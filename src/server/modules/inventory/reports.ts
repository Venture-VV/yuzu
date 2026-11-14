// 库存查询：库存卡（单物料流水）、期间收发汇总、工作台概览、账实一致性自检。
// 所有汇总只按各物料自己的库存单位统计，不跨单位求和。

import type { FastifyInstance } from 'fastify';
import { approvalChecks } from '../approvals/engine';
import { z } from 'zod';
import {
  CENTRAL_WAREHOUSE_ID,
  ISSUE_SIGN_DUE_DAYS,
  MOVE_TYPE_LABELS,
  SUPPLIER_ANSWER_DUE_DAYS,
  type CheckItem,
  type InventoryOverview,
  type StockCard,
  type StockMoveRow,
  type StockSummaryRow,
  type Warehouse,
  type WarehouseSel,
  type WarehouseStockRow,
} from '@shared/inventory';
import { formatQty } from '@shared/quantity';
import { readSnapshot, type Db } from '../../db';
import { guard } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import type { Deps } from '../../lib/context';
import { toCsv, CSV_TYPE, attachment } from '../../lib/csv';
import { badRequest, notFound } from '../../lib/errors';
import { idParam, parse } from '../../lib/validate';
import { coverFor, docDateSchema, loadInventorySettings, todayIn, usageByMaterial, usageSince, warehouseInfo } from './common';
import { getMaterial, listMaterials } from './master';
import { reconciliationChecks } from './cycles';

/** 查询参数里的仓：数字是某一个仓，all 是全部合计；不填是总仓（与 v0.7.10 以前一样） */
export const warehouseParam = z
  .string()
  .regex(/^(all|[1-9]\d{0,9})$/, '仓库参数不正确')
  .optional()
  .transform((v): WarehouseSel => (v === undefined ? CENTRAL_WAREHOUSE_ID : v === 'all' ? 'all' : Number(v)));

/** 仓库列表：总仓在前，部门小仓按部门顺序 */
export async function listWarehouses(db: Db): Promise<Warehouse[]> {
  return db<Warehouse[]>`
    SELECT w.id, w.kind, w.department_id,
           CASE WHEN w.kind = 'central'
                THEN coalesce((SELECT value #>> '{}' FROM settings WHERE key = 'inventory_scope_name'), '后勤总库')
                ELSE d.name || '小仓' END AS name,
           coalesce(d.active, true) AS active
    FROM warehouses w LEFT JOIN departments d ON d.id = w.department_id
    ORDER BY w.kind = 'department', d.active DESC, d.sort_order, d.id`;
}

/** 部门小仓的结存（有过收发的物料；结存为 0 的排在后面），带近期日均用量与可用天数（#22，v0.7.12） */
export async function warehouseStock(db: Db, warehouseId: number, timeZone?: string): Promise<WarehouseStockRow[]> {
  const rows = await db<Omit<WarehouseStockRow, 'dailyUsageMilli' | 'daysOfCover' | 'isLow'>[]>`
    SELECT m.id AS material_id, m.code, m.name, m.specification, m.category, m.inventory_unit, m.decimals, ws.stock_milli, m.cover_days,
           m.counter_use, m.replenish_mode, (SELECT created_at FROM stock_moves WHERE id = ws.last_move_id) AS last_move_at
    FROM warehouse_stock ws JOIN materials m ON m.id = ws.material_id
    WHERE ws.warehouse_id = ${warehouseId}
    ORDER BY ws.stock_milli = 0, m.counter_use, m.code`;
  if (!timeZone) return rows.map((r) => ({ ...r, dailyUsageMilli: 0, daysOfCover: null, isLow: false }));
  const { usageWindowDays } = await loadInventorySettings(db);
  const used = await usageByMaterial(db, warehouseId, usageSince(timeZone, usageWindowDays));
  // 部门小仓只按可用天数提醒（固定的低库存数量是总仓的）；台面日耗品领到即耗用、没有结存，不提醒（v0.7.13）；
  // 补货方式是按需采购的也不提醒（迁移 161）
  return rows.map((r) => {
    const cover = coverFor(r.stockMilli, used.get(r.materialId) ?? 0, usageWindowDays, { coverDays: r.coverDays, lowStockMilli: null, replenishMode: r.replenishMode });
    return r.counterUse ? { ...r, ...cover, daysOfCover: null, isLow: false } : { ...r, ...cover };
  });
}

/** 这个物料在各仓的结存：总仓在前，部门小仓只列有过收发的 */
export async function materialBalances(db: Db, materialId: number): Promise<StockCard['balances']> {
  return db<StockCard['balances']>`
    SELECT 1 AS warehouse_id, coalesce((SELECT value #>> '{}' FROM settings WHERE key = 'inventory_scope_name'), '后勤总库') AS name,
           'central' AS kind, m.stock_milli
    FROM materials m WHERE m.id = ${materialId}
    UNION ALL
    SELECT * FROM (
      SELECT w.id, d.name || '小仓', 'department', ws.stock_milli
      FROM warehouse_stock ws JOIN warehouses w ON w.id = ws.warehouse_id JOIN departments d ON d.id = w.department_id
      WHERE ws.material_id = ${materialId} ORDER BY d.sort_order, d.id) x`;
}

