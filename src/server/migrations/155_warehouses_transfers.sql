-- 8.0.22 多店多仓与门店间调拨（docs/MULTISTORE_V8022.md 第 8 节，MD-B）。
--   · 仓库加门店：现有的总仓与部门小仓都归本店；第二家店有自己的主仓（kind = store_main，结存记在 warehouse_stock）；
--     部门小仓按「部门 + 门店」各一个（本店的照旧由部门触发器自动建）。
--   · 调拨单（DB）：调出时从调出仓扣、记在途；调入时调入仓按实收入库，短少、损坏登记原因；在途的可以撤回（原数退回调出仓）。
--     调出、调入各记一张已生效的库存单据（transfer_out / transfer_in），流水、成本、单据清单都照旧。

ALTER TABLE warehouses ADD COLUMN store_id bigint NOT NULL DEFAULT 1 REFERENCES stores (id);
ALTER TABLE warehouses ADD COLUMN name text CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 40);
ALTER TABLE warehouses DROP CONSTRAINT warehouses_kind_check;
ALTER TABLE warehouses ADD CONSTRAINT warehouses_kind_check CHECK (kind IN ('central', 'department', 'store_main'));
ALTER TABLE warehouses DROP CONSTRAINT warehouses_check;
ALTER TABLE warehouses ADD CONSTRAINT warehouses_check CHECK ((kind = 'department') = (department_id IS NOT NULL));
-- 总仓就是本店的那一个（编号 1）
ALTER TABLE warehouses ADD CONSTRAINT warehouses_central_hq CHECK (kind <> 'central' OR store_id = 1);
ALTER TABLE warehouses ADD CONSTRAINT warehouses_store_main_named CHECK (kind <> 'store_main' OR (name IS NOT NULL AND store_id <> 1));
ALTER TABLE warehouses DROP CONSTRAINT warehouses_department_id_key;
CREATE UNIQUE INDEX warehouses_department_store_uq ON warehouses (department_id, store_id) WHERE department_id IS NOT NULL;
CREATE UNIQUE INDEX warehouses_one_store_main ON warehouses (store_id) WHERE kind = 'store_main';

-- 仓库只增不删，不改归属（门店也不能改；主仓的名称可以跟着门店改）
CREATE OR REPLACE FUNCTION yuzu_warehouse_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (NEW.kind, NEW.department_id, NEW.store_id) IS DISTINCT FROM (OLD.kind, OLD.department_id, OLD.store_id) THEN
    RAISE EXCEPTION '仓库不能删除或改归属' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- 已经建好的第二家店：各建一个主仓
INSERT INTO warehouses (kind, store_id, name)
SELECT 'store_main', s.id, left(s.name || '主仓', 40) FROM stores s
WHERE s.id <> 1 AND NOT EXISTS (SELECT 1 FROM warehouses w WHERE w.store_id = s.id AND w.kind = 'store_main');

-- 调出、调入两种单据与流水（在当时的约束上追加，不照着旧名单重建）
DO $$
DECLARE expression text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = 'inv_docs'::regclass AND conname = 'inv_docs_doc_type_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原单据类型约束不存在'; END IF;
  ALTER TABLE inv_docs DROP CONSTRAINT inv_docs_doc_type_check;
  EXECUTE format('ALTER TABLE inv_docs ADD CONSTRAINT inv_docs_doc_type_check CHECK ((%s) OR doc_type IN (''transfer_out'', ''transfer_in''))', expression);
  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = 'stock_moves'::regclass AND conname = 'stock_moves_move_type_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原流水类型约束不存在'; END IF;
  ALTER TABLE stock_moves DROP CONSTRAINT stock_moves_move_type_check;
  EXECUTE format('ALTER TABLE stock_moves ADD CONSTRAINT stock_moves_move_type_check CHECK ((%s) OR move_type IN (''transfer_out'', ''transfer_in''))', expression);
END $$;

-- 「确认作废」与操作编号：调拨单（编号记在 idempotency_keys，ref_id 是那张调拨单）
DO $$
DECLARE t text; expression text;
BEGIN
  FOREACH t IN ARRAY ARRAY['idempotency_keys', 'op_fences'] LOOP
    SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = t::regclass AND conname = t || '_op_type_check';
    IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, t || '_op_type_check');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ((%s) OR op_type IN (''stock_transfer''))', t, t || '_op_type_check', expression);
  END LOOP;
END $$;

CREATE TABLE stock_transfers (
  id                 bigserial PRIMARY KEY,
  transfer_no        text NOT NULL UNIQUE,
  from_warehouse_id  bigint NOT NULL REFERENCES warehouses (id),
  to_warehouse_id    bigint NOT NULL REFERENCES warehouses (id),
  status             text NOT NULL DEFAULT 'in_transit' CHECK (status IN ('in_transit', 'received', 'cancelled')),
  note               text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  out_doc_id         bigint NOT NULL REFERENCES inv_docs (id),
  in_doc_id          bigint REFERENCES inv_docs (id),
  sent_by            bigint NOT NULL REFERENCES staff (id),
  sent_at            timestamptz NOT NULL DEFAULT now(),
  received_by        bigint REFERENCES staff (id),
  received_at        timestamptz,
  cancelled_by       bigint REFERENCES staff (id),
  cancelled_at       timestamptz,
  cancel_reason      text CHECK (cancel_reason IS NULL OR char_length(cancel_reason) BETWEEN 2 AND 200),
  version            integer NOT NULL DEFAULT 1,
  CHECK (from_warehouse_id <> to_warehouse_id),
  CHECK ((status = 'in_transit') = (in_doc_id IS NULL)),
  CHECK (status <> 'received' OR received_by IS NOT NULL),
  CHECK (status <> 'cancelled' OR (cancelled_by IS NOT NULL AND cancel_reason IS NOT NULL))
);
CREATE INDEX stock_transfers_status_idx ON stock_transfers (status, id);
CREATE INDEX stock_transfers_to_idx ON stock_transfers (to_warehouse_id, id);

CREATE TABLE stock_transfer_lines (
  id               bigserial PRIMARY KEY,
  transfer_id      bigint NOT NULL REFERENCES stock_transfers (id),
  material_id      bigint NOT NULL REFERENCES materials (id),
  qty_milli        bigint NOT NULL CHECK (qty_milli > 0),
  received_milli   bigint CHECK (received_milli IS NULL OR (received_milli >= 0 AND received_milli <= qty_milli)),
  variance_reason  text CHECK (variance_reason IS NULL OR char_length(variance_reason) BETWEEN 2 AND 200),
  UNIQUE (transfer_id, material_id),
  -- 实收少于调出时要写原因（短少、损坏）
  CHECK (received_milli IS NULL OR received_milli = qty_milli OR variance_reason IS NOT NULL)
);
