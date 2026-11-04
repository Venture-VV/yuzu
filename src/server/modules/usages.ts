// 开单即占用（D37 / D39，v0.7.19，见 docs/FLOORPLAN_FINISH.md 第 1 节）：派对房、宠物轰趴房、娱乐室的使用单。
//   · 开单：选在店客人的手牌（使用人，费用挂在他的手牌账单上，与前台挂账同一个口径）、人数、备注；开单即「使用中」；
//     同一间房同时只有一张开着的使用单（部分唯一索引兜底）；
//   · 释放：手动「结束使用」、使用人结账（frontdesk/checkout.ts）、撤销来访（frontdesk/visits.ts）时自动结束、开错了「撤单」（写原因）；
//   · 实时位置：开单时使用人在那间房；结束、撤单时离开那间房（只在他现在就在那里时）。
//   · 计费（v0.7.28，N2，docs/SCHEDULE_FINISH.md 第 3 节）：业态设了计费的，结束使用时按时长把房费（与开台费）挂到使用人的手牌账单上，
//     明细是价目表里的项目（部门按项目的分类），space_usage_charges 记下是哪张使用单的；使用人结账前要先结束（不自动结束、不漏收）；
//     撤单、撤销来访不收；没设计费的业态与 v0.7.19 一样。
// 写操作带操作编号（断网时走「结果待确认」，可以确认作废）。
// 加锁顺序：开单：来访（共享锁，挡住同时结账、撤销）→ 空间一行（与空间台账的编辑串行）→ 当前位置；
//          结束、撤单：使用单一行 → 当前位置；结束计费的使用单：来访 → 账单 → 使用单一行 → 当前位置（与结账同一个顺序）；
//          结账、撤销来访：在各自已有的锁之后，锁这几位客人开着的使用单（id 升序）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { normalizeTagCode, TAG_CODE_PATTERN } from '@shared/frontdesk';
import type { UsagePricingView } from '@shared/floormap';
import { isTechnicianBusinessType, ROOM_BUSINESS_TYPE } from '@shared/spaces';
import {
  DEFAULT_USAGE_MIN_MINUTES,
  DEFAULT_USAGE_RULES,
  DEFAULT_USAGE_STEP_MINUTES,
  durationText,
  MAX_USAGE_GUESTS,
  MAX_USAGE_MIN_MINUTES,
  MAX_USAGE_NOTE,
  USAGE_STEP_OPTIONS,
  usageFee,
  type UsageDetail,
  type UsagePricing,
  type UsageRules,
} from '@shared/usages';
import { defaultTier, tierPrice } from '@shared/catalog';
import type { Db, Tx } from '../db';
import { guard, guardAny } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Deps, OpContext } from '../lib/context';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors';
import { idParam, parse } from '../lib/validate';
import { docDateSchema } from './inventory/common';
import { assertCanFix, businessDate, hashRequest, loadFrontdeskRules, lockVisits, nextDocNo, runIdempotent, saveKey } from './frontdesk/common';
import { loadPricedItems } from './pricing';
import { leaveUsages, locateUsage } from './locations';
import { ctxOf } from '../lib/context';
import { saveRuleSetting } from '../lib/rule-settings';

// ───────────────────────── 规则 ─────────────────────────

export async function loadUsageRules(db: Db): Promise<UsageRules> {
  const [row] = await db<{ value: Partial<UsageRules> }[]>`SELECT value FROM settings WHERE key = 'usage_rules'`;
  const v = { ...DEFAULT_USAGE_RULES, ...(row?.value ?? {}) };
  return { businessTypes: v.businessTypes, pricing: v.pricing ?? {} };
}

