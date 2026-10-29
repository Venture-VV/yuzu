-- 浴族 yuzu 初始结构
-- 约定：金额一律为整数「分」(bigint)；已入账的单据与流水只追加，不修改、不删除，
-- 纠错通过新增撤销/冲正记录完成。

-- ───────────── 员工与登录 ─────────────
CREATE TABLE staff (
  id                   bigserial PRIMARY KEY,
  username             text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9_.-]{2,32}$'),
  display_name         text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 32),
  role                 text NOT NULL CHECK (role IN ('owner', 'clerk')),
  password_hash        text NOT NULL,
  must_change_password boolean NOT NULL DEFAULT false,
  active               boolean NOT NULL DEFAULT true,
  last_login_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash   text PRIMARY KEY,
  staff_id     bigint NOT NULL REFERENCES staff (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  ip           text,
  user_agent   text
);
CREATE INDEX sessions_staff_idx ON sessions (staff_id);

-- ───────────── 经营设置（键值） ─────────────
CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by bigint REFERENCES staff (id)
);

INSERT INTO settings (key, value) VALUES
  ('store_name', '"浴族 · 城市汤泉"'),
  ('deduction_rule', '"principal_first"'),
  ('business_day_start_hour', '6'),
  ('max_recharge_cents', '5000000'),
  ('max_consume_cents', '2000000');

-- ───────────── 会员 ─────────────
CREATE SEQUENCE member_no_seq START 1001;

