// 库存查询：库存卡（单物料流水）、期间收发汇总、工作台概览、账实一致性自检。
// 所有汇总只按各物料自己的库存单位统计，不跨单位求和。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { INV_DOC_META, MOVE_TYPE_LABELS, type CheckItem, type InventoryOverview, type StockMoveRow, type StockSummaryRow } from '@shared/inventory';
import { formatQty } from '@shared/quantity';
import { readSnapshot, type Db } from '../../db';
import { guard } from '../../auth/guard';
import { writeAudit } from '../../lib/audit';
import type { Deps } from '../../lib/context';
import { toCsv } from '../../lib/csv';
import { badRequest } from '../../lib/errors';
import { idParam, parse } from '../../lib/validate';
import { docDateSchema, loadInventorySettings, todayIn } from './common';
import { getMaterial } from './master';

export async function stockCard(db: Db, materialId: number, f: { from?: string; to?: string; limit?: number } = {}) {
  const material = await getMaterial(db, materialId);
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
    WHERE sm.material_id = ${materialId}
      ${f.from ? db`AND sm.doc_date >= ${f.from}` : db``}
      ${f.to ? db`AND sm.doc_date <= ${f.to}` : db``}
    ORDER BY sm.id DESC
    LIMIT ${f.limit ?? 500}`;
  // 未生效的单据不影响库存，单独列出便于员工知道「还有什么在路上」
  const pending = await db<{ id: number; docNo: string; docType: keyof typeof INV_DOC_META; status: string; docDate: string; qtyMilli: number }[]>`
    SELECT d.id, d.doc_no, d.doc_type, d.status, d.doc_date, l.qty_milli
    FROM inv_doc_lines l JOIN inv_docs d ON d.id = l.doc_id
    WHERE l.material_id = ${materialId} AND d.status IN ('draft', 'submitted', 'returned')
    ORDER BY d.id DESC LIMIT 20`;
  return { material, moves, pending };
}

/**
 * 期间收发汇总：期初结存 + 本期各类变动 = 期末结存。
 * 出库类（领用、耗用、报损、退供应商）显示为正数；盘点调整与冲销保留正负号。
 */
export async function stockSummary(db: Db, from: string, to: string): Promise<StockSummaryRow[]> {
  if (from > to) throw badRequest('开始日期不能晚于结束日期');
  return db<StockSummaryRow[]>`
    SELECT m.id AS material_id, m.code, m.name, m.specification, m.inventory_unit, m.active,
           coalesce(sum(sm.qty_delta_milli) FILTER (WHERE sm.doc_date < ${from}), 0) AS begin,
           coalesce(sum(sm.qty_delta_milli) FILTER (WHERE sm.doc_date BETWEEN ${from} AND ${to} AND sm.move_type = 'opening'), 0) AS opening,
           coalesce(sum(sm.qty_delta_milli) FILTER (WHERE sm.doc_date BETWEEN ${from} AND ${to} AND sm.move_type = 'receipt'), 0) AS received,
           -coalesce(sum(sm.qty_delta_milli) FILTER (WHERE sm.doc_date BETWEEN ${from} AND ${to} AND sm.move_type = 'issue'), 0) AS issued,
           coalesce(sum(sm.qty_delta_milli) FILTER (WHERE sm.doc_date BETWEEN ${from} AND ${to} AND sm.move_type = 'issue_return'), 0) AS issue_returned,
           -coalesce(sum(sm.qty_delta_milli) FILTER (WHERE sm.doc_date BETWEEN ${from} AND ${to} AND sm.move_type = 'direct_use'), 0) AS direct_used,
           -coalesce(sum(sm.qty_delta_milli) FILTER (WHERE sm.doc_date BETWEEN ${from} AND ${to} AND sm.move_type = 'damage'), 0) AS damaged,
           coalesce(sum(sm.qty_delta_milli) FILTER (WHERE sm.doc_date BETWEEN ${from} AND ${to} AND sm.move_type = 'count_adjust'), 0) AS count_adjusted,
           -coalesce(sum(sm.qty_delta_milli) FILTER (WHERE sm.doc_date BETWEEN ${from} AND ${to} AND sm.move_type = 'supplier_return'), 0) AS supplier_returned,
           coalesce(sum(sm.qty_delta_milli) FILTER (WHERE sm.doc_date BETWEEN ${from} AND ${to} AND sm.move_type = 'void'), 0) AS voided,
           coalesce(sum(sm.qty_delta_milli) FILTER (WHERE sm.doc_date <= ${to}), 0) AS closing
    FROM materials m LEFT JOIN stock_moves sm ON sm.material_id = m.id
    WHERE m.tracked
    GROUP BY m.id ORDER BY m.code`;
}

export async function inventoryOverview(db: Db, timeZone: string): Promise<InventoryOverview> {
  const settings = await loadInventorySettings(db);
  const today = todayIn(timeZone);
  const [row] = await db<Omit<InventoryOverview, 'scopeName'>[]>`
    SELECT
      (SELECT count(*) FROM materials WHERE tracked AND active) AS material_count,
      (SELECT count(*) FROM materials WHERE tracked AND active AND low_stock_milli IS NOT NULL AND stock_milli < low_stock_milli) AS low_count,
      (SELECT count(*) FROM inv_docs WHERE doc_type = 'count' AND status IN ('draft', 'submitted', 'returned')) AS pending_counts,
      (SELECT count(*) FROM inv_docs WHERE status = 'submitted') AS pending_approvals,
      (SELECT count(DISTINCT doc_id) FROM stock_moves WHERE doc_date = ${today} AND qty_delta_milli > 0 AND move_type <> 'void') AS today_in,
      (SELECT count(DISTINCT doc_id) FROM stock_moves WHERE doc_date = ${today} AND qty_delta_milli < 0 AND move_type <> 'void') AS today_out`;
  return { scopeName: settings.scopeName, ...row! };
}

/**
 * 账实自检：结存 = 流水合计 = 最后一条流水的结存；流水链连续；生效单据都有流水。
 * 用于工作台「数据自检」和测试断言，正常情况下全部通过。
 */
export async function inventoryChecks(db: Db): Promise<CheckItem[]> {
  const items: CheckItem[] = [];
  const mismatch = await db<{ name: string; stockMilli: number; sumMilli: number }[]>`
    SELECT m.name, m.stock_milli, coalesce(sum(sm.qty_delta_milli), 0) AS sum_milli
    FROM materials m LEFT JOIN stock_moves sm ON sm.material_id = m.id
    GROUP BY m.id HAVING m.stock_milli <> coalesce(sum(sm.qty_delta_milli), 0)`;
  items.push({
    key: 'stock_equals_moves',
    label: '结存与流水合计一致',
    ok: mismatch.length === 0,
    detail: mismatch.length ? mismatch.map((m) => `${m.name}：结存 ${formatQty(m.stockMilli)}，流水 ${formatQty(m.sumMilli)}`).join('；') : '全部物料一致',
  });

  const lastMismatch = await db<{ name: string }[]>`
    SELECT m.name FROM materials m
    WHERE m.last_move_id IS DISTINCT FROM (SELECT max(id) FROM stock_moves WHERE material_id = m.id)
       OR m.stock_milli <> coalesce((SELECT qty_after_milli FROM stock_moves WHERE id = m.last_move_id), 0)`;
  items.push({
    key: 'last_move',
    label: '结存与最后一条流水一致',
    ok: lastMismatch.length === 0,
    detail: lastMismatch.length ? lastMismatch.map((m) => m.name).join('、') : '全部物料一致',
  });

  const broken = await db<{ name: string; count: number }[]>`
    SELECT m.name, count(*) AS count FROM (
      SELECT material_id, qty_after_milli, qty_delta_milli,
             lag(qty_after_milli, 1, 0::bigint) OVER (PARTITION BY material_id ORDER BY id) AS prev_after
      FROM stock_moves) x JOIN materials m ON m.id = x.material_id
    WHERE x.prev_after + x.qty_delta_milli <> x.qty_after_milli
    GROUP BY m.name`;
  items.push({
    key: 'move_chain',
    label: '流水逐笔连续（上一笔结存 + 本笔变动 = 本笔结存）',
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

  const voidNet = await db<{ docNo: string }[]>`
    SELECT d.doc_no FROM inv_docs d JOIN stock_moves sm ON sm.doc_id = d.id
    WHERE d.status = 'voided' GROUP BY d.id HAVING sum(sm.qty_delta_milli) <> 0`;
  items.push({
    key: 'void_net_zero',
    label: '已冲销单据对库存的净影响为 0',
    ok: voidNet.length === 0,
    detail: voidNet.length ? voidNet.map((o) => o.docNo).join('、') : '一致',
  });
  return items;
}

// ───────────────────────── 路由 ─────────────────────────

const RangeQuery = z.object({ from: docDateSchema, to: docDateSchema });

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
    const f = parse(z.object({ from: docDateSchema.optional(), to: docDateSchema.optional() }), req.query);
    return readSnapshot(sql, (tx) => stockCard(tx, id, f));
  });

  app.get('/api/inventory/summary', { preHandler: guard('inventory.read') }, async (req) => {
    const { from, to } = parse(RangeQuery, req.query);
    return readSnapshot(sql, (tx) => stockSummary(tx, from, to));
  });

  app.get('/api/inventory/checks', { preHandler: guard('inventory.read') }, async () => readSnapshot(sql, inventoryChecks));

  app.get('/api/inventory/summary/export', { preHandler: guard('inventory.read') }, async (req, reply) => {
    const { from, to } = parse(RangeQuery, req.query);
    const rows = await readSnapshot(sql, (tx) => stockSummary(tx, from, to));
    const scope = (await loadInventorySettings(sql)).scopeName;
    const head = ['物料编码', '物料名称', '规格', '库存单位', '期初结存', '期初建账', '收货入库', '部门领用', '领用退回', '直接耗用', '报损', '盘点调整', '退供应商', '冲销', '期末结存'];
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
    await writeAudit(sql, { staffId: req.actor.id, action: 'export', targetType: 'inventory_summary', detail: { from, to }, ip: req.ip });
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`收发汇总_${from}_${to}.csv`)}`);
    return csv;
  });

  app.get('/api/inventory/materials/:id/card/export', { preHandler: guard('inventory.read') }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const f = parse(z.object({ from: docDateSchema.optional(), to: docDateSchema.optional() }), req.query);
    const card = await readSnapshot(sql, (tx) => stockCard(tx, id, { ...f, limit: 100_000 }));
    const m = card.material;
    const csv = toCsv([
      [`库存卡 ${m.code} ${m.name} ${m.specification}（单位：${m.inventoryUnit}）`],
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
    await writeAudit(sql, { staffId: req.actor.id, action: 'export', targetType: 'stock_card', targetId: id, detail: f, ip: req.ip });
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`库存卡_${m.code}.csv`)}`);
    return csv;
  });
}
