// 库存与采购：前后端共用的类型与中文名称。数量为 milli（千分之一库存单位），金额为分。

import type { ApprovalBrief } from './approvals';
import type { PriceCompare } from './purchasing';

export const INV_DOC_TYPES = ['opening', 'receipt', 'issue', 'issue_return', 'direct_use', 'damage', 'count', 'supplier_return'] as const;
export type InvDocType = (typeof INV_DOC_TYPES)[number];

export const INV_DOC_META: Record<InvDocType, { title: string; prefix: string; verb: string; direction: 'in' | 'out' | 'both' }> = {
  opening: { title: '期初库存', prefix: 'QC', verb: '建立期初', direction: 'in' },
  receipt: { title: '收货入库', prefix: 'RK', verb: '收货', direction: 'in' },
  issue: { title: '部门领料', prefix: 'LY', verb: '领料', direction: 'out' },
  issue_return: { title: '领料退回', prefix: 'LT', verb: '退回', direction: 'in' },
  direct_use: { title: '直接耗用', prefix: 'HY', verb: '耗用', direction: 'out' },
  damage: { title: '报损', prefix: 'BS', verb: '报损', direction: 'out' },
  count: { title: '盘点', prefix: 'PD', verb: '盘点', direction: 'both' },
  supplier_return: { title: '退供应商', prefix: 'TG', verb: '退货', direction: 'out' },
};

// 待供应商确认：退供应商单确认后先等供应商同意，库存、货款都不动（#20，v0.7.12）
export const INV_DOC_STATUSES = ['draft', 'submitted', 'returned', 'awaiting_supplier', 'confirmed', 'cancelled', 'voided'] as const;
export type InvDocStatus = (typeof INV_DOC_STATUSES)[number];

export const INV_STATUS_LABELS: Record<InvDocStatus, string> = {
  draft: '草稿',
  submitted: '待确认',
  returned: '已退回修改',
  awaiting_supplier: '待供应商确认',
  confirmed: '已生效',
  cancelled: '已撤回',
  voided: '已冲销',
};

export const MOVE_TYPES = ['opening', 'receipt', 'issue', 'issue_return', 'direct_use', 'damage', 'count_adjust', 'supplier_return', 'void'] as const;
export type MoveType = (typeof MOVE_TYPES)[number];

export const MOVE_TYPE_LABELS: Record<MoveType, string> = {
  opening: '期初',
  receipt: '收货入库',
  issue: '部门领料',
  issue_return: '领料退回',
  direct_use: '直接耗用',
  damage: '报损',
  count_adjust: '盘点调整',
  supplier_return: '退供应商',
  void: '冲销',
};

/** 盘点差异原因：确认前一律为「待核差异」，不自动认定为浪费或失窃；部门小仓默认「耗用」（v0.7.11） */
export const COUNT_REASONS = ['unrecorded', 'measurement', 'damaged', 'unknown', 'consumed'] as const;
export type CountReason = (typeof COUNT_REASONS)[number];
export const COUNT_REASON_LABELS: Record<CountReason | 'pending', string> = {
  pending: '待核差异',
  unrecorded: '漏记',
  measurement: '计量错误',
  damaged: '损坏',
  unknown: '不明差异',
  consumed: '耗用',
};

// ───────────────────────── 补货方式（店主 2026-11-14，迁移 161，docs/ERP_PURCHASING.md 第 5.1 节） ─────────────────────────

/**
 * 物料的补货方式：auto 自动识别（默认）；stock 常备（一直按用量 / 提醒数量提补货）；
 * on_demand 按需采购（不提补货、也不做低库存提醒——手机、设备这类部门提了需求才买的）。
 */
export const REPLENISH_MODES = ['auto', 'stock', 'on_demand'] as const;
export type ReplenishMode = (typeof REPLENISH_MODES)[number];
export const REPLENISH_MODE_LABELS: Record<ReplenishMode, { title: string; hint: string }> = {
  auto: { title: '自动识别', hint: '设了提醒的、经常领用的才提补货；只领过一次的、建过资产卡片的不提' },
  stock: { title: '常备', hint: '一直备着的耗材：按用量或提醒数量提补货' },
  on_demand: { title: '按需采购', hint: '手机、设备这类不是消耗品的：部门提需求才买，不提补货、不做低库存提醒' },
};

