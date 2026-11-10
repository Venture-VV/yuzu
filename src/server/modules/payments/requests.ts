// 付款申请（v0.7.32，docs/PAYMENTS.md 第 3 节，默认 P5–P7、P10 待确认）：从合同的某一段或没挂合同的应付（收货单、期初未付）发起，
// 提交即走审批中心（「付款申请」，提前付款是「提前付款」）；退回、撤回后改了再提交；没付过钱的可以作废；付了一部分、剩下不付的「结束」。
// 批了以后按申请登记付款、不再审一次：采购合同与没挂合同的走供应商往来的付款登记（核销到收货单 / 期初未付，或记预付款），
// 服务、租赁、其他合同没有收货单、不记应付，在申请上登记合同付款。
//
// 锁（AGENTS.md「开发约定」）：
//   · 新建：操作编号的咨询锁（与「确认作废」串行）→ 合同一行（FOR NO KEY UPDATE，同一合同的申请串行，读付款计划时合同不在改）
//     或供应商一行（没挂合同的，与付款登记同一把锁）→ 写申请；改了再提交同样先锁合同 / 供应商、再锁申请一行；
//   · 撤回、作废、结束、同意、退回只锁申请一行（同意、退回、撤回之后锁申请的审批单一行，与审批中心一样）；
//   · 按申请登记付款：供应商一行 → 申请一行 → 收货单（id 升序）→ 期初未付；合同付款：申请一行 → 合同付款；
//   · 冲销按申请登记的付款：供应商 → 付款 → 申请一行；冲销合同付款：申请一行 → 合同付款。没有反过来的路径。

import { z } from 'zod';
import { PAYMENT_STAGES, PAYMENT_STAGE_LABELS, type ContractCategory, type PaymentStage } from '@shared/contracts';
import { formatAmount } from '@shared/money';
import {
  type PaymentRequestDetail,
  type PaymentRequestMeta,
  type PaymentRequestStatus,
  type PaymentRequestSummary,
  type PaymentRequestTarget,
  type PayMode,
  type RequestPaymentView,
  type StagePlan,
  type ThreeWayRow,
} from '@shared/payments';
import { can } from '@shared/permissions';
import { PAYMENT_METHODS, type PayMethod } from '@shared/purchasing';
import { isUniqueViolation, type Db, type Tx } from '../../db';
import { writeAudit } from '../../lib/audit';
import type { Actor, Deps } from '../../lib/context';
import { todayIn } from '../../lib/dates';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { assertNotFenced, lockOpKey } from '../../lib/fences';
import { hashRequest } from '../../lib/idempotency';
import { nextDocNo, setTxTimeouts } from '../../lib/tx';
import { dateSchema, parse, positiveCents } from '../../lib/validate';
import { approvalBrief, approveCurrent, closeApproval, returnCurrent, submitForApproval } from '../approvals/engine';
import { enabledErpModules, erpModuleDisabled } from '../erp';
import { erpOpAbandoned } from '../erp-ops';
import { loadExpenseRules } from '../expenses';
import { assertNotFuture, assertSameMonth, logApproval } from '../inventory/common';
import { checkAllocations, confirmPayment, lockSupplier, openItems, reopenPaidRequest, supplierCredits } from '../inventory/payables';
import { contractReceivedPoIds, poThreeWay, threeWayProblems } from './match';
import { loadSettings } from '../settings';
import { assertNoAcceptanceHold } from './hold';
import { contractPlan, requestPaidSql } from './plan';

const id = z.number().int().positive();
const yuan = (cents: number) => `¥${formatAmount(cents)}`;
const Reason = z.string('请填写原因').trim().min(2, '请填写原因（至少 2 个字）').max(200, '原因最多 200 个字');
const ClientKey = z.uuid('缺少有效的操作编号，请刷新页面后重试');
const TargetInput = z.object({ kind: z.enum(['receipt', 'opening']), targetId: id, amountCents: positiveCents('申请金额') });
type TargetIn = z.infer<typeof TargetInput>;

const Common = z.object({
  expectedDate: dateSchema('期望付款日'),
  purpose: z.string('请写明用途').trim().min(2, '请写明用途（至少 2 个字）').max(200, '用途最多 200 个字'),
  early: z.boolean().default(false),
  earlyReason: z.string().trim().max(200, '原因最多 200 个字').default(''),
});
const ContractSource = z.object({ kind: z.literal('contract'), contractId: id, stage: z.enum(PAYMENT_STAGES, '请选择付款节点'), amountCents: positiveCents('申请金额') });
const PayablesSource = z.object({ kind: z.literal('payables'), supplierId: id, targets: z.array(TargetInput).min(1, '请选择要付的货款').max(100, '一次最多 100 笔') });
const CreateInput = Common.extend({ clientKey: ClientKey, source: z.discriminatedUnion('kind', [ContractSource, PayablesSource]) });
const ResubmitInput = Common.extend({
  version: z.number('缺少版本号，请刷新后重试').int().positive(),
  amountCents: positiveCents('申请金额').optional(),
  targets: z.array(TargetInput).min(1, '请选择要付的货款').max(100).optional(),
});

// ───────────────────────── 读 ─────────────────────────

interface RequestRow {
  id: number;
  requestNo: string;
  status: PaymentRequestStatus;
  supplierId: number | null;
  supplierName: string | null;
  payee: string;
  contractId: number | null;
  contractNo: string | null;
  contractTitle: string | null;
  contractCategory: ContractCategory | null;
  stage: PaymentStage | null;
  payMode: PayMode;
  amountCents: number;
  paidCents: number;
  early: boolean;
  earlyReason: string;
  expectedDate: string;
  purpose: string;
  departmentId: number | null;
  departmentName: string | null;
  returnedReason: string | null;
  closedReason: string | null;
  closedByName: string | null;
  closedAt: string | null;
  submittedByName: string;
  submittedAt: string;
  approvedAt: string | null;
  version: number;
  createdBy: number;
  createdByName: string;
  createdAt: string;
}

const rowSelect = (db: Db) => db`
  SELECT r.id, r.request_no, r.status, r.supplier_id, s.name AS supplier_name, r.payee, r.contract_id, c.contract_no, c.title AS contract_title,
         c.category AS contract_category, r.stage, r.pay_mode, r.amount_cents, ${requestPaidSql(db)} AS paid_cents, r.early, r.early_reason,
         r.expected_date, r.purpose, r.department_id, d.name AS department_name, r.returned_reason, r.closed_reason, xb.display_name AS closed_by_name,
         r.closed_at, sb.display_name AS submitted_by_name, r.submitted_at, r.approved_at, r.version, r.created_by, cb.display_name AS created_by_name, r.created_at
  FROM payment_requests r
  JOIN staff cb ON cb.id = r.created_by JOIN staff sb ON sb.id = r.submitted_by
  LEFT JOIN suppliers s ON s.id = r.supplier_id LEFT JOIN contracts c ON c.id = r.contract_id
  LEFT JOIN departments d ON d.id = r.department_id LEFT JOIN staff xb ON xb.id = r.closed_by`;

