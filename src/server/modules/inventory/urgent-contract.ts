// 8.1.10 急采后补合同（docs/ERP_V8110.md 第 1 节，PENDING_DECISIONS CK18–CK22）：
//   · 急采收货单生效时合计达到「急采补合同金额」的记下要补合同（inv_docs.needs_contract，在 confirmDoc 里写）；
//   · 补单采购单事后挂合同：只改挂的合同，挂上以后不能换、不能取消；已经付过款、在付款申请里或报销过的不能补；
//   · 补上之前付款申请、直接登记付款、预付款核销、现付报销都拦（CONTRACT_REQUIRED）；
//   · 待补合同清单：期限从急采生效那天算「补合同期限」天，超期的标红，照样能补。
// 加锁：供应商一行（FOR NO KEY UPDATE，与付款登记、付款申请同一把）→ 采购单一行（FOR UPDATE）；合同、付款与报销记录只读。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ContractOption } from '@shared/contracts';
import type { PurchaseOrder } from '@shared/purchasing';
import { guard } from '../../auth/guard';
import type { Db } from '../../db';
import { writeAudit } from '../../lib/audit';
import type { Actor, Deps } from '../../lib/context';
import { conflict, notFound, unprocessable } from '../../lib/errors';
import { idParam, parse } from '../../lib/validate';
import { assertContractForPo, checkAgainstContract, contractOptions } from '../contracts/ledger';
import { setTxTimeouts } from './common';
import { listContractDue } from './contract-due';
import { lockSupplier } from './payables';
import { getPo, lockPo } from './purchasing';

/** 补单采购单已经付过款、在付款申请里或报销过的（CK20）：返回原因，没有为空 */
async function paidProblem(db: Db, poId: number): Promise<string | null> {
  const [paid] = await db<{ docNo: string }[]>`
    SELECT p.doc_no FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id JOIN inv_docs d ON d.id = pa.receipt_doc_id
    WHERE d.purchase_order_id = ${poId} AND p.status IN ('submitted', 'returned', 'confirmed') ORDER BY p.id LIMIT 1`;
  if (paid) return `这张采购单的货款已经登记过付款（${paid.docNo}），不能再补合同`;
  const [req] = await db<{ docNo: string }[]>`
    SELECT r.request_no AS doc_no FROM payment_request_targets t JOIN payment_requests r ON r.id = t.request_id JOIN inv_docs d ON d.id = t.receipt_doc_id
    WHERE d.purchase_order_id = ${poId} AND r.status IN ('submitted', 'returned', 'approved', 'paid') ORDER BY r.id LIMIT 1`;
  if (req) return `这张采购单的货款在付款申请 ${req.docNo} 里，不能再补合同`;
  const [claim] = await db<{ docNo: string }[]>`
    SELECT doc_no FROM expense_claims WHERE purchase_order_id = ${poId} AND status IN ('submitted', 'returned', 'confirmed') ORDER BY id LIMIT 1`;
  if (claim) return `这张采购单已经在报销单 ${claim.docNo} 里报销，不能再补合同`;
  return null;
}

/** 补合同能选的合同（CK21）：这家供应商的采购合同、生效中、到期日不早于下单日（开始日可以晚于下单日） */
export async function backfillContractOptions(db: Db, poId: number): Promise<ContractOption[]> {
  const [po] = await db<{ supplierId: number; orderDate: string; backfill: boolean }[]>`
    SELECT supplier_id, order_date::text, backfill FROM purchase_orders WHERE id = ${poId}`;
  if (!po) throw notFound('采购单不存在');
  if (!po.backfill) throw unprocessable('NOT_BACKFILL', '只有补单采购单在这里补合同；别的采购单在修改或改版时挂合同');
  return contractOptions(db, po.orderDate, Number(po.supplierId), { backfill: true });
}

const AttachInput = z.object({
  contractId: z.number().int().positive(),
  contractNote: z.string().trim().max(200, '说明最多 200 个字').default(''),
});

