// 退款单（v0.7.20，飞书需求 RQ-006 前半；docs/CASHIER.md 第 3 节）：结账后按项部分退款。
//
//   · 按结账单的项目退（部门营业额快照的一项：同名项目合并成一行）：每项累计不超过数量与实收（应收 − 分摊的优惠、券抵扣）；
//     数量可以是 0（只退钱、不退份数）；退款合计 = 项目合计 = 退款方式合计；
//   · 按原收款方式退：只退原单收过的现金、微信、支付宝、银行卡、其他，每种累计不超过原单这种方式收的钱；
//     会员储值、团购券、优惠 / 免单、券抵扣不能部分退（用反结账）；扫码、银行卡登记退款单号，「其他」写明怎么退的；
//   · 现金从选定的钱箱退（与反结账的跨钱箱退款同一套，lockRefundShift），其余记到经办人自己的班次（lockPaymentShift）；
//   · 值班经理及以上（「开退款单」），结账后超过撤销时限只有店主；有生效的退款单的结账单不能反结账（反结账那边核对）；
//   · 作废：退款当天、记退款的班次还没交班时可以作废（同一权限，写原因），作废后班次、日结、部门都不再算这张；
//   · 不碰账单、来访、会员储值、团购券与技师提成。
// 加锁顺序：经办人或所选钱箱的班次（共享锁）→ 结账单一行；作废：退款单记的班次（共享锁）→ 结账单 → 退款单。
// 反结账同样先锁结账单再核对退款单，两边不会交错；交班只锁班次一行（排他），不会与这里成环。

import { z } from 'zod';
import {
  defaultRefundAmount,
  isCashLike,
  REFUND_METHODS,
  refundNeedsRef,
  type CheckoutMethod,
  type RefundDetail,
  type RefundMethod,
  type RefundOptions,
  type RefundSummary,
} from '@shared/checkout';
import { describeHours, PAYMENT_METHOD_LABELS } from '@shared/labels';
import { formatYuan } from '@shared/money';
import type { Db, Tx } from '../../db';
import { writeAudit } from '../../lib/audit';
import type { Actor, Deps, OpContext } from '../../lib/context';
import { badRequest, conflict, notFound, unprocessable } from '../../lib/errors';
import { parse, positiveCents } from '../../lib/validate';
import { loadSettings } from '../settings';
import { lockPaymentShift, lockRefundShift, openShiftOf, shiftDrawerLabel } from '../shifts';
import { businessDate, hashRequest, nextDocNo, runIdempotent, saveKey, setTxTimeouts } from './common';

// ───────────────────────── 输入 ─────────────────────────

const RefundItemInput = z.object({
  category: z.string('请选择要退的项目').trim().min(1, '请选择要退的项目').max(64),
  name: z.string('请选择要退的项目').trim().min(1, '请选择要退的项目').max(64),
  quantity: z.number('退的份数必须是整数').int('退的份数必须是整数').min(0, '退的份数不能是负数').max(99_999, '退的份数过大'),
  amount: positiveCents('退款金额'),
});
const RefundPaymentInput = z.object({
  method: z.enum(REFUND_METHODS, '退款方式只能是现金、微信、支付宝、银行卡或其他；储值、团购券、优惠与券抵扣请用反结账'),
  amount: positiveCents('退款金额'),
  /** 扫码、银行卡：商户后台的退款单号；其他：写明怎么退的 */
  ref: z.string().trim().max(64, '退款单号最多 64 字').default(''),
});
export const RefundInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  items: z.array(RefundItemInput).min(1, '请选择要退的项目').max(50, '一次最多退 50 项'),
  payments: z.array(RefundPaymentInput).min(1, '请填写退款方式').max(5, '退款方式最多 5 种'),
  reason: z.string('请填写退款原因').trim().min(2, '请填写退款原因（至少 2 个字）').max(200, '原因最多 200 字'),
  /** 退现金从哪个钱箱退（所选钱箱当班的班次）；不带时记到经办人自己的班次 */
  refundShiftId: z.number('钱箱班次不正确').int('钱箱班次不正确').positive('钱箱班次不正确').nullish().transform((v) => v ?? undefined),
});
export type RefundInputData = z.input<typeof RefundInput>;