const norm = (r: RequestRow): RequestRow => ({
  ...r,
  id: Number(r.id),
  supplierId: r.supplierId === null ? null : Number(r.supplierId),
  contractId: r.contractId === null ? null : Number(r.contractId),
  departmentId: r.departmentId === null ? null : Number(r.departmentId),
  amountCents: Number(r.amountCents),
  paidCents: Number(r.paidCents),
  createdBy: Number(r.createdBy),
});

function toSummary(r: RequestRow): PaymentRequestSummary {
  return {
    id: r.id,
    requestNo: r.requestNo,
    status: r.status,
    supplierId: r.supplierId,
    supplierName: r.supplierName,
    payee: r.payee,
    contractId: r.contractId,
    contractNo: r.contractNo,
    stage: r.stage,
    payMode: r.payMode,
    amountCents: r.amountCents,
    paidCents: r.paidCents,
    early: r.early,
    expectedDate: r.expectedDate,
    purpose: r.purpose,
    departmentName: r.departmentName,
    createdById: r.createdBy,
    createdByName: r.createdByName,
    createdAt: r.createdAt,
    submittedAt: r.submittedAt,
    approvedAt: r.approvedAt,
  };
}

export type RequestListFilter = 'all' | 'reviewing' | 'returned' | 'approved' | 'done' | 'mine';

