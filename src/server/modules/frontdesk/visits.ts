// 来访：接待发牌（含同行多人）、换牌、同行组进出、撤销误开的牌，以及状态板与手牌账单的读取。
//
// 手牌账单不是会员钱包：本模块只读取会员姓名与余额用于显示，不调用任何扣款逻辑。

import { z } from 'zod';
import {
  normalizeTagCode,
  TAG_CODE_PATTERN,
  ZONES,
  type BillSource,
  type CheckinResult,
  type FrontdeskBoard,
  type PreviewBill,
  type VisitDetail,
  type VisitHistoryEvent,
  type Zone,
  ZONE_LABELS,
} from '@shared/frontdesk';
import { formatYuan } from '@shared/money';
import type { Db } from '../../db';
import { writeAudit } from '../../lib/audit';
import type { Deps, OpContext } from '../../lib/context';
import { fenceKey, isFenced } from '../../lib/fences';
import { badRequest, conflict, notFound, unprocessable } from '../../lib/errors';
import { parse } from '../../lib/validate';
import {
  assertCanFix,
  assertOpen,
  assertTagIssuable,
  businessDate,
  closeGroupIfEmpty,
  hashRequest,
  loadFrontdeskRules,
  lockGroups,
  lockTagsByCode,
  lockVisits,
  nextDocNo,
  openVisitsOnTags,
  runIdempotent,
  FRONTDESK_OPS,
  type FrontdeskOp,
  saveKey,
  setTxTimeouts,
} from './common';

const clientKey = z.uuid('缺少有效的操作编号，请刷新页面后重试');
const tagCode = z
  .string('请输入牌号')
  .transform(normalizeTagCode)
  .pipe(z.string().regex(TAG_CODE_PATTERN, '牌号格式不正确（例如 A023、1088）'));

// ───────────────────────── 接待发牌 ─────────────────────────

const GuestInput = z.object({
  tagCode,
  zone: z.enum(ZONES, '请选择男宾 / 女宾 / 儿童'),
  memberId: z.number().int().positive().nullable().default(null),
  guestLabel: z.string().trim().max(16, '称呼最多 16 个字').default(''),
});

export const CheckinInput = z.object({
  clientKey,
  guests: z.array(GuestInput).min(1, '请至少登记一位客人').max(12, '一次最多接待 12 位客人'),
  /** 加入一位已在店客人的同行组（没有组时自动新建） */
  joinVisitId: z.number().int().positive().nullable().default(null),
});
export type CheckinInputData = z.input<typeof CheckinInput>;

async function loadCheckin(db: Db, key: string, replayed: boolean): Promise<CheckinResult> {
  const rows = await db<{ id: number; visitNo: string; tagCode: string; zone: Zone; groupNo: string | null }[]>`
    SELECT v.id, v.visit_no, t.code AS tag_code, v.zone, g.group_no
    FROM visits v JOIN hand_tags t ON t.id = v.tag_id LEFT JOIN visit_groups g ON g.id = v.group_id
    WHERE v.checkin_key = ${key} ORDER BY v.id`;
  return {
    replayed,
    visits: rows.map(({ groupNo: _g, ...r }) => r),
    groupNo: rows.find((r) => r.groupNo)?.groupNo ?? null,
  };
}

