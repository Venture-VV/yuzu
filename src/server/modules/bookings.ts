// 预约（v0.7.28 ③，docs/SCHEDULE_FINISH.md 第 4 节；小程序第三期 3d，docs/MP_PHASE3.md 第 4 节，MP34–MP37；客房电话预订，飞书 Q17）。
//   · 预约技师（项目 + 技师或「不指定」）、派对房等（开单即占用的房间 + 时长）、客房（房型 + 预计到店，保留到几点）；
//   · 前台、电话的直接「已预约」；小程序的「待确认」，前台确认，开始前 N 分钟还没确认的自动取消（MP35）；
//   · 到店：先接待开手牌，再点「到店」——派对房直接开使用单（与平面图开单同一段代码），技师的去派钟，客房的去开房；
//   · 过了开始时间 N 分钟没到店记爽约；客房过了保留时间释放、记爽约；小程序 N 天内爽约几次后一段时间不能预约（MP37）；
//   · 不收订金、不动钱（MP36）。
// 时段（N4）：每个营业日 openTime–closeTime、每格 slotMinutes；技师没有排班表，按在职、能做这个项目、不和已有的预约与钟单重叠算；
//   「不指定」按空着的技师数减去同一时段别的「不指定」预约；派对房按已有的预约与开着的使用单；客房按房型的房间数减去当天的预约与在住。
// 写操作带操作编号（前台的「结果待确认」，可以确认作废）；改时间带版本号。
// 加锁顺序：
//   新建：（小程序：claimKey 的咨询锁 → 会员一行）→ 时段的锁（技师类取「技师预约」咨询锁，所有技师预约串行；派对房锁空间一行；客房锁房型一行）；
//   确认、改时间、取消、爽约：预约单一行 →（改时间再取时段的锁）；
//   到店：预约单一行 →（派对房：来访共享锁 → 空间一行 → 当前位置，与平面图开单一样）；
//   每分钟的自动处理：一张一个事务，只锁那张预约单。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { businessDateOf, businessDayStart, HHMM, ISO_DATE } from '@shared/business-date';
import {
  ACTIVE_BOOKING_STATUSES,
  BOOKING_KIND_LABELS,
  DEFAULT_BOOKING_RULES,
  MAX_BOOKING_GUESTS,
  MAX_BOOKING_NOTE,
  overlaps,
  plusMinutes,
  slotStartMinutes,
  type BookingBoard,
  type BookingDetail,
  type BookingKind,
  type BookingRules,
  type BookingSlot,
  type BookingSource,
} from '@shared/bookings';
import { normalizeTagCode, TAG_CODE_PATTERN } from '@shared/frontdesk';
import { canServe } from '@shared/technicians';
import type { Db, Sql, Tx } from '../db';
import { guard, guardAny } from '../auth/guard';
import { writeAudit, type AuditAction } from '../lib/audit';
import { ctxOf, type Deps, type OpContext } from '../lib/context';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors';
import { hashRequest } from '../lib/idempotency';
import { saveRuleSetting } from '../lib/rule-settings';
import { idParam, parse } from '../lib/validate';
import { businessDate, nextDocNo, runIdempotent, saveKey } from './frontdesk/common';
import { loadSettings } from './settings';
import { systemStaffId } from './system-staff';
import { loadTechnicianRules, loadTechnicians } from './technicians';
import { loadPricedItems } from './pricing';
import { loadUsageRules, openUsageTx } from './usages';
import { ClaimKey, lockClaim, mpContext, saveClaim } from './mp-entries';
import { randomUUID } from 'node:crypto';
import { lockTechnicianBookings } from './booking-guard';

// ───────────────────────── 规则 ─────────────────────────

export async function loadBookingRules(db: Db): Promise<BookingRules> {
  const [row] = await db<{ value: Partial<BookingRules> }[]>`SELECT value FROM settings WHERE key = 'booking_rules'`;
  return { ...DEFAULT_BOOKING_RULES, ...(row?.value ?? {}) };
}

const minutesField = (label: string, min: number, max: number) =>
  z.number(`请填写${label}`).int(`${label}要是整数`).min(min, `${label}最少 ${min}`).max(max, `${label}最多 ${max}`);

const RulesInput = z.object({
  openTime: z.string().regex(HHMM, '时间格式应为 HH:MM'),
  closeTime: z.string().regex(HHMM, '时间格式应为 HH:MM'),
  slotMinutes: z.union([z.literal(15), z.literal(30), z.literal(60)], '一格只能是 15 / 30 / 60 分钟'),
  maxDaysAhead: minutesField('最远能约几天后', 0, 60),
  mpMaxOpen: minutesField('每人同时预约数', 1, 10),
  confirmLeadMinutes: minutesField('自动取消的提前分钟', 0, 1440),
  mpCancelLeadMinutes: minutesField('自己取消的提前分钟', 0, 1440),
  noShowMinutes: minutesField('记爽约的分钟', 5, 240),
  noShowWindowDays: minutesField('爽约统计天数', 1, 365),
  noShowLimit: minutesField('爽约次数', 1, 20),
  noShowBanDays: minutesField('不能预约的天数', 0, 365),
  spaceDurations: z.array(minutesField('时长', 30, 720)).min(1, '至少一个时长').max(8, '时长最多 8 个'),
  defaultServiceMinutes: minutesField('项目默认时长', 15, 480),
  roomHoldMinutes: minutesField('客房保留分钟', 0, 1440),
});

async function saveBookingRules(deps: Deps, raw: unknown, ctx: OpContext) {
  const next = parse(RulesInput, raw);
  await saveRuleSetting(deps.sql, 'booking_rules', loadBookingRules, () => ({ ...next, spaceDurations: [...new Set(next.spaceDurations)].sort((a, b) => a - b) }), ctx);
  return loadBookingRules(deps.sql);
}

// ───────────────────────── 读取 ─────────────────────────

const iso = (v: string | Date | null) => (v === null ? null : new Date(v).toISOString());

type BookingRow = Omit<BookingDetail, 'startsAt' | 'endsAt' | 'holdUntil' | 'createdAt' | 'confirmedAt' | 'arrivedAt' | 'cancelledAt' | 'noShowAt' | 'technicianText'> & {
  startsAt: string;
  endsAt: string;
  holdUntil: string | null;
  createdAt: string;
  confirmedAt: string | null;
  arrivedAt: string | null;
  cancelledAt: string | null;
  noShowAt: string | null;
  techNo: string | null;
  techName: string | null;
};

async function readBookings(db: Db, where: { id?: number; date?: string; memberId?: number }): Promise<BookingDetail[]> {
  return (await readBookingRows(db, where)).map(({ techNo: _techNo, ...d }) => d);
}

