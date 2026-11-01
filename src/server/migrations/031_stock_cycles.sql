-- v0.7.13 · Batch 4 收尾（docs/STOCK_CYCLES.md）：台面日耗品与称重（#14）、每月盘点与供应商对账提醒（#23）。
-- 只加表、加列。台面日耗品的自动耗用记在领料单（或急采单）自己的流水里（部门小仓的「耗用」），不另建单据。

-- ───────────── 物料：台面日耗品、称重（#14） ─────────────
ALTER TABLE materials
  ADD COLUMN counter_use boolean NOT NULL DEFAULT false,  -- 台面日耗品：领到部门即算耗用，部门小仓不留结存、不再清点
  ADD COLUMN weighed     boolean NOT NULL DEFAULT false;  -- 称重：按实际称重记数量，收货可以比采购单多出容差
ALTER TABLE materials ADD CONSTRAINT materials_weighed_decimals CHECK (NOT weighed OR decimals >= 1);

-- ───────────── 供应商：挂账的对账方式（#23） ─────────────
ALTER TABLE suppliers
  ADD COLUMN reconcile_cycle text NOT NULL DEFAULT 'monthly' CHECK (reconcile_cycle IN ('monthly', 'batch')),
  -- 改成按批次的日期：之前的收货不提醒对账（不翻旧账）
  ADD COLUMN reconcile_since date;

-- ───────────── 对账登记（#23）：只追加，撤销只能一次 ─────────────
CREATE TABLE supplier_reconciliations (
  id             bigserial PRIMARY KEY,
  supplier_id    bigint NOT NULL REFERENCES suppliers (id),
  kind           text NOT NULL CHECK (kind IN ('month', 'batch')),
  -- 月结：对的是哪个月（那个月的 1 号）
  period_month   date CHECK (period_month IS NULL OR extract(day FROM period_month) = 1),
  -- 登记时的数字。月结：那个月对账单的期初余额、期初未付登记、收货、退货扣款、付款、供应商退款、期末余额；
  -- 按批次：只有合计（各张收货单的货款在明细表）
  begin_cents         bigint,
  opening_cents       bigint,
  received_cents      bigint,
  return_credit_cents bigint,
  paid_cents          bigint,
  refunded_cents      bigint,
  end_cents           bigint,
  total_cents         bigint NOT NULL,
  note           text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  client_key     uuid UNIQUE,
  is_synthetic   boolean NOT NULL DEFAULT false,
  created_by     bigint NOT NULL REFERENCES staff (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  voided_by      bigint REFERENCES staff (id),
  voided_at      timestamptz,
  void_reason    text CHECK (char_length(void_reason) <= 200),
  CHECK ((kind = 'month') = (period_month IS NOT NULL)),
  CHECK (kind = 'batch' OR (begin_cents IS NOT NULL AND opening_cents IS NOT NULL AND received_cents IS NOT NULL
                            AND return_credit_cents IS NOT NULL AND paid_cents IS NOT NULL AND refunded_cents IS NOT NULL
                            AND end_cents IS NOT NULL AND total_cents = end_cents)),
  CHECK ((voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL) = (void_reason IS NULL))
);
-- 同一供应商同一月份最多一条有效的月结登记
CREATE UNIQUE INDEX supplier_recon_month_once ON supplier_reconciliations (supplier_id, period_month)
  WHERE kind = 'month' AND voided_at IS NULL;
CREATE INDEX supplier_recon_supplier_idx ON supplier_reconciliations (supplier_id, id);

-- 按批次登记包含的收货单与登记时的货款
CREATE TABLE supplier_reconciliation_docs (
  reconciliation_id bigint NOT NULL REFERENCES supplier_reconciliations (id),
  doc_id            bigint NOT NULL REFERENCES inv_docs (id),
  amount_cents      bigint NOT NULL,
  PRIMARY KEY (reconciliation_id, doc_id)
);
CREATE INDEX supplier_recon_docs_doc_idx ON supplier_reconciliation_docs (doc_id);
CREATE TRIGGER supplier_recon_docs_append_only BEFORE UPDATE OR DELETE ON supplier_reconciliation_docs
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- 登记内容不可改、不能删除；撤销人、时间、原因只能从空写一次
CREATE FUNCTION yuzu_supplier_recon_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  voiding text[] := ARRAY['voided_by', 'voided_at', 'void_reason'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '对账登记禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(NEW) - voiding) IS DISTINCT FROM (to_jsonb(OLD) - voiding) THEN
    RAISE EXCEPTION '对账登记不可修改，只能撤销' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.voided_at IS NOT NULL AND (to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN
    RAISE EXCEPTION '对账登记已撤销，不可再改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER supplier_recon_guard BEFORE UPDATE OR DELETE ON supplier_reconciliations
  FOR EACH ROW EXECUTE FUNCTION yuzu_supplier_recon_guard();

-- ───────────── 操作编号与作废登记认「对账登记」 ─────────────
ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_op_type_check;
ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'inv_doc', 'purchase_order', 'payment', 'opening_payable',
                     'checkin', 'bill_post', 'tag_swap', 'abandoned', 'checkout', 'table_open', 'table_post', 'table_checkout',
                     'room_checkin', 'room_extend', 'room_deposit', 'room_refund', 'room_close', 'line_move',
                     'expense_claim', 'petty_advance', 'petty_settlement', 'purchase_request', 'ap_offset', 'supplier_refund', 'erp_import',
                     'supplier_recon'));
ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'checkin', 'bill_post', 'tag_swap', 'checkout', 'table_open', 'table_post', 'table_checkout',
                     'room_checkin', 'room_extend', 'room_deposit', 'room_refund', 'room_close', 'line_move',
                     'expense_claim', 'petty_advance', 'petty_settlement', 'purchase_request', 'ap_offset', 'supplier_refund', 'erp_import',
                     'supplier_recon'));
