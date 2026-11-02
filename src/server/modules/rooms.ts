// S7 客房（v0.7.4，店主 2026-10-31 选定，见 docs/ROOMS.md）：后台的房型与房间、房态看板、入住、房费（入住、夜审、退房时补挂）、
// 续住、换房、押金（收、退）、退房、撤销入住、打扫与维修、夜审。
//
// 住客都是在店的洗浴客人（店主 2026-10-31：门票必选，没有只住房的客人；房价不含洗浴门票）：入住要输入在店的手牌，
// 房费是手牌账单上的明细（来源「客房」），离店时随手牌在前台一起结账；手牌结账前要先退房（frontdesk/checkout.ts）。
// 押金台账只追加，收、退记经办人当班的班次（现金计入交班应有现金），退房时余下的押金原路退回。
// 加锁顺序：经办人的班次（收退押金、退房，共享锁）→ 房间（id 升序）→ 入住单（id 升序）→ 来访 → 账单 → 明细。

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { businessDateOf } from '@shared/business-date';
import { normalizeTagCode, TAG_CODE_PATTERN } from '@shared/frontdesk';
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentMethod } from '@shared/labels';
import { formatYuan } from '@shared/money';
import {
  DEFAULT_ROOM_RULES,
  HOUSEKEEPING_STATES,
  MAX_ROOM_FLOOR,
  MAX_ROOM_NO,
  MAX_ROOM_TYPE_NAME,
  MAX_STAY_GUESTS,
  ROOM_KINDS,
  chargeLineName,
  localMinuteAt,
  roomDues,
  type RoomAuditReport,
  type RoomAuditState,
  type RoomBoard,
  type RoomBoardStatus,
  type RoomDue,
  type RoomKind,
  type RoomRules,
  type RoomsAdmin,
  type StayCheckoutPreview,
  type StayDetail,
  type StaySummary,
} from '@shared/rooms';
import { ROOM_BUSINESS_TYPE } from '@shared/spaces';
import { isUniqueViolation, type Db, type Tx } from '../db';
import { guard, guardAny } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Deps, OpContext } from '../lib/context';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors';
import { cents, idParam, parse, positiveCents } from '../lib/validate';
import { assertCanFix, assertOpen, businessDate, hashRequest, loadFrontdeskRules, lockVisits, nextDocNo, runIdempotent, saveKey, setTxTimeouts } from './frontdesk/common';
import { loadSettings } from './settings';
import { lockPaymentShift, openShiftOf } from './shifts';
import { leaveRoomStay, locateRoomStay } from './locations';

// ───────────────────────── 规则 ─────────────────────────

export async function loadRoomRules(db: Db): Promise<RoomRules> {
  const [row] = await db<{ value: Partial<RoomRules> }[]>`SELECT value FROM settings WHERE key = 'room_rules'`;
  return { ...DEFAULT_ROOM_RULES, ...(row?.value ?? {}) };
}

async function assertRoomsEnabled(db: Db) {
  if (!(await loadRoomRules(db)).enabled) throw unprocessable('ROOMS_DISABLED', '客房功能已关闭，请刷新页面');
}

/** 门店时区与营业日切换时刻（房费按营业日算） */
async function roomClock(db: Db, deps: Deps) {
  return { timeZone: deps.config.timezone, startHour: (await loadSettings(db)).businessDayStartHour };
}

const minuteOfDay = (label: string) => z.number(`${label}不正确`).int(`${label}不正确`).min(0, `${label}不正确`).max(24 * 60 - 1, `${label}不正确`);
const RulesInput = z
  .object({
    enabled: z.boolean(),
    checkoutMinute: minuteOfDay('退房时间'),
    lateFullMinute: minuteOfDay('加收一晚的时刻'),
    hourlyGraceMinutes: z.number('宽限分钟不正确').int('宽限分钟不正确').min(0, '宽限分钟不能为负').max(120, '宽限最多 120 分钟'),
    defaultDeposit: cents('押金默认金额').max(10_000_000, '押金默认金额过大'),
  })
  .refine((r) => r.lateFullMinute > r.checkoutMinute, { message: '加收一晚的时刻要晚于退房时间', path: ['lateFullMinute'] });

const hhmm = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

// ───────────────────────── 后台：规则、房型、房间 ─────────────────────────

export async function roomsAdmin(db: Db): Promise<RoomsAdmin> {
  const rules = await loadRoomRules(db);
  const [meta] = await db<{ updatedAt: string; updatedBy: string | null }[]>`
    SELECT s.updated_at, st.display_name AS updated_by FROM settings s LEFT JOIN staff st ON st.id = s.updated_by WHERE s.key = 'room_rules'`;
  const types = await db<RoomsAdmin['types']>`
    SELECT t.id, t.name, t.kind, t.price, t.block_minutes, t.sort_order, t.active,
           (SELECT count(*) FROM rooms r WHERE r.room_type_id = t.id AND r.active)::int AS room_count
    FROM room_types t ORDER BY t.sort_order, t.id`;
  const rooms = await db<RoomsAdmin['rooms']>`
    SELECT r.id, r.room_no, r.floor, r.room_type_id, r.housekeeping, r.maintenance_note, r.sort_order, r.active,
           EXISTS (SELECT 1 FROM room_stays s WHERE s.room_id = r.id AND s.status = 'open') AS occupied,
           r.space_id, sp.code AS space_code, sp.display_name AS space_name
    FROM rooms r LEFT JOIN spaces sp ON sp.id = r.space_id ORDER BY r.floor, r.sort_order, r.room_no`;
  const spaces = await db<RoomsAdmin['spaces']>`
    SELECT s.id, s.code, s.display_name, f.code AS floor_code, s.active, r.id AS room_id
    FROM spaces s JOIN floors f ON f.id = s.floor_id LEFT JOIN rooms r ON r.space_id = s.id
    WHERE s.business_type = ${ROOM_BUSINESS_TYPE} AND (s.active OR r.id IS NOT NULL)
    ORDER BY f.sort_order, s.code`;
  return {
    rules,
    rulesUpdatedAt: meta?.updatedAt ?? null,
    rulesUpdatedBy: meta?.updatedBy ?? null,
    types,
    rooms,
    spaces,
    spaceRequired: spaces.some((s) => s.active),
  };
}

