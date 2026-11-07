// 供应商比价看板（8.0.1 采购组整改 07，CG07，docs/PURCHASING_V801.md）：「采购 → 供应商比价」。
// 按品类或物料、时间段（默认近 90 天），每个物料 × 供应商一行：
//   · 价格：采购次数、数量、最近单价、平均 / 最低 / 最高单价、比上一个同样长的时段涨跌了多少；
//   · 品质：退供应商的数量与退货率；合同验收登记的质量问题数（按供应商）；
//   · 耗用：这段时间这个物料的领用与直接耗用数量。
// 只读、不加锁；单价按物料现在的采购单位折算（收货时的包装换算不一样的也能比）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { COMPARE_DEFAULT_DAYS, type SupplierCompare, type SupplierCompareRow } from '@shared/purchasing';
import { shiftDate } from '@shared/labels';
import { priceChangePercent } from '@shared/quantity';
import { readSnapshot, type Db } from '../../db';
import type { Deps } from '../../lib/context';
import { guardAny } from '../../auth/guard';
import { checkDateRange, daysBetween, todayIn } from '../../lib/dates';
import { dateSchema, parse } from '../../lib/validate';

const Query = z.object({
  from: dateSchema('开始日期').optional(),
  to: dateSchema('结束日期').optional(),
  category: z.string().trim().max(16).optional(),
  materialId: z.coerce.number().int().positive().optional(),
  supplierId: z.coerce.number().int().positive().optional(),
});