export async function checkin(deps: Deps, raw: CheckinInputData, ctx: OpContext): Promise<CheckinResult> {
  const input = parse(CheckinInput, raw);
  const codes = input.guests.map((g) => g.tagCode);
  if (new Set(codes).size !== codes.length) throw badRequest('同一张手牌不能发给两位客人');
  const memberIds = input.guests.map((g) => g.memberId).filter((x): x is number => x !== null);
  if (new Set(memberIds).size !== memberIds.length) throw badRequest('同一位会员只能持一张手牌');

  const { clientKey: key, ...payload } = input;
  const run = await runIdempotent(deps, { key, opType: 'checkin', requestHash: hashRequest(payload) }, async (tx) => {
    const at = ctx.at ?? new Date();
    // ① 手牌（id 升序）
    const tags = await lockTagsByCode(tx, codes);
    for (const g of input.guests) assertTagIssuable(tags.get(g.tagCode)!, g.zone);
    const busy = await openVisitsOnTags(tx, [...tags.values()].map((t) => t.id));
    if (busy.length) {
      const b = busy[0]!;
      const code = [...tags.values()].find((t) => t.id === b.tagId)!.code;
      throw conflict('TAG_OCCUPIED', `手牌 ${code} 已在店（来访 ${b.visitNo}），请换一张空闲手牌`, { code, visitNo: b.visitNo });
    }

    // 会员只读：确认存在、没有其他在店手牌
    if (memberIds.length) {
      const found = await tx<{ id: number; name: string }[]>`SELECT id, name FROM members WHERE id IN ${tx(memberIds)}`;
      if (found.length !== memberIds.length) throw notFound('会员不存在，请重新查找');
      const inStore = await tx<{ name: string; code: string }[]>`
        SELECT m.name, t.code FROM visits v JOIN members m ON m.id = v.member_id JOIN hand_tags t ON t.id = v.tag_id
        WHERE v.status = 'open' AND v.member_id IN ${tx(memberIds)}`;
      if (inStore.length) {
        throw conflict('MEMBER_IN_STORE', `会员「${inStore[0]!.name}」已持有在店手牌 ${inStore[0]!.code}，不能重复开牌`);
      }
    }

    // ② 同行组 → ③ 来访
    let groupId: number | null = null;
    let target: { id: number; groupId: number | null } | null = null;
    if (input.joinVisitId) {
      const [peek] = await tx<{ groupId: number | null }[]>`SELECT group_id FROM visits WHERE id = ${input.joinVisitId}`;
      if (!peek) throw notFound('要同行的客人不存在，请刷新状态板');
      await lockGroups(tx, [peek.groupId]);
      const v = (await lockVisits(tx, [input.joinVisitId])).get(input.joinVisitId)!;
      assertOpen(v);
      if (v.groupId !== peek.groupId) throw conflict('VISIT_CHANGED', '同行组刚刚有变化，请刷新后重试');
      target = { id: v.id, groupId: v.groupId };
      groupId = v.groupId;
    }

    const date = await businessDate(tx, deps, at);
    if (!groupId && (input.guests.length > 1 || target)) {
      const groupNo = await nextDocNo(tx, 'visit_group', 'TX', date);
      const [g] = await tx<{ id: number }[]>`
        INSERT INTO visit_groups (group_no, business_date, created_by, created_at)
        VALUES (${groupNo}, ${date}, ${ctx.actor.id}, ${at}) RETURNING id`;
      groupId = g!.id;
      if (target) {
        await tx`UPDATE visits SET group_id = ${groupId} WHERE id = ${target.id}`;
        await tx`
          INSERT INTO visit_group_events (group_id, visit_id, action, operator_id, created_at)
          VALUES (${groupId}, ${target.id}, 'join', ${ctx.actor.id}, ${at})`;
      }
    }

    let firstId = 0;
    for (const g of input.guests) {
      const tag = tags.get(g.tagCode)!;
      const billNo = await nextDocNo(tx, 'bill', 'ZD', date);
      const [bill] = await tx<{ id: number }[]>`
        INSERT INTO bills (bill_no, kind, business_date, opened_at) VALUES (${billNo}, 'visit', ${date}, ${at}) RETURNING id`;
      const visitNo = await nextDocNo(tx, 'visit', 'LF', date);
      const [visit] = await tx<{ id: number }[]>`
        INSERT INTO visits (visit_no, bill_id, tag_id, zone, member_id, guest_label, group_id, business_date,
                            checked_in_at, checked_in_by, checkin_key)
        VALUES (${visitNo}, ${bill!.id}, ${tag.id}, ${g.zone}, ${g.memberId}, ${g.guestLabel}, ${groupId}, ${date},
                ${at}, ${ctx.actor.id}, ${key})
        RETURNING id`;
      if (!firstId) firstId = visit!.id;
      if (groupId) {
        await tx`
          INSERT INTO visit_group_events (group_id, visit_id, action, operator_id, created_at)
          VALUES (${groupId}, ${visit!.id}, 'join', ${ctx.actor.id}, ${at})`;
      }
    }
    await saveKey(tx, key, 'checkin', hashRequest(payload), firstId, ctx.actor.id);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'frontdesk_checkin',
      targetType: 'visit',
      targetId: firstId,
      detail: { tags: codes, members: memberIds, joinVisitId: input.joinVisitId, groupId },
      ip: ctx.ip,
      businessDate: date,
    });
    return firstId;
  });
  return loadCheckin(deps.sql, key, run.replayed);
}

