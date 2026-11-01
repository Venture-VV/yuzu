// 档案：部门、供应商、物料。停用而不删除，历史单据始终可追溯。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Department, Material, Supplier } from '@shared/inventory';
import { fitsDecimals, formatQty } from '@shared/quantity';
import { isUniqueViolation, type Db, type Tx } from '../../db';
import { guard, guardAny } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import type { Deps } from '../../lib/context';
import { conflict, notFound, unprocessable } from '../../lib/errors';
import { idParam, parse } from '../../lib/validate';
import { CENTRAL_WAREHOUSE_ID } from '@shared/inventory';
import { coverFor, loadInventorySettings, usageByMaterial, usageSince } from './common';

const MATERIAL_COLUMNS = (db: Db) => db`
  m.id, m.code, m.name, m.category, m.specification, m.inventory_unit, m.decimals, m.purchase_unit,
  m.purchase_factor_milli, m.ref_price_cents, m.default_supplier_id, s.name AS default_supplier_name,
  m.low_stock_milli, m.cover_days, m.tracked, m.active, m.stock_milli,
  (SELECT coalesce(sum(ws.stock_milli), 0) FROM warehouse_stock ws WHERE ws.material_id = m.id) AS dept_stock_milli,
  (m.low_stock_milli IS NOT NULL AND m.tracked AND m.stock_milli < m.low_stock_milli) AS is_low,
  (m.last_move_id IS NOT NULL) AS has_moves,
  (m.last_move_id IS NOT NULL OR EXISTS (SELECT 1 FROM stock_moves sm WHERE sm.material_id = m.id)) AS any_moves,
  (SELECT created_at FROM stock_moves WHERE id = m.last_move_id) AS last_move_at,
  m.note, m.is_synthetic`;

/**
 * 总仓的日均用量、可用天数与提醒（#22，v0.7.12）：设了提醒天数且近期有用量的按可用天数，否则按固定的低库存提醒数量。
 * 不给门店时区时不算用量（可用天数为空，提醒按固定数量）。
 */
async function withCover(db: Db, rows: Material[], timeZone?: string): Promise<Material[]> {
  if (!timeZone) return rows.map((m) => ({ ...m, dailyUsageMilli: 0, daysOfCover: null }));
  const { usageWindowDays } = await loadInventorySettings(db);
  const used = await usageByMaterial(db, CENTRAL_WAREHOUSE_ID, usageSince(timeZone, usageWindowDays));
  return rows.map((m) => ({ ...m, ...coverFor(m.stockMilli, used.get(m.id) ?? 0, usageWindowDays, m) }));
}

export async function listMaterials(db: Db, opts: { includeInactive?: boolean; trackedOnly?: boolean; timeZone?: string } = {}): Promise<Material[]> {
  const rows = await db<Material[]>`
    SELECT ${MATERIAL_COLUMNS(db)} FROM materials m LEFT JOIN suppliers s ON s.id = m.default_supplier_id
    WHERE true
      ${opts.includeInactive ? db`` : db`AND m.active`}
      ${opts.trackedOnly ? db`AND m.tracked` : db``}
    ORDER BY m.tracked DESC, m.code`;
  return withCover(db, rows, opts.timeZone);
}

