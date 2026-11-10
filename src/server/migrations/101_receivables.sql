-- 8.0.7 ERP P2 3.1（docs/ERP_V807.md）：应收与挂账。
--   · 协议单位 ar_accounts：名称、联系人、电话、挂账额度（空 = 不限，V11）、启用；不能删，不用了停用。
--   · 结账多一种收款方式「挂账」（on_account）：选协议单位、写签单人；要岗位权限「挂账」（V12）。挂账算营业额（应收、净营业额），
--     不算实收（与团购券一样）；退款单不能退挂账的部分（要反结账）。结账时在已有的锁之后锁协议单位一行，额度在锁里核对。
--   · 挂账 ar_charges：一笔挂账收款一条；反结账时作废（已经回款核销过的不能反结账，AR_COLLECTED，要先冲销那笔回款）。
--   · 回款 ar_collections 与核销 ar_allocations：财务登记回款（日期、方式、金额、凭据），核销到这个单位没结清的挂账；
--     不能超过没结清的金额；当月可以冲销（只追加，冲销写原因）。回款在 ERP 里，不进前台交班、日结（V13）。
--   · 「确认作废」加业务类型：回款登记（ar_collection）、资产建卡（asset_card，迁移 102 用）。放在 092–094 之后（它们重建过这条约束）。

CREATE TABLE ar_accounts (
  id                 bigserial PRIMARY KEY,
  code               text NOT NULL UNIQUE CHECK (code ~ '^[A-Za-z0-9-]{1,16}$'),
  name               text NOT NULL UNIQUE CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  contact            text NOT NULL DEFAULT '' CHECK (char_length(contact) <= 40),
  phone              text NOT NULL DEFAULT '' CHECK (char_length(phone) <= 32),
  -- 挂账额度（分）：空 = 不限
  credit_limit_cents bigint CHECK (credit_limit_cents IS NULL OR credit_limit_cents > 0),
  active             boolean NOT NULL DEFAULT true,
  note               text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  version            integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by         bigint NOT NULL REFERENCES staff (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER ar_accounts_no_delete BEFORE DELETE ON ar_accounts
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- ───────────── 结账收款加「挂账」 ─────────────
ALTER TABLE checkout_payments DROP CONSTRAINT checkout_payments_method_check;
ALTER TABLE checkout_payments ADD CONSTRAINT checkout_payments_method_check
  CHECK (method IN ('cash', 'wechat', 'alipay', 'bank_card', 'other', 'wallet', 'coupon', 'discount', 'store_coupon', 'member_discount', 'count_card', 'on_account'));
ALTER TABLE checkout_payments ADD COLUMN ar_account_id bigint REFERENCES ar_accounts (id);
ALTER TABLE checkout_payments ADD CONSTRAINT checkout_payments_on_account_check CHECK ((method = 'on_account') = (ar_account_id IS NOT NULL));

-- ───────────── 挂账 ─────────────
CREATE TABLE ar_charges (
  id            bigserial PRIMARY KEY,
  account_id    bigint NOT NULL REFERENCES ar_accounts (id),
  checkout_id   bigint NOT NULL REFERENCES checkouts (id),
  payment_id    bigint NOT NULL UNIQUE REFERENCES checkout_payments (id),
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  business_date date NOT NULL,
  signer        text NOT NULL CHECK (char_length(btrim(signer)) BETWEEN 1 AND 20),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'voided')),
  voided_by     bigint REFERENCES staff (id),
  voided_at     timestamptz,
  created_by    bigint NOT NULL REFERENCES staff (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'voided') = (voided_at IS NOT NULL) AND (voided_at IS NULL) = (voided_by IS NULL))
);
CREATE INDEX ar_charges_account_idx ON ar_charges (account_id, business_date, id);
CREATE INDEX ar_charges_checkout_idx ON ar_charges (checkout_id);

CREATE FUNCTION yuzu_ar_charge_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '挂账不能删除，反结账时作废' USING ERRCODE = 'P0001'; END IF;
  IF (NEW.account_id, NEW.checkout_id, NEW.payment_id, NEW.amount_cents, NEW.business_date, NEW.signer, NEW.created_by, NEW.created_at)
       IS DISTINCT FROM (OLD.account_id, OLD.checkout_id, OLD.payment_id, OLD.amount_cents, OLD.business_date, OLD.signer, OLD.created_by, OLD.created_at)
     OR OLD.status <> 'open' THEN
    RAISE EXCEPTION '挂账只能作废一次，别的不能改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ar_charges_guard BEFORE UPDATE OR DELETE ON ar_charges
  FOR EACH ROW EXECUTE FUNCTION yuzu_ar_charge_guard();

-- ───────────── 回款与核销 ─────────────
CREATE TABLE ar_collections (
  id           bigserial PRIMARY KEY,
  doc_no       text NOT NULL UNIQUE,
  account_id   bigint NOT NULL REFERENCES ar_accounts (id),
  collected_on date NOT NULL,
  method       text NOT NULL CHECK (method IN ('bank_transfer', 'cash', 'wechat', 'alipay', 'other')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  evidence     text NOT NULL DEFAULT '' CHECK (char_length(evidence) <= 64),
  note         text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  client_key   uuid NOT NULL UNIQUE,
  request_hash text NOT NULL,
  created_by   bigint NOT NULL REFERENCES staff (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  voided_by    bigint REFERENCES staff (id),
  voided_at    timestamptz,
  void_reason  text CHECK (void_reason IS NULL OR char_length(btrim(void_reason)) BETWEEN 2 AND 200),
  CHECK ((voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX ar_collections_account_idx ON ar_collections (account_id, collected_on);

CREATE FUNCTION yuzu_ar_collection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '回款登记不能删除，只能冲销' USING ERRCODE = 'P0001'; END IF;
  IF (NEW.doc_no, NEW.account_id, NEW.collected_on, NEW.method, NEW.amount_cents, NEW.evidence, NEW.note, NEW.client_key, NEW.request_hash, NEW.created_by, NEW.created_at)
       IS DISTINCT FROM (OLD.doc_no, OLD.account_id, OLD.collected_on, OLD.method, OLD.amount_cents, OLD.evidence, OLD.note, OLD.client_key, OLD.request_hash, OLD.created_by, OLD.created_at)
     OR OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION '回款登记只能冲销一次，别的不能改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ar_collections_guard BEFORE UPDATE OR DELETE ON ar_collections
  FOR EACH ROW EXECUTE FUNCTION yuzu_ar_collection_guard();

CREATE TABLE ar_allocations (
  collection_id bigint NOT NULL REFERENCES ar_collections (id),
  charge_id     bigint NOT NULL REFERENCES ar_charges (id),
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  PRIMARY KEY (collection_id, charge_id)
);
CREATE INDEX ar_allocations_charge_idx ON ar_allocations (charge_id);
CREATE TRIGGER ar_allocations_append_only BEFORE UPDATE OR DELETE ON ar_allocations
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- ───────────── 「确认作废」加业务类型 ─────────────
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
                     'payment_request', 'contract_payout', 'contract_acceptance', 'contract_quality', 'supplier_invoice', 'canteen_reply',
                     'request_import', 'gift_receipt', 'coupon_campaign', 'ar_collection', 'asset_card'));