export async function stockCard(
  db: Db,
  materialId: number,
  f: { from?: string; to?: string; limit?: number; warehouseId?: number; timeZone?: string } = {},
): Promise<StockCard> {
  const material = await getMaterial(db, materialId, f.timeZone);
  const whId = f.warehouseId ?? CENTRAL_WAREHOUSE_ID;
  const wh = await warehouseInfo(db, whId);
  if (!wh) throw notFound('仓库不存在');
  const moves = await db<StockMoveRow[]>`
    SELECT sm.id, sm.move_type, sm.qty_delta_milli, sm.qty_after_milli, sm.doc_date, sm.created_at,
           d.id AS doc_id, d.doc_no, d.doc_type, coalesce(s.name, dep.name) AS party_name,
           st.display_name AS operator_name,
           CASE WHEN sm.move_type = 'void' THEN coalesce(d.void_reason, '') ELSE coalesce(nullif(l.note, ''), d.note) END AS note
    FROM stock_moves sm
    JOIN inv_docs d ON d.id = sm.doc_id
    JOIN inv_doc_lines l ON l.id = sm.doc_line_id
    LEFT JOIN suppliers s ON s.id = d.supplier_id
    LEFT JOIN departments dep ON dep.id = d.department_id
    JOIN staff st ON st.id = sm.operator_id
    WHERE sm.material_id = ${materialId} AND sm.warehouse_id = ${whId}
      ${f.from ? db`AND sm.doc_date >= ${f.from}` : db``}
      ${f.to ? db`AND sm.doc_date <= ${f.to}` : db``}
    ORDER BY sm.id DESC
    LIMIT ${f.limit ?? 500}`;
  // 未生效的单据不影响库存，单独列出便于员工知道「还有什么在路上」；领料、退回两头都算
  const central = whId === CENTRAL_WAREHOUSE_ID;
  const pending = await db<StockCard['pending']>`
    SELECT d.id, d.doc_no, d.doc_type, d.status, d.doc_date, l.qty_milli
    FROM inv_doc_lines l JOIN inv_docs d ON d.id = l.doc_id
    WHERE l.material_id = ${materialId} AND d.status IN ('draft', 'submitted', 'returned', 'awaiting_supplier')
      AND ${central ? db`(d.warehouse_id = 1 OR d.warehouse_id IS NULL OR d.doc_type IN ('issue', 'issue_return'))` : db`d.warehouse_id = ${whId}`}
    ORDER BY d.id DESC LIMIT 20`;
  return {
    material,
    warehouse: { id: wh.id, name: wh.name, kind: wh.kind },
    balances: await materialBalances(db, materialId),
    moves,
    pending,
  };
}

/**
 * 期间收发汇总：期初结存 + 本期各类变动 = 期末结存。按仓（v0.7.11）：总仓、某个部门小仓，或全部合计。
 * 出库类（领料、耗用、报损、退供应商）显示为正数；盘点调整与冲销保留正负号。部门小仓的领料是进、退回是出（见 StockSummaryRow）；
 * 全部合计里迁移后的领料、退回是总仓与小仓之间的调拨，一出一进抵消，剩下的只有迁移前没进部门小仓的领用。
 */
export async function stockSummary(db: Db, from: string, to: string, warehouse: WarehouseSel = CENTRAL_WAREHOUSE_ID): Promise<StockSummaryRow[]> {
  if (from > to) throw badRequest('开始日期不能晚于结束日期');
  const dept = warehouse !== 'all' && warehouse !== CENTRAL_WAREHOUSE_ID;
  const inPeriod = (type: string) => db`sum(sm.qty_delta_milli) FILTER (WHERE sm.doc_date BETWEEN ${from} AND ${to} AND sm.move_type = ${type})`;
  return db<StockSummaryRow[]>`
    SELECT m.id AS material_id, m.code, m.name, m.specification, m.inventory_unit, m.active,
           coalesce(sum(sm.qty_delta_milli) FILTER (WHERE sm.doc_date < ${from}), 0) AS begin,
           coalesce(${inPeriod('opening')}, 0) AS opening,
           coalesce(${inPeriod('receipt')}, 0) AS received,
           ${dept ? db`coalesce(${inPeriod('issue')}, 0)` : db`-coalesce(${inPeriod('issue')}, 0)`} AS issued,
           ${dept ? db`-coalesce(${inPeriod('issue_return')}, 0)` : db`coalesce(${inPeriod('issue_return')}, 0)`} AS issue_returned,
           -coalesce(${inPeriod('direct_use')}, 0) AS direct_used,
           -coalesce(${inPeriod('damage')}, 0) AS damaged,
           coalesce(${inPeriod('count_adjust')}, 0) AS count_adjusted,
           -coalesce(${inPeriod('supplier_return')}, 0) AS supplier_returned,
           coalesce(${inPeriod('void')}, 0) AS voided,
           coalesce(sum(sm.qty_delta_milli) FILTER (WHERE sm.doc_date <= ${to}), 0) AS closing
    FROM materials m
    LEFT JOIN stock_moves sm ON sm.material_id = m.id ${warehouse === 'all' ? db`` : db`AND sm.warehouse_id = ${warehouse}`}
    WHERE m.tracked
    GROUP BY m.id
    ${dept ? db`HAVING count(sm.id) FILTER (WHERE sm.doc_date <= ${to}) > 0` : db``}
    ORDER BY m.code`;
}

