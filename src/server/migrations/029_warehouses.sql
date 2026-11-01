-- v0.7.11 · 飞书需求 RQ-002 第一步（docs/WAREHOUSES.md）：总仓 + 部门小仓两级库存、领料签收、急采、
-- 一起验收的采购、盘点差异「耗用」。只加表、加列；原有库存全部算总仓。

-- ───────────── 仓库：一个总仓（id = 1）+ 每个部门一个小仓 ─────────────
CREATE TABLE warehouses (
  id            bigserial PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('central', 'department')),
  department_id bigint UNIQUE REFERENCES departments (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'central') = (department_id IS NULL))
);
CREATE UNIQUE INDEX warehouses_one_central ON warehouses (kind) WHERE kind = 'central';
INSERT INTO warehouses (id, kind) VALUES (1, 'central');
SELECT setval(pg_get_serial_sequence('warehouses', 'id'), 1);
INSERT INTO warehouses (kind, department_id) SELECT 'department', id FROM departments ORDER BY id;
-- 以后新建的部门自动有小仓
CREATE FUNCTION yuzu_department_warehouse() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO warehouses (kind, department_id) VALUES ('department', NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER departments_warehouse AFTER INSERT ON departments FOR EACH ROW EXECUTE FUNCTION yuzu_department_warehouse();
-- 仓库只增不删，不改归属
CREATE FUNCTION yuzu_warehouse_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (NEW.kind, NEW.department_id) IS DISTINCT FROM (OLD.kind, OLD.department_id) THEN
    RAISE EXCEPTION '仓库不能删除或改归属' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER warehouses_guard BEFORE UPDATE OR DELETE ON warehouses FOR EACH ROW EXECUTE FUNCTION yuzu_warehouse_guard();

-- ───────────── 部门小仓的结存（总仓的结存仍记在 materials.stock_milli / last_move_id） ─────────────
CREATE TABLE warehouse_stock (
  warehouse_id bigint NOT NULL REFERENCES warehouses (id),
  material_id  bigint NOT NULL REFERENCES materials (id),
  stock_milli  bigint NOT NULL DEFAULT 0 CHECK (stock_milli >= 0),
  last_move_id bigint,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (warehouse_id, material_id),
  CHECK (warehouse_id <> 1)
);
CREATE INDEX warehouse_stock_material_idx ON warehouse_stock (material_id);

-- ───────────── 流水按仓：原有流水都在总仓 ─────────────
ALTER TABLE stock_moves ADD COLUMN warehouse_id bigint NOT NULL DEFAULT 1 REFERENCES warehouses (id);
ALTER TABLE stock_moves ALTER COLUMN warehouse_id DROP DEFAULT;
CREATE INDEX stock_moves_wh_material_idx ON stock_moves (warehouse_id, material_id, id);

-- ───────────── 单据 ─────────────
-- warehouse_id：这张单动的仓；领料、领料退回记部门小仓（另一头是总仓）。
--   迁移前已生效的领料、退回为空：那时的领料没进部门小仓（退回时只进总仓）。
ALTER TABLE inv_docs
  ADD COLUMN warehouse_id     bigint REFERENCES warehouses (id),
  ADD COLUMN urgent           boolean NOT NULL DEFAULT false,      -- 急采收货：没有采购单，进部门小仓，限额
  ADD COLUMN urgent_cap_cents bigint,                              -- 登记急采时的上限
  ADD COLUMN co_acceptor_id   bigint REFERENCES staff (id),        -- 一起验收的采购经办（#17 第一次验收）
  ADD COLUMN dept_signed_by   bigint REFERENCES staff (id),        -- 领料：部门签收（#17 第二次验收）
  ADD COLUMN dept_signed_at   timestamptz,
  ADD COLUMN dept_sign_note   text CHECK (char_length(dept_sign_note) <= 200);

UPDATE inv_docs SET warehouse_id = 1 WHERE doc_type NOT IN ('issue', 'issue_return');
-- 还没生效的领料按新规则走（生效时进领料部门的小仓）。
-- 还没生效的领料退回跟着原领料单：原单都是迁移前生效的、没进部门小仓，所以退回仍为空（生效时只进总仓）
UPDATE inv_docs d SET warehouse_id = w.id FROM warehouses w
WHERE d.doc_type = 'issue' AND d.status IN ('draft', 'submitted', 'returned') AND w.department_id = d.department_id;

ALTER TABLE inv_docs ADD CONSTRAINT inv_docs_urgent_check
  CHECK (NOT urgent OR (doc_type = 'receipt' AND warehouse_id IS NOT NULL AND warehouse_id <> 1
                        AND urgent_cap_cents IS NOT NULL AND amount_cents <= urgent_cap_cents));
ALTER TABLE inv_docs ADD CONSTRAINT inv_docs_sign_check
  CHECK (dept_signed_at IS NULL OR (doc_type = 'issue' AND dept_signed_by IS NOT NULL));
CREATE INDEX inv_docs_warehouse_idx ON inv_docs (warehouse_id, doc_date);

-- 已生效的库存单据：新加的几列同样不可改；部门签收只能从空写一次
CREATE OR REPLACE FUNCTION yuzu_inv_doc_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '库存单据禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status IN ('confirmed', 'voided') THEN
    IF (NEW.doc_no, NEW.doc_type, NEW.doc_date, NEW.supplier_id, NEW.department_id, NEW.source_doc_id,
        NEW.amount_cents, NEW.created_by, NEW.created_at, NEW.confirmed_by, NEW.confirmed_at, NEW.settlement,
        NEW.warehouse_id, NEW.urgent, NEW.urgent_cap_cents, NEW.co_acceptor_id)
       IS DISTINCT FROM
       (OLD.doc_no, OLD.doc_type, OLD.doc_date, OLD.supplier_id, OLD.department_id, OLD.source_doc_id,
        OLD.amount_cents, OLD.created_by, OLD.created_at, OLD.confirmed_by, OLD.confirmed_at, OLD.settlement,
        OLD.warehouse_id, OLD.urgent, OLD.urgent_cap_cents, OLD.co_acceptor_id) THEN
      RAISE EXCEPTION '已生效的库存单据不可修改' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.status <> OLD.status AND NOT (OLD.status = 'confirmed' AND NEW.status = 'voided') THEN
      RAISE EXCEPTION '已生效的库存单据只能冲销' USING ERRCODE = 'P0001';
    END IF;
    -- 补单：直接收货 / 急采后关联到新建的采购单（只能从空变为有）
    IF NEW.purchase_order_id IS DISTINCT FROM OLD.purchase_order_id AND OLD.purchase_order_id IS NOT NULL THEN
      RAISE EXCEPTION '收货单已关联采购单，不能更改' USING ERRCODE = 'P0001';
    END IF;
    -- 部门签收：只能签一次
    IF OLD.dept_signed_at IS NOT NULL
       AND (NEW.dept_signed_by, NEW.dept_signed_at, NEW.dept_sign_note) IS DISTINCT FROM (OLD.dept_signed_by, OLD.dept_signed_at, OLD.dept_sign_note) THEN
      RAISE EXCEPTION '领料单已签收，不能再改' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- 盘点差异原因加「耗用」（部门小仓的客用、日耗品用掉的就是这一项）
ALTER TABLE inv_doc_lines DROP CONSTRAINT inv_doc_lines_diff_reason_check;
ALTER TABLE inv_doc_lines ADD CONSTRAINT inv_doc_lines_diff_reason_check
  CHECK (diff_reason IN ('pending', 'unrecorded', 'measurement', 'damaged', 'unknown', 'consumed'));

-- 审批记录：部门签收领料
ALTER TABLE approval_logs DROP CONSTRAINT approval_logs_action_check;
ALTER TABLE approval_logs ADD CONSTRAINT approval_logs_action_check
  CHECK (action IN ('create', 'submit', 'approve', 'return', 'cancel', 'void', 'close', 'revise', 'sign'));

-- 规则：急采上限（默认 2000 元，ERP「模块设置 → 库存」可调）；「允许无采购单直接收货」不再使用（#19）
INSERT INTO settings (key, value) VALUES ('inventory_urgent_cap_cents', '200000') ON CONFLICT (key) DO NOTHING;