/** 付款申请列表（最近的在前，最多 300 张） */
export async function listPaymentRequests(
  db: Db,
  actor: Actor,
  f: { filter?: RequestListFilter; supplierId?: number; contractId?: number; q?: string } = {},
): Promise<PaymentRequestSummary[]> {
  const filter = f.filter ?? 'all';
  const q = f.q ? `%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
  const rows = await db<RequestRow[]>`
    ${rowSelect(db)}
    WHERE true
      ${filter === 'reviewing' ? db`AND r.status = 'submitted'` : db``}
      ${filter === 'returned' ? db`AND r.status = 'returned'` : db``}
      ${filter === 'approved' ? db`AND r.status = 'approved'` : db``}
      ${filter === 'done' ? db`AND r.status IN ('paid', 'ended', 'voided')` : db``}
      ${filter === 'mine' ? db`AND r.created_by = ${actor.id}` : db``}
      ${f.supplierId ? db`AND r.supplier_id = ${f.supplierId}` : db``}
      ${f.contractId ? db`AND r.contract_id = ${f.contractId}` : db``}
      ${q ? db`AND (r.request_no ILIKE ${q} OR r.payee ILIKE ${q} OR c.contract_no ILIKE ${q} OR r.purpose ILIKE ${q})` : db``}
    ORDER BY r.id DESC
    LIMIT 300`;
  return rows.map((r) => toSummary(norm(r)));
}

async function loadRow(db: Db, requestId: number): Promise<RequestRow> {
  const [r] = await db<RequestRow[]>`${rowSelect(db)} WHERE r.id = ${requestId}`;
  if (!r) throw notFound('付款申请不存在');
  return norm(r);
}

/** 没挂合同的申请选的收货单、期初未付：申请金额、这张申请已经付到这一笔上的、现在还没结清的 */
async function targetsOf(db: Db, r: Pick<RequestRow, 'id' | 'supplierId'>): Promise<PaymentRequestTarget[]> {
  const rows = await db<{ kind: 'receipt' | 'opening'; targetId: number; docNo: string; date: string; amountCents: number; paidCents: number; purchaseOrderNo: string | null }[]>`
    SELECT CASE WHEN t.receipt_doc_id IS NOT NULL THEN 'receipt' ELSE 'opening' END AS kind,
           coalesce(t.receipt_doc_id, t.opening_payable_id) AS target_id, coalesce(d.doc_no, o.doc_no) AS doc_no,
           coalesce(d.doc_date, o.as_of_date)::text AS date, t.amount_cents, po.doc_no AS purchase_order_no,
           coalesce((SELECT sum(pa.amount_cents) FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
                     WHERE p.payment_request_id = t.request_id AND p.status = 'confirmed'
                       AND (pa.receipt_doc_id = t.receipt_doc_id OR pa.opening_payable_id = t.opening_payable_id)), 0) AS paid_cents
    FROM payment_request_targets t LEFT JOIN inv_docs d ON d.id = t.receipt_doc_id LEFT JOIN opening_payables o ON o.id = t.opening_payable_id
    LEFT JOIN purchase_orders po ON po.id = d.purchase_order_id
    WHERE t.request_id = ${r.id} ORDER BY t.id`;
  if (rows.length === 0) return [];
  const open = r.supplierId === null ? [] : await openItems(db, r.supplierId);
  return rows.map((t) => {
    const item = open.find((i) => i.kind === t.kind && i.id === Number(t.targetId));
    return {
      kind: t.kind,
      targetId: Number(t.targetId),
      docNo: t.docNo,
      date: t.date,
      amountCents: Number(t.amountCents),
      paidCents: Number(t.paidCents),
      openCents: item ? item.openCents : 0,
      purchaseOrderNo: t.purchaseOrderNo,
    };
  });
}

async function paymentsOf(db: Db, requestId: number): Promise<RequestPaymentView[]> {
  const pays = await db<{ id: number; docNo: string; payDate: string; amountCents: number; method: PayMethod; evidence: string; note: string; status: string; createdByName: string; createdAt: string; voidReason: string | null }[]>`
    SELECT p.id, p.doc_no, p.pay_date, p.amount_cents, p.method, p.evidence, p.note, p.status, cb.display_name AS created_by_name, p.created_at, p.void_reason
    FROM payments p JOIN staff cb ON cb.id = p.created_by WHERE p.payment_request_id = ${requestId} AND p.status IN ('confirmed', 'voided') ORDER BY p.id`;
  const allocs = pays.length
    ? await db<{ paymentId: number; kind: 'receipt' | 'opening'; docNo: string; amountCents: number }[]>`
        SELECT pa.payment_id, CASE WHEN pa.receipt_doc_id IS NOT NULL THEN 'receipt' ELSE 'opening' END AS kind, coalesce(d.doc_no, o.doc_no) AS doc_no, pa.amount_cents
        FROM payment_allocations pa LEFT JOIN inv_docs d ON d.id = pa.receipt_doc_id LEFT JOIN opening_payables o ON o.id = pa.opening_payable_id
        WHERE pa.payment_id IN ${db(pays.map((p) => Number(p.id)))} ORDER BY pa.id`
    : [];
  const payouts = await db<{ id: number; docNo: string; payDate: string; amountCents: number; method: PayMethod; evidence: string; note: string; status: string; createdByName: string; createdAt: string; voidReason: string | null }[]>`
    SELECT o.id, o.doc_no, o.pay_date, o.amount_cents, o.method, o.evidence, o.note, o.status, cb.display_name AS created_by_name, o.created_at, o.void_reason
    FROM contract_payouts o JOIN staff cb ON cb.id = o.created_by WHERE o.payment_request_id = ${requestId} ORDER BY o.id`;
  const out: RequestPaymentView[] = [];
  for (const p of pays) {
    const mine = allocs.filter((a) => Number(a.paymentId) === Number(p.id)).map((a) => ({ kind: a.kind, docNo: a.docNo, amountCents: Number(a.amountCents) }));
    out.push({
      kind: 'payment',
      id: Number(p.id),
      docNo: p.docNo,
      payDate: p.payDate,
      amountCents: Number(p.amountCents),
      method: p.method,
      evidence: p.evidence,
      note: p.note,
      status: p.status === 'voided' ? 'voided' : 'confirmed',
      createdByName: p.createdByName,
      createdAt: p.createdAt,
      voidReason: p.voidReason,
      allocations: mine,
      prepaidCents: Number(p.amountCents) - mine.reduce((s, a) => s + a.amountCents, 0),
    });
  }
  for (const o of payouts) {
    out.push({
      kind: 'payout',
      id: Number(o.id),
      docNo: o.docNo,
      payDate: o.payDate,
      amountCents: Number(o.amountCents),
      method: o.method,
      evidence: o.evidence,
      note: o.note,
      status: o.status === 'voided' ? 'voided' : 'confirmed',
      createdByName: o.createdByName,
      createdAt: o.createdAt,
      voidReason: o.voidReason,
      allocations: [],
      prepaidCents: 0,
    });
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** 一家供应商的往来余额与可抵扣（与供应商往来的口径一样） */
async function supplierBalanceOf(db: Db, supplierId: number): Promise<{ balanceCents: number; creditCents: number }> {
  const [b] = await db<{ cents: string }[]>`SELECT coalesce(sum(amount_delta_cents), 0)::text AS cents FROM ap_entries WHERE supplier_id = ${supplierId}`;
  const credits = (await supplierCredits(db, supplierId)).filter((c) => c.canOffset).reduce((s, c) => s + c.availableCents, 0);
  return { balanceCents: Number(b!.cents), creditCents: credits };
}

/** 申请涉及的采购单：合同挂的采购单里有收货的，或选的收货单所属的采购单（急采还没补单的收货单没有采购单） */
async function requestPoIds(db: Db, r: Pick<RequestRow, 'id' | 'contractId'>): Promise<number[]> {
  if (r.contractId !== null) return contractReceivedPoIds(db, r.contractId);
  const rows = await db<{ poId: number }[]>`
    SELECT DISTINCT d.purchase_order_id AS po_id FROM payment_request_targets t JOIN inv_docs d ON d.id = t.receipt_doc_id
    WHERE t.request_id = ${r.id} AND d.purchase_order_id IS NOT NULL`;
  return rows.map((x) => Number(x.poId));
}

/** 三单要不要求（P8）：合同的预付段、服务 / 租赁 / 其他合同不要求；没挂合同的只有期初未付的也不要求 */
function threeWayRequired(r: { contractId: number | null; contractCategory: ContractCategory | null; stage: PaymentStage | null }, hasReceiptTargets: boolean): boolean {
  if (r.contractId !== null) return r.contractCategory === 'purchase' && r.stage !== 'prepay';
  return hasReceiptTargets;
}

export async function getPaymentRequest(db: Db, requestId: number, today: string): Promise<PaymentRequestDetail> {
  const r = await loadRow(db, requestId);
  const targets = await targetsOf(db, r);
  const threeWay = await poThreeWay(db, await requestPoIds(db, r));
  const required = threeWayRequired(r, targets.some((t) => t.kind === 'receipt'));
  const noPoReceipts = targets.filter((t) => t.kind === 'receipt' && t.purchaseOrderNo === null).length;
  let stagePlan: StagePlan | null = null;
  if (r.contractId !== null) stagePlan = (await contractPlan(db, r.contractId, today)).stages.find((s) => s.stage === r.stage) ?? null;
  const balance = r.supplierId === null ? null : await supplierBalanceOf(db, r.supplierId);
  return {
    ...toSummary(r),
    departmentId: r.departmentId,
    earlyReason: r.earlyReason,
    returnedReason: r.returnedReason,
    closedReason: r.closedReason,
    closedByName: r.closedByName,
    closedAt: r.closedAt,
    submittedByName: r.submittedByName,
    version: r.version,
    contractTitle: r.contractTitle,
    contractCategory: r.contractCategory,
    targets,
    payments: await paymentsOf(db, requestId),
    approval: await approvalBrief(db, 'payment_request', requestId),
    stagePlan,
    threeWay,
    threeWayRequired: required,
    threeWayOk: !required || (threeWayProblems(threeWay).length === 0 && noPoReceipts === 0),
    supplierBalanceCents: balance?.balanceCents ?? null,
    supplierCreditCents: balance?.creditCents ?? null,
  };
}

export async function paymentRequestMeta(db: Db, today: string): Promise<PaymentRequestMeta> {
  const suppliers = await db<{ id: number; name: string }[]>`SELECT id, name FROM suppliers WHERE active ORDER BY code`;
  const contracts = await db<{ id: number; contractNo: string; title: string; counterparty: string; category: ContractCategory; supplierId: number | null }[]>`
    SELECT id, contract_no, title, counterparty, category, supplier_id FROM contracts
    WHERE status IN ('signed', 'archived', 'terminated') ORDER BY id DESC LIMIT 500`;
  const rules = await loadExpenseRules(db);
  return {
    today,
    suppliers: suppliers.map((s) => ({ ...s, id: Number(s.id) })),
    contracts: contracts.map((c) => ({ ...c, id: Number(c.id), supplierId: c.supplierId === null ? null : Number(c.supplierId) })),
    invoiceKinds: rules.invoiceTypes.filter((t) => t.needsNumber).map((t) => ({ key: t.key, label: t.label, taxRatesBp: t.taxRatesBp })),
  };
}

// ───────────────────────── 校验 ─────────────────────────

/** 这一段除去某张申请自己以后的已申请、还能申请、现在可付 */
function stageRoom(st: StagePlan, exclude: { amountCents: number; paidCents: number } | null) {
  const requested = Math.max(0, st.requestedCents - (exclude ? Math.max(0, exclude.amountCents - exclude.paidCents) : 0));
  return {
    requested,
    remaining: Math.max(0, st.plannedCents - requested - st.paidCents),
    available: Math.max(0, Math.min(st.payableCents, st.plannedCents) - requested - st.paidCents),
  };
}

interface ContractCheck {
  supplierId: number | null;
  payee: string;
  payMode: PayMode;
  departmentId: number | null;
  contractNo: string;
}

/**
 * 合同那一段能不能申请这个金额（调用前已锁住合同一行）：合同签署了、这一段有计划金额、不超过还能申请的；
 * 超过现在可付的要按提前付款申请（P6）；采购合同除预付段外要三单齐全（P8）
 */
/**
 * 验收不合格挂起付款（8.0.7 2.5，V9）：这份合同最近一条没作废的验收是「不合格」、开关开着时拒绝（ACCEPTANCE_HOLD）。
 * 只读验收登记（登记验收锁合同一行，这里不锁合同：与登记同时发生时以先提交的为准）。
 */
async function checkContractRequest(
  tx: Tx,
  today: string,
  input: { contractId: number; stage: PaymentStage; amountCents: number; early: boolean; earlyReason: string },
  exclude: { amountCents: number; paidCents: number } | null,
): Promise<ContractCheck> {
  if (!(await enabledErpModules(tx)).has('contracts')) throw erpModuleDisabled('contracts');
  const plan = await contractPlan(tx, input.contractId, today);
  if (plan.acceptanceHold) throw unprocessable('ACCEPTANCE_HOLD', `合同 ${plan.contractNo}：${plan.whyNot}`);
  if (!plan.canRequest) throw unprocessable('CONTRACT_NOT_PAYABLE', `合同 ${plan.contractNo}：${plan.whyNot}`);
  const st = plan.stages.find((s) => s.stage === input.stage)!;
  const label = PAYMENT_STAGE_LABELS[input.stage];
  if (st.plannedCents === 0) throw unprocessable('STAGE_NOT_APPLICABLE', `合同 ${plan.contractNo} 的${label}段比例为 0，不用付`);
  const room = stageRoom(st, exclude);
  if (input.amountCents > room.remaining) {
    throw unprocessable(
      'REQUEST_OVER_PLAN',
      `${label}段计划 ${yuan(st.plannedCents)}，已申请 ${yuan(room.requested)}、已付 ${yuan(st.paidCents)}，最多还能申请 ${yuan(room.remaining)}`,
      { remainingCents: room.remaining },
    );
  }
  if (input.amountCents > room.available && !input.early) {
    throw unprocessable(
      'EARLY_REQUIRED',
      `${label}段现在可付 ${yuan(room.available)}（${st.reason}），超出的部分要勾「提前付款」并写原因，多审一级`,
      { availableCents: room.available },
    );
  }
  if (input.early && input.earlyReason.trim().length < 2) throw badRequest('提前付款请写明原因（至少 2 个字）');
  if (plan.category === 'purchase' && input.stage !== 'prepay') {
    const problems = threeWayProblems(await poThreeWay(tx, await contractReceivedPoIds(tx, input.contractId)));
    if (problems.length) {
      throw unprocessable('THREE_WAY_NOT_MATCHED', `三单还没对上，先登记发票或请财务放行：${problems.join('；')}`, { problems });
    }
  }
  if (plan.payMode === 'ap' && plan.supplierId === null) throw unprocessable('CONTRACT_NO_SUPPLIER', `合同 ${plan.contractNo} 没有供应商档案，不能按供应商往来付款`);
  return { supplierId: plan.supplierId, payee: plan.payee, payMode: plan.payMode, departmentId: plan.departmentId, contractNo: plan.contractNo };
}

/**
 * 没挂合同的应付（调用前已锁住供应商一行）：选的收货单、期初未付属于这家、还没结清、不挂合同；
 * 金额不超过「没结清 − 别的没结束的申请占着的」；收货单的采购单三单齐全（P8）
 */
async function checkPayablesRequest(tx: Tx, supplierId: number, targets: TargetIn[], excludeRequestId: number | null): Promise<void> {
  const keys = new Set<string>();
  for (const t of targets) {
    const k = `${t.kind}:${t.targetId}`;
    if (keys.has(k)) throw badRequest('同一笔货款在一张申请里只能选一次');
    keys.add(k);
  }
  const items = await openItems(tx, supplierId);
  const receiptIds = targets.filter((t) => t.kind === 'receipt').map((t) => t.targetId);
  const underContract = receiptIds.length
    ? await tx<{ id: number; docNo: string; contractNo: string }[]>`
        SELECT d.id, d.doc_no, c.contract_no FROM inv_docs d JOIN purchase_orders po ON po.id = d.purchase_order_id JOIN contracts c ON c.id = po.contract_id
        WHERE d.id IN ${tx(receiptIds)}`
    : [];
  if (underContract[0]) {
    throw unprocessable('RECEIPT_UNDER_CONTRACT', `收货单 ${underContract[0].docNo} 挂在合同 ${underContract[0].contractNo} 下，请从合同的付款计划里按付款节点申请`);
  }
  // 别的没结束的申请占着的（审批中、退回待改、批了没付完的，减去已经付到那一笔上的）
  const reserved = await tx<{ receiptDocId: number | null; openingPayableId: number | null; cents: string }[]>`
    SELECT t.receipt_doc_id, t.opening_payable_id,
           sum(greatest(0, t.amount_cents - coalesce((SELECT sum(pa.amount_cents) FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
                 WHERE p.payment_request_id = t.request_id AND p.status = 'confirmed'
                   AND (pa.receipt_doc_id = t.receipt_doc_id OR pa.opening_payable_id = t.opening_payable_id)), 0)))::text AS cents
    FROM payment_request_targets t JOIN payment_requests r ON r.id = t.request_id
    WHERE r.supplier_id = ${supplierId} AND r.status IN ('submitted', 'returned', 'approved')
      ${excludeRequestId === null ? tx`` : tx`AND r.id <> ${excludeRequestId}`}
    GROUP BY t.receipt_doc_id, t.opening_payable_id`;
  for (const t of targets) {
    const item = items.find((i) => i.kind === t.kind && i.id === t.targetId);
    if (!item) throw unprocessable('ALLOCATION_TARGET_INVALID', '选的货款不属于这家供应商，或还没生效 / 已冲销 / 是现付的');
    const held = Number(
      reserved.find((x) => (t.kind === 'receipt' ? Number(x.receiptDocId) === t.targetId : Number(x.openingPayableId) === t.targetId))?.cents ?? 0,
    );
    const room = item.openCents - held;
    if (t.amountCents > room) {
      throw conflict(
        'OVER_REQUESTED',
        room <= 0
          ? `${item.docNo} 没有能申请的金额了（没结清 ${yuan(item.openCents)}，别的申请占着 ${yuan(held)}）`
          : `${item.docNo} 最多还能申请 ${yuan(room)}（没结清 ${yuan(item.openCents)}，别的申请占着 ${yuan(held)}）`,
        { docNo: item.docNo, roomCents: room },
      );
    }
  }
  if (receiptIds.length) {
    const docs = await tx<{ id: number; docNo: string; poId: number | null }[]>`
      SELECT id, doc_no, purchase_order_id AS po_id FROM inv_docs WHERE id IN ${tx(receiptIds)} ORDER BY id`;
    const noPo = docs.filter((d) => d.poId === null).map((d) => `${d.docNo}：急采还没补采购单`);
    const problems = [...noPo, ...threeWayProblems(await poThreeWay(tx, docs.filter((d) => d.poId !== null).map((d) => Number(d.poId))))];
    if (problems.length) throw unprocessable('THREE_WAY_NOT_MATCHED', `三单还没对上，先登记发票或请财务放行：${problems.join('；')}`, { problems });
  }
}

// ───────────────────────── 新建、改了再提交 ─────────────────────────

/** 发起付款申请（提交即走审批中心） */
export async function createPaymentRequest(deps: Deps, raw: unknown, actor: Actor, ip?: string): Promise<{ id: number; replayed: boolean }> {
  const input = parse(CreateInput, raw);
  const today = todayIn(deps.config.timezone);
  if (input.expectedDate < today) throw badRequest('期望付款日不能早于今天');
  if (input.source.kind === 'payables' && input.early) throw badRequest('没挂合同的应付不用按提前付款申请');
  const requestHash = hashRequest({ ...input, clientKey: undefined });
  const find = async (db: Db) => {
    const [row] = await db<{ id: number; requestHash: string }[]>`SELECT id, request_hash FROM payment_requests WHERE client_key = ${input.clientKey}`;
    if (!row) return null;
    if (row.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一张付款申请，请刷新页面后重新填写');
    return Number(row.id);
  };
  try {
    return await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      // 先取操作编号的咨询锁（与「确认作废」串行），确认这笔没有被作废
      await assertNotFenced(tx, input.clientKey, 'payment_request', erpOpAbandoned);
      const existing = await find(tx);
      if (existing) return { id: existing, replayed: true };
      let head: { supplierId: number | null; payee: string; payMode: PayMode; departmentId: number | null; contractId: number | null; stage: PaymentStage | null; amountCents: number; label: string };
      if (input.source.kind === 'contract') {
        const src = input.source;
        const [c] = await tx<{ id: number }[]>`SELECT id FROM contracts WHERE id = ${src.contractId} FOR NO KEY UPDATE`;
        if (!c) throw notFound('合同不存在');
        const chk = await checkContractRequest(tx, today, { ...src, early: input.early, earlyReason: input.earlyReason }, null);
        head = { ...chk, contractId: src.contractId, stage: src.stage, amountCents: src.amountCents, label: `${chk.contractNo} ${PAYMENT_STAGE_LABELS[src.stage]}` };
      } else {
        const src = input.source;
        const sup = await lockSupplier(tx, src.supplierId);
        await checkPayablesRequest(tx, src.supplierId, src.targets, null);
        head = { supplierId: src.supplierId, payee: sup.name, payMode: 'ap', departmentId: null, contractId: null, stage: null, amountCents: src.targets.reduce((s, t) => s + t.amountCents, 0), label: sup.name };
      }
      const requestNo = await nextDocNo(tx, 'payment_request', 'FS', today);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO payment_requests (request_no, supplier_id, payee, contract_id, stage, pay_mode, amount_cents, early, early_reason, expected_date, purpose,
                                      department_id, status, submitted_by, client_key, request_hash, created_by)
        VALUES (${requestNo}, ${head.supplierId}, ${head.payee.slice(0, 60)}, ${head.contractId}, ${head.stage}, ${head.payMode}, ${head.amountCents},
                ${input.early}, ${input.early ? input.earlyReason : ''}, ${input.expectedDate}, ${input.purpose}, ${head.departmentId}, 'submitted', ${actor.id},
                ${input.clientKey}, ${requestHash}, ${actor.id})
        RETURNING id`;
      const requestId = Number(row!.id);
      if (input.source.kind === 'payables') await insertTargets(tx, requestId, input.source.targets);
      const r = await submitForApproval(tx, 'payment_request', requestId, { actor, timeZone: deps.config.timezone }, { fallback: true });
      if (r.outcome === 'effective') await tx`UPDATE payment_requests SET status = 'approved', approved_at = now() WHERE id = ${requestId}`;
      await writeAudit(tx, { staffId: actor.id, action: 'payment_doc', targetType: 'payment_request', targetId: requestId, detail: { op: 'create', requestNo, for: head.label, amountCents: head.amountCents, early: input.early }, ip });
      return { id: requestId, replayed: false };
    });
  } catch (error) {
    if (isUniqueViolation(error, 'payment_requests_client_key_key')) {
      const existing = await find(deps.sql);
      if (existing) return { id: existing, replayed: true };
    }
    throw error;
  }
}

