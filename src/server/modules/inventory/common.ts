// 库存模块的公共能力：设置、单号、锁定物料、写库存流水、审批记录。
//
// 并发规则（与会员钱包一致）：
//   · 每笔改变库存的操作在一个事务里完成「单据 + 流水 + 物料结存」；
//   · 先按 id 升序锁定涉及的物料行（SELECT … FOR UPDATE），同一物料的收发严格串行；
//   · 结存字段有 CHECK (>= 0) 兜底，任何情况下都不会出现负库存。

import { businessDateOf } from '@shared/business-date';
import { CENTRAL_WAREHOUSE_ID, type ApprovalRules, type InventorySettings, type MoveType } from '@shared/inventory';
import { formatQty } from '@shared/quantity';
import { z } from 'zod';
import { can } from '@shared/permissions';
import type { Db, Tx } from '../../db';
import type { Actor } from '../../lib/context';
import { AppError, unprocessable } from '../../lib/errors';
import { dateSchema } from '../../lib/validate';

export const DEFAULT_APPROVAL_RULES: ApprovalRules = {
  purchase_order: true,
  damage: true,
  supplier_return: true,
  payment: true,
  opening: true,
};

export async function loadInventorySettings(db: Db): Promise<InventorySettings> {
  const rows = await db<{ key: string; value: unknown }[]>`
    SELECT key, value FROM settings
    WHERE key IN ('inventory_scope_name', 'inventory_price_basis', 'inventory_urgent_cap_cents', 'inventory_approval_rules')`;
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    scopeName: (map.get('inventory_scope_name') as string) ?? '后勤总库',
    priceBasis: (map.get('inventory_price_basis') as string) ?? '含税到货价',
    urgentCapCents: Number(map.get('inventory_urgent_cap_cents') ?? DEFAULT_URGENT_CAP_CENTS),
    approvalRules: { ...DEFAULT_APPROVAL_RULES, ...((map.get('inventory_approval_rules') as Partial<ApprovalRules>) ?? {}) },
  };
}

/** 急采上限默认 2000 元（#19，可调） */
export const DEFAULT_URGENT_CAP_CENTS = 200_000;

/** #21：当月发生的当月冲销完——单据日期所在的月份（门店时区的自然月）过了就不能冲销 */
export function assertSameMonth(date: string, timeZone: string, what = '单据') {
  const today = todayIn(timeZone);
  if (date.slice(0, 7) !== today.slice(0, 7)) {
    throw unprocessable('VOID_CROSS_MONTH', `${what}日期在 ${date.slice(0, 4)} 年 ${Number(date.slice(5, 7))} 月，跨月不能冲销；请用本月的单据更正`, {
      docDate: date,
    });
  }
}

/** 员工档案里的所属部门（v0.7.8 起有） */
export async function actorDepartmentId(db: Db, actorId: number): Promise<number | null> {
  const [row] = await db<{ departmentId: number | null }[]>`SELECT department_id FROM staff WHERE id = ${actorId}`;
  return row?.departmentId ?? null;
}

/** 本部门小仓的部门申购（或店主）：签收领料、急采与补单等（v0.7.11） */
export async function canOperateDept(db: Db, actor: Actor, departmentId: number | null): Promise<boolean> {
  if (actor.role === 'owner') return true;
  if (departmentId === null || !can(actor, 'deptStock.operate')) return false;
  return (await actorDepartmentId(db, actor.id)) === departmentId;
}

/** 部门的小仓（部门停用后小仓也停用）；没有返回 null */
export async function departmentWarehouse(db: Db, departmentId: number): Promise<{ id: number; name: string; active: boolean } | null> {
  const [row] = await db<{ id: number; name: string; active: boolean }[]>`
    SELECT w.id, d.name || '小仓' AS name, d.active FROM warehouses w JOIN departments d ON d.id = w.department_id
    WHERE w.department_id = ${departmentId}`;
  return row ?? null;
}

/**
 * 动部门小仓之前：对部门行加共享锁并确认部门没停用（v0.7.11）。停用部门时对部门行加排他锁、核对小仓已清空，
 * 两边串行，停用后的小仓不会再有收发。在锁物料之后调用（停用部门只锁部门一行，不会互相等待）。
 */
