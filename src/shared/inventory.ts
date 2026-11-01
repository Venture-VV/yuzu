// 库存与采购：前后端共用的类型与中文名称。数量为 milli（千分之一库存单位），金额为分。

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
  }[];
  suppliers: { id: number; code: string; name: string }[];
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
  /** 结算方式（v0.7.7）：挂账（收货记应付）/ 现付（收货不记应付，货款走费用报销） */
  settlement: import('./expenses').SupplierSettlement;
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
  /** 提醒天数（#22，v0.7.12）：可用天数少于它时提醒；为空时按固定的低库存提醒数量 */
  coverDays: number | null;
  tracked: boolean;
  active: boolean;
  /** 总仓结存 */
  stockMilli: number;
  /** 各部门小仓合计（v0.7.11） */
  deptStockMilli: number;
  /** 总仓低于提醒线：设了提醒天数且有用量的按可用天数，否则按人工设定的数量 */
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
  /** 盘点：记录账面数之后该物料又有收发，需要重新核对 */
  stale: boolean;
  sourceLineId: number | null;
  /** 领用 / 收货行已被退回或退货的数量（已生效 + 待确认） */
  returnedMilli: number;
  /** 单据所在仓的当前结存（详情展示用） */
  stockMilli: number;
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
  amountCents: number;
  noPo: boolean;
  /** 这张单动的仓；领料与退回是部门小仓（另一头是总仓）；迁移前的领料、退回为空（没进部门小仓） */
  warehouse: { id: number; name: string; kind: Warehouse['kind'] } | null;
  /** 急采收货（#19）：没有采购单，进部门小仓，合计不超过登记时的上限 */
  urgent: boolean;
  urgentCapCents: number | null;
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
