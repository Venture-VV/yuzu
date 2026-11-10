// 呆滞与周转（8.0.7 供应链收尾 2.4，docs/ERP_V807.md）：按仓（总仓 / 各部门小仓）看每种有结存的物料：
// 结存、最近一次出库日、多少天没出库、结存金额（按最近一次收货价，没有按参考价）、近 90 天日均用量、周转天数（结存 ÷ 日均用量）。
// 有结存、超过 N 天（V7，默认 90，「经营规则 → 可调的数值」里改）没出库的算呆滞，标出、能导出，ERP 待办显示件数。
// 怎么处理照旧用现有单据（退供应商、报损、领料退回；V8：只提醒，不自动处理）。只读，不加锁。
//   · 出库 = 领料、领料退回（部门小仓退回总仓）、耗用、报损、退供应商的流水（数量减少的）；盘点调整、冲销不算；
//   · 从没出过库的，从第一次入库算起。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SlowMovingReport, SlowMovingRow } from '@shared/supply';
import type { Db } from '../../db';
import { guard } from '../../auth/guard';
import { csvReply, toCsv } from '../../lib/csv';
import type { Deps } from '../../lib/context';
import { daysBetween, todayIn } from '../../lib/dates';
import { parse } from '../../lib/validate';
import { loadSettings } from '../settings';

/** 日均用量按近 90 天算 */
export const USAGE_DAYS = 90;

const Query = z.object({
  /** 1 = 总仓；部门小仓的仓编号；不填 = 全部 */
  warehouseId: z.coerce.number().int().positive().optional(),
  /** 1 = 只看呆滞的 */
  slow: z.enum(['1']).optional(),
});