async function insertTargets(tx: Tx, requestId: number, targets: TargetIn[]) {
  for (const t of targets) {
    await tx`
      INSERT INTO payment_request_targets (request_id, receipt_doc_id, opening_payable_id, amount_cents)
      VALUES (${requestId}, ${t.kind === 'receipt' ? t.targetId : null}, ${t.kind === 'opening' ? t.targetId : null}, ${t.amountCents})`;
  }
}

interface LockedRequest {
  id: number;
  requestNo: string;
  status: PaymentRequestStatus;
  supplierId: number | null;
  contractId: number | null;
  stage: PaymentStage | null;
  payMode: PayMode;
  amountCents: number;
  paidCents: number;
  early: boolean;
  version: number;
  createdBy: number;
}

async function lockRequest(tx: Tx, requestId: number): Promise<LockedRequest> {
  const [r] = await tx<LockedRequest[]>`
    SELECT r.id, r.request_no, r.status, r.supplier_id, r.contract_id, r.stage, r.pay_mode, r.amount_cents, ${requestPaidSql(tx)} AS paid_cents, r.early, r.version, r.created_by
    FROM payment_requests r WHERE r.id = ${requestId} FOR UPDATE`;
  if (!r) throw notFound('付款申请不存在');
  return {
    ...r,
    id: Number(r.id),
    supplierId: r.supplierId === null ? null : Number(r.supplierId),
    contractId: r.contractId === null ? null : Number(r.contractId),
    amountCents: Number(r.amountCents),
    paidCents: Number(r.paidCents),
    createdBy: Number(r.createdBy),
  };
}