export async function lockDeptWarehouse(tx: Tx, warehouseId: number) {
  if (warehouseId === CENTRAL_WAREHOUSE_ID) return;
  const [row] = await tx<{ active: boolean; name: string }[]>`
    SELECT d.active, d.name FROM warehouses w JOIN departments d ON d.id = w.department_id WHERE w.id = ${warehouseId} FOR SHARE OF d`;
  if (!row) throw unprocessable('WAREHOUSE_NOT_FOUND', '仓库不存在，请刷新后重试');
  if (!row.active) throw unprocessable('DEPARTMENT_INACTIVE', `「${row.name}」已停用，它的小仓不能再收发`);
}

/** 仓的名称、类别与所属部门（总仓用「库存范围名称」） */
export async function warehouseInfo(db: Db, warehouseId: number) {
  const [row] = await db<{ id: number; kind: 'central' | 'department'; departmentId: number | null; name: string; active: boolean }[]>`
    SELECT w.id, w.kind, w.department_id,
           CASE WHEN w.kind = 'central'
                THEN coalesce((SELECT value #>> '{}' FROM settings WHERE key = 'inventory_scope_name'), '后勤总库')
                ELSE d.name || '小仓' END AS name,
           coalesce(d.active, true) AS active
    FROM warehouses w LEFT JOIN departments d ON d.id = w.department_id WHERE w.id = ${warehouseId}`;
  return row ?? null;
}

/** 门店时区的自然日（库存与采购按自然日统计，不沿用会员营业日切换规则） */
export const todayIn = (timeZone: string) => businessDateOf(new Date(), timeZone, 0);
/** 某个时刻在门店时区是哪一天 */
export const dateIn = (at: string | Date, timeZone: string) => businessDateOf(new Date(at), timeZone, 0);

export const docDateSchema = dateSchema();

export function assertNotFuture(date: string, timeZone: string) {
  if (date > todayIn(timeZone)) throw unprocessable('FUTURE_DATE', '单据日期不能晚于今天');
}

/** 单号：前缀 + 单据日期 + 当日流水号，例如 RK20261020-0001 */
export async function nextDocNo(tx: Tx, kind: string, prefix: string, date: string): Promise<string> {
  const [row] = await tx<{ lastNo: number }[]>`
    INSERT INTO doc_counters (doc_type, business_date, last_no) VALUES (${kind}, ${date}, 1)
    ON CONFLICT (doc_type, business_date) DO UPDATE SET last_no = doc_counters.last_no + 1
    RETURNING last_no`;
  return `${prefix}${date.replaceAll('-', '')}-${String(row!.lastNo).padStart(4, '0')}`;
}

export interface LockedMaterial {
  id: number;
  code: string;
  name: string;
  inventoryUnit: string;
  decimals: number;
  stockMilli: number;
  lastMoveId: number | null;
  tracked: boolean;
  active: boolean;
}

/** 按 id 升序锁定物料，返回可变的结存快照 */
export async function lockMaterials(tx: Tx, ids: number[]): Promise<Map<number, LockedMaterial>> {
  const unique = [...new Set(ids)].sort((a, b) => a - b);
  if (unique.length === 0) return new Map();
  const rows = await tx<LockedMaterial[]>`
    SELECT id, code, name, inventory_unit, decimals, stock_milli, last_move_id, tracked, active
    FROM materials WHERE id IN ${tx(unique)} ORDER BY id FOR UPDATE`;
  if (rows.length !== unique.length) throw unprocessable('MATERIAL_NOT_FOUND', '有物料不存在，请刷新后重试');
  return new Map(rows.map((r) => [r.id, r]));
}

export function insufficient(m: LockedMaterial, needMilli: number): AppError {
  return unprocessable(
    'INSUFFICIENT_STOCK',
    `「${m.name}」库存不足：当前 ${formatQty(m.stockMilli)} ${m.inventoryUnit}，需要 ${formatQty(needMilli)} ${m.inventoryUnit}`,
    { materialId: m.id, stockMilli: m.stockMilli, needMilli },
  );
}

/** 出库前按物料汇总校验（同一单里同一物料出现多行时一起计算） */
export function assertEnoughStock(materials: Map<number, LockedMaterial>, outs: { materialId: number; qtyMilli: number }[]) {
  const need = new Map<number, number>();
  for (const o of outs) need.set(o.materialId, (need.get(o.materialId) ?? 0) + o.qtyMilli);
  for (const [id, qty] of need) {
    const m = materials.get(id)!;
    if (m.stockMilli < qty) throw insufficient(m, qty);
  }
}

