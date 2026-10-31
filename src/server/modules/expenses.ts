// 费用报销与备用金（v0.7.7，飞书需求 RQ-005 第一步，见 docs/EXPENSES.md）。
//
// 口径：
//   · 每笔打款单独平账，只算已确认的报销：应退回 = 打款 − 支出；实际退回 = 退回 − 补付；未退回 = 应退回 − 实际退回。
//   · 报销单超过门槛（D13，默认 2000 元）要负责人确认；不超过的登记即确认。内容不可改，错了撤回或冲销后重新登记。
//   · 按采购单报销只能选现付供应商的采购单；采购单的每一行只能在一张有效的报销单里。
//   · 打款、退回、补付登记即生效，错了由负责人冲销。
// 加锁顺序：备用金打款 → 采购单 → 报销单 / 退回补付单。

import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ISO_DATE } from '@shared/business-date';
import {
  CLAIM_STATUS_LABELS,
  DEFAULT_EXPENSE_RULES,
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  PAY_SOURCE_LABELS,
  PAY_SOURCES,
  taxRateText,
  type ClaimStatus,
  type ExpenseClaim,
  type ExpenseClaimList,
  type ExpenseClaimSummary,
  type ExpenseRules,
  type PettyAdvance,
  type PettyAdvanceSummary,
  type PettyBalance,
  type PettyDaily,
  type PettyDailyRow,
  type PettySettlement,
  type PoCandidate,
  type PoForClaim,
} from '@shared/expenses';
import { formatAmount } from '@shared/money';
import { can } from '@shared/permissions';
import { PAYMENT_METHODS } from '@shared/purchasing';
import { formatQty } from '@shared/quantity';
import { isUniqueViolation, readSnapshot, type Db, type Tx } from '../db';
import { guard } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Actor, Deps } from '../lib/context';
import { toCsv } from '../lib/csv';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { idParam, parse, positiveCents } from '../lib/validate';
import { assertNotFuture, docDateSchema, logApproval, nextDocNo, setTxTimeouts, todayIn } from './inventory/common';

const id = z.number().int().positive();
const hashRequest = (payload: unknown) => createHash('sha256').update(JSON.stringify(payload)).digest('hex');
const yuan = (cents: number) => (cents < 0 ? '-' : '') + formatAmount(Math.abs(cents)).replace(/,/g, '');
const ReasonInput = z.object({ reason: z.string().trim().min(2, '请填写原因（至少 2 个字）').max(200) });
const ACTIVE_CLAIM = ['submitted', 'returned', 'confirmed'] as const;

// ───────────────────────── 规则 ─────────────────────────

const RulesInput = z.object({
  approvalThresholdCents: z.number().int().min(0, '门槛不能为负').max(100_000_000, '门槛不能超过 100 万元'),
  overdueDays: z.number().int().min(1, '至少 1 天').max(90, '最多 90 天'),
  purposes: z
    .array(z.string().trim().min(1, '用途不能为空').max(20, '用途最多 20 个字'))
    .min(1, '至少保留一个用途')
    .max(30, '用途最多 30 个')
    .refine((a) => new Set(a).size === a.length, '用途不能重复'),
  invoiceTypes: z
    .array(
      z.object({
        key: z.string().regex(/^[a-z0-9_]{1,32}$/, '发票类型的键只能用小写字母、数字、下划线'),
        label: z.string().trim().min(1, '发票类型名称不能为空').max(20, '发票类型名称最多 20 个字'),
        needsNumber: z.boolean(),
        taxRatesBp: z
          .array(z.number().int().min(0).max(10_000))
          .min(1, '每种发票类型至少一个税点')
          .max(10)
          .refine((a) => new Set(a).size === a.length, '税点不能重复'),
      }),
    )
    .min(1, '至少保留一种发票类型')
    .max(10)
    .refine((a) => new Set(a.map((t) => t.key)).size === a.length, '发票类型的键不能重复'),
});

export async function loadExpenseRules(db: Db): Promise<ExpenseRules> {
  const [row] = await db<{ value: Partial<ExpenseRules> }[]>`SELECT value FROM settings WHERE key = 'expense_rules'`;
  return { ...DEFAULT_EXPENSE_RULES, ...(row?.value ?? {}) };
}

// ───────────────────────── 平账 ─────────────────────────

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export function pettyBalance(
  a: { amountCents: number; advanceDate: string; spentCents: number; pendingCents: number; returnedCents: number; toppedUpCents: number },
  today: string,
  overdueDays: number,
): PettyBalance {
  const dueCents = a.amountCents - a.spentCents;
  const settledCents = a.returnedCents - a.toppedUpCents;
  const outstandingCents = dueCents - settledCents;
  const ageDays = Math.max(0, daysBetween(a.advanceDate, today));
  const state: PettyBalance['state'] = outstandingCents === 0 ? 'settled' : outstandingCents < 0 ? 'owed' : ageDays > overdueDays ? 'overdue' : 'open';
  return { advanceCents: a.amountCents, spentCents: a.spentCents, pendingCents: a.pendingCents, dueCents, settledCents, outstandingCents, state, ageDays };
}

/** 打款列表（含平账）：可按日期、部门、经办人、状态筛选 */
async function advanceRows(
  db: Db,
  f: { from?: string; to?: string; departmentId?: number; handlerId?: number; ids?: number[]; includeVoided?: boolean; unsettledOnly?: boolean },
) {
  return db<
    {
      id: number;
      docNo: string;
      status: 'active' | 'voided';
      advanceDate: string;
      departmentId: number;
      departmentName: string;
      handlerId: number;
      handlerName: string;
      amountCents: number;
      method: (typeof PAYMENT_METHODS)[number];
      evidence: string;
      spentCents: number;
      pendingCents: number;
      returnedCents: number;
      toppedUpCents: number;
    }[]
  >`
    SELECT a.id, a.doc_no, a.status, a.advance_date, a.department_id, d.name AS department_name, a.handler_id, h.display_name AS handler_name,
           a.amount_cents, a.method, a.evidence,
           coalesce((SELECT sum(c.amount_cents) FROM expense_claims c WHERE c.advance_id = a.id AND c.status = 'confirmed'), 0)::bigint AS spent_cents,
           coalesce((SELECT sum(c.amount_cents) FROM expense_claims c WHERE c.advance_id = a.id AND c.status IN ('submitted', 'returned')), 0)::bigint AS pending_cents,
           coalesce((SELECT sum(s.amount_cents) FROM petty_settlements s WHERE s.advance_id = a.id AND s.status = 'active' AND s.kind = 'return'), 0)::bigint AS returned_cents,
           coalesce((SELECT sum(s.amount_cents) FROM petty_settlements s WHERE s.advance_id = a.id AND s.status = 'active' AND s.kind = 'topup'), 0)::bigint AS topped_up_cents
    FROM petty_advances a JOIN departments d ON d.id = a.department_id JOIN staff h ON h.id = a.handler_id
    WHERE TRUE
      ${f.includeVoided ? db`` : db`AND a.status = 'active'`}
      ${f.from ? db`AND a.advance_date >= ${f.from}` : db``}
      ${f.to ? db`AND a.advance_date <= ${f.to}` : db``}
      ${f.departmentId ? db`AND a.department_id = ${f.departmentId}` : db``}
      ${f.handlerId ? db`AND a.handler_id = ${f.handlerId}` : db``}
      ${f.ids ? db`AND a.id IN ${db(f.ids)}` : db``}
    ORDER BY a.advance_date DESC, a.id DESC`;
}

function toAdvanceSummary(r: Awaited<ReturnType<typeof advanceRows>>[number], today: string, overdueDays: number): PettyAdvanceSummary {
  const bal = pettyBalance(r, today, overdueDays);
  return {
    ...bal,
    id: r.id,
    docNo: r.docNo,
    status: r.status,
    advanceDate: r.advanceDate,
    department: { id: r.departmentId, name: r.departmentName },
    handler: { id: r.handlerId, name: r.handlerName },
    method: r.method,
    evidence: r.evidence,
  };
}

