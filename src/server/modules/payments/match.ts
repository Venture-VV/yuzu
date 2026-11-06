// 三单匹配（v0.7.32，docs/PAYMENTS.md 第 4 节，默认 P8 待确认）：发票登记（分到采购单）、按采购单比对采购单金额 / 已收货（减退货）/ 已开票、
// 挂起的由财务写原因放行（记下放行时的三个金额，之后变了要重新放行）；付款申请要三单对得上或已放行。
//
// 锁：登记发票先取操作编号的咨询锁（与「确认作废」串行），靠「同一供应商同一发票号码只有一张没作废的」唯一索引兜底；作废只锁发票一行；
// 放行只锁采购单一行（FOR NO KEY UPDATE，同一张采购单的放行串行），在锁里核对页面看到的三个金额。比对、列表都只读。

import { z } from 'zod';
import { formatAmount } from '@shared/money';
import { withinTolerance, type SupplierInvoiceView, type ThreeWayRow, type ThreeWayStatus } from '@shared/payments';
import { isUniqueViolation, type Db, type Fragment } from '../../db';
import { writeAudit } from '../../lib/audit';
import type { Actor, Deps } from '../../lib/context';
import { todayIn } from '../../lib/dates';
import { badRequest, conflict, notFound, unprocessable } from '../../lib/errors';
import { assertNotFenced } from '../../lib/fences';
import { hashRequest } from '../../lib/idempotency';
import { setTxTimeouts } from '../../lib/tx';
import { dateSchema, parse, positiveCents } from '../../lib/validate';
import { PO_ORDERED_STATUSES } from '../contracts/ledger';
import { erpOpAbandoned } from '../erp-ops';

const id = z.number().int().positive();
const yuan = (cents: number) => `¥${formatAmount(cents)}`;
const Reason = z.string('请填写原因').trim().min(2, '请填写原因（至少 2 个字）').max(200, '原因最多 200 个字');

// ───────────────────────── 按采购单比对 ─────────────────────────

interface PoAmounts {
  poId: number;
  poNo: string;
  supplierId: number;
  supplierName: string;
  contractNo: string | null;
  poTotalCents: number;
  receivedCents: number;
  invoicedCents: number;
}

async function poAmounts(db: Db, poIds: number[]): Promise<PoAmounts[]> {
  if (poIds.length === 0) return [];
  const rows = await db<{
    poId: number;
    poNo: string;
    supplierId: number;
    supplierName: string;
    contractNo: string | null;
    poTotalCents: string;
    receivedCents: string;
    returnedCents: string;
    invoicedCents: string;
  }[]>`
    SELECT po.id AS po_id, po.doc_no AS po_no, po.supplier_id, s.name AS supplier_name, c.contract_no, po.total_cents::text AS po_total_cents,
           coalesce((SELECT sum(coalesce(d.amount_cents, 0)) FROM inv_docs d
                     WHERE d.purchase_order_id = po.id AND d.doc_type = 'receipt' AND d.status = 'confirmed'), 0)::text AS received_cents,
           coalesce((SELECT sum(coalesce(r.amount_cents, 0)) FROM inv_docs r JOIN inv_docs d ON d.id = r.source_doc_id
                     WHERE d.purchase_order_id = po.id AND r.doc_type = 'supplier_return' AND r.status = 'confirmed'), 0)::text AS returned_cents,
           coalesce((SELECT sum(l.amount_cents) FROM supplier_invoice_lines l JOIN supplier_invoices i ON i.id = l.invoice_id
                     WHERE l.purchase_order_id = po.id AND i.status = 'valid'), 0)::text AS invoiced_cents
    FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id LEFT JOIN contracts c ON c.id = po.contract_id
    WHERE po.id IN ${db(poIds)}
    ORDER BY po.id`;
  return rows.map((r) => ({
    poId: Number(r.poId),
    poNo: r.poNo,
    supplierId: Number(r.supplierId),
    supplierName: r.supplierName,
    contractNo: r.contractNo,
    poTotalCents: Number(r.poTotalCents),
    receivedCents: Math.max(0, Number(r.receivedCents) - Number(r.returnedCents)),
    invoicedCents: Number(r.invoicedCents),
  }));
}

