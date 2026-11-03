// 第一级实时位置（飞书需求 RQ-004，v0.7.17，见 docs/ROOMMAP.md 第 3 节）：业务推导定位，不加硬件，精度到区域与房间。
//   · 位置来自刷卡点刷卡（「上报即定位」接口；RQ-001 之前后台模拟刷卡）与业务动作（发牌、挂账、开房换房退房、上下钟、技师上下牌、结账）；
//   · 位置事件只追加；同一个地方连续的事件并成一段轨迹；当前位置每人一行（当前所在空间），离店、下牌后清空；
//   · 表结构按第二级精确定位预留（事件带坐标、精度、设备编号），第二级只换数据源、走同一个上报接口。
//
// 并发与锁：位置写在业务事务的最后（业务行都锁好之后），只锁每个人的当前位置一行——同一事务里先客人（来访 id 升序）、
// 再技师（id 升序），之后不再等其他业务锁；刷卡上报只锁当前位置一行（读来访、技师不加锁，拿到锁后再核对客人还在店）。
// 业务动作推导的位置用存档点隔开：写不进去（例如等锁超时）只是这一次不推导，业务照常生效。
// 开关关着时不推导、刷卡上报拒绝；离开、离店照样清掉已有的位置（不留下离店客人的位置）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { businessDayStart, ISO_DATE } from '@shared/business-date';
import {
  DEFAULT_LOCATION_RULES,
  READER_CODE_PATTERN,
  REPORT_MAX_AGE_MS,
  REPORT_MAX_SKEW_MS,
  REPORT_SOURCES,
  type LocationAdmin,
  type LocationEventKind,
  type LocationEventRow,
  type LocationItem,
  type LocationPerson,
  type LocationPlace,
  type LocationReader,
  type LocationReportResult,
  type LocationRules,
  type LocationsCurrent,
  type LocationSource,
  type LocationTrackData,
  type LocationTrackSegment,
  type LocationZone,
} from '@shared/locations';
import { isUniqueViolation, type Db, type Tx } from '../db';
import { guard, guardAny } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Deps, OpContext } from '../lib/context';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors';
import { assertNotFenced, isFenced } from '../lib/fences';
import { idParam, parse } from '../lib/validate';
import { businessDate, setTxTimeouts } from './frontdesk/common';
import { loadSettings } from './settings';
import { ctxOf } from '../lib/context';
import { hashRequest } from '../lib/idempotency';

// ───────────────────────── 规则 ─────────────────────────

export async function loadLocationRules(db: Db): Promise<LocationRules> {
  const [row] = await db<{ value: Partial<LocationRules> }[]>`SELECT value FROM settings WHERE key = 'location_rules'`;
  return { ...DEFAULT_LOCATION_RULES, ...(row?.value ?? {}) };
}

// ───────────────────────── 地方 ─────────────────────────

interface Place {
  floorId: number;
  zoneId: number | null;
  spaceId: number | null;
}

/** 区域 → 地方：区域与楼层都在用才算 */
async function zonePlace(db: Db, zoneId: number): Promise<Place | null> {
  const [z] = await db<{ id: number; floorId: number }[]>`
    SELECT z.id, z.floor_id FROM zones z JOIN floors f ON f.id = z.floor_id WHERE z.id = ${zoneId} AND z.active AND f.active`;
  return z ? { floorId: z.floorId, zoneId: z.id, spaceId: null } : null;
}

/** 空间 → 地方：空间与楼层在用才算；区域取空间所在的区域（区域停用了只到空间） */
async function spacePlace(db: Db, spaceId: number): Promise<Place | null> {
  const [s] = await db<{ id: number; floorId: number; zoneId: number | null }[]>`
    SELECT sp.id, sp.floor_id, CASE WHEN z.active THEN sp.zone_id END AS zone_id
    FROM spaces sp JOIN floors f ON f.id = sp.floor_id LEFT JOIN zones z ON z.id = sp.zone_id
    WHERE sp.id = ${spaceId} AND sp.active AND f.active`;
  return s ? { floorId: s.floorId, zoneId: s.zoneId, spaceId: s.id } : null;
}

/** 离开某个空间时用：停用了也照样认（只用来核对「现在就在这里」） */
async function spacePlaceAny(db: Db, spaceId: number): Promise<Place | null> {
  const [s] = await db<{ id: number; floorId: number; zoneId: number | null }[]>`SELECT id, floor_id, zone_id FROM spaces WHERE id = ${spaceId}`;
  return s ? { floorId: s.floorId, zoneId: s.zoneId, spaceId: s.id } : null;
}

const samePlace = (a: Place, b: Place) => a.floorId === b.floorId && a.zoneId === b.zoneId && a.spaceId === b.spaceId;

/** 离开 p：现在就在 p（空间按空间认，区域按区域认） */
const isAt = (cur: Place, p: Place) => (p.spaceId !== null ? cur.spaceId === p.spaceId : cur.spaceId === null && cur.zoneId === p.zoneId && cur.floorId === p.floorId);

// ───────────────────────── 写入：事件 → 轨迹段 → 当前位置 ─────────────────────────

type Subject = { visitId: number; technicianId?: undefined } | { technicianId: number; visitId?: undefined };
type RefType = 'visit' | 'bill_line' | 'room_stay' | 'technician_session' | 'checkout' | 'space_usage';

interface NewEvent {
  subject: Subject;
  kind: LocationEventKind;
  /** 在某处：必填；离开：离开哪里（只在现在就在那里时才记；不给为离开现在的地方）；离店：不给 */
  place: Place | null;
  source: LocationSource;
  ref?: { type: RefType; id: number } | null;
  readerId?: number | null;
  at: Date;
  staffId: number | null;
  op?: { key: string; hash: string } | null;
  pos?: { x: number | null; y: number | null; accuracy: number | null; deviceId: string | null } | null;
}

interface CurrentRow {
  id: number;
  visitId: number | null;
  technicianId: number | null;
  state: 'none' | 'at' | 'left' | 'gone';
  floorId: number | null;
  zoneId: number | null;
  spaceId: number | null;
  since: string | null;
  trackId: number | null;
  lastAt: string | null;
  lastEventId: number | null;
}

const subjectKey = (s: Subject) => (s.visitId !== undefined ? `v${s.visitId}` : `t${s.technicianId}`);

async function lockCurrent(tx: Tx, s: Subject, create: boolean): Promise<CurrentRow | null> {
  if (create) {
    if (s.visitId !== undefined) await tx`INSERT INTO current_locations (visit_id) VALUES (${s.visitId}) ON CONFLICT (visit_id) DO NOTHING`;
    else await tx`INSERT INTO current_locations (technician_id) VALUES (${s.technicianId}) ON CONFLICT (technician_id) DO NOTHING`;
  }
  const [row] =
    s.visitId !== undefined
      ? await tx<CurrentRow[]>`SELECT * FROM current_locations WHERE visit_id = ${s.visitId} FOR UPDATE`
      : await tx<CurrentRow[]>`SELECT * FROM current_locations WHERE technician_id = ${s.technicianId} FOR UPDATE`;
  return row ?? null;
}

const placeOf = (c: CurrentRow): Place | null => (c.state === 'at' && c.floorId !== null ? { floorId: c.floorId, zoneId: c.zoneId, spaceId: c.spaceId } : null);

