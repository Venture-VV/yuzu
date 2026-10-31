// 档案：部门、供应商、物料。停用而不删除，历史单据始终可追溯。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Department, Material, Supplier } from '@shared/inventory';
import { fitsDecimals } from '@shared/quantity';
import { isUniqueViolation, type Db } from '../../db';
import { guard, guardAny } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import type { Deps } from '../../lib/context';
import { conflict, notFound, unprocessable } from '../../lib/errors';
import { idParam, parse } from '../../lib/validate';
import { loadInventorySettings } from './common';

const MATERIAL_COLUMNS = (db: Db) => db`
  m.id, m.code, m.name, m.category, m.specification, m.inventory_unit, m.decimals, m.purchase_unit,
  m.purchase_factor_milli, m.ref_price_cents, m.default_supplier_id, s.name AS default_supplier_name,
  m.low_stock_milli, m.tracked, m.active, m.stock_milli,
  (m.low_stock_milli IS NOT NULL AND m.tracked AND m.stock_milli < m.low_stock_milli) AS is_low,
  (m.last_move_id IS NOT NULL) AS has_moves,
  (SELECT created_at FROM stock_moves WHERE id = m.last_move_id) AS last_move_at,
  m.note, m.is_synthetic`;

export async function listMaterials(db: Db, opts: { includeInactive?: boolean; trackedOnly?: boolean } = {}): Promise<Material[]> {
  return db<Material[]>`
    SELECT ${MATERIAL_COLUMNS(db)} FROM materials m LEFT JOIN suppliers s ON s.id = m.default_supplier_id
    WHERE true
      ${opts.includeInactive ? db`` : db`AND m.active`}
      ${opts.trackedOnly ? db`AND m.tracked` : db``}
    ORDER BY m.tracked DESC, m.code`;
}

export async function getMaterial(db: Db, id: number): Promise<Material> {
  const [row] = await db<Material[]>`
    SELECT ${MATERIAL_COLUMNS(db)} FROM materials m LEFT JOIN suppliers s ON s.id = m.default_supplier_id WHERE m.id = ${id}`;
  if (!row) throw notFound('物料不存在');
  return row;
}

export const listSuppliers = (db: Db, includeInactive = false) =>
  db<Supplier[]>`
    SELECT id, code, name, contact, phone, note, settlement, active, is_synthetic FROM suppliers
    ${includeInactive ? db`` : db`WHERE active`} ORDER BY active DESC, code`;

export const listDepartments = (db: Db, includeInactive = false) =>
  db<Department[]>`
    SELECT id, name, active, sort_order FROM departments
    ${includeInactive ? db`` : db`WHERE active`} ORDER BY active DESC, sort_order, id`;

const text = (max: number, label: string) => z.string().trim().max(max, `${label}最多 ${max} 个字`);
const required = (max: number, label: string) => text(max, label).min(1, `请填写${label}`);

export const MaterialInput = z
  .object({
    code: required(16, '物料编码'),
    name: required(40, '物料名称'),
    category: text(16, '分类').default(''),
    specification: text(80, '规格').default(''),
    inventoryUnit: required(8, '库存单位'),
    decimals: z.number().int().min(0).max(3).default(0),
    purchaseUnit: required(8, '采购单位'),
    purchaseFactorMilli: z.number('请填写换算数量').int().positive('换算数量必须大于 0').max(1_000_000_000),
    refPriceCents: z.number().int().nonnegative().max(100_000_000).nullable().default(null),
    defaultSupplierId: z.number().int().positive().nullable().default(null),
    lowStockMilli: z.number().int().nonnegative().max(1_000_000_000_000).nullable().default(null),
    tracked: z.boolean().default(true),
    active: z.boolean().default(true),
    note: text(200, '备注').default(''),
  })
  .refine((m) => fitsDecimals(m.purchaseFactorMilli, m.decimals), {
    message: '换算数量的小数位超过了库存单位允许的精度',
    path: ['purchaseFactorMilli'],
  })
  .refine((m) => m.lowStockMilli === null || fitsDecimals(m.lowStockMilli, m.decimals), {
    message: '低库存阈值的小数位超过了库存单位允许的精度',
    path: ['lowStockMilli'],
  });
export type MaterialInputData = z.input<typeof MaterialInput>;

export const SupplierInput = z.object({
  code: required(16, '供应商编码'),
  name: required(40, '供应商名称'),
  contact: text(40, '联系人').default(''),
  phone: text(32, '电话').default(''),
  note: text(200, '备注').default(''),
  /** 结算方式（v0.7.7）：挂账 / 现付；新建不填按挂账，修改不填保持原样 */
  settlement: z.enum(['credit', 'cash']).optional(),
  active: z.boolean().default(true),
});
export type SupplierInputData = z.input<typeof SupplierInput>;

