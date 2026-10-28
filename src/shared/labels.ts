import type { DeductionRule } from './deduction';
import type { Duty, Role } from './permissions';

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
  store_manager: '店总',
  duty_manager: '值班经理',
  clerk: '前台店员',
  backoffice: '后勤人员',
};

export const ROLE_HINTS: Record<Role, string> = {
  owner: '全部权限',
  store_manager: '值班经理的全部权限，另可自定赠金、管理套餐与项目、查看审计、当场授权超过单笔上限（待确认）',
  duty_manager: '店员权限，另可撤销消费、更正他人或超时的前台录入、维护手牌、看历史与导出、确认日结（待确认）',
  clerk: '会员查找、充值、消费、当日流水、前台接待与挂账',
  backoffice: '没有会员与储值权限，只按职责处理库存与采购',
};

export const DUTY_LABELS: Record<Duty, { title: string; hint: string }> = {
  stock: { title: '物资经办', hint: '期初、收货、领用、退回、耗用、报损申请、盘点录入' },
  purchase: { title: '采购经办', hint: '维护档案、编制采购单、跟进价格与到货' },
  payable: { title: '对账付款', hint: '核对货款、登记期初未付与实际付款' },
  approve: { title: '库存采购负责人', hint: '确认采购、报损、盘点调整、退货、付款与冲销' },
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

/** 时长：整天按「N 天」，其余按「N 小时」 */
export function describeHours(hours: number): string {
  return hours % 24 === 0 ? `${hours / 24} 天` : `${hours} 小时`;
}

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