// ───────────────────────── 换牌 ─────────────────────────

export const SwapInput = z.object({
  clientKey,
  toTagCode: tagCode,
  reason: z.string().trim().min(2, '请填写换牌原因（至少 2 个字）').max(100, '原因最多 100 字'),
  /** 换下的手牌是否同时锁定（丢失、损坏时应锁定，避免再次发出） */
  lockOld: z.boolean().default(false),
});
export type SwapInputData = z.input<typeof SwapInput>;

export async function swapTag(deps: Deps, visitId: number, raw: SwapInputData, ctx: OpContext) {
  const input = parse(SwapInput, raw);
  const { clientKey: key, ...payload } = input;
  await runIdempotent(deps, { key, opType: 'tag_swap', requestHash: hashRequest({ visitId, ...payload }) }, async (tx) => {
    const at = ctx.at ?? new Date();
    const [peek] = await tx<{ tagId: number; code: string }[]>`
      SELECT v.tag_id, t.code FROM visits v JOIN hand_tags t ON t.id = v.tag_id WHERE v.id = ${visitId}`;
    if (!peek) throw notFound('来访记录不存在');
    if (peek.code === input.toTagCode) throw badRequest('新手牌与原手牌相同');
    // ① 手牌（新旧两张，id 升序）→ ③ 来访
    const tags = await lockTagsByCode(tx, [peek.code, input.toTagCode]);
    const visit = (await lockVisits(tx, [visitId])).get(visitId)!;
    assertOpen(visit);
    if (visit.tagId !== peek.tagId) throw conflict('VISIT_CHANGED', '这位客人刚刚已换过牌，请刷新后再操作');
    const from = tags.get(peek.code)!;
    const to = tags.get(input.toTagCode)!;
    assertTagIssuable(to, visit.zone);
    const busy = await openVisitsOnTags(tx, [to.id]);
    if (busy.length) throw conflict('TAG_OCCUPIED', `手牌 ${to.code} 已在店（来访 ${busy[0]!.visitNo}），请换一张空闲手牌`);

    await tx`UPDATE visits SET tag_id = ${to.id} WHERE id = ${visit.id}`;
    const [change] = await tx<{ id: number }[]>`
      INSERT INTO visit_tag_changes (visit_id, from_tag_id, to_tag_id, reason, old_tag_locked, operator_id, created_at)
      VALUES (${visit.id}, ${from.id}, ${to.id}, ${input.reason}, ${input.lockOld}, ${ctx.actor.id}, ${at})
      RETURNING id`;
    if (input.lockOld) {
      await tx`
        UPDATE hand_tags SET locked = true, lock_reason = ${input.reason}, locked_by = ${ctx.actor.id}, locked_at = ${at}, updated_at = now()
        WHERE id = ${from.id}`;
    }
    await saveKey(tx, key, 'tag_swap', hashRequest({ visitId, ...payload }), change!.id, ctx.actor.id);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'frontdesk_swap',
      targetType: 'visit',
      targetId: visit.id,
      detail: { visitNo: visit.visitNo, from: from.code, to: to.code, reason: input.reason, lockOld: input.lockOld },
      ip: ctx.ip,
      businessDate: await businessDate(tx, deps, at),
    });
    return change!.id;
  });
  return getVisit(deps.sql, visitId);
}

// ───────────────────────── 同行组 ─────────────────────────

export const GroupInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('join'), targetVisitId: z.number().int().positive() }),
  z.object({ action: z.literal('leave') }),
]);
export type GroupInputData = z.input<typeof GroupInput>;