// ───────────────────────── 两级库存（v0.7.11，docs/WAREHOUSES.md） ─────────────────────────

/** 总仓固定是 1 号仓；每个部门一个小仓 */
export const CENTRAL_WAREHOUSE_ID = 1;

export interface Warehouse {
  id: number;
  kind: 'central' | 'department';
  departmentId: number | null;
  /** 总仓用「库存范围名称」，部门小仓是「部门名 + 小仓」 */
  name: string;
  /** 部门停用后它的小仓也停用（停用前要清空） */
  active: boolean;
}

/** 部门小仓里一个物料的结存 */
export interface WarehouseStockRow {
  materialId: number;
  code: string;
  name: string;
  specification: string;
  category: string;
  inventoryUnit: string;
  decimals: number;
  stockMilli: number;
  lastMoveAt: string | null;
  /** 提醒天数与这个仓近期的日均用量、可用天数（#22，v0.7.12）；没有用量时可用天数为空 */
  coverDays: number | null;
  dailyUsageMilli: number;
  daysOfCover: number | null;
  /** 可用天数少于提醒天数 */
  isLow: boolean;
  /** 台面日耗品（v0.7.13）：领到即耗用，部门小仓结存始终为 0、不提醒 */
  counterUse: boolean;
  /** 补货方式（迁移 161）：按需采购的不提醒 */
  replenishMode: ReplenishMode;
}

/** 领料单的部门签收（#17 第二次验收） */
export interface DeptSign {
  signedByName: string;
  signedAt: string;
  note: string;
}

/** 领料超过这么多天没签收，在待办与自检里标出（待确认） */
export const ISSUE_SIGN_DUE_DAYS = 3;

/** 「本部门小仓」页面用的基础资料（部门的员工没有「查看库存」，这里只给需要的字段，不含参考价与总仓结存） */
export interface DeptStockMeta {
  /** 能看的部门：店主与成本岗是所有在用部门，部门申购只有自己所属的部门 */
  departments: { id: number; name: string; warehouseId: number }[];
  /** 员工档案里的所属部门 */
  myDepartmentId: number | null;
  /** 能登记本部门的急采、期初、报损、签收（部门申购或店主） */
  canOperate: boolean;
  /** 能给所有部门盘点、登记耗用（财务成本岗） */
  canAudit: boolean;
  urgentCapCents: number;
  signDueDays: number;
  /** 期初、报损要不要负责人确认（与库存规则一致） */
  approvalRules: ApprovalRules;
  /** 盘点大差异（v0.7.30，A8）：差异超过账面的百分比、差异金额（分） */
  countBigPct: number;
  countBigCents: number;
  materials: {
    id: number;
    code: string;
    name: string;
    category: string;
    specification: string;
    inventoryUnit: string;
    decimals: number;
    purchaseUnit: string;
    purchaseFactorMilli: number;
    /** 台面日耗品（v0.7.13）：部门小仓不登记它的期初、耗用、报损、盘点 */
    counterUse: boolean;
    weighed: boolean;
  }[];
  suppliers: { id: number; code: string; name: string }[];
  /** 耗用的用途（8.0.7 2.3，「门店基本规则 → 可调的数值」里改） */
  purposes: string[];
  /** 经办人能选的员工（在职的） */
  staff: { id: number; name: string }[];
}

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
  /** 急采上限（分，#19：默认 2000 元，可调）；没有采购单的收货只能走急采 */
  urgentCapCents: number;
  /** 免确认门槛（分，#18：默认 2000 元，可调）：设为需要确认的单据，金额不超过门槛的提交即生效（v0.7.12） */
  approvalThresholdCents: number;
  /** 可用天数按近多少天的用量算（#22，默认 28 天，v0.7.12） */
  usageWindowDays: number;
  /** 称重收货容差（%，#14，默认 10，v0.7.13）：称重物料的实收可以比采购单这一行的订购数量多出这么多 */
  weighTolerancePct: number;
  /** 每月盘点日（1–28，#23，默认 1 号）与宽限天数（默认 3 天，过了标红） */
  stocktakeDay: number;
  stocktakeGraceDays: number;
  /** 月结供应商的对账日（1–28，#23，默认次月 1 号）与宽限天数（默认 5 天） */
  monthlyReconDay: number;
  monthlyReconGraceDays: number;
  /** 按批次供应商：收货后几天没对账标红（#23，默认 3 天） */
  batchReconGraceDays: number;
  /** 盘点大差异（v0.7.30，A8）：差异数量超过账面的这个百分比（默认 2），或差异金额超过这个金额（分，默认 ¥500） */
  countBigPct: number;
  countBigCents: number;
  approvalRules: ApprovalRules;
}