async function saveRoomRules(deps: Deps, raw: unknown, ctx: OpContext) {
  const next = parse(RulesInput, raw);
  await deps.sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('settings'))`;
    const before = await loadRoomRules(tx);
    await tx`
      INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('room_rules', ${tx.json(next as never)}, now(), ${ctx.actor.id})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`;
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'settings_updated', targetType: 'settings', detail: { key: 'room_rules', before, after: next }, ip: ctx.ip });
  });
}

const RoomTypeInput = z
  .object({
    name: z.string('请填写房型名称').trim().min(1, '请填写房型名称').max(MAX_ROOM_TYPE_NAME, `房型名称最多 ${MAX_ROOM_TYPE_NAME} 字`),
    kind: z.enum(ROOM_KINDS, '请选择全天房或钟点房'),
    price: positiveCents('房价').max(10_000_000, '房价过大'),
    /** 钟点房每段分钟；全天房不带 */
    blockMinutes: z.number('每段时长不正确').int('每段时长不正确').min(30, '每段至少 30 分钟').max(720, '每段最多 12 小时').nullish(),
    sortOrder: z.number().int().min(0).max(9999).default(0),
    active: z.boolean().default(true),
  })
  .refine((t) => (t.kind === 'hourly') === (t.blockMinutes != null), { message: '钟点房要填每段时长，全天房不用填', path: ['blockMinutes'] });

async function saveRoomType(deps: Deps, id: number | null, raw: unknown, ctx: OpContext) {
  const t = parse(RoomTypeInput, raw);
  const block = t.kind === 'hourly' ? t.blockMinutes! : null;
  await deps.sql.begin(async (tx) => {
    const [dup] = await tx<{ id: number }[]>`SELECT id FROM room_types WHERE lower(btrim(name)) = lower(${t.name}) AND id IS DISTINCT FROM ${id}`;
    if (dup) throw conflict('ROOM_TYPE_NAME_TAKEN', `已有房型「${t.name}」`);
    if (id === null) {
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO room_types (name, kind, price, block_minutes, sort_order, active, created_by)
        VALUES (${t.name}, ${t.kind}, ${t.price}, ${block}, ${t.sortOrder}, ${t.active}, ${ctx.actor.id}) RETURNING id`;
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'room_type_saved',
        targetType: 'room_type',
        targetId: row!.id,
        detail: { summary: `新建房型「${t.name}」${formatYuan(t.price)}${t.kind === 'hourly' ? `每段（${block} 分钟）` : '每晚'}` },
        ip: ctx.ip,
      });
      return;
    }
    const [cur] = await tx<{ name: string; price: number }[]>`SELECT name, price FROM room_types WHERE id = ${id} FOR UPDATE`;
    if (!cur) throw notFound('房型不存在');
    if (!t.active) {
      const [used] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM rooms WHERE room_type_id = ${id} AND active`;
      if (used!.n > 0) throw conflict('ROOM_TYPE_IN_USE', `房型「${cur.name}」还有 ${used!.n} 间启用的房间，请先把这些房间停用或改成别的房型`);
    }
    await tx`
      UPDATE room_types SET name = ${t.name}, kind = ${t.kind}, price = ${t.price}, block_minutes = ${block}, sort_order = ${t.sortOrder},
             active = ${t.active}, updated_at = now()
      WHERE id = ${id}`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'room_type_saved',
      targetType: 'room_type',
      targetId: id,
      detail: {
        summary: `修改房型「${cur.name}」${cur.name !== t.name ? ` → 「${t.name}」` : ''}${cur.price !== t.price ? `，房价 ${formatYuan(cur.price)} → ${formatYuan(t.price)}` : ''}${t.active ? '' : '（停用）'}`,
      },
      ip: ctx.ip,
    });
  });
}

const RoomInput = z.object({
  /** 房号：挂了空间的房间用空间编码，不用填 */
  roomNo: z.string('房号不正确').trim().max(MAX_ROOM_NO, `房号最多 ${MAX_ROOM_NO} 字`).default(''),
  floor: z.string().trim().max(MAX_ROOM_FLOOR, `楼层最多 ${MAX_ROOM_FLOOR} 字`).default(''),
  roomTypeId: z.number('请选择房型').int().positive('请选择房型'),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  active: z.boolean().default(true),
  /** 挂接的空间（v0.7.14）：不带 = 不改挂接；null = 不挂（已挂着的就是取消挂接） */
  spaceId: z.number('空间不正确').int().positive('空间不正确').nullable().optional(),
  /** 换挂、取消挂接的原因（例如现场核对后发现挂错了） */
  linkReason: z.string('原因不正确').trim().max(200, '原因最多 200 字').default(''),
});

/**
 * 锁住要挂的空间（房间之后：房间 → 空间），核对能挂：空间台账里在用的「客房」空间，没挂在别的房间上。
 * 空间编辑（停用、改业态）也锁这一行，两边串行。
 */
async function lockLinkableSpace(tx: Tx, spaceId: number, roomId: number | null) {
  const [space] = await tx<{ code: string; displayName: string; businessType: string; active: boolean }[]>`
    SELECT code, display_name, business_type, active FROM spaces WHERE id = ${spaceId} FOR UPDATE`;
  if (!space) throw notFound('空间不存在，请刷新后重试');
  if (!space.active) throw conflict('SPACE_INACTIVE', `空间 ${space.code} 已停用，不能挂客房`);
  if (space.businessType !== ROOM_BUSINESS_TYPE) throw conflict('SPACE_NOT_ROOM', `空间 ${space.code} 的业态是「${space.businessType}」，客房只能挂「${ROOM_BUSINESS_TYPE}」的空间`);
  const [other] = await tx<{ roomNo: string }[]>`SELECT room_no FROM rooms WHERE space_id = ${spaceId} AND id IS DISTINCT FROM ${roomId}`;
  if (other) throw conflict('SPACE_LINKED', `空间 ${space.code} 已挂在房间「${other.roomNo}」上`);
  return space;
}

async function saveRoom(deps: Deps, id: number | null, raw: unknown, ctx: OpContext) {
  const r = parse(RoomInput, raw);
  const reasonOk = r.linkReason.length >= 2;
  try {
    await deps.sql.begin(async (tx) => {
      const [type] = await tx<{ active: boolean }[]>`SELECT active FROM room_types WHERE id = ${r.roomTypeId}`;
      if (!type) throw notFound('房型不存在，请刷新后重试');
      if (id === null) {
        if (!type.active) throw conflict('ROOM_TYPE_INACTIVE', '这个房型已停用，请换一个房型');
        let roomNo = r.roomNo;
        let spaceId: number | null = null;
        if (r.spaceId != null) {
          const space = await lockLinkableSpace(tx, r.spaceId, null);
          roomNo = space.code;
          spaceId = r.spaceId;
        } else {
          // 空间台账里已有客房：新建的房间都要从台账里选（房号不再手工录入）
          const [required] = await tx`SELECT 1 FROM spaces WHERE business_type = ${ROOM_BUSINESS_TYPE} AND active LIMIT 1`;
          if (required) throw unprocessable('ROOM_SPACE_REQUIRED', '空间台账里已有客房：新建房间请选一个空间，房号就是空间编码');
          if (!roomNo) throw unprocessable('ROOM_NO_REQUIRED', '请填写房号');
        }
        const [dup] = await tx<{ id: number }[]>`SELECT id FROM rooms WHERE lower(btrim(room_no)) = lower(${roomNo})`;
        if (dup) throw conflict('ROOM_NO_TAKEN', `已有房间「${roomNo}」${spaceId ? '（先把那间房挂到这个空间上，或改它的房号）' : ''}`);
        const [row] = await tx<{ id: number }[]>`
          INSERT INTO rooms (room_no, floor, room_type_id, sort_order, active, created_by, space_id)
          VALUES (${roomNo}, ${r.floor}, ${r.roomTypeId}, ${r.sortOrder}, ${r.active}, ${ctx.actor.id}, ${spaceId}) RETURNING id`;
        await writeAudit(tx, {
          staffId: ctx.actor.id,
          action: 'room_saved',
          targetType: 'room',
          targetId: row!.id,
          detail: { summary: `新建房间「${roomNo}」${spaceId ? '（挂接空间台账）' : ''}`, spaceId },
          ip: ctx.ip,
        });
        return;
      }
      const [cur] = await tx<{ roomNo: string; roomTypeId: number; spaceId: number | null }[]>`
        SELECT room_no, room_type_id, space_id FROM rooms WHERE id = ${id} FOR UPDATE`;
      if (!cur) throw notFound('房间不存在');
      const [busy] = await tx<{ stayNo: string }[]>`SELECT stay_no FROM room_stays WHERE room_id = ${id} AND status = 'open'`;
      if (busy && (!r.active || r.roomTypeId !== cur.roomTypeId)) {
        throw conflict('ROOM_IN_USE', `房间「${cur.roomNo}」有人住（${busy.stayNo}），退房或换房后才能停用、改房型`);
      }
      if (r.roomTypeId !== cur.roomTypeId && !type.active) throw conflict('ROOM_TYPE_INACTIVE', '这个房型已停用，请换一个房型');
      const nextSpace = r.spaceId === undefined ? cur.spaceId : r.spaceId;
      const relink = nextSpace !== cur.spaceId;
      let roomNo = r.roomNo;
      let linkNote = '';
      if (relink) {
        // 挂接改了：有人住时不改（房费明细上的房号要与入住时一致）；换挂、取消挂接要写原因
        if (busy) throw conflict('ROOM_IN_USE', `房间「${cur.roomNo}」有人住（${busy.stayNo}），退房后才能${cur.spaceId ? '换挂或取消挂接' : '挂接空间'}`);
        if (cur.spaceId !== null && !reasonOk) throw unprocessable('LINK_REASON_REQUIRED', '换挂或取消挂接要写原因（至少 2 个字），例如现场核对后发现挂错了');
      }
      if (nextSpace !== null) {
        // 挂着空间：房号就是空间编码（不能另改）
        const space = relink
          ? await lockLinkableSpace(tx, nextSpace, id)
          : (await tx<{ code: string }[]>`SELECT code FROM spaces WHERE id = ${nextSpace} FOR SHARE`)[0]!;
        roomNo = space.code;
        if (relink) linkNote = cur.spaceId === null ? `，挂接空间 ${space.code}` : `，换挂空间 ${space.code}（${r.linkReason}）`;
      } else {
        if (!roomNo) throw unprocessable('ROOM_NO_REQUIRED', '请填写房号');
        if (relink) linkNote = `，取消挂接空间（${r.linkReason}）`;
      }
      const [dup] = await tx<{ id: number }[]>`SELECT id FROM rooms WHERE lower(btrim(room_no)) = lower(${roomNo}) AND id <> ${id}`;
      if (dup) throw conflict('ROOM_NO_TAKEN', `已有房间「${roomNo}」`);
      await tx`
        UPDATE rooms SET room_no = ${roomNo}, floor = ${r.floor}, room_type_id = ${r.roomTypeId}, sort_order = ${r.sortOrder}, active = ${r.active},
               space_id = ${nextSpace}, updated_at = now()
        WHERE id = ${id}`;
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'room_saved',
        targetType: 'room',
        targetId: id,
        detail: {
          summary: `修改房间「${cur.roomNo}」${cur.roomNo !== roomNo ? ` → 「${roomNo}」` : ''}${linkNote}${r.active ? '' : '（停用）'}`,
          ...(relink ? { spaceBefore: cur.spaceId, spaceAfter: nextSpace, reason: r.linkReason || null } : {}),
        },
        ip: ctx.ip,
      });
    });
  } catch (e) {
    // 两个房间同时挂同一个空间、或同时用同一个房号：唯一索引兜底
    if (isUniqueViolation(e, 'rooms_space_uq')) throw conflict('SPACE_LINKED', '这个空间刚被挂到别的房间上，请刷新后重试');
    if (isUniqueViolation(e, 'rooms_no_uq')) throw conflict('ROOM_NO_TAKEN', '房号刚被别的房间用了，请刷新后重试');
    throw e;
  }
}

// ───────────────────────── 读取：入住单、房态看板 ─────────────────────────

type StayRow = Omit<StayDetail, 'charges' | 'deposits' | 'depositByMethod' | 'moves'> & { roomTypeId: number };

const staySelect = (db: Db) => db`
  SELECT s.id, s.stay_no, s.kind, s.rate, s.block_minutes, s.status, s.room_id, r.room_no, t.name AS type_name, s.room_type_id,
         s.bill_id, b.bill_no, b.amount_cents AS bill_amount, s.visit_id, ht.code AS tag_code, s.guest_label, s.guests, v.member_id,
         m.name AS member_name, s.checked_in_at, s.business_date, s.expected_checkout_date, s.closed_at AS checked_out_at,
         cb.display_name AS checked_out_by_name, s.close_reason,
         (SELECT coalesce(sum(c.amount), 0) FROM room_stay_charges c JOIN bill_lines l ON l.id = c.line_id
          WHERE c.stay_id = s.id AND l.status = 'active')::int AS charged_amount,
         (SELECT coalesce(sum(CASE WHEN d.kind = 'receive' THEN d.amount ELSE -d.amount END), 0) FROM room_deposits d
          WHERE d.stay_id = s.id)::int AS deposit_balance
  FROM room_stays s JOIN rooms r ON r.id = s.room_id JOIN room_types t ON t.id = s.room_type_id JOIN bills b ON b.id = s.bill_id
  JOIN visits v ON v.id = s.visit_id JOIN hand_tags ht ON ht.id = v.tag_id LEFT JOIN members m ON m.id = v.member_id
  LEFT JOIN staff cb ON cb.id = s.closed_by`;

const toSummary = (r: StayRow): StaySummary => ({
  id: r.id,
  stayNo: r.stayNo,
  kind: r.kind,
  rate: r.rate,
  guestLabel: r.guestLabel,
  guests: r.guests,
  tagCode: r.tagCode,
  visitId: r.visitId,
  memberId: r.memberId,
  memberName: r.memberName,
  checkedInAt: r.checkedInAt,
  businessDate: r.businessDate,
  expectedCheckoutDate: r.expectedCheckoutDate,
  chargedAmount: r.chargedAmount,
  depositBalance: r.depositBalance,
});

/** 每种收款方式的押金余额 = 收 − 退 */
async function depositBalances(db: Db, stayIds: number[]): Promise<Map<number, Map<PaymentMethod, number>>> {
  const map = new Map<number, Map<PaymentMethod, number>>();
  if (stayIds.length === 0) return map;
  const rows = await db<{ stayId: number; method: PaymentMethod; balance: number }[]>`
    SELECT stay_id, method, sum(CASE WHEN kind = 'receive' THEN amount ELSE -amount END)::int AS balance
    FROM room_deposits WHERE stay_id IN ${db(stayIds)} GROUP BY stay_id, method`;
  for (const r of rows) {
    if (!map.has(r.stayId)) map.set(r.stayId, new Map());
    if (r.balance !== 0) map.get(r.stayId)!.set(r.method, r.balance);
  }
  return map;
}

const byMethodList = (m: Map<PaymentMethod, number> | undefined) =>
  PAYMENT_METHODS.filter((k) => (m?.get(k) ?? 0) !== 0).map((k) => ({ method: k, balance: m!.get(k)! }));

export async function getStay(db: Db, id: number): Promise<StayDetail> {
  const [s] = await db<StayRow[]>`${staySelect(db)} WHERE s.id = ${id}`;
  if (!s) throw notFound('入住单不存在');
  const charges = await db<StayDetail['charges']>`
    SELECT c.id, c.kind, c.night_date, c.block_no, c.amount, c.source, c.line_id, l.status AS line_status, c.created_at,
           st.display_name AS created_by_name
    FROM room_stay_charges c JOIN bill_lines l ON l.id = c.line_id JOIN staff st ON st.id = c.created_by
    WHERE c.stay_id = ${id} ORDER BY c.id`;
  const deposits = await db<StayDetail['deposits']>`
    SELECT d.id, d.kind, d.method, d.amount, d.ref, d.reason, st.display_name AS operator_name, d.created_at
    FROM room_deposits d JOIN staff st ON st.id = d.operator_id
    WHERE d.stay_id = ${id} ORDER BY d.id`;
  const moves = await db<StayDetail['moves']>`
    SELECT fr.room_no AS from_room, tr.room_no AS to_room, mv.reason, st.display_name AS operator_name, mv.created_at
    FROM room_moves mv JOIN rooms fr ON fr.id = mv.from_room_id JOIN rooms tr ON tr.id = mv.to_room_id JOIN staff st ON st.id = mv.operator_id
    WHERE mv.stay_id = ${id} ORDER BY mv.id`;
  const balances = await depositBalances(db, [id]);
  const { roomTypeId: _t, ...rest } = s;
  return { ...rest, charges, deposits, depositByMethod: byMethodList(balances.get(id)), moves };
}

/** 今天的夜审：做过没有、今晚还没挂房费的在住全天房、是否已过加收一晚的时刻 */
async function auditState(db: Db, deps: Deps, now: Date): Promise<RoomAuditState> {
  const rules = await loadRoomRules(db);
  const clock = await roomClock(db, deps);
  const date = businessDateOf(now, clock.timeZone, clock.startHour);
  const [last] = await db<{ runAt: string; runByName: string }[]>`
    SELECT a.run_at, st.display_name AS run_by_name FROM room_audits a JOIN staff st ON st.id = a.run_by
    WHERE a.business_date = ${date} ORDER BY a.id DESC LIMIT 1`;
  const [pending] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM room_stays s
    WHERE s.status = 'open' AND s.kind = 'daily' AND s.business_date < ${date}
      AND NOT EXISTS (SELECT 1 FROM room_stay_charges c WHERE c.stay_id = s.id AND c.kind = 'night' AND c.night_date = ${date})`;
  return {
    date,
    done: !!last,
    runAt: last?.runAt ?? null,
    runByName: last?.runByName ?? null,
    pending: pending!.n,
    allowed: now.getTime() >= localMinuteAt(date, rules.lateFullMinute, clock.timeZone).getTime(),
  };
}

