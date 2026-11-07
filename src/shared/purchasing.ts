// 采购单、供应商货款与付款：前后端共用的类型与中文名称。金额为分，数量为 milli。

import type { ApprovalBrief } from './approvals';
import type { ContractCheckResult } from './contracts';
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
  /** 已合格实收（库存单位）；称重物料可以比订购数量多出容差（v0.7.13） */
  receivedMilli: number;
  /** 称重物料（#14，v0.7.13） */
  weighed: boolean;
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
  snapshot: { supplierName: string; channel?: string | null; totalCents: number; lines: { materialName: string; spec?: string; purchaseQtyMilli: number; purchaseUnit: string; priceCents: number; amountCents: number; imageIds?: number[] }[] };
}

export interface PurchaseOrder {
  id: number;
  docNo: string;
  status: PoStatus;
  supplier: Ref;
  /** 采购途径（v0.7.29，E1）；v0.7.29 以前的单据为空 */
  channel: ChannelRef | null;
  /** 从哪张询价单转来的（v0.7.29，E5） */
  sourcing: { id: number; docNo: string; status: 'open' | 'awarded' | 'cancelled' } | null;
  /** 挂的合同（v0.7.31，C9）与超价、超量时写的原因；按合同单价表核对的结果（没挂合同为空） */
  contract: { id: number; contractNo: string; title: string } | null;
  contractNote: string;
  contractCheck: ContractCheckResult | null;
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
  /** 退货抵了本单收货的部分（v0.7.12 起：挂账的按 return_applied_cents，现付的整笔） */
  returnCreditCents: number;
  /** 本单退货里没抵到收货、还可以抵扣 / 退款的退货余额（在供应商的可抵扣里，不从本单扣；v0.7.12） */
  returnBalanceCents: number;
  /** 已登记付款：核销到本单收货的已确认付款，加上预付款、退货余额核销到本单收货的（v0.7.12） */
  paidCents: number;
  /** 本单未付 = 已确认收货 − 退货抵扣 − 已付（与应付未结清一致） */
  unpaidCents: number;
  receipts: (DocRef & { docDate: string; amountCents: number })[];
  revisions: PoRevision[];
  approvals: ApprovalLog[];
  /** 审批中心（v0.7.30）：在审的审批单，没有在审的取最近一张；从没走过审批中心的为空 */
  approval: ApprovalBrief | null;
  /** 报销情况（v0.7.29）：现付的采购单在费用报销里报，这里列报在哪几张、还有几行没报 */
  reimbursement: import('./expenses').PoReimbursement;
  /**
   * 现在能不能撤回（8.0.1）：草稿、待确认、退回的，与提交即确认（没经过人审批）、还没有报销、发票、三单放行的已确认采购单，都要还没有收货；
   * 撤回的人还要是创建人或能确认采购单的
   */
  withdrawable: boolean;
}

export interface PoSummary {
  id: number;
  docNo: string;
  status: PoStatus;
  supplierName: string;
  channel: ChannelRef | null;
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
  /** 退货扣款抵到这笔货款的部分（v0.7.12 起只算抵到的，多出来的是退货单的退货余额） */
  creditCents: number;
  /** 预付款、退货余额核销到这笔货款的（v0.7.12） */
  offsetCents: number;
  /** 已确认付款核销 */
  paidCents: number;
  /** 待确认付款占用（防止两笔付款同时核销同一货款） */
  pendingCents: number;
  /** 还可以核销的金额 = 货款 − 退货抵扣 − 核销 − 已付 − 待确认占用 */
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
  /** 没核销到具体货款的部分：预付款（v0.7.12） */
  prepaidCents: number;
  /** 预付款已核销、已退款与还可以用的（已确认的付款才有意义） */
  prepayOffsetCents: number;
  prepayRefundedCents: number;
  prepayAvailableCents: number;
  approvals: ApprovalLog[];
  /** 审批中心（v0.7.30）：在审的审批单，没有在审的取最近一张；从没走过审批中心的为空 */
  approval: ApprovalBrief | null;
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
  /** 预付款、退货余额核销到这笔期初未付的（v0.7.12） */
  offsetCents: number;
  /** 批量导入的（v0.7.12） */
  importId: number | null;
  approvals: ApprovalLog[];
  /** 审批中心（v0.7.30）：在审的审批单，没有在审的取最近一张；从没走过审批中心的为空 */
  approval: ApprovalBrief | null;
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
  /** 供应商退款（v0.7.12，冲减付款） */
  refundedCents: number;
  balanceCents: number;
  /** 可抵扣合计：预付款与退货余额还没核销、没退款的（v0.7.12） */
  creditCents: number;
  /** 待确认的付款（不计入余额） */
  pendingPaymentCents: number;
  /** 其中没到期的质保金（v0.7.32，P9）：这家的采购合同里质保段还没到可付、没付清的部分（不超过余额），不算现在该付 */
  warrantyHeldCents: number;
  /** 未结清货款张数 */
  openItemCount: number;
  lastActivity: string | null;
}

