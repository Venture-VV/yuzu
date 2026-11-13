// 订单查询与逐行明细（8.0.15，docs/ORDERS_V8015.md 第 2 节）：前台「流水」页的「订单查询」。
//
// 按结账单号、退款单号、手牌号、桌号、会员手机号（后 4 位或全号）、会员姓名、客人称呼查结账单与退款单；
// 点开看逐行明细（与打印的结账单同一个取法，另加所属部门与摊到这一行的优惠）；导出当前结果的逐行明细。
// 都是只读、在只读快照里读，不加锁。部门的归法与结账时记快照的函数（yuzu_snapshot_checkout_items，迁移 108）相同。

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ISO_DATE } from '@shared/business-date';
import { CHECKOUT_METHOD_LABELS, type CheckoutMethod } from '@shared/checkout';
import { formatAmount } from '@shared/money';
import {
  allocateLineDiscounts,
  linesFromItems,
  ORDER_QUERY_MAX,
  ORDER_SEARCH_LIMIT,
  orderPhoneQuery,
  orderStatusLabel,
  type CheckoutOrderDetail,
  type OrderItemSnapshot,
  type OrderLine,
  type OrderRow,
  type OrderSearchResult,
  type RawOrderLine,
  type RefundOrderDetail,
} from '@shared/orders';
import { can } from '@shared/permissions';
import { guard } from '../auth/guard';
import { readSnapshot, type Db } from '../db';
import { writeAudit } from '../lib/audit';
import type { Deps } from '../lib/context';
import { csvReply, toCsv } from '../lib/csv';
import { forbidden, notFound } from '../lib/errors';
import { idParam, parse } from '../lib/validate';
import { getRefund } from './frontdesk/refunds';
import { resolveReadableDate } from './ledger';
import { checkoutForPrint } from './print';
import { technicianTextSql } from './technicians';

// ───────────────────────── 查询 ─────────────────────────

export interface OrderSearchInput {
  /** 搜索词（已去掉首尾空白）；空 = 按营业日列 */
  q: string;
  /** 没有搜索词时列的营业日 */
  date: string;
  today: string;
  historyAllowed: boolean;
}

const escapeLike = (q: string) => q.replace(/[\\%_]/g, (c) => `\\${c}`);

/** 一张结账单（别名 c）符不符合搜索词：单号、手牌号、桌号、会员手机号、会员姓名、客人称呼 */
function checkoutMatchSql(db: Db, q: string) {
  const like = `%${escapeLike(q)}%`;
  const phone = orderPhoneQuery(q);
  const digits = /^[0-9]+$/.test(q);
  const phoneOf = (m: string) =>
    phone === 'tail' ? db`OR right(${db(`${m}.phone`)}, 4) = ${q}` : phone === 'full' ? db`OR ${db(`${m}.phone`)} = ${q}` : db``;
  return db`(
    c.checkout_no ILIKE ${like}
    OR EXISTS (
      SELECT 1 FROM checkout_bills cb
      LEFT JOIN visits v ON v.id = cb.visit_id LEFT JOIN hand_tags t ON t.id = v.tag_id LEFT JOIN members m ON m.id = v.member_id
      LEFT JOIN table_sessions ts ON ts.id = cb.table_session_id LEFT JOIN dining_tables dt ON dt.id = ts.table_id
      LEFT JOIN members tm ON tm.id = ts.member_id
      WHERE cb.checkout_id = c.id AND (
        upper(t.code) = upper(${q})
        ${digits ? db`OR regexp_replace(t.code, '[^0-9]', '', 'g') = ${q}` : db``}
        OR dt.name ILIKE ${like}
        OR v.guest_label ILIKE ${like} OR ts.guest_label ILIKE ${like}
        OR m.name ILIKE ${like} OR tm.name ILIKE ${like}
        ${phoneOf('m')} ${phoneOf('tm')}
      ))
    OR EXISTS (
      SELECT 1 FROM checkout_payments p JOIN members pm ON pm.id = coalesce(p.member_id, p.discount_member_id)
      WHERE p.checkout_id = c.id AND (pm.name ILIKE ${like} ${phoneOf('pm')}))
  )`;
}

