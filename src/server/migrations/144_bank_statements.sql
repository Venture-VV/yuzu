-- 8.0.21 银行账户与网银流水（docs/FINANCE_V8021.md 第 4 节，CW-C / CW3 / CW16 / CW17）。
--   · bank_accounts：本公司的银行账户。只存开户行与账号后四位（CW16），完整账号不进库；记住这个账户导入时列怎么对（column_map）。
--   · bank_imports：每次导入一份网银导出的对账单；同一个账户同一份文件（内容摘要）只导一次。
--   · bank_statement_lines：流水，只追加；状态（open 没对上 / matched 对平了 / ignored 不用对，如利息、手续费）与版本号可改。
--     去重键：有银行流水号的按「流水号」，没有的按「日期 + 方向 + 金额 + 对方 + 余额」。
--   · bank_matches：一条流水对系统里的一笔或几笔（付款、合同付款、备用金打款 / 补付 / 退回、回款、平台打款、批量付款的一行）。
--     同一个对象同时只对一条流水（部分唯一索引）；撤销写原因，不删。
--   · 「确认作废」加业务类型 bank_import（在当时的约束上追加）。

CREATE TABLE bank_accounts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          text NOT NULL UNIQUE CHECK (char_length(btrim(name)) BETWEEN 1 AND 30),
  bank_name     text NOT NULL CHECK (char_length(btrim(bank_name)) BETWEEN 1 AND 40),
  account_tail  text NOT NULL CHECK (account_tail ~ '^[0-9]{4}$'),
  -- 网银导出 / 批量付款用哪家的格式（第 5 节的批量付款文件也按它）
  template      text NOT NULL DEFAULT 'generic' CHECK (template IN ('icbc', 'ccb', 'cmb', 'generic')),
  column_map    jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(column_map) = 'object'),
  active        boolean NOT NULL DEFAULT true,
  version       integer NOT NULL DEFAULT 1,
  created_by    bigint NOT NULL REFERENCES staff (id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bank_imports (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id    bigint NOT NULL REFERENCES bank_accounts (id),
  file_sha256   text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_name     text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 120),
  line_count    integer NOT NULL CHECK (line_count >= 0),
  new_count     integer NOT NULL CHECK (new_count >= 0),
  dup_count     integer NOT NULL CHECK (dup_count >= 0),
  client_key    uuid NOT NULL UNIQUE,
  request_hash  text NOT NULL,
  created_by    bigint NOT NULL REFERENCES staff (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, file_sha256)
);
CREATE TRIGGER bank_imports_append_only BEFORE UPDATE OR DELETE ON bank_imports
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

CREATE TABLE bank_statement_lines (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id           bigint NOT NULL REFERENCES bank_accounts (id),
  import_id            bigint NOT NULL REFERENCES bank_imports (id),
  txn_date             date NOT NULL,
  direction            text NOT NULL CHECK (direction IN ('in', 'out')),
  amount_cents         bigint NOT NULL CHECK (amount_cents > 0),
  balance_cents        bigint,
  counterparty         text NOT NULL DEFAULT '' CHECK (char_length(counterparty) <= 100),
  counterparty_account text NOT NULL DEFAULT '' CHECK (char_length(counterparty_account) <= 40),
  summary              text NOT NULL DEFAULT '' CHECK (char_length(summary) <= 200),
  bank_ref             text NOT NULL DEFAULT '' CHECK (char_length(bank_ref) <= 64),
  dedupe_key           text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 1 AND 400),
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'matched', 'ignored')),
  ignore_reason        text CHECK (ignore_reason IS NULL OR char_length(btrim(ignore_reason)) BETWEEN 2 AND 200),
  version              integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, dedupe_key),
  CHECK ((status = 'ignored') = (ignore_reason IS NOT NULL))
);
CREATE INDEX bank_statement_lines_status_idx ON bank_statement_lines (status, txn_date);
CREATE INDEX bank_statement_lines_account_idx ON bank_statement_lines (account_id, txn_date DESC);

-- 流水的内容建了不改：只许改状态、不用对的原因、版本号
CREATE FUNCTION yuzu_bank_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '银行流水不能删除' USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'ignore_reason', 'version']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'ignore_reason', 'version']) THEN
    RAISE EXCEPTION '银行流水的内容不能改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bank_statement_lines_guard BEFORE UPDATE OR DELETE ON bank_statement_lines
  FOR EACH ROW EXECUTE FUNCTION yuzu_bank_line_guard();

CREATE TABLE bank_matches (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  line_id       bigint NOT NULL REFERENCES bank_statement_lines (id),
  target_type   text NOT NULL CHECK (target_type IN ('payment', 'contract_payout', 'petty_advance', 'petty_topup', 'petty_return',
                                                     'ar_collection', 'platform_settlement', 'batch_item')),
  target_id     bigint NOT NULL,
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  auto          boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided')),
  created_by    bigint NOT NULL REFERENCES staff (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  voided_by     bigint REFERENCES staff (id),
  voided_at     timestamptz,
  void_reason   text CHECK (void_reason IS NULL OR char_length(btrim(void_reason)) BETWEEN 2 AND 200),
  CHECK ((status = 'voided') = (voided_at IS NOT NULL) AND (voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL) = (void_reason IS NULL))
);
CREATE UNIQUE INDEX bank_matches_target_uq ON bank_matches (target_type, target_id) WHERE status = 'active';
CREATE INDEX bank_matches_line_idx ON bank_matches (line_id);

-- 勾对只许撤销（改成 voided），不能改别的、不能删
CREATE FUNCTION yuzu_bank_match_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '勾对记录不能删除，撤销请写原因' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'voided' OR (to_jsonb(NEW) - ARRAY['status', 'voided_by', 'voided_at', 'void_reason']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'voided_by', 'voided_at', 'void_reason']) THEN
    RAISE EXCEPTION '勾对记录只能撤销' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bank_matches_guard BEFORE UPDATE OR DELETE ON bank_matches
  FOR EACH ROW EXECUTE FUNCTION yuzu_bank_match_guard();

DO $$
DECLARE expression text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint
   WHERE conrelid = 'op_fences'::regclass AND conname = 'op_fences_op_type_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
  ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
  EXECUTE format('ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check CHECK ((%s) OR op_type IN (''bank_import''))', expression);
END $$;
