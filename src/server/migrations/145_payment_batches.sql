-- 8.0.21 供应商收款账户与批量付款文件（docs/FINANCE_V8021.md 第 5 节，CW-D / CW4 / CW18 / CW19）。
--   · suppliers 加收款账户：户名、开户行、账号（批量付款文件要用完整账号；页面列表里打码，维护照旧「维护物料、供应商、部门档案」）。
--   · payment_batches：一批付款。生成时抄一份收款户名、开户行、账号（之后改档案不影响这一批）；导出以后不能改，只能作废重开（作废要确认没在网银里付）。
--   · payment_batch_items：一张已审批、没付清的付款申请一行。同一张申请同时只能在一个没结束的批次里（active 的部分唯一索引）。
--     记已付时照「按申请登记付款」记账，用这一行自己的操作编号（pay_client_key），重来也只记一次。
--   · 「确认作废」加业务类型 payment_batch（在当时的约束上追加）。

ALTER TABLE suppliers
  ADD COLUMN bank_payee   text NOT NULL DEFAULT '' CHECK (char_length(bank_payee) <= 60),
  ADD COLUMN bank_name    text NOT NULL DEFAULT '' CHECK (char_length(bank_name) <= 60),
  ADD COLUMN bank_account text NOT NULL DEFAULT '' CHECK (bank_account = '' OR bank_account ~ '^[0-9]{8,32}$');

CREATE TABLE payment_batches (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_no      text NOT NULL UNIQUE,
  account_id    bigint NOT NULL REFERENCES bank_accounts (id),
  template      text NOT NULL CHECK (template IN ('icbc', 'ccb', 'cmb', 'generic')),
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'exported', 'done', 'voided')),
  total_cents   bigint NOT NULL CHECK (total_cents > 0),
  item_count    integer NOT NULL CHECK (item_count > 0),
  note          text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  version       integer NOT NULL DEFAULT 1,
  client_key    uuid NOT NULL UNIQUE,
  request_hash  text NOT NULL,
  created_by    bigint NOT NULL REFERENCES staff (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  exported_by   bigint REFERENCES staff (id),
  exported_at   timestamptz,
  voided_by     bigint REFERENCES staff (id),
  voided_at     timestamptz,
  void_reason   text CHECK (void_reason IS NULL OR char_length(btrim(void_reason)) BETWEEN 2 AND 200),
  CHECK ((status = 'voided') = (voided_at IS NOT NULL) AND (voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX payment_batches_status_idx ON payment_batches (status, id DESC);

CREATE TABLE payment_batch_items (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id           bigint NOT NULL REFERENCES payment_batches (id),
  line_no            integer NOT NULL CHECK (line_no > 0),
  payment_request_id bigint NOT NULL REFERENCES payment_requests (id),
  amount_cents       bigint NOT NULL CHECK (amount_cents > 0),
  payee_name         text NOT NULL CHECK (char_length(btrim(payee_name)) BETWEEN 1 AND 60),
  payee_bank         text NOT NULL CHECK (char_length(btrim(payee_bank)) BETWEEN 1 AND 60),
  payee_account      text NOT NULL CHECK (payee_account ~ '^[0-9]{8,32}$'),
  purpose            text NOT NULL CHECK (char_length(purpose) BETWEEN 1 AND 60),
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'removed')),
  -- 还在一个没结束的批次里（pending 且批次没作废、没结束）：同一张申请同时只能有一行 active
  active             boolean NOT NULL DEFAULT true,
  -- 记已付时调「按申请登记付款」用的操作编号（生成时就定下）
  pay_client_key     uuid NOT NULL UNIQUE,
  -- 记已付以后：供应商往来的付款（payments）或合同付款（contract_payouts）
  payment_kind       text CHECK (payment_kind IN ('payment', 'payout')),
  payment_id         bigint,
  paid_on            date,
  bank_ref           text NOT NULL DEFAULT '' CHECK (char_length(bank_ref) <= 64),
  fail_reason        text CHECK (fail_reason IS NULL OR char_length(btrim(fail_reason)) BETWEEN 2 AND 200),
  updated_by         bigint REFERENCES staff (id),
  updated_at         timestamptz,
  UNIQUE (batch_id, line_no),
  CHECK (NOT active OR status = 'pending'),
  CHECK ((status = 'paid') = (payment_id IS NOT NULL AND payment_kind IS NOT NULL AND paid_on IS NOT NULL)),
  CHECK ((status IN ('failed', 'removed')) <= (fail_reason IS NOT NULL))
);
CREATE UNIQUE INDEX payment_batch_items_active_uq ON payment_batch_items (payment_request_id) WHERE active;
CREATE INDEX payment_batch_items_batch_idx ON payment_batch_items (batch_id);

-- 生成时抄下的收款信息与金额不改；只改结果那几列
CREATE FUNCTION yuzu_batch_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  result_cols constant text[] := ARRAY['status', 'active', 'payment_kind', 'payment_id', 'paid_on', 'bank_ref', 'fail_reason', 'updated_by', 'updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '批量付款的明细不能删除' USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(NEW) - result_cols) IS DISTINCT FROM (to_jsonb(OLD) - result_cols) THEN
    RAISE EXCEPTION '批量付款的收款信息与金额生成以后不能改，错了请作废这一批重开' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_batch_items_guard BEFORE UPDATE OR DELETE ON payment_batch_items
  FOR EACH ROW EXECUTE FUNCTION yuzu_batch_item_guard();

DO $$
DECLARE expression text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint
   WHERE conrelid = 'op_fences'::regclass AND conname = 'op_fences_op_type_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
  ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
  EXECUTE format('ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check CHECK ((%s) OR op_type IN (''payment_batch''))', expression);
END $$;
