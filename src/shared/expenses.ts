// 费用报销与备用金（v0.7.7，飞书需求 RQ-005 第一步，见 docs/EXPENSES.md）。
// 金额为整数「分」，数量为千分之一单位，税点为万分之一（1300 = 13%）。

import type { ApprovalBrief } from './approvals';
import type { PayMethod } from './purchasing';

export const EXPENSE_CATEGORIES = ['office', 'fixed_asset', 'low_value', 'freight'] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
/** 费用科目：办公费、固定资产、低值易耗（飞书需求原话，不能自由填写）；v0.7.12 加「运费」（#15：运费单独记费用，不进物料成本） */
export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = { office: '办公费', fixed_asset: '固定资产', low_value: '低值易耗', freight: '运费' };

export const PAY_SOURCES = ['petty', 'company'] as const;
export type PaySource = (typeof PAY_SOURCES)[number];
export const PAY_SOURCE_LABELS: Record<PaySource, string> = { petty: '备用金', company: '公司直付' };

export type ClaimStatus = 'submitted' | 'returned' | 'confirmed' | 'cancelled' | 'voided';
export const CLAIM_STATUS_LABELS: Record<ClaimStatus, string> = {
  submitted: '待确认',
  returned: '已退回',
  confirmed: '已确认',
  cancelled: '已撤回',
  voided: '已冲销',
};

export type SettlementKind = 'return' | 'topup';
export const SETTLEMENT_KIND_LABELS: Record<SettlementKind, string> = { return: '退回', topup: '补付' };

export type SupplierSettlement = 'credit' | 'cash';
export const SUPPLIER_SETTLEMENT_LABELS: Record<SupplierSettlement, { title: string; hint: string }> = {
  credit: { title: '挂账', hint: '月结或按批次结算：收货记应付，在「应付货款」里付款核销' },
  cash: { title: '现付', hint: '下单时由经办人用备用金或公司账户付清：收货不记应付，货款走费用报销' },
};

export interface InvoiceTypeDef {
  /** 固定的键（登记时存键与当时的名称） */
  key: string;
  label: string;
  /** 必须填发票号码（标了有发票却没有发票号的直接拦下） */
  needsNumber: boolean;
  /** 允许的税点（万分之一） */
  taxRatesBp: number[];
}

export interface ExpenseRules {
  /** 单笔超过这个金额要负责人确认（D13：默认 2000 元，可调） */
  approvalThresholdCents: number;
  /** 打款后超过多少天还没平账标红（12 条自检第 4 条：默认 7 天） */
  overdueDays: number;
  /** 用途（固定选项） */
  purposes: string[];
  invoiceTypes: InvoiceTypeDef[];
}

/** 默认规则（待确认）：店主在 ERP「模块设置」里改 */
export const DEFAULT_EXPENSE_RULES: ExpenseRules = {
  approvalThresholdCents: 200_000,
  overdueDays: 7,
  purposes: ['客用消耗', '员工用品', '办公', '维修保养', '装修改造', '营销活动', '餐饮原料', '其他'],
  invoiceTypes: [
    { key: 'vat_special', label: '增值税专用发票', needsNumber: true, taxRatesBp: [100, 300, 600, 900, 1300] },
    { key: 'vat_normal', label: '增值税普通发票', needsNumber: true, taxRatesBp: [0, 100, 300, 600, 900, 1300] },
    { key: 'receipt', label: '收据', needsNumber: false, taxRatesBp: [0] },
    { key: 'none', label: '无票', needsNumber: false, taxRatesBp: [0] },
  ],
};

/** 1300 → 13%，150 → 1.5%，0 → 0 */
export function taxRateText(bp: number): string {
  if (bp === 0) return '0';
  const s = (bp / 100).toFixed(2).replace(/\.?0+$/, '');
  return `${s}%`;
}

export interface StaffRef {
  id: number;
  name: string;
}

export interface ExpenseClaimLine {
  lineNo: number;
  name: string;
  category: ExpenseCategory;
  unit: string;
  boughtMilli: number;
  receivedMilli: number;
  diffReason: string;
  amountCents: number;
  poLineId: number | null;
  materialId: number | null;
}

export interface ExpenseClaimSummary {
  id: number;
  docNo: string;
  status: ClaimStatus;
  expenseDate: string;
  department: { id: number; name: string };
  handler: StaffRef;
  purpose: string;
  paySource: PaySource;
  advance: { id: number; docNo: string } | null;
  invoiceType: string;
  invoiceLabel: string;
  taxRateBp: number;
  invoiceNo: string;
  purchaseOrder: { id: number; docNo: string; supplierName: string } | null;
  /** 采购途径（v0.7.29，E1）：按采购单报销的照采购单；没记的为空 */
  channel: import('./purchasing').ChannelRef | null;
  amountCents: number;
  needsApproval: boolean;
  /** 前几行的名称，列表里显示 */
  summary: string;
  createdByName: string;
  createdAt: string;
}