export type ApEntryKind = 'opening' | 'receipt' | 'supplier_return' | 'payment' | 'refund';

export interface StatementRow {
  id: number;
  date: string;
  kind: ApEntryKind;
  /** 冲销行：原单类型同上，isVoid 为 true */
  isVoid: boolean;
  docKind: 'inv_doc' | 'payment' | 'opening_payable' | 'supplier_refund';
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
  refundedCents: number;
  endCents: number;
  rows: StatementRow[];
  openItems: OpenItem[];
  /** 期末还可以核销或退款的预付款、退货余额（v0.7.12） */
  credits: SupplierCredit[];
}

export interface PayablesOverview {
  totals: { openingCents: number; receivedCents: number; returnCreditCents: number; paidCents: number; refundedCents: number; balanceCents: number; creditCents: number; warrantyHeldCents: number };
  suppliers: SupplierBalance[];
  pending: { payments: number; openings: number; purchaseOrders: number };
}

// ───────────────────────── 可抵扣、核销与供应商退款（v0.7.12，docs/SUPPLIER_SETTLEMENT.md） ─────────────────────────

/**
 * 可抵扣：预付款（已确认的付款没核销到具体货款的部分）或退货余额（已生效退货单没抵到原收货单的部分）。
 * 挂账的可以核销到以后的应付或登记退款；现付供应商的退货不记应付，只能登记退款（canOffset 为 false）。
 */
export interface SupplierCredit {
  kind: 'prepayment' | 'return';
  id: number;
  docNo: string;
  date: string;
  /** 付款金额 / 退货扣款 */
  amountCents: number;
  /** 付款核销到货款的 / 退货抵到原收货单的 */
  usedCents: number;
  offsetCents: number;
  refundedCents: number;
  availableCents: number;
  canOffset: boolean;
  summary: string;
}

export type SettlementStatus = 'confirmed' | 'voided';
export const SETTLEMENT_STATUS_LABELS: Record<SettlementStatus, string> = { confirmed: '已生效', voided: '已冲销' };

export interface ApOffsetLine {
  id: number;
  kind: 'receipt' | 'opening';
  targetId: number;
  docNo: string;
  amountCents: number;
}

/** 核销单：用一笔预付款或退货余额抵扣同一供应商的若干笔应付；不动钱、不记应付流水 */
export interface ApOffsetDoc {
  id: number;
  docNo: string;
  status: SettlementStatus;
  supplier: Ref;
  offsetDate: string;
  credit: { kind: 'prepayment' | 'return'; id: number; docNo: string };
  amountCents: number;
  note: string;
  lines: ApOffsetLine[];
  createdByName: string;
  createdAt: string;
  voidedByName: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  isSynthetic: boolean;
}

/** 供应商退款：供应商把预付款或退货的钱退回来；挂账的记应付流水「供应商退款」 */
export interface SupplierRefundDoc {
  id: number;
  docNo: string;
  status: SettlementStatus;
  supplier: Ref;
  refundDate: string;
  amountCents: number;
  method: PayMethod;
  evidence: string;
  note: string;
  credit: { kind: 'prepayment' | 'return'; id: number; docNo: string };
  postsAp: boolean;
  createdByName: string;
  createdAt: string;
  voidedByName: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  isSynthetic: boolean;
}