async function applyEvent(tx: Tx, cur: CurrentRow, ev: NewEvent, tagCode: string | null): Promise<{ eventId: number; applied: boolean; cur: CurrentRow } | null> {
  const here = placeOf(cur);
  // 离开：只在现在就在那里时才记；离店：只在有过位置时才记（从没记过位置的人离店不留事件）
  if (ev.kind === 'left' && (!here || (ev.place && !isAt(here, ev.place)))) return null;
  if (ev.kind === 'gone' && cur.state !== 'at' && cur.state !== 'left') return null;
  const last = cur.lastAt ? new Date(cur.lastAt) : null;
  // 在某处：比这个人最近一次位置还早的（迟到的刷卡）只记不改；离开、离店总是生效（离开的时刻不早于最近一次位置）
  const applied = ev.kind !== 'at' || !last || ev.at.getTime() >= last.getTime();
  const effective = last && ev.at.getTime() < last.getTime() ? last : ev.at;
  const place = ev.kind === 'gone' ? null : ev.kind === 'left' ? (ev.place ?? here) : ev.place;
  const [row] = await tx<{ id: number }[]>`
    INSERT INTO location_events (visit_id, technician_id, tag_code, kind, floor_id, zone_id, space_id, source, ref_type, ref_id, reader_id,
                                 at, applied, op_key, op_hash, x_mm, y_mm, accuracy_mm, device_id, staff_id)
    VALUES (${cur.visitId}, ${cur.technicianId}, ${tagCode}, ${ev.kind}, ${place?.floorId ?? null}, ${place?.zoneId ?? null}, ${place?.spaceId ?? null},
            ${ev.source}, ${ev.ref?.type ?? null}, ${ev.ref?.id ?? null}, ${ev.readerId ?? null}, ${ev.at}, ${applied},
            ${ev.op?.key ?? null}, ${ev.op?.hash ?? null}, ${ev.pos?.x ?? null}, ${ev.pos?.y ?? null}, ${ev.pos?.accuracy ?? null}, ${ev.pos?.deviceId ?? null},
            ${ev.staffId})
    RETURNING id`;
  const eventId = row!.id;
  if (!applied) return { eventId, applied, cur };
  let next: CurrentRow;
  if (ev.kind === 'at' && here && samePlace(here, ev.place!)) {
    // 同一个地方：续上当前这一段
    await tx`UPDATE location_tracks SET last_at = ${ev.at}, last_event_id = ${eventId}, event_count = event_count + 1 WHERE id = ${cur.trackId}`;
    next = (await tx<CurrentRow[]>`
      UPDATE current_locations SET last_at = ${ev.at}, last_event_id = ${eventId}, updated_at = now() WHERE id = ${cur.id} RETURNING *`)[0]!;
  } else {
    // 换了地方、离开、离店：结束当前这一段
    if (here) await tx`UPDATE location_tracks SET left_at = ${effective}, end_event_id = ${eventId} WHERE id = ${cur.trackId}`;
    if (ev.kind === 'at') {
      const p = ev.place!;
      const [track] = await tx<{ id: number }[]>`
        INSERT INTO location_tracks (visit_id, technician_id, floor_id, zone_id, space_id, entered_at, first_event_id, last_at, last_event_id)
        VALUES (${cur.visitId}, ${cur.technicianId}, ${p.floorId}, ${p.zoneId}, ${p.spaceId}, ${ev.at}, ${eventId}, ${ev.at}, ${eventId})
        RETURNING id`;
      next = (await tx<CurrentRow[]>`
        UPDATE current_locations SET state = 'at', floor_id = ${p.floorId}, zone_id = ${p.zoneId}, space_id = ${p.spaceId}, since = ${ev.at},
               track_id = ${track!.id}, last_at = ${ev.at}, last_event_id = ${eventId}, updated_at = now()
        WHERE id = ${cur.id} RETURNING *`)[0]!;
    } else {
      next = (await tx<CurrentRow[]>`
        UPDATE current_locations SET state = ${ev.kind}, floor_id = NULL, zone_id = NULL, space_id = NULL, since = NULL, track_id = NULL,
               last_at = ${effective}, last_event_id = ${eventId}, updated_at = now()
        WHERE id = ${cur.id} RETURNING *`)[0]!;
    }
  }
  return { eventId, applied, cur: next };
}

/**
 * 写一组位置事件（同一个事务里）：先按固定顺序锁好涉及的每个人的当前位置一行（客人按来访 id 升序，再技师按 id 升序），
 * 再按给定顺序逐条记。有「在某处」的人没有当前位置行时建一行；只有离开、离店的不建（从没记过位置的不留事件）。
 */
async function writeEvents(tx: Tx, events: NewEvent[]): Promise<({ eventId: number; applied: boolean } | null)[]> {
  if (events.length === 0) return [];
  const subjects = new Map<string, { s: Subject; create: boolean }>();
  for (const e of events) {
    const k = subjectKey(e.subject);
    const prev = subjects.get(k);
    subjects.set(k, { s: e.subject, create: (prev?.create ?? false) || e.kind === 'at' });
  }
  const ordered = [...subjects.values()].sort((a, b) => {
    const av = a.s.visitId !== undefined, bv = b.s.visitId !== undefined;
    if (av !== bv) return av ? -1 : 1;
    return (a.s.visitId ?? a.s.technicianId!) - (b.s.visitId ?? b.s.technicianId!);
  });
  const rows = new Map<string, CurrentRow | null>();
  for (const { s, create } of ordered) rows.set(subjectKey(s), await lockCurrent(tx, s, create));
  const visitIds = ordered.flatMap(({ s }) => (s.visitId !== undefined ? [s.visitId] : []));
  const tags = new Map<number, string>();
  if (visitIds.length) {
    for (const t of await tx<{ id: number; code: string }[]>`SELECT v.id, h.code FROM visits v JOIN hand_tags h ON h.id = v.tag_id WHERE v.id IN ${tx(visitIds)}`) tags.set(t.id, t.code);
  }
  const results: ({ eventId: number; applied: boolean } | null)[] = [];
  for (const e of events) {
    const k = subjectKey(e.subject);
    const cur = rows.get(k);
    if (!cur) {
      results.push(null);
      continue;
    }
    const r = await applyEvent(tx, cur, e, e.subject.visitId !== undefined ? (tags.get(e.subject.visitId) ?? null) : null);
    if (r) rows.set(k, r.cur);
    results.push(r ? { eventId: r.eventId, applied: r.applied } : null);
  }
  return results;
}

/** 业务动作推导位置：用存档点隔开，写不进去只是这一次不推导，业务照常生效；等锁最多 2 秒 */
async function quietly(tx: Tx, label: string, fn: (sp: Tx) => Promise<void>): Promise<void> {
  try {
    await tx.savepoint(async (sp) => {
      const s = sp as unknown as Tx;
      const [setting] = await s<{ lockTimeout: string }[]>`SELECT current_setting('lock_timeout') AS lock_timeout`;
      await s`SELECT set_config('lock_timeout', '2s', true)`;
      await fn(s);
      await s`SELECT set_config('lock_timeout', ${setting!.lockTimeout}, true)`;
    });
  } catch (e) {
    console.warn(`[实时位置] ${label}：位置没记上，业务照常生效（${e instanceof Error ? e.message : String(e)}）`);
  }
}

// ───────────────────────── 业务动作推导（各业务模块在自己的事务最后调用） ─────────────────────────

export interface LocateContext {
  at: Date;
  staffId: number;
  /** 按纸质应急单补录：不推导位置（补录时客人早已不在那里）；离店照样清 */
  backfill?: boolean;
}

/** 发手牌入场：客人在接待区（后台没选接待区不记） */
export async function locateCheckin(tx: Tx, visitIds: number[], c: LocateContext) {
  if (c.backfill || visitIds.length === 0) return;
  await quietly(tx, '发手牌', async (sp) => {
    const rules = await loadLocationRules(sp);
    if (!rules.enabled || rules.checkinZoneId === null) return;
    const place = await zonePlace(sp, rules.checkinZoneId);
    if (!place) return;
    await writeEvents(sp, visitIds.map((id) => ({ subject: { visitId: id }, kind: 'at', place, source: 'checkin', ref: { type: 'visit', id }, at: c.at, staffId: c.staffId })));
  });
}

