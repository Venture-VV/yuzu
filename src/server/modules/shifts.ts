// 交班（S3.4；店主 2026-10-27 #11：店员交班时需要做交班表或日结）。
//
//   · 开班：登记备用金；一位员工同时只能有一个未交班的班次；
//   · 交班表：开班到此刻本人经办、仍有效的结账与充值，按收款方式汇总；会员储值、团购券单列（不是现金）；
//     应有现金 = 备用金 + 结账现金 + 充值现金；本班次内本人做的反结账单列提醒（原单的现金是否已退还要人工核对）；
//   · 交班：员工实点现金，系统记下应有现金、差额与汇总快照；员工确认时看到的应有现金与此刻不一致（期间又有收款）时拒绝；
//   · 本人交本人的班；值班经理及以上可以替别人交班（例如员工忘了交班就下班）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { businessDateOf, ISO_DATE } from '@shared/business-date';
import type { CheckoutMethod, CouponPlatform, ShiftRecord, ShiftSummary } from '@shared/checkout';
import type { PaymentMethod } from '@shared/labels';
import { can } from '@shared/permissions';
import type { Db } from '../db';
import { guard } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Deps, OpContext } from '../lib/context';
import { conflict, forbidden, notFound } from '../lib/errors';
import { cents, idParam, parse } from '../lib/validate';
import { resolveReadableDate } from './ledger';
import { loadSettings } from './settings';
import { nextDocNo } from './inventory/common';

/** 本人在 [from, to) 内经办的收款汇总 */
export async function shiftSummary(db: Db, staffId: number, from: Date | string, to: Date | string, openingCash: number): Promise<ShiftSummary> {
  const [co] = await db<{ count: number; total: number }[]>`
    SELECT count(*)::int AS count, coalesce(sum(total_amount), 0) AS total FROM checkouts
    WHERE operator_id = ${staffId} AND status = 'completed' AND created_at >= ${from} AND created_at < ${to}`;
  const checkoutByMethod = await db<{ method: CheckoutMethod; count: number; amount: number }[]>`
    SELECT p.method, count(*)::int AS count, sum(p.amount) AS amount FROM checkout_payments p JOIN checkouts c ON c.id = p.checkout_id
    WHERE c.operator_id = ${staffId} AND c.status = 'completed' AND c.created_at >= ${from} AND c.created_at < ${to}
    GROUP BY p.method ORDER BY p.method`;
  const [rc] = await db<{ count: number; paid: number; bonus: number }[]>`
    SELECT count(*)::int AS count, coalesce(sum(paid_amount), 0) AS paid, coalesce(sum(bonus_amount), 0) AS bonus FROM recharges
    WHERE operator_id = ${staffId} AND created_at >= ${from} AND created_at < ${to}`;
  const rechargeByMethod = await db<{ method: PaymentMethod; count: number; amount: number }[]>`
    SELECT payment_method AS method, count(*)::int AS count, sum(paid_amount) AS amount FROM recharges
    WHERE operator_id = ${staffId} AND created_at >= ${from} AND created_at < ${to}
    GROUP BY payment_method ORDER BY payment_method`;
  const [wc] = await db<{ count: number; total: number }[]>`
    SELECT count(*)::int AS count, coalesce(sum(total_amount), 0) AS total FROM consumptions
    WHERE operator_id = ${staffId} AND checkout_id IS NULL AND status = 'completed' AND created_at >= ${from} AND created_at < ${to}`;
  const coupons = await db<{ platform: CouponPlatform; count: number; amount: number }[]>`
    SELECT platform, count(*)::int AS count, sum(amount) AS amount FROM group_buy_coupons
    WHERE registered_by = ${staffId} AND status = 'active' AND registered_at >= ${from} AND registered_at < ${to}
    GROUP BY platform ORDER BY platform`;
  const voids = await db<ShiftSummary['voids']>`
    SELECT checkout_no, total_amount AS amount, void_reason AS reason, voided_at FROM checkouts
    WHERE voided_by = ${staffId} AND voided_at >= ${from} AND voided_at < ${to} ORDER BY voided_at`;
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
    cash: { opening: openingCash, checkout: cashCheckout, recharge: cashRecharge, expected: openingCash + cashCheckout + cashRecharge },
  };
}

interface ShiftRow extends Omit<ShiftRecord, 'summary'> {
  summary: ShiftSummary | null;
}

export async function getShift(db: Db, id: number, now = new Date()): Promise<ShiftRecord> {
  const [row] = await db<ShiftRow[]>`
    SELECT s.id, s.shift_no, s.staff_id, st.display_name AS staff_name, s.status, s.business_date, s.started_at, s.opening_cash,
           s.ended_at, s.expected_cash, s.counted_cash, s.note, h.display_name AS handed_to_name, c.display_name AS closed_by_name, s.summary
    FROM shifts s JOIN staff st ON st.id = s.staff_id LEFT JOIN staff h ON h.id = s.handed_to LEFT JOIN staff c ON c.id = s.closed_by
    WHERE s.id = ${id}`;
  if (!row) throw notFound('班次不存在');
  return { ...row, summary: row.summary ?? (await shiftSummary(db, row.staffId, row.startedAt, now, row.openingCash)) };
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
  const at = ctx.at ?? new Date();
  await deps.sql.begin(async (tx) => {
    const [s] = await tx<{ id: number; shiftNo: string; staffId: number; status: string; startedAt: string; openingCash: number }[]>`
      SELECT id, shift_no, staff_id, status, started_at, opening_cash FROM shifts WHERE id = ${id} FOR UPDATE`;
    if (!s) throw notFound('班次不存在');
    if (s.status !== 'open') throw conflict('SHIFT_CLOSED', `班次 ${s.shiftNo} 已交班`);
    if (s.staffId !== ctx.actor.id && !can(ctx.actor, 'frontdesk.correct')) throw forbidden('只能交自己的班；替别人交班需要值班经理及以上');
    if (input.handedTo === s.staffId) throw conflict('HANDOVER_SELF', '接班人不能是交班人自己');
    const summary = await shiftSummary(tx, s.staffId, s.startedAt, at, s.openingCash);
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
