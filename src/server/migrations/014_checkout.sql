-- Batch 3 · S3.1–S3.3：门票 12 小时跳档、结账收款、团购券、会员储值结账（增量迁移）
--   · 店主 2026-10-27 #31：男女宾、普通柜与 VIP 柜统一一套门票，每 12 小时跳一档（12 小时档 / 24 小时档）；
--     ❓3 儿童 1 米以下免票（做成可维护的票种）；❓6 跳档宽限分钟数（前台规则，默认 0）；
--   · #32 不允许挂单离店：来访只能经「结账（结清）」或「撤销误开的牌（没有消费）」结束；
--   · #34 团购券记完整券码，同一平台同一券码只能有一笔有效登记；
--   · 会员储值支付在结账的同一事务里生成标准消费单与余额流水（consumptions.checkout_id 指向结账单），
--     会员日结与自检原样适用；反结账时按原单撤销（reversals）。
-- 加锁顺序：手牌（id 升序）→ 同行组 → 来访 → 账单 → 会员（id 升序）→ 赠金批次。

-- ───────────── ① 票种（店主 #31 确认的票价；1 米以下儿童免票为 ❓3 的默认做法，待确认） ─────────────
CREATE TABLE ticket_types (
  id         bigserial PRIMARY KEY,
  name       text NOT NULL UNIQUE CHECK (char_length(name) BETWEEN 1 AND 32),
  -- 12 小时档 / 24 小时档的价格（分）；免票两档都为 0
  price_12h  bigint NOT NULL CHECK (price_12h >= 0),
  price_24h  bigint NOT NULL CHECK (price_24h >= price_12h),
  note       text NOT NULL DEFAULT '' CHECK (char_length(note) <= 100),
  active     boolean NOT NULL DEFAULT true,
  -- 接待时默认选中的票种（最多一个）
  is_default boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (active OR NOT is_default)
);
CREATE UNIQUE INDEX ticket_types_default_uq ON ticket_types (is_default) WHERE is_default;
CREATE TRIGGER ticket_types_no_delete BEFORE DELETE ON ticket_types
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_delete();

INSERT INTO ticket_types (name, price_12h, price_24h, note, is_default, sort_order) VALUES
  ('不含餐', 49900, 59900, '', true, 10),
  ('含餐门票', 69900, 89900, '含宵夜、早餐、午餐：12 小时档各 2 餐，24 小时档各 3 餐', false, 20),
  ('全日自助餐', 99900, 119900, '', false, 30),
  ('儿童免票（1 米以下）', 0, 0, '1 米以上儿童按成人票', false, 40);

-- 来访的票种：接待时选定，在店期间可改（记录在 visit_ticket_changes）；Batch 3 之前开的牌为空，结账时补选。
-- 票价在选定票种时留存（与挂账明细的价格快照同一原则），之后店主改票价不影响已在店的客人
ALTER TABLE visits
  ADD COLUMN ticket_type_id   bigint REFERENCES ticket_types (id),
  ADD COLUMN ticket_price_12h bigint CHECK (ticket_price_12h >= 0),
  ADD COLUMN ticket_price_24h bigint CHECK (ticket_price_24h >= 0),
  ADD CONSTRAINT visits_ticket_check CHECK (
    (ticket_type_id IS NULL) = (ticket_price_12h IS NULL) AND (ticket_type_id IS NULL) = (ticket_price_24h IS NULL));

