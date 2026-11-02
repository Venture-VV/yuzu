// 钟房（S6 第二步，v0.7.1）：技师上牌与轮钟队列、派钟、上钟 / 下钟计时、加钟、退钟与取消、钟房日志。
//
// 钱只在账单明细里：派钟、加钟都走前台挂账（frontdesk/bills.ts 的 postCharges，同一个事务里建钟单），退钟、取消作废明细。
// 钟单（technician_sessions）只记钟数、计划时长与状态；技师在钟上还是空闲由钟单推出来，客人离店后他的钟单不再占着他。
//
// 并发：所有改排位的操作先拿同一把「技师队列」咨询锁，再锁钟单与技师状态行；挂账、作废时排在「来访 → 账单 → 明细」之后
// （前台的加锁顺序：手牌 → 同行组 → 来访 → 账单 → 钟单与技师状态 → 会员），不会反向加锁。
// 服务的房间（v0.7.16 房态图）：派钟在技师队列之后、建钟单之前给房间（空间台账的一行）加共享锁；换房间只锁钟单一行、再给房间加共享锁。
// 空间台账停用空间、改业态时锁空间一行（排他）再查里面还没结束的钟单，不锁钟单，不会反向加锁。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { canServe, type CallType } from '@shared/technicians';
import { ZONE_LABELS } from '@shared/frontdesk';
import {
  DEFAULT_CLOCKROOM_RULES,
  EVENT_KIND_LABELS,
  type BoardSession,
  type BoardTechnician,
  type ClockEvent,
  type ClockEventKind,
  type ClockroomBoard,
  type ClockroomRules,
  type TechState,
} from '@shared/clockroom';
import { ISO_DATE } from '@shared/business-date';
import type { ClockSpace } from '@shared/floormap';
import { isTechnicianBusinessType, spaceLabel, TECHNICIAN_BUSINESS_TYPES } from '@shared/spaces';
import type { Db, Tx } from '../db';
import { guard } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Actor, Deps, OpContext } from '../lib/context';
import { conflict, notFound, unprocessable } from '../lib/errors';
import { idParam, parse, positiveCents } from '../lib/validate';
import { assertCanFix, assertOpen, businessDate, loadFrontdeskRules, lockVisits, nextDocNo, setTxTimeouts } from './frontdesk/common';
import { loadTechnicianRules, loadTechnicians } from './technicians';
import { locateSession, locateSessionEnd, locateSignIn, locateSignOut } from './locations';

export async function loadClockroomRules(db: Db): Promise<ClockroomRules> {
  const [row] = await db<{ value: Partial<ClockroomRules> }[]>`SELECT value FROM settings WHERE key = 'clockroom_rules'`;
  return { ...DEFAULT_CLOCKROOM_RULES, ...(row?.value ?? {}) };
}

/** 改排位、派钟、上下钟都先拿这把锁：轮钟队列是全店共用的，按先后串行 */
export const lockQueue = (tx: Tx) => tx`SELECT pg_advisory_xact_lock(hashtext('technician_queue'))`;

interface Status {
  state: TechState;
  queueKey: Date | null;
  rejectStreak: number;
}

/** 今天的上牌状态；换了营业日没有重新上牌的按「未上牌」 */
async function statusMap(db: Db, today: string): Promise<Map<number, Status>> {
  const rows = await db<{ technicianId: number; businessDate: string; state: TechState; queueKey: string; rejectStreak: number }[]>`
    SELECT technician_id, business_date::text AS business_date, state, queue_key, reject_streak FROM technician_status`;
  return new Map(
    rows.map((r) => [
      r.technicianId,
      r.businessDate === today ? { state: r.state, queueKey: new Date(r.queueKey), rejectStreak: r.rejectStreak } : { state: 'off' as const, queueKey: null, rejectStreak: 0 },
    ]),
  );
}

const offStatus: Status = { state: 'off', queueKey: null, rejectStreak: 0 };

async function writeStatus(tx: Tx, technicianId: number, today: string, s: Status, staffId: number, at: Date) {
  await tx`
    INSERT INTO technician_status (technician_id, business_date, state, queue_key, reject_streak, updated_at, updated_by)
    VALUES (${technicianId}, ${today}, ${s.state}, ${s.queueKey ?? at}, ${s.rejectStreak}, ${at}, ${staffId})
    ON CONFLICT (technician_id) DO UPDATE SET business_date = EXCLUDED.business_date, state = EXCLUDED.state, queue_key = EXCLUDED.queue_key,
      reject_streak = EXCLUDED.reject_streak, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`;
}

async function logEvent(
  tx: Tx,
  e: { technicianId: number | null; sessionId?: number | null; kind: ClockEventKind; detail?: Record<string, unknown>; staffId: number; businessDate: string; at: Date },
) {
  await tx`
    INSERT INTO technician_events (technician_id, session_id, kind, detail, business_date, staff_id, created_at)
    VALUES (${e.technicianId}, ${e.sessionId ?? null}, ${e.kind}, ${tx.json((e.detail ?? {}) as never)}, ${e.businessDate}, ${e.staffId}, ${e.at})`;
}

/** 在钟上或已派了钟（客人还在店）的钟单：技师编号 → 钟单 */
async function activeSessions(db: Db) {
  return db<{ id: number; technicianId: number; status: 'waiting' | 'serving'; callType: CallType; visitId: number }[]>`
    SELECT s.id, s.technician_id, s.status, s.call_type, s.visit_id
    FROM technician_sessions s JOIN visits v ON v.id = s.visit_id
    WHERE s.status IN ('waiting', 'serving') AND v.status = 'open'
    ORDER BY s.id`;
}

/** 在岗技师按排位排好：queue_key 越早越靠前，同一时刻按技师编号 */
function queueOrder(statuses: Map<number, Status>) {
  return [...statuses]
    .filter(([, s]) => s.state === 'on' && s.queueKey)
    .sort(([a, x], [b, y]) => x.queueKey!.getTime() - y.queueKey!.getTime() || a - b)
    .map(([id]) => id);
}

// ───────────────────────── 挂账时建钟单（frontdesk/bills.ts 调用） ─────────────────────────

export interface SessionPostOptions {
  /** 加钟：明细挂到这张上钟中的钟单 */
  extendId?: number;
  /** 钟房派钟：立即上钟；轮钟不派给第一位时的原因；服务的房间（v0.7.16，可不选） */
  dispatch?: { startNow: boolean; skipReason?: string; spaceId?: number };
  /** 按实际时间补录的纸质单：钟单直接记为已下钟，不动排位 */
  backfill?: boolean;
}