/** 结账单上的手牌、桌号、会员 / 称呼（结账单的别名由调用方给：结账单行是 c.id，退款单行是 r.checkout_id） */
const holdersSql = (db: Db, checkoutId: string) => db`
  coalesce((SELECT array_agg(t.code ORDER BY t.code) FROM checkout_bills cb JOIN visits v ON v.id = cb.visit_id
            JOIN hand_tags t ON t.id = v.tag_id WHERE cb.checkout_id = ${db(checkoutId)}), '{}') AS tag_codes,
  coalesce((SELECT array_agg(dt.name ORDER BY dt.name) FROM checkout_bills cb JOIN table_sessions ts ON ts.id = cb.table_session_id
            JOIN dining_tables dt ON dt.id = ts.table_id WHERE cb.checkout_id = ${db(checkoutId)}), '{}') AS table_names,
  coalesce((SELECT array_agg(g.label ORDER BY g.ord) FROM (
              SELECT coalesce(m.name, tm.name, nullif(btrim(v.guest_label), ''), nullif(btrim(ts.guest_label), '')) AS label, coalesce(t.code, dt.name) AS ord
              FROM checkout_bills cb
              LEFT JOIN visits v ON v.id = cb.visit_id LEFT JOIN hand_tags t ON t.id = v.tag_id LEFT JOIN members m ON m.id = v.member_id
              LEFT JOIN table_sessions ts ON ts.id = cb.table_session_id LEFT JOIN dining_tables dt ON dt.id = ts.table_id
              LEFT JOIN members tm ON tm.id = ts.member_id
              WHERE cb.checkout_id = ${db(checkoutId)}) g
            WHERE g.label IS NOT NULL), '{}') AS guests`;

type RowRecord = Omit<OrderRow, 'createdAt'> & { createdAt: string | Date };

const toRow = (r: RowRecord): OrderRow => ({ ...r, createdAt: new Date(r.createdAt).toISOString(), guests: [...new Set(r.guests)], amount: Number(r.amount), refundedAmount: Number(r.refundedAmount) });

/**
 * 查订单。没有搜索词：所选营业日的全部结账单（含这一天反结账的）与退款单，不限张数。
 * 有搜索词：能看历史的跨营业日查，不能的只查当天的；按时间倒序最多 ORDER_SEARCH_LIMIT 张。
 * 退款单：单号对得上的，或者它的原结账单对得上的（查一位客人时退款单跟着一起列出来）。
 */
export async function searchOrders(db: Db, input: OrderSearchInput): Promise<OrderSearchResult> {
  const { q, historyAllowed } = input;
  const date = q ? (historyAllowed ? null : input.today) : input.date;
  const like = `%${escapeLike(q)}%`;
  const checkoutWhere = db`
    ${date ? db`(c.business_date = ${date} OR c.void_business_date = ${date})` : db`true`}
    ${q ? db`AND ${checkoutMatchSql(db, q)}` : db``}`;
  const refundWhere = db`
    ${date ? db`r.business_date = ${date}` : db`true`}
    ${q ? db`AND (r.refund_no ILIKE ${like} OR ${checkoutMatchSql(db, q)})` : db``}`;
  const rows = await db<RowRecord[]>`
    SELECT * FROM (
      SELECT 'checkout' AS kind, c.id, c.checkout_no AS doc_no, c.id AS checkout_id, c.checkout_no, c.created_at,
             to_char(c.business_date, 'YYYY-MM-DD') AS business_date, c.status, c.total_amount AS amount,
             (SELECT coalesce(sum(r.amount), 0) FROM refunds r WHERE r.checkout_id = c.id AND r.status = 'completed')::bigint AS refunded_amount,
             ${holdersSql(db, 'c.id')},
             coalesce((SELECT array_agg(DISTINCT p.method::text) FROM checkout_payments p WHERE p.checkout_id = c.id), '{}') AS methods,
             s.display_name AS operator_name
      FROM checkouts c JOIN staff s ON s.id = c.operator_id
      WHERE ${checkoutWhere}
      UNION ALL
      SELECT 'refund' AS kind, r.id, r.refund_no AS doc_no, r.checkout_id, c.checkout_no, r.created_at,
             to_char(r.business_date, 'YYYY-MM-DD') AS business_date, r.status, r.amount, 0::bigint AS refunded_amount,
             ${holdersSql(db, 'r.checkout_id')},
             coalesce((SELECT array_agg(DISTINCT p.method::text) FROM refund_payments p WHERE p.refund_id = r.id), '{}') AS methods,
             s.display_name AS operator_name
      FROM refunds r JOIN checkouts c ON c.id = r.checkout_id JOIN staff s ON s.id = r.operator_id
      WHERE ${refundWhere}
    ) o
    ORDER BY o.created_at DESC, o.kind DESC, o.id DESC
    ${q ? db`LIMIT ${ORDER_SEARCH_LIMIT + 1}` : db``}`;
  const truncated = !!q && rows.length > ORDER_SEARCH_LIMIT;
  return { q, date, historyAllowed, rows: (truncated ? rows.slice(0, ORDER_SEARCH_LIMIT) : rows).map(toRow), truncated };
}