export async function changeGroup(deps: Deps, visitId: number, raw: GroupInputData, ctx: OpContext) {
  const input = parse(GroupInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const at = ctx.at ?? new Date();
    const ids = input.action === 'join' ? [visitId, input.targetVisitId] : [visitId];
    if (input.action === 'join' && input.targetVisitId === visitId) throw badRequest('不能和自己同行');
    const peek = await tx<{ id: number; groupId: number | null }[]>`SELECT id, group_id FROM visits WHERE id IN ${tx(ids)}`;
    if (peek.length !== ids.length) throw notFound('来访记录不存在，请刷新状态板');
    // ② 同行组 → ③ 来访；加锁后核对组没有被其他终端改过
    await lockGroups(tx, peek.map((p) => p.groupId));
    const visits = await lockVisits(tx, ids);
    for (const p of peek) {
      if (visits.get(p.id)!.groupId !== p.groupId) throw conflict('VISIT_CHANGED', '同行组刚刚有变化，请刷新后重试');
    }
    const me = visits.get(visitId)!;
    assertOpen(me);
    const date = await businessDate(tx, deps, at);

    const leave = async (v: { id: number; groupId: number | null }) => {
      if (!v.groupId) return;
      await tx`UPDATE visits SET group_id = NULL WHERE id = ${v.id}`;
      await tx`
        INSERT INTO visit_group_events (group_id, visit_id, action, operator_id, created_at)
        VALUES (${v.groupId}, ${v.id}, 'leave', ${ctx.actor.id}, ${at})`;
      // 两人同行拆开后只剩一人、且没有已离店的同行时，整组解散，避免留下「一个人的同行组」
      const rest = await tx<{ id: number; status: string }[]>`SELECT id, status FROM visits WHERE group_id = ${v.groupId}`;
      if (rest.length === 1 && rest[0]!.status === 'open') {
        await tx`UPDATE visits SET group_id = NULL WHERE id = ${rest[0]!.id}`;
        await tx`
          INSERT INTO visit_group_events (group_id, visit_id, action, operator_id, created_at)
          VALUES (${v.groupId}, ${rest[0]!.id}, 'leave', ${ctx.actor.id}, ${at})`;
      }
      await closeGroupIfEmpty(tx, v.groupId, at);
    };

    if (input.action === 'leave') {
      if (!me.groupId) throw unprocessable('NOT_IN_GROUP', '这位客人没有同行组');
      await leave(me);
    } else {
      const target = visits.get(input.targetVisitId)!;
      assertOpen(target);
      if (me.groupId && me.groupId === target.groupId) return; // 已在同一组，重复点击不重复记录
      if (me.groupId) await leave(me);
      let groupId = target.groupId;
      if (!groupId) {
        const groupNo = await nextDocNo(tx, 'visit_group', 'TX', date);
        const [g] = await tx<{ id: number }[]>`
          INSERT INTO visit_groups (group_no, business_date, created_by, created_at)
          VALUES (${groupNo}, ${date}, ${ctx.actor.id}, ${at}) RETURNING id`;
        groupId = g!.id;
        await tx`UPDATE visits SET group_id = ${groupId} WHERE id = ${target.id}`;
        await tx`
          INSERT INTO visit_group_events (group_id, visit_id, action, operator_id, created_at)
          VALUES (${groupId}, ${target.id}, 'join', ${ctx.actor.id}, ${at})`;
      }
      await tx`UPDATE visits SET group_id = ${groupId} WHERE id = ${me.id}`;
      await tx`
        INSERT INTO visit_group_events (group_id, visit_id, action, operator_id, created_at)
        VALUES (${groupId}, ${me.id}, 'join', ${ctx.actor.id}, ${at})`;
    }
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'frontdesk_group',
      targetType: 'visit',
      targetId: visitId,
      detail: input,
      ip: ctx.ip,
      businessDate: date,
    });
  });
  return getVisit(deps.sql, visitId);
}

// ───────────────────────── 撤销误开的牌 ─────────────────────────

export const CancelInput = z.object({
  reason: z.string().trim().min(2, '请填写撤销原因（至少 2 个字）').max(200, '原因最多 200 字'),
});

