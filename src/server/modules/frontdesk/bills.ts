// 共同账单挂账：登记项目（价格随明细留存）、作废更正。
//
// 挂账不等于收款：本阶段只写账单明细与账单合计，不写 consumptions / ledger_entries，不改会员余额。

import { z } from 'zod';
import { PRICE_TIER_LABELS, PRICE_TIERS, type PriceTier } from '@shared/catalog';
import { can } from '@shared/permissions';
import { MAX_MOVE_LINES, normalizeTagCode, TAG_CODE_PATTERN, ZONE_LABELS, type BillSource } from '@shared/frontdesk';
import { CALL_TYPES, canServe, gradeLabel, technicianText, tierFor, type CallType } from '@shared/technicians';
import { MAX_BILL_LINE_QUANTITY, MAX_DISH_NOTE } from '@shared/dining';
import { writeAudit } from '../../lib/audit';
import type { Tx } from '../../db';
import type { Deps, OpContext } from '../../lib/context';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { parse, positiveCents } from '../../lib/validate';
import { assertCanFix, assertOpen, businessDate, hashRequest, loadFrontdeskRules, lockVisits, runIdempotent, saveKey, setTxTimeouts } from './common';
import { loadPricedItems, priceLine } from '../pricing';
import { loadTechnicianRules, loadTechnicians } from '../technicians';
import { attachSessions, lockQueue, syncSessionAfterVoid, type SessionPostOptions } from '../clockroom';
import { cancelKitchenItem, createKitchenItems, kitchenStationsOf, takeDishLimits } from '../dining';
import { authorizeLineVoid } from '../dining-808';
import { assertAfterVisits, backfillDetail, BackfillInput, recordBackfill, resolveBackfill, type Backfill } from './backfill';
import { getVisit } from './visits';
import { locateCharges, locateSession } from '../locations';

