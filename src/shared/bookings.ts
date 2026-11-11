// 预约（v0.7.28 ③，docs/SCHEDULE_FINISH.md 第 4 节；小程序第三期 3d，docs/MP_PHASE3.md 第 4 节，MP34–MP37；客房电话预订，飞书 Q17）。
//   · 三种：预约技师（项目 + 技师或「不指定」）、预约派对房等（开单即占用的房间 + 时长）、客房电话预订（房型 + 预计到店 + 保留到几点）；
//   · 来源：前台、电话（直接「已预约」）、小程序（「待确认」，前台确认）；
//   · 到店：先接待开手牌，再在预约看板点「到店」——派对房直接开使用单，技师的去派钟，客房的去开房；
//   · 不收订金、不动钱（MP36）；爽约按规则记（MP37）。

import { HHMM } from './business-date';

export const BOOKING_KINDS = ['technician', 'space', 'room'] as const;
export type BookingKind = (typeof BOOKING_KINDS)[number];
export const BOOKING_KIND_LABELS: Record<BookingKind, string> = { technician: '技师', space: '派对房等', room: '客房' };

export const BOOKING_SOURCES = ['front', 'phone', 'mp'] as const;
export type BookingSource = (typeof BOOKING_SOURCES)[number];
export const BOOKING_SOURCE_LABELS: Record<BookingSource, string> = { front: '前台', phone: '电话', mp: '小程序' };

export const BOOKING_STATUSES = ['pending', 'confirmed', 'arrived', 'cancelled', 'no_show'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];
export const BOOKING_STATUS_LABELS: Record<BookingStatus, string> = {
  pending: '待确认',
  confirmed: '已预约',
  arrived: '已到店',
  cancelled: '已取消',
  no_show: '爽约',
};
/** 还占着时段的（同一位技师、同一间房、同一个房型的名额） */
export const ACTIVE_BOOKING_STATUSES = ['pending', 'confirmed'] as const;

/** 预约规则（N4 / MP34–MP37，待确认；后台「预约」可改） */
export interface BookingRules {
  /** 能约的时段：每个营业日 openTime 起、closeTime 止（不晚于 openTime 表示到次日） */
  openTime: string;
  closeTime: string;
  /** 一格多少分钟（MP34：半小时一格） */
  slotMinutes: number;
  /** 最远能约几天后（MP34：当天到 7 天后） */
  maxDaysAhead: number;
  /** 小程序：每人同时最多几个没到店的预约（MP34） */
  mpMaxOpen: number;
  /** 小程序预约开始前多少分钟还没确认的，自动取消（MP35） */
  confirmLeadMinutes: number;
  /** 小程序：开始前多少分钟以前可以自己取消 */
  mpCancelLeadMinutes: number;
  /** 过了开始时间多少分钟还没到店记爽约（MP37） */
  noShowMinutes: number;
  /** 多少天内爽约几次，之后多少天不能在小程序预约（MP37） */
  noShowWindowDays: number;
  noShowLimit: number;
  noShowBanDays: number;
  /** 派对房等能约的时长（分钟） */
  spaceDurations: number[];
  /** 技师项目没写时长时按多少分钟算 */
  defaultServiceMinutes: number;
  /** 客房电话预订：保留到预计到店后多少分钟，过了自动释放、记爽约（Q17） */
  roomHoldMinutes: number;
}

export const DEFAULT_BOOKING_RULES: BookingRules = {
  openTime: '11:00',
  closeTime: '02:00',
  slotMinutes: 30,
  maxDaysAhead: 7,
  mpMaxOpen: 2,
  confirmLeadMinutes: 60,
  mpCancelLeadMinutes: 120,
  noShowMinutes: 30,
  noShowWindowDays: 90,
  noShowLimit: 3,
  noShowBanDays: 30,
  spaceDurations: [120, 180, 240],
  defaultServiceMinutes: 60,
  roomHoldMinutes: 60,
};

export const BOOKING_TIME = HHMM;
export const MAX_BOOKING_NOTE = 100;
export const MAX_BOOKING_GUESTS = 99;

/** 一张预约单（前台看板用；小程序看自己的用 MpBooking，不带门店内部信息） */
export interface BookingDetail {
  id: number;
  bookingNo: string;
  kind: BookingKind;
  source: BookingSource;
  status: BookingStatus;
  memberId: number | null;
  memberName: string | null;
  guestName: string;
  guestPhone: string;
  guests: number;
  itemId: number | null;
  itemName: string | null;
  technicianId: number | null;
  technicianText: string | null;
  spaceId: number | null;
  spaceCode: string | null;
  spaceName: string | null;
  roomTypeId: number | null;
  roomTypeName: string | null;
  startsAt: string;
  endsAt: string;
  holdUntil: string | null;
  note: string;
  businessDate: string;
  createdByName: string;
  createdAt: string;
  confirmedAt: string | null;
  arrivedAt: string | null;
  arrivalTagCode: string | null;
  arrivalRef: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  noShowAt: string | null;
  version: number;
  /**
   * 到店之后开的单（8.0.8，A04）：技师预约派的钟单、客房预约的入住单、派对房预约的使用单；还没有为 null。
   * 取消、退钟了的钟单与撤销了的入住单不算（可以再派、再入住）
   */
  service: { kind: 'session' | 'stay' | 'usage'; no: string } | null;
  /** 这位会员此刻在店的手牌（点到店时自动带出，8.0.8）；不是会员、不在店为 null */
  memberOpenTag: string | null;
}

export interface BookingBoard {
  date: string;
  rules: BookingRules;
  bookings: BookingDetail[];
  /** 能约的技师（在职），预约技师时挑 */
  technicians: { id: number; techNo: string; name: string; gender: 'male' | 'female' }[];
  /** 需要技师的项目 */
  items: { id: number; name: string; minutes: number }[];
  /** 开单即占用的房间 */
  spaces: { id: number; code: string; name: string; businessType: string; capacity: number | null }[];
  roomTypes: { id: number; name: string; rooms: number }[];
}

/** 一个可约时段 */
export interface BookingSlot {
  startsAt: string;
  endsAt: string;
  /** 预约技师：这个时段空着的技师；预约房间：空着为 true；客房：还剩几间 */
  free: number;
  technicianIds?: number[];
}

/** 预计结束：开始 + 分钟 */
export const plusMinutes = (iso: string | Date, minutes: number) => new Date(new Date(iso).getTime() + minutes * 60_000);

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * 某个营业日能约的时段的开始分钟（相对当天 00:00，可能超过 1440 = 次日）：openTime 起，每格 slotMinutes，
 * 到 closeTime 为止要能放下 durationMinutes
 */
export function slotStartMinutes(rules: Pick<BookingRules, 'openTime' | 'closeTime' | 'slotMinutes'>, durationMinutes: number): number[] {
  const open = toMinutes(rules.openTime);
  let close = toMinutes(rules.closeTime);
  if (close <= open) close += 24 * 60;
  const out: number[] = [];
  for (let m = open; m + durationMinutes <= close; m += rules.slotMinutes) out.push(m);
  return out;
}

/** 两段时间有没有重叠（半开区间） */
export const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) => aStart < bEnd && bStart < aEnd;
