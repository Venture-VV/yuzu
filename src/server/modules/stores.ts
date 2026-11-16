// 门店与公司主体（8.0.22，docs/MULTISTORE_V8022.md 第 1、2 节，MD-A / MD-C）。
//   · 门店：代码、名称、所属主体、地址电话、启用、排序；本店（编号 1）不能停用。
//   · 主体：名称（发票抬头）、税号、地址电话、开户行与账号；本公司（编号 1）不能停用。
//   · 员工挂哪几家店（staff_stores）；店主不用挂（所有启用的门店都能进）；没挂任何门店的按本店算。
//   · 这些都是档案：修改带版本号（对不上拒绝）、只锁那一行；新建靠代码、名称的唯一索引兜底（同样的再交一次报「已有」）。

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DEFAULT_ENTITY_ID, DEFAULT_STORE_ID, STORE_CODE_PATTERN, type EntityView, type StoreBrief, type StoreSettlementPair, type StoreSettlementReport, type StoreView } from '@shared/stores';
import { isUniqueViolation, type Db } from '../db';
import { guard, guardAny } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Actor, Deps } from '../lib/context';
import { badRequest, conflict, notFound } from '../lib/errors';
import { runWithStoreSet } from '../lib/store-context';
import { idParam, parse } from '../lib/validate';

/** 员工能进的门店：最近用过的在前，再按排序（店主是全部启用的门店；没挂任何门店的是本店） */
export async function allowedStores(db: Db, actor: Pick<Actor, 'id' | 'role'>): Promise<StoreBrief[]> {
  if (actor.role === 'owner') {
    return db<StoreBrief[]>`
      SELECT x.id, x.code, x.name FROM stores x
      LEFT JOIN staff_stores ss ON ss.store_id = x.id AND ss.staff_id = ${actor.id}
      WHERE x.active ORDER BY ss.last_used_at DESC NULLS LAST, x.sort_order, x.id`;
  }
  const [linked] = await db<{ any: boolean }[]>`SELECT EXISTS (SELECT 1 FROM staff_stores WHERE staff_id = ${actor.id}) AS any`;
  if (!linked?.any) return db<StoreBrief[]>`SELECT id, code, name FROM stores WHERE id = ${DEFAULT_STORE_ID}`;
  return db<StoreBrief[]>`
    SELECT x.id, x.code, x.name FROM staff_stores ss JOIN stores x ON x.id = ss.store_id AND x.active
    WHERE ss.staff_id = ${actor.id} ORDER BY ss.last_used_at DESC NULLS LAST, x.sort_order, x.id`;
}

/**
 * 报表、看板的「合并看」（?scope=all，MD18）：店主看全部门店，挂着几家店的人只合并自己挂着的店；
 * 只能进一家店的照旧只看当前门店
 */
export async function withReportScope<T>(db: Db, req: FastifyRequest, fn: () => Promise<T>): Promise<T> {
  const scope = (req.query as { scope?: unknown } | undefined)?.scope;
  if (scope !== 'all' || !req.actor) return fn();
  const stores = await allowedStores(db, req.actor);
  if (stores.length <= 1) return fn();
  return runWithStoreSet(
    stores.map((x) => Number(x.id)).sort((a, b) => a - b),
    fn,
  );
}