CREATE TABLE visit_ticket_changes (
  id           bigserial PRIMARY KEY,
  visit_id     bigint NOT NULL REFERENCES visits (id),
  from_type_id bigint REFERENCES ticket_types (id),
  to_type_id   bigint NOT NULL REFERENCES ticket_types (id),
  price_12h    bigint NOT NULL,
  price_24h    bigint NOT NULL,
  operator_id  bigint NOT NULL REFERENCES staff (id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX visit_ticket_changes_visit_idx ON visit_ticket_changes (visit_id);
CREATE TRIGGER visit_ticket_changes_append_only BEFORE UPDATE OR DELETE ON visit_ticket_changes
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- 门票明细：结账时按在店时长计算后挂到账单（金额为 0 的免票不挂明细，记在结账单上）
ALTER TABLE bill_lines
  ADD COLUMN ticket_type_id  bigint REFERENCES ticket_types (id),
  ADD COLUMN ticket_segments smallint CHECK (ticket_segments > 0),
  ADD CONSTRAINT bill_lines_ticket_check CHECK ((ticket_type_id IS NULL) = (ticket_segments IS NULL));

-- ───────────── ② 结账单 ─────────────
CREATE TABLE checkouts (
  id                 bigserial PRIMARY KEY,
  checkout_no        text NOT NULL UNIQUE,
  client_key         uuid NOT NULL UNIQUE,
  status             text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'voided')),
  -- 账单合计（含门票）= 收款合计：结清才能离店
  total_amount       bigint NOT NULL CHECK (total_amount >= 0),
  paid_amount        bigint NOT NULL CHECK (paid_amount >= 0),
  note               text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  business_date      date NOT NULL,
  operator_id        bigint NOT NULL REFERENCES staff (id),
  created_at         timestamptz NOT NULL,
  voided_at          timestamptz,
  voided_by          bigint REFERENCES staff (id),
  void_reason        text CHECK (void_reason IS NULL OR char_length(void_reason) BETWEEN 2 AND 200),
  -- 反结账记入的营业日（日结按它汇总）
  void_business_date date,
  CHECK (paid_amount = total_amount),
  CHECK ((status = 'voided') = (voided_at IS NOT NULL) AND (voided_at IS NULL) = (voided_by IS NULL)
         AND (voided_at IS NULL) = (void_reason IS NULL) AND (voided_at IS NULL) = (void_business_date IS NULL))
);
CREATE INDEX checkouts_date_idx ON checkouts (business_date);
CREATE INDEX checkouts_void_date_idx ON checkouts (void_business_date) WHERE void_business_date IS NOT NULL;

