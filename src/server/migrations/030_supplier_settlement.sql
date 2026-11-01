-- 030 · RQ-002 第二步（v0.7.12，见 docs/SUPPLIER_SETTLEMENT.md）：退货待供应商确认（#20）、预付款与供应商退款的核销（#25）、
-- 费用科目「运费」（#15）、物料的提醒天数（#22）、供应商与期初未付的导入记录（#16）、免确认门槛（#18）。
-- 只加表、加列；迁移前已生效的退货补记「抵了原收货单多少」，不改金额、不改流水。

-- ───────────── 退货待供应商确认（#20） ─────────────
ALTER TABLE inv_docs DROP CONSTRAINT inv_docs_status_check;
ALTER TABLE inv_docs ADD CONSTRAINT inv_docs_status_check
  CHECK (status IN ('draft', 'submitted', 'returned', 'awaiting_supplier', 'confirmed', 'cancelled', 'voided'));
ALTER TABLE inv_docs
  -- 供应商的答复（同意 → 生效；不同意 → 撤回）：登记人、时间、对方同意的日期与说明
  ADD COLUMN supplier_answer_by   bigint REFERENCES staff (id),
  ADD COLUMN supplier_answer_at   timestamptz,
  ADD COLUMN supplier_answer_date date,
  ADD COLUMN supplier_answer_note text CHECK (char_length(supplier_answer_note) <= 200),
  -- 退货扣款抵了原收货单多少：生效时按原收货单还没付、也没在待确认付款里的部分算；多出来的是退货余额（可以核销或退款）
  ADD COLUMN return_applied_cents bigint;
ALTER TABLE inv_docs ADD CONSTRAINT inv_docs_awaiting_check CHECK (status <> 'awaiting_supplier' OR doc_type = 'supplier_return');
ALTER TABLE inv_docs ADD CONSTRAINT inv_docs_return_applied_check
  CHECK (return_applied_cents IS NULL OR (doc_type = 'supplier_return' AND return_applied_cents BETWEEN 0 AND amount_cents));
ALTER TABLE inv_docs ADD CONSTRAINT inv_docs_supplier_answer_check
  CHECK (supplier_answer_at IS NULL OR (doc_type = 'supplier_return' AND supplier_answer_by IS NOT NULL));

