// 开单即占用（D37 / D39，v0.7.19，见 docs/FLOORPLAN_FINISH.md 第 1 节）：派对房、宠物轰趴房、娱乐室不派技师，
// 按「有开着的使用单」算在用，结束、使用人结账、撤销来访或撤单后释放。使用人是在店客人（手牌），费用是手牌账单上的普通明细。

/** 开单即占用的业态（后台可改，待确认） */
export const DEFAULT_USAGE_BUSINESS_TYPES = ['派对房', '宠物轰趴房', '娱乐室'] as const;

/**
 * 派对房等的计费（v0.7.28，N2，待确认）：按业态设。房费项目、开台费项目都是价目表里的项目——
 * 房费项目的价格是每小时多少，项目的分类就是部门营业额里的部门；开台费按它的价格收一次（不设就不收）。
 * 用了多久：起步时长以内按起步算，之后每「计费单位」分钟计一次，不足一个单位按一个单位。
 */
export interface UsagePricing {
  feeItemId: number;
  minMinutes: number;
  stepMinutes: number;
  openFeeItemId: number | null;
}

export interface UsageRules {
  /** 按「开单即占用」算的业态（空间台账的业态名） */
  businessTypes: string[];
  /** 按业态的计费（v0.7.28）；没设的业态不收费（与 v0.7.19 一样，场次费由前台另挂） */
  pricing: Record<string, UsagePricing>;
}

export const DEFAULT_USAGE_RULES: UsageRules = { businessTypes: [...DEFAULT_USAGE_BUSINESS_TYPES], pricing: {} };

export const DEFAULT_USAGE_MIN_MINUTES = 60;
export const DEFAULT_USAGE_STEP_MINUTES = 30;
export const USAGE_STEP_OPTIONS = [15, 30, 60] as const;
export const MAX_USAGE_MIN_MINUTES = 600;

/** 计费的分钟数：起步以内按起步，之后按计费单位向上取整 */
export function chargedUsageMinutes(minutes: number, p: Pick<UsagePricing, 'minMinutes' | 'stepMinutes'>): number {
  if (minutes <= p.minMinutes) return p.minMinutes;
  return p.minMinutes + Math.ceil((minutes - p.minMinutes) / p.stepMinutes) * p.stepMinutes;
}

/**
 * 房费：按计费单位记明细（数量 = 几个单位，单价 = 每小时价 × 单位分钟 ÷ 60，四舍五入到分）。
 * 起步时长不是单位的整数倍时，起步按向上取整的单位数算
 */
export function usageFee(minutes: number, p: Pick<UsagePricing, 'minMinutes' | 'stepMinutes'>, hourPrice: number) {
  const charged = chargedUsageMinutes(minutes, p);
  const steps = Math.ceil(charged / p.stepMinutes);
  const unitPrice = Math.round((hourPrice * p.stepMinutes) / 60);
  return { chargedMinutes: steps * p.stepMinutes, steps, unitPrice, amount: unitPrice * steps };
}

export const MAX_USAGE_GUESTS = 99;
export const MAX_USAGE_NOTE = 100;

export const USAGE_STATUSES = ['open', 'closed', 'cancelled'] as const;
export type UsageStatus = (typeof USAGE_STATUSES)[number];

/** 怎么结束的：手动结束 / 使用人结账 / 撤销来访 / 开错了撤单 */
export const USAGE_CLOSE_KINDS = ['end', 'checkout', 'visit_cancel', 'cancel'] as const;
export type UsageCloseKind = (typeof USAGE_CLOSE_KINDS)[number];

/** 一张使用单（只带手牌号，不带会员姓名、手机号） */
export interface UsageDetail {
  id: number;
  usageNo: string;
  spaceId: number;
  spaceCode: string;
  spaceName: string;
  businessType: string;
  visitId: number;
  tagCode: string;
  /** 使用人这次来访的状态（在店 / 已结账 / 已撤销） */
  visitStatus: 'open' | 'settled' | 'cancelled';
  guests: number;
  note: string;
  status: UsageStatus;
  businessDate: string;
  openedAt: string;
  openedByName: string;
  closedAt: string | null;
  closedByName: string | null;
  closeKind: UsageCloseKind | null;
  closeReason: string | null;
  /** 这个业态设了计费（v0.7.28）：结束使用时按时长挂房费；结账前要先结束 */
  priced: boolean;
  /** 已挂的房费与开台费（结束使用时挂的；没设计费、开着、撤单的为空） */
  fee: { amount: number; chargedMinutes: number; openFee: number } | null;
  /** 页面估算用的计费（此刻的价目；没设计费或项目停用了为空） */
  pricing?: { itemName: string; hourPrice: number; minMinutes: number; stepMinutes: number; openFee: number } | null;
}

/** 派对房看板（8.0.8，A03）：开单即占用的业态下在用、可售的房间，与开着的使用单；不需要底图 */
export interface UsageBoardSpace {
  id: number;
  code: string;
  displayName: string;
  businessType: string;
  capacity: number | null;
  floorCode: string;
  /** 这个业态设了计费：结束使用时按时长挂房费；没设的结束不收房费（开单时提醒，F7） */
  priced: boolean;
  /** 页面估算用的计费（此刻的价目；没设或项目停用了为空） */
  pricing: UsageDetail['pricing'];
  /** 开着的使用单；空闲为 null */
  usage: UsageDetail | null;
}

export interface UsageBoard {
  businessTypes: string[];
  spaces: UsageBoardSpace[];
}

/** 账单上派对房房费、开台费的名称（8.0.8，A03）：带房型（业态）和房间，几种房共用一个计费项目也分得清 */
export const usageLineName = (businessType: string, spaceCode: string, what: string) => `${businessType} ${spaceCode} ${what}`.slice(0, 48);

/** 已用时长（分钟，向下取整；没结束的到 now） */
export function usageMinutes(u: Pick<UsageDetail, 'openedAt' | 'closedAt'>, now: number): number {
  const end = u.closedAt ? new Date(u.closedAt).getTime() : now;
  return Math.max(0, Math.floor((end - new Date(u.openedAt).getTime()) / 60_000));
}

export function durationText(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} 小时${m ? ` ${m} 分` : ''}` : `${m} 分`;
}

/** 页面估算：用了 minutes 分钟时的房费加开台费（结束时按结束那一刻再算一次） */
export function usageEstimate(minutes: number, v: { hourPrice: number; minMinutes: number; stepMinutes: number; openFee: number }): number {
  return usageFee(minutes, v, v.hourPrice).amount + v.openFee;
}

/** 计费说明：「每小时 ¥X，起步 60 分钟，之后每 30 分钟计一次」 */
export function pricingText(v: { hourPrice: number; minMinutes: number; stepMinutes: number; openFee: number }, yuan: (cents: number) => string): string {
  return `每小时 ${yuan(v.hourPrice)}，起步 ${v.minMinutes} 分钟，之后每 ${v.stepMinutes} 分钟计一次${v.openFee > 0 ? `，开台费 ${yuan(v.openFee)}` : ''}`;
}