export async function slowMovingReport(db: Db, today: string, raw: unknown = {}): Promise<SlowMovingReport> {
  const q = parse(Query, raw);
  const { slowMovingDays } = await loadSettings(db);
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - (USAGE_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  const rows = await db<{
    materialId: number;
    code: string;
    name: string;
    specification: string;
    inventoryUnit: string;
    decimals: number;
    warehouseId: number;
    departmentId: number | null;
    warehouseName: string;
    stockMilli: string;
    perMilli: string | null;
    lastOutDate: string | null;
    firstInDate: string | null;
    usedMilli: string | null;
  }[]>`
    WITH stocks AS (
      SELECT m.id AS material_id, 1::bigint AS warehouse_id, NULL::bigint AS department_id, m.stock_milli
      FROM materials m WHERE m.tracked AND m.stock_milli > 0
      UNION ALL
      SELECT ws.material_id, ws.warehouse_id, w.department_id, ws.stock_milli
      FROM warehouse_stock ws JOIN warehouses w ON w.id = ws.warehouse_id
      WHERE ws.stock_milli > 0
    ),
    picked AS (
      SELECT * FROM stocks ${q.warehouseId ? db`WHERE warehouse_id = ${q.warehouseId}` : db``}
    ),
    -- 冲销了的单据不算（冲销留着原来的流水、另记一笔 void 抵回，这里按单据的状态整张排除；Codex 审查 9ad0f56）
    outs AS (
      SELECT sm.warehouse_id, sm.material_id, max(sm.doc_date) AS last_out,
             coalesce(sum(-sm.qty_delta_milli) FILTER (WHERE sm.doc_date >= ${since}::date), 0) AS used_milli
      FROM stock_moves sm JOIN inv_docs d ON d.id = sm.doc_id
      WHERE sm.qty_delta_milli < 0 AND sm.move_type IN ('issue', 'issue_return', 'direct_use', 'damage', 'supplier_return') AND d.status <> 'voided'
        AND (sm.warehouse_id, sm.material_id) IN (SELECT warehouse_id, material_id FROM picked)
      GROUP BY sm.warehouse_id, sm.material_id
    ),
    ins AS (
      SELECT sm.warehouse_id, sm.material_id, min(sm.doc_date) AS first_in
      FROM stock_moves sm JOIN inv_docs d ON d.id = sm.doc_id
      WHERE sm.qty_delta_milli > 0 AND sm.move_type <> 'void' AND d.status <> 'voided'
        AND (sm.warehouse_id, sm.material_id) IN (SELECT warehouse_id, material_id FROM picked)
      GROUP BY sm.warehouse_id, sm.material_id
    ),
    last_price AS (
      SELECT DISTINCT ON (l.material_id) l.material_id, l.price_cents::numeric / l.factor_milli AS per_milli
      FROM inv_doc_lines l JOIN inv_docs d ON d.id = l.doc_id
      WHERE d.doc_type = 'receipt' AND d.status = 'confirmed' AND l.price_cents IS NOT NULL AND l.qty_milli > 0
        AND l.material_id IN (SELECT material_id FROM picked)
      ORDER BY l.material_id, d.doc_date DESC, d.id DESC
    )
    SELECT m.id AS material_id, m.code, m.name, m.specification, m.inventory_unit, m.decimals,
           p.warehouse_id, p.department_id,
           CASE WHEN p.department_id IS NULL THEN '总仓' ELSE dep.name || '小仓' END AS warehouse_name,
           p.stock_milli::text,
           coalesce(lp.per_milli, m.ref_price_cents::numeric / nullif(m.purchase_factor_milli, 0))::text AS per_milli,
           o.last_out::text AS last_out_date, i.first_in::text AS first_in_date, o.used_milli::text
    FROM picked p JOIN materials m ON m.id = p.material_id
    LEFT JOIN departments dep ON dep.id = p.department_id
    LEFT JOIN outs o ON o.warehouse_id = p.warehouse_id AND o.material_id = p.material_id
    LEFT JOIN ins i ON i.warehouse_id = p.warehouse_id AND i.material_id = p.material_id
    LEFT JOIN last_price lp ON lp.material_id = p.material_id
    ORDER BY p.department_id NULLS FIRST, m.code`;
  const out: SlowMovingRow[] = rows.map((r) => {
    const stock = Number(r.stockMilli);
    const since0 = r.lastOutDate ?? r.firstInDate;
    const idleDays = since0 ? daysBetween(since0, today) : null;
    const daily = Math.round(Number(r.usedMilli ?? 0) / USAGE_DAYS);
    return {
      materialId: Number(r.materialId),
      code: r.code,
      name: r.name,
      specification: r.specification,
      inventoryUnit: r.inventoryUnit,
      decimals: r.decimals,
      departmentId: r.departmentId === null ? null : Number(r.departmentId),
      warehouseName: r.warehouseName,
      stockMilli: stock,
      amountCents: r.perMilli === null ? null : Math.round(Number(r.perMilli) * stock),
      lastOutDate: r.lastOutDate,
      idleDays,
      dailyUsageMilli: daily,
      turnoverDays: daily > 0 ? Math.round(stock / daily) : null,
      slow: idleDays !== null && idleDays > slowMovingDays,
    };
  });
  return { slowDays: slowMovingDays, rows: q.slow === '1' ? out.filter((r) => r.slow) : out };
}

export async function slowMovingCount(db: Db, today: string): Promise<number> {
  return (await slowMovingReport(db, today, { slow: '1' })).rows.length;
}

export function registerSlowRoutes(app: FastifyInstance, { sql, config }: Deps) {
  const today = () => todayIn(config.timezone);
  app.get('/api/inventory/slow-moving', { preHandler: guard('inventory.read') }, async (req) => slowMovingReport(sql, today(), req.query));
  app.get('/api/inventory/slow-moving/export', { preHandler: guard('inventory.read') }, async (req, reply) => {
    const r = await slowMovingReport(sql, today(), req.query);
    const qty = (milli: number, decimals: number) => (milli / 1000).toFixed(decimals);
    const csv = toCsv([
      ['仓', '物料编码', '物料', '规格', '单位', '结存', '结存金额', '最近出库日', '多少天没出库', '近90天日均用量', '周转天数', '呆滞'],
      ...r.rows.map((x) => [
        x.warehouseName,
        x.code,
        x.name,
        x.specification,
        x.inventoryUnit,
        qty(x.stockMilli, x.decimals),
        x.amountCents === null ? '' : (x.amountCents / 100).toFixed(2),
        x.lastOutDate ?? '没出过库',
        x.idleDays ?? '',
        qty(x.dailyUsageMilli, Math.max(x.decimals, 2)),
        x.turnoverDays ?? '',
        x.slow ? `是（超过 ${r.slowDays} 天）` : '',
      ]),
    ]);
    return csvReply(reply, `呆滞与周转_${today()}.csv`, csv);
  });
}
