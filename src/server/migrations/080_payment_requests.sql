-- v0.7.32（主线）付款流 第一部分（docs/PAYMENTS.md，默认 P1–P12 待确认）：
--   · 付款申请：从合同的某一段（预付 / 到货 / 验收 / 质保）或没挂合同的应付（收货单、期初未付）发起，提交即走审批中心
--     （单据类型「付款申请」，提前付款是「提前付款」）；批了以后按申请登记付款，不再审一次；
--   · 付款登记挂申请（payments.payment_request_id）；服务、租赁、其他合同没有收货单、不记应付，批了以后在申请上登记
--     「合同付款」（contract_payouts，不进供应商往来）；
--   · 合同的验收登记、质量问题登记（只追加，登错了作废；质量问题处理完标记已处理）；
--   · 审批中心加两种单据（付款申请、提前付款），「确认作废」加四类。
-- 只加表、加列、放宽约束，不改任何已有数据：已登记的付款照旧，只有新提交的走付款申请。

-- ───────────── 付款申请 ─────────────
CREATE TABLE payment_requests (
  id              bigserial PRIMARY KEY,
  request_no      text NOT NULL UNIQUE,
  -- 收款方：按应付付款（pay_mode = 'ap'）的要有供应商档案；服务、租赁、其他合同可以没有，收款方写合同的相对方
  supplier_id     bigint REFERENCES suppliers (id),
  payee           text NOT NULL CHECK (char_length(btrim(payee)) BETWEEN 1 AND 60),
  -- 合同的哪一段（没挂合同的为空，选的收货单 / 期初未付在 payment_request_targets）
  contract_id     bigint REFERENCES contracts (id),
  stage           text CHECK (stage IN ('prepay', 'delivery', 'acceptance', 'warranty')),
  -- ap：付款登记（进供应商往来，核销到收货单 / 期初未付或记预付款）；direct：在申请上登记合同付款（不进供应商往来）
  pay_mode        text NOT NULL CHECK (pay_mode IN ('ap', 'direct')),
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  -- 提前付款（P6）：这一段还没到条件、或申请金额超过可付金额，单据类型「提前付款」、要写原因
  early           boolean NOT NULL DEFAULT false,
  early_reason    text NOT NULL DEFAULT '' CHECK (char_length(early_reason) <= 200),
  expected_date   date NOT NULL,
  purpose         text NOT NULL CHECK (char_length(btrim(purpose)) BETWEEN 2 AND 200),
  -- 审批规则按部门匹配：合同的部门（没挂合同的为空）
  department_id   bigint REFERENCES departments (id),
  -- submitted 审批中 / returned 已退回（含撤回，可以改了再提交）/ approved 待付款 / paid 已付 / ended 付了一部分、结束 / voided 已作废
  status          text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'returned', 'approved', 'paid', 'ended', 'voided')),
  returned_reason text CHECK (returned_reason IS NULL OR char_length(returned_reason) <= 200),
  submitted_by    bigint NOT NULL REFERENCES staff (id),
  submitted_at    timestamptz NOT NULL DEFAULT now(),
  approved_at     timestamptz,
  -- 结束、作废
  closed_reason   text CHECK (closed_reason IS NULL OR char_length(btrim(closed_reason)) BETWEEN 2 AND 200),
  closed_by       bigint REFERENCES staff (id),
  closed_at       timestamptz,
  -- 改内容、改状态的乐观锁
  version         integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  client_key      uuid NOT NULL UNIQUE,
  request_hash    text NOT NULL,
  created_by      bigint NOT NULL REFERENCES staff (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((contract_id IS NULL) = (stage IS NULL)),
  CHECK (pay_mode = 'direct' OR supplier_id IS NOT NULL),
  CHECK (pay_mode = 'ap' OR contract_id IS NOT NULL),
  CHECK (NOT early OR (contract_id IS NOT NULL AND char_length(btrim(early_reason)) >= 2)),
  CHECK ((status IN ('ended', 'voided')) = (closed_at IS NOT NULL)),
  CHECK ((closed_at IS NULL) = (closed_reason IS NULL)),
  CHECK ((status IN ('approved', 'paid', 'ended')) <= (approved_at IS NOT NULL))
);
CREATE INDEX payment_requests_contract_idx ON payment_requests (contract_id, stage) WHERE contract_id IS NOT NULL;
CREATE INDEX payment_requests_status_idx ON payment_requests (status);
CREATE INDEX payment_requests_supplier_idx ON payment_requests (supplier_id) WHERE supplier_id IS NOT NULL;

