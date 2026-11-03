// 开单即占用（D37 / D39，v0.7.19，见 docs/FLOORPLAN_FINISH.md 第 1 节）：派对房、宠物轰趴房、娱乐室不派技师，
// 按「有开着的使用单」算在用，结束、使用人结账、撤销来访或撤单后释放。使用人是在店客人（手牌），费用是手牌账单上的普通明细。

/** 开单即占用的业态（后台可改，待确认） */
export const DEFAULT_USAGE_BUSINESS_TYPES = ['派对房', '宠物轰趴房', '娱乐室'] as const;

export interface UsageRules {
  /** 按「开单即占用」算的业态（空间台账的业态名） */
  businessTypes: string[];
}

export const DEFAULT_USAGE_RULES: UsageRules = { businessTypes: [...DEFAULT_USAGE_BUSINESS_TYPES] };

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
}

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