/** 同 readBookings，另带技师的工号（小程序「我的预约」要；前台看板、单张预约的形状不变） */
async function readBookingRows(db: Db, where: { id?: number; date?: string; memberId?: number }): Promise<(BookingDetail & { techNo: string | null })[]> {
  const rows = await db<BookingRow[]>`
    SELECT b.id, b.booking_no, b.kind, b.source, b.status, b.member_id, m.name AS member_name, b.guest_name, b.guest_phone, b.guests,
           b.item_id, i.name AS item_name, b.technician_id, t.tech_no, t.name AS tech_name,
           b.space_id, sp.code AS space_code, sp.display_name AS space_name, b.room_type_id, rt.name AS room_type_name,
           b.starts_at, b.ends_at, b.hold_until, b.note, b.business_date::text AS business_date, st.display_name AS created_by_name, b.created_at,
           b.confirmed_at, b.arrived_at, ht.code AS arrival_tag_code, b.arrival_ref, b.cancelled_at, b.cancel_reason, b.no_show_at, b.version
    FROM bookings b JOIN staff st ON st.id = b.created_by
    LEFT JOIN members m ON m.id = b.member_id LEFT JOIN service_items i ON i.id = b.item_id LEFT JOIN technicians t ON t.id = b.technician_id
    LEFT JOIN spaces sp ON sp.id = b.space_id LEFT JOIN room_types rt ON rt.id = b.room_type_id
    LEFT JOIN visits v ON v.id = b.arrival_visit_id LEFT JOIN hand_tags ht ON ht.id = v.tag_id
    WHERE ${where.id !== undefined ? db`b.id = ${where.id}` : db`true`}
      AND ${where.date !== undefined ? db`b.business_date = ${where.date}` : db`true`}
      AND ${where.memberId !== undefined ? db`b.member_id = ${where.memberId}` : db`true`}
    ORDER BY b.starts_at, b.id`;
  return rows.map(({ techNo, techName, ...r }) => ({
    ...r,
    techNo,
    id: Number(r.id),
    memberId: r.memberId === null ? null : Number(r.memberId),
    itemId: r.itemId === null ? null : Number(r.itemId),
    technicianId: r.technicianId === null ? null : Number(r.technicianId),
    spaceId: r.spaceId === null ? null : Number(r.spaceId),
    roomTypeId: r.roomTypeId === null ? null : Number(r.roomTypeId),
    technicianText: techNo ? `${techNo} 号 ${techName}` : r.kind === 'technician' ? '不指定' : null,
    startsAt: iso(r.startsAt)!,
    endsAt: iso(r.endsAt)!,
    holdUntil: iso(r.holdUntil),
    createdAt: iso(r.createdAt)!,
    confirmedAt: iso(r.confirmedAt),
    arrivedAt: iso(r.arrivedAt),
    cancelledAt: iso(r.cancelledAt),
    noShowAt: iso(r.noShowAt),
  }));
}

export async function getBooking(db: Db, id: number): Promise<BookingDetail> {
  const [b] = await readBookings(db, { id });
  if (!b) throw notFound('预约单不存在');
  return b;
}

/** 前台预约看板：这一天的预约，与新建时要挑的技师、项目、房间、房型 */
export async function bookingBoard(db: Db, date: string): Promise<BookingBoard> {
  const rules = await loadBookingRules(db);
  const usageTypes = (await loadUsageRules(db)).businessTypes;
  const [bookings, technicians, items, spaces, roomTypes] = await Promise.all([
    readBookings(db, { date }),
    db<BookingBoard['technicians']>`SELECT id, tech_no, name, gender FROM technicians WHERE active ORDER BY sort_order, tech_no`,
    db<{ id: number; name: string; durationMinutes: number | null }[]>`
      SELECT id, name, duration_minutes FROM service_items WHERE active AND technician_required ORDER BY sort_order, id`,
    usageTypes.length
      ? db<BookingBoard['spaces']>`
          SELECT id, code, display_name AS name, business_type, capacity FROM spaces
          WHERE active AND sellable AND business_type IN ${db(usageTypes)} ORDER BY code`
      : Promise.resolve([] as BookingBoard['spaces']),
    db<BookingBoard['roomTypes']>`
      SELECT rt.id, rt.name, (SELECT count(*)::int FROM rooms r WHERE r.room_type_id = rt.id AND r.active) AS rooms
      FROM room_types rt WHERE rt.active ORDER BY rt.sort_order, rt.id`,
  ]);
  return {
    date,
    rules,
    bookings,
    technicians: technicians.map((t) => ({ ...t, id: Number(t.id) })),
    items: items.map((i) => ({ id: Number(i.id), name: i.name, minutes: i.durationMinutes ?? rules.defaultServiceMinutes })),
    spaces: spaces.map((s) => ({ ...s, id: Number(s.id) })),
    roomTypes: roomTypes.map((r) => ({ ...r, id: Number(r.id) })),
  };
}

// ───────────────────────── 时段 ─────────────────────────

async function storeClock(db: Db, deps: Pick<Deps, 'config'>) {
  const { businessDayStartHour } = await loadSettings(db);
  return { timezone: deps.config.timezone, startHour: businessDayStartHour };
}

/** 某个营业日的时段（开始、结束的时刻） */
function daySlots(date: string, rules: BookingRules, duration: number, timezone: string) {
  const zero = businessDayStart(date, timezone, 0).getTime();
  return slotStartMinutes(rules, duration).map((m) => ({ start: zero + m * 60_000, end: zero + (m + duration) * 60_000 }));
}

type Busy = { start: number; end: number };

