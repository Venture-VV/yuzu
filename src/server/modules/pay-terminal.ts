// 支付直连 · 扫码收款（8.0.21，docs/INTEGRATIONS_V8021.md 第 2 节，CW-G / CW7；迁移 148）。
//
// 收款：扫付款码 → 先写一条「支付中」的交易（提交）→ 事务外调支付方 → 结果回写。支付方说「用户正在输密码」时页面每 3 秒查一次
// （服务端去支付方查），最多 60 秒；超时、断网的状态不确定，按支付方查回为准：每分钟的任务继续查，超过 5 分钟没结果的去支付方撤单。
// 到账以后收银员照常点结账 / 充值，请求里带交易编号：入账在结账 / 充值原来的锁之后锁交易一行，核对到账、没被用过、方式与金额一致，
// 记下用在哪（同一笔只能用一次）。收了钱没入账（结账被拒、关了页面）的停在「没入账」：前台顶上提示，可以挂到下一次结账 / 充值，
// 或「原路退回」。交班时有没入账、还在支付中的拦着。反结账解开它用过的交易（不自动退钱）。退款单上扫码收的那部分默认原路退回。
// 现在手选「微信 / 支付宝」、手输金额的做法照旧留着（没配置、或客人用的是别的码时用）。
//
// 锁：收款先取操作编号的咨询锁（`pay_terminal`，与「确认作废」串行）→ 经办人的班次（共享锁，与结账、充值一样）→ 写交易（新行）；
// 查询、撤单、原路退回只锁交易一行（`FOR UPDATE`），对外调用都在事务外；入账在结账 / 充值原来的锁之后锁交易行（几笔按 id 升序）；
// 反结账在结账单之后锁它用过的交易（id 升序）；退款单在结账单之后锁原路退回的交易（id 升序）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AUTH_CODE_PATTERN, DEFAULT_INTEGRATION_SWITCHES, type IntegrationSwitches, type PayProvider, type PayPurpose, type PayRefundView, type PayTerminalStatus, type PayTxView } from '@shared/integrations';
import { can } from '@shared/permissions';
import { PAYMENT_METHOD_LABELS } from '@shared/labels';
import { formatYuan } from '@shared/money';
import type { Db, Fragment, Sql, Tx } from '../db';
import { guard, guardAny } from '../auth/guard';
import { modeOf } from '../integrations/config';
import { maskTail, withCallLog } from '../integrations/calls';
import { payTerminalAdapter, type PayResult, type PayTerminal } from '../integrations/pay-terminal';
import { writeAudit } from '../lib/audit';
import type { Actor, Deps } from '../lib/context';
import { AppError, conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { assertNotFenced, fenceKey } from '../lib/fences';
import { hashRequest } from '../lib/idempotency';
import { setTxTimeouts } from '../lib/tx';
import { idParam, parse } from '../lib/validate';
import { lockPaymentShift, openShiftOf } from './shifts';

/** 支付中超过这么久没结果的去支付方撤单 */
export const PAYING_CLOSE_AFTER_MS = 5 * 60_000;

export async function loadIntegrationSwitches(db: Db): Promise<IntegrationSwitches> {
  const [row] = await db<{ value: Partial<IntegrationSwitches> }[]>`SELECT value FROM settings WHERE key = 'integration_switches'`;
  const v = row?.value ?? {};
  return {
    payTerminal: typeof v.payTerminal === 'boolean' ? v.payTerminal : DEFAULT_INTEGRATION_SWITCHES.payTerminal,
    platformVoucher: typeof v.platformVoucher === 'boolean' ? v.platformVoucher : DEFAULT_INTEGRATION_SWITCHES.platformVoucher,
    voucherReconcileAt: typeof v.voucherReconcileAt === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v.voucherReconcileAt) ? v.voucherReconcileAt : DEFAULT_INTEGRATION_SWITCHES.voucherReconcileAt,
  };
}

