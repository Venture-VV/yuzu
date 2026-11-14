// 8.0.20 成本报表（docs/ERP_V8020.md 第 1 节，JX-C）：库存金额、部门耗用成本、项目毛利。只读，不加锁。
//
// · 库存金额 = 全公司结存 × 现在的平均成本（移动加权平均，含税到货价）；成本是估的会标出来。
// · 耗用成本 = 日期段内耗用、报损流水记下的金额（作废的按作废那天反向记，自然抵掉）；自动扣料的单按批次分成「销售出库」「配方耗用」。
//   8.0.20 之前的流水没记成本，单列条数。
// · 项目毛利 = 日期段内有效结账单上的数量与金额 × 这个项目现在的用料按现在的平均成本算的理论成本——是理论值，不是当时真实耗用。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CostReport, MarginRow, StockValueRow, UsageCostRow } from '@shared/stock-usage';
import { guard } from '../../auth/guard';
import { readSnapshot, type Db } from '../../db';
import type { Deps } from '../../lib/context';
import { csvReply, toCsv } from '../../lib/csv';
import { checkDateRange } from '../../lib/dates';
import { parse } from '../../lib/validate';
import { moveCostCents, todayIn } from './common';

const Range = z.object({ from: z.string().optional(), to: z.string().optional() });

/**
 * 还没有进出过的物料没有平均成本：按参考价起算（与入库时的起算一样）。
 * 「还没有成本」= 平均成本是 0 而且还是估的；按进价收过货、平均成本真的是 0（赠送、零元进货）的就是 0，不拿参考价顶（合并前 Codex 审查 b850838）。
 */
export const effectiveCost = (db: Db) => db`
  (CASE WHEN m.avg_cost_e4 > 0 OR NOT m.cost_estimated THEN m.avg_cost_e4
        WHEN m.ref_price_cents IS NOT NULL AND m.purchase_factor_milli > 0 THEN round(m.ref_price_cents::numeric * 10000000 / m.purchase_factor_milli)
        ELSE 0 END)::bigint`;