export interface ExpenseClaim extends ExpenseClaimSummary {
  note: string;
  createdBy: number;
  confirmedByName: string | null;
  confirmedAt: string | null;
  returnedReason: string | null;
  voidedByName: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  isSynthetic: boolean;
  lines: ExpenseClaimLine[];
  approvals: { id: number; action: string; actorName: string; reason: string; createdAt: string }[];
  /** 审批中心（v0.7.30）：在审的审批单，没有在审的取最近一张；从没走过审批中心的为空 */
  approval: ApprovalBrief | null;
  /** 按采购单报销的：采购单已生效的收货单与附件（8.0.1，CG11）；按次报销的为空 */
  receipts: PoReceiptRef[];
}

export interface ExpenseClaimList {
  /** 最近的报销单（最多 2000 张） */
  claims: ExpenseClaimSummary[];
  /** 筛选条件下各状态的合计（按全部单据算，不受列表张数限制） */
  totals: { confirmedCents: number; pendingCents: number; count: number };
  /** 列表没有显示全部（合计仍按全部算） */
  truncated: boolean;
}

/** 一笔打款的平账；只算已确认的报销 */
export interface PettyBalance {
  advanceCents: number;
  /** 支出：用这笔钱、已确认的报销 */
  spentCents: number;
  /** 待确认的报销（确认后才算进支出） */
  pendingCents: number;
  /** 应退回 = 打款 − 支出 */
  dueCents: number;
  /** 实际退回 = 退回 − 补付 */
  settledCents: number;
  /** 未退回 = 应退回 − 实际退回（> 0 经办人手里还有钱；< 0 经办人垫了钱，等公司补付） */
  outstandingCents: number;
  /** settled 已平；open 未退回（未超期）；overdue 超期未退；owed 待补付 */
  state: 'settled' | 'open' | 'overdue' | 'owed';
  /** 从打款日起的天数 */
  ageDays: number;
}

export interface PettyAdvanceSummary extends PettyBalance {
  id: number;
  docNo: string;
  status: 'active' | 'voided';
  advanceDate: string;
  department: { id: number; name: string };
  handler: StaffRef;
  method: PayMethod;
  evidence: string;
}

export interface PettySettlement {
  id: number;
  docNo: string;
  kind: SettlementKind;
  status: 'active' | 'voided';
  settleDate: string;
  amountCents: number;
  method: PayMethod;
  evidence: string;
  note: string;
  createdByName: string;
  createdAt: string;
  voidedByName: string | null;
  voidReason: string | null;
}

export interface PettyAdvance extends PettyAdvanceSummary {
  note: string;
  createdByName: string;
  createdAt: string;
  voidedByName: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  isSynthetic: boolean;
  claims: ExpenseClaimSummary[];
  settlements: PettySettlement[];
}

/** 每日平账：按付款日（打款日期）与部门汇总 */
export interface PettyDailyRow {
  date: string;
  department: { id: number; name: string };
  advanceCents: number;
  spentCents: number;
  pendingCents: number;
  dueCents: number;
  settledCents: number;
  outstandingCents: number;
  /** 当天有一笔没平就整天未平；有超期的标 overdue */
  state: PettyBalance['state'];
  advances: PettyAdvanceSummary[];
}

export interface PettyDaily {
  from: string;
  to: string;
  rows: PettyDailyRow[];
  totals: Omit<PettyDailyRow, 'date' | 'department' | 'state' | 'advances'>;
  /** 每个部门目前没平的（不限日期范围）：经办人手里的钱与待补付 */
  openByDepartment: { department: { id: number; name: string }; outstandingCents: number; owedCents: number; overdue: number; open: number }[];
}

/** 可以按采购单报销的采购单（现付供应商、已确认或已关闭） */
export interface PoCandidate {
  id: number;
  docNo: string;
  supplierName: string;
  orderDate: string;
  status: string;
  totalCents: number;
  /** 还没报销的行数 */
  openLines: number;
}

/** 采购单已生效的收货单与附件（8.0.1 采购组整改 11，CG11）：转报销、报销单上看 */
export interface PoReceiptRef {
  id: number;
  docNo: string;
  docDate: string;
  attachments: import('./inventory').ReceiptAttachment[];
}

export interface PoForClaim {
  id: number;
  docNo: string;
  supplierName: string;
  orderDate: string;
  /** 已生效的收货单与附件（8.0.1） */
  receipts: PoReceiptRef[];
  /** 采购单的采购途径（v0.7.29）：报销照它记 */
  channel: import('./purchasing').ChannelRef | null;
  lines: {
    poLineId: number;
    materialId: number;
    name: string;
    /** 库存单位（购买、到货数量按库存单位） */
    unit: string;
    boughtMilli: number;
    receivedMilli: number;
    amountCents: number;
    /** 已经在有效的报销单里（不能再报） */
    claimedBy: string | null;
  }[];
}

