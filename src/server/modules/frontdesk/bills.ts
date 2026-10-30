// 共同账单挂账：登记项目（价格随明细留存）、作废更正。
//
// 挂账不等于收款：本阶段只写账单明细与账单合计，不写 consumptions / ledger_entries，不改会员余额。

import { z } from 'zod';
import { PRICE_TIER_LABELS, PRICE_TIERS, type PriceTier } from '@shared/catalog';
import { can } from '@shared/permissions';
import { ZONE_LABELS, type BillSource } from '@shared/frontdesk';
import { CALL_TYPES, canServe, gradeLabel, technicianText, tierFor, type CallType } from '@shared/technicians';
import { writeAudit } from '../../lib/audit';
import type { Deps, OpContext } from '../../lib/context';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { parse, positiveCents } from '../../lib/validate';
import { assertCanFix, assertOpen, businessDate, hashRequest, loadFrontdeskRules, lockVisits, runIdempotent, saveKey, setTxTimeouts } from './common';
import { loadPricedItems, priceLine } from '../pricing';
import { loadTechnicianRules, loadTechnicians } from '../technicians';
import { attachSessions, lockQueue, syncSessionAfterVoid, type SessionPostOptions } from '../clockroom';
import { assertAfterVisits, backfillDetail, BackfillInput, recordBackfill, resolveBackfill } from './backfill';
import { getVisit } from './visits';

export const PostInput = z
  .object({
    clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
    lines: z
      .array(
        z
          .object({
            itemId: z.number().int().positive(),
            quantity: z.number().int().min(1, '数量至少为 1').max(99, '单项数量最多 99'),
            /** 价格档；不带时按项目的默认档计价（升级前留下的待确认请求不带这一项） */
            tier: z.enum(PRICE_TIERS, '价格档不正确').optional(),
            /** 技师与点钟 / 轮钟（v0.7.0，需要技师的项目）；不带时与升级前的请求完全相同（幂等摘要不变） */
            technicianId: z.number().int().positive().nullish().transform((v) => v ?? undefined),
            callType: z.enum(CALL_TYPES, '上钟方式应为点钟或轮钟').nullish().transform((v) => v ?? undefined),
          })
          .refine((l) => (l.technicianId === undefined) === (l.callType === undefined), '选了技师时请同时选择点钟或轮钟'),
      )
      .max(30, '一次最多登记 30 项')
      .default([]),
    customLines: z
      .array(z.object({ name: z.string().trim().min(1, '请填写项目名称').max(32, '项目名称最多 32 字'), amount: positiveCents('金额') }))
      .max(10)
      .default([]),
    /** 店员确认时看到的本次合计；与服务端按当前价格计算的不一致时拒绝，避免改价后挂错金额 */
    expectedTotal: positiveCents('本次合计'),
    /** 按实际时间补录纸质单（R1.9）：纸质单号与实际时间；平时不带 */
    backfill: BackfillInput,
  })
  .refine((v) => v.lines.length + v.customLines.length > 0, '请至少选择一个项目');
export type PostInputData = z.input<typeof PostInput>;

/** 钟房派钟、加钟时附带的钟单选项（前台挂账不带：需要技师的明细照样建钟单，等钟房上钟） */
export interface PostOptions {
  session?: Omit<SessionPostOptions, 'backfill'>;
}

