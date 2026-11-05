// 合同与法务审查（v0.7.31，docs/CONTRACTS.md；默认 C1–C12 待确认）：合同台账与四要素、审查（走审批中心，法务按审查清单逐条给意见）、
// 签署、用印、归档、变更单、到期提醒；采购单挂合同时按单价表核对。金额一律整数分，比例存万分比（30% = 3000）。

import type { ApprovalBrief } from './approvals';

export const CONTRACT_CATEGORIES = ['purchase', 'service', 'lease', 'other'] as const;
export type ContractCategory = (typeof CONTRACT_CATEGORIES)[number];
export const CONTRACT_CATEGORY_LABELS: Record<ContractCategory, string> = { purchase: '采购', service: '服务', lease: '租赁', other: '其他' };

export const CONTRACT_STATUSES = ['draft', 'reviewing', 'returned', 'approved', 'signed', 'archived', 'terminated', 'voided'] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];
export const CONTRACT_STATUS_LABELS: Record<ContractStatus, string> = {
  draft: '起草中',
  reviewing: '审查中',
  returned: '已退回',
  approved: '审批通过（待签署）',
  signed: '已签署',
  archived: '已归档',
  terminated: '已终止',
  voided: '已作废',
};
/** 生效中的（采购单能挂、到期要提醒、可以开变更单） */
export const CONTRACT_EFFECTIVE: readonly ContractStatus[] = ['signed', 'archived'];
/** 还能改内容的（审批通过以后改走变更单） */
export const CONTRACT_EDITABLE: readonly ContractStatus[] = ['draft', 'returned'];

/** 运费、卸货谁承担 */
export const BEARERS = ['supplier', 'us', 'na'] as const;
export type Bearer = (typeof BEARERS)[number];
export const BEARER_LABELS: Record<Bearer, string> = { supplier: '供方', us: '我方', na: '不涉及' };

/** 付款节点四段（C5），固定顺序 */
export const PAYMENT_STAGES = ['prepay', 'delivery', 'acceptance', 'warranty'] as const;
export type PaymentStage = (typeof PAYMENT_STAGES)[number];
export const PAYMENT_STAGE_LABELS: Record<PaymentStage, string> = { prepay: '预付', delivery: '到货', acceptance: '验收', warranty: '质保' };
export interface PaymentTerm {
  stage: PaymentStage;
  /** 比例（万分比） */
  percentBp: number;
  /** 触发条件（一句话） */
  condition: string;
}
/** 付款节点模板（C5，待确认）：预付 30%、到货 0%、验收 60%、质保 10% */
export const DEFAULT_PAYMENT_TERMS: PaymentTerm[] = [
  { stage: 'prepay', percentBp: 3000, condition: '合同签订后 7 天内' },
  { stage: 'delivery', percentBp: 0, condition: '到货并收货登记后' },
  { stage: 'acceptance', percentBp: 6000, condition: '验收合格、收到发票后 30 天内' },
  { stage: 'warranty', percentBp: 1000, condition: '质保期满、没有质量问题' },
];

/** 质保起算依据（C6） */
export const WARRANTY_BASES = ['acceptance', 'delivery', 'signing'] as const;
export type WarrantyBasis = (typeof WARRANTY_BASES)[number];
export const WARRANTY_BASIS_LABELS: Record<WarrantyBasis, string> = { acceptance: '验收合格日', delivery: '到货日', signing: '签订日' };
export interface Warranty {
  basis: WarrantyBasis;
  /** 期限（月，0 = 没有质保） */
  months: number;
}
export const DEFAULT_WARRANTY: Warranty = { basis: 'acceptance', months: 12 };

export interface Acceptance {
  /** 按什么验 */
  method: string;
  /** 谁签字 */
  signer: string;
  /** 不合格怎么扣 */
  penalty: string;
}

/** 单价表的一行 */
export interface ContractLineInput {
  /** 物料档案里的物料（服务类写名称、可空） */
  materialId: number | null;
  itemName: string;
  spec: string;
  unit: string;
  /** 含税单价（每个单位，分） */
  priceCents: number;
  /** 税率（万分比） */
  taxRateBp: number;
  /** 合同数量（千分之一单位；空 = 不限量） */
  qtyMilli: number | null;
}

/** 合同内容（起草、变更单里编辑的部分；提交时存进提交记录，单价表另存一张表） */
export interface ContractContent {
  title: string;
  startDate: string | null;
  endDate: string | null;
  totalCents: number;
  /** 主要税率（万分比） */
  taxRateBp: number;
  freightBearer: Bearer;
  unloadingBearer: Bearer;
  paymentTerms: PaymentTerm[];
  /** 质保金比例 = 付款节点里「质保」那一段的比例 */
  warranty: Warranty;
  acceptance: Acceptance;
  note: string;
  lines: ContractLineInput[];
}