export async function listAdvances(
  db: Db,
  timezone: string,
  f: { from?: string; to?: string; departmentId?: number; handlerId?: number; unsettledOnly?: boolean; includeVoided?: boolean },
): Promise<PettyAdvanceSummary[]> {
  const rules = await loadExpenseRules(db);
  const today = todayIn(timezone);
  const rows = (await advanceRows(db, f)).map((r) => toAdvanceSummary(r, today, rules.overdueDays));
  return f.unsettledOnly ? rows.filter((r) => r.status === 'active' && r.state !== 'settled') : rows;
}

export async function getAdvance(db: Db, timezone: string, advanceId: number): Promise<PettyAdvance> {
  const rules = await loadExpenseRules(db);
  const [r] = await advanceRows(db, { ids: [advanceId], includeVoided: true });
  if (!r) throw notFound('打款记录不存在');
  const [extra] = await db<{ note: string; createdByName: string; createdAt: string; voidedByName: string | null; voidedAt: string | null; voidReason: string | null; isSynthetic: boolean }[]>`
    SELECT a.note, cb.display_name AS created_by_name, a.created_at, vb.display_name AS voided_by_name, a.voided_at, a.void_reason, a.is_synthetic
    FROM petty_advances a JOIN staff cb ON cb.id = a.created_by LEFT JOIN staff vb ON vb.id = a.voided_by WHERE a.id = ${advanceId}`;
  const settlements = await db<PettySettlement[]>`
    SELECT s.id, s.doc_no, s.kind, s.status, s.settle_date, s.amount_cents, s.method, s.evidence, s.note,
           cb.display_name AS created_by_name, s.created_at, vb.display_name AS voided_by_name, s.void_reason
    FROM petty_settlements s JOIN staff cb ON cb.id = s.created_by LEFT JOIN staff vb ON vb.id = s.voided_by
    WHERE s.advance_id = ${advanceId} ORDER BY s.settle_date, s.id`;
  const claims = await claimSummaries(db, { advanceId });
  return { ...toAdvanceSummary(r, todayIn(timezone), rules.overdueDays), ...extra!, claims, settlements };
}

/** 每日平账：按付款日（打款日期）与部门汇总 */
export async function pettyDaily(db: Db, timezone: string, f: { from: string; to: string; departmentId?: number; handlerId?: number }): Promise<PettyDaily> {
  const rules = await loadExpenseRules(db);
  const today = todayIn(timezone);
  const advances = (await advanceRows(db, f)).map((r) => toAdvanceSummary(r, today, rules.overdueDays));
  const byKey = new Map<string, PettyDailyRow>();
  const rank = { settled: 0, open: 1, owed: 2, overdue: 3 } as const;
  for (const a of advances) {
    const key = `${a.advanceDate}|${a.department.id}`;
    let row = byKey.get(key);
    if (!row) {
      row = {
        date: a.advanceDate,
        department: a.department,
        advanceCents: 0,
        spentCents: 0,
        pendingCents: 0,
        dueCents: 0,
        settledCents: 0,
        outstandingCents: 0,
        state: 'settled',
        advances: [],
      };
      byKey.set(key, row);
    }
    row.advanceCents += a.advanceCents;
    row.spentCents += a.spentCents;
    row.pendingCents += a.pendingCents;
    row.dueCents += a.dueCents;
    row.settledCents += a.settledCents;
    row.outstandingCents += a.outstandingCents;
    if (rank[a.state] > rank[row.state]) row.state = a.state;
    row.advances.push(a);
  }
  const rows = [...byKey.values()].sort((x, y) => (x.date === y.date ? x.department.name.localeCompare(y.department.name, 'zh-CN') : x.date < y.date ? 1 : -1));
  const sum = (k: 'advanceCents' | 'spentCents' | 'pendingCents' | 'dueCents' | 'settledCents' | 'outstandingCents') => rows.reduce((t, r) => t + r[k], 0);
  // 目前没平的（不限日期）：每个部门经办人手里的钱、待补付
  const open = (await advanceRows(db, { departmentId: f.departmentId, handlerId: f.handlerId }))
    .map((r) => toAdvanceSummary(r, today, rules.overdueDays))
    .filter((a) => a.state !== 'settled');
  const openMap = new Map<number, PettyDaily['openByDepartment'][number]>();
  for (const a of open) {
    const o = openMap.get(a.department.id) ?? { department: a.department, outstandingCents: 0, owedCents: 0, overdue: 0, open: 0 };
    if (a.outstandingCents > 0) o.outstandingCents += a.outstandingCents;
    else o.owedCents += -a.outstandingCents;
    if (a.state === 'overdue') o.overdue += 1;
    o.open += 1;
    openMap.set(a.department.id, o);
  }
  return {
    from: f.from,
    to: f.to,
    rows,
    totals: {
      advanceCents: sum('advanceCents'),
      spentCents: sum('spentCents'),
      pendingCents: sum('pendingCents'),
      dueCents: sum('dueCents'),
      settledCents: sum('settledCents'),
      outstandingCents: sum('outstandingCents'),
    },
    openByDepartment: [...openMap.values()].sort((x, y) => x.department.name.localeCompare(y.department.name, 'zh-CN')),
  };
}

// ───────────────────────── 报销单查询 ─────────────────────────

interface ClaimFilter {
  from?: string;
  to?: string;
  departmentId?: number;
  handlerId?: number;
  status?: ClaimStatus;
  paySource?: (typeof PAY_SOURCES)[number];
  advanceId?: number;
  ids?: number[];
}

async function claimSummaries(db: Db, f: ClaimFilter): Promise<ExpenseClaimSummary[]> {
  const rows = await db<
    (Omit<ExpenseClaimSummary, 'department' | 'handler' | 'advance' | 'purchaseOrder'> & {
      departmentId: number;
      departmentName: string;
      handlerId: number;
      handlerName: string;
      advanceId: number | null;
      advanceNo: string | null;
      poId: number | null;
      poNo: string | null;
      supplierName: string | null;
    })[]
  >`
    SELECT c.id, c.doc_no, c.status, c.expense_date, c.department_id, d.name AS department_name, c.handler_id, h.display_name AS handler_name,
           c.purpose, c.pay_source, c.advance_id, a.doc_no AS advance_no, c.invoice_type, c.invoice_label, c.tax_rate_bp, c.invoice_no,
           c.purchase_order_id AS po_id, po.doc_no AS po_no, s.name AS supplier_name, c.amount_cents, c.needs_approval,
           coalesce((SELECT string_agg(l.name, '、' ORDER BY l.line_no) FROM expense_claim_lines l WHERE l.claim_id = c.id AND l.line_no <= 3), '') AS summary,
           cb.display_name AS created_by_name, c.created_at
    FROM expense_claims c JOIN departments d ON d.id = c.department_id JOIN staff h ON h.id = c.handler_id JOIN staff cb ON cb.id = c.created_by
    LEFT JOIN petty_advances a ON a.id = c.advance_id
    LEFT JOIN purchase_orders po ON po.id = c.purchase_order_id LEFT JOIN suppliers s ON s.id = po.supplier_id
    WHERE TRUE
      ${f.from ? db`AND c.expense_date >= ${f.from}` : db``}
      ${f.to ? db`AND c.expense_date <= ${f.to}` : db``}
      ${f.departmentId ? db`AND c.department_id = ${f.departmentId}` : db``}
      ${f.handlerId ? db`AND c.handler_id = ${f.handlerId}` : db``}
      ${f.status ? db`AND c.status = ${f.status}` : db``}
      ${f.paySource ? db`AND c.pay_source = ${f.paySource}` : db``}
      ${f.advanceId ? db`AND c.advance_id = ${f.advanceId}` : db``}
      ${f.ids ? db`AND c.id IN ${db(f.ids)}` : db``}
    ORDER BY c.expense_date DESC, c.id DESC
    LIMIT 2000`;
  return rows.map(({ departmentId, departmentName, handlerId, handlerName, advanceId, advanceNo, poId, poNo, supplierName, ...r }) => ({
    ...r,
    department: { id: departmentId, name: departmentName },
    handler: { id: handlerId, name: handlerName },
    advance: advanceId ? { id: advanceId, docNo: advanceNo! } : null,
    purchaseOrder: poId ? { id: poId, docNo: poNo!, supplierName: supplierName ?? '' } : null,
  }));
}

