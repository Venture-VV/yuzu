// 8.0.8 前台整改 · 客房（docs/FRONTDESK_V808.md 第 6 节）：
//   · 改房态要确认、可备注、能撤回（B04）：每次房态变化记一条房态记录（room_housekeeping_events，只追加）：手动改、撤回、
//     退房 / 换房 / 撤销入住时自动改成待打扫；改房态带上看到的房态，刚被别人改过就拒绝（HOUSEKEEPING_CHANGED）；
//     最近一次是手动改的、之后房态没再变过的能撤回一次（照样按改房态的规则核对：有人住着不能改成维修）。
//   · 房间详情（B07）：按日期列出这间房的入住、换进换出、退房 / 撤销，房费、押金，住客住在这间房期间挂在账单上的消费（服务、餐饮、其他），
//     房态记录；都从原单据现查（只读），不另存。
// 锁：改房态、撤回：房间一行 → 写房态记录。退房、换房、撤销入住自动改房态的在各自已有的锁里（入住单之后）锁房间一行再写。

import { z } from 'zod';
import { businessDayStart, ISO_DATE } from '@shared/business-date';
import { PAYMENT_METHOD_LABELS, shiftDate, type PaymentMethod } from '@shared/labels';
import {
  DEFAULT_ROOM_TIMELINE_DAYS,
  HOUSEKEEPING_LABELS,
  HOUSEKEEPING_SOURCE_LABELS,
  MAX_HOUSEKEEPING_NOTE,
  MAX_ROOM_TIMELINE_DAYS,
  type Housekeeping,
  type HousekeepingSource,
  type RoomTimeline,
  type RoomTimelineEntry,
} from '@shared/rooms';
import { isUniqueViolation, type Tx } from '../db';
import { writeAudit } from '../lib/audit';
import type { Deps, OpContext } from '../lib/context';
import { checkDateRange, daysBetween } from '../lib/dates';
import { badRequest, conflict, notFound } from '../lib/errors';
import { parse } from '../lib/validate';
import { businessDate, setTxTimeouts } from './frontdesk/common';
import { loadSettings } from './settings';

// ───────────────────────── 房态记录（B04） ─────────────────────────

export interface HousekeepingEventInput {
  roomId: number;
  from: Housekeeping;
  to: Housekeeping;
  note: string;
  source: HousekeepingSource;
  revertsId?: number;
  /** 自动改的那张入住单号 */
  ref?: string;
  staffId: number;
  at: Date;
}

/** 记一条房态记录（房态没变的不记）；调用前已锁好房间一行 */
export async function insertHousekeepingEvent(tx: Tx, e: HousekeepingEventInput) {
  if (e.from === e.to) return;
  await tx`
    INSERT INTO room_housekeeping_events (room_id, from_state, to_state, note, source, reverts_id, ref, staff_id, created_at)
    VALUES (${e.roomId}, ${e.from}, ${e.to}, ${e.note.slice(0, MAX_HOUSEKEEPING_NOTE)}, ${e.source}, ${e.revertsId ?? null},
            ${(e.ref ?? '').slice(0, 32)}, ${e.staffId}, ${e.at})`;
}

/**
 * 退房、换房（换出的那间）、撤销入住后把房间改成待打扫，并记一条自动的房态记录。
 * 调用前已锁好入住单（与原来一样，房间一行在这里锁）
 */
export async function markRoomDirty(tx: Tx, roomId: number, why: { ref: string; note: string; staffId: number; at: Date }) {
  const [r] = await tx<{ housekeeping: Housekeeping }[]>`SELECT housekeeping FROM rooms WHERE id = ${roomId} FOR UPDATE`;
  await tx`UPDATE rooms SET housekeeping = 'dirty', maintenance_note = NULL, updated_at = now() WHERE id = ${roomId}`;
  if (r) await insertHousekeepingEvent(tx, { roomId, from: r.housekeeping, to: 'dirty', note: why.note, source: 'auto', ref: why.ref, staffId: why.staffId, at: why.at });
}

const RevertInput = z.object({
  /** 要撤回的那条房态记录（页面上看到的最近一次修改） */
  eventId: z.number('请刷新后重试').int('请刷新后重试').positive('请刷新后重试'),
  note: z.string().trim().max(MAX_HOUSEKEEPING_NOTE, `备注最多 ${MAX_HOUSEKEEPING_NOTE} 字`).optional(),
});