-- 没挂合同的申请选的收货单、期初未付与各自金额（退回后改了再提交时整组换掉）
CREATE TABLE payment_request_targets (
  id                 bigserial PRIMARY KEY,
  request_id         bigint NOT NULL REFERENCES payment_requests (id),
  receipt_doc_id     bigint REFERENCES inv_docs (id),
  opening_payable_id bigint REFERENCES opening_payables (id),
  amount_cents       bigint NOT NULL CHECK (amount_cents > 0),
  CHECK ((receipt_doc_id IS NULL) <> (opening_payable_id IS NULL))
);
CREATE UNIQUE INDEX payment_request_targets_receipt ON payment_request_targets (request_id, receipt_doc_id) WHERE receipt_doc_id IS NOT NULL;
CREATE UNIQUE INDEX payment_request_targets_opening ON payment_request_targets (request_id, opening_payable_id) WHERE opening_payable_id IS NOT NULL;
CREATE INDEX payment_request_targets_receipt_idx ON payment_request_targets (receipt_doc_id) WHERE receipt_doc_id IS NOT NULL;

-- 付款登记挂申请（按申请登记的付款不再走付款的审批，P7）
ALTER TABLE payments ADD COLUMN payment_request_id bigint REFERENCES payment_requests (id);
CREATE INDEX payments_request_idx ON payments (payment_request_id) WHERE payment_request_id IS NOT NULL;

-- ───────────── 合同付款（服务、租赁、其他合同：没有收货单、不记应付，不进供应商往来） ─────────────
CREATE TABLE contract_payouts (
  id                 bigserial PRIMARY KEY,
  doc_no             text NOT NULL UNIQUE,
  payment_request_id bigint NOT NULL REFERENCES payment_requests (id),
  pay_date           date NOT NULL,
  amount_cents       bigint NOT NULL CHECK (amount_cents > 0),
  method             text NOT NULL CHECK (method IN ('bank_transfer', 'wechat', 'alipay', 'cash', 'other')),
  evidence           text NOT NULL CHECK (char_length(btrim(evidence)) BETWEEN 2 AND 200),
  note               text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  status             text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'voided')),
  voided_by          bigint REFERENCES staff (id),
  voided_at          timestamptz,
  void_reason        text CHECK (void_reason IS NULL OR char_length(btrim(void_reason)) BETWEEN 2 AND 200),
  client_key         uuid NOT NULL UNIQUE,
  request_hash       text NOT NULL,
  created_by         bigint NOT NULL REFERENCES staff (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'voided') = (voided_at IS NOT NULL)),
  CHECK ((voided_at IS NULL) = (voided_by IS NULL)),
  CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX contract_payouts_request_idx ON contract_payouts (payment_request_id);
CREATE OR REPLACE FUNCTION yuzu_contract_payout_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '合同付款不能删除，只能冲销'; END IF;
  IF OLD.status <> 'confirmed' OR NEW.status <> 'voided'
     OR NEW.doc_no <> OLD.doc_no OR NEW.payment_request_id <> OLD.payment_request_id OR NEW.pay_date <> OLD.pay_date
     OR NEW.amount_cents <> OLD.amount_cents OR NEW.method <> OLD.method OR NEW.evidence <> OLD.evidence OR NEW.note <> OLD.note
     OR NEW.client_key <> OLD.client_key OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION '合同付款只能冲销一次，不能改';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contract_payouts_guard BEFORE UPDATE OR DELETE ON contract_payouts
  FOR EACH ROW EXECUTE FUNCTION yuzu_contract_payout_guard();