const VoidRefundInput = z.object({
  reason: z.string('请填写作废原因').trim().min(2, '请填写作废原因（至少 2 个字）').max(200, '原因最多 200 字'),
});

// ───────────────────────── 可退的余量 ─────────────────────────

interface ItemBalance {
  category: string;
  name: string;
  quantity: number;
  amount: number;
  discount: number;
  refundedQuantity: number;
  refundedAmount: number;
}

/** 结账单每一项（部门快照）已退的份数与金额（只算生效的退款单） */
async function itemBalances(db: Db, checkoutId: number): Promise<ItemBalance[]> {
  return db<ItemBalance[]>`
    SELECT ci.category, ci.name, ci.quantity, ci.amount, ci.discount,
           coalesce(sum(ri.quantity) FILTER (WHERE r.status = 'completed'), 0)::int AS refunded_quantity,
           coalesce(sum(ri.amount) FILTER (WHERE r.status = 'completed'), 0)::bigint AS refunded_amount
    FROM checkout_items ci
    LEFT JOIN refund_items ri ON ri.checkout_id = ci.checkout_id AND ri.category = ci.category AND ri.name = ci.name
    LEFT JOIN refunds r ON r.id = ri.refund_id
    WHERE ci.checkout_id = ${checkoutId}
    GROUP BY ci.category, ci.name, ci.quantity, ci.amount, ci.discount
    ORDER BY ci.amount DESC, ci.category COLLATE "C", ci.name COLLATE "C"`;
}

/** 原单每种收款方式收了多少、退款单退过多少（生效的） */
async function methodBalances(db: Db, checkoutId: number) {
  const paid = await db<{ method: CheckoutMethod; amount: number }[]>`
    SELECT method, sum(amount)::bigint AS amount FROM checkout_payments WHERE checkout_id = ${checkoutId} GROUP BY method ORDER BY method`;
  const refunded = await db<{ method: RefundMethod; amount: number }[]>`
    SELECT p.method, sum(p.amount)::bigint AS amount FROM refund_payments p JOIN refunds r ON r.id = p.refund_id
    WHERE r.checkout_id = ${checkoutId} AND r.status = 'completed' GROUP BY p.method`;
  const refundedOf = (m: string) => Number(refunded.find((r) => r.method === m)?.amount ?? 0);
  const methods = paid
    .filter((p): p is { method: RefundMethod; amount: number } => isCashLike(p.method))
    .map((p) => ({ method: p.method, paid: Number(p.amount), refunded: refundedOf(p.method), remaining: Number(p.amount) - refundedOf(p.method) }));
  const nonRefundable = paid.filter((p) => !isCashLike(p.method)).map((p) => ({ method: p.method, amount: Number(p.amount) }));
  return { methods, nonRefundable };
}

const remainingOf = (i: ItemBalance) => ({
  remainingQuantity: i.quantity - i.refundedQuantity,
  remainingAmount: i.amount - i.discount - i.refundedAmount,
});

/** 超过撤销时限（默认 48 小时）只有店主能开、能作废 */
async function windowBlock(db: Db, actor: Actor, checkoutNo: string, createdAt: string, at: Date) {
  const windowHours = (await loadSettings(db)).reversalWindowHours;
  if (windowHours !== null && actor.role !== 'owner' && at.getTime() - new Date(createdAt).getTime() > windowHours * 3_600_000) {
    return {
      code: 'REFUND_WINDOW',
      message: `结账单 ${checkoutNo} 已超过撤销时限（结账后 ${describeHours(windowHours)}内），只有店主可以开退款单`,
      details: { windowHours, checkedOutAt: new Date(createdAt).toISOString() },
    };
  }
  return null;
}

