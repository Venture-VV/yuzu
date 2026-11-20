// 房态中心（8.1.15，docs/ROOM_CENTER_V8115.md）的写操作：登记、续钟、换房、退房、并房 / 拆并、维修 / 恢复、标待清 / 清洁完成，
// 以及从房态中心给派对房开单。钱只走原来的路：登记、续钟都是前台挂账（frontdesk/bills.ts 的 postChargesTx，同一个事务里建钟单、派技师），
// 派对房开单是使用单（usages.ts 的 openUsageTx），这里不另写一遍金额、技师、幂等的核对。
//
// 加锁顺序（写进 docs/LOCKING.md 第 1 节）：先锁房态行（space_room_states，id 升序；并房的几间一起锁），之后照各模块原来的顺序——
//   · 登记、续钟：房态行 → 来访 → 账单 → 技师队列 → 空间一行（共享锁）→ 钟单 → 技师状态 → 技师预约咨询锁 → 当前位置；之后只插入登记单与事件；
//   · 派对房开单：房态行 → 来访（共享锁）→ 空间一行（FOR NO KEY UPDATE）→ 当前位置；
//   · 换房：两间房的房态行 → 钟单一行（id 升序）→ 新房间的空间一行（共享锁）→ 当前位置 → 登记单；
//   · 退房：房态行 → 登记单（id 升序）；读账单、钟单不加锁；
//   · 维修：房态行 → 空间一行（FOR NO KEY UPDATE，与派钟、换房间、开单的空间锁排队）；恢复、标待清、清洁完成、并房、拆并只锁房态行。
// 别的模块不锁房态行（钟房、使用单只读它上面的「维修」），结账、撤销来访在各自的锁之后锁登记单——都没有反过来的路径。
// 登记、续钟记成「挂账」的操作编号（bill_post），派对房开单记成 usage_open；换房、退房、并房、拆并记成 space_dispatch，
// 维修、恢复、标待清、清洁完成记成 space_state（8.1.16，迁移 193）：超时、断网以后都照前台的「结果待确认」查回、原样重提或确认作废。
// 这八样另外带页面看到的房态版本号（每次写操作加一），是第二道核对：两个人同时点、带着旧状态重做的，对不上就拒绝。

import { z } from 'zod';
import { PRICE_TIER_LABELS, PRICE_TIERS } from '@shared/catalog';
import { normalizeTagCode, TAG_CODE_PATTERN } from '@shared/frontdesk';
import { formatYuan } from '@shared/money';
import {
  MAX_MAINTENANCE_DAYS,
  MAX_MAINTENANCE_REASON,
  MAX_ROOM_NOTE,
  MAX_SELLER_NO,
  MAX_START_BACKDATE_MINUTES,
  roomKindOf,
  type RoomActionResult,
  type RoomCheckoutPreview,
  type RoomEventKind,
  type RoomSellerLookup,
  type RoomSource,
} from '@shared/room-center';
import { CALL_TYPE_LABELS, CALL_TYPES } from '@shared/technicians';
import type { UsageDetail } from '@shared/usages';
import type { Db, Tx } from '../db';
import { writeAudit } from '../lib/audit';
import type { Deps, OpContext } from '../lib/context';
import { conflict, notFound, unprocessable } from '../lib/errors';
import { currentStoreId } from '../lib/store-context';
import { parse, positiveCents } from '../lib/validate';
import { extensionLine, lockServiceSpace, setSessionSpaceTx } from './clockroom';
import { PostInput, postChargesTx } from './frontdesk/bills';
import { businessDate, hashRequest, runIdempotent, saveKey } from './frontdesk/common';
import {
  assertRoomVersion,
  bumpRoomVersion,
  guestName,
  loadRoomFacts,
  lockRoomStates,
  logRoomEvent,
  mergePartners,
  roomLabel,
  statusOfFacts,
  type GuestFact,
  type RoomFacts,
  type RoomStatusFacts,
} from './room-center-core';
import { getUsage, loadUsageRules, OpenUsageInput, openUsageTx } from './usages';

const clientKey = z.uuid('缺少有效的操作编号，请刷新页面后重试');
const expectedVersion = z.number('缺少房态版本号，请刷新页面后重试').int().min(0);

interface Opened {
  facts: Map<number, RoomFacts>;
  versions: Map<number, { version: number; mergedInto: number | null; maintenance: boolean }>;
  usageTypes: string[];
}

/**
 * 写操作的开头：锁住这几间房的房态行（连同它们并房的伙伴，id 升序），再读一次这些房间的事实。
 * 加锁之前先看一眼并房的伙伴；锁住以后再看一眼，多出来没锁到的（刚好有人并房）让页面刷新重来。
 */
async function openRooms(tx: Tx, today: string, primary: number[]): Promise<Opened> {
  const ids = new Set(primary);
  for (const id of primary) for (const p of await mergePartners(tx, id)) ids.add(p);
  const versions = await lockRoomStates(tx, [...ids]);
  for (const id of primary) {
    for (const p of await mergePartners(tx, id)) if (!versions.has(p)) throw conflict('ROOM_STATE_MOVED', '房间的并房关系刚刚变了，请刷新后再操作');
  }
  const facts = await loadRoomFacts(tx, today, [...versions.keys()]);
  return { facts, versions, usageTypes: (await loadUsageRules(tx)).businessTypes };
}

function roomOf(o: Opened, spaceId: number): { room: RoomFacts; st: RoomStatusFacts; kind: RoomSource; label: string; version: number } {
  const room = o.facts.get(spaceId);
  if (!room) throw notFound('房间不存在，请刷新后重试');
  return { room, st: statusOfFacts(room), kind: roomKindOf(room.space.businessType, o.usageTypes), label: roomLabel(room.space), version: o.versions.get(spaceId)!.version };
}

const HOTEL_ELSEWHERE = '客房的入住、退房与房态在客房的入住单、「改房态」里办（房态中心的客房卡片会打开它们）';