/** 挂账（含手牌点单、挂账派钟）：客人在项目配的区域；几个不同区域的按项目多的区域，一样多按先挂的；都没配的不记 */
export async function locateCharges(tx: Tx, visitId: number, lines: { lineId: number; itemId: number | null }[], c: LocateContext) {
  const itemIds = [...new Set(lines.flatMap((l) => (l.itemId === null ? [] : [l.itemId])))];
  if (c.backfill || itemIds.length === 0) return;
  await quietly(tx, '挂账', async (sp) => {
    const rules = await loadLocationRules(sp);
    if (!rules.enabled) return;
    const zoned = await sp<{ id: number; zoneId: number }[]>`
      SELECT si.id, si.zone_id FROM service_items si JOIN zones z ON z.id = si.zone_id JOIN floors f ON f.id = z.floor_id
      WHERE si.id IN ${sp(itemIds)} AND z.active AND f.active`;
    const zoneOf = new Map(zoned.map((r) => [r.id, r.zoneId]));
    const hits = lines.filter((l) => l.itemId !== null && zoneOf.has(l.itemId));
    if (hits.length === 0) return;
    const counts = new Map<number, number>();
    for (const l of hits) counts.set(zoneOf.get(l.itemId!)!, (counts.get(zoneOf.get(l.itemId!)!) ?? 0) + 1);
    // Map 按第一次出现的顺序：一样多时先挂的那个区域在前，只有更多才换
    let best = 0;
    let bestCount = 0;
    for (const [zoneId, n] of counts) if (n > bestCount) [best, bestCount] = [zoneId, n];
    const place = await zonePlace(sp, best);
    if (!place) return;
    const line = hits.find((l) => zoneOf.get(l.itemId!) === best)!;
    await writeEvents(sp, [{ subject: { visitId }, kind: 'at', place, source: 'consume', ref: { type: 'bill_line', id: line.lineId }, at: c.at, staffId: c.staffId }]);
  });
}

/** 客房开房、换房：客人在那间房（房间挂了空间才记） */
export async function locateRoomStay(tx: Tx, visitId: number, roomId: number, stayId: number, source: 'room_checkin' | 'room_move', c: LocateContext) {
  if (c.backfill) return;
  await quietly(tx, source === 'room_checkin' ? '开房' : '换房', async (sp) => {
    const rules = await loadLocationRules(sp);
    if (!rules.enabled) return;
    const [room] = await sp<{ spaceId: number | null }[]>`SELECT space_id FROM rooms WHERE id = ${roomId}`;
    const place = room?.spaceId ? await spacePlace(sp, room.spaceId) : null;
    if (!place) return;
    await writeEvents(sp, [{ subject: { visitId }, kind: 'at', place, source, ref: { type: 'room_stay', id: stayId }, at: c.at, staffId: c.staffId }]);
  });
}

/** 客房退房、撤销入住：客人离开那间房，位置不明（只在他现在就在那间房时；开关关着也照样清） */
export async function leaveRoomStay(tx: Tx, visitId: number, roomId: number, stayId: number, c: LocateContext) {
  await quietly(tx, '退房', async (sp) => {
    const [room] = await sp<{ spaceId: number | null }[]>`SELECT space_id FROM rooms WHERE id = ${roomId}`;
    const place = room?.spaceId ? await spacePlaceAny(sp, room.spaceId) : null;
    if (!place) return;
    await writeEvents(sp, [{ subject: { visitId }, kind: 'left', place, source: 'room_close', ref: { type: 'room_stay', id: stayId }, at: c.at, staffId: c.staffId }]);
  });
}

/** 派对房等开单（D39，v0.7.19）：使用人在那间房 */
export async function locateUsage(tx: Tx, visitId: number, spaceId: number, usageId: number, c: LocateContext) {
  if (c.backfill) return;
  await quietly(tx, '开单使用', async (sp) => {
    const rules = await loadLocationRules(sp);
    if (!rules.enabled) return;
    const place = await spacePlace(sp, spaceId);
    if (!place) return;
    await writeEvents(sp, [{ subject: { visitId }, kind: 'at', place, source: 'usage_open', ref: { type: 'space_usage', id: usageId }, at: c.at, staffId: c.staffId }]);
  });
}

/** 使用单结束、撤单：使用人离开那间房，位置不明（只在他现在就在那间房时；开关关着也照样清） */
export async function leaveUsages(tx: Tx, usages: { id: number; visitId: number; spaceId: number }[], c: LocateContext) {
  if (usages.length === 0) return;
  await quietly(tx, '结束使用', async (sp) => {
    const events: NewEvent[] = [];
    for (const u of [...usages].sort((a, b) => a.visitId - b.visitId || a.id - b.id)) {
      const place = await spacePlaceAny(sp, u.spaceId);
      if (place) events.push({ subject: { visitId: u.visitId }, kind: 'left', place, source: 'usage_close', ref: { type: 'space_usage', id: u.id }, at: c.at, staffId: c.staffId });
    }
    await writeEvents(sp, events);
  });
}

/** 上钟、在钟上换服务的房间：技师与客人在钟单记的房间（没记房间的不记；还没上钟的换房间不动） */
export async function locateSession(tx: Tx, sessionId: number, source: 'session_start' | 'session_room', c: LocateContext) {
  if (c.backfill) return;
  await quietly(tx, source === 'session_start' ? '上钟' : '换房间', async (sp) => {
    const rules = await loadLocationRules(sp);
    if (!rules.enabled) return;
    const [s] = await sp<{ visitId: number; technicianId: number; spaceId: number | null; status: string }[]>`
      SELECT visit_id, technician_id, space_id, status FROM technician_sessions WHERE id = ${sessionId}`;
    if (!s?.spaceId || s.status !== 'serving') return;
    const place = await spacePlace(sp, s.spaceId);
    if (!place) return;
    const ref = { type: 'technician_session' as const, id: sessionId };
    await writeEvents(sp, [
      { subject: { visitId: s.visitId }, kind: 'at', place, source, ref, at: c.at, staffId: c.staffId },
      { subject: { technicianId: s.technicianId }, kind: 'at', place, source, ref, at: c.at, staffId: c.staffId },
    ]);
  });
}

/** 下钟、退钟、结账时一起下钟：技师回技师休息区；没设休息区（或开关关着）的离开那间房、位置不明；客人不动 */
export async function locateSessionEnd(tx: Tx, sessions: { id: number; technicianId: number; spaceId: number | null }[], c: LocateContext) {
  if (sessions.length === 0) return;
  await quietly(tx, '下钟', async (sp) => {
    const rules = await loadLocationRules(sp);
    const rest = rules.enabled && rules.restZoneId !== null ? await zonePlace(sp, rules.restZoneId) : null;
    const events: NewEvent[] = [];
    for (const s of sessions) {
      const ref = { type: 'technician_session' as const, id: s.id };
      if (rest) events.push({ subject: { technicianId: s.technicianId }, kind: 'at', place: rest, source: 'session_end', ref, at: c.at, staffId: c.staffId });
      else if (s.spaceId) {
        const room = await spacePlaceAny(sp, s.spaceId);
        if (room) events.push({ subject: { technicianId: s.technicianId }, kind: 'left', place: room, source: 'session_end', ref, at: c.at, staffId: c.staffId });
      }
    }
    await writeEvents(sp, events);
  });
}

/** 技师上牌：在技师休息区；没设休息区（或开关关着）的清掉之前留下的位置（例如前一天没下牌） */
export async function locateSignIn(tx: Tx, technicianIds: number[], c: LocateContext) {
  if (technicianIds.length === 0) return;
  await quietly(tx, '技师上牌', async (sp) => {
    const rules = await loadLocationRules(sp);
    const rest = rules.enabled && rules.restZoneId !== null ? await zonePlace(sp, rules.restZoneId) : null;
    await writeEvents(
      sp,
      technicianIds.map((id) => ({ subject: { technicianId: id }, kind: rest ? 'at' : 'left', place: rest, source: 'sign_in', at: c.at, staffId: c.staffId })),
    );
  });
}

