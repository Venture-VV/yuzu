// 供应商货款：期初未付、付款登记（核销到具体货款）、供应商余额与对账单。
//
// 口径：供应商余额 = 期初未付 + 已确认收货货款 − 已确认退货扣款 − 净付款。
// 应付只来自已生效的收货与退货、已确认的期初未付与付款；对账、导出、重复打开页面都不会新增应付。
// 付款只登记线下已完成的付款，必须全额核销到同一供应商的具体货款，不能超额或重复核销。
// 同一供应商的付款与期初未付在供应商行锁内串行处理。

import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can } from '@shared/permissions';
import {
  PAYMENT_METHODS,
  type OpenItem,
  type OpeningPayableDoc,
  type PayablesOverview,
  type PaymentDoc,
  type Statement,
  type StatementRow,
  type SupplierBalance,
} from '@shared/purchasing';
import { formatAmount } from '@shared/money';
import { isUniqueViolation, readSnapshot, type Db, type Tx } from '../../db';
import { guard } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import type { Actor, Deps } from '../../lib/context';
import { toCsv } from '../../lib/csv';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { idParam, parse, positiveCents } from '../../lib/validate';
import { assertNotFuture, docDateSchema, loadInventorySettings, logApproval, nextDocNo, setTxTimeouts, todayIn } from './common';

const id = z.number().int().positive();
const ReasonInput = z.object({ reason: z.string().trim().min(2, '请填写原因（至少 2 个字）').max(200) });
const hashRequest = (payload: unknown) => createHash('sha256').update(JSON.stringify(payload)).digest('hex');

async function lockSupplier(tx: Tx, supplierId: number) {
  // 不修改供应商主键；允许库存应付流水的外键校验取得 KEY SHARE，避免与收货冲销互相等待。
  const [s] = await tx<{ id: number; name: string; active: boolean }[]>`SELECT id, name, active FROM suppliers WHERE id = ${supplierId} FOR NO KEY UPDATE`;
  if (!s) throw notFound('供应商不存在');
  return s;
}

// ───────────────────────── 未结清货款 ─────────────────────────

/** 某供应商可以付款核销的货款（已生效收货、已确认期初未付），可排除某笔付款自身的占用 */
export async function openItems(db: Db, supplierId: number, excludePaymentId: number | null = null): Promise<OpenItem[]> {
  const receipts = await db<OpenItem[]>`
    SELECT 'receipt' AS kind, d.id, d.doc_no, d.doc_date AS date, d.amount_cents,
           coalesce((SELECT sum(r.amount_cents) FROM inv_docs r WHERE r.source_doc_id = d.id AND r.doc_type = 'supplier_return' AND r.status = 'confirmed'), 0) AS credit_cents,
           coalesce((SELECT sum(pa.amount_cents) FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
                     WHERE pa.receipt_doc_id = d.id AND p.status = 'confirmed'
                       ${excludePaymentId ? db`AND p.id <> ${excludePaymentId}` : db``}), 0) AS paid_cents,
           coalesce((SELECT sum(pa.amount_cents) FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
                     WHERE pa.receipt_doc_id = d.id AND p.status = 'submitted'
                       ${excludePaymentId ? db`AND p.id <> ${excludePaymentId}` : db``}), 0) AS pending_cents,
           po.doc_no AS purchase_order_no,
           coalesce((SELECT string_agg(m.name, '、' ORDER BY l.line_no) FROM inv_doc_lines l JOIN materials m ON m.id = l.material_id
                     WHERE l.doc_id = d.id AND l.line_no <= 3), '') AS summary
    FROM inv_docs d LEFT JOIN purchase_orders po ON po.id = d.purchase_order_id
    WHERE d.doc_type = 'receipt' AND d.status = 'confirmed' AND d.supplier_id = ${supplierId} AND d.amount_cents > 0
      -- 现付供应商的收货没记应付（货款走费用报销，v0.7.7），不能在这里付款核销
      AND d.settlement = 'credit'
    ORDER BY d.doc_date, d.id`;
  const openings = await db<OpenItem[]>`
    SELECT 'opening' AS kind, o.id, o.doc_no, o.as_of_date AS date, o.amount_cents, 0 AS credit_cents,
           coalesce((SELECT sum(pa.amount_cents) FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
                     WHERE pa.opening_payable_id = o.id AND p.status = 'confirmed'
                       ${excludePaymentId ? db`AND p.id <> ${excludePaymentId}` : db``}), 0) AS paid_cents,
           coalesce((SELECT sum(pa.amount_cents) FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
                     WHERE pa.opening_payable_id = o.id AND p.status = 'submitted'
                       ${excludePaymentId ? db`AND p.id <> ${excludePaymentId}` : db``}), 0) AS pending_cents,
           NULL AS purchase_order_no, coalesce(nullif(o.note, ''), '期初未付') AS summary
    FROM opening_payables o
    WHERE o.status = 'confirmed' AND o.supplier_id = ${supplierId}
    ORDER BY o.as_of_date, o.id`;
  return [...openings, ...receipts].map((i) => ({ ...i, openCents: i.amountCents - i.creditCents - i.paidCents - i.pendingCents }));
}