/** 能不能开这间房（登记、开单、换进来）：维修、待清的不行；有人用着的不行（同房加人除外） */
function assertOpenable(x: { room: RoomFacts; st: RoomStatusFacts; label: string }, join: boolean) {
  const { room, st, label } = x;
  if (!room.space.active || !room.space.sellable) throw conflict('SPACE_INACTIVE', `${label} 在空间台账里停用或不可售，请换一间`);
  if (room.state?.maintenance) throw conflict('ROOM_MAINTENANCE', `${label} 在维修（${room.state.maintenanceReason ?? ''}），恢复以后才能用，请换一间`);
  if (st.inUse) {
    if (join) return;
    const who = room.guests.map((g) => g.visit.tagCode).join('、');
    throw conflict('ROOM_IN_USE', `${label} 正在用${who ? `（手牌 ${who}）` : ''}，请换一间；同一间房再加一位客人，点开这间房用「同房加人」`);
  }
  if (st.dirty) throw conflict('ROOM_DIRTY', `${label} 待清，点「清洁完成」以后才能用`);
}

const tagsOf = (guests: GuestFact[]) => guests.map((g) => g.visit.tagCode);

// ───────────────────────── 房间动作的操作编号（8.1.16） ─────────────────────────

/** 房间动作的两类操作编号：改房态（维修、恢复、标待清、清洁完成）、调度（换房、退房、并房、拆并）——作废时按各自的权限 */
type RoomOp = 'space_state' | 'space_dispatch';

/**
 * 换房、退房、并房、拆并、维修、恢复、标待清、清洁完成：带操作编号，照前台的「结果待确认」——同一个编号原样重提返回第一次的结果、
 * 不再做一遍（两次几乎同时到的，后到的那次撞上版本号以后也按编号查回）；换了内容拒绝；确认作废以后原请求再到整笔不做
 * （saveKey 写编号前在编号的咨询锁里核对作废登记，作废先登记的整笔回滚）。编号记在 idempotency_keys，ref_id 是这一步记下的
 * 第一条房间事件。房态版本号照旧在 body 里核对，是第二道。
 */
async function runRoomOp(deps: Deps, ctx: OpContext, opts: { key: string; opType: RoomOp; requestHash: string }, body: (tx: Tx, at: Date, today: string) => Promise<number>) {
  await runIdempotent(deps, opts, async (tx) => {
    const at = ctx.at ?? new Date();
    const eventId = await body(tx, at, await businessDate(tx, deps, at));
    await saveKey(tx, opts.key, opts.opType, opts.requestHash, eventId, ctx.actor.id);
    return eventId;
  });
}

/** 「结果待确认」按编号查回（frontdesk/visits.ts 的 lookupFrontdeskOp）：编号记下的那一条房间事件 */
export async function roomActionOf(db: Db, eventId: number): Promise<RoomActionResult> {
  const [e] = await db<{ id: number; spaceId: number; kind: RoomEventKind; createdAt: string }[]>`
    SELECT id, space_id, kind, created_at FROM space_room_events WHERE id = ${eventId}`;
  if (!e) throw notFound('这条房间记录不存在');
  return { eventId: Number(e.id), spaceId: Number(e.spaceId), kind: e.kind, at: new Date(e.createdAt).toISOString(), replayed: true };
}

// ───────────────────────── 出单员 ─────────────────────────

/**
 * 出单员的工号：先找员工名单（柚子饭堂的全员名单，在职的）里的工号，没有再按系统账号的登录名找（都不分大小写）。
 * 找不到拒绝——工号写错了登记不上，不会记成一个不存在的人。
 */
export async function findSeller(db: Db, no: string): Promise<RoomSellerLookup> {
  const key = no.trim();
  if (!key) throw unprocessable('SELLER_REQUIRED', '请填写出单员的工号');
  const [emp] = await db<{ empNo: string; name: string }[]>`SELECT emp_no, name FROM canteen_employees WHERE emp_no = upper(${key}) AND active`;
  if (emp) return { no: emp.empNo, name: emp.name };
  const [st] = await db<{ username: string; displayName: string }[]>`
    SELECT username, display_name FROM staff WHERE username = lower(${key}) AND active AND NOT system`;
  if (st) return { no: st.username, name: st.displayName };
  throw unprocessable('SELLER_NOT_FOUND', `没有工号「${key}」的在职员工：出单员填员工名单里的工号，或系统账号的登录名`);
}

// ───────────────────────── 登记 ─────────────────────────

export const RegisterInput = z
  .object({
    clientKey,
    tagCode: z
      .string('请填写手牌号')
      .transform((v) => normalizeTagCode(v))
      .pipe(z.string().min(1, '请填写手牌号').regex(TAG_CODE_PATTERN, '牌号格式不正确（例如 A023、1088）')),
    itemId: z.number('请选择项目').int().positive('请选择项目'),
    /** 档次（价格档）；价格跟技师等级时不带，按技师的等级定 */
    tier: z.enum(PRICE_TIERS, '档次不正确').optional(),
    quantity: z.number('请填写钟数').int('钟数要是整数').min(1, '钟数至少为 1').max(9, '一次最多 9 个钟').default(1),
    technicianId: z.number('请选择技师').int().positive('请选择技师'),
    callType: z.enum(CALL_TYPES, '上钟方式应为点钟或轮钟'),
    skipReason: z.string().trim().max(100, '原因最多 100 字').optional(),
    sellerNo: z.string('请填写出单员的工号').trim().min(1, '请填写出单员的工号').max(MAX_SELLER_NO, `工号最多 ${MAX_SELLER_NO} 位`),
    note: z.string().trim().max(MAX_ROOM_NOTE, `备注最多 ${MAX_ROOM_NOTE} 字`).default(''),
    /** 开始时间：现在开始 / 已经开始了（补记几点开始的）/ 稍后上钟（先占房，技师到了再点上钟） */
    start: z.enum(['now', 'at', 'later'], '请选择开始时间'),
    startedAt: z.iso.datetime({ offset: true, message: '开始时间不正确' }).optional(),
    /** 同房加人：这间房已经有客人，再登记一位 */
    join: z.boolean().default(false),
    expectedTotal: positiveCents('本次合计'),
  })
  .refine((v) => v.start !== 'at' || !!v.startedAt, '已经开始了的，请填写几点开始的');

