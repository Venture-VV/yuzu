// 进项发票台账（8.0.3，docs/BUDGET_INVOICES.md 第 3 节，默认 BI07–BI12 待确认）：在 v0.7.32 的发票登记（supplier_invoices）上扩。
//
// 台账里的发票有三个来源：三单匹配登记的供应商发票（three_way，分到采购单，照旧在付款页登记）、报销单上的专票普票
// （expense，登记报销时进台账，见 resolveClaimInvoice）、财务在台账里直接登记的（manual）。
// 认证：要认证的发票类型（默认专票）登记时待认证，财务标已认证并填所属期；认证期限 = 开票日 + 规则的天数（0 = 不设），
// 到期前几天进待办（ERP 导航「发票台账」的数字）。异常票只标记、不拦。
//
// 加锁：
//   · 同一个发票号码的登记（三单、报销、台账）按号码的咨询锁串行；三单登记先锁采购单（KEY SHARE，id 升序）再取号码锁，
//     报销在锁住打款、采购单之后取号码锁（与采购单的锁顺序一致）。
//   · 报销关联发票：锁住发票一行（FOR KEY SHARE），锁住以后再核对没作废、没挂在别的有效报销单上；
//     作废锁发票一行（FOR UPDATE），在锁里核对没有有效报销单挂着——两边串行。
//   · 标认证只锁发票一行（带认证版本号，对不上拒绝）；一批按 id 升序。
//   · 照片：先按内容存图片 / PDF（唯一索引去重，不加锁），再锁发票一行（FOR NO KEY UPDATE）核对份数。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { invoiceTypeCertifies, type ExpenseRules, type InvoiceTypeDef } from '@shared/expenses';
import {
  CERT_BATCH_MAX,
  CERT_PERIOD_RE,
  CERT_STATUSES,
  CERT_STATUS_LABELS,
  INVOICE_ANOMALY_LABELS,
  INVOICE_SOURCE_LABELS,
  MAX_INVOICE_ATTACHMENTS,
  expectedTaxCents,
  normalizeInvoiceNo,
  type CertStatus,
  type InputInvoice,
  type InputInvoiceDetail,
  type InvoiceAnomaly,
  type InvoiceAttachment,
  type InvoiceLedger,
  type InvoiceSource,
  type InvoiceTodo,
  type InvoiceView,
} from '@shared/invoices';
import { formatAmount } from '@shared/money';
import { shiftDate } from '@shared/labels';
import { can } from '@shared/permissions';
import { taxRateText } from '@shared/expenses';
import { isUniqueViolation, readSnapshot, type Db, type Fragment, type Tx } from '../db';
import { guard, guardAny } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import { attachment, csvReply, toCsv } from '../lib/csv';
import type { Actor, Deps } from '../lib/context';
import { daysBetween, todayIn } from '../lib/dates';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { assertNotFenced } from '../lib/fences';
import { hashRequest } from '../lib/idempotency';
import { setTxTimeouts } from '../lib/tx';
import { dateSchema, idParam, parse, positiveCents } from '../lib/validate';
import { erpOpAbandoned } from './erp-ops';
import { loadExpenseRules } from './expenses';
import { readFile, storePdf } from './inventory/files';
import { saveImage } from './requests';

const id = z.number().int().positive();
const ACTIVE_CLAIM = ['submitted', 'returned', 'confirmed'] as const;