/** 盘点大差异（v0.7.30，A8）的默认：差异超过账面的 2%，或差异金额超过 ¥500 */
export const DEFAULT_COUNT_BIG_PCT = 2;
export const DEFAULT_COUNT_BIG_CENTS = 50_000;

/**
 * 盘点这一行是不是「大差异」（v0.7.30，A8）：差异数量超过账面数的 countBigPct%（账面是 0 的有差异就算），
 * 或差异金额（差异数量 × 参考价，取绝对值）超过 countBigCents。没有参考价的只按比例看。
 */
export function isBigVariance(
  bookMilli: number,
  diffMilli: number,
  diffAmountCents: number | null,
  rules: Pick<InventorySettings, 'countBigPct' | 'countBigCents'>,
): boolean {
  if (diffMilli === 0) return false;
  if (bookMilli === 0) return true;
  if (Math.abs(diffMilli) * 100 > Math.abs(bookMilli) * rules.countBigPct) return true;
  return diffAmountCents !== null && Math.abs(diffAmountCents) > rules.countBigCents;
}

/** 盘点差异占账面的百分比（保留一位小数）；账面是 0 的为空 */
export function variancePct(bookMilli: number, diffMilli: number): number | null {
  if (bookMilli === 0) return null;
  return Math.round((diffMilli * 1000) / bookMilli) / 10;
}

export interface Department {
  id: number;
  name: string;
  active: boolean;
  sortOrder: number;
  /** 部门主管（8.0.17，LC1）：需求单要主管确认时由他确认；没设为空 */
  head: { id: number; name: string; active: boolean } | null;
}

export interface Supplier {
  id: number;
  code: string;
  name: string;
  contact: string;
  phone: string;
  note: string;
  /** 结算方式（v0.7.7）：挂账（收货记应付）/ 现付（收货不记应付，货款走费用报销） */
  settlement: import('./expenses').SupplierSettlement;
  /** 挂账供应商的对账方式（#23，v0.7.13）：月结（默认）/ 按批次；现付供应商不对账 */
  reconcileCycle: ReconcileCycle;
  /** 改成按批次的日期：之前的收货不提醒对账 */
  reconcileSince: string | null;
  /** 默认采购途径（v0.7.29，E1；8.0.1 起只有三类）：新建采购单按它带出；没设的按「供应商」 */
  defaultChannel: string | null;
  /** 签约 / 未签约（8.0.1 采购组整改 08，CG08）：签约的可以上传合同 PDF */
  contracted: boolean;
  /** 在用的合同 PDF 份数 */
  contractFiles: number;
  /** 准入状态（8.0.7 A2，@shared/supply）：待准入 / 已准入 / 暂停 */
  admission: import('./supply').SupplierAdmission;
  /** 准入、暂停时写的说明 */
  admissionNote: string;
  /** 在用的证照里最早到期的（没有或都长期的为空）；过期的也算 */
  licenseDue: string | null;
  active: boolean;
  isSynthetic: boolean;
}

/** 签约供应商的合同 PDF（8.0.1，CG08） */
export interface SupplierContractFile {
  id: number;
  name: string;
  sizeBytes: number;
  uploadedByName: string;
  uploadedAt: string;
  /** 下载地址（要登录） */
  url: string;
}
/** 合同 PDF 每份最多 10 MB */
export const MAX_PDF_BYTES = 10 * 1024 * 1024;

/** 收货单的附件（8.0.1 采购组整改 11，CG11）：货物、送货单、小票的照片（≤ 1 MB）或 PDF（≤ 10 MB） */
export interface ReceiptAttachment {
  id: number;
  kind: 'image' | 'pdf';
  name: string;
  /** 看图、下载的地址（要登录） */
  url: string;
  sizeBytes: number;
  uploadedByName: string;
  uploadedAt: string;
}
/** 每张收货单最多几份附件 */
export const MAX_RECEIPT_ATTACHMENTS = 9;