/** 这位客人已经登记在别的房间：一位客人同时只登记在一间房 */
async function assertNotRegistered(db: Db, visitId: number, tagCode: string) {
  const [r] = await db<{ code: string; displayName: string }[]>`
    SELECT sp.code, sp.display_name FROM room_registrations r JOIN spaces sp ON sp.id = r.space_id WHERE r.visit_id = ${visitId} AND r.status = 'open'`;
  if (r) throw conflict('GUEST_REGISTERED', `手牌 ${tagCode} 的客人还登记在 ${roomLabel(r)}：先在那间房退房，或用「换房」换过来`);
}

/**
 * 卡片式登记（技师服务的房间）：挂账 + 派钟 + 占房在一个事务里。
 * 挂账、建钟单、核对技师与价格、写操作编号都由 postChargesTx 做（与钟房派钟同一条路）；这里在它前面锁房态行、核对房间能不能开，
 * 在它后面补记开始时间、写登记单与房间事件。任何一步不过整笔回滚：不会挂了账没占房，也不会占了房没挂账。
 */
export async function registerRoom(deps: Deps, spaceId: number, raw: unknown, ctx: OpContext): Promise<void> {
  const input = parse(RegisterInput, raw);
  const { clientKey: key, ...payload } = input;
  const requestHash = hashRequest({ op: 'room_register', spaceId, ...payload });
  await runIdempotent(deps, { key, opType: 'bill_post', requestHash }, async (tx) => {
    const at = ctx.at ?? new Date();
    const today = await businessDate(tx, deps, at);
    const opened = await openRooms(tx, today, [spaceId]);
    const x = roomOf(opened, spaceId);
    if (x.kind !== 'service') {
      throw unprocessable('ROOM_NOT_SERVICE', x.kind === 'hotel' ? HOTEL_ELSEWHERE : `${x.label} 是「${x.room.space.businessType}」，不是技师服务的房间，不能这样登记`);
    }
    assertOpenable(x, input.join);
    const seller = await findSeller(tx, input.sellerNo);
    const [guest] = await tx<{ id: number; checkedInAt: string }[]>`
      SELECT v.id, v.checked_in_at FROM visits v JOIN hand_tags t ON t.id = v.tag_id
      WHERE t.code = ${input.tagCode} AND v.status = 'open' AND t.store_id = ${currentStoreId()}`;
    if (!guest) throw conflict('TAG_NOT_IN_STORE', `手牌 ${input.tagCode} 没有在店客人，请核对牌号；客人要先在发卡台接待、领手牌`);
    const visitId = Number(guest.id);
    await assertNotRegistered(tx, visitId, input.tagCode);
    // 开始时间（补记的）：不用查库的几条先核对
    const startedAt = input.start === 'at' ? new Date(input.startedAt!) : null;
    if (startedAt) {
      if (startedAt.getTime() > at.getTime() + 60_000) throw unprocessable('START_IN_FUTURE', '开始时间比现在还晚：还没开始的请选「稍后上钟」');
      if (startedAt.getTime() < at.getTime() - MAX_START_BACKDATE_MINUTES * 60_000) {
        throw unprocessable('START_TOO_EARLY', `开始时间最多补记到 ${MAX_START_BACKDATE_MINUTES} 分钟以前，再早的请按实际情况处理（补录纸质单在发卡台）`);
      }
      if (startedAt.getTime() < new Date(guest.checkedInAt).getTime()) throw unprocessable('START_BEFORE_CHECKIN', '开始时间比这位客人入场还早，请核对');
    }

    // 挂账 + 派钟（来访 → 账单 → 技师队列 → 空间一行 → 钟单 → 技师状态 → 位置；操作编号也在这里写下）
    const posted = await postChargesTx(
      tx,
      deps,
      visitId,
      parse(PostInput, {
        clientKey: key,
        lines: [{ itemId: input.itemId, quantity: input.quantity, tier: input.tier, technicianId: input.technicianId, callType: input.callType }],
        expectedTotal: input.expectedTotal,
      }),
      { key, requestHash, backfill: null },
      ctx,
      { session: { dispatch: { startNow: input.start !== 'later', skipReason: input.skipReason, spaceId } } },
    );
    const line = posted.lines[0]!;
    const [s] = await tx<{ id: number; sessionNo: string; status: string; technicianId: number; techNo: string; techName: string; tier: keyof typeof PRICE_TIER_LABELS | null }[]>`
      SELECT s.id, s.session_no, s.status, s.technician_id, t.tech_no, t.name AS tech_name, l.tier
      FROM bill_lines l JOIN technician_sessions s ON s.id = l.session_id JOIN technicians t ON t.id = s.technician_id WHERE l.id = ${line.lineId}`;
    if (!s) throw unprocessable('TECHNICIAN_REQUIRED', `「${line.name}」不是需要技师的项目，不能在房态中心登记（请到发卡台挂账）`);
    const sessionId = Number(s.id);
    const techLabel = `${s.techNo} 号 ${s.techName}`;
    // 这时技师队列锁在手里（派钟时拿的）：钟房同时把别的客人派进了这间房的，这里看得到
    if (!input.join) {
      const [other] = await tx<{ tagCode: string }[]>`
        SELECT h.code AS tag_code FROM technician_sessions o JOIN visits v ON v.id = o.visit_id JOIN hand_tags h ON h.id = v.tag_id
        WHERE o.space_id = ${spaceId} AND o.status IN ('waiting', 'serving') AND v.status = 'open' AND o.visit_id <> ${visitId} LIMIT 1`;
      if (other) throw conflict('ROOM_IN_USE', `${x.label} 刚刚被钟房派进了手牌 ${other.tagCode} 的客人，请换一间，或用「同房加人」`);
    }
    // 来访已经锁住：再核对一次没登记在别的房间（部分唯一索引兜底）
    await assertNotRegistered(tx, visitId, input.tagCode);
    if (startedAt) {
      if (s.status !== 'serving') throw conflict('START_NOT_SERVING', `${techLabel}还在别的钟上，这一钟要等钟，不能补记开始时间；请选「现在开始」或「稍后上钟」`);
      const [prev] = await tx<{ endedAt: string | null }[]>`
        SELECT max(ended_at) AS ended_at FROM technician_sessions WHERE technician_id = ${s.technicianId} AND id <> ${sessionId} AND status IN ('done', 'rejected')`;
      if (prev?.endedAt && new Date(prev.endedAt).getTime() > startedAt.getTime()) {
        throw unprocessable('START_OVERLAP', `${techLabel}的上一个钟在这个时间以后才下钟，开始时间不能比它早`);
      }
      await tx`UPDATE technician_sessions SET started_at = ${new Date(Math.min(startedAt.getTime(), at.getTime()))} WHERE id = ${sessionId} AND status = 'serving'`;
    }
    const [reg] = await tx<{ id: number }[]>`
      INSERT INTO room_registrations (space_id, visit_id, session_id, seller_no, seller_name, note, opened_at, opened_by, open_key)
      VALUES (${spaceId}, ${visitId}, ${sessionId}, ${seller.no}, ${seller.name}, ${input.note}, ${at}, ${ctx.actor.id}, ${key})
      RETURNING id`;
    await bumpRoomVersion(tx, [spaceId], ctx.actor.id, at);
    const detail = {
      room: x.label,
      tag: input.tagCode,
      item: line.name,
      tier: s.tier ? PRICE_TIER_LABELS[s.tier] : null,
      clocks: input.quantity,
      technician: `${techLabel}（${CALL_TYPE_LABELS[input.callType]}）`,
      seller: `${seller.no} ${seller.name}`,
      amount: posted.total,
      sessionNo: s.sessionNo,
      start: input.start,
      ...(startedAt ? { startedAt: startedAt.toISOString() } : {}),
      ...(input.note ? { note: input.note } : {}),
      ...(input.join ? { join: true } : {}),
    };
    await logRoomEvent(tx, { spaceId, kind: 'register', registrationId: Number(reg!.id), detail, staffId: ctx.actor.id, at });
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'room_center_register', targetType: 'space', targetId: spaceId, detail, ip: ctx.ip, businessDate: today });
    return visitId;
  });
}