/** 这几位技师在 [from, to) 里占着的时段：还占着时段的预约（指定了技师的）、没结束的钟单（按计划的时长） */
async function technicianBusy(db: Db, ids: number[], from: number, to: number, excludeBookingId?: number): Promise<Map<number, Busy[]>> {
  const out = new Map<number, Busy[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return out;
  const bookings = await db<{ technicianId: number; startsAt: string; endsAt: string }[]>`
    SELECT technician_id, starts_at, ends_at FROM bookings
    WHERE technician_id IN ${db(ids)} AND status IN ${db(ACTIVE_BOOKING_STATUSES)} AND starts_at < ${new Date(to)} AND ends_at > ${new Date(from)}
      AND id <> ${excludeBookingId ?? 0}`;
  for (const b of bookings) out.get(Number(b.technicianId))?.push({ start: Date.parse(b.startsAt), end: Date.parse(b.endsAt) });
  // 钟单的 minutes 已经是全部钟数的分钟数（加钟时一起加），不再乘钟数
  const sessions = await db<{ technicianId: number; startedAt: string | null; minutes: number }[]>`
    SELECT s.technician_id, s.started_at, s.minutes FROM technician_sessions s
    WHERE s.technician_id IN ${db(ids)} AND s.status IN ('waiting', 'serving')`;
  const now = Date.now();
  for (const s of sessions) {
    const start = s.startedAt ? Date.parse(s.startedAt) : now;
    out.get(Number(s.technicianId))?.push({ start, end: start + Number(s.minutes) * 60_000 });
  }
  return out;
}

/** 「不指定」的预约在 [from, to) 里的时段 */
async function unassignedBusy(db: Db, from: number, to: number, excludeBookingId?: number): Promise<Busy[]> {
  const rows = await db<{ startsAt: string; endsAt: string }[]>`
    SELECT starts_at, ends_at FROM bookings
    WHERE kind = 'technician' AND technician_id IS NULL AND status IN ${db(ACTIVE_BOOKING_STATUSES)}
      AND starts_at < ${new Date(to)} AND ends_at > ${new Date(from)} AND id <> ${excludeBookingId ?? 0}`;
  return rows.map((r) => ({ start: Date.parse(r.startsAt), end: Date.parse(r.endsAt) }));
}

/** 这间房在 [from, to) 里占着的时段：还占着时段的预约、开着的使用单（开单起到此刻之后 60 分钟，N4） */
async function spaceBusy(db: Db, spaceId: number, from: number, to: number, excludeBookingId?: number): Promise<Busy[]> {
  const rows = await db<{ startsAt: string; endsAt: string }[]>`
    SELECT starts_at, ends_at FROM bookings
    WHERE space_id = ${spaceId} AND status IN ${db(ACTIVE_BOOKING_STATUSES)} AND starts_at < ${new Date(to)} AND ends_at > ${new Date(from)}
      AND id <> ${excludeBookingId ?? 0}`;
  const out = rows.map((r) => ({ start: Date.parse(r.startsAt), end: Date.parse(r.endsAt) }));
  const [u] = await db<{ openedAt: string }[]>`SELECT opened_at FROM space_usages WHERE space_id = ${spaceId} AND status = 'open'`;
  if (u) out.push({ start: Date.parse(u.openedAt), end: Math.max(Date.now(), Date.parse(u.openedAt)) + 60 * 60_000 });
  return out;
}

/** 这个房型当天还剩几间：启用的房间（不含维修）− 当天还占着名额的预约 − （当天）在住 */
async function roomTypeFree(db: Db, roomTypeId: number, date: string, today: string, excludeBookingId?: number): Promise<number> {
  const [r] = await db<{ rooms: number; booked: number; staying: number }[]>`
    SELECT (SELECT count(*)::int FROM rooms WHERE room_type_id = ${roomTypeId} AND active AND housekeeping <> 'maintenance') AS rooms,
           (SELECT count(*)::int FROM bookings WHERE room_type_id = ${roomTypeId} AND business_date = ${date}
              AND status IN ${db(ACTIVE_BOOKING_STATUSES)} AND id <> ${excludeBookingId ?? 0}) AS booked,
           (SELECT count(*)::int FROM room_stays s JOIN rooms ro ON ro.id = s.room_id WHERE ro.room_type_id = ${roomTypeId} AND s.status = 'open') AS staying`;
  return Math.max(0, r!.rooms - r!.booked - (date === today ? r!.staying : 0));
}

interface TechnicianTarget {
  item: { id: number; name: string; category: string; prices: { tier: 'standard' | 'professional' | 'premium' }[]; minutes: number };
  eligible: number[];
}

/** 预约技师：项目要是需要技师、启用的；能做这个项目的在职技师 */
async function technicianTarget(db: Db, itemId: number, rules: BookingRules): Promise<TechnicianTarget> {
  const items = await loadPricedItems(db, [itemId]);
  const item = items.get(itemId);
  if (!item || !item.active || !item.technicianRequired) throw unprocessable('BOOKING_ITEM', '这个项目不能预约技师：要是启用的、需要技师的项目');
  const [d] = await db<{ durationMinutes: number | null }[]>`SELECT duration_minutes FROM service_items WHERE id = ${itemId}`;
  const techRules = await loadTechnicianRules(db);
  const all = [...(await loadTechnicians(db)).values()];
  const eligible = all.filter((t) => t.active && canServe(t, item, techRules.tierByGrade) === null).map((t) => t.id);
  return { item: { id: item.id, name: item.name, category: item.category, prices: item.prices, minutes: d?.durationMinutes ?? rules.defaultServiceMinutes }, eligible };
}

const SlotQuery = z.object({
  kind: z.enum(['technician', 'space', 'room']),
  date: z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD'),
  itemId: z.coerce.number().int().positive().optional(),
  technicianId: z.coerce.number().int().positive().optional(),
  spaceId: z.coerce.number().int().positive().optional(),
  roomTypeId: z.coerce.number().int().positive().optional(),
  durationMinutes: z.coerce.number().int().min(15).max(720).optional(),
});
export type BookingSlotQuery = z.input<typeof SlotQuery>;

/**
 * 可约时段（只读；前台新建、小程序选时段用）。
 * 技师：每个时段空着的技师（指定了技师的只看这一位），「不指定」时还要减去同一时段别的「不指定」预约；
 * 派对房：每个时段这间房空不空；客房：当天这个房型还剩几间（一个时段，开始为营业日的 openTime）
 */
export async function bookingSlots(db: Db, deps: Pick<Deps, 'config'>, raw: BookingSlotQuery): Promise<BookingSlot[]> {
  const q = parse(SlotQuery, raw);
  const rules = await loadBookingRules(db);
  const clock = await storeClock(db, deps);
  const now = Date.now();
  if (q.kind === 'room') {
    if (!q.roomTypeId) throw badRequest('请选择房型');
    const today = businessDateOf(new Date(), clock.timezone, clock.startHour);
    const zero = businessDayStart(q.date, clock.timezone, 0).getTime();
    const open = Number(rules.openTime.slice(0, 2)) * 60 + Number(rules.openTime.slice(3, 5));
    let close = Number(rules.closeTime.slice(0, 2)) * 60 + Number(rules.closeTime.slice(3, 5));
    if (close <= open) close += 24 * 60;
    // 一个时段：营业日能约的时段（预计到店在这中间选）
    return [{ startsAt: new Date(zero + open * 60_000).toISOString(), endsAt: new Date(zero + close * 60_000).toISOString(), free: await roomTypeFree(db, q.roomTypeId, q.date, today) }];
  }
  if (q.kind === 'space') {
    if (!q.spaceId) throw badRequest('请选择房间');
    const duration = q.durationMinutes ?? rules.spaceDurations[0] ?? 120;
    const slots = daySlots(q.date, rules, duration, clock.timezone).filter((s) => s.start >= now);
    if (slots.length === 0) return [];
    const busy = await spaceBusy(db, q.spaceId, slots[0]!.start, slots.at(-1)!.end);
    return slots.map((s) => ({ startsAt: new Date(s.start).toISOString(), endsAt: new Date(s.end).toISOString(), free: busy.some((b) => overlaps(s.start, s.end, b.start, b.end)) ? 0 : 1 }));
  }
  if (!q.itemId) throw badRequest('请选择项目');
  const target = await technicianTarget(db, q.itemId, rules);
  const ids = q.technicianId ? target.eligible.filter((id) => id === q.technicianId) : target.eligible;
  const slots = daySlots(q.date, rules, target.item.minutes, clock.timezone).filter((s) => s.start >= now);
  if (slots.length === 0) return [];
  const from = slots[0]!.start;
  const to = slots.at(-1)!.end;
  const busy = await technicianBusy(db, target.eligible, from, to);
  const loose = await unassignedBusy(db, from, to);
  return slots.map((s) => {
    const freeIds = ids.filter((id) => !busy.get(id)!.some((b) => overlaps(s.start, s.end, b.start, b.end)));
    // 不指定：空着的技师（全部能做的）减去同一时段别的「不指定」预约
    const allFree = target.eligible.filter((id) => !busy.get(id)!.some((b) => overlaps(s.start, s.end, b.start, b.end))).length;
    const taken = loose.filter((b) => overlaps(s.start, s.end, b.start, b.end)).length;
    const free = q.technicianId ? (freeIds.length > 0 && allFree - taken >= 1 ? 1 : 0) : Math.max(0, allFree - taken);
    return { startsAt: new Date(s.start).toISOString(), endsAt: new Date(s.end).toISOString(), free, technicianIds: freeIds };
  });
}

// ───────────────────────── 新建 ─────────────────────────

const PhoneField = z
  .string()
  .transform((s) => s.replace(/[\s-]/g, ''))
  .pipe(z.string().regex(/^(1\d{10})?$/, '请输入 11 位手机号'));

const CreateInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  kind: z.enum(['technician', 'space', 'room'], '请选择预约什么'),
  source: z.enum(['front', 'phone'], '请选择来源').default('front'),
  memberId: z.number().int().positive().nullable().default(null),
  guestName: z.string().trim().max(32, '姓名最多 32 字').default(''),
  guestPhone: PhoneField.default(''),
  guests: z.number().int().min(1, '至少 1 人').max(MAX_BOOKING_GUESTS, `最多 ${MAX_BOOKING_GUESTS} 人`).default(1),
  itemId: z.number().int().positive().optional(),
  technicianId: z.number().int().positive().nullable().optional(),
  spaceId: z.number().int().positive().optional(),
  roomTypeId: z.number().int().positive().optional(),
  startsAt: z.iso.datetime({ offset: true, message: '请选择开始时间' }),
  durationMinutes: z.number().int().min(30).max(720).optional(),
  note: z.string().trim().max(MAX_BOOKING_NOTE, `备注最多 ${MAX_BOOKING_NOTE} 字`).default(''),
});
export type BookingCreateInput = z.input<typeof CreateInput>;

