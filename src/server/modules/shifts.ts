// 交班（S3.4；店主 2026-10-27 #11：店员交班时需要做交班表或日结）。
//
//   · 开班：登记备用金；一位员工同时只能有一个未交班的班次；
//   · 交班表：本班次本人经办的结账与充值，按收款方式汇总；会员储值、团购券、优惠 / 免单单列（不是现金）；
//     结账收款算在收款时的班次，之后被反结账也不减；本班次内本人做的反结账按原收款方式列出退款：
//     现金从本班钱箱退，扣减应有现金（原单与反结账在同一班次时两者相抵），扫码、银行卡、团购在商户后台原路退回、只列提醒
//     （R1.2，店主 2026-10-29 签认）；应有现金 = 备用金 + 结账现金 + 充值现金 − 反结账退现金。
//     这个口径只用于升级（迁移 017）之后开的班次：升级时已有的班次里做的反结账仍只列提醒、不扣现金，
//     原单也不计入收款时的班次；反结账时没有开班的（规则关闭时）同样不计入原单的班次——退款没有记到任何班次；
//   · 跨钱箱退款（店主 2026-10-30 定，方案 A）：反结账退现金时可以选从哪个钱箱退——此刻当班的任一班次（默认原单收款的班次，
//     已交班时是反结账人自己的班次）；退款（含其他方式的退款提醒）记到所选班次，扣减它的应有现金，各人交班不再出现负数；
//   · 退款单（v0.7.20，离店后部分退款）：记到办理时的班次（退现金时是所选钱箱当班的班次），现金退款扣减应有现金，
//     微信、支付宝、银行卡、其他列出退款单号只作提醒；当班作废的退款单不算；
//   · 收款前必须先开班（经营规则开关，默认开）：没有开班时充值、结账、反结账整笔拒绝（SHIFT_REQUIRED）；
//   · 交班：员工实点现金，系统记下应有现金、差额与汇总快照；员工确认时看到的应有现金与此刻不一致（期间又有收款）时拒绝；
//   · 本人交本人的班；值班经理及以上可以替别人交班（例如员工忘了交班就下班）。
//
// 班次边界（迁移 016）：充值、结账、反结账在入账事务里记下经办人的班次（lockPaymentShift），交班表按班次汇总，
// 不按单据时间：收款取时间在等锁之前，按时间窗口会把交班之后才提交的收款算进已交的班次之内、又不在快照里。
// 收款与交班的共同协议（G3 复测第 2 轮）：收款开始处理时记下经办人所在的班次（openShiftOf），入账事务在锁业务行之前
// 对班次加共享锁；交班加排他锁。先拿到班次的收款提交后才能交班、计入本班次；先交班的，之后拿到锁的收款若开始时
// 在这个班次上就整笔拒绝（SHIFT_CLOSED），不会出现「开班期间发起、交班之后完成、哪个班次都不算」的收款。
// 加锁顺序：收款先对班次加共享锁（会员记账在会员锁之后），再锁业务行；交班只锁班次一行（排他）、不锁业务行，
// 二者不会互相等待成环。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { businessDateOf, ISO_DATE } from '@shared/business-date';
import type { RefundShiftOptions, ShiftRecord, ShiftSummary } from '@shared/checkout';
import { can } from '@shared/permissions';
import type { Db, Tx } from '../db';
import { guard } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Deps, OpContext } from '../lib/context';
import { conflict, forbidden, notFound } from '../lib/errors';
import { cents, idParam, parse } from '../lib/validate';
import { resolveReadableDate } from './ledger';
import { loadSettings } from './settings';
import { nextDocNo } from '../lib/tx';
import { ctxOf } from '../lib/context';

/** 收款开始处理时经办人未交班的班次（不加锁，没有开班时为 null）；入账事务里交给 lockPaymentShift 核对 */
export async function openShiftOf(db: Db, staffId: number): Promise<number | null> {
  const [row] = await db<{ id: number }[]>`SELECT id FROM shifts WHERE staff_id = ${staffId} AND status = 'open'`;
  return row?.id ?? null;
}