export interface SessionLine {
  itemId: number;
  quantity: number;
  technicianId: number;
  callType: CallType;
}

interface ServiceSpace {
  id: number;
  code: string;
  displayName: string;
}

/**
 * 服务的房间（v0.7.16）：空间台账里在用、可售的技师服务类空间。加共享锁：与空间台账停用空间、改业态（排他锁）串行，
 * 停用时就看得到刚派进这间的钟单。房间满了不拦（容量只是参考，待确认），选房间时页面上显示占用。
 */
export async function lockServiceSpace(tx: Tx, spaceId: number): Promise<ServiceSpace> {
  const [sp] = await tx<(ServiceSpace & { businessType: string; active: boolean; sellable: boolean })[]>`
    SELECT id, code, display_name, business_type, active, sellable FROM spaces WHERE id = ${spaceId} FOR SHARE`;
  if (!sp) throw notFound('房间不存在，请刷新后重新选择');
  const name = spaceLabel(sp.code, sp.displayName);
  if (!sp.active) throw conflict('SPACE_INACTIVE', `房间 ${name} 已停用，请换一间`);
  if (!isTechnicianBusinessType(sp.businessType)) {
    throw unprocessable('SPACE_NOT_SERVICE', `${name} 是「${sp.businessType}」，不是技师服务的房间（${TECHNICIAN_BUSINESS_TYPES.join('、')}），请换一间`);
  }
  if (!sp.sellable) throw conflict('SPACE_NOT_SELLABLE', `房间 ${name} 在空间台账里不可售，请换一间`);
  return { id: sp.id, code: sp.code, displayName: sp.displayName };
}

/**
 * 在挂账的事务里为每条技师明细建钟单（或加到正在上钟的钟单），返回各条明细的钟单编号。
 * 调用前已锁好来访与账单；这里再拿技师队列锁。
 */