export async function listClaims(db: Db, f: ClaimFilter): Promise<ExpenseClaimList> {
  const claims = await claimSummaries(db, f);
  return {
    claims,
    totals: {
      confirmedCents: claims.filter((c) => c.status === 'confirmed').reduce((t, c) => t + c.amountCents, 0),
      pendingCents: claims.filter((c) => c.status === 'submitted' || c.status === 'returned').reduce((t, c) => t + c.amountCents, 0),
      count: claims.length,
    },
  };
}

export async function getClaim(db: Db, claimId: number): Promise<ExpenseClaim> {
  const [summary] = await claimSummaries(db, { ids: [claimId] });
  if (!summary) throw notFound('报销单不存在');
  const [extra] = await db<Pick<ExpenseClaim, 'note' | 'createdBy' | 'confirmedByName' | 'confirmedAt' | 'returnedReason' | 'voidedByName' | 'voidedAt' | 'voidReason' | 'isSynthetic'>[]>`
    SELECT c.note, c.created_by, ob.display_name AS confirmed_by_name, c.confirmed_at, c.returned_reason, vb.display_name AS voided_by_name,
           c.voided_at, c.void_reason, c.is_synthetic
    FROM expense_claims c LEFT JOIN staff ob ON ob.id = c.confirmed_by LEFT JOIN staff vb ON vb.id = c.voided_by WHERE c.id = ${claimId}`;
  const lines = await db<ExpenseClaim['lines']>`
    SELECT line_no, name, category, unit, bought_milli, received_milli, diff_reason, amount_cents, po_line_id, material_id
    FROM expense_claim_lines WHERE claim_id = ${claimId} ORDER BY line_no`;
  const approvals = await db<ExpenseClaim['approvals']>`
    SELECT a.id, a.action, s.display_name AS actor_name, a.reason, a.created_at
    FROM approval_logs a JOIN staff s ON s.id = a.actor_id WHERE a.doc_kind = 'expense_claim' AND a.doc_id = ${claimId} ORDER BY a.id`;
  return { ...summary, ...extra!, lines, approvals };
}

// ───────────────────────── 按采购单报销 ─────────────────────────

/** 已到货数量（库存单位）：按采购单行汇总已生效的收货 */
async function receivedByLine(db: Db, poId: number) {
  const rows = await db<{ poLineId: number; qty: number }[]>`
    SELECT l.po_line_id, sum(l.qty_milli)::bigint AS qty FROM inv_doc_lines l JOIN inv_docs d ON d.id = l.doc_id
    WHERE d.purchase_order_id = ${poId} AND d.doc_type = 'receipt' AND d.status = 'confirmed' AND l.po_line_id IS NOT NULL
    GROUP BY l.po_line_id`;
  return new Map(rows.map((r) => [r.poLineId, r.qty]));
}

export async function poForClaim(db: Db, poId: number, excludeClaimId: number | null = null): Promise<PoForClaim & { settlement: string; status: string }> {
  const [po] = await db<{ id: number; docNo: string; supplierName: string; orderDate: string; settlement: string; status: string }[]>`
    SELECT p.id, p.doc_no, s.name AS supplier_name, p.order_date, s.settlement, p.status
    FROM purchase_orders p JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = ${poId}`;
  if (!po) throw notFound('采购单不存在');
  const lines = await db<{ poLineId: number; materialId: number; name: string; unit: string; boughtMilli: number; amountCents: number }[]>`
    SELECT pl.id AS po_line_id, pl.material_id, m.name, pl.inventory_unit AS unit, pl.base_qty_milli AS bought_milli, pl.amount_cents
    FROM purchase_order_lines pl JOIN materials m ON m.id = pl.material_id WHERE pl.po_id = ${poId} ORDER BY pl.line_no`;
  const received = await receivedByLine(db, poId);
  const claimed = await db<{ poLineId: number; docNo: string }[]>`
    SELECT l.po_line_id, c.doc_no FROM expense_claim_lines l JOIN expense_claims c ON c.id = l.claim_id
    WHERE l.po_line_id IN (SELECT id FROM purchase_order_lines WHERE po_id = ${poId}) AND c.status IN ${db(ACTIVE_CLAIM)}
      ${excludeClaimId ? db`AND c.id <> ${excludeClaimId}` : db``}`;
  const claimedMap = new Map(claimed.map((c) => [c.poLineId, c.docNo]));
  return {
    ...po,
    lines: lines.map((l) => ({ ...l, receivedMilli: received.get(l.poLineId) ?? 0, claimedBy: claimedMap.get(l.poLineId) ?? null })),
  };
}

export async function poCandidates(db: Db, q: string): Promise<PoCandidate[]> {
  const like = `%${q.trim()}%`;
  return db<PoCandidate[]>`
    SELECT p.id, p.doc_no, s.name AS supplier_name, p.order_date, p.status, p.total_cents,
           (SELECT count(*) FROM purchase_order_lines pl WHERE pl.po_id = p.id AND NOT EXISTS (
              SELECT 1 FROM expense_claim_lines l JOIN expense_claims c ON c.id = l.claim_id
              WHERE l.po_line_id = pl.id AND c.status IN ${db(ACTIVE_CLAIM)}))::int AS open_lines
    FROM purchase_orders p JOIN suppliers s ON s.id = p.supplier_id
    WHERE s.settlement = 'cash' AND p.status IN ('approved', 'closed')
      ${q.trim() ? db`AND (p.doc_no ILIKE ${like} OR s.name ILIKE ${like} OR s.code ILIKE ${like})` : db``}
    ORDER BY p.order_date DESC, p.id DESC
    LIMIT 50`;
}

// ───────────────────────── 登记报销 ─────────────────────────

const LineInput = z.object({
  name: z.string().trim().min(1, '请填写物品或内容').max(40, '物品名称最多 40 个字'),
  category: z.enum(EXPENSE_CATEGORIES, '费用科目只能选办公费、固定资产、低值易耗'),
  unit: z.string().trim().min(1, '请填写单位').max(8, '单位最多 8 个字'),
  boughtMilli: z.number().int().positive('购买数量必须大于 0').max(1_000_000_000),
  receivedMilli: z.number().int().min(0, '到货数量不能为负').max(1_000_000_000),
  diffReason: z.string().trim().max(100, '差异原因最多 100 个字').default(''),
  amountCents: positiveCents('金额'),
  poLineId: id.nullable().default(null),
});

const ClaimInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  expenseDate: docDateSchema,
  departmentId: id,
  handlerId: id,
  purpose: z.string().trim().min(1, '请选择用途').max(20),
  paySource: z.enum(PAY_SOURCES),
  advanceId: id.nullable().default(null),
  invoiceType: z.string().min(1, '请选择发票类型').max(32),
  taxRateBp: z.number().int().min(0).max(10_000),
  invoiceNo: z.string().trim().max(40, '发票号码最多 40 个字').default(''),
  purchaseOrderId: id.nullable().default(null),
  note: z.string().trim().max(200).default(''),
  lines: z.array(LineInput).min(1, '至少一行').max(50, '一张报销单最多 50 行'),
  approveNow: z.boolean().default(false),
});

