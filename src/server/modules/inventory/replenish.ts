// 补货建议（v0.7.29 ERP 采购五项④，E4，见 docs/ERP_PURCHASING.md 第 5 节）：只读计算，不写数据。
//
// 只看总仓的受管、在用物料：
//   · 日均用量按「可用天数的用量统计」（默认近 28 天）的领料、直接耗用、报损；
//   · 在途 = 草稿、待确认、已退回修改、已确认的采购单还没收到的数量（补单除外：货已经到了），
//     加上询价中、已定标还没转出采购单的询价单的数量（v0.7.30：从补货建议发起询价，不会重复建议）；
//   · 有用量的：(结存 + 在途) ÷ 日均用量 < 触发天数（物料的提醒天数，没设用规则的补货触发天数）就建议，
//     补到目标天数（规则的补货目标天数；物料的提醒天数不短于它时取提醒天数 + 7）；
//   · 没有用量的：设了低库存提醒数量、结存 + 在途低于它就建议，补到提醒线；
//   · 按采购单位向上取整（换算后不是整库存单位的再多加一包）；单价取最近一次同口径成交价，没有用参考价；
//   · 按物料的默认供应商分组，没设的取最近一次收货的供应商。
// 页面上每组可以改数量、去掉行，用现有的新建采购单接口生成草稿，或者发起询价（v0.7.30）；建好的草稿、询价单都算在途，不会重复建议。

import type { FastifyInstance } from 'fastify';
import { CENTRAL_WAREHOUSE_ID } from '@shared/inventory';
import type { ReplenishGroup, ReplenishLine, ReplenishSuggestions } from '@shared/purchasing';
import { fitsDecimals, lineAmountCents, toBaseQty } from '@shared/quantity';
import { readSnapshot, type Db } from '../../db';
import { guard } from '../../auth/guard';
import type { Deps } from '../../lib/context';
import { loadInventorySettings, priceBaseline, todayIn, usageByMaterial, usageSince } from './common';
import { loadPurchaseRules } from './purchase-rules';

/** 补到目标天数：规则的目标天数；物料的提醒天数不短于它时取提醒天数 + 7 */
export const targetDaysFor = (triggerDays: number, ruleTarget: number) => (triggerDays >= ruleTarget ? triggerDays + 7 : ruleTarget);

/** 需要的库存数量 → 整包装的采购数量（milli）；换算后不是整库存单位的再多加一包，最多试 10 包 */
export function packsFor(needMilli: number, factorMilli: number, decimals: number): { purchaseMilli: number; baseMilli: number } | null {
  let packs = Math.max(1, Math.ceil(needMilli / factorMilli));
  for (let i = 0; i < 10; i++, packs++) {
    const base = toBaseQty(packs * 1000, factorMilli);
    if (base !== null && fitsDecimals(base, decimals)) return { purchaseMilli: packs * 1000, baseMilli: base };
  }
  return null;
}

