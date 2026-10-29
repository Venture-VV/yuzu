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
  type TagZone,
  type VisitDetail,
  type VisitHistoryEvent,
  ZONE_LABELS,
} from '@shared/frontdesk';
import { backfillText, type BackfillMark } from '@shared/backfill';
import { isFreeTicket } from '@shared/checkout';
import { formatYuan } from '@shared/money';
import { consumeTicketGrant } from '../../auth/grants';
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
import { assertAfterVisits, assertFreeAt, backfillDetail, backfillMarkSql, BackfillInput, normalizeMark, recordBackfill, resolveBackfill } from './backfill';
import { getCheckout } from './checkout';
import { resolveTicketType, ticketAuthRequired, visitTicket } from './tickets';
import { assertVipAllowed, consumeVipShortfalls, memberLevels, vipShortfalls } from './vip';

const clientKey = z.uuid('缺少有效的操作编号，请刷新页面后重试');
const tagCode = z
  .string('请输入牌号')
  .transform(normalizeTagCode)
  .pipe(z.string().regex(TAG_CODE_PATTERN, '牌号格式不正确（例如 A023、1088）'));

// ───────────────────────── 接待发牌 ─────────────────────────

const GuestInput = z.object({
  tagCode,
  zone: z.enum(ZONES, '请选择男宾或女宾（儿童跟同性别家长用男宾或女宾的牌）'),
  memberId: z.number().int().positive().nullable().default(null),
  guestLabel: z.string().trim().max(16, '称呼最多 16 个字').default(''),
  /** 票种；不带时用默认票种（升级前留下的待确认请求不带这一项，不带时不进入请求摘要） */
  ticketTypeId: z.number().int().positive().optional(),
});

export const CheckinInput = z.object({
  clientKey,
  guests: z.array(GuestInput).min(1, '请至少登记一位客人').max(12, '一次最多接待 12 位客人'),
  /** 加入一位已在店客人的同行组（没有组时自动新建） */
  joinVisitId: z.number().int().positive().nullable().default(null),
  /** 当场授权编号：有客人等级不够、要用 VIP 柜时，由值班经理 / 店总在弹窗里签发 */
  vipGrantId: z.uuid('授权编号格式不正确').nullable().default(null),
  /** 当场授权编号：有客人选免票（例如 1 米以下儿童）时，由值班经理及以上签发，同一次接待只授权一次（R1.2） */
  ticketGrantId: z.uuid('授权编号格式不正确').nullable().default(null),
  /** 按实际时间补录纸质单（R1.9）：纸质单号与实际时间；平时不带 */
  backfill: BackfillInput,
});
export type CheckinInputData = z.input<typeof CheckinInput>;

/** 参与核对的请求内容：未使用的新字段不计入，升级前留下的待确认请求重提时仍能对上 */
function hashedPayload<T extends Record<string, unknown>>(payload: T, optional: (keyof T)[]) {
  const out: Record<string, unknown> = { ...payload };
  for (const k of optional) if (out[k as string] === null) delete out[k as string];
  return out;
}