/** 不看放行时的结果（P8）：对得上 / 挂起 / 不齐，与原因 */
export function rawStatus(a: Pick<PoAmounts, 'poTotalCents' | 'receivedCents' | 'invoicedCents'>): { status: Exclude<ThreeWayStatus, 'released'>; reason: string } {
  if (a.receivedCents <= 0 && a.invoicedCents <= 0) return { status: 'incomplete', reason: '还没收货，也还没登记发票' };
  if (a.receivedCents <= 0) return { status: 'incomplete', reason: `已登记发票 ${yuan(a.invoicedCents)}，还没有生效的收货` };
  if (a.invoicedCents <= 0) return { status: 'incomplete', reason: `已收货 ${yuan(a.receivedCents)}，还没登记发票` };
  const problems: string[] = [];
  if (!withinTolerance(a.invoicedCents, a.receivedCents, a.receivedCents)) {
    problems.push(`发票 ${yuan(a.invoicedCents)} 与收货 ${yuan(a.receivedCents)} 差 ${yuan(Math.abs(a.invoicedCents - a.receivedCents))}`);
  }
  if (a.receivedCents > a.poTotalCents && !withinTolerance(a.receivedCents, a.poTotalCents, a.poTotalCents)) {
    problems.push(`收货 ${yuan(a.receivedCents)} 超过采购单 ${yuan(a.poTotalCents)}`);
  }
  if (problems.length) return { status: 'held', reason: `${problems.join('；')}（超过 1% 或 ¥50）` };
  return { status: 'matched', reason: '采购单、收货、发票对得上' };
}

/** 几张采购单的三单比对：最近一次放行的三个金额与现在一样才算放行有效 */
export async function poThreeWay(db: Db, poIds: number[]): Promise<ThreeWayRow[]> {
  const amounts = await poAmounts(db, [...new Set(poIds)]);
  if (amounts.length === 0) return [];
  const releases = await db<{ poId: number; reason: string; byName: string; at: string; poTotalCents: string; receivedCents: string; invoicedCents: string }[]>`
    SELECT DISTINCT ON (r.purchase_order_id) r.purchase_order_id AS po_id, r.reason, s.display_name AS by_name, r.created_at AS at,
           r.po_total_cents::text AS po_total_cents, r.received_cents::text AS received_cents, r.invoiced_cents::text AS invoiced_cents
    FROM po_match_releases r JOIN staff s ON s.id = r.created_by
    WHERE r.purchase_order_id IN ${db(amounts.map((a) => a.poId))}
    ORDER BY r.purchase_order_id, r.id DESC`;
  return amounts.map((a) => {
    const raw = rawStatus(a);
    const rel = releases.find((r) => Number(r.poId) === a.poId);
    const release = rel
      ? { reason: rel.reason, byName: rel.byName, at: rel.at, poTotalCents: Number(rel.poTotalCents), receivedCents: Number(rel.receivedCents), invoicedCents: Number(rel.invoicedCents) }
      : null;
    const valid = !!release && release.poTotalCents === a.poTotalCents && release.receivedCents === a.receivedCents && release.invoicedCents === a.invoicedCents;
    const status: ThreeWayStatus = raw.status !== 'matched' && valid ? 'released' : raw.status;
    return {
      ...a,
      status,
      reason: status === 'released' ? `已放行：${release!.reason}（${raw.reason}）` : raw.reason,
      release,
      releaseStale: !!release && !valid && raw.status !== 'matched',
    };
  });
}

/** 合同挂的采购单里有生效收货的（付款申请要它们三单齐全） */
export async function contractReceivedPoIds(db: Db, contractId: number): Promise<number[]> {
  const rows = await db<{ id: number }[]>`
    SELECT DISTINCT po.id FROM purchase_orders po JOIN inv_docs d ON d.purchase_order_id = po.id
    WHERE po.contract_id = ${contractId} AND d.doc_type = 'receipt' AND d.status = 'confirmed' ORDER BY po.id`;
  return rows.map((r) => Number(r.id));
}

/** 三单是否齐全（对得上或已放行）；不齐的列出来 */
export function threeWayProblems(rows: ThreeWayRow[]): string[] {
  return rows.filter((r) => r.status !== 'matched' && r.status !== 'released').map((r) => `${r.poNo}：${r.reason}${r.releaseStale ? '（放行以后金额变了，要重新放行）' : ''}`);
}