export async function payTerminalStatus(deps: Deps): Promise<PayTerminalStatus> {
  return { mode: modeOf(deps.config.integrations, 'pay_terminal'), enabled: (await loadIntegrationSwitches(deps.sql)).payTerminal };
}

/** 现在能用的付款码支付；没配置、门店关了的拒绝 */
async function adapterOrThrow(deps: Deps): Promise<PayTerminal> {
  const a = payTerminalAdapter(deps.config.integrations);
  if (!a) throw conflict('PAY_TERMINAL_OFF', modeOf(deps.config.integrations, 'pay_terminal') === 'live' ? '扫码收款已配置，等联调以后才能用；现在请手选微信 / 支付宝并核实到账' : '没有配置扫码收款；请手选微信 / 支付宝并核实到账');
  if (!(await loadIntegrationSwitches(deps.sql)).payTerminal) throw conflict('PAY_TERMINAL_OFF', '门店关了扫码收款（后台「对外接口」）；请手选微信 / 支付宝并核实到账');
  return a;
}

// ───────────────────────── 读取 ─────────────────────────

async function refundsOf(db: Db, txIds: number[]): Promise<PayRefundView[]> {
  if (!txIds.length) return [];
  const rows = await db<PayRefundView[]>`
    SELECT r.id, r.tx_id, r.out_refund_no, r.amount_cents, r.reason, r.status, r.provider_refund_no, r.fail_reason, r.offline_note,
           rf.refund_no, s.display_name AS staff_name, r.created_at
    FROM pay_refunds r JOIN staff s ON s.id = r.staff_id LEFT JOIN refunds rf ON rf.id = r.refund_id
    WHERE r.tx_id IN ${db(txIds)} ORDER BY r.id`;
  return rows.map((r) => ({ ...r, id: Number(r.id), txId: Number(r.txId), amountCents: Number(r.amountCents) }));
}

async function views(db: Db, where: Fragment): Promise<PayTxView[]> {
  const rows = await db<(Omit<PayTxView, 'consumed' | 'refunds'> & { consumedKind: PayPurpose | null; consumedId: number | null; consumedNo: string | null })[]>`
    SELECT t.id, t.out_trade_no, t.provider, t.purpose, t.amount_cents, t.status, t.provider_trade_no, t.paid_at, t.fail_reason, t.refund_cents,
           t.consumed_kind, t.consumed_id,
           CASE t.consumed_kind WHEN 'checkout' THEN (SELECT checkout_no FROM checkouts WHERE id = t.consumed_id)
                                WHEN 'recharge' THEN (SELECT doc_no FROM recharges WHERE id = t.consumed_id) END AS consumed_no,
           s.display_name AS staff_name, t.created_at
    FROM pay_transactions t JOIN staff s ON s.id = t.staff_id
    WHERE ${where}
    ORDER BY t.id DESC LIMIT 200`;
  const refunds = await refundsOf(db, rows.map((r) => Number(r.id)));
  return rows.map(({ consumedKind, consumedId, consumedNo, ...r }) => ({
    ...r,
    id: Number(r.id),
    amountCents: Number(r.amountCents),
    refundCents: Number(r.refundCents),
    consumed: consumedKind ? { kind: consumedKind, id: Number(consumedId), docNo: consumedNo ?? '' } : null,
    refunds: refunds.filter((x) => x.txId === Number(r.id)),
  }));
}

export async function payTxView(db: Db, id: number): Promise<PayTxView> {
  const [v] = await views(db, db`t.id = ${id}`);
  if (!v) throw notFound('扫码收款记录不存在');
  return v;
}

// ───────────────────────── 收款 ─────────────────────────

const StartInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  provider: z.enum(['wechat', 'alipay'], '请选择微信或支付宝'),
  purpose: z.enum(['checkout', 'recharge'], '用途不对'),
  amountCents: z.number('请填写金额').int('金额要是整数分').positive('金额要大于 0').max(10_000_000, '单笔最多 ¥100,000'),
  /** 付款码：只在这一次调用支付方时用，不存、不记 */
  authCode: z.string('请扫客人的付款码').trim().regex(AUTH_CODE_PATTERN, '付款码不对（16–24 位数字），请重新扫'),
});