export async function postCharges(deps: Deps, visitId: number, raw: PostInputData, ctx: OpContext, options: PostOptions = {}) {
  const input = parse(PostInput, raw);
  if (input.customLines.length > 0 && !can(ctx.actor, 'consume.customAmount')) {
    throw forbidden('当前岗位不能手动输入金额，请从项目中选择');
  }
  const { clientKey: key, ...payload } = input;
  const requestHash = hashRequest({ visitId, ...payload });
  // 补录纸质单：明细按纸质单上的实际时间登记（营业日按实际时间归属）
  const backfill = resolveBackfill(input.backfill, ctx.actor);
  await runIdempotent(deps, { key, opType: 'bill_post', requestHash }, async (tx) => {
    const at = backfill?.at ?? ctx.at ?? new Date();
    // ③ 来访 → 账单
    const visit = (await lockVisits(tx, [visitId])).get(visitId)!;
    assertOpen(visit);
    if (backfill) await assertAfterVisits(tx, at, [visit.id], 'charges', deps.config.timezone);
    const [bill] = await tx<{ id: number; status: string; amountCents: number; lineCount: number }[]>`
      SELECT id, status, amount_cents, line_count FROM bills WHERE id = ${visit.billId} FOR UPDATE`;
    if (bill!.status !== 'open') throw conflict('BILL_CLOSED', '账单已结束，不能再挂账');

    // 项目价格以服务端为准，按所选价格档计价；只限某一性别的项目（如私汤木桶浴仅女宾）按客人分区核对
    const items = await loadPricedItems(tx, input.lines.map((l) => l.itemId));
    // 技师（v0.7.0）：功能开启时，需要技师的项目记下技师与点钟 / 轮钟；价格跟等级时按技师等级取价
    const techRules = await loadTechnicianRules(tx);
    const techs = await loadTechnicians(tx, input.lines.flatMap((l) => (l.technicianId === undefined ? [] : [l.technicianId])));
    type Line = { itemId: number | null; name: string; tier: PriceTier | null; unitPrice: number; quantity: number; amount: number; source: BillSource; technicianId: number | null; callType: CallType | null; techText: string | null };
    const lines: Line[] = [];
    for (const l of input.lines) {
      const item = items.get(l.itemId);
      if (item?.gender && item.gender !== visit.zone) {
        throw unprocessable('ITEM_GENDER', `「${item.name}」仅限${ZONE_LABELS[item.gender].title}，这位客人是${ZONE_LABELS[visit.zone].title}`);
      }
      const withTech = !!item && techRules.enabled && item.technicianRequired;
      let tier = l.tier;
      let tech: { id: number; techNo: string; name: string } | null = null;
      if (item && l.technicianId !== undefined) {
        if (!techRules.enabled) throw unprocessable('TECHNICIAN_DISABLED', '技师功能已关闭，请刷新页面后重新登记');
        if (!item.technicianRequired) throw unprocessable('TECHNICIAN_NOT_NEEDED', `「${item.name}」不需要技师，请刷新页面后重新登记`);
        const t = techs.get(l.technicianId);
        if (!t) throw notFound('技师不存在，请刷新后重新选择');
        const why = canServe(t, item, techRules.tierByGrade);
        if (why) throw unprocessable('TECHNICIAN_UNAVAILABLE', `${t.techNo} 号 ${t.name}：${why}，请换一位技师`);
        const chosen = tierFor(t, item, l.tier ?? item.prices[0]!.tier, techRules.tierByGrade);
        if (l.tier && l.tier !== chosen) {
          throw conflict('TECHNICIAN_TIER', `${t.techNo} 号 ${t.name}是${gradeLabel(t.grade)}，「${item.name}」按${PRICE_TIER_LABELS[chosen]}档计价，请刷新后重新确认`);
        }
        tier = chosen;
        tech = t;
      } else if (withTech && techRules.requireTechnician) {
        throw unprocessable('TECHNICIAN_REQUIRED', `「${item!.name}」需要选技师与点钟 / 轮钟`);
      }
      const priced = priceLine(item, tier, l.quantity, '有项目已停用，请刷新后重新选择');
      lines.push({
        ...priced,
        source: withTech ? 'therapist' : 'bath',
        technicianId: tech?.id ?? null,
        callType: l.callType ?? null,
        techText: tech ? technicianText({ ...tech, callType: l.callType }) : null,
      });
    }
    for (const l of input.customLines) {
      lines.push({ itemId: null, name: l.name, tier: null, unitPrice: l.amount, quantity: 1, amount: l.amount, source: 'bath', technicianId: null, callType: null, techText: null });
    }
    const total = lines.reduce((s, l) => s + l.amount, 0);
    if (total !== input.expectedTotal) {
      throw conflict('PRICE_CHANGED', '项目价格刚刚有调整，本次合计与确认时不同，请核对后重新确认', { total });
    }

    const date = await businessDate(tx, deps, at);
    // 钟单（v0.7.1）：每条技师明细建一张钟单（或加到正在上钟的钟单），排在来访、账单之后拿技师队列锁
    const techLines = lines.filter((l) => l.technicianId !== null);
    const sessionIds = new Map<Line, number>();
    if (techLines.length > 0) {
      const [tag] = await tx<{ code: string }[]>`SELECT code FROM hand_tags WHERE id = ${visit.tagId}`;
      const ids = await attachSessions(tx, deps, {
        visitId: visit.id,
        tagCode: tag!.code,
        lines: techLines.map((l) => ({ itemId: l.itemId!, quantity: l.quantity, technicianId: l.technicianId!, callType: l.callType! })),
        date,
        at,
        actor: ctx.actor,
        options: { ...options.session, backfill: !!backfill },
      });
      techLines.forEach((l, i) => sessionIds.set(l, ids[i]!));
    } else if (options.session?.extendId !== undefined || options.session?.dispatch) {
      throw unprocessable('TECHNICIAN_REQUIRED', '派钟、加钟要选技师');
    }
    for (const l of lines) {
      await tx`
        INSERT INTO bill_lines (bill_id, source, item_id, tier, name, unit_price, quantity, amount, post_key, business_date, posted_by, posted_at,
                                technician_id, call_type, session_id)
        VALUES (${bill!.id}, ${l.source}, ${l.itemId}, ${l.tier}, ${l.name}, ${l.unitPrice}, ${l.quantity}, ${l.amount}, ${key}, ${date},
                ${ctx.actor.id}, ${at}, ${l.technicianId}, ${l.callType}, ${sessionIds.get(l) ?? null})`;
    }
    await tx`
      UPDATE bills SET amount_cents = amount_cents + ${total}, line_count = line_count + ${lines.length} WHERE id = ${bill!.id}`;
    if (backfill) await recordBackfill(tx, backfill, { kind: 'charges', opKey: key, visitId: visit.id, businessDate: date, actor: ctx.actor });
    await saveKey(tx, key, 'bill_post', requestHash, visit.id, ctx.actor.id);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'frontdesk_post',
      targetType: 'visit',
      targetId: visit.id,
      detail: { visitNo: visit.visitNo, total, lines: lines.map((l) => `${l.name}×${l.quantity}${l.techText ? `（${l.techText}）` : ''}`), ...backfillDetail(backfill) },
      ip: ctx.ip,
      businessDate: date,
    });
    return visit.id;
  });
  return getVisit(deps.sql, visitId);
}