async function lockAdvance(tx: Tx, advanceId: number) {
  const [a] = await tx<{ id: number; docNo: string; status: string; departmentId: number; advanceDate: string; amountCents: number }[]>`
    SELECT id, doc_no, status, department_id, advance_date, amount_cents FROM petty_advances WHERE id = ${advanceId} FOR UPDATE`;
  if (!a) throw notFound('打款记录不存在');
  return a;
}

export async function createClaim(deps: Deps, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(ClaimInput, raw);
  if (input.approveNow && !can(actor, 'expense.approve')) throw forbidden('当前账号不能确认报销，请提交给负责人');
  assertNotFuture(input.expenseDate, deps.config.timezone);
  const rules = await loadExpenseRules(deps.sql);
  if (!rules.purposes.includes(input.purpose)) throw unprocessable('PURPOSE_INVALID', `用途只能从固定选项里选：${rules.purposes.join('、')}`);
  const inv = rules.invoiceTypes.find((t) => t.key === input.invoiceType);
  if (!inv) throw unprocessable('INVOICE_TYPE_INVALID', '发票类型不在固定选项里，请刷新页面后重选');
  if (!inv.taxRatesBp.includes(input.taxRateBp)) {
    throw unprocessable('TAX_RATE_MISMATCH', `${inv.label}的税点只能是 ${inv.taxRatesBp.map(taxRateText).join('、')}`);
  }
  if (inv.needsNumber && !input.invoiceNo) throw unprocessable('INVOICE_NO_REQUIRED', `标了${inv.label}，请填写发票号码；没有发票请选「收据」或「无票」`);
  if (input.paySource === 'petty' && !input.advanceId) throw badRequest('用备用金付的，请选择这笔钱出自哪一笔打款');
  if (input.paySource === 'company' && input.advanceId) throw badRequest('公司直付的报销不选打款');
  if (!input.purchaseOrderId && input.lines.some((l) => l.poLineId)) throw badRequest('按次报销的明细不能关联采购单行');
  const poLineIds = input.lines.map((l) => l.poLineId).filter((x): x is number => x !== null);
  if (new Set(poLineIds).size !== poLineIds.length) throw badRequest('同一采购单行在一张报销单里只能出现一次');
  for (const l of input.lines) {
    if (!l.poLineId && l.boughtMilli !== l.receivedMilli && l.diffReason.length < 2) {
      throw unprocessable('DIFF_REASON_REQUIRED', `「${l.name}」到货数量与购买数量不一致，请填写差异原因`);
    }
  }
  const total = input.lines.reduce((t, l) => t + l.amountCents, 0);
  const needsApproval = total > rules.approvalThresholdCents;
  const requestHash = hashRequest({ ...input, clientKey: undefined });

  const findExisting = async (db: Db) => {
    const [row] = await db<{ opType: string; requestHash: string; refId: number }[]>`SELECT op_type, request_hash, ref_id FROM idempotency_keys WHERE key = ${input.clientKey}`;
    if (!row) return null;
    if (row.opType !== 'expense_claim' || row.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一笔不同的登记，请刷新页面后重新填写');
    return row.refId;
  };

  let claimId: number;
  let replayed = false;
  try {
    const r = await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const existing = await findExisting(tx);
      if (existing) return { id: existing, replayed: true };
      const [dept] = await tx<{ active: boolean }[]>`SELECT active FROM departments WHERE id = ${input.departmentId}`;
      if (!dept?.active) throw unprocessable('DEPARTMENT_INVALID', '部门不存在或已停用');
      const [handler] = await tx<{ active: boolean }[]>`SELECT active FROM staff WHERE id = ${input.handlerId}`;
      if (!handler?.active) throw unprocessable('HANDLER_INVALID', '经办人不存在或已停用');

      // 锁：打款 → 采购单
      if (input.advanceId) {
        const a = await lockAdvance(tx, input.advanceId);
        if (a.status !== 'active') throw conflict('ADVANCE_VOIDED', `打款 ${a.docNo} 已冲销，不能再用`);
        if (a.departmentId !== input.departmentId) throw unprocessable('ADVANCE_DEPARTMENT_MISMATCH', `打款 ${a.docNo} 是别的部门的备用金`);
      }
      const lines = input.lines.map((l) => ({ ...l, materialId: null as number | null }));
      if (input.purchaseOrderId) {
        await tx`SELECT id FROM purchase_orders WHERE id = ${input.purchaseOrderId} FOR UPDATE`;
        const po = await poForClaim(tx, input.purchaseOrderId);
        if (po.settlement !== 'cash') throw unprocessable('CREDIT_SUPPLIER', '挂账供应商的采购单请在「应付货款」里付款核销，不能按采购单报销');
        if (po.status !== 'approved' && po.status !== 'closed') throw conflict('PO_NOT_APPROVED', '只能报销已确认或已关闭的采购单');
        for (const l of lines) {
          if (!l.poLineId) continue;
          const pl = po.lines.find((x) => x.poLineId === l.poLineId);
          if (!pl) throw badRequest('明细里的采购单行不属于这张采购单');
          if (pl.claimedBy) throw conflict('PO_LINE_CLAIMED', `「${pl.name}」已在报销单 ${pl.claimedBy} 里，不能重复报销`, { docNo: pl.claimedBy });
          // 购买、到货数量以系统为准：页面打开后又收了货，要重新核对
          if (l.boughtMilli !== pl.boughtMilli || l.receivedMilli !== pl.receivedMilli || l.name !== pl.name || l.unit !== pl.unit) {
            throw conflict('PO_CHANGED', `「${pl.name}」的采购或到货数量刚变了，请刷新后重新核对`);
          }
          if (pl.boughtMilli !== pl.receivedMilli && l.diffReason.length < 2) {
            throw unprocessable('DIFF_REASON_REQUIRED', `「${pl.name}」到货 ${formatQty(pl.receivedMilli)} / 购买 ${formatQty(pl.boughtMilli)} ${pl.unit}，请填写差异原因`);
          }
          l.materialId = pl.materialId;
        }
      }

      const confirmNow = !needsApproval || input.approveNow;
      const docNo = await nextDocNo(tx, 'expense_claim', 'BX', input.expenseDate);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO expense_claims (doc_no, expense_date, department_id, handler_id, purpose, pay_source, advance_id, invoice_type, invoice_label,
                                    tax_rate_bp, invoice_no, purchase_order_id, amount_cents, note, needs_approval, status, client_key, created_by,
                                    confirmed_by, confirmed_at)
        VALUES (${docNo}, ${input.expenseDate}, ${input.departmentId}, ${input.handlerId}, ${input.purpose}, ${input.paySource}, ${input.advanceId},
                ${inv.key}, ${inv.label}, ${input.taxRateBp}, ${input.invoiceNo}, ${input.purchaseOrderId}, ${total}, ${input.note}, ${needsApproval},
                ${confirmNow ? 'confirmed' : 'submitted'}, ${input.clientKey}, ${actor.id},
                ${confirmNow ? actor.id : null}, ${confirmNow ? tx`now()` : null})
        RETURNING id`;
      const newId = row!.id;
      let lineNo = 0;
      for (const l of lines) {
        lineNo += 1;
        await tx`
          INSERT INTO expense_claim_lines (claim_id, line_no, name, category, unit, bought_milli, received_milli, diff_reason, amount_cents, po_line_id, material_id)
          VALUES (${newId}, ${lineNo}, ${l.name}, ${l.category}, ${l.unit}, ${l.boughtMilli}, ${l.receivedMilli},
                  ${l.boughtMilli === l.receivedMilli ? '' : l.diffReason}, ${l.amountCents}, ${l.poLineId}, ${l.materialId})`;
      }
      await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${input.clientKey}, 'expense_claim', ${requestHash}, ${newId}, ${actor.id})`;
      await logApproval(tx, 'expense_claim', newId, 'create', actor.id);
      await logApproval(tx, 'expense_claim', newId, 'submit', actor.id);
      if (confirmNow) await logApproval(tx, 'expense_claim', newId, 'approve', actor.id, needsApproval ? '' : '未超过确认门槛，登记即确认');
      await writeAudit(tx, { staffId: actor.id, action: 'expense_doc', targetType: 'expense_claim', targetId: newId, detail: { docNo, amountCents: total, status: confirmNow ? 'confirmed' : 'submitted' }, ip });
      return { id: newId, replayed: false };
    });
    claimId = r.id;
    replayed = r.replayed;
  } catch (error) {
    if (isUniqueViolation(error, 'idempotency_keys_pkey') || isUniqueViolation(error, 'expense_claims_client_key_key')) {
      const existing = await findExisting(deps.sql);
      if (!existing) throw error;
      claimId = existing;
      replayed = true;
    } else throw error;
  }
  return { claim: await getClaim(deps.sql, claimId), replayed };
}

