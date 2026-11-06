// 付款流（v0.7.32，docs/PAYMENTS.md；默认 P1–P12 待确认）：合同的付款计划（按生效的那一版现算）、验收与质量问题登记、
// 付款申请（走审批中心：「付款申请」「提前付款」）、按申请登记付款、三单匹配（发票、按采购单比对、放行）、质保金台账、本周应付。
// 金额一律整数分。

import type { ApprovalBrief } from './approvals';
import type { ContractCategory, ContractStatus, PaymentStage, WarrantyBasis } from './contracts';
import type { PayMethod } from './purchasing';

export const PAYMENT_REQUEST_STATUSES = ['submitted', 'returned', 'approved', 'paid', 'ended', 'voided'] as const;
export type PaymentRequestStatus = (typeof PAYMENT_REQUEST_STATUSES)[number];
export const PAYMENT_REQUEST_STATUS_LABELS: Record<PaymentRequestStatus, string> = {
  submitted: '审批中',
  returned: '已退回',
  approved: '待付款',
  paid: '已付清',
  ended: '已结束',
  voided: '已作废',
};
/** 还算「已申请」的（占着这一段的额度）：审批中、退回待改、批了没付完的 */
export const REQUEST_OPEN_STATUSES: readonly PaymentRequestStatus[] = ['submitted', 'returned', 'approved'];

/** ap：付款登记（进供应商往来）；direct：服务、租赁、其他合同没有收货单、不记应付，在申请上登记合同付款 */
export type PayMode = 'ap' | 'direct';
export const PAY_MODE_LABELS: Record<PayMode, string> = { ap: '供应商往来付款', direct: '合同付款（不进供应商往来）' };

/** P5：付款申请没有规则命中时，申请金额 ≥ ¥50,000 的再加一级店主 */
export const PAYMENT_OWNER_LEVEL_CENTS = 5_000_000;
/** P8：三单门槛——差额 ≤ 已收货金额的 1% 并且 ≤ ¥50 */
export const THREE_WAY_TOLERANCE_PERCENT = 1;
export const THREE_WAY_TOLERANCE_CENTS = 5_000;
/** P9：质保金到期前 30 天进待办 */
export const WARRANTY_REMIND_DAYS = 30;
/** P11：本周应付看四周 */
export const WEEKLY_PAYABLE_WEEKS = 4;

/** 差额在门槛内（P8）：|a − b| ≤ base 的 1% 并且 ≤ ¥50 */
export function withinTolerance(a: number, b: number, base: number): boolean {
  const diff = Math.abs(a - b);
  return diff * 100 <= Math.abs(base) * THREE_WAY_TOLERANCE_PERCENT && diff <= THREE_WAY_TOLERANCE_CENTS;
}

/**
 * 每一段的计划金额（P1）：合同总价 × 这一段的比例，按分取整；最后一个比例不为 0 的那一段补齐差额，四段合计等于总价。
 * 比例加起来不是 100% 的（不该有，提交时就核对过）按各自的比例算、不补齐。
 */
export function stageAmounts(totalCents: number, terms: { stage: PaymentStage; percentBp: number }[]): Record<PaymentStage, number> {
  const out: Record<PaymentStage, number> = { prepay: 0, delivery: 0, acceptance: 0, warranty: 0 };
  const sumBp = terms.reduce((s, t) => s + t.percentBp, 0);
  let lastIdx = -1;
  terms.forEach((t, i) => {
    if (t.percentBp > 0) lastIdx = i;
  });
  let used = 0;
  terms.forEach((t, i) => {
    if (t.percentBp <= 0) return;
    if (i === lastIdx && sumBp === 10000) out[t.stage] += totalCents - used;
    else {
      const amt = Math.round((totalCents * t.percentBp) / 10000);
      out[t.stage] += amt;
      used += amt;
    }
  });
  return out;
}

/** 日期加几个月（月底对齐：1 月 31 日加 1 个月是 2 月最后一天）；YYYY-MM-DD */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

// ───────────────────────── 验收与质量问题 ─────────────────────────

export type AcceptanceResult = 'pass' | 'fail';
export const ACCEPTANCE_RESULT_LABELS: Record<AcceptanceResult, string> = { pass: '合格', fail: '不合格' };

export interface AcceptanceView {
  id: number;
  acceptedOn: string;
  result: AcceptanceResult;
  signer: string;
  note: string;
  createdByName: string;
  createdAt: string;
  voidedAt: string | null;
  voidedByName: string | null;
  voidReason: string | null;
}

export type QualityStatus = 'open' | 'resolved' | 'voided';
export const QUALITY_STATUS_LABELS: Record<QualityStatus, string> = { open: '未处理', resolved: '已处理', voided: '已作废' };