async function loadCheckin(db: Db, key: string, replayed: boolean): Promise<CheckinResult> {
  const rows = await db<{ id: number; visitNo: string; tagCode: string; zone: TagZone; groupNo: string | null }[]>`
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
  const requestHash = hashRequest(hashedPayload(payload, ['vipGrantId', 'ticketGrantId']));
  // 补录纸质单：按纸质单上的实际时间办理（门票从实际时间起计，营业日按实际时间归属）
  const backfill = resolveBackfill(input.backfill, ctx.actor);
  const run = await runIdempotent(deps, { key, opType: 'checkin', requestHash }, async (tx) => {
    const at = backfill?.at ?? ctx.at ?? new Date();
    const rules = await loadFrontdeskRules(tx);
    // ① 手牌（id 升序）
    const tags = await lockTagsByCode(tx, codes);
    for (const g of input.guests) assertTagIssuable(tags.get(g.tagCode)!, g.zone);
    const busy = await openVisitsOnTags(tx, [...tags.values()].map((t) => t.id));
    if (busy.length) {
      const b = busy[0]!;
      const code = [...tags.values()].find((t) => t.id === b.tagId)!.code;
      throw conflict('TAG_OCCUPIED', `手牌 ${code} 已在店（来访 ${b.visitNo}），请换一张空闲手牌`, { code, visitNo: b.visitNo });
    }
    // 补录：实际时间那一刻手牌、会员不能已被别的来访占用（已离店的也算），否则时间重叠
    if (backfill) await assertFreeAt(tx, at, [...tags.values()].map((t) => t.id), memberIds, deps.config.timezone);

    // 会员只读：确认存在、没有其他在店手牌
    const names = new Map<number, string>();
    if (memberIds.length) {
      const found = await tx<{ id: number; name: string }[]>`SELECT id, name FROM members WHERE id IN ${tx(memberIds)}`;
      if (found.length !== memberIds.length) throw notFound('会员不存在，请重新查找');
      for (const m of found) names.set(m.id, m.name);
      const inStore = await tx<{ name: string; code: string }[]>`
        SELECT m.name, t.code FROM visits v JOIN members m ON m.id = v.member_id JOIN hand_tags t ON t.id = v.tag_id
        WHERE v.status = 'open' AND v.member_id IN ${tx(memberIds)}`;
      if (inStore.length) {
        throw conflict('MEMBER_IN_STORE', `会员「${inStore[0]!.name}」已持有在店手牌 ${inStore[0]!.code}，不能重复开牌`);
      }
    }

    // VIP 柜：会员等级不低于柜子等级；不够时需当场授权（规则开启时）
    const levels = await memberLevels(tx, memberIds, rules);
    const shortfalls = vipShortfalls(
      input.guests.map((g) => ({ tag: tags.get(g.tagCode)!, memberId: g.memberId, memberName: g.memberId ? (names.get(g.memberId) ?? null) : null })),
      levels,
    );
    assertVipAllowed(shortfalls, levels, rules, input.vipGrantId);
    const overrideCodes = new Set(shortfalls.map((x) => x.code));

    // 票种：留存选定时的票价，结账时按在店时长计算门票；选免票的客人要当场授权（同一次接待一次授权）
    const tickets = await Promise.all(input.guests.map((g) => resolveTicketType(tx, g.ticketTypeId)));
    const freeGuests = input.guests.flatMap((g, i) => {
      const t = tickets[i];
      return t && isFreeTicket(t) ? [{ tagCode: g.tagCode, ticketTypeId: t.id, name: t.name, free: true }] : [];
    });
    if (freeGuests.length && !input.ticketGrantId) throw ticketAuthRequired(freeGuests);

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
      if (backfill) await assertAfterVisits(tx, at, [v.id], 'checkin', deps.config.timezone);
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

    // 授权凭据最后加锁并核销（业务回滚时一起回滚）
    const override = await consumeVipShortfalls(tx, shortfalls, input.vipGrantId, ctx.actor, `checkin:${key}`);
    const ticketApproval = freeGuests.length
      ? await consumeTicketGrant(tx, {
          grantId: input.ticketGrantId!,
          actor: ctx.actor,
          needed: freeGuests.map(({ tagCode, ticketTypeId }) => ({ tagCode, ticketTypeId })),
          usedRef: `checkin:${key}`,
        })
      : null;

    let firstId = 0;
    for (const [i, g] of input.guests.entries()) {
      const tag = tags.get(g.tagCode)!;
      const ticket = tickets[i]!;
      const billNo = await nextDocNo(tx, 'bill', 'ZD', date);
      const [bill] = await tx<{ id: number }[]>`
        INSERT INTO bills (bill_no, kind, business_date, opened_at) VALUES (${billNo}, 'visit', ${date}, ${at}) RETURNING id`;
      const visitNo = await nextDocNo(tx, 'visit', 'LF', date);
      const [visit] = await tx<{ id: number }[]>`
        INSERT INTO visits (visit_no, bill_id, tag_id, zone, member_id, guest_label, group_id, business_date,
                            checked_in_at, checked_in_by, checkin_key, vip_override_by, ticket_type_id, ticket_price_12h, ticket_price_24h)
        VALUES (${visitNo}, ${bill!.id}, ${tag.id}, ${g.zone}, ${g.memberId}, ${g.guestLabel}, ${groupId}, ${date},
                ${at}, ${ctx.actor.id}, ${key}, ${override && overrideCodes.has(tag.code) ? override.approverId : null},
                ${ticket?.id ?? null}, ${ticket?.price12h ?? null}, ${ticket?.price24h ?? null})
        RETURNING id`;
      if (!firstId) firstId = visit!.id;
      // 免票：记一条改票种记录，留下授权人与原因
      if (ticket && ticketApproval && isFreeTicket(ticket)) {
        await tx`
          INSERT INTO visit_ticket_changes (visit_id, from_type_id, to_type_id, price_12h, price_24h, operator_id, created_at, approved_by, reason)
          VALUES (${visit!.id}, NULL, ${ticket.id}, ${ticket.price12h}, ${ticket.price24h}, ${ctx.actor.id}, ${at},
                  ${ticketApproval.approverId}, ${ticketApproval.reason})`;
      }
      if (groupId) {
        await tx`
          INSERT INTO visit_group_events (group_id, visit_id, action, operator_id, created_at)
          VALUES (${groupId}, ${visit!.id}, 'join', ${ctx.actor.id}, ${at})`;
      }
      if (backfill) await recordBackfill(tx, backfill, { kind: 'checkin', opKey: key, visitId: visit!.id, businessDate: date, actor: ctx.actor });
    }
    await saveKey(tx, key, 'checkin', requestHash, firstId, ctx.actor.id);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'frontdesk_checkin',
      targetType: 'visit',
      targetId: firstId,
      detail: {
        tags: codes,
        members: memberIds,
        joinVisitId: input.joinVisitId,
        groupId,
        ...(override ? { vipOverride: { tags: [...overrideCodes], approverId: override.approverId, approverName: override.approverName, grantId: input.vipGrantId } } : {}),
        ...(ticketApproval
          ? {
              freeTickets: {
                tags: freeGuests.map((g) => g.tagCode),
                approverId: ticketApproval.approverId,
                approverName: ticketApproval.approverName,
                reason: ticketApproval.reason,
                grantId: input.ticketGrantId,
              },
            }
          : {}),
        ...backfillDetail(backfill),
      },
      ip: ctx.ip,
      businessDate: date,
    });
    return firstId;
  });
  return loadCheckin(deps.sql, key, run.replayed);
}

// ───────────────────────── 换牌 ─────────────────────────

export const SwapInput = z
  .object({
    clientKey,
    toTagCode: tagCode,
    reason: z.string().trim().min(2, '请填写换牌原因（至少 2 个字）').max(100, '原因最多 100 字'),
    /** 换下的手牌是否同时锁定（丢失、损坏时应锁定，避免再次发出） */
    lockOld: z.boolean().default(false),
    /** 丢牌赔偿（分）：挂到客人账单；与当前规则的金额不一致时拒绝，避免改价后挂错。不收时为 null */
    lostFee: z.number().int().positive('赔偿金额不正确').nullable().default(null),
    /** 当场授权编号：换到等级不够的 VIP 柜时，由值班经理 / 店总签发 */
    vipGrantId: z.uuid('授权编号格式不正确').nullable().default(null),
  })
  .refine((v) => v.lostFee === null || v.lockOld, { message: '丢失的手牌需要同时锁定，避免再次发出', path: ['lockOld'] });
export type SwapInputData = z.input<typeof SwapInput>;

export async function swapTag(deps: Deps, visitId: number, raw: SwapInputData, ctx: OpContext) {
  const input = parse(SwapInput, raw);
  const { clientKey: key, ...payload } = input;
  const requestHash = hashRequest({ visitId, ...hashedPayload(payload, ['lostFee', 'vipGrantId']) });
  await runIdempotent(deps, { key, opType: 'tag_swap', requestHash }, async (tx) => {
    const at = ctx.at ?? new Date();
    const rules = await loadFrontdeskRules(tx);
    const [peek] = await tx<{ tagId: number; code: string }[]>`
      SELECT v.tag_id, t.code FROM visits v JOIN hand_tags t ON t.id = v.tag_id WHERE v.id = ${visitId}`;
    if (!peek) throw notFound('来访记录不存在');
    if (peek.code === input.toTagCode) throw badRequest('新手牌与原手牌相同');
    // ① 手牌（新旧两张，id 升序）→ ③ 来访 → 账单（收丢牌赔偿时）→ 授权凭据
    const tags = await lockTagsByCode(tx, [peek.code, input.toTagCode]);
    const visit = (await lockVisits(tx, [visitId])).get(visitId)!;
    assertOpen(visit);
    if (visit.tagId !== peek.tagId) throw conflict('VISIT_CHANGED', '这位客人刚刚已换过牌，请刷新后再操作');
    const from = tags.get(peek.code)!;
    const to = tags.get(input.toTagCode)!;
    assertTagIssuable(to, visit.zone);
    const busy = await openVisitsOnTags(tx, [to.id]);
    if (busy.length) throw conflict('TAG_OCCUPIED', `手牌 ${to.code} 已在店（来访 ${busy[0]!.visitNo}），请换一张空闲手牌`);

    // VIP 柜：按这位客人的会员等级核对
    let shortfalls: ReturnType<typeof vipShortfalls> = [];
    if (to.kind === 'vip') {
      const levels = await memberLevels(tx, visit.memberId ? [visit.memberId] : [], rules);
      const [m] = visit.memberId ? await tx<{ name: string }[]>`SELECT name FROM members WHERE id = ${visit.memberId}` : [];
      shortfalls = vipShortfalls([{ tag: to, memberId: visit.memberId, memberName: m?.name ?? null }], levels);
      assertVipAllowed(shortfalls, levels, rules, input.vipGrantId);
    }
    if (input.lostFee !== null) {
      if (rules.lostTagFeeCents <= 0) throw unprocessable('LOST_FEE_DISABLED', '当前规则不收丢牌赔偿，请取消「收取丢牌赔偿」后重试');
      if (input.lostFee !== rules.lostTagFeeCents) {
        throw conflict('PRICE_CHANGED', `丢牌赔偿刚刚调整为 ${formatYuan(rules.lostTagFeeCents)}，请核对后重新确认`, { fee: rules.lostTagFeeCents });
      }
    }
    const date = await businessDate(tx, deps, at);

    await tx`UPDATE visits SET tag_id = ${to.id} WHERE id = ${visit.id}`;
    if (input.lostFee !== null) {
      // 丢牌赔偿作为挂账明细（来源「其他」），与本次换牌共用操作编号
      const name = `手牌丢失赔偿（${from.code}）`;
      await tx`SELECT id FROM bills WHERE id = ${visit.billId} FOR UPDATE`;
      await tx`
        INSERT INTO bill_lines (bill_id, source, item_id, name, unit_price, quantity, amount, post_key, business_date, posted_by, posted_at)
        VALUES (${visit.billId}, 'other', NULL, ${name}, ${input.lostFee}, 1, ${input.lostFee}, ${key}, ${date}, ${ctx.actor.id}, ${at})`;
      await tx`UPDATE bills SET amount_cents = amount_cents + ${input.lostFee}, line_count = line_count + 1 WHERE id = ${visit.billId}`;
    }
    const override = await consumeVipShortfalls(tx, shortfalls, input.vipGrantId, ctx.actor, `tag_swap:${key}`);
    const [change] = await tx<{ id: number }[]>`
      INSERT INTO visit_tag_changes (visit_id, from_tag_id, to_tag_id, reason, old_tag_locked, operator_id, created_at, vip_override_by)
      VALUES (${visit.id}, ${from.id}, ${to.id}, ${input.reason}, ${input.lockOld}, ${ctx.actor.id}, ${at}, ${override?.approverId ?? null})
      RETURNING id`;
    if (input.lockOld) {
      await tx`
        UPDATE hand_tags SET locked = true, lock_reason = ${input.reason}, locked_by = ${ctx.actor.id}, locked_at = ${at}, updated_at = now()
        WHERE id = ${from.id}`;
    }
    await saveKey(tx, key, 'tag_swap', requestHash, change!.id, ctx.actor.id);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'frontdesk_swap',
      targetType: 'visit',
      targetId: visit.id,
      detail: {
        visitNo: visit.visitNo,
        from: from.code,
        to: to.code,
        reason: input.reason,
        lockOld: input.lockOld,
        ...(input.lostFee !== null ? { lostFee: input.lostFee } : {}),
        ...(override ? { vipOverride: { approverId: override.approverId, approverName: override.approverName, grantId: input.vipGrantId } } : {}),
      },
      ip: ctx.ip,
      businessDate: date,
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
    memberId: number | null; memberName: string | null; memberPhoneTail: string | null; guestLabel: string | null; groupId: number | null;
    groupNo: string | null; groupOpenCount: number; amountCents: number | null; lineCount: number | null;
  })[]>`
    SELECT t.id, t.code, t.zone, t.kind, t.vip_level, t.locked, t.lock_reason, t.active, t.is_synthetic,
           v.id AS visit_id, v.visit_no, v.bill_id, v.checked_in_at, v.member_id, m.name AS member_name, right(m.phone, 4) AS member_phone_tail,
           v.guest_label,
           v.group_id, g.group_no,
           CASE WHEN v.group_id IS NULL THEN 0 ELSE count(v.id) OVER (PARTITION BY v.group_id) END AS group_open_count,
           b.amount_cents, b.line_count
    FROM hand_tags t
    LEFT JOIN visits v ON v.tag_id = t.id AND v.status = 'open'
    LEFT JOIN members m ON m.id = v.member_id
    LEFT JOIN visit_groups g ON g.id = v.group_id
    LEFT JOIN bills b ON b.id = v.bill_id
    WHERE t.active OR v.id IS NOT NULL
    ORDER BY CASE t.zone WHEN 'male' THEN 0 WHEN 'female' THEN 1 ELSE 2 END, t.kind = 'vip', t.vip_level,
             regexp_replace(t.code, '[0-9]', '', 'g'), length(t.code), t.code`;
  const tags = rows.map((r) => ({
    id: r.id,
    code: r.code,
    zone: r.zone,
    kind: r.kind,
    vipLevel: r.vipLevel,
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
          memberPhoneTail: r.memberPhoneTail,
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
  const inStoreByZone: Record<TagZone, number> = { male: 0, female: 0, child: 0 };
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
    id: number; visitNo: string; status: VisitDetail['status']; zone: TagZone; guestLabel: string; businessDate: string;
    checkedInAt: string; checkedInById: number; checkedInByName: string; closedAt: string | null; closeReason: string | null;
    closedByName: string | null; memberId: number | null; groupId: number | null; billId: number; billNo: string;
    billStatus: VisitDetail['status']; amountCents: number; lineCount: number;
    tagId: number; tagCode: string; tagZone: TagZone; tagKind: VisitDetail['tag']['kind']; tagVipLevel: number | null;
    tagLocked: boolean; tagLockReason: string | null; tagActive: boolean; tagSynthetic: boolean; vipOverrideByName: string | null;
    backfill: BackfillMark | null;
  }[]>`
    SELECT v.id, v.visit_no, v.status, v.zone, v.guest_label, v.business_date, v.checked_in_at, ${backfillMarkSql(db, 'v.checkin_key')} AS backfill,
           v.checked_in_by AS checked_in_by_id, s.display_name AS checked_in_by_name, v.closed_at, v.close_reason,
           cs.display_name AS closed_by_name, v.member_id, v.group_id,
           b.id AS bill_id, b.bill_no, b.status AS bill_status, b.amount_cents, b.line_count,
           t.id AS tag_id, t.code AS tag_code, t.zone AS tag_zone, t.kind AS tag_kind, t.vip_level AS tag_vip_level,
           t.locked AS tag_locked, t.lock_reason AS tag_lock_reason, t.active AS tag_active, t.is_synthetic AS tag_synthetic,
           os.display_name AS vip_override_by_name
    FROM visits v JOIN bills b ON b.id = v.bill_id JOIN hand_tags t ON t.id = v.tag_id
    JOIN staff s ON s.id = v.checked_in_by LEFT JOIN staff cs ON cs.id = v.closed_by LEFT JOIN staff os ON os.id = v.vip_override_by
    WHERE v.id = ${id}`;
  if (!v) throw notFound('来访记录不存在');

  const [member] = v.memberId
    ? await db<NonNullable<VisitDetail['member']>[]>`
        SELECT id, member_no, name, phone, gender, status, principal_balance, bonus_balance FROM members WHERE id = ${v.memberId}`
    : [];
  const memberLevel = v.memberId ? ((await memberLevels(db, [v.memberId], await loadFrontdeskRules(db))).get(v.memberId) ?? null) : null;

  const lines = (
    await db<VisitDetail['lines']>`
      SELECT l.id, l.source, l.item_id, l.tier, l.name, l.unit_price, l.quantity, l.amount, l.status, l.post_key, l.business_date,
             l.posted_by AS posted_by_id, p.display_name AS posted_by_name, l.posted_at, l.void_reason,
             vs.display_name AS voided_by_name, l.voided_at, ${backfillMarkSql(db, 'l.post_key')} AS backfill
      FROM bill_lines l JOIN staff p ON p.id = l.posted_by LEFT JOIN staff vs ON vs.id = l.voided_by
      WHERE l.bill_id = ${v.billId} ORDER BY l.id`
  ).map((l) => ({ ...l, backfill: normalizeMark(l.backfill) }));
  const backfill = normalizeMark(v.backfill);

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
    {
      at: v.checkedInAt,
      kind: 'checkin',
      text: `开牌 · ${ZONE_LABELS[v.zone].title}${v.vipOverrideByName ? `（VIP 柜由${v.vipOverrideByName}当场授权）` : ''}${backfill ? `（${backfillText(backfill)}）` : ''}`,
      operatorName: v.checkedInByName,
    },
  ];
  const swaps = await db<{ createdAt: string; fromCode: string; toCode: string; reason: string; oldTagLocked: boolean; operatorName: string; overrideByName: string | null }[]>`
    SELECT c.created_at, f.code AS from_code, t.code AS to_code, c.reason, c.old_tag_locked, s.display_name AS operator_name,
           os.display_name AS override_by_name
    FROM visit_tag_changes c JOIN hand_tags f ON f.id = c.from_tag_id JOIN hand_tags t ON t.id = c.to_tag_id
    JOIN staff s ON s.id = c.operator_id LEFT JOIN staff os ON os.id = c.vip_override_by
    WHERE c.visit_id = ${id} ORDER BY c.id`;
  for (const s of swaps) {
    history.push({
      at: s.createdAt,
      kind: 'swap',
      text: `换牌 ${s.fromCode} → ${s.toCode}（${s.reason}${s.oldTagLocked ? `，${s.fromCode} 已锁定` : ''}${s.overrideByName ? `，VIP 柜由${s.overrideByName}当场授权` : ''}）`,
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
    history.push({
      at: l.postedAt,
      kind: 'post',
      text: `挂账 ${l.name} × ${l.quantity}（${formatYuan(l.amount)}${l.backfill ? `，${backfillText(l.backfill)}` : ''}）`,
      operatorName: l.postedByName,
    });
    if (l.status === 'voided') {
      history.push({ at: l.voidedAt!, kind: 'void', text: `作废 ${l.name} × ${l.quantity}（${l.voidReason}）`, operatorName: l.voidedByName ?? '' });
    }
  }
  const ticketChanges = await db<{ createdAt: string; fromName: string | null; toName: string; operatorName: string }[]>`
    SELECT c.created_at, f.name AS from_name, t.name AS to_name, s.display_name AS operator_name
    FROM visit_ticket_changes c LEFT JOIN ticket_types f ON f.id = c.from_type_id JOIN ticket_types t ON t.id = c.to_type_id
    JOIN staff s ON s.id = c.operator_id WHERE c.visit_id = ${id} ORDER BY c.id`;
  for (const c of ticketChanges) {
    history.push({ at: c.createdAt, kind: 'ticket', text: c.fromName ? `改票种 ${c.fromName} → ${c.toName}` : `选定票种 ${c.toName}`, operatorName: c.operatorName });
  }
  // 结账与反结账（反结账后来访恢复在店，可能再次结账）
  const checkouts = await db<{ id: number; checkoutNo: string; status: 'completed' | 'voided'; createdAt: string; operatorName: string; voidedAt: string | null; voidedByName: string | null; voidReason: string | null; amount: number }[]>`
    SELECT c.id, c.checkout_no, c.status, c.created_at, s.display_name AS operator_name, c.voided_at, vs.display_name AS voided_by_name,
           c.void_reason, cb.amount
    FROM checkout_bills cb JOIN checkouts c ON c.id = cb.checkout_id JOIN staff s ON s.id = c.operator_id
    LEFT JOIN staff vs ON vs.id = c.voided_by
    WHERE cb.bill_id = ${v.billId} ORDER BY c.id`;
  for (const c of checkouts) {
    history.push({ at: c.createdAt, kind: 'close', text: `结账 ${c.checkoutNo}（${formatYuan(c.amount)}）`, operatorName: c.operatorName });
    if (c.voidedAt) history.push({ at: c.voidedAt, kind: 'reopen', text: `反结账 ${c.checkoutNo}（${c.voidReason}），恢复在店`, operatorName: c.voidedByName ?? '' });
  }
  if (v.closedAt && v.status === 'cancelled') {
    history.push({ at: v.closedAt, kind: 'close', text: `撤销来访（${v.closeReason}）`, operatorName: v.closedByName ?? '' });
  }
  history.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const [now] = await db<{ now: string }[]>`SELECT now() AS now`;
  const lastCheckout = checkouts.at(-1);
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
    tag: {
      id: v.tagId,
      code: v.tagCode,
      zone: v.tagZone,
      kind: v.tagKind,
      vipLevel: v.tagVipLevel,
      locked: v.tagLocked,
      lockReason: v.tagLockReason,
      active: v.tagActive,
      isSynthetic: v.tagSynthetic,
    },
    member: member ?? null,
    memberLevel,
    vipOverrideByName: v.vipOverrideByName,
    backfill,
    ticket: await visitTicket(db, v.id, v.closedAt ? new Date(v.closedAt) : new Date(now!.now)),
    checkout: lastCheckout ? { id: lastCheckout.id, checkoutNo: lastCheckout.checkoutNo, status: lastCheckout.status } : null,
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
  const visits = await db<{ visitId: number; visitNo: string; tagCode: string; zone: TagZone; memberName: string | null; guestLabel: string; checkedInAt: string; amountCents: number; status: string; billId: number }[]>`
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
  if (row.opType === 'checkout') return { found: true as const, type: 'checkout' as const, checkout: await getCheckout(db, row.refId) };
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