-- 结账单只能由「已结账」改为「已反结账」，其余字段不可改；不能删除
CREATE FUNCTION yuzu_checkout_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  void_cols constant text[] := ARRAY['status', 'voided_at', 'voided_by', 'void_reason', 'void_business_date'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '结账单禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF NOT (OLD.status = 'completed' AND NEW.status = 'voided')
     OR (to_jsonb(NEW) - void_cols) <> (to_jsonb(OLD) - void_cols) THEN
    RAISE EXCEPTION '结账单只能反结账，不能修改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER checkouts_guard BEFORE UPDATE OR DELETE ON checkouts
  FOR EACH ROW EXECUTE FUNCTION yuzu_checkout_guard();

-- 结账单包含的账单（一张或同行多张），记下结账时的门票计算
CREATE TABLE checkout_bills (
  checkout_id     bigint NOT NULL REFERENCES checkouts (id),
  bill_id         bigint NOT NULL REFERENCES bills (id),
  visit_id        bigint NOT NULL REFERENCES visits (id),
  -- 该账单结账时的合计（含门票）
  amount          bigint NOT NULL CHECK (amount >= 0),
  stay_minutes    integer NOT NULL CHECK (stay_minutes >= 0),
  ticket_type_id  bigint NOT NULL REFERENCES ticket_types (id),
  ticket_name     text NOT NULL,
  ticket_segments smallint NOT NULL CHECK (ticket_segments > 0),
  ticket_amount   bigint NOT NULL CHECK (ticket_amount >= 0),
  PRIMARY KEY (checkout_id, bill_id)
);
CREATE INDEX checkout_bills_bill_idx ON checkout_bills (bill_id);
CREATE TRIGGER checkout_bills_append_only BEFORE UPDATE OR DELETE ON checkout_bills
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- ───────────── ③ 团购券：完整券码，同一平台同一券码只能有一笔有效登记 ─────────────
CREATE TABLE group_buy_coupons (
  id            bigserial PRIMARY KEY,
  platform      text NOT NULL CHECK (platform IN ('meituan', 'dianping', 'douyin', 'other')),
  -- 规范化后的完整券码（去掉空格与连字符、字母大写）
  code          text NOT NULL CHECK (code ~ '^[0-9A-Z]{6,64}$'),
  deal_name     text NOT NULL DEFAULT '' CHECK (char_length(deal_name) <= 48),
  -- 抵扣金额：这张券在本次结账中抵扣的金额
  amount        bigint NOT NULL CHECK (amount > 0),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided')),
  checkout_id   bigint NOT NULL REFERENCES checkouts (id),
  business_date date NOT NULL,
  registered_by bigint NOT NULL REFERENCES staff (id),
  registered_at timestamptz NOT NULL,
  voided_at     timestamptz,
  voided_by     bigint REFERENCES staff (id),
  void_reason   text,
  CHECK ((status = 'voided') = (voided_at IS NOT NULL) AND (voided_at IS NULL) = (voided_by IS NULL)
         AND (voided_at IS NULL) = (void_reason IS NULL))
);
CREATE UNIQUE INDEX group_buy_coupons_code_uq ON group_buy_coupons (platform, code) WHERE status = 'active';
CREATE INDEX group_buy_coupons_date_idx ON group_buy_coupons (business_date);

CREATE FUNCTION yuzu_coupon_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  void_cols constant text[] := ARRAY['status', 'voided_at', 'voided_by', 'void_reason'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '团购券登记禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF NOT (OLD.status = 'active' AND NEW.status = 'voided')
     OR (to_jsonb(NEW) - void_cols) <> (to_jsonb(OLD) - void_cols) THEN
    RAISE EXCEPTION '团购券登记只能作废，不能修改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER group_buy_coupons_guard BEFORE UPDATE OR DELETE ON group_buy_coupons
  FOR EACH ROW EXECUTE FUNCTION yuzu_coupon_guard();

-- 会员储值支付生成的消费单指向结账单
ALTER TABLE consumptions ADD COLUMN checkout_id bigint REFERENCES checkouts (id);
CREATE INDEX consumptions_checkout_idx ON consumptions (checkout_id) WHERE checkout_id IS NOT NULL;

-- ───────────── ④ 收款明细 ─────────────
CREATE TABLE checkout_payments (
  id             bigserial PRIMARY KEY,
  checkout_id    bigint NOT NULL REFERENCES checkouts (id),
  method         text NOT NULL CHECK (method IN ('cash', 'wechat', 'alipay', 'bank_card', 'other', 'wallet', 'coupon')),
  amount         bigint NOT NULL CHECK (amount > 0),
  ref            text NOT NULL DEFAULT '' CHECK (char_length(ref) <= 64),
  member_id      bigint REFERENCES members (id),
  consumption_id bigint UNIQUE REFERENCES consumptions (id),
  coupon_id      bigint UNIQUE REFERENCES group_buy_coupons (id),
  CHECK ((method = 'wallet') = (consumption_id IS NOT NULL) AND (method = 'wallet') = (member_id IS NOT NULL)),
  CHECK ((method = 'coupon') = (coupon_id IS NOT NULL))
);
CREATE INDEX checkout_payments_checkout_idx ON checkout_payments (checkout_id);
CREATE TRIGGER checkout_payments_append_only BEFORE UPDATE OR DELETE ON checkout_payments
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- ───────────── ⑤ 反结账：已结的账单与来访恢复为在店未结 ─────────────
-- 只在反结账的事务里（SET LOCAL yuzu.reopen = 'on'）允许「已结 → 未结」，开单信息仍不可改；其余规则与 004 相同
CREATE OR REPLACE FUNCTION yuzu_bill_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '账单禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.bill_no, NEW.kind, NEW.business_date, NEW.opened_at)
     IS DISTINCT FROM (OLD.id, OLD.bill_no, OLD.kind, OLD.business_date, OLD.opened_at) THEN
    RAISE EXCEPTION '账单编号与开单信息不可修改' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'settled' AND NEW.status = 'open' AND NEW.closed_at IS NULL
     AND NEW.amount_cents = OLD.amount_cents AND NEW.line_count = OLD.line_count
     AND current_setting('yuzu.reopen', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION '已结束的账单不可修改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION yuzu_visit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '来访记录禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.visit_no, NEW.bill_id, NEW.business_date, NEW.checked_in_at, NEW.checked_in_by, NEW.checkin_key)
     IS DISTINCT FROM (OLD.id, OLD.visit_no, OLD.bill_id, OLD.business_date, OLD.checked_in_at, OLD.checked_in_by, OLD.checkin_key) THEN
    RAISE EXCEPTION '来访编号与开牌信息不可修改' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'settled' AND NEW.status = 'open' AND NEW.closed_at IS NULL AND NEW.closed_by IS NULL
     AND (NEW.tag_id, NEW.zone, NEW.member_id, NEW.group_id, NEW.ticket_type_id, NEW.ticket_price_12h, NEW.ticket_price_24h)
         IS NOT DISTINCT FROM (OLD.tag_id, OLD.zone, OLD.member_id, OLD.group_id, OLD.ticket_type_id, OLD.ticket_price_12h, OLD.ticket_price_24h)
     AND current_setting('yuzu.reopen', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION '已离店或已撤销的来访不可修改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- ───────────── ⑥ 幂等与作废登记：结账 ─────────────
ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_op_type_check;
ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'inv_doc', 'purchase_order', 'payment', 'opening_payable',
                     'checkin', 'bill_post', 'tag_swap', 'abandoned', 'checkout'));
ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'checkin', 'bill_post', 'tag_swap', 'checkout'));
