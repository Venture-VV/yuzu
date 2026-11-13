// 供应商季度评分与观察名单（8.0.7 供应链收尾 2.2，docs/ERP_V807.md）：按季度现算，不另存表。
//   · 准时率：这个季度生效的收货单里（有采购单、不是补单的），收货日不晚于采购单的预计到货日
//     （没填的按下单日 + 采购规则「下单后几天没到货算超期」）的比例；
//   · 合格率：1 −（拒收金额 + 退货金额）÷ 送货金额（送货 = 合格收货 + 拒收；拒收金额 = 拒收数量 × 单价）；
//   · 价格指数：这家的进价 ÷ 同一物料这个季度所有供应商的加权均价（按金额加权；只有这一家供货的物料不计）；
//   · 分数 = 准时率 × 40 + 合格率 × 40 + 价格分 × 20（V4），没有送货的「样本不足」不打分；
//   · 低于观察线（V5，默认 70，「门店基本规则 → 可调的数值」里改）进观察名单：评分页标出、供应商档案显示「观察」、下采购单时提示（不拦）。
// 只读，不加锁。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { quarterOf, quarterRange, recentQuarters, scoreOf, SUPPLIER_ADMISSION_LABELS, type SupplierScore, type SupplierScoreReport } from '@shared/supply';
import type { Db } from '../../db';
import { guardAny } from '../../auth/guard';
import { csvReply, toCsv } from '../../lib/csv';
import type { Deps } from '../../lib/context';
import { todayIn } from '../../lib/dates';
import { badRequest } from '../../lib/errors';
import { parse } from '../../lib/validate';
import { loadSettings } from '../settings';
import { loadPurchaseRules } from './purchase-rules';

const Query = z.object({ quarter: z.string().regex(/^\d{4}Q[1-4]$/, '季度要写成 2026Q4 这样').optional() });

export async function supplierScores(db: Db, quarter: string): Promise<SupplierScoreReport> {
  const range = quarterRange(quarter);
  if (!range) throw badRequest('季度要写成 2026Q4 这样');
  const { from, to } = range;
  const { arrivalOverdueDays } = await loadPurchaseRules(db);
  const { supplierWatchScore } = await loadSettings(db);
  const rows = await db<{
    supplierId: number;
    code: string;
    name: string;
    admission: SupplierScore['admission'];
    receipts: number;
    judged: number;
    onTime: number;
    acceptedCents: string | null;
    rejectedCents: string | null;
    returnedCents: string | null;
    charged: string | null;
    atAvg: string | null;
  }[]>`
    WITH rc AS (
      SELECT d.id, d.supplier_id, d.doc_date, p.id AS po_id, p.backfill, p.expected_date, p.order_date
      FROM inv_docs d LEFT JOIN purchase_orders p ON p.id = d.purchase_order_id
      WHERE d.doc_type = 'receipt' AND d.status = 'confirmed' AND d.doc_date BETWEEN ${from} AND ${to}
    ),
    t AS (
      SELECT supplier_id, count(*)::int AS receipts,
             count(*) FILTER (WHERE po_id IS NOT NULL AND NOT backfill)::int AS judged,
             count(*) FILTER (WHERE po_id IS NOT NULL AND NOT backfill
                                AND doc_date <= coalesce(expected_date, order_date + ${arrivalOverdueDays}::int))::int AS on_time
      FROM rc GROUP BY supplier_id
    ),
    q AS (
      SELECT d.supplier_id,
             sum(coalesce(l.amount_cents, 0)) AS accepted_cents,
             sum(round(coalesce(l.rejected_milli, 0)::numeric * coalesce(l.price_cents, 0) / nullif(l.factor_milli, 0))) AS rejected_cents
      FROM inv_doc_lines l JOIN rc d ON d.id = l.doc_id
      GROUP BY d.supplier_id
    ),
    r AS (
      SELECT supplier_id, sum(abs(amount_cents)) AS returned_cents FROM inv_docs
      WHERE doc_type = 'supplier_return' AND status = 'confirmed' AND doc_date BETWEEN ${from} AND ${to}
      GROUP BY supplier_id
    ),
    lines AS (
      SELECT d.supplier_id, l.material_id, l.amount_cents::numeric AS amount, (l.qty_milli::numeric / nullif(m.purchase_factor_milli, 0)) AS packs
      FROM inv_doc_lines l JOIN rc d ON d.id = l.doc_id JOIN materials m ON m.id = l.material_id
      WHERE l.qty_milli > 0 AND l.amount_cents IS NOT NULL
    ),
    mat AS (
      SELECT material_id, sum(amount) / nullif(sum(packs), 0) AS avg_price, count(DISTINCT supplier_id) AS suppliers
      FROM lines GROUP BY material_id
    ),
    pi AS (
      SELECT l.supplier_id, sum(l.amount) AS charged, sum(l.packs * mat.avg_price) AS at_avg
      FROM lines l JOIN mat ON mat.material_id = l.material_id
      WHERE mat.suppliers >= 2 AND mat.avg_price IS NOT NULL
      GROUP BY l.supplier_id
    )
    SELECT s.id AS supplier_id, s.code, s.name, s.admission,
           coalesce(t.receipts, 0) AS receipts, coalesce(t.judged, 0) AS judged, coalesce(t.on_time, 0) AS on_time,
           q.accepted_cents::text, q.rejected_cents::text, r.returned_cents::text, pi.charged::text, pi.at_avg::text
    FROM suppliers s
    LEFT JOIN t ON t.supplier_id = s.id LEFT JOIN q ON q.supplier_id = s.id LEFT JOIN r ON r.supplier_id = s.id LEFT JOIN pi ON pi.supplier_id = s.id
    WHERE s.active OR t.receipts IS NOT NULL
    ORDER BY s.code`;
  const out: SupplierScore[] = rows.map((r) => {
    const accepted = Math.round(Number(r.acceptedCents ?? 0));
    const rejected = Math.round(Number(r.rejectedCents ?? 0));
    const returned = Math.round(Number(r.returnedCents ?? 0));
    const delivered = accepted + rejected;
    const onTimeBp = r.judged > 0 ? Math.round((r.onTime / r.judged) * 10_000) : null;
    const qualityBp = delivered > 0 ? Math.max(0, Math.round(10_000 - ((rejected + returned) / delivered) * 10_000)) : null;
    const charged = Number(r.charged ?? 0);
    const atAvg = Number(r.atAvg ?? 0);
    const priceIndexBp = atAvg > 0 ? Math.round((charged / atAvg) * 10_000) : null;
    // 样本不足（没有送货）不打分；没有能判断准时的收货（都是急采、补单）按准时算，不扣分
    const scoreX10 = qualityBp === null ? null : scoreOf(onTimeBp ?? 10_000, qualityBp, priceIndexBp);
    return {
      supplierId: Number(r.supplierId),
      code: r.code,
      name: r.name,
      admission: r.admission,
      receipts: r.receipts,
      onTime: r.onTime,
      onTimeBp,
      deliveredCents: delivered,
      rejectedCents: rejected,
      returnedCents: returned,
      qualityBp,
      priceIndexBp,
      scoreX10,
      watch: scoreX10 !== null && scoreX10 < supplierWatchScore * 10,
    };
  });
  // 观察名单在前，再按分数从低到高；样本不足的在最后
  out.sort((a, b) => Number(b.watch) - Number(a.watch) || (a.scoreX10 ?? 10_000) - (b.scoreX10 ?? 10_000) || a.code.localeCompare(b.code));
  return { quarter, from, to, watchBelow: supplierWatchScore, rows: out };
}