// ───────────────────────── 续钟 ─────────────────────────

export const RoomExtendInput = z.object({
  clientKey,
  sessionId: z.number('请选择续哪一张钟').int().positive(),
  quantity: z.number('请填写钟数').int('钟数要是整数').min(1, '续钟至少 1 个').max(9, '一次最多续 9 个钟'),
  expectedTotal: positiveCents('本次合计'),
});

/** 续钟：就是钟房的加钟（按这张钟单的项目与档次加收、钟数与计划时长累加），多记一条房间事件 */
export async function extendRoom(deps: Deps, spaceId: number, raw: unknown, ctx: OpContext): Promise<void> {
  const input = parse(RoomExtendInput, raw);
  const { clientKey: key, ...payload } = input;
  const requestHash = hashRequest({ op: 'room_extend', spaceId, ...payload });
  await runIdempotent(deps, { key, opType: 'bill_post', requestHash }, async (tx) => {
    const at = ctx.at ?? new Date();
    const today = await businessDate(tx, deps, at);
    const x = roomOf(await openRooms(tx, today, [spaceId]), spaceId);
    const guest = x.room.guests.find((g) => g.sessions.some((s) => Number(s.id) === input.sessionId));
    const s = guest?.sessions.find((it) => Number(it.id) === input.sessionId);
    if (!guest || !s) throw conflict('SESSION_NOT_IN_ROOM', `这张钟单不在 ${x.label}（可能刚换了房或已经退房），请刷新`);
    const ext = await extensionLine(tx, input.sessionId, input.quantity);
    const posted = await postChargesTx(tx, deps, ext.visitId, parse(PostInput, { clientKey: key, lines: [ext.line], expectedTotal: input.expectedTotal }), { key, requestHash, backfill: null }, ctx, {
      session: { extendId: input.sessionId },
    });
    await bumpRoomVersion(tx, [spaceId], ctx.actor.id, at);
    const detail = { room: x.label, tag: guest.visit.tagCode, item: s.itemName, technician: `${s.techNo} 号 ${s.techName}`, clocks: input.quantity, amount: posted.total, sessionNo: s.sessionNo };
    await logRoomEvent(tx, { spaceId, kind: 'extend', registrationId: guest.registration ? Number(guest.registration.id) : null, detail, staffId: ctx.actor.id, at });
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'room_center_extend', targetType: 'space', targetId: spaceId, detail, ip: ctx.ip, businessDate: today });
    return ext.visitId;
  });
}

// ───────────────────────── 派对房等：从房态中心开单 ─────────────────────────

/**
 * 开单（使用单）：与平面图、派对房看板上的开单是同一张单、同一个操作编号类型，多一步——先锁房态行，待清、维修、有人用着的不开。
 * 摘要与 usages.ts 的 openUsage 算法一样（同一个编号从哪边重提都认得）。
 */
export async function openRoomUsage(deps: Deps, spaceId: number, raw: unknown, ctx: OpContext): Promise<UsageDetail> {
  const input = parse(OpenUsageInput, { ...(raw && typeof raw === 'object' ? raw : {}), spaceId });
  const { clientKey: key, ...payload } = input;
  const requestHash = hashRequest(payload);
  const run = await runIdempotent(deps, { key, opType: 'usage_open', requestHash }, async (tx) => {
    const at = ctx.at ?? new Date();
    const x = roomOf(await openRooms(tx, await businessDate(tx, deps, at), [spaceId]), spaceId);
    if (x.kind === 'hotel') throw unprocessable('ROOM_NOT_USAGE', HOTEL_ELSEWHERE);
    assertOpenable(x, false);
    const usageId = await openUsageTx(tx, deps, payload, key, ctx);
    await bumpRoomVersion(tx, [spaceId], ctx.actor.id, at);
    await saveKey(tx, key, 'usage_open', requestHash, usageId, ctx.actor.id);
    return usageId;
  });
  return getUsage(deps.sql, run.refId);
}

// ───────────────────────── 换房 ─────────────────────────

export const MoveInput = z.object({
  clientKey,
  toSpaceId: z.number('请选择换到哪间房').int().positive('请选择换到哪间房'),
  expectedVersion,
  note: z.string().trim().max(MAX_ROOM_NOTE, `说明最多 ${MAX_ROOM_NOTE} 字`).default(''),
});

/**
 * 换房：这间房里的客人整间换到另一间空房。单与计时都不动——钟单还是那一张（只改它记的房间，与钟房的「换房间」同一个函数），
 * 明细、金额、开始时间不变；登记单改到新房间；两间房各记一条事件（从哪间到哪间）。原来的房间有人上过钟就转待清。
 * 并房的关系跟着走（新房间接替原来那间）。
 */
