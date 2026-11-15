-- 8.0.21 平台验券（docs/INTEGRATIONS_V8021.md 第 3 节，CW-H / CW8）：美团、抖音各一个适配器，验券即核销。
-- 8.0.21 只有接口与模拟实现（CW22），正式实现等平台应用联调；平台不通时照旧手输（不验券）、补录照旧。
--
-- platform_verifications：结账时验券，先写「核销中」（提交），事务外调平台核销，结果回写；状态只往前走：
--   verifying → verified | failed；verified → cancelled（撤销核销）| recorded（平台不许撤了，转成「平台核销补录」一条）。
--   结账用掉时挂上团购券记录（group_buy_coupon_id），反结账解开（回到没用）。同一平台同一券码同时只有一张核销中 / 已核销的。
-- 每天对账：platform_recon_runs（每次对账一行，可以重跑）与 platform_recon_issues（平台有系统没有、系统有平台没有、金额不同；人看过标已处理）。

CREATE TABLE platform_verifications (
  id                  bigserial PRIMARY KEY,
  platform            text NOT NULL CHECK (platform IN ('meituan', 'douyin')),
  code                text NOT NULL CHECK (code ~ '^[0-9A-Z]{6,64}$'),
  deal_name           text NOT NULL DEFAULT '' CHECK (char_length(deal_name) <= 48),
  -- 面值（这几份合计，结账抵扣的就是它）与平台应结给门店的
  face_cents          bigint NOT NULL CHECK (face_cents BETWEEN 0 AND 100000000),
  settle_cents        bigint NOT NULL CHECK (settle_cents >= 0 AND settle_cents <= face_cents),
  quantity            integer NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 20),
  adapter             text NOT NULL CHECK (adapter IN ('mock', 'live')),
  status              text NOT NULL DEFAULT 'verifying' CHECK (status IN ('verifying', 'verified', 'failed', 'cancelled', 'recorded')),
  verify_no           text CHECK (verify_no IS NULL OR char_length(verify_no) BETWEEN 1 AND 64),
  fail_reason         text CHECK (fail_reason IS NULL OR char_length(fail_reason) <= 200),
  group_buy_coupon_id bigint REFERENCES group_buy_coupons (id),
  redemption_id       bigint REFERENCES platform_redemptions (id),
  business_date       date NOT NULL,
  client_key          uuid NOT NULL UNIQUE,
  request_hash        text NOT NULL,
  staff_id            bigint NOT NULL REFERENCES staff (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  verified_at         timestamptz,
  cancel_reason       text CHECK (cancel_reason IS NULL OR char_length(btrim(cancel_reason)) BETWEEN 2 AND 200),
  cancelled_by        bigint REFERENCES staff (id),
  cancelled_at        timestamptz,
  CHECK ((status IN ('verified', 'cancelled', 'recorded')) = (verify_no IS NOT NULL AND verified_at IS NOT NULL)),
  CHECK (group_buy_coupon_id IS NULL OR status = 'verified'),
  CHECK ((status = 'recorded') = (redemption_id IS NOT NULL)),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND cancel_reason IS NOT NULL))
);
CREATE UNIQUE INDEX platform_verifications_live ON platform_verifications (platform, code) WHERE status IN ('verifying', 'verified');
CREATE UNIQUE INDEX platform_verifications_coupon ON platform_verifications (group_buy_coupon_id) WHERE group_buy_coupon_id IS NOT NULL;
CREATE INDEX platform_verifications_open ON platform_verifications (status, id) WHERE status IN ('verifying', 'verified');

