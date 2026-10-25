// 充值套餐与消费项目：首版只满足试点的录入与选择。停用而不删除，保证历史单据可追溯。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Catalog, RechargePlan, ServiceItem } from '@shared/types';
import type { Db } from '../db';
import { guard } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Deps } from '../lib/context';
import { notFound } from '../lib/errors';
import { cents, idParam, parse, positiveCents } from '../lib/validate';

const PlanInput = z.object({
  name: z.string().trim().min(1, '请填写套餐名称').max(32, '名称最多 32 个字'),
  payAmount: positiveCents('实收金额'),
  bonusAmount: cents('赠金'),
  note: z.string().trim().max(100).default(''),
  active: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

const ItemInput = z.object({
  name: z.string().trim().min(1, '请填写项目名称').max(32, '名称最多 32 个字'),
  category: z.string().trim().max(16).default(''),
  price: positiveCents('价格'),
  active: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

export async function loadCatalog(db: Db, includeInactive = false): Promise<Catalog> {
  const plans = await db<RechargePlan[]>`
    SELECT id, name, pay_amount, bonus_amount, note, active, sort_order FROM recharge_plans
    ${includeInactive ? db`` : db`WHERE active`} ORDER BY active DESC, sort_order, pay_amount, id`;
  const items = await db<ServiceItem[]>`
    SELECT id, name, category, price, active, sort_order FROM service_items
    ${includeInactive ? db`` : db`WHERE active`} ORDER BY active DESC, sort_order, id`;
  return { plans, items };
}

export function registerCatalogRoutes(app: FastifyInstance, { sql }: Deps) {
  app.get('/api/catalog', { preHandler: guard('member.read') }, async (req) => {
    const all = (req.query as { all?: string }).all === '1';
    return loadCatalog(sql, all);
  });

  app.post('/api/plans', { preHandler: guard('catalog.manage') }, async (req) => {
    const p = parse(PlanInput, req.body);
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO recharge_plans (name, pay_amount, bonus_amount, note, active, sort_order)
      VALUES (${p.name}, ${p.payAmount}, ${p.bonusAmount}, ${p.note}, ${p.active}, ${p.sortOrder}) RETURNING id`;
    await writeAudit(sql, { staffId: req.actor.id, action: 'plan_saved', targetType: 'plan', targetId: row!.id, detail: p, ip: req.ip });
    return loadCatalog(sql, true);
  });

  app.put('/api/plans/:id', { preHandler: guard('catalog.manage') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const p = parse(PlanInput, req.body);
    const rows = await sql`
      UPDATE recharge_plans SET name = ${p.name}, pay_amount = ${p.payAmount}, bonus_amount = ${p.bonusAmount},
             note = ${p.note}, active = ${p.active}, sort_order = ${p.sortOrder}, updated_at = now()
      WHERE id = ${id} RETURNING id`;
    if (rows.length === 0) throw notFound('套餐不存在');
    await writeAudit(sql, { staffId: req.actor.id, action: 'plan_saved', targetType: 'plan', targetId: id, detail: p, ip: req.ip });
    return loadCatalog(sql, true);
  });

  app.post('/api/items', { preHandler: guard('catalog.manage') }, async (req) => {
    const i = parse(ItemInput, req.body);
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO service_items (name, category, price, active, sort_order)
      VALUES (${i.name}, ${i.category}, ${i.price}, ${i.active}, ${i.sortOrder}) RETURNING id`;
    await writeAudit(sql, { staffId: req.actor.id, action: 'item_saved', targetType: 'item', targetId: row!.id, detail: i, ip: req.ip });
    return loadCatalog(sql, true);
  });

  app.put('/api/items/:id', { preHandler: guard('catalog.manage') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const i = parse(ItemInput, req.body);
    const rows = await sql`
      UPDATE service_items SET name = ${i.name}, category = ${i.category}, price = ${i.price}, active = ${i.active},
             sort_order = ${i.sortOrder}, updated_at = now()
      WHERE id = ${id} RETURNING id`;
    if (rows.length === 0) throw notFound('项目不存在');
    await writeAudit(sql, { staffId: req.actor.id, action: 'item_saved', targetType: 'item', targetId: id, detail: i, ip: req.ip });
    return loadCatalog(sql, true);
  });
}