export async function moveRoom(deps: Deps, spaceId: number, raw: unknown, ctx: OpContext): Promise<void> {
  const { clientKey: key, ...input } = parse(MoveInput, raw);
  if (input.toSpaceId === spaceId) throw unprocessable('MOVE_SAME', '换到的是同一间房，请换一间');
  await runRoomOp(deps, ctx, { key, opType: 'space_dispatch', requestHash: hashRequest({ op: 'room_move', spaceId, ...input }) }, async (tx, at, today) => {
    const opened = await openRooms(tx, today, [spaceId, input.toSpaceId]);
    const from = roomOf(opened, spaceId);
    const to = roomOf(opened, input.toSpaceId);
    assertRoomVersion(from.version, input.expectedVersion, from.label);
    if (from.kind !== 'service' || to.kind !== 'service') {
      throw unprocessable('MOVE_NOT_SERVICE', from.kind === 'hotel' || to.kind === 'hotel' ? HOTEL_ELSEWHERE : '只有技师服务的房间之间可以这样换房（派对房等请结束使用后在新房间开单）');
    }
    if (from.room.guests.length === 0) throw conflict('ROOM_NOT_IN_USE', `${from.label} 现在没有客人，不用换房，请刷新`);
    assertOpenable(to, false);
    // 钟单：在这间房里还没结束的几张，按编号一张张换（钟单一行 → 新房间共享锁 → 位置）
    const moving = from.room.guests.flatMap((g) => g.sessions).filter((s) => Number(s.spaceId) === spaceId && s.status !== 'done');
    if (moving.length === 0) await lockServiceSpace(tx, input.toSpaceId);
    for (const s of moving.sort((a, b) => Number(a.id) - Number(b.id))) {
      await setSessionSpaceTx(tx, deps, Number(s.id), { spaceId: input.toSpaceId, expectedVersion: s.spaceVersion }, ctx);
    }
    const regIds = from.room.guests.flatMap((g) => (g.registration ? [Number(g.registration.id)] : []));
    if (regIds.length) await tx`UPDATE room_registrations SET space_id = ${input.toSpaceId} WHERE id IN ${tx(regIds)} AND status = 'open'`;
    // 原来的房间：有人上过钟（在钟上，或已经做完）就算用过，转待清；都还没上钟的不算
    const used = from.room.guests.some((g) => g.sessions.some((s) => s.status !== 'waiting'));
    if (used) await tx`UPDATE space_room_states SET dirty_at = ${at}, dirty_note = ${`换房换到 ${to.label}`.slice(0, 100)} WHERE space_id = ${spaceId}`;
    // 并房跟着走：原来并入别人的，新房间接着并入；并入原来这间的，改成并入新房间
    const main = opened.versions.get(spaceId)!.mergedInto;
    await tx`UPDATE space_room_states SET merged_into = NULL WHERE space_id IN ${tx([spaceId, input.toSpaceId])} OR merged_into = ${input.toSpaceId}`;
    if (main !== null && main !== input.toSpaceId) await tx`UPDATE space_room_states SET merged_into = ${main} WHERE space_id = ${input.toSpaceId}`;
    const followers = await tx<{ spaceId: number }[]>`
      UPDATE space_room_states SET merged_into = ${input.toSpaceId} WHERE merged_into = ${spaceId} AND space_id <> ${input.toSpaceId} RETURNING space_id`;
    await bumpRoomVersion(tx, [spaceId, input.toSpaceId, ...(main !== null ? [main] : []), ...followers.map((f) => Number(f.spaceId))], ctx.actor.id, at);
    const detail = { from: from.label, to: to.label, tags: tagsOf(from.room.guests), sessions: moving.map((s) => s.sessionNo), ...(input.note ? { note: input.note } : {}) };
    const first = await logRoomEvent(tx, { spaceId, kind: 'move_out', detail, staffId: ctx.actor.id, at });
    await logRoomEvent(tx, { spaceId: input.toSpaceId, kind: 'move_in', detail, staffId: ctx.actor.id, at });
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'room_center_move', targetType: 'space', targetId: spaceId, detail, ip: ctx.ip, businessDate: today });
    return first;
  });
}

// ───────────────────────── 退房 ─────────────────────────

/** 这间房里登记了的客人与他们的账：退房前的预览、退房时的核对用同一份 */
function checkoutGuests(room: RoomFacts): RoomCheckoutPreview['guests'] {
  return room.guests.flatMap((g) =>
    g.registration
      ? [
          {
            registrationId: Number(g.registration.id),
            visitId: Number(g.visit.id),
            tagCode: g.visit.tagCode,
            guest: guestName(g.visit),
            roomAmount: g.sessions.reduce((n, s) => n + s.amount, 0),
            billAmount: g.visit.billAmount,
            lines: g.sessions.filter((s) => s.amount > 0).map((s) => ({ name: s.itemName, quantity: s.clocks, amount: s.amount, technician: `${s.techNo} 号 ${s.techName}` })),
            running: g.sessions
              .filter((s): s is typeof s & { status: 'waiting' | 'serving' } => s.status !== 'done')
              .map((s) => ({ sessionId: Number(s.id), sessionNo: s.sessionNo, techNo: s.techNo, techName: s.techName, status: s.status })),
          },
        ]
      : [],
  );
}

/** 退房前的预览（只读）：每位客人这次登记的明细、手牌账单的合计、还没下钟的钟单 */
export async function roomCheckoutPreview(deps: Deps, spaceId: number): Promise<RoomCheckoutPreview> {
  const today = await businessDate(deps.sql, deps, new Date());
  const room = (await loadRoomFacts(deps.sql, today, [spaceId])).get(spaceId);
  if (!room) throw notFound('房间不存在，请刷新后重试');
  const guests = checkoutGuests(room);
  return { spaceId, code: room.space.code, version: room.state?.version ?? 0, guests, unpaidTotal: guests.reduce((n, g) => n + g.billAmount, 0) };
}

