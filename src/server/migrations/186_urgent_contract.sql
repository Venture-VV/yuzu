-- 8.1.10 急采后补合同（docs/ERP_V8110.md 第 1 节，PENDING_DECISIONS CK18–CK22）
--   · 急采收货单在仓库确认生效时，合计达到「急采补合同金额」（采购规则，默认 ¥20,000）的记下要补合同；
--     生效那一刻定下，以后改金额线不影响已经生效的（CK18）；
--   · 补单采购单事后挂合同（只改挂的合同）：记下补合同的人与时刻。挂上以后不能换、不能取消（CK20），由代码核对；
--     采购单原来的守卫（yuzu_po_guard）不管 contract_id，这里不另加。

ALTER TABLE inv_docs ADD COLUMN needs_contract boolean NOT NULL DEFAULT false;
-- 只有急采收货单会要补合同
ALTER TABLE inv_docs ADD CONSTRAINT inv_docs_needs_contract_urgent CHECK (NOT needs_contract OR (urgent AND doc_type = 'receipt'));
CREATE INDEX inv_docs_needs_contract_idx ON inv_docs (id) WHERE needs_contract;

ALTER TABLE purchase_orders
  ADD COLUMN contract_added_by bigint REFERENCES staff (id),
  ADD COLUMN contract_added_at timestamptz;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_contract_added CHECK (
  (contract_added_by IS NULL) = (contract_added_at IS NULL) AND (contract_added_at IS NULL OR (backfill AND contract_id IS NOT NULL)));
