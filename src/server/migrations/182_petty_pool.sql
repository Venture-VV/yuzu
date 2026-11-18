-- 8.1.9 零采备用金（docs/ERP_V819.md 第 2 节，PENDING_DECISIONS「8.1.9」BJ1–BJ8）。
-- 供应链零采：在面板上申用（登记即占用）→ 提交报销（未补单 / 已补单 + 采购单）→ 财务在「费用报销」登记、钱从「零采备用金」来，
-- 勾这张报销单报的是哪几笔申用 → 报销单确认后这几笔不再占用（自动回补）。总额是 settings 里的 petty_pool，不在这里。
-- 申用的状态（待报销、已提交、审核中、已报销）从报销单推出来，不另存；表里只记申用本身、提交报销与作废。

CREATE TABLE petty_pool_uses (
  id                bigserial PRIMARY KEY,
  doc_no            text NOT NULL UNIQUE,
  use_date          date NOT NULL,
  applicant_id      bigint NOT NULL REFERENCES staff (id),
  -- 用途说明、采购内容
  purpose           text NOT NULL CHECK (char_length(btrim(purpose)) BETWEEN 1 AND 100),
  content           text NOT NULL CHECK (char_length(btrim(content)) BETWEEN 1 AND 200),
  amount_cents      bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 100000000),
  note              text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  -- 报销：open 还没提交，submitted 供应链已提交、等财务登记报销单
  claim_state       text NOT NULL DEFAULT 'open' CHECK (claim_state IN ('open', 'submitted')),
  -- 补单：pending 未补单，done 已补单（要有采购单）；提交报销时必填，之后可以改
  backfill          text CHECK (backfill IN ('pending', 'done')),
  purchase_order_id bigint REFERENCES purchase_orders (id),
  submit_note       text NOT NULL DEFAULT '' CHECK (char_length(submit_note) <= 200),
  submitted_by      bigint REFERENCES staff (id),
  submitted_at      timestamptz,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided')),
  voided_by         bigint REFERENCES staff (id),
  voided_at         timestamptz,
  void_reason       text CHECK (void_reason IS NULL OR char_length(void_reason) BETWEEN 2 AND 200),
  client_key        uuid NOT NULL UNIQUE,
  is_synthetic      boolean NOT NULL DEFAULT false,
  created_by        bigint NOT NULL REFERENCES staff (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CHECK ((backfill = 'done') = (purchase_order_id IS NOT NULL)),
  CHECK (claim_state = 'open' OR (backfill IS NOT NULL AND submitted_by IS NOT NULL AND submitted_at IS NOT NULL)),
  CHECK ((status = 'voided') = (voided_at IS NOT NULL AND voided_by IS NOT NULL AND void_reason IS NOT NULL))
);
CREATE INDEX petty_pool_uses_date_idx ON petty_pool_uses (use_date DESC, id DESC);
CREATE INDEX petty_pool_uses_open_idx ON petty_pool_uses (id) WHERE status = 'active';
CREATE INDEX petty_pool_uses_po_idx ON petty_pool_uses (purchase_order_id) WHERE purchase_order_id IS NOT NULL;

-- 申用登记以后，单号、日期、申请人、用途、内容、金额、经办都不能改，也不能删（错了作废后重新申用）
CREATE FUNCTION yuzu_petty_pool_use_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '零采备用金的申用不能删除，请作废'; END IF;
  IF NEW.doc_no IS DISTINCT FROM OLD.doc_no OR NEW.use_date IS DISTINCT FROM OLD.use_date OR NEW.applicant_id IS DISTINCT FROM OLD.applicant_id
     OR NEW.purpose IS DISTINCT FROM OLD.purpose OR NEW.content IS DISTINCT FROM OLD.content OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
     OR NEW.client_key IS DISTINCT FROM OLD.client_key OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION '零采备用金的申用登记后内容不能修改，请作废后重新申用';
  END IF;
  IF OLD.status = 'voided' THEN RAISE EXCEPTION '已作废的申用不能再改'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER petty_pool_uses_guard BEFORE UPDATE OR DELETE ON petty_pool_uses FOR EACH ROW EXECUTE FUNCTION yuzu_petty_pool_use_guard();

-- 报销单报的是哪几笔申用（报销单登记时一起写，之后不改；报销单撤回、冲销后这条关联不再有效）
CREATE TABLE expense_claim_pool_uses (
  claim_id bigint NOT NULL REFERENCES expense_claims (id),
  use_id   bigint NOT NULL REFERENCES petty_pool_uses (id),
  PRIMARY KEY (claim_id, use_id)
);
CREATE INDEX expense_claim_pool_uses_use_idx ON expense_claim_pool_uses (use_id);
CREATE TRIGGER expense_claim_pool_uses_immutable BEFORE UPDATE OR DELETE ON expense_claim_pool_uses FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- 报销单的「钱从哪来」加零采备用金（pool，不选打款）：在当时的约束上追加
DO $$
DECLARE c record; found int := 0;
BEGIN
  FOR c IN
    SELECT conname, pg_get_expr(conbin, conrelid) AS expression FROM pg_constraint
    WHERE conrelid = 'expense_claims'::regclass AND contype = 'c'
      AND pg_get_expr(conbin, conrelid) LIKE '%pay_source%' AND pg_get_expr(conbin, conrelid) NOT LIKE '%advance_id%'
  LOOP
    EXECUTE format('ALTER TABLE expense_claims DROP CONSTRAINT %I', c.conname);
    EXECUTE format('ALTER TABLE expense_claims ADD CONSTRAINT %I CHECK ((%s) OR pay_source = ''pool'')', c.conname, c.expression);
    found := found + 1;
  END LOOP;
  IF found <> 1 THEN RAISE EXCEPTION '报销单「钱从哪来」的约束应当正好一条，找到 % 条', found; END IF;
END $$;

-- 操作编号与「确认作废」：申用（pool_use），在当时的约束上追加（写法见 162）
DO $$
DECLARE t text; expression text;
BEGIN
 FOREACH t IN ARRAY ARRAY['idempotency_keys','op_fences'] LOOP
  SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint WHERE conrelid=t::regclass AND conname=t||'_op_type_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',t,t||'_op_type_check');
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ((%s) OR op_type IN (''pool_use''))',t,t||'_op_type_check',expression);
 END LOOP;
END $$;
