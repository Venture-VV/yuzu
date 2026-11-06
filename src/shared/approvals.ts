// 审批中心（v0.7.30，docs/APPROVALS.md；默认 A1–A10 待确认）：审批规则、审批单、审批记录、代理人。
// 要审批的单据（采购单、物资单据、付款、期初未付、报销）提交时按规则生成审批单，逐级同意、任何一级可退回；
// 没有规则命中按现在的「负责人确认」开关与门槛（默认规则：一级负责人），没建规则时与 v0.7.29 一样。
// v0.7.31 合同与法务审查（docs/CONTRACTS.md）：加三种单据（合同、合同变更、用印）与岗位组「法务」；
// 合同、合同变更没有规则命中时走 财务 → 法务 → 负责人，用印走一级店主（C2、C7，待确认）。

import type { ChangeKind, ReviewView } from './contracts';
import { can, type Duty, type Permission, type Role } from './permissions';

/** 规则里的单据类型 */
export const APPROVAL_DOC_TYPES = ['purchase_order', 'damage', 'supplier_return', 'opening', 'payment', 'expense_claim', 'stocktake', 'contract', 'contract_change', 'contract_seal'] as const;
export type ApprovalDocType = (typeof APPROVAL_DOC_TYPES)[number];
export const APPROVAL_DOC_TYPE_LABELS: Record<ApprovalDocType, string> = {
  purchase_order: '采购单',
  damage: '报损',
  supplier_return: '退供应商',
  opening: '期初',
  payment: '付款',
  expense_claim: '报销',
  stocktake: '盘点差异',
  contract: '合同',
  contract_change: '合同变更',
  contract_seal: '用印',
};
/** 合同类的单据（法务那一级按审查清单逐条给意见；规则必须有且只有一级「法务」） */
export const CONTRACT_REVIEW_DOC_TYPES: readonly ApprovalDocType[] = ['contract', 'contract_change'];
/** 不能批量同意的单据：合同类（法务那一级要逐条给意见）、用印 */
export const NO_BATCH_DOC_TYPES: readonly ApprovalDocType[] = ['contract', 'contract_change', 'contract_seal'];

/** 审批单挂在哪张表的单据上 */
export const APPROVAL_DOC_KINDS = ['purchase_order', 'inv_doc', 'payment', 'opening_payable', 'expense_claim', 'contract', 'contract_change', 'contract_seal'] as const;
export type ApprovalDocKind = (typeof APPROVAL_DOC_KINDS)[number];

/** 岗位组（A2）：店主算在每一组里 */
export const APPROVAL_GROUPS = ['manager', 'finance', 'store_manager', 'owner', 'legal'] as const;
export type ApprovalGroup = (typeof APPROVAL_GROUPS)[number];
export const APPROVAL_GROUP_LABELS: Record<ApprovalGroup, string> = {
  manager: '负责人',
  finance: '财务',
  store_manager: '店总',
  owner: '店主',
  legal: '法务',
};
export const APPROVAL_GROUP_HINTS: Record<ApprovalGroup, string> = {
  manager: '有「负责人确认」职责的（报销是能确认报销的）',
  finance: '对账付款、成本核算',
  store_manager: '店总岗位',
  owner: '只有店主',
  legal: '有「法务」职责的（只用于合同、合同变更，按审查清单逐条给意见）',
};
/** 合同、合同变更没有规则命中时的审查链（C2）：财务 → 法务 → 负责人 */
export const CONTRACT_DEFAULT_STEPS: ApprovalStep[] = [
  { group: 'finance', mode: 'any' },
  { group: 'legal', mode: 'any' },
  { group: 'manager', mode: 'any' },
];
/** 用印没有规则命中时（C7）：一级店主 */
export const SEAL_DEFAULT_STEPS: ApprovalStep[] = [{ group: 'owner', mode: 'any' }];
/** 这一级是不是法务那一级（合同类的单据在这一级按审查清单逐条给意见） */
export const isLegalStep = (step: ApprovalStep | undefined): boolean => !!step && 'group' in step && step.group === 'legal';

export type ApprovalMode = 'any' | 'all';
export const APPROVAL_MODE_LABELS: Record<ApprovalMode, string> = { any: '或签', all: '会签' };

/** 审批链的一级：一个岗位组（只能或签），或一到五个指定的人（或签 / 会签） */
export type ApprovalStep = { group: ApprovalGroup; mode: 'any' } | { staffIds: number[]; mode: ApprovalMode };