CREATE TABLE members (
  id                bigserial PRIMARY KEY,
  member_no         text NOT NULL UNIQUE,
  name              text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 32),
  phone             text NOT NULL UNIQUE CHECK (phone ~ '^1[0-9]{10}$'),
  gender            text CHECK (gender IN ('female', 'male')),
  birthday          date,
  note              text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  principal_balance bigint NOT NULL DEFAULT 0 CHECK (principal_balance >= 0),
  bonus_balance     bigint NOT NULL DEFAULT 0 CHECK (bonus_balance >= 0),
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen')),
  is_synthetic      boolean NOT NULL DEFAULT false,
  created_by        bigint REFERENCES staff (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX members_name_idx ON members (name);

-- ───────────── 充值套餐与消费项目 ─────────────
CREATE TABLE recharge_plans (
  id           bigserial PRIMARY KEY,
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 32),
  pay_amount   bigint NOT NULL CHECK (pay_amount > 0),
  bonus_amount bigint NOT NULL DEFAULT 0 CHECK (bonus_amount >= 0),
  note         text NOT NULL DEFAULT '',
  active       boolean NOT NULL DEFAULT true,
  sort_order   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE service_items (
  id         bigserial PRIMARY KEY,
  name       text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 32),
  category   text NOT NULL DEFAULT '',
  price      bigint NOT NULL CHECK (price > 0),
  active     boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ───────────── 单号计数（按单据类型 + 营业日） ─────────────
CREATE TABLE doc_counters (
  doc_type      text NOT NULL,
  business_date date NOT NULL,
  last_no       integer NOT NULL,
  PRIMARY KEY (doc_type, business_date)
);

-- ───────────── 充值单：收款确认后才会生成 ─────────────
CREATE TABLE recharges (
  id             bigserial PRIMARY KEY,
  doc_no         text NOT NULL UNIQUE,
  member_id      bigint NOT NULL REFERENCES members (id),
  plan_id        bigint REFERENCES recharge_plans (id),
  plan_name      text,
  paid_amount    bigint NOT NULL CHECK (paid_amount > 0),   -- 实收金额，等额计入本金
  bonus_amount   bigint NOT NULL CHECK (bonus_amount >= 0), -- 赠金
  payment_method text NOT NULL CHECK (payment_method IN ('wechat', 'alipay', 'cash', 'bank_card', 'other')),
  payment_ref    text NOT NULL DEFAULT '' CHECK (char_length(payment_ref) <= 64),
  note           text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  business_date  date NOT NULL,
  operator_id    bigint NOT NULL REFERENCES staff (id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recharges_date_idx ON recharges (business_date);
CREATE INDEX recharges_member_idx ON recharges (member_id);

-- ───────────── 消费单 ─────────────
CREATE TABLE consumptions (
  id               bigserial PRIMARY KEY,
  doc_no           text NOT NULL UNIQUE,
  member_id        bigint NOT NULL REFERENCES members (id),
  total_amount     bigint NOT NULL CHECK (total_amount > 0),
  principal_amount bigint NOT NULL CHECK (principal_amount >= 0),
  bonus_amount     bigint NOT NULL CHECK (bonus_amount >= 0),
  deduction_rule   text NOT NULL,
  note             text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  status           text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'reversed')),
  business_date    date NOT NULL,
  operator_id      bigint NOT NULL REFERENCES staff (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (principal_amount + bonus_amount = total_amount)
);
CREATE INDEX consumptions_date_idx ON consumptions (business_date);
CREATE INDEX consumptions_member_idx ON consumptions (member_id);

CREATE TABLE consumption_lines (
  id             bigserial PRIMARY KEY,
  consumption_id bigint NOT NULL REFERENCES consumptions (id),
  item_id        bigint REFERENCES service_items (id),
  name           text NOT NULL,
  unit_price     bigint NOT NULL CHECK (unit_price > 0),
  quantity       integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  amount         bigint NOT NULL,
  CHECK (amount = unit_price * quantity)
);
CREATE INDEX consumption_lines_consumption_idx ON consumption_lines (consumption_id);

-- ───────────── 撤销单：对原消费整单撤销，一张消费单最多一张撤销单 ─────────────
CREATE TABLE reversals (
  id               bigserial PRIMARY KEY,
  doc_no           text NOT NULL UNIQUE,
  consumption_id   bigint NOT NULL UNIQUE REFERENCES consumptions (id),
  member_id        bigint NOT NULL REFERENCES members (id),
  principal_amount bigint NOT NULL CHECK (principal_amount >= 0),
  bonus_amount     bigint NOT NULL CHECK (bonus_amount >= 0),
  reason           text NOT NULL CHECK (char_length(reason) BETWEEN 2 AND 200),
  business_date    date NOT NULL,
  operator_id      bigint NOT NULL REFERENCES staff (id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reversals_date_idx ON reversals (business_date);

-- ───────────── 余额流水：唯一的记账来源，每笔余额变化一行 ─────────────
CREATE TABLE ledger_entries (
  id              bigserial PRIMARY KEY,
  member_id       bigint NOT NULL REFERENCES members (id),
  entry_type      text NOT NULL CHECK (entry_type IN ('recharge', 'consume', 'reversal')),
  recharge_id     bigint REFERENCES recharges (id),
  consumption_id  bigint REFERENCES consumptions (id),
  reversal_id     bigint REFERENCES reversals (id),
  doc_no          text NOT NULL,
  principal_delta bigint NOT NULL,
  bonus_delta     bigint NOT NULL,
  principal_after bigint NOT NULL CHECK (principal_after >= 0),
  bonus_after     bigint NOT NULL CHECK (bonus_after >= 0),
  business_date   date NOT NULL,
  operator_id     bigint NOT NULL REFERENCES staff (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (entry_type = 'recharge' AND recharge_id IS NOT NULL AND consumption_id IS NULL AND reversal_id IS NULL
      AND principal_delta > 0 AND bonus_delta >= 0)
    OR (entry_type = 'consume' AND consumption_id IS NOT NULL AND recharge_id IS NULL AND reversal_id IS NULL
      AND principal_delta <= 0 AND bonus_delta <= 0)
    OR (entry_type = 'reversal' AND reversal_id IS NOT NULL AND consumption_id IS NOT NULL AND recharge_id IS NULL
      AND principal_delta >= 0 AND bonus_delta >= 0)
  )
);
CREATE INDEX ledger_entries_date_idx ON ledger_entries (business_date);
CREATE INDEX ledger_entries_member_idx ON ledger_entries (member_id, id);
CREATE UNIQUE INDEX ledger_entries_recharge_uq ON ledger_entries (recharge_id) WHERE recharge_id IS NOT NULL;
CREATE UNIQUE INDEX ledger_entries_consume_uq ON ledger_entries (consumption_id) WHERE entry_type = 'consume';
CREATE UNIQUE INDEX ledger_entries_reversal_uq ON ledger_entries (reversal_id) WHERE reversal_id IS NOT NULL;

-- ───────────── 幂等键：重复点击 / 超时重试只会得到同一张单 ─────────────
CREATE TABLE idempotency_keys (
  key          uuid PRIMARY KEY,
  op_type      text NOT NULL CHECK (op_type IN ('recharge', 'consume', 'reversal')),
  request_hash text NOT NULL,
  ref_id       bigint NOT NULL,
  staff_id     bigint NOT NULL REFERENCES staff (id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ───────────── 日结确认 ─────────────
CREATE TABLE daily_settlements (
  business_date date PRIMARY KEY,
  closed_by     bigint NOT NULL REFERENCES staff (id),
  closed_at     timestamptz NOT NULL DEFAULT now(),
  note          text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  snapshot      jsonb NOT NULL,
  revision      integer NOT NULL DEFAULT 1
);

-- ───────────── 操作审计 ─────────────
CREATE TABLE audit_logs (
  id            bigserial PRIMARY KEY,
  staff_id      bigint REFERENCES staff (id),
  action        text NOT NULL,
  target_type   text,
  target_id     text,
  detail        jsonb NOT NULL DEFAULT '{}',
  ip            text,
  business_date date,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at);
CREATE INDEX audit_logs_date_idx ON audit_logs (business_date, action);

-- ───────────── 只追加保护 ─────────────
CREATE FUNCTION yuzu_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% 为只追加记录，禁止 %', TG_TABLE_NAME, TG_OP USING ERRCODE = 'P0001';
END $$;

CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
CREATE TRIGGER recharges_append_only BEFORE UPDATE OR DELETE ON recharges
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
CREATE TRIGGER reversals_append_only BEFORE UPDATE OR DELETE ON reversals
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
CREATE TRIGGER consumption_lines_append_only BEFORE UPDATE OR DELETE ON consumption_lines
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
CREATE TRIGGER idempotency_keys_append_only BEFORE UPDATE OR DELETE ON idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- 消费单只允许一种变化：completed → reversed，其余字段不可改。
CREATE FUNCTION yuzu_consumption_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '消费单禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'completed' AND NEW.status = 'reversed'
     AND (NEW.id, NEW.doc_no, NEW.member_id, NEW.total_amount, NEW.principal_amount, NEW.bonus_amount,
          NEW.deduction_rule, NEW.note, NEW.business_date, NEW.operator_id, NEW.created_at)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.doc_no, OLD.member_id, OLD.total_amount, OLD.principal_amount, OLD.bonus_amount,
          OLD.deduction_rule, OLD.note, OLD.business_date, OLD.operator_id, OLD.created_at) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '消费单只能由已完成变为已撤销' USING ERRCODE = 'P0001';
END $$;

CREATE TRIGGER consumptions_guard BEFORE UPDATE OR DELETE ON consumptions
  FOR EACH ROW EXECUTE FUNCTION yuzu_consumption_guard();
