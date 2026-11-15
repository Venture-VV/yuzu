-- 8.0.21 供应商门户：订单确认按采购单的版次认（Codex 审查 beabd59 后补，docs/FINANCE_V8021.md 第 7 节）。
--   原来一张采购单只认第一次确认（purchase_order_id 唯一）：采购单改版（可能换了供应商）、重新确认以后，改版前的确认还占着、
--   新的确认写不进去，流程图也还按旧的承诺日算。改成「一张采购单的一个版次」一次确认；改版前的确认留着（只追加），读的时候只认当前版次的。
--   确认链接、发货预告链接的快照里记着发链接时的版次（新链接），版次或供应商对不上的链接不能再回复。

ALTER TABLE po_supplier_confirmations ADD COLUMN po_revision integer;

-- 已有的确认按现在的版次补上（只追加的表：补这一列时临时关掉保护触发器）
ALTER TABLE po_supplier_confirmations DISABLE TRIGGER po_supplier_confirmations_guard;
UPDATE po_supplier_confirmations c SET po_revision = p.revision FROM purchase_orders p WHERE p.id = c.purchase_order_id;
ALTER TABLE po_supplier_confirmations ENABLE TRIGGER po_supplier_confirmations_guard;

ALTER TABLE po_supplier_confirmations ALTER COLUMN po_revision SET NOT NULL;
ALTER TABLE po_supplier_confirmations DROP CONSTRAINT po_supplier_confirmations_purchase_order_id_key;
CREATE UNIQUE INDEX po_supplier_confirmations_po_revision ON po_supplier_confirmations (purchase_order_id, po_revision);
