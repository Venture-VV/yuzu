// 每日对账包（R1.5，只读）：影子运行期间每晚与旧系统对账；切换后每天日结时与微信、支付宝、银行卡、团购后台和现金实点核对。
// 一个营业日一个目录，结账、明细、交班与异常在同一个只读快照里读出：
//   00-说明.txt        门店、实例、版本与 SHA、营业日与时段、生成时刻、数据指纹、主要数字与交叉核对
//   01-日结汇总.csv    与「日结」页导出的相同
//   02-结账单.csv      当天结账与当天反结账的结账单，按收款方式分列
//   03-部门参考表.csv  结账时记下的部门快照（v0.7.6）按项目分类（部门）汇总：当天结的计正数、当天反结账的计负数，合计 = 应收；优惠按比例分摊到各项
//   04-异常清单.csv    反结账、作废明细、撤销误开的牌、改票种、免票入场、会员撤销与其他日结异常
//   05-交班.csv        当天的班次：备用金、各收款方式、应有现金、实点、长短款
//   06-技师业绩.csv    每位技师的钟数、点钟 / 轮钟、金额与提成（v0.7.0 / v0.7.1，与部门参考表同一口径），供与钟房的钟单核对
//   07-客房与押金.csv  当天的入住、房费、换房、退房、夜审与押金的收、退（S7，v0.7.4），供与客房登记、押金袋核对
//   08-使用单.csv      派对房、宠物轰趴房、娱乐室当天开的使用单（v0.7.19）：房间、使用人手牌、开单与结束时刻、时长、经办人、撤单原因
//   09-退款单.csv      当天开的退款单（v0.7.20，离店后部分退款，含当天作废的）：每项一行，原结账单、退款方式与退款单号、经办人、原因
// 优惠 / 免单与降档 / 免票授权在资金轨 R1.2 合并后加入异常清单。

import { businessDateOf, businessDayStart } from '@shared/business-date';
import { businessBreakdown, CHECKOUT_METHOD_LABELS, CHECKOUT_METHODS, COUPON_PLATFORM_LABELS, type CheckoutMethod, type CouponPlatform, type ShiftRecord } from '@shared/checkout';
import { INSTANCE_LABELS } from '@shared/instance';
import { formatYuan } from '@shared/money';
import { CALL_TYPE_LABELS, gradeLabel } from '@shared/technicians';
import type { SettlementSummary } from '@shared/types';
import type { AppConfig } from '../config';
import { readSnapshot, type Sql, type Tx } from '../db';
import { toCsv } from '../lib/csv';
import { computeSettlement, settlementCsv } from '../modules/settlement';
import { loadFrontdeskRules } from '../modules/frontdesk/common';
import { loadSettings } from '../modules/settings';
import { listShifts } from '../modules/shifts';
import { technicianReport, technicianTextSql } from '../modules/technicians';
import { consistencyChecks, type CheckLine } from './consistency';
import { computeFingerprint } from './fingerprint';

export interface ReconFile {
  name: string;
  content: string;
}

export interface DailyRecon {
  date: string;
  files: ReconFile[];
  /** 自检全部通过，且部门参考表合计 = 营业额（净额） */
  ok: boolean;
  /** 说明文件里的主要内容，命令行同时打印 */
  summary: string[];
}

/** 对账表里的金额：元，两位小数，不加千分位，便于表格软件直接求和 */
const yuan = (cents: number) => `${cents < 0 ? '-' : ''}${Math.trunc(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, '0')}`;

const plusDays = (date: string, days: number) => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

/**
 * 日结异常的类别名。按字符串取：以后新增的类别没列到时照原样输出类别代码，不因此漏行。
 * COVERED 是本包自己从单据逐条列出的类别（反结账、作废明细、撤销误开的牌、改票种 / 免票），日结异常里的同类不再重复列；
 * 本包的行比日结多手牌、客人与当场授权的人和原因。
 */
const ANOMALY_LABELS: Record<string, string> = {
  reversal: '会员撤销',
  cross_day_reversal: '跨营业日撤销',
  duplicate_blocked: '重复提交已拦截',
  rejected: '拒绝的操作',
  abandoned: '作废的待确认操作',
  balance_mismatch: '余额不一致',
  chain_break: '流水不连续',
  discount: '优惠 / 免单',
  backfill: '补录纸质单',
  refund: '退款单',
  refund_void: '作废退款单',
};
const COVERED = new Set(['checkout_void', 'line_void', 'visit_cancel', 'ticket_override']);
/** 说明文件里分别计数的异常类别（按类别名开头匹配，「改票种」含降档与改为免票） */
const EXCEPTION_KINDS = ['反结账', '优惠 / 免单', '作废明细', '撤销误开的牌', '改票种', '免票入场', '补录纸质单', '退款单', '作废退款单'];

interface CheckoutRow {
  id: number;
  checkoutNo: string;
  status: 'completed' | 'voided';
  businessDate: string;
  createdAt: string;
  operatorName: string;
  totalAmount: number;
  voidBusinessDate: string | null;
  voidedAt: string | null;
  voidedByName: string | null;
  voidReason: string | null;
  note: string;
  tags: string | null;
  payments: { method: CheckoutMethod; amount: number; ref: string; member: string | null; coupon: string | null; platform: CouponPlatform | null; approver: string | null }[] | null;
}

interface ExceptionRow {
  kind: string;
  at: string;
  docNo: string;
  tag: string;
  guest: string;
  staff: string;
  amount: number | null;
  description: string;
}