/** 三单列表（ERP「付款 → 三单」）：已下单的采购单里有收货或有发票的；只看挂起 / 不齐的或全部 */
export async function threeWayList(db: Db, f: { pendingOnly?: boolean; supplierId?: number } = {}): Promise<ThreeWayRow[]> {
  const ids = await db<{ id: number }[]>`
    SELECT po.id FROM purchase_orders po
    WHERE po.status IN ${db(PO_ORDERED_STATUSES as unknown as string[])}
      ${f.supplierId ? db`AND po.supplier_id = ${f.supplierId}` : db``}
      AND (EXISTS (SELECT 1 FROM inv_docs d WHERE d.purchase_order_id = po.id AND d.doc_type = 'receipt' AND d.status = 'confirmed')
           OR EXISTS (SELECT 1 FROM supplier_invoice_lines l JOIN supplier_invoices i ON i.id = l.invoice_id WHERE l.purchase_order_id = po.id AND i.status = 'valid'))
    ORDER BY po.id DESC
    LIMIT 500`;
  const rows = await poThreeWay(db, ids.map((r) => Number(r.id)));
  const out = f.pendingOnly ? rows.filter((r) => r.status === 'held' || r.status === 'incomplete') : rows;
  return out.sort((a, b) => b.poId - a.poId);
}

// ───────────────────────── 发票 ─────────────────────────

async function invoicesWhere(db: Db, where: Fragment): Promise<SupplierInvoiceView[]> {
  const rows = await db<(Omit<SupplierInvoiceView, 'lines'> & { totalCents: string; taxCents: string })[]>`
    SELECT i.id, i.invoice_no, i.supplier_id, s.name AS supplier_name, i.invoice_date, i.total_cents::text AS total_cents, i.tax_cents::text AS tax_cents,
           i.tax_rate_bp, i.note, i.status, cb.display_name AS created_by_name, i.created_at, vb.display_name AS voided_by_name, i.voided_at, i.void_reason
    FROM supplier_invoices i JOIN suppliers s ON s.id = i.supplier_id JOIN staff cb ON cb.id = i.created_by LEFT JOIN staff vb ON vb.id = i.voided_by
    WHERE ${where}
    ORDER BY i.invoice_date DESC, i.id DESC
    LIMIT 300`;
  if (rows.length === 0) return [];
  const lines = await db<{ invoiceId: number; poId: number; poNo: string; amountCents: string }[]>`
    SELECT l.invoice_id, l.purchase_order_id AS po_id, po.doc_no AS po_no, l.amount_cents::text AS amount_cents
    FROM supplier_invoice_lines l JOIN purchase_orders po ON po.id = l.purchase_order_id
    WHERE l.invoice_id IN ${db(rows.map((r) => Number(r.id)))} ORDER BY l.id`;
  return rows.map((r) => ({
    ...r,
    id: Number(r.id),
    supplierId: Number(r.supplierId),
    totalCents: Number(r.totalCents),
    taxCents: Number(r.taxCents),
    lines: lines.filter((l) => Number(l.invoiceId) === Number(r.id)).map((l) => ({ poId: Number(l.poId), poNo: l.poNo, amountCents: Number(l.amountCents) })),
  }));
}

