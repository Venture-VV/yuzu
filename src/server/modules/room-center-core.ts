// 房态中心（8.1.15，docs/ROOM_CENTER_V8115.md）的底层：一间房此刻的事实怎么读（房态行、登记单、钟单、使用单、最近一次用完的时刻、今天的预约），
// 状态怎么从事实推出来，房态行怎么锁，房间事件怎么记。看板（room-center.ts）与写操作（room-center-ops.ts）共用这一份——
// 页面上看到的状态与写操作核对的状态是同一个口径。
//
// 「在用」：这间房有开着的登记单，或有还没结束的钟单（客人在店；钟房直接派进来的也算），或有开着的使用单。
// 「待清」：没人用，而且最近一次「清洁完成」（没点过的按房态行建的时刻）之后——有钟单在这间房做完（或上了钟被退钟）、
//          有使用单结束（撤单不算）、有登记单退房或客人结账离店（撤销来访不算）、或被手动标过（换房换出去也记在这里）。
// 「维修」：房态行上记着。  「已预订」：今天有订这间房、还没到店的预约（派对房等按房间订；技师预约、客房预约不订具体房间）。

import { roomStatusOf, type RoomEventKind, type RoomStatus } from '@shared/room-center';
import { spaceLabel } from '@shared/spaces';
import type { CallType } from '@shared/technicians';
import type { Db, Tx } from '../db';
import { conflict, notFound } from '../lib/errors';
import { currentStoreId } from '../lib/store-context';

export interface SpaceRow {
  id: number;
  code: string;
  displayName: string;
  businessType: string;
  capacity: number | null;
  active: boolean;
  sellable: boolean;
  floorCode: string;
  createdAt: string;
}

export interface StateRow {
  spaceId: number;
  cleanedAt: string;
  dirtyAt: string | null;
  dirtyNote: string;
  maintenance: boolean;
  maintenanceReason: string | null;
  maintenanceUntil: string | null;
  maintenanceAt: string | null;
  maintenanceByName: string | null;
  mergedInto: number | null;
  version: number;
}

export interface SessionFact {
  id: number;
  sessionNo: string;
  spaceId: number | null;
  spaceVersion: number;
  visitId: number;
  technicianId: number;
  techNo: string;
  techName: string;
  itemId: number;
  itemName: string;
  callType: CallType;
  clocks: number;
  minutes: number;
  status: 'waiting' | 'serving' | 'done';
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  amount: number;
  unitPrice: number | null;
}

export interface VisitFact {
  id: number;
  tagCode: string;
  zone: 'male' | 'female' | 'child';
  memberId: number | null;
  memberName: string | null;
  guestLabel: string;
  billAmount: number;
}

export interface RegistrationFact {
  id: number;
  spaceId: number;
  visitId: number;
  sessionId: number;
  sellerNo: string;
  sellerName: string;
  note: string;
  openedAt: string;
}

/** 房间里的一位客人：登记单（钟房直接派进来的没有）与他在这间房的钟单 */
export interface GuestFact {
  registration: RegistrationFact | null;
  visit: VisitFact;
  sessions: SessionFact[];
}

export interface BookingFact {
  id: number;
  bookingNo: string;
  spaceId: number;
  guests: number;
  guestName: string;
  memberName: string | null;
  startsAt: string;
  endsAt: string;
}

export interface RoomFacts {
  space: SpaceRow;
  state: StateRow | null;
  guests: GuestFact[];
  /** 有开着的使用单（派对房等） */
  usageOpen: boolean;
  /** 最近一次用完的时刻（钟单做完、使用单结束、登记单结束、手动标待清里最晚的）；没有为 null */
  lastUsedAt: string | null;
  booking: BookingFact | null;
}

const later = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : new Date(a).getTime() >= new Date(b).getTime() ? a : b);

/**
 * 这几间房（不给就是本店全部空间）此刻的事实。只读、不加锁；写操作在锁住房态行以后再读一次（那时同一间房上别的写操作都排在后面）。
 * today 是营业日（预约按它算「今天」）。
 */