/** 技师下牌：离店（开关关着也照样清） */
export async function locateSignOut(tx: Tx, technicianId: number, c: LocateContext) {
  await quietly(tx, '技师下牌', async (sp) => {
    await writeEvents(sp, [{ subject: { technicianId }, kind: 'gone', place: null, source: 'sign_out', at: c.at, staffId: c.staffId }]);
  });
}

/** 结账离场、撤销来访：客人离店，当前位置清掉（开关关着、补录也照样清） */
export async function locateGone(tx: Tx, visitIds: number[], source: 'checkout' | 'visit_cancel', ref: { type: 'checkout' | 'visit'; id: number } | null, c: LocateContext) {
  if (visitIds.length === 0) return;
  await quietly(tx, source === 'checkout' ? '结账离场' : '撤销来访', async (sp) => {
    await writeEvents(
      sp,
      [...visitIds].sort((a, b) => a - b).map((id) => ({ subject: { visitId: id }, kind: 'gone', place: null, source, ref: ref ?? { type: 'visit', id }, at: c.at, staffId: c.staffId })),
    );
  });
}

// ───────────────────────── 上报即定位 ─────────────────────────

export const ReportInput = z
  .object({
    /** 操作编号：同一个编号原样重发返回原结果、不重复记 */
    opId: z.uuid('操作编号格式不正确'),
    source: z.enum(REPORT_SOURCES, '数据来源只能是刷卡点（reader）或定位上报（position）'),
    readerCode: z.string().trim().toUpperCase().regex(READER_CODE_PATTERN, '刷卡点编号不正确').optional(),
    tagCode: z.string().trim().toUpperCase().min(1, '请填写手牌号').max(16, '手牌号最多 16 位').optional(),
    technicianNo: z.string().trim().min(1, '请填写技师工号').max(6, '技师工号最多 6 位').optional(),
    spaceCode: z.string().trim().toUpperCase().min(1).max(8, '空间编码最多 8 位').optional(),
    zoneId: z.number().int().positive().optional(),
    at: z.iso.datetime({ offset: true, message: '时刻格式不正确' }).optional(),
    // 第二级精确定位预留：底图坐标（毫米）、精度（毫米）、设备编号
    x: z.number().int().min(-100_000_000).max(100_000_000).optional(),
    y: z.number().int().min(-100_000_000).max(100_000_000).optional(),
    accuracy: z.number().int().min(0).max(100_000_000).optional(),
    deviceId: z.string().trim().min(1).max(64).optional(),
  })
  .superRefine((v, ctx) => {
    if ((v.tagCode === undefined) === (v.technicianNo === undefined)) ctx.addIssue({ code: 'custom', message: '手牌号与技师工号填一个', path: ['tagCode'] });
    if (v.source === 'reader') {
      if (!v.readerCode) ctx.addIssue({ code: 'custom', message: '刷卡要给刷卡点编号', path: ['readerCode'] });
      if (v.spaceCode !== undefined || v.zoneId !== undefined) ctx.addIssue({ code: 'custom', message: '刷卡按刷卡点定位，不要再给空间或区域', path: ['spaceCode'] });
    } else {
      if ((v.spaceCode === undefined) === (v.zoneId === undefined)) ctx.addIssue({ code: 'custom', message: '定位上报给空间编码或区域，二选一', path: ['spaceCode'] });
      if (v.readerCode !== undefined) ctx.addIssue({ code: 'custom', message: '定位上报不用刷卡点编号', path: ['readerCode'] });
    }
  });

const opKeyReused = () => conflict('OP_KEY_REUSED', '这个操作编号已经报过另一条位置，请换一个新的操作编号');
const reportAbandoned = () => conflict('OP_ABANDONED', '这次刷卡已经确认作废，没有记；要记请重新刷卡');
/** 来访拿到现在这张手牌的时刻：入场，或之后换到这张牌（换手牌记在 visit_tag_changes） */
const TAG_SINCE = `greatest(v.checked_in_at, (SELECT max(c.created_at) FROM visit_tag_changes c WHERE c.visit_id = v.id AND c.to_tag_id = v.tag_id))`;

export async function reportLocation(deps: Deps, raw: unknown, ctx: OpContext): Promise<LocationReportResult> {
  const input = parse(ReportInput, raw);
  const { opId, ...payload } = input;
  const hash = hashRequest(payload);
  const replay = await replayReport(deps, opId, hash);
  if (replay) return replay;
  // 页面「结果待确认」后确认作废的编号（v0.7.17，Codex 复审）：原请求晚到也不记。这里先查一次给明确的提示，事务里取锁后再核对
  if (await isFenced(deps.sql, opId, ['location_report'])) throw reportAbandoned();
  const rules = await loadLocationRules(deps.sql);
  if (!rules.enabled) throw conflict('LOCATION_OFF', '实时位置没有开启（后台「空间台账 → 实时位置」）');
  const [now] = await deps.sql<{ now: string }[]>`SELECT now() AS now`;
  const serverNow = new Date(now!.now);
  const at = input.at ? new Date(input.at) : serverNow;
  if (at.getTime() > serverNow.getTime() + REPORT_MAX_SKEW_MS) throw unprocessable('REPORT_TIME', '上报的时刻比服务器晚了 2 分钟以上，请核对设备时钟');
  if (at.getTime() < serverNow.getTime() - REPORT_MAX_AGE_MS) throw unprocessable('REPORT_TIME', '上报的时刻早于 24 小时，不再记');

  // 在哪：刷卡点所在的区域或空间；定位上报直接给空间或区域
  let place: Place | null;
  let readerId: number | null = null;
  if (input.source === 'reader') {
    const [r] = await deps.sql<{ id: number; name: string; active: boolean; zoneId: number | null; spaceId: number | null }[]>`
      SELECT id, name, active, zone_id, space_id FROM location_readers WHERE code = ${input.readerCode!}`;
    if (!r) throw notFound(`刷卡点 ${input.readerCode} 没有登记`);
    if (!r.active) throw unprocessable('READER_INACTIVE', `刷卡点 ${input.readerCode}（${r.name}）已停用`);
    readerId = r.id;
    place = r.spaceId ? await spacePlace(deps.sql, r.spaceId) : await zonePlace(deps.sql, r.zoneId!);
    if (!place) throw unprocessable('PLACE_INACTIVE', `刷卡点 ${input.readerCode}（${r.name}）装的${r.spaceId ? '空间' : '区域'}已停用，请到后台改刷卡点`);
  } else if (input.spaceCode !== undefined) {
    const [s] = await deps.sql<{ id: number }[]>`SELECT id FROM spaces WHERE code = ${input.spaceCode}`;
    if (!s) throw notFound(`空间 ${input.spaceCode} 不在台账里`);
    place = await spacePlace(deps.sql, s.id);
    if (!place) throw unprocessable('PLACE_INACTIVE', `空间 ${input.spaceCode} 已停用`);
  } else {
    place = await zonePlace(deps.sql, input.zoneId!);
    if (!place) throw unprocessable('PLACE_INACTIVE', '区域不存在或已停用');
  }

  // 谁：手牌号 → 持这张牌的在店客人；技师工号 → 技师（不加锁，拿到当前位置的锁后再核对客人还在店）
  let subject: Subject;
  if (input.tagCode !== undefined) {
    const [v] = await deps.sql<{ id: number }[]>`
      SELECT v.id FROM visits v JOIN hand_tags h ON h.id = v.tag_id WHERE h.code = ${input.tagCode} AND v.status = 'open'`;
    if (!v) throw unprocessable('TAG_NOT_IN_STORE', `手牌 ${input.tagCode} 没有在店客人`);
    subject = { visitId: v.id };
  } else {
    const [t] = await deps.sql<{ id: number; active: boolean }[]>`SELECT id, active FROM technicians WHERE lower(tech_no) = lower(${input.technicianNo!})`;
    if (!t) throw notFound(`技师工号 ${input.technicianNo} 不存在`);
    if (!t.active) throw unprocessable('TECHNICIAN_INACTIVE', `技师 ${input.technicianNo} 已停用`);
    subject = { technicianId: t.id };
  }

  try {
    const done = await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      // 先取操作编号的锁，与确认作废串行：作废了的整笔不记；同一个编号已经记过的（连点、原样重发）返回原结果
      await assertNotFenced(tx, opId, 'location_report', reportAbandoned);
      const [prev] = await tx<{ id: number; opHash: string }[]>`SELECT id, op_hash FROM location_events WHERE op_key = ${opId}`;
      if (prev) {
        if (prev.opHash !== hash) throw opKeyReused();
        return { eventId: prev.id, replayed: true };
      }
      // 刷卡点、空间在上面查过之后被停用的极少，按查到时为准；客人在拿到当前位置的锁之后再核对还在店、还拿着这张手牌
      const cur = await lockCurrent(tx, subject, true);
      let tagCode: string | null = null;
      if (subject.visitId !== undefined) {
        const [v] = await tx<{ status: string; tagCode: string; tagSince: string }[]>`
          SELECT v.status, h.code AS tag_code, ${tx.unsafe(TAG_SINCE)} AS tag_since
          FROM visits v JOIN hand_tags h ON h.id = v.tag_id WHERE v.id = ${subject.visitId}`;
        if (v!.status !== 'open' || v!.tagCode !== input.tagCode) throw unprocessable('TAG_NOT_IN_STORE', `手牌 ${input.tagCode} 的客人刚刚离店或换了手牌`);
        // 手牌退回后又发给了别的客人：上一位客人迟到的刷卡不能算到现在这位头上（Codex 复审）
        if (at.getTime() < new Date(v!.tagSince).getTime()) {
          throw unprocessable('REPORT_BEFORE_TAG', `这次上报的时刻早于手牌 ${input.tagCode} 发给现在这位客人，不知道是哪位客人刷的，不记`);
        }
        tagCode = v!.tagCode;
      }
      const r = await applyEvent(
        tx,
        cur!,
        {
          subject,
          kind: 'at',
          place,
          source: input.source,
          readerId,
          at,
          staffId: ctx.actor.id,
          op: { key: opId, hash },
          pos: input.source === 'position' ? { x: input.x ?? null, y: input.y ?? null, accuracy: input.accuracy ?? null, deviceId: input.deviceId ?? null } : null,
        },
        tagCode,
      );
      return { eventId: r!.eventId, replayed: false };
    });
    return await reportResult(deps, done.eventId, done.replayed);
  } catch (e) {
    // 同一个编号同时发了两次：后到的那次等先到的提交后撞上唯一索引，返回先到的结果
    if (isUniqueViolation(e, 'location_events_op_uq')) {
      const again = await replayReport(deps, opId, hash);
      if (again) return again;
    }
    throw e;
  }
}