/** 上一个完整季度与这个季度里在观察名单上的供应商（供应商档案、下采购单时提示） */
export async function watchList(db: Db, today: string): Promise<{ supplierId: number; quarter: string; scoreX10: number }[]> {
  const out = new Map<number, { supplierId: number; quarter: string; scoreX10: number }>();
  for (const quarter of recentQuarters(today, 2).reverse()) {
    for (const r of (await supplierScores(db, quarter)).rows) {
      if (r.watch && r.scoreX10 !== null) out.set(r.supplierId, { supplierId: r.supplierId, quarter, scoreX10: r.scoreX10 });
      else if (r.scoreX10 !== null) out.delete(r.supplierId); // 这个季度好了的不再提示
    }
  }
  return [...out.values()];
}

const pct = (bp: number | null) => (bp === null ? '' : (bp / 100).toFixed(1));

export function registerScoreRoutes(app: FastifyInstance, { sql, config }: Deps) {
  const readers = guardAny('inventory.read', 'purchase.manage');
  app.get('/api/purchase-compare/scores', { preHandler: readers }, async (req) => {
    const q = parse(Query, req.query);
    return supplierScores(sql, q.quarter ?? quarterOf(todayIn(config.timezone)));
  });
  app.get('/api/purchase-compare/watch', { preHandler: readers }, async () => watchList(sql, todayIn(config.timezone)));
  app.get('/api/purchase-compare/scores/export', { preHandler: readers }, async (req, reply) => {
    const q = parse(Query, req.query);
    const report = await supplierScores(sql, q.quarter ?? quarterOf(todayIn(config.timezone)));
    const csv = toCsv([
      ['季度', '供应商编码', '供应商', '准入', '收货单', '准时', '准时率%', '送货金额', '拒收金额', '退货金额', '合格率%', '价格指数', '分数', '观察名单'],
      ...report.rows.map((r) => [
        report.quarter,
        r.code,
        r.name,
        SUPPLIER_ADMISSION_LABELS[r.admission],
        r.receipts,
        r.onTime,
        pct(r.onTimeBp),
        (r.deliveredCents / 100).toFixed(2),
        (r.rejectedCents / 100).toFixed(2),
        (r.returnedCents / 100).toFixed(2),
        pct(r.qualityBp),
        r.priceIndexBp === null ? '' : (r.priceIndexBp / 10_000).toFixed(3),
        r.scoreX10 === null ? '样本不足' : (r.scoreX10 / 10).toFixed(1),
        r.watch ? '是' : '',
      ]),
    ]);
    return csvReply(reply, `供应商评分_${report.quarter}.csv`, csv);
  });
}