const boardStatus = (housekeeping: string, occupied: boolean): RoomBoardStatus =>
  occupied ? 'occupied' : housekeeping === 'clean' ? 'vacant' : (housekeeping as RoomBoardStatus);

async function roomStatusCounts(db: Db): Promise<Record<RoomBoardStatus, number>> {
  const rows = await db<{ housekeeping: string; occupied: boolean }[]>`
    SELECT r.housekeeping, EXISTS (SELECT 1 FROM room_stays s WHERE s.room_id = r.id AND s.status = 'open') AS occupied
    FROM rooms r WHERE r.active`;
  const counts: Record<RoomBoardStatus, number> = { vacant: 0, occupied: 0, dirty: 0, maintenance: 0 };
  for (const r of rows) counts[boardStatus(r.housekeeping, r.occupied)] += 1;
  return counts;
}

export async function roomsBoard(deps: Deps): Promise<RoomBoard> {
  const db = deps.sql;
  const now = new Date();
  // 停用的房间还有人住时照样显示，退房为止
  const rooms = await db<
    {
      id: number;
      roomNo: string;
      spaceName: string | null;
      spaceId: number | null;
      floor: string;
      typeName: string;
      kind: RoomKind;
      price: number;
      blockMinutes: number | null;
      housekeeping: string;
      maintenanceNote: string | null;
      stayId: number | null;
    }[]
  >`
    SELECT r.id, r.room_no, sp.display_name AS space_name, r.space_id, r.floor, t.name AS type_name, t.kind, t.price, t.block_minutes, r.housekeeping,
           r.maintenance_note, s.id AS stay_id
    FROM rooms r JOIN room_types t ON t.id = r.room_type_id LEFT JOIN room_stays s ON s.room_id = r.id AND s.status = 'open'
    LEFT JOIN spaces sp ON sp.id = r.space_id
    WHERE r.active OR s.id IS NOT NULL
    ORDER BY r.floor, r.sort_order, r.room_no`;
  const ids = rooms.flatMap((r) => (r.stayId ? [r.stayId] : []));
  const stays = ids.length ? await db<StayRow[]>`${staySelect(db)} WHERE s.id IN ${db(ids)}` : [];
  return {
    rules: await loadRoomRules(db),
    rooms: rooms.map(({ stayId, housekeeping, ...r }) => {
      const stay = stays.find((s) => s.id === stayId);
      return { ...r, status: boardStatus(housekeeping, !!stay), stay: stay ? toSummary(stay) : null };
    }),
    audit: await auditState(db, deps, now),
    counts: await roomStatusCounts(db),
  };
}