const assertVersion = (r: { version: number }, version: number) => {
  if (r.version !== version) throw conflict('VERSION_CONFLICT', '这张付款申请刚被别人改过，请刷新后再操作');
};
/** 经办（发起的人），或店主、店总 */
const mayHandle = (actor: Actor, r: { createdBy: number }) => r.createdBy === actor.id || actor.role === 'owner' || actor.role === 'store_manager';

/** 退回 / 撤回后改了再提交（按当时的规则从第一级重新走） */
export async function resubmitPaymentRequest(deps: Deps, requestId: number, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(ResubmitInput, raw);
  const today = todayIn(deps.config.timezone);
  if (input.expectedDate < today) throw badRequest('期望付款日不能早于今天');
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [head] = await tx<{ contractId: number | null; supplierId: number | null }[]>`SELECT contract_id, supplier_id FROM payment_requests WHERE id = ${requestId}`;
    if (!head) throw notFound('付款申请不存在');
    // 锁顺序与新建一样：合同（或供应商）→ 申请
    if (head.contractId !== null) await tx`SELECT id FROM contracts WHERE id = ${head.contractId} FOR NO KEY UPDATE`;
    else await lockSupplier(tx, Number(head.supplierId));
    const r = await lockRequest(tx, requestId);
    assertVersion(r, input.version);
    if (r.status !== 'returned') throw conflict('INVALID_STATE', '只有退回（或撤回）的付款申请可以改了再提交');
    if (!mayHandle(actor, r)) throw forbidden('只能改自己发起的付款申请');
    let amount = r.amountCents;
    if (r.contractId !== null) {
      if (input.targets) throw badRequest('合同的付款申请不选收货单');
      amount = input.amountCents ?? r.amountCents;
      await checkContractRequest(tx, today, { contractId: r.contractId, stage: r.stage!, amountCents: amount, early: input.early, earlyReason: input.earlyReason }, { amountCents: r.amountCents, paidCents: r.paidCents });
    } else {
      if (input.early) throw badRequest('没挂合同的应付不用按提前付款申请');
      if (input.targets) {
        await checkPayablesRequest(tx, r.supplierId!, input.targets, r.id);
        await tx`DELETE FROM payment_request_targets WHERE request_id = ${r.id}`;
        await insertTargets(tx, r.id, input.targets);
        amount = input.targets.reduce((s, t) => s + t.amountCents, 0);
      } else {
        const current = await tx<TargetIn[]>`
          SELECT CASE WHEN receipt_doc_id IS NOT NULL THEN 'receipt' ELSE 'opening' END AS kind, coalesce(receipt_doc_id, opening_payable_id) AS target_id, amount_cents
          FROM payment_request_targets WHERE request_id = ${r.id}`;
        await checkPayablesRequest(tx, r.supplierId!, current.map((t) => ({ ...t, targetId: Number(t.targetId), amountCents: Number(t.amountCents) })), r.id);
      }
    }
    await tx`
      UPDATE payment_requests SET amount_cents = ${amount}, early = ${r.contractId !== null && input.early}, early_reason = ${r.contractId !== null && input.early ? input.earlyReason : ''},
             expected_date = ${input.expectedDate}, purpose = ${input.purpose}, status = 'submitted', returned_reason = NULL, submitted_by = ${actor.id},
             submitted_at = now(), version = version + 1, updated_at = now()
      WHERE id = ${r.id}`;
    const s = await submitForApproval(tx, 'payment_request', r.id, { actor, timeZone: deps.config.timezone }, { fallback: true });
    if (s.outcome === 'effective') await tx`UPDATE payment_requests SET status = 'approved', approved_at = now() WHERE id = ${r.id}`;
    await writeAudit(tx, { staffId: actor.id, action: 'payment_doc', targetType: 'payment_request', targetId: r.id, detail: { op: 'resubmit', requestNo: r.requestNo, amountCents: amount }, ip });
  });
}