export const CONTRACT_MAX_LINES = 50;

/** 法务审查清单（C3，待确认） */
export const LEGAL_CHECKLIST = [
  { key: 'parties', label: '主体资质', hint: '相对方的营业执照、资质、授权签字人' },
  { key: 'subject', label: '标的与规格', hint: '品名、规格、数量、质量标准写清楚' },
  { key: 'price', label: '价格与税', hint: '含税单价、税率、发票类型、运费卸货' },
  { key: 'payment', label: '付款', hint: '付款节点、比例、条件、账户' },
  { key: 'delivery', label: '交付验收', hint: '交付时间地点、验收标准、谁签字' },
  { key: 'warranty', label: '质保售后', hint: '质保比例、起算、期限、售后响应' },
  { key: 'liability', label: '违约责任', hint: '逾期、质量不合格的违约金与扣款' },
  { key: 'dispute', label: '争议解决', hint: '管辖法院或仲裁、适用法律' },
  { key: 'confidentiality', label: '保密', hint: '价格与经营信息的保密义务' },
  { key: 'term', label: '期限与续签', hint: '起止日、自动续签、提前解除' },
] as const;
export type LegalItemKey = (typeof LEGAL_CHECKLIST)[number]['key'];
export const LEGAL_ITEM_KEYS = LEGAL_CHECKLIST.map((i) => i.key) as LegalItemKey[];

export const REVIEW_VERDICTS = ['pass', 'revise', 'risk'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];
export const REVIEW_VERDICT_LABELS: Record<ReviewVerdict, string> = { pass: '通过', revise: '要修改', risk: '风险提示' };

export interface ReviewItem {
  key: LegalItemKey;
  verdict: ReviewVerdict;
  note: string;
}

/** 印章种类（C7） */
export const SEAL_TYPES = ['company', 'contract', 'finance', 'legal_rep'] as const;
export type SealType = (typeof SEAL_TYPES)[number];
export const SEAL_TYPE_LABELS: Record<SealType, string> = { company: '公章', contract: '合同专用章', finance: '财务专用章', legal_rep: '法人章' };

export type SealStatus = 'reviewing' | 'returned' | 'approved' | 'withdrawn';
export const SEAL_STATUS_LABELS: Record<SealStatus, string> = { reviewing: '审批中', returned: '已退回', approved: '已生效', withdrawn: '已撤回' };

/** 变更类型（C10） */
export const CHANGE_KINDS = ['price', 'quantity', 'extension', 'other'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];
export const CHANGE_KIND_LABELS: Record<ChangeKind, string> = { price: '改价', quantity: '改量', extension: '延期', other: '其他' };

export type ChangeStatus = 'draft' | 'reviewing' | 'returned' | 'approved' | 'voided';
export const CHANGE_STATUS_LABELS: Record<ChangeStatus, string> = { draft: '起草中', reviewing: '审查中', returned: '已退回', approved: '已生效', voided: '已作废' };

/** 到期提醒（C11）：结束日前 60 天进待办 */
export const CONTRACT_EXPIRY_REMIND_DAYS = 60;

// ───────────────────────── 读接口返回的样子 ─────────────────────────

export interface ContractSummary {
  id: number;
  contractNo: string;
  category: ContractCategory;
  title: string;
  counterparty: string;
  supplierId: number | null;
  departmentName: string | null;
  handlerName: string;
  status: ContractStatus;
  startDate: string | null;
  endDate: string | null;
  totalCents: number;
  currentVersion: number;
  /** 已签署、已归档的：今天距结束日还有几天（过了是负数；结束日为空为 null） */
  daysLeft: number | null;
  /** 有没有续签的新合同（没作废的） */
  renewal: { id: number; contractNo: string; status: ContractStatus } | null;
  /** 在审的变更单 */
  openChangeNo: string | null;
  updatedAt: string;
}

export interface ContractLineView extends ContractLineInput {
  lineNo: number;
  materialName: string | null;
}

export interface ReviewView {
  id: number;
  level: number;
  action: 'approve' | 'return';
  items: ReviewItem[];
  reviewerName: string;
  onBehalfOfName: string | null;
  createdAt: string;
}

/** 一次提交（合同本身或变更单）：当时的内容、单价表、审批进度、法务清单的结论 */
export interface RevisionView {
  id: number;
  seq: number;
  changeId: number | null;
  changeNo: string | null;
  /** 审批通过成了第几版（没通过为空） */
  versionNo: number | null;
  content: Omit<ContractContent, 'lines'>;
  lines: ContractLineView[];
  submittedByName: string;
  submittedAt: string;
  approval: ApprovalBrief | null;
  reviews: ReviewView[];
}

