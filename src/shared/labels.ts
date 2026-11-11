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
  account_manager: '客户经理',
  clerk: '前台店员',
  backoffice: '后勤人员',
  other_store: '他店查询',
  tablet: '点餐平板',
};

export const ROLE_HINTS: Record<Role, string> = {
  owner: '全部权限',
  store_manager: '值班经理的全部权限，另可自定赠金、管理套餐与项目、查看审计、当场授权超过单笔上限（待确认）',
  duty_manager: '店员权限，另可撤销消费、更正他人或超时的前台录入、维护手牌、看历史与导出、确认日结（待确认）',
  account_manager: '会员建档与充值、当日流水、会员总览看板、会员体系看板与到期提醒名单；不做前台收银（待确认）',
  clerk: '会员查找、充值、消费、当日流水、前台接待与挂账',
  backoffice: '没有会员与储值权限，只按职责处理库存与采购',
  other_store: '另一家店的同事：只能按手机号或会员号查会员的档阶与会籍到期日，看不到余额与流水（会员体系 v2，待确认）',
  tablet: '放在餐桌上的平板登录用：只能打开点餐页（电子菜单），下单要服务员输点单密码；看不到门店系统别的页面（8.0.10，待确认）',
};

export const DUTY_LABELS: Record<Duty, { title: string; hint: string }> = {
  stock: { title: '物资经办', hint: '期初、收货、领用、退回、耗用、报损申请、盘点录入' },
  purchase: { title: '采购经办', hint: '维护档案、编制采购单、跟进价格与到货' },
  payable: { title: '对账付款', hint: '核对货款、登记期初未付与实际付款' },
  approve: { title: '库存采购负责人', hint: '确认采购、报损、盘点调整、退货、付款与冲销' },
  cost: { title: '成本核算', hint: '登记费用报销（发票、税点、科目）与备用金打款、退回（v0.7.7）' },
  request: { title: '部门申购', hint: '给自己的部门提采购需求单（员工档案里要填所属部门，v0.7.8）' },
  legal: { title: '法务', hint: '合同审查的法务那一级：按审查清单逐条给意见（v0.7.31）' },
};

export const DEDUCTION_RULE_LABELS: Record<DeductionRule, { title: string; description: string }> = {
  principal_first: { title: '先本金，后赠金', description: '本金扣完后再使用赠金。' },
  bonus_first: { title: '先赠金，后本金', description: '赠金扣完后再使用本金。' },
  proportional: { title: '按比例扣除', description: '按当前本金与赠金的比例同时扣除，零头计入本金。' },
};

/** 余额流水的类型；v0.7.26 起还有储值退回、合并转出、合并转入 */
export type EntryType = 'recharge' | 'consume' | 'reversal' | 'expire' | 'opening' | 'opening_void' | 'refund' | 'merge_out' | 'merge_in';

export const ENTRY_TYPES = ['recharge', 'consume', 'reversal', 'expire', 'opening', 'opening_void', 'refund', 'merge_out', 'merge_in'] as const satisfies readonly EntryType[];

export const ENTRY_TYPE_LABELS: Record<EntryType, string> = {
  recharge: '充值',
  consume: '消费',
  reversal: '撤销',
  expire: '赠金过期',
  opening: '期初导入',
  opening_void: '期初作废',
  refund: '储值退回',
  merge_out: '合并转出',
  merge_in: '合并转入',
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