// ───────────────────────── 逐行明细 ─────────────────────────

/** 按时刻取出来的一行，带它是哪张结账单、哪位客人的（导出用） */
interface LineRecord extends RawOrderLine {
  checkoutId: number;
  guest: string;
}

/**
 * 这些结账单在结账那一刻的明细（与打印的结账单同一个取法：结账时已经挂上、当时还没作废的），
 * 每行带所属部门与它在项目快照里归到的名称（与 yuzu_snapshot_checkout_items 同一套归法）。
 */
async function loadLines(db: Db, checkoutIds: readonly number[]): Promise<LineRecord[]> {
  if (!checkoutIds.length) return [];
  const rows = await db<(Omit<LineRecord, 'holder'> & { tagCode: string | null; tableName: string | null })[]>`
    SELECT c.id AS checkout_id, l.id AS line_id, t.code AS tag_code, dt.name AS table_name,
           coalesce(m.name, tm.name, nullif(btrim(v.guest_label), ''), nullif(btrim(ts.guest_label), ''), '') AS guest,
           l.name,
           CASE WHEN l.ticket_type_id IS NOT NULL THEN '门票'
                WHEN l.source = 'room' THEN '客房'
                WHEN uc.line_id IS NOT NULL THEN coalesce(nullif(sp.business_type, ''), '派对房')
                WHEN l.item_id IS NULL THEN '其他（手动金额、赔偿等）'
                ELSE coalesce(nullif(si.category, ''), '未分类') END AS category,
           CASE WHEN rc.kind = 'night' THEN '房费（全天房）' WHEN rc.kind = 'half_day' THEN '超时半天' WHEN rc.kind = 'block' THEN '钟点房'
                WHEN uc.kind = 'fee' THEN '房费' WHEN uc.kind = 'open_fee' THEN '开台费' ELSE l.name END AS item_name,
           ${technicianTextSql(db, 'l')} AS technician,
           l.quantity, l.unit_price, l.amount
    FROM checkouts c JOIN checkout_bills cb ON cb.checkout_id = c.id
    JOIN bill_lines l ON l.bill_id = cb.bill_id AND l.posted_at <= c.created_at AND (l.voided_at IS NULL OR l.voided_at > c.created_at)
    LEFT JOIN service_items si ON si.id = l.item_id
    LEFT JOIN room_stay_charges rc ON rc.line_id = l.id
    LEFT JOIN space_usage_charges uc ON uc.line_id = l.id
    LEFT JOIN space_usages su ON su.id = uc.usage_id
    LEFT JOIN spaces sp ON sp.id = su.space_id
    LEFT JOIN visits v ON v.id = cb.visit_id LEFT JOIN hand_tags t ON t.id = v.tag_id LEFT JOIN members m ON m.id = v.member_id
    LEFT JOIN table_sessions ts ON ts.id = cb.table_session_id LEFT JOIN dining_tables dt ON dt.id = ts.table_id
    LEFT JOIN members tm ON tm.id = ts.member_id
    WHERE c.id IN ${db(checkoutIds)}
    ORDER BY c.id, coalesce(t.code, dt.name), l.bill_id, l.id`;
  return rows.map(({ tagCode, tableName, ...r }) => ({
    ...r,
    unitPrice: Number(r.unitPrice),
    amount: Number(r.amount),
    holder: tagCode ? `手牌 ${tagCode}` : tableName ? `桌台 ${tableName}` : '',
  }));
}

