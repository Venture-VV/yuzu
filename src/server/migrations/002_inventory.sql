-- 浴族 yuzu · 库存与采购（增量迁移，不改动会员与储值数据）
-- 约定：
--   · 数量一律为整数「千分之一库存单位」(*_milli，bigint)，金额一律为整数「分」，不使用浮点数；
--   · 单据行保存当时的单位与换算快照，物料包装变更不会改写历史；
--   · 库存流水 stock_moves 与应付流水 ap_entries 只追加，是唯一的记账来源；
--   · 需要负责人确认的单据，确认前不影响库存或应付。

-- ───────────── 员工：新增「后勤人员」岗位与可叠加的职责 ─────────────
ALTER TABLE staff DROP CONSTRAINT staff_role_check;
ALTER TABLE staff ADD CONSTRAINT staff_role_check CHECK (role IN ('owner', 'clerk', 'backoffice'));
ALTER TABLE staff ADD COLUMN duties text[] NOT NULL DEFAULT '{}'
  CHECK (duties <@ ARRAY['stock', 'purchase', 'payable', 'approve']::text[]);

-- ───────────── 经营设置（模拟规则，待确认） ─────────────
INSERT INTO settings (key, value) VALUES
  ('inventory_scope_name', '"后勤总库"'),
  ('inventory_price_basis', '"含税到货价（模拟口径，待确认）"'),
  ('inventory_allow_direct_receipt', 'true'),
  ('inventory_approval_rules', '{"purchase_order": true, "damage": true, "supplier_return": true, "payment": true, "opening": true}')
ON CONFLICT (key) DO NOTHING;