export async function actOnClaim(deps: Deps, claimId: number, action: 'approve' | 'return' | 'resubmit' | 'cancel' | 'void', raw: unknown, actor: Actor) {
  const reason = action === 'approve' || action === 'resubmit' ? '' : parse(ReasonInput, raw).reason;
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [head] = await tx<{ advanceId: number | null }[]>`SELECT advance_id FROM expense_claims WHERE id = ${claimId}`;
    if (!head) throw notFound('报销单不存在');
    const advance = head.advanceId ? await lockAdvance(tx, head.advanceId) : null;
    const [c] = await tx<{ id: number; status: ClaimStatus; createdBy: number }[]>`SELECT id, status, created_by FROM expense_claims WHERE id = ${claimId} FOR UPDATE`;
    const mine = c!.createdBy === actor.id;
    switch (action) {
      case 'approve':
        if (c!.status === 'confirmed') return;
        if (c!.status !== 'submitted') throw conflict('INVALID_STATE', '只有待确认的报销可以确认');
        if (advance && advance.status !== 'active') throw conflict('ADVANCE_VOIDED', `打款 ${advance.docNo} 已冲销，请退回让登记人改用别的打款`);
        await tx`UPDATE expense_claims SET status = 'confirmed', confirmed_by = ${actor.id}, confirmed_at = now(), returned_reason = NULL, updated_at = now() WHERE id = ${claimId}`;
        return logApproval(tx, 'expense_claim', claimId, 'approve', actor.id);
      case 'return':
        if (c!.status === 'returned') return;
        if (c!.status !== 'submitted') throw conflict('INVALID_STATE', '只有待确认的报销可以退回');
        await tx`UPDATE expense_claims SET status = 'returned', returned_reason = ${reason}, updated_at = now() WHERE id = ${claimId}`;
        return logApproval(tx, 'expense_claim', claimId, 'return', actor.id, reason);
      case 'resubmit':
        if (c!.status === 'submitted') return;
        if (c!.status !== 'returned') throw conflict('INVALID_STATE', '只有退回的报销可以重新提交');
        if (!mine && !can(actor, 'expense.manage')) throw forbidden('只能重新提交自己登记的报销');
        if (advance && advance.status !== 'active') throw conflict('ADVANCE_VOIDED', `打款 ${advance.docNo} 已冲销，请撤回后重新登记`);
        await tx`UPDATE expense_claims SET status = 'submitted', updated_at = now() WHERE id = ${claimId}`;
        return logApproval(tx, 'expense_claim', claimId, 'submit', actor.id);
      case 'cancel':
        if (c!.status === 'cancelled') return;
        if (c!.status !== 'submitted' && c!.status !== 'returned') throw conflict('INVALID_STATE', '已确认的报销不能撤回，只能由负责人冲销');
        if (!mine && !can(actor, 'expense.approve')) throw forbidden('只能撤回自己登记的报销');
        await tx`UPDATE expense_claims SET status = 'cancelled', returned_reason = ${reason}, updated_at = now() WHERE id = ${claimId}`;
        return logApproval(tx, 'expense_claim', claimId, 'cancel', actor.id, reason);
      case 'void':
        if (c!.status === 'voided') return;
        if (c!.status !== 'confirmed') throw conflict('INVALID_STATE', '只有已确认的报销可以冲销');
        await tx`UPDATE expense_claims SET status = 'voided', voided_by = ${actor.id}, voided_at = now(), void_reason = ${reason}, updated_at = now() WHERE id = ${claimId}`;
        return logApproval(tx, 'expense_claim', claimId, 'void', actor.id, reason);
    }
  });
  await writeAudit(deps.sql, { staffId: actor.id, action: 'expense_doc', targetType: 'expense_claim', targetId: claimId, detail: { action, reason } });
  return getClaim(deps.sql, claimId);
}

// ───────────────────────── 打款、退回、补付 ─────────────────────────

const AdvanceInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  departmentId: id,
  handlerId: id,
  advanceDate: docDateSchema,
  amountCents: positiveCents('打款金额'),
  method: z.enum(PAYMENT_METHODS),
  evidence: z.string().trim().min(2, '请填写凭据说明，例如转账流水号后四位').max(200),
  note: z.string().trim().max(200).default(''),
});

const SettlementInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  advanceId: id,
  kind: z.enum(['return', 'topup']),
  settleDate: docDateSchema,
  amountCents: positiveCents('金额'),
  method: z.enum(PAYMENT_METHODS),
  evidence: z.string().trim().min(2, '请填写凭据说明，例如转账流水号后四位').max(200),
  note: z.string().trim().max(200).default(''),
});

/** 打款、退回补付共用的幂等登记 */
async function idempotentInsert(
  deps: Deps,
  opType: 'petty_advance' | 'petty_settlement',
  input: { clientKey: string },
  uniqueKey: string,
  actor: Actor,
  body: (tx: Tx) => Promise<number>,
): Promise<{ id: number; replayed: boolean }> {
  const requestHash = hashRequest({ ...input, clientKey: undefined });
  const findExisting = async (db: Db) => {
    const [row] = await db<{ opType: string; requestHash: string; refId: number }[]>`SELECT op_type, request_hash, ref_id FROM idempotency_keys WHERE key = ${input.clientKey}`;
    if (!row) return null;
    if (row.opType !== opType || row.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一笔不同的登记，请刷新页面后重新填写');
    return row.refId;
  };
  try {
    return await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const existing = await findExisting(tx);
      if (existing) return { id: existing, replayed: true };
      const newId = await body(tx);
      await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${input.clientKey}, ${opType}, ${requestHash}, ${newId}, ${actor.id})`;
      return { id: newId, replayed: false };
    });
  } catch (error) {
    if (isUniqueViolation(error, 'idempotency_keys_pkey') || isUniqueViolation(error, uniqueKey)) {
      const existing = await findExisting(deps.sql);
      if (!existing) throw error;
      return { id: existing, replayed: true };
    }
    throw error;
  }
}

export async function createAdvance(deps: Deps, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(AdvanceInput, raw);
  assertNotFuture(input.advanceDate, deps.config.timezone);
  const r = await idempotentInsert(deps, 'petty_advance', input, 'petty_advances_client_key_key', actor, async (tx) => {
    const [dept] = await tx<{ active: boolean }[]>`SELECT active FROM departments WHERE id = ${input.departmentId}`;
    if (!dept?.active) throw unprocessable('DEPARTMENT_INVALID', '部门不存在或已停用');
    const [handler] = await tx<{ active: boolean }[]>`SELECT active FROM staff WHERE id = ${input.handlerId}`;
    if (!handler?.active) throw unprocessable('HANDLER_INVALID', '经办人不存在或已停用');
    const docNo = await nextDocNo(tx, 'petty_advance', 'BY', input.advanceDate);
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO petty_advances (doc_no, department_id, handler_id, advance_date, amount_cents, method, evidence, note, client_key, created_by)
      VALUES (${docNo}, ${input.departmentId}, ${input.handlerId}, ${input.advanceDate}, ${input.amountCents}, ${input.method}, ${input.evidence},
              ${input.note}, ${input.clientKey}, ${actor.id})
      RETURNING id`;
    await logApproval(tx, 'petty_advance', row!.id, 'create', actor.id);
    await writeAudit(tx, { staffId: actor.id, action: 'petty_doc', targetType: 'petty_advance', targetId: row!.id, detail: { docNo, amountCents: input.amountCents }, ip });
    return row!.id;
  });
  return { advance: await getAdvance(deps.sql, deps.config.timezone, r.id), replayed: r.replayed };
}