/** 部门小仓里这些物料的结存（没有记录的算 0）；调用方已锁定物料行 */
export async function deptBalances(db: Db, warehouseId: number, materialIds: number[]): Promise<Map<number, { stockMilli: number; lastMoveId: number | null }>> {
  const unique = [...new Set(materialIds)];
  const rows = unique.length
    ? await db<{ materialId: number; stockMilli: number; lastMoveId: number | null }[]>`
        SELECT material_id, stock_milli, last_move_id FROM warehouse_stock WHERE warehouse_id = ${warehouseId} AND material_id IN ${db(unique)}`
    : [];
  const map = new Map(rows.map((r) => [r.materialId, { stockMilli: r.stockMilli, lastMoveId: r.lastMoveId }]));
  for (const id of unique) if (!map.has(id)) map.set(id, { stockMilli: 0, lastMoveId: null });
  return map;
}

/** 部门小仓出库前按物料汇总校验 */
export async function assertEnoughDeptStock(db: Db, warehouseId: number, warehouseName: string, materials: Map<number, LockedMaterial>, outs: { materialId: number; qtyMilli: number }[]) {
  const need = new Map<number, number>();
  for (const o of outs) need.set(o.materialId, (need.get(o.materialId) ?? 0) + o.qtyMilli);
  const have = await deptBalances(db, warehouseId, [...need.keys()]);
  for (const [id, qty] of need) {
    const stock = have.get(id)!.stockMilli;
    if (stock < qty) {
      const m = materials.get(id)!;
      throw unprocessable(
        'INSUFFICIENT_STOCK',
        `「${m.name}」${warehouseName}库存不足：当前 ${formatQty(stock)} ${m.inventoryUnit}，需要 ${formatQty(qty)} ${m.inventoryUnit}`,
        { materialId: m.id, stockMilli: stock, needMilli: qty, warehouseId },
      );
    }
  }
}

/**
 * 写一条库存流水并更新所在仓的结存（v0.7.11 两级库存）：总仓的结存在物料上（stock_milli、last_move_id），
 * 部门小仓的在 warehouse_stock；流水的「变动后结存」按所在仓算。调用方已按 id 升序锁定物料行（所有仓的收发都串行）。
 */
export async function applyMove(
  tx: Tx,
  m: LockedMaterial,
  deltaMilli: number,
  ref: { moveType: MoveType; docId: number; lineId: number; docDate: string; operatorId: number; warehouseId: number; warehouseName?: string },
) {
  if (deltaMilli === 0) return;
  if (ref.warehouseId === CENTRAL_WAREHOUSE_ID) {
    const after = m.stockMilli + deltaMilli;
    if (after < 0) throw insufficient(m, -deltaMilli);
    const [move] = await tx<{ id: number }[]>`
      INSERT INTO stock_moves (material_id, move_type, doc_id, doc_line_id, qty_delta_milli, qty_after_milli, doc_date, operator_id, warehouse_id)
      VALUES (${m.id}, ${ref.moveType}, ${ref.docId}, ${ref.lineId}, ${deltaMilli}, ${after}, ${ref.docDate}, ${ref.operatorId}, ${CENTRAL_WAREHOUSE_ID})
      RETURNING id`;
    await tx`UPDATE materials SET stock_milli = ${after}, last_move_id = ${move!.id}, updated_at = now() WHERE id = ${m.id}`;
    m.stockMilli = after;
    m.lastMoveId = move!.id;
    return;
  }
  const [cur] = await tx<{ stockMilli: number }[]>`
    SELECT stock_milli FROM warehouse_stock WHERE warehouse_id = ${ref.warehouseId} AND material_id = ${m.id} FOR UPDATE`;
  const before = cur?.stockMilli ?? 0;
  const after = before + deltaMilli;
  if (after < 0) {
    throw unprocessable(
      'INSUFFICIENT_STOCK',
      `「${m.name}」${ref.warehouseName ?? '部门小仓'}库存不足：当前 ${formatQty(before)} ${m.inventoryUnit}，需要 ${formatQty(-deltaMilli)} ${m.inventoryUnit}`,
      { materialId: m.id, stockMilli: before, needMilli: -deltaMilli, warehouseId: ref.warehouseId },
    );
  }
  const [move] = await tx<{ id: number }[]>`
    INSERT INTO stock_moves (material_id, move_type, doc_id, doc_line_id, qty_delta_milli, qty_after_milli, doc_date, operator_id, warehouse_id)
    VALUES (${m.id}, ${ref.moveType}, ${ref.docId}, ${ref.lineId}, ${deltaMilli}, ${after}, ${ref.docDate}, ${ref.operatorId}, ${ref.warehouseId})
    RETURNING id`;
  await tx`
    INSERT INTO warehouse_stock (warehouse_id, material_id, stock_milli, last_move_id) VALUES (${ref.warehouseId}, ${m.id}, ${after}, ${move!.id})
    ON CONFLICT (warehouse_id, material_id) DO UPDATE SET stock_milli = ${after}, last_move_id = ${move!.id}, updated_at = now()`;
}