/** 同一个发票号码的登记串行（三单、报销、台账） */
export async function lockInvoiceNo(tx: Tx, invoiceNo: string) {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`input_invoice_no:${normalizeInvoiceNo(invoiceNo)}`}, 0))`;
}

/** 这类发票（规则里的发票类型）要不要认证、能不能进台账（要填号码的才进） */
export function ledgerKind(rules: ExpenseRules, kind: string): InvoiceTypeDef | null {
  const t = rules.invoiceTypes.find((x) => x.key === kind);
  return t && t.needsNumber ? t : null;
}

// ───────────────────────── 列表与详情 ─────────────────────────

interface RawRow {
  id: number;
  invoiceNo: string;
  kind: string;
  kindLabel: string;
  supplierId: number | null;
  supplierName: string | null;
  issuerName: string;
  invoiceDate: string;
  totalCents: string;
  taxCents: string;
  taxRateBp: number;
  source: InvoiceSource;
  status: 'valid' | 'voided';
  note: string;
  certStatus: CertStatus;
  certPeriod: string | null;
  certNote: string;
  certByName: string | null;
  certAt: string | null;
  certVersion: number;
  createdByName: string;
  createdAt: string;
  voidedByName: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  sameNo: number;
  attachmentCount: number;
  claimId: number | null;
  claimDocNo: string | null;
  claimStatus: InputInvoice['claim'] extends infer C ? (C extends { status: infer S } ? S : never) : never;
  claimAmountCents: string | null;
}

/** 同号码（去空白、不分大小写）的有效发票张数 */
const sameNoSql = (db: Db) => db`(
  SELECT count(*) FROM supplier_invoices d
  WHERE d.status = 'valid' AND upper(regexp_replace(d.invoice_no, '\\s', '', 'g')) = upper(regexp_replace(i.invoice_no, '\\s', '', 'g')))`;

/** 关联的报销单：有效的那张，没有有效的取最近一张（别名 c） */
const claimJoinSql = (db: Db) => db`LEFT JOIN LATERAL (
  SELECT x.id, x.doc_no, x.status, x.amount_cents FROM expense_claims x WHERE x.invoice_id = i.id
  ORDER BY (x.status IN ('submitted', 'returned', 'confirmed')) DESC, x.id DESC LIMIT 1
) c ON true`;

/** 认证将到期（含已过期）：有效、待认证、规则设了期限，期限在今天 + 提醒天数以内（与 dueOf、invoiceTodo 同一口径） */
function dueSql(db: Db, rules: ExpenseRules, today: string): Fragment {
  if (rules.invoiceCertifyDays <= 0) return db`false`;
  return db`(i.status = 'valid' AND i.cert_status = 'pending' AND i.invoice_date + ${rules.invoiceCertifyDays}::int <= ${shiftDate(today, rules.invoiceRemindDays)}::date)`;
}

/**
 * 异常票：与 anomaliesOf 同一口径，放在 SQL 里先筛、再取前若干张（8.0.3 测试会话 P2：先取最新 1000 张再在内存里筛，旧的异常票、逾期票会漏掉）。
 * 税额按「价税合计 × 税率 ÷ (1 + 税率)」四舍五入到分（金额都不为负，与 expectedTaxCents 一致）。
 */
function anomalySql(db: Db, rules: ExpenseRules, today: string): Fragment {
  const kinds = rules.invoiceTypes.map((t) => t.key);
  const allowed = rules.invoiceTypes.flatMap((t) => t.taxRatesBp.map((bp) => `${t.key}:${bp}`));
  return db`(i.status = 'valid' AND (
    ${sameNoSql(db)} > 1
    OR abs(i.tax_cents - round(i.total_cents::numeric * i.tax_rate_bp / (10000 + i.tax_rate_bp))) > ${rules.invoiceTaxToleranceCents}
    OR (i.kind = ANY(${kinds}::text[]) AND NOT ((i.kind || ':' || i.tax_rate_bp) = ANY(${allowed}::text[])))
    ${rules.invoiceCertifyDays > 0 ? db`OR (i.cert_status = 'pending' AND i.invoice_date + ${rules.invoiceCertifyDays}::int < ${today}::date)` : db``}
    OR (c.status IN ('submitted', 'returned', 'confirmed') AND c.amount_cents <> i.total_cents)
    OR (i.supplier_id IS NULL AND btrim(i.issuer_name) = '')))`;
}

async function rowsWhere(db: Db, where: Fragment, limit = 1000): Promise<RawRow[]> {
  return db<RawRow[]>`
    SELECT i.id, i.invoice_no, i.kind, i.kind_label, i.supplier_id, s.name AS supplier_name, i.issuer_name, i.invoice_date,
           i.total_cents::text AS total_cents, i.tax_cents::text AS tax_cents, i.tax_rate_bp, i.source, i.status, i.note,
           i.cert_status, i.cert_period, i.cert_note, cb.display_name AS cert_by_name, i.cert_at, i.cert_version,
           cr.display_name AS created_by_name, i.created_at, vb.display_name AS voided_by_name, i.voided_at, i.void_reason,
           ${sameNoSql(db)}::int AS same_no,
           (SELECT count(*) FROM supplier_invoice_attachments a WHERE a.invoice_id = i.id)::int AS attachment_count,
           c.id AS claim_id, c.doc_no AS claim_doc_no, c.status AS claim_status, c.amount_cents::text AS claim_amount_cents
    FROM supplier_invoices i
    LEFT JOIN suppliers s ON s.id = i.supplier_id
    JOIN staff cr ON cr.id = i.created_by
    LEFT JOIN staff cb ON cb.id = i.cert_by
    LEFT JOIN staff vb ON vb.id = i.voided_by
    ${claimJoinSql(db)}
    WHERE ${where}
    ORDER BY i.invoice_date DESC, i.id DESC
    LIMIT ${limit}`;
}

/** 认证期限：要认证、还待认证、规则设了期限的才有 */
function dueOf(r: { certStatus: CertStatus; invoiceDate: string; status: string }, rules: ExpenseRules): string | null {
  if (r.status !== 'valid' || r.certStatus !== 'pending' || rules.invoiceCertifyDays <= 0) return null;
  return shiftDate(r.invoiceDate, rules.invoiceCertifyDays);
}

function anomaliesOf(r: RawRow, rules: ExpenseRules, today: string): InvoiceAnomaly[] {
  if (r.status !== 'valid') return [];
  const out: InvoiceAnomaly[] = [];
  const total = Number(r.totalCents);
  if (r.sameNo > 1) out.push('duplicate_no');
  if (Math.abs(Number(r.taxCents) - expectedTaxCents(total, r.taxRateBp)) > rules.invoiceTaxToleranceCents) out.push('tax_mismatch');
  const t = rules.invoiceTypes.find((x) => x.key === r.kind);
  if (t && !t.taxRatesBp.includes(r.taxRateBp)) out.push('rate_not_allowed');
  const due = dueOf(r, rules);
  if (due && due < today) out.push('cert_overdue');
  if (r.claimId && r.claimStatus && (ACTIVE_CLAIM as readonly string[]).includes(r.claimStatus) && Number(r.claimAmountCents) !== total) out.push('amount_mismatch');
  if (r.supplierId === null && !r.issuerName.trim()) out.push('issuer_missing');
  return out;
}

async function poSplits(db: Db, ids: number[]): Promise<Map<number, InputInvoice['pos']>> {
  const out = new Map<number, InputInvoice['pos']>();
  if (ids.length === 0) return out;
  const rows = await db<{ invoiceId: number; poId: number; poNo: string; amountCents: string }[]>`
    SELECT l.invoice_id, l.purchase_order_id AS po_id, po.doc_no AS po_no, l.amount_cents::text AS amount_cents
    FROM supplier_invoice_lines l JOIN purchase_orders po ON po.id = l.purchase_order_id
    WHERE l.invoice_id IN ${db(ids)} ORDER BY l.id`;
  for (const l of rows) {
    const list = out.get(Number(l.invoiceId)) ?? [];
    list.push({ id: Number(l.poId), docNo: l.poNo, amountCents: Number(l.amountCents) });
    out.set(Number(l.invoiceId), list);
  }
  return out;
}

function toInvoice(r: RawRow, pos: InputInvoice['pos'], rules: ExpenseRules, today: string): InputInvoice {
  const due = dueOf(r, rules);
  return {
    id: Number(r.id),
    invoiceNo: r.invoiceNo,
    kind: r.kind,
    kindLabel: r.kindLabel,
    supplier: r.supplierId === null ? null : { id: Number(r.supplierId), name: r.supplierName ?? '' },
    issuerName: r.supplierId === null ? r.issuerName : (r.supplierName ?? r.issuerName),
    invoiceDate: r.invoiceDate,
    totalCents: Number(r.totalCents),
    taxCents: Number(r.taxCents),
    taxRateBp: r.taxRateBp,
    source: r.source,
    status: r.status,
    note: r.note,
    certStatus: r.certStatus,
    certPeriod: r.certPeriod,
    certNote: r.certNote,
    certByName: r.certByName,
    certAt: r.certAt,
    certVersion: r.certVersion,
    certDueDate: due,
    certDueInDays: due ? daysBetween(today, due) : null,
    claim: r.claimId ? { id: Number(r.claimId), docNo: r.claimDocNo!, status: r.claimStatus, amountCents: Number(r.claimAmountCents) } : null,
    pos,
    attachmentCount: r.attachmentCount,
    anomalies: anomaliesOf(r, rules, today),
    createdByName: r.createdByName,
    createdAt: r.createdAt,
    voidedByName: r.voidedByName,
    voidedAt: r.voidedAt,
    voidReason: r.voidReason,
  };
}

const LedgerQuery = z.object({
  view: z.enum(['all', 'pending', 'due', 'certified', 'not_required', 'anomaly', 'voided']).default('all'),
  source: z.enum(['three_way', 'expense', 'manual']).optional(),
  from: dateSchema('开票日（起）').optional(),
  to: dateSchema('开票日（止）').optional(),
  q: z.string().trim().max(60).optional(),
});

/** 列表一次最多几张（更多的缩短日期或导出）；导出最多几张 */
const LEDGER_LIMIT = 1000;
const EXPORT_LIMIT = 50_000;

export async function loadLedger(db: Db, raw: unknown, today: string, limit = LEDGER_LIMIT): Promise<InvoiceLedger> {
  const f = parse(LedgerQuery, raw ?? {});
  const rules = await loadExpenseRules(db);
  const q = f.q ? `%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
  const where = db`true
    ${f.view === 'voided' ? db`AND i.status = 'voided'` : db`AND i.status = 'valid'`}
    ${f.view === 'pending' ? db`AND i.cert_status = 'pending'` : db``}
    ${f.view === 'due' ? db`AND ${dueSql(db, rules, today)}` : db``}
    ${f.view === 'anomaly' ? db`AND ${anomalySql(db, rules, today)}` : db``}
    ${f.view === 'certified' ? db`AND i.cert_status = 'certified'` : db``}
    ${f.view === 'not_required' ? db`AND i.cert_status = 'not_required'` : db``}
    ${f.source ? db`AND i.source = ${f.source}` : db``}
    ${f.from ? db`AND i.invoice_date >= ${f.from}` : db``}
    ${f.to ? db`AND i.invoice_date <= ${f.to}` : db``}
    ${q ? db`AND (i.invoice_no ILIKE ${q} OR i.issuer_name ILIKE ${q} OR s.name ILIKE ${q})` : db``}`;
  // 多取一张看有没有截断
  const rows = await rowsWhere(db, where, limit + 1);
  const truncated = rows.length > limit;
  const shown = truncated ? rows.slice(0, limit) : rows;
  const pos = await poSplits(db, shown.map((r) => Number(r.id)));
  const invoices = shown.map((r) => toInvoice(r, pos.get(Number(r.id)) ?? [], rules, today));
  // 上方的数字：全部有效的发票，在 SQL 里数（不受列表张数限制）
  const [counts] = await db<{ pending: number; due: number; anomaly: number }[]>`
    SELECT count(*) FILTER (WHERE i.cert_status = 'pending')::int AS pending,
           count(*) FILTER (WHERE ${dueSql(db, rules, today)})::int AS due,
           count(*) FILTER (WHERE ${anomalySql(db, rules, today)})::int AS anomaly
    FROM supplier_invoices i
    ${claimJoinSql(db)}
    WHERE i.status = 'valid'`;
  return {
    invoices,
    truncated,
    counts: counts!,
    rules: { certifyDays: rules.invoiceCertifyDays, remindDays: rules.invoiceRemindDays, taxToleranceCents: rules.invoiceTaxToleranceCents },
  };
}