export async function cancelVisit(deps: Deps, visitId: number, raw: unknown, ctx: OpContext) {
  const input = parse(CancelInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const at = ctx.at ?? new Date();
    // ② 同行组 → ③ 来访 → 账单（撤销后可能要关闭同行组，所以先锁组）
    const [peek] = await tx<{ groupId: number | null }[]>`SELECT group_id FROM visits WHERE id = ${visitId}`;
    if (!peek) throw notFound('来访记录不存在');
    await lockGroups(tx, [peek.groupId]);
    const visit = (await lockVisits(tx, [visitId])).get(visitId)!;
    assertOpen(visit);
    if (visit.groupId !== peek.groupId) throw conflict('VISIT_CHANGED', '同行组刚刚有变化，请刷新后重试');
    const [bill] = await tx<{ lineCount: number; amountCents: number }[]>`
      SELECT line_count, amount_cents FROM bills WHERE id = ${visit.billId} FOR UPDATE`;
    if (bill!.lineCount > 0) {
      throw conflict(
        'BILL_UNSETTLED',
        `手牌账单上还有 ${bill!.lineCount} 项未结消费（${formatYuan(bill!.amountCents)}），不能直接释放手牌；请先结账，或作废登记错的明细`,
        { lineCount: bill!.lineCount, amountCents: bill!.amountCents },
      );
    }
    assertCanFix(ctx.actor, visit.checkedInBy, visit.checkedInAt, await loadFrontdeskRules(tx), at, '这张手牌');
    await tx`UPDATE bills SET status = 'cancelled', closed_at = ${at} WHERE id = ${visit.billId}`;
    await tx`
      UPDATE visits SET status = 'cancelled', closed_at = ${at}, closed_by = ${ctx.actor.id}, close_reason = ${input.reason}
      WHERE id = ${visit.id}`;
    await closeGroupIfEmpty(tx, visit.groupId, at);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'frontdesk_cancel',
      targetType: 'visit',
      targetId: visit.id,
      detail: { visitNo: visit.visitNo, reason: input.reason },
      ip: ctx.ip,
      businessDate: await businessDate(tx, deps, at),
    });
  });
  return getVisit(deps.sql, visitId);
}

// ───────────────────────── 读取 ─────────────────────────

export async function getBoard(db: Db): Promise<FrontdeskBoard> {
  const rows = await db<(Omit<FrontdeskBoard['tags'][number], 'visit'> & {
    visitId: number | null; visitNo: string | null; billId: number | null; checkedInAt: string | null;
    memberId: number | null; memberName: string | null; guestLabel: string | null; groupId: number | null;
    groupNo: string | null; groupOpenCount: number; amountCents: number | null; lineCount: number | null;
  })[]>`
    SELECT t.id, t.code, t.zone, t.locked, t.lock_reason, t.active, t.is_synthetic,
           v.id AS visit_id, v.visit_no, v.bill_id, v.checked_in_at, v.member_id, m.name AS member_name, v.guest_label,
           v.group_id, g.group_no,
           CASE WHEN v.group_id IS NULL THEN 0 ELSE count(v.id) OVER (PARTITION BY v.group_id) END AS group_open_count,
           b.amount_cents, b.line_count
    FROM hand_tags t
    LEFT JOIN visits v ON v.tag_id = t.id AND v.status = 'open'
    LEFT JOIN members m ON m.id = v.member_id
    LEFT JOIN visit_groups g ON g.id = v.group_id
    LEFT JOIN bills b ON b.id = v.bill_id
    WHERE t.active OR v.id IS NOT NULL
    ORDER BY CASE t.zone WHEN 'male' THEN 0 WHEN 'female' THEN 1 ELSE 2 END, length(t.code), t.code`;
  const tags = rows.map((r) => ({
    id: r.id,
    code: r.code,
    zone: r.zone,
    locked: r.locked,
    lockReason: r.lockReason,
    active: r.active,
    isSynthetic: r.isSynthetic,
    visit: r.visitId
      ? {
          id: r.visitId,
          visitNo: r.visitNo!,
          billId: r.billId!,
          checkedInAt: r.checkedInAt!,
          memberId: r.memberId,
          memberName: r.memberName,
          guestLabel: r.guestLabel ?? '',
          groupId: r.groupId,
          groupNo: r.groupNo,
          groupOpenCount: r.groupOpenCount,
          amountCents: r.amountCents ?? 0,
          lineCount: r.lineCount ?? 0,
        }
      : null,
  }));
  const inStore = tags.filter((t) => t.visit);
  const inStoreByZone = { male: 0, female: 0, child: 0 } as Record<Zone, number>;
  for (const t of inStore) inStoreByZone[t.zone] += 1;
  const [now] = await db<{ now: string }[]>`SELECT now() AS now`;
  return {
    tags,
    stats: {
      inStore: inStore.length,
      inStoreByZone,
      free: tags.filter((t) => !t.visit && !t.locked && t.active).length,
      locked: tags.filter((t) => t.locked).length,
      unsettledCents: inStore.reduce((s, t) => s + t.visit!.amountCents, 0),
      groups: new Set(inStore.map((t) => t.visit!.groupId).filter(Boolean)).size,
    },
    rules: await loadFrontdeskRules(db),
    serverTime: now!.now,
  };
}