export async function listInvoices(db: Db, f: { supplierId?: number; poId?: number; status?: 'valid' | 'voided'; q?: string } = {}): Promise<SupplierInvoiceView[]> {
  const q = f.q ? `%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
  return invoicesWhere(
    db,
    db`true
      ${f.supplierId ? db`AND i.supplier_id = ${f.supplierId}` : db``}
      ${f.status ? db`AND i.status = ${f.status}` : db``}
      ${f.poId ? db`AND EXISTS (SELECT 1 FROM supplier_invoice_lines l WHERE l.invoice_id = i.id AND l.purchase_order_id = ${f.poId})` : db``}
      ${q ? db`AND (i.invoice_no ILIKE ${q} OR s.name ILIKE ${q})` : db``}`,
  );
}

export async function getInvoice(db: Db, invoiceId: number): Promise<SupplierInvoiceView> {
  const [inv] = await invoicesWhere(db, db`i.id = ${invoiceId}`);
  if (!inv) throw notFound('发票登记不存在');
  return inv;
}

const InvoiceInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  supplierId: id,
  invoiceNo: z.string('请填写发票号码').trim().min(1, '请填写发票号码').max(30, '发票号码最多 30 位'),
  invoiceDate: dateSchema('开票日'),
  totalCents: positiveCents('价税合计'),
  taxCents: z.number('请填写税额').int('税额要精确到分').min(0, '税额不能为负').max(1_000_000_000),
  taxRateBp: z.number('请填写税率').int().min(0, '税率不能为负').max(10000, '税率不能超过 100%'),
  note: z.string().trim().max(200, '备注最多 200 个字').default(''),
  lines: z.array(z.object({ poId: id, amountCents: positiveCents('分到采购单的金额') })).min(1, '请选择这张发票对应的采购单').max(50),
});

/** 登记发票：分到采购单的金额合计 = 价税合计；采购单要是这家供应商、已下单的 */
export async function createInvoice(deps: Deps, raw: unknown, actor: Actor, ip?: string): Promise<{ id: number; replayed: boolean }> {
  const input = parse(InvoiceInput, raw);
  if (input.invoiceDate > todayIn(deps.config.timezone)) throw badRequest('开票日不能晚于今天');
  if (input.taxCents > input.totalCents) throw badRequest('税额不能超过价税合计');
  const split = input.lines.reduce((s, l) => s + l.amountCents, 0);
  if (split !== input.totalCents) throw badRequest(`分到采购单的金额合计 ${yuan(split)} 与价税合计 ${yuan(input.totalCents)} 不一样`);
  if (new Set(input.lines.map((l) => l.poId)).size !== input.lines.length) throw badRequest('同一张采购单在一张发票里只能出现一次');
  const requestHash = hashRequest({ ...input, clientKey: undefined });
  const find = async (db: Db) => {
    const [row] = await db<{ id: number; requestHash: string }[]>`SELECT id, request_hash FROM supplier_invoices WHERE client_key = ${input.clientKey}`;
    if (!row) return null;
    if (row.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一张发票，请刷新页面后重新填写');
    return Number(row.id);
  };
  try {
    return await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      // 先取操作编号的咨询锁（与「确认作废」串行），确认这笔没有被作废
      await assertNotFenced(tx, input.clientKey, 'supplier_invoice', erpOpAbandoned);
      const existing = await find(tx);
      if (existing) return { id: existing, replayed: true };
      const [sup] = await tx<{ id: number }[]>`SELECT id FROM suppliers WHERE id = ${input.supplierId}`;
      if (!sup) throw notFound('供应商不存在');
      const pos = await tx<{ id: number; docNo: string; supplierId: number; status: string }[]>`
        SELECT id, doc_no, supplier_id, status FROM purchase_orders WHERE id IN ${tx(input.lines.map((l) => l.poId))}`;
      for (const l of input.lines) {
        const po = pos.find((p) => Number(p.id) === l.poId);
        if (!po) throw unprocessable('PO_NOT_FOUND', '选的采购单不存在，请刷新后重新选');
        if (Number(po.supplierId) !== input.supplierId) throw unprocessable('PO_SUPPLIER_MISMATCH', `采购单 ${po.docNo} 不是这家供应商的`);
        if (!(PO_ORDERED_STATUSES as readonly string[]).includes(po.status)) throw unprocessable('PO_NOT_ORDERED', `采购单 ${po.docNo} 还没下单（或已撤回），不能登记发票`);
      }
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO supplier_invoices (invoice_no, supplier_id, invoice_date, total_cents, tax_cents, tax_rate_bp, note, client_key, request_hash, created_by)
        VALUES (${input.invoiceNo}, ${input.supplierId}, ${input.invoiceDate}, ${input.totalCents}, ${input.taxCents}, ${input.taxRateBp}, ${input.note},
                ${input.clientKey}, ${requestHash}, ${actor.id})
        RETURNING id`;
      const invoiceId = Number(row!.id);
      for (const l of input.lines) {
        await tx`INSERT INTO supplier_invoice_lines (invoice_id, purchase_order_id, amount_cents) VALUES (${invoiceId}, ${l.poId}, ${l.amountCents})`;
      }
      await writeAudit(tx, { staffId: actor.id, action: 'payment_doc', targetType: 'supplier_invoice', targetId: invoiceId, detail: { op: 'create', invoiceNo: input.invoiceNo, totalCents: input.totalCents }, ip });
      return { id: invoiceId, replayed: false };
    });
  } catch (error) {
    if (isUniqueViolation(error, 'supplier_invoices_client_key_key')) {
      const existing = await find(deps.sql);
      if (existing) return { id: existing, replayed: true };
    }
    if (isUniqueViolation(error, 'supplier_invoices_no')) throw conflict('INVOICE_DUPLICATE', `这家供应商的发票 ${input.invoiceNo} 已经登记过了（登错了先作废原来那张）`);
    throw error;
  }
}