export async function inventoryOverview(db: Db, timeZone: string): Promise<InventoryOverview> {
  const settings = await loadInventorySettings(db);
  const today = todayIn(timeZone);
  const [row] = await db<Omit<InventoryOverview, 'scopeName'>[]>`
    SELECT
      (SELECT count(*) FROM inv_docs WHERE doc_type = 'issue' AND status = 'confirmed' AND warehouse_id IS NOT NULL
         AND dept_signed_at IS NULL AND confirmed_at < now() - make_interval(days => ${ISSUE_SIGN_DUE_DAYS})) AS unsigned_issues,
      -- 急采待仓库验收：已经按金额分级审批过的（8.0.1；还在审批中的不算）
      (SELECT count(*) FROM inv_docs WHERE doc_type = 'receipt' AND urgent AND status = 'submitted' AND urgent_approved_at IS NOT NULL) AS urgent_to_verify,
      (SELECT count(*) FROM inv_docs WHERE doc_type = 'receipt' AND urgent AND status = 'confirmed' AND purchase_order_id IS NULL) AS urgent_to_backfill,
      (SELECT count(*) FROM inv_docs WHERE status = 'awaiting_supplier') AS awaiting_supplier,
      (SELECT count(*) FROM inv_docs WHERE status = 'awaiting_supplier'
         AND coalesce(submitted_at, created_at) < now() - make_interval(days => ${SUPPLIER_ANSWER_DUE_DAYS})) AS awaiting_supplier_overdue,
      (SELECT count(*) FROM materials WHERE tracked AND active) AS material_count,
      (SELECT count(*) FROM inv_docs WHERE doc_type = 'count' AND status IN ('draft', 'submitted', 'returned')) AS pending_counts,
      (SELECT count(*) FROM inv_docs WHERE status = 'submitted') AS pending_approvals,
      (SELECT count(DISTINCT doc_id) FROM stock_moves WHERE doc_date = ${today} AND qty_delta_milli > 0 AND move_type <> 'void') AS today_in,
      (SELECT count(DISTINCT doc_id) FROM stock_moves WHERE doc_date = ${today} AND qty_delta_milli < 0 AND move_type <> 'void') AS today_out`;
  // 提醒线（#22）：设了提醒天数且有用量的按可用天数，否则按固定数量
  const lowCount = (await listMaterials(db, { trackedOnly: true, timeZone })).filter((m) => m.isLow).length;
  return { scopeName: settings.scopeName, ...row!, lowCount };
}

/**
 * 账实自检：结存 = 流水合计 = 最后一条流水的结存；流水链连续；生效单据都有流水。按仓（v0.7.11）：
 * 总仓的结存在物料上，部门小仓的在 warehouse_stock；各仓的流水各自逐笔连续。
 * 用于工作台「数据自检」和测试断言，正常情况下全部通过。
 */