async function readDay(tx: Tx, date: string, today: string, from: Date, to: Date) {
  const summary = await computeSettlement(tx, date, today);
  const checkouts = await tx<CheckoutRow[]>`
    SELECT c.id, c.checkout_no, c.status, c.business_date, c.created_at, s.display_name AS operator_name, c.total_amount,
           c.void_business_date, c.voided_at, vs.display_name AS voided_by_name, c.void_reason, c.note,
           -- 手牌号；桌台结账单（餐饮第二步）写「桌 A1」
           (SELECT string_agg(x.label, '、' ORDER BY x.label) FROM (
              SELECT t.code AS label FROM checkout_bills cb JOIN visits v ON v.id = cb.visit_id JOIN hand_tags t ON t.id = v.tag_id
              WHERE cb.checkout_id = c.id
              UNION ALL
              SELECT '桌 ' || dt.name FROM checkout_bills cb JOIN table_sessions ts ON ts.id = cb.table_session_id
              JOIN dining_tables dt ON dt.id = ts.table_id WHERE cb.checkout_id = c.id) x) AS tags,
           (SELECT json_agg(json_build_object('method', p.method, 'amount', p.amount, 'ref', p.ref, 'member', m.name,
                                              'coupon', g.code, 'platform', g.platform, 'approver', ap.display_name) ORDER BY p.id)
            FROM checkout_payments p LEFT JOIN members m ON m.id = p.member_id LEFT JOIN group_buy_coupons g ON g.id = p.coupon_id
            LEFT JOIN staff ap ON ap.id = p.approved_by
            WHERE p.checkout_id = c.id) AS payments
    FROM checkouts c JOIN staff s ON s.id = c.operator_id LEFT JOIN staff vs ON vs.id = c.voided_by
    WHERE c.business_date = ${date} OR c.void_business_date = ${date}
    ORDER BY c.created_at, c.id`;
  // 部门参考表：结账时记下的快照（v0.7.6，以后改价目、改分类不影响已结的单）；当天结的计正数、当天反结账的计负数；
  // discount 是按金额比例分摊到这一项的优惠 / 免单与券抵扣（v0.7.20 只分摊到券适用的明细）；
  // refund 是当天的退款单退的金额（v0.7.20，作废的不算），数量减去退的份数
  const departments = await tx<{ category: string; name: string; quantity: number; amount: number; discount: number; refund: number }[]>`
    WITH k AS (
      SELECT id, 1 AS sign FROM checkouts WHERE business_date = ${date}
      UNION ALL
      SELECT id, -1 FROM checkouts WHERE void_business_date = ${date}
    ),
    x AS (
      SELECT ci.category, ci.name, k.sign * ci.quantity AS quantity, k.sign * ci.amount AS amount, k.sign * ci.discount AS discount, 0::bigint AS refund
      FROM k JOIN checkout_items ci ON ci.checkout_id = k.id
      UNION ALL
      SELECT ri.category, ri.name, -ri.quantity, 0, 0, ri.amount
      FROM refund_items ri JOIN refunds r ON r.id = ri.refund_id WHERE r.status = 'completed' AND r.business_date = ${date}
    )
    SELECT category, name, sum(quantity)::int AS quantity, sum(amount)::bigint AS amount, sum(discount)::bigint AS discount, sum(refund)::bigint AS refund
    FROM x
    GROUP BY 1, 2
    HAVING sum(quantity) <> 0 OR sum(amount) <> 0 OR sum(discount) <> 0 OR sum(refund) <> 0`;
  // 退款单（v0.7.20）：当天开的（含当天作废的），每项一行
  const refunds = await tx<{
    refundNo: string; status: string; createdAt: string; checkoutNo: string; checkoutDate: string; tags: string | null; operatorName: string; reason: string;
    amount: number; category: string; name: string; quantity: number; itemAmount: number; pays: string; voidedAt: string | null; voidedByName: string | null; voidReason: string | null;
  }[]>`
    SELECT r.refund_no, r.status, r.created_at, c.checkout_no, c.business_date AS checkout_date, s.display_name AS operator_name, r.reason, r.amount,
           ri.category, ri.name, ri.quantity, ri.amount AS item_amount, r.voided_at, vb.display_name AS voided_by_name, r.void_reason,
           (SELECT string_agg(x.label, '、' ORDER BY x.label) FROM (
              SELECT t.code AS label FROM checkout_bills cb JOIN visits v ON v.id = cb.visit_id JOIN hand_tags t ON t.id = v.tag_id WHERE cb.checkout_id = c.id
              UNION ALL
              SELECT '桌 ' || dt.name FROM checkout_bills cb JOIN table_sessions ts ON ts.id = cb.table_session_id
              JOIN dining_tables dt ON dt.id = ts.table_id WHERE cb.checkout_id = c.id) x) AS tags,
           (SELECT string_agg(CASE p.method WHEN 'cash' THEN '现金' WHEN 'wechat' THEN '微信' WHEN 'alipay' THEN '支付宝' WHEN 'bank_card' THEN '银行卡' ELSE '其他' END
                              || ' ' || to_char(p.amount / 100.0, 'FM999999990.00') || CASE WHEN p.ref <> '' THEN '（' || p.ref || '）' ELSE '' END, '、' ORDER BY p.id)
            FROM refund_payments p WHERE p.refund_id = r.id) AS pays
    FROM refunds r JOIN checkouts c ON c.id = r.checkout_id JOIN staff s ON s.id = r.operator_id JOIN refund_items ri ON ri.refund_id = r.id
    LEFT JOIN staff vb ON vb.id = r.voided_by
    WHERE r.business_date = ${date}
    ORDER BY r.id, ri.amount DESC, ri.category COLLATE "C", ri.name COLLATE "C"`;
  // 按分类、项目名排序（逐字符比较，结果与数据库的排序规则无关）
  departments.sort((a, b) => (a.category === b.category ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.category < b.category ? -1 : 1));
  const voidedLines = await tx<{ at: string; visitNo: string; tag: string; guest: string; staff: string; name: string; quantity: number; amount: number; reason: string; postedByName: string; technician: string | null }[]>`
    SELECT l.voided_at AS at, v.visit_no, t.code AS tag, coalesce(m.name, nullif(v.guest_label, ''), '散客') AS guest, vs.display_name AS staff,
           l.name, l.quantity, l.amount, l.void_reason AS reason, ps.display_name AS posted_by_name, ${technicianTextSql(tx, 'l')} AS technician
    FROM bill_lines l JOIN visits v ON v.bill_id = l.bill_id JOIN hand_tags t ON t.id = v.tag_id LEFT JOIN members m ON m.id = v.member_id
    JOIN staff vs ON vs.id = l.voided_by JOIN staff ps ON ps.id = l.posted_by
    WHERE l.status = 'voided' AND l.voided_at >= ${from} AND l.voided_at < ${to}
      AND NOT (l.ticket_type_id IS NOT NULL AND l.void_reason LIKE '反结账 %')
    UNION ALL
    -- 桌台退菜（餐饮第二步）：单号是开台号，「手牌」一栏写桌号
    SELECT l.voided_at, s.session_no, '桌 ' || dt.name, coalesce(m.name, nullif(s.guest_label, ''), '散客'), vs.display_name,
           l.name, l.quantity, l.amount, l.void_reason, ps.display_name, NULL
    FROM bill_lines l JOIN table_sessions s ON s.bill_id = l.bill_id JOIN dining_tables dt ON dt.id = s.table_id LEFT JOIN members m ON m.id = s.member_id
    JOIN staff vs ON vs.id = l.voided_by JOIN staff ps ON ps.id = l.posted_by
    WHERE l.status = 'voided' AND l.voided_at >= ${from} AND l.voided_at < ${to}
    ORDER BY 1, 2`;
  const cancelled = await tx<{ at: string; visitNo: string; tag: string; guest: string; staff: string; reason: string | null; checkedInAt: string }[]>`
    SELECT v.closed_at AS at, v.visit_no, t.code AS tag, coalesce(m.name, nullif(v.guest_label, ''), '散客') AS guest,
           coalesce(s.display_name, '') AS staff, v.close_reason AS reason, v.checked_in_at
    FROM visits v JOIN hand_tags t ON t.id = v.tag_id LEFT JOIN members m ON m.id = v.member_id LEFT JOIN staff s ON s.id = v.closed_by
    WHERE v.status = 'cancelled' AND v.closed_at >= ${from} AND v.closed_at < ${to}
    ORDER BY v.closed_at, v.id`;
  // 改票种：降低票种或改成免票时记下当场授权的人与原因（R1.2 起；之前的记录与改贵的没有）
  const ticketChanges = await tx<{ at: string; visitNo: string; tag: string; guest: string; staff: string; fromName: string; toName: string; price12h: number; price24h: number; approverName: string | null; reason: string | null }[]>`
    SELECT c.created_at AS at, v.visit_no, t.code AS tag, coalesce(m.name, nullif(v.guest_label, ''), '散客') AS guest, s.display_name AS staff,
           ft.name AS from_name, tt.name AS to_name, c.price_12h, c.price_24h, ap.display_name AS approver_name, c.reason
    FROM visit_ticket_changes c JOIN visits v ON v.id = c.visit_id JOIN hand_tags t ON t.id = v.tag_id LEFT JOIN members m ON m.id = v.member_id
    JOIN staff s ON s.id = c.operator_id JOIN ticket_types ft ON ft.id = c.from_type_id JOIN ticket_types tt ON tt.id = c.to_type_id
    LEFT JOIN staff ap ON ap.id = c.approved_by
    WHERE c.created_at >= ${from} AND c.created_at < ${to}
    ORDER BY c.created_at, c.id`;
  // 免票入场：接待时就是免票（之后改过票种的，按第一次改票种之前的票种算；在店期间改成免票的列在「改票种」）。
  // 接待时直接选免票的授权记在这次接待的审计记录里（R1.2 起），按手牌对上这次接待（接待的第一位来访编号不大于本来访）
  const freeEntries = await tx<{ at: string; visitNo: string; tag: string; guest: string; staff: string; ticketName: string; approverName: string | null; reason: string | null }[]>`
    SELECT v.checked_in_at AS at, v.visit_no, t.code AS tag, coalesce(m.name, nullif(v.guest_label, ''), '散客') AS guest,
           s.display_name AS staff, tt.name AS ticket_name, fa.approver_name, fa.reason
    FROM visits v JOIN hand_tags t ON t.id = v.tag_id LEFT JOIN members m ON m.id = v.member_id JOIN staff s ON s.id = v.checked_in_by
    JOIN ticket_types tt ON tt.id = v.ticket_type_id
    LEFT JOIN LATERAL (
      SELECT a.detail -> 'freeTickets' ->> 'approverName' AS approver_name, a.detail -> 'freeTickets' ->> 'reason' AS reason
      FROM audit_logs a
      WHERE a.business_date = ${date} AND a.action = 'frontdesk_checkin' AND a.detail ? 'freeTickets'
        AND a.detail -> 'freeTickets' -> 'tags' ? t.code
        AND (CASE WHEN a.target_id ~ '^[0-9]+$' THEN a.target_id::bigint END) <= v.id
      ORDER BY (CASE WHEN a.target_id ~ '^[0-9]+$' THEN a.target_id::bigint END) DESC
      LIMIT 1
    ) fa ON true
    WHERE v.checked_in_at >= ${from} AND v.checked_in_at < ${to} AND v.status <> 'cancelled'
      AND coalesce(
        (SELECT ft.price_12h = 0 AND ft.price_24h = 0 FROM visit_ticket_changes c JOIN ticket_types ft ON ft.id = c.from_type_id
         WHERE c.visit_id = v.id ORDER BY c.created_at, c.id LIMIT 1),
        v.ticket_price_12h = 0)
    ORDER BY v.checked_in_at, v.id`;
  const shifts = (await listShifts(tx, date)).filter((s) => s.businessDate === date);
  const technicians = await technicianReport(tx, date, date);
  // 客房（S7）：当天的入住、房费、换房、退房 / 撤销入住、夜审与押金台账，按时间排（房费挂在住客的手牌账单上，随手牌结账）
  const rooms = await tx<{ at: string; event: string; stayNo: string; roomNo: string; guest: string; tagCode: string | null; method: string | null; amount: number | null; operator: string; note: string }[]>`
    SELECT s.checked_in_at AS at, '入住' AS event, s.stay_no, r.room_no,
           s.guest_label AS guest, ht.code AS tag_code, NULL AS method, s.rate AS amount, st.display_name AS operator,
           CASE s.kind WHEN 'daily' THEN '全天房，房价每晚' ELSE '钟点房，房价每段 ' || s.block_minutes || ' 分钟' END AS note
    FROM room_stays s JOIN rooms r ON r.id = s.room_id JOIN staff st ON st.id = s.checked_in_by
    JOIN visits v ON v.id = s.visit_id JOIN hand_tags ht ON ht.id = v.tag_id
    WHERE s.checked_in_at >= ${from} AND s.checked_in_at < ${to}
    UNION ALL
    SELECT c.created_at, CASE c.source WHEN 'checkin' THEN '房费（随入住）' WHEN 'audit' THEN '房费（夜审）' WHEN 'checkout' THEN '房费（退房补挂）' ELSE '房费（续住）' END,
           s.stay_no, r.room_no, s.guest_label, ht.code, NULL, c.amount, st.display_name,
           l.name || CASE WHEN l.status = 'voided' THEN '（已作废：' || l.void_reason || '）' ELSE '' END
    FROM room_stay_charges c JOIN room_stays s ON s.id = c.stay_id JOIN rooms r ON r.id = s.room_id JOIN bill_lines l ON l.id = c.line_id
    JOIN staff st ON st.id = c.created_by JOIN visits v ON v.id = s.visit_id JOIN hand_tags ht ON ht.id = v.tag_id
    WHERE c.created_at >= ${from} AND c.created_at < ${to}
    UNION ALL
    SELECT d.created_at, CASE d.kind WHEN 'receive' THEN '收押金' ELSE '退押金' END,
           s.stay_no, r.room_no, s.guest_label, ht.code, d.method, CASE WHEN d.kind = 'receive' THEN d.amount ELSE -d.amount END,
           st.display_name, concat_ws('；', nullif(d.ref, ''), d.reason)
    FROM room_deposits d JOIN room_stays s ON s.id = d.stay_id JOIN rooms r ON r.id = s.room_id JOIN staff st ON st.id = d.operator_id
    JOIN visits v ON v.id = s.visit_id JOIN hand_tags ht ON ht.id = v.tag_id
    WHERE d.business_date = ${date}
    UNION ALL
    SELECT mv.created_at, '换房', s.stay_no, tr.room_no, s.guest_label, ht.code, NULL, NULL, st.display_name, fr.room_no || ' → ' || tr.room_no || '：' || mv.reason
    FROM room_moves mv JOIN room_stays s ON s.id = mv.stay_id JOIN rooms fr ON fr.id = mv.from_room_id JOIN rooms tr ON tr.id = mv.to_room_id
    JOIN staff st ON st.id = mv.operator_id JOIN visits v ON v.id = s.visit_id JOIN hand_tags ht ON ht.id = v.tag_id
    WHERE mv.created_at >= ${from} AND mv.created_at < ${to}
    UNION ALL
    SELECT s.closed_at, CASE s.status WHEN 'checked_out' THEN '退房' ELSE '撤销入住' END,
           s.stay_no, r.room_no, s.guest_label, ht.code, NULL, NULL, st.display_name, coalesce(s.close_reason, '')
    FROM room_stays s JOIN rooms r ON r.id = s.room_id JOIN staff st ON st.id = s.closed_by
    JOIN visits v ON v.id = s.visit_id JOIN hand_tags ht ON ht.id = v.tag_id
    WHERE s.status <> 'open' AND s.closed_at >= ${from} AND s.closed_at < ${to}
    UNION ALL
    SELECT a.run_at, '夜审', '', '', '', NULL, NULL, a.amount, st.display_name, '挂了 ' || a.nights || ' 晚房费'
    FROM room_audits a JOIN staff st ON st.id = a.run_by WHERE a.business_date = ${date}
    ORDER BY 1, 3`;
  // 派对房等的使用单（v0.7.19）：当天开的（营业日），以及当天结束的、前一天开的
  const usages = await tx<{ usageNo: string; spaceCode: string; spaceName: string; businessType: string; tagCode: string; guests: number; openedAt: string; openedBy: string; closedAt: string | null; closedBy: string | null; status: string; closeKind: string | null; closeReason: string | null; note: string; businessDate: string }[]>`
    SELECT u.usage_no, sp.code AS space_code, sp.display_name AS space_name, sp.business_type, ht.code AS tag_code, u.guests,
           u.opened_at, so.display_name AS opened_by, u.closed_at, sc.display_name AS closed_by, u.status, u.close_kind, u.close_reason, u.note,
           u.business_date::text AS business_date
    FROM space_usages u JOIN spaces sp ON sp.id = u.space_id JOIN visits v ON v.id = u.visit_id JOIN hand_tags ht ON ht.id = v.tag_id
    JOIN staff so ON so.id = u.opened_by LEFT JOIN staff sc ON sc.id = u.closed_by
    WHERE u.business_date = ${date} OR (u.closed_at >= ${from} AND u.closed_at < ${to})
    ORDER BY u.opened_at, u.id`;
  return { summary, checkouts, departments, voidedLines, cancelled, ticketChanges, freeEntries, shifts, technicians, rooms, usages, refunds };
}

