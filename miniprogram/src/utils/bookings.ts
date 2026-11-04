// 预约技师与派对房（第三期 3d，docs/MP_PHASE3.md 第 4 节）：预约页与「我的预约」要显示的字、时段、预约与取消的「结果待确认」。
// 能不能约、哪些时段空着、同时几个、爽约限制都由门店系统算好，这里只拼成句子。
//
// 预约、取消（AGENTS.md「结果待确认」，与点餐、邀请领取一样）：
//   · 点「提交预约」「取消预约」前先把这次的操作编号存在手机上并读回核对，存不了就不发请求；
//   · 办了、或门店系统明确拒绝才删；结果不确定时保留，马上请门店系统「确认作废」这个编号：已经办了回那一张；
//     还没有就登记作废，原来那次请求之后即使到达也不办。以这个回答为准；连作废都发不出去时保留，确认之前不能再约、再取消；
//   · 手机上的记录读不出来不当作没有：不能约、不能取消，提示稍后再试；
//   · 请求还在发（页面回到前台时）不去确认作废它；点「提交」「取消」时手机上还有上一次没确认的，先确认那一次、告诉顾客结果，这一次不办。

import type { MpBookingAbandonResult, MpBookingDone, MpBookingSlot, MpBookingStatus, MpBookingView } from '../../../src/shared/mp';
import { isApiError, member, messageOf } from './api';
import { shopDateTime } from './format';
import { beginFlight, clearStoredIf, endFlight, inFlight, readStored, saveStored, uncertain } from './pending-store';

// ── 显示 ──

const STATUS_TEXT: Record<MpBookingStatus, string> = {
  pending: '待门店确认',
  confirmed: '已预约',
  arrived: '已到店',
  cancelled: '已取消',
  no_show: '没到店',
};
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 「11月6日 周五」 */
export function dateText(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return m + '月' + d + '日 ' + WEEK[w];
}

/** 日历上的第二天 */
function nextDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/**
 * 能约的日子（营业日）：按顾客手机上的日历写今天、明天，其余写月日；都带周几（独立审查 3d 的 P3：半夜到早上营业日切换之前，
 * 营业日的「第二天」其实是日历上的今天，按排第几个写会把「明天」写成今天）
 */
export function dayChips(dates: string[], now = Date.now()): { date: string; label: string; sub: string }[] {
  const today = shopDateTime(new Date(now).toISOString()).slice(0, 10);
  const tomorrow = nextDate(today);
  return dates.map((date) => {
    const [, m, d] = date.split('-').map(Number) as [number, number, number];
    return { date, label: date === today ? '今天' : date === tomorrow ? '明天' : m + '/' + d, sub: dateText(date).split(' ')[1]! };
  });
}

/** 门店时间的钟点：「14:00」 */
export const clock = (iso: string) => shopDateTime(iso).slice(11);

/** 一个时段在日历上是哪天几点：「11月7日 周六 00:30」（过了半夜的时段写第二天） */
export function slotWhen(iso: string): string {
  const t = shopDateTime(iso);
  return dateText(t.slice(0, 10)) + ' ' + t.slice(11);
}

export interface SlotView {
  startsAt: string;
  time: string;
  full: boolean;
  /** 「空 2 位」「可约」「约满」 */
  text: string;
}

/** 时段格子；给了营业日的，过了半夜（日历上是第二天）的写「次日」 */
export function slotViews(kind: 'technician' | 'space', slots: MpBookingSlot[], date?: string): SlotView[] {
  return slots.map((s) => {
    const text = s.free < 1 ? '约满' : kind === 'technician' ? '空 ' + s.free + ' 位' : '可约';
    const next = !!date && shopDateTime(s.startsAt).slice(0, 10) !== date;
    return { startsAt: s.startsAt, time: clock(s.startsAt), full: s.free < 1, text: next ? '次日 · ' + text : text };
  });
}

/** 「2 小时」「90 分钟」 */
export const durationText = (m: number) => (m % 60 === 0 ? m / 60 + ' 小时' : m + ' 分钟');

export interface BookingItemView {
  id: number;
  bookingNo: string;
  title: string;
  status: MpBookingStatus;
  statusText: string;
  /** 「11月6日 周五 14:00–15:00」 */
  when: string;
  /** 「8 位」；1 位不写 */
  guests: string;
  /** 还占着时段（待确认、已预约） */
  open: boolean;
  cancellable: boolean;
  /** 取消了的写原因（「开始前 60 分钟还没确认，自动取消」「顾客在小程序取消」） */
  reason: string;
}

export function bookingItemView(b: MpBookingView): BookingItemView {
  const start = shopDateTime(b.startsAt);
  return {
    id: b.id,
    bookingNo: b.bookingNo,
    title: b.title,
    status: b.status,
    statusText: STATUS_TEXT[b.status] || b.status,
    when: dateText(start.slice(0, 10)) + ' ' + start.slice(11) + '–' + clock(b.endsAt),
    guests: b.guests > 1 ? b.guests + ' 位' : '',
    open: b.status === 'pending' || b.status === 'confirmed',
    cancellable: b.cancellable,
    reason: b.status === 'cancelled' && b.cancelReason ? b.cancelReason : '',
  };
}

/** 结果页的标题：按那张预约现在的状态写（确认出上一次已经办了的，可能已经确认、取消或爽约了） */
export function doneTitle(status: MpBookingStatus): string {
  return status === 'pending'
    ? '提交好了，等门店确认'
    : status === 'confirmed'
      ? '约好了'
      : status === 'arrived'
        ? '已经到店了'
        : status === 'cancelled'
          ? '这张预约已经取消了'
          : '这张预约没有到店';
}

