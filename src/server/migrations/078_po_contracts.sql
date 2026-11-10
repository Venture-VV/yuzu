-- v0.7.31 采购单挂合同（docs/CONTRACTS.md 第 5 节，C9 待确认）：采购单可以选一份生效中的采购合同，按合同的单价表核对；
-- 单价超过合同价、数量超过合同剩余量的，提交时写原因（contract_note），审批里看得到。只加列，不改已有的采购单。

ALTER TABLE purchase_orders ADD COLUMN contract_id bigint REFERENCES contracts (id);
ALTER TABLE purchase_orders ADD COLUMN contract_note text NOT NULL DEFAULT '' CHECK (char_length(contract_note) <= 200);
CREATE INDEX purchase_orders_contract_idx ON purchase_orders (contract_id) WHERE contract_id IS NOT NULL;