/** 开退款单前的核对（只读）：每项、每种方式还能退多少，不能开的原因 */
export async function refundOptions(db: Db, checkoutId: number, actor: Actor, at = new Date()): Promise<RefundOptions> {
  const [c] = await db<{ id: number; checkoutNo: string; status: 'completed' | 'voided'; createdAt: string; totalAmount: number }[]>`
    SELECT id, checkout_no, status, created_at, total_amount FROM checkouts WHERE id = ${checkoutId}`;
  if (!c) throw notFound('结账单不存在');
  const items = (await itemBalances(db, c.id)).map((i) => ({ ...i, ...remainingOf(i) }));
  const { methods, nonRefundable } = await methodBalances(db, c.id);
  const refundable = Math.min(
    items.reduce((s, i) => s + Math.max(0, i.remainingAmount), 0),
    methods.reduce((s, m) => s + Math.max(0, m.remaining), 0),
  );
  let blocked: RefundOptions['blocked'] = null;
  if (c.status !== 'completed') blocked = { code: 'CHECKOUT_VOIDED', message: `结账单 ${c.checkoutNo} 已反结账，不能开退款单` };
  else if (methods.length === 0) {
    blocked = { code: 'REFUND_NO_METHOD', message: `结账单 ${c.checkoutNo} 是用会员储值、团购券、优惠或券付的，不能部分退款，请用反结账` };
  } else if (refundable <= 0) blocked = { code: 'REFUND_NOTHING_LEFT', message: `结账单 ${c.checkoutNo} 能退的已经退完了` };
  else {
    const w = await windowBlock(db, actor, c.checkoutNo, c.createdAt, at);
    if (w) blocked = { code: w.code, message: w.message };
  }
  return {
    checkoutId: c.id,
    checkoutNo: c.checkoutNo,
    checkoutStatus: c.status,
    createdAt: new Date(c.createdAt).toISOString(),
    totalAmount: c.totalAmount,
    items,
    methods,
    nonRefundable,
    blocked,
    refunds: await listRefundsOf(db, c.id),
  };
}

// ───────────────────────── 开退款单 ─────────────────────────