export interface SealView {
  id: number;
  sealNo: string;
  sealType: SealType;
  copies: number;
  operatorId: number;
  operatorName: string;
  sealDate: string;
  purpose: string;
  status: SealStatus;
  version: number;
  createdByName: string;
  createdAt: string;
  approval: ApprovalBrief | null;
}

export interface ChangeView {
  id: number;
  changeNo: string;
  baseVersion: number;
  kinds: ChangeKind[];
  reason: string;
  draft: ContractContent;
  totalCents: number;
  deltaCents: number;
  status: ChangeStatus;
  version: number;
  resultVersion: number | null;
  closedReason: string | null;
  createdByName: string;
  createdAt: string;
  approval: ApprovalBrief | null;
}

export interface ContractFileView {
  id: number;
  imageId: number;
  url: string;
  sortNo: number;
  addedByName: string;
  addedAt: string;
}

/** 挂这份合同的采购单 */
export interface ContractPoView {
  id: number;
  docNo: string;
  status: string;
  totalCents: number;
  contractNote: string;
  createdAt: string;
}

export interface ContractDetail extends ContractSummary {
  supplierName: string | null;
  departmentId: number | null;
  handlerId: number;
  renewalOf: { id: number; contractNo: string } | null;
  /** 起草中、已退回时编辑的内容；之后是生效那一版的内容（含单价表） */
  content: ContractContent;
  version: number;
  signedOn: string | null;
  ourSignatory: string | null;
  theirSignatory: string | null;
  signedByName: string | null;
  archiveNo: string | null;
  archiveLocation: string | null;
  archivedAt: string | null;
  closedReason: string | null;
  closedOn: string | null;
  closedByName: string | null;
  createdByName: string;
  createdAt: string;
  /** 审查中的那张审批单（合同本身的） */
  approval: ApprovalBrief | null;
  revisions: RevisionView[];
  seals: SealView[];
  changes: ChangeView[];
  files: ContractFileView[];
  purchaseOrders: ContractPoView[];
}

/** 到期提醒（C11） */
export interface ContractExpiryItem {
  id: number;
  contractNo: string;
  title: string;
  counterparty: string;
  endDate: string;
  daysLeft: number;
  handlerName: string;
  /** 续签的新合同（没作废的） */
  renewal: { id: number; contractNo: string; status: ContractStatus } | null;
}

/** 采购单选合同用：同一供应商、采购类型、生效中、今天在起止日内 */
export interface ContractOption {
  id: number;
  contractNo: string;
  title: string;
  endDate: string | null;
  lines: ContractLineView[];
  /** 每行已经下单的数量（同一物料、同一单位；挂这份合同、没撤回的采购单） */
  orderedMilli: Record<number, number>;
}

/** 采购单的一行与合同核对的结果（C9） */
export interface ContractLineCheck {
  lineNo: number;
  materialId: number;
  /** 合同里没有这一项、单位不同 */
  notInContract: boolean;
  unitMismatch: boolean;
  contractPriceCents: number | null;
  priceOverCents: number;
  /** 合同剩余量（不限量为空）、这一行超出的数量 */
  remainingMilli: number | null;
  overQtyMilli: number;
}

export interface ContractCheckResult {
  contractId: number;
  contractNo: string;
  lines: ContractLineCheck[];
  /** 有超价或超量的行 */
  exceeded: boolean;
}

/** 合同内容里的质保金比例（付款节点「质保」段） */
export function warrantyPercentBp(content: Pick<ContractContent, 'paymentTerms'>): number {
  return content.paymentTerms.find((t) => t.stage === 'warranty')?.percentBp ?? 0;
}

/** 比例（万分比）显示成百分数：3000 → 30%，1250 → 12.5% */
export function formatPercentBp(bp: number): string {
  const s = (bp / 100).toFixed(2).replace(/\.?0+$/, '');
  return `${s}%`;
}

/** 新合同的空白内容（四要素按模板预填，C5、C6） */
export function blankContent(): ContractContent {
  return {
    title: '',
    startDate: null,
    endDate: null,
    totalCents: 0,
    taxRateBp: 1300,
    freightBearer: 'supplier',
    unloadingBearer: 'supplier',
    paymentTerms: DEFAULT_PAYMENT_TERMS.map((t) => ({ ...t })),
    warranty: { ...DEFAULT_WARRANTY },
    acceptance: { method: '', signer: '', penalty: '' },
    note: '',
    lines: [],
  };
}