const abandoned = () => conflict('OP_ABANDONED', '这笔扫码收款已经确认作废，没有收款；请重新扫码');

const dateStamp = (d: Date) => d.toISOString().slice(2, 10).replaceAll('-', '');

/** 结果回写：只认「支付中」的交易；支付方说还在等、查不到的不动 */
async function applyResult(db: Sql, id: number, r: PayResult): Promise<void> {
  if (r.status === 'paying' || r.status === 'unknown') return;
  await db.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [t] = await tx<{ status: string }[]>`SELECT status FROM pay_transactions WHERE id = ${id} FOR UPDATE`;
    if (!t || t.status !== 'paying') return;
    if (r.status === 'paid') {
      await tx`UPDATE pay_transactions SET status = 'paid', provider_trade_no = ${r.providerTradeNo ?? null}, paid_at = ${r.paidAt ?? new Date()}, updated_at = now() WHERE id = ${id}`;
    } else {
      await tx`UPDATE pay_transactions SET status = ${r.status}, fail_reason = ${(r.error ?? (r.status === 'closed' ? '已撤单' : '没付成')).slice(0, 200)}, updated_at = now() WHERE id = ${id}`;
    }
  });
}

async function callPay(deps: Deps, a: PayTerminal, t: { id: number; provider: PayProvider; outTradeNo: string; amountCents: number }, authCode: string, staffId: number): Promise<PayResult> {
  try {
    return await withCallLog(
      deps.sql,
      { kind: 'pay_terminal', provider: t.provider, action: 'pay', mode: a.mode, refType: 'pay_transaction', refId: t.id, request: { outTradeNo: t.outTradeNo, amountCents: t.amountCents, authCode: maskTail(authCode) }, staffId },
      () => a.pay({ provider: t.provider, outTradeNo: t.outTradeNo, amountCents: t.amountCents, authCode, subject: '浴场消费' }),
      (r) => ({ status: r.status, providerTradeNo: r.providerTradeNo ?? null, error: r.error ?? null }),
    );
  } catch {
    // 断网、超时：结果不确定，按支付方查回为准
    return { status: 'unknown' };
  }
}

async function callQuery(deps: Deps, a: PayTerminal, t: { id: number; provider: PayProvider; outTradeNo: string }): Promise<PayResult> {
  try {
    return await withCallLog(
      deps.sql,
      { kind: 'pay_terminal', provider: t.provider, action: 'query', mode: a.mode, refType: 'pay_transaction', refId: t.id, request: { outTradeNo: t.outTradeNo } },
      () => a.query({ provider: t.provider, outTradeNo: t.outTradeNo }),
      (r) => ({ status: r.status, providerTradeNo: r.providerTradeNo ?? null, error: r.error ?? null }),
    );
  } catch {
    return { status: 'unknown' };
  }
}

