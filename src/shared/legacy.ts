// 8–10 月旧账只读对照（v0.7.10，飞书需求 RQ-005 收尾，见 docs/LEGACY_LEDGER.md）。
// 四份原始 Excel 导入只读表，不进正式账、不参与 11 月起的统计；核验口径照「账目问题清单」的做法。

export const LEGACY_SOURCES = ['purchase_ledger', 'material_detail', 'ordered_materials', 'brand_requests'] as const;
export type LegacySource = (typeof LEGACY_SOURCES)[number];

export const LEGACY_SOURCE_LABELS: Record<LegacySource, string> = {
  purchase_ledger: '采购台账',
  material_detail: '采购物资明细表',
  ordered_materials: '已下单物料',
  brand_requests: '品牌新增寻款采购清单',
};

/** 原表一行的原始单元格：表头 → 显示的值（公式写成「=公式 → 结果」） */
export type LegacyRawCells = Record<string, string>;

/** 采购台账第 1 张「费用报销明细表」的一行 */
export interface LegacyLedgerLine {
  rowNo: number;
  seq: string;
  date: string | null;
  /** 原表里写的日期（认不出时看这里） */
  dateText: string;
  /** 「类别」列（实际多是物品名） */
  item: string;
  qtyText: string;
  amountCents: number | null;
  amountFormula: string | null;
  merchant: string;
  purpose: string;
  invoice: string;
  note: string;
  /** 金额格与上面第几行合并（金额算在那一行） */
  mergedInto: number | null;
  /** 表头下面、序号 1 之前的行：单列，不计入合计（与账目问题清单一致） */
  preHeader: boolean;
  raw: LegacyRawCells;
}

/** 采购台账第 2 张「付款台账」的一个付款日 */
export interface LegacyPaymentDay {
  rowNo: number;
  date: string | null;
  dateText: string;
  advanceCents: number | null;
  advanceFormula: string | null;
  shouldReturnCents: number | null;
  shouldReturnFormula: string | null;
  returnedCents: number | null;
  returnedFormula: string | null;
  note: string;
  raw: LegacyRawCells;
}

/** 采购物资明细表的一行（8 月、9 月、10 月……每月一张表） */
export interface LegacyMaterialLine {
  sheet: string;
  rowNo: number;
  seq: string;
  date: string | null;
  dateText: string;
  item: string;
  purpose: string;
  amountCents: number | null;
  amountFormula: string | null;
  boughtText: string;
  boughtMilli: number | null;
  receivedText: string;
  receivedMilli: number | null;
  department: string;
  invoice: string;
  taxText: string;
  /** 税点（万分之几）：0.13 → 1300 */
  taxRateBp: number | null;
  /** 「备注（办公费、固定资产、低值易耗等）」列，实际是费用科目 */
  category: string;
  mergedInto: number | null;
  raw: LegacyRawCells;
}

/** 已下单物料的一行 */
export interface LegacyOrderedLine {
  sheet: string;
  rowNo: number;
  date: string | null;
  dateText: string;
  product: string;
  /** 导入后的图片编号；页面用 /api/erp/legacy/images/:id 看原图 */
  imageId: number | null;
  /** 图片格与上面一行合并（同一张图） */
  imageShared: boolean;
  variant: string;
  department: string;
  orderer: string;
  qtyText: string;
  qtyMilli: number | null;
  amountCents: number | null;
  amountFormula: string | null;
  note: string;
  mergedInto: number | null;
  raw: LegacyRawCells;
}

/** 品牌新增寻款采购清单的一行 */
export interface LegacyBrandLine {
  rowNo: number;
  seq: string;
  ordered: boolean;
  received: boolean;
  returned: boolean;
  product: string;
  purpose: string;
  qtyText: string;
  qtyMilli: number | null;
  note: string;
  details: string;
  linkText: string;
  linkUrl: string;
  raw: LegacyRawCells;
}

export interface LegacyImport {
  id: number;
  source: LegacySource;
  fileName: string;
  sha256: string;
  status: 'active' | 'voided';
  /** 每张表：名称、表格里写出来的行数（含空行）、表头在第几行、导入的行数 */
  sheets: { name: string; rowElements: number; headerRow: number; rows: number }[];
  /** 表里自带的合计行（付款台账的「合计」）：列名 → 分 */
  fileTotals: Record<string, number>;
  importedByName: string;
  importedAt: string;
  voidedByName: string | null;
  voidedAt: string | null;
  voidReason: string | null;
}

/** 核验里的一行原表引用（点开看原表） */
export interface LegacyRowRef {
  source: LegacySource;
  sheet: string;
  rowNo: number;
  text: string;
}

export interface LegacyFinding {
  key: string;
  title: string;
  /** 结论（带金额、行数） */
  detail: string;
  /** 涉及的行数（没有就是 null） */
  count: number | null;
  rows: LegacyRowRef[];
}

export interface LegacyDailyRow {
  date: string;
  advanceCents: number;
  spendCents: number;
  shouldReturnCents: number;
  returnedCents: number;
  /** 打款 − 当日台账支出 − 应退回 */
  diffCents: number;
  state: 'balanced' | 'tail' | 'unbalanced';
}

export interface LegacyOverviewRow {
  source: LegacySource;
  label: string;
  rows: number;
  period: string;
  amountText: string;
  problems: string;
}

export interface LegacyRuleResult {
  no: number;
  title: string;
  /** 旧账上的结果 */
  result: string;
  /** 有几条问题；旧账核对不了时为 null */
  count: number | null;
  rows: LegacyRowRef[];
}

export interface LegacyAudit {
  /** 已导入哪几份表（缺的那几份相关的核验写「未导入」） */
  imported: LegacySource[];
  overview: LegacyOverviewRow[];
  crossChecks: LegacyFinding[];
  daily: {
    days: LegacyDailyRow[];
    unbalanced: number;
    tail: number;
    /** 打款为 0 但当天有支出的日子 */
    zeroAdvanceWithSpend: string[];
  } | null;
  fieldIssues: LegacyFinding[];
  rules: LegacyRuleResult[];
}

/** 核验口径的常数（与账目问题清单一致，待确认） */
export const LEGACY_RULES = {
  /** 台账「金额」负数：绝对值大于它推定为打款，小于它推定为退款，等于它单列 */
  payoutThresholdCents: 100_000,
  /** 每日平账：差额绝对值小于它算尾差、记平 */
  tailToleranceCents: 100,
} as const;

/** 台账一行推定的类型（只标「推定」，不改原值） */
export type LegacyLedgerKind = 'pre_header' | 'no_amount' | 'expense' | 'refund' | 'payout' | 'unclear';
export const LEGACY_LEDGER_KIND_LABELS: Record<LegacyLedgerKind, string> = {
  pre_header: '表头下的金额',
  no_amount: '没有金额',
  expense: '支出',
  refund: '退款（推定）',
  payout: '打款（推定）',
  unclear: '无法判断',
};

export function legacyLedgerKind(l: Pick<LegacyLedgerLine, 'preHeader' | 'amountCents'>): LegacyLedgerKind {
  if (l.preHeader) return 'pre_header';
  if (l.amountCents === null) return 'no_amount';
  if (l.amountCents >= 0) return 'expense';
  const abs = -l.amountCents;
  if (abs > LEGACY_RULES.payoutThresholdCents) return 'payout';
  if (abs < LEGACY_RULES.payoutThresholdCents) return 'refund';
  return 'unclear';
}