export async function createSettlement(deps: Deps, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(SettlementInput, raw);
  assertNotFuture(input.settleDate, deps.config.timezone);
  const r = await idempotentInsert(deps, 'petty_settlement', input, 'petty_settlements_client_key_key', actor, async (tx) => {
    const a = await lockAdvance(tx, input.advanceId);
    if (a.status !== 'active') throw conflict('ADVANCE_VOIDED', `打款 ${a.docNo} 已冲销`);
    if (input.settleDate < a.advanceDate) throw unprocessable('SETTLE_BEFORE_ADVANCE', `日期不能早于打款日期 ${a.advanceDate}`);
    const [row] = await advanceRows(tx, { ids: [a.id] });
    const bal = pettyBalance(row!, todayIn(deps.config.timezone), 0);
    if (input.kind === 'return') {
      if (bal.outstandingCents <= 0) throw conflict('NOTHING_TO_RETURN', `打款 ${a.docNo} 没有未退回的钱${bal.outstandingCents < 0 ? `，反而待补付 ¥${formatAmount(-bal.outstandingCents)}` : ''}`);
      if (input.amountCents > bal.outstandingCents) throw conflict('RETURN_EXCEEDS', `打款 ${a.docNo} 未退回 ¥${formatAmount(bal.outstandingCents)}，最多退这么多`);
    } else {
      if (bal.outstandingCents >= 0) throw conflict('NOTHING_TO_TOPUP', `打款 ${a.docNo} 没有待补付的钱`);
      if (input.amountCents > -bal.outstandingCents) throw conflict('TOPUP_EXCEEDS', `打款 ${a.docNo} 待补付 ¥${formatAmount(-bal.outstandingCents)}，最多补这么多`);
    }
    const docNo = await nextDocNo(tx, input.kind === 'return' ? 'petty_return' : 'petty_topup', input.kind === 'return' ? 'TH' : 'BF', input.settleDate);
    const [s] = await tx<{ id: number }[]>`
      INSERT INTO petty_settlements (doc_no, advance_id, kind, settle_date, amount_cents, method, evidence, note, client_key, created_by)
      VALUES (${docNo}, ${a.id}, ${input.kind}, ${input.settleDate}, ${input.amountCents}, ${input.method}, ${input.evidence}, ${input.note},
              ${input.clientKey}, ${actor.id})
      RETURNING id`;
    await logApproval(tx, 'petty_settlement', s!.id, 'create', actor.id);
    await writeAudit(tx, { staffId: actor.id, action: 'petty_doc', targetType: 'petty_settlement', targetId: s!.id, detail: { docNo, advance: a.docNo, kind: input.kind, amountCents: input.amountCents }, ip });
    return s!.id;
  });
  const [s] = await deps.sql<{ advanceId: number }[]>`SELECT advance_id FROM petty_settlements WHERE id = ${r.id}`;
  return { advance: await getAdvance(deps.sql, deps.config.timezone, s!.advanceId), settlementId: r.id, replayed: r.replayed };
}

export async function voidAdvance(deps: Deps, advanceId: number, raw: unknown, actor: Actor) {
  const { reason } = parse(ReasonInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const a = await lockAdvance(tx, advanceId);
    if (a.status === 'voided') return;
    const [used] = await tx<{ claims: number; settlements: number }[]>`
      SELECT (SELECT count(*) FROM expense_claims WHERE advance_id = ${advanceId} AND status IN ${tx(ACTIVE_CLAIM)})::int AS claims,
             (SELECT count(*) FROM petty_settlements WHERE advance_id = ${advanceId} AND status = 'active')::int AS settlements`;
    if (used!.claims > 0 || used!.settlements > 0) {
      throw conflict('ADVANCE_IN_USE', `打款 ${a.docNo} 下面还有 ${used!.claims} 张有效的报销、${used!.settlements} 笔退回 / 补付，先撤回或冲销它们`);
    }
    await tx`UPDATE petty_advances SET status = 'voided', voided_by = ${actor.id}, voided_at = now(), void_reason = ${reason} WHERE id = ${advanceId}`;
    await logApproval(tx, 'petty_advance', advanceId, 'void', actor.id, reason);
  });
  await writeAudit(deps.sql, { staffId: actor.id, action: 'petty_doc', targetType: 'petty_advance', targetId: advanceId, detail: { action: 'void', reason } });
  return getAdvance(deps.sql, deps.config.timezone, advanceId);
}

export async function voidSettlement(deps: Deps, settlementId: number, raw: unknown, actor: Actor) {
  const { reason } = parse(ReasonInput, raw);
  const [head] = await deps.sql<{ advanceId: number }[]>`SELECT advance_id FROM petty_settlements WHERE id = ${settlementId}`;
  if (!head) throw notFound('退回 / 补付记录不存在');
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await lockAdvance(tx, head.advanceId);
    const [s] = await tx<{ status: string }[]>`SELECT status FROM petty_settlements WHERE id = ${settlementId} FOR UPDATE`;
    if (s!.status === 'voided') return;
    await tx`UPDATE petty_settlements SET status = 'voided', voided_by = ${actor.id}, voided_at = now(), void_reason = ${reason} WHERE id = ${settlementId}`;
    await logApproval(tx, 'petty_settlement', settlementId, 'void', actor.id, reason);
  });
  await writeAudit(deps.sql, { staffId: actor.id, action: 'petty_doc', targetType: 'petty_settlement', targetId: settlementId, detail: { action: 'void', reason } });
  return getAdvance(deps.sql, deps.config.timezone, head.advanceId);
}

// ───────────────────────── 自检 ─────────────────────────

