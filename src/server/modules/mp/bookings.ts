// 小程序第三期 3d：预约技师与派对房（小程序线，docs/MP_PHASE3.md 第 4 节；MP34–MP37）。主线 v0.7.28 的 bookings 建预约单、算时段。
//   · 设置（settings 的 mp_booking_rules，带版本号）：开关、小程序可约的技师项目与房间，后台「微信小程序 → 预约」（权限 mp.booking）。
//     几点到几点、半小时一格、最远几天、每人同时几个、确认与取消的提前分钟、爽约限制都照主线后台「预约」的规则；
//   · 预约页：能不能约（绑定了会员、会员卡能用、没被爽约限制、同时预约没满）、可约的项目与房间、能约哪几天；「我的预约」；
//     可约时段（主线的 bookingSlots，技师只给号、不给名字）；
//   · 预约、取消在一个事务里：这个微信的预约咨询锁（mp_booking:<openid>，与确认作废串行）→ 作废登记 → 绑定锁（共享）→
//     同一个编号重提返回第一次（只认同一条绑定）→ 核对绑定版本号 → 设置与可约的 → 主线的入口（它自己的编号锁 → 会员一行 →
//     时段的锁；取消：编号锁 → 预约单一行）→ 记下这一次。结果不确定时请门店系统确认作废这个编号（取同一把预约锁）：
//     已经办了回那一张；还没有就登记作废，之后原请求再到也不办。
// 不动钱（MP36 不收订金）；前台确认、到店、爽约都在主线。

import { z } from 'zod';
import { ISO_DATE } from '@shared/business-date';
import type { BookingDetail } from '@shared/bookings';
import { shiftDate } from '@shared/labels';
import {
  MP_BOOKING_CONFIRM_WINDOW_MINUTES,
  MP_BOOKING_MAX_GUESTS,
  MP_BOOKING_MAX_OPTIONS,
  MP_BOOKING_NOTE_MAX,
  MP_BOOKING_RULES_KEY,
  type MpBookingAbandonResult,
  type MpBookingAdminData,
  type MpBookingAdminOp,
  type MpBookingDone,
  type MpBookingHome,
  type MpBookingRules,
  type MpBookingSlot,
  type MpBookingStatus,
  type MpBookingView,
} from '@shared/mp';
import { isUniqueViolation, type Db, type Tx } from '../../db';
import type { Deps, OpContext } from '../../lib/context';
import { AppError, badRequest, conflict, unprocessable } from '../../lib/errors';
import { hashRequest } from '../../lib/idempotency';
import { saveRuleSetting } from '../../lib/rule-settings';
import { setTxTimeouts } from '../../lib/tx';
import { parse } from '../../lib/validate';
import { bookingBoard, bookingSlots, cancelBookingFromMp, createBookingFromMp, getBooking, loadBookingRules, memberBookings, mpBookingBan, type MpBooking } from '../bookings';
import { bindingStateOf, lockOpenidShared } from './member';
import { mpToday } from './public';
import { loadBookingMpRules } from './rules';

// ───────────────────────── 小工具 ─────────────────────────

/** 同一个微信的预约、取消、确认作废串行 */
const lockBookingOpenid = (tx: Tx, openid: string) => tx`SELECT pg_advisory_xact_lock(hashtext(${`mp_booking:${openid}`}))`;

/** 小程序只给技师号（主线 MpBooking 的 techNo；「不指定」为空），不给名字 */
const titleOf = (b: Pick<MpBooking, 'kind' | 'itemName' | 'spaceName'> & { roomTypeName?: string | null }, techNo: string | null) =>
  b.kind === 'technician'
    ? `${b.itemName ?? '技师项目'} · ${techNo ? `${techNo} 号技师` : '不指定技师'}`
    : b.kind === 'space'
      ? (b.spaceName ?? '房间')
      : (b.roomTypeName ?? '客房');

function viewOf(b: MpBooking | BookingDetail, techNo: string | null, cancelLeadMinutes: number, now = Date.now()): MpBookingView {
  const open = b.status === 'pending' || b.status === 'confirmed';
  return {
    id: Number(b.id),
    bookingNo: b.bookingNo,
    kind: b.kind,
    status: b.status as MpBookingStatus,
    title: titleOf(b, techNo),
    startsAt: b.startsAt,
    endsAt: b.endsAt,
    guests: b.guests,
    cancelReason: b.cancelReason,
    cancellable: 'cancellable' in b ? b.cancellable : open && Date.parse(b.startsAt) - now >= cancelLeadMinutes * 60_000,
  };
}

