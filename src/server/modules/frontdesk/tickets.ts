// 票种与来访的门票（店主 2026-10-27 #31；❓3 儿童免票、❓6 跳档宽限）。
//
// 票种在后台维护（12 小时档 / 24 小时档两个价）；接待时为每位客人选定票种并留存当时的票价，
// 在店期间可以改票种（留痕）；门票金额在结账时按在店时长计算（见 @shared/checkout 的 priceTicket）。

import { z } from 'zod';
import { priceTicket, ticketTierLabel, type TicketType } from '@shared/checkout';
import type { VisitDetail } from '@shared/frontdesk';
import type { Db, Sql, Tx } from '../../db';
import { writeAudit } from '../../lib/audit';
import type { Deps, OpContext } from '../../lib/context';
import { badRequest, conflict, notFound, unprocessable } from '../../lib/errors';
import { cents, parse } from '../../lib/validate';
import { assertOpen, businessDate, loadFrontdeskRules, lockVisits, setTxTimeouts } from './common';

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

export const VisitTicketInput = z.object({ ticketTypeId: z.number('请选择票种').int().positive('请选择票种') });

/** 改票种（在店期间）：留存新票种当前的票价，记一条改票种记录 */
export async function setVisitTicket(deps: Deps, visitId: number, raw: unknown, ctx: OpContext) {
  const input = parse(VisitTicketInput, raw);
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const at = ctx.at ?? new Date();
    const visit = (await lockVisits(tx, [visitId])).get(visitId)!;
    assertOpen(visit);
    const [cur] = await tx<{ ticketTypeId: number | null }[]>`SELECT ticket_type_id FROM visits WHERE id = ${visitId}`;
    if (cur!.ticketTypeId === input.ticketTypeId) throw badRequest('票种没有变化');
    const type = (await resolveTicketType(tx, input.ticketTypeId))!;
    await applyVisitTicket(tx, visitId, cur!.ticketTypeId, type, ctx.actor.id, at);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'frontdesk_ticket',
      targetType: 'visit',
      targetId: visitId,
      detail: { visitNo: visit.visitNo, from: cur!.ticketTypeId, to: type.id, name: type.name },
      ip: ctx.ip,
      businessDate: await businessDate(tx, deps, at),
    });
  });
}

/** 写入来访的票种与票价快照，并记一条改票种记录（调用方已锁来访） */
export async function applyVisitTicket(tx: Tx, visitId: number, fromTypeId: number | null, type: TicketType, operatorId: number, at: Date) {
  await tx`
    UPDATE visits SET ticket_type_id = ${type.id}, ticket_price_12h = ${type.price12h}, ticket_price_24h = ${type.price24h}
    WHERE id = ${visitId}`;
  await tx`
    INSERT INTO visit_ticket_changes (visit_id, from_type_id, to_type_id, price_12h, price_24h, operator_id, created_at)
    VALUES (${visitId}, ${fromTypeId}, ${type.id}, ${type.price12h}, ${type.price24h}, ${operatorId}, ${at})`;
}

/** 来访详情里的门票：按留存的票价与当前时刻计算 */
export async function visitTicket(db: Db, visitId: number, at: Date): Promise<VisitDetail['ticket']> {
  const [v] = await db<{ typeId: number | null; name: string | null; price12h: number | null; price24h: number | null; checkedInAt: string }[]>`
    SELECT v.ticket_type_id AS type_id, t.name, v.ticket_price_12h AS price12h, v.ticket_price_24h AS price24h, v.checked_in_at
    FROM visits v LEFT JOIN ticket_types t ON t.id = v.ticket_type_id WHERE v.id = ${visitId}`;
  if (!v || v.typeId === null) return null;
  const rules = await loadFrontdeskRules(db);
  const prices = { price12h: v.price12h!, price24h: v.price24h! };
  const p = priceTicket(prices, v.checkedInAt, at, rules.overtimeGraceMinutes);
  return {
    typeId: v.typeId,
    name: v.name!,
    ...prices,
    segments: p.segments,
    tierLabel: ticketTierLabel(p.segments),
    amount: p.amount,
    nextJumpAt: p.nextJumpAt,
    nextAmount: p.nextAmount,
  };
}