export async function replenishSuggestions(db: Db, timezone: string): Promise<ReplenishSuggestions> {
  const rules = await loadPurchaseRules(db);
  const settings = await loadInventorySettings(db);
  const today = todayIn(timezone);
  const windowDays = settings.usageWindowDays;
  const used = await usageByMaterial(db, CENTRAL_WAREHOUSE_ID, usageSince(timezone, windowDays));
  const materials = await db<{
    id: number;
    code: string;
    name: string;
    specification: string;
    inventoryUnit: string;
    purchaseUnit: string;
    purchaseFactorMilli: number;
    decimals: number;
    stockMilli: number;
    coverDays: number | null;
    lowStockMilli: number | null;
    refPriceCents: number | null;
    supplierId: number | null;
    supplierName: string | null;
  }[]>`
    SELECT m.id, m.code, m.name, m.specification, m.inventory_unit, m.purchase_unit, m.purchase_factor_milli, m.decimals, m.stock_milli,
           m.cover_days, m.low_stock_milli, m.ref_price_cents,
           coalesce(ds.id, ls.id) AS supplier_id, coalesce(ds.name, ls.name) AS supplier_name
    FROM materials m
    LEFT JOIN suppliers ds ON ds.id = m.default_supplier_id AND ds.active
    LEFT JOIN LATERAL (
      SELECT s.id, s.name FROM inv_docs d JOIN inv_doc_lines l ON l.doc_id = d.id JOIN suppliers s ON s.id = d.supplier_id
      WHERE d.doc_type = 'receipt' AND d.status = 'confirmed' AND l.material_id = m.id AND s.active
      ORDER BY d.doc_date DESC, d.id DESC LIMIT 1
    ) ls ON true
    WHERE m.tracked AND m.active
    ORDER BY m.code`;
  const transit = await db<{ materialId: number; qty: number; docNos: string[] }[]>`
    SELECT x.material_id, sum(x.open_qty)::bigint AS qty, array_agg(DISTINCT x.doc_no ORDER BY x.doc_no) AS doc_nos
    FROM (
      SELECT pl.material_id, po.doc_no,
             greatest(0, pl.base_qty_milli - coalesce((SELECT sum(l.qty_milli) FROM inv_doc_lines l JOIN inv_docs d ON d.id = l.doc_id
                                                        WHERE l.po_line_id = pl.id AND d.status = 'confirmed'), 0)) AS open_qty
      FROM purchase_order_lines pl JOIN purchase_orders po ON po.id = pl.po_id
      WHERE po.status IN ('draft', 'submitted', 'returned', 'approved') AND NOT po.backfill
      UNION ALL
      -- 询价中、已定标还没转出（或转出的采购单已撤回）的询价单：转出采购单以后按采购单算
      SELECT sl.material_id, e.doc_no, sl.base_qty_milli
      FROM sourcing_lines sl JOIN sourcing_events e ON e.id = sl.event_id
      WHERE e.status IN ('open', 'awarded')
        AND NOT EXISTS (SELECT 1 FROM purchase_orders po WHERE po.sourcing_event_id = e.id AND po.status <> 'cancelled')
    ) x
    WHERE x.open_qty > 0
    GROUP BY x.material_id`;
  const transitBy = new Map(transit.map((t) => [Number(t.materialId), { qty: Number(t.qty), docNos: t.docNos }]));

  const groups = new Map<string, ReplenishGroup>();
  let count = 0;
  for (const m of materials) {
    const stock = Number(m.stockMilli);
    const tr = transitBy.get(Number(m.id));
    const inTransit = tr?.qty ?? 0;
    const available = stock + inTransit;
    const usedMilli = used.get(Number(m.id)) ?? 0;
    let reason: ReplenishLine['reason'];
    let needMilli: number;
    let triggerDays: number | null = null;
    let targetDays: number | null = null;
    let daysOfCover: number | null = null;
    const daily = usedMilli > 0 ? usedMilli / Math.max(1, windowDays) : 0;
    if (daily > 0) {
      triggerDays = m.coverDays ?? rules.reorderDays;
      daysOfCover = Math.floor((available / daily) * 10) / 10;
      if (daysOfCover >= triggerDays) continue;
      targetDays = targetDaysFor(triggerDays, rules.targetDays);
      reason = 'cover';
      needMilli = Math.ceil(targetDays * daily) - available;
    } else if (m.lowStockMilli !== null && available < Number(m.lowStockMilli)) {
      reason = 'low_stock';
      needMilli = Number(m.lowStockMilli) - available;
    } else continue;
    if (needMilli <= 0) continue;
    const packs = packsFor(needMilli, Number(m.purchaseFactorMilli), m.decimals);
    if (!packs) continue;
    const base = await priceBaseline(
      db,
      { materialId: Number(m.id), purchaseUnit: m.purchaseUnit, factorMilli: Number(m.purchaseFactorMilli), priceBasis: settings.priceBasis },
      { onOrBefore: today },
    );
    const priceCents = base?.priceCents ?? (m.refPriceCents === null ? null : Number(m.refPriceCents));
    const line: ReplenishLine = {
      materialId: Number(m.id),
      code: m.code,
      name: m.name,
      specification: m.specification,
      inventoryUnit: m.inventoryUnit,
      purchaseUnit: m.purchaseUnit,
      factorMilli: Number(m.purchaseFactorMilli),
      decimals: m.decimals,
      stockMilli: stock,
      inTransitMilli: inTransit,
      openPos: tr?.docNos ?? [],
      dailyUsageMilli: daily > 0 ? Math.round(daily) : null,
      daysOfCover,
      reason,
      triggerDays,
      targetDays,
      lowStockMilli: m.lowStockMilli === null ? null : Number(m.lowStockMilli),
      suggestedPurchaseMilli: packs.purchaseMilli,
      suggestedBaseMilli: packs.baseMilli,
      priceCents,
      priceSource: base ? 'last' : priceCents !== null ? 'ref' : null,
      amountCents: priceCents === null ? null : lineAmountCents(packs.baseMilli, priceCents, Number(m.purchaseFactorMilli)),
    };
    const key = m.supplierId ? String(m.supplierId) : 'none';
    const g = groups.get(key) ?? { supplier: m.supplierId ? { id: Number(m.supplierId), name: m.supplierName ?? '' } : null, lines: [], totalCents: 0 };
    g.lines.push(line);
    g.totalCents += line.amountCents ?? 0;
    groups.set(key, g);
    count += 1;
  }
  const sorted = [...groups.values()].sort((a, b) => (a.supplier === null ? 1 : b.supplier === null ? -1 : a.supplier.name.localeCompare(b.supplier.name, 'zh-CN')));
  return { windowDays, reorderDays: rules.reorderDays, targetDays: rules.targetDays, count, groups: sorted };
}

export function registerReplenishRoutes(app: FastifyInstance, { sql, config }: Deps) {
  app.get('/api/purchase-suggestions', { preHandler: guard('inventory.read') }, async () => readSnapshot(sql, (tx) => replenishSuggestions(tx, config.timezone)));
}