async function attachmentsOf(db: Db, invoiceId: number): Promise<InvoiceAttachment[]> {
  const rows = await db<{ id: number; imageId: number | null; fileId: number | null; name: string; sizeBytes: number; uploadedByName: string; uploadedAt: string }[]>`
    SELECT a.id, a.image_id, a.file_id, a.name, coalesce(im.size_bytes, f.size_bytes) AS size_bytes, s.display_name AS uploaded_by_name, a.uploaded_at
    FROM supplier_invoice_attachments a JOIN staff s ON s.id = a.uploaded_by
    LEFT JOIN erp_images im ON im.id = a.image_id LEFT JOIN erp_files f ON f.id = a.file_id
    WHERE a.invoice_id = ${invoiceId} ORDER BY a.uploaded_at, a.id`;
  return rows.map((r) => ({
    id: Number(r.id),
    kind: r.imageId ? 'image' : 'pdf',
    name: r.name,
    url: r.imageId ? `/api/erp/images/${r.imageId}` : `/api/erp/invoices/attachments/${r.id}/download`,
    sizeBytes: Number(r.sizeBytes),
    uploadedByName: r.uploadedByName,
    uploadedAt: r.uploadedAt,
  }));
}

export async function getInputInvoice(db: Db, invoiceId: number, today: string): Promise<InputInvoiceDetail> {
  const rules = await loadExpenseRules(db);
  const [row] = await rowsWhere(db, db`i.id = ${invoiceId}`);
  if (!row) throw notFound('发票不存在');
  const pos = await poSplits(db, [invoiceId]);
  return { ...toInvoice(row, pos.get(invoiceId) ?? [], rules, today), attachments: await attachmentsOf(db, invoiceId) };
}