export async function createRefund(deps: Deps, checkoutId: number, raw: RefundInputData, ctx: OpContext): Promise<RefundDetail> {
  const input = parse(RefundInput, raw);
  const itemKeys = input.items.map((i) => `${i.category}\u0000${i.name}`);
  if (new Set(itemKeys).size !== itemKeys.length) throw badRequest('同一个项目请合并成一行再退');
  if (new Set(input.payments.map((p) => p.method)).size !== input.payments.length) throw badRequest('同一种退款方式请合并成一笔');
  const itemsTotal = input.items.reduce((s, i) => s + i.amount, 0);
  const paysTotal = input.payments.reduce((s, p) => s + p.amount, 0);
  if (itemsTotal !== paysTotal) {
    throw unprocessable('REFUND_NOT_BALANCED', `退的项目合计 ${formatYuan(itemsTotal)}，退款方式合计 ${formatYuan(paysTotal)}，两者要相等`, {
      items: itemsTotal,
      payments: paysTotal,
    });
  }
  const missingRef = input.payments.find((p) => refundNeedsRef(p.method) && p.ref.length < 2);
  if (missingRef) {
    throw badRequest(
      missingRef.method === 'other'
        ? '「其他」退款请写明是怎么退的'
        : `${PAYMENT_METHOD_LABELS[missingRef.method]}退款请登记商户后台的退款单号（在商户后台原路退回后填写）`,
    );
  }
  const cash = input.payments.find((p) => p.method === 'cash');
  if (input.refundShiftId !== undefined && !cash) {
    throw unprocessable('REFUND_SHIFT_NOT_CASH', '这次没有退现金，不用选钱箱；扫码、银行卡的退款记到你当班的交班表');
  }
  const { clientKey: key, ...payload } = input;
  const requestHash = hashRequest({ checkoutId, ...payload });
  // 开始处理时经办人所在的班次：入账前它已交班则整笔拒绝（与结账、反结账同一协议）；选了钱箱时记到所选的班次
  const seenShift = input.refundShiftId === undefined ? await openShiftOf(deps.sql, ctx.actor.id) : null;

  const run = await runIdempotent(deps, { key, opType: 'checkout_refund', requestHash }, async (tx) => {
    const shiftId = input.refundShiftId === undefined ? await lockPaymentShift(tx, ctx.actor.id, seenShift) : await lockRefundShift(tx, input.refundShiftId);
    const at = ctx.at ?? new Date();
    const [c] = await tx<{ id: number; checkoutNo: string; status: string; createdAt: string }[]>`
      SELECT id, checkout_no, status, created_at FROM checkouts WHERE id = ${checkoutId} FOR UPDATE`;
    if (!c) throw notFound('结账单不存在');
    if (c.status !== 'completed') throw conflict('CHECKOUT_VOIDED', `结账单 ${c.checkoutNo} 已反结账，不能开退款单`);
    const w = await windowBlock(tx, ctx.actor, c.checkoutNo, c.createdAt, at);
    if (w) throw unprocessable(w.code, w.message, w.details);

    // 每项：份数与金额都不超过剩下的（结账单已锁，别的退款单要等这笔提交后才能核对）
    const balances = await itemBalances(tx, c.id);
    for (const i of input.items) {
      const b = balances.find((x) => x.category === i.category && x.name === i.name);
      if (!b) throw unprocessable('REFUND_ITEM_NOT_FOUND', `结账单 ${c.checkoutNo} 里没有「${i.name}」这一项，请刷新后重新选择`);
      const left = remainingOf(b);
      if (i.quantity > left.remainingQuantity) {
        throw unprocessable('REFUND_EXCEEDS', `「${b.name}」最多还能退 ${left.remainingQuantity} 份（共 ${b.quantity} 份，已退 ${b.refundedQuantity} 份）`, {
          name: b.name,
          remainingQuantity: left.remainingQuantity,
        });
      }
      if (i.amount > left.remainingAmount) {
        throw unprocessable(
          'REFUND_EXCEEDS',
          `「${b.name}」最多还能退 ${formatYuan(Math.max(0, left.remainingAmount))}（实收 ${formatYuan(b.amount - b.discount)}，已退 ${formatYuan(b.refundedAmount)}）`,
          { name: b.name, remainingAmount: left.remainingAmount },
        );
      }
      // 退几份最多退这几份的实收：剩下的金额按剩下的份数比例算到分，尾差留给最后一份（与页面的默认金额同一算法）；
      // 份数 0（只退钱，例如服务打折补偿）只受整项剩下的金额限制（Codex 预检 1c8b453 P2）
      if (i.quantity > 0) {
        const cap = defaultRefundAmount(left, i.quantity);
        if (i.amount > cap) {
          throw unprocessable('REFUND_EXCEEDS', `「${b.name}」退 ${i.quantity} 份最多退 ${formatYuan(cap)}（这几份的实收）；只退钱不退份数请把份数填 0`, {
            name: b.name,
            quantity: i.quantity,
            maxAmount: cap,
          });
        }
      }
    }
    // 每种方式：原单收过、累计不超过原单这种方式收的钱
    const { methods } = await methodBalances(tx, c.id);
    for (const p of input.payments) {
      const m = methods.find((x) => x.method === p.method);
      if (!m) {
        throw unprocessable('REFUND_METHOD_NOT_PAID', `结账单 ${c.checkoutNo} 没有用${PAYMENT_METHOD_LABELS[p.method]}收款，只能按原收款方式退`, {
          method: p.method,
        });
      }
      if (p.amount > m.remaining) {
        throw unprocessable(
          'REFUND_METHOD_EXCEEDS',
          `${PAYMENT_METHOD_LABELS[p.method]}最多还能退 ${formatYuan(m.remaining)}（原单收 ${formatYuan(m.paid)}，已退 ${formatYuan(m.refunded)}）`,
          { method: p.method, remaining: m.remaining },
        );
      }
    }

    const date = await businessDate(tx, deps, at);
    const refundNo = await nextDocNo(tx, 'refund', 'TK', date);
    const [r] = await tx<{ id: number }[]>`
      INSERT INTO refunds (refund_no, checkout_id, client_key, amount, reason, business_date, operator_id, created_at, shift_id)
      VALUES (${refundNo}, ${c.id}, ${key}, ${itemsTotal}, ${input.reason}, ${date}, ${ctx.actor.id}, ${at}, ${shiftId})
      RETURNING id`;
    for (const i of input.items) {
      await tx`
        INSERT INTO refund_items (refund_id, checkout_id, category, name, quantity, amount)
        VALUES (${r!.id}, ${c.id}, ${i.category}, ${i.name}, ${i.quantity}, ${i.amount})`;
    }
    for (const p of input.payments) {
      await tx`INSERT INTO refund_payments (refund_id, method, amount, ref) VALUES (${r!.id}, ${p.method}, ${p.amount}, ${p.ref})`;
    }
    // 从别人的钱箱退现金：审计写明记到了谁的哪个班次
    const drawer = shiftId ? await shiftDrawerLabel(tx, shiftId, ctx.actor.id) : null;
    await saveKey(tx, key, 'checkout_refund', requestHash, r!.id, ctx.actor.id);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'checkout_refund',
      targetType: 'refund',
      targetId: r!.id,
      detail: {
        docNo: refundNo,
        checkoutNo: c.checkoutNo,
        amount: itemsTotal,
        reason: input.reason,
        items: input.items,
        payments: input.payments.map((p) => ({ method: p.method, amount: p.amount, ref: p.ref })),
        ...(drawer && !drawer.mine ? { refundShift: drawer.shiftNo, refundDrawer: drawer.label } : {}),
      },
      ip: ctx.ip,
      businessDate: date,
    });
    return r!.id;
  });
  return getRefund(deps.sql, run.refId);
}