// ───────────────────────── 期初未付 ─────────────────────────

const OpeningInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  supplierId: id,
  amountCents: positiveCents('期初未付金额'),
  asOfDate: docDateSchema,
  note: z.string().trim().max(200).default(''),
  approveNow: z.boolean().default(false),
});

export async function getOpening(db: Db, openingId: number): Promise<OpeningPayableDoc> {
  const [o] = await db<(OpeningPayableDoc & { supplierId: number; supplierName: string })[]>`
    SELECT o.id, o.doc_no, o.status, o.as_of_date, o.amount_cents, o.note, o.created_by, cb.display_name AS created_by_name, o.created_at,
           ob.display_name AS confirmed_by_name, o.confirmed_at, o.returned_reason, vb.display_name AS voided_by_name, o.voided_at,
           o.void_reason, o.is_synthetic, s.id AS supplier_id, s.name AS supplier_name,
           coalesce((SELECT sum(pa.amount_cents) FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
                     WHERE pa.opening_payable_id = o.id AND p.status = 'confirmed'), 0) AS paid_cents
    FROM opening_payables o JOIN suppliers s ON s.id = o.supplier_id JOIN staff cb ON cb.id = o.created_by
    LEFT JOIN staff ob ON ob.id = o.confirmed_by LEFT JOIN staff vb ON vb.id = o.voided_by
    WHERE o.id = ${openingId}`;
  if (!o) throw notFound('期初未付记录不存在');
  const approvals = await db<OpeningPayableDoc['approvals']>`
    SELECT a.id, a.action, s.display_name AS actor_name, a.reason, a.revision, a.created_at
    FROM approval_logs a JOIN staff s ON s.id = a.actor_id WHERE a.doc_kind = 'opening_payable' AND a.doc_id = ${openingId} ORDER BY a.id`;
  const { supplierId, supplierName, ...rest } = o;
  return { ...rest, supplier: { id: supplierId, name: supplierName }, approvals };
}

async function confirmOpening(tx: Tx, o: { id: number; supplierId: number; amountCents: number; asOfDate: string }, actor: Actor) {
  await tx`UPDATE opening_payables SET status = 'confirmed', confirmed_by = ${actor.id}, confirmed_at = now(), returned_reason = NULL, updated_at = now() WHERE id = ${o.id}`;
  await tx`
    INSERT INTO ap_entries (supplier_id, entry_type, amount_delta_cents, opening_payable_id, entry_date, operator_id)
    VALUES (${o.supplierId}, 'opening', ${o.amountCents}, ${o.id}, ${o.asOfDate}, ${actor.id})`;
  await logApproval(tx, 'opening_payable', o.id, 'approve', actor.id);
}

export async function createOpening(deps: Deps, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(OpeningInput, raw);
  if (input.approveNow && !can(actor, 'inventory.approve')) throw forbidden('当前账号不能确认期初未付，请提交给负责人');
  assertNotFuture(input.asOfDate, deps.config.timezone);
  const requestHash = hashRequest({ ...input, clientKey: undefined });
  const findExisting = async (db: Db) => {
    const [row] = await db<{ opType: string; requestHash: string; refId: number }[]>`SELECT op_type, request_hash, ref_id FROM idempotency_keys WHERE key = ${input.clientKey}`;
    if (!row) return null;
    if (row.opType !== 'opening_payable' || row.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一笔不同的登记，请刷新页面后重新填写');
    return row.refId;
  };
  let openingId: number;
  let replayed = false;
  try {
    const r = await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const existing = await findExisting(tx);
      if (existing) return { id: existing, replayed: true };
      const sup = await lockSupplier(tx, input.supplierId);
      if (!sup.active) throw unprocessable('SUPPLIER_INACTIVE', '供应商已停用');
      const docNo = await nextDocNo(tx, 'opening_payable', 'QF', input.asOfDate);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO opening_payables (doc_no, supplier_id, amount_cents, as_of_date, note, status, client_key, created_by)
        VALUES (${docNo}, ${input.supplierId}, ${input.amountCents}, ${input.asOfDate}, ${input.note}, 'submitted', ${input.clientKey}, ${actor.id})
        RETURNING id`;
      const newId = row!.id;
      await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${input.clientKey}, 'opening_payable', ${requestHash}, ${newId}, ${actor.id})`;
      await logApproval(tx, 'opening_payable', newId, 'create', actor.id);
      await logApproval(tx, 'opening_payable', newId, 'submit', actor.id);
      const rules = (await loadInventorySettings(tx)).approvalRules;
      if (!rules.opening || input.approveNow) await confirmOpening(tx, { id: newId, ...input }, actor);
      await writeAudit(tx, { staffId: actor.id, action: 'payable_doc', targetType: 'opening_payable', targetId: newId, detail: { docNo, amountCents: input.amountCents }, ip });
      return { id: newId, replayed: false };
    });
    openingId = r.id;
    replayed = r.replayed;
  } catch (error) {
    if (isUniqueViolation(error, 'idempotency_keys_pkey') || isUniqueViolation(error, 'opening_payables_client_key_key')) {
      const existing = await findExisting(deps.sql);
      if (!existing) throw error;
      openingId = existing;
      replayed = true;
    } else throw error;
  }
  return { opening: await getOpening(deps.sql, openingId), replayed };
}