// ───────────────────────── 加锁与房费 ─────────────────────────

interface LockedRoom {
  id: number;
  roomNo: string;
  roomTypeId: number;
  housekeeping: string;
  active: boolean;
}

/** 房间按 id 升序加锁 */
async function lockRooms(tx: Tx, ids: number[]): Promise<Map<number, LockedRoom>> {
  const unique = [...new Set(ids)].sort((a, b) => a - b);
  if (unique.length === 0) return new Map();
  const rows = await tx<LockedRoom[]>`
    SELECT id, room_no, room_type_id, housekeeping, active FROM rooms WHERE id IN ${tx(unique)} ORDER BY id FOR UPDATE`;
  if (rows.length !== unique.length) throw notFound('房间不存在，请刷新后重试');
  return new Map(rows.map((r) => [r.id, r]));
}

interface LockedStay {
  id: number;
  stayNo: string;
  roomId: number;
  kind: RoomKind;
  rate: number;
  blockMinutes: number | null;
  billId: number;
  visitId: number;
  guests: number;
  status: string;
  businessDate: string;
  checkedInAt: string;
  checkedInBy: number;
}

/**
 * 入住单按 id 升序加锁（先锁房间：入住单的房间在锁房间之前读一次，锁好后核对没有换过房）。
 * 调用方已经按顺序锁好房间时（换房）传入它读到的房间，这里不再另锁房间，换过房就拒绝
 */
async function lockStays(tx: Tx, ids: number[], lockedRooms?: Map<number, number>): Promise<Map<number, LockedStay>> {
  const unique = [...new Set(ids)].sort((a, b) => a - b);
  if (unique.length === 0) return new Map();
  let roomOf = lockedRooms;
  if (!roomOf) {
    const peek = await tx<{ id: number; roomId: number }[]>`SELECT id, room_id FROM room_stays WHERE id IN ${tx(unique)}`;
    if (peek.length !== unique.length) throw notFound('入住单不存在，请刷新后重试');
    await lockRooms(tx, peek.map((p) => p.roomId));
    roomOf = new Map(peek.map((p) => [p.id, p.roomId]));
  }
  const rows = await tx<LockedStay[]>`
    SELECT id, stay_no, room_id, kind, rate, block_minutes, bill_id, visit_id, guests, status, business_date, checked_in_at, checked_in_by
    FROM room_stays WHERE id IN ${tx(unique)} ORDER BY id FOR UPDATE`;
  for (const r of rows) {
    if (r.roomId !== roomOf.get(r.id)) throw conflict('ROOM_CHANGED', `入住单 ${r.stayNo} 刚刚换过房，请刷新后重试`);
  }
  return new Map(rows.map((r) => [r.id, r]));
}

function assertStayOpen(s: LockedStay) {
  if (s.status !== 'open') {
    const what = s.status === 'checked_out' ? '已退房' : '已撤销';
    throw conflict('STAY_CLOSED', `入住单 ${s.stayNo} ${what}，不能再操作`);
  }
}

/** 已经挂过的房费（含作废过的：作废是前台有意的更正，不再补挂） */
async function chargedOf(db: Db, stayId: number) {
  const rows = await db<{ kind: string; nightDate: string | null; blockNo: number | null }[]>`
    SELECT kind, night_date, block_no FROM room_stay_charges WHERE stay_id = ${stayId}`;
  return {
    nights: new Set(rows.filter((r) => r.kind === 'night').map((r) => r.nightDate!)),
    halfDays: new Set(rows.filter((r) => r.kind === 'half_day').map((r) => r.nightDate!)),
    blocks: new Set(rows.filter((r) => r.kind === 'block').map((r) => r.blockNo!)),
  };
}

/** 此刻退房要补挂的房费 */
async function duesNow(db: Db, deps: Deps, stay: LockedStay, at: Date): Promise<RoomDue[]> {
  return roomDues(stay, await chargedOf(db, stay.id), at, await loadRoomRules(db), await roomClock(db, deps));
}

/** 挂房费：每一晚 / 每一段一条账单明细（来源「客房」），并记下是哪一晚 / 哪一段（同一晚、同一段唯一）。调用前入住单已加锁 */
async function postRoomCharges(
  tx: Tx,
  stay: { id: number; billId: number; roomNo: string },
  dues: RoomDue[],
  o: { source: 'checkin' | 'audit' | 'checkout' | 'extend'; postKey: string; actorId: number; at: Date; date: string },
): Promise<number> {
  if (dues.length === 0) return 0;
  const [bill] = await tx<{ status: string }[]>`SELECT status FROM bills WHERE id = ${stay.billId} FOR UPDATE`;
  if (bill!.status !== 'open') throw conflict('BILL_CLOSED', '房费要挂的账单已经结束，请刷新后重试');
  let total = 0;
  for (const d of dues) {
    const [line] = await tx<{ id: number }[]>`
      INSERT INTO bill_lines (bill_id, source, item_id, name, unit_price, quantity, amount, post_key, business_date, posted_by, posted_at)
      VALUES (${stay.billId}, 'room', NULL, ${chargeLineName(stay.roomNo, d)}, ${d.amount}, 1, ${d.amount}, ${o.postKey}, ${o.date}, ${o.actorId}, ${o.at})
      RETURNING id`;
    await tx`
      INSERT INTO room_stay_charges (stay_id, kind, night_date, block_no, line_id, amount, source, created_by, created_at)
      VALUES (${stay.id}, ${d.kind}, ${d.nightDate}, ${d.blockNo}, ${line!.id}, ${d.amount}, ${o.source}, ${o.actorId}, ${o.at})`;
    total += d.amount;
  }
  await tx`UPDATE bills SET amount_cents = amount_cents + ${total}, line_count = line_count + ${dues.length} WHERE id = ${stay.billId}`;
  return total;
}

/** 退回这几间房余下的押金：按原收款方式原路退（现金从经办人当班的钱箱退） */
async function refundAllDeposits(
  tx: Tx,
  stayIds: number[],
  o: { shiftId: number | null; actorId: number; date: string; at: Date; reason: string },
): Promise<{ method: PaymentMethod; amount: number }[]> {
  const balances = await depositBalances(tx, stayIds);
  const refunded = new Map<PaymentMethod, number>();
  for (const stayId of stayIds) {
    for (const [method, balance] of balances.get(stayId) ?? []) {
      if (balance <= 0) continue;
      await tx`
        INSERT INTO room_deposits (stay_id, kind, method, amount, reason, shift_id, business_date, operator_id, created_at)
        VALUES (${stayId}, 'refund', ${method}, ${balance}, ${o.reason}, ${o.shiftId}, ${o.date}, ${o.actorId}, ${o.at})`;
      refunded.set(method, (refunded.get(method) ?? 0) + balance);
    }
  }
  return [...refunded].map(([method, amount]) => ({ method, amount }));
}

const describeMethods = (list: { method: PaymentMethod; amount: number }[]) => list.map((x) => `${PAYMENT_METHOD_LABELS[x.method]} ${formatYuan(x.amount)}`).join('、');