async function loadItems(db: Db, checkoutIds: readonly number[]): Promise<(OrderItemSnapshot & { checkoutId: number })[]> {
  if (!checkoutIds.length) return [];
  const rows = await db<(OrderItemSnapshot & { checkoutId: number })[]>`
    SELECT checkout_id, category, name, quantity, amount, discount FROM checkout_items
    WHERE checkout_id IN ${db(checkoutIds)} ORDER BY checkout_id, amount DESC, category COLLATE "C", name COLLATE "C"`;
  return rows.map((r) => ({ ...r, amount: Number(r.amount), discount: Number(r.discount) }));
}

type DetailLine = OrderLine & { guest: string };

/**
 * 一张结账单的逐行明细：把结账时按项目记下的优惠摊到每一行。按时刻取出来的明细与项目快照对不上时
 * （按实际时间补录到更早时刻的结账等）改按快照显示，source = 'items'。
 */
function resolveLines(lines: readonly LineRecord[], items: readonly OrderItemSnapshot[]): { lines: DetailLine[]; source: 'lines' | 'items' } {
  // 没有快照（不该出现）：照按时刻取的明细显示，优惠记 0
  const allocated = items.length ? allocateLineDiscounts(lines, items) : lines.map(({ lineId: _l, itemName: _n, ...l }) => ({ ...l, discount: 0 }));
  if (allocated) return { lines: allocated.map(({ checkoutId: _c, ...l }) => l), source: 'lines' };
  return { lines: linesFromItems(items).map((l) => ({ ...l, guest: '' })), source: 'items' };
}

export async function checkoutOrderDetail(db: Db, id: number): Promise<CheckoutOrderDetail> {
  const doc = await checkoutForPrint(db, id);
  const { lines, source } = resolveLines(await loadLines(db, [id]), await loadItems(db, [id]));
  const plain: OrderLine[] = lines.map(({ guest: _g, ...l }) => l);
  return { doc, lines: plain, source, amount: plain.reduce((s, l) => s + l.amount, 0), discount: plain.reduce((s, l) => s + l.discount, 0) };
}

// ───────────────────────── 导出 ─────────────────────────

const EXPORT_HEADER = [
  '营业日', '时间', '单号', '类型', '状态', '手牌 / 桌号', '会员 / 称呼', '部门', '项目', '技师',
  '数量', '单价', '金额', '优惠', '实收', '整单收款方式', '经办人', '原结账单号',
];

const money = (cents: number) => (cents < 0 ? '-' : '') + formatAmount(cents);
const methodLabel = (m: string) => CHECKOUT_METHOD_LABELS[m as CheckoutMethod] ?? m;

/** 当前搜索结果的逐行明细：一行一个消费项目（退款单一行一个退的项目，数量与金额是负数），按时间从早到晚 */
export async function ordersCsv(db: Db, rows: readonly OrderRow[], timeZone: string): Promise<{ csv: string; lines: number }> {
  const checkoutIds = rows.filter((r) => r.kind === 'checkout').map((r) => r.id);
  const refundIds = rows.filter((r) => r.kind === 'refund').map((r) => r.id);
  const allLines = await loadLines(db, checkoutIds);
  const allItems = await loadItems(db, checkoutIds);
  const refundItems = refundIds.length
    ? await db<{ refundId: number; category: string; name: string; quantity: number; amount: number }[]>`
        SELECT refund_id, category, name, quantity, amount FROM refund_items
        WHERE refund_id IN ${db(refundIds)} ORDER BY refund_id, amount DESC, category COLLATE "C", name COLLATE "C"`
    : [];
  const time = (iso: string) => new Date(iso).toLocaleString('zh-CN', { timeZone, hour12: false });
  const body: (string | number)[][] = [];
  for (const r of [...rows].reverse()) {
    const holders = [...r.tagCodes, ...r.tableNames].join('、');
    const guests = r.guests.join('、');
    const head = [r.businessDate, time(r.createdAt), r.docNo, r.kind === 'checkout' ? '结账单' : '退款单', orderStatusLabel(r)];
    const tail = [r.methods.map(methodLabel).join('、'), r.operatorName, r.kind === 'refund' ? r.checkoutNo : ''];
    if (r.kind === 'checkout') {
      const { lines } = resolveLines(allLines.filter((l) => l.checkoutId === r.id), allItems.filter((i) => i.checkoutId === r.id));
      for (const l of lines) {
        body.push([
          ...head,
          l.holder ? l.holder.replace(/^(手牌|桌台) /, '') : holders,
          l.guest || (l.holder ? '' : guests),
          l.category,
          l.name,
          l.technician ?? '',
          l.quantity,
          l.unitPrice == null ? '' : money(l.unitPrice),
          money(l.amount),
          money(l.discount),
          money(l.amount - l.discount),
          ...tail,
        ]);
      }
    } else {
      for (const i of refundItems.filter((x) => x.refundId === r.id)) {
        const amount = -Number(i.amount);
        body.push([...head, holders, guests, i.category, i.name, '', -i.quantity, '', money(amount), money(0), money(amount), ...tail]);
      }
    }
  }
  return { csv: toCsv([EXPORT_HEADER, ...body]), lines: body.length };
}