const DepartmentInput = z.object({
  name: required(16, '部门名称'),
  active: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

export async function saveMaterial(db: Db, id: number | null, raw: MaterialInputData, extra: { isSynthetic?: boolean } = {}): Promise<number> {
  const m = parse(MaterialInput, raw);
  try {
    if (id === null) {
      const [row] = await db<{ id: number }[]>`
        INSERT INTO materials (code, name, category, specification, inventory_unit, decimals, purchase_unit, purchase_factor_milli,
                               ref_price_cents, default_supplier_id, low_stock_milli, tracked, active, note, is_synthetic)
        VALUES (${m.code}, ${m.name}, ${m.category}, ${m.specification}, ${m.inventoryUnit}, ${m.decimals}, ${m.purchaseUnit},
                ${m.purchaseFactorMilli}, ${m.refPriceCents}, ${m.defaultSupplierId}, ${m.lowStockMilli}, ${m.tracked}, ${m.active},
                ${m.note}, ${extra.isSynthetic ?? false})
        RETURNING id`;
      return row!.id;
    }
    const [before] = await db<{ inventoryUnit: string; decimals: number; hasMoves: boolean; tracked: boolean }[]>`
      SELECT inventory_unit, decimals, last_move_id IS NOT NULL AS has_moves, tracked FROM materials WHERE id = ${id}`;
    if (!before) throw notFound('物料不存在');
    // 已有流水的物料不能改库存单位或精度，否则会改写历史数量的含义
    if (before.hasMoves && (before.inventoryUnit !== m.inventoryUnit || before.decimals !== m.decimals)) {
      throw unprocessable('UNIT_LOCKED', '该物料已有库存流水，库存单位与小数位不能再修改；包装变化请修改采购单位与换算');
    }
    if (before.hasMoves && before.tracked && !m.tracked) {
      throw unprocessable('TRACKED_LOCKED', '该物料已有库存流水，不能改为候选物料；不再使用请停用');
    }
    await db`
      UPDATE materials SET code = ${m.code}, name = ${m.name}, category = ${m.category}, specification = ${m.specification},
             inventory_unit = ${m.inventoryUnit}, decimals = ${m.decimals}, purchase_unit = ${m.purchaseUnit},
             purchase_factor_milli = ${m.purchaseFactorMilli}, ref_price_cents = ${m.refPriceCents},
             default_supplier_id = ${m.defaultSupplierId}, low_stock_milli = ${m.lowStockMilli}, tracked = ${m.tracked},
             active = ${m.active}, note = ${m.note}, updated_at = now()
      WHERE id = ${id}`;
    return id;
  } catch (error) {
    if (isUniqueViolation(error, 'materials_code_key')) throw conflict('CODE_EXISTS', '物料编码已存在');
    throw error;
  }
}

export async function saveSupplier(db: Db, id: number | null, raw: SupplierInputData, extra: { isSynthetic?: boolean } = {}): Promise<number> {
  const s = parse(SupplierInput, raw);
  try {
    if (id === null) {
      const [row] = await db<{ id: number }[]>`
        INSERT INTO suppliers (code, name, contact, phone, note, settlement, active, is_synthetic)
        VALUES (${s.code}, ${s.name}, ${s.contact}, ${s.phone}, ${s.note}, ${s.settlement ?? 'credit'}, ${s.active}, ${extra.isSynthetic ?? false})
        RETURNING id`;
      return row!.id;
    }
    const rows = await db`
      UPDATE suppliers SET code = ${s.code}, name = ${s.name}, contact = ${s.contact}, phone = ${s.phone}, note = ${s.note},
             settlement = coalesce(${s.settlement ?? null}, settlement), active = ${s.active}, updated_at = now()
      WHERE id = ${id} RETURNING id`;
    if (rows.length === 0) throw notFound('供应商不存在');
    return id;
  } catch (error) {
    if (isUniqueViolation(error, 'suppliers_code_key')) throw conflict('CODE_EXISTS', '供应商编码已存在');
    throw error;
  }
}

const SettingsInput = z.object({
  scopeName: required(20, '库存范围名称'),
  priceBasis: required(20, '价格口径'),
  allowDirectReceipt: z.boolean(),
  approvalRules: z.object({
    purchase_order: z.boolean(),
    damage: z.boolean(),
    supplier_return: z.boolean(),
    payment: z.boolean(),
    opening: z.boolean(),
  }),
});

export function registerMasterRoutes(app: FastifyInstance, { sql }: Deps) {
  const all = (q: unknown) => (q as { all?: string }).all === '1';

  app.get('/api/inventory/settings', { preHandler: guard('inventory.read') }, async () => loadInventorySettings(sql));
  app.put('/api/inventory/settings', { preHandler: guard('settings.manage') }, async (req) => {
    const s = parse(SettingsInput, req.body);
    const before = await loadInventorySettings(sql);
    await sql.begin(async (tx) => {
      const entries: [string, unknown][] = [
        ['inventory_scope_name', s.scopeName],
        ['inventory_price_basis', s.priceBasis],
        ['inventory_allow_direct_receipt', s.allowDirectReceipt],
        ['inventory_approval_rules', s.approvalRules],
      ];
      for (const [key, value] of entries) {
        await tx`
          INSERT INTO settings (key, value, updated_by) VALUES (${key}, ${tx.json(value as never)}, ${req.actor.id})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
      }
      await writeAudit(tx, { staffId: req.actor.id, action: 'inventory_settings_updated', detail: { before, after: s }, ip: req.ip });
    });
    return loadInventorySettings(sql);
  });

  app.get('/api/inventory/materials', { preHandler: guard('inventory.read') }, async (req) =>
    listMaterials(sql, { includeInactive: all(req.query) }),
  );
  app.get('/api/inventory/materials/:id', { preHandler: guard('inventory.read') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return getMaterial(sql, id);
  });
  app.post('/api/inventory/materials', { preHandler: guard('inventory.master') }, async (req, reply) => {
    const id = await saveMaterial(sql, null, req.body as MaterialInputData);
    await writeAudit(sql, { staffId: req.actor.id, action: 'inventory_master_saved', targetType: 'material', targetId: id, detail: req.body as Record<string, unknown>, ip: req.ip });
    reply.code(201);
    return getMaterial(sql, id);
  });
  app.put('/api/inventory/materials/:id', { preHandler: guard('inventory.master') }, async (req) => {
    const { id } = parse(idParam, req.params);
    await saveMaterial(sql, id, req.body as MaterialInputData);
    await writeAudit(sql, { staffId: req.actor.id, action: 'inventory_master_saved', targetType: 'material', targetId: id, detail: req.body as Record<string, unknown>, ip: req.ip });
    return getMaterial(sql, id);
  });

  app.get('/api/inventory/suppliers', { preHandler: guard('inventory.read') }, async (req) => listSuppliers(sql, all(req.query)));
  app.post('/api/inventory/suppliers', { preHandler: guard('inventory.master') }, async (req, reply) => {
    const id = await saveSupplier(sql, null, req.body as SupplierInputData);
    await writeAudit(sql, { staffId: req.actor.id, action: 'inventory_master_saved', targetType: 'supplier', targetId: id, detail: req.body as Record<string, unknown>, ip: req.ip });
    reply.code(201);
    return listSuppliers(sql, true);
  });
  app.put('/api/inventory/suppliers/:id', { preHandler: guard('inventory.master') }, async (req) => {
    const { id } = parse(idParam, req.params);
    await saveSupplier(sql, id, req.body as SupplierInputData);
    await writeAudit(sql, { staffId: req.actor.id, action: 'inventory_master_saved', targetType: 'supplier', targetId: id, detail: req.body as Record<string, unknown>, ip: req.ip });
    return listSuppliers(sql, true);
  });

  // 部门：库存之外，费用报销（只有费用职责的员工也要选部门）与需求单也要用
  app.get('/api/inventory/departments', { preHandler: guardAny('inventory.read', 'expense.read', 'request.create', 'request.review') }, async (req) =>
    listDepartments(sql, all(req.query)),
  );
  app.post('/api/inventory/departments', { preHandler: guard('inventory.master') }, async (req) => {
    const d = parse(DepartmentInput, req.body);
    try {
      const [row] = await sql<{ id: number }[]>`
        INSERT INTO departments (name, active, sort_order) VALUES (${d.name}, ${d.active}, ${d.sortOrder}) RETURNING id`;
      await writeAudit(sql, { staffId: req.actor.id, action: 'inventory_master_saved', targetType: 'department', targetId: row!.id, detail: d, ip: req.ip });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('NAME_EXISTS', '部门名称已存在');
      throw error;
    }
    return listDepartments(sql, true);
  });
  app.put('/api/inventory/departments/:id', { preHandler: guard('inventory.master') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const d = parse(DepartmentInput, req.body);
    try {
      const rows = await sql`
        UPDATE departments SET name = ${d.name}, active = ${d.active}, sort_order = ${d.sortOrder} WHERE id = ${id} RETURNING id`;
      if (rows.length === 0) throw notFound('部门不存在');
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('NAME_EXISTS', '部门名称已存在');
      throw error;
    }
    await writeAudit(sql, { staffId: req.actor.id, action: 'inventory_master_saved', targetType: 'department', targetId: id, detail: d, ip: req.ip });
    return listDepartments(sql, true);
  });
}