export async function startPay(deps: Deps, raw: unknown, actor: Actor, ip?: string): Promise<{ tx: PayTxView; replayed: boolean }> {
  const input = parse(StartInput, raw);
  if (!can(actor, input.purpose === 'checkout' ? 'frontdesk.checkout' : 'recharge.create')) throw forbidden(input.purpose === 'checkout' ? '当前岗位不能结账收款' : '当前岗位不能充值');
  const a = await adapterOrThrow(deps);
  const requestHash = hashRequest({ provider: input.provider, purpose: input.purpose, amountCents: input.amountCents });
  const seenShift = await openShiftOf(deps.sql, actor.id);
  const r = await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await assertNotFenced(tx, input.clientKey, 'pay_terminal', abandoned);
    const [prev] = await tx<{ id: number; requestHash: string }[]>`SELECT id, request_hash FROM pay_transactions WHERE client_key = ${input.clientKey}`;
    if (prev) {
      if (prev.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '这个操作编号已经用在另一笔扫码收款上，请刷新后重新扫码');
      return { id: Number(prev.id), replayed: true };
    }
    const shiftId = await lockPaymentShift(tx, actor.id, seenShift);
    const [seq] = await tx<{ id: string }[]>`SELECT nextval('pay_transactions_id_seq')::text AS id`;
    const id = seq!.id;
    const outTradeNo = `YZP${dateStamp(new Date())}${id.padStart(8, '0')}`;
    await tx`
      INSERT INTO pay_transactions (id, out_trade_no, provider, adapter, purpose, amount_cents, client_key, request_hash, staff_id, shift_id)
      VALUES (${id}, ${outTradeNo}, ${input.provider}, ${a.mode}, ${input.purpose}, ${input.amountCents}, ${input.clientKey}, ${requestHash}, ${actor.id}, ${shiftId})`;
    await writeAudit(tx, { staffId: actor.id, action: 'pay_terminal', targetType: 'pay_transaction', targetId: Number(id), detail: { op: 'start', outTradeNo, provider: input.provider, amountCents: input.amountCents, purpose: input.purpose }, ip });
    return { id: Number(id), replayed: false };
  });
  if (!r.replayed) {
    const [t] = await deps.sql<{ outTradeNo: string }[]>`SELECT out_trade_no FROM pay_transactions WHERE id = ${r.id}`;
    const result = await callPay(deps, a, { id: r.id, provider: input.provider, outTradeNo: t!.outTradeNo, amountCents: input.amountCents }, input.authCode, actor.id);
    await applyResult(deps.sql, r.id, result);
  }
  return { tx: await payTxView(deps.sql, r.id), replayed: r.replayed };
}

/** 页面每 3 秒查一次：还在支付中的去支付方查 */
export async function refreshPay(deps: Deps, id: number): Promise<PayTxView> {
  const [t] = await deps.sql<{ status: string; provider: PayProvider; outTradeNo: string }[]>`SELECT status, provider, out_trade_no FROM pay_transactions WHERE id = ${id}`;
  if (!t) throw notFound('扫码收款记录不存在');
  if (t.status === 'paying') {
    const a = payTerminalAdapter(deps.config.integrations);
    if (a) await applyResult(deps.sql, id, await callQuery(deps, a, { id, provider: t.provider, outTradeNo: t.outTradeNo }));
  }
  return payTxView(deps.sql, id);
}

/** 每分钟：还在支付中的去查；超过 5 分钟没结果的撤单。返回处理了几笔 */
export async function sweepPaying(deps: Deps, now = new Date()): Promise<number> {
  const a = payTerminalAdapter(deps.config.integrations);
  if (!a) return 0;
  const rows = await deps.sql<{ id: number; provider: PayProvider; outTradeNo: string; createdAt: Date }[]>`
    SELECT id, provider, out_trade_no, created_at FROM pay_transactions WHERE status = 'paying' ORDER BY id LIMIT 50`;
  let n = 0;
  for (const t of rows) {
    const id = Number(t.id);
    const r = await callQuery(deps, a, { id, provider: t.provider, outTradeNo: t.outTradeNo });
    if (r.status !== 'paying' && r.status !== 'unknown') {
      await applyResult(deps.sql, id, r);
      n += 1;
    } else if (now.getTime() - new Date(t.createdAt).getTime() > PAYING_CLOSE_AFTER_MS) {
      const c = await withCallLog(
        deps.sql,
        { kind: 'pay_terminal', provider: t.provider, action: 'close', mode: a.mode, refType: 'pay_transaction', refId: id, request: { outTradeNo: t.outTradeNo } },
        () => a.close({ provider: t.provider, outTradeNo: t.outTradeNo }),
        (x) => ({ closed: x.closed }),
      ).catch(() => ({ closed: false }));
      if (c.closed) {
        await applyResult(deps.sql, id, { status: 'closed', error: '超过 5 分钟没有结果，已去支付方撤单' });
        n += 1;
      }
    }
  }
  return n;
}