export const RECONCILE_CYCLES = ['monthly', 'batch'] as const;
export type ReconcileCycle = (typeof RECONCILE_CYCLES)[number];
export const RECONCILE_CYCLE_LABELS: Record<ReconcileCycle, { title: string; hint: string }> = {
  monthly: { title: '月结', hint: '次月初与供应商对上个月的账' },
  batch: { title: '按批次', hint: '每批货到后对一次账' },
};

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
  /** 提醒天数（#22，v0.7.12）：可用天数少于它时提醒；为空时按固定的低库存提醒数量 */
  coverDays: number | null;
  /** 台面日耗品（#14，v0.7.13）：领到部门即算耗用，部门小仓不留结存、不再清点 */
  counterUse: boolean;
  /** 称重（#14，v0.7.13）：按实际称重记数量，收货可以比采购单多出容差 */
  weighed: boolean;
  /** 效期管理（8.0.7 3.3）：收货要填到期日；保质期天数（可空） */
  expiryTracked: boolean;
  shelfLifeDays: number | null;
  /** 补货方式（迁移 161）：按需采购的不提补货、不做低库存提醒 */
  replenishMode: ReplenishMode;
  tracked: boolean;
  active: boolean;
  /** 总仓结存 */
  stockMilli: number;
  /** 各部门小仓合计（v0.7.11） */
  deptStockMilli: number;
  /** 总仓低于提醒线：设了提醒天数且有用量的按可用天数，否则按人工设定的数量；补货方式是按需采购的不提醒 */
  isLow: boolean;
  /** 总仓近期日均用量（milli/天，按「用量统计天数」算；没有用量为 0） */
  dailyUsageMilli: number;
  /** 总仓可用天数（结存 ÷ 日均用量，一位小数；没有用量为空） */
  daysOfCover: number | null;
  /** 总仓已有库存流水（总仓的期初只能在没有流水时建立） */
  hasMoves: boolean;
  /** 任何一个仓已有流水（库存单位、精度不能再改，也不能改成候选物料；v0.7.11） */
  anyMoves: boolean;
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
  /** 差异说明（v0.7.30：大差异的行提交时写） */
  diffNote: string;
  /** 盘点：记录账面数之后该物料又有收发，需要重新核对 */
  stale: boolean;
  sourceLineId: number | null;
  /** 领用 / 收货行已被退回或退货的数量（已生效 + 待确认） */
  returnedMilli: number;
  /** 单据所在仓的当前结存（详情展示用） */
  stockMilli: number;
  /** 台面日耗品：这一行领到部门（或急采）时已自动记为部门耗用（#14，v0.7.13） */
  autoConsumed: boolean;
  /** 物料现在是台面日耗品 / 称重（单据表单的提示用） */
  counterUse: boolean;
  weighed: boolean;
  /** 批号、生产日期、到期日（8.0.7 3.3，收货行）；物料管不管效期 */
  batchNo: string | null;
  producedOn: string | null;
  expiresOn: string | null;
  expiryTracked: boolean;
  note: string;
  /** 收货行：与此前同口径成交价的比较 */
  compare?: PriceCompare;
}