export type DocKind = 'inv_doc' | 'purchase_order' | 'payment' | 'opening_payable' | 'expense_claim' | 'petty_advance' | 'petty_settlement' | 'purchase_request';
export type ApprovalAction = 'create' | 'submit' | 'approve' | 'return' | 'cancel' | 'void' | 'close' | 'revise' | 'sign';

export async function logApproval(
  tx: Db,
  kind: DocKind,
  docId: number,
  action: ApprovalAction,
  actorId: number,
  reason = '',
  revision: number | null = null,
) {
  await tx`
    INSERT INTO approval_logs (doc_kind, doc_id, action, actor_id, reason, revision)
    VALUES (${kind}, ${docId}, ${action}, ${actorId}, ${reason}, ${revision})`;
}

/** 库存与采购写操作统一的等锁上限，与会员记账一致 */
/**
 * 一张采购单只有一种结算方式（v0.7.8 修正 v0.7.7）：以第一张生效的收货记下的为准；还没收货但已按采购单报销（现付）的算现付；
 * 都没有才看供应商当前的设置。这样供应商改了结算方式之后，同一张采购单不会既记应付又走报销。
 */
export async function poSettlement(db: Db, poId: number): Promise<'credit' | 'cash'> {
  const [row] = await db<{ settlement: 'credit' | 'cash' }[]>`
    SELECT coalesce(
             (SELECT d.settlement FROM inv_docs d
              WHERE d.purchase_order_id = p.id AND d.doc_type = 'receipt' AND d.status = 'confirmed' AND d.settlement IS NOT NULL
              ORDER BY d.confirmed_at, d.id LIMIT 1),
             CASE WHEN EXISTS (SELECT 1 FROM expense_claims c WHERE c.purchase_order_id = p.id AND c.status IN ('submitted', 'returned', 'confirmed'))
                  THEN 'cash' END,
             s.settlement) AS settlement
    FROM purchase_orders p JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = ${poId}`;
  return row?.settlement ?? 'credit';
}

export async function setTxTimeouts(tx: Tx) {
  await tx.unsafe("SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '10s'");
}

/**
 * 同口径的最近一次成交价：同一物料（即同规格）、同采购单位与换算、同价格口径的已生效收货。
 * 没有可比历史时返回 null，页面显示「暂无可比成交价」，不计算涨跌。
 */
export async function priceBaseline(
  db: Db,
  key: { materialId: number; purchaseUnit: string; factorMilli: number; priceBasis: string },
  scope: { onOrBefore: string; excludePoId?: number | null; beforeDoc?: { date: string; id: number } | null },
) {
  const [row] = await db<{ priceCents: number; docId: number; docNo: string; docDate: string; supplierName: string }[]>`
    SELECT l.price_cents, d.id AS doc_id, d.doc_no, d.doc_date, s.name AS supplier_name
    FROM inv_doc_lines l JOIN inv_docs d ON d.id = l.doc_id JOIN suppliers s ON s.id = d.supplier_id
    WHERE d.doc_type = 'receipt' AND d.status = 'confirmed' AND l.material_id = ${key.materialId}
      AND l.purchase_unit = ${key.purchaseUnit} AND l.factor_milli = ${key.factorMilli} AND d.price_basis = ${key.priceBasis}
      AND l.price_cents IS NOT NULL AND l.qty_milli > 0
      AND d.doc_date <= ${scope.onOrBefore}
      ${scope.excludePoId ? db`AND d.purchase_order_id IS DISTINCT FROM ${scope.excludePoId}` : db``}
      ${scope.beforeDoc ? db`AND (d.doc_date, d.id) < (${scope.beforeDoc.date}::date, ${scope.beforeDoc.id}::bigint)` : db``}
    ORDER BY d.doc_date DESC, d.id DESC
    LIMIT 1`;
  return row ?? null;
}