export const RoomCheckoutInput = z.object({
  clientKey,
  expectedVersion,
  /** 预览里看到的几位客人手牌账单的合计：看过以后账又变了（加了菜、续了钟）要重新看一遍 */
  seenUnpaid: z.number('请先看一遍结账预览').int().min(0),
  /** 账还没结时的确认：客人带着手牌继续在店，离店时在收银台结 */
  inHouse: z.boolean().default(false),
});

/**
 * 退房（技师服务的房间）：把房间腾出来、转待清。
 *   · 技师还在钟上（或派了还没上钟）的不能退：先下钟，或取消派钟；
 *   · 「退房前须结清或预览结账」：浴场的账挂在手牌上、离店时在收银台一起结，做完项目就离开房间的客人这时多半还没结。
 *     所以这里要的是——看过结账预览（带回预览里的合计，对不上说明账又变了，重新看），账没结的由经办人明确确认
 *     「客人带着手牌继续在店，离店时在收银台结」，未结金额记在登记单与房间事件上；已经在收银台结清的客人，登记单在结账时就结束了，不用再退。
 * 钟房直接派进来、没经房态中心登记的钟，下钟以后房间自己转待清，不用退房。
 */
export async function checkoutRoom(deps: Deps, spaceId: number, raw: unknown, ctx: OpContext): Promise<void> {
  const { clientKey: key, ...input } = parse(RoomCheckoutInput, raw);
  await runRoomOp(deps, ctx, { key, opType: 'space_dispatch', requestHash: hashRequest({ op: 'room_checkout', spaceId, ...input }) }, async (tx, at, today) => {
    const x = roomOf(await openRooms(tx, today, [spaceId]), spaceId);
    assertRoomVersion(x.version, input.expectedVersion, x.label);
    if (x.kind === 'hotel') throw unprocessable('ROOM_NOT_SERVICE', HOTEL_ELSEWHERE);
    // 登记单按 id 升序锁（与结账时结束登记单同一个顺序）；锁住以后以它为准
    const regs = await tx<{ id: number }[]>`SELECT id FROM room_registrations WHERE space_id = ${spaceId} AND status = 'open' ORDER BY id FOR UPDATE`;
    const guests = checkoutGuests(x.room).filter((g) => regs.some((r) => Number(r.id) === g.registrationId));
    if (guests.length === 0) {
      throw conflict(
        'NO_REGISTRATION',
        x.st.inUse ? `${x.label} 里的钟是钟房直接派进来的，没有登记单：下钟以后房间自己转待清，不用退房` : `${x.label} 现在没有登记的客人（可能已经退房，或客人已经结账离店），请刷新`,
      );
    }
    const running = guests.flatMap((g) => g.running);
    if (running.length) {
      const r = running[0]!;
      throw conflict('SESSION_RUNNING', `${r.techNo} 号 ${r.techName}${r.status === 'serving' ? '还在钟上' : '的钟派了还没上'}（${r.sessionNo}）：先下钟或取消派钟，再退房`, {
        sessionIds: running.map((s) => s.sessionId),
      });
    }
    const unpaid = guests.reduce((n, g) => n + g.billAmount, 0);
    if (unpaid !== input.seenUnpaid) throw conflict('BILL_CHANGED', `账单在你看过预览以后有变化（现在 ${formatYuan(unpaid)}），请重新看一遍再退房`, { unpaid });
    if (unpaid > 0 && !input.inHouse) {
      throw unprocessable('UNPAID_CONFIRM', `账单还有 ${formatYuan(unpaid)} 没结：请客人到收银台结清，或确认「客人带着手牌继续在店，离店时在收银台结」再退房`, { unpaid });
    }
    for (const g of guests) {
      await tx`
        UPDATE room_registrations SET status = 'closed', closed_at = greatest(opened_at, ${at}), closed_by = ${ctx.actor.id}, close_kind = 'checkout', unpaid_cents = ${g.billAmount}
        WHERE id = ${g.registrationId}`;
    }
    // 并房：这间房退了，它的并房关系解除
    const partners = await tx<{ spaceId: number }[]>`
      UPDATE space_room_states SET merged_into = NULL WHERE (space_id = ${spaceId} AND merged_into IS NOT NULL) OR merged_into = ${spaceId} RETURNING space_id`;
    await bumpRoomVersion(tx, [spaceId, ...partners.map((p) => Number(p.spaceId))], ctx.actor.id, at);
    const events: number[] = [];
    for (const g of guests) {
      const detail = { room: x.label, tag: g.tagCode, roomAmount: g.roomAmount, unpaid: g.billAmount, inHouse: g.billAmount > 0 };
      events.push(await logRoomEvent(tx, { spaceId, kind: 'checkout', registrationId: g.registrationId, detail, staffId: ctx.actor.id, at }));
    }
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'room_center_checkout',
      targetType: 'space',
      targetId: spaceId,
      detail: { room: x.label, tags: guests.map((g) => g.tagCode), unpaid, inHouse: unpaid > 0 },
      ip: ctx.ip,
      businessDate: today,
    });
    return events[0]!;
  });
}

// ───────────────────────── 并房、拆并 ─────────────────────────

export const MergeInput = z.object({ clientKey, withSpaceId: z.number('请选择并到哪间房').int().positive('请选择并到哪间房'), expectedVersion });

/**
 * 并房：两间都在用的房间记成一起的（这一间并入 withSpaceId，那一间是主房）。只是显示与历史上连在一起——
 * 账还在各自客人的手牌上，不搬明细、不动钱；哪一间退房、换空了，关系自己解除。
 */