/** ERP 导航「发票台账」的数字：认证期限到期前几天以内（含已过期）的待认证发票 */
export async function invoiceTodo(db: Db, today: string): Promise<InvoiceTodo> {
  const rules = await loadExpenseRules(db);
  if (rules.invoiceCertifyDays <= 0) return { due: 0, overdue: 0 };
  const [row] = await db<{ due: number; overdue: number }[]>`
    SELECT count(*) FILTER (WHERE invoice_date + ${rules.invoiceCertifyDays}::int <= ${shiftDate(today, rules.invoiceRemindDays)}::date)::int AS due,
           count(*) FILTER (WHERE invoice_date + ${rules.invoiceCertifyDays}::int < ${today}::date)::int AS overdue
    FROM supplier_invoices WHERE status = 'valid' AND cert_status = 'pending'`;
  return { due: row!.due, overdue: row!.overdue };
}

/** 登记报销页按号码找台账里的发票（没作废的） */
export async function findByNo(db: Db, invoiceNo: string): Promise<{ id: number; invoiceNo: string; kind: string; kindLabel: string; issuerName: string; supplierId: number | null; invoiceDate: string; totalCents: number; taxCents: number; taxRateBp: number; usedBy: string | null; inPayables: boolean }[]> {
  const rows = await db<{ id: number; invoiceNo: string; kind: string; kindLabel: string; issuerName: string; supplierId: number | null; supplierName: string | null; invoiceDate: string; totalCents: string; taxCents: string; taxRateBp: number; usedBy: string | null; poLines: number }[]>`
    SELECT i.id, i.invoice_no, i.kind, i.kind_label, i.issuer_name, i.supplier_id, s.name AS supplier_name, i.invoice_date,
           i.total_cents::text AS total_cents, i.tax_cents::text AS tax_cents, i.tax_rate_bp,
           (SELECT c.doc_no FROM expense_claims c WHERE c.invoice_id = i.id AND c.status IN ${db(ACTIVE_CLAIM)} LIMIT 1) AS used_by,
           (SELECT count(*) FROM supplier_invoice_lines l WHERE l.invoice_id = i.id)::int AS po_lines
    FROM supplier_invoices i LEFT JOIN suppliers s ON s.id = i.supplier_id
    WHERE i.status = 'valid' AND upper(regexp_replace(i.invoice_no, '\\s', '', 'g')) = ${normalizeInvoiceNo(invoiceNo)}
    ORDER BY i.id`;
  return rows.map((r) => ({
    id: Number(r.id),
    invoiceNo: r.invoiceNo,
    kind: r.kind,
    kindLabel: r.kindLabel,
    issuerName: r.supplierId === null ? r.issuerName : (r.supplierName ?? r.issuerName),
    supplierId: r.supplierId === null ? null : Number(r.supplierId),
    invoiceDate: r.invoiceDate,
    totalCents: Number(r.totalCents),
    taxCents: Number(r.taxCents),
    taxRateBp: r.taxRateBp,
    usedBy: r.usedBy,
    inPayables: r.poLines > 0,
  }));
}

// ───────────────────────── 报销关联发票（BI11） ─────────────────────────

export interface ClaimInvoiceInput {
  /** 登记页选的台账发票 */
  invoiceId: number | null;
  kind: InvoiceTypeDef;
  invoiceNo: string;
  /** 按采购单报销的：采购单的供应商 */
  supplier: { id: number; name: string } | null;
  issuerName: string;
  invoiceDate: string;
  totalCents: number;
  taxCents: number | null;
  taxRateBp: number;
}

/**
 * 在报销的事务里（锁住打款、采购单以后）：选了台账的发票就核对后关联；没选按号码找（填了开票方的按开票方筛）：
 * 找到一张没用过的就关联，挂在有效报销单上、在三单匹配里的拦，好几张要求在登记页选，没有就登记进台账。返回发票编号。
 */
