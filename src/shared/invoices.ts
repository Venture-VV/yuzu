// 进项发票台账（8.0.3，docs/BUDGET_INVOICES.md 第 3 节，默认 BI07–BI12 待确认）：在 v0.7.32 的发票登记上扩。
// 台账里有三单匹配登记的供应商发票、报销单上的专票普票、财务在台账里直接登记的；记认证状态与所属期、照片，
// 认证期限到期前几天进待办，异常票（重号、税额不符、税率不符、超过认证期限、金额不符、开票方未填）只标记、不拦。

export type CertStatus = 'pending' | 'certified' | 'not_required';
export const CERT_STATUSES = ['pending', 'certified', 'not_required'] as const;
export const CERT_STATUS_LABELS: Record<CertStatus, string> = { pending: '待认证', certified: '已认证', not_required: '不用认证' };

export type InvoiceSource = 'three_way' | 'expense' | 'manual';
export const INVOICE_SOURCE_LABELS: Record<InvoiceSource, string> = { three_way: '三单（货款）', expense: '报销', manual: '台账登记' };

export type InvoiceAnomaly = 'duplicate_no' | 'tax_mismatch' | 'rate_not_allowed' | 'cert_overdue' | 'amount_mismatch' | 'issuer_missing';
export const INVOICE_ANOMALY_LABELS: Record<InvoiceAnomaly, string> = {
  duplicate_no: '重号',
  tax_mismatch: '税额不符',
  rate_not_allowed: '税率不符',
  cert_overdue: '超过认证期限',
  amount_mismatch: '与报销金额不符',
  issuer_missing: '开票方未填',
};

/** 每张发票最多挂几份照片或 PDF（与收货附件一样） */
export const MAX_INVOICE_ATTACHMENTS = 9;
/** 一次标认证最多几张 */
export const CERT_BATCH_MAX = 200;
/** 所属期：YYYY-MM */
export const CERT_PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 价税合计按税率算出的税额：价税合计 × 税率 ÷ (1 + 税率)，四舍五入到分 */
export function expectedTaxCents(totalCents: number, taxRateBp: number): number {
  return Math.round((totalCents * taxRateBp) / (10_000 + taxRateBp));
}

/** 号码比对用：去掉空白、转大写 */
export const normalizeInvoiceNo = (no: string) => no.replace(/\s/g, '').toUpperCase();

export interface InvoiceAttachment {
  id: number;
  kind: 'image' | 'pdf';
  name: string;
  url: string;
  sizeBytes: number;
  uploadedByName: string;
  uploadedAt: string;
}

export interface InputInvoice {
  id: number;
  invoiceNo: string;
  /** 发票类型的键与登记时的名称（专票、普票……） */
  kind: string;
  kindLabel: string;
  supplier: { id: number; name: string } | null;
  /** 开票方：有供应商的是供应商名称，否则是登记时填的（没填为空） */
  issuerName: string;
  invoiceDate: string;
  totalCents: number;
  taxCents: number;
  taxRateBp: number;
  source: InvoiceSource;
  status: 'valid' | 'voided';
  note: string;
  certStatus: CertStatus;
  /** 已认证的所属期（YYYY-MM） */
  certPeriod: string | null;
  certNote: string;
  certByName: string | null;
  certAt: string | null;
  /** 认证状态的版本：标认证时带上，对不上（别人刚改过）拒绝 */
  certVersion: number;
  /** 认证期限（待认证、规则设了期限的）；不用认证、已认证、没设期限的为空 */
  certDueDate: string | null;
  /** 离认证期限还有几天（过了是负数） */
  certDueInDays: number | null;
  /** 关联的报销单：有效的那张，没有有效的取最近一张 */
  claim: { id: number; docNo: string; status: import('./expenses').ClaimStatus; amountCents: number } | null;
  /** 三单匹配分到的采购单 */
  pos: { id: number; docNo: string; amountCents: number }[];
  attachmentCount: number;
  anomalies: InvoiceAnomaly[];
  createdByName: string;
  createdAt: string;
  voidedByName: string | null;
  voidedAt: string | null;
  voidReason: string | null;
}

export interface InputInvoiceDetail extends InputInvoice {
  attachments: InvoiceAttachment[];
}

export type InvoiceView = 'all' | 'pending' | 'due' | 'certified' | 'not_required' | 'anomaly' | 'voided';
export const INVOICE_VIEW_LABELS: Record<InvoiceView, string> = {
  all: '全部有效',
  pending: '待认证',
  due: '认证将到期',
  certified: '已认证',
  not_required: '不用认证',
  anomaly: '异常票',
  voided: '已作废',
};

export interface InvoiceLedger {
  /** 按开票日从新到旧，最多 1000 张（导出最多 5 万张） */
  invoices: InputInvoice[];
  /** 这个视图里还有更多（只列出最新的）：缩短日期范围或导出 */
  truncated: boolean;
  /** 页面上方的数字（有效的发票） */
  counts: { pending: number; due: number; anomaly: number };
  rules: { certifyDays: number; remindDays: number; taxToleranceCents: number };
}

/** ERP 导航「发票台账」的数字：认证期限到期前几天以内（含已过期）的待认证发票 */
export interface InvoiceTodo {
  due: number;
  overdue: number;
}
