// 采购单、供应商货款与付款：前后端共用的类型与中文名称。金额为分，数量为 milli。

import type { ApprovalLog, DocRef, Ref } from './inventory';

export const PO_STATUSES = ['draft', 'submitted', 'returned', 'approved', 'cancelled', 'closed'] as const;
export type PoStatus = (typeof PO_STATUSES)[number];

export const PO_STATUS_LABELS: Record<PoStatus, string> = {
  draft: '草稿',
  submitted: '待确认',
  returned: '已退回修改',
  approved: '已确认',
  cancelled: '已撤回',
  closed: '已关闭',
};

/** 到货进度（按合格实收计算，拒收与未到不算） */
export type ReceivingState = 'none' | 'partial' | 'full';
export const RECEIVING_LABELS: Record<ReceivingState, string> = { none: '未到货', partial: '部分到货', full: '已到齐' };

/** 与最近一次同口径成交价的比较 */
export interface PriceCompare {
  /** 比较对象：同物料（即同规格）、同采购单位与换算、同价格口径的最近一次已生效收货 */
  baseline: { priceCents: number; docId: number; docNo: string; docDate: string; supplierName: string } | null;
  /** 变化百分比（两位小数）；没有可比历史时为 null，不计算 */
  changePercent: number | null;
}

export interface PoLine {
  id: number;
  lineNo: number;
  materialId: number;
  materialCode: string;
  materialName: string;
  specification: string;
  decimals: number;
  purchaseQtyMilli: number;
  purchaseUnit: string;
  inventoryUnit: string;
  factorMilli: number;
  baseQtyMilli: number;
  priceCents: number;
  amountCents: number;
  note: string;
  /** 规格（v0.7.8） */
  spec: string;
  /** 来自哪几行需求（v0.7.8，转采购单时带上；同一物料的几行需求可以合并成一行） */
  requests: PoLineRequest[];
  /** 图片（v0.7.8） */
  images: import('./requests').ImageRef[];
  /** 已合格实收（库存单位） */
  receivedMilli: number;
  compare: PriceCompare;
}

/** 采购单行对应的需求行（v0.7.8） */
export interface PoLineRequest {
  lineId: number;
  requestId: number;
  requestNo: string;
  departmentName: string;
  name: string;
  qtyMilli: number;
  unit: string;
}

export interface PoRevision {
  revision: number;
  changedByName: string;
  changedAt: string;
  snapshot: { supplierName: string; totalCents: number; lines: { materialName: string; spec?: string; purchaseQtyMilli: number; purchaseUnit: string; priceCents: number; amountCents: number; imageIds?: number[] }[] };
}

export interface PurchaseOrder {
  id: number;
  docNo: string;
  status: PoStatus;
  supplier: Ref;
  orderDate: string;
  expectedDate: string | null;
  note: string;
  priceBasis: string;
  revision: number;
  backfill: boolean;
  backfillReceipt: DocRef | null;
  createdBy: number;
  createdByName: string;
  createdAt: string;
  approvedByName: string | null;
  approvedAt: string | null;
  returnedReason: string | null;
  closedByName: string | null;
  closedAt: string | null;
  closeReason: string | null;
  isSynthetic: boolean;
  lines: PoLine[];
  receiving: ReceivingState;
  /** 下单金额（采购承诺） */
  totalCents: number;
  /** 已确认收货金额 */
  receivedCents: number;
  /** 关联收货的退货扣款 */
  returnCreditCents: number;
  /** 已登记付款（核销到本单收货的已确认付款） */
  paidCents: number;
  /** 本单未付 = 已确认收货 − 退货扣款 − 已付 */
  unpaidCents: number;
  receipts: (DocRef & { docDate: string; amountCents: number })[];
  revisions: PoRevision[];
  approvals: ApprovalLog[];
}

export interface PoSummary {
  id: number;
  docNo: string;
  status: PoStatus;
  supplierName: string;
  supplierId: number;
  orderDate: string;
  expectedDate: string | null;
  totalCents: number;
  receivedCents: number;
  revision: number;
  backfill: boolean;
  lineCount: number;
  summary: string;
  receiving: ReceivingState;
  createdByName: string;
  createdAt: string;
}

// ───────────────────────── 货款与付款 ─────────────────────────

