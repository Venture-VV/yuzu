// 每月盘点与供应商对账的提醒、对账登记（#23，v0.7.13，见 docs/STOCK_CYCLES.md）

/** 一个仓本月的盘点进度：月初有结存的物料里，本月的盘点单（已提交或已生效）盘到了几种 */
export interface StocktakeProgress {
  warehouseId: number;
  warehouseName: string;
  kind: 'central' | 'department';
  departmentId: number | null;
  /** 月初（1 号 0 点）有结存、要盘的物料种数（部门小仓不含台面日耗品） */
  required: number;
  /** 本月已经盘到的 */
  counted: number;
  done: boolean;
  /** 还没盘到的物料（最多 30 种） */
  missing: { materialId: number; code: string; name: string; bookMilli: number; inventoryUnit: string; decimals: number }[];
}

export interface StocktakeReminders {
  today: string;
  /** 本月，YYYY-MM */
  month: string;
  /** 本月从哪天起提醒（盘点日）、从哪天起标红 */
  startDate: string;
  dueDate: string;
  /** 今天在不在提醒期（盘点日到月底） */
  active: boolean;
  overdue: boolean;
  warehouses: StocktakeProgress[];
}

/** 对账提醒的状态：还没登记 / 登记以后数字又变了 */
export type ReconState = 'pending' | 'changed';

export interface MonthlyReconItem {
  supplierId: number;
  supplierCode: string;
  supplierName: string;
  /** 要对的月份，YYYY-MM */
  month: string;
  /** 那个月月底的余额（现在算的） */
  endCents: number;
  state: ReconState;
  reconciliationId: number | null;
}

export interface BatchReconItem {
  supplierId: number;
  supplierCode: string;
  supplierName: string;
  docId: number;
  docNo: string;
  docDate: string;
  amountCents: number;
  /** 这张收货单从哪天起标红 */
  dueDate: string;
  overdue: boolean;
  state: ReconState;
  /** 已冲销的收货单（只会出现在「登记以后有变动」里） */
  voided: boolean;
  reconciliationId: number | null;
}

export interface ReconReminders {
  today: string;
  monthly: {
    /** 对的是上个月，YYYY-MM */
    month: string;
    startDate: string;
    dueDate: string;
    active: boolean;
    overdue: boolean;
    items: MonthlyReconItem[];
  };
  batch: BatchReconItem[];
  /** 当前账号能登记哪种（月结：对账付款；按批次：采购经办或对账付款） */
  canMonthly: boolean;
  canBatch: boolean;
}

export interface SupplierReconciliation {
  id: number;
  supplierId: number;
  supplierCode: string;
  supplierName: string;
  kind: 'month' | 'batch';
  /** 月结的月份，YYYY-MM */
  month: string | null;
  /** 月结：登记时对账单的数字 */
  snapshot: {
    beginCents: number;
    openingCents: number;
    receivedCents: number;
    returnCreditCents: number;
    paidCents: number;
    refundedCents: number;
    endCents: number;
  } | null;
  /** 月结：现在同一个月对账单的数字（与登记时不同就是「登记后有变动」） */
  current: SupplierReconciliation['snapshot'];
  totalCents: number;
  /** 按批次：登记的收货单 */
  docs: { docId: number; docNo: string; docDate: string; amountCents: number; status: string }[];
  note: string;
  createdByName: string;
  createdAt: string;
  voided: { byName: string; at: string; reason: string } | null;
  /** 有效的登记，登记后数字又变了 */
  changed: boolean;
  /** 最近一条对账确认链接（8.0.7 2.6）；没生成过的为空 */
  link: ReconLinkState | null;
}

// ───────────────────────── 供应商在线对账确认（8.0.7 2.6） ─────────────────────────

export type ReconReply = 'confirmed' | 'disputed';
export const RECON_REPLY_LABELS: Record<ReconReply, string> = { confirmed: '已确认无误', disputed: '有异议' };

/** 对账确认链接的状态（不含链接原文：只在生成时给一次） */
export interface ReconLinkState {
  id: number;
  createdAt: string;
  createdByName: string;
  expiresAt: string;
  expired: boolean;
  voidedAt: string | null;
  reply: ReconReply | null;
  replyName: string | null;
  replyNote: string;
  repliedAt: string | null;
}

/** 生成链接时的对账单快照（供应商看到的就是这个） */
export interface ReconSnapshot {
  storeName: string;
  supplierName: string;
  kind: 'month' | 'batch';
  /** 月结：YYYY-MM；按批次为空 */
  month: string | null;
  from: string | null;
  to: string | null;
  /** 月结：登记时的数字 */
  totals: SupplierReconciliation['snapshot'];
  totalCents: number;
  /** 单据：月结是这个月的往来（收货、退货、付款……），按批次是登记的收货单 */
  rows: { date: string; docNo: string; kind: string; amountCents: number; note: string }[];
}

/** 供应商打开链接看到的（不用登录） */
export interface ReconPublicView {
  snapshot: ReconSnapshot;
  expiresAt: string;
  reply: ReconReply | null;
  replyName: string | null;
  replyNote: string;
  repliedAt: string | null;
}