/** 单张预约（主线的 BookingDetail 不带技师号）：按技师编号查一下 */
async function techNoOf(db: Db, b: BookingDetail): Promise<string | null> {
  if (b.technicianId === null) return null;
  const [t] = await db<{ techNo: string }[]>`SELECT tech_no FROM technicians WHERE id = ${b.technicianId}`;
  return t?.techNo ?? null;
}

async function detailView(db: Db, b: BookingDetail, cancelLeadMinutes: number): Promise<MpBookingView> {
  return viewOf(b, await techNoOf(db, b), cancelLeadMinutes);
}

async function bookingView(db: Db, bookingId: number): Promise<MpBookingView> {
  const [b, rules] = await Promise.all([getBooking(db, bookingId), loadBookingRules(db)]);
  return detailView(db, b, rules.mpCancelLeadMinutes);
}

/** 会员卡能不能用来约（合并掉的、停用的不行） */
async function memberProblem(db: Db, memberId: number): Promise<string | null> {
  const [m] = await db<{ status: string; mergedIntoId: number | null }[]>`SELECT status, merged_into_id FROM members WHERE id = ${memberId}`;
  if (!m) return '会员不存在';
  if (m.mergedIntoId !== null) return '这张会员卡已合并，请到前台换绑';
  if (m.status !== 'active') return '会员卡已停用，请打电话给门店预约';
  return null;
}

/**
 * 小程序最早能约开始前多少分钟的时段（独立审查 3d 的 P2）：开始前 confirmLeadMinutes 还没确认的每分钟自动取消（主线 sweepBookings），
 * 再留 MP_BOOKING_CONFIRM_WINDOW_MINUTES 给前台确认；更近的不给、不收，请打电话给门店
 */
const minLeadOf = (rules: { confirmLeadMinutes: number }) => rules.confirmLeadMinutes + MP_BOOKING_CONFIRM_WINDOW_MINUTES;