-- 迁移前已生效的退货：按「付款优先」补记抵了原收货单多少（原收货单已经付清的，超出的部分是退货余额）。
-- 现付供应商的退货不记应付，以前的退款按「冲销原报销单重新登记」处理过，记为已全部了结（不再显示待退款）。
WITH paid AS (
  SELECT pa.receipt_doc_id AS receipt_id, sum(pa.amount_cents) AS cents
  FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
  WHERE p.status = 'confirmed' AND pa.receipt_doc_id IS NOT NULL
  GROUP BY pa.receipt_doc_id
), ret AS (
  SELECT d.id, d.amount_cents, x.amount_cents AS receipt_cents, coalesce(x.settlement, 'credit') AS settlement,
         coalesce(paid.cents, 0) AS paid_cents,
         coalesce(sum(d.amount_cents) OVER (PARTITION BY d.source_doc_id ORDER BY d.confirmed_at, d.id
                                           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS before_cents
  FROM inv_docs d JOIN inv_docs x ON x.id = d.source_doc_id LEFT JOIN paid ON paid.receipt_id = x.id
  WHERE d.doc_type = 'supplier_return' AND d.status = 'confirmed'
)
UPDATE inv_docs d SET return_applied_cents = CASE
    WHEN ret.settlement = 'cash' THEN ret.amount_cents
    ELSE least(ret.amount_cents, greatest(greatest(ret.receipt_cents - ret.paid_cents, 0) - ret.before_cents, 0))
  END
FROM ret WHERE ret.id = d.id;

-- 单据保护：待供应商确认的退货内容不能改，只能生效或撤回；已生效的新加几列同样不可改
CREATE OR REPLACE FUNCTION yuzu_inv_doc_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '库存单据禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'awaiting_supplier' THEN
    IF (NEW.doc_no, NEW.doc_type, NEW.doc_date, NEW.supplier_id, NEW.department_id, NEW.source_doc_id, NEW.amount_cents,
        NEW.created_by, NEW.created_at, NEW.warehouse_id, NEW.note, NEW.purchase_order_id)
       IS DISTINCT FROM
       (OLD.doc_no, OLD.doc_type, OLD.doc_date, OLD.supplier_id, OLD.department_id, OLD.source_doc_id, OLD.amount_cents,
        OLD.created_by, OLD.created_at, OLD.warehouse_id, OLD.note, OLD.purchase_order_id) THEN
      RAISE EXCEPTION '等供应商确认的退货单内容不可修改' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.status NOT IN ('awaiting_supplier', 'confirmed', 'cancelled') THEN
      RAISE EXCEPTION '等供应商确认的退货单只能生效或撤回' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF OLD.status IN ('confirmed', 'voided') THEN
    IF (NEW.doc_no, NEW.doc_type, NEW.doc_date, NEW.supplier_id, NEW.department_id, NEW.source_doc_id,
        NEW.amount_cents, NEW.created_by, NEW.created_at, NEW.confirmed_by, NEW.confirmed_at, NEW.settlement,
        NEW.warehouse_id, NEW.urgent, NEW.urgent_cap_cents, NEW.co_acceptor_id, NEW.return_applied_cents,
        NEW.supplier_answer_by, NEW.supplier_answer_at, NEW.supplier_answer_date, NEW.supplier_answer_note)
       IS DISTINCT FROM
       (OLD.doc_no, OLD.doc_type, OLD.doc_date, OLD.supplier_id, OLD.department_id, OLD.source_doc_id,
        OLD.amount_cents, OLD.created_by, OLD.created_at, OLD.confirmed_by, OLD.confirmed_at, OLD.settlement,
        OLD.warehouse_id, OLD.urgent, OLD.urgent_cap_cents, OLD.co_acceptor_id, OLD.return_applied_cents,
        OLD.supplier_answer_by, OLD.supplier_answer_at, OLD.supplier_answer_date, OLD.supplier_answer_note) THEN
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

-- 明细保护：待供应商确认的退货明细也不能改
CREATE OR REPLACE FUNCTION yuzu_inv_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  doc_status text;
BEGIN
  SELECT status INTO doc_status FROM inv_docs WHERE id = OLD.doc_id;
  IF doc_status IN ('awaiting_supplier', 'confirmed', 'voided') THEN
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

-- ───────────── 核销：预付款、退货余额抵扣以后的应付（#25、#20） ─────────────
CREATE TABLE ap_offsets (
  id                bigserial PRIMARY KEY,
  doc_no            text NOT NULL UNIQUE,
  supplier_id       bigint NOT NULL REFERENCES suppliers (id),
  offset_date       date NOT NULL,
  -- 可抵扣的一方：预付款（付款没核销完的部分）或退货余额（挂账的退货单）
  credit_payment_id bigint REFERENCES payments (id),
  credit_return_id  bigint REFERENCES inv_docs (id),
  amount_cents      bigint NOT NULL CHECK (amount_cents > 0),
  note              text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  status            text NOT NULL CHECK (status IN ('confirmed', 'voided')),
  client_key        uuid UNIQUE,
  is_synthetic      boolean NOT NULL DEFAULT false,
  created_by        bigint NOT NULL REFERENCES staff (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  voided_by         bigint REFERENCES staff (id),
  voided_at         timestamptz,
  void_reason       text CHECK (char_length(void_reason) <= 200),
  CHECK ((credit_payment_id IS NULL) <> (credit_return_id IS NULL)),
  CHECK ((status = 'voided') = (voided_at IS NOT NULL AND voided_by IS NOT NULL AND void_reason IS NOT NULL))
);
CREATE INDEX ap_offsets_supplier_idx ON ap_offsets (supplier_id, offset_date);
CREATE INDEX ap_offsets_payment_idx ON ap_offsets (credit_payment_id);
CREATE INDEX ap_offsets_return_idx ON ap_offsets (credit_return_id);

-- 核销到哪几笔应付（收货单或期初未付）；只追加
CREATE TABLE ap_offset_lines (
  id                 bigserial PRIMARY KEY,
  offset_id          bigint NOT NULL REFERENCES ap_offsets (id),
  receipt_doc_id     bigint REFERENCES inv_docs (id),
  opening_payable_id bigint REFERENCES opening_payables (id),
  amount_cents       bigint NOT NULL CHECK (amount_cents > 0),
  CHECK ((receipt_doc_id IS NULL) <> (opening_payable_id IS NULL))
);
CREATE UNIQUE INDEX ap_offset_lines_receipt_once ON ap_offset_lines (offset_id, receipt_doc_id) WHERE receipt_doc_id IS NOT NULL;
CREATE UNIQUE INDEX ap_offset_lines_opening_once ON ap_offset_lines (offset_id, opening_payable_id) WHERE opening_payable_id IS NOT NULL;
CREATE INDEX ap_offset_lines_receipt_idx ON ap_offset_lines (receipt_doc_id);
CREATE INDEX ap_offset_lines_opening_idx ON ap_offset_lines (opening_payable_id);
CREATE TRIGGER ap_offset_lines_append_only BEFORE UPDATE OR DELETE ON ap_offset_lines
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- ───────────── 供应商退款（#25、#20） ─────────────
CREATE TABLE supplier_refunds (
  id                bigserial PRIMARY KEY,
  doc_no            text NOT NULL UNIQUE,
  supplier_id       bigint NOT NULL REFERENCES suppliers (id),
  refund_date       date NOT NULL,
  amount_cents      bigint NOT NULL CHECK (amount_cents > 0),
  method            text NOT NULL CHECK (method IN ('bank_transfer', 'wechat', 'alipay', 'cash', 'other')),
  evidence          text NOT NULL CHECK (char_length(btrim(evidence)) BETWEEN 2 AND 200),
  note              text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  -- 退的是哪一笔：预付款，或退货单（挂账的退货余额；现付供应商的退货）
  credit_payment_id bigint REFERENCES payments (id),
  credit_return_id  bigint REFERENCES inv_docs (id),
  -- 挂账的记应付流水「供应商退款」；现付供应商的退货不记应付
  posts_ap          boolean NOT NULL,
  status            text NOT NULL CHECK (status IN ('confirmed', 'voided')),
  client_key        uuid UNIQUE,
  is_synthetic      boolean NOT NULL DEFAULT false,
  created_by        bigint NOT NULL REFERENCES staff (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  voided_by         bigint REFERENCES staff (id),
  voided_at         timestamptz,
  void_reason       text CHECK (char_length(void_reason) <= 200),
  CHECK ((credit_payment_id IS NULL) <> (credit_return_id IS NULL)),
  CHECK (credit_payment_id IS NULL OR posts_ap),
  CHECK ((status = 'voided') = (voided_at IS NOT NULL AND voided_by IS NOT NULL AND void_reason IS NOT NULL))
);
CREATE INDEX supplier_refunds_supplier_idx ON supplier_refunds (supplier_id, refund_date);
CREATE INDEX supplier_refunds_payment_idx ON supplier_refunds (credit_payment_id);
CREATE INDEX supplier_refunds_return_idx ON supplier_refunds (credit_return_id);

-- 核销与退款：内容不可改，只能从「已生效」冲销一次；不能删除
CREATE FUNCTION yuzu_ap_settlement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  fixed text[] := ARRAY['status', 'voided_by', 'voided_at', 'void_reason'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '核销与供应商退款记录禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(NEW) - fixed) IS DISTINCT FROM (to_jsonb(OLD) - fixed) THEN
    RAISE EXCEPTION '核销与供应商退款记录不可修改，只能冲销' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'confirmed' AND NEW.status = 'voided') THEN
    RAISE EXCEPTION '核销与供应商退款记录只能冲销一次' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'voided' AND (to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN
    RAISE EXCEPTION '已冲销的记录不可修改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ap_offsets_guard BEFORE UPDATE OR DELETE ON ap_offsets
  FOR EACH ROW EXECUTE FUNCTION yuzu_ap_settlement_guard();
CREATE TRIGGER supplier_refunds_guard BEFORE UPDATE OR DELETE ON supplier_refunds
  FOR EACH ROW EXECUTE FUNCTION yuzu_ap_settlement_guard();

-- 应付流水加「供应商退款」（正数，把负的往来余额补回来）
ALTER TABLE ap_entries ADD COLUMN supplier_refund_id bigint REFERENCES supplier_refunds (id);
ALTER TABLE ap_entries DROP CONSTRAINT ap_entries_entry_type_check;
ALTER TABLE ap_entries ADD CONSTRAINT ap_entries_entry_type_check
  CHECK (entry_type IN ('opening', 'receipt', 'supplier_return', 'payment', 'refund', 'void'));
CREATE INDEX ap_entries_refund_idx ON ap_entries (supplier_refund_id);

-- 审批记录与操作编号：核销、供应商退款；退货的供应商答复
ALTER TABLE approval_logs DROP CONSTRAINT approval_logs_doc_kind_check;
ALTER TABLE approval_logs ADD CONSTRAINT approval_logs_doc_kind_check
  CHECK (doc_kind IN ('inv_doc', 'purchase_order', 'payment', 'opening_payable', 'expense_claim', 'petty_advance', 'petty_settlement',
                      'purchase_request', 'ap_offset', 'supplier_refund'));
ALTER TABLE approval_logs DROP CONSTRAINT approval_logs_action_check;
ALTER TABLE approval_logs ADD CONSTRAINT approval_logs_action_check
  CHECK (action IN ('create', 'submit', 'approve', 'return', 'cancel', 'void', 'close', 'revise', 'sign', 'supplier_agree', 'supplier_reject'));
ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_op_type_check;
ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'inv_doc', 'purchase_order', 'payment', 'opening_payable',
                     'checkin', 'bill_post', 'tag_swap', 'abandoned', 'checkout', 'table_open', 'table_post', 'table_checkout',
                     'room_checkin', 'room_extend', 'room_deposit', 'room_refund', 'room_close', 'line_move',
                     'expense_claim', 'petty_advance', 'petty_settlement', 'purchase_request', 'ap_offset', 'supplier_refund'));
-- 核销、供应商退款的「结果待确认」可以在服务端确认作废（与费用报销等一样，见 modules/erp-ops.ts）
ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'checkin', 'bill_post', 'tag_swap', 'checkout', 'table_open', 'table_post', 'table_checkout',
                     'room_checkin', 'room_extend', 'room_deposit', 'room_refund', 'room_close', 'line_move',
                     'expense_claim', 'petty_advance', 'petty_settlement', 'purchase_request', 'ap_offset', 'supplier_refund'));

-- ───────────── 运费单独记费用（#15） ─────────────
ALTER TABLE expense_claim_lines DROP CONSTRAINT expense_claim_lines_category_check;
ALTER TABLE expense_claim_lines ADD CONSTRAINT expense_claim_lines_category_check
  CHECK (category IN ('office', 'fixed_asset', 'low_value', 'freight'));

-- ───────────── 按可用天数提醒（#22） ─────────────
ALTER TABLE materials ADD COLUMN cover_days integer CHECK (cover_days BETWEEN 1 AND 90);

-- ───────────── 供应商与期初未付批量导入（#16） ─────────────
CREATE TABLE erp_imports (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('suppliers', 'opening_payables')),
  file_name   text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 200),
  file_sha256 text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  row_count   integer NOT NULL CHECK (row_count > 0),
  total_cents bigint NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  created_by  bigint NOT NULL REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, file_sha256)
);
CREATE TRIGGER erp_imports_append_only BEFORE UPDATE OR DELETE ON erp_imports
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
ALTER TABLE suppliers ADD COLUMN import_id bigint REFERENCES erp_imports (id);
ALTER TABLE opening_payables ADD COLUMN import_id bigint REFERENCES erp_imports (id);

-- ───────────── 规则：免确认门槛（#18，默认 2000 元）、用量统计天数（#22，默认 28 天） ─────────────
INSERT INTO settings (key, value) VALUES ('inventory_approval_threshold_cents', '200000') ON CONFLICT (key) DO NOTHING;
INSERT INTO settings (key, value) VALUES ('inventory_usage_window_days', '28') ON CONFLICT (key) DO NOTHING;
