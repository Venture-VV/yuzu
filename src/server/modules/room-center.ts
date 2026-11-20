// 房态中心（8.1.15，《浴族系统需求汇总》房态中心 1–4，见 docs/ROOM_CENTER_V8115.md）：
//   · 房型（后台可配）与看板：按房型分页签，每个页签的总数与空闲 / 在用 / 待清 / 维修 / 已预订各几间，房间卡片（房号、状态、客人、技师、已用时长、金额）；
//   · 房间历史：房态中心自己的事件，加上这间房里的钟单、使用单；
//   · 登记表单要问的两样：手牌上的客人（会员与档阶）、出单员的工号；
//   · 「结果待确认」：房间动作（space_state / space_dispatch）按编号查回、确认作废（按原业务的权限；只管打扫的后勤没有前台权限也能处理）。
// 给别的模块的只读入口 currentGuestOfSpace（这间房里现在是哪位客人——餐饮「只填房号」点单用）在 room-state.ts。
// 状态怎么算在 room-center-core.ts，写操作在 room-center-ops.ts；客房的卡片直接用客房的房态看板（rooms.ts），不另算一遍。
// 谁能看：看得到客房、钟房、派对房其中一样的岗位。没有前台、钟房、客房操作权限的（只管打扫的后勤）只看得到手牌号，不显示客人姓名。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { normalizeTagCode, TAG_CODE_PATTERN, ZONE_LABELS, type FrontdeskOpLookup } from '@shared/frontdesk';
import { formatYuan } from '@shared/money';
import { can } from '@shared/permissions';
import {
  categoryProblem,
  DEFAULT_ROOM_CATEGORIES,
  EMPTY_ROOM_COUNTS,
  MAX_CATEGORY_NAME,
  MAX_CATEGORY_TYPES,
  OTHER_CATEGORY_KEY,
  OTHER_CATEGORY_NAME,
  ROOM_COUNT_KEY,
  ROOM_EVENT_LABELS,
  ROOM_SOURCES,
  ROOM_START_LABELS,
  roomKindOf,
  type RoomCard,
  type RoomCategoriesAdmin,
  type RoomCategory,
  type RoomCategoryView,
  type RoomCenterBoard,
  type RoomCounts,
  type RoomEventKind,
  type RoomGuestLookup,
  type RoomGuestView,
  type RoomHistory,
  type RoomHistoryRow,
  type RoomSessionView,
  type RoomSource,
  type RoomStartMode,
  type RoomStatus,
} from '@shared/room-center';
import type { RoomBoardStatus } from '@shared/rooms';
import { MAX_BUSINESS_TYPE, ROOM_BUSINESS_TYPE, SPACE_BUSINESS_TYPES } from '@shared/spaces';
import { durationText } from '@shared/usages';
import { isUniqueViolation, type Db, type Tx } from '../db';
import { guard, guardAny } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import { ctxOf, type Actor, type Deps, type OpContext } from '../lib/context';
import { conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { currentStoreId, DEFAULT_STORE_ID } from '../lib/store-context';
import { idParam, parse } from '../lib/validate';
import { monthDayTime } from './bookings';
import { businessDate, FRONTDESK_OP_PERMISSIONS, setTxTimeouts } from './frontdesk/common';
import { memberGradeBadges } from './membership';
import { guestName, loadRoomFacts, roomLabel, statusOfFacts, type GuestFact, type SessionFact } from './room-center-core';
import {
  checkoutRoom,
  extendRoom,
  findSeller,
  markCleaned,
  markDirty,
  mergeRooms,
  moveRoom,
  openRoomUsage,
  registerRoom,
  restoreRoom,
  roomCheckoutPreview,
  setMaintenance,
  unmergeRoom,
} from './room-center-ops';
import { loadRoomRules, roomsBoard } from './rooms';
import { loadUsageRules, usageBoard } from './usages';

// ───────────────────────── 房型（后台） ─────────────────────────

async function loadCategories(db: Db): Promise<RoomCategory[]> {
  return db<RoomCategory[]>`
    SELECT id, name, source, business_types, sort_order, active, version FROM room_categories
    WHERE store_id = ${currentStoreId()} ORDER BY sort_order, id`;
}

/** 房型的写入都串行（按门店一把锁）：同一种业态不会同时被两个在用的房型管上 */
const lockCategories = (tx: Tx) => tx`SELECT pg_advisory_xact_lock(hashtext(${currentStoreId() === DEFAULT_STORE_ID ? 'room_categories' : `room_categories:${currentStoreId()}`}))`;

export async function roomCategoriesAdmin(db: Db): Promise<RoomCategoriesAdmin> {
  const categories = await loadCategories(db);
  const used = await db<{ type: string; spaces: number }[]>`
    SELECT business_type AS type, count(*)::int AS spaces FROM spaces WHERE active AND store_id = ${currentStoreId()} GROUP BY 1 ORDER BY 1`;
  const counts = new Map(used.map((u) => [u.type, u.spaces]));
  // 台账里用到的业态在前（按间数），常用业态、房型里已经写了的跟在后面——没有空间的也能先配好
  const all = [...new Set([...used.map((u) => u.type), ...SPACE_BUSINESS_TYPES, ...categories.flatMap((c) => c.businessTypes)])];
  const mapped = new Set(categories.filter((c) => c.active).flatMap((c) => c.businessTypes));
  return {
    categories,
    businessTypes: all.map((type) => ({ type, spaces: counts.get(type) ?? 0 })),
    usageTypes: (await loadUsageRules(db)).businessTypes,
    unmapped: used.filter((u) => !mapped.has(u.type)).map((u) => u.type),
  };
}

const CategoryInput = z.object({
  name: z.string('请填写房型名称').trim().min(1, '请填写房型名称').max(MAX_CATEGORY_NAME, `房型名称最多 ${MAX_CATEGORY_NAME} 字`),
  source: z.enum(ROOM_SOURCES, '请选择是哪一类房间'),
  businessTypes: z
    .array(z.string('业态不正确').trim().min(1, '业态不能为空').max(MAX_BUSINESS_TYPE, `业态最多 ${MAX_BUSINESS_TYPE} 字`), '请选择业态')
    .max(MAX_CATEGORY_TYPES, `一个房型最多管 ${MAX_CATEGORY_TYPES} 种业态`)
    .transform((list) => [...new Set(list)]),
  sortOrder: z.number('排序不正确').int('排序要是整数').min(0, '排序不能是负数').max(9999, '排序最大 9999').default(0),
  active: z.boolean().default(true),
  /** 修改时带上看到的版本号 */
  version: z.number().int().min(1).optional(),
});

/** 新建（id 为 null）或修改一个房型：名称不重复；来源与业态对得上；同一种业态同时只在一个在用的房型里 */
async function saveCategory(deps: Deps, id: number | null, raw: unknown, ctx: OpContext): Promise<RoomCategoriesAdmin> {
  const input = parse(CategoryInput, raw);
  const problem = categoryProblem(input.source, input.businessTypes);
  if (problem) throw unprocessable('CATEGORY_TYPES', problem);
  try {
    await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      await lockCategories(tx);
      const others = (await loadCategories(tx)).filter((c) => c.id !== id);
      if (input.active) {
        for (const c of others.filter((o) => o.active)) {
          const both = c.businessTypes.filter((t) => input.businessTypes.includes(t));
          if (both.length) throw conflict('CATEGORY_TYPE_TAKEN', `业态「${both.join('」「')}」已经在房型「${c.name}」里：一种业态只归一个房型，先从那边去掉`);
        }
      }
      const at = ctx.at ?? new Date();
      let targetId = id;
      if (id === null) {
        const [row] = await tx<{ id: number }[]>`
          INSERT INTO room_categories (name, source, business_types, sort_order, active, created_by, created_at, updated_by, updated_at)
          VALUES (${input.name}, ${input.source}, ${input.businessTypes}, ${input.sortOrder}, ${input.active}, ${ctx.actor.id}, ${at}, ${ctx.actor.id}, ${at})
          RETURNING id`;
        targetId = Number(row!.id);
      } else {
        const [cur] = await tx<{ version: number }[]>`SELECT version FROM room_categories WHERE id = ${id} AND store_id = ${currentStoreId()} FOR UPDATE`;
        if (!cur) throw notFound('房型不存在，请刷新后重试');
        if (input.version !== cur.version) throw conflict('CATEGORY_STALE', '这个房型刚被别人改过，请刷新后再改');
        await tx`
          UPDATE room_categories SET name = ${input.name}, source = ${input.source}, business_types = ${input.businessTypes}, sort_order = ${input.sortOrder},
                 active = ${input.active}, version = version + 1, updated_by = ${ctx.actor.id}, updated_at = ${at}
          WHERE id = ${id}`;
      }
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'room_category',
        targetType: 'room_category',
        targetId: targetId!,
        detail: { change: id === null ? 'create' : 'update', name: input.name, source: input.source, businessTypes: input.businessTypes, sortOrder: input.sortOrder, active: input.active },
        ip: ctx.ip,
      });
    });
  } catch (e) {
    if (isUniqueViolation(e, 'room_categories_name_uq')) throw conflict('CATEGORY_NAME_TAKEN', `已经有叫「${input.name}」的房型了，换一个名称`);
    throw e;
  }
  return roomCategoriesAdmin(deps.sql);
}