export async function loadRoomFacts(db: Db, today: string, spaceIds?: number[]): Promise<Map<number, RoomFacts>> {
  const ids = spaceIds ? [...new Set(spaceIds)] : null;
  if (ids && ids.length === 0) return new Map();
  const only = (col: string) => (ids ? db`AND ${db(col)} IN ${db(ids)}` : db``);
  const store = currentStoreId();
  const spaces = await db<SpaceRow[]>`
    SELECT sp.id, sp.code, sp.display_name, sp.business_type, sp.capacity, sp.active, sp.sellable, f.code AS floor_code, sp.created_at
    FROM spaces sp JOIN floors f ON f.id = sp.floor_id
    WHERE sp.store_id = ${store} ${only('sp.id')}
    ORDER BY f.sort_order, f.code, sp.code`;
  const states = await db<StateRow[]>`
    SELECT st.space_id, st.cleaned_at, st.dirty_at, st.dirty_note, st.maintenance, st.maintenance_reason, st.maintenance_until, st.maintenance_at,
           ms.display_name AS maintenance_by_name, st.merged_into, st.version
    FROM space_room_states st LEFT JOIN staff ms ON ms.id = st.maintenance_by
    WHERE st.store_id = ${store} ${only('st.space_id')}`;
  // 开着的登记单（客人还在店；结账、撤销来访时登记单一起结束，这里再按来访核对一次）
  const regs = await db<RegistrationFact[]>`
    SELECT r.id, r.space_id, r.visit_id, r.session_id, r.seller_no, r.seller_name, r.note, r.opened_at
    FROM room_registrations r JOIN visits v ON v.id = r.visit_id
    WHERE r.status = 'open' AND v.status = 'open' AND r.store_id = ${store} ${only('r.space_id')}
    ORDER BY r.id`;
  // 钟单：在这些房间里还没结束的；加上登记了的客人这次登记里的钟单（做完的也要：下钟以后客人还在房里，金额也算它）
  const sessions = await db<SessionFact[]>`
    SELECT s.id, s.session_no, s.space_id, s.space_version, s.visit_id, s.technician_id, t.tech_no, t.name AS tech_name, s.item_id, i.name AS item_name,
           s.call_type, s.clocks, s.minutes, s.status, s.created_at, s.started_at, s.ended_at,
           (SELECT coalesce(sum(l.amount), 0)::int FROM bill_lines l WHERE l.session_id = s.id AND l.status = 'active') AS amount,
           (SELECT l.unit_price FROM bill_lines l WHERE l.session_id = s.id AND l.status = 'active' ORDER BY l.id LIMIT 1) AS unit_price
    FROM technician_sessions s JOIN visits v ON v.id = s.visit_id JOIN technicians t ON t.id = s.technician_id JOIN service_items i ON i.id = s.item_id
    WHERE v.status = 'open' AND v.store_id = ${store} AND s.status IN ('waiting', 'serving', 'done')
      AND ((s.status IN ('waiting', 'serving') AND s.space_id IS NOT NULL ${only('s.space_id')})
           OR EXISTS (SELECT 1 FROM room_registrations r WHERE r.visit_id = s.visit_id AND r.status = 'open' AND s.id >= r.session_id ${only('r.space_id')}))
    ORDER BY s.id`;
  const visitIds = [...new Set([...regs.map((r) => Number(r.visitId)), ...sessions.map((s) => Number(s.visitId))])];
  const visits = new Map(
    (visitIds.length
      ? await db<VisitFact[]>`
          SELECT v.id, h.code AS tag_code, v.zone, v.member_id, m.name AS member_name, v.guest_label, b.amount_cents AS bill_amount
          FROM visits v JOIN hand_tags h ON h.id = v.tag_id JOIN bills b ON b.id = v.bill_id LEFT JOIN members m ON m.id = v.member_id
          WHERE v.id IN ${db(visitIds)}`
      : []
    ).map((v) => [Number(v.id), v]),
  );
  const usages = new Set(
    (await db<{ spaceId: number }[]>`SELECT u.space_id FROM space_usages u WHERE u.status = 'open' AND u.store_id = ${store} ${only('u.space_id')}`).map((u) => Number(u.spaceId)),
  );
  const used = new Map(
    (
      await db<{ id: number; sessionEnd: string | null; usageEnd: string | null; regEnd: string | null }[]>`
        SELECT sp.id,
               (SELECT max(s.ended_at) FROM technician_sessions s WHERE s.space_id = sp.id AND s.status IN ('done', 'rejected')) AS session_end,
               (SELECT max(u.closed_at) FROM space_usages u WHERE u.space_id = sp.id AND u.status = 'closed') AS usage_end,
               (SELECT max(r.closed_at) FROM room_registrations r WHERE r.space_id = sp.id AND r.status = 'closed' AND r.close_kind <> 'visit_cancel') AS reg_end
        FROM spaces sp WHERE sp.store_id = ${store} ${only('sp.id')}`
    ).map((r) => [Number(r.id), later(later(r.sessionEnd, r.usageEnd), r.regEnd)]),
  );
  const bookings = await db<BookingFact[]>`
    SELECT b.id, b.booking_no, b.space_id, b.guests, b.guest_name, m.name AS member_name, b.starts_at, b.ends_at
    FROM bookings b LEFT JOIN members m ON m.id = b.member_id
    WHERE b.kind = 'space' AND b.status IN ('pending', 'confirmed') AND b.business_date = ${today} AND b.store_id = ${store} ${only('b.space_id')}
    ORDER BY b.starts_at, b.id`;

  const stateOf = new Map(states.map((s) => [Number(s.spaceId), s]));
  const out = new Map<number, RoomFacts>();
  for (const sp of spaces) {
    const id = Number(sp.id);
    const state = stateOf.get(id) ?? null;
    const mine = regs.filter((r) => Number(r.spaceId) === id);
    const guests: GuestFact[] = mine.flatMap((r) => {
      const visit = visits.get(Number(r.visitId));
      return visit ? [{ registration: r, visit, sessions: sessions.filter((s) => Number(s.visitId) === Number(r.visitId) && Number(s.id) >= Number(r.sessionId)) }] : [];
    });
    // 钟房直接派进这间房、没有登记单的：一位客人一组，只算还没结束的钟
    const registered = new Set(mine.map((r) => Number(r.visitId)));
    const loose = sessions.filter((s) => Number(s.spaceId) === id && s.status !== 'done' && !registered.has(Number(s.visitId)));
    for (const visitId of new Set(loose.map((s) => Number(s.visitId)))) {
      const visit = visits.get(visitId);
      if (visit) guests.push({ registration: null, visit, sessions: loose.filter((s) => Number(s.visitId) === visitId) });
    }
    out.set(id, {
      space: sp,
      state,
      guests,
      usageOpen: usages.has(id),
      lastUsedAt: later(used.get(id) ?? null, state?.dirtyAt ?? null),
      booking: bookings.find((b) => Number(b.spaceId) === id) ?? null,
    });
  }
  return out;
}