/** 门店之间的储值结算（只读）：消费店 ≠ 开卡店的储值消费（撤销冲回），按「开卡店 → 消费店」汇总，再两两轧差 */
export async function storeSettlement(db: Db, from: string, to: string, stores: StoreBrief[]): Promise<StoreSettlementReport> {
  const ids = stores.map((x) => Number(x.id));
  const rows = ids.length
    ? await db<StoreSettlementPair[]>`
        WITH home AS (SELECT DISTINCT ON (member_id) member_id, store_id FROM recharges ORDER BY member_id, id),
        x AS (
          SELECT coalesce(h.store_id, ${DEFAULT_STORE_ID}) AS home_store_id, c.store_id AS spend_store_id, 1 AS n, c.principal_amount AS principal, c.bonus_amount AS bonus
          FROM consumptions c LEFT JOIN home h ON h.member_id = c.member_id
          WHERE c.business_date BETWEEN ${from} AND ${to}
          UNION ALL
          SELECT coalesce(h.store_id, ${DEFAULT_STORE_ID}), c.store_id, -1, -r.principal_amount, -r.bonus_amount
          FROM reversals r JOIN consumptions c ON c.id = r.consumption_id LEFT JOIN home h ON h.member_id = r.member_id
          WHERE r.business_date BETWEEN ${from} AND ${to}
        )
        SELECT home_store_id, spend_store_id, sum(n)::int AS count, sum(principal)::bigint AS principal, sum(bonus)::bigint AS bonus
        FROM x
        WHERE home_store_id <> spend_store_id AND home_store_id IN ${db(ids)} AND spend_store_id IN ${db(ids)}
        GROUP BY 1, 2 HAVING sum(principal) <> 0 OR sum(bonus) <> 0
        ORDER BY 1, 2`
    : [];
  const pairs = rows.map((r) => ({ ...r, homeStoreId: Number(r.homeStoreId), spendStoreId: Number(r.spendStoreId), principal: Number(r.principal), bonus: Number(r.bonus) }));
  const owed = new Map<string, number>();
  for (const p of pairs) owed.set(`${p.homeStoreId}>${p.spendStoreId}`, (owed.get(`${p.homeStoreId}>${p.spendStoreId}`) ?? 0) + p.principal);
  const net: StoreSettlementReport['net'] = [];
  for (const a of ids) {
    for (const b of ids) {
      if (a >= b) continue;
      const d = (owed.get(`${a}>${b}`) ?? 0) - (owed.get(`${b}>${a}`) ?? 0);
      if (d > 0) net.push({ fromStoreId: a, toStoreId: b, principal: d });
      if (d < 0) net.push({ fromStoreId: b, toStoreId: a, principal: -d });
    }
  }
  return { from, to, stores, pairs, net };
}

/** 换门店：只能换到自己能进的；记下这家店最近用过（下次登录默认它） */
export async function switchStore(db: Db, actor: Pick<Actor, 'id' | 'role'>, tokenHash: string, storeId: number): Promise<void> {
  const stores = await allowedStores(db, actor);
  if (!stores.some((s) => s.id === storeId)) throw badRequest('不能进这家门店');
  await db`UPDATE sessions SET store_id = ${storeId} WHERE token_hash = ${tokenHash}`;
  await db`
    INSERT INTO staff_stores (staff_id, store_id, last_used_at) VALUES (${actor.id}, ${storeId}, now())
    ON CONFLICT (staff_id, store_id) DO UPDATE SET last_used_at = now()`;
}

const Code = z.string('请填写门店代码').trim().toUpperCase().regex(STORE_CODE_PATTERN, '门店代码是 2–8 位大写字母或数字，例如 FT');
const StoreInput = z.object({
  code: Code,
  name: z.string('请填写门店名称').trim().min(1, '请填写门店名称').max(32, '门店名称最多 32 个字'),
  entityId: z.number().int().positive(),
  address: z.string().trim().max(120, '地址最多 120 个字').default(''),
  phone: z.string().trim().max(40, '电话最多 40 个字').default(''),
  sortOrder: z.number().int().min(0).max(9999).default(0),
});
const StoreUpdate = StoreInput.extend({ active: z.boolean(), version: z.number().int().positive() });
const EntityInput = z.object({
  name: z.string('请填写主体名称').trim().min(1, '请填写主体名称').max(60, '主体名称最多 60 个字'),
  taxNo: z.string().trim().max(30, '税号最多 30 位').default(''),
  addressPhone: z.string().trim().max(120, '地址电话最多 120 个字').default(''),
  bankName: z.string().trim().max(60, '开户行最多 60 个字').default(''),
  bankAccount: z.string().trim().max(40, '账号最多 40 位').default(''),
});
const EntityUpdate = EntityInput.extend({ active: z.boolean(), version: z.number().int().positive() });
const StaffStoresInput = z.object({ storeIds: z.array(z.number().int().positive()).max(50) });