export async function attachSessions(
  tx: Tx,
  deps: Deps,
  args: { visitId: number; tagCode: string; lines: SessionLine[]; date: string; at: Date; actor: Actor; options?: SessionPostOptions },
): Promise<number[]> {
  if (args.lines.length === 0) return [];
  const { at, actor, date, options = {} } = args;
  await lockQueue(tx);
  const space = options.dispatch?.spaceId !== undefined && options.extendId === undefined && !options.backfill ? await lockServiceSpace(tx, options.dispatch.spaceId) : null;
  const rules = await loadClockroomRules(tx);
  const today = await businessDate(tx, deps, at);
  const durations = new Map(
    (await tx<{ id: number; durationMinutes: number | null; name: string }[]>`
      SELECT id, duration_minutes, name FROM service_items WHERE id IN ${tx([...new Set(args.lines.map((l) => l.itemId))])}`).map((r) => [r.id, r]),
  );
  const perClock = (itemId: number) => durations.get(itemId)?.durationMinutes ?? rules.defaultMinutes;
  const ids: number[] = [];

  if (options.extendId !== undefined) {
    const [s] = await tx<{ id: number; sessionNo: string; technicianId: number; visitId: number; itemId: number; status: string }[]>`
      SELECT id, session_no, technician_id, visit_id, item_id, status FROM technician_sessions WHERE id = ${options.extendId} FOR UPDATE`;
    if (!s) throw notFound('钟单不存在');
    for (const l of args.lines) {
      if (s.status !== 'serving') throw conflict('SESSION_NOT_SERVING', `钟单 ${s.sessionNo} 不在上钟中，不能加钟`);
      if (s.visitId !== args.visitId || s.technicianId !== l.technicianId || s.itemId !== l.itemId) {
        throw conflict('SESSION_MISMATCH', '加钟的技师、项目或客人与钟单不一致，请刷新后重试');
      }
      await tx`UPDATE technician_sessions SET clocks = clocks + ${l.quantity}, minutes = minutes + ${perClock(l.itemId) * l.quantity} WHERE id = ${s.id}`;
      await logEvent(tx, { technicianId: s.technicianId, sessionId: s.id, kind: 'extend', detail: { clocks: l.quantity, callType: l.callType }, staffId: actor.id, businessDate: today, at });
      ids.push(s.id);
    }
    return ids;
  }

  const statuses = await statusMap(tx, today);
  const active = await activeSessions(tx);
  const busyIds = new Set(active.map((s) => s.technicianId));
  const techs = await loadTechnicians(tx);
  for (const l of args.lines) {
    const t = techs.get(l.technicianId)!;
    const status = statuses.get(t.id) ?? offStatus;
    const minutes = perClock(l.itemId) * l.quantity;
    const item = durations.get(l.itemId)!;

    if (options.backfill) {
      // 补录的纸质单：服务早已做完，直接记为已下钟，不动排位
      const sessionNo = await nextDocNo(tx, 'technician_session', 'ZD', date);
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO technician_sessions (session_no, technician_id, visit_id, item_id, call_type, clocks, minutes, status, business_date,
                                         created_by, created_at, started_by, started_at, ended_by, ended_at)
        VALUES (${sessionNo}, ${t.id}, ${args.visitId}, ${l.itemId}, ${l.callType}, ${l.quantity}, ${minutes}, 'done', ${date},
                ${actor.id}, ${at}, ${actor.id}, ${at}, ${actor.id}, ${new Date(Math.min(at.getTime() + minutes * 60_000, Date.now()))})
        RETURNING id`;
      await logEvent(tx, { technicianId: t.id, sessionId: row!.id, kind: 'dispatch', detail: { item: item.name, clocks: l.quantity, callType: l.callType, tag: args.tagCode, backfill: true }, staffId: actor.id, businessDate: today, at: new Date() });
      ids.push(row!.id);
      continue;
    }

    let start = false;
    if (options.dispatch) {
      if (status.state === 'off') throw unprocessable('TECHNICIAN_OFF', `${t.techNo} 号 ${t.name}今天还没上牌，请先上牌`);
      if (l.callType === 'rotation') {
        if (status.state !== 'on') throw unprocessable('TECHNICIAN_RESTING', `${t.techNo} 号 ${t.name}在休息，轮钟只派给在岗的技师`);
        if (busyIds.has(t.id)) throw conflict('TECHNICIAN_BUSY', `${t.techNo} 号 ${t.name}正在钟上，轮钟请派给空闲的技师`);
        const techRules = await loadTechnicianRules(tx);
        const prices = await tx<{ tier: 'standard' | 'professional' | 'premium' }[]>`SELECT tier FROM service_item_prices WHERE item_id = ${l.itemId}`;
        const [cat] = await tx<{ category: string }[]>`SELECT category FROM service_items WHERE id = ${l.itemId}`;
        const itemShape = { category: cat!.category, prices: prices.length ? prices : [{ tier: 'standard' as const }] };
        const eligible = queueOrder(statuses).filter((id) => !busyIds.has(id) && !canServe(techs.get(id)!, itemShape, techRules.tierByGrade));
        const ahead = eligible.slice(0, Math.max(0, eligible.indexOf(t.id)));
        if (ahead.length > 0) {
          const first = techs.get(ahead[0]!)!;
          if (rules.skipNeedsReason && !options.dispatch.skipReason?.trim()) {
            throw unprocessable('SKIP_REASON_REQUIRED', `轮钟应派给排在前面的 ${first.techNo} 号 ${first.name}；要跳过请写原因`);
          }
          for (const id of ahead) {
            const s = techs.get(id)!;
            await logEvent(tx, {
              technicianId: id,
              kind: 'skip',
              detail: { reason: options.dispatch.skipReason?.trim() ?? '', to: `${t.techNo} 号 ${t.name}`, tag: args.tagCode, techNo: s.techNo },
              staffId: actor.id,
              businessDate: today,
              at,
            });
          }
        }
      }
      start = options.dispatch.startNow && !busyIds.has(t.id);
    }

    // 排位：轮钟派钟时排到队尾（默认）；点钟按规则不动牌 / 算一轮；「点钟期间轮到就排尾」在派轮钟时处理排在前面、正在上点钟的技师
    const before = status.queueKey;
    if (status.state === 'on') {
      const toEnd = (l.callType === 'rotation' && rules.afterRotation === 'dispatch') || (l.callType === 'designated' && rules.afterDesignated === 'end');
      if (toEnd) statuses.set(t.id, { ...status, queueKey: at });
      if (toEnd) await writeStatus(tx, t.id, today, { ...status, queueKey: at }, actor.id, at);
      if (l.callType === 'rotation' && rules.afterDesignated === 'passed' && before) {
        const designatedBusy = new Set(active.filter((s) => s.callType === 'designated').map((s) => s.technicianId));
        for (const id of queueOrder(statuses)) {
          const s = statuses.get(id)!;
          if (id !== t.id && designatedBusy.has(id) && s.queueKey! < before) {
            const moved = { ...s, queueKey: new Date(at.getTime() + 1) };
            statuses.set(id, moved);
            await writeStatus(tx, id, today, moved, actor.id, at);
            await logEvent(tx, { technicianId: id, kind: 'queue', detail: { reason: '点钟期间轮到，排到队尾' }, staffId: actor.id, businessDate: today, at });
          }
        }
      }
    }

    // 客人已离店、还记着在钟上的旧钟单先自动下钟，再上这一钟
    if (start) await closeStale(tx, deps, t.id, actor, at);
    const sessionNo = await nextDocNo(tx, 'technician_session', 'ZD', date);
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO technician_sessions (session_no, technician_id, visit_id, item_id, call_type, clocks, minutes, status, business_date,
                                       queue_key_before, created_by, created_at, started_by, started_at, space_id)
      VALUES (${sessionNo}, ${t.id}, ${args.visitId}, ${l.itemId}, ${l.callType}, ${l.quantity}, ${minutes}, ${start ? 'serving' : 'waiting'}, ${date},
              ${before}, ${actor.id}, ${at}, ${start ? actor.id : null}, ${start ? at : null}, ${space?.id ?? null})
      RETURNING id`;
    await logEvent(tx, {
      technicianId: t.id,
      sessionId: row!.id,
      kind: 'dispatch',
      detail: {
        item: item.name,
        clocks: l.quantity,
        callType: l.callType,
        tag: args.tagCode,
        via: options.dispatch ? 'clockroom' : 'frontdesk',
        ...(space ? { room: spaceLabel(space.code, space.displayName) } : {}),
      },
      staffId: actor.id,
      businessDate: today,
      at,
    });
    if (start) await logEvent(tx, { technicianId: t.id, sessionId: row!.id, kind: 'start', staffId: actor.id, businessDate: today, at });
    busyIds.add(t.id);
    ids.push(row!.id);
  }
  return ids;
}

// ───────────────────────── 作废明细后同步钟单（前台作废、钟房退钟共用） ─────────────────────────

interface SessionRow {
  id: number;
  sessionNo: string;
  technicianId: number;
  visitId: number;
  itemId: number;
  callType: CallType;
  clocks: number;
  minutes: number;
  status: 'waiting' | 'serving' | 'done' | 'cancelled' | 'rejected';
  queueKeyBefore: string | null;
  startedAt: string | null;
  spaceId: number | null;
}

const lockSession = async (tx: Tx, id: number) =>
  (
    await tx<SessionRow[]>`
      SELECT id, session_no, technician_id, visit_id, item_id, call_type, clocks, minutes, status, queue_key_before, started_at, space_id
      FROM technician_sessions WHERE id = ${id} FOR UPDATE`
  )[0];

/**
 * 钟单的明细作废之后：还剩有效明细时按剩下的钟数改钟单；一条都不剩时钟单作废（没上钟为取消，上了钟为被退钟），
 * 技师按规则回到原位，连续被退钟到次数排到队尾。调用前已锁好来访、账单与明细，并已拿技师队列锁。
 */
export async function syncSessionAfterVoid(tx: Tx, deps: Deps, sessionId: number, reason: string, actor: Actor, at: Date) {
  const s = await lockSession(tx, sessionId);
  if (!s || (s.status !== 'waiting' && s.status !== 'serving')) return;
  const [left] = await tx<{ clocks: number }[]>`
    SELECT coalesce(sum(quantity), 0)::int AS clocks FROM bill_lines WHERE session_id = ${sessionId} AND status = 'active'`;
  const today = await businessDate(tx, deps, at);
  if (left!.clocks > 0) {
    const perClock = Math.max(1, Math.round(s.minutes / s.clocks));
    await tx`UPDATE technician_sessions SET clocks = ${left!.clocks}, minutes = ${perClock * left!.clocks} WHERE id = ${s.id}`;
    return;
  }
  const rejected = s.status === 'serving';
  await tx`
    UPDATE technician_sessions SET status = ${rejected ? 'rejected' : 'cancelled'}, ended_at = ${at}, ended_by = ${actor.id}, void_reason = ${reason}
    WHERE id = ${s.id}`;
  await logEvent(tx, { technicianId: s.technicianId, sessionId: s.id, kind: rejected ? 'reject' : 'cancel', detail: { reason }, staffId: actor.id, businessDate: today, at });
  // 实时位置（v0.7.17）：上了钟被退钟，技师回休息区（没设的离开那间房）；没上钟的取消不动
  if (rejected) await locateSessionEnd(tx, [{ id: s.id, technicianId: s.technicianId, spaceId: s.spaceId }], { at, staffId: actor.id });

  const rules = await loadClockroomRules(tx);
  const status = (await statusMap(tx, today)).get(s.technicianId) ?? offStatus;
  if (status.state === 'off') return;
  let next = { ...status };
  if (rules.rejectKeepsPlace && s.queueKeyBefore) next.queueKey = new Date(s.queueKeyBefore);
  if (rejected) {
    next.rejectStreak = status.rejectStreak + 1;
    if (rules.rejectEndAfter > 0 && next.rejectStreak >= rules.rejectEndAfter) {
      next = { ...next, queueKey: at, rejectStreak: 0 };
      await logEvent(tx, { technicianId: s.technicianId, kind: 'queue', detail: { reason: `连续被退钟 ${rules.rejectEndAfter} 次，排到队尾` }, staffId: actor.id, businessDate: today, at });
    }
  }
  await writeStatus(tx, s.technicianId, today, next, actor.id, at);
}

// ───────────────────────── 上钟、下钟、退钟 / 取消 ─────────────────────────

/** 客人已离店、却还记着在钟上的钟单：按离店时刻自动下钟（钟房忘了点下钟时，不再占着技师） */
async function closeStale(tx: Tx, deps: Deps, technicianId: number, actor: Actor, at: Date) {
  const stale = await tx<{ id: number; closedAt: string | null }[]>`
    SELECT s.id, v.closed_at FROM technician_sessions s JOIN visits v ON v.id = s.visit_id
    WHERE s.technician_id = ${technicianId} AND s.status = 'serving' AND v.status <> 'open' FOR UPDATE OF s`;
  const today = await businessDate(tx, deps, at);
  for (const s of stale) {
    const end = s.closedAt ? new Date(s.closedAt) : at;
    await tx`UPDATE technician_sessions SET status = 'done', ended_at = ${end}, ended_by = ${actor.id} WHERE id = ${s.id}`;
    await logEvent(tx, { technicianId, sessionId: s.id, kind: 'finish', detail: { auto: '客人已离店' }, staffId: actor.id, businessDate: today, at });
  }
}

export async function startSession(deps: Deps, id: number, ctx: OpContext) {
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const at = ctx.at ?? new Date();
    await lockQueue(tx);
    const s = await lockSession(tx, id);
    if (!s) throw notFound('钟单不存在');
    if (s.status !== 'waiting') throw conflict('SESSION_NOT_WAITING', `钟单 ${s.sessionNo} 已${s.status === 'serving' ? '上钟' : '结束'}，请刷新`);
    const [v] = await tx<{ status: string; visitNo: string }[]>`SELECT status, visit_no FROM visits WHERE id = ${s.visitId}`;
    if (v!.status !== 'open') throw conflict('VISIT_CLOSED', `来访 ${v!.visitNo} 已离店，不能再上钟`);
    await closeStale(tx, deps, s.technicianId, ctx.actor, at);
    const [other] = await tx<{ sessionNo: string }[]>`
      SELECT session_no FROM technician_sessions WHERE technician_id = ${s.technicianId} AND status = 'serving' AND id <> ${s.id}`;
    if (other) throw conflict('TECHNICIAN_BUSY', `这位技师还在钟单 ${other.sessionNo} 上，请先下钟`);
    await tx`UPDATE technician_sessions SET status = 'serving', started_at = ${at}, started_by = ${ctx.actor.id} WHERE id = ${s.id}`;
    await logEvent(tx, { technicianId: s.technicianId, sessionId: s.id, kind: 'start', staffId: ctx.actor.id, businessDate: await businessDate(tx, deps, at), at });
    // 实时位置（v0.7.17）：技师与客人在钟单记的房间
    await locateSession(tx, s.id, 'session_start', { at, staffId: ctx.actor.id });
  });
  return clockroomBoard(deps.sql, deps);
}