// ───────────────────────── 入住 ─────────────────────────

const clientKey = z.uuid('缺少有效的操作编号，请刷新页面后重试');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式不正确');
const DepositFields = {
  method: z.enum(PAYMENT_METHODS, '请选择押金的收款方式'),
  amount: positiveCents('押金').max(10_000_000, '押金过大'),
  ref: z.string().trim().max(64, '收款备注最多 64 字').default(''),
};
const DepositInput = z.object(DepositFields).refine((d) => d.method !== 'other' || d.ref.length > 0, { message: '「其他」收款请在备注里写明收的是什么', path: ['ref'] });

const TAG_REQUIRED = '请填写在店客人的手牌号：住客要先在前台接待、买门票，再入住客房';

export const CheckinInput = z.object({
  clientKey,
  roomId: z.number('请选择房间').int().positive('请选择房间'),
  /** 在店客人的手牌号：住客都要先在前台接待、买门票（门票必选），房费挂在手牌账单上 */
  tagCode: z
    .string(TAG_REQUIRED)
    .transform((v) => normalizeTagCode(v))
    .pipe(z.string().min(1, TAG_REQUIRED).regex(TAG_CODE_PATTERN, '牌号格式不正确（例如 A023、1088）')),
  guestLabel: z.string().trim().max(16, '住客称呼最多 16 字').default(''),
  guests: z.number('请填写入住人数').int('人数必须是整数').min(1, '至少 1 人').max(MAX_STAY_GUESTS, `最多 ${MAX_STAY_GUESTS} 人`).default(1),
  expectedCheckoutDate: isoDate.nullish().transform((v) => v ?? null),
  /** 员工确认时看到的房价；房型刚改了价就拒绝 */
  expectedRate: positiveCents('房价'),
  deposit: DepositInput.nullish().transform((v) => v ?? null),
});

export async function checkinRoom(deps: Deps, raw: unknown, ctx: OpContext): Promise<StayDetail> {
  const input = parse(CheckinInput, raw);
  const { clientKey: key, ...payload } = input;
  const requestHash = hashRequest(payload);
  const seenShift = input.deposit ? await openShiftOf(deps.sql, ctx.actor.id) : null;
  const run = await runIdempotent(deps, { key, opType: 'room_checkin', requestHash }, async (tx) => {
    const at = ctx.at ?? new Date();
    await assertRoomsEnabled(tx);
    // ① 班次（收押金时，共享锁）→ ② 房间 → 来访 → 账单
    const shiftId = input.deposit ? await lockPaymentShift(tx, ctx.actor.id, seenShift) : null;
    const room = (await lockRooms(tx, [input.roomId])).get(input.roomId)!;
    if (!room.active) throw conflict('ROOM_INACTIVE', `房间「${room.roomNo}」已停用，请换一间`);
    const [busy] = await tx<{ stayNo: string }[]>`SELECT stay_no FROM room_stays WHERE room_id = ${room.id} AND status = 'open'`;
    if (busy) throw conflict('ROOM_TAKEN', `房间「${room.roomNo}」有人住（${busy.stayNo}），请换一间空房`);
    if (room.housekeeping !== 'clean') {
      throw conflict('ROOM_NOT_READY', `房间「${room.roomNo}」${room.housekeeping === 'dirty' ? '还没打扫' : '在维修'}，打扫好（点「已打扫」）才能入住`);
    }
    const [type] = await tx<{ kind: RoomKind; price: number; blockMinutes: number | null; active: boolean; name: string }[]>`
      SELECT kind, price, block_minutes, active, name FROM room_types WHERE id = ${room.roomTypeId}`;
    if (!type!.active) throw conflict('ROOM_TYPE_INACTIVE', `房型「${type!.name}」已停用，不能入住`);
    if (type!.price !== input.expectedRate) {
      throw conflict('PRICE_CHANGED', `房型「${type!.name}」的房价刚刚改为 ${formatYuan(type!.price)}，请核对后重新确认`, { rate: type!.price });
    }
    const date = await businessDate(tx, deps, at);
    // 房费挂在在店客人的手牌账单上
    const [peek] = await tx<{ id: number }[]>`
      SELECT v.id FROM visits v JOIN hand_tags t ON t.id = v.tag_id WHERE t.code = ${input.tagCode} AND v.status = 'open'`;
    if (!peek) throw conflict('TAG_NOT_IN_STORE', `手牌 ${input.tagCode} 没有在店客人，请核对牌号；住客要先在前台接待、买门票，再入住客房`);
    const visit = (await lockVisits(tx, [peek.id])).get(peek.id)!;
    assertOpen(visit);
    const billId = visit.billId;
    const visitId = visit.id;
    const stayNo = await nextDocNo(tx, 'room_stay', 'RZ', date);
    const [stay] = await tx<{ id: number }[]>`
      INSERT INTO room_stays (stay_no, room_id, room_type_id, kind, rate, block_minutes, bill_id, visit_id, guest_label, guests,
                              expected_checkout_date, business_date, checked_in_at, checked_in_by, open_key)
      VALUES (${stayNo}, ${room.id}, ${room.roomTypeId}, ${type!.kind}, ${type!.price}, ${type!.blockMinutes}, ${billId}, ${visitId},
              ${input.guestLabel}, ${input.guests}, ${input.expectedCheckoutDate}, ${date}, ${at}, ${ctx.actor.id}, ${key})
      RETURNING id`;
    const stayId = stay!.id;
    // 第一晚 / 第一段随入住挂上
    const first: RoomDue = type!.kind === 'daily' ? { kind: 'night', nightDate: date, blockNo: null, amount: type!.price } : { kind: 'block', nightDate: null, blockNo: 1, amount: type!.price };
    await postRoomCharges(tx, { id: stayId, billId, roomNo: room.roomNo }, [first], { source: 'checkin', postKey: key, actorId: ctx.actor.id, at, date });
    if (input.deposit) {
      await tx`
        INSERT INTO room_deposits (stay_id, kind, method, amount, ref, shift_id, business_date, operator_id, created_at)
        VALUES (${stayId}, 'receive', ${input.deposit.method}, ${input.deposit.amount}, ${input.deposit.ref}, ${shiftId}, ${date}, ${ctx.actor.id}, ${at})`;
    }
    // 实时位置（v0.7.17）：客人在那间房（房间挂了空间才记）
    await locateRoomStay(tx, visitId, room.id, stayId, 'room_checkin', { at, staffId: ctx.actor.id });
    await saveKey(tx, key, 'room_checkin', requestHash, stayId, ctx.actor.id);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'room_checkin',
      targetType: 'room_stay',
      targetId: stayId,
      detail: {
        stayNo,
        room: room.roomNo,
        rate: type!.price,
        tagCode: input.tagCode,
        guestLabel: input.guestLabel,
        guests: input.guests,
        ...(input.deposit ? { deposit: { method: input.deposit.method, amount: input.deposit.amount } } : {}),
      },
      ip: ctx.ip,
      businessDate: date,
    });
    return stayId;
  });
  return getStay(deps.sql, run.refId);
}

// ───────────────────────── 续住、换房、改登记、撤销入住 ─────────────────────────

export const ExtendInput = z.object({
  clientKey,
  /** 全天房：预计离店的营业日（只做提醒）；钟点房：加一段（马上挂上） */
  expectedCheckoutDate: isoDate.nullish().transform((v) => v ?? null),
  addBlock: z.boolean().default(false),
});