export async function resolveClaimInvoice(tx: Tx, input: ClaimInvoiceInput, actor: Actor): Promise<number> {
  await lockInvoiceNo(tx, input.invoiceNo);
  const no = normalizeInvoiceNo(input.invoiceNo);
  let targetId: number | null = input.invoiceId;
  if (targetId === null) {
    const candidates = await findByNo(tx, input.invoiceNo);
    const issuer = (input.supplier?.name ?? input.issuerName).trim().toLowerCase();
    const matched = issuer
      ? candidates.filter(
          (c) => (input.supplier && c.supplierId === input.supplier.id) || c.issuerName.trim().toLowerCase() === issuer || !c.issuerName.trim(),
        )
      : candidates;
    if (matched.length > 1) {
      throw conflict('INVOICE_AMBIGUOUS', `台账里有 ${matched.length} 张号码是 ${input.invoiceNo} 的发票，请在登记页选是哪一张`, {
        candidates: matched.map((c) => ({ id: c.id, issuerName: c.issuerName, invoiceDate: c.invoiceDate, totalCents: c.totalCents })),
      });
    }
    targetId = matched[0]?.id ?? null;
  }
  if (targetId !== null) {
    // 锁住发票一行以后再核对（与作废串行）
    const [inv] = await tx<{ id: number; invoiceNo: string; kind: string; status: string }[]>`
      SELECT id, invoice_no, kind, status FROM supplier_invoices WHERE id = ${targetId} FOR KEY SHARE`;
    if (!inv) throw unprocessable('INVOICE_NOT_FOUND', '选的发票不存在，请刷新后重新选');
    if (inv.status !== 'valid') throw conflict('INVOICE_VOIDED', `发票 ${inv.invoiceNo} 已作废，请重新选或重新登记`);
    if (normalizeInvoiceNo(inv.invoiceNo) !== no) throw badRequest(`选的发票号码是 ${inv.invoiceNo}，与填的发票号码不一样`);
    if (inv.kind !== input.kind.key) throw badRequest('选的发票类型与报销填的发票类型不一样');
    const [po] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM supplier_invoice_lines WHERE invoice_id = ${targetId}`;
    if (po!.n > 0) throw conflict('INVOICE_IN_PAYABLES', `发票 ${inv.invoiceNo} 已在三单匹配里分到采购单（走货款付款），不能再报销`);
    const [used] = await tx<{ docNo: string }[]>`
      SELECT doc_no FROM expense_claims WHERE invoice_id = ${targetId} AND status IN ${tx(ACTIVE_CLAIM)} LIMIT 1`;
    if (used) throw conflict('INVOICE_ALREADY_CLAIMED', `发票 ${inv.invoiceNo} 已在报销单 ${used.docNo} 里，同一张发票不能报销两次`, { docNo: used.docNo });
    return Number(inv.id);
  }
  const certifies = invoiceTypeCertifies(input.kind);
  const [row] = await tx<{ id: number }[]>`
    INSERT INTO supplier_invoices (invoice_no, supplier_id, issuer_name, invoice_date, total_cents, tax_cents, tax_rate_bp, note,
                                   kind, kind_label, source, cert_status, client_key, request_hash, created_by)
    VALUES (${input.invoiceNo.trim()}, ${input.supplier?.id ?? null}, ${input.supplier ? '' : input.issuerName.trim()}, ${input.invoiceDate},
            ${input.totalCents}, ${input.taxCents ?? expectedTaxCents(input.totalCents, input.taxRateBp)}, ${input.taxRateBp}, '',
            ${input.kind.key}, ${input.kind.label}, 'expense', ${certifies ? 'pending' : 'not_required'}, gen_random_uuid(), 'expense', ${actor.id})
    RETURNING id`;
  return Number(row!.id);
}

// ───────────────────────── 台账里直接登记 ─────────────────────────

const ManualInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  kind: z.string().min(1, '请选择发票类型').max(32),
  invoiceNo: z.string('请填写发票号码').trim().min(1, '请填写发票号码').max(40, '发票号码最多 40 位'),
  supplierId: id.nullable().default(null),
  issuerName: z.string().trim().max(60, '开票方最多 60 个字').default(''),
  invoiceDate: dateSchema('开票日'),
  totalCents: positiveCents('价税合计'),
  taxCents: z.number('请填写税额').int('税额要精确到分').min(0, '税额不能为负').max(1_000_000_000),
  taxRateBp: z.number('请填写税率').int().min(0, '税率不能为负').max(10000, '税率不能超过 100%'),
  note: z.string().trim().max(200, '备注最多 200 个字').default(''),
});

export async function createManualInvoice(deps: Deps, raw: unknown, actor: Actor, ip?: string): Promise<{ id: number; replayed: boolean }> {
  const input = parse(ManualInput, raw);
  if (input.invoiceDate > todayIn(deps.config.timezone)) throw badRequest('开票日不能晚于今天');
  if (input.taxCents > input.totalCents) throw badRequest('税额不能超过价税合计');
  if (!input.supplierId && !input.issuerName) throw badRequest('请选择供应商或填写开票方');
  const rules = await loadExpenseRules(deps.sql);
  const kind = ledgerKind(rules, input.kind);
  if (!kind) throw unprocessable('INVOICE_TYPE_INVALID', '台账只登记要填号码的发票（专票、普票等），请刷新页面后重选发票类型');
  const requestHash = hashRequest({ ...input, clientKey: undefined, manual: true });
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
      let supplierName = '';
      if (input.supplierId) {
        const [s] = await tx<{ name: string }[]>`SELECT name FROM suppliers WHERE id = ${input.supplierId}`;
        if (!s) throw notFound('供应商不存在');
        supplierName = s.name;
      }
      await lockInvoiceNo(tx, input.invoiceNo);
      const issuer = (supplierName || input.issuerName).trim().toLowerCase();
      const dup = (await findByNo(tx, input.invoiceNo)).find(
        (c) => (input.supplierId && c.supplierId === input.supplierId) || c.issuerName.trim().toLowerCase() === issuer,
      );
      if (dup) throw conflict('INVOICE_DUPLICATE', `${dup.issuerName || '这个开票方'}的发票 ${input.invoiceNo} 已经在台账里了（登错了先作废原来那张）`, { invoiceId: dup.id });
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO supplier_invoices (invoice_no, supplier_id, issuer_name, invoice_date, total_cents, tax_cents, tax_rate_bp, note,
                                       kind, kind_label, source, cert_status, client_key, request_hash, created_by)
        VALUES (${input.invoiceNo}, ${input.supplierId}, ${input.supplierId ? '' : input.issuerName}, ${input.invoiceDate}, ${input.totalCents},
                ${input.taxCents}, ${input.taxRateBp}, ${input.note}, ${kind.key}, ${kind.label}, 'manual',
                ${invoiceTypeCertifies(kind) ? 'pending' : 'not_required'}, ${input.clientKey}, ${requestHash}, ${actor.id})
        RETURNING id`;
      const invoiceId = Number(row!.id);
      await writeAudit(tx, {
        staffId: actor.id,
        action: 'input_invoice',
        targetType: 'supplier_invoice',
        targetId: invoiceId,
        detail: { op: 'create', invoiceNo: input.invoiceNo, totalCents: input.totalCents, kind: kind.label },
        ip,
      });
      return { id: invoiceId, replayed: false };
    });
  } catch (error) {
    if (isUniqueViolation(error, 'supplier_invoices_client_key_key')) {
      const existing = await find(deps.sql);
      if (existing) return { id: existing, replayed: true };
    }
    if (isUniqueViolation(error, 'supplier_invoices_no') || isUniqueViolation(error, 'supplier_invoices_no_issuer')) {
      throw conflict('INVOICE_DUPLICATE', `这个开票方的发票 ${input.invoiceNo} 已经在台账里了（登错了先作废原来那张）`);
    }
    throw error;
  }
}