// ───────────────────────── 采购单一键转报销（v0.7.29 ERP 采购五项②，docs/ERP_PURCHASING.md 第 3 节） ─────────────────────────

/** 待报销：现付、已确认或已关闭、还有没报销的行的采购单 */
export interface ToClaimPo {
  id: number;
  docNo: string;
  supplierName: string;
  channel: import('./purchasing').ChannelRef | null;
  orderDate: string;
  status: 'approved' | 'closed';
  backfill: boolean;
  /** 采购单的编制人（转报销时默认的经办人） */
  createdBy: StaffRef;
  /** 关联需求单的部门；没有的取编制人档案的部门 */
  departments: string[];
  totalCents: number;
  /** 还没报销的行与金额（按采购单金额） */
  openLines: number;
  lineCount: number;
  openCents: number;
  receiving: import('./purchasing').ReceivingState;
  /** 已生效的收货单与附件份数（8.0.1 采购组整改 11：收货生效后推送到待报销，标「已收货」） */
  receipts: { id: number; docNo: string; docDate: string; attachmentCount: number }[];
  /** 下单后过了几天 */
  ageDays: number;
}

/** 转报销时带出的默认值（E2）：人只核对、改不一样的 */
export interface ClaimPrefill {
  departmentId: number | null;
  handlerId: number | null;
  purpose: string | null;
  invoiceType: string | null;
  taxRateBp: number | null;
  paySource: PaySource;
  advanceId: number | null;
  /** 每行（采购单行）的费用科目 */
  categories: Record<number, ExpenseCategory>;
  /** 各项是按什么带出的（页面上提示） */
  basis: string[];
}

/** 采购单上的报销情况（采购单详情显示，v0.7.29） */
export interface PoReimbursement {
  /** 这张采购单的结算方式（第一张收货定下的；还没收货的按供应商当前的） */
  settlement: SupplierSettlement;
  claims: { id: number; docNo: string; status: ClaimStatus; amountCents: number; expenseDate: string }[];
  /** 还没在有效报销单里的行 */
  unclaimedLines: number;
}

// ───────────────────────── 部门备用金台账（v0.7.29 ERP 采购五项③，docs/ERP_PURCHASING.md 第 4 节） ─────────────────────────

/** 部门备用金看板的一行（E3）：余额 = 有效打款 − 用备用金的已确认报销 − 退回 + 补付（= 各笔打款的未退回之和） */
export interface PettyAccountRow {
  department: { id: number; name: string; active: boolean };
  custodian: StaffRef | null;
  /** 定额（可空） */
  limitCents: number | null;
  note: string;
  /** 设置的版本号；0 = 还没设过 */
  version: number;
  balanceCents: number;
  /** 在手：没平的打款里还在经办人手里的 */
  inHandCents: number;
  /** 待补付：经办人垫了、等公司补的 */
  owedCents: number;
  /** 用备用金、还没确认的报销（确认后才算支出） */
  pendingCents: number;
  /** 本月（自然月）已确认的支出 */
  monthSpentCents: number;
  openAdvances: number;
  overdue: number;
  /** 建议补足 = 定额 − 余额（设了定额、余额不到定额时） */
  topUpCents: number | null;
  lastDate: string | null;
}

export type PettyJournalKind = 'advance' | 'expense' | 'return' | 'topup';
export const PETTY_JOURNAL_LABELS: Record<PettyJournalKind, string> = { advance: '打款', expense: '支出', return: '退回', topup: '补付' };

export interface PettyJournalEntry {
  kind: PettyJournalKind;
  date: string;
  docNo: string;
  /** 打款、报销单、退回补付单的编号（打开详情用） */
  refId: number;
  advanceId: number;
  advanceNo: string;
  handler: StaffRef;
  /** 打款、退回、补付：方式与凭据；支出：用途 */
  description: string;
  /** 支出：明细 */
  items: { name: string; boughtMilli: number; unit: string; amountCents: number }[];
  channel: string | null;
  poNo: string | null;
  /** 进为正（打款、补付），出为负（支出、退回） */
  deltaCents: number;
  /** 这一笔之后的余额 */
  balanceCents: number;
}

export interface PettyJournal {
  department: { id: number; name: string };
  from: string;
  to: string;
  custodian: StaffRef | null;
  limitCents: number | null;
  /** 期初余额（开始日期之前的） */
  openingCents: number;
  entries: PettyJournalEntry[];
  closingCents: number;
  inCents: number;
  outCents: number;
  /** 用备用金、还没确认的报销（不算进余额） */
  pending: ExpenseClaimSummary[];
  /** 逐笔只显示前 3000 笔（期末余额仍按全部算） */
  truncated: boolean;
}