async function lockOpening(tx: Tx, openingId: number) {
  const [o] = await tx<{ id: number; status: string; supplierId: number; amountCents: number; asOfDate: string; createdBy: number }[]>`
    SELECT id, status, supplier_id, amount_cents, as_of_date, created_by FROM opening_payables WHERE id = ${openingId}`;
  if (!o) throw notFound('期初未付记录不存在');
  await lockSupplier(tx, o.supplierId);
  const [locked] = await tx<typeof o[]>`
    SELECT id, status, supplier_id, amount_cents, as_of_date, created_by FROM opening_payables WHERE id = ${openingId} FOR UPDATE`;
  return locked!;
}

export async function actOnOpening(deps: Deps, openingId: number, action: 'approve' | 'return' | 'cancel' | 'void' | 'resubmit', raw: unknown, actor: Actor) {
  const reason = action === 'approve' || action === 'resubmit' ? '' : parse(ReasonInput, raw).reason;
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const o = await lockOpening(tx, openingId);
    switch (action) {
      case 'approve':
        if (o.status === 'confirmed') return;
        if (o.status !== 'submitted') throw conflict('INVALID_STATE', '只有待确认的记录可以确认');
        return confirmOpening(tx, o, actor);
      case 'return':
        if (o.status === 'returned') return;
        if (o.status !== 'submitted') throw conflict('INVALID_STATE', '只有待确认的记录可以退回');
        await tx`UPDATE opening_payables SET status = 'returned', returned_reason = ${reason}, updated_at = now() WHERE id = ${o.id}`;
        return logApproval(tx, 'opening_payable', o.id, 'return', actor.id, reason);
      case 'resubmit':
        if (o.status === 'submitted') return;
        if (o.status !== 'returned') throw conflict('INVALID_STATE', '只有退回的记录可以重新提交');
        await tx`UPDATE opening_payables SET status = 'submitted', updated_at = now() WHERE id = ${o.id}`;
        return logApproval(tx, 'opening_payable', o.id, 'submit', actor.id);
      case 'cancel':
        if (o.status === 'cancelled') return;
        if (o.status !== 'submitted' && o.status !== 'returned') throw conflict('INVALID_STATE', '已确认的记录不能撤回，只能冲销');
        if (!can(actor, 'inventory.approve') && o.createdBy !== actor.id) throw forbidden('只能撤回自己登记的记录');
        await tx`UPDATE opening_payables SET status = 'cancelled', returned_reason = ${reason}, updated_at = now() WHERE id = ${o.id}`;
        return logApproval(tx, 'opening_payable', o.id, 'cancel', actor.id, reason);
      case 'void': {
        if (o.status === 'voided') return;
        if (o.status !== 'confirmed') throw conflict('INVALID_STATE', '只有已确认的记录可以冲销');
        const [used] = await tx<{ n: number }[]>`
          SELECT count(*) AS n FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
          WHERE pa.opening_payable_id = ${o.id} AND p.status IN ('confirmed', 'submitted')`;
        if (used!.n > 0) throw conflict('NOT_VOIDABLE', '这笔期初未付已有付款核销，需先冲销付款');
        await tx`UPDATE opening_payables SET status = 'voided', voided_by = ${actor.id}, voided_at = now(), void_reason = ${reason}, updated_at = now() WHERE id = ${o.id}`;
        await tx`
          INSERT INTO ap_entries (supplier_id, entry_type, amount_delta_cents, opening_payable_id, entry_date, operator_id)
          VALUES (${o.supplierId}, 'void', ${-o.amountCents}, ${o.id}, ${todayIn(deps.config.timezone)}, ${actor.id})`;
        return logApproval(tx, 'opening_payable', o.id, 'void', actor.id, reason);
      }
    }
  });
  return getOpening(deps.sql, openingId);
}

// ───────────────────────── 付款 ─────────────────────────

const AllocationInput = z.object({
  kind: z.enum(['receipt', 'opening']),
  targetId: id,
  amountCents: positiveCents('核销金额'),
});

const PaymentInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  supplierId: id,
  payDate: docDateSchema,
  amountCents: positiveCents('付款金额'),
  method: z.enum(PAYMENT_METHODS),
  evidence: z.string().trim().min(2, '请填写凭据说明，例如转账流水号后四位').max(200),
  note: z.string().trim().max(200).default(''),
  allocations: z.array(AllocationInput).min(1, '请选择这笔付款对应的货款').max(100),
  approveNow: z.boolean().default(false),
});