// ───────────────────────── 入账、解开 ─────────────────────────

/**
 * 结账 / 充值入账时用掉一笔扫码收款（调用方已经锁好自己的业务行）：锁交易一行，核对到账、没被用过、没退过款、方式与金额一致。
 * 返回支付方单号（记在收款明细 / 充值单的参考号上）。
 */
export async function lockPayTxForUse(tx: Tx, id: number, expect: { provider: string; amountCents: number }): Promise<string> {
  const [t] = await tx<{ status: string; provider: string; amountCents: number; consumedKind: string | null; refundCents: number; providerTradeNo: string | null }[]>`
    SELECT status, provider, amount_cents, consumed_kind, refund_cents, provider_trade_no FROM pay_transactions WHERE id = ${id} FOR UPDATE`;
  if (!t) throw notFound('扫码收款记录不存在，请刷新后重试');
  if (t.status !== 'paid') throw conflict('PAY_TX_NOT_PAID', '这笔扫码收款还没到账，不能入账');
  if (t.consumedKind) throw conflict('PAY_TX_USED', '这笔扫码收款已经入过账了，不能再用');
  if (Number(t.refundCents) > 0) throw conflict('PAY_TX_REFUNDED', '这笔扫码收款已经申请过原路退回，不能再入账');
  if (t.provider !== expect.provider) throw unprocessable('PAY_TX_MISMATCH', `这笔扫码收款是${PAYMENT_METHOD_LABELS[t.provider as 'wechat'] ?? t.provider}，和登记的收款方式不一样`);
  if (Number(t.amountCents) !== expect.amountCents) throw unprocessable('PAY_TX_MISMATCH', `这笔扫码收款是 ${formatYuan(Number(t.amountCents))}，和登记的金额不一样`);
  return t.providerTradeNo!;
}

export async function markPayTxUsed(tx: Tx, id: number, kind: PayPurpose, targetId: number, staffId: number) {
  await tx`UPDATE pay_transactions SET consumed_kind = ${kind}, consumed_id = ${targetId}, updated_at = now() WHERE id = ${id}`;
  await tx`INSERT INTO pay_tx_events (tx_id, action, kind, target_id, staff_id) VALUES (${id}, 'consume', ${kind}, ${targetId}, ${staffId})`;
}

/** 反结账：解开这张结账单用过的扫码收款（id 升序锁），回到「没入账」；不自动退钱 */
export async function releasePayTxs(tx: Tx, kind: PayPurpose, targetId: number, staffId: number, note: string): Promise<number> {
  const rows = await tx<{ id: number }[]>`
    SELECT id FROM pay_transactions WHERE consumed_kind = ${kind} AND consumed_id = ${targetId} ORDER BY id FOR UPDATE`;
  for (const r of rows) {
    await tx`UPDATE pay_transactions SET consumed_kind = NULL, consumed_id = NULL, updated_at = now() WHERE id = ${r.id}`;
    await tx`INSERT INTO pay_tx_events (tx_id, action, kind, target_id, note, staff_id) VALUES (${r.id}, 'release', ${kind}, ${targetId}, ${note.slice(0, 200)}, ${staffId})`;
  }
  return rows.length;
}

/** 交班前：这个班次还有没入账、还在支付中的扫码收款 */
export async function unsettledPayOfShift(db: Db, shiftId: number): Promise<{ unconsumed: number; paying: number }> {
  const [r] = await db<{ unconsumed: number; paying: number }[]>`
    SELECT count(*) FILTER (WHERE status = 'paid' AND consumed_kind IS NULL AND refund_cents = 0)::int AS unconsumed,
           count(*) FILTER (WHERE status = 'paying')::int AS paying
    FROM pay_transactions WHERE shift_id = ${shiftId}`;
  return r!;
}