/** 这家店一个房型都没有时按默认的建一份（迁移 190 给当时已有的门店建过；之后新开的门店在后台点一下） */
async function createDefaultCategories(deps: Deps, ctx: OpContext): Promise<RoomCategoriesAdmin> {
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await lockCategories(tx);
    if ((await loadCategories(tx)).length > 0) throw conflict('CATEGORY_EXISTS', '已经有房型了，不用再按默认的建；要改直接改现有的');
    const at = ctx.at ?? new Date();
    for (const d of DEFAULT_ROOM_CATEGORIES) {
      await tx`
        INSERT INTO room_categories (name, source, business_types, sort_order, created_by, created_at, updated_by, updated_at)
        VALUES (${d.name}, ${d.source}, ${d.businessTypes}, ${d.sortOrder}, ${ctx.actor.id}, ${at}, ${ctx.actor.id}, ${at})`;
    }
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'room_category',
      targetType: 'room_category',
      detail: { change: 'defaults', names: DEFAULT_ROOM_CATEGORIES.map((d) => d.name) },
      ip: ctx.ip,
    });
  });
  return roomCategoriesAdmin(deps.sql);
}

// ───────────────────────── 看板 ─────────────────────────

const HOTEL_STATUS: Record<RoomBoardStatus, RoomStatus> = { vacant: 'free', occupied: 'in_use', dirty: 'dirty', maintenance: 'maintenance' };

