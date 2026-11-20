-- 8.1.17 BW-11 本店价改价留痕（docs/FRONTDESK_V8117.md 第 6 节）：第二家店改菜品的本店价（service_item_store_prices，8.0.22）
-- 也写进菜品的改价记录 dish_price_changes——哪家店、改前改后、谁、几点、原因；改价记录能按门店筛。
--   · store_id：这一条是哪家店的本店价（为空 = 全公司的价目，以前的记录都是）；
--   · base_price：那时这一档全公司的价（本店价的改前、改后为空时写「同全公司」，带上当时是多少）；
--   · 来源多一种 store_price（后台价目「本店价」），在当时的约束上追加（几条开发线的迁移谁先跑不一定，写法见 162）；
--   · 本店价的记录必须带门店、不能是本店（编号 1 用全公司的价目），全公司的记录不带门店。
-- 只加列、加约束、加索引；以前的改价记录一行不改（新列为空，就是全公司的）。

ALTER TABLE dish_price_changes
  ADD COLUMN store_id bigint REFERENCES stores (id),
  ADD COLUMN base_price bigint CHECK (base_price > 0);

DO $$
DECLARE expression text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = 'dish_price_changes'::regclass AND conname = 'dish_price_changes_source_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原改价来源约束 dish_price_changes_source_check 不存在'; END IF;
  ALTER TABLE dish_price_changes DROP CONSTRAINT dish_price_changes_source_check;
  EXECUTE format('ALTER TABLE dish_price_changes ADD CONSTRAINT dish_price_changes_source_check CHECK ((%s) OR source = ''store_price'')', expression);
END $$;

ALTER TABLE dish_price_changes ADD CONSTRAINT dish_price_changes_store_check
  CHECK ((source = 'store_price') = (store_id IS NOT NULL) AND (store_id IS NULL OR store_id <> 1) AND (store_id IS NOT NULL OR base_price IS NULL));

-- 改价记录按门店筛（某一家店的本店价）
CREATE INDEX dish_price_changes_store_idx ON dish_price_changes (store_id, id) WHERE store_id IS NOT NULL;