export async function getPayment(db: Db, paymentId: number): Promise<PaymentDoc> {
  const [p] = await db<(PaymentDoc & { supplierId: number; supplierName: string })[]>`
    SELECT p.id, p.doc_no, p.status, p.pay_date, p.amount_cents, p.method, p.evidence, p.note, p.created_by, cb.display_name AS created_by_name,
           p.created_at, ob.display_name AS confirmed_by_name, p.confirmed_at, p.returned_reason, vb.display_name AS voided_by_name,
           p.voided_at, p.void_reason, p.is_synthetic, s.id AS supplier_id, s.name AS supplier_name
    FROM payments p JOIN suppliers s ON s.id = p.supplier_id JOIN staff cb ON cb.id = p.created_by
    LEFT JOIN staff ob ON ob.id = p.confirmed_by LEFT JOIN staff vb ON vb.id = p.voided_by
    WHERE p.id = ${paymentId}`;
  if (!p) throw notFound('付款记录不存在');
  const allocations = await db<PaymentDoc['allocations']>`
    SELECT pa.id, CASE WHEN pa.receipt_doc_id IS NOT NULL THEN 'receipt' ELSE 'opening' END AS kind,
           coalesce(pa.receipt_doc_id, pa.opening_payable_id) AS target_id, coalesce(d.doc_no, o.doc_no) AS doc_no, pa.amount_cents
    FROM payment_allocations pa LEFT JOIN inv_docs d ON d.id = pa.receipt_doc_id LEFT JOIN opening_payables o ON o.id = pa.opening_payable_id
    WHERE pa.payment_id = ${paymentId} ORDER BY pa.id`;
  const approvals = await db<PaymentDoc['approvals']>`
    SELECT a.id, a.action, s.display_name AS actor_name, a.reason, a.revision, a.created_at
    FROM approval_logs a JOIN staff s ON s.id = a.actor_id WHERE a.doc_kind = 'payment' AND a.doc_id = ${paymentId} ORDER BY a.id`;
  const { supplierId, supplierName, ...rest } = p;
  return { ...rest, supplier: { id: supplierId, name: supplierName }, allocations, approvals };
}

/** 核销校验：目标属于该供应商、仍有未结清金额，且不超过未结清金额 */
async function checkAllocations(tx: Tx, supplierId: number, allocations: { kind: 'receipt' | 'opening'; targetId: number; amountCents: number }[], excludePaymentId: number | null) {
  // 与收货冲销、退货确认使用同一原单行锁。先锁再读余额，避免核销检查后原单失效。
  const receiptIds = [...new Set(allocations.filter((a) => a.kind === 'receipt').map((a) => a.targetId))].sort((a, b) => a - b);
  if (receiptIds.length) await tx`SELECT id FROM inv_docs WHERE id IN ${tx(receiptIds)} ORDER BY id FOR UPDATE`;
  const items = await openItems(tx, supplierId, excludePaymentId);
  const seen = new Set<string>();
  for (const a of allocations) {
    const key = `${a.kind}:${a.targetId}`;
    if (seen.has(key)) throw badRequest('同一笔货款在一次付款里只能核销一次');
    seen.add(key);
    const item = items.find((i) => i.kind === a.kind && i.id === a.targetId);
    if (!item) throw unprocessable('ALLOCATION_TARGET_INVALID', '核销的货款不属于该供应商，或尚未生效 / 已冲销');
    if (a.amountCents > item.openCents) {
      throw conflict(
        'OVER_ALLOCATION',
        item.openCents <= 0
          ? `${item.docNo} 已没有未结清金额，不能重复核销`
          : `${item.docNo} 未结清 ¥${formatAmount(item.openCents)}，本次核销 ¥${formatAmount(a.amountCents)} 超出`,
        { docNo: item.docNo, openCents: item.openCents },
      );
    }
  }
}

async function confirmPayment(tx: Tx, p: { id: number; supplierId: number; amountCents: number; payDate: string }, actor: Actor) {
  const allocs = await tx<{ kind: 'receipt' | 'opening'; targetId: number; amountCents: number }[]>`
    SELECT CASE WHEN receipt_doc_id IS NOT NULL THEN 'receipt' ELSE 'opening' END AS kind,
           coalesce(receipt_doc_id, opening_payable_id) AS target_id, amount_cents
    FROM payment_allocations WHERE payment_id = ${p.id}`;
  await checkAllocations(tx, p.supplierId, allocs, p.id);
  await tx`UPDATE payments SET status = 'confirmed', confirmed_by = ${actor.id}, confirmed_at = now(), returned_reason = NULL, updated_at = now() WHERE id = ${p.id}`;
  await tx`
    INSERT INTO ap_entries (supplier_id, entry_type, amount_delta_cents, payment_id, entry_date, operator_id)
    VALUES (${p.supplierId}, 'payment', ${-p.amountCents}, ${p.id}, ${p.payDate}, ${actor.id})`;
  await logApproval(tx, 'payment', p.id, 'approve', actor.id);
}

