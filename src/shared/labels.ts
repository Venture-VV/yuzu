import type { DeductionRule } from './deduction';
import type { Role } from './permissions';

export const PAYMENT_METHODS = ['wechat', 'alipay', 'cash', 'bank_card', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  wechat: '微信',
  alipay: '支付宝',
  cash: '现金',
  bank_card: '银行卡',
  other: '其他',
};

export const ROLE_LABELS: Record<Role, string> = {
  owner: '店主',
  clerk: '店员',
};

export const DEDUCTION_RULE_LABELS: Record<DeductionRule, { title: string; description: string }> = {
  principal_first: { title: '先本金，后赠金', description: '本金扣完后再使用赠金。' },
  bonus_first: { title: '先赠金，后本金', description: '赠金扣完后再使用本金。' },
  proportional: { title: '按比例扣除', description: '按当前本金与赠金的比例同时扣除，零头计入本金。' },
};

export type EntryType = 'recharge' | 'consume' | 'reversal';

export const ENTRY_TYPE_LABELS: Record<EntryType, string> = {
  recharge: '充值',
  consume: '消费',
  reversal: '撤销',
};

export const REVERSAL_REASONS = ['项目选错', '金额录入错误', '会员选错', '重复登记', '顾客取消消费'] as const;

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** "2026-10-25" → { md: "10月25日", weekday: "周日" } */
export function describeDate(isoDate: string): { md: string; weekday: string; full: string } {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? '';
  return { md: `${m}月${d}日`, weekday, full: `${y}年${m}月${d}日` };
}

/** 在 ISO 日期上加减天数。 */
export function shiftDate(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

export function maskPhone(phone: string): string {
  return phone.length === 11 ? `${phone.slice(0, 3)} **** ${phone.slice(7)}` : phone;
}

export function formatPhone(phone: string): string {
  return phone.length === 11 ? `${phone.slice(0, 3)} ${phone.slice(3, 7)} ${phone.slice(7)}` : phone;
}
