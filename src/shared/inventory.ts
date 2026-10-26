// 库存与采购：前后端共用的类型与中文名称。数量为 milli（千分之一库存单位），金额为分。

import type { PriceCompare } from './purchasing';

export const INV_DOC_TYPES = ['opening', 'receipt', 'issue', 'issue_return', 'direct_use', 'damage', 'count', 'supplier_return'] as const;
export type InvDocType = (typeof INV_DOC_TYPES)[number];

export const INV_DOC_META: Record<InvDocType, { title: string; prefix: string; verb: string; direction: 'in' | 'out' | 'both' }> = {
  opening: { title: '期初库存', prefix: 'QC', verb: '建立期初', direction: 'in' },
  receipt: { title: '收货入库', prefix: 'RK', verb: '收货', direction: 'in' },
  issue: { title: '部门领用', prefix: 'LY', verb: '领用', direction: 'out' },
  issue_return: { title: '领用退回', prefix: 'LT', verb: '退回', direction: 'in' },
  direct_use: { title: '直接耗用', prefix: 'HY', verb: '耗用', direction: 'out' },
  damage: { title: '报损', prefix: 'BS', verb: '报损', direction: 'out' },
  count: { title: '盘点', prefix: 'PD', verb: '盘点', direction: 'both' },
  supplier_return: { title: '退供应商', prefix: 'TG', verb: '退货', direction: 'out' },
};

export const INV_DOC_STATUSES = ['draft', 'submitted', 'returned', 'confirmed', 'cancelled', 'voided'] as const;
export type InvDocStatus = (typeof INV_DOC_STATUSES)[number];

export const INV_STATUS_LABELS: Record<InvDocStatus, string> = {
  draft: '草稿',
  submitted: '待确认',
  returned: '已退回修改',
  confirmed: '已生效',
  cancelled: '已撤回',
  voided: '已冲销',
};

export const MOVE_TYPES = ['opening', 'receipt', 'issue', 'issue_return', 'direct_use', 'damage', 'count_adjust', 'supplier_return', 'void'] as const;
export type MoveType = (typeof MOVE_TYPES)[number];

export const MOVE_TYPE_LABELS: Record<MoveType, string> = {
  opening: '期初',
  receipt: '收货入库',
  issue: '部门领用',
  issue_return: '领用退回',
  direct_use: '直接耗用',
  damage: '报损',
  count_adjust: '盘点调整',
  supplier_return: '退供应商',
  void: '冲销',
};

/** 盘点差异原因：确认前一律为「待核差异」，不自动认定为浪费或失窃 */
export const COUNT_REASONS = ['unrecorded', 'measurement', 'damaged', 'unknown'] as const;
export type CountReason = (typeof COUNT_REASONS)[number];
export const COUNT_REASON_LABELS: Record<CountReason | 'pending', string> = {
  pending: '待核差异',
  unrecorded: '漏记',
  measurement: '计量错误',
  damaged: '损坏',
  unknown: '不明差异',
};

/** 需要负责人确认的单据（模拟规则，待店主确认）。盘点调整固定需要确认。 */
export interface ApprovalRules {
  purchase_order: boolean;
  damage: boolean;
  supplier_return: boolean;
  payment: boolean;
  opening: boolean;
}

export const APPROVAL_RULE_LABELS: Record<keyof ApprovalRules, string> = {
  purchase_order: '采购单',
  damage: '报损',
  supplier_return: '退供应商',
  payment: '付款登记',
  opening: '期初库存与期初未付',
};

export interface InventorySettings {
  scopeName: string;
  priceBasis: string;
  allowDirectReceipt: boolean;
  approvalRules: ApprovalRules;
}

export interface Department {
  id: number;
  name: string;
  active: boolean;
  sortOrder: number;
}

export interface Supplier {
  id: number;
  code: string;
  name: string;
  contact: string;
  phone: string;
  note: string;
  active: boolean;
  isSynthetic: boolean;
}