export const PostInput = z
  .object({
    clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
    lines: z
      .array(
        z
          .object({
            itemId: z.number().int().positive(),
            quantity: z.number().int().min(1, '数量至少为 1').max(MAX_BILL_LINE_QUANTITY, `单项数量最多 ${MAX_BILL_LINE_QUANTITY}`),
            /** 价格档；不带时按项目的默认档计价（升级前留下的待确认请求不带这一项） */
            tier: z.enum(PRICE_TIERS, '价格档不正确').optional(),
            /** 技师与点钟 / 轮钟（v0.7.0，需要技师的项目）；不带时与升级前的请求完全相同（幂等摘要不变） */
            technicianId: z.number().int().positive().nullish().transform((v) => v ?? undefined),
            callType: z.enum(CALL_TYPES, '上钟方式应为点钟或轮钟').nullish().transform((v) => v ?? undefined),
            /** 口味备注（v0.7.2 餐饮：少辣、不要香菜），只给进厨房的菜；不带时与升级前的请求完全相同（幂等摘要不变） */
            note: z
              .string()
              .trim()
              .max(MAX_DISH_NOTE, `口味备注最多 ${MAX_DISH_NOTE} 字`)
              .nullish()
              .transform((v) => v || undefined),
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
  /** 点单页下单：只能点进厨房的菜（其他项目、手动金额请到前台登记） */
  dining?: { onlyKitchen: boolean };
}

export type PostInputParsed = z.output<typeof PostInput>;

/** 这一次挂账的编号与摘要；渠道入口（小程序扫码点餐，v0.7.28）另带限制 */
export interface PostTxMeta {
  key: string;
  requestHash: string;
  backfill: Backfill | null;
  /**
   * 渠道入口：不按 input.expectedTotal 核对（入口带了预期合计才核对）；份数、金额有上限；
   * 出品单写送到哪张桌；锁住来访后核对还是这位会员的在店手牌
   */
  channel?: { expectedTotal: number | null; maxQuantity: number; maxTotal: number; deliverTo: string; memberId: number };
}

export interface PostedLine {
  lineId: number;
  itemId: number | null;
  name: string;
  unitPrice: number;
  quantity: number;
  amount: number;
  note: string;
}

export interface PostResult {
  visitId: number;
  /** 进厨房的菜的出品单号（没有进厨房的为空） */
  orderNo: string | null;
  total: number;
  lines: PostedLine[];
}

export async function postCharges(deps: Deps, visitId: number, raw: PostInputData, ctx: OpContext, options: PostOptions = {}) {
  const input = parse(PostInput, raw);
  if (input.customLines.length > 0 && !can(ctx.actor, 'consume.customAmount')) {
    throw forbidden('当前岗位不能手动输入金额，请从项目中选择');
  }
  const { clientKey: key, ...payload } = input;
  // 派钟选的房间（v0.7.16）、按哪张预约派（8.0.8）也算进摘要：同一个操作编号换了房间、预约重发会被拒绝；都没有时摘要与升级前完全相同
  const spaceId = options.session?.dispatch?.spaceId;
  const bookingId = options.session?.dispatch?.bookingId;
  const requestHash = hashRequest({
    visitId,
    ...payload,
    ...(spaceId === undefined ? {} : { spaceId }),
    ...(bookingId === undefined ? {} : { bookingId }),
  });
  // 补录纸质单：明细按纸质单上的实际时间登记（营业日按实际时间归属）
  const backfill = resolveBackfill(input.backfill, ctx.actor);
  await runIdempotent(deps, { key, opType: 'bill_post', requestHash }, async (tx) =>
    (await postChargesTx(tx, deps, visitId, input, { key, requestHash, backfill }, ctx, options)).visitId,
  );
  return getVisit(deps.sql, visitId, deps.config.timezone);
}

/**
 * 挂账（调用方的事务里；前台、点单页、钟房经 postCharges 的幂等外壳调用，小程序扫码点餐经 mp-entries.ts 调用）。
 * 锁：来访 → 账单 →（技师队列 → 钟单 → 技师状态）→ 估清 → 出品单
 */
export async function postChargesTx(
  tx: Tx,
  deps: Deps,
  visitId: number,
  input: PostInputParsed,
  meta: PostTxMeta,
  ctx: OpContext,
  options: PostOptions = {},
): Promise<PostResult> {
  const { key, requestHash, backfill, channel } = meta;
  const at = backfill?.at ?? ctx.at ?? new Date();
  // ③ 来访 → 账单
  const visit = (await lockVisits(tx, [visitId])).get(visitId)!;
  assertOpen(visit);
  if (channel && Number(visit.memberId) !== channel.memberId) {
    throw conflict('VISIT_CHANGED', '这张手牌刚刚换了客人，请重新下单');
  }
  if (backfill) await assertAfterVisits(tx, at, [visit.id], 'charges', deps.config.timezone);
  const [bill] = await tx<{ id: number; status: string; amountCents: number; lineCount: number }[]>`
    SELECT id, status, amount_cents, line_count FROM bills WHERE id = ${visit.billId} FOR UPDATE`;
  if (bill!.status !== 'open') throw conflict('BILL_CLOSED', '账单已结束，不能再挂账');
  // 项目价格以服务端为准，按所选价格档计价；只限某一性别的项目（如私汤木桶浴仅女宾）按客人分区核对
  const items = await loadPricedItems(tx, input.lines.map((l) => l.itemId));
  // 技师（v0.7.0）：功能开启时，需要技师的项目记下技师与点钟 / 轮钟；价格跟等级时按技师等级取价
  const techRules = await loadTechnicianRules(tx);
  const techs = await loadTechnicians(tx, input.lines.flatMap((l) => (l.technicianId === undefined ? [] : [l.technicianId])));
  // 餐饮（S5 第一步）：功能开启时，挂在出品档口上的菜记在「餐饮」，同时建出品单进厨房
  const stations = await kitchenStationsOf(tx, input.lines.map((l) => l.itemId));
  type Line = { itemId: number | null; name: string; tier: PriceTier | null; unitPrice: number; quantity: number; amount: number; source: BillSource; technicianId: number | null; callType: CallType | null; techText: string | null; stationId: number | null; note: string };
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
    const stationId = withTech ? null : (stations.get(l.itemId) ?? null);
    if (options.dining?.onlyKitchen && stationId === null) {
      throw unprocessable('DISH_NOT_KITCHEN', `「${item!.name}」不是点单的菜，请到前台登记`);
    }
    if (l.note && stationId === null) throw unprocessable('DISH_NOTE_NOT_ALLOWED', `「${item!.name}」不进厨房，不用写口味备注`);
    lines.push({
      ...priced,
      source: withTech ? 'therapist' : stationId !== null ? 'dining' : 'bath',
      technicianId: tech?.id ?? null,
      callType: l.callType ?? null,
      techText: tech ? technicianText({ ...tech, callType: l.callType }) : null,
      stationId,
      note: l.note ?? '',
    });
  }
  for (const l of input.customLines) {
    lines.push({ itemId: null, name: l.name, tier: null, unitPrice: l.amount, quantity: 1, amount: l.amount, source: 'bath', technicianId: null, callType: null, techText: null, stationId: null, note: '' });
  }
  const total = lines.reduce((s, l) => s + l.amount, 0);
  const expectedTotal = channel ? channel.expectedTotal : input.expectedTotal;
  if (expectedTotal !== null && total !== expectedTotal) {
    throw conflict('PRICE_CHANGED', '项目价格刚刚有调整，本次合计与确认时不同，请核对后重新确认', { total });
  }
  if (channel) {
    const quantity = lines.reduce((s, l) => s + l.quantity, 0);
    if (quantity > channel.maxQuantity || total > channel.maxTotal) {
      throw unprocessable(
        'MP_ORDER_LIMIT',
        `一单最多 ${channel.maxQuantity} 份、¥${channel.maxTotal / 100}，这一单 ${quantity} 份、¥${total / 100}；多的请服务员点`,
        { quantity, total },
      );
    }
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
  // 估清（技师队列之后、建出品单之前）：今天还剩的份数不够整笔拒绝；补录纸质单的菜早已上过，不扣估清
  const dishLines = lines.filter((l) => l.stationId !== null);
  const limited = dishLines.length > 0 && !backfill
    ? await takeDishLimits(tx, dishLines.map((l) => ({ itemId: l.itemId!, name: l.name, quantity: l.quantity })), date)
    : new Set<number>();
  const lineIds = new Map<Line, number>();
  for (const l of lines) {
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO bill_lines (bill_id, source, item_id, tier, name, unit_price, quantity, amount, post_key, business_date, posted_by, posted_at,
                              technician_id, call_type, session_id)
      VALUES (${bill!.id}, ${l.source}, ${l.itemId}, ${l.tier}, ${l.name}, ${l.unitPrice}, ${l.quantity}, ${l.amount}, ${key}, ${date},
              ${ctx.actor.id}, ${at}, ${l.technicianId}, ${l.callType}, ${sessionIds.get(l) ?? null})
      RETURNING id`;
    lineIds.set(l, row!.id);
  }
  const orderNo = await createKitchenItems(tx, {
    visitId: visit.id,
    tableSessionId: null,
    deliverTo: channel?.deliverTo ?? '',
    lines: dishLines.map((l) => ({ billLineId: lineIds.get(l)!, itemId: l.itemId!, stationId: l.stationId!, quantity: l.quantity, note: l.note, limitTaken: limited.has(l.itemId!) })),
    date,
    at,
    actor: ctx.actor,
    backfill: !!backfill,
  });
  await tx`
    UPDATE bills SET amount_cents = amount_cents + ${total}, line_count = line_count + ${lines.length} WHERE id = ${bill!.id}`;
  // 实时位置（v0.7.17）：客人在项目配的区域（几个不同区域按项目多的；补录的不记）
  await locateCharges(tx, visit.id, lines.map((l) => ({ lineId: lineIds.get(l)!, itemId: l.itemId })), { at, staffId: ctx.actor.id, backfill: !!backfill });
  // 派钟马上上钟（或加钟）的钟单：技师与客人在钟单记的房间（记在消费之后，房间比项目的区域更准）
  for (const id of new Set(sessionIds.values())) await locateSession(tx, id, 'session_start', { at, staffId: ctx.actor.id, backfill: !!backfill });
  if (backfill) await recordBackfill(tx, backfill, { kind: 'charges', opKey: key, visitId: visit.id, businessDate: date, actor: ctx.actor });
  await saveKey(tx, key, 'bill_post', requestHash, visit.id, ctx.actor.id);
  await writeAudit(tx, {
    staffId: ctx.actor.id,
    action: 'frontdesk_post',
    targetType: 'visit',
    targetId: visit.id,
    detail: { visitNo: visit.visitNo, total, lines: lines.map((l) => `${l.name}×${l.quantity}${l.techText ? `（${l.techText}）` : ''}${l.note ? `（${l.note}）` : ''}`), ...backfillDetail(backfill) },
    ip: ctx.ip,
    businessDate: date,
  });
  return {
    visitId: visit.id,
    orderNo,
    total,
    lines: lines.map((l) => ({ lineId: lineIds.get(l)!, itemId: l.itemId, name: l.name, unitPrice: l.unitPrice, quantity: l.quantity, amount: l.amount, note: l.note })),
  };
}

export const VoidInput = z.object({
  reason: z.string().trim().min(2, '请填写作废原因（至少 2 个字）').max(200, '原因最多 200 字'),
  /** 退超过小额上限的菜时值班经理及以上的当场授权（8.0.8，B02） */
  grantId: z.uuid('授权编号不正确').optional(),
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
    const [line] = await tx<{ id: number; name: string; source: string; quantity: number; amount: number; status: string; postedBy: number; postedAt: string; voidedByName: string | null; sessionId: number | null }[]>`
      SELECT l.id, l.name, l.source, l.quantity, l.amount, l.status, l.posted_by, l.posted_at, s.display_name AS voided_by_name, l.session_id
      FROM bill_lines l LEFT JOIN staff s ON s.id = l.voided_by WHERE l.id = ${lineId} FOR UPDATE OF l`;
    if (line!.status === 'voided') {
      throw conflict('ALREADY_VOIDED', `这项明细已由${line!.voidedByName ?? '其他人'}作废，不会重复冲减`);
    }
    // 8.0.8（B02）：餐饮的菜小额直接退；超过的经理、当场授权或本人 15 分钟内（其他明细照旧）
    const approval = await authorizeLineVoid(tx, { line: line!, actor: ctx.actor, at, grantId: input.grantId, what: '这项明细' });
    await tx`
      UPDATE bill_lines SET status = 'voided', void_reason = ${input.reason}, voided_by = ${ctx.actor.id}, voided_at = ${at}
      WHERE id = ${line!.id}`;
    await tx`UPDATE bills SET amount_cents = amount_cents - ${line!.amount}, line_count = line_count - 1 WHERE id = ${visit.billId}`;
    // 技师明细：钟单按剩下的钟数改，一条不剩时钟单作废、技师按规则回到原位（明细 → 技师队列 → 钟单）
    if (line!.sessionId !== null) {
      await lockQueue(tx);
      await syncSessionAfterVoid(tx, deps, line!.sessionId, input.reason, ctx.actor, at);
    }
    // 餐饮明细（退菜）：出品单改为已退，扣过估清的按原份数加回
    await cancelKitchenItem(tx, line!.id, `退菜：${input.reason}`, ctx.actor, at);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'frontdesk_void',
      targetType: 'visit',
      targetId: visit.id,
      detail: { visitNo: visit.visitNo, lineId: line!.id, name: line!.name, quantity: line!.quantity, amount: line!.amount, reason: input.reason, ...approval },
      ip: ctx.ip,
      businessDate: await businessDate(tx, deps, at),
    });
  });
  return getVisit(deps.sql, peek.visitId, deps.config.timezone);
}

export const MoveLinesInput = z.object({
  clientKey: z.uuid('缺少有效的操作编号，请刷新页面后重试'),
  lineIds: z
    .array(z.number().int().positive(), '请选择要转的明细')
    .min(1, '请选择要转的明细')
    .max(MAX_MOVE_LINES, `一次最多转 ${MAX_MOVE_LINES} 条`),
  toTagCode: z
    .string('请填写转到哪张手牌')
    .transform((v) => normalizeTagCode(v))
    .pipe(z.string().min(1, '请填写转到哪张手牌').regex(TAG_CODE_PATTERN, '牌号格式不正确（例如 A023、1088）')),
  reason: z.string('请填写转单原因').trim().min(2, '请填写转单原因（至少 2 个字）').max(100, '原因最多 100 字'),
});

/**
 * 转单（v0.7.6）：挂错手牌时，把在店客人账单上的一条或几条有效明细转到另一位在店客人的手牌上。
 * 原明细作废（原因写明转到哪张手牌），目标账单新增一条同样的明细（来源、项目、名称、档位、单价、数量、技师不变，
 * 挂账人记办理的人），并记下转单记录。权限与作废明细相同（自己挂的、规定分钟内；其他由有「前台更正」的岗位）。
 * 房费（随入住单走）、餐饮的菜（有出品单）、钟房派的钟（有钟单）、门票不能转。
 * 加锁：两位客人的来访（id 升序）→ 账单（id 升序）→ 明细（id 升序）
 */
export async function moveLines(deps: Deps, raw: unknown, ctx: OpContext) {
  const input = parse(MoveLinesInput, raw);
  const lineIds = [...new Set(input.lineIds)].sort((a, b) => a - b);
  const { clientKey: key, ...payload } = input;
  const requestHash = hashRequest({ ...payload, lineIds });
  const peek = await deps.sql<{ visitId: number }[]>`
    SELECT DISTINCT v.id AS visit_id FROM bill_lines l JOIN visits v ON v.bill_id = l.bill_id WHERE l.id IN ${deps.sql(lineIds)}`;
  if (peek.length === 0) throw notFound('账单明细不存在');
  if (peek.length > 1) throw badRequest('一次只能转同一位客人账单上的明细');
  const fromVisitId = peek[0]!.visitId;
  await runIdempotent(deps, { key, opType: 'line_move', requestHash }, async (tx) => {
    const at = ctx.at ?? new Date();
    const [target] = await tx<{ id: number; tagId: number }[]>`
      SELECT v.id, v.tag_id FROM visits v JOIN hand_tags t ON t.id = v.tag_id WHERE t.code = ${input.toTagCode} AND v.status = 'open'`;
    if (!target) throw conflict('TAG_NOT_IN_STORE', `手牌 ${input.toTagCode} 没有在店客人，请核对牌号`);
    if (target.id === fromVisitId) throw badRequest(`这些明细就在手牌 ${input.toTagCode} 上，不用转`);
    // 来访（id 升序）→ 账单（id 升序）→ 明细（id 升序）
    const visits = await lockVisits(tx, [fromVisitId, target.id]);
    const from = visits.get(fromVisitId)!;
    const to = visits.get(target.id)!;
    assertOpen(from);
    assertOpen(to);
    // 读到目标客人之后、锁好之前，这位客人可能刚在别的终端换了牌：牌号对不上就拒绝，不把明细转给已不在这张牌上的客人
    if (to.tagId !== target.tagId) throw conflict('TAG_CHANGED', `手牌 ${input.toTagCode} 刚刚换过牌，请刷新后重新填写转到哪张手牌`);
    const bills = await tx<{ status: string }[]>`SELECT status FROM bills WHERE id IN ${tx([from.billId, to.billId])} ORDER BY id FOR UPDATE`;
    if (bills.some((b) => b.status !== 'open')) throw conflict('BILL_CLOSED', '账单已结束，不能再转单');
    const lines = await tx<
      {
        id: number;
        billId: number;
        source: BillSource;
        itemId: number | null;
        tier: PriceTier | null;
        name: string;
        unitPrice: number;
        quantity: number;
        amount: number;
        status: string;
        postedBy: number;
        postedAt: string;
        technicianId: number | null;
        callType: CallType | null;
        sessionId: number | null;
        ticketTypeId: number | null;
        gender: 'male' | 'female' | null;
      }[]
    >`
      SELECT l.id, l.bill_id, l.source, l.item_id, l.tier, l.name, l.unit_price, l.quantity, l.amount, l.status, l.posted_by, l.posted_at,
             l.technician_id, l.call_type, l.session_id, l.ticket_type_id, si.gender
      FROM bill_lines l LEFT JOIN service_items si ON si.id = l.item_id
      WHERE l.id IN ${tx(lineIds)} ORDER BY l.id FOR UPDATE OF l`;
    if (lines.length !== lineIds.length || lines.some((l) => l.billId !== from.billId)) throw notFound('有明细不存在，请刷新后重试');
    const rules = await loadFrontdeskRules(tx);
    for (const l of lines) {
      if (l.status !== 'active') throw conflict('ALREADY_VOIDED', `「${l.name}」已作废，不能再转`);
      if (l.source === 'room') throw unprocessable('LINE_NOT_MOVABLE', `「${l.name}」是房费，随入住单走，不能转`);
      if (l.source === 'dining') throw unprocessable('LINE_NOT_MOVABLE', `「${l.name}」是餐饮的菜（有出品单），不能转；请退菜后在正确的手牌上重新点`);
      if (l.sessionId !== null) throw unprocessable('LINE_NOT_MOVABLE', `「${l.name}」是钟房派的钟（有钟单），不能转；请在钟房处理`);
      if (l.ticketTypeId !== null) throw unprocessable('LINE_NOT_MOVABLE', `「${l.name}」是门票，不能转`);
      if (l.gender && l.gender !== to.zone) {
        throw unprocessable('ITEM_GENDER', `「${l.name}」仅限${ZONE_LABELS[l.gender].title}，手牌 ${input.toTagCode} 是${ZONE_LABELS[to.zone].title}`);
      }
      assertCanFix(ctx.actor, l.postedBy, l.postedAt, rules, at, `「${l.name}」`);
    }
    const date = await businessDate(tx, deps, at);
    const [fromTag] = await tx<{ code: string }[]>`SELECT code FROM hand_tags WHERE id = ${from.tagId}`;
    const voidReason = `转到手牌 ${input.toTagCode}：${input.reason}`;
    const total = lines.reduce((t, l) => t + l.amount, 0);
    for (const l of lines) {
      await tx`
        UPDATE bill_lines SET status = 'voided', void_reason = ${voidReason}, voided_by = ${ctx.actor.id}, voided_at = ${at} WHERE id = ${l.id}`;
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO bill_lines (bill_id, source, item_id, tier, name, unit_price, quantity, amount, post_key, business_date, posted_by, posted_at,
                                technician_id, call_type)
        VALUES (${to.billId}, ${l.source}, ${l.itemId}, ${l.tier}, ${l.name}, ${l.unitPrice}, ${l.quantity}, ${l.amount}, ${key}, ${date},
                ${ctx.actor.id}, ${at}, ${l.technicianId}, ${l.callType})
        RETURNING id`;
      await tx`
        INSERT INTO bill_line_moves (op_key, from_line_id, to_line_id, from_visit_id, to_visit_id, reason, operator_id, business_date, created_at)
        VALUES (${key}, ${l.id}, ${row!.id}, ${from.id}, ${to.id}, ${input.reason}, ${ctx.actor.id}, ${date}, ${at})`;
    }
    await tx`UPDATE bills SET amount_cents = amount_cents - ${total}, line_count = line_count - ${lines.length} WHERE id = ${from.billId}`;
    await tx`UPDATE bills SET amount_cents = amount_cents + ${total}, line_count = line_count + ${lines.length} WHERE id = ${to.billId}`;
    await saveKey(tx, key, 'line_move', requestHash, from.id, ctx.actor.id);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'frontdesk_move',
      targetType: 'visit',
      targetId: from.id,
      detail: { visitNo: from.visitNo, from: fromTag!.code, to: input.toTagCode, toVisitNo: to.visitNo, total, lines: lines.map((l) => `${l.name}×${l.quantity}`), reason: input.reason },
      ip: ctx.ip,
      businessDate: date,
    });
    return from.id;
  });
  return getVisit(deps.sql, fromVisitId, deps.config.timezone);
}
