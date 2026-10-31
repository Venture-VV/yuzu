-- 飞书需求 RQ-005「采购与费用闭环」第一步（v0.7.7，见 docs/EXPENSES.md）：
--   ① 费用报销（BX）：按采购单或按次；发票类型、税点、费用科目、用途、部门、经办人、购买与到货数量；超门槛要负责人确认。
--   ② 备用金：打款（BY）按部门、经办人留名；退回（TH）/ 补付（BF）记在对应的打款上；每笔打款单独平账。
--   ③ 供应商分「挂账」与「现付」：现付供应商的收货不记应付（货款走费用报销），收货单记下确认时的结算方式。
--   ④ 新职责「成本核算」（cost）。
-- 只加表、列与约束；已生效的收货与退货补记结算方式「挂账」（与原来的做法一致），不改其他已有数据。

-- ───────────── 职责：成本核算 ─────────────
ALTER TABLE staff DROP CONSTRAINT staff_duties_check;
ALTER TABLE staff ADD CONSTRAINT staff_duties_check
  CHECK (duties <@ ARRAY['stock', 'purchase', 'payable', 'approve', 'cost']::text[]);

-- ───────────── 供应商的结算方式；收货与退货记下确认时的结算方式 ─────────────
-- credit = 挂账（月结 / 按批次结算，收货记应付）；cash = 现付（下单时付清，收货不记应付，货款走费用报销）
ALTER TABLE suppliers ADD COLUMN settlement text NOT NULL DEFAULT 'credit' CHECK (settlement IN ('credit', 'cash'));
ALTER TABLE inv_docs ADD COLUMN settlement text CHECK (settlement IN ('credit', 'cash'));
UPDATE inv_docs SET settlement = 'credit'
WHERE doc_type IN ('receipt', 'supplier_return') AND status IN ('confirmed', 'voided');

-- 已生效的库存单据：结算方式也不可再改（其余与 002 相同）
CREATE OR REPLACE FUNCTION yuzu_inv_doc_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '库存单据禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status IN ('confirmed', 'voided') THEN
    IF (NEW.doc_no, NEW.doc_type, NEW.doc_date, NEW.supplier_id, NEW.department_id, NEW.source_doc_id,
        NEW.amount_cents, NEW.created_by, NEW.created_at, NEW.confirmed_by, NEW.confirmed_at, NEW.settlement)
       IS DISTINCT FROM
       (OLD.doc_no, OLD.doc_type, OLD.doc_date, OLD.supplier_id, OLD.department_id, OLD.source_doc_id,
        OLD.amount_cents, OLD.created_by, OLD.created_at, OLD.confirmed_by, OLD.confirmed_at, OLD.settlement) THEN
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