export async function createPayment(deps: Deps, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(PaymentInput, raw);
  if (input.approveNow && !can(actor, 'inventory.approve')) throw forbidden('当前账号不能确认付款，请提交给负责人');
  assertNotFuture(input.payDate, deps.config.timezone);
  const total = input.allocations.reduce((s, a) => s + a.amountCents, 0);
  if (total !== input.amountCents) {
    throw badRequest(`核销合计 ¥${formatAmount(total)} 与付款金额 ¥${formatAmount(input.amountCents)} 不一致；首版不登记预付款`);
  }
  const requestHash = hashRequest({ ...input, clientKey: undefined });
  const findExisting = async (db: Db) => {
    const [row] = await db<{ opType: string; requestHash: string; refId: number }[]>`SELECT op_type, request_hash, ref_id FROM idempotency_keys WHERE key = ${input.clientKey}`;
    if (!row) return null;
    if (row.opType !== 'payment' || row.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一笔不同的付款，请刷新页面后重新填写');
    return row.refId;
  };
  let paymentId: number;
  let replayed = false;
  try {
    const r = await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const existing = await findExisting(tx);
      if (existing) return { id: existing, replayed: true };
      await lockSupplier(tx, input.supplierId);
      await checkAllocations(tx, input.supplierId, input.allocations, null);
      const docNo = await nextDocNo(tx, 'payment', 'FK', input.payDate);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO payments (doc_no, supplier_id, pay_date, amount_cents, method, evidence, note, status, client_key, created_by)
        VALUES (${docNo}, ${input.supplierId}, ${input.payDate}, ${input.amountCents}, ${input.method}, ${input.evidence}, ${input.note},
                'submitted', ${input.clientKey}, ${actor.id})
        RETURNING id`;
      const newId = row!.id;
      for (const a of input.allocations) {
        await tx`
          INSERT INTO payment_allocations (payment_id, receipt_doc_id, opening_payable_id, amount_cents)
          VALUES (${newId}, ${a.kind === 'receipt' ? a.targetId : null}, ${a.kind === 'opening' ? a.targetId : null}, ${a.amountCents})`;
      }
      await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${input.clientKey}, 'payment', ${requestHash}, ${newId}, ${actor.id})`;
      await logApproval(tx, 'payment', newId, 'create', actor.id);
      await logApproval(tx, 'payment', newId, 'submit', actor.id);
      const rules = (await loadInventorySettings(tx)).approvalRules;
      if (!rules.payment || input.approveNow) await confirmPayment(tx, { id: newId, ...input }, actor);
      await writeAudit(tx, { staffId: actor.id, action: 'payable_doc', targetType: 'payment', targetId: newId, detail: { docNo, amountCents: input.amountCents }, ip });
      return { id: newId, replayed: false };
    });
    paymentId = r.id;
    replayed = r.replayed;
  } catch (error) {
    if (isUniqueViolation(error, 'idempotency_keys_pkey') || isUniqueViolation(error, 'payments_client_key_key')) {
      const existing = await findExisting(deps.sql);
      if (!existing) throw error;
      paymentId = existing;
      replayed = true;
    } else throw error;
  }
  return { payment: await getPayment(deps.sql, paymentId), replayed };
}