interface CreateArgs {
  kind: BookingKind;
  source: BookingSource;
  memberId: number | null;
  guestName: string;
  guestPhone: string;
  guests: number;
  itemId?: number;
  technicianId?: number | null;
  spaceId?: number;
  roomTypeId?: number;
  startsAt: Date;
  durationMinutes?: number;
  note: string;
  /** 小程序的要对齐时段、在最远天数内；前台的只要在营业时段内、不早于此刻 */
  strictGrid: boolean;
}

// 与前台建钟单、加钟同一把锁（booking-guard.ts）


/**
 * 核对时段、取时段的锁、算出结束时刻（新建、改时间共用）。返回结束时刻与客房的保留时刻
 */
async function claimSlot(tx: Tx, deps: Pick<Deps, 'config'>, a: CreateArgs, rules: BookingRules, excludeBookingId?: number) {
  const clock = await storeClock(tx, deps);
  const now = Date.now();
  const start = a.startsAt.getTime();
  const date = businessDateOf(a.startsAt, clock.timezone, clock.startHour);
  const today = businessDateOf(new Date(now), clock.timezone, clock.startHour);
  if (start < now - 5 * 60_000) throw unprocessable('BOOKING_PAST', a.kind === 'room' ? '预计到店时间已经过了，请重新选' : '开始时间已经过了，请重新选');
  const lastDay = businessDateOf(new Date(Date.parse(`${today}T12:00:00Z`) + rules.maxDaysAhead * 86_400_000), 'UTC', 0);
  if (date < today || date > lastDay) throw unprocessable('BOOKING_RANGE', `只能约今天到 ${rules.maxDaysAhead} 天后（${lastDay}）`);
  if (a.kind === 'room') {
    if (!a.roomTypeId) throw badRequest('请选择房型');
    const [rt] = await tx<{ id: number; name: string; active: boolean }[]>`SELECT id, name, active FROM room_types WHERE id = ${a.roomTypeId} FOR NO KEY UPDATE`;
    if (!rt || !rt.active) throw unprocessable('BOOKING_ROOM_TYPE', '房型不存在或已停用');
    if ((await roomTypeFree(tx, a.roomTypeId, date, today, excludeBookingId)) < 1) throw conflict('BOOKING_FULL', `「${rt.name}」${date} 已经约满了`);
    const end = plusMinutes(a.startsAt, 60);
    return { end, holdUntil: plusMinutes(a.startsAt, rules.roomHoldMinutes), date, label: rt.name };
  }
  if (a.kind === 'space') {
    if (!a.spaceId) throw badRequest('请选择房间');
    const duration = a.durationMinutes ?? rules.spaceDurations[0] ?? 120;
    if (a.strictGrid && !rules.spaceDurations.includes(duration)) throw unprocessable('BOOKING_DURATION', `时长只能选 ${rules.spaceDurations.map((m) => `${m / 60} 小时`).join('、')}`);
    const [sp] = await tx<{ id: number; code: string; businessType: string; active: boolean; sellable: boolean }[]>`
      SELECT id, code, business_type, active, sellable FROM spaces WHERE id = ${a.spaceId} FOR NO KEY UPDATE`;
    const usageTypes = (await loadUsageRules(tx)).businessTypes;
    if (!sp || !sp.active || !sp.sellable || !usageTypes.includes(sp.businessType)) throw unprocessable('BOOKING_SPACE', '这间房不能预约：要是启用、可售、开单即占用的房间');
    assertInWindow(a.startsAt, duration, date, rules, clock.timezone, a.strictGrid);
    const end = plusMinutes(a.startsAt, duration);
    const busy = await spaceBusy(tx, sp.id, start, end.getTime(), excludeBookingId);
    if (busy.some((b) => overlaps(start, end.getTime(), b.start, b.end))) throw conflict('BOOKING_TAKEN', `${sp.code} 这个时段已经有人约了或正在用，请换一个时段`);
    return { end, holdUntil: null, date, label: sp.code };
  }
  if (!a.itemId) throw badRequest('请选择项目');
  const target = await technicianTarget(tx, a.itemId, rules);
  assertInWindow(a.startsAt, target.item.minutes, date, rules, clock.timezone, a.strictGrid);
  const end = plusMinutes(a.startsAt, target.item.minutes);
  // 所有技师预约串行：同一时段的「指定」与「不指定」互相影响
  await lockTechnicianBookings(tx);
  const busy = await technicianBusy(tx, target.eligible, start, end.getTime(), excludeBookingId);
  const free = target.eligible.filter((id) => !busy.get(id)!.some((b) => overlaps(start, end.getTime(), b.start, b.end)));
  const loose = (await unassignedBusy(tx, start, end.getTime(), excludeBookingId)).filter((b) => overlaps(start, end.getTime(), b.start, b.end)).length;
  if (a.technicianId) {
    const t = (await loadTechnicians(tx, [a.technicianId])).get(a.technicianId);
    if (!t || !target.eligible.includes(a.technicianId)) throw unprocessable('BOOKING_TECHNICIAN', `${t ? `${t.techNo} 号 ${t.name}` : '这位技师'}不能做「${target.item.name}」或已停用`);
    if (!free.includes(a.technicianId) || free.length - 1 < loose) throw conflict('BOOKING_TAKEN', `${t.techNo} 号 ${t.name} 这个时段已经有预约或在上钟，请换一个时段或技师`);
  } else if (free.length - loose < 1) {
    throw conflict('BOOKING_TAKEN', `这个时段能做「${target.item.name}」的技师都约满了，请换一个时段`);
  }
  return { end, holdUntil: null, date, label: target.item.name };
}

