-- v0.7.32（主线）付款流 第二部分（docs/PAYMENTS.md 第 4 节，默认 P8 待确认）：三单匹配。
--   · 发票登记：供应商开来的发票（发票号码、开票日、价税合计、税额、税率），分到哪几张采购单、各分多少（合计等于价税合计）；
--     同一供应商同一发票号码只能有一张没作废的；登错了作废（写原因）。v0.7.33 再扩成完整的发票台账（认证状态、到期提醒、异常票）；
--   · 三单放行：采购单的收货与发票差额超过门槛（挂起）时，财务写原因放行，记下放行时的三个金额（之后变了要重新放行）；
--   · 「确认作废」加一类：登记发票。
-- 只加表、放宽约束，不改任何已有数据。

CREATE TABLE supplier_invoices (
  id            bigserial PRIMARY KEY,
  invoice_no    text NOT NULL CHECK (char_length(btrim(invoice_no)) BETWEEN 1 AND 30),
  supplier_id   bigint NOT NULL REFERENCES suppliers (id),
  invoice_date  date NOT NULL,
  -- 价税合计、税额（整数分）、税率（万分比）
  total_cents   bigint NOT NULL CHECK (total_cents > 0),
  tax_cents     bigint NOT NULL CHECK (tax_cents >= 0),
  tax_rate_bp   integer NOT NULL CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  note          text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  status        text NOT NULL DEFAULT 'valid' CHECK (status IN ('valid', 'voided')),
  voided_by     bigint REFERENCES staff (id),
  voided_at     timestamptz,
  void_reason   text CHECK (void_reason IS NULL OR char_length(btrim(void_reason)) BETWEEN 2 AND 200),
  client_key    uuid NOT NULL UNIQUE,
  request_hash  text NOT NULL,
  created_by    bigint NOT NULL REFERENCES staff (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (tax_cents <= total_cents),
  CHECK ((status = 'voided') = (voided_at IS NOT NULL)),
  CHECK ((voided_at IS NULL) = (voided_by IS NULL)),
  CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
-- 同一供应商同一发票号码只能有一张没作废的
CREATE UNIQUE INDEX supplier_invoices_no ON supplier_invoices (supplier_id, invoice_no) WHERE status = 'valid';
CREATE INDEX supplier_invoices_supplier_idx ON supplier_invoices (supplier_id);
CREATE OR REPLACE FUNCTION yuzu_supplier_invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '发票登记不能删除，只能作废'; END IF;
  IF OLD.status <> 'valid' OR NEW.status <> 'voided'
     OR NEW.invoice_no <> OLD.invoice_no OR NEW.supplier_id <> OLD.supplier_id OR NEW.invoice_date <> OLD.invoice_date
     OR NEW.total_cents <> OLD.total_cents OR NEW.tax_cents <> OLD.tax_cents OR NEW.tax_rate_bp <> OLD.tax_rate_bp
     OR NEW.note <> OLD.note OR NEW.client_key <> OLD.client_key OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION '发票登记只能作废一次，不能改';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER supplier_invoices_guard BEFORE UPDATE OR DELETE ON supplier_invoices
  FOR EACH ROW EXECUTE FUNCTION yuzu_supplier_invoice_guard();

-- 发票分到采购单的金额（只追加；发票作废以后这些行不再算）
CREATE TABLE supplier_invoice_lines (
  id                bigserial PRIMARY KEY,
  invoice_id        bigint NOT NULL REFERENCES supplier_invoices (id),
  purchase_order_id bigint NOT NULL REFERENCES purchase_orders (id),
  amount_cents      bigint NOT NULL CHECK (amount_cents > 0),
  UNIQUE (invoice_id, purchase_order_id)
);
CREATE INDEX supplier_invoice_lines_po_idx ON supplier_invoice_lines (purchase_order_id);
CREATE TRIGGER supplier_invoice_lines_append_only BEFORE UPDATE OR DELETE ON supplier_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- 三单放行（只追加）：放行时的采购单金额、已收货（减退货）、已开票；三个金额都没变才算放行有效
CREATE TABLE po_match_releases (
  id                bigserial PRIMARY KEY,
  purchase_order_id bigint NOT NULL REFERENCES purchase_orders (id),
  po_total_cents    bigint NOT NULL,
  received_cents    bigint NOT NULL,
  invoiced_cents    bigint NOT NULL,
  reason            text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 2 AND 200),
  client_key        uuid NOT NULL UNIQUE,
  request_hash      text NOT NULL,
  created_by        bigint NOT NULL REFERENCES staff (id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX po_match_releases_po_idx ON po_match_releases (purchase_order_id);
CREATE TRIGGER po_match_releases_append_only BEFORE UPDATE OR DELETE ON po_match_releases
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- ───────────── 「确认作废」加一类：登记发票 ─────────────
ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'checkin', 'bill_post', 'tag_swap', 'checkout', 'table_open', 'table_post', 'table_checkout',
                     'room_checkin', 'room_extend', 'room_deposit', 'room_refund', 'room_close', 'line_move',
                     'expense_claim', 'petty_advance', 'petty_settlement', 'purchase_request', 'ap_offset', 'supplier_refund', 'erp_import',
                     'supplier_recon', 'supplier_recon_void', 'space_import', 'location_report', 'usage_open', 'usage_end', 'usage_cancel',
                     'checkout_refund', 'coupon_template', 'coupon_rule', 'coupon_batch', 'coupon_issue',
                     'device_create', 'device_job', 'payment', 'opening_payable', 'grade_adjust', 'benefit_use', 'member_trial',
                     'member_refund', 'member_status', 'member_merge', 'booking_create', 'booking_change',
                     'count_card_sale', 'count_card_refund', 'platform_redemption', 'platform_settlement', 'doc_print', 'member_card',
                     'approval_rule', 'approval_delegation', 'contract_create', 'contract_change', 'contract_seal',
                     'payment_request', 'contract_payout', 'contract_acceptance', 'contract_quality', 'supplier_invoice'));