export async function extendStay(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<StayDetail> {
  const input = parse(ExtendInput, raw);
  const { clientKey: key, ...payload } = input;
  const requestHash = hashRequest({ id, ...payload });
  await runIdempotent(deps, { key, opType: 'room_extend', requestHash }, async (tx) => {
    const at = ctx.at ?? new Date();
    await assertRoomsEnabled(tx);
    const s = (await lockStays(tx, [id])).get(id)!;
    assertStayOpen(s);
    const date = await businessDate(tx, deps, at);
    const [room] = await tx<{ roomNo: string }[]>`SELECT room_no FROM rooms WHERE id = ${s.roomId}`;
    let detail: Record<string, unknown>;
    if (s.kind === 'hourly') {
      if (!input.addBlock) throw badRequest('钟点房续住是加一段，请点「加一段」');
      const charged = await chargedOf(tx, s.id);
      const blockNo = (charged.blocks.size ? Math.max(...charged.blocks) : 0) + 1;
      await postRoomCharges(tx, { id: s.id, billId: s.billId, roomNo: room!.roomNo }, [{ kind: 'block', nightDate: null, blockNo, amount: s.rate }], {
        source: 'extend',
        postKey: key,
        actorId: ctx.actor.id,
        at,
        date,
      });
      detail = { stayNo: s.stayNo, room: room!.roomNo, blockNo, amount: s.rate };
    } else {
      if (!input.expectedCheckoutDate) throw badRequest('请选择预计离店日期');
      if (input.expectedCheckoutDate < s.businessDate) throw badRequest('预计离店日期不能早于入住日期');
      await tx`UPDATE room_stays SET expected_checkout_date = ${input.expectedCheckoutDate} WHERE id = ${s.id}`;
      detail = { stayNo: s.stayNo, room: room!.roomNo, expectedCheckoutDate: input.expectedCheckoutDate };
    }
    await saveKey(tx, key, 'room_extend', requestHash, s.id, ctx.actor.id);
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'room_extend', targetType: 'room_stay', targetId: s.id, detail, ip: ctx.ip, businessDate: date });
    return s.id;
  });
  return getStay(deps.sql, id);
}

const UpdateStayInput = z.object({
  guestLabel: z.string().trim().max(16, '住客称呼最多 16 字').default(''),
  guests: z.number('请填写入住人数').int('人数必须是整数').min(1, '至少 1 人').max(MAX_STAY_GUESTS, `最多 ${MAX_STAY_GUESTS} 人`),
});

/** 改住客称呼、人数（在住；会员按手牌上登记的） */
export async function updateStay(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<StayDetail> {
  const input = parse(UpdateStayInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const s = (await lockStays(tx, [id])).get(id)!;
    assertStayOpen(s);
    await tx`UPDATE room_stays SET guest_label = ${input.guestLabel}, guests = ${input.guests} WHERE id = ${id}`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'room_update',
      targetType: 'room_stay',
      targetId: id,
      detail: { stayNo: s.stayNo, guestLabel: input.guestLabel, guests: input.guests },
      ip: ctx.ip,
      businessDate: await businessDate(tx, deps, ctx.at ?? new Date()),
    });
  });
  return getStay(deps.sql, id);
}

const MoveInput = z.object({
  toRoomId: z.number('请选择换到哪间房').int().positive('请选择换到哪间房'),
  reason: z.string('请填写换房原因').trim().min(2, '请填写换房原因（至少 2 个字）').max(100, '原因最多 100 字'),
});

/** 换房：只能换到空闲的房间；房价不变（按入住时的房价）；原房间变待打扫 */
export async function moveStay(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<StayDetail> {
  const input = parse(MoveInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const at = ctx.at ?? new Date();
    await assertRoomsEnabled(tx);
    const [peek] = await tx<{ roomId: number }[]>`SELECT room_id FROM room_stays WHERE id = ${id}`;
    if (!peek) throw notFound('入住单不存在');
    if (peek.roomId === input.toRoomId) throw badRequest('新房间与原房间相同');
    // 两间房一起按 id 升序加锁，再锁入住单；入住单在这之前被别的终端换走了就拒绝（不再去锁第三间房）
    const rooms = await lockRooms(tx, [peek.roomId, input.toRoomId]);
    const s = (await lockStays(tx, [id], new Map([[id, peek.roomId]]))).get(id)!;
    assertStayOpen(s);
    const from = rooms.get(s.roomId)!;
    const to = rooms.get(input.toRoomId)!;
    if (!to.active) throw conflict('ROOM_INACTIVE', `房间「${to.roomNo}」已停用，请换一间`);
    const [busy] = await tx<{ stayNo: string }[]>`SELECT stay_no FROM room_stays WHERE room_id = ${to.id} AND status = 'open'`;
    if (busy) throw conflict('ROOM_TAKEN', `房间「${to.roomNo}」有人住（${busy.stayNo}），请换一间空房`);
    if (to.housekeeping !== 'clean') throw conflict('ROOM_NOT_READY', `房间「${to.roomNo}」${to.housekeeping === 'dirty' ? '还没打扫' : '在维修'}，请换一间空房`);
    await tx`UPDATE room_stays SET room_id = ${to.id} WHERE id = ${id}`;
    await tx`UPDATE rooms SET housekeeping = 'dirty', maintenance_note = NULL, updated_at = now() WHERE id = ${from.id}`;
    await tx`
      INSERT INTO room_moves (stay_id, from_room_id, to_room_id, reason, operator_id, created_at)
      VALUES (${id}, ${from.id}, ${to.id}, ${input.reason}, ${ctx.actor.id}, ${at})`;
    // 实时位置（v0.7.17）：客人到新房间
    await locateRoomStay(tx, s.visitId, to.id, id, 'room_move', { at, staffId: ctx.actor.id });
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'room_move',
      targetType: 'room_stay',
      targetId: id,
      detail: { stayNo: s.stayNo, from: from.roomNo, to: to.roomNo, reason: input.reason },
      ip: ctx.ip,
      businessDate: await businessDate(tx, deps, at),
    });
  });
  return getStay(deps.sql, id);
}

const ReasonInput = z.object({ reason: z.string('请填写原因').trim().min(2, '请填写原因（至少 2 个字）').max(200, '原因最多 200 字') });

/** 撤销入住：开错房、客人没住就走。房费都作废了、押金都退了才能撤销；时限与作废明细相同 */
export async function cancelStay(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<StayDetail> {
  const { reason } = parse(ReasonInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const at = ctx.at ?? new Date();
    const s = (await lockStays(tx, [id])).get(id)!;
    assertStayOpen(s);
    const [active] = await tx<{ n: number; amount: number }[]>`
      SELECT count(*)::int AS n, coalesce(sum(l.amount), 0)::int AS amount
      FROM room_stay_charges c JOIN bill_lines l ON l.id = c.line_id WHERE c.stay_id = ${id} AND l.status = 'active'`;
    if (active!.n > 0) {
      throw conflict('ROOM_CHARGED', `这间房还有 ${active!.n} 笔房费（${formatYuan(active!.amount)}）没作废，不能撤销入住；客人住过的请退房，开错的先在前台手牌账单上作废房费`);
    }
    const balance = [...((await depositBalances(tx, [id])).get(id) ?? new Map()).values()].reduce((sum, x) => sum + x, 0);
    if (balance > 0) throw conflict('DEPOSIT_HELD', `这间房还有押金 ${formatYuan(balance)} 没退，请先退押金再撤销入住`);
    assertCanFix(ctx.actor, s.checkedInBy, s.checkedInAt, await loadFrontdeskRules(tx), at, '这次入住');
    await tx`UPDATE room_stays SET status = 'cancelled', closed_at = ${at}, closed_by = ${ctx.actor.id}, close_reason = ${reason} WHERE id = ${id}`;
    await tx`UPDATE rooms SET housekeeping = 'dirty', maintenance_note = NULL, updated_at = now() WHERE id = ${s.roomId}`;
    // 实时位置（v0.7.17）：客人离开那间房，位置不明
    await leaveRoomStay(tx, s.visitId, s.roomId, id, { at, staffId: ctx.actor.id });
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'room_cancel',
      targetType: 'room_stay',
      targetId: id,
      detail: { stayNo: s.stayNo, reason },
      ip: ctx.ip,
      businessDate: await businessDate(tx, deps, at),
    });
  });
  return getStay(deps.sql, id);
}

// ───────────────────────── 押金：收、退 ─────────────────────────

export const ReceiveDepositInput = z
  .object({ clientKey, ...DepositFields })
  .refine((d) => d.method !== 'other' || d.ref.length > 0, { message: '「其他」收款请在备注里写明收的是什么', path: ['ref'] });

export async function receiveDeposit(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<StayDetail> {
  const input = parse(ReceiveDepositInput, raw);
  const { clientKey: key, ...payload } = input;
  const requestHash = hashRequest({ id, ...payload });
  const seenShift = await openShiftOf(deps.sql, ctx.actor.id);
  await runIdempotent(deps, { key, opType: 'room_deposit', requestHash }, async (tx) => {
    const at = ctx.at ?? new Date();
    await assertRoomsEnabled(tx);
    // 先对班次加共享锁，再锁房间、入住单（与充值、结账同一班次协议）
    const shiftId = await lockPaymentShift(tx, ctx.actor.id, seenShift);
    const s = (await lockStays(tx, [id])).get(id)!;
    assertStayOpen(s);
    const date = await businessDate(tx, deps, at);
    await tx`
      INSERT INTO room_deposits (stay_id, kind, method, amount, ref, shift_id, business_date, operator_id, created_at)
      VALUES (${id}, 'receive', ${input.method}, ${input.amount}, ${input.ref}, ${shiftId}, ${date}, ${ctx.actor.id}, ${at})`;
    await saveKey(tx, key, 'room_deposit', requestHash, id, ctx.actor.id);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'room_deposit',
      targetType: 'room_stay',
      targetId: id,
      detail: { stayNo: s.stayNo, kind: 'receive', method: input.method, amount: input.amount },
      ip: ctx.ip,
      businessDate: date,
    });
    return id;
  });
  return getStay(deps.sql, id);
}