export interface QualityIssueView {
  id: number;
  foundOn: string;
  description: string;
  status: QualityStatus;
  resolvedOn: string | null;
  resolution: string | null;
  resolvedByName: string | null;
  voidReason: string | null;
  voidedByName: string | null;
  createdByName: string;
  createdAt: string;
}

// ───────────────────────── 付款计划 ─────────────────────────

/** 付款计划里列出的一张申请 */
export interface PlanRequestBrief {
  id: number;
  requestNo: string;
  status: PaymentRequestStatus;
  amountCents: number;
  paidCents: number;
  early: boolean;
  expectedDate: string;
}

export interface StagePlan {
  stage: PaymentStage;
  percentBp: number;
  condition: string;
  /** 计划金额（P1） */
  plannedCents: number;
  /** 现在按条件放开的（P2） */
  payableCents: number;
  /** 已申请：审批中、退回待改、批了没付完的部分 */
  requestedCents: number;
  paidCents: number;
  /** 现在还能照常申请的：可付 − 已申请 − 已付（不小于 0） */
  availableCents: number;
  /** 还能申请的上限：计划 − 已申请 − 已付（不小于 0）；超过可付的部分要按提前付款申请 */
  remainingCents: number;
  /** 变更后计划变小、已付超过计划的（P4，只显示） */
  overpaidCents: number;
  /** 为什么现在能付 / 还不能付 */
  reason: string;
  /** 付清或申请「结束」了（P12） */
  done: boolean;
  requests: PlanRequestBrief[];
}

export interface WarrantyState {
  basis: WarrantyBasis;
  months: number;
  /** 起算日（还没验收的为空：未起算） */
  startDate: string | null;
  /** 起算依据没取到时的说明（例如服务合同没有收货单，按验收合格日） */
  startNote: string;
  dueDate: string | null;
  /** 距到期还有几天（过了是负数） */
  daysLeft: number | null;
  openIssues: number;
}

export interface ContractPaymentPlan {
  contractId: number;
  contractNo: string;
  title: string;
  category: ContractCategory;
  status: ContractStatus;
  totalCents: number;
  currentVersion: number;
  payMode: PayMode;
  supplierId: number | null;
  payee: string;
  departmentId: number | null;
  /** 能不能在这份合同上发起付款申请；不能的写原因 */
  canRequest: boolean;
  whyNot: string | null;
  /** 采购合同：已生效的收货金额（减去生效的退货）、最后一次到货日 */
  receivedCents: number | null;
  lastDeliveryDate: string | null;
  /** 最近一条没作废的验收登记 */
  latestAcceptance: AcceptanceView | null;
  warranty: WarrantyState;
  stages: StagePlan[];
  plannedCents: number;
  requestedCents: number;
  paidCents: number;
  /** 结项（P12）：四段都付清或结束 */
  settled: boolean;
  /** 不带申请、核销到这份合同收货单上的付款（v0.7.32 以前登记的，不算在各段里） */
  legacyPaidCents: number;
  acceptances: AcceptanceView[];
  qualityIssues: QualityIssueView[];
}

// ───────────────────────── 付款申请 ─────────────────────────

export interface PaymentRequestSummary {
  id: number;
  requestNo: string;
  status: PaymentRequestStatus;
  supplierId: number | null;
  supplierName: string | null;
  payee: string;
  contractId: number | null;
  contractNo: string | null;
  stage: PaymentStage | null;
  payMode: PayMode;
  amountCents: number;
  paidCents: number;
  early: boolean;
  expectedDate: string;
  purpose: string;
  departmentName: string | null;
  createdById: number;
  createdByName: string;
  createdAt: string;
  submittedAt: string;
  approvedAt: string | null;
}

export type ThreeWayStatus = 'matched' | 'released' | 'held' | 'incomplete';
export const THREE_WAY_STATUS_LABELS: Record<ThreeWayStatus, string> = {
  matched: '对得上',
  released: '已放行',
  held: '挂起',
  incomplete: '不齐',
};

/** 一张采购单的三单比对（P8） */
export interface ThreeWayRow {
  poId: number;
  poNo: string;
  supplierId: number;
  supplierName: string;
  contractNo: string | null;
  poTotalCents: number;
  /** 已生效的收货减去生效的退货 */
  receivedCents: number;
  /** 分到这张采购单、没作废的发票 */
  invoicedCents: number;
  status: ThreeWayStatus;
  /** 为什么挂起 / 不齐 */
  reason: string;
  /** 最近一次放行（三个金额都没变才算有效） */
  release: { reason: string; byName: string; at: string; poTotalCents: number; receivedCents: number; invoicedCents: number } | null;
  releaseStale: boolean;
}

export interface PaymentRequestTarget {
  kind: 'receipt' | 'opening';
  targetId: number;
  docNo: string;
  date: string;
  amountCents: number;
  /** 这张申请已经付到这一笔上的 */
  paidCents: number;
  /** 这一笔现在还没结清的（与付款登记的核销同一口径） */
  openCents: number;
  purchaseOrderNo: string | null;
}