// ── 预约、取消的「结果待确认」──

const KEY = 'tq_booking_pending';

export type BookingOutcome =
  /** 办了（或原来那次已经办了） */
  | { kind: 'done'; action: 'create' | 'cancel'; booking: MpBookingView }
  /** 原来那次没有办成，已登记作废：可以重新约 / 重新取消 */
  | { kind: 'abandoned'; action: 'create' | 'cancel' }
  /** 门店系统明确拒绝（时段刚被约走、同时预约满了、开始前 2 小时以内不能取消…） */
  | { kind: 'rejected'; code: string; message: string }
  /** 手机上的记录读不出来：不知道有没有没确认的，先不能约、不能取消 */
  | { kind: 'unreadable' }
  /** 还确认不了（多半是断网；flying：这一次还在发，等它回来）：记录保留，网络好了再确认 */
  | { kind: 'pending'; action: 'create' | 'cancel'; message: string; flying?: boolean }
  /** 点的时候手机上还有上一次没确认的：确认了上一次（message 写结果），这一次没有办 */
  | { kind: 'earlier'; message: string };

export type BookingPendingRead = { state: 'none' } | { state: 'pending'; clientKey: string; action: 'create' | 'cancel' } | { state: 'unreadable' };

export function readBookingPending(): BookingPendingRead {
  const r = readStored(KEY);
  if (r.state !== 'ok') return r;
  const { clientKey, action } = r.value;
  return typeof clientKey === 'string' && (action === 'create' || action === 'cancel') ? { state: 'pending', clientKey, action } : { state: 'unreadable' };
}

/** 有待确认的预约或取消时，请门店系统确认作废这个编号；以门店系统的回答为准。读不出来时不确认、不删 */
export async function resolveBookingPending(): Promise<BookingOutcome | null> {
  const r0 = readBookingPending();
  if (r0.state === 'none') return null;
  if (r0.state === 'unreadable') return { kind: 'unreadable' };
  // 这一次还在发（页面刚回到前台）：不去作废它，等它回来
  if (inFlight(r0.clientKey)) return { kind: 'pending', action: r0.action, message: '还在提交，请稍候再点「再确认一次」', flying: true };
  try {
    const r = await member<MpBookingAbandonResult>('POST', '/v1/bookings/abandon', { clientKey: r0.clientKey });
    clearStoredIf(KEY, r0.clientKey);
    return r.status === 'done' ? { kind: 'done', action: r.action, booking: r.booking } : { kind: 'abandoned', action: r0.action };
  } catch (e) {
    if (isApiError(e) && e.code === 'CLIENT_KEY_REUSED') {
      clearStoredIf(KEY, r0.clientKey);
      return { kind: 'abandoned', action: r0.action };
    }
    return { kind: 'pending', action: r0.action, message: messageOf(e) };
  }
}

async function send(action: 'create' | 'cancel', path: string, body: Record<string, unknown>, clientKey: string): Promise<BookingOutcome> {
  const before = readBookingPending();
  if (before.state === 'unreadable') return { kind: 'unreadable' };
  if (before.state === 'pending') {
    // 上一次还没确认：先确认那一次，告诉顾客结果；这一次不办（顾客看了再点）
    const earlier = await resolveBookingPending();
    if (earlier && (earlier.kind === 'pending' || earlier.kind === 'unreadable')) return earlier;
    const what = before.action === 'create' ? '预约' : '取消';
    if (earlier && earlier.kind === 'done') {
      return { kind: 'earlier', message: '上一次的' + what + '已经办好了（' + earlier.booking.title + '，' + STATUS_TEXT[earlier.booking.status] + '）；这一次还没办，看一下「我的预约」，要的话再点一次' };
    }
    return { kind: 'earlier', message: '上一次的' + what + '没有办成；这一次还没办，请再点一次' };
  }
  if (!saveStored(KEY, { clientKey, action, at: Date.now() })) {
    return { kind: 'rejected', code: 'PENDING_STORE_FAILED', message: '手机存储空间不够，这次没有' + (action === 'create' ? '约' : '取消') + '，请清理微信的存储空间后再试' };
  }
  beginFlight(clientKey);
  try {
    const r = await member<MpBookingDone>('POST', path, { clientKey, ...body });
    clearStoredIf(KEY, clientKey);
    return { kind: 'done', action, booking: r.booking };
  } catch (e) {
    if (!uncertain(e) && isApiError(e)) {
      clearStoredIf(KEY, clientKey);
      return { kind: 'rejected', code: e.code, message: e.message };
    }
    // 请求回来了、结果不确定：先拿掉「正在发」，再确认作废
    endFlight(clientKey);
    return (await resolveBookingPending()) || { kind: 'pending', action, message: messageOf(e) };
  } finally {
    endFlight(clientKey);
  }
}

export interface BookingBody {
  kind: 'technician' | 'space';
  itemId?: number;
  technicianId?: number | null;
  spaceId?: number;
  durationMinutes?: number;
  startsAt: string;
  guests: number;
  note: string;
  bindVersion: number;
}

/** 提交预约：先确认手机上没有没确认的、再存编号（读不出来、存不了都不发），再发；结果不确定时马上确认一次 */
export function sendBooking(body: BookingBody, clientKey: string): Promise<BookingOutcome> {
  return send('create', '/v1/bookings', { ...body }, clientKey);
}

/** 自己取消：同上 */
export function sendCancel(bookingId: number, bindVersion: number, clientKey: string): Promise<BookingOutcome> {
  return send('cancel', '/v1/bookings/' + bookingId + '/cancel', { bindVersion }, clientKey);
}