// ───────────────────────── 接口 ─────────────────────────

const OrdersQuery = z.object({
  q: z.string().trim().max(ORDER_QUERY_MAX, `搜索词最多 ${ORDER_QUERY_MAX} 个字`).optional(),
  date: z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD').optional(),
});

export function registerOrderRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;

  /** 搜索的范围：没有搜索词时按所选营业日（历史营业日要权限）；有搜索词时所选营业日不起作用 */
  const scope = async (req: FastifyRequest): Promise<OrderSearchInput> => {
    const query = parse(OrdersQuery, req.query);
    const q = query.q ?? '';
    const today = await resolveReadableDate(deps, req, undefined);
    const date = q ? today : await resolveReadableDate(deps, req, query.date);
    return { q, date, today, historyAllowed: can(req.actor, 'ledger.readHistory') };
  };

  /** 不是今天的单（结账、反结账、退款都不在今天）要「查看历史营业日」 */
  const needReadable = async (req: FastifyRequest, dates: (string | null)[]) => {
    if (can(req.actor, 'ledger.readHistory')) return;
    const today = await resolveReadableDate(deps, req, undefined);
    if (!dates.includes(today)) throw forbidden('当前岗位只能查看本营业日的记录');
  };

  app.get('/api/ledger/orders', { preHandler: guard('ledger.readToday') }, async (req): Promise<OrderSearchResult> => {
    const input = await scope(req);
    return readSnapshot(sql, (tx) => searchOrders(tx, input));
  });

  app.get('/api/ledger/orders/checkouts/:id', { preHandler: guard('ledger.readToday') }, async (req): Promise<CheckoutOrderDetail> => {
    const { id } = parse(idParam, req.params);
    const [c] = await sql<{ businessDate: string; voidBusinessDate: string | null }[]>`
      SELECT to_char(business_date, 'YYYY-MM-DD') AS business_date, to_char(void_business_date, 'YYYY-MM-DD') AS void_business_date
      FROM checkouts WHERE id = ${id}`;
    if (!c) throw notFound('结账单不存在');
    await needReadable(req, [c.businessDate, c.voidBusinessDate]);
    return readSnapshot(sql, (tx) => checkoutOrderDetail(tx, id));
  });

  app.get('/api/ledger/orders/refunds/:id', { preHandler: guard('ledger.readToday') }, async (req): Promise<RefundOrderDetail> => {
    const { id } = parse(idParam, req.params);
    const [r] = await sql<{ businessDate: string }[]>`SELECT to_char(business_date, 'YYYY-MM-DD') AS business_date FROM refunds WHERE id = ${id}`;
    if (!r) throw notFound('退款单不存在');
    await needReadable(req, [r.businessDate]);
    return readSnapshot(sql, (tx) => getRefund(tx, id));
  });

  // 导出当前搜索结果的逐行明细（与页面上列出来的是同一批单）
  app.get('/api/ledger/orders/export', { preHandler: guard('ledger.export') }, async (req, reply) => {
    const input = await scope(req);
    const { result, csv, lines } = await readSnapshot(sql, async (tx) => {
      const found = await searchOrders(tx, input);
      return { result: found, ...(await ordersCsv(tx, found.rows, deps.config.timezone)) };
    });
    await writeAudit(sql, {
      staffId: req.actor.id,
      action: 'export',
      targetType: 'orders',
      targetId: result.date ?? 'search',
      detail: { q: result.q, date: result.date, orders: result.rows.length, lines, truncated: result.truncated },
      ip: req.ip,
    });
    return csvReply(reply, `浴族订单明细-${result.q ? '搜索结果' : result.date}.csv`, csv);
  });
}