export interface ExpenseCheck {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

export async function expenseChecks(db: Db): Promise<ExpenseCheck[]> {
  const items: ExpenseCheck[] = [];
  const badClaims = await db<{ docNo: string; why: string }[]>`
    SELECT c.doc_no, '金额与明细合计不一致' AS why FROM expense_claims c
    WHERE c.amount_cents <> coalesce((SELECT sum(amount_cents) FROM expense_claim_lines WHERE claim_id = c.id), 0)
    UNION ALL
    SELECT c.doc_no, '与打款不是同一个部门' FROM expense_claims c JOIN petty_advances a ON a.id = c.advance_id
    WHERE c.department_id <> a.department_id
    UNION ALL
    SELECT c.doc_no, '用的打款已冲销' FROM expense_claims c JOIN petty_advances a ON a.id = c.advance_id
    WHERE c.status IN ('submitted', 'returned', 'confirmed') AND a.status = 'voided'
    UNION ALL
    SELECT min(c.doc_no), '同一采购单行报销了不止一次' FROM expense_claim_lines l JOIN expense_claims c ON c.id = l.claim_id
    WHERE l.po_line_id IS NOT NULL AND c.status IN ('submitted', 'returned', 'confirmed')
    GROUP BY l.po_line_id HAVING count(*) > 1`;
  const claimCount = await db<{ count: number }[]>`SELECT count(*)::int AS count FROM expense_claims WHERE status = 'confirmed'`;
  items.push({
    key: 'expense_claims',
    label: '费用报销单与明细一致',
    ok: badClaims.length === 0,
    detail: badClaims.length
      ? badClaims.map((b) => `${b.docNo} ${b.why}`).join('；')
      : `已确认的报销 ${claimCount[0]!.count} 张：金额 = 明细合计，用备用金的与打款同部门，同一采购单行只报一次`,
  });

  const badPetty = await db<{ docNo: string; why: string }[]>`
    SELECT s.doc_no, '记在已冲销的打款上' AS why FROM petty_settlements s JOIN petty_advances a ON a.id = s.advance_id
    WHERE s.status = 'active' AND a.status = 'voided'
    UNION ALL
    SELECT s.doc_no, '日期早于打款日期' FROM petty_settlements s JOIN petty_advances a ON a.id = s.advance_id
    WHERE s.status = 'active' AND s.settle_date < a.advance_date`;
  const [adv] = await db<{ count: number; amount: number }[]>`SELECT count(*)::int AS count, coalesce(sum(amount_cents), 0)::bigint AS amount FROM petty_advances WHERE status = 'active'`;
  items.push({
    key: 'petty_ledger',
    label: '备用金台账一致',
    ok: badPetty.length === 0,
    detail: badPetty.length ? badPetty.map((b) => `${b.docNo} ${b.why}`).join('；') : `有效打款 ${adv!.count} 笔共 ¥${formatAmount(adv!.amount)}，退回 / 补付都记在有效的打款上`,
  });

  const badAp = await db<{ docNo: string; why: string }[]>`
    SELECT d.doc_no, CASE WHEN d.settlement = 'credit' THEN '挂账的收货应付记录不是一条' ELSE '现付的收货记了应付' END AS why
    FROM inv_docs d
    WHERE d.doc_type = 'receipt' AND d.status IN ('confirmed', 'voided') AND d.amount_cents > 0
      AND (SELECT count(*) FROM ap_entries e WHERE e.inv_doc_id = d.id AND e.entry_type = 'receipt') <> CASE WHEN d.settlement = 'credit' THEN 1 ELSE 0 END
    UNION ALL
    SELECT d.doc_no, '收货单没有记下结算方式' FROM inv_docs d
    WHERE d.doc_type IN ('receipt', 'supplier_return') AND d.status IN ('confirmed', 'voided') AND d.settlement IS NULL`;
  const [cash] = await db<{ count: number }[]>`SELECT count(*)::int AS count FROM inv_docs WHERE doc_type = 'receipt' AND status = 'confirmed' AND settlement = 'cash'`;
  items.push({
    key: 'cash_receipts',
    label: '现付供应商的收货不记应付',
    ok: badAp.length === 0,
    detail: badAp.length ? badAp.map((b) => `${b.docNo} ${b.why}`).join('；') : `挂账的收货各有一条应付；现付的收货 ${cash!.count} 张都没有应付`,
  });
  return items;
}

// ───────────────────────── 导出 ─────────────────────────

function csvReply(reply: FastifyReply, name: string, csv: string) {
  reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  return csv;
}

async function claimsCsv(db: Db, f: ClaimFilter & { from: string; to: string }) {
  const claims = await claimSummaries(db, f);
  const ids = claims.map((c) => c.id);
  type Line = ExpenseClaim['lines'][number] & { claimId: number };
  const lines: Line[] = ids.length
    ? [
        ...(await db<Line[]>`
          SELECT claim_id, line_no, name, category, unit, bought_milli, received_milli, diff_reason, amount_cents, po_line_id, material_id
          FROM expense_claim_lines WHERE claim_id IN ${db(ids)} ORDER BY claim_id, line_no`),
      ]
    : [];
  const byClaim = new Map<number, Line[]>();
  for (const l of lines) byClaim.set(l.claimId, [...(byClaim.get(l.claimId) ?? []), l]);
  const confirmed = claims.filter((c) => c.status === 'confirmed').reduce((t, c) => t + c.amountCents, 0);
  return toCsv([
    [`费用报销明细 ${f.from} 至 ${f.to}（门店内部管理口径；已确认合计 ¥${yuan(confirmed)}）`],
    ['单号', '日期', '状态', '部门', '经办人', '用途', '付款来源', '打款单', '发票类型', '税点', '发票号码', '采购单', '供应商', '行', '物品 / 内容', '费用科目', '单位', '购买数量', '到货数量', '差异原因', '金额（元）'],
    ...claims.flatMap((c) =>
      (byClaim.get(c.id) ?? []).map((l) => [
        c.docNo,
        c.expenseDate,
        CLAIM_STATUS_LABELS[c.status],
        c.department.name,
        c.handler.name,
        c.purpose,
        PAY_SOURCE_LABELS[c.paySource],
        c.advance?.docNo ?? '',
        c.invoiceLabel,
        taxRateText(c.taxRateBp),
        c.invoiceNo,
        c.purchaseOrder?.docNo ?? '',
        c.purchaseOrder?.supplierName ?? '',
        l.lineNo,
        l.name,
        EXPENSE_CATEGORY_LABELS[l.category],
        l.unit,
        formatQty(l.boughtMilli),
        formatQty(l.receivedMilli),
        l.diffReason,
        yuan(l.amountCents),
      ]),
    ),
  ]);
}

const STATE_LABELS: Record<PettyBalance['state'], string> = { settled: '已平', open: '未退回', overdue: '超期未退', owed: '待补付' };

function dailyCsv(d: PettyDaily) {
  return toCsv([
    [`备用金每日平账 ${d.from} 至 ${d.to}（应退回 = 打款 − 已确认支出；实际退回 = 退回 − 补付；未退回 = 应退回 − 实际退回）`],
    ['付款日', '部门', '打款单', '经办人', '打款（元）', '支出（元）', '待确认（元）', '应退回（元）', '实际退回（元）', '未退回（元）', '状态', '天数'],
    ...d.rows.flatMap((r) => [
      ...r.advances.map((a) => [
        r.date,
        r.department.name,
        a.docNo,
        a.handler.name,
        yuan(a.advanceCents),
        yuan(a.spentCents),
        yuan(a.pendingCents),
        yuan(a.dueCents),
        yuan(a.settledCents),
        yuan(a.outstandingCents),
        STATE_LABELS[a.state],
        a.ageDays,
      ]),
      [r.date, r.department.name, '当日合计', '', yuan(r.advanceCents), yuan(r.spentCents), yuan(r.pendingCents), yuan(r.dueCents), yuan(r.settledCents), yuan(r.outstandingCents), STATE_LABELS[r.state], ''],
    ]),
    [],
    ['合计', '', '', '', yuan(d.totals.advanceCents), yuan(d.totals.spentCents), yuan(d.totals.pendingCents), yuan(d.totals.dueCents), yuan(d.totals.settledCents), yuan(d.totals.outstandingCents)],
  ]);
}

// ───────────────────────── 路由 ─────────────────────────

const optId = z.coerce.number().int().positive().optional();
const ClaimQuery = z.object({
  from: docDateSchema.optional(),
  to: docDateSchema.optional(),
  departmentId: optId,
  handlerId: optId,
  status: z.enum(['submitted', 'returned', 'confirmed', 'cancelled', 'voided']).optional(),
  paySource: z.enum(PAY_SOURCES).optional(),
  advanceId: optId,
});
const RangeQuery = z.object({ from: docDateSchema, to: docDateSchema, departmentId: optId, handlerId: optId });
const AdvanceQuery = z.object({
  from: docDateSchema.optional(),
  to: docDateSchema.optional(),
  departmentId: optId,
  handlerId: optId,
  unsettled: z.enum(['1', '0']).optional(),
  all: z.enum(['1', '0']).optional(),
});
const keyParam = z.object({ key: z.uuid('操作编号格式不正确') });

const checkRange = (from: string, to: string) => {
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to) || from > to) throw badRequest('开始日期不能晚于结束日期');
  if (daysBetween(from, to) > 366) throw badRequest('一次最多查 366 天');
};