export async function getVisit(db: Db, id: number): Promise<VisitDetail> {
  const [v] = await db<{
    id: number; visitNo: string; status: VisitDetail['status']; zone: Zone; guestLabel: string; businessDate: string;
    checkedInAt: string; checkedInById: number; checkedInByName: string; closedAt: string | null; closeReason: string | null;
    closedByName: string | null; memberId: number | null; groupId: number | null; billId: number; billNo: string;
    billStatus: VisitDetail['status']; amountCents: number; lineCount: number;
    tagId: number; tagCode: string; tagZone: Zone; tagLocked: boolean; tagLockReason: string | null; tagActive: boolean; tagSynthetic: boolean;
  }[]>`
    SELECT v.id, v.visit_no, v.status, v.zone, v.guest_label, v.business_date, v.checked_in_at,
           v.checked_in_by AS checked_in_by_id, s.display_name AS checked_in_by_name, v.closed_at, v.close_reason,
           cs.display_name AS closed_by_name, v.member_id, v.group_id,
           b.id AS bill_id, b.bill_no, b.status AS bill_status, b.amount_cents, b.line_count,
           t.id AS tag_id, t.code AS tag_code, t.zone AS tag_zone, t.locked AS tag_locked, t.lock_reason AS tag_lock_reason,
           t.active AS tag_active, t.is_synthetic AS tag_synthetic
    FROM visits v JOIN bills b ON b.id = v.bill_id JOIN hand_tags t ON t.id = v.tag_id
    JOIN staff s ON s.id = v.checked_in_by LEFT JOIN staff cs ON cs.id = v.closed_by
    WHERE v.id = ${id}`;
  if (!v) throw notFound('来访记录不存在');

  const [member] = v.memberId
    ? await db<NonNullable<VisitDetail['member']>[]>`
        SELECT id, member_no, name, phone, gender, status, principal_balance, bonus_balance FROM members WHERE id = ${v.memberId}`
    : [];

  const lines = await db<VisitDetail['lines']>`
    SELECT l.id, l.source, l.item_id, l.name, l.unit_price, l.quantity, l.amount, l.status, l.post_key, l.business_date,
           l.posted_by AS posted_by_id, p.display_name AS posted_by_name, l.posted_at, l.void_reason,
           vs.display_name AS voided_by_name, l.voided_at
    FROM bill_lines l JOIN staff p ON p.id = l.posted_by LEFT JOIN staff vs ON vs.id = l.voided_by
    WHERE l.bill_id = ${v.billId} ORDER BY l.id`;

  let group: VisitDetail['group'] = null;
  if (v.groupId) {
    const [g] = await db<{ id: number; groupNo: string; status: 'open' | 'closed' }[]>`
      SELECT id, group_no, status FROM visit_groups WHERE id = ${v.groupId}`;
    const mates = await db<NonNullable<VisitDetail['group']>['mates']>`
      SELECT v.id AS visit_id, v.visit_no, t.code AS tag_code, v.zone, v.status, m.name AS member_name, v.guest_label,
             b.amount_cents, b.line_count, v.checked_in_at
      FROM visits v JOIN hand_tags t ON t.id = v.tag_id JOIN bills b ON b.id = v.bill_id LEFT JOIN members m ON m.id = v.member_id
      WHERE v.group_id = ${v.groupId} ORDER BY v.id`;
    group = {
      ...g!,
      mates,
      openAmountCents: mates.filter((m) => m.status === 'open').reduce((s, m) => s + m.amountCents, 0),
    };
  }

  const history: VisitHistoryEvent[] = [
    { at: v.checkedInAt, kind: 'checkin', text: `开牌 · ${ZONE_LABELS[v.zone].title}`, operatorName: v.checkedInByName },
  ];
  const swaps = await db<{ createdAt: string; fromCode: string; toCode: string; reason: string; oldTagLocked: boolean; operatorName: string }[]>`
    SELECT c.created_at, f.code AS from_code, t.code AS to_code, c.reason, c.old_tag_locked, s.display_name AS operator_name
    FROM visit_tag_changes c JOIN hand_tags f ON f.id = c.from_tag_id JOIN hand_tags t ON t.id = c.to_tag_id
    JOIN staff s ON s.id = c.operator_id WHERE c.visit_id = ${id} ORDER BY c.id`;
  for (const s of swaps) {
    history.push({
      at: s.createdAt,
      kind: 'swap',
      text: `换牌 ${s.fromCode} → ${s.toCode}（${s.reason}${s.oldTagLocked ? `，${s.fromCode} 已锁定` : ''}）`,
      operatorName: s.operatorName,
    });
  }
  const groupEvents = await db<{ createdAt: string; action: 'join' | 'leave'; groupNo: string; operatorName: string }[]>`
    SELECT e.created_at, e.action, g.group_no, s.display_name AS operator_name
    FROM visit_group_events e JOIN visit_groups g ON g.id = e.group_id JOIN staff s ON s.id = e.operator_id
    WHERE e.visit_id = ${id} ORDER BY e.id`;
  for (const e of groupEvents) {
    history.push({ at: e.createdAt, kind: e.action, text: `${e.action === 'join' ? '加入' : '退出'}同行组 ${e.groupNo}`, operatorName: e.operatorName });
  }
  for (const l of lines) {
    history.push({ at: l.postedAt, kind: 'post', text: `挂账 ${l.name} × ${l.quantity}（${formatYuan(l.amount)}）`, operatorName: l.postedByName });
    if (l.status === 'voided') {
      history.push({ at: l.voidedAt!, kind: 'void', text: `作废 ${l.name} × ${l.quantity}（${l.voidReason}）`, operatorName: l.voidedByName ?? '' });
    }
  }
  if (v.closedAt) {
    history.push({
      at: v.closedAt,
      kind: 'close',
      text: v.status === 'cancelled' ? `撤销来访（${v.closeReason}）` : '结账离店',
      operatorName: v.closedByName ?? '',
    });
  }
  history.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const [now] = await db<{ now: string }[]>`SELECT now() AS now`;
  return {
    id: v.id,
    visitNo: v.visitNo,
    status: v.status,
    zone: v.zone,
    guestLabel: v.guestLabel,
    businessDate: v.businessDate,
    checkedInAt: v.checkedInAt,
    checkedInById: v.checkedInById,
    checkedInByName: v.checkedInByName,
    closedAt: v.closedAt,
    closeReason: v.closeReason,
    tag: { id: v.tagId, code: v.tagCode, zone: v.tagZone, locked: v.tagLocked, lockReason: v.tagLockReason, active: v.tagActive, isSynthetic: v.tagSynthetic },
    member: member ?? null,
    bill: { id: v.billId, billNo: v.billNo, status: v.billStatus, amountCents: v.amountCents, lineCount: v.lineCount },
    lines,
    group,
    history,
    serverTime: now!.now,
  };
}

