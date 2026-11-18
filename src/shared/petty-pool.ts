// 零采备用金（8.1.9，docs/ERP_V819.md 第 2 节，PENDING_DECISIONS「8.1.9」BJ1–BJ8）。
// 金额为整数「分」。总额是 ERP 设置里的一项；申用登记即占用，挂的报销单确认后不再占用（自动回补）。

/** 一笔申用现在的状态（从报销单推出来，不另存） */
export const POOL_USE_STATES = ['open', 'submitted', 'reviewing', 'reimbursed', 'voided'] as const;
export type PoolUseState = (typeof POOL_USE_STATES)[number];
export const POOL_USE_STATE_LABELS: Record<PoolUseState, string> = {
  open: '待报销',
  submitted: '已提交报销',
  reviewing: '报销审核中',
  reimbursed: '已报销',
  voided: '已作废',
};
/** 还占着额度的状态 */
export const POOL_OCCUPYING_STATES: readonly PoolUseState[] = ['open', 'submitted', 'reviewing'];

export const POOL_BACKFILLS = ['pending', 'done'] as const;
export type PoolBackfill = (typeof POOL_BACKFILLS)[number];
/** 补单：事后补的采购单（BJ5） */
export const POOL_BACKFILL_LABELS: Record<PoolBackfill, string> = { pending: '未补单', done: '已补单' };

export interface PoolSettings {
  /** 备用金总额（分）；没配置时为空，不能申用 */
  totalCents: number | null;
  /** 归属部门：财务登记这类报销时默认记到这个部门（预算按部门算） */
  departmentId: number | null;
}
export const DEFAULT_POOL_SETTINGS: PoolSettings = { totalCents: null, departmentId: null };

/** 报销单上列出的申用（简要） */
export interface PoolUseBrief {
  id: number;
  docNo: string;
  useDate: string;
  applicantName: string;
  content: string;
  amountCents: number;
  backfill: PoolBackfill | null;
  poNo: string | null;
}

/** 挂在申用上的报销单（最近一张有效的；撤回、冲销的在详情里） */
export interface PoolClaimRef {
  id: number;
  docNo: string;
  status: import('./expenses').ClaimStatus;
  amountCents: number;
  confirmedAt: string | null;
}

export interface PoolUseRow {
  id: number;
  docNo: string;
  useDate: string;
  applicant: { id: number; name: string };
  purpose: string;
  content: string;
  amountCents: number;
  note: string;
  state: PoolUseState;
  /** 补单：提交报销时必填，之后可以改；没填为空 */
  backfill: PoolBackfill | null;
  purchaseOrder: { id: number; docNo: string; supplierName: string } | null;
  submitNote: string;
  submittedAt: string | null;
  submittedByName: string | null;
  /** 现在挂着的有效报销单（待确认、退回、已确认） */
  claim: PoolClaimRef | null;
  voidReason: string | null;
  voidedAt: string | null;
  voidedByName: string | null;
  createdByName: string;
  createdAt: string;
  version: number;
  isSynthetic: boolean;
}

export interface PoolUseDetail extends PoolUseRow {
  /** 挂过的报销单（含撤回、冲销的），按登记顺序 */
  claims: PoolClaimRef[];
}

export interface PoolSummary {
  totalCents: number | null;
  /** 已占用 = 待报销 + 已提交 + 审核中 */
  occupiedCents: number;
  /** 剩余可用 = 总额 − 已占用；没配置总额时为空，总额改小以后可能是负的 */
  remainingCents: number | null;
  /** 待报销笔数（还占着额度的） */
  pendingCount: number;
  byState: Record<'open' | 'submitted' | 'reviewing', { count: number; cents: number }>;
  /** 本月报销完成（自动回补）的笔数与金额 */
  reimbursedThisMonth: { count: number; cents: number };
}

export interface PoolBoard {
  settings: PoolSettings;
  departmentName: string | null;
  summary: PoolSummary;
  uses: PoolUseRow[];
  /** 列表没显示全（合计仍按全部算） */
  truncated: boolean;
}

/** 提交报销时可以选的采购单 */
export interface PoolPoOption {
  id: number;
  docNo: string;
  supplierName: string;
  orderDate: string;
  totalCents: number;
  status: string;
  /** 补单（按收货单补的采购单） */
  backfill: boolean;
}

/** 财务登记报销时可以勾的申用（供应链已提交报销、还没挂有效报销单的） */
export interface PoolUseForClaim extends PoolUseBrief {
  applicantId: number;
  purpose: string;
  purchaseOrderId: number | null;
  submitNote: string;
}

export interface PoolUsesForClaim {
  /** 设置里的归属部门：登记这类报销时默认记到这个部门 */
  departmentId: number | null;
  uses: PoolUseForClaim[];
}