export const APPROVAL_MAX_LEVELS = 3;
export const APPROVAL_MAX_STAFF = 5;
/** 批量同意（A5）：同一种单据、每张不超过 ¥5,000，一次最多 50 张 */
export const APPROVAL_BATCH_MAX_CENTS = 500_000;
export const APPROVAL_BATCH_MAX = 50;
/** 超时（A6）：当前这一级等了超过 24 小时 */
export const APPROVAL_OVERDUE_HOURS = 24;
/** 代理人（A7）：起止日期最多 31 天（含首尾） */
export const DELEGATION_MAX_DAYS = 31;
/** 急采待补单升级（A10）：生效后超过 3 天没补采购单的进负责人待办 */
export const URGENT_BACKFILL_ESCALATE_DAYS = 3;

export type ApprovalStatus = 'pending' | 'approved' | 'returned' | 'cancelled';
export const APPROVAL_STATUS_LABELS: Record<ApprovalStatus, string> = {
  pending: '审批中',
  approved: '已通过',
  returned: '已退回',
  cancelled: '已撤回',
};

/** 每一级显示成一句话：负责人（或签）、张三、李四（会签） */
export function stepLabel(step: ApprovalStep, names: Map<number, string> | Record<number, string> = {}): string {
  if ('group' in step) return APPROVAL_GROUP_LABELS[step.group];
  const nameOf = (id: number) => (names instanceof Map ? names.get(id) : names[id]) ?? `#${id}`;
  const who = step.staffIds.map(nameOf).join('、');
  return step.staffIds.length > 1 ? `${who}（${APPROVAL_MODE_LABELS[step.mode]}）` : who;
}

/** 判断一个人在不在某一级的审批人里用到的资料（会话、员工档案都能给） */
export interface ApproverSubject {
  id: number;
  role: Role;
  duties: readonly Duty[];
  permissions?: readonly Permission[];
}

/** 岗位组的「负责人」：采购单、物资单据、付款、期初未付、合同类按「负责人确认」，报销按「确认超门槛的报销」 */
export function managerPermission(kind: ApprovalDocKind): Permission {
  return kind === 'expense_claim' ? 'expense.approve' : 'inventory.approve';
}

/** 这个人是不是这一级的审批人（不看「提交人不能审自己的单」与会签已经同意过的） */
export function inStep(step: ApprovalStep, who: ApproverSubject, kind: ApprovalDocKind): boolean {
  // 店主在每一级都能审（指定的人那一级也可以：有人离职、停用时单据不会卡住）
  if (who.role === 'owner') return true;
  if ('staffIds' in step) return step.staffIds.includes(who.id);
  switch (step.group) {
    case 'manager':
      return can(who, managerPermission(kind));
    case 'finance':
      return who.duties.includes('payable') || who.duties.includes('cost');
    case 'store_manager':
      return who.role === 'store_manager';
    case 'owner':
      return false;
    case 'legal':
      return who.duties.includes('legal');
  }
}

/** 审批单在单据详情里的一句话（单据的读接口带上，不分看的人） */
export interface ApprovalBrief {
  requestId: number;
  status: ApprovalStatus;
  /** 默认规则（没有规则命中）为空 */
  ruleId: number | null;
  currentLevel: number;
  levels: number;
  steps: ApprovalStep[];
  stepLabels: string[];
  allowSelf: boolean;
  submittedBy: number;
  levelStartedAt: string;
  overdue: boolean;
  /** 会签时这一级已经同意的人 */
  approvedIds: number[];
  actions: ApprovalActionView[];
}

export interface ApprovalActionView {
  id: number;
  level: number;
  action: 'approve' | 'return';
  actorId: number;
  actorName: string;
  /** 代理人替谁审的（记「某某（代 某某）」） */
  onBehalfOf: number | null;
  onBehalfOfName: string | null;
  comment: string;
  batch: boolean;
  createdAt: string;
}

/** 审批中心的卡片 */
export interface ApprovalCard {
  id: number;
  docKind: ApprovalDocKind;
  docId: number;
  docType: ApprovalDocType;
  docNo: string;
  /** 算不出的（例如没有参考价的期初）为空 */
  amountCents: number | null;
  departmentName: string | null;
  /** 一句话摘要：供应商、物料 */
  summary: string;
  status: ApprovalStatus;
  ruleId: number | null;
  ruleNote: string | null;
  currentLevel: number;
  levels: number;
  currentStepLabel: string;
  submittedById: number;
  submittedByName: string;
  submittedAt: string;
  levelStartedAt: string;
  finishedAt: string | null;
  overdue: boolean;
  /** 我现在能不能审；能审时是不是替别人审（代理） */
  canAct: boolean;
  actingFor: string[];
  /** 这一级目前没人能审（提交人不能审自己的单、指定的人都停用了……），要店主处理 */
  stuck: boolean;
  /** 上一级的意见（最近一条同意或退回） */
  lastAction: ApprovalActionView | null;
}