const MAX_BUSINESS_TYPE = 8;
const RulesInput = z.object({
  businessTypes: z
    .array(z.string('业态不正确').trim().min(1, '业态不能为空').max(MAX_BUSINESS_TYPE, `业态最多 ${MAX_BUSINESS_TYPE} 字`), '请选择业态')
    .max(20, '业态最多 20 个')
    .transform((list) => [...new Set(list)])
    .refine((list) => !list.includes(ROOM_BUSINESS_TYPE), { message: '「客房」按入住单算占用，不能设成开单即占用' })
    .refine((list) => !list.some(isTechnicianBusinessType), { message: '技师服务类的房间按钟单算占用，不能设成开单即占用' }),
  /** 按业态的计费（v0.7.28）；不带时保留原来的（只改业态的旧页面不会把计费清掉） */
  pricing: z
    .record(
      z.string().trim().min(1).max(MAX_BUSINESS_TYPE),
      z.object({
        feeItemId: z.number('请选择房费项目').int().positive('请选择房费项目'),
        minMinutes: z
          .number('请填写起步时长')
          .int('起步时长要是整数分钟')
          .min(0, '起步时长不能是负数')
          .max(MAX_USAGE_MIN_MINUTES, `起步时长最多 ${MAX_USAGE_MIN_MINUTES} 分钟`)
          .default(DEFAULT_USAGE_MIN_MINUTES),
        stepMinutes: z
          .number('请选择计费单位')
          .refine((v) => (USAGE_STEP_OPTIONS as readonly number[]).includes(v), `计费单位只能是 ${USAGE_STEP_OPTIONS.join(' / ')} 分钟`)
          .default(DEFAULT_USAGE_STEP_MINUTES),
        openFeeItemId: z.number().int().positive().nullable().default(null),
      }),
    )
    .optional(),
});

async function saveUsageRules(deps: Deps, raw: unknown, ctx: OpContext) {
  const next = parse(RulesInput, raw);
  if (next.pricing) {
    for (const [type, p] of Object.entries(next.pricing)) {
      if (!next.businessTypes.includes(type)) throw badRequest(`「${type}」不是开单即占用的业态，不能设计费`);
      const items = await loadPricedItems(deps.sql, [p.feeItemId, ...(p.openFeeItemId ? [p.openFeeItemId] : [])]);
      for (const id of [p.feeItemId, p.openFeeItemId]) {
        if (id === null) continue;
        const item = items.get(id);
        if (!item || !item.active) throw unprocessable('USAGE_PRICE_ITEM', `「${type}」选的${id === p.feeItemId ? '房费' : '开台费'}项目不存在或已停用，请重新选择`);
        if (item.technicianRequired) throw unprocessable('USAGE_PRICE_ITEM', `「${item.name}」是技师项目，不能当房费`);
      }
    }
  }
  await saveRuleSetting(
    deps.sql,
    'usage_rules',
    loadUsageRules,
    (cur) => {
      const pricing = next.pricing ?? cur.pricing;
      // 不再是开单即占用的业态，计费一起去掉
      return { businessTypes: next.businessTypes, pricing: Object.fromEntries(Object.entries(pricing).filter(([t]) => next.businessTypes.includes(t))) };
    },
    ctx,
  );
  return loadUsageRules(deps.sql);
}

/** 业态的计费（没设为空） */
export const pricingOf = (rules: UsageRules, businessType: string): UsagePricing | null => rules.pricing[businessType] ?? null;

/** 设了计费的业态 → 页面估算用的计费（每小时价、开台费按此刻的价目；项目停用了的不列，结束时会提示去后台改） */
export async function usagePricingViews(db: Db, rules: UsageRules): Promise<Map<string, UsagePricingView>> {
  const entries = Object.entries(rules.pricing);
  const items = await loadPricedItems(db, entries.flatMap(([, p]) => [p.feeItemId, ...(p.openFeeItemId ? [p.openFeeItemId] : [])]));
  const price = (id: number | null) => {
    const item = id === null ? undefined : items.get(id);
    const tier = item?.active ? defaultTier(item.prices) : null;
    return item && tier ? tierPrice(item.prices, tier) : null;
  };
  const out = new Map<string, UsagePricingView>();
  for (const [type, p] of entries) {
    const hourPrice = price(p.feeItemId);
    if (hourPrice === null) continue;
    out.set(type, { itemName: items.get(p.feeItemId)!.name, hourPrice, minMinutes: p.minMinutes, stepMinutes: p.stepMinutes, openFee: price(p.openFeeItemId) ?? 0 });
  }
  return out;
}

