-- 8.0.21 开票申请（docs/FINANCE_V8021.md 第 3 节，CW-B / CW2 / CW13–CW15）与对外调用记录（docs/INTEGRATIONS_V8021.md 第 1 节）。
--
--   · invoice_requests：给客人开票（销项）的申请。来源是结账单、会员充值、协议单位回款；可开金额 = 来源的实收
--     （结账单去掉储值、券、优惠、挂账，减掉已生效的退款；储值在充值时开；协议单位按回款开）。
--     同一来源同时只有一张「申请中 / 已开」的（部分唯一索引）；红冲 = 作废已开的 + 重新申请。
--     申请的内容（来源、金额、抬头、税号……）建了不改；处理（开出、驳回、作废）只改状态那几列，带版本号。
--   · integration_calls：每次调对外接口（开票服务商、支付、平台验券、银企直连、OTA）记一行，只追加；
--     请求、结果只存打码后的摘要，不存付款码、密钥、完整手机号。原定放在 148，开票「交给服务商开」先用到，挪到这里建。
--   · 「确认作废」加业务类型 invoice_request；erp_files 加一类 sales_invoice（开出来的发票 PDF）。两处都在当时的约束上追加。

CREATE TABLE invoice_requests (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_no      text NOT NULL UNIQUE,
  source_type     text NOT NULL CHECK (source_type IN ('checkout', 'recharge', 'ar_collection')),
  source_id       bigint NOT NULL,
  -- 来源的单号（结账单号、充值单号、回款单号），页面上显示用
  source_no       text NOT NULL,
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  title_type      text NOT NULL CHECK (title_type IN ('personal', 'company')),
  title           text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 100),
  tax_no          text NOT NULL DEFAULT '' CHECK (tax_no = '' OR tax_no ~ '^[0-9A-Z]{15,20}$'),
  email           text NOT NULL DEFAULT '' CHECK (char_length(email) <= 100),
  phone           text NOT NULL DEFAULT '' CHECK (char_length(phone) <= 20),
  invoice_kind    text NOT NULL CHECK (invoice_kind IN ('normal', 'special')),
  note            text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  status          text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'issued', 'rejected', 'voided')),
  -- 开出以后
  invoice_no      text CHECK (invoice_no IS NULL OR char_length(btrim(invoice_no)) BETWEEN 1 AND 40),
  invoice_date    date,
  file_id         bigint REFERENCES erp_files (id),
  -- manual 手工开好登记；mock / 服务商名：交给服务商开的
  issued_via      text CHECK (issued_via IS NULL OR char_length(issued_via) BETWEEN 1 AND 32),
  provider_ref    text CHECK (provider_ref IS NULL OR char_length(provider_ref) <= 64),
  reject_reason   text CHECK (reject_reason IS NULL OR char_length(btrim(reject_reason)) BETWEEN 2 AND 200),
  void_reason     text CHECK (void_reason IS NULL OR char_length(btrim(void_reason)) BETWEEN 2 AND 200),
  version         integer NOT NULL DEFAULT 1,
  client_key      uuid NOT NULL UNIQUE,
  request_hash    text NOT NULL,
  requested_by    bigint NOT NULL REFERENCES staff (id),
  requested_at    timestamptz NOT NULL DEFAULT now(),
  handled_by      bigint REFERENCES staff (id),
  handled_at      timestamptz,
  voided_by       bigint REFERENCES staff (id),
  voided_at       timestamptz,
  CHECK (title_type = 'company' OR invoice_kind = 'normal'),
  CHECK (invoice_kind = 'normal' OR tax_no <> ''),
  CHECK ((status = 'issued') <= (invoice_no IS NOT NULL AND invoice_date IS NOT NULL AND issued_via IS NOT NULL)),
  CHECK ((status = 'rejected') = (reject_reason IS NOT NULL)),
  CHECK ((status = 'voided') = (void_reason IS NOT NULL))
);
CREATE UNIQUE INDEX invoice_requests_active_uq ON invoice_requests (source_type, source_id) WHERE status IN ('requested', 'issued');
CREATE INDEX invoice_requests_source_idx ON invoice_requests (source_type, source_id);
CREATE INDEX invoice_requests_status_idx ON invoice_requests (status, requested_at DESC);

-- 申请的内容建了不改：只许改状态与处理的那几列
CREATE FUNCTION yuzu_invoice_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  handling constant text[] := ARRAY['status', 'invoice_no', 'invoice_date', 'file_id', 'issued_via', 'provider_ref', 'reject_reason',
                                    'void_reason', 'version', 'handled_by', 'handled_at', 'voided_by', 'voided_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '开票申请不能删除，不要了请作废' USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(NEW) - handling) IS DISTINCT FROM (to_jsonb(OLD) - handling) THEN
    RAISE EXCEPTION '开票申请的内容建了就不能改，错了请作废后重新申请' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status IN ('rejected', 'voided') THEN
    RAISE EXCEPTION '已驳回、已作废的开票申请不能再改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_requests_guard BEFORE UPDATE OR DELETE ON invoice_requests
  FOR EACH ROW EXECUTE FUNCTION yuzu_invoice_request_guard();

CREATE TABLE integration_calls (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind            text NOT NULL CHECK (kind IN ('pay_terminal', 'platform_voucher', 'einvoice', 'bank_direct', 'ota')),
  provider        text NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 32),
  action          text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 40),
  mode            text NOT NULL CHECK (mode IN ('mock', 'live')),
  ref_type        text CHECK (ref_type IS NULL OR char_length(ref_type) <= 40),
  ref_id          bigint,
  request_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  ok              boolean NOT NULL,
  result_summary  jsonb NOT NULL DEFAULT '{}'::jsonb,
  error           text CHECK (error IS NULL OR char_length(error) <= 500),
  duration_ms     integer NOT NULL CHECK (duration_ms >= 0),
  staff_id        bigint REFERENCES staff (id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX integration_calls_ref_idx ON integration_calls (ref_type, ref_id);
CREATE INDEX integration_calls_recent_idx ON integration_calls (created_at DESC);
CREATE TRIGGER integration_calls_append_only BEFORE UPDATE OR DELETE ON integration_calls
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- 「确认作废」加业务类型（在当时的约束上追加，与 140、162 同一个写法）
DO $$
DECLARE expression text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint
   WHERE conrelid = 'op_fences'::regclass AND conname = 'op_fences_op_type_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
  ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
  EXECUTE format('ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check CHECK ((%s) OR op_type IN (''invoice_request''))', expression);
END $$;

-- 开出来的发票 PDF
DO $$
DECLARE expression text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint
   WHERE conrelid = 'erp_files'::regclass AND conname = 'erp_files_scope_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原文件类别约束不存在'; END IF;
  ALTER TABLE erp_files DROP CONSTRAINT erp_files_scope_check;
  EXECUTE format('ALTER TABLE erp_files ADD CONSTRAINT erp_files_scope_check CHECK ((%s) OR scope IN (''sales_invoice''))', expression);
END $$;
