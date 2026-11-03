// 票种与来访的门票（店主 2026-10-27 #31；❓3 儿童免票、❓6 跳档宽限）。
//
// 票种在后台维护（12 小时档 / 24 小时档两个价）；接待时为每位客人选定票种并留存当时的票价，
// 在店期间可以改票种（留痕）；门票金额在结账时按在店时长计算（见 @shared/checkout 的 priceTicket）。
// 改成更便宜的票种或免票（接待时直接选免票也算）要值班经理及以上当场授权并填原因（R1.2，店主 2026-10-29 签认），
// 授权人与原因记在改票种记录上。

import { z } from 'zod';
import { isFreeTicket, priceTicket, ticketChangeNeedsGrant, ticketTierLabel, type TicketType } from '@shared/checkout';
import type { VisitDetail } from '@shared/frontdesk';
import type { Db, Sql, Tx } from '../../db';
import { consumeTicketGrant } from '../../auth/grants';
import { writeAudit } from '../../lib/audit';
import type { Deps, OpContext } from '../../lib/context';
import { badRequest, conflict, notFound, unprocessable } from '../../lib/errors';
import { cents, parse } from '../../lib/validate';
import { assertOpen, businessDate, loadFrontdeskRules, lockVisits, setTxTimeouts } from './common';
import { memberTicketExtensions } from '../ticket-extensions';

export async function listTicketTypes(db: Db, all = false): Promise<TicketType[]> {
  return db<TicketType[]>`
    SELECT id, name, price_12h, price_24h, note, active, is_default, sort_order FROM ticket_types
    WHERE ${all} OR active ORDER BY sort_order, id`;
}

/** 接待或改票种时取票种（必须启用）；不指定时取默认票种，没有默认票种时为 null */
export async function resolveTicketType(db: Db, id: number | undefined): Promise<TicketType | null> {
  const [row] =
    id === undefined
      ? await db<TicketType[]>`SELECT id, name, price_12h, price_24h, note, active, is_default, sort_order FROM ticket_types WHERE is_default`
      : await db<TicketType[]>`SELECT id, name, price_12h, price_24h, note, active, is_default, sort_order FROM ticket_types WHERE id = ${id}`;
  if (id !== undefined && (!row || !row.active)) throw unprocessable('TICKET_UNAVAILABLE', '所选票种不存在或已停用，请重新选择');
  return row ?? null;
}

const TicketTypeInput = z
  .object({
    name: z.string().trim().min(1, '请填写票种名称').max(32, '名称最多 32 字'),
    price12h: cents('12 小时档价格'),
    price24h: cents('24 小时档价格'),
    note: z.string().trim().max(100, '说明最多 100 字').default(''),
    active: z.boolean().default(true),
    isDefault: z.boolean().default(false),
    sortOrder: z.number().int().min(0).max(9999).default(0),
  })
  .refine((v) => v.price24h >= v.price12h, { message: '24 小时档价格不能低于 12 小时档', path: ['price24h'] })
  .refine((v) => v.active || !v.isDefault, { message: '停用的票种不能设为默认', path: ['isDefault'] });
export type TicketTypeInputData = z.input<typeof TicketTypeInput>;

/** 新建或修改票种。改价只影响之后选定这一票种的客人；已在店的客人按接待时留存的票价计算 */
export async function saveTicketType(sql: Sql, id: number | null, raw: TicketTypeInputData, ctx: OpContext): Promise<TicketType[]> {
  const input = parse(TicketTypeInput, raw);
  await sql.begin(async (tx) => {
    // 票种保存之间串行：保证最多一个默认票种
    await tx`SELECT pg_advisory_xact_lock(hashtext('ticket_types'))`;
    const [dup] = await tx<{ id: number }[]>`SELECT id FROM ticket_types WHERE name = ${input.name} AND id IS DISTINCT FROM ${id}`;
    if (dup) throw conflict('DUPLICATE_NAME', `已有票种「${input.name}」`);
    if (input.isDefault) await tx`UPDATE ticket_types SET is_default = false, updated_at = now() WHERE is_default AND id IS DISTINCT FROM ${id}`;
    let before: TicketType | undefined;
    if (id) {
      [before] = await tx<TicketType[]>`
        SELECT id, name, price_12h, price_24h, note, active, is_default, sort_order FROM ticket_types WHERE id = ${id} FOR UPDATE`;
      if (!before) throw notFound('票种不存在');
      await tx`
        UPDATE ticket_types SET name = ${input.name}, price_12h = ${input.price12h}, price_24h = ${input.price24h}, note = ${input.note},
                                active = ${input.active}, is_default = ${input.isDefault}, sort_order = ${input.sortOrder}, updated_at = now()
        WHERE id = ${id}`;
    } else {
      await tx`
        INSERT INTO ticket_types (name, price_12h, price_24h, note, active, is_default, sort_order)
        VALUES (${input.name}, ${input.price12h}, ${input.price24h}, ${input.note}, ${input.active}, ${input.isDefault}, ${input.sortOrder})`;
    }
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'ticket_type_saved',
      targetType: 'ticket_type',
      targetId: id ?? undefined,
      detail: { name: input.name, before: before ?? null, after: input },
      ip: ctx.ip,
    });
  });
  return listTicketTypes(sql, true);
}