export async function mergeRooms(deps: Deps, spaceId: number, raw: unknown, ctx: OpContext): Promise<void> {
  const { clientKey: key, ...input } = parse(MergeInput, raw);
  if (input.withSpaceId === spaceId) throw unprocessable('MERGE_SAME', '不能和自己并房，请选另一间');
  await runRoomOp(deps, ctx, { key, opType: 'space_dispatch', requestHash: hashRequest({ op: 'room_merge', spaceId, ...input }) }, async (tx, at, today) => {
    const opened = await openRooms(tx, today, [spaceId, input.withSpaceId]);
    const me = roomOf(opened, spaceId);
    const main = roomOf(opened, input.withSpaceId);
    assertRoomVersion(me.version, input.expectedVersion, me.label);
    for (const r of [me, main]) {
      if (r.kind === 'hotel' || r.kind === 'hall') throw unprocessable('MERGE_KIND', `${r.label} 是${r.kind === 'hotel' ? '客房' : '大厅类'}，不参加并房`);
      if (!r.st.inUse) throw conflict('ROOM_NOT_IN_USE', `${r.label} 现在没有客人：两间都在用的房间才能并房`);
    }
    const inUse = (id: number) => (opened.facts.has(id) ? statusOfFacts(opened.facts.get(id)!).inUse : false);
    // 还作数的并房关系（两头都在用）才拦；一头已经空了的旧关系直接盖掉
    const mainInto = opened.versions.get(input.withSpaceId)!.mergedInto;
    if (mainInto !== null && mainInto !== spaceId && inUse(mainInto)) {
      throw conflict('MERGE_CHAIN', `${main.label} 已经并入 ${roomLabel(opened.facts.get(mainInto)!.space)}，请直接并到那一间`);
    }
    const followers = [...opened.versions].filter(([id, v]) => v.mergedInto === spaceId && id !== input.withSpaceId && inUse(id)).map(([id]) => id);
    if (followers.length) throw conflict('MERGE_CHAIN', `${me.label} 是主房（带着 ${followers.map((id) => opened.facts.get(id)!.space.code).join('、')}），先拆并再并到别的房间`);
    const mine = opened.versions.get(spaceId)!.mergedInto;
    if (mine === input.withSpaceId) throw conflict('MERGE_EXISTS', `${me.label} 已经并入 ${main.label} 了，请刷新`);
    if (mine !== null && inUse(mine)) throw conflict('MERGE_CHAIN', `${me.label} 已经并入 ${roomLabel(opened.facts.get(mine)!.space)}，先拆并再并到别的房间`);
    await tx`UPDATE space_room_states SET merged_into = NULL WHERE merged_into = ${spaceId} OR (space_id = ${input.withSpaceId} AND merged_into IS NOT NULL)`;
    await tx`UPDATE space_room_states SET merged_into = ${input.withSpaceId} WHERE space_id = ${spaceId}`;
    await bumpRoomVersion(tx, [...opened.versions.keys()], ctx.actor.id, at);
    const detail = { room: me.label, into: main.label, tags: [...tagsOf(me.room.guests), ...tagsOf(main.room.guests)] };
    const first = await logRoomEvent(tx, { spaceId, kind: 'merge', detail, staffId: ctx.actor.id, at });
    await logRoomEvent(tx, { spaceId: input.withSpaceId, kind: 'merge', detail, staffId: ctx.actor.id, at });
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'room_center_merge', targetType: 'space', targetId: spaceId, detail, ip: ctx.ip, businessDate: today });
    return first;
  });
}

export const VersionInput = z.object({ clientKey, expectedVersion });

/** 拆并：这间并入别人的，解除它自己；这间是主房的，并入它的几间都解除 */
export async function unmergeRoom(deps: Deps, spaceId: number, raw: unknown, ctx: OpContext): Promise<void> {
  const { clientKey: key, ...input } = parse(VersionInput, raw);
  await runRoomOp(deps, ctx, { key, opType: 'space_dispatch', requestHash: hashRequest({ op: 'room_unmerge', spaceId, ...input }) }, async (tx, at, today) => {
    const opened = await openRooms(tx, today, [spaceId]);
    const me = roomOf(opened, spaceId);
    assertRoomVersion(me.version, input.expectedVersion, me.label);
    const cleared = await tx<{ spaceId: number }[]>`
      UPDATE space_room_states SET merged_into = NULL WHERE (space_id = ${spaceId} AND merged_into IS NOT NULL) OR merged_into = ${spaceId} RETURNING space_id`;
    if (cleared.length === 0) throw conflict('NOT_MERGED', `${me.label} 没有并房，请刷新`);
    const all = [...new Set([spaceId, ...opened.versions.keys()])];
    await bumpRoomVersion(tx, all, ctx.actor.id, at);
    const detail = { room: me.label, rooms: all.map((id) => opened.facts.get(id)?.space.code ?? '') };
    const events: number[] = [];
    for (const id of all) events.push(await logRoomEvent(tx, { spaceId: id, kind: 'unmerge', detail, staffId: ctx.actor.id, at }));
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'room_center_merge', targetType: 'space', targetId: spaceId, detail: { ...detail, unmerge: true }, ip: ctx.ip, businessDate: today });
    return events[0]!;
  });
}

// ───────────────────────── 维修 / 恢复、标待清 / 清洁完成 ─────────────────────────

export const MaintenanceInput = z.object({
  clientKey,
  reason: z.string('请填写维修原因').trim().min(2, '请填写维修原因（至少 2 个字）').max(MAX_MAINTENANCE_REASON, `原因最多 ${MAX_MAINTENANCE_REASON} 字`),
  expectedAt: z.iso.datetime({ offset: true, message: '请填写预计完成时间' }),
  expectedVersion,
});

type StateChange = 'maintenance' | 'restore' | 'dirty' | 'cleaned';

/**
 * 改房态的四样共用的外壳：带操作编号（space_state）；锁房态行、核对版本号与房间种类（客房不在这里改），写完加版本号、记事件与审计。
 * request 是原请求（摘要按除操作编号以外的内容算：同一个编号换了内容拒绝）
 */
async function changeState(
  deps: Deps,
  spaceId: number,
  request: { clientKey: string; expectedVersion: number } & Record<string, unknown>,
  kind: StateChange,
  ctx: OpContext,
  apply: (tx: Tx, x: ReturnType<typeof roomOf>, at: Date) => Promise<Record<string, unknown>>,
): Promise<void> {
  const { clientKey: key, ...rest } = request;
  await runRoomOp(deps, ctx, { key, opType: 'space_state', requestHash: hashRequest({ op: `room_${kind}`, spaceId, ...rest }) }, async (tx, at, today) => {
    const x = roomOf(await openRooms(tx, today, [spaceId]), spaceId);
    assertRoomVersion(x.version, request.expectedVersion, x.label);
    if (x.kind === 'hotel') throw unprocessable('ROOM_IS_HOTEL', HOTEL_ELSEWHERE);
    const detail = { room: x.label, ...(await apply(tx, x, at)) };
    await bumpRoomVersion(tx, [spaceId], ctx.actor.id, at);
    const eventId = await logRoomEvent(tx, { spaceId, kind, detail, staffId: ctx.actor.id, at });
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'room_center_state', targetType: 'space', targetId: spaceId, detail: { change: kind, ...detail }, ip: ctx.ip, businessDate: today });
    return eventId;
  });
}

