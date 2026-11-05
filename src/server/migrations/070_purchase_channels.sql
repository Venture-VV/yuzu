-- v0.7.29 ERP 采购五项①（主线）：采购途径（E1，设计见 docs/ERP_PURCHASING.md 第 2 节）。
--   · 途径字典在设置「采购规则」（settings.purchase_rules）里：键固定、名称可改；单据存键与当时的名称，改名不影响已有单据；
--   · 采购单、报销单记采购途径与途径说明（档口、平台与店铺、门店名……）；按采购单报销的照采购单记；
--   · 供应商档案加默认采购途径，新建采购单按它带出。
-- 只加列；旧单据的采购途径为空（页面显示「—」），不回填。

ALTER TABLE purchase_orders
  ADD COLUMN channel       text CHECK (channel IS NULL OR channel ~ '^[a-z0-9_]{1,32}$'),
  ADD COLUMN channel_label text CHECK (channel_label IS NULL OR char_length(channel_label) BETWEEN 1 AND 20),
  ADD COLUMN channel_note  text NOT NULL DEFAULT '' CHECK (char_length(channel_note) <= 60),
  ADD CONSTRAINT purchase_orders_channel_pair CHECK ((channel IS NULL) = (channel_label IS NULL) AND (channel IS NOT NULL OR channel_note = ''));

ALTER TABLE expense_claims
  ADD COLUMN channel       text CHECK (channel IS NULL OR channel ~ '^[a-z0-9_]{1,32}$'),
  ADD COLUMN channel_label text CHECK (channel_label IS NULL OR char_length(channel_label) BETWEEN 1 AND 20),
  ADD COLUMN channel_note  text NOT NULL DEFAULT '' CHECK (char_length(channel_note) <= 60),
  ADD CONSTRAINT expense_claims_channel_pair CHECK ((channel IS NULL) = (channel_label IS NULL) AND (channel IS NOT NULL OR channel_note = ''));

ALTER TABLE suppliers
  ADD COLUMN default_channel text CHECK (default_channel IS NULL OR default_channel ~ '^[a-z0-9_]{1,32}$');