// ───────────────────────── 认证 ─────────────────────────

const CertInput = z.object({
  status: z.enum(CERT_STATUSES),
  period: z.string().regex(CERT_PERIOD_RE, '所属期要写成 YYYY-MM').nullable().default(null),
  note: z.string().trim().max(100, '说明最多 100 个字').default(''),
  /** 页面看到的认证版本：对不上（别人刚改过）拒绝 */
  version: z.number().int().min(1),
});

function assertPeriod(period: string | null, today: string) {
  if (!period) throw badRequest('标已认证要填所属期（年月）');
  if (period > today.slice(0, 7)) throw badRequest('所属期不能晚于本月');
}

async function applyCert(tx: Tx, invoiceId: number, next: { status: CertStatus; period: string | null; note: string }, actor: Actor, ip?: string) {
  await tx`
    UPDATE supplier_invoices
    SET cert_status = ${next.status}, cert_period = ${next.status === 'certified' ? next.period : null}, cert_note = ${next.note},
        cert_by = ${actor.id}, cert_at = now(), cert_version = cert_version + 1
    WHERE id = ${invoiceId}`;
  await writeAudit(tx, {
    staffId: actor.id,
    action: 'input_invoice',
    targetType: 'supplier_invoice',
    targetId: invoiceId,
    detail: { op: 'cert', status: CERT_STATUS_LABELS[next.status], period: next.period, note: next.note },
    ip,
  });
}

export async function setCertStatus(deps: Deps, invoiceId: number, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(CertInput, raw);
  const today = todayIn(deps.config.timezone);
  if (input.status === 'certified') assertPeriod(input.period, today);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [inv] = await tx<{ status: string; certStatus: CertStatus; certVersion: number; invoiceNo: string }[]>`
      SELECT status, cert_status, cert_version, invoice_no FROM supplier_invoices WHERE id = ${invoiceId} FOR UPDATE`;
    if (!inv) throw notFound('发票不存在');
    if (inv.status !== 'valid') throw conflict('INVOICE_VOIDED', `发票 ${inv.invoiceNo} 已作废，不能再改认证`);
    if (inv.certVersion !== input.version) throw conflict('CERT_CHANGED', `发票 ${inv.invoiceNo} 的认证刚被别人改过，请刷新后再看`);
    await applyCert(tx, invoiceId, { status: input.status, period: input.period, note: input.note }, actor, ip);
  });
}

const BatchInput = z.object({
  ids: z.array(id).min(1, '请勾选要标认证的发票').max(CERT_BATCH_MAX, `一次最多 ${CERT_BATCH_MAX} 张`),
  period: z.string().regex(CERT_PERIOD_RE, '所属期要写成 YYYY-MM'),
  note: z.string().trim().max(100, '说明最多 100 个字').default(''),
});

/** 一批标已认证：按 id 升序逐张锁住；不是待认证的（已经标了、不用认证、作废的）跳过 */
export async function certifyBatch(deps: Deps, raw: unknown, actor: Actor, ip?: string): Promise<{ certified: number; skipped: string[] }> {
  const input = parse(BatchInput, raw);
  assertPeriod(input.period, todayIn(deps.config.timezone));
  const ids = [...new Set(input.ids)].sort((a, b) => a - b);
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    let certified = 0;
    const skipped: string[] = [];
    for (const invoiceId of ids) {
      const [inv] = await tx<{ status: string; certStatus: CertStatus; invoiceNo: string }[]>`
        SELECT status, cert_status, invoice_no FROM supplier_invoices WHERE id = ${invoiceId} FOR UPDATE`;
      if (!inv) throw notFound('有一张发票不存在，请刷新后再选');
      if (inv.status !== 'valid' || inv.certStatus !== 'pending') {
        skipped.push(inv.invoiceNo);
        continue;
      }
      await applyCert(tx, invoiceId, { status: 'certified', period: input.period, note: input.note }, actor, ip);
      certified += 1;
    }
    return { certified, skipped };
  });
}

// ───────────────────────── 照片 ─────────────────────────

const AttachmentInput = z.object({
  name: z.string().trim().max(80, '名称最多 80 个字').default(''),
  mime: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], '只能上传照片（JPEG、PNG、WebP）或 PDF'),
  data: z.string().min(16),
});