/** 作废发票（登错了）：写原因；作废以后分到采购单的金额不再算 */
export async function voidInvoice(deps: Deps, invoiceId: number, raw: unknown, actor: Actor, ip?: string) {
  const { reason } = parse(z.object({ reason: Reason }), raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [inv] = await tx<{ status: string; invoiceNo: string }[]>`SELECT status, invoice_no FROM supplier_invoices WHERE id = ${invoiceId} FOR UPDATE`;
    if (!inv) throw notFound('发票登记不存在');
    if (inv.status === 'voided') return;
    await tx`UPDATE supplier_invoices SET status = 'voided', voided_by = ${actor.id}, voided_at = now(), void_reason = ${reason} WHERE id = ${invoiceId}`;
    await writeAudit(tx, { staffId: actor.id, action: 'payment_doc', targetType: 'supplier_invoice', targetId: invoiceId, detail: { op: 'void', invoiceNo: inv.invoiceNo, reason }, ip });
  });
}

// ───────────────────────── 放行 ─────────────────────────

const ReleaseInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  reason: Reason,
  /** 页面上看到的三个金额：锁住采购单以后核对，变了拒绝（THREE_WAY_MOVED） */
  seen: z.object({ poTotalCents: z.number().int(), receivedCents: z.number().int(), invoicedCents: z.number().int() }),
});

/** 财务确认放行挂起 / 不齐的采购单（写原因，记下当时的三个金额） */
export async function releasePo(deps: Deps, poId: number, raw: unknown, actor: Actor, ip?: string): Promise<{ id: number; replayed: boolean }> {
  const input = parse(ReleaseInput, raw);
  const requestHash = hashRequest({ ...input, clientKey: undefined, poId });
  const find = async (db: Db) => {
    const [row] = await db<{ id: number; requestHash: string }[]>`SELECT id, request_hash FROM po_match_releases WHERE client_key = ${input.clientKey}`;
    if (!row) return null;
    if (row.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一次放行，请刷新后重新操作');
    return Number(row.id);
  };
  try {
    return await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const existing = await find(tx);
      if (existing) return { id: existing, replayed: true };
      const [po] = await tx<{ docNo: string }[]>`SELECT doc_no FROM purchase_orders WHERE id = ${poId} FOR NO KEY UPDATE`;
      if (!po) throw notFound('采购单不存在');
      const again = await find(tx);
      if (again) return { id: again, replayed: true };
      const [row] = await poThreeWay(tx, [poId]);
      if (row!.status === 'matched') throw conflict('THREE_WAY_MATCHED', `${po.docNo} 三单对得上，不用放行`);
      if (row!.status === 'released') throw conflict('THREE_WAY_RELEASED', `${po.docNo} 已经放行过（金额没变）`);
      if (row!.poTotalCents !== input.seen.poTotalCents || row!.receivedCents !== input.seen.receivedCents || row!.invoicedCents !== input.seen.invoicedCents) {
        throw conflict('THREE_WAY_MOVED', `${po.docNo} 的金额刚变了（采购单 ${yuan(row!.poTotalCents)}、收货 ${yuan(row!.receivedCents)}、发票 ${yuan(row!.invoicedCents)}），请刷新后再看`);
      }
      const [ins] = await tx<{ id: number }[]>`
        INSERT INTO po_match_releases (purchase_order_id, po_total_cents, received_cents, invoiced_cents, reason, client_key, request_hash, created_by)
        VALUES (${poId}, ${row!.poTotalCents}, ${row!.receivedCents}, ${row!.invoicedCents}, ${input.reason}, ${input.clientKey}, ${requestHash}, ${actor.id})
        RETURNING id`;
      await writeAudit(tx, { staffId: actor.id, action: 'payment_doc', targetType: 'purchase_order', targetId: poId, detail: { op: 'three_way_release', poNo: po.docNo, reason: input.reason }, ip });
      return { id: Number(ins!.id), replayed: false };
    });
  } catch (error) {
    if (isUniqueViolation(error, 'po_match_releases_client_key_key')) {
      const existing = await find(deps.sql);
      if (existing) return { id: existing, replayed: true };
    }
    throw error;
  }
}

/** 发票自检：没作废的发票分到采购单的金额合计 = 价税合计 */
export async function invoiceChecks(db: Db): Promise<string[]> {
  const rows = await db<{ invoiceNo: string; supplierName: string }[]>`
    SELECT i.invoice_no, s.name AS supplier_name FROM supplier_invoices i JOIN suppliers s ON s.id = i.supplier_id
    WHERE coalesce((SELECT sum(l.amount_cents) FROM supplier_invoice_lines l WHERE l.invoice_id = i.id), 0) <> i.total_cents`;
  return rows.map((r) => `${r.supplierName} 的发票 ${r.invoiceNo} 分到采购单的金额合计与价税合计不一样`);
}