/**
 * 收款事务（充值、结账、反结账）在锁业务行之前调用（重复提交查回原单时不调用）：对经办人此刻未交班的班次加共享锁
 * 直到事务结束，返回这笔要记入的班次（没有开班且规则允许时为 null）。
 *   · 交班对班次加排他锁：已拿到共享锁、正在入账的收款提交后才能交班，计入本班次（员工看到的应有现金过期时 SHIFT_CHANGED）；
 *   · 收款开始处理时（seen）经办人在班上，拿到锁时这个班次已经交班：整笔拒绝（SHIFT_CLOSED），不入账——
 *     否则这笔收款既不在已交班次的快照里，也不属于之后的班次。员工开新班后重新办理，记到新班次；
 *   · 收款前必须先开班（经营规则，默认开）：此刻没有未交班的班次就整笔拒绝（SHIFT_REQUIRED），员工开班后原样重提；
 *     规则关闭时没有开班的照常收款、不记班次，期间开了班的记到新开的班次。
 */
export async function lockPaymentShift(tx: Tx, staffId: number, seen: number | null): Promise<number | null> {
  const [row] = await tx<{ id: number }[]>`SELECT id FROM shifts WHERE staff_id = ${staffId} AND status = 'open' FOR SHARE`;
  const id = row?.id ?? null;
  if (seen !== null && id !== seen) {
    const [s] = await tx<{ shiftNo: string }[]>`SELECT shift_no FROM shifts WHERE id = ${seen}`;
    throw conflict('SHIFT_CLOSED', `班次 ${s!.shiftNo} 在这笔收款入账之前已经交班，这笔没有入账，也不会记入任何班次；请开新班后重新办理`, {
      shiftNo: s!.shiftNo,
    });
  }
  if (id === null && (await loadSettings(tx)).requireOpenShift) {
    throw conflict('SHIFT_REQUIRED', '还没有开班：充值、结账、反结账前请先开班（登记备用金），开班后再办理这一笔');
  }
  return id;
}

/**
 * 跨钱箱退款：反结账的退款记到所选的班次（所选钱箱当班的班次）。与 lockPaymentShift 同一协议——在锁业务行之前
 * 对所选班次加共享锁，交班要等这笔反结账提交后才能汇总（计入它）；所选班次此刻已交班则整笔拒绝，请重新选择。
 * 升级（迁移 017）之前开的班次按原口径不扣现金，不能选。
 */
export async function lockRefundShift(tx: Tx, shiftId: number): Promise<number> {
  const [row] = await tx<{ id: number; status: string; shiftNo: string; staffName: string; legacyRefund: boolean }[]>`
    SELECT s.id, s.status, s.shift_no, st.display_name AS staff_name, s.legacy_refund
    FROM shifts s JOIN staff st ON st.id = s.staff_id WHERE s.id = ${shiftId} FOR SHARE OF s`;
  if (!row) throw notFound('所选钱箱的班次不存在，请刷新后重新选择');
  if (row.status !== 'open') {
    throw conflict('REFUND_SHIFT_CLOSED', `${row.staffName}的班次 ${row.shiftNo} 已经交班，不能再从这个钱箱退款；这笔反结账没有办理，请重新选择钱箱`, {
      shiftNo: row.shiftNo,
    });
  }
  if (row.legacyRefund) throw conflict('REFUND_SHIFT_LEGACY', `班次 ${row.shiftNo} 是升级前开的，退款不按钱箱记；请选别的钱箱或先交班后重新开班`);
  return row.id;
}

/**
 * 反结账退现金可以选的钱箱：此刻当班（未交班、不是升级前开的）的班次。建议的默认：原单收款的班次仍在班上时选它
 * （钱是收进那个钱箱的）；否则是反结账人自己的班次；只有一个当班的班次时选它；都没有时不预选。
 */
export async function refundShiftOptions(db: Db, checkoutId: number, actorId: number): Promise<RefundShiftOptions> {
  const [c] = await db<{ shiftId: number | null }[]>`SELECT shift_id FROM checkouts WHERE id = ${checkoutId}`;
  if (!c) throw notFound('结账单不存在');
  const rows = await db<{ id: number; shiftNo: string; staffId: number; staffName: string; startedAt: string }[]>`
    SELECT s.id, s.shift_no, s.staff_id, st.display_name AS staff_name, s.started_at
    FROM shifts s JOIN staff st ON st.id = s.staff_id WHERE s.status = 'open' AND NOT s.legacy_refund ORDER BY s.started_at, s.id`;
  const shifts = rows.map((r) => ({
    id: r.id,
    shiftNo: r.shiftNo,
    staffName: r.staffName,
    startedAt: new Date(r.startedAt).toISOString(),
    mine: r.staffId === actorId,
    original: r.id === c.shiftId,
  }));
  const suggested = (shifts.find((x) => x.original) ?? shifts.find((x) => x.mine) ?? (shifts.length === 1 ? shifts[0] : undefined))?.id ?? null;
  return { shifts, suggested };
}