/** 预结账：汇总所选在店手牌的未结明细（S2 只看金额，不收款、不扣会员余额） */
export async function previewBills(db: Db, visitIds: number[]): Promise<PreviewBill> {
  const ids = [...new Set(visitIds)];
  if (ids.length === 0) throw badRequest('请至少选择一张手牌');
  const visits = await db<{ visitId: number; visitNo: string; tagCode: string; zone: Zone; memberName: string | null; guestLabel: string; checkedInAt: string; amountCents: number; status: string; billId: number }[]>`
    SELECT v.id AS visit_id, v.visit_no, t.code AS tag_code, v.zone, m.name AS member_name, v.guest_label, v.checked_in_at,
           b.amount_cents, v.status, v.bill_id
    FROM visits v JOIN hand_tags t ON t.id = v.tag_id JOIN bills b ON b.id = v.bill_id LEFT JOIN members m ON m.id = v.member_id
    WHERE v.id IN ${db(ids)} ORDER BY t.code`;
  if (visits.length !== ids.length) throw notFound('有手牌的来访记录不存在，请刷新后重试');
  const closed = visits.find((v) => v.status !== 'open');
  if (closed) throw conflict('VISIT_CLOSED', `手牌 ${closed.tagCode} 已不在店，请刷新后重新选择`);
  const sums = await db<{ billId: number; source: BillSource; amountCents: number; lineCount: number }[]>`
    SELECT bill_id, source, sum(amount) AS amount_cents, count(*) AS line_count FROM bill_lines
    WHERE status = 'active' AND bill_id IN ${db(visits.map((v) => v.billId))}
    GROUP BY bill_id, source ORDER BY bill_id, source`;
  const totalBySource = new Map<BillSource, number>();
  for (const s of sums) totalBySource.set(s.source, (totalBySource.get(s.source) ?? 0) + s.amountCents);
  const [now] = await db<{ now: string }[]>`SELECT now() AS now`;
  return {
    visits: visits.map(({ status: _s, billId, ...v }) => ({
      ...v,
      bySource: sums.filter((s) => s.billId === billId).map(({ billId: _b, ...s }) => s),
    })),
    totalCents: visits.reduce((s, v) => s + v.amountCents, 0),
    bySource: [...totalBySource].map(([source, amountCents]) => ({ source, amountCents })),
    serverTime: now!.now,
  };
}

