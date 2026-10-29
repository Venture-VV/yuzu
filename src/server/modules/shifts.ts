// 交班（S3.4；店主 2026-10-27 #11：店员交班时需要做交班表或日结）。
//
//   · 开班：登记备用金；一位员工同时只能有一个未交班的班次；
//   · 交班表：本班次本人经办、仍有效的结账与充值，按收款方式汇总；会员储值、团购券单列（不是现金）；
//     应有现金 = 备用金 + 结账现金 + 充值现金；本班次内本人做的反结账单列提醒（原单的现金是否已退还要人工核对）；
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
import type { CheckoutMethod, CouponPlatform, ShiftRecord, ShiftSummary } from '@shared/checkout';
import type { PaymentMethod } from '@shared/labels';
import { can } from '@shared/permissions';
import type { Db, Tx } from '../db';
import { guard } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Deps, OpContext } from '../lib/context';
import { conflict, forbidden, notFound } from '../lib/errors';
import { cents, idParam, parse } from '../lib/validate';
import { resolveReadableDate } from './ledger';
import { loadSettings } from './settings';
import { nextDocNo } from './inventory/common';

/** 收款开始处理时经办人未交班的班次（不加锁，没有开班时为 null）；入账事务里交给 lockPaymentShift 核对 */
export async function openShiftOf(db: Db, staffId: number): Promise<number | null> {
  const [row] = await db<{ id: number }[]>`SELECT id FROM shifts WHERE staff_id = ${staffId} AND status = 'open'`;
  return row?.id ?? null;
}

/**
 * 收款事务（充值、结账、反结账）在锁业务行之前调用（重复提交查回原单时不调用）：对经办人此刻未交班的班次加共享锁
 * 直到事务结束，返回这笔要记入的班次（没有开班时为 null）。
 *   · 交班对班次加排他锁：已拿到共享锁、正在入账的收款提交后才能交班，计入本班次（员工看到的应有现金过期时 SHIFT_CHANGED）；
 *   · 收款开始处理时（seen）经办人在班上，拿到锁时这个班次已经交班：整笔拒绝（SHIFT_CLOSED），不入账——
 *     否则这笔收款既不在已交班次的快照里，也不属于之后的班次。员工开新班后重新办理，记到新班次；
 *   · 收款开始时没有开班的照常收款（开班是可选的），期间开了班的记到新开的班次。
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
  return id;
}

interface ShiftScope {
  id: number;
  staffId: number;
  startedAt: string;
  openingCash: number;
  /** 升级（迁移 016）时仍未交班的班次：升级前的单据没有记班次 */
  legacyWindow: boolean;
}