-- ───────────── 档案：部门、供应商、物料 ─────────────
CREATE TABLE departments (
  id         bigserial PRIMARY KEY,
  name       text NOT NULL UNIQUE CHECK (char_length(name) BETWEEN 1 AND 16),
  active     boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE suppliers (
  id           bigserial PRIMARY KEY,
  code         text NOT NULL UNIQUE CHECK (char_length(code) BETWEEN 1 AND 16),
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  contact      text NOT NULL DEFAULT '' CHECK (char_length(contact) <= 40),
  phone        text NOT NULL DEFAULT '' CHECK (char_length(phone) <= 32),
  note         text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  active       boolean NOT NULL DEFAULT true,
  is_synthetic boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE materials (
  id                    bigserial PRIMARY KEY,
  code                  text NOT NULL UNIQUE CHECK (char_length(code) BETWEEN 1 AND 16),
  name                  text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  category              text NOT NULL DEFAULT '' CHECK (char_length(category) <= 16),
  specification         text NOT NULL DEFAULT '' CHECK (char_length(specification) <= 80),
  inventory_unit        text NOT NULL CHECK (char_length(inventory_unit) BETWEEN 1 AND 8),
  -- 库存单位允许的小数位：0 = 只能整数（双、瓶、桶），最多 3 位（kg 等）
  decimals              smallint NOT NULL DEFAULT 0 CHECK (decimals BETWEEN 0 AND 3),
  purchase_unit         text NOT NULL CHECK (char_length(purchase_unit) BETWEEN 1 AND 8),
  -- 1 个采购单位 = 多少库存单位（千分之一精度），例如 1 箱 = 100 双 → 100000
  purchase_factor_milli bigint NOT NULL CHECK (purchase_factor_milli > 0),
  ref_price_cents       bigint CHECK (ref_price_cents >= 0),   -- 参考价，按采购单位
  default_supplier_id   bigint REFERENCES suppliers (id),
  low_stock_milli       bigint CHECK (low_stock_milli >= 0),   -- 人工设定的低库存提醒阈值
  tracked               boolean NOT NULL DEFAULT true,          -- false = 候选物料，不产生库存流水
  active                boolean NOT NULL DEFAULT true,
  stock_milli           bigint NOT NULL DEFAULT 0 CHECK (stock_milli >= 0),
  last_move_id          bigint,                                 -- 盘点时据此判断账面是否又有变动
  note                  text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  is_synthetic          boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX materials_category_idx ON materials (category);

-- ───────────── 采购单 ─────────────
CREATE TABLE purchase_orders (
  id              bigserial PRIMARY KEY,
  doc_no          text NOT NULL UNIQUE,
  supplier_id     bigint NOT NULL REFERENCES suppliers (id),
  status          text NOT NULL CHECK (status IN ('draft', 'submitted', 'returned', 'approved', 'cancelled', 'closed')),
  order_date      date NOT NULL,
  expected_date   date,
  note            text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  total_cents     bigint NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  revision        integer NOT NULL DEFAULT 1,
  -- 先收货后补单：补单关联已有收货，不会再次入库或形成应付
  backfill        boolean NOT NULL DEFAULT false,
  client_key      uuid UNIQUE,
  is_synthetic    boolean NOT NULL DEFAULT false,
  created_by      bigint NOT NULL REFERENCES staff (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  submitted_by    bigint REFERENCES staff (id),
  submitted_at    timestamptz,
  approved_by     bigint REFERENCES staff (id),
  approved_at     timestamptz,
  returned_reason text,
  closed_by       bigint REFERENCES staff (id),
  closed_at       timestamptz,
  close_reason    text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX purchase_orders_supplier_idx ON purchase_orders (supplier_id);

CREATE TABLE purchase_order_lines (
  id               bigserial PRIMARY KEY,
  po_id            bigint NOT NULL REFERENCES purchase_orders (id),
  line_no          integer NOT NULL,
  material_id      bigint NOT NULL REFERENCES materials (id),
  purchase_qty_milli bigint NOT NULL CHECK (purchase_qty_milli > 0),
  purchase_unit    text NOT NULL,
  inventory_unit   text NOT NULL,
  factor_milli     bigint NOT NULL CHECK (factor_milli > 0),
  base_qty_milli   bigint NOT NULL CHECK (base_qty_milli > 0),
  price_cents      bigint NOT NULL CHECK (price_cents >= 0),   -- 每采购单位
  amount_cents     bigint NOT NULL CHECK (amount_cents >= 0),
  note             text NOT NULL DEFAULT '' CHECK (char_length(note) <= 100),
  UNIQUE (po_id, line_no)
);
CREATE INDEX purchase_order_lines_material_idx ON purchase_order_lines (material_id);

-- 采购单每次关键内容变更都保留上一版本
CREATE TABLE purchase_order_revisions (
  id         bigserial PRIMARY KEY,
  po_id      bigint NOT NULL REFERENCES purchase_orders (id),
  revision   integer NOT NULL,
  snapshot   jsonb NOT NULL,
  changed_by bigint NOT NULL REFERENCES staff (id),
  changed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (po_id, revision)
);

-- ───────────── 库存单据（期初、收货、领用、领用退回、直接耗用、报损、盘点、退供应商） ─────────────
CREATE TABLE inv_docs (
  id                bigserial PRIMARY KEY,
  doc_no            text NOT NULL UNIQUE,
  doc_type          text NOT NULL CHECK (doc_type IN
                      ('opening', 'receipt', 'issue', 'issue_return', 'direct_use', 'damage', 'count', 'supplier_return')),
  status            text NOT NULL CHECK (status IN ('draft', 'submitted', 'returned', 'confirmed', 'cancelled', 'voided')),
  doc_date          date NOT NULL,
  supplier_id       bigint REFERENCES suppliers (id),
  purchase_order_id bigint REFERENCES purchase_orders (id),
  department_id     bigint REFERENCES departments (id),
  handler           text NOT NULL DEFAULT '' CHECK (char_length(handler) <= 32),  -- 领用人 / 送货人等经手人
  source_doc_id     bigint REFERENCES inv_docs (id),                               -- 退回、退货、冲销对应的原单
  note              text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  amount_cents      bigint NOT NULL DEFAULT 0,                                     -- 收货货款 / 退货扣款
  no_po             boolean NOT NULL DEFAULT false,                                -- 直接收货：缺少采购依据
  client_key        uuid UNIQUE,
  is_synthetic      boolean NOT NULL DEFAULT false,
  created_by        bigint NOT NULL REFERENCES staff (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  submitted_by      bigint REFERENCES staff (id),
  submitted_at      timestamptz,
  confirmed_by      bigint REFERENCES staff (id),
  confirmed_at      timestamptz,
  returned_reason   text,
  voided_by         bigint REFERENCES staff (id),
  voided_at         timestamptz,
  void_reason       text,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (doc_type <> 'receipt' OR supplier_id IS NOT NULL),
  CHECK (doc_type <> 'supplier_return' OR (supplier_id IS NOT NULL AND source_doc_id IS NOT NULL)),
  CHECK (doc_type <> 'issue' OR department_id IS NOT NULL),
  CHECK (doc_type <> 'issue_return' OR source_doc_id IS NOT NULL)
);
CREATE INDEX inv_docs_type_date_idx ON inv_docs (doc_type, doc_date);
CREATE INDEX inv_docs_status_idx ON inv_docs (status);
CREATE INDEX inv_docs_source_idx ON inv_docs (source_doc_id);
CREATE INDEX inv_docs_po_idx ON inv_docs (purchase_order_id);

CREATE TABLE inv_doc_lines (
  id                bigserial PRIMARY KEY,
  doc_id            bigint NOT NULL REFERENCES inv_docs (id),
  line_no           integer NOT NULL,
  material_id       bigint NOT NULL REFERENCES materials (id),
  -- 本行生效数量（库存单位，千分之一）：收货 = 合格实收；领用/退回/耗用/报损/退货 = 数量；盘点 = 调整数（可负）；期初 = 期初数
  qty_milli         bigint NOT NULL,
  inventory_unit    text NOT NULL,
  purchase_unit     text NOT NULL,
  factor_milli      bigint NOT NULL CHECK (factor_milli > 0),
  -- 员工录入时使用的数量与单位，例如「8 箱」，用于原样展示
  entered_qty_milli bigint,
  entered_unit      text,
  -- 收货
  delivered_milli   bigint CHECK (delivered_milli >= 0),
  rejected_milli    bigint CHECK (rejected_milli >= 0),
  reject_reason     text NOT NULL DEFAULT '' CHECK (char_length(reject_reason) <= 100),
  price_cents       bigint CHECK (price_cents >= 0),         -- 每采购单位
  amount_cents      bigint,
  po_line_id        bigint REFERENCES purchase_order_lines (id),
  -- 盘点
  book_milli        bigint,
  counted_milli     bigint CHECK (counted_milli >= 0),
  book_move_id      bigint,                                   -- 记录账面数时该物料最后一条流水
  diff_reason       text CHECK (diff_reason IN ('pending', 'unrecorded', 'measurement', 'damaged', 'unknown')),
  -- 退回 / 退货对应原单行
  source_line_id    bigint REFERENCES inv_doc_lines (id),
  note              text NOT NULL DEFAULT '' CHECK (char_length(note) <= 100),
  UNIQUE (doc_id, line_no)
);
CREATE INDEX inv_doc_lines_material_idx ON inv_doc_lines (material_id);
CREATE INDEX inv_doc_lines_source_idx ON inv_doc_lines (source_line_id);
CREATE INDEX inv_doc_lines_po_line_idx ON inv_doc_lines (po_line_id);

-- ───────────── 库存流水：唯一的数量来源 ─────────────
CREATE TABLE stock_moves (
  id              bigserial PRIMARY KEY,
  material_id     bigint NOT NULL REFERENCES materials (id),
  move_type       text NOT NULL CHECK (move_type IN
                    ('opening', 'receipt', 'issue', 'issue_return', 'direct_use', 'damage', 'count_adjust', 'supplier_return', 'void')),
  doc_id          bigint NOT NULL REFERENCES inv_docs (id),
  doc_line_id     bigint NOT NULL REFERENCES inv_doc_lines (id),
  qty_delta_milli bigint NOT NULL CHECK (qty_delta_milli <> 0),
  qty_after_milli bigint NOT NULL CHECK (qty_after_milli >= 0),
  doc_date        date NOT NULL,
  operator_id     bigint NOT NULL REFERENCES staff (id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_moves_material_idx ON stock_moves (material_id, id);
CREATE INDEX stock_moves_date_idx ON stock_moves (doc_date);
CREATE INDEX stock_moves_doc_idx ON stock_moves (doc_id);

-- ───────────── 应付：期初未付、付款、付款分配、应付流水 ─────────────
CREATE TABLE opening_payables (
  id              bigserial PRIMARY KEY,
  doc_no          text NOT NULL UNIQUE,
  supplier_id     bigint NOT NULL REFERENCES suppliers (id),
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  as_of_date      date NOT NULL,
  note            text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  status          text NOT NULL CHECK (status IN ('submitted', 'returned', 'confirmed', 'cancelled', 'voided')),
  client_key      uuid UNIQUE,
  is_synthetic    boolean NOT NULL DEFAULT false,
  created_by      bigint NOT NULL REFERENCES staff (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  confirmed_by    bigint REFERENCES staff (id),
  confirmed_at    timestamptz,
  returned_reason text,
  voided_by       bigint REFERENCES staff (id),
  voided_at       timestamptz,
  void_reason     text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payments (
  id              bigserial PRIMARY KEY,
  doc_no          text NOT NULL UNIQUE,
  supplier_id     bigint NOT NULL REFERENCES suppliers (id),
  pay_date        date NOT NULL,
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  method          text NOT NULL CHECK (method IN ('bank_transfer', 'wechat', 'alipay', 'cash', 'other')),
  evidence        text NOT NULL DEFAULT '' CHECK (char_length(evidence) <= 200),  -- 凭据说明
  note            text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  status          text NOT NULL CHECK (status IN ('submitted', 'returned', 'confirmed', 'cancelled', 'voided')),
  client_key      uuid UNIQUE,
  is_synthetic    boolean NOT NULL DEFAULT false,
  created_by      bigint NOT NULL REFERENCES staff (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  confirmed_by    bigint REFERENCES staff (id),
  confirmed_at    timestamptz,
  returned_reason text,
  voided_by       bigint REFERENCES staff (id),
  voided_at       timestamptz,
  void_reason     text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_supplier_idx ON payments (supplier_id);

-- 付款核销到具体货款：某张收货单，或期初未付
CREATE TABLE payment_allocations (
  id                 bigserial PRIMARY KEY,
  payment_id         bigint NOT NULL REFERENCES payments (id),
  receipt_doc_id     bigint REFERENCES inv_docs (id),
  opening_payable_id bigint REFERENCES opening_payables (id),
  amount_cents       bigint NOT NULL CHECK (amount_cents > 0),
  CHECK ((receipt_doc_id IS NULL) <> (opening_payable_id IS NULL))
);
CREATE INDEX payment_allocations_receipt_idx ON payment_allocations (receipt_doc_id);
CREATE INDEX payment_allocations_opening_idx ON payment_allocations (opening_payable_id);

-- 应付流水：正数增加应付（期初、收货），负数减少（退货扣款、付款）
CREATE TABLE ap_entries (
  id                 bigserial PRIMARY KEY,
  supplier_id        bigint NOT NULL REFERENCES suppliers (id),
  entry_type         text NOT NULL CHECK (entry_type IN ('opening', 'receipt', 'supplier_return', 'payment', 'void')),
  amount_delta_cents bigint NOT NULL CHECK (amount_delta_cents <> 0),
  inv_doc_id         bigint REFERENCES inv_docs (id),
  opening_payable_id bigint REFERENCES opening_payables (id),
  payment_id         bigint REFERENCES payments (id),
  entry_date         date NOT NULL,
  operator_id        bigint NOT NULL REFERENCES staff (id),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ap_entries_supplier_idx ON ap_entries (supplier_id, entry_date);

-- ───────────── 审批记录（提交、确认、退回、撤回、冲销） ─────────────
CREATE TABLE approval_logs (
  id         bigserial PRIMARY KEY,
  doc_kind   text NOT NULL CHECK (doc_kind IN ('inv_doc', 'purchase_order', 'payment', 'opening_payable')),
  doc_id     bigint NOT NULL,
  action     text NOT NULL CHECK (action IN ('create', 'submit', 'approve', 'return', 'cancel', 'void', 'close', 'revise')),
  actor_id   bigint NOT NULL REFERENCES staff (id),
  reason     text NOT NULL DEFAULT '',
  revision   integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approval_logs_doc_idx ON approval_logs (doc_kind, doc_id);

-- ───────────── 只追加保护 ─────────────
CREATE TRIGGER stock_moves_append_only BEFORE UPDATE OR DELETE ON stock_moves
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
CREATE TRIGGER ap_entries_append_only BEFORE UPDATE OR DELETE ON ap_entries
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
CREATE TRIGGER approval_logs_append_only BEFORE UPDATE OR DELETE ON approval_logs
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
CREATE TRIGGER purchase_order_revisions_append_only BEFORE UPDATE OR DELETE ON purchase_order_revisions
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
CREATE TRIGGER payment_allocations_append_only BEFORE UPDATE OR DELETE ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- 已生效（confirmed / voided）的库存单据：内容不可再改，只允许「确认 → 冲销」和补单关联采购单
CREATE FUNCTION yuzu_inv_doc_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '库存单据禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status IN ('confirmed', 'voided') THEN
    IF (NEW.doc_no, NEW.doc_type, NEW.doc_date, NEW.supplier_id, NEW.department_id, NEW.source_doc_id,
        NEW.amount_cents, NEW.created_by, NEW.created_at, NEW.confirmed_by, NEW.confirmed_at)
       IS DISTINCT FROM
       (OLD.doc_no, OLD.doc_type, OLD.doc_date, OLD.supplier_id, OLD.department_id, OLD.source_doc_id,
        OLD.amount_cents, OLD.created_by, OLD.created_at, OLD.confirmed_by, OLD.confirmed_at) THEN
      RAISE EXCEPTION '已生效的库存单据不可修改' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.status <> OLD.status AND NOT (OLD.status = 'confirmed' AND NEW.status = 'voided') THEN
      RAISE EXCEPTION '已生效的库存单据只能冲销' USING ERRCODE = 'P0001';
    END IF;
    -- 补单：直接收货后关联到新建的采购单（只能从空变为有）
    IF NEW.purchase_order_id IS DISTINCT FROM OLD.purchase_order_id AND OLD.purchase_order_id IS NOT NULL THEN
      RAISE EXCEPTION '收货单已关联采购单，不能更改' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inv_docs_guard BEFORE UPDATE OR DELETE ON inv_docs
  FOR EACH ROW EXECUTE FUNCTION yuzu_inv_doc_guard();

-- 已生效单据的明细行不可修改或删除（补单时允许把收货行关联到采购单行）
CREATE FUNCTION yuzu_inv_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  doc_status text;
BEGIN
  SELECT status INTO doc_status FROM inv_docs WHERE id = OLD.doc_id;
  IF doc_status IN ('confirmed', 'voided') THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION '已生效单据的明细不可删除' USING ERRCODE = 'P0001';
    END IF;
    IF (NEW.doc_id, NEW.material_id, NEW.qty_milli, NEW.factor_milli, NEW.price_cents, NEW.amount_cents,
        NEW.delivered_milli, NEW.rejected_milli, NEW.counted_milli, NEW.book_milli, NEW.source_line_id)
       IS DISTINCT FROM
       (OLD.doc_id, OLD.material_id, OLD.qty_milli, OLD.factor_milli, OLD.price_cents, OLD.amount_cents,
        OLD.delivered_milli, OLD.rejected_milli, OLD.counted_milli, OLD.book_milli, OLD.source_line_id)
       OR (OLD.po_line_id IS NOT NULL AND NEW.po_line_id IS DISTINCT FROM OLD.po_line_id) THEN
      RAISE EXCEPTION '已生效单据的明细不可修改' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inv_doc_lines_guard BEFORE UPDATE OR DELETE ON inv_doc_lines
  FOR EACH ROW EXECUTE FUNCTION yuzu_inv_line_guard();

-- 已确认的付款与期初未付不可修改或删除，只能冲销（保留原记录）
CREATE FUNCTION yuzu_payable_doc_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '付款与期初应付记录禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'voided'
     OR (OLD.status = 'confirmed'
         AND NOT (NEW.status = 'voided' AND NEW.amount_cents = OLD.amount_cents AND NEW.supplier_id = OLD.supplier_id
                  AND NEW.confirmed_at IS NOT DISTINCT FROM OLD.confirmed_at)) THEN
    RAISE EXCEPTION '已确认的记录不可修改，只能冲销' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payments_guard BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION yuzu_payable_doc_guard();
CREATE TRIGGER opening_payables_guard BEFORE UPDATE OR DELETE ON opening_payables
  FOR EACH ROW EXECUTE FUNCTION yuzu_payable_doc_guard();

-- ───────────── 演示部门（可在「库存 → 档案」中修改） ─────────────
INSERT INTO departments (name, sort_order) VALUES
  ('浴区', 1), ('保洁', 2), ('SPA', 3), ('水吧', 4), ('前台', 5), ('餐饮', 6);

-- ───────────── 幂等键扩展到库存与采购单据 ─────────────
ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_op_type_check;
ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'inv_doc', 'purchase_order', 'payment', 'opening_payable'));