async function replayReport(deps: Deps, opId: string, hash: string): Promise<LocationReportResult | null> {
  const [done] = await deps.sql<{ id: number; opHash: string }[]>`SELECT id, op_hash FROM location_events WHERE op_key = ${opId}`;
  if (!done) return null;
  if (done.opHash !== hash) throw opKeyReused();
  return reportResult(deps, done.id, true);
}

async function reportResult(deps: Deps, eventId: number, replayed: boolean): Promise<LocationReportResult> {
  const [e] = await deps.sql<{ applied: boolean; visitId: number | null; technicianId: number | null }[]>`
    SELECT applied, visit_id, technician_id FROM location_events WHERE id = ${eventId}`;
  const people = await peopleWhere(deps.sql, deps, e!.visitId !== null ? { visitId: e!.visitId } : { technicianId: e!.technicianId! });
  return { eventId, applied: e!.applied, replayed, current: people[0] ?? null };
}

// ───────────────────────── 查询：现在谁在哪、轨迹 ─────────────────────────

const PLACE_COLUMNS = (alias: string) => `
  ${alias}.floor_id, f.code AS floor_code, f.name AS floor_name, ${alias}.zone_id, z.name AS zone_name,
  ${alias}.space_id, sp.code AS space_code, sp.display_name AS space_name`;

async function today(db: Db, deps: Deps): Promise<string> {
  const [now] = await db<{ now: string }[]>`SELECT now() AS now`;
  return businessDate(db, deps, new Date(now!.now));
}

/** 现在在某处的人：在店客人与今天在岗（上了牌、没下牌）的技师；停用了的技师不列（与在岗人数同一口径） */
async function peopleWhere(db: Db, deps: Deps, only?: Subject): Promise<LocationPerson[]> {
  const date = await today(db, deps);
  const visitFilter = only ? (only.visitId !== undefined ? db`AND c.visit_id = ${only.visitId}` : db`AND false`) : db``;
  const techFilter = only ? (only.technicianId !== undefined ? db`AND c.technician_id = ${only.technicianId}` : db`AND false`) : db``;
  const rows = await db<(Omit<LocationPerson, 'since' | 'lastAt'> & { since: string; lastAt: string })[]>`
    SELECT 'guest' AS kind, c.visit_id AS id, h.code AS tag_code, NULL::text AS tech_no, NULL::text AS tech_name,
           ${db.unsafe(PLACE_COLUMNS('c'))}, c.since, c.last_at, e.source AS last_source
    FROM current_locations c
    JOIN visits v ON v.id = c.visit_id AND v.status = 'open'
    JOIN hand_tags h ON h.id = v.tag_id
    JOIN floors f ON f.id = c.floor_id LEFT JOIN zones z ON z.id = c.zone_id LEFT JOIN spaces sp ON sp.id = c.space_id
    JOIN location_events e ON e.id = c.last_event_id
    WHERE c.state = 'at' ${visitFilter}
    UNION ALL
    SELECT 'technician', c.technician_id, NULL, t.tech_no, t.name,
           ${db.unsafe(PLACE_COLUMNS('c'))}, c.since, c.last_at, e.source
    FROM current_locations c
    JOIN technicians t ON t.id = c.technician_id AND t.active
    JOIN technician_status ts ON ts.technician_id = t.id AND ts.business_date = ${date} AND ts.state <> 'off'
    JOIN floors f ON f.id = c.floor_id LEFT JOIN zones z ON z.id = c.zone_id LEFT JOIN spaces sp ON sp.id = c.space_id
    JOIN location_events e ON e.id = c.last_event_id
    WHERE c.state = 'at' ${techFilter}
    ORDER BY floor_code, zone_name NULLS LAST, space_code NULLS FIRST, kind, since`;
  return rows.map((r) => ({ ...r, since: new Date(r.since).toISOString(), lastAt: new Date(r.lastAt).toISOString() }));
}

export async function currentLocations(db: Db, deps: Deps): Promise<LocationsCurrent> {
  const [now] = await db<{ now: string }[]>`SELECT now() AS now`;
  const rules = await loadLocationRules(db);
  const date = await businessDate(db, deps, new Date(now!.now));
  const [counts] = await db<{ guests: number; technicians: number }[]>`
    SELECT (SELECT count(*) FROM visits WHERE status = 'open')::int AS guests,
           (SELECT count(*) FROM technician_status ts JOIN technicians t ON t.id = ts.technician_id
            WHERE ts.business_date = ${date} AND ts.state <> 'off' AND t.active)::int AS technicians`;
  return {
    serverTime: new Date(now!.now).toISOString(),
    enabled: rules.enabled,
    people: await peopleWhere(db, deps),
    guestsInStore: counts!.guests,
    techniciansOnDuty: counts!.technicians,
  };
}

const MAX_TRACK_EVENTS = 500;