function assertInWindow(start: Date, duration: number, date: string, rules: BookingRules, timezone: string, strictGrid: boolean) {
  const zero = businessDayStart(date, timezone, 0).getTime();
  const m = Math.round((start.getTime() - zero) / 60_000);
  const starts = slotStartMinutes(rules, duration);
  if (strictGrid ? !starts.includes(m) : m < (starts[0] ?? 0) || m > (starts.at(-1) ?? -1)) {
    throw unprocessable('BOOKING_TIME', `只能约 ${rules.openTime}–${rules.closeTime} 之间${strictGrid ? `、每 ${rules.slotMinutes} 分钟一格的时段` : ''}，要能在结束前做完`);
  }
}

/** 新建（调用方的事务里，已核对过重提）：返回预约单编号 */
async function createBookingTx(tx: Tx, deps: Pick<Deps, 'config'>, a: CreateArgs, actor: { id: number }, clientKey: string, requestHash: string, at: Date): Promise<number> {
  const rules = await loadBookingRules(tx);
  if (a.memberId !== null) {
    const [m] = await tx<{ status: string }[]>`SELECT status FROM members WHERE id = ${a.memberId}`;
    if (!m) throw notFound('会员不存在');
    if (m.status !== 'active') throw unprocessable('MEMBER_INACTIVE', '这位会员已停用或已合并，不能预约');
  } else if (!a.guestName && !a.guestPhone) {
    throw badRequest('请选会员，或填客人姓名、电话', { field: 'guestName' });
  }
  const slot = await claimSlot(tx, deps, a, rules);
  const bookingNo = await nextDocNo(tx, 'booking', 'YY', slot.date);
  const status = a.source === 'mp' ? 'pending' : 'confirmed';
  const [row] = await tx<{ id: number }[]>`
    INSERT INTO bookings (booking_no, kind, source, status, member_id, guest_name, guest_phone, guests, item_id, technician_id, space_id, room_type_id,
                          starts_at, ends_at, hold_until, note, business_date, created_by, created_at, client_key, request_hash, confirmed_by, confirmed_at)
    VALUES (${bookingNo}, ${a.kind}, ${a.source}, ${status}, ${a.memberId}, ${a.guestName}, ${a.guestPhone}, ${a.guests},
            ${a.kind === 'technician' ? (a.itemId ?? null) : null}, ${a.kind === 'technician' ? (a.technicianId ?? null) : null},
            ${a.kind === 'space' ? (a.spaceId ?? null) : null}, ${a.kind === 'room' ? (a.roomTypeId ?? null) : null},
            ${a.startsAt}, ${slot.end}, ${slot.holdUntil}, ${a.note}, ${slot.date}, ${actor.id}, ${at}, ${clientKey}, ${requestHash},
            ${status === 'confirmed' ? actor.id : null}, ${status === 'confirmed' ? at : null})
    RETURNING id`;
  const id = Number(row!.id);
  await writeAudit(tx, {
    staffId: actor.id,
    action: 'booking_create',
    targetType: 'booking',
    targetId: id,
    detail: { bookingNo, kind: BOOKING_KIND_LABELS[a.kind], source: a.source, target: slot.label, startsAt: a.startsAt.toISOString(), memberId: a.memberId ?? undefined },
    businessDate: slot.date,
  });
  return id;
}

/** 前台、电话新建（「预约」页）：直接「已预约」 */
export async function createBooking(deps: Deps, raw: unknown, ctx: OpContext): Promise<BookingDetail> {
  const input = parse(CreateInput, raw);
  const { clientKey: key, ...payload } = input;
  const requestHash = hashRequest(payload);
  const run = await runIdempotent(deps, { key, opType: 'booking_create', requestHash }, async (tx) => {
    const id = await createBookingTx(
      tx,
      deps,
      { ...payload, startsAt: new Date(payload.startsAt), strictGrid: false },
      ctx.actor,
      key,
      requestHash,
      ctx.at ?? new Date(),
    );
    await saveKey(tx, key, 'booking_create', requestHash, id, ctx.actor.id);
    return id;
  });
  return getBooking(deps.sql, run.refId);
}

// ───────────────────────── 确认、改时间、取消、爽约、到店 ─────────────────────────

interface LockedBooking {
  id: number;
  bookingNo: string;
  kind: BookingKind;
  source: BookingSource;
  status: string;
  memberId: number | null;
  itemId: number | null;
  technicianId: number | null;
  spaceId: number | null;
  roomTypeId: number | null;
  startsAt: string;
  endsAt: string;
  guests: number;
  version: number;
  businessDate: string;
}

async function lockBooking(tx: Tx, id: number): Promise<LockedBooking> {
  const [b] = await tx<LockedBooking[]>`
    SELECT id, booking_no, kind, source, status, member_id, item_id, technician_id, space_id, room_type_id, starts_at, ends_at, guests, version,
           business_date::text AS business_date
    FROM bookings WHERE id = ${id} FOR UPDATE`;
  if (!b) throw notFound('预约单不存在');
  return { ...b, id: Number(b.id) };
}

const stillOpen = (b: LockedBooking) => {
  if (b.status !== 'pending' && b.status !== 'confirmed') {
    const label = { arrived: '已到店', cancelled: '已取消', no_show: '已记爽约' }[b.status] ?? b.status;
    throw conflict('BOOKING_CLOSED', `预约 ${b.bookingNo} ${label}，请刷新`);
  }
};
const checkVersion = (b: LockedBooking, expected: number) => {
  if (b.version !== expected) throw conflict('BOOKING_CHANGED', `预约 ${b.bookingNo} 刚刚被改过，请刷新后再操作`);
};