/** 撤回上一次手动修改：回到改之前的房态，记一条「撤回」（一条修改只能撤回一次） */
export async function revertHousekeeping(deps: Deps, roomId: number, raw: unknown, ctx: OpContext) {
  const input = parse(RevertInput, raw);
  const at = ctx.at ?? new Date();
  try {
    await deps.sql.begin(async (tx) => {
      await setTxTimeouts(tx);
      const [room] = await tx<{ roomNo: string; housekeeping: Housekeeping }[]>`
        SELECT room_no, housekeeping FROM rooms WHERE id = ${roomId} FOR UPDATE`;
      if (!room) throw notFound('房间不存在，请刷新后重试');
      const [last] = await tx<{ id: number; fromState: Housekeeping; toState: Housekeeping; source: HousekeepingSource }[]>`
        SELECT id, from_state, to_state, source FROM room_housekeeping_events WHERE room_id = ${roomId} ORDER BY id DESC LIMIT 1`;
      if (!last || Number(last.id) !== input.eventId || last.source !== 'manual' || last.toState !== room.housekeeping) {
        throw conflict(
          'HOUSEKEEPING_CHANGED',
          `房间「${room.roomNo}」的房态在这之后又变过（现在是「${HOUSEKEEPING_LABELS[room.housekeeping]}」），不能撤回；请刷新后再看`,
        );
      }
      const target = last.fromState;
      let maintenanceNote: string | null = null;
      if (target === 'maintenance') {
        const [busy] = await tx<{ stayNo: string }[]>`SELECT stay_no FROM room_stays WHERE room_id = ${roomId} AND status = 'open'`;
        if (busy) throw conflict('ROOM_IN_USE', `房间「${room.roomNo}」有人住（${busy.stayNo}），不能撤回成维修`);
        // 恢复维修：用上一次设为维修时写的原因（升级前设的没有记录，写「撤回，恢复维修」）
        const [m] = await tx<{ note: string }[]>`
          SELECT note FROM room_housekeeping_events
          WHERE room_id = ${roomId} AND to_state = 'maintenance' AND id < ${last.id} ORDER BY id DESC LIMIT 1`;
        maintenanceNote = m && m.note.trim().length >= 2 ? m.note.trim() : '撤回，恢复维修';
      }
      await tx`UPDATE rooms SET housekeeping = ${target}, maintenance_note = ${maintenanceNote}, updated_at = now() WHERE id = ${roomId}`;
      const note = input.note || '撤回上一次修改';
      await insertHousekeepingEvent(tx, { roomId, from: room.housekeeping, to: target, note, source: 'revert', revertsId: Number(last.id), staffId: ctx.actor.id, at });
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'room_housekeeping',
        targetType: 'room',
        targetId: roomId,
        detail: { room: room.roomNo, from: room.housekeeping, to: target, revert: true, revertsId: Number(last.id), note },
        ip: ctx.ip,
        businessDate: await businessDate(tx, deps, at),
      });
    });
  } catch (error) {
    // 两个终端同时撤回同一条：唯一索引兜底
    if (isUniqueViolation(error, 'room_housekeeping_events_revert_uq')) throw conflict('HOUSEKEEPING_CHANGED', '这次修改已经撤回过了，请刷新后再看');
    throw error;
  }
}

// ───────────────────────── 房间详情（B07） ─────────────────────────

const TimelineQuery = z.object({
  from: z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD').optional(),
  to: z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD').optional(),
});

interface StayRow {
  id: number;
  stayNo: string;
  roomId: number;
  status: 'open' | 'checked_out' | 'cancelled';
  checkedInAt: string;
  closedAt: string | null;
  closeReason: string | null;
  guestLabel: string;
  guests: number;
  billId: number;
  tagCode: string;
  memberName: string | null;
  checkedInByName: string;
  closedByName: string | null;
}

interface MoveRow {
  id: number;
  stayId: number;
  fromRoomId: number;
  toRoomId: number;
  fromNo: string;
  toNo: string;
  reason: string;
  createdAt: string;
  staffName: string;
}

/** 一张入住单住在这间房的时间段：最后一段（退房、撤销那一刻）含结束时刻，换出的那段不含 */
interface Segment {
  stay: StayRow;
  start: number;
  end: number;
  last: boolean;
}