// ───────────────────────── 读取 ─────────────────────────

const iso = (v: string | Date | null) => (v === null ? null : new Date(v).toISOString());

async function readUsages(db: Db, where: { id?: number; date?: string; spaceId?: number }): Promise<UsageDetail[]> {
  type Row = Omit<UsageDetail, 'openedAt' | 'closedAt' | 'priced' | 'fee'> & {
    openedAt: string;
    closedAt: string | null;
    feeAmount: number | null;
    openFee: number | null;
    chargedMinutes: number | null;
  };
  const rows = await db<Row[]>`
    SELECT u.id, u.usage_no, u.space_id, sp.code AS space_code, sp.display_name AS space_name, sp.business_type,
           u.visit_id, h.code AS tag_code, v.status AS visit_status, u.guests, u.note, u.status, u.business_date::text AS business_date,
           u.opened_at, so.display_name AS opened_by_name, u.closed_at, sc.display_name AS closed_by_name, u.close_kind, u.close_reason,
           (SELECT l.amount FROM space_usage_charges c JOIN bill_lines l ON l.id = c.line_id WHERE c.usage_id = u.id AND c.kind = 'fee') AS fee_amount,
           (SELECT l.amount FROM space_usage_charges c JOIN bill_lines l ON l.id = c.line_id WHERE c.usage_id = u.id AND c.kind = 'open_fee') AS open_fee,
           (SELECT c.charged_minutes FROM space_usage_charges c WHERE c.usage_id = u.id AND c.kind = 'fee') AS charged_minutes
    FROM space_usages u JOIN spaces sp ON sp.id = u.space_id JOIN visits v ON v.id = u.visit_id JOIN hand_tags h ON h.id = v.tag_id
    JOIN staff so ON so.id = u.opened_by LEFT JOIN staff sc ON sc.id = u.closed_by
    WHERE ${where.id !== undefined ? db`u.id = ${where.id}` : db`true`}
      AND ${where.date !== undefined ? db`u.business_date = ${where.date}` : db`true`}
      AND ${where.spaceId !== undefined ? db`u.space_id = ${where.spaceId}` : db`true`}
    ORDER BY u.opened_at, u.id`;
  const rules = await loadUsageRules(db);
  const views = await usagePricingViews(db, rules);
  return rows.map(({ feeAmount, openFee, chargedMinutes, ...r }) => ({
    ...r,
    openedAt: iso(r.openedAt)!,
    closedAt: iso(r.closedAt),
    priced: pricingOf(rules, r.businessType) !== null,
    pricing: views.get(r.businessType) ?? null,
    fee:
      feeAmount === null && openFee === null
        ? null
        : { amount: Number(feeAmount ?? 0), chargedMinutes: Number(chargedMinutes ?? 0), openFee: Number(openFee ?? 0) },
  }));
}

export async function getUsage(db: Db, id: number): Promise<UsageDetail> {
  const [u] = await readUsages(db, { id });
  if (!u) throw notFound('使用单不存在');
  return u;
}

/** 某个营业日开的使用单（对账包、页面的当天清单） */
export const listUsages = (db: Db, date: string, spaceId?: number) => readUsages(db, { date, ...(spaceId ? { spaceId } : {}) });

// ───────────────────────── 开单 ─────────────────────────

const clientKey = z.uuid('缺少有效的操作编号，请刷新页面后重试');
const TAG_REQUIRED = '请填写使用人的手牌号：使用人要先在前台接待、买门票，再开单';

export const OpenUsageInput = z.object({
  clientKey,
  spaceId: z.number('请选择房间').int().positive('请选择房间'),
  /** 使用人：在店客人的手牌号（费用挂在他的手牌账单上） */
  tagCode: z
    .string(TAG_REQUIRED)
    .transform((v) => normalizeTagCode(v))
    .pipe(z.string().min(1, TAG_REQUIRED).regex(TAG_CODE_PATTERN, '牌号格式不正确（例如 A023、1088）')),
  guests: z.number('请填写人数').int('人数必须是整数').min(1, '至少 1 人').max(MAX_USAGE_GUESTS, `最多 ${MAX_USAGE_GUESTS} 人`).default(1),
  note: z.string().trim().max(MAX_USAGE_NOTE, `备注最多 ${MAX_USAGE_NOTE} 字`).default(''),
});