export const RefundDepositInput = z.object({
  clientKey,
  method: z.enum(PAYMENT_METHODS, '请选择退回的方式'),
  amount: positiveCents('退押金金额'),
  reason: z.string('请填写退押金原因').trim().min(2, '请填写退押金原因（至少 2 个字）').max(200, '原因最多 200 字'),
});

/** 在住期间退一部分押金：按原收款方式退，不能超过这种方式收的押金余额 */
export async function refundDeposit(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<StayDetail> {
  const input = parse(RefundDepositInput, raw);
  const { clientKey: key, ...payload } = input;
  const requestHash = hashRequest({ id, ...payload });
  const seenShift = await openShiftOf(deps.sql, ctx.actor.id);
  await runIdempotent(deps, { key, opType: 'room_refund', requestHash }, async (tx) => {
    const at = ctx.at ?? new Date();
    const shiftId = await lockPaymentShift(tx, ctx.actor.id, seenShift);
    const s = (await lockStays(tx, [id])).get(id)!;
    assertStayOpen(s);
    const balance = (await depositBalances(tx, [id])).get(id)?.get(input.method) ?? 0;
    if (input.amount > balance) {
      throw unprocessable(
        'DEPOSIT_INSUFFICIENT',
        balance > 0
          ? `${PAYMENT_METHOD_LABELS[input.method]}收的押金只剩 ${formatYuan(balance)}，最多退 ${formatYuan(balance)}`
          : `这间房没有${PAYMENT_METHOD_LABELS[input.method]}收的押金，押金按原收款方式原路退`,
        { balance },
      );
    }
    const date = await businessDate(tx, deps, at);
    await tx`
      INSERT INTO room_deposits (stay_id, kind, method, amount, reason, shift_id, business_date, operator_id, created_at)
      VALUES (${id}, 'refund', ${input.method}, ${input.amount}, ${input.reason}, ${shiftId}, ${date}, ${ctx.actor.id}, ${at})`;
    await saveKey(tx, key, 'room_refund', requestHash, id, ctx.actor.id);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'room_deposit',
      targetType: 'room_stay',
      targetId: id,
      detail: { stayNo: s.stayNo, kind: 'refund', method: input.method, amount: input.amount, reason: input.reason },
      ip: ctx.ip,
      businessDate: date,
    });
    return id;
  });
  return getStay(deps.sql, id);
}

// ───────────────────────── 退房 ─────────────────────────

/** 退房核对（只读）：此刻要补的房费、账单合计与押金 */
export async function previewStayCheckout(deps: Deps, id: number, at = new Date()): Promise<StayCheckoutPreview> {
  return deps.sql.begin('isolation level repeatable read read only', async (tx) => {
    const [s] = await tx<LockedStay[]>`
      SELECT id, stay_no, room_id, kind, rate, block_minutes, bill_id, visit_id, guests, status, business_date, checked_in_at, checked_in_by
      FROM room_stays WHERE id = ${id}`;
    if (!s) throw notFound('入住单不存在');
    assertStayOpen(s);
    const dues = await duesNow(tx, deps, s, at);
    const [bill] = await tx<{ amount: number }[]>`SELECT amount_cents AS amount FROM bills WHERE id = ${s.billId}`;
    const balances = await depositBalances(tx, [id]);
    const dueAmount = dues.reduce((sum, d) => sum + d.amount, 0);
    const byMethod = byMethodList(balances.get(id));
    return {
      stayId: id,
      at: at.toISOString(),
      dues,
      dueAmount,
      billAmount: bill!.amount,
      depositBalance: byMethod.reduce((sum, x) => sum + x.balance, 0),
      depositByMethod: byMethod,
    };
  });
}

export const CloseStayInput = z.object({
  clientKey,
  /** 员工确认时看到的要补的房费合计；过了退房时间等变化时拒绝，重新核对 */
  expectedDue: cents('要补的房费'),
  /** 员工确认时看到的押金余额（按收款方式），退房按它原路退；其他终端刚收、退过押金时拒绝，重新核对 */
  expectedDeposits: z
    .array(z.object({ method: z.enum(PAYMENT_METHODS, '押金的收款方式不正确'), balance: cents('押金余额') }), '请核对要退的押金')
    .max(PAYMENT_METHODS.length, '押金的收款方式重复')
    .refine((list) => new Set(list.map((d) => d.method)).size === list.length, '押金的收款方式重复'),
});

/** 退房：补齐房费（挂在手牌账单上，随手牌结账）、押金全部原路退回、房间变待打扫 */
export async function closeStay(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<StayDetail> {
  const input = parse(CloseStayInput, raw);
  const { clientKey: key, ...payload } = input;
  const requestHash = hashRequest({ id, ...payload });
  const seenShift = await openShiftOf(deps.sql, ctx.actor.id);
  const expected = new Map(input.expectedDeposits.filter((d) => d.balance > 0).map((d) => [d.method, d.balance] as const));
  await runIdempotent(deps, { key, opType: 'room_close', requestHash }, async (tx) => {
    const at = ctx.at ?? new Date();
    // 员工确认时有押金要退：先对班次加共享锁（退现金记在经办人当班的钱箱）；押金都退完了的不用开班
    const shiftId = expected.size > 0 ? await lockPaymentShift(tx, ctx.actor.id, seenShift) : null;
    const s = (await lockStays(tx, [id])).get(id)!;
    assertStayOpen(s);
    const visit = (await lockVisits(tx, [s.visitId])).get(s.visitId)!;
    assertOpen(visit);
    const dues = await duesNow(tx, deps, s, at);
    const dueAmount = dues.reduce((sum, d) => sum + d.amount, 0);
    if (dueAmount !== input.expectedDue) {
      throw conflict('ROOM_DUE_CHANGED', `要补的房费刚刚变为 ${formatYuan(dueAmount)}（可能刚过了退房时间），请核对后重新确认`, { dueAmount });
    }
    // 收、退押金都要锁入住单，锁好后余额不会再变：与员工看到的逐项核对，退的就是员工交给客人的
    const balances = (await depositBalances(tx, [id])).get(id) ?? new Map<PaymentMethod, number>();
    const methods = new Set([...balances.keys(), ...expected.keys()]);
    if ([...methods].some((m) => (balances.get(m) ?? 0) !== (expected.get(m) ?? 0))) {
      const now = byMethodList(balances).map((x) => ({ method: x.method, amount: x.balance }));
      throw conflict(
        'DEPOSIT_CHANGED',
        `押金刚刚有变动（其他终端刚收或退过），现在${now.length ? `是 ${describeMethods(now)}` : '没有押金'}，请核对后重新确认退房`,
        { depositByMethod: byMethodList(balances) },
      );
    }
    const date = await businessDate(tx, deps, at);
    const [room] = await tx<{ roomNo: string }[]>`SELECT room_no FROM rooms WHERE id = ${s.roomId}`;
    await postRoomCharges(tx, { id: s.id, billId: s.billId, roomNo: room!.roomNo }, dues, { source: 'checkout', postKey: key, actorId: ctx.actor.id, at, date });
    const refunded = await refundAllDeposits(tx, [id], { shiftId, actorId: ctx.actor.id, date, at, reason: '退房，押金原路退回' });
    await tx`UPDATE room_stays SET status = 'checked_out', closed_at = ${at}, closed_by = ${ctx.actor.id} WHERE id = ${id}`;
    await tx`UPDATE rooms SET housekeeping = 'dirty', maintenance_note = NULL, updated_at = now() WHERE id = ${s.roomId}`;
    // 实时位置（v0.7.17）：客人离开那间房，位置不明
    await leaveRoomStay(tx, s.visitId, s.roomId, id, { at, staffId: ctx.actor.id });
    await saveKey(tx, key, 'room_close', requestHash, id, ctx.actor.id);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'room_close',
      targetType: 'room_stay',
      targetId: id,
      detail: { stayNo: s.stayNo, room: room!.roomNo, dueAmount, ...(refunded.length ? { refunded: describeMethods(refunded) } : {}) },
      ip: ctx.ip,
      businessDate: date,
    });
    return id;
  });
  return getStay(deps.sql, id);
}