export async function listStores(db: Db): Promise<StoreView[]> {
  return db<StoreView[]>`
    SELECT s.id, s.code, s.name, s.entity_id, e.name AS entity_name, s.address, s.phone, s.active, s.sort_order, s.version,
           (SELECT count(*)::int FROM staff_stores ss JOIN staff st ON st.id = ss.staff_id AND st.active WHERE ss.store_id = s.id) AS staff_count
    FROM stores s JOIN legal_entities e ON e.id = s.entity_id
    ORDER BY s.sort_order, s.id`;
}

export async function listEntities(db: Db): Promise<EntityView[]> {
  return db<EntityView[]>`
    SELECT e.id, e.name, e.tax_no, e.address_phone, e.bank_name, e.bank_account, e.active, e.version,
           (SELECT count(*)::int FROM stores s WHERE s.entity_id = e.id) AS store_count
    FROM legal_entities e ORDER BY e.id`;
}

export function registerStoreRoutes(app: FastifyInstance, { sql }: Deps) {
  const admin = guard('settings.manage');

  app.get('/api/admin/stores', { preHandler: admin }, async () => ({ stores: await listStores(sql), entities: await listEntities(sql) }));

  app.post('/api/admin/stores', { preHandler: admin }, async (req, reply) => {
    const input = parse(StoreInput, req.body);
    try {
      const id = await sql.begin(async (tx) => {
        const [entity] = await tx<{ active: boolean }[]>`SELECT active FROM legal_entities WHERE id = ${input.entityId} FOR KEY SHARE`;
        if (!entity?.active) throw badRequest('所属主体不存在或已停用');
        const [row] = await tx<{ id: number }[]>`
          INSERT INTO stores (code, name, entity_id, address, phone, sort_order)
          VALUES (${input.code}, ${input.name}, ${input.entityId}, ${input.address}, ${input.phone}, ${input.sortOrder}) RETURNING id`;
        // 这家店的主仓（8.0.22 MD-B）；扣料默认从这家店的主仓扣（门店设置，后台可以改）
        const [wh] = await tx<{ id: number }[]>`
          INSERT INTO warehouses (kind, store_id, name) VALUES ('store_main', ${row!.id}, ${`${input.name}主仓`.slice(0, 40)}) RETURNING id`;
        const usage = (await tx<{ value: Record<string, unknown> }[]>`SELECT value FROM settings WHERE key = 'stock_usage_rules'`)[0]?.value ?? {};
        await tx`
          INSERT INTO store_settings (store_id, key, value, updated_by)
          VALUES (${row!.id}, 'stock_usage_rules', ${tx.json({ enabled: true, ...usage, saleWarehouseId: Number(wh!.id), recipeWarehouseId: Number(wh!.id) } as never)}, ${req.actor.id})`;
        await writeAudit(tx, { staffId: req.actor.id, action: 'store_saved', targetType: 'store', targetId: row!.id, detail: { created: input, warehouseId: Number(wh!.id) }, ip: req.ip });
        return Number(row!.id);
      });
      reply.code(201);
      return (await listStores(sql)).find((s) => s.id === id);
    } catch (error) {
      if (isUniqueViolation(error, 'stores_code_uq')) throw conflict('STORE_CODE_TAKEN', `门店代码 ${input.code} 已经有了`);
      if (isUniqueViolation(error, 'stores_name_uq')) throw conflict('STORE_NAME_TAKEN', `已经有一家「${input.name}」`);
      throw error;
    }
  });

  app.put('/api/admin/stores/:id', { preHandler: admin }, async (req) => {
    const { id } = parse(idParam, req.params);
    const input = parse(StoreUpdate, req.body);
    if (id === DEFAULT_STORE_ID && !input.active) throw badRequest('本店不能停用');
    try {
      await sql.begin(async (tx) => {
        const [before] = await tx<{ version: number; name: string }[]>`SELECT version, name FROM stores WHERE id = ${id} FOR NO KEY UPDATE`;
        if (!before) throw notFound('门店不存在');
        if (before.version !== input.version) throw conflict('STORE_CHANGED', '这家门店刚被别人改过，请刷新后再改');
        const [entity] = await tx<{ active: boolean }[]>`SELECT active FROM legal_entities WHERE id = ${input.entityId} FOR KEY SHARE`;
        if (!entity?.active) throw badRequest('所属主体不存在或已停用');
        await tx`
          UPDATE stores SET code = ${input.code}, name = ${input.name}, entity_id = ${input.entityId}, address = ${input.address}, phone = ${input.phone},
                 sort_order = ${input.sortOrder}, active = ${input.active}, version = version + 1, updated_at = now()
          WHERE id = ${id}`;
        // 主仓的名称跟着门店改（8.0.22）
        if (before.name !== input.name) {
          await tx`UPDATE warehouses SET name = ${`${input.name}主仓`.slice(0, 40)} WHERE store_id = ${id} AND kind = 'store_main'`;
        }
        // 本店的名称也是设置里的门店名（登录页、小票抬头照旧取它）
        if (id === DEFAULT_STORE_ID && before.name !== input.name) {
          await tx`
            INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('store_name', ${tx.json(input.name)}, now(), ${req.actor.id})
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`;
        }
        await writeAudit(tx, { staffId: req.actor.id, action: 'store_saved', targetType: 'store', targetId: id, detail: { updated: input }, ip: req.ip });
      });
    } catch (error) {
      if (isUniqueViolation(error, 'stores_code_uq')) throw conflict('STORE_CODE_TAKEN', `门店代码 ${input.code} 已经有了`);
      if (isUniqueViolation(error, 'stores_name_uq')) throw conflict('STORE_NAME_TAKEN', `已经有一家「${input.name}」`);
      throw error;
    }
    return (await listStores(sql)).find((s) => s.id === id);
  });

  app.post('/api/admin/entities', { preHandler: admin }, async (req, reply) => {
    const input = parse(EntityInput, req.body);
    try {
      const id = await sql.begin(async (tx) => {
        const [row] = await tx<{ id: number }[]>`
          INSERT INTO legal_entities (name, tax_no, address_phone, bank_name, bank_account)
          VALUES (${input.name}, ${input.taxNo}, ${input.addressPhone}, ${input.bankName}, ${input.bankAccount}) RETURNING id`;
        await writeAudit(tx, {
          staffId: req.actor.id,
          action: 'entity_saved',
          targetType: 'legal_entity',
          targetId: row!.id,
          detail: { created: { ...input, bankAccount: input.bankAccount ? `****${input.bankAccount.slice(-4)}` : '' } },
          ip: req.ip,
        });
        return Number(row!.id);
      });
      reply.code(201);
      return (await listEntities(sql)).find((e) => e.id === id);
    } catch (error) {
      if (isUniqueViolation(error, 'legal_entities_name_uq')) throw conflict('ENTITY_NAME_TAKEN', `已经有「${input.name}」这个主体`);
      throw error;
    }
  });

  app.put('/api/admin/entities/:id', { preHandler: admin }, async (req) => {
    const { id } = parse(idParam, req.params);
    const input = parse(EntityUpdate, req.body);
    if (id === DEFAULT_ENTITY_ID && !input.active) throw badRequest('本公司不能停用');
    try {
      await sql.begin(async (tx) => {
        const [before] = await tx<{ version: number }[]>`SELECT version FROM legal_entities WHERE id = ${id} FOR NO KEY UPDATE`;
        if (!before) throw notFound('主体不存在');
        if (before.version !== input.version) throw conflict('ENTITY_CHANGED', '这个主体刚被别人改过，请刷新后再改');
        if (!input.active) {
          const [using] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM stores WHERE entity_id = ${id} AND active`;
          if ((using?.n ?? 0) > 0) throw conflict('ENTITY_IN_USE', '还有启用的门店挂在这个主体下，先把门店挂到别的主体');
        }
        await tx`
          UPDATE legal_entities SET name = ${input.name}, tax_no = ${input.taxNo}, address_phone = ${input.addressPhone}, bank_name = ${input.bankName},
                 bank_account = ${input.bankAccount}, active = ${input.active}, version = version + 1, updated_at = now()
          WHERE id = ${id}`;
        await writeAudit(tx, {
          staffId: req.actor.id,
          action: 'entity_saved',
          targetType: 'legal_entity',
          targetId: id,
          detail: { updated: { ...input, bankAccount: input.bankAccount ? `****${input.bankAccount.slice(-4)}` : '' } },
          ip: req.ip,
        });
      });
    } catch (error) {
      if (isUniqueViolation(error, 'legal_entities_name_uq')) throw conflict('ENTITY_NAME_TAKEN', `已经有「${input.name}」这个主体`);
      throw error;
    }
    return (await listEntities(sql)).find((e) => e.id === id);
  });

  // 员工挂哪几家店（员工档案里的「门店」）
  // 启用的公司主体（8.0.22）：合同、付款、银行账户、开票里选「我方」用；只有一个主体时页面不显示选择
  app.get('/api/entities', { preHandler: guardAny('contract.read', 'payable.read', 'invoice.issue', 'settings.manage') }, async () =>
    sql<{ id: number; name: string; taxNo: string }[]>`SELECT id, name, tax_no FROM legal_entities WHERE active ORDER BY id`.then((rows) => rows.map((r) => ({ ...r, id: Number(r.id) }))),
  );

  // 门店之间的储值结算表（第 7 节）：只是报表，不记账；只列自己能进的门店之间的
  app.get('/api/reports/store-settlement', { preHandler: guard('report.executive') }, async (req) => {
    const q = parse(z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD'), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD') }), req.query ?? {});
    if (q.from > q.to) throw badRequest('开始日期不能晚于结束日期');
    const stores = await allowedStores(sql, req.actor);
    return storeSettlement(sql, q.from, q.to, stores);
  });

  app.get('/api/staff/:id/stores', { preHandler: guard('staff.manage') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const rows = await sql<{ storeId: number }[]>`SELECT store_id FROM staff_stores WHERE staff_id = ${id} ORDER BY store_id`;
    // 能勾的门店：自己能进的（店主是全部启用的）；挂着的照样列出来
    const mine = await allowedStores(sql, req.actor);
    const linked = rows.map((r) => Number(r.storeId));
    const extra = linked.filter((x) => !mine.some((m) => Number(m.id) === x));
    const others = extra.length ? await sql<StoreBrief[]>`SELECT id, code, name FROM stores WHERE id IN ${sql(extra)}` : [];
    const stores = [...mine, ...others].map((x) => ({ ...x, id: Number(x.id) })).sort((a, b) => a.id - b.id);
    return { storeIds: linked, stores };
  });

  app.put('/api/staff/:id/stores', { preHandler: guard('staff.manage') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { storeIds } = parse(StaffStoresInput, req.body);
    const wanted = [...new Set(storeIds)].sort((a, b) => a - b);
    if (wanted.length === 0) throw badRequest('至少挂一家门店');
    // 只能挂自己能进的门店（店主能进全部）；原来就挂着的可以留着
    const mine = new Set((await allowedStores(sql, req.actor)).map((x) => Number(x.id)));
    const before = new Set((await sql<{ storeId: number }[]>`SELECT store_id FROM staff_stores WHERE staff_id = ${id}`).map((r) => Number(r.storeId)));
    if (wanted.some((x) => !mine.has(x) && !before.has(x))) throw badRequest('只能挂你自己能进的门店');
    await sql.begin(async (tx) => {
      const [staff] = await tx<{ role: string }[]>`SELECT role FROM staff WHERE id = ${id} FOR NO KEY UPDATE`;
      if (!staff) throw notFound('员工不存在');
      const found = await tx<{ id: number }[]>`SELECT id FROM stores WHERE id IN ${tx(wanted)} AND active FOR KEY SHARE`;
      if (found.length !== wanted.length) throw badRequest('有的门店不存在或已停用');
      await tx`DELETE FROM staff_stores WHERE staff_id = ${id} AND NOT (store_id IN ${tx(wanted)})`;
      for (const storeId of wanted) await tx`INSERT INTO staff_stores (staff_id, store_id) VALUES (${id}, ${storeId}) ON CONFLICT DO NOTHING`;
      await writeAudit(tx, { staffId: req.actor.id, action: 'staff_stores_saved', targetType: 'staff', targetId: id, detail: { storeIds: wanted }, ip: req.ip });
    });
    return { storeIds: wanted };
  });
}