/** 审批单详情：审批链每一级的结果、意见与单据要点 */
export interface ApprovalDetail extends ApprovalCard {
  allowSelf: boolean;
  levelsDetail: {
    level: number;
    label: string;
    mode: ApprovalMode;
    state: 'done' | 'current' | 'waiting' | 'returned';
    /** 会签时这一级还要谁同意 */
    waitingFor: string[];
    actions: ApprovalActionView[];
    /** 法务这一级（v0.7.31，合同、合同变更）：同意时按审查清单逐条给结论 */
    legal: boolean;
  }[];
  /** 单据要点 */
  doc: ApprovalDocDigest;
  /** 同一张单据以前几轮（退回后再提交）的审批单 */
  previous: { id: number; status: ApprovalStatus; submittedAt: string; finishedAt: string | null; lastComment: string | null }[];
}

export interface ApprovalDocDigest {
  title: string;
  /** 打开原单据的页面地址（ERP 里有权限的人才打得开） */
  link: string;
  party: string | null;
  docDate: string | null;
  note: string;
  facts: { label: string; value: string }[];
  lines: {
    id: number;
    name: string;
    spec: string;
    qty: string;
    unit: string;
    priceCents: number | null;
    amountCents: number | null;
    /** 盘点：账面、实盘、差异、比例、原因 */
    count?: {
      bookMilli: number;
      countedMilli: number;
      diffMilli: number;
      pct: number | null;
      big: boolean;
      reason: string | null;
      reasonNote: string;
    };
  }[];
  /** 合同类单据（v0.7.31）：合同号、这张审批单对着的提交记录与上面已有的审查清单结论；变更单另有改前改后 */
  contract?: {
    kind: 'contract' | 'contract_change' | 'contract_seal';
    contractId: number;
    contractNo: string;
    /** 合同、变更单这次提交的提交记录（用印没有） */
    revisionId: number | null;
    reviews: ReviewView[];
    change?: { kinds: ChangeKind[]; reason: string; baseVersion: number; beforeTotalCents: number; afterTotalCents: number };
  };
}

export interface ApprovalCounts {
  /** 待我审批 */
  mine: number;
  /** 其中超时的 */
  overdue: number;
  /** 急采待补单（超过 3 天，负责人看） */
  backfill: number;
  /** 急采待验收（部门登记、等仓库到部门验收；负责人看，自己登记的不算，店主除外） */
  accept: number;
}

export interface ApprovalRuleView {
  id: number;
  docType: ApprovalDocType;
  minCents: number;
  maxCents: number | null;
  departmentId: number | null;
  departmentName: string | null;
  steps: ApprovalStep[];
  stepLabels: string[];
  allowSelf: boolean;
  note: string;
  active: boolean;
  version: number;
  createdByName: string;
  createdAt: string;
  updatedByName: string | null;
  updatedAt: string;
}

export interface DelegationView {
  id: number;
  staffId: number;
  staffName: string;
  delegateId: number;
  delegateName: string;
  startsOn: string;
  endsOn: string;
  reason: string;
  createdByName: string;
  createdAt: string;
  revokedByName: string | null;
  revokedAt: string | null;
  /** 今天在不在代理期内（没收回） */
  active: boolean;
}

/** 规则编辑器、代理人选择用的员工（在用、有审批中心的权限） */
export interface ApproverOption {
  id: number;
  name: string;
  role: Role;
  groups: ApprovalGroup[];
}

/** 急采待补单（A10）：生效后超过 3 天没补采购单 */
export interface UrgentBackfillItem {
  receiptId: number;
  docNo: string;
  departmentName: string | null;
  supplierName: string | null;
  amountCents: number;
  confirmedAt: string;
  daysOver: number;
  handlerName: string;
}

/** 急采待验收（不走审批中心：仓库或负责人到部门验收后生效） */
export interface UrgentAcceptItem {
  docId: number;
  docNo: string;
  departmentName: string | null;
  supplierName: string | null;
  amountCents: number | null;
  createdAt: string;
  handlerName: string;
}

export interface BatchApproveResult {
  results: { id: number; ok: boolean; docNo: string; message?: string; code?: string }[];
}