export interface ApprovalLog {
  id: number;
  action: 'create' | 'submit' | 'approve' | 'return' | 'cancel' | 'void' | 'close' | 'revise' | 'sign' | 'supplier_agree' | 'supplier_reject';
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
  /** 耗用的用途与经办人（8.0.7 2.3）：之前的耗用单与别的单据为空 */
  usePurpose: string | null;
  useHandler: Ref | null;
  amountCents: number;
  noPo: boolean;
  /** 这张单动的仓；领料与退回是部门小仓（另一头是总仓）；迁移前的领料、退回为空（没进部门小仓） */
  warehouse: { id: number; name: string; kind: Warehouse['kind'] } | null;
  /** 急采收货（#19）：没有采购单，进部门小仓，合计不超过登记时的上限 */
  urgent: boolean;
  urgentCapCents: number | null;
  /** 急采按金额分级审批通过的时间（8.0.1，CG05）：为空且已提交 = 还在审批中；不为空且已提交 = 等仓库到部门验收 */
  urgentApprovedAt: string | null;
  /** 一起验收的采购经办（#17 第一次验收） */
  coAcceptor: Ref | null;
  /** 领料：部门签收（#17 第二次验收）；没签收为空 */
  deptSign: DeptSign | null;
  /** 退供应商：供应商的答复（#20，v0.7.12）；还没答复为空 */
  supplierAnswer: SupplierAnswer | null;
  /** 退供应商（已生效）：退货扣款抵了原收货单多少、退货余额核销与退款的情况（v0.7.12） */
  returnCredit: ReturnCredit | null;
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
  /** 审批中心（v0.7.30）：在审的审批单，没有在审的取最近一张；从没走过审批中心的为空 */
  approval: ApprovalBrief | null;
  /** 收货单的附件（8.0.1，CG11）；不是收货单的为空 */
  attachments: ReceiptAttachment[];
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
  warehouseName: string | null;
  urgent: boolean;
  /** 急采已生效、还没补采购单 */
  needsBackfill: boolean;
  /** 急采已经按金额分级审批通过（8.0.1）：已提交的急采据此分「审批中」与「待验收」 */
  urgentApproved: boolean;
  /** 领料：部门是否已签收（其他单据为空） */
  deptSigned: boolean | null;
  createdByName: string;
  createdAt: string;
}

/** 退供应商的供应商答复（#20） */
export interface SupplierAnswer {
  agreed: boolean;
  /** 对方同意的日期（不同意时为空） */
  date: string | null;
  note: string;
  byName: string;
  at: string;
}

/**
 * 已生效退货的扣款去向（v0.7.12）：挂账的先抵原收货单还没付的部分（appliedCents），多出来的是退货余额，
 * 可以核销到以后的应付或登记供应商退款；现付供应商的退货不记应付，整笔等供应商退款（迁移前的视为已了结）。
 */
export interface ReturnCredit {
  settlement: import('./expenses').SupplierSettlement;
  appliedCents: number;
  offsetCents: number;
  refundedCents: number;
  /** 还可以核销或退款的余额 */
  availableCents: number;
}

/** 退供应商单在「待供应商确认」超过这么多天时在工作台标红（待确认） */
export const SUPPLIER_ANSWER_DUE_DAYS = 7;

/** 库存卡：一个物料在一个仓的流水（v0.7.11 起按仓） */
export interface StockCard {
  material: Material;
  warehouse: { id: number; name: string; kind: Warehouse['kind'] };
  /** 这个物料在各仓的结存：总仓在前，部门小仓只列有过收发的 */
  balances: { warehouseId: number; name: string; kind: Warehouse['kind']; stockMilli: number }[];
  moves: StockMoveRow[];
  pending: { id: number; docNo: string; docType: InvDocType; status: InvDocStatus; docDate: string; qtyMilli: number }[];
}

/** 报表选的仓：某一个仓，或「全部合计」 */
export type WarehouseSel = number | 'all';

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

/**
 * 期间收发汇总；出库类为正数，盘点调整与冲销带正负号。begin + 各项 = closing。
 * 总仓与「全部合计」：issued 是领料出、issueReturned 是退回进；部门小仓反过来：issued 是从总仓领进、issueReturned 是退回总仓（v0.7.11）。
 */
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
  /** 领料超过 ISSUE_SIGN_DUE_DAYS 天部门没签收 */
  unsignedIssues: number;
  /** 急采待仓库验收、待补采购单 */
  urgentToVerify: number;
  urgentToBackfill: number;
  /** 退货待供应商确认的张数，其中超过 SUPPLIER_ANSWER_DUE_DAYS 天的（v0.7.12） */
  awaitingSupplier: number;
  awaitingSupplierOverdue: number;
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

/** 赠品入库台账（8.0.1 采购组整改 09，CG09）：只记台账，不进库存结存、不记成本 */
export interface GiftReceipt {
  id: number;
  docNo: string;
  receivedOn: string;
  material: { id: number; code: string; name: string } | null;
  name: string;
  qtyMilli: number;
  unit: string;
  supplier: { id: number; name: string } | null;
  receipt: { id: number; docNo: string } | null;
  note: string;
  status: 'valid' | 'voided';
  createdByName: string;
  createdAt: string;
  voidReason: string | null;
  voidedByName: string | null;
  voidedAt: string | null;
}
