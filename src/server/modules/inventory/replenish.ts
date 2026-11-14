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
//
// 补货方式（店主 2026-11-14，迁移 161，第 5.1 节，E9–E12）：原来所有受管物料都当成要备货的，手机这类部门提了需求才买的东西，
// 领走以后近 28 天都有「用量」、总仓会一直出建议。现在按物料的补货方式过滤（replenishSkipWhy）：
//   · 按需采购的不提；常备的一直提；
//   · 自动识别的：设了提醒天数或提醒数量的照常；档案里标明是消耗品的（台面日耗品、管效期、称重）照常；
//     建过资产卡片的不提；近 90 天有领用的天数不到「常用天数」的看作一次性采购、不提。
// 本来会提、识别为不用补的放在 skipped 里（带原因），不进 groups、不算进 count——按 groups 建草稿的（页面、8.0.20 的自动补货）都不会带上它们。

import type { FastifyInstance } from 'fastify';
import { CENTRAL_WAREHOUSE_ID, type ReplenishMode } from '@shared/inventory';
import { REPLENISH_LOOKBACK_DAYS, replenishSkipWhy, type ReplenishGroup, type ReplenishLine, type ReplenishSkipped, type ReplenishSuggestions } from '@shared/purchasing';
import { fitsDecimals, lineAmountCents, toBaseQty } from '@shared/quantity';
import { readSnapshot, type Db } from '../../db';
import { guard } from '../../auth/guard';
import type { Deps } from '../../lib/context';
import { loadInventorySettings, priceBaseline, todayIn, usageByMaterial, usageDaysByMaterial, usageSince } from './common';
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
    replenishMode: ReplenishMode;
    replenishRev: number;
    consumable: boolean;
    assetNo: string | null;
    assetCount: number;
    refPriceCents: number | null;
    supplierId: number | null;
    supplierName: string | null;
  }[]>`
    SELECT m.id, m.code, m.name, m.specification, m.inventory_unit, m.purchase_unit, m.purchase_factor_milli, m.decimals, m.stock_milli,
           m.cover_days, m.low_stock_milli, m.replenish_mode, m.replenish_rev, m.ref_price_cents,
           -- 档案里已经标明是消耗品的（自动识别时算常备，头一次领用就提）：台面日耗品、管效期的、称重的。
           -- 别的「明摆着是消耗品」的信号接在这里——8.0.20 的用料与配方合进来以后，挂了在用用料的物料也算
           --（零售品、菜品原料：第一天就卖断货的话，后面的扣料都欠着、不会再有第二天的用量）。
           (m.counter_use OR m.expiry_tracked OR m.weighed) AS consumable,
           ac.asset_no, coalesce(ac.n, 0) AS asset_count,
           coalesce(ds.id, ls.id) AS supplier_id, coalesce(ds.name, ls.name) AS supplier_name
    FROM materials m
    -- 建过资产卡片的（从收货单「转资产建卡」）：按资产管，自动识别时不提补货
    LEFT JOIN (SELECT material_id, min(asset_no) AS asset_no, count(*)::int AS n FROM asset_cards WHERE material_id IS NOT NULL GROUP BY material_id) ac
      ON ac.material_id = m.id
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
  // 自动识别：近 90 天里有领用的天数（日均用量照旧按上面的统计天数）
  const useDays = await usageDaysByMaterial(db, usageSince(timezone, REPLENISH_LOOKBACK_DAYS));

  const groups = new Map<string, ReplenishGroup>();
  const skipped: ReplenishSkipped[] = [];
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
    // 补货方式（第 5.1 节）：本来会提、识别为不用补的只列出来，不建议
    const use = useDays.get(Number(m.id));
    const why = replenishSkipWhy(
      {
        replenishMode: m.replenishMode,
        coverDays: m.coverDays,
        lowStockMilli: m.lowStockMilli === null ? null : Number(m.lowStockMilli),
        consumable: m.consumable,
        hasAsset: m.assetCount > 0,
        useDays: use?.days ?? 0,
      },
      rules.regularUseDays,
    );
    if (why) {
      skipped.push({
        materialId: Number(m.id),
        code: m.code,
        name: m.name,
        specification: m.specification,
        inventoryUnit: m.inventoryUnit,
        stockMilli: stock,
        inTransitMilli: inTransit,
        mode: m.replenishMode,
        modeRev: m.replenishRev,
        why,
        useDays: use?.days ?? 0,
        lastUsedOn: use?.lastOn ?? null,
        assetNo: m.assetNo,
        assetCount: m.assetCount,
      });
      continue;
    }
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
      mode: m.replenishMode,
      modeRev: m.replenishRev,
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
  return {
    windowDays,
    reorderDays: rules.reorderDays,
    targetDays: rules.targetDays,
    regularUseDays: rules.regularUseDays,
    lookbackDays: REPLENISH_LOOKBACK_DAYS,
    count,
    groups: sorted,
    skipped,
  };
}

export function registerReplenishRoutes(app: FastifyInstance, { sql, config }: Deps) {
  app.get('/api/purchase-suggestions', { preHandler: guard('inventory.read') }, async () => readSnapshot(sql, (tx) => replenishSuggestions(tx, config.timezone)));
}