const placeFrom = (r: { floorId: number | null; floorCode: string | null; floorName: string | null; zoneId: number | null; zoneName: string | null; spaceId: number | null; spaceCode: string | null; spaceName: string | null }): LocationPlace | null =>
  r.floorId === null
    ? null
    : { floorId: r.floorId, floorCode: r.floorCode!, floorName: r.floorName!, zoneId: r.zoneId, zoneName: r.zoneName, spaceId: r.spaceId, spaceCode: r.spaceCode, spaceName: r.spaceName };

export const TrackQuery = z
  .object({
    visitId: z.coerce.number().int().positive().optional(),
    technicianId: z.coerce.number().int().positive().optional(),
    date: z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD').optional(),
  })
  .refine((v) => (v.visitId === undefined) !== (v.technicianId === undefined), '客人与技师选一个');

/** 一个人的轨迹：客人看这次来访的全部；技师看一个营业日（默认今天） */
export async function locationTrack(db: Db, deps: Deps, raw: unknown): Promise<LocationTrackData> {
  const q = parse(TrackQuery, raw);
  let subject: LocationTrackData['subject'];
  let range: { from: Date; to: Date } | null = null;
  if (q.visitId !== undefined) {
    const [v] = await db<{ id: number; visitNo: string; tagCode: string; status: string; checkedInAt: string }[]>`
      SELECT v.id, v.visit_no, h.code AS tag_code, v.status, v.checked_in_at FROM visits v JOIN hand_tags h ON h.id = v.tag_id WHERE v.id = ${q.visitId}`;
    if (!v) throw notFound('来访不存在');
    subject = { kind: 'guest', visitId: v.id, visitNo: v.visitNo, tagCode: v.tagCode, inStore: v.status === 'open', checkedInAt: new Date(v.checkedInAt).toISOString() };
  } else {
    const [t] = await db<{ id: number; techNo: string; name: string }[]>`SELECT id, tech_no, name FROM technicians WHERE id = ${q.technicianId!}`;
    if (!t) throw notFound('技师不存在');
    const date = q.date ?? (await today(db, deps));
    const settings = await loadSettings(db);
    const from = businessDayStart(date, deps.config.timezone, settings.businessDayStartHour);
    const next = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)) + 1)).toISOString().slice(0, 10);
    range = { from, to: businessDayStart(next, deps.config.timezone, settings.businessDayStartHour) };
    subject = { kind: 'technician', technicianId: t.id, techNo: t.techNo, name: t.name, date };
  }
  const who = q.visitId !== undefined ? db`t.visit_id = ${q.visitId}` : db`t.technician_id = ${q.technicianId!}`;
  const inRange = range ? db`AND t.entered_at < ${range.to} AND (t.left_at IS NULL OR t.left_at >= ${range.from})` : db``;
  const tracks = await db<(Omit<LocationTrackSegment, 'enteredAt' | 'lastAt' | 'leftAt'> & { enteredAt: string; lastAt: string; leftAt: string | null })[]>`
    SELECT t.id, ${db.unsafe(PLACE_COLUMNS('t'))}, t.entered_at, t.last_at, t.left_at, t.event_count,
           fe.source AS enter_source, ee.source AS end_source
    FROM location_tracks t
    JOIN floors f ON f.id = t.floor_id LEFT JOIN zones z ON z.id = t.zone_id LEFT JOIN spaces sp ON sp.id = t.space_id
    JOIN location_events fe ON fe.id = t.first_event_id LEFT JOIN location_events ee ON ee.id = t.end_event_id
    WHERE ${who} ${inRange}
    ORDER BY t.entered_at, t.id`;
  const whoE = q.visitId !== undefined ? db`e.visit_id = ${q.visitId}` : db`e.technician_id = ${q.technicianId!}`;
  const inRangeE = range ? db`AND e.at >= ${range.from} AND e.at < ${range.to}` : db``;
  const events = await db<
    {
      id: number;
      kind: LocationEventKind;
      floorId: number | null;
      floorCode: string | null;
      floorName: string | null;
      zoneId: number | null;
      zoneName: string | null;
      spaceId: number | null;
      spaceCode: string | null;
      spaceName: string | null;
      source: LocationSource;
      at: string;
      recordedAt: string;
      applied: boolean;
      tagCode: string | null;
      readerCode: string | null;
      readerName: string | null;
      refText: string | null;
      staffName: string | null;
    }[]
  >`
    SELECT e.id, e.kind, ${db.unsafe(PLACE_COLUMNS('e'))}, e.source, e.at, e.recorded_at, e.applied, e.tag_code,
           r.code AS reader_code, r.name AS reader_name, st.display_name AS staff_name,
           CASE e.ref_type
             WHEN 'visit' THEN (SELECT visit_no FROM visits WHERE id = e.ref_id)
             WHEN 'bill_line' THEN (SELECT name FROM bill_lines WHERE id = e.ref_id)
             WHEN 'room_stay' THEN (SELECT rs.stay_no || ' ' || rm.room_no FROM room_stays rs JOIN rooms rm ON rm.id = rs.room_id WHERE rs.id = e.ref_id)
             WHEN 'technician_session' THEN (SELECT session_no FROM technician_sessions WHERE id = e.ref_id)
             WHEN 'checkout' THEN (SELECT checkout_no FROM checkouts WHERE id = e.ref_id)
           END AS ref_text
    FROM location_events e
    LEFT JOIN floors f ON f.id = e.floor_id LEFT JOIN zones z ON z.id = e.zone_id LEFT JOIN spaces sp ON sp.id = e.space_id
    LEFT JOIN location_readers r ON r.id = e.reader_id LEFT JOIN staff st ON st.id = e.staff_id
    WHERE ${whoE} ${inRangeE}
    ORDER BY e.at DESC, e.id DESC
    LIMIT ${MAX_TRACK_EVENTS + 1}`;
  const current = (await peopleWhere(db, deps, q.visitId !== undefined ? { visitId: q.visitId } : { technicianId: q.technicianId! }))[0] ?? null;
  return {
    subject,
    current,
    tracks: tracks.map((t) => ({
      ...t,
      enteredAt: new Date(t.enteredAt).toISOString(),
      lastAt: new Date(t.lastAt).toISOString(),
      leftAt: t.leftAt ? new Date(t.leftAt).toISOString() : null,
    })),
    events: events
      .slice(0, MAX_TRACK_EVENTS)
      .reverse()
      .map(
        (e): LocationEventRow => ({
          id: e.id,
          kind: e.kind,
          place: placeFrom(e),
          source: e.source,
          at: new Date(e.at).toISOString(),
          recordedAt: new Date(e.recordedAt).toISOString(),
          applied: e.applied,
          tagCode: e.tagCode,
          readerCode: e.readerCode,
          readerName: e.readerName,
          refText: e.refText,
          staffName: e.staffName,
        }),
      ),
    eventsTruncated: events.length > MAX_TRACK_EVENTS,
  };
}

// ───────────────────────── 后台：开关与区域、刷卡点、项目所在区域 ─────────────────────────