// ───────────────────────── 作废退款单 ─────────────────────────

/**
 * 作废登记错的退款单：退款当天、记退款的班次还没交班时可以（同一权限、写原因）；作废后像没退过。
 * 先对退款单记的班次加共享锁（交班等这笔提交后再汇总，不会把作废前的退款记进已交的班次快照），再锁结账单与退款单
 */
export async function voidRefund(deps: Deps, refundId: number, raw: unknown, ctx: OpContext): Promise<RefundDetail> {
  const { reason } = parse(VoidRefundInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [peek] = await tx<{ checkoutId: number; shiftId: number | null }[]>`SELECT checkout_id, shift_id FROM refunds WHERE id = ${refundId}`;
    if (!peek) throw notFound('退款单不存在');
    if (peek.shiftId !== null) {
      const [s] = await tx<{ status: string; shiftNo: string; staffName: string }[]>`
        SELECT s.status, s.shift_no, coalesce(s.drawer_name, st.display_name) AS staff_name FROM shifts s JOIN staff st ON st.id = s.staff_id
        WHERE s.id = ${peek.shiftId} FOR SHARE OF s`;
      if (s!.status !== 'open') {
        throw conflict('REFUND_SHIFT_CLOSED', `这张退款单记在${s!.staffName}的班次 ${s!.shiftNo}，已经交班，不能再作废；请店主处理`, { shiftNo: s!.shiftNo });
      }
    }
    const at = ctx.at ?? new Date();
    await tx`SELECT id FROM checkouts WHERE id = ${peek.checkoutId} FOR UPDATE`;
    const [r] = await tx<{ id: number; refundNo: string; status: string; businessDate: string; amount: number; checkoutNo: string }[]>`
      SELECT r.id, r.refund_no, r.status, to_char(r.business_date, 'YYYY-MM-DD') AS business_date, r.amount, c.checkout_no
      FROM refunds r JOIN checkouts c ON c.id = r.checkout_id WHERE r.id = ${refundId} FOR UPDATE OF r`;
    if (r!.status !== 'completed') throw conflict('ALREADY_VOIDED', `退款单 ${r!.refundNo} 已作废`);
    const today = await businessDate(tx, deps, at);
    if (r!.businessDate !== today) {
      throw conflict('REFUND_VOID_DAY_PASSED', `退款单 ${r!.refundNo} 是 ${r!.businessDate} 的，过了营业日不能作废；请店主处理`, {
        businessDate: r!.businessDate,
      });
    }
    await tx`
      UPDATE refunds SET status = 'voided', voided_at = ${at}, voided_by = ${ctx.actor.id}, void_reason = ${reason} WHERE id = ${r!.id}`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'checkout_refund_void',
      targetType: 'refund',
      targetId: r!.id,
      detail: { docNo: r!.refundNo, checkoutNo: r!.checkoutNo, amount: r!.amount, reason },
      ip: ctx.ip,
      businessDate: today,
    });
  });
  return getRefund(deps.sql, refundId);
}