/**
 * 补合同：只改补单采购单挂的合同（CK20、CK21）。用同一份合同重提照原样返回（天然幂等，不另带操作编号）；
 * 已经挂了别的合同的拒绝（PO_CONTRACT_SET）。
 */
export async function attachBackfillContract(deps: Deps, poId: number, raw: unknown, actor: Actor, ip?: string): Promise<PurchaseOrder> {
  const input = parse(AttachInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [head] = await tx<{ supplierId: number }[]>`SELECT supplier_id FROM purchase_orders WHERE id = ${poId}`;
    if (!head) throw notFound('采购单不存在');
    // 供应商一行（与付款登记、付款申请同一把，FOR NO KEY UPDATE）→ 采购单一行
    await lockSupplier(tx, Number(head.supplierId));
    const po = await lockPo(tx, poId);
    if (!po.backfill) throw unprocessable('NOT_BACKFILL', '只有补单采购单在这里补合同；别的采购单在修改或改版时挂合同');
    if (po.status !== 'approved' && po.status !== 'closed') throw conflict('INVALID_STATE', '这张采购单当前状态不能补合同');
    const [cur] = await tx<{ contractId: number | null; orderDate: string }[]>`
      SELECT contract_id, order_date::text FROM purchase_orders WHERE id = ${poId}`;
    if (cur!.contractId !== null) {
      if (Number(cur!.contractId) === input.contractId) return; // 原样重提
      throw conflict('PO_CONTRACT_SET', '这张采购单已经挂了合同；挂上以后不能换');
    }
    await assertContractForPo(tx, input.contractId, Number(po.supplierId), cur!.orderDate, { backfill: true });
    const problem = await paidProblem(tx, poId);
    if (problem) throw conflict('PO_ALREADY_PAID', problem);
    const [c] = await tx<{ contractNo: string }[]>`SELECT contract_no FROM contracts WHERE id = ${input.contractId}`;
    const lines = await tx<{ lineNo: number; materialId: number; purchaseUnit: string; purchaseQtyMilli: number; priceCents: number }[]>`
      SELECT line_no, material_id, purchase_unit, purchase_qty_milli, price_cents FROM purchase_order_lines WHERE po_id = ${poId} ORDER BY line_no`;
    const check = await checkAgainstContract(
      tx,
      input.contractId,
      c!.contractNo,
      lines.map((l) => ({ ...l, materialId: Number(l.materialId), purchaseQtyMilli: Number(l.purchaseQtyMilli), priceCents: Number(l.priceCents) })),
      poId,
    );
    if (check.exceeded && input.contractNote.length < 2) {
      const over = check.lines.filter((l) => l.priceOverCents > 0 || l.overQtyMilli > 0).map((l) => `第 ${l.lineNo} 行`);
      throw unprocessable('CONTRACT_DEVIATION_REASON_REQUIRED', `${over.join('、')}的单价超过合同价或数量超过合同剩余量，请写明原因再补合同`, { lines: check.lines });
    }
    await tx`
      UPDATE purchase_orders SET contract_id = ${input.contractId}, contract_note = ${input.contractNote},
             contract_added_by = ${actor.id}, contract_added_at = now(), updated_at = now()
      WHERE id = ${poId}`;
    await writeAudit(tx, {
      staffId: actor.id,
      action: 'po_contract_added',
      targetType: 'purchase_order',
      targetId: poId,
      detail: { docNo: po.docNo, contractNo: c!.contractNo, note: input.contractNote },
      ip,
    });
  });
  return getPo(deps.sql, poId);
}

export function registerUrgentContractRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  app.get('/api/purchase-orders/contract-due', { preHandler: guard('inventory.read') }, async () => listContractDue(sql, deps.config.timezone));
  app.get('/api/purchase-orders/:id/contract-options', { preHandler: guard('purchase.manage') }, async (req) => backfillContractOptions(sql, parse(idParam, req.params).id));
  app.post('/api/purchase-orders/:id/contract', { preHandler: guard('purchase.manage') }, async (req) =>
    attachBackfillContract(deps, parse(idParam, req.params).id, req.body ?? {}, req.actor, req.ip),
  );
}