export async function actOnPayment(deps: Deps, paymentId: number, action: 'approve' | 'return' | 'cancel' | 'void' | 'resubmit', raw: unknown, actor: Actor) {
  const reason = action === 'approve' || action === 'resubmit' ? '' : parse(ReasonInput, raw).reason;
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [head] = await tx<{ supplierId: number }[]>`SELECT supplier_id FROM payments WHERE id = ${paymentId}`;
    if (!head) throw notFound('付款记录不存在');
    await lockSupplier(tx, head.supplierId);
    const [p] = await tx<{ id: number; status: string; supplierId: number; amountCents: number; payDate: string; createdBy: number }[]>`
      SELECT id, status, supplier_id, amount_cents, pay_date, created_by FROM payments WHERE id = ${paymentId} FOR UPDATE`;
    switch (action) {
      case 'approve':
        if (p!.status === 'confirmed') return;
        if (p!.status !== 'submitted') throw conflict('INVALID_STATE', '只有待确认的付款可以确认');
        return confirmPayment(tx, p!, actor);
      case 'return':
        if (p!.status === 'returned') return;
        if (p!.status !== 'submitted') throw conflict('INVALID_STATE', '只有待确认的付款可以退回');
        await tx`UPDATE payments SET status = 'returned', returned_reason = ${reason}, updated_at = now() WHERE id = ${p!.id}`;
        return logApproval(tx, 'payment', p!.id, 'return', actor.id, reason);
      case 'resubmit': {
        if (p!.status === 'submitted') return;
        if (p!.status !== 'returned') throw conflict('INVALID_STATE', '只有退回的付款可以重新提交');
        const allocs = await tx<{ kind: 'receipt' | 'opening'; targetId: number; amountCents: number }[]>`
          SELECT CASE WHEN receipt_doc_id IS NOT NULL THEN 'receipt' ELSE 'opening' END AS kind,
                 coalesce(receipt_doc_id, opening_payable_id) AS target_id, amount_cents
          FROM payment_allocations WHERE payment_id = ${p!.id}`;
        await checkAllocations(tx, p!.supplierId, allocs, p!.id);
        await tx`UPDATE payments SET status = 'submitted', updated_at = now() WHERE id = ${p!.id}`;
        return logApproval(tx, 'payment', p!.id, 'submit', actor.id);
      }
      case 'cancel':
        if (p!.status === 'cancelled') return;
        if (p!.status !== 'submitted' && p!.status !== 'returned') throw conflict('INVALID_STATE', '已确认的付款不能撤回，只能冲销');
        if (!can(actor, 'inventory.approve') && p!.createdBy !== actor.id) throw forbidden('只能撤回自己登记的付款');
        await tx`UPDATE payments SET status = 'cancelled', returned_reason = ${reason}, updated_at = now() WHERE id = ${p!.id}`;
        return logApproval(tx, 'payment', p!.id, 'cancel', actor.id, reason);
      case 'void':
        if (p!.status === 'voided') return;
        if (p!.status !== 'confirmed') throw conflict('INVALID_STATE', '只有已确认的付款可以冲销');
        await tx`UPDATE payments SET status = 'voided', voided_by = ${actor.id}, voided_at = now(), void_reason = ${reason}, updated_at = now() WHERE id = ${p!.id}`;
        await tx`
          INSERT INTO ap_entries (supplier_id, entry_type, amount_delta_cents, payment_id, entry_date, operator_id)
          VALUES (${p!.supplierId}, 'void', ${p!.amountCents}, ${p!.id}, ${todayIn(deps.config.timezone)}, ${actor.id})`;
        return logApproval(tx, 'payment', p!.id, 'void', actor.id, reason);
    }
  });
  return getPayment(deps.sql, paymentId);
}

// ───────────────────────── 余额与对账单 ─────────────────────────

/** 应付流水按原业务归类（冲销并入原类别），用于余额与对账汇总 */
const CATEGORIZED = (db: Db) => db`
  SELECT e.id, e.supplier_id, e.entry_type, e.amount_delta_cents, e.entry_date, e.created_at, e.operator_id,
         e.inv_doc_id, e.payment_id, e.opening_payable_id,
         CASE WHEN e.opening_payable_id IS NOT NULL THEN 'opening'
              WHEN e.payment_id IS NOT NULL THEN 'payment'
              WHEN d.doc_type = 'receipt' THEN 'receipt'
              ELSE 'supplier_return' END AS kind
  FROM ap_entries e LEFT JOIN inv_docs d ON d.id = e.inv_doc_id`;

export async function supplierBalances(db: Db): Promise<SupplierBalance[]> {
  const rows = await db<Omit<SupplierBalance, 'openItemCount'>[]>`
    SELECT s.id AS supplier_id, s.code, s.name, s.active,
           coalesce(sum(x.amount_delta_cents) FILTER (WHERE x.kind = 'opening'), 0) AS opening_cents,
           coalesce(sum(x.amount_delta_cents) FILTER (WHERE x.kind = 'receipt'), 0) AS received_cents,
           -coalesce(sum(x.amount_delta_cents) FILTER (WHERE x.kind = 'supplier_return'), 0) AS return_credit_cents,
           -coalesce(sum(x.amount_delta_cents) FILTER (WHERE x.kind = 'payment'), 0) AS paid_cents,
           coalesce(sum(x.amount_delta_cents), 0) AS balance_cents,
           coalesce((SELECT sum(amount_cents) FROM payments WHERE supplier_id = s.id AND status = 'submitted'), 0) AS pending_payment_cents,
           max(x.entry_date)::text AS last_activity
    FROM suppliers s LEFT JOIN (${CATEGORIZED(db)}) x ON x.supplier_id = s.id
    GROUP BY s.id ORDER BY (coalesce(sum(x.amount_delta_cents), 0) <> 0) DESC, s.code`;
  const result: SupplierBalance[] = [];
  for (const r of rows) {
    const items = r.balanceCents !== 0 || r.receivedCents !== 0 ? await openItems(db, r.supplierId) : [];
    result.push({ ...r, openItemCount: items.filter((i) => i.amountCents - i.creditCents - i.paidCents !== 0).length });
  }
  return result;
}

export async function payablesOverview(db: Db): Promise<PayablesOverview> {
  const suppliers = await supplierBalances(db);
  const sum = (k: keyof SupplierBalance) => suppliers.reduce((s, x) => s + (x[k] as number), 0);
  const [pending] = await db<PayablesOverview['pending'][]>`
    SELECT (SELECT count(*) FROM payments WHERE status = 'submitted') AS payments,
           (SELECT count(*) FROM opening_payables WHERE status = 'submitted') AS openings,
           (SELECT count(*) FROM purchase_orders WHERE status = 'submitted') AS purchase_orders`;
  return {
    totals: {
      openingCents: sum('openingCents'),
      receivedCents: sum('receivedCents'),
      returnCreditCents: sum('returnCreditCents'),
      paidCents: sum('paidCents'),
      balanceCents: sum('balanceCents'),
    },
    suppliers,
    pending: pending!,
  };
}