export async function openUsage(deps: Deps, raw: unknown, ctx: OpContext): Promise<UsageDetail> {
  const input = parse(OpenUsageInput, raw);
  const { clientKey: key, ...payload } = input;
  const requestHash = hashRequest(payload);
  const run = await runIdempotent(deps, { key, opType: 'usage_open', requestHash }, async (tx) => {
    const at = ctx.at ?? new Date();
    const rules = await loadUsageRules(tx);
    // ① 来访（共享锁：开单不改来访，但要挡住同时结账、撤销）
    const [peek] = await tx<{ id: number }[]>`
      SELECT v.id FROM visits v JOIN hand_tags t ON t.id = v.tag_id WHERE t.code = ${input.tagCode} AND v.status = 'open'`;
    if (!peek) throw conflict('TAG_NOT_IN_STORE', `手牌 ${input.tagCode} 没有在店客人，请核对牌号；使用人要先在前台接待、买门票，再开单`);
    const [visit] = await tx<{ id: number; visitNo: string; billId: number; status: string }[]>`
      SELECT id, visit_no, bill_id, status FROM visits WHERE id = ${peek.id} FOR SHARE`;
    if (visit!.status !== 'open') throw conflict('VISIT_CLOSED', `来访 ${visit!.visitNo} 已${visit!.status === 'settled' ? '结账离店' : '撤销'}，不能开单`);
    // ② 空间一行（与空间台账的停用、改业态串行；不挡外键检查）
    const [space] = await tx<{ id: number; code: string; displayName: string; businessType: string; active: boolean; sellable: boolean }[]>`
      SELECT id, code, display_name, business_type, active, sellable FROM spaces WHERE id = ${input.spaceId} FOR NO KEY UPDATE`;
    if (!space) throw notFound('空间不存在，请刷新后重试');
    if (!rules.businessTypes.includes(space.businessType)) {
      throw unprocessable(
        'USAGE_NOT_ALLOWED',
        `${space.code}（${space.businessType}）不按「开单即占用」算${rules.businessTypes.length ? `，能开单的业态：${rules.businessTypes.join('、')}` : '；后台还没设能开单的业态'}`,
      );
    }
    if (!space.active || !space.sellable) throw conflict('SPACE_INACTIVE', `${space.code} 在空间台账里停用或不可售，不能开单，请换一间`);
    const [busy] = await tx<{ usageNo: string; tagCode: string }[]>`
      SELECT u.usage_no, h.code AS tag_code FROM space_usages u JOIN visits v ON v.id = u.visit_id JOIN hand_tags h ON h.id = v.tag_id
      WHERE u.space_id = ${space.id} AND u.status = 'open'`;
    if (busy) throw conflict('USAGE_TAKEN', `${space.code} 正在使用（${busy.usageNo}，手牌 ${busy.tagCode}），先结束这张再开单`);
    const date = await businessDate(tx, deps, at);
    const usageNo = await nextDocNo(tx, 'space_usage', 'SY', date);
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO space_usages (usage_no, space_id, visit_id, bill_id, guests, note, business_date, opened_at, opened_by, open_key)
      VALUES (${usageNo}, ${space.id}, ${visit!.id}, ${visit!.billId}, ${input.guests}, ${input.note}, ${date}, ${at}, ${ctx.actor.id}, ${key})
      RETURNING id`;
    const usageId = row!.id;
    // 实时位置：使用人在那间房
    await locateUsage(tx, visit!.id, space.id, usageId, { at, staffId: ctx.actor.id });
    await saveKey(tx, key, 'usage_open', requestHash, usageId, ctx.actor.id);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'usage_open',
      targetType: 'space_usage',
      targetId: usageId,
      detail: { usageNo, space: space.code, tagCode: input.tagCode, guests: input.guests, ...(input.note ? { note: input.note } : {}) },
      ip: ctx.ip,
      businessDate: date,
    });
    return usageId;
  });
  return getUsage(deps.sql, run.refId);
}

// ───────────────────────── 结束、撤单 ─────────────────────────

interface LockedUsage {
  id: number;
  usageNo: string;
  spaceId: number;
  visitId: number;
  status: 'open' | 'closed' | 'cancelled';
  openedBy: number;
  openedAt: string;
  spaceCode: string;
}

async function lockUsage(tx: Tx, id: number): Promise<LockedUsage> {
  const [u] = await tx<LockedUsage[]>`
    SELECT u.id, u.usage_no, u.space_id, u.visit_id, u.status, u.opened_by, u.opened_at, sp.code AS space_code
    FROM space_usages u JOIN spaces sp ON sp.id = u.space_id WHERE u.id = ${id} FOR UPDATE OF u`;
  if (!u) throw notFound('使用单不存在');
  if (u.status !== 'open') {
    throw conflict('USAGE_CLOSED', `使用单 ${u.usageNo}（${u.spaceCode}）已${u.status === 'cancelled' ? '撤单' : '结束'}，请刷新`);
  }
  return u;
}

export const EndUsageInput = z.object({ clientKey });

export async function endUsage(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<UsageDetail> {
  const input = parse(EndUsageInput, raw);
  const requestHash = hashRequest({ id });
  await runIdempotent(deps, { key: input.clientKey, opType: 'usage_end', requestHash }, async (tx) => {
    const at = ctx.at ?? new Date();
    // 计费的：先锁来访、账单（与结账同一个顺序：来访 → 账单 → 使用单），再锁使用单
    const [peek] = await tx<{ visitId: number; businessType: string }[]>`
      SELECT u.visit_id, sp.business_type FROM space_usages u JOIN spaces sp ON sp.id = u.space_id WHERE u.id = ${id}`;
    if (!peek) throw notFound('使用单不存在');
    const pricing = pricingOf(await loadUsageRules(tx), peek.businessType);
    let billId: number | null = null;
    if (pricing) {
      const visit = (await lockVisits(tx, [Number(peek.visitId)])).get(Number(peek.visitId))!;
      const [bill] = await tx<{ id: number; status: string }[]>`SELECT id, status FROM bills WHERE id = ${visit.billId} FOR UPDATE`;
      if (bill!.status !== 'open') throw conflict('BILL_CLOSED', '使用人的账单已结束，不能再挂房费，请刷新');
      billId = Number(bill!.id);
    }
    const u = await lockUsage(tx, id);
    const date = await businessDate(tx, deps, at);
    await tx`
      UPDATE space_usages SET status = 'closed', closed_at = greatest(opened_at, ${at}), closed_by = ${ctx.actor.id}, close_kind = 'end'
      WHERE id = ${id}`;
    const fee = pricing && billId !== null ? await chargeUsage(tx, { usage: u, pricing, billId, at, date, key: input.clientKey, actor: ctx.actor }) : null;
    await leaveUsages(tx, [{ id, visitId: u.visitId, spaceId: u.spaceId }], { at, staffId: ctx.actor.id });
    await saveKey(tx, input.clientKey, 'usage_end', requestHash, id, ctx.actor.id);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'usage_end',
      targetType: 'space_usage',
      targetId: id,
      detail: { usageNo: u.usageNo, space: u.spaceCode, ...(fee ? { minutes: fee.minutes, chargedMinutes: fee.chargedMinutes, fee: fee.amount, openFee: fee.openFee } : {}) },
      ip: ctx.ip,
      businessDate: date,
    });
    return id;
  });
  return getUsage(deps.sql, id);
}

/**
 * 结束计费的使用单时挂房费（来访、账单、使用单都已锁）：按实际用了多久（开单到结束，分钟向下取整）算，
 * 房费按计费单位记一条明细（数量 = 几个单位），开台费记一条；账单合计跟着加；space_usage_charges 记下来。
 * 房费、开台费项目已停用的拒绝（请到后台改计费）
 */
async function chargeUsage(
  tx: Tx,
  a: { usage: LockedUsage; pricing: UsagePricing; billId: number; at: Date; date: string; key: string; actor: { id: number } },
): Promise<{ minutes: number; chargedMinutes: number; amount: number; openFee: number }> {
  const { usage, pricing } = a;
  const minutes = Math.max(0, Math.floor((a.at.getTime() - new Date(usage.openedAt).getTime()) / 60_000));
  const items = await loadPricedItems(tx, [pricing.feeItemId, ...(pricing.openFeeItemId ? [pricing.openFeeItemId] : [])]);
  const priceOf = (itemId: number, what: string) => {
    const item = items.get(itemId);
    const tier = item ? defaultTier(item.prices) : null;
    const price = item && tier ? tierPrice(item.prices, tier) : null;
    if (!item || !item.active || !tier || price === null) {
      throw conflict('USAGE_PRICE_ITEM', `${usage.spaceCode} 的${what}项目已停用或没有价格，请店主到后台「客房 → 派对房等」改计费后再结束`);
    }
    return { item, tier, price };
  };
  const feeItem = priceOf(pricing.feeItemId, '房费');
  const fee = usageFee(minutes, pricing, feeItem.price);
  const lines: { kind: 'fee' | 'open_fee'; itemId: number; tier: string; name: string; unitPrice: number; quantity: number; amount: number; charged: number }[] = [];
  if (fee.amount > 0) {
    // 数量最多 99：超长的（计费单位很小、用了一整天）合成一行
    const perStep = fee.steps <= 99 && fee.unitPrice > 0;
    lines.push({
      kind: 'fee',
      itemId: feeItem.item.id,
      tier: feeItem.tier,
      name: (perStep ? `${feeItem.item.name}（每 ${pricing.stepMinutes} 分钟）` : `${feeItem.item.name}（${durationText(fee.chargedMinutes)}）`).slice(0, 32),
      unitPrice: perStep ? fee.unitPrice : fee.amount,
      quantity: perStep ? fee.steps : 1,
      amount: fee.amount,
      charged: fee.chargedMinutes,
    });
  }
  let openFee = 0;
  if (pricing.openFeeItemId) {
    const o = priceOf(pricing.openFeeItemId, '开台费');
    if (o.price > 0) {
      openFee = o.price;
      lines.push({ kind: 'open_fee', itemId: o.item.id, tier: o.tier, name: o.item.name.slice(0, 32), unitPrice: o.price, quantity: 1, amount: o.price, charged: 0 });
    }
  }
  for (const l of lines) {
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO bill_lines (bill_id, source, item_id, tier, name, unit_price, quantity, amount, post_key, business_date, posted_by, posted_at)
      VALUES (${a.billId}, 'other', ${l.itemId}, ${l.tier}, ${l.name}, ${l.unitPrice}, ${l.quantity}, ${l.amount}, ${a.key}, ${a.date}, ${a.actor.id}, ${a.at})
      RETURNING id`;
    await tx`
      INSERT INTO space_usage_charges (usage_id, kind, line_id, minutes, charged_minutes)
      VALUES (${usage.id}, ${l.kind}, ${row!.id}, ${l.kind === 'fee' ? minutes : 0}, ${l.charged})`;
  }
  if (lines.length > 0) {
    const total = lines.reduce((s, l) => s + l.amount, 0);
    await tx`UPDATE bills SET amount_cents = amount_cents + ${total}, line_count = line_count + ${lines.length} WHERE id = ${a.billId}`;
  }
  return { minutes, chargedMinutes: fee.amount > 0 ? fee.chargedMinutes : 0, amount: fee.amount, openFee };
}

export const CancelUsageInput = z.object({
  clientKey,
  reason: z.string('请填写撤单原因（至少 2 个字）').trim().min(2, '请填写撤单原因（至少 2 个字）').max(200, '原因最多 200 字'),
});

/** 开错了撤单（写原因）：与作废明细同一条规则——前台只能撤自己开的、开单后一定时间内的，超出由店主处理；挂过的费用另到前台作废 */
export async function cancelUsage(deps: Deps, id: number, raw: unknown, ctx: OpContext): Promise<UsageDetail> {
  const input = parse(CancelUsageInput, raw);
  const requestHash = hashRequest({ id, reason: input.reason });
  await runIdempotent(deps, { key: input.clientKey, opType: 'usage_cancel', requestHash }, async (tx) => {
    const at = ctx.at ?? new Date();
    const u = await lockUsage(tx, id);
    assertCanFix(ctx.actor, u.openedBy, u.openedAt, await loadFrontdeskRules(tx), at, '这张使用单');
    await tx`
      UPDATE space_usages SET status = 'cancelled', closed_at = greatest(opened_at, ${at}), closed_by = ${ctx.actor.id}, close_kind = 'cancel',
             close_reason = ${input.reason}
      WHERE id = ${id}`;
    await leaveUsages(tx, [{ id, visitId: u.visitId, spaceId: u.spaceId }], { at, staffId: ctx.actor.id });
    await saveKey(tx, input.clientKey, 'usage_cancel', requestHash, id, ctx.actor.id);
    await writeAudit(tx, {
      staffId: ctx.actor.id,
      action: 'usage_cancel',
      targetType: 'space_usage',
      targetId: id,
      detail: { usageNo: u.usageNo, space: u.spaceCode, reason: input.reason },
      ip: ctx.ip,
      businessDate: await businessDate(tx, deps, at),
    });
    return id;
  });
  return getUsage(deps.sql, id);
}

/**
 * 使用人结账、撤销来访时一起结束他开着的使用单（在调用方已有的锁之后，按 id 升序锁）。
 * 位置不在这里处理：调用方接着清掉这几位客人的位置（离店）。返回结束的使用单号。
 */
export async function closeUsagesOfVisits(tx: Tx, visitIds: number[], kind: 'checkout' | 'visit_cancel', c: { at: Date; staffId: number }): Promise<string[]> {
  if (visitIds.length === 0) return [];
  const rows = await tx<{ id: number; usageNo: string; spaceCode: string; businessType: string }[]>`
    SELECT u.id, u.usage_no, sp.code AS space_code, sp.business_type
    FROM space_usages u JOIN spaces sp ON sp.id = u.space_id
    WHERE u.visit_id IN ${tx(visitIds)} AND u.status = 'open' ORDER BY u.id FOR UPDATE OF u`;
  if (rows.length === 0) return [];
  if (kind === 'checkout') {
    // 计费的业态（v0.7.28）：结账前要先「结束使用」把房费挂上（不在这里自动结束，免得漏收）；撤销来访照旧直接结束、不收
    const rules = await loadUsageRules(tx);
    const priced = rows.filter((r) => pricingOf(rules, r.businessType) !== null);
    if (priced.length > 0) {
      throw conflict(
        'USAGE_UNCHARGED',
        `${priced.map((r) => r.spaceCode).join('、')} 还在使用：这类房间按时长收房费，请先「结束使用」把房费挂到手牌账单上，再结账`,
        { usageIds: priced.map((r) => Number(r.id)) },
      );
    }
  }
  await tx`
    UPDATE space_usages SET status = 'closed', closed_at = greatest(opened_at, ${c.at}), closed_by = ${c.staffId}, close_kind = ${kind}
    WHERE id IN ${tx(rows.map((r) => r.id))}`;
  return rows.map((r) => r.usageNo);
}

/** 这几位客人开着的使用单（结账预览里提示「结账后自动结束」） */
export async function openUsagesOf(db: Db, visitIds: number[], at = new Date()) {
  if (visitIds.length === 0) return [];
  const rows = await db<{ usageId: number; usageNo: string; tagCode: string; spaceCode: string; spaceName: string; businessType: string; openedAt: string }[]>`
    SELECT u.id AS usage_id, u.usage_no, h.code AS tag_code, sp.code AS space_code, sp.display_name AS space_name, sp.business_type, u.opened_at
    FROM space_usages u JOIN visits v ON v.id = u.visit_id JOIN hand_tags h ON h.id = v.tag_id JOIN spaces sp ON sp.id = u.space_id
    WHERE u.visit_id IN ${db(visitIds)} AND u.status = 'open' ORDER BY h.code, sp.code`;
  if (rows.length === 0) return [];
  const rules = await loadUsageRules(db);
  const views = await usagePricingViews(db, rules);
  return rows.map(({ businessType, openedAt, ...r }) => {
    const minutes = Math.max(0, Math.floor((at.getTime() - new Date(openedAt).getTime()) / 60_000));
    // 结账前核对：按此刻算的房费（结束时按结束那一刻再算一次）
    const v = views.get(businessType);
    return {
      ...r,
      usageId: Number(r.usageId),
      priced: pricingOf(rules, businessType) !== null,
      minutes,
      estimate: v ? usageFee(minutes, v, v.hourPrice).amount + v.openFee : null,
    };
  });
}

/** 空间里开着的使用单（空间台账停用、改业态前核对） */
export async function openUsageIn(tx: Tx, spaceId: number) {
  const [row] = await tx<{ usageNo: string }[]>`SELECT usage_no FROM space_usages WHERE space_id = ${spaceId} AND status = 'open'`;
  return row ?? null;
}

// ───────────────────────── 自检 ─────────────────────────

/** 开着的使用单的使用人都在店、账单就是他的手牌账单；结过账、撤销了来访的客人没有开着的使用单 */
export async function usageCheck(db: Db) {
  const diff = await db<{ ref: string }[]>`
    SELECT u.usage_no AS ref FROM space_usages u JOIN visits v ON v.id = u.visit_id
    WHERE (u.status = 'open' AND v.status <> 'open') OR u.bill_id <> v.bill_id
    LIMIT 5`;
  const [n] = await db<{ open: number; total: number }[]>`
    SELECT count(*) FILTER (WHERE status = 'open')::int AS open, count(*)::int AS total FROM space_usages`;
  return {
    key: 'space_usages',
    label: '派对房等使用单与在店客人一致',
    ok: diff.length === 0,
    detail: diff.length
      ? `${diff.length} 张使用单的使用人已离店或账单不符（如 ${diff.map((d) => d.ref).join('、')}）`
      : `使用单 ${n!.total} 张，开着的 ${n!.open} 张：一间房最多一张，使用人都在店，结过账、撤销了来访的客人没有开着的使用单`,
  };
}

// ───────────────────────── 路由 ─────────────────────────

const ListQuery = z.object({ date: docDateSchema, spaceId: z.coerce.number().int().positive().optional() });

export function registerUsageRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  // 与「客房」页（房态看板、平面图）同一组岗位能看；开单、结束、撤单沿用「客房入住、退房」
  const read = guardAny('room.operate', 'room.housekeep', 'frontdesk.checkout');
  app.get('/api/usages', { preHandler: read }, async (req) => {
    const q = parse(ListQuery, req.query);
    return listUsages(sql, q.date, q.spaceId);
  });
  app.get('/api/usages/:id', { preHandler: read }, async (req) => getUsage(sql, parse(idParam, req.params).id));
  const op = guard('room.operate');
  app.post('/api/usages', { preHandler: op }, async (req) => openUsage(deps, req.body, ctxOf(req)));
  app.post('/api/usages/:id/end', { preHandler: op }, async (req) => endUsage(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  app.post('/api/usages/:id/cancel', { preHandler: op }, async (req) => cancelUsage(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  // 后台：开单即占用的业态（店主）
  app.get('/api/admin/usage-rules', { preHandler: guardAny('settings.manage', 'catalog.manage') }, async () => loadUsageRules(sql));
  app.put('/api/admin/usage-rules', { preHandler: guard('settings.manage') }, async (req) => {
    if (!req.body || typeof req.body !== 'object') throw badRequest('请选择业态');
    return saveUsageRules(deps, req.body, ctxOf(req));
  });
}