// ───────────────────────── 供应商与期初未付批量导入（#16，v0.7.12） ─────────────────────────

export type ErpImportKind = 'suppliers' | 'opening_payables';
export const ERP_IMPORT_LABELS: Record<ErpImportKind, string> = { suppliers: '供应商', opening_payables: '期初未付' };

/** 导入模板的列（第一行是表头，顺序不限，按名称找） */
export const SUPPLIER_IMPORT_COLUMNS = ['编码', '名称', '联系人', '电话', '结算方式', '备注'] as const;
export const OPENING_IMPORT_COLUMNS = ['供应商编码', '金额', '截至日期', '备注'] as const;

export interface ErpImportRowIssue {
  /** 文件里的行号（表头是第 1 行） */
  row: number;
  message: string;
}

export interface ErpImportPreview {
  kind: ErpImportKind;
  fileName: string;
  fileSha256: string;
  encoding: string;
  rowCount: number;
  totalCents: number;
  /** 有问题的行（有任何一行有问题整份不能写入） */
  issues: ErpImportRowIssue[];
  /** 已经导入过同一个文件 */
  duplicateOf: { id: number; createdAt: string; createdByName: string } | null;
  /** 前 20 行预览 */
  sample: Record<string, string>[];
}

export interface ErpImportRecord {
  id: number;
  kind: ErpImportKind;
  fileName: string;
  rowCount: number;
  totalCents: number;
  createdByName: string;
  createdAt: string;
}

// ───────────────────────── 采购规则（v0.7.29 ERP 采购五项，docs/ERP_PURCHASING.md） ─────────────────────────

/** 采购途径：needsNote 的要写途径说明（平台与店铺、市场或门店……） */
export interface PurchaseChannelDef {
  key: string;
  label: string;
  needsNote: boolean;
}

/**
 * 采购途径固定三类（8.0.1 采购组整改 08，CG08，docs/PURCHASING_V801.md）：网购、自采（现采 / 零采）、供应商；
 * 名称不能改、不能加。v0.7.29 起的途径字典（可改名、可加）在迁移 083 里并成这三类，数据库也只认这三个键。
 */
export const PURCHASE_CHANNEL_KEYS = ['online', 'self', 'supplier'] as const;
export type PurchaseChannelKey = (typeof PURCHASE_CHANNEL_KEYS)[number];
export const PURCHASE_CHANNELS: PurchaseChannelDef[] = [
  { key: 'online', label: '网购', needsNote: true },
  { key: 'self', label: '自采（现采/零采）', needsNote: true },
  { key: 'supplier', label: '供应商', needsNote: false },
];
/**
 * 旧的途径键（v0.7.29 的字典：供应商配送 supplier、网购平台 online、批发市场 wholesale、商超门店 store、其他 other 与自加的）按三类算（CG08）：
 * supplier、online 照旧，其余都算自采。已经生效的单据只追加、不改历史，记的还是当时的名称；按三类统计、筛选，
 * 以及供应商档案里旧的默认途径都按这个对应（档案下次保存时存成三类之一）。
 */
export const channelCategory = (key: string | null | undefined): PurchaseChannelKey | null =>
  !key ? null : key === 'supplier' || key === 'online' ? key : 'self';

/** 没选途径、供应商档案也没设默认途径时按「供应商」 */
export const DEFAULT_CHANNEL_KEY: PurchaseChannelKey = 'supplier';
export const channelLabel = (key: string | null | undefined): string => PURCHASE_CHANNELS.find((c) => c.key === key)?.label ?? '—';

/** 急采分级审批的一档（05，CG05）：合计不超过 maxCents 的由这一档的审批人审（1–5 人或签；没指定的由负责人审） */
export interface UrgentTier {
  maxCents: number;
  approverIds: number[];
}
export const URGENT_TIERS_MAX = 3;