export function registerExpenseRoutes(app: FastifyInstance, deps: Deps) {
  const { sql, config } = deps;
  const docId = (req: { params: unknown }) => parse(idParam, req.params).id;

  app.get('/api/erp/expenses/rules', { preHandler: guard('expense.read') }, async () => loadExpenseRules(sql));
  app.put('/api/erp/expenses/rules', { preHandler: guard('settings.manage') }, async (req) => {
    const rules = parse(RulesInput, req.body);
    await sql.begin(async (tx) => {
      const before = await loadExpenseRules(tx);
      await tx`
        INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('expense_rules', ${tx.json(rules as never)}, now(), ${req.actor.id})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`;
      await writeAudit(tx, { staffId: req.actor.id, action: 'settings_updated', targetType: 'settings', detail: { key: 'expense_rules', before, after: rules }, ip: req.ip });
    });
    return loadExpenseRules(sql);
  });

  // 报销
  app.get('/api/erp/expenses', { preHandler: guard('expense.read') }, async (req) => {
    const f = parse(ClaimQuery, req.query);
    if (f.from && f.to) checkRange(f.from, f.to);
    return readSnapshot(sql, (tx) => listClaims(tx, f));
  });
  app.get('/api/erp/expenses/export', { preHandler: guard('expense.export') }, async (req, reply) => {
    const f = parse(ClaimQuery.extend({ from: docDateSchema, to: docDateSchema }), req.query);
    checkRange(f.from, f.to);
    const csv = await readSnapshot(sql, (tx) => claimsCsv(tx, f));
    await writeAudit(sql, { staffId: req.actor.id, action: 'export', targetType: 'expense_claims', detail: f, ip: req.ip });
    return csvReply(reply, `费用报销明细_${f.from}_${f.to}.csv`, csv);
  });
  app.get('/api/erp/expenses/checks', { preHandler: guard('expense.read') }, async () => readSnapshot(sql, expenseChecks));
  // 经办人：在职的员工（只给名字，不给账号与岗位）
  app.get('/api/erp/expenses/handlers', { preHandler: guard('expense.read') }, async () =>
    sql<{ id: number; name: string }[]>`SELECT id, display_name AS name FROM staff WHERE active ORDER BY display_name`,
  );
  app.get('/api/erp/expenses/po-candidates', { preHandler: guard('expense.manage') }, async (req) => {
    const { q } = parse(z.object({ q: z.string().max(40).default('') }), req.query);
    return poCandidates(sql, q);
  });
  app.get('/api/erp/expenses/po/:id', { preHandler: guard('expense.manage') }, async (req) => {
    const po = await poForClaim(sql, docId(req));
    if (po.settlement !== 'cash') throw unprocessable('CREDIT_SUPPLIER', '挂账供应商的采购单请在「应付货款」里付款核销，不能按采购单报销');
    const { settlement: _s, status: _st, ...rest } = po;
    return rest satisfies PoForClaim;
  });
  app.get('/api/erp/expenses/by-key/:key', { preHandler: guard('expense.read') }, async (req) => {
    const { key } = parse(keyParam, req.params);
    const [row] = await sql<{ id: number }[]>`SELECT id FROM expense_claims WHERE client_key = ${key}`;
    if (!row) throw notFound('没有找到这次登记');
    return getClaim(sql, row.id);
  });
  app.get('/api/erp/expenses/:id', { preHandler: guard('expense.read') }, async (req) => getClaim(sql, docId(req)));
  app.post('/api/erp/expenses', { preHandler: guard('expense.manage') }, async (req, reply) => {
    const r = await createClaim(deps, req.body, req.actor, req.ip);
    if (!r.replayed) reply.code(201);
    return r;
  });
  for (const action of ['approve', 'return', 'void'] as const) {
    app.post(`/api/erp/expenses/:id/${action}`, { preHandler: guard('expense.approve') }, async (req) => actOnClaim(deps, docId(req), action, req.body, req.actor));
  }
  for (const action of ['resubmit', 'cancel'] as const) {
    app.post(`/api/erp/expenses/:id/${action}`, { preHandler: guard('expense.read') }, async (req) => {
      if (!can(req.actor, 'expense.manage') && !can(req.actor, 'expense.approve')) throw forbidden('当前账号不能处理报销单');
      return actOnClaim(deps, docId(req), action, req.body, req.actor);
    });
  }

  // 备用金
  app.get('/api/erp/petty/advances', { preHandler: guard('expense.read') }, async (req) => {
    const f = parse(AdvanceQuery, req.query);
    return readSnapshot(sql, (tx) =>
      listAdvances(tx, config.timezone, { ...f, unsettledOnly: f.unsettled === '1', includeVoided: f.all === '1' }),
    );
  });
  app.get('/api/erp/petty/advances/by-key/:key', { preHandler: guard('expense.read') }, async (req) => {
    const { key } = parse(keyParam, req.params);
    const [row] = await sql<{ id: number }[]>`SELECT id FROM petty_advances WHERE client_key = ${key}`;
    if (!row) throw notFound('没有找到这次登记');
    return getAdvance(sql, config.timezone, row.id);
  });
  app.get('/api/erp/petty/advances/:id', { preHandler: guard('expense.read') }, async (req) => readSnapshot(sql, (tx) => getAdvance(tx, config.timezone, docId(req))));
  app.post('/api/erp/petty/advances', { preHandler: guard('petty.manage') }, async (req, reply) => {
    const r = await createAdvance(deps, req.body, req.actor, req.ip);
    if (!r.replayed) reply.code(201);
    return r;
  });
  app.post('/api/erp/petty/advances/:id/void', { preHandler: guard('expense.approve') }, async (req) => voidAdvance(deps, docId(req), req.body, req.actor));
  app.get('/api/erp/petty/settlements/by-key/:key', { preHandler: guard('expense.read') }, async (req) => {
    const { key } = parse(keyParam, req.params);
    const [row] = await sql<{ advanceId: number; id: number }[]>`SELECT id, advance_id FROM petty_settlements WHERE client_key = ${key}`;
    if (!row) throw notFound('没有找到这次登记');
    return { advance: await getAdvance(sql, config.timezone, row.advanceId), settlementId: row.id };
  });
  app.post('/api/erp/petty/settlements', { preHandler: guard('petty.manage') }, async (req, reply) => {
    const r = await createSettlement(deps, req.body, req.actor, req.ip);
    if (!r.replayed) reply.code(201);
    return r;
  });
  app.post('/api/erp/petty/settlements/:id/void', { preHandler: guard('expense.approve') }, async (req) => voidSettlement(deps, docId(req), req.body, req.actor));
  app.get('/api/erp/petty/daily', { preHandler: guard('expense.read') }, async (req) => {
    const f = parse(RangeQuery, req.query);
    checkRange(f.from, f.to);
    return readSnapshot(sql, (tx) => pettyDaily(tx, config.timezone, f));
  });
  app.get('/api/erp/petty/daily/export', { preHandler: guard('expense.export') }, async (req, reply) => {
    const f = parse(RangeQuery, req.query);
    checkRange(f.from, f.to);
    const d = await readSnapshot(sql, (tx) => pettyDaily(tx, config.timezone, f));
    await writeAudit(sql, { staffId: req.actor.id, action: 'export', targetType: 'petty_daily', detail: f, ip: req.ip });
    return csvReply(reply, `备用金每日平账_${f.from}_${f.to}.csv`, dailyCsv(d));
  });
}