export async function statement(db: Db, supplierId: number, from: string, to: string): Promise<Statement> {
  if (from > to) throw badRequest('开始日期不能晚于结束日期');
  const [s] = await db<{ id: number; code: string; name: string }[]>`SELECT id, code, name FROM suppliers WHERE id = ${supplierId}`;
  if (!s) throw notFound('供应商不存在');
  const [begin] = await db<{ cents: number }[]>`
    SELECT coalesce(sum(amount_delta_cents), 0) AS cents FROM ap_entries WHERE supplier_id = ${supplierId} AND entry_date < ${from}`;
  const raw = await db<(Omit<StatementRow, 'balanceCents'> & { createdAt: string })[]>`
    SELECT x.id, x.entry_date AS date, x.kind, (x.entry_type = 'void') AS is_void,
           CASE WHEN x.inv_doc_id IS NOT NULL THEN 'inv_doc' WHEN x.payment_id IS NOT NULL THEN 'payment' ELSE 'opening_payable' END AS doc_kind,
           coalesce(x.inv_doc_id, x.payment_id, x.opening_payable_id) AS doc_id,
           coalesce(d.doc_no, p.doc_no, o.doc_no) AS doc_no, x.amount_delta_cents, st.display_name AS operator_name, x.created_at,
           CASE
             WHEN x.entry_type = 'void' THEN '冲销：' || coalesce(d.void_reason, p.void_reason, o.void_reason, '')
             WHEN x.kind = 'payment' THEN coalesce(p.evidence, '')
             WHEN x.kind = 'opening' THEN coalesce(o.note, '')
             ELSE coalesce((SELECT string_agg(m.name, '、' ORDER BY l.line_no) FROM inv_doc_lines l JOIN materials m ON m.id = l.material_id
                            WHERE l.doc_id = d.id AND l.line_no <= 3), '')
           END AS note
    FROM (${CATEGORIZED(db)}) x
    LEFT JOIN inv_docs d ON d.id = x.inv_doc_id
    LEFT JOIN payments p ON p.id = x.payment_id
    LEFT JOIN opening_payables o ON o.id = x.opening_payable_id
    JOIN staff st ON st.id = x.operator_id
    WHERE x.supplier_id = ${supplierId} AND x.entry_date BETWEEN ${from} AND ${to}
    ORDER BY x.entry_date, x.id`;
  let balance = begin!.cents;
  const rows: StatementRow[] = raw.map(({ createdAt: _c, ...r }) => {
    balance += r.amountDeltaCents;
    return { ...r, balanceCents: balance };
  });
  const net = (k: string) => rows.filter((r) => r.kind === k).reduce((sum, r) => sum + r.amountDeltaCents, 0);
  return {
    supplier: s,
    from,
    to,
    priceBasis: (await loadInventorySettings(db)).priceBasis,
    beginCents: begin!.cents,
    openingCents: net('opening'),
    receivedCents: net('receipt'),
    returnCreditCents: -net('supplier_return'),
    paidCents: -net('payment'),
    endCents: balance,
    rows,
    openItems: await openItems(db, supplierId),
  };
}

// ───────────────────────── 路由 ─────────────────────────

const KIND_LABELS: Record<StatementRow['kind'], string> = { opening: '期初未付', receipt: '收货货款', supplier_return: '退货扣款', payment: '付款' };
const RangeQuery = z.object({ supplierId: z.coerce.number().int().positive(), from: docDateSchema, to: docDateSchema });
const yuan = (cents: number) => (cents < 0 ? '-' : '') + formatAmount(cents).replace(/,/g, '');