/** 按申请登记的付款（供应商往来的付款，或合同付款） */
export interface RequestPaymentView {
  kind: 'payment' | 'payout';
  id: number;
  docNo: string;
  payDate: string;
  amountCents: number;
  method: PayMethod;
  evidence: string;
  note: string;
  status: 'confirmed' | 'voided';
  createdByName: string;
  createdAt: string;
  voidReason: string | null;
  /** 供应商往来付款：核销到哪几笔、记为预付款的部分 */
  allocations: { kind: 'receipt' | 'opening'; docNo: string; amountCents: number }[];
  prepaidCents: number;
}

export interface PaymentRequestDetail extends PaymentRequestSummary {
  departmentId: number | null;
  earlyReason: string;
  returnedReason: string | null;
  closedReason: string | null;
  closedByName: string | null;
  closedAt: string | null;
  submittedByName: string;
  version: number;
  contractTitle: string | null;
  contractCategory: ContractCategory | null;
  targets: PaymentRequestTarget[];
  payments: RequestPaymentView[];
  approval: ApprovalBrief | null;
  /** 合同那一段现在的情况（合同申请） */
  stagePlan: StagePlan | null;
  /** 涉及的采购单的三单比对（合同的收货、选的收货单） */
  threeWay: ThreeWayRow[];
  /** 三单是否要求、现在满不满足（P8） */
  threeWayRequired: boolean;
  threeWayOk: boolean;
  /** 供应商往来余额（有供应商的） */
  supplierBalanceCents: number | null;
  supplierCreditCents: number | null;
}

/** 新建付款申请页用：可以选的供应商、合同（生效中的）、默认期望付款日 */
export interface PaymentRequestMeta {
  today: string;
  suppliers: { id: number; name: string }[];
  contracts: { id: number; contractNo: string; title: string; counterparty: string; category: ContractCategory; supplierId: number | null }[];
}

// ───────────────────────── 发票 ─────────────────────────

export interface SupplierInvoiceView {
  id: number;
  invoiceNo: string;
  supplierId: number;
  supplierName: string;
  invoiceDate: string;
  totalCents: number;
  taxCents: number;
  taxRateBp: number;
  note: string;
  status: 'valid' | 'voided';
  lines: { poId: number; poNo: string; amountCents: number }[];
  createdByName: string;
  createdAt: string;
  voidedByName: string | null;
  voidedAt: string | null;
  voidReason: string | null;
}

// ───────────────────────── 质保金台账、本周应付、待办 ─────────────────────────

export type WarrantyRowStatus = 'not_started' | 'running' | 'due_soon' | 'payable' | 'held' | 'paid';
export const WARRANTY_ROW_STATUS_LABELS: Record<WarrantyRowStatus, string> = {
  not_started: '未起算',
  running: '未到期',
  due_soon: '30 天内到期',
  payable: '可付',
  held: '有质量问题挂起',
  paid: '已付清',
};

export interface WarrantyRow {
  contractId: number;
  contractNo: string;
  title: string;
  counterparty: string;
  status: ContractStatus;
  plannedCents: number;
  requestedCents: number;
  paidCents: number;
  basis: WarrantyBasis;
  months: number;
  startDate: string | null;
  dueDate: string | null;
  daysLeft: number | null;
  openIssues: number;
  rowStatus: WarrantyRowStatus;
  /** 合同结项了没有（P12） */
  settled: boolean;
}

export type WeeklyItemKind = 'approved' | 'available' | 'warranty';
export const WEEKLY_ITEM_LABELS: Record<WeeklyItemKind, string> = {
  approved: '已批待付',
  available: '可付未申请',
  warranty: '到期的质保金',
};

export interface WeeklyItem {
  kind: WeeklyItemKind;
  /** 期望付款日 / 质保到期日（可付未申请的是今天） */
  date: string;
  amountCents: number;
  payee: string;
  requestId: number | null;
  requestNo: string | null;
  contractId: number | null;
  contractNo: string | null;
  stage: PaymentStage | null;
  note: string;
}

export interface WeeklyPayables {
  today: string;
  /** 本周一 */
  from: string;
  weeks: { start: string; end: string; items: WeeklyItem[]; totalCents: number }[];
  totalCents: number;
  /** 期望付款日在四周以后的已批待付（不算进四周） */
  laterCents: number;
  /** 没挂合同、也没提申请的应付余额（没有付款日期，只作参考） */
  otherApCents: number;
}

export interface PaymentTodo {
  /** 批了待付款的申请（登记付款的人看） */
  awaitingPayment: number;
  /** 到期前 30 天（含已到期没付的）的质保金（P9） */
  warrantyDue: number;
  /** 每周一（门店时区）的本周应付（P11）；其余日子为空 */
  weekly: { totalCents: number; count: number } | null;
}