export const VoidInput = z.object({
  reason: z.string().trim().min(2, '请填写作废原因（至少 2 个字）').max(200, '原因最多 200 字'),
});

export async function voidLine(deps: Deps, lineId: number, raw: unknown, ctx: OpContext) {
  const input = parse(VoidInput, raw);
  const [peek] = await deps.sql<{ visitId: number }[]>`
    SELECT v.id AS visit_id FROM bill_lines l JOIN visits v ON v.bill_id = l.bill_id WHERE l.id = ${lineId}`;
  if (!peek) throw notFound('账单明细不存在');
  await deps.sql.begin(async (tx) => {
    await setTxTimeouts(tx);
    const at = ctx.at ?? new Date();
    // ③ 来访 → 账单 → 明细
    const visit = (await lockVisits(tx, [peek.visitId])).get(peek.visitId)!;
    assertOpen(visit);
    await tx`SELECT id FROM bills WHERE id = ${visit.billId} FOR UPDATE`;
    const [line] = await tx<{ id: number; name: string; quantity: number; amount: number; status: string; postedBy: number; postedAt: string; voidedByName: string | null; sessionId: number | null }[]>`
      SELECT l.id, l.name, l.quantity, l.amount, l.status, l.posted_by, l.posted_at, s.display_name AS voided_by_name, l.session_id
      FROM bill_lines l LEFT JOIN staff s ON s.id = l.voided_by WHERE l.id = ${lineId} FOR UPDATE OF l`;
    if (line!.status === 'voided') {
      throw conflict('ALREADY_VOIDED', `这项明细已由${line!.voidedByName ?? '其他人'}作废，不会重复冲减`);
    }
    assertCanFix(ctx.actor, line!.postedBy, line!.postedAt, await loadFrontdeskRules(tx), at, '这项明细');
    await tx`
      UPDATE bill_lines SET status = 'voided', void_reason = ${input.reason}, voided_by = ${ctx.actor.id}, voided_at = ${at}
      WHERE id = ${line!.id}`;
    await tx`UPDATE bills SET amount_cents = amount_cents - ${line!.amount}, line_count = line_count - 1 WHERE id = ${visit.billId}`;
    // 技师明细：钟单按剩下的钟数改，一条不剩时钟单作废、技师按规则回到原位（明细 → 技师队列 → 钟单）
    if (line!.sessionId !== null) {
      await lockQueue(tx);
      await syncSessionAfterVoid(tx, deps, line!.sessionId, input.reason, ctx.actor, at);
    }
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'frontdesk_void',
      targetType: 'visit',
      targetId: visit.id,
      detail: { visitNo: visit.visitNo, lineId: line!.id, name: line!.name, quantity: line!.quantity, amount: line!.amount, reason: input.reason },
      ip: ctx.ip,
      businessDate: await businessDate(tx, deps, at),
    });
  });
  return getVisit(deps.sql, peek.visitId);
}