export interface PurchaseRules {
  /** 固定三类（读出来总是 PURCHASE_CHANNELS，改不了） */
  channels: PurchaseChannelDef[];
  /** 询价门槛（分，E5）：合计 ≥ 这个金额的采购单第一次提交时要来自已定标的询价单；0 = 不要求 */
  quoteThresholdCents: number;
  /** 定标至少要几家有效报价（E6）；不够的标「单一来源」、由负责人定标 */
  minQuotes: number;
  /** 补货触发天数（E4）：物料没设提醒天数时，可用天数（含在途）少于它就建议补货 */
  reorderDays: number;
  /** 补货目标天数（E4）：建议补到能用这么多天 */
  targetDays: number;
  /** 下单后几天没到货算超期（采购单没填预计到货日时用；账目自检第 9 条）。8.0.1 从费用报销规则挪过来（CG01） */
  arrivalOverdueDays: number;
  /** 每日截单（03，CG03）：开着时截单时间以后（含）提交的需求单当天不能审核通过 */
  cutoffEnabled: boolean;
  /** 截单时间（门店时区，HH:MM） */
  cutoffTime: string;
  /** 需求单转的采购单（04，CG04）：每一行都来自已通过的需求单的，提交即确认，不再走「负责人确认」的默认规则 */
  requestPoDirect: boolean;
  /** 急采分级审批（05，CG05）：按金额从小到大；最高一档就是急采上限 */
  urgentTiers: UrgentTier[];
}

/** 默认规则（待确认，E1、E4–E6、CG01、CG03–CG05）：在「采购 → 采购规则」里改 */
export const DEFAULT_PURCHASE_RULES: PurchaseRules = {
  channels: PURCHASE_CHANNELS,
  quoteThresholdCents: 500_000,
  minQuotes: 2,
  reorderDays: 7,
  targetDays: 14,
  arrivalOverdueDays: 7,
  // 截单默认关着（打开后默认 17:00）：升级后审核照旧，采购或店主在「采购 → 采购规则」里打开（CG03）
  cutoffEnabled: false,
  cutoffTime: '17:00',
  requestPoDirect: true,
  urgentTiers: [
    { maxCents: 500_000, approverIds: [] },
    { maxCents: 3_000_000, approverIds: [] },
  ],
};

/** 急采上限：分级的最高一档 */
export const urgentCapOf = (rules: Pick<PurchaseRules, 'urgentTiers'>): number => rules.urgentTiers[rules.urgentTiers.length - 1]?.maxCents ?? 0;
/** 急采合计落在哪一档（第几档，从 0 起）；超过最高一档返回 -1 */
export const urgentTierIndex = (rules: Pick<PurchaseRules, 'urgentTiers'>, amountCents: number): number => rules.urgentTiers.findIndex((t) => amountCents <= t.maxCents);

/** 单据上记的采购途径：键与当时的名称、途径说明 */
export interface ChannelRef {
  key: string;
  label: string;
  note: string;
}

/** 「网购平台 · 某某旗舰店」；没记的显示「—」 */
export function channelText(c: ChannelRef | null | undefined): string {
  if (!c) return '—';
  return c.note ? `${c.label} · ${c.note}` : c.label;
}

// ───────────────────────── 补货建议（v0.7.29 ERP 采购五项④，docs/ERP_PURCHASING.md 第 5 节） ─────────────────────────

export interface ReplenishLine {
  materialId: number;
  code: string;
  name: string;
  specification: string;
  inventoryUnit: string;
  purchaseUnit: string;
  factorMilli: number;
  decimals: number;
  /** 总仓结存（库存单位） */
  stockMilli: number;
  /** 在途：没撤回、没关闭的采购单还没收到的（补单除外） */
  inTransitMilli: number;
  /** 在途来自哪几张采购单 */
  openPos: string[];
  /** 日均用量（库存单位，近 N 天）；没有用量为 null */
  dailyUsageMilli: number | null;
  /** (结存 + 在途) ÷ 日均用量，一位小数 */
  daysOfCover: number | null;
  /** cover：可用天数不足；low_stock：没有用量、低于提醒数量 */
  reason: 'cover' | 'low_stock';
  /** 触发天数（物料的提醒天数，或规则的补货触发天数）与补到的天数 */
  triggerDays: number | null;
  targetDays: number | null;
  lowStockMilli: number | null;
  /** 建议采购数量（采购单位，整包装）与折成的库存数量 */
  suggestedPurchaseMilli: number;
  suggestedBaseMilli: number;
  /** 单价（每采购单位）：最近一次同口径成交价，没有用参考价 */
  priceCents: number | null;
  priceSource: 'last' | 'ref' | null;
  amountCents: number | null;
}