/**
 * 下钟（钟单已锁、已拿技师队列锁）：记实际时长；轮钟按规则排到队尾，连续被退钟的次数清零。
 * auto 为自动下钟的原因；还没上钟的（只有结账时一起收尾才会）上钟、下钟都记在这一刻，实际 0 分钟。
 */
async function finishLocked(tx: Tx, deps: Deps, s: SessionRow, actor: Actor, at: Date, auto?: string, locate = true) {
  const start = s.startedAt ? new Date(s.startedAt) : at;
  const end = new Date(Math.max(at.getTime(), start.getTime()));
  await tx`
    UPDATE technician_sessions SET status = 'done', started_at = ${start}, started_by = coalesce(started_by, ${actor.id}), ended_at = ${end}, ended_by = ${actor.id}
    WHERE id = ${s.id}`;
  const today = await businessDate(tx, deps, at);
  const actual = Math.round((end.getTime() - start.getTime()) / 60_000);
  await logEvent(tx, {
    technicianId: s.technicianId,
    sessionId: s.id,
    kind: 'finish',
    detail: { minutes: actual, planned: s.minutes, ...(auto ? { auto } : {}) },
    staffId: actor.id,
    businessDate: today,
    at,
  });
  // 实时位置（v0.7.17）：在钟上的下钟，技师回休息区（没设的离开那间房）；还没上钟的（结账时一起收尾）不动
  if (locate && s.status === 'serving') await locateSessionEnd(tx, [{ id: s.id, technicianId: s.technicianId, spaceId: s.spaceId }], { at, staffId: actor.id });
  const rules = await loadClockroomRules(tx);
  const status = (await statusMap(tx, today)).get(s.technicianId) ?? offStatus;
  if (status.state !== 'off') {
    const toEnd = s.callType === 'rotation' && rules.afterRotation === 'finish';
    await writeStatus(tx, s.technicianId, today, { ...status, queueKey: toEnd ? at : status.queueKey, rejectStreak: 0 }, actor.id, at);
  }
}