export interface RoomStatusFacts {
  status: RoomStatus;
  inUse: boolean;
  dirty: boolean;
  /** 从什么时候起待清（最近一次用完的时刻） */
  dirtySince: string | null;
}

/** 从事实推出状态（先后见 @shared/room-center 的 roomStatusOf） */
export function statusOfFacts(f: RoomFacts): RoomStatusFacts {
  const inUse = f.guests.length > 0 || f.usageOpen;
  const cleaned = new Date(f.state?.cleanedAt ?? f.space.createdAt).getTime();
  const dirty = f.lastUsedAt !== null && new Date(f.lastUsedAt).getTime() > cleaned;
  const status = roomStatusOf({ maintenance: f.state?.maintenance ?? false, inUse, dirty, booked: f.booking !== null });
  return { status, inUse, dirty, dirtySince: status === 'dirty' ? f.lastUsedAt : null };
}

export const roomLabel = (sp: Pick<SpaceRow, 'code' | 'displayName'>) => spaceLabel(sp.code, sp.displayName);

/** 客人怎么称呼：会员名、称呼，都没有就是「手牌 A023」 */
export const guestName = (v: Pick<VisitFact, 'memberName' | 'guestLabel' | 'tagCode'>) => v.memberName ?? (v.guestLabel || `手牌 ${v.tagCode}`);