export const VisitTicketInput = z.object({
  ticketTypeId: z.number('请选择票种').int().positive('请选择票种'),
  /** 改成更便宜的票种或免票时，值班经理及以上当场签发的授权编号（原因随授权填写） */
  grantId: z.uuid('授权编号格式不正确').nullable().default(null),
});

/** 降档 / 免票的授权人与原因（记在改票种记录上） */
export interface TicketApproval {
  approverId: number;
  approverName: string;
  reason: string;
}

/** 需要授权却没有带授权时的提示（接待、改票种共用） */
export function ticketAuthRequired(items: { tagCode: string; ticketTypeId: number; name: string; free: boolean }[]) {
  const first = items[0]!;
  return unprocessable(
    'TICKET_AUTH_REQUIRED',
    `手牌 ${items.map((i) => i.tagCode).join('、')} 选「${first.name}」${first.free ? '是免票' : '比原来的票种便宜'}，需要值班经理、店总或店主当场授权并填写原因`,
    { items: items.map(({ tagCode, ticketTypeId }) => ({ tagCode, ticketTypeId })) },
  );
}

/** 改票种（在店期间）：留存新票种当前的票价，记一条改票种记录；改成更便宜的票种或免票要当场授权 */
export async function setVisitTicket(deps: Deps, visitId: number, raw: unknown, ctx: OpContext) {
  const input = parse(VisitTicketInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const at = ctx.at ?? new Date();
    const visit = (await lockVisits(tx, [visitId])).get(visitId)!;
    assertOpen(visit);
    const [cur] = await tx<{ ticketTypeId: number | null; price12h: number | null; price24h: number | null; tagCode: string }[]>`
      SELECT v.ticket_type_id, v.ticket_price_12h AS price12h, v.ticket_price_24h AS price24h, t.code AS tag_code
      FROM visits v JOIN hand_tags t ON t.id = v.tag_id WHERE v.id = ${visitId}`;
    if (cur!.ticketTypeId === input.ticketTypeId) throw badRequest('票种没有变化');
    const type = (await resolveTicketType(tx, input.ticketTypeId))!;
    const current = cur!.ticketTypeId === null ? null : { price12h: cur!.price12h!, price24h: cur!.price24h! };
    let approval: TicketApproval | null = null;
    if (ticketChangeNeedsGrant(type, current)) {
      if (!input.grantId) throw ticketAuthRequired([{ tagCode: cur!.tagCode, ticketTypeId: type.id, name: type.name, free: isFreeTicket(type) }]);
      // 授权最后加锁并核销（业务回滚时一起回滚）
      approval = await consumeTicketGrant(tx, {
        grantId: input.grantId,
        actor: ctx.actor,
        needed: [{ tagCode: cur!.tagCode, ticketTypeId: type.id }],
        usedRef: `ticket:${visitId}:${type.id}`,
      });
    }
    await applyVisitTicket(tx, visitId, cur!.ticketTypeId, type, ctx.actor.id, at, approval);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'frontdesk_ticket',
      targetType: 'visit',
      targetId: visitId,
      detail: {
        visitNo: visit.visitNo,
        from: cur!.ticketTypeId,
        to: type.id,
        name: type.name,
        ...(approval ? { approval: { approverId: approval.approverId, approverName: approval.approverName, reason: approval.reason, grantId: input.grantId } } : {}),
      },
      ip: ctx.ip,
      businessDate: await businessDate(tx, deps, at),
    });
  });
}