// ───────────────────────── 原路退回 ─────────────────────────

const refundNo = (id: string | number) => `YZR${dateStamp(new Date())}${String(id).padStart(8, '0')}`;

async function insertRefund(tx: Tx, a: { txId: number; amountCents: number; reason: string; refundId: number | null; clientKey: string | null; staffId: number }) {
  const [seq] = await tx<{ id: string }[]>`SELECT nextval('pay_refunds_id_seq')::text AS id`;
  const id = seq!.id;
  await tx`
    INSERT INTO pay_refunds (id, tx_id, out_refund_no, amount_cents, reason, refund_id, client_key, staff_id)
    VALUES (${id}, ${a.txId}, ${refundNo(id)}, ${a.amountCents}, ${a.reason}, ${a.refundId}, ${a.clientKey}, ${a.staffId})`;
  await tx`UPDATE pay_transactions SET refund_cents = refund_cents + ${a.amountCents}, updated_at = now() WHERE id = ${a.txId}`;
  return Number(id);
}

/**
 * 退款单（refunds.ts）上原路退回的部分：在结账单之后按交易 id 升序锁这张结账单用这种方式扫码收的交易，按还能退的分配，写待退。
 * 返回待退的记录（事务提交以后由调用方 processRefunds 去支付方退）；扫码收的不够退的抛错。
 */
export async function queueCheckoutRefund(tx: Tx, a: { checkoutId: number; provider: string; amountCents: number; reason: string; refundId: number; staffId: number }): Promise<number[]> {
  const txs = await tx<{ id: number; amountCents: number; refundCents: number }[]>`
    SELECT id, amount_cents, refund_cents FROM pay_transactions
    WHERE consumed_kind = 'checkout' AND consumed_id = ${a.checkoutId} AND provider = ${a.provider} ORDER BY id FOR UPDATE`;
  let left = a.amountCents;
  const ids: number[] = [];
  for (const t of txs) {
    const can = Number(t.amountCents) - Number(t.refundCents);
    if (can <= 0 || left <= 0) continue;
    const take = Math.min(can, left);
    ids.push(await insertRefund(tx, { txId: Number(t.id), amountCents: take, reason: a.reason, refundId: a.refundId, clientKey: null, staffId: a.staffId }));
    left -= take;
  }
  if (left > 0) throw unprocessable('PAY_REFUND_OVER', `这张结账单${PAYMENT_METHOD_LABELS[a.provider as 'wechat'] ?? a.provider}扫码收的钱只够原路退 ${formatYuan(a.amountCents - left)}；多出的请不勾「原路退回」，登记商户后台的退款单号`);
  return ids;
}

/** 去支付方退（事务外）：只处理「退款中」的；结果回写 */
export async function processRefunds(deps: Deps, ids: number[]): Promise<void> {
  const a = payTerminalAdapter(deps.config.integrations);
  for (const id of ids) {
    const [r] = await deps.sql<{ status: string; outRefundNo: string; amountCents: number; reason: string; outTradeNo: string; provider: PayProvider; totalCents: number; txId: number }[]>`
      SELECT r.status, r.out_refund_no, r.amount_cents, r.reason, t.out_trade_no, t.provider, t.amount_cents AS total_cents, t.id AS tx_id
      FROM pay_refunds r JOIN pay_transactions t ON t.id = r.tx_id WHERE r.id = ${id}`;
    if (!r || r.status !== 'pending') continue;
    let result: { status: 'done' | 'failed'; providerRefundNo?: string; error?: string };
    if (!a) result = { status: 'failed', error: '扫码收款现在没有配置，退不了；请改成「线下已退」并写明怎么退的' };
    else {
      result = await withCallLog(
        deps.sql,
        { kind: 'pay_terminal', provider: r.provider, action: 'refund', mode: a.mode, refType: 'pay_refund', refId: id, request: { outTradeNo: r.outTradeNo, outRefundNo: r.outRefundNo, amountCents: Number(r.amountCents) } },
        () => a.refund({ provider: r.provider, outTradeNo: r.outTradeNo, outRefundNo: r.outRefundNo, amountCents: Number(r.amountCents), totalCents: Number(r.totalCents), reason: r.reason }),
        (x) => ({ status: x.status, providerRefundNo: x.providerRefundNo ?? null, error: x.error ?? null }),
      ).catch((e: unknown) => ({ status: 'failed' as const, error: `支付方没有回应：${e instanceof Error ? e.message : String(e)}`.slice(0, 200) }));
    }
    await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const [cur] = await tx<{ status: string }[]>`SELECT status FROM pay_refunds WHERE id = ${id} FOR UPDATE`;
      if (cur?.status !== 'pending') return;
      if (result.status === 'done') {
        await tx`UPDATE pay_refunds SET status = 'done', provider_refund_no = ${result.providerRefundNo ?? r.outRefundNo}, done_at = now(), updated_at = now() WHERE id = ${id}`;
      } else {
        await tx`UPDATE pay_refunds SET status = 'failed', fail_reason = ${(result.error ?? '退款失败').slice(0, 200)}, updated_at = now() WHERE id = ${id}`;
      }
    });
  }
}