export function registerPayableRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const docId = (req: FastifyRequest) => parse(idParam, req.params).id;

  app.get('/api/payables/overview', { preHandler: guard('payable.read') }, async () => readSnapshot(sql, payablesOverview));
  app.get('/api/payables/suppliers/:id/open-items', { preHandler: guard('payable.read') }, async (req) => openItems(sql, docId(req)));
  app.get('/api/payables/statement', { preHandler: guard('payable.read') }, async (req) => {
    const q = parse(RangeQuery, req.query);
    return readSnapshot(sql, (tx) => statement(tx, q.supplierId, q.from, q.to));
  });
  app.get('/api/payables/statement/export', { preHandler: guard('inventory.export') }, async (req, reply) => {
    const q = parse(RangeQuery, req.query);
    const st = await readSnapshot(sql, (tx) => statement(tx, q.supplierId, q.from, q.to));
    const csv = toCsv([
      [`供应商对账单 ${st.supplier.code} ${st.supplier.name} ${st.from} 至 ${st.to}（价格口径：${st.priceBasis}；门店内部管理口径，非发票或税务核算）`],
      ['上期结余', yuan(st.beginCents), '期初未付', yuan(st.openingCents), '收货货款', yuan(st.receivedCents), '退货扣款', yuan(st.returnCreditCents), '付款', yuan(st.paidCents), '期末余额', yuan(st.endCents)],
      [],
      ['日期', '类型', '单号', '金额（元）', '余额（元）', '说明', '经办'],
      ...st.rows.map((r) => [r.date, (r.isVoid ? '冲销·' : '') + KIND_LABELS[r.kind], r.docNo, yuan(r.amountDeltaCents), yuan(r.balanceCents), r.note, r.operatorName]),
      [],
      ['未结清货款'],
      ['单号', '日期', '货款', '退货扣款', '已付', '待确认付款', '未结清'],
      ...st.openItems.map((i) => [i.docNo, i.date, yuan(i.amountCents), yuan(i.creditCents), yuan(i.paidCents), yuan(i.pendingCents), yuan(i.openCents)]),
    ]);
    await writeAudit(sql, { staffId: req.actor.id, action: 'export', targetType: 'supplier_statement', targetId: q.supplierId, detail: q, ip: req.ip });
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`对账单_${st.supplier.code}_${q.from}_${q.to}.csv`)}`);
    return csv;
  });

  // 期初未付
  app.get('/api/payables/openings', { preHandler: guard('payable.read') }, async (req) => {
    const { supplierId, status } = parse(z.object({ supplierId: z.coerce.number().int().positive().optional(), status: z.string().max(16).optional() }), req.query);
    const rows = await sql<{ id: number }[]>`
      SELECT id FROM opening_payables WHERE true
        ${supplierId ? sql`AND supplier_id = ${supplierId}` : sql``} ${status ? sql`AND status = ${status}` : sql``}
      ORDER BY id DESC LIMIT 200`;
    return Promise.all(rows.map((r) => getOpening(sql, r.id)));
  });
  app.get('/api/payables/openings/:id', { preHandler: guard('payable.read') }, async (req) => getOpening(sql, docId(req)));
  app.post('/api/payables/openings', { preHandler: guard('payable.manage') }, async (req, reply) => {
    const r = await createOpening(deps, req.body, req.actor, req.ip);
    reply.code(r.replayed ? 200 : 201);
    return r;
  });
  for (const action of ['approve', 'return', 'void'] as const) {
    app.post(`/api/payables/openings/:id/${action}`, { preHandler: guard('inventory.approve') }, async (req) => actOnOpening(deps, docId(req), action, req.body, req.actor));
  }
  for (const action of ['cancel', 'resubmit'] as const) {
    app.post(`/api/payables/openings/:id/${action}`, { preHandler: guard('payable.read') }, async (req) => {
      if (!can(req.actor, 'payable.manage') && !can(req.actor, 'inventory.approve')) throw forbidden();
      return actOnOpening(deps, docId(req), action, req.body, req.actor);
    });
  }

  // 付款
  app.get('/api/payables/payments', { preHandler: guard('payable.read') }, async (req) => {
    const { supplierId, status } = parse(z.object({ supplierId: z.coerce.number().int().positive().optional(), status: z.string().max(16).optional() }), req.query);
    const rows = await sql<{ id: number }[]>`
      SELECT id FROM payments WHERE true
        ${supplierId ? sql`AND supplier_id = ${supplierId}` : sql``} ${status ? sql`AND status = ${status}` : sql``}
      ORDER BY pay_date DESC, id DESC LIMIT 200`;
    return Promise.all(rows.map((r) => getPayment(sql, r.id)));
  });
  app.get('/api/payables/payments/by-key/:key', { preHandler: guard('payable.read') }, async (req) => {
    const { key } = parse(z.object({ key: z.uuid() }), req.params);
    const [row] = await sql<{ id: number }[]>`SELECT id FROM payments WHERE client_key = ${key}`;
    return row ? { found: true, payment: await getPayment(sql, row.id) } : { found: false };
  });
  app.get('/api/payables/payments/:id', { preHandler: guard('payable.read') }, async (req) => getPayment(sql, docId(req)));
  app.post('/api/payables/payments', { preHandler: guard('payable.manage') }, async (req, reply) => {
    const r = await createPayment(deps, req.body, req.actor, req.ip);
    reply.code(r.replayed ? 200 : 201);
    return r;
  });
  for (const action of ['approve', 'return', 'void'] as const) {
    app.post(`/api/payables/payments/:id/${action}`, { preHandler: guard('inventory.approve') }, async (req) => actOnPayment(deps, docId(req), action, req.body, req.actor));
  }
  for (const action of ['cancel', 'resubmit'] as const) {
    app.post(`/api/payables/payments/:id/${action}`, { preHandler: guard('payable.read') }, async (req) => {
      if (!can(req.actor, 'payable.manage') && !can(req.actor, 'inventory.approve')) throw forbidden();
      return actOnPayment(deps, docId(req), action, req.body, req.actor);
    });
  }
}