export async function addInvoiceAttachment(deps: Deps, invoiceId: number, raw: unknown, actor: Actor, ip?: string): Promise<InvoiceAttachment[]> {
  const input = parse(AttachmentInput, raw);
  const [inv] = await deps.sql<{ status: string }[]>`SELECT status FROM supplier_invoices WHERE id = ${invoiceId}`;
  if (!inv) throw notFound('发票不存在');
  // 先存内容（同一份只存一份）
  const stored =
    input.mime === 'application/pdf'
      ? { fileId: (await storePdf(deps.sql, 'invoice', input.data, actor)).id, imageId: null }
      : { imageId: (await saveImage(deps.sql, { mime: input.mime, data: input.data }, actor)).id, fileId: null };
  await deps.sql.begin(async (tx) => {
    const [d] = await tx<{ status: string; invoiceNo: string }[]>`SELECT status, invoice_no FROM supplier_invoices WHERE id = ${invoiceId} FOR NO KEY UPDATE`;
    if (!d) throw notFound('发票不存在');
    if (d.status !== 'valid') throw conflict('INVOICE_VOIDED', '作废的发票不能再挂照片');
    const [dup] = await tx<{ id: number }[]>`
      SELECT id FROM supplier_invoice_attachments WHERE invoice_id = ${invoiceId} AND (image_id = ${stored.imageId} OR file_id = ${stored.fileId})`;
    if (dup) return; // 同一份已经挂着
    const [n] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM supplier_invoice_attachments WHERE invoice_id = ${invoiceId}`;
    if (n!.n >= MAX_INVOICE_ATTACHMENTS) throw conflict('ATTACHMENT_LIMIT', `每张发票最多 ${MAX_INVOICE_ATTACHMENTS} 份照片或 PDF`);
    const name = input.name || (stored.fileId ? 'PDF' : '照片');
    await tx`
      INSERT INTO supplier_invoice_attachments (invoice_id, image_id, file_id, name, uploaded_by)
      VALUES (${invoiceId}, ${stored.imageId}, ${stored.fileId}, ${name}, ${actor.id})`;
    await writeAudit(tx, { staffId: actor.id, action: 'input_invoice', targetType: 'supplier_invoice', targetId: invoiceId, detail: { op: 'attachment', invoiceNo: d.invoiceNo, name }, ip });
  });
  return attachmentsOf(deps.sql, invoiceId);
}

// ───────────────────────── 作废 ─────────────────────────

/**
 * 作废台账里的发票（写原因）：挂在有效报销单上的不能作废（先撤回或冲销报销单）；三单匹配里分到采购单的要「登记期初未付、付款……」权限
 * （与付款页的作废一样）。锁住发票一行以后核对（与报销关联串行）。
 */
export async function voidInputInvoice(deps: Deps, invoiceId: number, reason: string, actor: Actor, ip?: string) {
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [inv] = await tx<{ status: string; invoiceNo: string; source: InvoiceSource }[]>`
      SELECT status, invoice_no, source FROM supplier_invoices WHERE id = ${invoiceId} FOR UPDATE`;
    if (!inv) throw notFound('发票登记不存在');
    if (inv.status === 'voided') return;
    const [po] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM supplier_invoice_lines WHERE invoice_id = ${invoiceId}`;
    if (po!.n > 0 && !can(actor, 'payable.manage')) throw forbidden('这张发票在三单匹配里分到了采购单，作废要「登记期初未付、付款、核销与供应商退款」权限');
    if (po!.n === 0 && !can(actor, 'invoice.manage') && !can(actor, 'payable.manage')) throw forbidden('当前账号不能作废台账里的发票');
    const [used] = await tx<{ docNo: string }[]>`
      SELECT doc_no FROM expense_claims WHERE invoice_id = ${invoiceId} AND status IN ${tx(ACTIVE_CLAIM)} LIMIT 1`;
    if (used) throw conflict('INVOICE_IN_CLAIM', `发票 ${inv.invoiceNo} 挂在报销单 ${used.docNo} 上，先撤回或冲销报销单再作废`, { docNo: used.docNo });
    await tx`UPDATE supplier_invoices SET status = 'voided', voided_by = ${actor.id}, voided_at = now(), void_reason = ${reason} WHERE id = ${invoiceId}`;
    await writeAudit(tx, { staffId: actor.id, action: 'payment_doc', targetType: 'supplier_invoice', targetId: invoiceId, detail: { op: 'void', invoiceNo: inv.invoiceNo, reason, source: inv.source }, ip });
  });
}

// ───────────────────────── 自检与导出 ─────────────────────────

/** 台账自检：有效报销单关联的发票都没作废、一张发票只挂一张有效报销单；已认证的都有所属期与认证人 */
export async function ledgerChecks(db: Db): Promise<string[]> {
  const rows = await db<{ why: string }[]>`
    SELECT c.doc_no || ' 关联的发票 ' || i.invoice_no || ' 已作废' AS why
    FROM expense_claims c JOIN supplier_invoices i ON i.id = c.invoice_id
    WHERE c.status IN ('submitted', 'returned', 'confirmed') AND i.status <> 'valid'
    UNION ALL
    SELECT '发票 ' || min(i.invoice_no) || ' 同时挂在 ' || count(*) || ' 张有效报销单上'
    FROM expense_claims c JOIN supplier_invoices i ON i.id = c.invoice_id
    WHERE c.status IN ('submitted', 'returned', 'confirmed') GROUP BY c.invoice_id HAVING count(*) > 1
    UNION ALL
    SELECT '发票 ' || i.invoice_no || ' 标了已认证，但没有所属期或认证人'
    FROM supplier_invoices i WHERE i.cert_status = 'certified' AND (i.cert_period IS NULL OR i.cert_by IS NULL)
    UNION ALL
    SELECT '发票 ' || i.invoice_no || ' 既分到了采购单，又挂在有效报销单 ' || c.doc_no || ' 上'
    FROM expense_claims c JOIN supplier_invoices i ON i.id = c.invoice_id
    WHERE c.status IN ('submitted', 'returned', 'confirmed') AND EXISTS (SELECT 1 FROM supplier_invoice_lines l WHERE l.invoice_id = i.id)`;
  return rows.map((r) => r.why);
}