const Reason = z.string('请写原因').trim().min(2, '请写原因（至少 2 个字）').max(200, '原因最多 200 个字');

/** 没入账的扫码收款整笔原路退回 */
export async function refundUnconsumed(deps: Deps, txId: number, raw: unknown, actor: Actor, ip?: string): Promise<PayTxView> {
  const input = parse(z.object({ clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'), reason: Reason }), raw);
  const ids = await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [prev] = await tx<{ id: number; txId: number }[]>`SELECT id, tx_id FROM pay_refunds WHERE client_key = ${input.clientKey}`;
    if (prev) {
      if (Number(prev.txId) !== txId) throw conflict('IDEMPOTENCY_CONFLICT', '这个操作编号已经用在另一笔退款上，请刷新后重试');
      return [Number(prev.id)];
    }
    const [t] = await tx<{ status: string; consumedKind: string | null; refundCents: number; amountCents: number; outTradeNo: string }[]>`
      SELECT status, consumed_kind, refund_cents, amount_cents, out_trade_no FROM pay_transactions WHERE id = ${txId} FOR UPDATE`;
    if (!t) throw notFound('扫码收款记录不存在');
    if (t.status !== 'paid') throw conflict('PAY_TX_NOT_PAID', '这笔没到账，不用退');
    if (t.consumedKind) throw conflict('PAY_TX_USED', '这笔已经入账了：要退请开退款单（原路退回）或反结账');
    if (Number(t.refundCents) > 0) throw conflict('PAY_TX_REFUNDED', '这笔已经申请过原路退回');
    const id = await insertRefund(tx, { txId, amountCents: Number(t.amountCents), reason: input.reason, refundId: null, clientKey: input.clientKey, staffId: actor.id });
    await writeAudit(tx, { staffId: actor.id, action: 'pay_terminal', targetType: 'pay_transaction', targetId: txId, detail: { op: 'refund_unconsumed', outTradeNo: t.outTradeNo, amountCents: Number(t.amountCents), reason: input.reason }, ip });
    return [id];
  });
  await processRefunds(deps, ids);
  return payTxView(deps.sql, txId);
}

/** 原路退款失败的：重试，或改成线下已退（写明怎么退的） */
export async function resolveRefund(deps: Deps, refundId: number, raw: unknown, actor: Actor, ip?: string): Promise<PayTxView> {
  const input = parse(z.discriminatedUnion('action', [z.object({ action: z.literal('retry') }), z.object({ action: z.literal('offline'), note: Reason })]), raw);
  const txId = await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [r] = await tx<{ status: string; txId: number }[]>`SELECT status, tx_id FROM pay_refunds WHERE id = ${refundId} FOR UPDATE`;
    if (!r) throw notFound('原路退款记录不存在');
    if (input.action === 'retry') {
      if (r.status === 'pending') return Number(r.txId);
      if (r.status !== 'failed') throw conflict('INVALID_STATE', '只有退款失败的能重试');
      await tx`UPDATE pay_refunds SET status = 'pending', fail_reason = NULL, updated_at = now() WHERE id = ${refundId}`;
    } else {
      if (r.status === 'offline') return Number(r.txId);
      if (r.status !== 'failed') throw conflict('INVALID_STATE', '只有退款失败的能改成线下已退');
      await tx`UPDATE pay_refunds SET status = 'offline', offline_note = ${input.note}, updated_at = now() WHERE id = ${refundId}`;
    }
    await writeAudit(tx, { staffId: actor.id, action: 'pay_terminal', targetType: 'pay_refund', targetId: refundId, detail: { op: input.action, ...(input.action === 'offline' ? { note: input.note } : {}) }, ip });
    return Number(r.txId);
  });
  if (input.action === 'retry') await processRefunds(deps, [refundId]);
  return payTxView(deps.sql, txId);
}