export interface Material {
  id: number;
  code: string;
  name: string;
  category: string;
  specification: string;
  inventoryUnit: string;
  decimals: number;
  purchaseUnit: string;
  purchaseFactorMilli: number;
  refPriceCents: number | null;
  defaultSupplierId: number | null;
  defaultSupplierName: string | null;
  lowStockMilli: number | null;
  tracked: boolean;
  active: boolean;
  stockMilli: number;
  /** 低于人工设定阈值 */
  isLow: boolean;
  /** 已有库存流水（期初只能在没有流水时建立） */
  hasMoves: boolean;
  lastMoveAt: string | null;
  note: string;
  isSynthetic: boolean;
}

export interface Ref {
  id: number;
  name: string;
}

export interface DocRef {
  id: number;
  docNo: string;
  docType: InvDocType;
  status: InvDocStatus;
}

export interface InvDocLine {
  id: number;
  lineNo: number;
  materialId: number;
  materialCode: string;
  materialName: string;
  specification: string;
  decimals: number;
  qtyMilli: number;
  inventoryUnit: string;
  purchaseUnit: string;
  factorMilli: number;
  enteredQtyMilli: number | null;
  enteredUnit: string | null;
  deliveredMilli: number | null;
  rejectedMilli: number | null;
  rejectReason: string;
  priceCents: number | null;
  amountCents: number | null;
  poLineId: number | null;
  bookMilli: number | null;
  countedMilli: number | null;
  diffReason: CountReason | 'pending' | null;
  /** 盘点：记录账面数之后该物料又有收发，需要重新核对 */
  stale: boolean;
  sourceLineId: number | null;
  /** 领用 / 收货行已被退回或退货的数量（已生效 + 待确认） */
  returnedMilli: number;
  /** 当前库存（详情展示用） */
  stockMilli: number;
  note: string;
  /** 收货行：与此前同口径成交价的比较 */
  compare?: PriceCompare;
}

export interface ApprovalLog {
  id: number;
  action: 'create' | 'submit' | 'approve' | 'return' | 'cancel' | 'void' | 'close' | 'revise';
  actorName: string;
  reason: string;
  revision: number | null;
  createdAt: string;
}

export interface InvDoc {
  id: number;
  docNo: string;
  docType: InvDocType;
  status: InvDocStatus;
  docDate: string;
  supplier: Ref | null;
  purchaseOrder: { id: number; docNo: string } | null;
  department: Ref | null;
  handler: string;
  sourceDoc: DocRef | null;
  note: string;
  amountCents: number;
  noPo: boolean;
  createdBy: number;
  createdByName: string;
  createdAt: string;
  submittedByName: string | null;
  submittedAt: string | null;
  confirmedByName: string | null;
  confirmedAt: string | null;
  returnedReason: string | null;
  voidedByName: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  isSynthetic: boolean;
  lines: InvDocLine[];
  /** 由本单派生的退回、退货单 */
  children: DocRef[];
  approvals: ApprovalLog[];
  /** 是否允许冲销及原因 */
  voidable: { ok: boolean; reason: string | null };
}

export interface InvDocSummary {
  id: number;
  docNo: string;
  docType: InvDocType;
  status: InvDocStatus;
  docDate: string;
  partyName: string | null;
  lineCount: number;
  summary: string;
  amountCents: number;
  noPo: boolean;
  createdByName: string;
  createdAt: string;
}

export interface StockMoveRow {
  id: number;
  moveType: MoveType;
  qtyDeltaMilli: number;
  qtyAfterMilli: number;
  docDate: string;
  createdAt: string;
  docId: number;
  docNo: string;
  docType: InvDocType;
  partyName: string | null;
  operatorName: string;
  note: string;
}

/** 期间收发汇总；出库类为正数，盘点调整与冲销带正负号。begin + 各项 = closing */
export interface StockSummaryRow {
  materialId: number;
  code: string;
  name: string;
  specification: string;
  inventoryUnit: string;
  active: boolean;
  /** 期间开始前的结存 */
  begin: number;
  /** 本期期初建账 */
  opening: number;
  received: number;
  issued: number;
  issueReturned: number;
  directUsed: number;
  damaged: number;
  countAdjusted: number;
  supplierReturned: number;
  voided: number;
  closing: number;
}

export interface InventoryOverview {
  scopeName: string;
  materialCount: number;
  lowCount: number;
  pendingCounts: number;
  pendingApprovals: number;
  todayIn: number;
  todayOut: number;
}

export interface CheckItem {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}
