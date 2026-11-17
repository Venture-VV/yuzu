-- 180（8.1.5，迁移号在 docs/ROADMAP.md 第 7 节登记）：平板电子菜单按早、中、晚三个时段（店主 2026-11-16 转来的品牌需求，
-- docs/EMENU.md 第 14.1 节，PENDING_DECISIONS.md PP1–PP3）。
--
-- 分类在哪几段供应：breakfast 早、lunch 中、dinner 晚，可以多选；空的是全天——原来的分类都是空的，升级以后平板上什么都不变，
-- 店主把早餐、午餐、晚餐的分类各自勾上才开始分段。三段的开始时间与名称是电子菜单设置里的一项（settings 的 emenu_rules.periods），
-- 不另建表。原来的 start_minute / end_minute（「指定时段」，DC9）留着，改叫「另外限定时间」，与时段同时满足才供应。

ALTER TABLE emenu_categories ADD COLUMN periods text[] NOT NULL DEFAULT '{}';
ALTER TABLE emenu_categories
  ADD CONSTRAINT emenu_categories_periods_check CHECK (periods <@ ARRAY['breakfast', 'lunch', 'dinner']::text[] AND cardinality(periods) <= 3);