/** 门店时间的「11月6日 14:00」 */
function shopText(iso: string, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.month}月${parts.day}日 ${parts.hour}:${parts.minute}`;
}

/** 能约的营业日：今天到最远几天后 */
const datesFrom = (today: string, maxDaysAhead: number) => Array.from({ length: maxDaysAhead + 1 }, (_, i) => shiftDate(today, i));

/** 主线的拒绝写给顾客看 */
function friendlyBookingError(error: unknown): unknown {
  if (!(error instanceof AppError)) return error;
  if (error.code === 'MP_CLAIM_CONFLICT') return new AppError(error.status, 'CLIENT_KEY_REUSED', '这次预约的编号已经用过，请重新点');
  return error;
}

interface OpRow {
  id: number;
  clientKey: string;
  action: 'create' | 'cancel';
  bindingId: number;
  memberId: number;
  bookingId: number;
  /** 这次请求的摘要：同一个编号重提时核对内容一样（独立审查 3d 的 P3） */
  requestHash: string;
  createdAt: string;
}

// ───────────────────────── 设置 ─────────────────────────

const RulesInput = z.object({
  enabled: z.boolean(),
  itemIds: z.array(z.number().int().positive(), '可约的项目不对').max(MP_BOOKING_MAX_OPTIONS, `项目最多勾 ${MP_BOOKING_MAX_OPTIONS} 个`),
  spaceIds: z.array(z.number().int().positive(), '可约的房间不对').max(MP_BOOKING_MAX_OPTIONS, `房间最多勾 ${MP_BOOKING_MAX_OPTIONS} 间`),
  version: z.number().int().min(0).optional(),
});

export async function saveBookingMpRules(deps: Deps, raw: unknown, ctx: OpContext): Promise<MpBookingRules> {
  const input = parse(RulesInput, raw);
  const sorted = (ids: number[]) => [...new Set(ids)].sort((a, b) => a - b);
  return saveRuleSetting(
    deps.sql,
    MP_BOOKING_RULES_KEY,
    loadBookingMpRules,
    async (before) => {
      if (input.version !== undefined && input.version !== before.version) throw conflict('VERSION_CONFLICT', '小程序预约的设置刚被别人改过，请刷新后再改');
      return { enabled: input.enabled, itemIds: sorted(input.itemIds), spaceIds: sorted(input.spaceIds), version: before.version + 1 };
    },
    ctx,
  );
}

// ───────────────────────── 顾客 ─────────────────────────

/** 预约页与「我的预约」 */
export async function bookingHome(deps: Deps, openid: string): Promise<MpBookingHome> {
  const [mpRules, rules, state, today] = await Promise.all([
    loadBookingMpRules(deps.sql),
    loadBookingRules(deps.sql),
    bindingStateOf(deps.sql, openid),
    mpToday(deps.sql, deps.config.timezone),
  ]);
  const board = await bookingBoard(deps.sql, today);
  const items = board.items.filter((i) => mpRules.itemIds.includes(i.id)).map((i) => ({ id: i.id, name: i.name, minutes: i.minutes }));
  const spaces = board.spaces.filter((s) => mpRules.spaceIds.includes(s.id)).map((s) => ({ id: s.id, name: s.name || s.code }));
  const open = mpRules.enabled && (items.length > 0 || spaces.length > 0);
  const base = {
    bindVersion: state.version,
    bound: state.binding !== null,
    items: open ? items : [],
    spaces: open ? spaces : [],
    durations: rules.spaceDurations,
    dates: datesFrom(today, rules.maxDaysAhead),
    rules: {
      maxOpen: rules.mpMaxOpen,
      cancelLeadMinutes: rules.mpCancelLeadMinutes,
      confirmLeadMinutes: rules.confirmLeadMinutes,
      noShowMinutes: rules.noShowMinutes,
      minLeadMinutes: minLeadOf(rules),
    },
  };
  // 自己的预约：绑定了就给看（小程序预约关了也看得到、能取消）
  let bookings: MpBookingView[] = [];
  let notice: string | null = null;
  let bookNotice: string | null = null;
  if (!state.binding) {
    notice = '绑定会员后才能预约：请到「我的」绑定，或打电话给门店';
  } else {
    const memberId = state.binding.memberId;
    const now = new Date();
    bookings = (await memberBookings(deps.sql, memberId, now)).map((b) => viewOf(b, b.techNo, rules.mpCancelLeadMinutes, now.getTime()));
    notice = await memberProblem(deps.sql, memberId);
    if (!notice) {
      const ban = await mpBookingBan(deps.sql, memberId, now);
      const openCount = bookings.filter((b) => (b.status === 'pending' || b.status === 'confirmed') && Date.parse(b.startsAt) > now.getTime()).length;
      // 限制到那一刻为止：按门店时间写到几点（独立审查 3d 的 P3：原来写的是 UTC 的日子）
      if (ban.banned) bookNotice = `${rules.noShowWindowDays} 天内爽约 ${ban.noShows} 次，${shopText(ban.until!, deps.config.timezone)} 以后才能在小程序预约；现在请打电话给门店`;
      else if (openCount >= rules.mpMaxOpen) bookNotice = `每人同时最多 ${rules.mpMaxOpen} 个没到店的预约：到店或取消以后才能再约`;
    }
  }
  if (!open && !notice) notice = '小程序预约还没开放，请打电话给门店';
  return { open, notice, bookNotice, canBook: open && notice === null && bookNotice === null, ...base, bookings };
}

const SlotQuery = z.object({
  kind: z.enum(['technician', 'space'], '请选择预约什么'),
  date: z.string().regex(ISO_DATE, '日期不对'),
  itemId: z.coerce.number().int().positive().optional(),
  spaceId: z.coerce.number().int().positive().optional(),
  durationMinutes: z.coerce.number().int().min(30).max(720).optional(),
});

/** 可约时段（主线的 bookingSlots）：只能查小程序可约的项目、房间，能约的那几天 */
export async function bookingSlotsMp(deps: Deps, query: unknown): Promise<MpBookingSlot[]> {
  const q = parse(SlotQuery, query);
  const [mpRules, rules, today] = await Promise.all([loadBookingMpRules(deps.sql), loadBookingRules(deps.sql), mpToday(deps.sql, deps.config.timezone)]);
  if (!mpRules.enabled) throw new AppError(403, 'MP_BOOKING_DISABLED', '小程序预约还没开放，请打电话给门店');
  if (!datesFrom(today, rules.maxDaysAhead).includes(q.date)) throw unprocessable('BOOKING_RANGE', `只能约今天到 ${rules.maxDaysAhead} 天后`);
  if (q.kind === 'technician') {
    if (!q.itemId || !mpRules.itemIds.includes(q.itemId)) throw unprocessable('BOOKING_NOT_OPEN', '这个项目不能在小程序预约，请打电话给门店');
  } else {
    if (!q.spaceId || !mpRules.spaceIds.includes(q.spaceId)) throw unprocessable('BOOKING_NOT_OPEN', '这间房不能在小程序预约，请打电话给门店');
    if (q.durationMinutes !== undefined && !rules.spaceDurations.includes(q.durationMinutes)) throw unprocessable('BOOKING_DURATION', '时长不对，请重新选');
  }
  const slots = await bookingSlots(deps.sql, deps, {
    kind: q.kind,
    date: q.date,
    ...(q.kind === 'technician' ? { itemId: q.itemId } : { spaceId: q.spaceId, durationMinutes: q.durationMinutes ?? rules.spaceDurations[0] }),
  });
  const ids = [...new Set(slots.flatMap((s) => s.technicianIds ?? []))];
  const nos = ids.length
    ? new Map((await deps.sql<{ id: number; techNo: string }[]>`SELECT id, tech_no FROM technicians WHERE id IN ${deps.sql(ids)}`).map((t) => [Number(t.id), t.techNo]))
    : new Map<number, string>();
  // 离开始不到 minLead 的不给（约上了也来不及确认，会被自动取消）
  const earliest = Date.now() + minLeadOf(rules) * 60_000;
  return slots.filter((s) => Date.parse(s.startsAt) >= earliest).map((s) => ({
    startsAt: s.startsAt,
    endsAt: s.endsAt,
    free: s.free,
    // 不指定时一位都没空的时段，指定哪位也约不上（还要给别的「不指定」留人）：不给技师
    technicians: s.free > 0 ? (s.technicianIds ?? []).map((id) => ({ id, techNo: nos.get(id) ?? String(id) })) : [],
  }));
}

const CreateInput = z.object({
  clientKey: z.uuid('操作编号不正确'),
  kind: z.enum(['technician', 'space'], '请选择预约什么'),
  itemId: z.number().int().positive().optional(),
  /** 预约技师：指定哪一位（不指定为空） */
  technicianId: z.number().int().positive().nullable().optional(),
  spaceId: z.number().int().positive().optional(),
  startsAt: z.iso.datetime({ offset: true, message: '请选择时段' }),
  durationMinutes: z.number().int().min(30).max(720).optional(),
  guests: z.number('人数不对').int('人数不对').min(1, '至少 1 位').max(MP_BOOKING_MAX_GUESTS, `最多 ${MP_BOOKING_MAX_GUESTS} 位`).default(1),
  note: z.string().trim().max(MP_BOOKING_NOTE_MAX, `备注最多 ${MP_BOOKING_NOTE_MAX} 字`).default(''),
  bindVersion: z.number('请刷新后再预约').int().min(0),
});

/** 这次预约请求的摘要（同一个编号重提时核对内容一样）：只取会影响预约的字段，时间统一成 ISO */
const createHashOf = (i: z.infer<typeof CreateInput>) =>
  hashRequest({
    action: 'create',
    kind: i.kind,
    itemId: i.kind === 'technician' ? (i.itemId ?? null) : null,
    technicianId: i.kind === 'technician' ? (i.technicianId ?? null) : null,
    spaceId: i.kind === 'space' ? (i.spaceId ?? null) : null,
    durationMinutes: i.kind === 'space' ? (i.durationMinutes ?? null) : null,
    startsAt: new Date(i.startsAt).toISOString(),
    guests: i.guests,
    note: i.note,
  });

export async function createBookingMp(deps: Deps, openid: string, raw: unknown): Promise<MpBookingDone> {
  const input = parse(CreateInput, raw);
  if (input.kind === 'technician' && !input.itemId) throw badRequest('请选择项目');
  if (input.kind === 'space' && !input.spaceId) throw badRequest('请选择房间');
  const requestHash = createHashOf(input);
  try {
    return await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await lockBookingOpenid(tx, openid);
      const [fenced] = await tx`SELECT 1 FROM mp_op_fences WHERE key = ${input.clientKey} AND op_type = 'mp_booking' AND openid = ${openid}`;
      if (fenced) throw conflict('OP_ABANDONED', '这次预约已经放弃，没有约；请重新预约');
      await lockOpenidShared(tx, openid);
      const state = await bindingStateOf(tx, openid);
      const [prev] = await tx<OpRow[]>`SELECT * FROM mp_booking_ops WHERE client_key = ${input.clientKey}`;
      if (prev) {
        // 同一个编号重提：只认同一条绑定、内容一样的预约
        if (prev.action !== 'create' || !state.binding || Number(prev.bindingId) !== state.binding.id || prev.requestHash !== requestHash) {
          throw conflict('CLIENT_KEY_REUSED', '这次预约的编号已经用过，请重新点');
        }
        return { booking: await bookingView(tx, Number(prev.bookingId)), replayed: true };
      }
      if (!state.binding) throw new AppError(403, 'MP_NOT_BOUND', '请先绑定会员');
      if (state.version !== input.bindVersion) throw conflict('BIND_STALE', '会员绑定刚变过，这次没有约，请刷新后再点');
      const mpRules = await loadBookingMpRules(tx);
      if (!mpRules.enabled) throw new AppError(403, 'MP_BOOKING_DISABLED', '小程序预约还没开放，请打电话给门店');
      const memberId = state.binding.memberId;
      const problem = await memberProblem(tx, memberId);
      if (problem) throw unprocessable('MEMBER_UNAVAILABLE', problem);
      if (input.kind === 'technician' ? !mpRules.itemIds.includes(input.itemId!) : !mpRules.spaceIds.includes(input.spaceId!)) {
        throw unprocessable('BOOKING_NOT_OPEN', input.kind === 'technician' ? '这个项目不能在小程序预约，请打电话给门店' : '这间房不能在小程序预约，请打电话给门店');
      }
      const rules = await loadBookingRules(tx);
      if (Date.parse(input.startsAt) < Date.now() + minLeadOf(rules) * 60_000) {
        throw unprocessable('BOOKING_TOO_SOON', `开始前 ${minLeadOf(rules)} 分钟以内的时段来不及等门店确认，请打电话给门店预约`);
      }
      const r = await createBookingFromMp(tx, deps, {
        memberId,
        kind: input.kind,
        ...(input.kind === 'technician' ? { itemId: input.itemId, technicianId: input.technicianId ?? null } : { spaceId: input.spaceId, durationMinutes: input.durationMinutes }),
        startsAt: input.startsAt,
        guests: input.guests,
        note: input.note,
        claimKey: input.clientKey,
      });
      await tx`
        INSERT INTO mp_booking_ops (client_key, action, binding_id, member_id, booking_id, request_hash)
        VALUES (${input.clientKey}, 'create', ${state.binding.id}, ${memberId}, ${r.booking.id}, ${requestHash})`;
      return { booking: await detailView(tx, r.booking, rules.mpCancelLeadMinutes), replayed: false };
    });
  } catch (error) {
    if (isUniqueViolation(error, 'mp_booking_ops_client_key_key')) throw conflict('CLIENT_KEY_REUSED', '这次预约的编号已经用过，请重新点');
    throw friendlyBookingError(error);
  }
}

const CancelInput = z.object({ clientKey: z.uuid('操作编号不正确'), bindVersion: z.number('请刷新后再取消').int().min(0) });

/** 顾客自己取消（开始前 2 小时以前；小程序预约关着也能取消） */
export async function cancelBookingMp(deps: Deps, openid: string, bookingId: number, raw: unknown): Promise<MpBookingDone> {
  const input = parse(CancelInput, raw);
  const requestHash = hashRequest({ action: 'cancel', bookingId });
  try {
    return await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await lockBookingOpenid(tx, openid);
      const [fenced] = await tx`SELECT 1 FROM mp_op_fences WHERE key = ${input.clientKey} AND op_type = 'mp_booking' AND openid = ${openid}`;
      if (fenced) throw conflict('OP_ABANDONED', '这次取消已经放弃，没有取消；请重新点');
      await lockOpenidShared(tx, openid);
      const state = await bindingStateOf(tx, openid);
      const [prev] = await tx<OpRow[]>`SELECT * FROM mp_booking_ops WHERE client_key = ${input.clientKey}`;
      if (prev) {
        if (prev.action !== 'cancel' || prev.requestHash !== requestHash || !state.binding || Number(prev.bindingId) !== state.binding.id) {
          throw conflict('CLIENT_KEY_REUSED', '这次取消的编号已经用过，请重新点');
        }
        return { booking: await bookingView(tx, bookingId), replayed: true };
      }
      if (!state.binding) throw new AppError(403, 'MP_NOT_BOUND', '请先绑定会员');
      if (state.version !== input.bindVersion) throw conflict('BIND_STALE', '会员绑定刚变过，这次没有取消，请刷新后再点');
      const memberId = state.binding.memberId;
      const r = await cancelBookingFromMp(tx, deps, { memberId, bookingId, claimKey: input.clientKey });
      await tx`
        INSERT INTO mp_booking_ops (client_key, action, binding_id, member_id, booking_id, request_hash)
        VALUES (${input.clientKey}, 'cancel', ${state.binding.id}, ${memberId}, ${bookingId}, ${requestHash})`;
      const rules = await loadBookingRules(tx);
      return { booking: await detailView(tx, r.booking, rules.mpCancelLeadMinutes), replayed: false };
    });
  } catch (error) {
    if (isUniqueViolation(error, 'mp_booking_ops_client_key_key')) throw conflict('CLIENT_KEY_REUSED', '这次取消的编号已经用过，请重新点');
    if (error instanceof AppError && error.status === 404) throw new AppError(404, 'NOT_FOUND', '预约不存在');
    throw friendlyBookingError(error);
  }
}

const AbandonInput = z.object({ clientKey: z.uuid('操作编号不正确') });

/** 预约、取消的结果不确定时：已经办了返回那一张；还没有就登记作废（与预约、取消取同一把锁，作废以后原请求再到也不办） */
export async function abandonBookingOp(deps: Deps, openid: string, raw: unknown): Promise<MpBookingAbandonResult> {
  const { clientKey } = parse(AbandonInput, raw);
  return deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await lockBookingOpenid(tx, openid);
    const [r] = await tx<(OpRow & { openid: string | null })[]>`
      SELECT o.*, b.openid FROM mp_booking_ops o JOIN mp_bindings b ON b.id = o.binding_id WHERE o.client_key = ${clientKey}`;
    if (r) {
      if (r.openid !== openid) throw conflict('CLIENT_KEY_REUSED', '这次预约的编号已经用过，请重新点');
      return { status: 'done' as const, action: r.action, booking: await bookingView(tx, Number(r.bookingId)) };
    }
    await tx`INSERT INTO mp_op_fences (key, op_type, openid) VALUES (${clientKey}, 'mp_booking', ${openid}) ON CONFLICT (key, op_type) DO NOTHING`;
    const [fence] = await tx<{ openid: string }[]>`SELECT openid FROM mp_op_fences WHERE key = ${clientKey} AND op_type = 'mp_booking'`;
    if (fence?.openid !== openid) throw conflict('CLIENT_KEY_REUSED', '这次预约的编号已经用过，请重新点');
    return { status: 'abandoned' as const };
  });
}

// ───────────────────────── 后台 ─────────────────────────

export async function bookingMpAdminData(deps: Deps): Promise<MpBookingAdminData> {
  const [mpRules, rules, today] = await Promise.all([loadBookingMpRules(deps.sql), loadBookingRules(deps.sql), mpToday(deps.sql, deps.config.timezone)]);
  const board = await bookingBoard(deps.sql, today);
  const [p] = await deps.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM bookings WHERE source = 'mp' AND status = 'pending'`;
  const rows = await deps.sql<(OpRow & { memberName: string })[]>`
    SELECT o.*, m.name AS member_name FROM mp_booking_ops o JOIN members m ON m.id = o.member_id ORDER BY o.id DESC LIMIT 50`;
  const recent: MpBookingAdminOp[] = [];
  for (const r of rows) {
    const b = await getBooking(deps.sql, Number(r.bookingId));
    recent.push({
      id: Number(r.id),
      createdAt: new Date(r.createdAt).toISOString(),
      action: r.action,
      memberId: Number(r.memberId),
      memberName: r.memberName,
      bookingId: b.id,
      bookingNo: b.bookingNo,
      title: titleOf(b, await techNoOf(deps.sql, b)),
      startsAt: b.startsAt,
      status: b.status as MpBookingStatus,
    });
  }
  return {
    rules: mpRules,
    items: board.items.map((i) => ({ id: i.id, name: i.name, minutes: i.minutes, open: mpRules.itemIds.includes(i.id) })),
    spaces: board.spaces.map((s) => ({ id: s.id, name: s.name || s.code, code: s.code, open: mpRules.spaceIds.includes(s.id) })),
    bookingRules: {
      openTime: rules.openTime,
      closeTime: rules.closeTime,
      slotMinutes: rules.slotMinutes,
      maxDaysAhead: rules.maxDaysAhead,
      mpMaxOpen: rules.mpMaxOpen,
      confirmLeadMinutes: rules.confirmLeadMinutes,
      mpCancelLeadMinutes: rules.mpCancelLeadMinutes,
    },
    pending: p?.n ?? 0,
    recent,
  };
}