// ───────────────────────── 路由 ─────────────────────────

export function registerPayTerminalRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const payers = guardAny('frontdesk.checkout', 'recharge.create');
  app.get('/api/pay/terminal/status', { preHandler: payers }, async () => payTerminalStatus(deps));
  app.post('/api/pay/terminal', { preHandler: payers }, async (req, reply) => {
    const r = await startPay(deps, req.body, req.actor, req.ip);
    reply.code(r.replayed ? 200 : 201);
    return r.tx;
  });
  /** 没入账、退款失败的（前台顶上的提示与处理）：全店的，最多 200 笔 */
  app.get('/api/pay/terminal/open', { preHandler: payers }, async () =>
    views(sql, sql`(t.status = 'paid' AND t.consumed_kind IS NULL AND t.refund_cents = 0) OR t.status = 'paying' OR EXISTS (SELECT 1 FROM pay_refunds r WHERE r.tx_id = t.id AND r.status IN ('pending', 'failed'))`),
  );
  app.get('/api/pay/terminal/:id', { preHandler: payers }, async (req) => refreshPay(deps, parse(idParam, req.params).id));
  // 结果待确认：按操作编号查回（交易在调支付方之前就提交了，查不到就是请求没到）；确认作废后原请求即使到达也不生效
  const KeyParam = z.object({ key: z.uuid('操作编号格式不正确') });
  app.get('/api/pay/terminal/by-key/:key', { preHandler: payers }, async (req) => {
    const { key } = parse(KeyParam, req.params);
    const [t] = await sql<{ id: number }[]>`SELECT id FROM pay_transactions WHERE client_key = ${key}`;
    if (!t) throw new AppError(404, 'NOT_FOUND', '没有查到这笔扫码收款（请求可能没到服务器）');
    return refreshPay(deps, Number(t.id));
  });
  app.post('/api/pay/terminal/by-key/:key/abandon', { preHandler: payers }, async (req) => {
    const { key } = parse(KeyParam, req.params);
    const r = await sql.begin(async (tx) => fenceKey(tx, key, 'pay_terminal', req.actor.id));
    if ('existingOpType' in r) {
      const [t] = await sql<{ id: number }[]>`SELECT id FROM pay_transactions WHERE client_key = ${key}`;
      return { abandoned: false, tx: t ? await refreshPay(deps, Number(t.id)) : null };
    }
    return { abandoned: true, tx: null };
  });
  app.post('/api/pay/terminal/:id/refund', { preHandler: guard('frontdesk.refund') }, async (req) => refundUnconsumed(deps, parse(idParam, req.params).id, req.body, req.actor, req.ip));
  app.post('/api/pay/refunds/:id/resolve', { preHandler: guard('frontdesk.refund') }, async (req) => resolveRefund(deps, parse(idParam, req.params).id, req.body, req.actor, req.ip));
}