interface ShiftScope {
  id: number;
  staffId: number;
  startedAt: string;
  openingCash: number;
  /** 升级（迁移 016）时仍未交班的班次：升级前的单据没有记班次 */
  legacyWindow: boolean;
  /** 升级（迁移 017）时已有的班次：本班次做的反结账按原口径，只列提醒、不扣现金 */
  legacyRefund: boolean;
}

/**
 * 本班次的收款汇总；to 是汇总时刻（显示用，也是时间窗口补算的终点）。
 * 各项用一条语句汇总，取自同一个快照：交班汇总期间其他员工可能正好反结账本班次的单，分多条查询会各自看到
 * 不同时刻的数据，保存的快照里结账合计、收款方式与团购券互相对不上。不用可重复读事务：交班要先等正在入账的
 * 收款提交（班次排他锁），可重复读的快照取在第一条语句开始、早于等锁，会漏掉等到的收款。
 */
async function shiftSummary(db: Db, s: ShiftScope, to: Date | string): Promise<ShiftSummary> {
  const from = s.startedAt;
  // 单据属于本班次：按单据记下的班次。升级时仍未交班的班次，再补上升级前没有记班次、开班之后本人经办的单据
  // （原来的时间窗口口径）；升级之后经办人有未交班的班次时单据都会记下班次，补算不会多算
  const ofShift = (shiftCol: string, staffCol: string, timeCol: string) =>
    s.legacyWindow
      ? db`(${db(shiftCol)} = ${s.id} OR (${db(shiftCol)} IS NULL AND ${db(staffCol)} = ${s.staffId} AND ${db(timeCol)} >= ${from} AND ${db(timeCol)} < ${to}))`
      : db`${db(shiftCol)} = ${s.id}`;
  // co 本班次收款的结账单（含之后被反结账的：收款算在收款时的班次；退款没有按新口径记到班次的反结账除外）；rc 本班次的充值；团购券随结账单登记
  // （同一事务、同一经办人），按结账单的班次；vd 本班次做的反结账（反结账人当时未交班的班次），rf 按原收款方式的退款：
  // 现金扣减应有现金，原单与反结账在同一班次时两者相抵；会员工作台的储值消费不是收款，只作参考，
  // 仍按开班到此刻的时间窗口统计（消费单不记班次）
  const [row] = await db<
    (Omit<ShiftSummary, 'from' | 'to' | 'recharges' | 'cash'> & {
      recharges: Omit<ShiftSummary['recharges'], 'byMethod'>;
      rechargeByMethod: ShiftSummary['recharges']['byMethod'];
      refunds: Omit<NonNullable<ShiftSummary['refunds']>, 'byMethod'>;
      refundByMethod: NonNullable<ShiftSummary['refunds']>['byMethod'];
      depositReceived: NonNullable<ShiftSummary['deposits']>['received'];
      depositRefunded: NonNullable<ShiftSummary['deposits']>['refunded'];
      refundSlipTotals: { count: number; total: number };
      refundSlipByMethod: NonNullable<ShiftSummary['refundSlips']>['byMethod'];
      refundSlipList: NonNullable<ShiftSummary['refundSlips']>['list'];
    })[]
  >`
    WITH co AS (
      SELECT c.id, c.total_amount FROM checkouts c LEFT JOIN shifts vs ON vs.id = c.void_shift_id
      WHERE ${ofShift('c.shift_id', 'c.operator_id', 'c.created_at')}
        AND (c.status = 'completed' OR (vs.id IS NOT NULL AND NOT vs.legacy_refund))
    ), rc AS (
      SELECT r.payment_method, r.paid_amount, r.bonus_amount FROM recharges r
      WHERE ${ofShift('r.shift_id', 'r.operator_id', 'r.created_at')}
    ), pay AS (
      SELECT p.method, count(*) AS count, sum(p.amount) AS amount FROM checkout_payments p JOIN co ON co.id = p.checkout_id
      GROUP BY p.method
    ), rcm AS (
      SELECT payment_method AS method, count(*) AS count, sum(paid_amount) AS amount FROM rc GROUP BY payment_method
    ), cp AS (
      SELECT g.platform, count(*) AS count, sum(g.amount) AS amount FROM group_buy_coupons g JOIN co ON co.id = g.checkout_id
      GROUP BY g.platform
    ), vd AS (
      -- 跨钱箱退款时反结账的是别人（例如值班经理从收银员的钱箱退）：写明是谁做的反结账
      SELECT c.id, c.checkout_no, c.total_amount, c.void_reason, c.voided_at,
             CASE WHEN c.voided_by <> ${s.staffId} THEN vb.display_name END AS voided_by_name,
             (SELECT coalesce(sum(p.amount), 0) FROM checkout_payments p WHERE p.checkout_id = c.id AND p.method = 'cash') AS cash_refund
      FROM checkouts c LEFT JOIN staff vb ON vb.id = c.voided_by
      WHERE ${ofShift('c.void_shift_id', 'c.voided_by', 'c.voided_at')}
    ), rf AS (
      SELECT p.method, sum(p.amount) AS amount FROM checkout_payments p JOIN vd ON vd.id = p.checkout_id GROUP BY p.method
    ), wc AS (
      SELECT total_amount FROM consumptions
      WHERE operator_id = ${s.staffId} AND checkout_id IS NULL AND status = 'completed' AND created_at >= ${from} AND created_at < ${to}
    ), dp AS (
      -- 客房押金（S7）：收、退都记在经办人当班的班次
      SELECT kind, method, count(*) AS count, sum(amount) AS amount FROM room_deposits
      WHERE shift_id = ${s.id} AND kind IN ('receive', 'refund') GROUP BY kind, method
    ), rs AS (
      -- 退款单（v0.7.20）：记到本班次的、生效的（作废只能在班次交班前，作废后不算）；别人从本班钱箱退的写明是谁
      SELECT r.id, r.refund_no, r.amount, r.reason, r.created_at, c.checkout_no,
             CASE WHEN r.operator_id <> ${s.staffId} THEN ob.display_name END AS operator_name
      FROM refunds r JOIN checkouts c ON c.id = r.checkout_id JOIN staff ob ON ob.id = r.operator_id
      WHERE r.shift_id = ${s.id} AND r.status = 'completed'
    ), rsp AS (
      SELECT p.refund_id, p.method, p.amount, p.ref FROM refund_payments p JOIN rs ON rs.id = p.refund_id
    )
    SELECT
      (SELECT json_build_object('count', count(*), 'total', coalesce(sum(total_amount), 0)) FROM co) AS checkouts,
      (SELECT coalesce(json_agg(json_build_object('method', method, 'count', count, 'amount', amount) ORDER BY method), '[]'::json) FROM pay)
        AS checkout_by_method,
      (SELECT json_build_object('count', count(*), 'paid', coalesce(sum(paid_amount), 0), 'bonus', coalesce(sum(bonus_amount), 0)) FROM rc)
        AS recharges,
      (SELECT coalesce(json_agg(json_build_object('method', method, 'count', count, 'amount', amount) ORDER BY method), '[]'::json) FROM rcm)
        AS recharge_by_method,
      (SELECT json_build_object('count', count(*), 'total', coalesce(sum(total_amount), 0)) FROM wc) AS wallet_consumes,
      (SELECT coalesce(json_agg(json_build_object('platform', platform, 'count', count, 'amount', amount) ORDER BY platform), '[]'::json) FROM cp)
        AS coupons,
      (SELECT coalesce(json_agg(json_build_object('checkoutNo', checkout_no, 'amount', total_amount, 'reason', void_reason, 'voidedAt', voided_at,
                                                  'cashRefund', cash_refund, 'voidedByName', voided_by_name)
                                ORDER BY voided_at), '[]'::json) FROM vd) AS voids,
      (SELECT json_build_object('count', count(*), 'total', coalesce(sum(total_amount), 0)) FROM vd) AS refunds,
      (SELECT coalesce(json_agg(json_build_object('method', method, 'amount', amount) ORDER BY method), '[]'::json) FROM rf) AS refund_by_method,
      (SELECT coalesce(json_agg(json_build_object('method', method, 'count', count, 'amount', amount) ORDER BY method), '[]'::json)
       FROM dp WHERE kind = 'receive') AS deposit_received,
      (SELECT coalesce(json_agg(json_build_object('method', method, 'count', count, 'amount', amount) ORDER BY method), '[]'::json)
       FROM dp WHERE kind = 'refund') AS deposit_refunded,
      (SELECT json_build_object('count', count(*), 'total', coalesce(sum(amount), 0)) FROM rs) AS refund_slip_totals,
      (SELECT coalesce(json_agg(json_build_object('method', method, 'count', count, 'amount', amount) ORDER BY method), '[]'::json)
       FROM (SELECT method, count(*) AS count, sum(amount) AS amount FROM rsp GROUP BY method) x) AS refund_slip_by_method,
      (SELECT coalesce(json_agg(json_build_object(
                'refundNo', rs.refund_no, 'checkoutNo', rs.checkout_no, 'amount', rs.amount, 'reason', rs.reason, 'createdAt', rs.created_at,
                'operatorName', rs.operator_name,
                'cash', coalesce((SELECT sum(rsp.amount) FROM rsp WHERE rsp.refund_id = rs.id AND rsp.method = 'cash'), 0),
                'refs', coalesce((SELECT json_agg(json_build_object('method', rsp.method, 'amount', rsp.amount, 'ref', rsp.ref) ORDER BY rsp.method)
                                  FROM rsp WHERE rsp.refund_id = rs.id), '[]'::json))
              ORDER BY rs.created_at, rs.id), '[]'::json) FROM rs) AS refund_slip_list`;
  const { checkouts, checkoutByMethod, recharges, rechargeByMethod, walletConsumes, coupons, refunds, refundByMethod, depositReceived, depositRefunded } = row!;
  const { refundSlipTotals, refundSlipByMethod, refundSlipList } = row!;
  const cashCheckout = checkoutByMethod.find((m) => m.method === 'cash')?.amount ?? 0;
  const cashRecharge = rechargeByMethod.find((m) => m.method === 'cash')?.amount ?? 0;
  // 升级时已有的班次：反结账按原口径只列提醒（与 v0.3 的交班表相同），不列退款、不扣现金
  const cashRefund = s.legacyRefund ? 0 : (refundByMethod.find((m) => m.method === 'cash')?.amount ?? 0);
  // 客房押金的现金：收的计入、退的扣减（押金是负债，交班时钱箱里有这笔钱）；本班次没有押金往来时不列这一项
  const hasDeposits = depositReceived.length > 0 || depositRefunded.length > 0;
  const hasCashDeposit = [...depositReceived, ...depositRefunded].some((m) => m.method === 'cash');
  const cashDeposit = (depositReceived.find((m) => m.method === 'cash')?.amount ?? 0) - (depositRefunded.find((m) => m.method === 'cash')?.amount ?? 0);
  // 退款单（v0.7.20）：现金从本班钱箱退，扣减应有现金；本班次没有退款单时不列这一项
  const hasSlips = refundSlipTotals.count > 0;
  const cashSlip = refundSlipByMethod.find((m) => m.method === 'cash')?.amount ?? 0;
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    checkouts,
    checkoutByMethod,
    recharges: { ...recharges, byMethod: rechargeByMethod },
    walletConsumes,
    coupons,
    // JSON 里的时间是 PostgreSQL 的格式，与单独查询时一样换成 ISO 字符串
    voids: row!.voids.map(({ cashRefund: refund, voidedByName, ...v }) => ({
      ...v,
      voidedAt: new Date(v.voidedAt).toISOString(),
      ...(s.legacyRefund ? {} : { cashRefund: refund }),
      ...(voidedByName ? { voidedByName } : {}),
    })),
    ...(s.legacyRefund ? {} : { refunds: { ...refunds, byMethod: refundByMethod } }),
    ...(hasDeposits ? { deposits: { received: depositReceived, refunded: depositRefunded } } : {}),
    ...(hasSlips
      ? {
          refundSlips: {
            ...refundSlipTotals,
            byMethod: refundSlipByMethod,
            list: refundSlipList.map(({ operatorName, ...r }) => ({
              ...r,
              createdAt: new Date(r.createdAt).toISOString(),
              ...(operatorName ? { operatorName } : {}),
            })),
          },
        }
      : {}),
    cash: {
      opening: s.openingCash,
      checkout: cashCheckout,
      recharge: cashRecharge,
      ...(s.legacyRefund ? {} : { refund: cashRefund }),
      ...(hasCashDeposit ? { deposit: cashDeposit } : {}),
      ...(hasSlips ? { refundSlip: cashSlip } : {}),
      expected: s.openingCash + cashCheckout + cashRecharge - cashRefund + cashDeposit - cashSlip,
    },
  };
}