// ───────────────────────── 撤回、作废、结束 ─────────────────────────

const VersionReason = z.object({ version: z.number('缺少版本号，请刷新后重试').int().positive(), reason: Reason });

/** 撤回（审批中）：回到「已退回」，可以改了再提交或作废 */
export async function withdrawPaymentRequest(deps: Deps, requestId: number, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(VersionReason, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const r = await lockRequest(tx, requestId);
    if (r.status === 'returned') return;
    assertVersion(r, input.version);
    if (r.status !== 'submitted') throw conflict('INVALID_STATE', '只有审批中的付款申请可以撤回');
    if (!mayHandle(actor, r)) throw forbidden('只能撤回自己发起的付款申请');
    await tx`UPDATE payment_requests SET status = 'returned', returned_reason = ${`撤回：${input.reason}`.slice(0, 200)}, version = version + 1, updated_at = now() WHERE id = ${r.id}`;
    await closeApproval(tx, 'payment_request', r.id, actor);
    await writeAudit(tx, { staffId: actor.id, action: 'payment_doc', targetType: 'payment_request', targetId: r.id, detail: { op: 'withdraw', requestNo: r.requestNo, reason: input.reason }, ip });
  });
}

/** 作废（没付过钱的）：经办、店主店总或登记付款的人 */
export async function voidPaymentRequest(deps: Deps, requestId: number, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(VersionReason, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const r = await lockRequest(tx, requestId);
    if (r.status === 'voided') return;
    assertVersion(r, input.version);
    if (!['submitted', 'returned', 'approved'].includes(r.status)) throw conflict('INVALID_STATE', '已付清、已结束的付款申请不能作废');
    if (!mayHandle(actor, r) && !can(actor, 'payable.manage')) throw forbidden('只能作废自己发起的付款申请');
    const [any] = await tx<{ n: number }[]>`
      SELECT (SELECT count(*) FROM payments WHERE payment_request_id = ${r.id} AND status = 'confirmed')
           + (SELECT count(*) FROM contract_payouts WHERE payment_request_id = ${r.id} AND status = 'confirmed') AS n`;
    if (Number(any!.n) > 0) throw conflict('REQUEST_HAS_PAYMENTS', '这张申请已经登记过付款，不能作废；剩下的不付了请「结束」，付错了先冲销付款');
    await tx`UPDATE payment_requests SET status = 'voided', closed_reason = ${input.reason}, closed_by = ${actor.id}, closed_at = now(), version = version + 1, updated_at = now() WHERE id = ${r.id}`;
    await closeApproval(tx, 'payment_request', r.id, actor);
    await writeAudit(tx, { staffId: actor.id, action: 'payment_doc', targetType: 'payment_request', targetId: r.id, detail: { op: 'void', requestNo: r.requestNo, reason: input.reason }, ip });
  });
}

/** 结束（付了一部分、剩下的不付了）：登记付款的人 */
export async function endPaymentRequest(deps: Deps, requestId: number, raw: unknown, actor: Actor, ip?: string) {
  const input = parse(VersionReason, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const r = await lockRequest(tx, requestId);
    if (r.status === 'ended') return;
    assertVersion(r, input.version);
    if (r.status !== 'approved') throw conflict('INVALID_STATE', '只有待付款的付款申请可以结束');
    if (r.paidCents <= 0) throw conflict('REQUEST_NOT_PAID', '这张申请还没付过钱，不用的话请作废');
    await tx`UPDATE payment_requests SET status = 'ended', closed_reason = ${input.reason}, closed_by = ${actor.id}, closed_at = now(), version = version + 1, updated_at = now() WHERE id = ${r.id}`;
    await writeAudit(tx, { staffId: actor.id, action: 'payment_doc', targetType: 'payment_request', targetId: r.id, detail: { op: 'end', requestNo: r.requestNo, paidCents: r.paidCents, reason: input.reason }, ip });
  });
}

// ───────────────────────── 审批（审批中心与申请详情共用） ─────────────────────────

const ApprovalFence = z.object({ requestId: id.optional(), level: z.number().int().min(1).max(3).optional(), batch: z.boolean().optional() });
const ApproveInput = ApprovalFence.extend({ comment: z.string().trim().max(200, '意见最多 200 个字').default('') });
const ReturnInput = ApprovalFence.extend({ reason: Reason });