// ───────────────────────── 房态行：加锁、版本号 ─────────────────────────

/**
 * 锁房态行（id 升序）：房态中心的写操作都先拿它，同一间房上的登记、换房、退房、并房、改状态串行。
 * 还没有房态行的空间先建一行——「最近一次清洁完成」记成空间建好的时刻，与没有这一行时看板的算法一样，建行不会让待清的房间变回空闲。
 * 之后才锁来访、账单、技师队列、钟单、空间一行（各模块原来的顺序）；别的模块不锁房态行，所以没有反过来的路径。
 */
export async function lockRoomStates(tx: Tx, spaceIds: number[]): Promise<Map<number, { version: number; mergedInto: number | null; maintenance: boolean }>> {
  const ids = [...new Set(spaceIds)].sort((a, b) => a - b);
  if (ids.length === 0) return new Map();
  await tx`
    INSERT INTO space_room_states (space_id, store_id, cleaned_at)
    SELECT id, store_id, created_at FROM spaces WHERE id IN ${tx(ids)} AND store_id = ${currentStoreId()} ORDER BY id
    ON CONFLICT (space_id) DO NOTHING`;
  const rows = await tx<{ spaceId: number; version: number; mergedInto: number | null; maintenance: boolean }[]>`
    SELECT space_id, version, merged_into, maintenance FROM space_room_states
    WHERE space_id IN ${tx(ids)} AND store_id = ${currentStoreId()} ORDER BY space_id FOR UPDATE`;
  // 别家店的空间（8.0.22）：与不存在一样
  if (rows.length !== ids.length) throw notFound('房间不存在，请刷新后重试');
  return new Map(rows.map((r) => [Number(r.spaceId), { version: r.version, mergedInto: r.mergedInto === null ? null : Number(r.mergedInto), maintenance: r.maintenance }]));
}

/** 这间房并房时一起的几间（它并入的主房、并入它的几间）：加锁前先看一眼，好把它们的房态行一起按 id 升序锁上 */
export async function mergePartners(db: Db, spaceId: number): Promise<number[]> {
  const rows = await db<{ id: number }[]>`
    SELECT merged_into AS id FROM space_room_states WHERE space_id = ${spaceId} AND merged_into IS NOT NULL
    UNION SELECT space_id FROM space_room_states WHERE merged_into = ${spaceId}`;
  return rows.map((r) => Number(r.id)).sort((a, b) => a - b);
}

/** 页面上看到的房态版本号对不上：这间房刚被别人动过（或这一笔已经做过了、是迟到的重发），拒绝 */
export function assertRoomVersion(actual: number, expected: number, label: string) {
  if (actual !== expected) throw conflict('ROOM_STATE_MOVED', `${label} 的状态刚刚变了（别的终端动过，或这一步已经做过），请刷新后再操作`);
}

/** 版本号加一（这间房每一次写操作都加；带着旧版本号迟到的请求因此对不上） */
export async function bumpRoomVersion(tx: Tx, spaceIds: number[], staffId: number, at: Date) {
  if (spaceIds.length === 0) return;
  await tx`UPDATE space_room_states SET version = version + 1, updated_at = ${at}, updated_by = ${staffId} WHERE space_id IN ${tx([...new Set(spaceIds)])}`;
}

/** 记一条房间事件，返回它的编号（带操作编号的房间动作把第一条记进 idempotency_keys，查回时按它找） */
export async function logRoomEvent(tx: Tx, e: { spaceId: number; kind: RoomEventKind; registrationId?: number | null; detail?: Record<string, unknown>; staffId: number; at: Date }): Promise<number> {
  const [row] = await tx<{ id: number }[]>`
    INSERT INTO space_room_events (space_id, kind, registration_id, detail, staff_id, created_at)
    VALUES (${e.spaceId}, ${e.kind}, ${e.registrationId ?? null}, ${tx.json((e.detail ?? {}) as never)}, ${e.staffId}, ${e.at})
    RETURNING id`;
  return Number(row!.id);
}