export async function finishSession(deps: Deps, id: number, ctx: OpContext) {
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const at = ctx.at ?? new Date();
    await lockQueue(tx);
    const s = await lockSession(tx, id);
    if (!s) throw notFound('钟单不存在');
    if (s.status !== 'serving') throw conflict('SESSION_NOT_SERVING', `钟单 ${s.sessionNo} 不在上钟中，请刷新`);
    await finishLocked(tx, deps, s, ctx.actor, at);
  });
  return clockroomBoard(deps.sql, deps);
}

/** 这几位客人还没结束的钟单（结账前核对时列出来：结账时一起收尾） */
export async function openSessionsOf(db: Db, visitIds: number[]) {
  return db<{ sessionNo: string; tagCode: string; techNo: string; techName: string; itemName: string; clocks: number; status: 'waiting' | 'serving' }[]>`
    SELECT s.session_no, h.code AS tag_code, t.tech_no, t.name AS tech_name, i.name AS item_name, s.clocks, s.status
    FROM technician_sessions s JOIN technicians t ON t.id = s.technician_id JOIN service_items i ON i.id = s.item_id
    JOIN visits v ON v.id = s.visit_id JOIN hand_tags h ON h.id = v.tag_id
    WHERE s.visit_id IN ${db(visitIds)} AND s.status IN ('waiting', 'serving') ORDER BY s.id`;
}

/**
 * 结账（frontdesk/checkout.ts 调用，来访与账单已锁）：这几位客人还没结束的钟单一起收尾——在钟上的按结账时刻下钟；
 * 还没上钟的按已做完记（明细已经结进账单；客人没做的应在结账前取消派钟，结账核对里会列出来提醒）。
 * 客人离店后不再占着技师，反结账重开账单也不会再冒出来。没有钟单时不拿技师队列锁，平时结账不受影响。
 */
export async function settleSessionsAtCheckout(tx: Tx, deps: Deps, visitIds: number[], actor: Actor, at: Date): Promise<{ id: number; technicianId: number; spaceId: number | null }[]> {
  const [any] = await tx<{ id: number }[]>`SELECT id FROM technician_sessions WHERE visit_id IN ${tx(visitIds)} AND status IN ('waiting', 'serving') LIMIT 1`;
  if (!any) return [];
  await lockQueue(tx);
  const rows = await tx<SessionRow[]>`
    SELECT id, session_no, technician_id, visit_id, item_id, call_type, clocks, minutes, status, queue_key_before, started_at, space_id
    FROM technician_sessions WHERE visit_id IN ${tx(visitIds)} AND status IN ('waiting', 'serving') ORDER BY id FOR UPDATE`;
  // 实时位置在结账最后一起记（先客人离店、再技师回休息区，按固定顺序锁当前位置）：这里只返回在钟上的
  for (const r of rows) await finishLocked(tx, deps, r, actor, at, r.status === 'waiting' ? '结账时还没上钟，按已做完记' : '结账离店', false);
  return rows.filter((r) => r.status === 'serving').map((r) => ({ id: r.id, technicianId: r.technicianId, spaceId: r.spaceId }));
}

export const VoidSessionInput = z.object({
  reason: z.string().trim().min(2, '请填写原因（至少 2 个字）').max(180, '原因最多 180 字'),
});

/** 退钟（上了钟、客人不满意换人）/ 取消派钟（还没上钟）：作废这张钟单的全部明细，技师按规则回到原位 */
export async function voidSession(deps: Deps, id: number, raw: unknown, ctx: OpContext) {
  const { reason } = parse(VoidSessionInput, raw);
  const [peek] = await deps.sql<{ visitId: number }[]>`SELECT visit_id FROM technician_sessions WHERE id = ${id}`;
  if (!peek) throw notFound('钟单不存在');
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const at = ctx.at ?? new Date();
    // 来访 → 账单 → 明细 → 技师队列 → 钟单
    const visit = (await lockVisits(tx, [peek.visitId])).get(peek.visitId)!;
    assertOpen(visit);
    await tx`SELECT id FROM bills WHERE id = ${visit.billId} FOR UPDATE`;
    const [cur] = await tx<{ status: string; sessionNo: string }[]>`SELECT status, session_no FROM technician_sessions WHERE id = ${id}`;
    if (cur!.status !== 'waiting' && cur!.status !== 'serving') throw conflict('SESSION_CLOSED', `钟单 ${cur!.sessionNo} 已结束，不能再退钟`);
    const text = `${cur!.status === 'serving' ? '退钟' : '取消派钟'}：${reason}`;
    const lines = await tx<{ id: number; name: string; quantity: number; amount: number; postedBy: number; postedAt: string }[]>`
      SELECT id, name, quantity, amount, posted_by, posted_at FROM bill_lines WHERE session_id = ${id} AND status = 'active' ORDER BY id FOR UPDATE`;
    const rules = await loadFrontdeskRules(tx);
    for (const l of lines) assertCanFix(ctx.actor, l.postedBy, l.postedAt, rules, at, '这张钟单的挂账');
    for (const l of lines) {
      await tx`UPDATE bill_lines SET status = 'voided', void_reason = ${text}, voided_by = ${ctx.actor.id}, voided_at = ${at} WHERE id = ${l.id}`;
    }
    const total = lines.reduce((t, l) => t + l.amount, 0);
    if (lines.length) await tx`UPDATE bills SET amount_cents = amount_cents - ${total}, line_count = line_count - ${lines.length} WHERE id = ${visit.billId}`;
    await lockQueue(tx);
    await syncSessionAfterVoid(tx, deps, id, reason, ctx.actor, at);
    for (const l of lines) {
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'frontdesk_void',
        targetType: 'visit',
        targetId: visit.id,
        detail: { visitNo: visit.visitNo, lineId: l.id, name: l.name, quantity: l.quantity, amount: l.amount, reason: text },
        ip: ctx.ip,
        businessDate: await businessDate(tx, deps, at),
      });
    }
  });
  return clockroomBoard(deps.sql, deps);
}

// ───────────────────────── 换房间（v0.7.16） ─────────────────────────

export const SessionSpaceInput = z.object({
  /** 换到的房间；null 为清掉房间 */
  spaceId: z.number().int().positive().nullable(),
  /**
   * 页面上看到的房间版本号（每换一次加 1）：对不上就拒绝，不悄悄覆盖。只比房间会漏掉「A 换成 C 又换回 A」，
   * 超时后迟到的「A → B」旧请求就会盖掉后来的修改；版本号只增不减，中间有过任何修改都对不上
   */
  expectedVersion: z.number().int().min(0),
});

