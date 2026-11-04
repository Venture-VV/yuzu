// 数据看板（v0.6.0，同事在测试服的反馈）：按岗位分三页——
//   · 今日（值班经理、收银）：在店、今日营业额与收款、分时结账与到店、部门构成、在店最久的客人、当班中；
//   · 经营总览（总经理：店主、店总）：任选时段的营业额、客流、客单价、收款与部门构成、热门项目、到店时段，与上一时段环比；
//   · 会员总览（客户经理）：储值余额、新增与渠道、活跃与沉睡、等级分布、充值排行、赠金到期、待跟进的沉睡会员。
// 口径与日结一致：营业额按营业日，当日结账的计入、当日反结账的冲回；净营业额 = 应收 − 优惠 / 免单 − 券抵扣 − 退款（v0.7.20）。

import type { CheckoutMethod } from './checkout';

export const MAX_REPORT_DAYS = 366;

/** 常用时段（营业日） */
export const REPORT_PRESETS = ['today', 'yesterday', 'last7', 'last30', 'month', 'lastMonth'] as const;
export type ReportPreset = (typeof REPORT_PRESETS)[number];
export const REPORT_PRESET_LABELS: Record<ReportPreset, string> = {
  today: '今天',
  yesterday: '昨天',
  last7: '近 7 天',
  last30: '近 30 天',
  month: '本月',
  lastMonth: '上月',
};

export interface PeriodKpis {
  /** 应收（结账 − 反结账） */
  receivable: number;
  /** 优惠 / 免单（当场授权） */
  discount: number;
  /** 券抵扣（v0.7.20，结账用的券；是优惠，在「优惠」下单列） */
  coupon: number;
  /** 会员折扣（v0.7.25，结账时自动算；口径同券抵扣） */
  memberDiscount: number;
  /** 退款单（v0.7.20，离店后部分退款，按退款的营业日） */
  refund: number;
  /** 净营业额 = 应收 − 优惠 − 券抵扣 − 会员折扣 − 退款 */
  net: number;
  /** 结账客人（手牌每位 1 人，桌台按开台人数） */
  guests: number;
  checkouts: number;
  /** 客单价 = 净营业额 / 结账客人（分，四舍五入） */
  perGuest: number;
  rechargePaid: number;
  rechargeCount: number;
  /** 储值退回（v0.7.26）：退的本金与张数；净充值 = 充值实收 − 储值退回 */
  memberRefund: number;
  memberRefundCount: number;
  /** 储值消费（会员工作台与结账用储值，撤销的不计） */
  walletConsumed: number;
  newMembers: number;
}

export interface ExecutiveReport {
  from: string;
  to: string;
  days: number;
  /** 上一时段（同样天数，紧挨着之前） */
  prevFrom: string;
  prevTo: string;
  kpis: PeriodKpis;
  prev: PeriodKpis;
  trend: { date: string; net: number; guests: number; rechargePaid: number }[];
  byMethod: { method: CheckoutMethod; amount: number }[];
  tickets: { name: string; count: number; amount: number }[];
  /** 部门（项目分类）构成：结账时记下的快照（v0.7.6），反结账的冲回 */
  departments: DepartmentRevenue[];
  topItems: { name: string; category: string; quantity: number; amount: number }[];
  /** 到店时段：各小时接待的人数（撤销误开的不计） */
  arrivals: { hour: number; count: number }[];
}

export interface MemberBrief {
  id: number;
  memberNo: string;
  name: string;
  phoneTail: string;
  balance: number;
  /** 档阶，例如「L3 观澜 · 享」 */
  levelName: string;
  lastActivityAt: string | null;
}

export interface MembersReport {
  from: string;
  to: string;
  totals: { members: number; withBalance: number; principal: number; bonus: number; frozen: number };
  /** 有余额的会员按最近一次余额变动分：30 天内、31–90 天、90 天以上没来（沉睡） */
  activity: { active30: number; active90: number; dormant: number; dormantBalance: number };
  period: { newMembers: number; rechargePaid: number; rechargeCount: number; rechargeMembers: number; memberRefund: number; memberRefundCount: number; walletConsumed: number; consumeMembers: number };
  newByChannel: { channel: string | null; label: string; count: number }[];
  allByChannel: { channel: string | null; label: string; count: number }[];
  /** 档级分布 L0–L6（会员体系 v2；19 个状态的分布见后台「会员体系」看板） */
  levels: { level: number; name: string; count: number; balance: number }[];
  topBalance: MemberBrief[];
  topRecharge: (MemberBrief & { paid: number })[];
  /** 90 天以上没来、余额最高的会员（客户经理回访） */
  dormantList: MemberBrief[];
  /** 未来 30 天到期的赠金 */
  bonusExpiring: { amount: number; members: number };
}

/**
 * 部门营业额（v0.7.6）：结账时按明细记下的快照，以后改价目、改分类不影响已结的单。
 * amount 是应收（明细金额），discount 是按金额比例分摊到这个部门的优惠 / 免单，净额 = amount − discount
 */
export interface DepartmentRevenue {
  category: string;
  /** 份数（退款单退的份数已减去） */
  quantity: number;
  /** 应收 */
  amount: number;
  /** 分摊到这个部门的优惠 / 免单与券抵扣 */
  discount: number;
  /** 退款单退的金额（v0.7.20，按退款的营业日）；净额 = 应收 − 优惠 − 退款 */
  refund: number;
}

/** 今日看板追加的值班数据 */
export interface DutyExtras {
  /** 各小时的结账张数与接待人数（营业日从切换时刻起算） */
  hourly: { hour: number; checkouts: number; arrivals: number }[];
  departments: DepartmentRevenue[];
  /** 在店最久的客人（前 8 位）；没有「查看在店手牌」权限的岗位为 null（v0.7.1） */
  longStays: { visitId: number; tagCode: string; guest: string; checkedInAt: string; amountCents: number }[] | null;
}
