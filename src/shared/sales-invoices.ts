// 8.0.21 开票申请（销项，docs/FINANCE_V8021.md 第 3 节，CW-B / CW2 / CW13–CW15）：前后端共用。

export const INVOICE_SOURCE_TYPES = ['checkout', 'recharge', 'ar_collection'] as const;
export type InvoiceSourceType = (typeof INVOICE_SOURCE_TYPES)[number];
export const INVOICE_SOURCE_LABELS: Record<InvoiceSourceType, string> = { checkout: '结账单', recharge: '会员充值', ar_collection: '协议单位回款' };

export const SALES_INVOICE_STATUSES = ['requested', 'issued', 'rejected', 'voided'] as const;
export type SalesInvoiceStatus = (typeof SALES_INVOICE_STATUSES)[number];
export const SALES_INVOICE_STATUS_LABELS: Record<SalesInvoiceStatus, string> = { requested: '申请中', issued: '已开', rejected: '已驳回', voided: '已作废' };

export type InvoiceTitleType = 'personal' | 'company';
export const INVOICE_TITLE_TYPE_LABELS: Record<InvoiceTitleType, string> = { personal: '个人', company: '单位' };
export type SalesInvoiceKind = 'normal' | 'special';
export const SALES_INVOICE_KIND_LABELS: Record<SalesInvoiceKind, string> = { normal: '普通发票', special: '增值税专用发票' };

/** 税号：统一社会信用代码 18 位，老税号 15、17、20 位，数字与大写字母 */
export const TAX_NO_PATTERN = /^[0-9A-Z]{15,20}$/;

export interface SalesInvoice {
  id: number;
  requestNo: string;
  sourceType: InvoiceSourceType;
  sourceId: number;
  sourceNo: string;
  amountCents: number;
  titleType: InvoiceTitleType;
  title: string;
  taxNo: string;
  email: string;
  phone: string;
  invoiceKind: SalesInvoiceKind;
  note: string;
  status: SalesInvoiceStatus;
  invoiceNo: string | null;
  invoiceDate: string | null;
  hasFile: boolean;
  /** manual 手工开好登记；sending 已交给服务商、还没回来；其余是服务商（mock 为模拟） */
  issuedVia: string | null;
  providerRef: string | null;
  rejectReason: string | null;
  voidReason: string | null;
  version: number;
  requestedByName: string;
  requestedAt: string;
  handledByName: string | null;
  handledAt: string | null;
  voidedByName: string | null;
  voidedAt: string | null;
  /** 来源已反结账、作废（已开的要红冲：作废后重新申请，CW15） */
  sourceVoided: boolean;
}

/** 申请页要的：来源的情况、可开金额、这一笔现在的申请与历史 */
export interface InvoiceSourceInfo {
  type: InvoiceSourceType;
  id: number;
  no: string;
  date: string;
  /** 来源的实收里能开票的部分（CW13） */
  invoiceableCents: number;
  /** 说明可开金额怎么来的（例如「去掉储值 ¥30.00」） */
  basis: string[];
  voided: boolean;
  /** 会员姓名、协议单位名称（单位抬头可以带出来） */
  partyName: string;
  active: SalesInvoice | null;
  history: SalesInvoice[];
}

export interface SalesInvoiceList {
  rows: SalesInvoice[];
  counts: { requested: number; issued: number; sending: number; redFlag: number };
  /** 开票服务商：off 没接；mock 模拟；live 正式（8.0.21 没有） */
  providerMode: 'off' | 'mock' | 'live';
}