CREATE FUNCTION yuzu_platform_verification_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '验券记录不能删除' USING ERRCODE = 'P0001'; END IF;
  IF (NEW.platform, NEW.code, NEW.deal_name, NEW.face_cents, NEW.settle_cents, NEW.quantity, NEW.adapter, NEW.business_date, NEW.client_key, NEW.request_hash, NEW.staff_id, NEW.created_at)
       IS DISTINCT FROM (OLD.platform, OLD.code, OLD.deal_name, OLD.face_cents, OLD.settle_cents, OLD.quantity, OLD.adapter, OLD.business_date, OLD.client_key, OLD.request_hash, OLD.staff_id, OLD.created_at) THEN
    RAISE EXCEPTION '验券的平台、券码、项目、金额不能改' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'verifying' AND NEW.status IN ('verified', 'failed'))
       OR (OLD.status = 'verified' AND NEW.status IN ('cancelled', 'recorded'))) THEN
    RAISE EXCEPTION '验券的状态不能这样改（%→%）', OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;
  IF OLD.verify_no IS NOT NULL AND (NEW.verify_no, NEW.verified_at) IS DISTINCT FROM (OLD.verify_no, OLD.verified_at) THEN
    RAISE EXCEPTION '平台核销单号记下以后不能改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER platform_verifications_guard BEFORE UPDATE OR DELETE ON platform_verifications
  FOR EACH ROW EXECUTE FUNCTION yuzu_platform_verification_guard();

-- 团购券记录记下用的是哪一次验券
ALTER TABLE group_buy_coupons ADD COLUMN verification_id bigint REFERENCES platform_verifications (id);

-- 每天对账
CREATE TABLE platform_recon_runs (
  id            bigserial PRIMARY KEY,
  platform      text NOT NULL CHECK (platform IN ('meituan', 'douyin')),
  business_date date NOT NULL,
  adapter       text NOT NULL CHECK (adapter IN ('mock', 'live')),
  ok            boolean NOT NULL,
  error         text CHECK (error IS NULL OR char_length(error) <= 500),
  platform_lines integer NOT NULL DEFAULT 0,
  system_lines  integer NOT NULL DEFAULT 0,
  issues        integer NOT NULL DEFAULT 0,
  -- 自动（每天）还是有人点了「重新对账」
  staff_id      bigint REFERENCES staff (id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_recon_runs_day ON platform_recon_runs (platform, business_date, id);

CREATE TABLE platform_recon_issues (
  id             bigserial PRIMARY KEY,
  run_id         bigint NOT NULL REFERENCES platform_recon_runs (id),
  platform       text NOT NULL,
  business_date  date NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('platform_only', 'system_only', 'amount_diff')),
  code           text NOT NULL,
  deal_name      text NOT NULL DEFAULT '',
  platform_cents bigint,
  system_cents   bigint,
  system_ref     text NOT NULL DEFAULT '',
  resolved_by    bigint REFERENCES staff (id),
  resolved_at    timestamptz,
  resolve_note   text CHECK (resolve_note IS NULL OR char_length(btrim(resolve_note)) BETWEEN 2 AND 200),
  CHECK ((resolved_at IS NULL) = (resolved_by IS NULL) AND (resolved_at IS NULL) = (resolve_note IS NULL))
);
CREATE INDEX platform_recon_issues_open ON platform_recon_issues (business_date, id) WHERE resolved_at IS NULL;

CREATE FUNCTION yuzu_platform_recon_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '对账记录不能删除' USING ERRCODE = 'P0001'; END IF;
  IF TG_TABLE_NAME = 'platform_recon_runs' THEN RAISE EXCEPTION '对账记录只追加' USING ERRCODE = 'P0001'; END IF;
  IF (NEW.run_id, NEW.platform, NEW.business_date, NEW.kind, NEW.code, NEW.platform_cents, NEW.system_cents)
       IS DISTINCT FROM (OLD.run_id, OLD.platform, OLD.business_date, OLD.kind, OLD.code, OLD.platform_cents, OLD.system_cents)
     OR OLD.resolved_at IS NOT NULL THEN
    RAISE EXCEPTION '对账差异只能标一次已处理' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER platform_recon_runs_guard BEFORE UPDATE OR DELETE ON platform_recon_runs FOR EACH ROW EXECUTE FUNCTION yuzu_platform_recon_guard();
CREATE TRIGGER platform_recon_issues_guard BEFORE UPDATE OR DELETE ON platform_recon_issues FOR EACH ROW EXECUTE FUNCTION yuzu_platform_recon_guard();

-- 「确认作废」：验券（编号记在验券记录上）。在当时的约束上追加
DO $$
DECLARE expression text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint
   WHERE conrelid = 'op_fences'::regclass AND conname = 'op_fences_op_type_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
  ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
  EXECUTE format('ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check CHECK ((%s) OR op_type IN (''platform_verify''))', expression);
END $$;