export const PAYMENT_METHODS = ['bank_transfer', 'wechat', 'alipay', 'cash', 'other'] as const;
export type PayMethod = (typeof PAYMENT_METHODS)[number];
export const PAY_METHOD_LABELS: Record<PayMethod, string> = {
  bank_transfer: '银行转账',
  wechat: '微信',
  alipay: '支付宝',
  cash: '现金',
  other: '其他',
};

export type PayableStatus = 'submitted' | 'returned' | 'confirmed' | 'cancelled' | 'voided';
export const PAYABLE_STATUS_LABELS: Record<PayableStatus, string> = {
  submitted: '待确认',
  returned: '已退回修改',
  confirmed: '已确认',
  cancelled: '已撤回',
  voided: '已冲销',
};

/** 一笔可以付款核销的货款：已生效收货单或已确认的期初未付 */
export interface OpenItem {
  kind: 'receipt' | 'opening';
  id: number;
  docNo: string;
  date: string;
  /** 货款（收货确认金额 / 期初未付金额） */
  amountCents: number;
  /** 关联退货扣款 */
  creditCents: number;
  /** 已确认付款核销 */
  paidCents: number;
  /** 待确认付款占用（防止两笔付款同时核销同一货款） */
  pendingCents: number;
  /** 还可以核销的金额 = 货款 − 扣款 − 已付 − 待确认占用；可能为负（已付后退货，供应商待退 / 可抵） */
  openCents: number;
  purchaseOrderNo: string | null;
  summary: string;
}

export interface PaymentAllocation {
  id: number;
  kind: 'receipt' | 'opening';
  targetId: number;
  docNo: string;
  amountCents: number;
}

export interface PaymentDoc {
  id: number;
  docNo: string;
  status: PayableStatus;
  supplier: Ref;
  payDate: string;
  amountCents: number;
  method: PayMethod;
  evidence: string;
  note: string;
  createdBy: number;
  createdByName: string;
  createdAt: string;
  confirmedByName: string | null;
  confirmedAt: string | null;
  returnedReason: string | null;
  voidedByName: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  isSynthetic: boolean;
  allocations: PaymentAllocation[];
  approvals: ApprovalLog[];
}

export interface OpeningPayableDoc {
  id: number;
  docNo: string;
  status: PayableStatus;
  supplier: Ref;
  asOfDate: string;
  amountCents: number;
  note: string;
  createdBy: number;
  createdByName: string;
  createdAt: string;
  confirmedByName: string | null;
  confirmedAt: string | null;
  returnedReason: string | null;
  voidedByName: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  isSynthetic: boolean;
  /** 已核销金额（已确认付款） */
  paidCents: number;
  approvals: ApprovalLog[];
}

/** 供应商余额：期初未付 + 已确认收货货款 − 已确认退货扣款 − 净付款 */
export interface SupplierBalance {
  supplierId: number;
  code: string;
  name: string;
  active: boolean;
  openingCents: number;
  receivedCents: number;
  returnCreditCents: number;
  paidCents: number;
  balanceCents: number;
  /** 待确认的付款（不计入余额） */
  pendingPaymentCents: number;
  /** 未结清货款张数 */
  openItemCount: number;
  lastActivity: string | null;
}

export type ApEntryKind = 'opening' | 'receipt' | 'supplier_return' | 'payment';

export interface StatementRow {
  id: number;
  date: string;
  kind: ApEntryKind;
  /** 冲销行：原单类型同上，isVoid 为 true */
  isVoid: boolean;
  docKind: 'inv_doc' | 'payment' | 'opening_payable';
  docId: number;
  docNo: string;
  amountDeltaCents: number;
  balanceCents: number;
  note: string;
  operatorName: string;
}

export interface Statement {
  supplier: Ref & { code: string };
  from: string;
  to: string;
  priceBasis: string;
  /** 期间开始前的结余 */
  beginCents: number;
  /** 本期净额（冲销已并入对应类别） */
  openingCents: number;
  receivedCents: number;
  returnCreditCents: number;
  paidCents: number;
  endCents: number;
  rows: StatementRow[];
  openItems: OpenItem[];
}

export interface PayablesOverview {
  totals: { openingCents: number; receivedCents: number; returnCreditCents: number; paidCents: number; balanceCents: number };
  suppliers: SupplierBalance[];
  pending: { payments: number; openings: number; purchaseOrders: number };
}