const sessionView = (s: SessionFact): RoomSessionView => ({
  id: Number(s.id),
  sessionNo: s.sessionNo,
  visitId: Number(s.visitId),
  technicianId: Number(s.technicianId),
  techNo: s.techNo,
  techName: s.techName,
  itemId: Number(s.itemId),
  itemName: s.itemName,
  callType: s.callType,
  clocks: s.clocks,
  minutes: s.minutes,
  status: s.status,
  startedAt: s.startedAt,
  plannedEnd: s.startedAt && s.status === 'serving' ? new Date(new Date(s.startedAt).getTime() + s.minutes * 60_000).toISOString() : null,
  endedAt: s.endedAt,
  amount: s.amount,
  unitPrice: s.unitPrice,
});

const earliest = (list: (string | null)[]) => list.filter((x): x is string => x !== null).sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0] ?? null;
const latest = (list: (string | null)[]) => list.filter((x): x is string => x !== null).sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? null;

/** 能不能看客人是谁（姓名、档阶、备注）：前台、钟房、客房的操作岗位；只管打扫的只看得到手牌号 */
const seesGuests = (actor: Actor) => can(actor, 'technician.dispatch') || can(actor, 'frontdesk.read') || can(actor, 'room.operate');

export async function roomCenterBoard(deps: Deps, actor: Actor): Promise<RoomCenterBoard> {
  const db = deps.sql;
  const [now] = await db<{ now: string }[]>`SELECT now() AS now`;
  const at = new Date(now!.now);
  const today = await businessDate(db, deps, at);
  const categories = (await loadCategories(db)).filter((c) => c.active);
  const usages = await usageBoard(db);
  const usageOf = new Map(usages.spaces.map((s) => [Number(s.id), s]));
  const facts = await loadRoomFacts(db, today);
  const hotelOn = (await loadRoomRules(db)).enabled;
  const hotel = hotelOn ? await roomsBoard(deps) : null;
  const showGuests = seesGuests(actor);
  const memberIds = [...facts.values()].flatMap((f) => f.guests.flatMap((g) => (g.visit.memberId === null ? [] : [Number(g.visit.memberId)])));
  const grades = showGuests ? await memberGradeBadges(db, memberIds, today) : new Map();

  const categoryKeyOf = (businessType: string) => {
    const c = categories.find((x) => x.businessTypes.includes(businessType));
    return c ? `c${c.id}` : OTHER_CATEGORY_KEY;
  };
  const guestView = (g: GuestFact): RoomGuestView => {
    const badge = g.visit.memberId === null ? undefined : grades.get(Number(g.visit.memberId));
    const sessions = g.sessions.map(sessionView);
    return {
      registrationId: g.registration ? Number(g.registration.id) : null,
      visitId: Number(g.visit.id),
      tagCode: g.visit.tagCode,
      guest: showGuests ? guestName(g.visit) : `手牌 ${g.visit.tagCode}`,
      memberGradeLabel: badge && badge.grade > 0 ? badge.label : null,
      sellerNo: showGuests ? (g.registration?.sellerNo ?? '') : '',
      sellerName: showGuests ? (g.registration?.sellerName ?? '') : '',
      note: showGuests ? (g.registration?.note ?? '') : '',
      since: g.registration?.openedAt ?? g.sessions[0]?.createdAt ?? at.toISOString(),
      sessions,
      amount: sessions.reduce((n, s) => n + s.amount, 0),
      billAmount: g.visit.billAmount,
    };
  };

  // 并房：两头都在用的才算（一头已经空了的旧关系不显示）
  const inUse = (id: number) => (facts.has(id) ? statusOfFacts(facts.get(id)!).inUse : false);
  const groups = new Map<number, number[]>();
  for (const [id, f] of facts) {
    const main = f.state?.mergedInto ?? null;
    if (main !== null && inUse(id) && inUse(Number(main))) groups.set(Number(main), [...(groups.get(Number(main)) ?? [Number(main)]), id]);
  }
  const groupOf = new Map<number, number[]>();
  for (const members of groups.values()) for (const id of members) groupOf.set(id, members);

  const rooms: RoomCard[] = [];
  for (const [id, f] of facts) {
    const sp = f.space;
    // 「客房」业态的空间不在这里出卡片：客房按房间（rooms）出，见下
    if (sp.businessType === ROOM_BUSINESS_TYPE) continue;
    const st = statusOfFacts(f);
    // 停用、不可售的空间不营业，不出卡片；还有人用着的照样显示到用完
    if (!(sp.active && sp.sellable) && !st.inUse) continue;
    const kind = roomKindOf(sp.businessType, usages.businessTypes);
    const guests = f.guests.map(guestView);
    const all = guests.flatMap((g) => g.sessions);
    const usage = usageOf.get(id)?.usage ?? null;
    const phase = guests.length === 0 ? null : all.some((s) => s.status === 'serving') ? 'serving' : all.some((s) => s.status === 'waiting') ? 'waiting' : 'done';
    const techs = [...new Set((all.some((s) => s.status !== 'done') ? all.filter((s) => s.status !== 'done') : all).map((s) => `${s.techNo} 号 ${s.techName}`))];
    rooms.push({
      key: `s${id}`,
      categoryKey: categoryKeyOf(sp.businessType),
      kind,
      spaceId: id,
      code: sp.code,
      name: sp.displayName,
      floor: sp.floorCode,
      businessType: sp.businessType,
      capacity: sp.capacity,
      status: st.status,
      version: f.state?.version ?? 0,
      guests,
      usage,
      usagePriced: usageOf.get(id)?.priced ?? false,
      hotel: null,
      maintenance: f.state?.maintenance
        ? { reason: f.state.maintenanceReason ?? '', expectedAt: f.state.maintenanceUntil!, at: f.state.maintenanceAt!, byName: f.state.maintenanceByName ?? '' }
        : null,
      dirtySince: st.dirtySince,
      dirtyNote: st.status === 'dirty' ? (f.state?.dirtyNote ?? '') : '',
      booking: f.booking
        ? {
            id: Number(f.booking.id),
            bookingNo: f.booking.bookingNo,
            guest: showGuests ? (f.booking.memberName ?? (f.booking.guestName || '客人')) : '客人',
            guests: f.booking.guests,
            startsAt: f.booking.startsAt,
            endsAt: f.booking.endsAt,
          }
        : null,
      merged: (groupOf.get(id) ?? []).map((m) => ({ spaceId: m, code: facts.get(m)!.space.code })),
      guestText: guests.length ? guests.map((g) => g.guest).join('、') : usage ? `手牌 ${usage.tagCode} · ${usage.guests} 人` : null,
      techText: techs.length ? techs.join('、') : null,
      since: guests.length ? earliest(all.map((s) => s.startedAt)) : (usage?.openedAt ?? null),
      amount: guests.length ? guests.reduce((n, g) => n + g.amount, 0) : null,
      phase,
      plannedEnd: latest(all.map((s) => s.plannedEnd)),
    });
  }
  for (const r of hotel?.rooms ?? []) {
    rooms.push({
      key: `r${r.id}`,
      categoryKey: categoryKeyOf(ROOM_BUSINESS_TYPE),
      kind: 'hotel',
      spaceId: r.spaceId,
      code: r.roomNo,
      name: r.spaceName && r.spaceName !== r.roomNo ? r.spaceName : r.typeName,
      floor: r.floor,
      businessType: ROOM_BUSINESS_TYPE,
      capacity: null,
      status: HOTEL_STATUS[r.status],
      version: 0,
      guests: [],
      usage: null,
      usagePriced: false,
      hotel: showGuests ? r : r.stay ? { ...r, stay: { ...r.stay, memberName: null, guestLabel: '', memberId: null } } : r,
      maintenance: null,
      dirtySince: null,
      dirtyNote: '',
      booking: null,
      merged: [],
      guestText: r.stay ? (showGuests ? (r.stay.memberName ?? (r.stay.guestLabel || `手牌 ${r.stay.tagCode}`)) : `手牌 ${r.stay.tagCode}`) : null,
      techText: null,
      since: r.stay?.checkedInAt ?? null,
      amount: r.stay ? r.stay.chargedAmount : null,
      phase: null,
      plannedEnd: null,
    });
  }

  const count = (list: RoomCard[]): RoomCounts => {
    const c = { ...EMPTY_ROOM_COUNTS, total: list.length };
    for (const r of list) c[ROOM_COUNT_KEY[r.status]] += 1;
    return c;
  };
  const [pendingRooms] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM bookings WHERE kind = 'room' AND status IN ('pending', 'confirmed') AND business_date = ${today} AND store_id = ${currentStoreId()}`;
  const hotelHint = !hotelOn
    ? '客房功能没有开启：店主在「后台 → 客房」建好房型与房间并开启后，这里看客房的房态'
    : pendingRooms!.n > 0
      ? `今天有 ${pendingRooms!.n} 张客房预约还没到店（按房型订，不占具体哪一间）`
      : null;
  const views: RoomCategoryView[] = categories.map((c) => ({
    key: `c${c.id}`,
    id: c.id,
    name: c.name,
    source: c.source,
    counts: count(rooms.filter((r) => r.categoryKey === `c${c.id}`)),
    hint: c.source === 'hotel' ? hotelHint : null,
  }));
  const rest = rooms.filter((r) => r.categoryKey === OTHER_CATEGORY_KEY);
  // 没归到房型的空间放在「其他」；一间都没有就不出这个页签
  if (rest.length) {
    const source: RoomSource = rest.some((r) => r.kind === 'service') ? 'service' : rest.some((r) => r.kind === 'party') ? 'party' : rest.some((r) => r.kind === 'hotel') ? 'hotel' : 'hall';
    views.push({
      key: OTHER_CATEGORY_KEY,
      id: null,
      name: OTHER_CATEGORY_NAME,
      source,
      counts: count(rest),
      hint: '还没归到房型的房间：店主在「后台 → 空间台账 → 房态中心房型」里把它们的业态加进一个房型',
    });
  }
  return { serverTime: at.toISOString(), businessDate: today, categories: views, total: count(rooms), rooms };
}

// ───────────────────────── 房间历史 ─────────────────────────

const START_TEXT = (d: Record<string, unknown>, tz: string) =>
  d.start === 'at' && typeof d.startedAt === 'string'
    ? `补记 ${monthDayTime(new Date(d.startedAt), tz)} 开始`
    : typeof d.start === 'string' && d.start in ROOM_START_LABELS
      ? ROOM_START_LABELS[d.start as RoomStartMode]
      : '';

function eventText(kind: RoomEventKind, d: Record<string, unknown>, tz: string): string {
  const s = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : '');
  const n = (k: string) => (typeof d[k] === 'number' ? (d[k] as number) : 0);
  const list = (k: string) => (Array.isArray(d[k]) ? (d[k] as unknown[]).filter((x): x is string => typeof x === 'string') : []);
  const parts = (xs: string[]) => xs.filter(Boolean).join(' · ');
  switch (kind) {
    case 'register':
      return parts([
        `手牌 ${s('tag')}${d.join ? '（同房加人）' : ''}`,
        `${s('item')}${s('tier') ? `（${s('tier')}）` : ''} × ${n('clocks') || 1}`,
        s('technician'),
        `出单员 ${s('seller')}`,
        formatYuan(n('amount')),
        START_TEXT(d, tz),
        s('note') ? `备注：${s('note')}` : '',
      ]);
    case 'extend':
      return parts([`手牌 ${s('tag')}`, `${s('item')} 加 ${n('clocks') || 1} 钟`, s('technician'), formatYuan(n('amount'))]);
    case 'move_out':
      return parts([`换到 ${s('to')}`, `手牌 ${list('tags').join('、')}`, '单与计时不变', s('note')]);
    case 'move_in':
      return parts([`从 ${s('from')} 换来`, `手牌 ${list('tags').join('、')}`, '单与计时不变', s('note')]);
    case 'checkout':
      if (d.auto === 'checkout') return `手牌 ${s('tag')} 结账离店，房间自动腾出`;
      if (d.auto === 'visit_cancel') return `手牌 ${s('tag')} 的来访被撤销，登记一起结束`;
      return parts([`手牌 ${s('tag')}`, `这间房 ${formatYuan(n('roomAmount'))}`, n('unpaid') > 0 ? `账单未结 ${formatYuan(n('unpaid'))}，客人带手牌继续在店` : '账单没有未结金额']);
    case 'merge':
      return `${s('room')} 并入 ${s('into')}（手牌 ${list('tags').join('、')}）；账各在各的手牌上`;
    case 'unmerge':
      return `解除并房：${list('rooms').filter(Boolean).join('、')}`;
    case 'dirty':
      return s('note') || '手动标为待清';
    case 'cleaned':
      return typeof d.since === 'string' ? `${monthDayTime(new Date(d.since), tz)} 起待清，现在清洁完成` : '清洁完成';
    case 'maintenance':
      return parts([d.update ? '改维修信息' : '', s('reason'), typeof d.expectedAt === 'string' ? `预计 ${monthDayTime(new Date(d.expectedAt), tz)} 完成` : '']);
    case 'restore':
      return parts([`维修结束${s('reason') ? `（${s('reason')}）` : ''}`, s('note')]);
  }
}

/** 房间历史：房态中心的事件 + 这间房里的钟单（派钟、上钟、下钟）+ 使用单（开单、结束），按时间倒排，最近 200 条 */
export async function roomHistory(deps: Deps, spaceId: number): Promise<RoomHistory> {
  const db = deps.sql;
  const tz = deps.config.timezone;
  const [sp] = await db<{ code: string; displayName: string }[]>`SELECT code, display_name FROM spaces WHERE id = ${spaceId} AND store_id = ${currentStoreId()}`;
  if (!sp) throw notFound('房间不存在，请刷新后重试');
  const events = await db<{ id: number; kind: RoomEventKind; detail: Record<string, unknown>; createdAt: string; staffName: string }[]>`
    SELECT e.id, e.kind, e.detail, e.created_at, st.display_name AS staff_name
    FROM space_room_events e JOIN staff st ON st.id = e.staff_id WHERE e.space_id = ${spaceId} ORDER BY e.id DESC LIMIT 200`;
  const rows: RoomHistoryRow[] = events.map((e) => ({
    key: `e${e.id}`,
    at: e.createdAt,
    label: ROOM_EVENT_LABELS[e.kind],
    text: eventText(e.kind, e.detail ?? {}, tz),
    staffName: e.staffName,
    kind: e.kind,
  }));
  // 钟单：现在记着这间房的（换走的钟单跟着去了新房间，这间房留有「换房（换出）」一条）。登记时建的那张，派钟已经写在「登记」里，不重复
  const sessions = await db<
    {
      id: number;
      sessionNo: string;
      status: string;
      createdAt: string;
      startedAt: string | null;
      endedAt: string | null;
      voidReason: string | null;
      tagCode: string;
      techNo: string;
      techName: string;
      itemName: string;
      clocks: number;
      registered: boolean;
      createdBy: string;
      startedBy: string | null;
      endedBy: string | null;
    }[]
  >`
    SELECT s.id, s.session_no, s.status, s.created_at, s.started_at, s.ended_at, s.void_reason, h.code AS tag_code, t.tech_no, t.name AS tech_name, i.name AS item_name, s.clocks,
           EXISTS (SELECT 1 FROM room_registrations r WHERE r.session_id = s.id) AS registered,
           cb.display_name AS created_by, sb.display_name AS started_by, eb.display_name AS ended_by
    FROM technician_sessions s JOIN visits v ON v.id = s.visit_id JOIN hand_tags h ON h.id = v.tag_id JOIN technicians t ON t.id = s.technician_id
    JOIN service_items i ON i.id = s.item_id JOIN staff cb ON cb.id = s.created_by LEFT JOIN staff sb ON sb.id = s.started_by LEFT JOIN staff eb ON eb.id = s.ended_by
    WHERE s.space_id = ${spaceId} ORDER BY s.id DESC LIMIT 100`;
  for (const s of sessions) {
    const what = `${s.sessionNo} · 手牌 ${s.tagCode} · ${s.itemName} × ${s.clocks} · ${s.techNo} 号 ${s.techName}`;
    if (!s.registered) rows.push({ key: `sd${s.id}`, at: s.createdAt, label: '派钟', text: `${what}（钟房派进这间房）`, staffName: s.createdBy, kind: null });
    // 登记时就上钟的（开始时刻就是建钟单的时刻，补记的更早）不另列；「稍后上钟」的，之后点的上钟要列出来
    const startedLater = s.startedAt !== null && new Date(s.startedAt).getTime() > new Date(s.createdAt).getTime();
    if (s.startedAt && (!s.registered || startedLater)) rows.push({ key: `ss${s.id}`, at: s.startedAt, label: '上钟', text: what, staffName: s.startedBy ?? '', kind: null });
    if (s.endedAt) {
      const label = s.status === 'done' ? '下钟' : s.status === 'rejected' ? '退钟' : '取消派钟';
      const minutes = s.startedAt ? Math.max(0, Math.round((new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()) / 60_000)) : 0;
      const tail = s.status === 'done' ? `，实际 ${durationText(minutes)}` : s.voidReason ? `：${s.voidReason}` : '';
      rows.push({ key: `se${s.id}`, at: s.endedAt, label, text: `${what}${tail}`, staffName: s.endedBy ?? '', kind: null });
    }
  }
  const usages = await db<
    {
      id: number;
      usageNo: string;
      tagCode: string;
      guests: number;
      status: string;
      openedAt: string;
      closedAt: string | null;
      closeKind: string | null;
      closeReason: string | null;
      openedBy: string;
      closedBy: string | null;
    }[]
  >`
    SELECT u.id, u.usage_no, h.code AS tag_code, u.guests, u.status, u.opened_at, u.closed_at, u.close_kind, u.close_reason, so.display_name AS opened_by, sc.display_name AS closed_by
    FROM space_usages u JOIN visits v ON v.id = u.visit_id JOIN hand_tags h ON h.id = v.tag_id JOIN staff so ON so.id = u.opened_by LEFT JOIN staff sc ON sc.id = u.closed_by
    WHERE u.space_id = ${spaceId} AND u.store_id = ${currentStoreId()} ORDER BY u.id DESC LIMIT 100`;
  const CLOSE_LABEL: Record<string, string> = { end: '结束使用', checkout: '结账时结束', visit_cancel: '撤销来访时结束', cancel: '撤单' };
  for (const u of usages) {
    const what = `${u.usageNo} · 手牌 ${u.tagCode} · ${u.guests} 人`;
    rows.push({ key: `uo${u.id}`, at: u.openedAt, label: '开单', text: what, staffName: u.openedBy, kind: null });
    if (u.closedAt) {
      const minutes = Math.max(0, Math.floor((new Date(u.closedAt).getTime() - new Date(u.openedAt).getTime()) / 60_000));
      rows.push({
        key: `uc${u.id}`,
        at: u.closedAt,
        label: CLOSE_LABEL[u.closeKind ?? 'end'] ?? '结束使用',
        text: `${what}${u.status === 'cancelled' ? `：${u.closeReason ?? ''}` : `，用了 ${durationText(minutes)}`}`,
        staffName: u.closedBy ?? '',
        kind: null,
      });
    }
  }
  rows.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime() || (a.key < b.key ? 1 : -1));
  return { spaceId, code: sp.code, name: sp.displayName, rows: rows.slice(0, 200) };
}

// ───────────────────────── 登记表单要问的：手牌上的客人 ─────────────────────────

const TagQuery = z.object({
  tag: z
    .string('请填写手牌号')
    .transform((v) => normalizeTagCode(v))
    .pipe(z.string().regex(TAG_CODE_PATTERN, '牌号格式不正确（例如 A023、1088）')),
});

/** 手牌上的在店客人：会员与档阶、账单此刻的合计、已经登记在哪间房（只读） */
export async function lookupGuest(deps: Deps, raw: unknown): Promise<RoomGuestLookup> {
  const { tag } = parse(TagQuery, raw);
  const db = deps.sql;
  const [v] = await db<{ id: number; zone: RoomGuestLookup['zone']; memberId: number | null; memberName: string | null; guestLabel: string; billAmount: number }[]>`
    SELECT v.id, v.zone, v.member_id, m.name AS member_name, v.guest_label, b.amount_cents AS bill_amount
    FROM visits v JOIN hand_tags t ON t.id = v.tag_id JOIN bills b ON b.id = v.bill_id LEFT JOIN members m ON m.id = v.member_id
    WHERE t.code = ${tag} AND v.status = 'open' AND t.store_id = ${currentStoreId()}`;
  if (!v) throw conflict('TAG_NOT_IN_STORE', `手牌 ${tag} 没有在店客人，请核对牌号；客人要先在发卡台接待、领手牌`);
  const today = await businessDate(db, deps, new Date());
  const badge = v.memberId === null ? undefined : (await memberGradeBadges(db, [Number(v.memberId)], today)).get(Number(v.memberId));
  const [reg] = await db<{ code: string; displayName: string }[]>`
    SELECT sp.code, sp.display_name FROM room_registrations r JOIN spaces sp ON sp.id = r.space_id WHERE r.visit_id = ${v.id} AND r.status = 'open'`;
  return {
    visitId: Number(v.id),
    tagCode: tag,
    zone: v.zone,
    guest: v.memberName ?? (v.guestLabel || `${ZONE_LABELS[v.zone].title}散客`),
    memberGradeLabel: badge && badge.grade > 0 ? badge.label : null,
    billAmount: v.billAmount,
    registeredIn: reg ? roomLabel(reg) : null,
  };
}

/** 房间里一个都不该看到别家店的：路由上的房间编号先核对是本店的空间 */
async function assertSpace(db: Db, spaceId: number) {
  const [sp] = await db<{ id: number }[]>`SELECT id FROM spaces WHERE id = ${spaceId} AND store_id = ${currentStoreId()}`;
  if (!sp) throw notFound('房间不存在，请刷新后重试');
}

// ───────────────────────── 路由 ─────────────────────────

export function registerRoomCenterRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  // 看：看得到客房、钟房、派对房其中一样的岗位
  const read = guardAny('room.operate', 'room.housekeep', 'technician.dispatch', 'frontdesk.checkout');
  // 登记、续钟要挂账、派钟：与钟房派钟同一组权限；换房、退房、并房是钟房的调度；改房态（待清、清洁完成、维修、恢复）是打扫与维修；
  // 派对房开单沿用「客房入住、退房」（与平面图、派对房看板上的开单一样）
  const post = guard('technician.dispatch', 'frontdesk.operate');
  const dispatch = guard('technician.dispatch');
  const housekeep = guard('room.housekeep');
  const board = (req: { actor: Actor }) => roomCenterBoard(deps, req.actor);
  const space = async (req: { params: unknown }) => {
    const { id } = parse(idParam, req.params);
    await assertSpace(sql, id);
    return id;
  };

  app.get('/api/room-center', { preHandler: read }, async (req) => board(req));
  app.get('/api/room-center/rooms/:id/history', { preHandler: read }, async (req) => roomHistory(deps, await space(req)));
  app.get('/api/room-center/rooms/:id/checkout-preview', { preHandler: dispatch }, async (req) => roomCheckoutPreview(deps, await space(req)));
  app.get('/api/room-center/guest', { preHandler: dispatch }, async (req) => lookupGuest(deps, req.query));
  app.get('/api/room-center/seller', { preHandler: dispatch }, async (req) =>
    findSeller(sql, parse(z.object({ no: z.string('请填写出单员的工号').trim().min(1, '请填写出单员的工号').max(32) }), req.query).no),
  );

  app.post('/api/room-center/rooms/:id/register', { preHandler: post }, async (req) => {
    await registerRoom(deps, await space(req), req.body, ctxOf(req));
    return board(req);
  });
  app.post('/api/room-center/rooms/:id/extend', { preHandler: post }, async (req) => {
    await extendRoom(deps, await space(req), req.body, ctxOf(req));
    return board(req);
  });
  app.post('/api/room-center/rooms/:id/usage', { preHandler: guard('room.operate') }, async (req) => openRoomUsage(deps, await space(req), req.body, ctxOf(req)));
  app.post('/api/room-center/rooms/:id/move', { preHandler: dispatch }, async (req) => {
    await moveRoom(deps, await space(req), req.body, ctxOf(req));
    return board(req);
  });
  app.post('/api/room-center/rooms/:id/checkout', { preHandler: dispatch }, async (req) => {
    await checkoutRoom(deps, await space(req), req.body, ctxOf(req));
    return board(req);
  });
  app.post('/api/room-center/rooms/:id/merge', { preHandler: dispatch }, async (req) => {
    await mergeRooms(deps, await space(req), req.body, ctxOf(req));
    return board(req);
  });
  app.post('/api/room-center/rooms/:id/unmerge', { preHandler: dispatch }, async (req) => {
    await unmergeRoom(deps, await space(req), req.body, ctxOf(req));
    return board(req);
  });
  app.post('/api/room-center/rooms/:id/maintenance', { preHandler: housekeep }, async (req) => {
    await setMaintenance(deps, await space(req), req.body, ctxOf(req));
    return board(req);
  });
  app.post('/api/room-center/rooms/:id/restore', { preHandler: housekeep }, async (req) => {
    await restoreRoom(deps, await space(req), req.body, ctxOf(req));
    return board(req);
  });
  app.post('/api/room-center/rooms/:id/dirty', { preHandler: housekeep }, async (req) => {
    await markDirty(deps, await space(req), req.body, ctxOf(req));
    return board(req);
  });
  app.post('/api/room-center/rooms/:id/cleaned', { preHandler: housekeep }, async (req) => {
    await markCleaned(deps, await space(req), req.body, ctxOf(req));
    return board(req);
  });

  // 「结果待确认」（8.1.16）：房间动作按编号只读查回（GET）、确认作废（POST abandon；之后原请求即使到达也整笔不做）。
  // 只认房态中心的两类，按原业务的权限（改房态要「客房打扫、维修」，换房、退房、并房要「钟房派钟」）——只管打扫的后勤没有前台权限，
  // 走前台的 /api/frontdesk/ops 查不了自己改房态的那一笔，所以在这里另开一个。查到的是别的业务的编号按查不到回（不给别的业务的内容）
  const SpaceOpQuery = z.object({ type: z.enum(['space_state', 'space_dispatch'], '缺少原操作的业务类型') });
  const OpKey = z.object({ key: z.uuid('操作编号格式不正确') });
  const spaceOp = (req: { actor: Actor; params: unknown }, raw: unknown) => {
    const { key } = parse(OpKey, req.params);
    const { type } = parse(SpaceOpQuery, raw ?? {});
    if (!FRONTDESK_OP_PERMISSIONS[type].every((p) => can(req.actor, p))) throw forbidden('处理这笔要有原业务的权限，请由有权限的员工处理');
    return { key, type };
  };
  const onlySpace = (type: 'space_state' | 'space_dispatch', r: FrontdeskOpLookup): FrontdeskOpLookup => (r.found && r.type !== type ? { found: false, abandoned: false } : r);
  app.get('/api/room-center/ops/:key', { preHandler: read }, async (req) => {
    const { key, type } = spaceOp(req, req.query);
    const { lookupFrontdeskOp } = await import('./frontdesk/visits');
    return onlySpace(type, (await lookupFrontdeskOp(sql, key, deps.config.timezone, type)) as FrontdeskOpLookup);
  });
  app.post('/api/room-center/ops/:key/abandon', { preHandler: read }, async (req) => {
    const { key, type } = spaceOp(req, req.body);
    const { abandonFrontdeskOp } = await import('./frontdesk/visits');
    return onlySpace(type, (await abandonFrontdeskOp(deps, key, type, ctxOf(req))) as FrontdeskOpLookup);
  });

  // 后台：房型（与空间台账同一组岗位）
  const admin = guardAny('settings.manage', 'catalog.manage');
  app.get('/api/admin/room-categories', { preHandler: admin }, async () => roomCategoriesAdmin(sql));
  app.post('/api/admin/room-categories', { preHandler: admin }, async (req) => saveCategory(deps, null, req.body, ctxOf(req)));
  app.put('/api/admin/room-categories/:id', { preHandler: admin }, async (req) => saveCategory(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  app.post('/api/admin/room-categories/defaults', { preHandler: admin }, async (req) => createDefaultCategories(deps, ctxOf(req)));
}