-- ───────────── 验收登记（只追加；登错了作废，以最近一条没作废的为准） ─────────────
CREATE TABLE contract_acceptances (
  id           bigserial PRIMARY KEY,
  contract_id  bigint NOT NULL REFERENCES contracts (id),
  accepted_on  date NOT NULL,
  result       text NOT NULL CHECK (result IN ('pass', 'fail')),
  signer       text NOT NULL CHECK (char_length(btrim(signer)) BETWEEN 1 AND 20),
  note         text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  voided_by    bigint REFERENCES staff (id),
  voided_at    timestamptz,
  void_reason  text CHECK (void_reason IS NULL OR char_length(btrim(void_reason)) BETWEEN 2 AND 200),
  client_key   uuid NOT NULL UNIQUE,
  request_hash text NOT NULL,
  created_by   bigint NOT NULL REFERENCES staff (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- 不合格要写怎么处理
  CHECK (result = 'pass' OR char_length(btrim(note)) >= 2),
  CHECK ((voided_at IS NULL) = (voided_by IS NULL)),
  CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX contract_acceptances_contract_idx ON contract_acceptances (contract_id);
CREATE OR REPLACE FUNCTION yuzu_contract_acceptance_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '验收登记不能删除，只能作废'; END IF;
  IF OLD.voided_at IS NOT NULL OR NEW.voided_at IS NULL
     OR NEW.contract_id <> OLD.contract_id OR NEW.accepted_on <> OLD.accepted_on OR NEW.result <> OLD.result
     OR NEW.signer <> OLD.signer OR NEW.note <> OLD.note OR NEW.client_key <> OLD.client_key
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION '验收登记只能作废一次，不能改';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contract_acceptances_guard BEFORE UPDATE OR DELETE ON contract_acceptances
  FOR EACH ROW EXECUTE FUNCTION yuzu_contract_acceptance_guard();

-- ───────────── 质量问题登记（未处理 → 已处理，或登错了作废） ─────────────
CREATE TABLE contract_quality_issues (
  id           bigserial PRIMARY KEY,
  contract_id  bigint NOT NULL REFERENCES contracts (id),
  found_on     date NOT NULL,
  description  text NOT NULL CHECK (char_length(btrim(description)) BETWEEN 2 AND 200),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'voided')),
  resolved_on  date,
  resolution   text CHECK (resolution IS NULL OR char_length(btrim(resolution)) BETWEEN 2 AND 200),
  resolved_by  bigint REFERENCES staff (id),
  resolved_at  timestamptz,
  void_reason  text CHECK (void_reason IS NULL OR char_length(btrim(void_reason)) BETWEEN 2 AND 200),
  voided_by    bigint REFERENCES staff (id),
  voided_at    timestamptz,
  client_key   uuid NOT NULL UNIQUE,
  request_hash text NOT NULL,
  created_by   bigint NOT NULL REFERENCES staff (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL)),
  CHECK ((resolved_at IS NULL) = (resolved_by IS NULL) AND (resolved_at IS NULL) = (resolved_on IS NULL) AND (resolved_at IS NULL) = (resolution IS NULL)),
  CHECK ((status = 'voided') = (voided_at IS NOT NULL)),
  CHECK ((voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL) = (void_reason IS NULL)),
  CHECK (resolved_on IS NULL OR resolved_on >= found_on)
);
CREATE INDEX contract_quality_issues_contract_idx ON contract_quality_issues (contract_id);
CREATE INDEX contract_quality_issues_open_idx ON contract_quality_issues (contract_id) WHERE status = 'open';
CREATE OR REPLACE FUNCTION yuzu_contract_quality_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '质量问题登记不能删除，只能作废'; END IF;
  IF OLD.status <> 'open' OR NEW.status NOT IN ('resolved', 'voided')
     OR NEW.contract_id <> OLD.contract_id OR NEW.found_on <> OLD.found_on OR NEW.description <> OLD.description
     OR NEW.client_key <> OLD.client_key OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION '质量问题登记只能从未处理改成已处理或作废一次';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contract_quality_issues_guard BEFORE UPDATE OR DELETE ON contract_quality_issues
  FOR EACH ROW EXECUTE FUNCTION yuzu_contract_quality_guard();

-- ───────────── 审批中心：两种单据（付款申请、提前付款） ─────────────
ALTER TABLE approval_rules DROP CONSTRAINT approval_rules_doc_type_check;
ALTER TABLE approval_rules ADD CONSTRAINT approval_rules_doc_type_check
  CHECK (doc_type IN ('purchase_order', 'damage', 'supplier_return', 'opening', 'payment', 'expense_claim', 'stocktake',
                      'contract', 'contract_change', 'contract_seal', 'payment_request', 'payment_early'));
ALTER TABLE approval_requests DROP CONSTRAINT approval_requests_doc_kind_check;
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_doc_kind_check
  CHECK (doc_kind IN ('purchase_order', 'inv_doc', 'payment', 'opening_payable', 'expense_claim', 'contract', 'contract_change', 'contract_seal',
                      'payment_request'));
ALTER TABLE approval_requests DROP CONSTRAINT approval_requests_doc_type_check;
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_doc_type_check
  CHECK (doc_type IN ('purchase_order', 'damage', 'supplier_return', 'opening', 'payment', 'expense_claim', 'stocktake',
                      'contract', 'contract_change', 'contract_seal', 'payment_request', 'payment_early'));

-- ───────────── 「确认作废」加四类：付款申请、合同付款、验收登记、质量问题登记（同 077；发票在 081 加） ─────────────
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
                     'payment_request', 'contract_payout', 'contract_acceptance', 'contract_quality'));