export async function supplierCompare(db: Db, timezone: string, raw: unknown): Promise<SupplierCompare> {
  const q = parse(Query, raw);
  const to = q.to ?? todayIn(timezone);
  const from = q.from ?? shiftDate(to, -(COMPARE_DEFAULT_DAYS - 1));
  checkDateRange(from, to);
  const span = daysBetween(from, to) + 1;
  const prevTo = shiftDate(from, -1);
  const prevFrom = shiftDate(prevTo, -(span - 1));
  const matFilter = db`
    ${q.category ? db`AND m.category = ${q.category}` : db``}
    ${q.materialId ? db`AND m.id = ${q.materialId}` : db``}`;
  const supFilter = q.supplierId ? db`AND d.supplier_id = ${q.supplierId}` : db``;
  // 单价折算到物料现在的采购单位：行的单价 × 现在的换算 ÷ 收货时的换算
  const rows = await db<(Omit<SupplierCompareRow, 'changePercent' | 'returnRatePct'> & { prevAvgPriceCents: number | null })[]>`
    WITH lines AS (
      SELECT l.material_id, d.supplier_id, d.id AS doc_id, d.doc_date, l.qty_milli, l.amount_cents,
             (l.price_cents::numeric * m.purchase_factor_milli / nullif(l.factor_milli, 0)) AS unit_price,
             (l.qty_milli::numeric / nullif(m.purchase_factor_milli, 0)) AS packs
      FROM inv_doc_lines l JOIN inv_docs d ON d.id = l.doc_id JOIN materials m ON m.id = l.material_id
      WHERE d.doc_type = 'receipt' AND d.status = 'confirmed' AND l.qty_milli > 0 AND l.price_cents IS NOT NULL
        AND d.doc_date BETWEEN ${prevFrom} AND ${to} ${matFilter} ${supFilter}
    ),
    cur AS (SELECT * FROM lines WHERE doc_date >= ${from}),
    prev AS (SELECT * FROM lines WHERE doc_date < ${from}),
    returns AS (
      SELECT l.material_id, d.supplier_id, sum(l.qty_milli)::bigint AS returned_milli
      FROM inv_doc_lines l JOIN inv_docs d ON d.id = l.doc_id JOIN materials m ON m.id = l.material_id
      WHERE d.doc_type = 'supplier_return' AND d.status = 'confirmed' AND d.doc_date BETWEEN ${from} AND ${to} ${matFilter} ${supFilter}
      GROUP BY l.material_id, d.supplier_id
    )
    SELECT m.id AS material_id, m.code AS material_code, m.name AS material_name, m.category, m.purchase_unit, m.inventory_unit,
           s.id AS supplier_id, s.name AS supplier_name,
           count(DISTINCT c.doc_id)::int AS receipts,
           sum(c.qty_milli)::bigint AS received_milli,
           sum(c.amount_cents)::bigint AS amount_cents,
           (SELECT round(x.unit_price)::bigint FROM cur x WHERE x.material_id = m.id AND x.supplier_id = s.id ORDER BY x.doc_date DESC, x.doc_id DESC LIMIT 1) AS last_price_cents,
           max(c.doc_date)::text AS last_date,
           round(sum(c.amount_cents) / nullif(sum(c.packs), 0))::bigint AS avg_price_cents,
           round(min(c.unit_price))::bigint AS min_price_cents,
           round(max(c.unit_price))::bigint AS max_price_cents,
           (SELECT round(sum(p.amount_cents) / nullif(sum(p.packs), 0))::bigint FROM prev p WHERE p.material_id = m.id AND p.supplier_id = s.id) AS prev_avg_price_cents,
           coalesce((SELECT r.returned_milli FROM returns r WHERE r.material_id = m.id AND r.supplier_id = s.id), 0)::bigint AS returned_milli
    FROM cur c JOIN materials m ON m.id = c.material_id JOIN suppliers s ON s.id = c.supplier_id
    GROUP BY m.id, s.id
    ORDER BY m.category, m.code, avg_price_cents NULLS LAST, s.name
    LIMIT 2000`;
  const out: SupplierCompareRow[] = rows.map((r) => {
    const received = Number(r.receivedMilli);
    const returned = Number(r.returnedMilli);
    const avg = r.avgPriceCents === null ? null : Number(r.avgPriceCents);
    const prev = r.prevAvgPriceCents === null ? null : Number(r.prevAvgPriceCents);
    return {
      ...r,
      materialId: Number(r.materialId),
      supplierId: Number(r.supplierId),
      receivedMilli: received,
      amountCents: Number(r.amountCents),
      lastPriceCents: r.lastPriceCents === null ? null : Number(r.lastPriceCents),
      avgPriceCents: avg,
      minPriceCents: r.minPriceCents === null ? null : Number(r.minPriceCents),
      maxPriceCents: r.maxPriceCents === null ? null : Number(r.maxPriceCents),
      prevAvgPriceCents: prev,
      changePercent: avg !== null && prev !== null ? priceChangePercent(prev, avg) : null,
      returnedMilli: returned,
      returnRatePct: received > 0 ? Math.round((returned / received) * 10000) / 100 : null,
    };
  });
  const supplierIds = [...new Set(out.map((r) => r.supplierId))];
  const materialIds = [...new Set(out.map((r) => r.materialId))];
  const quality = supplierIds.length
    ? await db<{ supplierId: number; issues: number }[]>`
        SELECT c.supplier_id, count(*)::int AS issues FROM contract_quality_issues q JOIN contracts c ON c.id = q.contract_id
        WHERE c.supplier_id IN ${db(supplierIds)} AND q.status <> 'voided' AND q.found_on BETWEEN ${from} AND ${to}
        GROUP BY c.supplier_id`
    : [];
  const consumption = materialIds.length
    ? await db<{ materialId: number; issuedMilli: number; directUsedMilli: number }[]>`
        SELECT l.material_id,
               coalesce(sum(l.qty_milli) FILTER (WHERE d.doc_type = 'issue'), 0)::bigint AS issued_milli,
               coalesce(sum(l.qty_milli) FILTER (WHERE d.doc_type = 'direct_use'), 0)::bigint AS direct_used_milli
        FROM inv_doc_lines l JOIN inv_docs d ON d.id = l.doc_id
        WHERE l.material_id IN ${db(materialIds)} AND d.status = 'confirmed' AND d.doc_type IN ('issue', 'direct_use')
          AND d.doc_date BETWEEN ${from} AND ${to}
        GROUP BY l.material_id`
    : [];
  const categories = (await db<{ category: string }[]>`SELECT DISTINCT category FROM materials WHERE category <> '' ORDER BY category`).map((c) => c.category);
  return {
    from,
    to,
    prevFrom,
    prevTo,
    rows: out,
    quality: quality.map((x) => ({ supplierId: Number(x.supplierId), issues: x.issues })),
    consumption: consumption.map((x) => ({ materialId: Number(x.materialId), issuedMilli: Number(x.issuedMilli), directUsedMilli: Number(x.directUsedMilli) })),
    categories,
  };
}

export function registerCompareRoutes(app: FastifyInstance, { sql, config }: Deps) {
  // 挂在采购的接口前缀下（采购模块关着时一起关，注册表里登记）；有查看库存或编采购单的人都能看
  app.get('/api/purchase-compare', { preHandler: guardAny('inventory.read', 'purchase.manage') }, async (req) =>
    readSnapshot(sql, (tx) => supplierCompare(tx, config.timezone, req.query)),
  );
}