const STAY_CLOSE_TEXT = { checked_out: '退房', cancelled: '撤销入住' } as const;
/** 同一刻的几条按这个先后：入住、换进、房费、押金、消费、换出、退房、房态 */
const TIE_ORDER = ['checkin-', 'move-in-', 'charge-', 'deposit-', 'line-', 'move-out-', 'close-', 'hk-'];

export async function roomTimeline(deps: Deps, roomId: number, raw: unknown): Promise<RoomTimeline> {
  const db = deps.sql;
  const q = parse(TimelineQuery, raw);
  const today = await businessDate(db as unknown as Tx, deps, new Date());
  const to = q.to ?? today;
  const from = q.from ?? shiftDate(to, -(DEFAULT_ROOM_TIMELINE_DAYS - 1));
  checkDateRange(from, to);
  if (daysBetween(from, to) >= MAX_ROOM_TIMELINE_DAYS) throw badRequest(`一次最多查 ${MAX_ROOM_TIMELINE_DAYS} 天`);
  const settings = await loadSettings(db);
  const start = businessDayStart(from, deps.config.timezone, settings.businessDayStartHour);
  const end = new Date(businessDayStart(to, deps.config.timezone, settings.businessDayStartHour).getTime() + 86_400_000);
  const inRange = (iso: string) => {
    const ms = Date.parse(iso);
    return ms >= start.getTime() && ms < end.getTime();
  };

  const [room] = await db<{ id: number; roomNo: string; floor: string; typeName: string; housekeeping: Housekeeping }[]>`
    SELECT r.id, r.room_no, r.floor, t.name AS type_name, r.housekeeping FROM rooms r JOIN room_types t ON t.id = r.room_type_id WHERE r.id = ${roomId}`;
  if (!room) throw notFound('房间不存在');

  // 在这段时间里住过这间房的入住单（现在在这间，或换进、换出过这间）
  const stays = await db<StayRow[]>`
    SELECT s.id, s.stay_no, s.room_id, s.status, s.checked_in_at, s.closed_at, s.close_reason, s.guest_label, s.guests, s.bill_id,
           h.code AS tag_code, m.name AS member_name, ci.display_name AS checked_in_by_name, cb.display_name AS closed_by_name
    FROM room_stays s JOIN visits v ON v.id = s.visit_id JOIN hand_tags h ON h.id = v.tag_id LEFT JOIN members m ON m.id = v.member_id
    JOIN staff ci ON ci.id = s.checked_in_by LEFT JOIN staff cb ON cb.id = s.closed_by
    WHERE (s.room_id = ${roomId} OR EXISTS (SELECT 1 FROM room_moves mv WHERE mv.stay_id = s.id AND (mv.from_room_id = ${roomId} OR mv.to_room_id = ${roomId})))
      AND s.checked_in_at < ${end} AND (s.closed_at IS NULL OR s.closed_at >= ${start})
    ORDER BY s.checked_in_at, s.id`;
  const stayIds = stays.map((s) => Number(s.id));
  const moves = stayIds.length
    ? await db<MoveRow[]>`
        SELECT mv.id, mv.stay_id, mv.from_room_id, mv.to_room_id, fr.room_no AS from_no, tr.room_no AS to_no, mv.reason, mv.created_at, st.display_name AS staff_name
        FROM room_moves mv JOIN rooms fr ON fr.id = mv.from_room_id JOIN rooms tr ON tr.id = mv.to_room_id JOIN staff st ON st.id = mv.operator_id
        WHERE mv.stay_id IN ${db(stayIds)} ORDER BY mv.created_at, mv.id`
    : [];

  const entries: RoomTimelineEntry[] = [];
  const segments: Segment[] = [];
  const guestText = (s: StayRow) => [s.memberName ?? s.guestLabel, `手牌 ${s.tagCode}`, `${s.guests} 人`].filter(Boolean).join(' · ');
  for (const s of stays) {
    const own = moves.filter((m) => Number(m.stayId) === Number(s.id));
    // 按换房记录还原这张入住单住过的房间与时间段
    let current = own.length ? Number(own[0]!.fromRoomId) : Number(s.roomId);
    let since = Date.parse(s.checkedInAt);
    const firstRoom = current;
    for (const m of own) {
      if (current === roomId) segments.push({ stay: s, start: since, end: Date.parse(m.createdAt), last: false });
      current = Number(m.toRoomId);
      since = Date.parse(m.createdAt);
      if (Number(m.toRoomId) === roomId && inRange(m.createdAt)) {
        entries.push({ key: `move-in-${m.id}`, kind: 'stay', at: m.createdAt, title: `换进（从 ${m.fromNo}）`, detail: `${guestText(s)} · ${m.reason}`, ref: s.stayNo, amount: null, status: null, staffName: m.staffName });
      }
      if (Number(m.fromRoomId) === roomId && inRange(m.createdAt)) {
        entries.push({ key: `move-out-${m.id}`, kind: 'stay', at: m.createdAt, title: `换出（到 ${m.toNo}）`, detail: `${guestText(s)} · ${m.reason}`, ref: s.stayNo, amount: null, status: null, staffName: m.staffName });
      }
    }
    if (current === roomId) segments.push({ stay: s, start: since, end: s.closedAt ? Date.parse(s.closedAt) : Number.POSITIVE_INFINITY, last: true });
    if (firstRoom === roomId && inRange(s.checkedInAt)) {
      entries.push({ key: `checkin-${s.id}`, kind: 'stay', at: s.checkedInAt, title: '入住', detail: guestText(s), ref: s.stayNo, amount: null, status: s.status === 'cancelled' ? '已撤销' : null, staffName: s.checkedInByName });
    }
    if (current === roomId && s.closedAt && s.status !== 'open' && inRange(s.closedAt)) {
      entries.push({
        key: `close-${s.id}`,
        kind: 'stay',
        at: s.closedAt,
        title: STAY_CLOSE_TEXT[s.status],
        detail: [guestText(s), s.closeReason].filter(Boolean).join(' · '),
        ref: s.stayNo,
        amount: null,
        status: null,
        staffName: s.closedByName ?? '',
      });
    }
  }
  /** 这一刻这张入住单住在这间房里吗（时间段内） */
  const within = (g: Segment, iso: string) => {
    const ms = Date.parse(iso);
    return ms >= g.start && (g.last ? ms <= g.end : ms < g.end);
  };
  const segmentOf = (stayId: number, iso: string) => segments.find((g) => Number(g.stay.id) === stayId && within(g, iso));

  if (stayIds.length) {
    // 房费
    const charges = await db<{ id: number; stayId: number; name: string; amount: number; status: string; voidReason: string | null; postedAt: string; staffName: string }[]>`
      SELECT l.id, c.stay_id, l.name, l.amount, l.status, l.void_reason, l.posted_at, st.display_name AS staff_name
      FROM room_stay_charges c JOIN bill_lines l ON l.id = c.line_id JOIN staff st ON st.id = l.posted_by
      WHERE c.stay_id IN ${db(stayIds)} ORDER BY l.posted_at, l.id`;
    for (const c of charges) {
      const g = segmentOf(Number(c.stayId), c.postedAt);
      if (!g || !inRange(c.postedAt)) continue;
      entries.push({
        key: `charge-${c.id}`,
        kind: 'charge',
        at: c.postedAt,
        title: c.name,
        detail: c.status === 'voided' && c.voidReason ? `作废原因：${c.voidReason}` : guestText(g.stay),
        ref: g.stay.stayNo,
        amount: Number(c.amount),
        status: c.status === 'voided' ? '已作废' : null,
        staffName: c.staffName,
      });
    }
    // 押金
    const deposits = await db<{ id: number; stayId: number; kind: 'receive' | 'refund'; method: PaymentMethod; amount: number; reason: string | null; createdAt: string; staffName: string }[]>`
      SELECT d.id, d.stay_id, d.kind, d.method, d.amount, d.reason, d.created_at, st.display_name AS staff_name
      FROM room_deposits d JOIN staff st ON st.id = d.operator_id WHERE d.stay_id IN ${db(stayIds)} ORDER BY d.created_at, d.id`;
    for (const d of deposits) {
      const g = segmentOf(Number(d.stayId), d.createdAt);
      if (!g || !inRange(d.createdAt)) continue;
      entries.push({
        key: `deposit-${d.id}`,
        kind: 'deposit',
        at: d.createdAt,
        title: `${d.kind === 'receive' ? '收押金' : '退押金'}（${PAYMENT_METHOD_LABELS[d.method] ?? d.method}）`,
        detail: d.reason ?? guestText(g.stay),
        ref: g.stay.stayNo,
        amount: d.kind === 'receive' ? Number(d.amount) : -Number(d.amount),
        status: null,
        staffName: d.staffName,
      });
    }
    // 住客住在这间房期间挂在账单上的消费（房费另列）
    const billIds = [...new Set(stays.map((s) => Number(s.billId)))];
    const lines = await db<{
      id: number;
      billId: number;
      name: string;
      source: string;
      quantity: number;
      amount: number;
      status: string;
      voidReason: string | null;
      postedAt: string;
      staffName: string;
      sessionNo: string | null;
      techNo: string | null;
      techName: string | null;
      clocks: number | null;
      orderNo: string | null;
    }[]>`
      SELECT l.id, l.bill_id, l.name, l.source, l.quantity, l.amount, l.status, l.void_reason, l.posted_at, st.display_name AS staff_name,
             ts.session_no, t.tech_no, t.name AS tech_name, ts.clocks, ki.order_no
      FROM bill_lines l JOIN staff st ON st.id = l.posted_by
      LEFT JOIN technician_sessions ts ON ts.id = l.session_id LEFT JOIN technicians t ON t.id = ts.technician_id
      LEFT JOIN kitchen_items ki ON ki.bill_line_id = l.id
      WHERE l.bill_id IN ${db(billIds)} AND l.source <> 'room' AND NOT EXISTS (SELECT 1 FROM room_stay_charges c WHERE c.line_id = l.id)
        AND l.posted_at >= ${start} AND l.posted_at < ${end}
      ORDER BY l.posted_at, l.id`;
    for (const l of lines) {
      const g = segments.find((x) => Number(x.stay.billId) === Number(l.billId) && within(x, l.postedAt));
      if (!g) continue;
      const kind = l.source === 'therapist' ? 'service' : l.source === 'dining' ? 'dining' : 'other';
      const extra =
        kind === 'service' && l.techName
          ? `技师 ${l.techNo} ${l.techName}${l.clocks ? ` · ${l.clocks} 钟` : ''}`
          : kind === 'dining'
            ? `${l.quantity} 份`
            : l.quantity > 1
              ? `× ${l.quantity}`
              : '';
      entries.push({
        key: `line-${l.id}`,
        kind,
        at: l.postedAt,
        title: l.name,
        detail: [extra, `手牌 ${g.stay.tagCode}`, l.status === 'voided' && l.voidReason ? `作废原因：${l.voidReason}` : ''].filter(Boolean).join(' · '),
        ref: l.sessionNo ?? l.orderNo ?? '',
        amount: Number(l.amount),
        status: l.status === 'voided' ? '已作废' : null,
        staffName: l.staffName,
      });
    }
  }

  // 房态记录
  const events = await db<{ id: number; fromState: Housekeeping; toState: Housekeeping; note: string; source: HousekeepingSource; ref: string; createdAt: string; staffName: string }[]>`
    SELECT e.id, e.from_state, e.to_state, e.note, e.source, e.ref, e.created_at, st.display_name AS staff_name
    FROM room_housekeeping_events e JOIN staff st ON st.id = e.staff_id
    WHERE e.room_id = ${roomId} AND e.created_at >= ${start} AND e.created_at < ${end} ORDER BY e.id`;
  const reverted = new Set(
    (await db<{ revertsId: number }[]>`SELECT reverts_id FROM room_housekeeping_events WHERE room_id = ${roomId} AND reverts_id IS NOT NULL`).map((r) => Number(r.revertsId)),
  );
  for (const e of events) {
    entries.push({
      key: `hk-${e.id}`,
      kind: 'housekeeping',
      at: e.createdAt,
      title: `${HOUSEKEEPING_LABELS[e.fromState]} → ${HOUSEKEEPING_LABELS[e.toState]}`,
      detail: [HOUSEKEEPING_SOURCE_LABELS[e.source], e.note].filter(Boolean).join(' · '),
      ref: e.ref,
      amount: null,
      status: reverted.has(Number(e.id)) ? '已撤回' : null,
      staffName: e.staffName,
    });
  }

  // 时间倒序；同一刻发生的（入住时挂的房费、收的押金，退房时退的押金、自动改房态）按发生的先后排
  const rank = (key: string) => TIE_ORDER.findIndex((p) => key.startsWith(p));
  entries.sort((a, b) => (a.at !== b.at ? (a.at < b.at ? 1 : -1) : rank(b.key) - rank(a.key) || b.key.localeCompare(a.key)));
  return { room: { ...room, id: Number(room.id) }, from, to, entries };
}