-- ───────────── 备用金打款（BY） ─────────────
CREATE TABLE petty_advances (
  id            bigserial PRIMARY KEY,
  doc_no        text NOT NULL UNIQUE,
  department_id bigint NOT NULL REFERENCES departments (id),
  -- 经办人：拿这笔钱去采购的人（个人经手的金额按它查）
  handler_id    bigint NOT NULL REFERENCES staff (id),
  advance_date  date NOT NULL,
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  method        text NOT NULL CHECK (method IN ('bank_transfer', 'wechat', 'alipay', 'cash', 'other')),
  evidence      text NOT NULL CHECK (char_length(btrim(evidence)) BETWEEN 2 AND 200),
  note          text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided')),
  client_key    uuid UNIQUE,
  is_synthetic  boolean NOT NULL DEFAULT false,
  created_by    bigint NOT NULL REFERENCES staff (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  voided_by     bigint REFERENCES staff (id),
  voided_at     timestamptz,
  void_reason   text,
  CHECK ((status = 'voided') = (voided_at IS NOT NULL AND voided_by IS NOT NULL AND void_reason IS NOT NULL))
);
CREATE INDEX petty_advances_dept_date_idx ON petty_advances (department_id, advance_date);
CREATE INDEX petty_advances_date_idx ON petty_advances (advance_date);
CREATE INDEX petty_advances_handler_idx ON petty_advances (handler_id);

-- ───────────── 退回（TH，经办人退给公司）/ 补付（BF，公司补给经办人） ─────────────
CREATE TABLE petty_settlements (
  id            bigserial PRIMARY KEY,
  doc_no        text NOT NULL UNIQUE,
  advance_id    bigint NOT NULL REFERENCES petty_advances (id),
  kind          text NOT NULL CHECK (kind IN ('return', 'topup')),
  settle_date   date NOT NULL,
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  method        text NOT NULL CHECK (method IN ('bank_transfer', 'wechat', 'alipay', 'cash', 'other')),
  evidence      text NOT NULL CHECK (char_length(btrim(evidence)) BETWEEN 2 AND 200),
  note          text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided')),
  client_key    uuid UNIQUE,
  is_synthetic  boolean NOT NULL DEFAULT false,
  created_by    bigint NOT NULL REFERENCES staff (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  voided_by     bigint REFERENCES staff (id),
  voided_at     timestamptz,
  void_reason   text,
  CHECK ((status = 'voided') = (voided_at IS NOT NULL AND voided_by IS NOT NULL AND void_reason IS NOT NULL))
);
CREATE INDEX petty_settlements_advance_idx ON petty_settlements (advance_id);
CREATE INDEX petty_settlements_date_idx ON petty_settlements (settle_date);

-- 打款、退回补付：登记即生效，内容不可改，只能「有效 → 冲销」，不能删除
CREATE FUNCTION yuzu_petty_doc_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '备用金单据禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'voided_by' - 'voided_at' - 'void_reason')
     IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'voided_by' - 'voided_at' - 'void_reason') THEN
    RAISE EXCEPTION '备用金单据的内容不可修改' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'voided' AND (to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN
    RAISE EXCEPTION '已冲销的备用金单据不可修改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER petty_advances_guard BEFORE UPDATE OR DELETE ON petty_advances
  FOR EACH ROW EXECUTE FUNCTION yuzu_petty_doc_guard();
CREATE TRIGGER petty_settlements_guard BEFORE UPDATE OR DELETE ON petty_settlements
  FOR EACH ROW EXECUTE FUNCTION yuzu_petty_doc_guard();

-- ───────────── 费用报销（BX） ─────────────
CREATE TABLE expense_claims (
  id                bigserial PRIMARY KEY,
  doc_no            text NOT NULL UNIQUE,
  expense_date      date NOT NULL,
  department_id     bigint NOT NULL REFERENCES departments (id),
  handler_id        bigint NOT NULL REFERENCES staff (id),
  -- 用途（固定选项，记下登记时的文字）
  purpose           text NOT NULL CHECK (char_length(btrim(purpose)) BETWEEN 1 AND 20),
  -- 钱从哪来：petty = 备用金（必须指明出自哪一笔打款），company = 公司直付
  pay_source        text NOT NULL CHECK (pay_source IN ('petty', 'company')),
  advance_id        bigint REFERENCES petty_advances (id),
  -- 发票：类型（固定选项的键与登记时的名称）、税点（万分之一，1300 = 13%）、发票号
  invoice_type      text NOT NULL CHECK (char_length(invoice_type) BETWEEN 1 AND 32),
  invoice_label     text NOT NULL CHECK (char_length(invoice_label) BETWEEN 1 AND 20),
  tax_rate_bp       integer NOT NULL CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  invoice_no        text NOT NULL DEFAULT '' CHECK (char_length(invoice_no) <= 40),
  -- 按采购单报销（只能是现付供应商的采购单）
  purchase_order_id bigint REFERENCES purchase_orders (id),
  amount_cents      bigint NOT NULL CHECK (amount_cents > 0),
  note              text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  -- 登记时是否超过确认门槛（超过的要负责人确认）
  needs_approval    boolean NOT NULL,
  status            text NOT NULL CHECK (status IN ('submitted', 'returned', 'confirmed', 'cancelled', 'voided')),
  client_key        uuid UNIQUE,
  is_synthetic      boolean NOT NULL DEFAULT false,
  created_by        bigint NOT NULL REFERENCES staff (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  confirmed_by      bigint REFERENCES staff (id),
  confirmed_at      timestamptz,
  -- 退回或撤回的原因
  returned_reason   text,
  voided_by         bigint REFERENCES staff (id),
  voided_at         timestamptz,
  void_reason       text,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((pay_source = 'petty') = (advance_id IS NOT NULL)),
  CHECK (status NOT IN ('confirmed', 'voided') OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)),
  CHECK ((status = 'voided') = (voided_at IS NOT NULL AND voided_by IS NOT NULL AND void_reason IS NOT NULL))
);
CREATE INDEX expense_claims_date_idx ON expense_claims (expense_date);
CREATE INDEX expense_claims_status_idx ON expense_claims (status);
CREATE INDEX expense_claims_advance_idx ON expense_claims (advance_id);
CREATE INDEX expense_claims_po_idx ON expense_claims (purchase_order_id);
CREATE INDEX expense_claims_dept_idx ON expense_claims (department_id, expense_date);

CREATE TABLE expense_claim_lines (
  id             bigserial PRIMARY KEY,
  claim_id       bigint NOT NULL REFERENCES expense_claims (id),
  line_no        integer NOT NULL,
  name           text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  -- 费用科目：办公费 / 固定资产 / 低值易耗
  category       text NOT NULL CHECK (category IN ('office', 'fixed_asset', 'low_value')),
  unit           text NOT NULL CHECK (char_length(btrim(unit)) BETWEEN 1 AND 8),
  -- 购买数量与到货数量（千分之一单位）；不一致时必须写差异原因
  bought_milli   bigint NOT NULL CHECK (bought_milli > 0),
  received_milli bigint NOT NULL CHECK (received_milli >= 0),
  diff_reason    text NOT NULL DEFAULT '' CHECK (char_length(diff_reason) <= 100),
  amount_cents   bigint NOT NULL CHECK (amount_cents > 0),
  -- 按采购单报销：对应的采购单行与物料
  po_line_id     bigint REFERENCES purchase_order_lines (id),
  material_id    bigint REFERENCES materials (id),
  UNIQUE (claim_id, line_no),
  CHECK (bought_milli = received_milli OR char_length(btrim(diff_reason)) >= 2)
);
CREATE INDEX expense_claim_lines_po_line_idx ON expense_claim_lines (po_line_id);
CREATE TRIGGER expense_claim_lines_append_only BEFORE UPDATE OR DELETE ON expense_claim_lines
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- 报销单：内容不可改；状态只按「待确认 → 已确认 / 退回 / 撤回，退回 → 待确认 / 撤回，已确认 → 冲销」走；不能删除
CREATE FUNCTION yuzu_expense_claim_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  fixed text[] := ARRAY['status', 'confirmed_by', 'confirmed_at', 'returned_reason', 'voided_by', 'voided_at', 'void_reason', 'updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '报销单禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(NEW) - fixed) IS DISTINCT FROM (to_jsonb(OLD) - fixed) THEN
    RAISE EXCEPTION '报销单的内容不可修改' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'submitted' AND NEW.status IN ('confirmed', 'returned', 'cancelled'))
    OR (OLD.status = 'returned' AND NEW.status IN ('submitted', 'cancelled'))
    OR (OLD.status = 'confirmed' AND NEW.status = 'voided')) THEN
    RAISE EXCEPTION '报销单不能从 % 改为 %', OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status IN ('confirmed', 'voided') AND (NEW.confirmed_by, NEW.confirmed_at) IS DISTINCT FROM (OLD.confirmed_by, OLD.confirmed_at) THEN
    RAISE EXCEPTION '已确认的报销单不能改确认人' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status IN ('cancelled', 'voided') AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION '已撤回或冲销的报销单不可修改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER expense_claims_guard BEFORE UPDATE OR DELETE ON expense_claims
  FOR EACH ROW EXECUTE FUNCTION yuzu_expense_claim_guard();

-- ───────────── 审批记录、幂等：新单据类型 ─────────────
ALTER TABLE approval_logs DROP CONSTRAINT approval_logs_doc_kind_check;
ALTER TABLE approval_logs ADD CONSTRAINT approval_logs_doc_kind_check
  CHECK (doc_kind IN ('inv_doc', 'purchase_order', 'payment', 'opening_payable', 'expense_claim', 'petty_advance', 'petty_settlement'));

ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_op_type_check;
ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'inv_doc', 'purchase_order', 'payment', 'opening_payable',
                     'checkin', 'bill_post', 'tag_swap', 'abandoned', 'checkout', 'table_open', 'table_post', 'table_checkout',
                     'room_checkin', 'room_extend', 'room_deposit', 'room_refund', 'room_close', 'line_move',
                     'expense_claim', 'petty_advance', 'petty_settlement'));