/**
 * 按操作编号查回结果（只读）。
 * 查不到只说明「此刻还没有已提交的结果」，原请求可能仍在路上或在等锁，页面不能据此断定没有生效；
 * 要放弃这笔，必须调用 abandonFrontdeskOp。
 * expected 是页面记录的原业务类型：只有同一类型的作废登记才算「已作废」。
 */
export async function lookupFrontdeskOp(db: Db, key: string, expected?: FrontdeskOp) {
  const [row] = await db<{ opType: string; refId: number }[]>`SELECT op_type, ref_id FROM idempotency_keys WHERE key = ${key}`;
  if (row?.opType === 'abandoned') return { found: false as const, abandoned: true };
  if (!row) return { found: false as const, abandoned: await isFenced(db, key, expected ? [expected] : FRONTDESK_OPS) };
  if (!(FRONTDESK_OPS as readonly string[]).includes(row.opType)) return { found: false as const, abandoned: false };
  if (row.opType === 'checkin') return { found: true as const, type: 'checkin' as const, checkin: await loadCheckin(db, key, true) };
  if (row.opType === 'bill_post') return { found: true as const, type: 'bill_post' as const, visit: await getVisit(db, row.refId) };
  const [c] = await db<{ visitId: number }[]>`SELECT visit_id FROM visit_tag_changes WHERE id = ${row.refId}`;
  return { found: true as const, type: 'tag_swap' as const, visit: await getVisit(db, c!.visitId) };
}

/**
 * 作废一笔结果待确认的前台操作：登记「编号 + 原业务类型」的作废（单独提交，见 lib/fences.ts）。
 * - 登记成功：原请求无论还在路上、在等锁还是正在执行，写编号前都会看到作废并整笔回滚，永远不会生效；
 * - 编号已有结果：说明原操作已经生效，返回查回的结果，不作废；
 * - 原请求恰好正在写编号：这里等它提交（最多 5 秒）再给出确定答复，超时则仍为待确认。
 * 只能登记前台的业务类型，所以从这里作废会员记账的编号不会拦下会员记账。
 */
export async function abandonFrontdeskOp(deps: Deps, key: string, opType: FrontdeskOp, ctx: OpContext) {
  const outcome = await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const result = await fenceKey(tx, key, opType, ctx.actor.id);
    if ('inserted' in result && result.inserted) {
      await writeAudit(tx, {
        staffId: ctx.actor.id,
        action: 'frontdesk_abandon',
        targetType: 'operation',
        targetId: key,
        detail: { key, type: opType },
        ip: ctx.ip,
        businessDate: await businessDate(tx, deps, ctx.at ?? new Date()),
      });
    }
    return result;
  });
  if (!('existingOpType' in outcome) || outcome.existingOpType === 'abandoned') return { found: false as const, abandoned: true };
  if (!(FRONTDESK_OPS as readonly string[]).includes(outcome.existingOpType)) {
    throw conflict('IDEMPOTENCY_CONFLICT', '该操作编号属于其他业务，不能在前台作废');
  }
  return lookupFrontdeskOp(deps.sql, key, opType);
}