export async function getMaterial(db: Db, id: number, timeZone?: string): Promise<Material> {
  const [row] = await db<Material[]>`
    SELECT ${MATERIAL_COLUMNS(db)} FROM materials m LEFT JOIN suppliers s ON s.id = m.default_supplier_id WHERE m.id = ${id}`;
  if (!row) throw notFound('物料不存在');
  return (await withCover(db, [row], timeZone))[0]!;
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
    /** 提醒天数（#22，v0.7.12）：可用天数少于它时提醒；为空按固定的低库存提醒数量 */
    coverDays: z.number('提醒天数必须是数字').int('提醒天数要是整数').min(1, '提醒天数至少 1 天').max(90, '提醒天数最多 90 天').nullable().default(null),
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

/** 停用部门前：它的小仓没有存货、没有待确认的单据 */
async function assertDeptWarehouseEmpty(tx: Tx, departmentId: number) {
  const left = await tx<{ name: string; stockMilli: number; inventoryUnit: string }[]>`
    SELECT m.name, ws.stock_milli, m.inventory_unit FROM warehouse_stock ws
    JOIN warehouses w ON w.id = ws.warehouse_id JOIN materials m ON m.id = ws.material_id
    WHERE w.department_id = ${departmentId} AND ws.stock_milli > 0 ORDER BY m.code LIMIT 6`;
  if (left.length > 0) {
    throw unprocessable(
      'DEPT_STOCK_NOT_EMPTY',
      `这个部门的小仓还有存货（${left.slice(0, 5).map((r) => `${r.name} ${formatQty(r.stockMilli)} ${r.inventoryUnit}`).join('、')}${left.length > 5 ? ' 等' : ''}），请先退回总仓或盘点到 0 再停用`,
    );
  }
  const [pending] = await tx<{ docNo: string }[]>`
    SELECT d.doc_no FROM inv_docs d JOIN warehouses w ON w.id = d.warehouse_id
    WHERE w.department_id = ${departmentId} AND d.status IN ('submitted', 'awaiting_supplier') ORDER BY d.id LIMIT 1`;
  if (pending) throw unprocessable('DEPT_DOCS_PENDING', `这个部门的小仓还有待确认的单据 ${pending.docNo}，请先确认或退回再停用`);
}

export async function saveMaterial(db: Db, id: number | null, raw: MaterialInputData, extra: { isSynthetic?: boolean } = {}): Promise<number> {
  const m = parse(MaterialInput, raw);
  try {
    if (id === null) {
      const [row] = await db<{ id: number }[]>`
        INSERT INTO materials (code, name, category, specification, inventory_unit, decimals, purchase_unit, purchase_factor_milli,
                               ref_price_cents, default_supplier_id, low_stock_milli, cover_days, tracked, active, note, is_synthetic)
        VALUES (${m.code}, ${m.name}, ${m.category}, ${m.specification}, ${m.inventoryUnit}, ${m.decimals}, ${m.purchaseUnit},
                ${m.purchaseFactorMilli}, ${m.refPriceCents}, ${m.defaultSupplierId}, ${m.lowStockMilli}, ${m.coverDays}, ${m.tracked}, ${m.active},
                ${m.note}, ${extra.isSynthetic ?? false})
        RETURNING id`;
      return row!.id;
    }
    // 任何一个仓有流水都算（部门小仓的期初、急采也会先于总仓有流水，v0.7.11）
    const [before] = await db<{ inventoryUnit: string; decimals: number; hasMoves: boolean; tracked: boolean }[]>`
      SELECT inventory_unit, decimals, (last_move_id IS NOT NULL OR EXISTS (SELECT 1 FROM stock_moves WHERE material_id = ${id})) AS has_moves, tracked
      FROM materials WHERE id = ${id}`;
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
             default_supplier_id = ${m.defaultSupplierId}, low_stock_milli = ${m.lowStockMilli}, cover_days = ${m.coverDays}, tracked = ${m.tracked},
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
  /** 急采上限（分，#19）：1 元到 100 万元 */
  urgentCapCents: z.number().int().min(100).max(100_000_000),
  /** 免确认门槛（分，#18，v0.7.12）：0（全部要确认）到 100 万元 */
  approvalThresholdCents: z.number().int().min(0, '免确认门槛不能为负').max(100_000_000, '免确认门槛不能超过 100 万元'),
  /** 可用天数的用量统计天数（#22，v0.7.12）：7 到 90 天 */
  usageWindowDays: z.number().int().min(7, '用量至少按近 7 天统计').max(90, '用量最多按近 90 天统计'),
  approvalRules: z.object({
    purchase_order: z.boolean(),
    damage: z.boolean(),
    supplier_return: z.boolean(),
    payment: z.boolean(),
    opening: z.boolean(),
  }),
});

export function registerMasterRoutes(app: FastifyInstance, { sql, config }: Deps) {
  const all = (q: unknown) => (q as { all?: string }).all === '1';

  app.get('/api/inventory/settings', { preHandler: guard('inventory.read') }, async () => loadInventorySettings(sql));
  app.put('/api/inventory/settings', { preHandler: guard('settings.manage') }, async (req) => {
    const s = parse(SettingsInput, req.body);
    const before = await loadInventorySettings(sql);
    await sql.begin(async (tx) => {
      const entries: [string, unknown][] = [
        ['inventory_scope_name', s.scopeName],
        ['inventory_price_basis', s.priceBasis],
        ['inventory_urgent_cap_cents', s.urgentCapCents],
        ['inventory_approval_threshold_cents', s.approvalThresholdCents],
        ['inventory_usage_window_days', s.usageWindowDays],
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
    listMaterials(sql, { includeInactive: all(req.query), timeZone: config.timezone }),
  );
  app.get('/api/inventory/materials/:id', { preHandler: guard('inventory.read') }, async (req) => {
    const { id } = parse(idParam, req.params);
    return getMaterial(sql, id, config.timezone);
  });
  app.post('/api/inventory/materials', { preHandler: guard('inventory.master') }, async (req, reply) => {
    const id = await saveMaterial(sql, null, req.body as MaterialInputData);
    await writeAudit(sql, { staffId: req.actor.id, action: 'inventory_master_saved', targetType: 'material', targetId: id, detail: req.body as Record<string, unknown>, ip: req.ip });
    reply.code(201);
    return getMaterial(sql, id, config.timezone);
  });
  app.put('/api/inventory/materials/:id', { preHandler: guard('inventory.master') }, async (req) => {
    const { id } = parse(idParam, req.params);
    await saveMaterial(sql, id, req.body as MaterialInputData);
    await writeAudit(sql, { staffId: req.actor.id, action: 'inventory_master_saved', targetType: 'material', targetId: id, detail: req.body as Record<string, unknown>, ip: req.ip });
    return getMaterial(sql, id, config.timezone);
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

  // 收货时一起验收的采购经办（#17，v0.7.11）：在职的采购经办与店主
  app.get('/api/inventory/co-acceptors', { preHandler: guard('inventory.read') }, async () =>
    sql<{ id: number; displayName: string }[]>`
      SELECT id, display_name FROM staff WHERE active AND (role = 'owner' OR 'purchase' = ANY (duties)) ORDER BY role = 'owner', display_name`,
  );

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
      await sql.begin(async (tx) => {
        // 停用前小仓要清空、没有待确认的单据（v0.7.11）；部门行排他锁与收发时的共享锁串行
        const [cur] = await tx<{ active: boolean }[]>`SELECT active FROM departments WHERE id = ${id} FOR UPDATE`;
        if (!cur) throw notFound('部门不存在');
        if (cur.active && !d.active) await assertDeptWarehouseEmpty(tx, id);
        await tx`UPDATE departments SET name = ${d.name}, active = ${d.active}, sort_order = ${d.sortOrder} WHERE id = ${id}`;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('NAME_EXISTS', '部门名称已存在');
      throw error;
    }
    await writeAudit(sql, { staffId: req.actor.id, action: 'inventory_master_saved', targetType: 'department', targetId: id, detail: d, ip: req.ip });
    return listDepartments(sql, true);
  });
}