export async function inventoryChecks(db: Db): Promise<CheckItem[]> {
  const items: CheckItem[] = [];
  const mismatch = await db<{ name: string; stockMilli: number; sumMilli: number }[]>`
    SELECT m.name, m.stock_milli, coalesce(sum(sm.qty_delta_milli), 0) AS sum_milli
    FROM materials m LEFT JOIN stock_moves sm ON sm.material_id = m.id AND sm.warehouse_id = 1
    GROUP BY m.id HAVING m.stock_milli <> coalesce(sum(sm.qty_delta_milli), 0)`;
  items.push({
    key: 'stock_equals_moves',
    label: '总仓结存与流水合计一致',
    ok: mismatch.length === 0,
    detail: mismatch.length ? mismatch.map((m) => `${m.name}：结存 ${formatQty(m.stockMilli)}，流水 ${formatQty(m.sumMilli)}`).join('；') : '全部物料一致',
  });

  const lastMismatch = await db<{ name: string }[]>`
    SELECT m.name FROM materials m
    WHERE m.last_move_id IS DISTINCT FROM (SELECT max(id) FROM stock_moves WHERE material_id = m.id AND warehouse_id = 1)
       OR m.stock_milli <> coalesce((SELECT qty_after_milli FROM stock_moves WHERE id = m.last_move_id), 0)`;
  items.push({
    key: 'last_move',
    label: '总仓结存与最后一条流水一致',
    ok: lastMismatch.length === 0,
    detail: lastMismatch.length ? lastMismatch.map((m) => m.name).join('、') : '全部物料一致',
  });

  // 部门小仓：结存 = 该仓流水合计 = 最后一条流水的结存
  const deptMismatch = await db<{ warehouseName: string; name: string; stockMilli: number; sumMilli: number }[]>`
    WITH mv AS (
      SELECT warehouse_id, material_id, sum(qty_delta_milli) AS sum_milli, max(id) AS last_id
      FROM stock_moves WHERE warehouse_id <> 1 GROUP BY warehouse_id, material_id
    )
    SELECT d.name || '小仓' AS warehouse_name, m.name, coalesce(ws.stock_milli, 0) AS stock_milli, coalesce(mv.sum_milli, 0) AS sum_milli
    FROM warehouse_stock ws FULL JOIN mv ON mv.warehouse_id = ws.warehouse_id AND mv.material_id = ws.material_id
    JOIN warehouses w ON w.id = coalesce(ws.warehouse_id, mv.warehouse_id)
    LEFT JOIN departments d ON d.id = w.department_id
    JOIN materials m ON m.id = coalesce(ws.material_id, mv.material_id)
    WHERE coalesce(ws.stock_milli, 0) <> coalesce(mv.sum_milli, 0)
       OR ws.last_move_id IS DISTINCT FROM mv.last_id
       OR coalesce(ws.stock_milli, 0) <> coalesce((SELECT qty_after_milli FROM stock_moves WHERE id = mv.last_id), 0)`;
  items.push({
    key: 'dept_stock_equals_moves',
    label: '部门小仓结存与流水一致',
    ok: deptMismatch.length === 0,
    detail: deptMismatch.length
      ? deptMismatch.map((m) => `${m.warehouseName} ${m.name}：结存 ${formatQty(m.stockMilli)}，流水 ${formatQty(m.sumMilli)}`).join('；')
      : '全部一致',
  });

  const broken = await db<{ name: string; count: number }[]>`
    SELECT m.name, count(*) AS count FROM (
      SELECT material_id, qty_after_milli, qty_delta_milli,
             lag(qty_after_milli, 1, 0::bigint) OVER (PARTITION BY material_id, warehouse_id ORDER BY id) AS prev_after
      FROM stock_moves) x JOIN materials m ON m.id = x.material_id
    WHERE x.prev_after + x.qty_delta_milli <> x.qty_after_milli
    GROUP BY m.name`;
  items.push({
    key: 'move_chain',
    label: '各仓流水逐笔连续（上一笔结存 + 本笔变动 = 本笔结存）',
    ok: broken.length === 0,
    detail: broken.length ? broken.map((b) => `${b.name} ${b.count} 处`).join('、') : '全部连续',
  });

  const orphan = await db<{ docNo: string }[]>`
    SELECT d.doc_no FROM inv_docs d
    WHERE d.status IN ('confirmed', 'voided') AND d.doc_type <> 'count'
      AND EXISTS (SELECT 1 FROM inv_doc_lines l WHERE l.doc_id = d.id AND l.qty_milli <> 0)
      AND NOT EXISTS (SELECT 1 FROM stock_moves WHERE doc_id = d.id)
    UNION ALL
    SELECT d.doc_no FROM inv_docs d
    WHERE d.status NOT IN ('confirmed', 'voided') AND EXISTS (SELECT 1 FROM stock_moves WHERE doc_id = d.id)`;
  items.push({
    key: 'doc_moves',
    label: '只有已生效单据产生流水',
    ok: orphan.length === 0,
    detail: orphan.length ? orphan.map((o) => o.docNo).join('、') : '一致',
  });

  // 流水记在单据的仓：领料、退回是总仓与单据上的部门小仓一出一进（迁移前的只在总仓），其他单据只在单据的仓
  const wrongWh = await db<{ docNo: string }[]>`
    SELECT d.doc_no FROM inv_docs d
    WHERE d.status IN ('confirmed', 'voided') AND (
      EXISTS (SELECT 1 FROM stock_moves sm WHERE sm.doc_id = d.id
              AND sm.warehouse_id <> coalesce(d.warehouse_id, 1)
              AND NOT (d.doc_type IN ('issue', 'issue_return') AND sm.warehouse_id = 1))
      OR (d.doc_type IN ('issue', 'issue_return') AND d.warehouse_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM inv_doc_lines l WHERE l.doc_id = d.id AND (
              coalesce((SELECT sum(sm.qty_delta_milli) FROM stock_moves sm WHERE sm.doc_line_id = l.id AND sm.move_type <> 'void' AND sm.warehouse_id = 1), 0)
                <> CASE WHEN d.doc_type = 'issue' THEN -l.qty_milli ELSE l.qty_milli END
              OR coalesce((SELECT sum(sm.qty_delta_milli) FROM stock_moves sm WHERE sm.doc_line_id = l.id AND sm.move_type NOT IN ('void', 'direct_use')
                           AND sm.warehouse_id = d.warehouse_id), 0)
                <> CASE WHEN d.doc_type = 'issue' THEN l.qty_milli ELSE -l.qty_milli END))))`;
  items.push({
    key: 'move_warehouse',
    label: '流水记在单据的仓（领料、退回是总仓与部门小仓一出一进；台面日耗品的自动耗用不计）',
    ok: wrongWh.length === 0,
    detail: wrongWh.length ? wrongWh.map((o) => o.docNo).join('、') : '一致',
  });

  const voidNet = await db<{ docNo: string }[]>`
    SELECT DISTINCT d.doc_no FROM inv_docs d JOIN stock_moves sm ON sm.doc_id = d.id
    WHERE d.status = 'voided' GROUP BY d.id, sm.warehouse_id HAVING sum(sm.qty_delta_milli) <> 0`;
  items.push({
    key: 'void_net_zero',
    label: '已冲销单据对各仓库存的净影响为 0',
    ok: voidNet.length === 0,
    detail: voidNet.length ? voidNet.map((o) => o.docNo).join('、') : '一致',
  });

  // #19：迁移 029 以后生效的收货都按采购单，没有采购单的只能是急采（合计不超过登记时的上限）；急采后补单另在待办里提醒
  const noPo = await db<{ docNo: string }[]>`
    SELECT d.doc_no FROM inv_docs d
    WHERE d.doc_type = 'receipt' AND d.status = 'confirmed' AND d.purchase_order_id IS NULL AND NOT d.urgent
      AND d.created_at >= (SELECT applied_at FROM schema_migrations WHERE version = '029_warehouses.sql')
    UNION ALL
    SELECT d.doc_no FROM inv_docs d WHERE d.urgent AND (d.urgent_cap_cents IS NULL OR d.amount_cents > d.urgent_cap_cents)`;
  items.push({
    key: 'receipt_po',
    label: '收货都有采购单，没有的是急采且不超过上限',
    ok: noPo.length === 0,
    detail: noPo.length ? noPo.map((o) => o.docNo).join('、') : '一致',
  });

  // 台面日耗品（#14，v0.7.13）：部门小仓没有结存；领料、急采里的自动耗用要么没有、要么正好是这一行的数量，且只在部门小仓
  const counterBad = await db<{ label: string }[]>`
    SELECT m.name || '在' || dep.name || '小仓还有结存' AS label
    FROM warehouse_stock ws JOIN materials m ON m.id = ws.material_id
    JOIN warehouses w ON w.id = ws.warehouse_id JOIN departments dep ON dep.id = w.department_id
    WHERE m.counter_use AND ws.stock_milli > 0
    UNION ALL
    SELECT d.doc_no || ' ' || m.name || '的自动耗用与领料数量不一致'
    FROM inv_docs d JOIN inv_doc_lines l ON l.doc_id = d.id JOIN materials m ON m.id = l.material_id
    WHERE d.doc_type IN ('issue', 'receipt') AND d.status IN ('confirmed', 'voided')
      AND coalesce((SELECT sum(sm.qty_delta_milli) FROM stock_moves sm WHERE sm.doc_line_id = l.id AND sm.move_type = 'direct_use'), 0)
          NOT IN (0, -l.qty_milli)
    UNION ALL
    SELECT d.doc_no || ' 的自动耗用不在部门小仓'
    FROM inv_docs d JOIN stock_moves sm ON sm.doc_id = d.id
    WHERE d.doc_type IN ('issue', 'receipt') AND sm.move_type = 'direct_use'
      AND (sm.warehouse_id = ${CENTRAL_WAREHOUSE_ID} OR sm.warehouse_id IS DISTINCT FROM d.warehouse_id)`;
  items.push({
    key: 'counter_use',
    label: '台面日耗品在部门小仓没有结存，领料、急采的自动耗用与数量一致',
    ok: counterBad.length === 0,
    detail: counterBad.length ? counterBad.map((c) => c.label).join('、') : '一致',
  });

  // 每个部门都有小仓；停用的部门小仓已清空
  const deptWh = await db<{ name: string; problem: string }[]>`
    SELECT d.name, '没有小仓' AS problem FROM departments d WHERE NOT EXISTS (SELECT 1 FROM warehouses w WHERE w.department_id = d.id)
    UNION ALL
    SELECT d.name, '已停用但小仓还有存货' FROM departments d JOIN warehouses w ON w.department_id = d.id
    WHERE NOT d.active AND EXISTS (SELECT 1 FROM warehouse_stock ws WHERE ws.warehouse_id = w.id AND ws.stock_milli > 0)`;
  items.push({
    key: 'dept_warehouses',
    label: '每个部门都有小仓，停用部门的小仓已清空',
    ok: deptWh.length === 0,
    detail: deptWh.length ? deptWh.map((d) => `${d.name}${d.problem}`).join('、') : '一致',
  });

  // ── 供应商往来（v0.7.12）：应付流水合计 = 应付未付合计 − 可抵扣合计 ──
  const apMismatch = await db<{ name: string; balance: number; open: number; credit: number }[]>`
    WITH debit AS (
      SELECT d.supplier_id, d.amount_cents
        - coalesce((SELECT sum(coalesce(r.return_applied_cents, r.amount_cents)) FROM inv_docs r
                    WHERE r.source_doc_id = d.id AND r.doc_type = 'supplier_return' AND r.status = 'confirmed'), 0)
        - coalesce((SELECT sum(pa.amount_cents) FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
                    WHERE pa.receipt_doc_id = d.id AND p.status = 'confirmed'), 0)
        - coalesce((SELECT sum(ol.amount_cents) FROM ap_offset_lines ol JOIN ap_offsets o ON o.id = ol.offset_id
                    WHERE ol.receipt_doc_id = d.id AND o.status = 'confirmed'), 0) AS open_cents
      FROM inv_docs d WHERE d.doc_type = 'receipt' AND d.status = 'confirmed' AND d.settlement = 'credit'
      UNION ALL
      SELECT o.supplier_id, o.amount_cents
        - coalesce((SELECT sum(pa.amount_cents) FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
                    WHERE pa.opening_payable_id = o.id AND p.status = 'confirmed'), 0)
        - coalesce((SELECT sum(ol.amount_cents) FROM ap_offset_lines ol JOIN ap_offsets f ON f.id = ol.offset_id
                    WHERE ol.opening_payable_id = o.id AND f.status = 'confirmed'), 0)
      FROM opening_payables o WHERE o.status = 'confirmed'
    ), credit AS (
      SELECT p.supplier_id, p.amount_cents
        - coalesce((SELECT sum(amount_cents) FROM payment_allocations WHERE payment_id = p.id), 0)
        - coalesce((SELECT sum(amount_cents) FROM ap_offsets WHERE credit_payment_id = p.id AND status = 'confirmed'), 0)
        - coalesce((SELECT sum(amount_cents) FROM supplier_refunds WHERE credit_payment_id = p.id AND status = 'confirmed'), 0) AS credit_cents
      FROM payments p WHERE p.status = 'confirmed'
      UNION ALL
      SELECT r.supplier_id, r.amount_cents - coalesce(r.return_applied_cents, r.amount_cents)
        - coalesce((SELECT sum(amount_cents) FROM ap_offsets WHERE credit_return_id = r.id AND status = 'confirmed'), 0)
        - coalesce((SELECT sum(amount_cents) FROM supplier_refunds WHERE credit_return_id = r.id AND status = 'confirmed'), 0)
      FROM inv_docs r JOIN inv_docs src ON src.id = r.source_doc_id
      WHERE r.doc_type = 'supplier_return' AND r.status = 'confirmed' AND coalesce(src.settlement, 'credit') = 'credit'
    )
    SELECT s.name,
           coalesce((SELECT sum(amount_delta_cents) FROM ap_entries WHERE supplier_id = s.id), 0) AS balance,
           coalesce((SELECT sum(open_cents) FROM debit WHERE supplier_id = s.id), 0) AS open,
           coalesce((SELECT sum(credit_cents) FROM credit WHERE supplier_id = s.id), 0) AS credit
    FROM suppliers s`;
  const apBad = apMismatch.filter((r) => r.balance !== r.open - r.credit);
  items.push({
    key: 'ap_balance',
    label: '供应商余额 = 应付未付合计 − 可抵扣合计',
    ok: apBad.length === 0,
    detail: apBad.length
      ? apBad.map((r) => `${r.name}：余额 ${r.balance / 100}，未付 ${r.open / 100}，可抵扣 ${r.credit / 100}`).join('；')
      : '全部供应商一致',
  });

  // 核销、退款不超过可抵扣；核销单的明细合计等于核销金额；没有负的未付或可抵扣
  const overUsed = await db<{ docNo: string; problem: string }[]>`
    SELECT o.doc_no, '明细合计与核销金额不一致' AS problem FROM ap_offsets o
    WHERE (SELECT coalesce(sum(amount_cents), 0) FROM ap_offset_lines WHERE offset_id = o.id) <> o.amount_cents
    UNION ALL
    SELECT p.doc_no, '预付款被用超了' FROM payments p WHERE p.status = 'confirmed' AND p.amount_cents
      < coalesce((SELECT sum(amount_cents) FROM payment_allocations WHERE payment_id = p.id), 0)
      + coalesce((SELECT sum(amount_cents) FROM ap_offsets WHERE credit_payment_id = p.id AND status = 'confirmed'), 0)
      + coalesce((SELECT sum(amount_cents) FROM supplier_refunds WHERE credit_payment_id = p.id AND status = 'confirmed'), 0)
    UNION ALL
    SELECT r.doc_no, '退货余额被用超了' FROM inv_docs r WHERE r.doc_type = 'supplier_return' AND r.status = 'confirmed' AND r.amount_cents
      < coalesce(r.return_applied_cents, r.amount_cents)
      + coalesce((SELECT sum(amount_cents) FROM ap_offsets WHERE credit_return_id = r.id AND status = 'confirmed'), 0)
      + coalesce((SELECT sum(amount_cents) FROM supplier_refunds WHERE credit_return_id = r.id AND status = 'confirmed'), 0)
    UNION ALL
    SELECT d.doc_no, '核销与付款超过了未付' FROM inv_docs d WHERE d.doc_type = 'receipt' AND d.status = 'confirmed' AND d.amount_cents
      < coalesce((SELECT sum(coalesce(r.return_applied_cents, r.amount_cents)) FROM inv_docs r
                  WHERE r.source_doc_id = d.id AND r.doc_type = 'supplier_return' AND r.status = 'confirmed'), 0)
      + coalesce((SELECT sum(pa.amount_cents) FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
                  WHERE pa.receipt_doc_id = d.id AND p.status = 'confirmed'), 0)
      + coalesce((SELECT sum(ol.amount_cents) FROM ap_offset_lines ol JOIN ap_offsets o ON o.id = ol.offset_id
                  WHERE ol.receipt_doc_id = d.id AND o.status = 'confirmed'), 0)
    UNION ALL
    SELECT o.doc_no, '核销到了已冲销的应付' FROM ap_offsets o JOIN ap_offset_lines ol ON ol.offset_id = o.id
      LEFT JOIN inv_docs d ON d.id = ol.receipt_doc_id LEFT JOIN opening_payables op ON op.id = ol.opening_payable_id
    WHERE o.status = 'confirmed' AND coalesce(d.status, op.status) <> 'confirmed'
    UNION ALL
    SELECT r.doc_no, '退货单不在已生效却还有退款或核销' FROM inv_docs r
    WHERE r.doc_type = 'supplier_return' AND r.status <> 'confirmed'
      AND (EXISTS (SELECT 1 FROM ap_offsets WHERE credit_return_id = r.id AND status = 'confirmed')
           OR EXISTS (SELECT 1 FROM supplier_refunds WHERE credit_return_id = r.id AND status = 'confirmed'))`;
  items.push({
    key: 'ap_settlements',
    label: '核销与供应商退款不超过可抵扣，核销不超过未付',
    ok: overUsed.length === 0,
    detail: overUsed.length ? overUsed.map((o) => `${o.docNo}${o.problem}`).join('、') : '一致',
  });

  // 待供应商确认的退货（#20）：没有库存流水、没有应付流水
  const awaitingPosted = await db<{ docNo: string }[]>`
    SELECT d.doc_no FROM inv_docs d WHERE d.status = 'awaiting_supplier'
      AND (EXISTS (SELECT 1 FROM stock_moves WHERE doc_id = d.id) OR EXISTS (SELECT 1 FROM ap_entries WHERE inv_doc_id = d.id))`;
  items.push({
    key: 'awaiting_supplier',
    label: '待供应商确认的退货没有出库、没有扣款',
    ok: awaitingPosted.length === 0,
    detail: awaitingPosted.length ? awaitingPosted.map((o) => o.docNo).join('、') : '一致',
  });

  // 对账登记（#23，v0.7.13）：按批次登记的是同一供应商的收货单，一张最多在一条有效登记里，合计与明细一致
  const recon = await reconciliationChecks(db);
  items.push({
    key: 'supplier_reconciliations',
    label: '对账登记：按批次的收货单属于这个供应商、一张最多登记一次，合计与明细一致',
    ok: recon.bad.length === 0 && recon.badTotals.length === 0,
    detail:
      recon.bad.length || recon.badTotals.length
        ? [...recon.bad, ...recon.badTotals.map((id) => `对账登记 #${id} 合计不一致`)].join('、')
        : '一致',
  });

  // 审批中心（v0.7.30）
  items.push(await approvalChecks(db));
  return items;
}