/** 本班次的收款汇总；to 是汇总时刻（显示用，也是时间窗口补算的终点） */
async function shiftSummary(db: Db, s: ShiftScope, to: Date | string): Promise<ShiftSummary> {
  const from = s.startedAt;
  // 单据属于本班次：按单据记下的班次。升级时仍未交班的班次，再补上升级前没有记班次、开班之后本人经办的单据
  // （原来的时间窗口口径）；升级之后经办人有未交班的班次时单据都会记下班次，补算不会多算
  const ofShift = (shiftCol: string, staffCol: string, timeCol: string) =>
    s.legacyWindow
      ? db`(${db(shiftCol)} = ${s.id} OR (${db(shiftCol)} IS NULL AND ${db(staffCol)} = ${s.staffId} AND ${db(timeCol)} >= ${from} AND ${db(timeCol)} < ${to}))`
      : db`${db(shiftCol)} = ${s.id}`;
  const [co] = await db<{ count: number; total: number }[]>`
    SELECT count(*)::int AS count, coalesce(sum(c.total_amount), 0) AS total FROM checkouts c
    WHERE c.status = 'completed' AND ${ofShift('c.shift_id', 'c.operator_id', 'c.created_at')}`;
  const checkoutByMethod = await db<{ method: CheckoutMethod; count: number; amount: number }[]>`
    SELECT p.method, count(*)::int AS count, sum(p.amount) AS amount FROM checkout_payments p JOIN checkouts c ON c.id = p.checkout_id
    WHERE c.status = 'completed' AND ${ofShift('c.shift_id', 'c.operator_id', 'c.created_at')}
    GROUP BY p.method ORDER BY p.method`;
  const [rc] = await db<{ count: number; paid: number; bonus: number }[]>`
    SELECT count(*)::int AS count, coalesce(sum(r.paid_amount), 0) AS paid, coalesce(sum(r.bonus_amount), 0) AS bonus FROM recharges r
    WHERE ${ofShift('r.shift_id', 'r.operator_id', 'r.created_at')}`;
  const rechargeByMethod = await db<{ method: PaymentMethod; count: number; amount: number }[]>`
    SELECT r.payment_method AS method, count(*)::int AS count, sum(r.paid_amount) AS amount FROM recharges r
    WHERE ${ofShift('r.shift_id', 'r.operator_id', 'r.created_at')}
    GROUP BY r.payment_method ORDER BY r.payment_method`;
  // 会员工作台的储值消费不是收款，只作参考，仍按开班到此刻的时间窗口统计（消费单不记班次）
  const [wc] = await db<{ count: number; total: number }[]>`
    SELECT count(*)::int AS count, coalesce(sum(total_amount), 0) AS total FROM consumptions
    WHERE operator_id = ${s.staffId} AND checkout_id IS NULL AND status = 'completed' AND created_at >= ${from} AND created_at < ${to}`;
  // 团购券随结账单登记（同一事务、同一经办人），按结账单的班次
  const coupons = await db<{ platform: CouponPlatform; count: number; amount: number }[]>`
    SELECT g.platform, count(*)::int AS count, sum(g.amount) AS amount FROM group_buy_coupons g JOIN checkouts c ON c.id = g.checkout_id
    WHERE g.status = 'active' AND ${ofShift('c.shift_id', 'c.operator_id', 'c.created_at')}
    GROUP BY g.platform ORDER BY g.platform`;
  // 反结账提醒：按反结账时记下的班次（反结账人当时未交班的班次）
  const voids = await db<ShiftSummary['voids']>`
    SELECT c.checkout_no, c.total_amount AS amount, c.void_reason AS reason, c.voided_at FROM checkouts c
    WHERE ${ofShift('c.void_shift_id', 'c.voided_by', 'c.voided_at')} ORDER BY c.voided_at`;
  const cashCheckout = checkoutByMethod.find((m) => m.method === 'cash')?.amount ?? 0;
  const cashRecharge = rechargeByMethod.find((m) => m.method === 'cash')?.amount ?? 0;
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    checkouts: co!,
    checkoutByMethod,
    recharges: { ...rc!, byMethod: rechargeByMethod },
    walletConsumes: wc!,
    coupons,
    voids,
    cash: { opening: s.openingCash, checkout: cashCheckout, recharge: cashRecharge, expected: s.openingCash + cashCheckout + cashRecharge },
  };
}

interface ShiftRow extends Omit<ShiftRecord, 'summary'> {
  summary: ShiftSummary | null;
  legacyWindow: boolean;
}

/** 已交班的返回交班时的快照；当班中的按此刻汇总 */
export async function getShift(db: Db, id: number, now = new Date()): Promise<ShiftRecord> {
  const [row] = await db<ShiftRow[]>`
    SELECT s.id, s.shift_no, s.staff_id, st.display_name AS staff_name, s.status, s.business_date, s.started_at, s.opening_cash,
           s.ended_at, s.expected_cash, s.counted_cash, s.note, h.display_name AS handed_to_name, c.display_name AS closed_by_name, s.summary,
           s.legacy_window
    FROM shifts s JOIN staff st ON st.id = s.staff_id LEFT JOIN staff h ON h.id = s.handed_to LEFT JOIN staff c ON c.id = s.closed_by
    WHERE s.id = ${id}`;
  if (!row) throw notFound('班次不存在');
  const { legacyWindow: _legacy, ...shift } = row;
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
  /** 员工交班时看到的应有现金；与此刻计算的不一致说明期间又有收款，需要刷新后重新核对 */
  expectedCash: cents('应有现金'),
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
      SELECT id, shift_no, staff_id, status, started_at, opening_cash, legacy_window FROM shifts WHERE id = ${id} FOR UPDATE`;
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
  const ctxOf = (req: import('fastify').FastifyRequest): OpContext => ({ actor: req.actor, ip: req.ip });

  app.get('/api/shifts/current', { preHandler: guard('ledger.readToday') }, async (req) => ({ shift: await currentShift(sql, req.actor.id) }));

  app.get('/api/shifts', { preHandler: guard('ledger.readToday') }, async (req) => {
    const { date } = parse(z.object({ date: z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD').optional() }), req.query ?? {});
    return listShifts(sql, await resolveReadableDate(deps, req, date));
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