/** 反结账前核对（结账单已锁）：有生效的退款单就不能反结账 */
export async function assertNoRefunds(tx: Tx, checkout: { id: number; checkoutNo: string }) {
  const [r] = await tx<{ refundNo: string }[]>`
    SELECT refund_no FROM refunds WHERE checkout_id = ${checkout.id} AND status = 'completed' ORDER BY id LIMIT 1`;
  if (r) {
    throw conflict('REFUND_EXISTS', `结账单 ${checkout.checkoutNo} 已有退款单 ${r.refundNo}，不能再反结账；还要退请继续开退款单（登记错的退款单当班可以先作废）`, {
      refundNo: r.refundNo,
    });
  }
}

// ───────────────────────── 查询 ─────────────────────────

const summarySql = (db: Db) => db`
  SELECT r.id, r.refund_no, r.checkout_id, c.checkout_no, r.amount, r.reason, r.status, to_char(r.business_date, 'YYYY-MM-DD') AS business_date,
         r.created_at, s.display_name AS operator_name,
         coalesce((SELECT array_agg(p.method ORDER BY p.id) FROM refund_payments p WHERE p.refund_id = r.id), '{}') AS methods,
         coalesce((SELECT array_agg(t.code ORDER BY t.code) FROM checkout_bills cb JOIN visits v ON v.id = cb.visit_id
                   JOIN hand_tags t ON t.id = v.tag_id WHERE cb.checkout_id = r.checkout_id), '{}') AS tag_codes,
         coalesce((SELECT array_agg(dt.name ORDER BY dt.name) FROM checkout_bills cb JOIN table_sessions ts ON ts.id = cb.table_session_id
                   JOIN dining_tables dt ON dt.id = ts.table_id WHERE cb.checkout_id = r.checkout_id), '{}') AS table_names
  FROM refunds r JOIN checkouts c ON c.id = r.checkout_id JOIN staff s ON s.id = r.operator_id`;

const toSummary = (r: RefundSummary): RefundSummary => ({ ...r, createdAt: new Date(r.createdAt).toISOString() });

export async function listRefundsOf(db: Db, checkoutId: number): Promise<RefundSummary[]> {
  const rows = await db<RefundSummary[]>`${summarySql(db)} WHERE r.checkout_id = ${checkoutId} ORDER BY r.id`;
  return rows.map(toSummary);
}

/** 某个营业日开的退款单（含已作废的，作废只能在当天） */
export async function listRefunds(db: Db, date: string): Promise<RefundSummary[]> {
  const rows = await db<RefundSummary[]>`${summarySql(db)} WHERE r.business_date = ${date} ORDER BY r.id DESC`;
  return rows.map(toSummary);
}

export async function getRefund(db: Db, id: number): Promise<RefundDetail> {
  const [r] = await db<RefundSummary[]>`${summarySql(db)} WHERE r.id = ${id}`;
  if (!r) throw notFound('退款单不存在');
  const items = await db<RefundDetail['items']>`
    SELECT category, name, quantity, amount FROM refund_items WHERE refund_id = ${id} ORDER BY amount DESC, category COLLATE "C", name COLLATE "C"`;
  const payments = await db<RefundDetail['payments']>`SELECT method, amount, ref FROM refund_payments WHERE refund_id = ${id} ORDER BY id`;
  const [extra] = await db<{ shift: RefundDetail['shift']; voidedAt: string | null; voidedByName: string | null; voidReason: string | null }[]>`
    SELECT CASE WHEN s.id IS NULL THEN NULL
                ELSE json_build_object('id', s.id, 'shiftNo', s.shift_no, 'staffName', ss.display_name, 'drawerName', s.drawer_name,
                                       'open', s.status = 'open') END AS shift,
           r.voided_at, vb.display_name AS voided_by_name, r.void_reason
    FROM refunds r LEFT JOIN shifts s ON s.id = r.shift_id LEFT JOIN staff ss ON ss.id = s.staff_id LEFT JOIN staff vb ON vb.id = r.voided_by
    WHERE r.id = ${id}`;
  return {
    ...toSummary(r),
    items,
    payments,
    shift: extra!.shift,
    voidedAt: extra!.voidedAt ? new Date(extra!.voidedAt).toISOString() : null,
    voidedByName: extra!.voidedByName,
    voidReason: extra!.voidReason,
  };
}