interface ShiftRow extends Omit<ShiftRecord, 'summary'> {
  summary: ShiftSummary | null;
  legacyWindow: boolean;
  legacyRefund: boolean;
}

/** 已交班的返回交班时的快照；当班中的按此刻汇总 */
export async function getShift(db: Db, id: number, now = new Date()): Promise<ShiftRecord> {
  const [row] = await db<ShiftRow[]>`
    SELECT s.id, s.shift_no, s.staff_id, st.display_name AS staff_name, s.status, s.business_date, s.started_at, s.opening_cash,
           s.ended_at, s.expected_cash, s.counted_cash, s.note, h.display_name AS handed_to_name, c.display_name AS closed_by_name, s.summary,
           s.legacy_window, s.legacy_refund
    FROM shifts s JOIN staff st ON st.id = s.staff_id LEFT JOIN staff h ON h.id = s.handed_to LEFT JOIN staff c ON c.id = s.closed_by
    WHERE s.id = ${id}`;
  if (!row) throw notFound('班次不存在');
  const { legacyWindow: _legacy, legacyRefund: _legacyRefund, ...shift } = row;
  return { ...shift, summary: row.summary ?? (await shiftSummary(db, row, now)) };
}

export async function currentShift(db: Db, staffId: number): Promise<ShiftRecord | null> {
  const [row] = await db<{ id: number }[]>`SELECT id FROM shifts WHERE staff_id = ${staffId} AND status = 'open'`;
  return row ? getShift(db, row.id) : null;
}

