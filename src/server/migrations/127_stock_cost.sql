-- 8.0.20 成本核算（docs/ERP_V8020.md 第 1 节，JX-C / JX4）：移动加权平均，含税到货价，按物料全公司一个成本。
--
--   · materials.avg_cost_e4：每个库存单位的平均成本，单位「万分之一分」（1 元 / 件 = 1,000,000）；
--     cost_estimated：成本是估的（下面按最近一次进价、没有进价按参考价回填），第一次真的入库重算后变成否。
--   · stock_moves.unit_cost_e4、cost_cents：这一笔流水当时的单位成本与金额（出库为负）。升级前的流水这两列是空的
--     （没法回头算当时的平均成本），报表里写「没记成本」。stock_moves 只增不改的规矩不变：只在写入时带上。
-- 只加列与回填物料的起算成本；数量、单据、应付都不动。

ALTER TABLE materials
  ADD COLUMN avg_cost_e4 bigint NOT NULL DEFAULT 0 CHECK (avg_cost_e4 >= 0),
  ADD COLUMN cost_estimated boolean NOT NULL DEFAULT true;

ALTER TABLE stock_moves
  ADD COLUMN unit_cost_e4 bigint CHECK (unit_cost_e4 >= 0),
  ADD COLUMN cost_cents bigint;

-- 起算成本：最近一张已生效收货单上的进价（每采购单位 → 每库存单位）；没有收过货的按参考价；都没有的是 0（第一次入库时起算）
UPDATE materials m SET avg_cost_e4 = COALESCE(
  (SELECT round(l.price_cents::numeric * 10000000 / l.factor_milli)
     FROM inv_doc_lines l JOIN inv_docs d ON d.id = l.doc_id
    WHERE d.doc_type = 'receipt' AND d.status = 'confirmed' AND l.material_id = m.id
      AND l.price_cents IS NOT NULL AND l.factor_milli > 0
    ORDER BY d.confirmed_at DESC NULLS LAST, l.id DESC LIMIT 1),
  CASE WHEN m.ref_price_cents IS NOT NULL AND m.purchase_factor_milli > 0
       THEN round(m.ref_price_cents::numeric * 10000000 / m.purchase_factor_milli) END,
  0);