const ChangeInput = z.discriminatedUnion('action', [
  z.object({ clientKey: z.uuid(), action: z.literal('confirm'), expectedVersion: z.number().int().positive() }),
  z.object({
    clientKey: z.uuid(),
    action: z.literal('reschedule'),
    expectedVersion: z.number().int().positive(),
    startsAt: z.iso.datetime({ offset: true, message: '请选择开始时间' }),
    durationMinutes: z.number().int().min(30).max(720).optional(),
    technicianId: z.number().int().positive().nullable().optional(),
  }),
  z.object({ clientKey: z.uuid(), action: z.literal('cancel'), reason: z.string('请填写取消原因').trim().min(2, '请填写取消原因（至少 2 个字）').max(200) }),
  z.object({ clientKey: z.uuid(), action: z.literal('no_show') }),
  z.object({
    clientKey: z.uuid(),
    action: z.literal('arrive'),
    tagCode: z
      .string('请填写客人的手牌号')
      .transform((v) => normalizeTagCode(v))
      .pipe(z.string().min(1, '请填写客人的手牌号').regex(TAG_CODE_PATTERN, '牌号格式不正确（例如 A023、1088）')),
  }),
]);
export type BookingChangeInput = z.input<typeof ChangeInput>;

/** 改一张预约（前台）：确认、改时间、取消、记爽约、到店；同一编号重提返回原结果 */
export async function changeBooking(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<BookingDetail> {
  const input = parse(ChangeInput, raw);
  const { clientKey: key, ...payload } = input;
  const requestHash = hashRequest({ id, ...payload });
  await runIdempotent(deps, { key, opType: 'booking_change', requestHash }, async (tx) => {
    await changeBookingTx(tx, deps, id, payload, ctx, key);
    await saveKey(tx, key, 'booking_change', requestHash, id, ctx.actor.id);
    return id;
  });
  return getBooking(deps.sql, id);
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type ChangePayload = DistributiveOmit<z.output<typeof ChangeInput>, 'clientKey'>;

async function changeBookingTx(tx: Tx, deps: Deps, id: number, p: ChangePayload, ctx: OpContext, key: string) {
  const at = ctx.at ?? new Date();
  const b = await lockBooking(tx, id);
  const audit = (action: AuditAction, detail: Record<string, unknown>) =>
    writeAudit(tx, { staffId: ctx.actor.id, action, targetType: 'booking', targetId: id, detail: { bookingNo: b.bookingNo, ...detail }, ip: ctx.ip, businessDate: b.businessDate });
  if (p.action === 'confirm') {
    checkVersion(b, p.expectedVersion);
    if (b.status !== 'pending') throw conflict('BOOKING_CLOSED', `预约 ${b.bookingNo} 不是待确认的，请刷新`);
    await tx`UPDATE bookings SET status = 'confirmed', confirmed_by = ${ctx.actor.id}, confirmed_at = ${at}, version = version + 1 WHERE id = ${id}`;
    await audit('booking_confirm', {});
    return;
  }
  if (p.action === 'reschedule') {
    checkVersion(b, p.expectedVersion);
    stillOpen(b);
    const rules = await loadBookingRules(tx);
    const startsAt = new Date(p.startsAt);
    const duration = p.durationMinutes ?? Math.round((Date.parse(b.endsAt) - Date.parse(b.startsAt)) / 60_000);
    const technicianId = b.kind === 'technician' ? (p.technicianId === undefined ? b.technicianId : p.technicianId) : null;
    const slot = await claimSlot(
      tx,
      deps,
      {
        kind: b.kind,
        source: b.source,
        memberId: b.memberId,
        guestName: '',
        guestPhone: '',
        guests: b.guests,
        itemId: b.itemId ?? undefined,
        technicianId,
        spaceId: b.spaceId ?? undefined,
        roomTypeId: b.roomTypeId ?? undefined,
        startsAt,
        durationMinutes: duration,
        note: '',
        strictGrid: false,
      },
      rules,
      id,
    );
    await tx`
      UPDATE bookings SET starts_at = ${startsAt}, ends_at = ${slot.end}, hold_until = ${slot.holdUntil}, business_date = ${slot.date},
             technician_id = ${technicianId}, version = version + 1
      WHERE id = ${id}`;
    await audit('booking_reschedule', { from: new Date(b.startsAt).toISOString(), to: startsAt.toISOString(), technicianId: technicianId ?? undefined });
    return;
  }
  if (p.action === 'cancel') {
    stillOpen(b);
    await tx`UPDATE bookings SET status = 'cancelled', cancelled_by = ${ctx.actor.id}, cancelled_at = ${at}, cancel_reason = ${p.reason}, version = version + 1 WHERE id = ${id}`;
    await audit('booking_cancel', { reason: p.reason });
    return;
  }
  if (p.action === 'no_show') {
    stillOpen(b);
    await tx`UPDATE bookings SET status = 'no_show', no_show_by = ${ctx.actor.id}, no_show_at = ${at}, version = version + 1 WHERE id = ${id}`;
    await audit('booking_no_show', {});
    return;
  }
  // 到店：客人要先接待开手牌；派对房直接开使用单
  stillOpen(b);
  const [v] = await tx<{ id: number }[]>`
    SELECT v.id FROM visits v JOIN hand_tags h ON h.id = v.tag_id WHERE h.code = ${p.tagCode} AND v.status = 'open'`;
  if (!v) throw conflict('TAG_NOT_IN_STORE', `手牌 ${p.tagCode} 没有在店客人：请先接待开手牌，再点到店`);
  let ref: string | null = null;
  if (b.kind === 'space') {
    const usageId = await openUsageTx(tx, deps, { spaceId: b.spaceId!, tagCode: p.tagCode, guests: b.guests, note: `预约 ${b.bookingNo}` }, key, ctx);
    const [u] = await tx<{ usageNo: string }[]>`SELECT usage_no FROM space_usages WHERE id = ${usageId}`;
    ref = u!.usageNo;
  }
  await tx`
    UPDATE bookings SET status = 'arrived', arrived_by = ${ctx.actor.id}, arrived_at = ${at}, arrival_visit_id = ${v.id}, arrival_ref = ${ref},
           confirmed_by = coalesce(confirmed_by, ${ctx.actor.id}), confirmed_at = coalesce(confirmed_at, ${at}), version = version + 1
    WHERE id = ${id}`;
  await audit('booking_arrive', { tagCode: p.tagCode, ...(ref ? { usageNo: ref } : {}) });
}

// ───────────────────────── 每分钟的自动处理 ─────────────────────────

/**
 * 小程序预约开始前 N 分钟还没确认的自动取消（MP35）；过了开始时间 N 分钟还没到店的记爽约（MP37）；客房过了保留时间记爽约（Q17）。
 * 一张一个事务，只锁那张预约单；返回处理了几张
 */
export async function sweepBookings(sql: Sql, now = new Date()): Promise<{ cancelled: number; noShow: number }> {
  const rules = await loadBookingRules(sql);
  // 到了的：没确认的小程序预约到了自动取消的时刻；其余过了记爽约的时刻（客房：过了保留时间）
  const due = await sql<{ id: number }[]>`
    SELECT id FROM bookings
    WHERE (status = 'pending' AND source = 'mp' AND starts_at - ${`${rules.confirmLeadMinutes} minutes`}::interval <= ${now})
       OR (status IN ('pending', 'confirmed') AND (
             (kind <> 'room' AND starts_at + ${`${rules.noShowMinutes} minutes`}::interval <= ${now}) OR (kind = 'room' AND hold_until <= ${now})))
    ORDER BY id`;
  let cancelled = 0;
  let noShow = 0;
  for (const d of due) {
    await sql.begin(async (tx) => {
      const [b] = await tx<{ status: string; source: string; kind: BookingKind; bookingNo: string; businessDate: string; startsAt: Date; holdUntil: Date | null }[]>`
        SELECT status, source, kind, booking_no, business_date::text AS business_date, starts_at, hold_until FROM bookings WHERE id = ${d.id} FOR UPDATE`;
      if (!b || (b.status !== 'pending' && b.status !== 'confirmed')) return;
      // 锁住以后按最新的时间再核对一次（刚改过时间的不动）
      const t = now.getTime();
      const start = new Date(b.startsAt).getTime();
      const unconfirmed = b.status === 'pending' && b.source === 'mp' && start - rules.confirmLeadMinutes * 60_000 <= t;
      const missed = b.kind === 'room' ? !!b.holdUntil && new Date(b.holdUntil).getTime() <= t : start + rules.noShowMinutes * 60_000 <= t;
      if (!unconfirmed && !missed) return;
      const staffId = await systemStaffId(tx);
      // 还没确认的小程序预约（停机后两个条件同时到了也一样）：自动取消，不算顾客爽约
      if (unconfirmed) {
        await tx`
          UPDATE bookings SET status = 'cancelled', cancelled_at = ${now}, cancel_reason = ${`开始前 ${rules.confirmLeadMinutes} 分钟还没确认，自动取消`}, version = version + 1
          WHERE id = ${d.id}`;
        cancelled += 1;
        await writeAudit(tx, { staffId, action: 'booking_cancel', targetType: 'booking', targetId: Number(d.id), detail: { bookingNo: b.bookingNo, auto: true }, businessDate: b.businessDate });
      } else {
        await tx`UPDATE bookings SET status = 'no_show', no_show_at = ${now}, version = version + 1 WHERE id = ${d.id}`;
        noShow += 1;
        await writeAudit(tx, { staffId, action: 'booking_no_show', targetType: 'booking', targetId: Number(d.id), detail: { bookingNo: b.bookingNo, auto: true }, businessDate: b.businessDate });
      }
    });
  }
  return { cancelled, noShow };
}

// ───────────────────────── 小程序（3d）的入口 ─────────────────────────

/** 小程序看自己的预约（不带门店内部信息：经办人、备注之外的客人信息） */
export interface MpBooking {
  id: number;
  bookingNo: string;
  kind: BookingKind;
  status: BookingDetail['status'];
  itemName: string | null;
  technicianText: string | null;
  /** 指定的技师的工号（不指定、不是技师预约时为 null；小程序线 2026-11-04 要的，显示用 technicianText 也行） */
  techNo: string | null;
  spaceName: string | null;
  startsAt: string;
  endsAt: string;
  guests: number;
  cancelReason: string | null;
  /** 现在还能在小程序自己取消 */
  cancellable: boolean;
}

/** 这位会员在小程序能不能预约（爽约限制，MP37）：被限制时给到哪天 */
export async function mpBookingBan(db: Db, memberId: number, now = new Date()): Promise<{ banned: boolean; until: string | null; noShows: number }> {
  const rules = await loadBookingRules(db);
  const [r] = await db<{ n: number; last: string | null }[]>`
    SELECT count(*)::int AS n, max(no_show_at) AS last FROM bookings
    WHERE member_id = ${memberId} AND status = 'no_show' AND no_show_at >= ${new Date(now.getTime() - rules.noShowWindowDays * 86_400_000)}`;
  if (!r || r.n < rules.noShowLimit || !r.last) return { banned: false, until: null, noShows: r?.n ?? 0 };
  const until = new Date(Date.parse(r.last) + rules.noShowBanDays * 86_400_000);
  return until > now ? { banned: true, until: until.toISOString(), noShows: r.n } : { banned: false, until: null, noShows: r.n };
}

/** 「我的预约」：这位会员最近 30 天起的预约（新的在前） */
export async function memberBookings(db: Db, memberId: number, now = new Date()): Promise<MpBooking[]> {
  const rules = await loadBookingRules(db);
  const rows = (await readBookingRows(db, { memberId })).filter((b) => Date.parse(b.startsAt) >= now.getTime() - 30 * 86_400_000);
  return rows
    .map((b) => ({
      id: b.id,
      bookingNo: b.bookingNo,
      kind: b.kind,
      status: b.status,
      itemName: b.itemName,
      technicianText: b.technicianText,
      techNo: b.techNo,
      spaceName: b.spaceName,
      startsAt: b.startsAt,
      endsAt: b.endsAt,
      guests: b.guests,
      cancelReason: b.cancelReason,
      cancellable: (b.status === 'pending' || b.status === 'confirmed') && Date.parse(b.startsAt) - now.getTime() >= rules.mpCancelLeadMinutes * 60_000,
    }))
    .reverse();
}

const MpCreateInput = z.object({
  memberId: z.number('会员编号不对').int().positive(),
  kind: z.enum(['technician', 'space'], '小程序只能预约技师、派对房等'),
  itemId: z.number().int().positive().optional(),
  technicianId: z.number().int().positive().nullable().optional(),
  spaceId: z.number().int().positive().optional(),
  startsAt: z.iso.datetime({ offset: true, message: '请选择时段' }),
  durationMinutes: z.number().int().min(30).max(720).optional(),
  guests: z.number().int().min(1).max(MAX_BOOKING_GUESTS).default(1),
  note: z.string().trim().max(MAX_BOOKING_NOTE).default(''),
  claimKey: ClaimKey,
  at: z.date().optional(),
});
export type MpBookingInput = z.input<typeof MpCreateInput>;

/**
 * 小程序预约（3d）：「待确认」，前台确认；时段要对齐、在最远天数内；每人同时最多 N 个没到店的（MP34）；爽约限制（MP37）。
 * 拒绝码：MEMBER_INACTIVE、BOOKING_BANNED、BOOKING_LIMIT、BOOKING_TIME、BOOKING_RANGE、BOOKING_PAST、BOOKING_ITEM、BOOKING_TECHNICIAN、
 * BOOKING_SPACE、BOOKING_DURATION、BOOKING_TAKEN。同一个 claimKey 再调用返回第一次的结果（replayed）
 */
export async function createBookingFromMp(tx: Tx, deps: Pick<Deps, 'config'>, raw: MpBookingInput): Promise<{ booking: BookingDetail; replayed: boolean }> {
  const input = parse(MpCreateInput, raw);
  const { claimKey, at: when, ...payload } = input;
  const requestHash = hashRequest(payload);
  const prior = await lockClaim(tx, 'mp_booking', claimKey, requestHash);
  if (prior) return { booking: await getBooking(tx, prior.refId), replayed: true };
  const ctx = await mpContext(tx, when);
  const rules = await loadBookingRules(tx);
  // 会员一行：同一位会员的「同时几个」串行
  const [m] = await tx<{ status: string }[]>`SELECT status FROM members WHERE id = ${input.memberId} FOR UPDATE`;
  if (!m) throw notFound('会员不存在');
  if (m.status !== 'active') throw unprocessable('MEMBER_INACTIVE', '会员卡已停用或已合并，请到前台办理');
  const ban = await mpBookingBan(tx, input.memberId, ctx.at);
  if (ban.banned) throw unprocessable('BOOKING_BANNED', `${rules.noShowWindowDays} 天内爽约 ${ban.noShows} 次，${ban.until!.slice(0, 10)} 前不能在小程序预约，请打电话给门店`);
  const [open] = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM bookings WHERE member_id = ${input.memberId} AND status IN ${tx(ACTIVE_BOOKING_STATUSES)} AND starts_at > ${ctx.at!}`;
  if (open!.n >= rules.mpMaxOpen) throw unprocessable('BOOKING_LIMIT', `每人同时最多 ${rules.mpMaxOpen} 个没到店的预约`);
  const id = await createBookingTx(
    tx,
    deps,
    { ...payload, source: 'mp', memberId: input.memberId, guestName: '', guestPhone: '', startsAt: new Date(payload.startsAt), strictGrid: true },
    ctx.actor,
    randomUUID(),
    requestHash,
    ctx.at!,
  );
  await saveClaim(tx, 'mp_booking', claimKey, requestHash, id);
  return { booking: await getBooking(tx, id), replayed: false };
}

const MpCancelInput = z.object({ memberId: z.number().int().positive(), bookingId: z.number().int().positive(), claimKey: ClaimKey, at: z.date().optional() });
export type MpCancelInput = z.input<typeof MpCancelInput>;

/** 小程序自己取消：只能取消自己的、开始前 N 分钟以前的（之后请打电话给门店）；拒绝码 BOOKING_NOT_YOURS、BOOKING_CLOSED、BOOKING_TOO_LATE */
export async function cancelBookingFromMp(tx: Tx, _deps: Pick<Deps, 'config'>, raw: MpCancelInput): Promise<{ booking: BookingDetail; replayed: boolean }> {
  const input = parse(MpCancelInput, raw);
  const requestHash = hashRequest({ memberId: input.memberId, bookingId: input.bookingId });
  const prior = await lockClaim(tx, 'mp_booking_cancel', input.claimKey, requestHash);
  if (prior) return { booking: await getBooking(tx, prior.refId), replayed: true };
  const ctx = await mpContext(tx, input.at);
  const rules = await loadBookingRules(tx);
  const b = await lockBooking(tx, input.bookingId);
  if (b.memberId !== input.memberId) throw unprocessable('BOOKING_NOT_YOURS', '这不是你的预约');
  stillOpen(b);
  if (Date.parse(b.startsAt) - ctx.at!.getTime() < rules.mpCancelLeadMinutes * 60_000) {
    throw unprocessable('BOOKING_TOO_LATE', `开始前 ${rules.mpCancelLeadMinutes / 60} 小时以内不能在小程序取消，请打电话给门店`);
  }
  await tx`
    UPDATE bookings SET status = 'cancelled', cancelled_by = ${ctx.actor.id}, cancelled_at = ${ctx.at!}, cancel_reason = '顾客在小程序取消', version = version + 1
    WHERE id = ${b.id}`;
  await writeAudit(tx, { staffId: ctx.actor.id, action: 'booking_cancel', targetType: 'booking', targetId: b.id, detail: { bookingNo: b.bookingNo, mp: true }, businessDate: b.businessDate });
  await saveClaim(tx, 'mp_booking_cancel', input.claimKey, requestHash, b.id);
  return { booking: await getBooking(tx, b.id), replayed: false };
}

// ───────────────────────── 自检 ─────────────────────────

/** 同一位技师、同一间房没有重叠的预约（还占着时段的）；客房当天的预约不超过房间数 */
export async function bookingChecks(db: Db) {
  const tech = await db<{ ref: string }[]>`
    SELECT a.booking_no AS ref FROM bookings a JOIN bookings b ON b.id > a.id AND b.technician_id = a.technician_id
      AND b.starts_at < a.ends_at AND a.starts_at < b.ends_at
    WHERE a.status IN ('pending', 'confirmed') AND b.status IN ('pending', 'confirmed') LIMIT 5`;
  const space = await db<{ ref: string }[]>`
    SELECT a.booking_no AS ref FROM bookings a JOIN bookings b ON b.id > a.id AND b.space_id = a.space_id
      AND b.starts_at < a.ends_at AND a.starts_at < b.ends_at
    WHERE a.status IN ('pending', 'confirmed') AND b.status IN ('pending', 'confirmed') LIMIT 5`;
  const [n] = await db<{ open: number; total: number }[]>`
    SELECT count(*) FILTER (WHERE status IN ('pending', 'confirmed'))::int AS open, count(*)::int AS total FROM bookings`;
  const bad = [...tech, ...space];
  return {
    key: 'bookings',
    label: '预约不重叠（同一位技师、同一间房）',
    ok: bad.length === 0,
    detail: bad.length ? `有重叠的预约：${bad.map((b) => b.ref).join('、')}` : `预约 ${n!.total} 张，还占着时段的 ${n!.open} 张，没有重叠`,
  };
}

// ───────────────────────── 路由 ─────────────────────────

const DateQuery = z.object({ date: z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD') });

export function registerBookingRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const op = guard('booking.manage');
  app.get('/api/bookings', { preHandler: op }, async (req) => bookingBoard(sql, parse(DateQuery, req.query).date));
  app.get('/api/bookings/slots', { preHandler: op }, async (req) => bookingSlots(sql, deps, req.query as BookingSlotQuery));
  app.get('/api/bookings/:id', { preHandler: op }, async (req) => getBooking(sql, parse(idParam, req.params).id));
  app.post('/api/bookings', { preHandler: op }, async (req) => createBooking(deps, req.body, ctxOf(req)));
  app.post('/api/bookings/:id/change', { preHandler: op }, async (req) => changeBooking(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  app.get('/api/admin/booking-rules', { preHandler: guardAny('settings.manage', 'booking.manage') }, async () => loadBookingRules(sql));
  app.put('/api/admin/booking-rules', { preHandler: guard('settings.manage') }, async (req) => saveBookingRules(deps, req.body, ctxOf(req)));
}

