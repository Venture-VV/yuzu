// 应收与挂账（8.0.7 ERP P2 3.1，docs/ERP_V807.md）：协议单位、结账挂账、回款与核销、平台回款、账龄。

export const AR_METHODS = ['bank_transfer', 'cash', 'wechat', 'alipay', 'other'] as const;
export type ArMethod = (typeof AR_METHODS)[number];
export const AR_METHOD_LABELS: Record<ArMethod, string> = { bank_transfer: '银行转账', cash: '现金', wechat: '微信', alipay: '支付宝', other: '其他' };

/** 账龄分段（天，按挂账的营业日 / 核销日算） */
export const AGING_BUCKETS = [
  { key: 'd30', label: '0–30 天', max: 30 },
  { key: 'd60', label: '31–60 天', max: 60 },
  { key: 'd90', label: '61–90 天', max: 90 },
  { key: 'over', label: '90 天以上', max: Infinity },
] as const;
export type AgingKey = (typeof AGING_BUCKETS)[number]['key'];
export const agingKeyOf = (days: number): AgingKey => AGING_BUCKETS.find((b) => days <= b.max)!.key;

export interface ArAccount {
  id: number;
  code: string;
  name: string;
  contact: string;
  phone: string;
  /** 挂账额度（分）：空 = 不限 */
  creditLimitCents: number | null;
  active: boolean;
  note: string;
  version: number;
  /** 没结清的挂账合计 */
  outstandingCents: number;
  /** 最早一笔没结清的挂账的营业日 */
  oldestOpenDate: string | null;
}

/** 前台结账选协议单位用（只读，不含别的单位的往来） */
export interface ArAccountOption {
  id: number;
  code: string;
  name: string;
  creditLimitCents: number | null;
  outstandingCents: number;
}

export interface ArCharge {
  id: number;
  accountId: number;
  checkoutId: number;
  checkoutNo: string;
  businessDate: string;
  signer: string;
  amountCents: number;
  /** 已核销（没冲销的回款） */
  collectedCents: number;
  status: 'open' | 'voided';
  /** 挂了几天（到今天） */
  ageDays: number;
}

export interface ArCollection {
  id: number;
  docNo: string;
  accountId: number;
  accountName: string;
  collectedOn: string;
  method: ArMethod;
  amountCents: number;
  evidence: string;
  note: string;
  allocations: { chargeId: number; checkoutNo: string; businessDate: string; amountCents: number }[];
  createdByName: string;
  createdAt: string;
  voided: { byName: string; at: string; reason: string } | null;
}

export interface ArAccountDetail {
  account: ArAccount;
  charges: ArCharge[];
  collections: ArCollection[];
}

export interface AgingRow {
  /** 协议单位，或平台（团购） */
  kind: 'account' | 'platform';
  id: string;
  name: string;
  buckets: Record<AgingKey, number>;
  totalCents: number;
  /** 超过提醒天数（V14）的 */
  overdueCents: number;
}

export interface ArAging {
  overdueDays: number;
  rows: AgingRow[];
  totals: Record<AgingKey, number> & { total: number; overdue: number };
}

/** 平台回款：团购券（结账登记的 + 补录的）按核销日，应结 − 平台打款 */
export interface PlatformReceivable {
  platform: string;
  platformLabel: string;
  /** 应结（核销合计） */
  redeemedCents: number;
  /** 平台已打款 */
  settledCents: number;
  /** 还没回来的 */
  outstandingCents: number;
  /** 最早一笔核销日（还有没回来的时） */
  oldestDate: string | null;
}

export interface ArTodo {
  /** 超过 N 天（V14）没回的协议单位挂账笔数与金额 */
  overdueCharges: number;
  overdueCents: number;
  /** 超过 N 天没回的平台应收（金额） */
  platformOverdueCents: number;
}