// ───────────────────────── 路由 ─────────────────────────

const RangeQuery = z.object({ from: docDateSchema, to: docDateSchema, warehouse: warehouseParam });
const CardQuery = z.object({ from: docDateSchema.optional(), to: docDateSchema.optional(), warehouse: warehouseParam });
/** 库存卡按单个仓（各仓的结存各自连续），不支持全部合计 */
const cardWarehouse = (w: WarehouseSel) => {
  if (w === 'all') throw badRequest('库存卡按单个仓查看，请选一个仓');
  return w;
};

const qtyCell = (milli: number) => formatQty(milli);

export function registerReportRoutes(app: FastifyInstance, deps: Deps) {
  const { sql, config } = deps;

  app.get('/api/inventory/overview', { preHandler: guard('inventory.read') }, async () => inventoryOverview(sql, config.timezone));
  // 导航「待办」上的数字：所有等待负责人确认的单据
  app.get('/api/inventory/todo-count', { preHandler: guard('inventory.approve') }, async () => {
    const [row] = await sql<{ count: number }[]>`
      SELECT (SELECT count(*) FROM inv_docs WHERE status = 'submitted') + (SELECT count(*) FROM purchase_orders WHERE status = 'submitted')
           + (SELECT count(*) FROM payments WHERE status = 'submitted') + (SELECT count(*) FROM opening_payables WHERE status = 'submitted')
           + (SELECT count(*) FROM expense_claims WHERE status = 'submitted') AS count`;
    return { count: row!.count };
  });

  app.get('/api/inventory/materials/:id/card', { preHandler: guard('inventory.read') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const f = parse(CardQuery, req.query);
    return readSnapshot(sql, (tx) => stockCard(tx, id, { from: f.from, to: f.to, warehouseId: cardWarehouse(f.warehouse), timeZone: config.timezone }));
  });

  app.get('/api/inventory/summary', { preHandler: guard('inventory.read') }, async (req) => {
    const { from, to, warehouse } = parse(RangeQuery, req.query);
    return readSnapshot(sql, (tx) => stockSummary(tx, from, to, warehouse));
  });

  app.get('/api/inventory/checks', { preHandler: guard('inventory.read') }, async () => readSnapshot(sql, inventoryChecks));

  // 两级库存（v0.7.11）：仓库列表与部门小仓的结存
  app.get('/api/inventory/warehouses', { preHandler: guard('inventory.read') }, async () => listWarehouses(sql));
  app.get('/api/inventory/warehouses/:id/stock', { preHandler: guard('inventory.read') }, async (req) => {
    const { id } = parse(idParam, req.params);
    if (id === CENTRAL_WAREHOUSE_ID) throw badRequest('总仓的结存在物料列表里');
    if (!(await warehouseInfo(sql, id))) throw notFound('仓库不存在');
    return warehouseStock(sql, id, config.timezone);
  });

  app.get('/api/inventory/summary/export', { preHandler: guard('inventory.read') }, async (req, reply) => {
    const { from, to, warehouse } = parse(RangeQuery, req.query);
    const rows = await readSnapshot(sql, (tx) => stockSummary(tx, from, to, warehouse));
    const scope = warehouse === 'all' ? `${(await loadInventorySettings(sql)).scopeName}（含部门小仓，全部合计）` : (await warehouseInfo(sql, warehouse))?.name;
    if (!scope) throw notFound('仓库不存在');
    const dept = warehouse !== 'all' && warehouse !== CENTRAL_WAREHOUSE_ID;
    const head = [
      '物料编码', '物料名称', '规格', '库存单位', '期初结存', '期初建账', '收货入库',
      dept ? '从总仓领料（进）' : '部门领料（出）', dept ? '退回总仓（出）' : '领料退回（进）',
      '直接耗用', '报损', '盘点调整', '退供应商', '冲销', '期末结存',
    ];
    const csv = toCsv([
      [`${scope} 收发汇总 ${from} 至 ${to}（数量按各自库存单位，不跨单位合计）`],
      head,
      ...rows.map((r) => [
        r.code,
        r.name,
        r.specification,
        r.inventoryUnit,
        qtyCell(r.begin),
        qtyCell(r.opening),
        qtyCell(r.received),
        qtyCell(r.issued),
        qtyCell(r.issueReturned),
        qtyCell(r.directUsed),
        qtyCell(r.damaged),
        qtyCell(r.countAdjusted),
        qtyCell(r.supplierReturned),
        qtyCell(r.voided),
        qtyCell(r.closing),
      ]),
    ]);
    await writeAudit(sql, { staffId: req.actor.id, action: 'export', targetType: 'inventory_summary', detail: { from, to, warehouse }, ip: req.ip });
    attachment(reply, `收发汇总_${dept ? `${scope}_` : ''}${from}_${to}.csv`, CSV_TYPE);
    return csv;
  });

  app.get('/api/inventory/materials/:id/card/export', { preHandler: guard('inventory.read') }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const f = parse(CardQuery, req.query);
    const card = await readSnapshot(sql, (tx) => stockCard(tx, id, { from: f.from, to: f.to, warehouseId: cardWarehouse(f.warehouse), limit: 100_000 }));
    const m = card.material;
    const csv = toCsv([
      [`库存卡 ${m.code} ${m.name} ${m.specification}（${card.warehouse.name}，单位：${m.inventoryUnit}）`],
      ['日期', '单号', '类型', '对象', '变动', '结存', '经办', '备注', '记录时间'],
      ...[...card.moves].reverse().map((mv) => [
        mv.docDate,
        mv.docNo,
        MOVE_TYPE_LABELS[mv.moveType],
        mv.partyName ?? '',
        (mv.qtyDeltaMilli > 0 ? '+' : '') + qtyCell(mv.qtyDeltaMilli),
        qtyCell(mv.qtyAfterMilli),
        mv.operatorName,
        mv.note,
        mv.createdAt,
      ]),
    ]);
    await writeAudit(sql, { staffId: req.actor.id, action: 'export', targetType: 'stock_card', targetId: id, detail: { ...f, warehouseId: card.warehouse.id }, ip: req.ip });
    attachment(reply, `库存卡_${m.code}.csv`, CSV_TYPE);
    return csv;
  });
}