export async function costReport(db: Db, timezone: string, raw: unknown): Promise<CostReport> {
  const today = todayIn(timezone);
  const q = parse(Range, raw ?? {});
  const from = q.from ?? `${today.slice(0, 8)}01`;
  const to = q.to ?? today;
  checkDateRange(from, to);

  const stockRows = await db<{ id: number; code: string; name: string; inventoryUnit: string; central: number; total: number; cost: number; estimated: boolean }[]>`
    SELECT m.id, m.code, m.name, m.inventory_unit, m.stock_milli AS central,
           (m.stock_milli + COALESCE((SELECT sum(ws.stock_milli) FROM warehouse_stock ws WHERE ws.material_id = m.id), 0))::bigint AS total,
           ${effectiveCost(db)} AS cost, m.cost_estimated AS estimated
    FROM materials m WHERE m.tracked ORDER BY m.code`;
  const stock: StockValueRow[] = stockRows
    .filter((r) => Number(r.total) > 0)
    .map((r) => ({
      materialId: Number(r.id),
      code: r.code,
      name: r.name,
      inventoryUnit: r.inventoryUnit,
      stockMilli: Number(r.total),
      centralMilli: Number(r.central),
      avgCostE4: Number(r.cost),
      estimated: r.estimated,
      valueCents: moveCostCents(Number(r.total), Number(r.cost)),
    }));

  const usageRows = await db<{ warehouseName: string; label: string; cost: number; moves: number; uncosted: number }[]>`
    SELECT COALESCE(dp.name, '总仓') AS warehouse_name,
           (CASE WHEN b.kind = 'sale' THEN '销售出库' WHEN b.kind = 'recipe' THEN '配方耗用' WHEN d.doc_type = 'damage' THEN '报损' ELSE '耗用' END) AS label,
           COALESCE(sum(-sm.cost_cents), 0)::bigint AS cost, count(*)::int AS moves, count(*) FILTER (WHERE sm.cost_cents IS NULL)::int AS uncosted
    FROM stock_moves sm JOIN inv_docs d ON d.id = sm.doc_id
    LEFT JOIN stock_usage_batches b ON b.inv_doc_id = d.id
    LEFT JOIN warehouses w ON w.id = sm.warehouse_id LEFT JOIN departments dp ON dp.id = w.department_id
    -- 按流水认，不按单据类型认（合并前 Codex 审查 b850838）：台面日耗品领到部门、急采进部门小仓时，在领料单 / 收货单下面接着记一笔「耗用」流水，
    -- 只看耗用单、报损单会把它们漏掉。作废冲回的那一笔流水类型是 void：同一张单、同一行、同一个仓里冲的是耗用 / 报损的才算（数量为正的那一笔；
    -- 同一行里冲调入、冲收货的是负的，不算）。
    WHERE (sm.move_type IN ('direct_use', 'damage')
           OR (sm.move_type = 'void' AND sm.qty_delta_milli > 0 AND EXISTS (
                 SELECT 1 FROM stock_moves o
                 WHERE o.doc_id = sm.doc_id AND o.doc_line_id = sm.doc_line_id AND o.warehouse_id = sm.warehouse_id AND o.material_id = sm.material_id
                   AND o.move_type IN ('direct_use', 'damage'))))
      AND sm.doc_date BETWEEN ${from} AND ${to}
    GROUP BY 1, 2 ORDER BY 1, 2`;
  const usage: UsageCostRow[] = usageRows.map((r) => ({ warehouseName: r.warehouseName, label: r.label, costCents: Number(r.cost), moves: r.moves, uncosted: r.uncosted }));

  const sold = await db<{ id: number; name: string; category: string; quantity: number; revenue: number; recipeId: number | null }[]>`
    SELECT i.id, i.name, i.category, sum(l.quantity)::int AS quantity, sum(l.amount)::bigint AS revenue, r.id AS recipe_id
    FROM checkouts c JOIN checkout_bills cb ON cb.checkout_id = c.id
    JOIN bill_lines l ON l.bill_id = cb.bill_id AND l.status = 'active' AND l.item_id IS NOT NULL
    JOIN service_items i ON i.id = l.item_id
    LEFT JOIN item_recipes r ON r.item_id = i.id AND r.status = 'active'
    WHERE c.status = 'completed' AND c.business_date BETWEEN ${from} AND ${to}
    GROUP BY i.id, i.name, i.category, r.id ORDER BY sum(l.amount) DESC, i.id`;
  const recipeIds = sold.map((s) => s.recipeId).filter((x): x is number => x !== null);
  type RL = { recipeId: number; qtyMilli: number; lossBp: number; cost: number };
  const recipeLines: RL[] = recipeIds.length
    ? await db<RL[]>`
        SELECT l.recipe_id, l.qty_milli, l.loss_bp, ${effectiveCost(db)} AS cost
        FROM item_recipe_lines l JOIN materials m ON m.id = l.material_id WHERE l.recipe_id IN ${db(recipeIds)}`
    : [];
  const unitCost = new Map<number, number | null>();
  for (const id of recipeIds) {
    const own = recipeLines.filter((l) => Number(l.recipeId) === Number(id));
    unitCost.set(
      Number(id),
      own.length > 0 && own.every((l) => Number(l.cost) > 0) ? own.reduce((sum, l) => sum + moveCostCents(Math.ceil((Number(l.qtyMilli) * (10000 + l.lossBp)) / 10000), Number(l.cost)), 0) : null,
    );
  }
  const margin: MarginRow[] = sold.map((s) => {
    const unit = s.recipeId === null ? null : (unitCost.get(Number(s.recipeId)) ?? null);
    const cost = unit === null ? null : unit * s.quantity;
    return { itemId: Number(s.id), itemName: s.name, category: s.category, quantity: s.quantity, revenueCents: Number(s.revenue), unitCostCents: unit, costCents: cost, marginCents: cost === null ? null : Number(s.revenue) - cost };
  });

  return {
    from,
    to,
    stock: { rows: stock, totalCents: stock.reduce((a, r) => a + r.valueCents, 0), estimatedCount: stock.filter((r) => r.estimated).length },
    usage: { rows: usage, totalCents: usage.reduce((a, r) => a + r.costCents, 0) },
    margin: { rows: margin, revenueCents: margin.reduce((a, r) => a + r.revenueCents, 0), costCents: margin.reduce((a, r) => a + (r.costCents ?? 0), 0) },
  };
}

const yuan = (cents: number | null) => (cents === null ? '' : (cents / 100).toFixed(2));

export function registerCostRoutes(app: FastifyInstance, deps: Deps) {
  const { sql, config } = deps;
  app.get('/api/inventory/cost', { preHandler: guard('inventory.cost') }, async (req) => readSnapshot(sql, (tx) => costReport(tx, config.timezone, req.query)));
  app.get('/api/inventory/cost/export', { preHandler: guard('inventory.cost') }, async (req, reply) => {
    const r = await readSnapshot(sql, (tx) => costReport(tx, config.timezone, req.query));
    const rows: (string | number)[][] = [
      ['库存金额', `截至 ${todayIn(config.timezone)}`],
      ['物料编号', '物料', '单位', '结存', '平均成本（元）', '是否估算', '金额（元）'],
      ...r.stock.rows.map((x) => [x.code, x.name, x.inventoryUnit, x.stockMilli / 1000, (x.avgCostE4 / 1_000_000).toFixed(4), x.estimated ? '估算' : '', yuan(x.valueCents)]),
      [],
      ['耗用成本', `${r.from} 至 ${r.to}`],
      ['仓', '类别', '金额（元）', '流水条数', '没记成本的条数'],
      ...r.usage.rows.map((x) => [x.warehouseName, x.label, yuan(x.costCents), x.moves, x.uncosted]),
      [],
      ['项目毛利（理论成本）', `${r.from} 至 ${r.to}`],
      ['项目', '分类', '数量', '销售额（元）', '单份理论成本（元）', '理论成本（元）', '毛利（元）'],
      ...r.margin.rows.map((x) => [x.itemName, x.category, x.quantity, yuan(x.revenueCents), yuan(x.unitCostCents), yuan(x.costCents), yuan(x.marginCents)]),
    ];
    return csvReply(reply, `成本_${r.from}_${r.to}.csv`, toCsv(rows));
  });
}