/** 派钟后改服务的房间、补选房间（前台挂账建的钟单没有房间）、清掉房间：只锁钟单一行，再给新房间加共享锁 */
export async function setSessionSpace(deps: Deps, id: number, raw: unknown, ctx: OpContext) {
  const { spaceId, expectedVersion } = parse(SessionSpaceInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const at = ctx.at ?? new Date();
    const [s] = await tx<{ id: number; sessionNo: string; technicianId: number; status: string; spaceId: number | null; spaceVersion: number; visitStatus: string }[]>`
      SELECT s.id, s.session_no, s.technician_id, s.status, s.space_id, s.space_version, v.status AS visit_status
      FROM technician_sessions s JOIN visits v ON v.id = s.visit_id WHERE s.id = ${id} FOR UPDATE OF s`;
    if (!s) throw notFound('钟单不存在');
    if (s.status !== 'waiting' && s.status !== 'serving') throw conflict('SESSION_CLOSED', `钟单 ${s.sessionNo} 已结束，不能再换房间`);
    if (s.visitStatus !== 'open') throw conflict('VISIT_CLOSED', `钟单 ${s.sessionNo} 的客人已离店，不能再换房间`);
    // 已经是这间：重发、两个人同时选了同一间都照常返回（不改、不记日志）
    if (s.spaceId === spaceId) return;
    if (s.spaceVersion !== expectedVersion) throw conflict('SESSION_SPACE_STALE', `钟单 ${s.sessionNo} 的房间刚被改过，请刷新后再选`);
    const to = spaceId === null ? null : await lockServiceSpace(tx, spaceId);
    const [from] = s.spaceId === null ? [] : await tx<{ code: string; displayName: string }[]>`SELECT code, display_name FROM spaces WHERE id = ${s.spaceId}`;
    await tx`UPDATE technician_sessions SET space_id = ${spaceId}, space_version = space_version + 1 WHERE id = ${s.id}`;
    // 实时位置（v0.7.17）：在钟上换房间，技师与客人到新房间；还没上钟的、清掉房间的不动
    if (s.status === 'serving' && spaceId !== null) await locateSession(tx, s.id, 'session_room', { at, staffId: ctx.actor.id });
    await logEvent(tx, {
      technicianId: s.technicianId,
      sessionId: s.id,
      kind: 'room',
      detail: { from: from ? spaceLabel(from.code, from.displayName) : null, to: to ? spaceLabel(to.code, to.displayName) : null },
      staffId: ctx.actor.id,
      businessDate: await businessDate(tx, deps, at),
      at,
    });
  });
  return clockroomBoard(deps.sql, deps);
}

/** 派钟、换房间时可选的技师房：在用、可售的技师服务类空间，带现在的占用（客人在店、还没结束的钟单） */
export async function clockSpaces(db: Db): Promise<ClockSpace[]> {
  return db<ClockSpace[]>`
    SELECT sp.id, sp.code, sp.display_name, f.code AS floor_code, z.name AS zone_name, sp.business_type, sp.capacity,
           count(s.id) FILTER (WHERE s.status = 'serving')::int AS serving,
           count(s.id) FILTER (WHERE s.status = 'waiting')::int AS waiting
    FROM spaces sp JOIN floors f ON f.id = sp.floor_id LEFT JOIN zones z ON z.id = sp.zone_id
    LEFT JOIN technician_sessions s ON s.space_id = sp.id AND s.status IN ('waiting', 'serving')
      AND EXISTS (SELECT 1 FROM visits v WHERE v.id = s.visit_id AND v.status = 'open')
    WHERE sp.active AND sp.sellable AND sp.business_type IN ${db([...TECHNICIAN_BUSINESS_TYPES])}
    GROUP BY sp.id, f.code, f.sort_order, z.name
    ORDER BY f.sort_order, f.code, sp.code`;
}

// ───────────────────────── 上牌、休息、下牌、排到队尾 ─────────────────────────

export const StateInput = z.object({
  action: z.enum(['sign_in', 'rest', 'back', 'sign_out', 'to_end'], '操作不正确'),
  reason: z.string().trim().max(100, '原因最多 100 字').optional(),
});

export async function changeState(deps: Deps, technicianId: number, raw: unknown, ctx: OpContext) {
  const { action, reason } = parse(StateInput, raw);
  if (action === 'to_end' && (reason ?? '').length < 2) throw unprocessable('REASON_REQUIRED', '排到队尾请写原因（例如：叫了不在岗、拒钟）');
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const at = ctx.at ?? new Date();
    await lockQueue(tx);
    const [t] = await tx<{ id: number; techNo: string; name: string; active: boolean }[]>`SELECT id, tech_no, name, active FROM technicians WHERE id = ${technicianId}`;
    if (!t) throw notFound('技师不存在');
    if (!t.active) throw unprocessable('TECHNICIAN_INACTIVE', `${t.techNo} 号 ${t.name}已停用`);
    const today = await businessDate(tx, deps, at);
    const rules = await loadClockroomRules(tx);
    const s = (await statusMap(tx, today)).get(t.id) ?? offStatus;
    let next: Status;
    switch (action) {
      case 'sign_in':
        if (s.state === 'on') return;
        // 当天休息后再上牌也按回牌处理
        next = { state: 'on', queueKey: s.state === 'rest' && !rules.backToEnd ? s.queueKey : at, rejectStreak: s.rejectStreak };
        break;
      case 'back':
        if (s.state !== 'rest') throw conflict('NOT_RESTING', `${t.techNo} 号 ${t.name}不在休息`);
        next = { state: 'on', queueKey: rules.backToEnd ? at : s.queueKey, rejectStreak: s.rejectStreak };
        break;
      case 'rest':
        if (s.state !== 'on') throw conflict('NOT_ON', `${t.techNo} 号 ${t.name}不在岗`);
        next = { ...s, state: 'rest' };
        break;
      case 'sign_out':
        if (s.state === 'off') return;
        next = { ...s, state: 'off' };
        break;
      case 'to_end':
        if (s.state !== 'on') throw conflict('NOT_ON', `${t.techNo} 号 ${t.name}不在岗`);
        next = { ...s, queueKey: at };
        break;
    }
    await writeStatus(tx, t.id, today, next, ctx.actor.id, at);
    await logEvent(tx, { technicianId: t.id, kind: action, detail: reason ? { reason } : {}, staffId: ctx.actor.id, businessDate: today, at });
    // 实时位置（v0.7.17）：上牌（没上牌的才算到店）在技师休息区；下牌离店
    if (action === 'sign_in' && s.state === 'off') await locateSignIn(tx, [t.id], { at, staffId: ctx.actor.id });
    if (action === 'sign_out') await locateSignOut(tx, t.id, { at, staffId: ctx.actor.id });
  });
  return clockroomBoard(deps.sql, deps);
}