/** 同意、退回：最后一级同意后变「待付款」（申请一行 → 审批单一行） */
export async function actOnPaymentRequest(deps: Deps, requestId: number, action: 'approve' | 'return', raw: unknown, actor: Actor) {
  const ctx = { actor, timeZone: deps.config.timezone };
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const r = await lockRequest(tx, requestId);
    if (action === 'approve') {
      const input = parse(ApproveInput, raw ?? {});
      if (input.batch && r.early) throw conflict('APPROVAL_NO_BATCH', '提前付款要逐张审，不能批量同意');
      if (r.status === 'approved') return;
      if (r.status !== 'submitted') throw conflict('INVALID_STATE', '只有审批中的付款申请可以同意');
      const outcome = await approveCurrent(tx, 'payment_request', r.id, ctx, { requestId: input.requestId, level: input.level, comment: input.comment, batch: input.batch });
      if (outcome !== 'final') return;
      // 最后一级同意前再看一次这一段还剩多少（审批中合同变更、计划变小的，请退回让经办改金额；只读，不锁合同）
      if (r.contractId !== null) {
        const st = (await contractPlan(tx, r.contractId, todayIn(deps.config.timezone))).stages.find((s) => s.stage === r.stage)!;
        const room = stageRoom(st, { amountCents: r.amountCents, paidCents: r.paidCents });
        if (r.amountCents - r.paidCents > room.remaining) {
          throw conflict('REQUEST_OVER_PLAN', `${PAYMENT_STAGE_LABELS[r.stage!]}段现在最多还能申请 ${yuan(room.remaining)}（合同变更或别的申请占了额度），请退回让经办改金额`);
        }
      }
      await tx`UPDATE payment_requests SET status = 'approved', approved_at = now(), version = version + 1, updated_at = now() WHERE id = ${r.id}`;
      await writeAudit(tx, { staffId: actor.id, action: 'payment_doc', targetType: 'payment_request', targetId: r.id, detail: { op: 'approved', requestNo: r.requestNo, amountCents: r.amountCents } });
    } else {
      const input = parse(ReturnInput, raw ?? {});
      if (r.status === 'returned') return;
      if (r.status !== 'submitted') throw conflict('INVALID_STATE', '只有审批中的付款申请可以退回');
      await returnCurrent(tx, 'payment_request', r.id, ctx, { requestId: input.requestId, level: input.level, reason: input.reason });
      await tx`UPDATE payment_requests SET status = 'returned', returned_reason = ${input.reason}, version = version + 1, updated_at = now() WHERE id = ${r.id}`;
    }
  });
}

// ───────────────────────── 按申请登记付款 ─────────────────────────

const AllocationInput = z.object({ kind: z.enum(['receipt', 'opening']), targetId: id, amountCents: positiveCents('核销金额') });
const PayInput = z.object({
  clientKey: ClientKey,
  payDate: dateSchema('付款日'),
  amountCents: positiveCents('付款金额'),
  method: z.enum(PAYMENT_METHODS, '请选择付款方式'),
  evidence: z.string('请填写凭据说明').trim().min(2, '请填写凭据说明，例如转账流水号后四位').max(200),
  note: z.string().trim().max(200).default(''),
  allocations: z.array(AllocationInput).max(100).default([]),
  /** 核销合计小于付款金额时，其余记为预付款（只有合同的申请可以） */
  prepay: z.boolean().default(false),
});

/**
 * 按批过的申请登记供应商往来的付款（P7）：不再走付款的审批，登记即确认；金额不超过申请里还没付的部分。
 * 合同的申请核销到这份合同的采购单的收货单上，也可以记预付款；没挂合同的只核销到申请里选的那几笔。
 */
