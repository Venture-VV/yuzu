// 后台「会员权益 → 按档阶」（8.0.4，需求表 01，docs/MEMBERSHIP_V804.md 第 1 节）：把权益清单、券模板、发券规则交给
// @shared/benefit-tiers 排好 L0–L6 × 初 / 享 / 尊。只读，不加锁。

import type { FastifyInstance } from 'fastify';
import { businessDateOf } from '@shared/business-date';
import { buildBenefitTiers, type BenefitTiers, type TierTemplate } from '@shared/benefit-tiers';
import type { CouponTemplate } from '@shared/coupons';
import { guard } from '../auth/guard';
import { readSnapshot, type Db } from '../db';
import type { Deps } from '../lib/context';
import { benefitCatalog } from './benefits';
import { listRules, listTemplates } from './coupons';
import { loadMembershipRules } from './membership';
import { loadSettings } from './settings';

/**
 * 排序用的面值（HY17）：代金券按面额；兑换券、买一赠一按「最多抵」，没设按兑换（赠送）项目的单价、票种按 12 小时档；
 * 折扣券按「最多减」，没设为空（排在有面值的后面）
 */
export function templateFaceValue(t: Pick<CouponTemplate, 'kind' | 'faceValue' | 'maxOff' | 'exchangeItemId' | 'exchangeTicketTypeId'>, prices: { items: Map<number, number>; tickets: Map<number, number> }): number | null {
  if (t.kind === 'cash') return t.faceValue;
  if (t.kind === 'discount') return t.maxOff;
  if (t.maxOff !== null) return t.maxOff;
  if (t.exchangeItemId !== null) return prices.items.get(t.exchangeItemId) ?? null;
  if (t.exchangeTicketTypeId !== null) return prices.tickets.get(t.exchangeTicketTypeId) ?? null;
  return null;
}

export async function templatePrices(db: Db): Promise<{ items: Map<number, number>; tickets: Map<number, number> }> {
  const items = await db<{ id: number; price: number }[]>`SELECT id, price FROM service_items`;
  const tickets = await db<{ id: number; price: number }[]>`SELECT id, price_12h AS price FROM ticket_types`;
  return { items: new Map(items.map((i) => [Number(i.id), Number(i.price)])), tickets: new Map(tickets.map((t) => [Number(t.id), Number(t.price)])) };
}

export async function benefitTiers(db: Db, today: string): Promise<BenefitTiers> {
  const rules = await loadMembershipRules(db);
  const catalog = await benefitCatalog(db, today);
  const prices = await templatePrices(db);
  const templates: TierTemplate[] = (await listTemplates(db)).map((t) => ({
    id: t.id,
    name: t.name,
    summary: t.summary,
    faceValue: templateFaceValue(t, prices),
    levels: t.levels,
    active: t.active,
  }));
  const plans = await db<{ id: number; payAmount: number }[]>`SELECT id, pay_amount FROM recharge_plans`;
  const planAmount = new Map(plans.map((p) => [Number(p.id), Number(p.payAmount)]));
  const couponRules = (await listRules(db))
    .filter((r) => r.active)
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      level: r.level,
      templateId: r.templateId,
      quantity: r.quantity,
      planName: r.planName,
      planAmount: r.planId === null ? null : (planAmount.get(Number(r.planId)) ?? null),
    }));
  return buildBenefitTiers({ rules, benefits: catalog.items, templates, couponRules });
}

export function registerBenefitTierRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  app.get('/api/benefits/tiers', { preHandler: guard('benefit.publish') }, async () => {
    const settings = await loadSettings(sql);
    const today = businessDateOf(new Date(), deps.config.timezone, settings.businessDayStartHour);
    return readSnapshot(sql, (tx) => benefitTiers(tx, today));
  });
}