/** 全部上牌：在职、今天还没上牌的技师按名册顺序上牌（已在岗、休息的不动） */
export async function signInAll(deps: Deps, ctx: OpContext) {
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const at = ctx.at ?? new Date();
    await lockQueue(tx);
    const today = await businessDate(tx, deps, at);
    const statuses = await statusMap(tx, today);
    let i = 0;
    const signed: number[] = [];
    for (const t of (await loadTechnicians(tx)).values()) {
      if (!t.active || (statuses.get(t.id)?.state ?? 'off') !== 'off') continue;
      const key = new Date(at.getTime() + i++);
      await writeStatus(tx, t.id, today, { state: 'on', queueKey: key, rejectStreak: 0 }, ctx.actor.id, at);
      await logEvent(tx, { technicianId: t.id, kind: 'sign_in', detail: { all: true }, staffId: ctx.actor.id, businessDate: today, at });
      signed.push(t.id);
    }
    await locateSignIn(tx, signed, { at, staffId: ctx.actor.id });
  });
  return clockroomBoard(deps.sql, deps);
}

// ───────────────────────── 看板与日志 ─────────────────────────

export async function clockroomBoard(db: Db, deps: Deps): Promise<ClockroomBoard> {
  const [now] = await db<{ now: string }[]>`SELECT now() AS now`;
  const at = new Date(now!.now);
  const today = await businessDate(db, deps, at);
  const rules = await loadClockroomRules(db);
  const techRules = await loadTechnicianRules(db);
  const statuses = await statusMap(db, today);
  const order = queueOrder(statuses);
  const techs = await loadTechnicians(db);
  const sessions = await db<
    (Omit<BoardSession, 'plannedEnd' | 'guest' | 'space'> & { memberName: string | null; guestLabel: string; spaceId: number | null; spaceCode: string | null; spaceName: string | null })[]
  >`
    SELECT s.id, s.session_no, s.technician_id, t.tech_no, t.name AS tech_name, s.visit_id, h.code AS tag_code, v.zone,
           m.name AS member_name, v.guest_label, s.item_id, i.name AS item_name, s.call_type, s.clocks, s.minutes, s.status, s.created_at, s.started_at,
           s.space_id, s.space_version, sp.code AS space_code, sp.display_name AS space_name
    FROM technician_sessions s JOIN technicians t ON t.id = s.technician_id JOIN visits v ON v.id = s.visit_id
    JOIN hand_tags h ON h.id = v.tag_id JOIN service_items i ON i.id = s.item_id LEFT JOIN members m ON m.id = v.member_id
    LEFT JOIN spaces sp ON sp.id = s.space_id
    WHERE s.status IN ('waiting', 'serving') AND v.status = 'open'
    ORDER BY (s.status = 'serving') DESC, coalesce(s.started_at, s.created_at), s.id`;
  const clocks = await db<{ technicianId: number; callType: CallType; clocks: number }[]>`
    SELECT technician_id, call_type, sum(quantity)::int AS clocks FROM bill_lines
    WHERE technician_id IS NOT NULL AND status = 'active' AND business_date = ${today} GROUP BY 1, 2`;
  const todayOf = (id: number) => clocks.filter((c) => c.technicianId === id).reduce((n, c) => n + c.clocks, 0);
  const board: BoardTechnician[] = [...techs.values()]
    .filter((t) => t.active || sessions.some((s) => s.technicianId === t.id))
    .map((t) => {
      const st = statuses.get(t.id) ?? offStatus;
      const mine = sessions.filter((s) => s.technicianId === t.id);
      const serving = mine.find((s) => s.status === 'serving');
      const first = serving ?? mine[0];
      return {
        ...t,
        state: st.state,
        position: st.state === 'on' ? order.indexOf(t.id) + 1 : null,
        busy: first ? { sessionId: first.id, status: first.status } : null,
        waiting: mine.filter((s) => s.status === 'waiting').length,
        todayClocks: todayOf(t.id),
        rejectStreak: st.rejectStreak,
      };
    });
  return {
    serverTime: at.toISOString(),
    businessDate: today,
    rules,
    techRules,
    technicians: board,
    sessions: sessions.map(({ memberName, guestLabel, spaceId, spaceCode, spaceName, ...s }) => ({
      ...s,
      space: spaceId !== null ? { id: spaceId, code: spaceCode!, displayName: spaceName! } : null,
      createdAt: new Date(s.createdAt).toISOString(),
      startedAt: s.startedAt ? new Date(s.startedAt).toISOString() : null,
      plannedEnd: s.startedAt ? new Date(new Date(s.startedAt).getTime() + s.minutes * 60_000).toISOString() : null,
      guest: memberName ?? (guestLabel || `${ZONE_LABELS[s.zone].title}散客`),
    })),
    today: {
      clocks: clocks.reduce((n, c) => n + c.clocks, 0),
      designated: clocks.filter((c) => c.callType === 'designated').reduce((n, c) => n + c.clocks, 0),
      rotation: clocks.filter((c) => c.callType === 'rotation').reduce((n, c) => n + c.clocks, 0),
    },
  };
}

const CALL = { designated: '点钟', rotation: '轮钟' } as const;

function eventText(kind: ClockEventKind, d: Record<string, unknown>): string {
  const s = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : '');
  switch (kind) {
    case 'dispatch':
      return `${s('tag')} ${s('item')} × ${d.clocks ?? 1}（${CALL[d.callType as CallType] ?? ''}）${s('room') ? `，房间 ${s('room')}` : ''}${d.via === 'frontdesk' ? '，前台挂账' : ''}${d.backfill ? '，补录纸质单' : ''}`;
    case 'room':
      return d.to ? `${d.from ? `房间 ${s('from')} → ` : '选房间 '}${s('to')}` : `清掉房间 ${s('from')}`;
    case 'skip':
      return `轮到时跳过，派给 ${s('to')}${s('reason') ? `：${s('reason')}` : ''}`;
    case 'extend':
      return `加钟 × ${d.clocks ?? 1}（${CALL[d.callType as CallType] ?? ''}）`;
    case 'finish':
      return `${d.auto ? `自动下钟（${s('auto')}），` : ''}实际 ${d.minutes ?? '?'} 分钟（计划 ${d.planned ?? '?'} 分钟）`;
    default:
      return s('reason');
  }
}