/**
 * 维修：要原因与预计完成时间。有人用着的房间不能设（先退房、下钟、结束使用）。已经在维修的再提交一次是改原因与预计完成时间。
 * 房态行之后锁空间一行（FOR NO KEY UPDATE）：派钟、换房间、开单都先锁这一行再读「维修」，两边排队，不会一边设了维修一边刚好派进去。
 */
export async function setMaintenance(deps: Deps, spaceId: number, raw: unknown, ctx: OpContext): Promise<void> {
  const input = parse(MaintenanceInput, raw);
  // 摘要按预计完成时间的那一刻算（同一刻换一种时区写法不算换了内容）
  await changeState(deps, spaceId, { ...input, expectedAt: new Date(input.expectedAt).toISOString() }, 'maintenance', ctx, async (tx, x, at) => {
    const until = new Date(input.expectedAt);
    if (until.getTime() <= at.getTime()) throw unprocessable('MAINTENANCE_PAST', '预计完成时间要比现在晚');
    if (until.getTime() > at.getTime() + MAX_MAINTENANCE_DAYS * 86_400_000) throw unprocessable('MAINTENANCE_FAR', `预计完成时间最远到 ${MAX_MAINTENANCE_DAYS} 天以后`);
    await tx`SELECT id FROM spaces WHERE id = ${spaceId} FOR NO KEY UPDATE`;
    // 锁住空间一行以后再看一眼有没有人用（这以前排在前面的派钟、开单都已经提交）
    const [busy] = await tx<{ n: number }[]>`
      SELECT ((SELECT count(*) FROM technician_sessions s JOIN visits v ON v.id = s.visit_id WHERE s.space_id = ${spaceId} AND s.status IN ('waiting', 'serving') AND v.status = 'open')
            + (SELECT count(*) FROM space_usages u WHERE u.space_id = ${spaceId} AND u.status = 'open')
            + (SELECT count(*) FROM room_registrations r JOIN visits v ON v.id = r.visit_id WHERE r.space_id = ${spaceId} AND r.status = 'open' AND v.status = 'open'))::int AS n`;
    if (x.st.inUse || busy!.n > 0) throw conflict('ROOM_IN_USE', `${x.label} 正在用，不能设成维修：先退房（或下钟、结束使用）`);
    const update = x.room.state?.maintenance ?? false;
    await tx`
      UPDATE space_room_states SET maintenance = true, maintenance_reason = ${input.reason}, maintenance_until = ${until},
             maintenance_at = ${update ? tx`maintenance_at` : at}, maintenance_by = ${ctx.actor.id}
      WHERE space_id = ${spaceId}`;
    return { reason: input.reason, expectedAt: until.toISOString(), ...(update ? { update: true } : {}) };
  });
}

export const RestoreInput = z.object({ clientKey, expectedVersion, note: z.string().trim().max(MAX_ROOM_NOTE, `说明最多 ${MAX_ROOM_NOTE} 字`).default('') });

/** 恢复：维修结束。回到维修以前的样子——维修前就待清的仍是待清，否则空闲 */
export async function restoreRoom(deps: Deps, spaceId: number, raw: unknown, ctx: OpContext): Promise<void> {
  const input = parse(RestoreInput, raw);
  await changeState(deps, spaceId, input, 'restore', ctx, async (tx, x) => {
    if (!x.room.state?.maintenance) throw conflict('NOT_MAINTENANCE', `${x.label} 不在维修，请刷新`);
    await tx`
      UPDATE space_room_states SET maintenance = false, maintenance_reason = NULL, maintenance_until = NULL, maintenance_at = NULL, maintenance_by = NULL
      WHERE space_id = ${spaceId}`;
    return { reason: x.room.state.maintenanceReason, since: x.room.state.maintenanceAt, ...(input.note ? { note: input.note } : {}) };
  });
}

export const DirtyInput = z.object({ clientKey, expectedVersion, note: z.string().trim().max(MAX_ROOM_NOTE, `说明最多 ${MAX_ROOM_NOTE} 字`).default('') });

/** 手动标成待清（客人弄脏了、借用过）：空闲、已预订的房间才用得着 */
export async function markDirty(deps: Deps, spaceId: number, raw: unknown, ctx: OpContext): Promise<void> {
  const input = parse(DirtyInput, raw);
  await changeState(deps, spaceId, input, 'dirty', ctx, async (tx, x, at) => {
    if (x.st.status !== 'free' && x.st.status !== 'booked') throw conflict('ROOM_NOT_FREE', `${x.label} 现在不是空闲，不用标待清，请刷新`);
    await tx`UPDATE space_room_states SET dirty_at = ${at}, dirty_note = ${input.note} WHERE space_id = ${spaceId}`;
    return input.note ? { note: input.note } : {};
  });
}

/** 清洁完成：待清 → 空闲（今天有预订的回到已预订） */
export async function markCleaned(deps: Deps, spaceId: number, raw: unknown, ctx: OpContext): Promise<void> {
  const input = parse(VersionInput, raw);
  await changeState(deps, spaceId, input, 'cleaned', ctx, async (tx, x, at) => {
    if (x.st.inUse) throw conflict('ROOM_IN_USE', `${x.label} 还有客人，退房以后再点清洁完成`);
    if (!x.st.dirty) throw conflict('ROOM_NOT_DIRTY', `${x.label} 不是待清，请刷新`);
    // 记成「最近一次用完」以后的时刻（两台电脑的钟差一点也不会刚点完又变回待清）
    const cleanedAt = new Date(Math.max(at.getTime(), x.room.lastUsedAt ? new Date(x.room.lastUsedAt).getTime() : 0));
    await tx`UPDATE space_room_states SET cleaned_at = ${cleanedAt}, dirty_at = NULL, dirty_note = '' WHERE space_id = ${spaceId}`;
    return { since: x.room.lastUsedAt };
  });
}