export async function locationAdmin(db: Db): Promise<LocationAdmin> {
  const rules = await loadLocationRules(db);
  const readers = await db<
    (Omit<LocationReader, 'place' | 'lastAt'> & {
      floorId: number;
      floorCode: string;
      floorName: string;
      zoneName: string | null;
      placeZoneId: number | null;
      spaceCode: string | null;
      spaceName: string | null;
      lastAt: string | null;
    })[]
  >`
    SELECT r.id, r.code, r.name, r.zone_id, r.space_id, r.note, r.active, r.version,
           f.id AS floor_id, f.code AS floor_code, f.name AS floor_name, z.id AS place_zone_id, z.name AS zone_name,
           sp.code AS space_code, sp.display_name AS space_name,
           (CASE WHEN r.space_id IS NOT NULL THEN NOT sp.active ELSE NOT z.active END) OR NOT f.active AS place_inactive,
           (SELECT max(e.at) FROM location_events e WHERE e.reader_id = r.id) AS last_at
    FROM location_readers r
    LEFT JOIN spaces sp ON sp.id = r.space_id
    LEFT JOIN zones z ON z.id = coalesce(r.zone_id, sp.zone_id)
    JOIN floors f ON f.id = coalesce(sp.floor_id, z.floor_id)
    ORDER BY r.active DESC, r.code`;
  const zones = await db<LocationZone[]>`
    SELECT z.id, f.code AS floor_code, f.name AS floor_name, z.name, z.active AND f.active AS active
    FROM zones z JOIN floors f ON f.id = z.floor_id ORDER BY f.sort_order, f.code, z.sort_order, z.name`;
  const items = await db<LocationItem[]>`
    SELECT id, name, category, active, zone_id FROM service_items ORDER BY active DESC, category, sort_order, name`;
  const [now] = await db<{ now: string }[]>`SELECT now() AS now`;
  return {
    serverTime: new Date(now!.now).toISOString(),
    rules,
    readers: readers.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      zoneId: r.zoneId,
      spaceId: r.spaceId,
      place: {
        floorId: r.floorId,
        floorCode: r.floorCode,
        floorName: r.floorName,
        zoneId: r.placeZoneId,
        zoneName: r.zoneName,
        spaceId: r.spaceId,
        spaceCode: r.spaceCode,
        spaceName: r.spaceName,
      },
      placeInactive: r.placeInactive,
      note: r.note,
      active: r.active,
      version: r.version,
      lastAt: r.lastAt ? new Date(r.lastAt).toISOString() : null,
    })),
    zones,
    items,
  };
}

const RulesInput = z.object({
  enabled: z.boolean('请选择开或关'),
  checkinZoneId: z.number().int().positive().nullable(),
  restZoneId: z.number().int().positive().nullable(),
});