export async function buildDailyRecon(sql: Sql, config: AppConfig, date: string, now = new Date()): Promise<DailyRecon> {
  const settings = await loadSettings(sql);
  const startHour = settings.businessDayStartHour;
  const today = businessDateOf(now, config.timezone, startHour);
  const from = businessDayStart(date, config.timezone, startHour);
  const to = businessDayStart(plusDays(date, 1), config.timezone, startHour);
  const day = await readSnapshot(sql, (tx) => readDay(tx, date, today, from, to));
  // 撤销误开的牌：本包列出每一次，写明是否超过更正时限；日结异常清单只列超过时限的（与日结同一时限）
  const { selfVoidMinutes } = await loadFrontdeskRules(sql);
  const checks = await consistencyChecks(sql, config.timezone);
  const fingerprint = await computeFingerprint(sql);

  const stampOf = (iso: string | null) => {
    if (!iso) return '';
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
        .formatToParts(new Date(iso))
        .map((p) => [p.type, p.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  };

  const s: SettlementSummary = day.summary;
  const files: ReconFile[] = [];
  files.push({ name: '01-日结汇总.csv', content: settlementCsv(s) });

  // 02 结账单
  const methods = CHECKOUT_METHODS as readonly CheckoutMethod[];
  files.push({
    name: '02-结账单.csv',
    content: toCsv([
      ['结账单号', '状态', '结账营业日', '结账时间', '收银', '手牌', '应收合计', ...methods.map((m) => CHECKOUT_METHOD_LABELS[m]), '储值会员', '团购券码', '收款备注',
        '计入本日结账', '计入本日反结账', '反结账营业日', '反结账时间', '反结账人', '反结账原因', '备注'],
      ...day.checkouts.map((c) => {
        const pays = c.payments ?? [];
        const sumOf = (m: CheckoutMethod) => pays.filter((p) => p.method === m).reduce((t, p) => t + p.amount, 0);
        return [
          c.checkoutNo,
          c.status === 'voided' ? '已反结账' : '已结账',
          c.businessDate,
          stampOf(c.createdAt),
          c.operatorName,
          c.tags ?? '',
          yuan(c.totalAmount),
          ...methods.map((m) => yuan(sumOf(m))),
          pays.flatMap((p) => (p.member ? [p.member] : [])).join('、'),
          pays.flatMap((p) => (p.coupon ? [`${p.platform ? COUPON_PLATFORM_LABELS[p.platform] : ''} ${p.coupon}`.trim()] : [])).join('、'),
          pays.flatMap((p) => (p.ref ? [`${CHECKOUT_METHOD_LABELS[p.method]} ${p.ref}${p.approver ? `（${p.approver}授权）` : ''}`] : [])).join('、'),
          yuan(c.businessDate === date ? c.totalAmount : 0),
          yuan(c.voidBusinessDate === date ? -c.totalAmount : 0),
          c.voidBusinessDate ?? '',
          stampOf(c.voidedAt),
          c.voidedByName ?? '',
          c.voidReason ?? '',
          c.note,
        ];
      }),
    ]),
  });

  // 03 部门参考表：结账时记下的快照，应收合计应等于应收；优惠 / 免单按金额比例分摊到各项（v0.7.6），券抵扣只分摊到券适用的明细，
  // 分摊合计应等于优惠 + 券抵扣；退款单（v0.7.20）按退的项目记到部门，合计应等于退款
  const biz = businessBreakdown(s.business);
  const deptTotal = day.departments.reduce((t, d) => t + d.amount, 0);
  const deptDiscount = day.departments.reduce((t, d) => t + d.discount, 0);
  const deptRefund = day.departments.reduce((t, d) => t + d.refund, 0);
  const categories = [...new Set(day.departments.map((d) => d.category))];
  const row = (cat: string, name: string, quantity: number | string, amount: number, discount: number, refund: number) => [
    cat,
    name,
    quantity,
    yuan(amount),
    yuan(discount),
    yuan(refund),
    yuan(amount - discount - refund),
  ];
  files.push({
    name: '03-部门参考表.csv',
    content: toCsv([
      ['部门（项目分类）', '项目', '数量', '应收（元）', '优惠分摊（元）', '退款（元）', '净额（元）'],
      ...categories.flatMap((cat) => {
        const items = day.departments.filter((d) => d.category === cat);
        return [
          ...items.map((d) => row(cat, d.name, d.quantity, d.amount, d.discount, d.refund)),
          row(cat, '小计', '', items.reduce((t, d) => t + d.amount, 0), items.reduce((t, d) => t + d.discount, 0), items.reduce((t, d) => t + d.refund, 0)),
        ];
      }),
      row('合计', '', '', deptTotal, deptDiscount, deptRefund),
      ['应收（结账 − 反结账）', '', '', yuan(biz.receivable), '', '', ''],
      ['核对', deptTotal === biz.receivable && deptDiscount === biz.discount + biz.coupon && deptRefund === biz.refund ? '一致' : '不一致', '', '', '', '', ''],
      ['优惠 / 免单（不是收款）', '', '', yuan(-biz.discount), '', '', ''],
      ['券抵扣（是优惠，不是收款）', '', '', yuan(-biz.coupon), '', '', ''],
      ['退款（退款单）', '', '', yuan(-biz.refund), '', '', ''],
      ['净营业额（应收 − 优惠 − 券抵扣 − 退款）', '', '', yuan(biz.netRevenue), '', '', ''],
    ]),
  });

  // 04 异常清单
  const authText = (approver: string | null, reason: string | null) => (approver ? `；${reason ?? ''}，${approver}当场授权` : '');
  const exceptions: ExceptionRow[] = [
    ...day.checkouts
      .filter((c) => c.voidBusinessDate === date)
      .map((c) => ({
        kind: '反结账',
        at: c.voidedAt!,
        docNo: c.checkoutNo,
        tag: c.tags ?? '',
        guest: (c.payments ?? []).flatMap((p) => (p.member ? [p.member] : [])).join('、'),
        staff: c.voidedByName ?? '',
        amount: -c.totalAmount,
        description: `${c.voidReason ?? ''}（原结账 ${c.businessDate} ${c.operatorName}）`,
      })),
    ...day.voidedLines.map((l) => ({
      kind: '作废明细',
      at: l.at,
      docNo: l.visitNo,
      tag: l.tag,
      guest: l.guest,
      staff: l.staff,
      amount: -l.amount,
      description: `${l.name} ×${l.quantity}${l.technician ? `（${l.technician}）` : ''}（${l.postedByName} 挂）：${l.reason}`,
    })),
    ...day.cancelled.map((v) => {
      const ms = new Date(v.at).getTime() - new Date(v.checkedInAt).getTime();
      const late = ms > selfVoidMinutes * 60_000;
      return {
        kind: '撤销误开的牌',
        at: v.at,
        docNo: v.visitNo,
        tag: v.tag,
        guest: v.guest,
        staff: v.staff,
        amount: null,
        description: `${v.reason ?? ''}（${stampOf(v.checkedInAt)} 开牌，${Math.floor(ms / 60_000)} 分钟后撤销，${late ? `超过更正时限 ${selfVoidMinutes} 分钟，日结异常清单同样列出` : `在更正时限 ${selfVoidMinutes} 分钟内`}）`,
      };
    }),
    ...day.ticketChanges.map((c) => ({
      // 降低票种、改成免票要当场授权（R1.2 起），改贵的不用
      kind: c.price12h === 0 && c.price24h === 0 ? '改票种（改为免票）' : c.approverName ? '改票种（降档）' : '改票种',
      at: c.at,
      docNo: c.visitNo,
      tag: c.tag,
      guest: c.guest,
      staff: c.staff,
      amount: null,
      description: `${c.fromName} → ${c.toName}（12 小时档 ${formatYuan(c.price12h)} / 24 小时档 ${formatYuan(c.price24h)}）${authText(c.approverName, c.reason)}`,
    })),
    ...day.freeEntries.map((v) => ({
      kind: '免票入场',
      at: v.at,
      docNo: v.visitNo,
      tag: v.tag,
      guest: v.guest,
      staff: v.staff,
      amount: null,
      description: `票种：${v.ticketName}${authText(v.approverName, v.reason)}`,
    })),
    ...s.anomalies
      .filter((a) => !COVERED.has(a.kind))
      .map((a) => {
        // 优惠 / 免单、补录的结账：按结账单补上手牌、客人与收银；优惠金额记负数（少收的营业额，与反结账、作废明细同向）
        const c = a.kind === 'discount' || a.kind === 'backfill' ? day.checkouts.find((x) => x.checkoutNo === a.docNo) : undefined;
        return {
          kind: ANOMALY_LABELS[a.kind] ?? a.kind,
          at: a.at ?? '',
          docNo: a.docNo ?? '',
          tag: c?.tags ?? '',
          guest: c ? (c.payments ?? []).flatMap((p) => (p.member ? [p.member] : [])).join('、') : (a.memberName ?? ''),
          staff: c?.operatorName ?? '',
          // 退款单少了营业额，与优惠同向记负数；作废退款单冲回，记正数
          amount: (a.kind === 'discount' || a.kind === 'refund') && a.amount !== null ? -a.amount : a.amount,
          description: a.description,
        };
      }),
  ].sort((a, b) => a.at.localeCompare(b.at));
  files.push({
    name: '04-异常清单.csv',
    content: toCsv([
      ['类别', '时间', '单号', '手牌', '客人 / 会员', '经办人', '金额（元）', '说明'],
      ...exceptions.map((e) => [e.kind, stampOf(e.at || null), e.docNo, e.tag, e.guest, e.staff, e.amount === null ? '' : yuan(e.amount), e.description]),
    ]),
  });

  // 05 交班。反结账退现金：资金轨 R1.2 起扣减反结账人当班的应有现金（cash.refund），之前的版本与升级前的快照没有，记 0
  const shiftMethods = (r: ShiftRecord, m: CheckoutMethod) => r.summary.checkoutByMethod.find((x) => x.method === m)?.amount ?? 0;
  const cashRefund = (r: ShiftRecord) => (r.summary.cash as { refund?: number }).refund ?? 0;
  files.push({
    name: '05-交班.csv',
    content: toCsv([
      ['班次', '员工', '营业日', '状态', '开班', '交班', '备用金', '结账张数', '结账合计', ...methods.map((m) => `结账·${CHECKOUT_METHOD_LABELS[m]}`),
        '充值实收', '赠金', '工作台储值消费', '反结账退现金', '押金现金（收 − 退）', '退款单退现金', '应有现金', '实点现金', '长短款', '反结账张数', '退款单张数', '接班人', '备注'],
      ...day.shifts.map((r) => [
        r.shiftNo,
        r.staffName,
        r.businessDate,
        r.status === 'closed' ? '已交班' : '当班中',
        stampOf(r.startedAt),
        stampOf(r.endedAt),
        yuan(r.openingCash),
        r.summary.checkouts.count,
        yuan(r.summary.checkouts.total),
        ...methods.map((m) => yuan(shiftMethods(r, m))),
        yuan(r.summary.recharges.paid),
        yuan(r.summary.recharges.bonus),
        yuan(r.summary.walletConsumes.total),
        yuan(cashRefund(r)),
        yuan(r.summary.cash.deposit ?? 0),
        yuan(r.summary.cash.refundSlip ?? 0),
        yuan(r.expectedCash ?? r.summary.cash.expected),
        r.countedCash === null ? '' : yuan(r.countedCash),
        r.countedCash === null || r.expectedCash === null ? '' : yuan(r.countedCash - r.expectedCash),
        r.summary.voids.length,
        r.summary.refundSlips?.count ?? 0,
        r.handedToName ?? '',
        r.note,
      ]),
    ]),
  });

  // 06 技师业绩：与部门参考表同一口径（结账那一刻的明细，当天反结账的冲回）；在职技师没有钟的也列出
  const tr = day.technicians;
  files.push({
    name: '06-技师业绩.csv',
    content: toCsv([
      ['工号', '技师', '等级', '状态', '钟数', `${CALL_TYPE_LABELS.designated}`, `${CALL_TYPE_LABELS.rotation}`, '金额（元）', '基本提成（元）', '点钟奖励（元）', '提成合计（元）'],
      ...tr.rows.map((r) => [
        r.techNo,
        r.name,
        gradeLabel(r.grade),
        r.active ? '在职' : '已停用',
        r.clocks,
        r.designated,
        r.rotation,
        yuan(r.amount),
        yuan(r.commission?.base ?? 0),
        yuan(r.commission?.bonus ?? 0),
        yuan(r.commission?.total ?? 0),
      ]),
      ['合计', '', '', '', tr.totals.clocks, tr.totals.designated, tr.totals.rotation, yuan(tr.totals.amount), yuan(tr.totals.commission?.base ?? 0), yuan(tr.totals.commission?.bonus ?? 0), yuan(tr.totals.commission?.total ?? 0)],
      ['未指定技师的技师项目', '', '', '', tr.unassigned.clocks, '', '', yuan(tr.unassigned.amount), '', '', ''],
    ]),
  });

  // 07 客房与押金（S7）：当天的入住、房费、换房、退房、夜审与押金台账；押金是负债，不算营业额
  const methodLabel = (m: string | null) => (m ? (CHECKOUT_METHOD_LABELS[m as CheckoutMethod] ?? m) : '');
  files.push({
    name: '07-客房与押金.csv',
    content: toCsv([
      ['时间', '事项', '入住单', '房号', '住客', '手牌', '方式', '金额（元）', '经办人', '说明'],
      ...day.rooms.map((r) => [
        stampOf(r.at),
        r.event,
        r.stayNo,
        r.roomNo,
        r.guest,
        r.tagCode ?? '',
        methodLabel(r.method),
        r.amount === null ? '' : (r.amount < 0 ? '-' : '') + yuan(Math.abs(r.amount)),
        r.operator,
        r.note,
      ]),
      [],
      ['押金汇总', '', '', '', '', '', '方式', '金额（元）'],
      ...s.deposits.received.map((m) => ['收押金', '', '', '', '', '', methodLabel(m.method), yuan(m.amount)]),
      ...s.deposits.refunded.map((m) => ['退押金', '', '', '', '', '', methodLabel(m.method), '-' + yuan(m.amount)]),
      ['当天结束时在住押金余额', '', '', '', '', '', '', yuan(s.deposits.held)],
    ]),
  });

  // 08 使用单（v0.7.19）：派对房等「开单即占用」，费用是手牌账单上的普通明细（在结账单与部门参考表里），这里只核对占用
  const closeLabel: Record<string, string> = { end: '结束使用', checkout: '使用人结账', visit_cancel: '撤销来访', cancel: '撤单' };
  const minutesOf = (a: string, b: string | null) => (b ? Math.max(0, Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 60_000)) : null);
  files.push({
    name: '08-使用单.csv',
    content: toCsv([
      ['使用单', '房间', '名称', '业态', '使用人手牌', '人数', '开单时刻', '开单人', '结束时刻', '结束方式', '经办人', '时长（分钟）', '撤单原因', '备注', '开单营业日'],
      ...day.usages.map((u) => [
        u.usageNo,
        u.spaceCode,
        u.spaceName,
        u.businessType,
        u.tagCode,
        u.guests,
        stampOf(u.openedAt),
        u.openedBy,
        u.closedAt ? stampOf(u.closedAt) : '使用中',
        u.closeKind ? (closeLabel[u.closeKind] ?? u.closeKind) : '',
        u.closedBy ?? '',
        minutesOf(u.openedAt, u.closedAt) ?? '',
        u.closeReason ?? '',
        u.note,
        u.businessDate,
      ]),
    ]),
  });

  // 09 退款单（v0.7.20）：当天开的，每项一行；作废的写明（作废只能在当天，日结与部门都不算）
  files.push({
    name: '09-退款单.csv',
    content: toCsv([
      ['退款单号', '状态', '退款时间', '原结账单', '原结账营业日', '手牌 / 桌台', '部门（项目分类）', '项目', '退的份数', '退的金额（元）', '退款单合计（元）',
        '退款方式与退款单号', '经办人', '原因', '作废时间', '作废人', '作废原因'],
      ...day.refunds.map((r) => [
        r.refundNo,
        r.status === 'voided' ? '已作废' : '生效',
        stampOf(r.createdAt),
        r.checkoutNo,
        r.checkoutDate,
        r.tags ?? '',
        r.category,
        r.name,
        r.quantity,
        yuan(r.itemAmount),
        yuan(r.amount),
        r.pays ?? '',
        r.operatorName,
        r.reason,
        stampOf(r.voidedAt),
        r.voidedByName ?? '',
        r.voidReason ?? '',
      ]),
    ]),
  });

  // 00 说明
  const failed = checks.filter((c: CheckLine) => !c.ok);
  const deptOk = deptTotal === biz.receivable && deptDiscount === biz.discount + biz.coupon && deptRefund === biz.refund;
  const byMethod = s.business.byMethod.map((m) => `${CHECKOUT_METHOD_LABELS[m.method]} ${formatYuan(m.amount)}`).join('、') || '无';
  const count = (kind: string) => exceptions.filter((e) => e.kind.startsWith(kind)).length;
  const summary = [
    `营业日 ${date}（${stampOf(from.toISOString()).slice(0, 16)} 至 ${stampOf(to.toISOString()).slice(0, 16)}）${date === today ? '，营业日尚未结束' : ''}`,
    `应收 ${formatYuan(biz.receivable)}：结账 ${s.business.checkouts.count} 张 ${formatYuan(s.business.checkouts.total)}，反结账 ${s.business.voids.count} 张 ${formatYuan(s.business.voids.total)}`,
    `优惠 / 免单 ${formatYuan(biz.discount)}；券抵扣 ${formatYuan(biz.coupon)}；退款 ${formatYuan(biz.refund)}（${s.business.refunds.count} 张）；净营业额 ${formatYuan(biz.netRevenue)}；实收（现金类）${formatYuan(biz.received)}`,
    `收款方式：${byMethod}`,
    `储值：充值实收 ${formatYuan(s.recharge.paid)}（${s.recharge.count} 笔），储值消费 ${formatYuan(s.consume.total)}（${s.consume.count} 笔）`,
    `部门参考表合计 ${formatYuan(deptTotal)}、优惠分摊 ${formatYuan(deptDiscount)}、退款 ${formatYuan(deptRefund)}：${deptOk ? '✓ 与应收、优惠与券抵扣、退款一致' : '✗ 与应收、优惠或退款不一致'}`,
    `异常：${EXCEPTION_KINDS.map((k) => `${k} ${count(k)}`).join('、')}、其他 ${exceptions.length - EXCEPTION_KINDS.reduce((t, k) => t + count(k), 0)}`,
    `交班：${day.shifts.length} 个班次，已交班 ${day.shifts.filter((r) => r.status === 'closed').length} 个`,
    `技师：${tr.totals.clocks} 个钟（点钟 ${tr.totals.designated}、轮钟 ${tr.totals.rotation}），${formatYuan(tr.totals.amount)}${tr.unassigned.clocks ? `；未指定技师 ${tr.unassigned.clocks} 个钟` : ''}`,
    `客房押金：收 ${formatYuan(s.deposits.received.reduce((t, m) => t + m.amount, 0))}、退 ${formatYuan(s.deposits.refunded.reduce((t, m) => t + m.amount, 0))}；当天结束时在住押金 ${formatYuan(s.deposits.held)}`,
    `派对房等使用单：当天开 ${day.usages.filter((u) => u.businessDate === date).length} 张，撤单 ${day.usages.filter((u) => u.status === 'cancelled').length} 张，仍在使用 ${day.usages.filter((u) => u.status === 'open').length} 张`,
    failed.length ? `自检：✗ ${failed.length} 项不一致：${failed.map((c) => c.label).join('、')}` : `自检：✓ ${checks.length} 项全部一致`,
  ];
  files.unshift({
    name: '00-说明.txt',
    content: [
      `浴族每日对账包 · ${settings.storeName}`,
      `实例：${INSTANCE_LABELS[config.instance] ?? config.instance} · 版本 v${config.version}${config.commit ? ` · ${config.commit.slice(0, 7)}` : ''}`,
      `生成时刻：${stampOf(now.toISOString())}（只读生成，没有改任何数据）`,
      `数据指纹：${fingerprint.digest}`,
      '',
      ...summary,
      '',
      '文件：',
      '  01-日结汇总.csv     与「日结」页导出的相同',
      '  02-结账单.csv       当天结账与当天反结账的结账单，按收款方式分列；「计入本日」两列分别合计 = 结账合计、反结账合计',
      '  03-部门参考表.csv   结账时记下的部门快照按项目分类（部门）汇总，合计 = 应收；优惠 / 免单按金额比例分摊到各项、券抵扣只分摊到券适用的项目（优惠分摊一列），当天的退款单按退的项目记（退款一列），后面单列优惠 / 免单、券抵扣、退款与净营业额',
      '  04-异常清单.csv     反结账、优惠 / 免单、作废明细、撤销误开的牌（每一次都列，写明是否超过更正时限；日结异常清单只列超过时限的）、改票种（降档、改为免票写明授权人与原因）、免票入场、补录纸质单、退款单与作废的退款单、会员撤销与其他异常',
      '  05-交班.csv         当天的班次、反结账退现金与长短款',
      '  06-技师业绩.csv     每位技师的钟数、点钟 / 轮钟、金额与提成（与部门参考表同一口径，提成按结账时刻的提成规则），与钟房的钟单核对',
      '  07-客房与押金.csv   当天的入住、房费、换房、退房、夜审与押金的收、退（押金是负债，不算营业额；房费随手牌结账），与客房登记、押金袋核对',
      '  08-使用单.csv       派对房、宠物轰趴房、娱乐室当天开的与当天结束的使用单（房间、使用人手牌、开单与结束、时长、经办人、撤单原因）；场次费在结账单里',
      '  09-退款单.csv       当天开的退款单（离店后部分退款），每项一行：原结账单、退的份数与金额、退款方式与商户后台的退款单号、经办人、原因；当天作废的写明（不算营业额）',
      '',
    ].join('\n'),
  });
  return { date, files, ok: failed.length === 0 && deptOk, summary };
}
