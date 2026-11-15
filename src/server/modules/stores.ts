// 门店与公司主体（8.0.22，docs/MULTISTORE_V8022.md 第 1、2 节，MD-A / MD-C）。
//   · 门店：代码、名称、所属主体、地址电话、启用、排序；本店（编号 1）不能停用。
//   · 主体：名称（发票抬头）、税号、地址电话、开户行与账号；本公司（编号 1）不能停用。
//   · 员工挂哪几家店（staff_stores）；店主不用挂（所有启用的门店都能进）；没挂任何门店的按本店算。
//   · 这些都是档案：修改带版本号（对不上拒绝）、只锁那一行；新建靠代码、名称的唯一索引兜底（同样的再交一次报「已有」）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DEFAULT_ENTITY_ID, DEFAULT_STORE_ID, STORE_CODE_PATTERN, type EntityView, type StoreBrief, type StoreView } from '@shared/stores';
import { isUniqueViolation, type Db } from '../db';
import { guard } from '../auth/guard';
import { writeAudit } from '../lib/audit';
import type { Actor, Deps } from '../lib/context';
import { badRequest, conflict, notFound } from '../lib/errors';
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

/** 换门店：只能换到自己能进的；记下这家店最近用过（下次登录默认它） */
export async function switchStore(db: Db, actor: Pick<Actor, 'id' | 'role'>, tokenHash: string, storeId: number): Promise<void> {
  const stores = await allowedStores(db, actor);
  if (!stores.some((s) => s.id === storeId)) throw badRequest('不能进这家门店');
  await db`UPDATE sessions SET store_id = ${storeId} WHERE token_hash = ${tokenHash}`;
  await db`
    INSERT INTO staff_stores (staff_id, store_id, last_used_at) VALUES (${actor.id}, ${storeId}, now())
    ON CONFLICT (staff_id, store_id) DO UPDATE SET last_used_at = now()`;
}

const Code = z
  .string('请填写门店代码')
  .trim()
  .toUpperCase()
  .regex(STORE_CODE_PATTERN, '门店代码是 2–8 位大写字母或数字，例如 FT');
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
        await writeAudit(tx, { staffId: req.actor.id, action: 'store_saved', targetType: 'store', targetId: row!.id, detail: { created: input }, ip: req.ip });
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
        await writeAudit(tx, { staffId: req.actor.id, action: 'entity_saved', targetType: 'legal_entity', targetId: row!.id, detail: { created: { ...input, bankAccount: input.bankAccount ? `****${input.bankAccount.slice(-4)}` : '' } }, ip: req.ip });
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
        await writeAudit(tx, { staffId: req.actor.id, action: 'entity_saved', targetType: 'legal_entity', targetId: id, detail: { updated: { ...input, bankAccount: input.bankAccount ? `****${input.bankAccount.slice(-4)}` : '' } }, ip: req.ip });
      });
    } catch (error) {
      if (isUniqueViolation(error, 'legal_entities_name_uq')) throw conflict('ENTITY_NAME_TAKEN', `已经有「${input.name}」这个主体`);
      throw error;
    }
    return (await listEntities(sql)).find((e) => e.id === id);
  });

  // 员工挂哪几家店（员工档案里的「门店」）
  app.get('/api/staff/:id/stores', { preHandler: guard('staff.manage') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const rows = await sql<{ storeId: number }[]>`SELECT store_id FROM staff_stores WHERE staff_id = ${id} ORDER BY store_id`;
    return { storeIds: rows.map((r) => Number(r.storeId)) };
  });

  app.put('/api/staff/:id/stores', { preHandler: guard('staff.manage') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { storeIds } = parse(StaffStoresInput, req.body);
    const wanted = [...new Set(storeIds)].sort((a, b) => a - b);
    if (wanted.length === 0) throw badRequest('至少挂一家门店');
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