/** 写入来访的票种与票价快照，并记一条改票种记录（调用方已锁来访）；降档 / 免票时记下授权人与原因 */
export async function applyVisitTicket(
  tx: Tx,
  visitId: number,
  fromTypeId: number | null,
  type: TicketType,
  operatorId: number,
  at: Date,
  approval: TicketApproval | null = null,
) {
  await tx`
    UPDATE visits SET ticket_type_id = ${type.id}, ticket_price_12h = ${type.price12h}, ticket_price_24h = ${type.price24h}
    WHERE id = ${visitId}`;
  await tx`
    INSERT INTO visit_ticket_changes (visit_id, from_type_id, to_type_id, price_12h, price_24h, operator_id, created_at, approved_by, reason)
    VALUES (${visitId}, ${fromTypeId}, ${type.id}, ${type.price12h}, ${type.price24h}, ${operatorId}, ${at},
            ${approval?.approverId ?? null}, ${approval?.reason ?? null})`;
}

/**
 * 来访详情里的门票：按留存的票价与当前时刻计算。
 * 会员的浴票延迟（v0.7.25 续）：在店的按门店当前营业日 today 推算会员的档阶，与结账核对、看板同一算法
 * （测试会话预检 46009c2：原来用接待那一天，跨营业日时体验已到期、到期处理还没跑的会员，详情与核对的门票不一致）；
 * 已结账离店的按结账单记下的（快照），不再按现在的档阶重算
 */
export async function visitTicket(db: Db, visitId: number, at: Date, today: string): Promise<VisitDetail['ticket']> {
  const [v] = await db<{
    typeId: number | null; name: string | null; price12h: number | null; price24h: number | null; checkedInAt: string; ticketEndAt: string | null;
    memberId: number | null; status: string;
  }[]>`
    SELECT v.ticket_type_id AS type_id, t.name, v.ticket_price_12h AS price12h, v.ticket_price_24h AS price24h, v.checked_in_at, v.ticket_end_at,
           v.member_id, v.status
    FROM visits v LEFT JOIN ticket_types t ON t.id = v.ticket_type_id WHERE v.id = ${visitId}`;
  if (!v || v.typeId === null) return null;
  const rules = await loadFrontdeskRules(db);
  const prices = { price12h: v.price12h!, price24h: v.price24h! };
  const extension = v.status === 'open' ? await currentExtension(db, v.memberId, today) : await checkoutExtension(db, visitId);
  // 反结账后重结：门票计到第一次结账的时刻
  const p = priceTicket(prices, v.checkedInAt, v.ticketEndAt ? new Date(v.ticketEndAt) : at, rules.overtimeGraceMinutes + (extension?.minutes ?? 0));
  return {
    typeId: v.typeId,
    name: v.name!,
    ...prices,
    segments: p.segments,
    tierLabel: ticketTierLabel(p.segments),
    amount: p.amount,
    nextJumpAt: p.nextJumpAt,
    nextAmount: p.nextAmount,
    endAt: v.ticketEndAt ? new Date(v.ticketEndAt).toISOString() : null,
    extension,
  };
}

type VisitExtension = NonNullable<VisitDetail['ticket']>['extension'];

/** 在店客人：会员此刻（门店当前营业日）的浴票延迟 */
async function currentExtension(db: Db, memberId: number | null, today: string): Promise<VisitExtension> {
  if (!memberId) return null;
  const e = (await memberTicketExtensions(db, [Number(memberId)], today)).get(Number(memberId));
  return e ? { minutes: e.minutes, benefitId: e.benefitId, code: e.code, name: e.name } : null;
}

/** 已结账的客人：最近一张有效结账单记下的浴票延迟 */
async function checkoutExtension(db: Db, visitId: number): Promise<VisitExtension> {
  const [r] = await db<{ minutes: number; benefitId: number | null; code: string | null; name: string | null }[]>`
    SELECT cb.ticket_extension_minutes AS minutes, cb.ticket_extension_benefit_id AS benefit_id, be.code, be.name
    FROM checkout_bills cb JOIN checkouts c ON c.id = cb.checkout_id LEFT JOIN benefits be ON be.id = cb.ticket_extension_benefit_id
    WHERE cb.visit_id = ${visitId} AND c.status = 'completed' ORDER BY c.id DESC LIMIT 1`;
  if (!r || r.minutes <= 0 || r.benefitId === null) return null;
  return { minutes: r.minutes, benefitId: Number(r.benefitId), code: r.code ?? '', name: r.name ?? '' };
}