async function saveRules(deps: Deps, raw: unknown, ctx: OpContext) {
  await deps.sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('settings'))`;
    const before = await loadLocationRules(tx);
    const after = parse(RulesInput, { ...before, ...parse(RulesInput.partial(), raw) });
    for (const [label, id] of [['接待区', after.checkinZoneId], ['技师休息区', after.restZoneId]] as const) {
      if (id === null || id === before[label === '接待区' ? 'checkinZoneId' : 'restZoneId']) continue;
      if (!(await zonePlace(tx, id))) throw unprocessable('ZONE_INACTIVE', `${label}选的区域不存在或已停用`);
    }
    await tx`
      INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('location_rules', ${tx.json(after as never)}, now(), ${ctx.actor.id})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`;
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'settings_updated', targetType: 'settings', detail: { key: 'location_rules', before, after }, ip: ctx.ip });
  });
}

const ReaderFields = {
  code: z.string('请填写刷卡点编号').trim().toUpperCase().regex(READER_CODE_PATTERN, '编号只能是大写字母、数字与横线，最多 24 位'),
  name: z.string('请填写名称').trim().min(1, '请填写名称').max(24, '名称最多 24 字'),
  zoneId: z.number().int().positive().nullable(),
  spaceId: z.number().int().positive().nullable(),
  note: z.string().trim().max(200, '备注最多 200 字').default(''),
  active: z.boolean().default(true),
};
const ReaderInput = z.object(ReaderFields).refine((r) => (r.zoneId === null) !== (r.spaceId === null), { message: '装在哪：选一个区域或一个空间', path: ['zoneId'] });
const ReaderUpdateInput = z
  .object({ ...ReaderFields, expectedVersion: z.number('请刷新后重试').int().min(1) })
  .refine((r) => (r.zoneId === null) !== (r.spaceId === null), { message: '装在哪：选一个区域或一个空间', path: ['zoneId'] });

async function assertReaderPlace(tx: Tx, zoneId: number | null, spaceId: number | null) {
  const ok = spaceId !== null ? await spacePlace(tx, spaceId) : await zonePlace(tx, zoneId!);
  if (!ok) throw unprocessable('PLACE_INACTIVE', spaceId !== null ? '选的空间不存在或已停用' : '选的区域不存在或已停用');
}

const readerText = (r: { code: string; name: string }) => `${r.code}（${r.name}）`;

async function createReader(deps: Deps, raw: unknown, ctx: OpContext) {
  const input = parse(ReaderInput, raw);
  try {
    await deps.sql.begin(async (tx) => {
      await assertReaderPlace(tx, input.zoneId, input.spaceId);
      const [r] = await tx<{ id: number }[]>`
        INSERT INTO location_readers (code, name, zone_id, space_id, note, active, created_by)
        VALUES (${input.code}, ${input.name}, ${input.zoneId}, ${input.spaceId}, ${input.note}, ${input.active}, ${ctx.actor.id})
        RETURNING id`;
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'location_reader_saved',
        targetType: 'location_reader',
        targetId: r!.id,
        detail: { ...input, summary: `新建刷卡点 ${readerText(input)}` },
        ip: ctx.ip,
      });
    });
  } catch (e) {
    if (isUniqueViolation(e, 'location_readers_code_uq')) throw conflict('READER_CODE_TAKEN', `刷卡点编号 ${input.code} 已经登记过了`);
    throw e;
  }
}

async function updateReader(deps: Deps, id: number, raw: unknown, ctx: OpContext) {
  const { expectedVersion, ...input } = parse(ReaderUpdateInput, raw);
  try {
    await deps.sql.begin(async (tx) => {
      const [before] = await tx<{ code: string; name: string; zoneId: number | null; spaceId: number | null; note: string; active: boolean; version: number }[]>`
        SELECT code, name, zone_id, space_id, note, active, version FROM location_readers WHERE id = ${id} FOR UPDATE`;
      if (!before) throw notFound('刷卡点不存在');
      if (before.version !== expectedVersion) throw conflict('READER_STALE', `刷卡点 ${readerText(before)} 刚刚被别人改过，请刷新后再改`);
      // 停用不核对装的地方；在用的、换了地方的要核对地方在用
      if (input.active && (input.zoneId !== before.zoneId || input.spaceId !== before.spaceId || !before.active)) {
        await assertReaderPlace(tx, input.zoneId, input.spaceId);
      }
      await tx`
        UPDATE location_readers SET code = ${input.code}, name = ${input.name}, zone_id = ${input.zoneId}, space_id = ${input.spaceId},
               note = ${input.note}, active = ${input.active}, version = version + 1, updated_at = now()
        WHERE id = ${id}`;
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'location_reader_saved',
        targetType: 'location_reader',
        targetId: id,
        detail: { before, after: input, summary: `修改刷卡点 ${readerText(before)}${input.active === before.active ? '' : input.active ? '（启用）' : '（停用）'}` },
        ip: ctx.ip,
      });
    });
  } catch (e) {
    if (isUniqueViolation(e, 'location_readers_code_uq')) throw conflict('READER_CODE_TAKEN', `刷卡点编号 ${input.code} 已经登记过了`);
    throw e;
  }
}

const ItemZonesInput = z.object({
  items: z
    .array(z.object({ id: z.number().int().positive(), zoneId: z.number().int().positive().nullable() }))
    .min(1, '没有要调整的项目')
    .max(1000),
});

/** 项目所在区域：只提交要改的项目（按项目 id 升序加锁，与项目编辑串行） */
async function saveItemZones(deps: Deps, raw: unknown, ctx: OpContext) {
  const { items } = parse(ItemZonesInput, raw);
  const ids = [...new Set(items.map((i) => i.id))];
  if (ids.length !== items.length) throw badRequest('同一个项目提交了两次');
  await deps.sql.begin(async (tx) => {
    const zoneIds = [...new Set(items.flatMap((i) => (i.zoneId === null ? [] : [i.zoneId])))];
    for (const z of zoneIds) if (!(await zonePlace(tx, z))) throw unprocessable('ZONE_INACTIVE', '选的区域不存在或已停用，请刷新后重试');
    const rows = await tx<{ id: number; name: string; zoneId: number | null }[]>`
      SELECT id, name, zone_id FROM service_items WHERE id IN ${tx(ids)} ORDER BY id FOR UPDATE`;
    if (rows.length !== ids.length) throw notFound('有项目不存在，请刷新后重试');
    const want = new Map(items.map((i) => [i.id, i.zoneId]));
    const changed = rows.filter((r) => r.zoneId !== want.get(r.id));
    if (changed.length === 0) return;
    for (const r of changed) await tx`UPDATE service_items SET zone_id = ${want.get(r.id)!}, updated_at = now() WHERE id = ${r.id}`;
    const zoneNames = new Map(
      (zoneIds.length ? await tx<{ id: number; name: string }[]>`SELECT id, name FROM zones WHERE id IN ${tx(zoneIds)}` : []).map((z) => [z.id, z.name]),
    );
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'items_zone_updated',
      targetType: 'item',
      detail: {
        items: changed.map((r) => ({ id: r.id, name: r.name, from: r.zoneId, to: want.get(r.id) })),
        summary: `项目所在区域：${changed.map((r) => `${r.name} → ${want.get(r.id) ? zoneNames.get(want.get(r.id)!) : '不推导'}`).join('；')}`,
      },
      ip: ctx.ip,
    });
  });
}

// ───────────────────────── 自检（cli check） ─────────────────────────

export async function locationChecks(db: Db): Promise<{ label: string; ok: boolean; detail: string }[]> {
  // ① 当前位置 = 这个人最后一条生效的事件（状态、地方都一致）。「最后」按生效的先后（事件编号）：同一个人的事件都在
  //   锁着他当前位置一行时写入，编号就是生效的先后；离开、离店总是生效，事件时刻可能早于前一条（设备时钟略快、
  //   结账的时刻在并发的刷卡之前取的），不能按时刻排（Codex 复审）
  const lastDiff = await db<{ ref: string }[]>`
    WITH last AS (
      SELECT DISTINCT ON (coalesce(visit_id, 0), coalesce(technician_id, 0)) id, visit_id, technician_id, kind, floor_id, zone_id, space_id
      FROM location_events WHERE applied ORDER BY coalesce(visit_id, 0), coalesce(technician_id, 0), id DESC
    )
    SELECT coalesce('来访 ' || c.visit_id, '技师 ' || c.technician_id) AS ref
    FROM current_locations c
    LEFT JOIN last l ON (l.visit_id = c.visit_id OR l.technician_id = c.technician_id)
    WHERE (c.state = 'none') <> (l.id IS NULL)
       OR (l.id IS NOT NULL AND (c.last_event_id IS DISTINCT FROM l.id OR c.state IS DISTINCT FROM l.kind
           OR (c.state = 'at' AND (c.floor_id, c.zone_id, c.space_id) IS DISTINCT FROM (l.floor_id, l.zone_id, l.space_id))))
    LIMIT 5`;
  // ② 每人最多一段没结束的轨迹（唯一索引兜底），在某处的人那一段就是当前位置记的那段、地方一致；不在某处的人没有没结束的段
  const trackDiff = await db<{ ref: string }[]>`
    SELECT coalesce('来访 ' || c.visit_id, '技师 ' || c.technician_id) AS ref
    FROM current_locations c
    LEFT JOIN location_tracks t ON t.left_at IS NULL AND (t.visit_id = c.visit_id OR t.technician_id = c.technician_id)
    WHERE (c.state = 'at') <> (t.id IS NOT NULL)
       OR (t.id IS NOT NULL AND (t.id <> c.track_id OR (t.floor_id, t.zone_id, t.space_id) IS DISTINCT FROM (c.floor_id, c.zone_id, c.space_id)))
    UNION ALL
    SELECT coalesce('来访 ' || t.visit_id, '技师 ' || t.technician_id) FROM location_tracks t
    WHERE t.left_at IS NULL AND NOT EXISTS (SELECT 1 FROM current_locations c WHERE c.track_id = t.id)
    LIMIT 5`;
  // ③ 离店的客人、下了牌的技师没有当前位置（下牌之后又刷卡的照样记，只看下牌那一刻之前的位置有没有清掉）
  const goneDiff = await db<{ ref: string }[]>`
    SELECT v.visit_no AS ref FROM current_locations c JOIN visits v ON v.id = c.visit_id WHERE c.state = 'at' AND v.status <> 'open'
    UNION ALL
    SELECT '技师 ' || t.tech_no FROM current_locations c JOIN technicians t ON t.id = c.technician_id
    JOIN technician_status ts ON ts.technician_id = t.id
    WHERE c.state = 'at' AND ts.state = 'off' AND c.last_at < ts.updated_at
    LIMIT 5`;
  const [stats] = await db<{ events: number; located: number; tracks: number }[]>`
    SELECT (SELECT count(*) FROM location_events)::int AS events,
           (SELECT count(*) FROM current_locations c JOIN visits v ON v.id = c.visit_id WHERE c.state = 'at' AND v.status = 'open')::int AS located,
           (SELECT count(*) FROM location_tracks)::int AS tracks`;
  const refs = (d: { ref: string }[]) => d.map((x) => x.ref).join('、');
  return [
    {
      label: '实时位置：当前位置与最后一条位置事件一致',
      ok: lastDiff.length === 0,
      detail: lastDiff.length ? `${lastDiff.length} 人的当前位置与最后一条事件不符（如 ${refs(lastDiff)}）` : `位置事件 ${stats!.events} 条，当前位置都与各人最后一条生效的事件一致`,
    },
    {
      label: '实时位置：轨迹段连续、与当前位置一致',
      ok: trackDiff.length === 0,
      detail: trackDiff.length ? `${trackDiff.length} 处轨迹段与当前位置不符（如 ${refs(trackDiff)}）` : `轨迹段 ${stats!.tracks} 段，每人最多一段没结束，且就是当前位置那一段`,
    },
    {
      label: '实时位置：离店的客人、下了牌的技师没有当前位置',
      ok: goneDiff.length === 0,
      detail: goneDiff.length
        ? `${goneDiff.length} 位已离店的客人或下了牌的技师还记着位置（如 ${refs(goneDiff)}）`
        : `在店、有位置的客人 ${stats!.located} 位；离店的客人、下了牌的技师都没有当前位置`,
    },
  ];
}

// ───────────────────────── 路由 ─────────────────────────

export function registerLocationRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  // 后台：与空间台账同一组权限（店主、店总）
  const admin = guardAny('settings.manage', 'catalog.manage');

  app.get('/api/locations/current', { preHandler: guard('location.view') }, async () => currentLocations(sql, deps));
  app.get('/api/locations/tracks', { preHandler: guard('location.view') }, async (req) => locationTrack(sql, deps, req.query ?? {}));
  app.post('/api/locations/report', { preHandler: guard('location.report') }, async (req) => reportLocation(deps, req.body, ctxOf(req)));

  app.get('/api/admin/locations', { preHandler: admin }, async () => locationAdmin(sql));
  app.put('/api/admin/locations/rules', { preHandler: admin }, async (req) => {
    await saveRules(deps, req.body, ctxOf(req));
    return locationAdmin(sql);
  });
  app.post('/api/admin/locations/readers', { preHandler: admin }, async (req, reply) => {
    await createReader(deps, req.body, ctxOf(req));
    reply.status(201);
    return locationAdmin(sql);
  });
  app.put('/api/admin/locations/readers/:id', { preHandler: admin }, async (req) => {
    await updateReader(deps, parse(idParam, req.params).id, req.body, ctxOf(req));
    return locationAdmin(sql);
  });
  app.put('/api/admin/locations/items', { preHandler: admin }, async (req) => {
    await saveItemZones(deps, req.body, ctxOf(req));
    return locationAdmin(sql);
  });
}