// ───────────────────────── 打扫、维修 ─────────────────────────

const HousekeepingInput = z.object({
  status: z.enum(HOUSEKEEPING_STATES, '请选择房态'),
  note: z.string().trim().max(100, '维修原因最多 100 字').nullish().transform((v) => v || null),
});

export async function setHousekeeping(deps: Deps, roomId: number, raw: unknown, ctx: OpContext) {
  const input = parse(HousekeepingInput, raw);
  if (input.status === 'maintenance' && (!input.note || input.note.length < 2)) throw badRequest('请填写维修原因（至少 2 个字）');
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const room = (await lockRooms(tx, [roomId])).get(roomId)!;
    if (input.status === 'maintenance') {
      const [busy] = await tx<{ stayNo: string }[]>`SELECT stay_no FROM room_stays WHERE room_id = ${roomId} AND status = 'open'`;
      if (busy) throw conflict('ROOM_IN_USE', `房间「${room.roomNo}」有人住（${busy.stayNo}），换房或退房后再设为维修`);
    }
    await tx`
      UPDATE rooms SET housekeeping = ${input.status}, maintenance_note = ${input.status === 'maintenance' ? input.note : null}, updated_at = now()
      WHERE id = ${roomId}`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'room_housekeeping',
      targetType: 'room',
      targetId: roomId,
      detail: { room: room.roomNo, from: room.housekeeping, to: input.status, ...(input.note ? { note: input.note } : {}) },
      ip: ctx.ip,
      businessDate: await businessDate(tx, deps, ctx.at ?? new Date()),
    });
  });
}

// ───────────────────────── 夜审 ─────────────────────────

/** 夜审：给在住的全天房挂到今晚为止还没挂的房费（同一晚只挂一次，可以重复做），出夜审报告 */
export async function runNightAudit(deps: Deps, ctx: OpContext): Promise<RoomAuditReport> {
  const at = ctx.at ?? new Date();
  const result = await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    await assertRoomsEnabled(tx);
    const rules = await loadRoomRules(tx);
    const clock = await roomClock(tx, deps);
    const date = businessDateOf(at, clock.timeZone, clock.startHour);
    const cutoff = localMinuteAt(date, rules.lateFullMinute, clock.timeZone);
    if (at.getTime() < cutoff.getTime()) {
      throw unprocessable('AUDIT_TOO_EARLY', `今天的夜审要在 ${hhmm(rules.lateFullMinute)} 以后做（这时还在住的客人要付今晚的房费）`);
    }
    const open = await tx<{ id: number }[]>`SELECT id FROM room_stays WHERE status = 'open' AND kind = 'daily' ORDER BY id`;
    const stays = await lockStays(tx, open.map((s) => s.id));
    const postKey = randomUUID();
    const posted: RoomAuditReport['posted'] = [];
    for (const s of [...stays.values()].sort((a, b) => a.id - b.id)) {
      if (s.status !== 'open') continue;
      const dues = (await duesNow(tx, deps, s, at)).filter((d) => d.kind === 'night');
      if (dues.length === 0) continue;
      const [room] = await tx<{ roomNo: string }[]>`SELECT room_no FROM rooms WHERE id = ${s.roomId}`;
      await postRoomCharges(tx, { id: s.id, billId: s.billId, roomNo: room!.roomNo }, dues, { source: 'audit', postKey, actorId: ctx.actor.id, at, date });
      for (const d of dues) posted.push({ stayNo: s.stayNo, roomNo: room!.roomNo, nightDate: d.nightDate!, amount: d.amount });
    }
    const amount = posted.reduce((sum, p) => sum + p.amount, 0);
    await tx`INSERT INTO room_audits (business_date, nights, amount, run_by, run_at) VALUES (${date}, ${posted.length}, ${amount}, ${ctx.actor.id}, ${at})`;
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'room_audit',
      targetType: 'room_audit',
      targetId: date,
      detail: { date, nights: posted.length, amount },
      ip: ctx.ip,
      businessDate: date,
    });
    return { date, posted, amount };
  });
  const db = deps.sql;
  const open = await db<StayRow[]>`${staySelect(db)} WHERE s.status = 'open' ORDER BY r.floor, r.sort_order, r.room_no`;
  return {
    date: result.date,
    runAt: at.toISOString(),
    runByName: ctx.actor.displayName,
    posted: result.posted,
    postedAmount: result.amount,
    stays: open.map((s) => ({ ...toSummary(s), roomNo: s.roomNo })),
    depositBalance: open.reduce((sum, s) => sum + s.depositBalance, 0),
    counts: await roomStatusCounts(db),
  };
}

// ───────────────────────── 路由 ─────────────────────────

export function registerRoomRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const ctxOf = (req: FastifyRequest): OpContext => ({ actor: req.actor, ip: req.ip });

  // 后台「客房」：规则（店主）、房型与房间（能管理价目的岗位）
  app.get('/api/admin/rooms', { preHandler: guardAny('settings.manage', 'catalog.manage') }, async () => roomsAdmin(sql));
  app.put('/api/admin/rooms/rules', { preHandler: guard('settings.manage') }, async (req) => {
    await saveRoomRules(deps, req.body, ctxOf(req));
    return roomsAdmin(sql);
  });
  app.post('/api/admin/rooms/types', { preHandler: guard('catalog.manage') }, async (req) => {
    await saveRoomType(deps, null, req.body, ctxOf(req));
    return roomsAdmin(sql);
  });
  app.put('/api/admin/rooms/types/:id', { preHandler: guard('catalog.manage') }, async (req) => {
    await saveRoomType(deps, parse(idParam, req.params).id, req.body, ctxOf(req));
    return roomsAdmin(sql);
  });
  app.post('/api/admin/rooms/rooms', { preHandler: guard('catalog.manage') }, async (req) => {
    await saveRoom(deps, null, req.body, ctxOf(req));
    return roomsAdmin(sql);
  });
  app.put('/api/admin/rooms/rooms/:id', { preHandler: guard('catalog.manage') }, async (req) => {
    await saveRoom(deps, parse(idParam, req.params).id, req.body, ctxOf(req));
    return roomsAdmin(sql);
  });

  // 房态看板与入住单：前台、客房服务员、收银都要看
  const readGuard = guardAny('room.operate', 'room.housekeep', 'frontdesk.checkout');
  app.get('/api/rooms', { preHandler: readGuard }, async () => roomsBoard(deps));
  app.get('/api/rooms/stays/:id', { preHandler: guardAny('room.operate', 'frontdesk.checkout') }, async (req) => getStay(sql, parse(idParam, req.params).id));
  app.get('/api/rooms/stays/:id/checkout-preview', { preHandler: guardAny('room.operate', 'frontdesk.checkout') }, async (req) =>
    previewStayCheckout(deps, parse(idParam, req.params).id),
  );

  // 入住、续住、改登记、换房、押金、退房、撤销入住、夜审
  const opGuard = guard('room.operate');
  app.post('/api/rooms/checkin', { preHandler: opGuard }, async (req) => checkinRoom(deps, req.body, ctxOf(req)));
  app.post('/api/rooms/stays/:id/extend', { preHandler: opGuard }, async (req) => extendStay(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  app.put('/api/rooms/stays/:id', { preHandler: opGuard }, async (req) => updateStay(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  app.post('/api/rooms/stays/:id/move', { preHandler: opGuard }, async (req) => moveStay(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  app.post('/api/rooms/stays/:id/deposits', { preHandler: opGuard }, async (req) => receiveDeposit(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  app.post('/api/rooms/stays/:id/refunds', { preHandler: opGuard }, async (req) => refundDeposit(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  app.post('/api/rooms/stays/:id/close', { preHandler: opGuard }, async (req) => closeStay(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  app.post('/api/rooms/stays/:id/cancel', { preHandler: opGuard }, async (req) => cancelStay(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  app.post('/api/rooms/audit', { preHandler: opGuard }, async (req) => runNightAudit(deps, ctxOf(req)));

  // 打扫、维修：前台与客房服务员（后勤）
  app.put('/api/rooms/:id/housekeeping', { preHandler: guard('room.housekeep') }, async (req) => {
    await setHousekeeping(deps, parse(idParam, req.params).id, req.body, ctxOf(req));
    return roomsBoard(deps);
  });
}