export interface ReplenishGroup {
  /** 物料的默认供应商，没设的取最近一次收货的供应商；都没有为空（要先选供应商） */
  supplier: Ref | null;
  lines: ReplenishLine[];
  totalCents: number;
}

export interface ReplenishSuggestions {
  windowDays: number;
  reorderDays: number;
  targetDays: number;
  count: number;
  groups: ReplenishGroup[];
}

// ───────────────────────── 询价比价与定标（v0.7.29 ERP 采购五项⑤，docs/ERP_PURCHASING.md 第 6 节） ─────────────────────────

export type SourcingStatus = 'open' | 'awarded' | 'cancelled';
export const SOURCING_STATUS_LABELS: Record<SourcingStatus, string> = { open: '询价中', awarded: '已定标', cancelled: '已撤销' };

export interface SourcingLine {
  id: number;
  lineNo: number;
  materialId: number;
  materialCode: string;
  materialName: string;
  specification: string;
  purchaseUnit: string;
  inventoryUnit: string;
  factorMilli: number;
  purchaseQtyMilli: number;
  baseQtyMilli: number;
  spec: string;
  /** 最近一次同口径成交价（比价用） */
  baseline: PriceCompare['baseline'];
  /** 来自哪几行需求（v0.7.30：从需求单发起的询价；定标转采购单时一起带到采购单行上） */
  requests: SourcingLineRequest[];
}

/** 询价单行来自的需求行：与采购单行的需求关联同一形状 */
export type SourcingLineRequest = PoLineRequest;

export interface SourcingQuote {
  id: number;
  supplier: Ref;
  status: 'active' | 'withdrawn';
  goodsCents: number;
  freightCents: number;
  /** 综合到价 = 货款合计 + 运费（E7） */
  landedCents: number;
  payTerms: string;
  creditDays: number;
  deliveryDays: number | null;
  validUntil: string | null;
  note: string;
  prices: { lineId: number; priceCents: number; amountCents: number; changePercent: number | null }[];
  /** 有效报价里按综合到价的名次（1 = 最低）；撤下的为空 */
  rank: number | null;
  createdByName: string;
  createdAt: string;
  withdrawReason: string | null;
  withdrawnByName: string | null;
}

export interface SourcingEvent {
  id: number;
  docNo: string;
  title: string;
  status: SourcingStatus;
  needBy: string | null;
  note: string;
  singleSource: boolean;
  awardedQuoteId: number | null;
  awardReason: string | null;
  awardedByName: string | null;
  awardedAt: string | null;
  cancelReason: string | null;
  createdByName: string;
  createdAt: string;
  lines: SourcingLine[];
  quotes: SourcingQuote[];
  /** 每行最低的有效报价：行 → 报价 */
  lowest: Record<number, number>;
  /** 转出的、没撤回的采购单 */
  purchaseOrder: { id: number; docNo: string; status: PoStatus } | null;
  /** 定标至少要几家有效报价（规则） */
  minQuotes: number;
}

export interface SourcingSummary {
  id: number;
  docNo: string;
  title: string;
  status: SourcingStatus;
  needBy: string | null;
  lineCount: number;
  quoteCount: number;
  summary: string;
  awardedSupplierName: string | null;
  lowestLandedCents: number | null;
  purchaseOrder: { id: number; docNo: string } | null;
  createdByName: string;
  createdAt: string;
}

/** 价格曲线（E8）：近 12 个月的成交价与报价，按日期 */
export interface PriceHistory {
  materialId: number;
  materialName: string;
  points: { date: string; source: 'receipt' | 'quote'; docNo: string; supplierName: string; priceCents: number; purchaseUnit: string; qtyMilli: number | null }[];
}