export async function payFromRequest(deps: Deps, requestId: number, raw: unknown, actor: Actor, ip?: string): Promise<{ paymentId: number; replayed: boolean }> {
  const input = parse(PayInput, raw);
  assertNotFuture(input.payDate, deps.config.timezone);
  const allocated = input.allocations.reduce((s, a) => s + a.amountCents, 0);
  if (allocated > input.amountCents) throw badRequest(`核销合计 ${yuan(allocated)} 超过付款金额 ${yuan(input.amountCents)}`);
  const requestHash = hashRequest({ ...input, clientKey: undefined, requestId });
  const findExisting = async (db: Db) => {
    const [row] = await db<{ opType: string; requestHash: string; refId: number }[]>`SELECT op_type, request_hash, ref_id FROM idempotency_keys WHERE key = ${input.clientKey}`;
    if (!row) return null;
    if (row.opType !== 'payment' || row.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一笔不同的付款，请刷新页面后重新填写');
    return Number(row.refId);
  };
  try {
    return await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await lockOpKey(tx, input.clientKey);
      const existing = await findExisting(tx);
      if (existing) return { paymentId: existing, replayed: true };
      await assertNotFenced(tx, input.clientKey, 'payment', erpOpAbandoned);
      const [head] = await tx<{ supplierId: number | null }[]>`SELECT supplier_id FROM payment_requests WHERE id = ${requestId}`;
      if (!head) throw notFound('付款申请不存在');
      if (head.supplierId === null) throw conflict('PAY_MODE_MISMATCH', '这张申请没有供应商档案，请登记合同付款');
      const supplierId = Number(head.supplierId);
      await lockSupplier(tx, supplierId);
      const r = await lockRequest(tx, requestId);
      if (r.payMode !== 'ap') throw conflict('PAY_MODE_MISMATCH', '服务、租赁、其他合同的申请请登记合同付款（不进供应商往来）');
      if (r.status !== 'approved') throw conflict('INVALID_STATE', r.status === 'paid' ? '这张申请已经付清了' : '只有批过（待付款）的申请可以登记付款');
      const left = r.amountCents - r.paidCents;
      if (input.amountCents > left) throw conflict('OVER_REQUEST', `申请 ${yuan(r.amountCents)}，已付 ${yuan(r.paidCents)}，这次最多付 ${yuan(left)}`, { leftCents: left });
      let note = input.note;
      if (r.contractId !== null) {
        await assertNoAcceptanceHold(tx, r.contractId);
        if (input.allocations.some((a) => a.kind !== 'receipt')) throw badRequest('合同的付款只能核销到这份合同的收货单上');
        const ids = input.allocations.map((a) => a.targetId);
        if (ids.length) {
          const ok = await tx<{ id: number }[]>`
            SELECT d.id FROM inv_docs d JOIN purchase_orders po ON po.id = d.purchase_order_id WHERE d.id IN ${tx(ids)} AND po.contract_id = ${r.contractId}`;
          if (ok.length !== new Set(ids).size) throw unprocessable('ALLOCATION_NOT_IN_CONTRACT', '核销的收货单要是这份合同的采购单收的货');
        }
        if (allocated < input.amountCents) {
          if (!input.prepay) throw badRequest('核销合计小于付款金额；其余要记为预付款请勾选「其余记为预付款」');
          if (note.length < 2) note = `付款申请 ${r.requestNo} 预付`;
        }
      } else {
        if (allocated !== input.amountCents) throw badRequest('没挂合同的付款要全部核销到申请里选的货款上');
        const targets = await targetsOf(tx, { id: r.id, supplierId });
        for (const a of input.allocations) {
          const t = targets.find((x) => x.kind === a.kind && x.targetId === a.targetId);
          if (!t) throw unprocessable('ALLOCATION_NOT_REQUESTED', '只能核销到申请里选的货款上');
          if (a.amountCents > t.amountCents - t.paidCents) throw conflict('OVER_REQUEST', `${t.docNo} 申请了 ${yuan(t.amountCents)}，已付 ${yuan(t.paidCents)}，这次最多 ${yuan(t.amountCents - t.paidCents)}`);
        }
      }
      await checkAllocations(tx, supplierId, input.allocations, null);
      const docNo = await nextDocNo(tx, 'payment', 'FK', input.payDate);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO payments (doc_no, supplier_id, pay_date, amount_cents, method, evidence, note, status, client_key, created_by, payment_request_id)
        VALUES (${docNo}, ${supplierId}, ${input.payDate}, ${input.amountCents}, ${input.method}, ${input.evidence}, ${note}, 'submitted', ${input.clientKey}, ${actor.id}, ${r.id})
        RETURNING id`;
      const paymentId = Number(row!.id);
      for (const a of input.allocations) {
        await tx`
          INSERT INTO payment_allocations (payment_id, receipt_doc_id, opening_payable_id, amount_cents)
          VALUES (${paymentId}, ${a.kind === 'receipt' ? a.targetId : null}, ${a.kind === 'opening' ? a.targetId : null}, ${a.amountCents})`;
      }
      await tx`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${input.clientKey}, 'payment', ${requestHash}, ${paymentId}, ${actor.id})`;
      await logApproval(tx, 'payment', paymentId, 'create', actor.id);
      // 申请已经批过：登记即确认（P7），记下按哪张申请
      await confirmPayment(tx, { id: paymentId, supplierId, amountCents: input.amountCents, payDate: input.payDate }, actor, `按付款申请 ${r.requestNo}（已审批）`);
      if (r.paidCents + input.amountCents === r.amountCents) await tx`UPDATE payment_requests SET status = 'paid', version = version + 1, updated_at = now() WHERE id = ${r.id}`;
      else await tx`UPDATE payment_requests SET version = version + 1, updated_at = now() WHERE id = ${r.id}`;
      await writeAudit(tx, { staffId: actor.id, action: 'payable_doc', targetType: 'payment', targetId: paymentId, detail: { docNo, amountCents: input.amountCents, paymentRequest: r.requestNo }, ip });
      return { paymentId, replayed: false };
    });
  } catch (error) {
    if (isUniqueViolation(error, 'idempotency_keys_pkey') || isUniqueViolation(error, 'payments_client_key_key')) {
      const existing = await findExisting(deps.sql);
      if (existing) return { paymentId: existing, replayed: true };
    }
    throw error;
  }
}

const PayoutInput = PayInput.omit({ allocations: true, prepay: true });

/** 服务、租赁、其他合同的申请：批了以后登记合同付款（不进供应商往来） */
export async function payoutFromRequest(deps: Deps, requestId: number, raw: unknown, actor: Actor, ip?: string): Promise<{ payoutId: number; replayed: boolean }> {
  const input = parse(PayoutInput, raw);
  assertNotFuture(input.payDate, deps.config.timezone);
  const requestHash = hashRequest({ ...input, clientKey: undefined, requestId });
  const find = async (db: Db) => {
    const [row] = await db<{ id: number; requestHash: string }[]>`SELECT id, request_hash FROM contract_payouts WHERE client_key = ${input.clientKey}`;
    if (!row) return null;
    if (row.requestHash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号已用于另一笔合同付款，请刷新页面后重新填写');
    return Number(row.id);
  };
  try {
    return await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await assertNotFenced(tx, input.clientKey, 'contract_payout', erpOpAbandoned);
      const existing = await find(tx);
      if (existing) return { payoutId: existing, replayed: true };
      const r = await lockRequest(tx, requestId);
      if (r.payMode !== 'direct') throw conflict('PAY_MODE_MISMATCH', '采购合同与没挂合同的申请请按供应商往来登记付款');
      if (r.status !== 'approved') throw conflict('INVALID_STATE', r.status === 'paid' ? '这张申请已经付清了' : '只有批过（待付款）的申请可以登记付款');
      if (r.contractId !== null) await assertNoAcceptanceHold(tx, r.contractId);
      const left = r.amountCents - r.paidCents;
      if (input.amountCents > left) throw conflict('OVER_REQUEST', `申请 ${yuan(r.amountCents)}，已付 ${yuan(r.paidCents)}，这次最多付 ${yuan(left)}`, { leftCents: left });
      const docNo = await nextDocNo(tx, 'contract_payout', 'HF', input.payDate);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO contract_payouts (doc_no, payment_request_id, pay_date, amount_cents, method, evidence, note, client_key, request_hash, created_by)
        VALUES (${docNo}, ${r.id}, ${input.payDate}, ${input.amountCents}, ${input.method}, ${input.evidence}, ${input.note}, ${input.clientKey}, ${requestHash}, ${actor.id})
        RETURNING id`;
      const payoutId = Number(row!.id);
      if (r.paidCents + input.amountCents === r.amountCents) await tx`UPDATE payment_requests SET status = 'paid', version = version + 1, updated_at = now() WHERE id = ${r.id}`;
      else await tx`UPDATE payment_requests SET version = version + 1, updated_at = now() WHERE id = ${r.id}`;
      await writeAudit(tx, { staffId: actor.id, action: 'payment_doc', targetType: 'contract_payout', targetId: payoutId, detail: { op: 'create', docNo, amountCents: input.amountCents, paymentRequest: r.requestNo }, ip });
      return { payoutId, replayed: false };
    });
  } catch (error) {
    if (isUniqueViolation(error, 'contract_payouts_client_key_key')) {
      const existing = await find(deps.sql);
      if (existing) return { payoutId: existing, replayed: true };
    }
    throw error;
  }
}

/** 冲销合同付款（#21：当月、对账付款或成本核算）：申请已付清的回到待付款 */
export async function voidPayout(deps: Deps, payoutId: number, raw: unknown, actor: Actor, ip?: string) {
  const { reason } = parse(z.object({ reason: Reason }), raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const [head] = await tx<{ requestId: number }[]>`SELECT payment_request_id AS request_id FROM contract_payouts WHERE id = ${payoutId}`;
    if (!head) throw notFound('合同付款不存在');
    // 锁顺序：申请 → 合同付款（与登记一样）
    await lockRequest(tx, Number(head.requestId));
    const [o] = await tx<{ status: string; payDate: string; docNo: string }[]>`SELECT status, pay_date, doc_no FROM contract_payouts WHERE id = ${payoutId} FOR UPDATE`;
    if (o!.status === 'voided') return;
    assertSameMonth(o!.payDate, deps.config.timezone, '合同付款');
    await tx`UPDATE contract_payouts SET status = 'voided', voided_by = ${actor.id}, voided_at = now(), void_reason = ${reason} WHERE id = ${payoutId}`;
    await reopenPaidRequest(tx, Number(head.requestId));
    await writeAudit(tx, { staffId: actor.id, action: 'payment_doc', targetType: 'contract_payout', targetId: payoutId, detail: { op: 'void', docNo: o!.docNo, reason }, ip });
  });
}

/** 合同付款按编号查回（「结果待确认」查到时跳到那张申请） */
export async function payoutRequestId(db: Db, payoutId: number): Promise<number | null> {
  const [r] = await db<{ requestId: number }[]>`SELECT payment_request_id AS request_id FROM contract_payouts WHERE id = ${payoutId}`;
  return r ? Number(r.requestId) : null;
}

