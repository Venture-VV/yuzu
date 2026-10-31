// 库存模块的公共能力：设置、单号、锁定物料、写库存流水、审批记录。
//
// 并发规则（与会员钱包一致）：
//   · 每笔改变库存的操作在一个事务里完成「单据 + 流水 + 物料结存」；
//   · 先按 id 升序锁定涉及的物料行（SELECT … FOR UPDATE），同一物料的收发严格串行；
//   · 结存字段有 CHECK (>= 0) 兜底，任何情况下都不会出现负库存。

import { businessDateOf, ISO_DATE } from '@shared/business-date';
import type { ApprovalRules, InventorySettings, MoveType } from '@shared/inventory';
import { formatQty } from '@shared/quantity';
import { z } from 'zod';
import type { Db, Tx } from '../../db';
import { AppError, unprocessable } from '../../lib/errors';

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
    WHERE key IN ('inventory_scope_name', 'inventory_price_basis', 'inventory_allow_direct_receipt', 'inventory_approval_rules')`;
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    scopeName: (map.get('inventory_scope_name') as string) ?? '后勤总库',
    priceBasis: (map.get('inventory_price_basis') as string) ?? '含税到货价',
    allowDirectReceipt: (map.get('inventory_allow_direct_receipt') as boolean) ?? true,
    approvalRules: { ...DEFAULT_APPROVAL_RULES, ...((map.get('inventory_approval_rules') as Partial<ApprovalRules>) ?? {}) },
  };
}

/** 门店时区的自然日（库存与采购按自然日统计，不沿用会员营业日切换规则） */
export const todayIn = (timeZone: string) => businessDateOf(new Date(), timeZone, 0);

export const docDateSchema = z.string().regex(ISO_DATE, '日期格式应为 YYYY-MM-DD');

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

/** 写一条库存流水并更新物料结存 */
export async function applyMove(
  tx: Tx,
  m: LockedMaterial,
  deltaMilli: number,
  ref: { moveType: MoveType; docId: number; lineId: number; docDate: string; operatorId: number },
) {
  if (deltaMilli === 0) return;
  const after = m.stockMilli + deltaMilli;
  if (after < 0) throw insufficient(m, -deltaMilli);
  const [move] = await tx<{ id: number }[]>`
    INSERT INTO stock_moves (material_id, move_type, doc_id, doc_line_id, qty_delta_milli, qty_after_milli, doc_date, operator_id)
    VALUES (${m.id}, ${ref.moveType}, ${ref.docId}, ${ref.lineId}, ${deltaMilli}, ${after}, ${ref.docDate}, ${ref.operatorId})
    RETURNING id`;
  await tx`UPDATE materials SET stock_milli = ${after}, last_move_id = ${move!.id}, updated_at = now() WHERE id = ${m.id}`;
  m.stockMilli = after;
  m.lastMoveId = move!.id;
}

export type DocKind = 'inv_doc' | 'purchase_order' | 'payment' | 'opening_payable' | 'expense_claim' | 'petty_advance' | 'petty_settlement' | 'purchase_request';
export type ApprovalAction = 'create' | 'submit' | 'approve' | 'return' | 'cancel' | 'void' | 'close' | 'revise';

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