export async function clockEvents(db: Db, date: string): Promise<ClockEvent[]> {
  const rows = await db<{ id: number; createdAt: string; kind: ClockEventKind; techNo: string | null; techName: string | null; sessionNo: string | null; staffName: string; detail: Record<string, unknown> }[]>`
    SELECT e.id, e.created_at, e.kind, t.tech_no, t.name AS tech_name, s.session_no, st.display_name AS staff_name, e.detail
    FROM technician_events e LEFT JOIN technicians t ON t.id = e.technician_id LEFT JOIN technician_sessions s ON s.id = e.session_id
    JOIN staff st ON st.id = e.staff_id
    WHERE e.business_date = ${date} ORDER BY e.id DESC LIMIT 500`;
  return rows.map((r) => ({
    id: r.id,
    at: new Date(r.createdAt).toISOString(),
    kind: r.kind,
    techNo: r.techNo,
    techName: r.techName,
    sessionNo: r.sessionNo,
    staffName: r.staffName,
    text: eventText(r.kind, r.detail ?? {}) || EVENT_KIND_LABELS[r.kind],
  }));
}

// ───────────────────────── 路由 ─────────────────────────

export const DispatchInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  visitId: z.number().int().positive(),
  itemId: z.number().int().positive(),
  tier: z.enum(['standard', 'professional', 'premium']).optional(),
  quantity: z.number().int().min(1, '钟数至少为 1').max(9, '一次最多派 9 个钟'),
  technicianId: z.number().int().positive(),
  callType: z.enum(['designated', 'rotation']),
  startNow: z.boolean().default(true),
  skipReason: z.string().trim().max(100, '原因最多 100 字').optional(),
  /** 服务的房间（v0.7.16，可不选）；不带时与升级前的请求完全相同（幂等摘要不变） */
  spaceId: z.number().int().positive().nullish().transform((v) => v ?? undefined),
  expectedTotal: positiveCents('本次合计'),
});

export const ExtendInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  quantity: z.number().int().min(1, '加钟至少 1 个').max(9, '一次最多加 9 个钟'),
  expectedTotal: positiveCents('本次合计'),
});

export function registerClockroomRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const ctxOf = (req: import('fastify').FastifyRequest): OpContext => ({ actor: req.actor, ip: req.ip });
  // 派钟、加钟要挂账：与前台挂账同一个入口（价格、技师、幂等的核对都在那里）
  const post = async () => (await import('./frontdesk/bills')).postCharges;

  app.get('/api/clockroom', { preHandler: guard('technician.dispatch') }, async () => clockroomBoard(sql, deps));

  app.get('/api/clockroom/events', { preHandler: guard('technician.dispatch') }, async (req) => {
    const { date } = parse(z.object({ date: z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD').optional() }), req.query ?? {});
    return clockEvents(sql, date ?? (await businessDate(sql, deps, new Date())));
  });

  app.post('/api/clockroom/dispatch', { preHandler: guard('technician.dispatch', 'frontdesk.operate') }, async (req) => {
    const d = parse(DispatchInput, req.body);
    const postCharges = await post();
    await postCharges(
      deps,
      d.visitId,
      { clientKey: d.clientKey, lines: [{ itemId: d.itemId, quantity: d.quantity, tier: d.tier, technicianId: d.technicianId, callType: d.callType }], expectedTotal: d.expectedTotal },
      ctxOf(req),
      { session: { dispatch: { startNow: d.startNow, skipReason: d.skipReason, spaceId: d.spaceId } } },
    );
    return clockroomBoard(sql, deps);
  });

  app.get('/api/clockroom/spaces', { preHandler: guard('technician.dispatch') }, async () => clockSpaces(sql));
  app.post('/api/clockroom/sessions/:id/space', { preHandler: guard('technician.dispatch') }, async (req) =>
    setSessionSpace(deps, parse(idParam, req.params).id, req.body, ctxOf(req)),
  );

  app.post('/api/clockroom/sessions/:id/start', { preHandler: guard('technician.dispatch') }, async (req) => startSession(deps, parse(idParam, req.params).id, ctxOf(req)));
  app.post('/api/clockroom/sessions/:id/finish', { preHandler: guard('technician.dispatch') }, async (req) => finishSession(deps, parse(idParam, req.params).id, ctxOf(req)));
  app.post('/api/clockroom/sessions/:id/void', { preHandler: guard('technician.dispatch', 'frontdesk.operate') }, async (req) =>
    voidSession(deps, parse(idParam, req.params).id, req.body, ctxOf(req)),
  );

  app.post('/api/clockroom/sessions/:id/extend', { preHandler: guard('technician.dispatch', 'frontdesk.operate') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const e = parse(ExtendInput, req.body);
    const [s] = await sql<{ visitId: number; itemId: number; technicianId: number; callType: CallType; status: string; tier: 'standard' | 'professional' | 'premium' | null }[]>`
      SELECT s.visit_id, s.item_id, s.technician_id, s.call_type, s.status,
             (SELECT l.tier FROM bill_lines l WHERE l.session_id = s.id ORDER BY l.id LIMIT 1) AS tier
      FROM technician_sessions s WHERE s.id = ${id}`;
    if (!s) throw notFound('钟单不存在');
    if (s.status !== 'serving') throw conflict('SESSION_NOT_SERVING', '只有上钟中的钟单可以加钟');
    const rules = await loadClockroomRules(sql);
    const postCharges = await post();
    await postCharges(
      deps,
      s.visitId,
      {
        clientKey: e.clientKey,
        lines: [{ itemId: s.itemId, quantity: e.quantity, tier: s.tier ?? undefined, technicianId: s.technicianId, callType: rules.extensionAsDesignated ? 'designated' : s.callType }],
        expectedTotal: e.expectedTotal,
      },
      ctxOf(req),
      { session: { extendId: id } },
    );
    return clockroomBoard(sql, deps);
  });

  app.post('/api/clockroom/technicians/:id/state', { preHandler: guard('technician.dispatch') }, async (req) =>
    changeState(deps, parse(idParam, req.params).id, req.body, ctxOf(req)),
  );
  app.post('/api/clockroom/sign-in-all', { preHandler: guard('technician.dispatch') }, async (req) => signInAll(deps, ctxOf(req)));
}