async function ledgerCsv(db: Db, raw: unknown, today: string) {
  const ledger = await loadLedger(db, raw, today, EXPORT_LIMIT);
  return toCsv([
    ['发票号码', '发票类型', '开票方', '开票日', '价税合计', '税额', '税率', '来源', '关联单据', '认证状态', '所属期', '认证期限', '异常', '照片', '状态', '登记人', '登记时间'],
    ...ledger.invoices.map((r) => [
      r.invoiceNo,
      r.kindLabel,
      r.issuerName || '（未填）',
      r.invoiceDate,
      formatAmount(r.totalCents).replace(/,/g, ''),
      formatAmount(r.taxCents).replace(/,/g, ''),
      taxRateText(r.taxRateBp),
      INVOICE_SOURCE_LABELS[r.source],
      r.claim ? r.claim.docNo : r.pos.map((p) => p.docNo).join(' '),
      CERT_STATUS_LABELS[r.certStatus],
      r.certPeriod ?? '',
      r.certDueDate ?? '',
      r.anomalies.map((a) => INVOICE_ANOMALY_LABELS[a]).join('、'),
      String(r.attachmentCount),
      r.status === 'voided' ? `已作废：${r.voidReason ?? ''}` : '有效',
      r.createdByName,
      r.createdAt,
    ]),
  ]);
}

export function registerInvoiceRoutes(app: FastifyInstance, deps: Deps) {
  const { sql, config } = deps;
  const today = () => todayIn(config.timezone);
  const READ = guardAny('payable.read', 'expense.read', 'invoice.manage');
  const MANAGE = guard('invoice.manage');
  const docId = (req: { params: unknown }) => parse(idParam, req.params).id;

  app.get('/api/erp/invoices', { preHandler: READ }, async (req) => readSnapshot(sql, (tx) => loadLedger(tx, req.query, today())));
  app.get('/api/erp/invoices/todo', { preHandler: READ }, async () => invoiceTodo(sql, today()));
  app.get('/api/erp/invoices/lookup', { preHandler: guardAny('expense.read', 'invoice.manage') }, async (req) => {
    const { no } = parse(z.object({ no: z.string().trim().min(1, '请填写发票号码').max(40) }), req.query);
    return findByNo(sql, no);
  });
  app.get('/api/erp/invoices/export', { preHandler: READ }, async (req, reply) => {
    const csv = await readSnapshot(sql, (tx) => ledgerCsv(tx, req.query, today()));
    await writeAudit(sql, { staffId: req.actor.id, action: 'export', targetType: 'input_invoices', detail: req.query as Record<string, unknown>, ip: req.ip });
    return csvReply(reply, `进项发票台账_${today()}.csv`, csv);
  });
  app.get('/api/erp/invoices/attachments/:id/download', { preHandler: READ }, async (req, reply) => {
    const [a] = await sql<{ fileId: number | null; name: string }[]>`SELECT file_id, name FROM supplier_invoice_attachments WHERE id = ${docId(req)}`;
    if (!a || !a.fileId) throw notFound('附件不存在');
    const file = await readFile(sql, Number(a.fileId), 'invoice');
    if (!file) throw notFound('附件不存在');
    attachment(reply, a.name.toLowerCase().endsWith('.pdf') ? a.name : `${a.name}.pdf`, file.mime);
    return reply.send(file.data);
  });
  app.get('/api/erp/invoices/:id', { preHandler: READ }, async (req) => readSnapshot(sql, (tx) => getInputInvoice(tx, docId(req), today())));
  app.post('/api/erp/invoices', { preHandler: MANAGE }, async (req, reply) => {
    const r = await createManualInvoice(deps, req.body, req.actor, req.ip);
    reply.code(r.replayed ? 200 : 201);
    return { replayed: r.replayed, invoice: await getInputInvoice(sql, r.id, today()) };
  });
  app.post('/api/erp/invoices/:id/cert', { preHandler: MANAGE }, async (req) => {
    await setCertStatus(deps, docId(req), req.body, req.actor, req.ip);
    return getInputInvoice(sql, docId(req), today());
  });
  app.post('/api/erp/invoices/cert-batch', { preHandler: MANAGE }, async (req) => certifyBatch(deps, req.body, req.actor, req.ip));
  // 照片：10 MB 的 PDF 转成 Base64 约 13.4 MB
  app.post('/api/erp/invoices/:id/attachments', { preHandler: MANAGE, bodyLimit: 14_500_000 }, async (req, reply) => {
    const list = await addInvoiceAttachment(deps, docId(req), req.body, req.actor, req.ip);
    reply.code(201);
    return list;
  });
  app.post('/api/erp/invoices/:id/void', { preHandler: guardAny('invoice.manage', 'payable.manage') }, async (req) => {
    const { reason } = parse(z.object({ reason: z.string().trim().min(2, '请填写原因（至少 2 个字）').max(200) }), req.body);
    await voidInputInvoice(deps, docId(req), reason, req.actor, req.ip);
    return getInputInvoice(sql, docId(req), today());
  });
}