export async function listShifts(db: Db, date: string): Promise<ShiftRecord[]> {
  const rows = await db<{ id: number }[]>`
    SELECT id FROM shifts WHERE business_date = ${date} OR (status = 'open' AND business_date < ${date}) ORDER BY started_at DESC`;
  return Promise.all(rows.map((r) => getShift(db, r.id)));
}

const StartInput = z.object({ openingCash: cents('备用金') });
const CloseInput = z.object({
  countedCash: cents('实点现金'),
  /**
   * 员工交班时看到的应有现金；与此刻计算的不一致说明期间又有收款，需要刷新后重新核对。
   * 可以是负数：反结账退的现金算在执行人的班次（R1.2），备用金为 0 的值班经理反结账别人的现金单后应有现金为负，
   * 同一钱箱的人合并核对时与原收款班次相抵
   */
  expectedCash: z.number('应有现金必须是数字').int('应有现金必须精确到分').min(-1_000_000_000, '应有现金过大').max(1_000_000_000, '应有现金过大'),
  note: z.string().trim().max(200, '备注最多 200 字').default(''),
  handedTo: z.number().int().positive().nullable().default(null),
});

export async function startShift(deps: Deps, raw: unknown, ctx: OpContext): Promise<ShiftRecord> {
  const input = parse(StartInput, raw);
  const at = ctx.at ?? new Date();
  const id = await deps.sql.begin(async (tx) => {
    const [open] = await tx<{ shiftNo: string }[]>`SELECT shift_no FROM shifts WHERE staff_id = ${ctx.actor.id} AND status = 'open' FOR UPDATE`;
    if (open) throw conflict('SHIFT_OPEN', `你还有未交班的班次 ${open.shiftNo}，请先交班`);
    const settings = await loadSettings(tx);
    const date = businessDateOf(at, deps.config.timezone, settings.businessDayStartHour);
    const shiftNo = await nextDocNo(tx, 'shift', 'BC', date);
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO shifts (shift_no, staff_id, business_date, started_at, opening_cash)
      VALUES (${shiftNo}, ${ctx.actor.id}, ${date}, ${at}, ${input.openingCash}) RETURNING id`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'shift_started',
      targetType: 'shift',
      targetId: row!.id,
      detail: { docNo: shiftNo, openingCash: input.openingCash },
      ip: ctx.ip,
      businessDate: date,
    });
    return row!.id;
  });
  return getShift(deps.sql, id);
}

export async function closeShift(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<ShiftRecord> {
  const input = parse(CloseInput, raw);
  await deps.sql.begin(async (tx) => {
    // 排他锁：等已对本班次加了共享锁、正在入账的收款提交后再汇总（它们计入本班次）；
    // 之后才拿锁的收款看到本班次已交，不会记进来，所以汇总快照不会漏掉记在本班次的单据
    const [s] = await tx<(ShiftScope & { shiftNo: string; status: string })[]>`
      SELECT id, shift_no, staff_id, status, started_at, opening_cash, legacy_window, legacy_refund FROM shifts WHERE id = ${id} FOR UPDATE`;
    // 交班时刻取在拿到锁之后：快照里的单据都不晚于交班时刻
    const at = ctx.at ?? new Date();
    if (!s) throw notFound('班次不存在');
    if (s.status !== 'open') throw conflict('SHIFT_CLOSED', `班次 ${s.shiftNo} 已交班`);
    if (s.staffId !== ctx.actor.id && !can(ctx.actor, 'frontdesk.correct')) throw forbidden('只能交自己的班；替别人交班需要值班经理及以上');
    if (input.handedTo === s.staffId) throw conflict('HANDOVER_SELF', '接班人不能是交班人自己');
    const summary = await shiftSummary(tx, s, at);
    if (summary.cash.expected !== input.expectedCash) {
      throw conflict('SHIFT_CHANGED', '交班期间又有收款，应有现金已变化，请刷新后重新核对', { expectedCash: summary.cash.expected });
    }
    await tx`
      UPDATE shifts SET status = 'closed', ended_at = ${at}, expected_cash = ${summary.cash.expected}, counted_cash = ${input.countedCash},
                        summary = ${tx.json(summary as never)}, note = ${input.note}, handed_to = ${input.handedTo}, closed_by = ${ctx.actor.id}
      WHERE id = ${s.id}`;
    const settings = await loadSettings(tx);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'shift_closed',
      targetType: 'shift',
      targetId: s.id,
      detail: { docNo: s.shiftNo, expectedCash: summary.cash.expected, countedCash: input.countedCash, diff: input.countedCash - summary.cash.expected, note: input.note },
      ip: ctx.ip,
      businessDate: businessDateOf(at, deps.config.timezone, settings.businessDayStartHour),
    });
  });
  return getShift(deps.sql, id);
}

export function registerShiftRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;

  // today：此刻的营业日（与 /api/auth/me 同一算法）。页面每 30 秒轮询这个接口，过了营业日切换时间不用刷新页面也能提醒跨营业日的班次
  app.get('/api/shifts/current', { preHandler: guard('ledger.readToday') }, async (req) => {
    const settings = await loadSettings(sql);
    return { shift: await currentShift(sql, req.actor.id), today: businessDateOf(new Date(), deps.config.timezone, settings.businessDayStartHour) };
  });

  app.get('/api/shifts', { preHandler: guard('ledger.readToday') }, async (req) => {
    const { date } = parse(z.object({ date: z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD').optional() }), req.query ?? {});
    const list = await listShifts(sql, await resolveReadableDate(deps, req, date));
    // 别人的班次（备用金、实点现金、长短款）与单个班次同一规则：只给能看历史营业日的岗位（默认值班经理及以上）
    return can(req.actor, 'ledger.readHistory') ? list : list.filter((s) => s.staffId === req.actor.id);
  });

  app.get('/api/shifts/:id', { preHandler: guard('ledger.readToday') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const shift = await getShift(sql, id);
    if (shift.staffId !== req.actor.id && !can(req.actor, 'ledger.readHistory')) throw forbidden('只能查看自己的班次');
    return shift;
  });

  app.post('/api/shifts', { preHandler: guard('ledger.readToday') }, async (req) => startShift(deps, req.body, ctxOf(req)));

  app.post('/api/shifts/:id/close', { preHandler: guard('ledger.readToday') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return closeShift(deps, id, req.body, ctxOf(req));
  });
}
