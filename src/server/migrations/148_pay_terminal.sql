-- 8.0.21 支付直连（docs/INTEGRATIONS_V8021.md 第 2 节，CW-G / CW7）：B 扫 C，收银员扫客人的付款码，到账自动记收款。
-- 8.0.21 只有接口与模拟实现（CW22），正式实现等商户号联调；手选「微信 / 支付宝」、手输金额的做法照旧留着。
--
-- pay_transactions：每次扫码收款一行。先写 paying（提交），事务外调支付方，结果回写；状态只往前走：
--   paying → paid | failed | closed（超过 5 分钟没结果的去支付方撤单）。paid 的交易由结账 / 充值入账时「用掉」（consumed_*），
--   同一笔只能用一次；反结账解开（回到没入账），由收银员挂到重新结账或原路退回。用掉、解开都在 pay_tx_events 里记一条。
-- pay_refunds：原路退回（退款单默认、没入账的整笔退）；refund_cents 是这笔交易上已经申请退的（待退、已退、失败待重试、线下已退都算）。
-- 不存付款码。

CREATE TABLE pay_transactions (
  id                bigserial PRIMARY KEY,
  out_trade_no      text NOT NULL UNIQUE CHECK (out_trade_no ~ '^YZP[0-9A-Z]{6,29}$'),
  provider          text NOT NULL CHECK (provider IN ('wechat', 'alipay')),
  adapter           text NOT NULL CHECK (adapter IN ('mock', 'live')),
  purpose           text NOT NULL CHECK (purpose IN ('checkout', 'recharge')),
  amount_cents      bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 10000000),
  status            text NOT NULL DEFAULT 'paying' CHECK (status IN ('paying', 'paid', 'failed', 'closed')),
  provider_trade_no text CHECK (provider_trade_no IS NULL OR char_length(provider_trade_no) BETWEEN 1 AND 64),
  paid_at           timestamptz,
  fail_reason       text CHECK (fail_reason IS NULL OR char_length(fail_reason) <= 200),
  refund_cents      bigint NOT NULL DEFAULT 0 CHECK (refund_cents >= 0 AND refund_cents <= amount_cents),
  consumed_kind     text CHECK (consumed_kind IN ('checkout', 'recharge')),
  consumed_id       bigint,
  client_key        uuid NOT NULL UNIQUE,
  request_hash      text NOT NULL,
  staff_id          bigint NOT NULL REFERENCES staff (id),
  shift_id          bigint REFERENCES shifts (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((consumed_kind IS NULL) = (consumed_id IS NULL)),
  CHECK (consumed_kind IS NULL OR status = 'paid'),
  CHECK ((status = 'paid') = (provider_trade_no IS NOT NULL AND paid_at IS NOT NULL)),
  CHECK (refund_cents = 0 OR status = 'paid')
);
CREATE INDEX pay_transactions_open_idx ON pay_transactions (status, created_at) WHERE status = 'paying';
CREATE INDEX pay_transactions_unconsumed_idx ON pay_transactions (shift_id, id) WHERE status = 'paid' AND consumed_kind IS NULL;
CREATE INDEX pay_transactions_consumed_idx ON pay_transactions (consumed_kind, consumed_id) WHERE consumed_kind IS NOT NULL;

CREATE FUNCTION yuzu_pay_tx_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '扫码收款记录不能删除' USING ERRCODE = 'P0001'; END IF;
  IF (NEW.out_trade_no, NEW.provider, NEW.adapter, NEW.purpose, NEW.amount_cents, NEW.client_key, NEW.request_hash, NEW.staff_id, NEW.shift_id, NEW.created_at)
       IS DISTINCT FROM (OLD.out_trade_no, OLD.provider, OLD.adapter, OLD.purpose, OLD.amount_cents, OLD.client_key, OLD.request_hash, OLD.staff_id, OLD.shift_id, OLD.created_at) THEN
    RAISE EXCEPTION '扫码收款的单号、方式、金额、经办人不能改' USING ERRCODE = 'P0001';
  END IF;
  -- 状态只往前走：paying → paid / failed / closed；之后不再变
  IF NEW.status IS DISTINCT FROM OLD.status AND OLD.status <> 'paying' THEN
    RAISE EXCEPTION '扫码收款的状态只能从「支付中」变成成功、失败或已撤单' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'paid' AND (NEW.provider_trade_no, NEW.paid_at) IS DISTINCT FROM (OLD.provider_trade_no, OLD.paid_at) THEN
    RAISE EXCEPTION '支付方单号、付款时间记下以后不能改' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.refund_cents < OLD.refund_cents THEN
    RAISE EXCEPTION '已申请的退款不能减少' USING ERRCODE = 'P0001';
  END IF;
  -- 退过款的交易不能再被用掉（解开可以）
  IF NEW.consumed_kind IS NOT NULL AND OLD.consumed_kind IS NULL AND NEW.refund_cents > 0 THEN
    RAISE EXCEPTION '这笔扫码收款已经申请过退款，不能再入账' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pay_transactions_guard BEFORE UPDATE OR DELETE ON pay_transactions
  FOR EACH ROW EXECUTE FUNCTION yuzu_pay_tx_guard();

-- 用掉、解开的记录（只追加）
CREATE TABLE pay_tx_events (
  id         bigserial PRIMARY KEY,
  tx_id      bigint NOT NULL REFERENCES pay_transactions (id),
  action     text NOT NULL CHECK (action IN ('consume', 'release')),
  kind       text NOT NULL CHECK (kind IN ('checkout', 'recharge')),
  target_id  bigint NOT NULL,
  note       text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  staff_id   bigint NOT NULL REFERENCES staff (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pay_tx_events_tx_idx ON pay_tx_events (tx_id, id);

CREATE TABLE pay_refunds (
  id                 bigserial PRIMARY KEY,
  tx_id              bigint NOT NULL REFERENCES pay_transactions (id),
  out_refund_no      text NOT NULL UNIQUE CHECK (out_refund_no ~ '^YZR[0-9A-Z]{6,29}$'),
  amount_cents       bigint NOT NULL CHECK (amount_cents > 0),
  reason             text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 2 AND 200),
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed', 'offline')),
  provider_refund_no text CHECK (provider_refund_no IS NULL OR char_length(provider_refund_no) BETWEEN 1 AND 64),
  fail_reason        text CHECK (fail_reason IS NULL OR char_length(fail_reason) <= 200),
  offline_note       text CHECK (offline_note IS NULL OR char_length(btrim(offline_note)) BETWEEN 2 AND 200),
  -- 退款单（v0.7.20）上的原路退回；没入账的整笔退回为空
  refund_id          bigint REFERENCES refunds (id),
  client_key         uuid UNIQUE,
  staff_id           bigint NOT NULL REFERENCES staff (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  done_at            timestamptz,
  CHECK ((status = 'done') = (provider_refund_no IS NOT NULL AND done_at IS NOT NULL) OR status = 'offline'),
  CHECK ((status = 'offline') = (offline_note IS NOT NULL))
);
CREATE INDEX pay_refunds_tx_idx ON pay_refunds (tx_id, id);
CREATE INDEX pay_refunds_open_idx ON pay_refunds (status, id) WHERE status IN ('pending', 'failed');

CREATE FUNCTION yuzu_pay_refund_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '原路退款记录不能删除' USING ERRCODE = 'P0001'; END IF;
  IF (NEW.tx_id, NEW.out_refund_no, NEW.amount_cents, NEW.reason, NEW.refund_id, NEW.client_key, NEW.staff_id, NEW.created_at)
       IS DISTINCT FROM (OLD.tx_id, OLD.out_refund_no, OLD.amount_cents, OLD.reason, OLD.refund_id, OLD.client_key, OLD.staff_id, OLD.created_at) THEN
    RAISE EXCEPTION '原路退款的单号、金额、原因不能改' USING ERRCODE = 'P0001';
  END IF;
  -- pending → done / failed；failed → pending（重试）/ offline（线下已退）；done、offline 不再变
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'pending' AND NEW.status IN ('done', 'failed'))
       OR (OLD.status = 'failed' AND NEW.status IN ('pending', 'offline'))) THEN
    RAISE EXCEPTION '原路退款的状态不能这样改（%→%）', OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pay_refunds_guard BEFORE UPDATE OR DELETE ON pay_refunds
  FOR EACH ROW EXECUTE FUNCTION yuzu_pay_refund_guard();

CREATE FUNCTION yuzu_pay_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '扫码收款的入账记录只追加' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER pay_tx_events_guard BEFORE UPDATE OR DELETE ON pay_tx_events
  FOR EACH ROW EXECUTE FUNCTION yuzu_pay_event_guard();

-- 收款明细、充值单记下用的是哪一笔扫码收款
ALTER TABLE checkout_payments ADD COLUMN pay_tx_id bigint REFERENCES pay_transactions (id);
ALTER TABLE recharges ADD COLUMN pay_tx_id bigint REFERENCES pay_transactions (id);
-- 退款单的一行是原路退回的
ALTER TABLE refund_payments ADD COLUMN via_terminal boolean NOT NULL DEFAULT false;

-- 「确认作废」：扫码收款（编号记在交易上）。在当时的约束上追加
DO $$
DECLARE expression text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint
   WHERE conrelid = 'op_fences'::regclass AND conname = 'op_fences_op_type_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
  ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
  EXECUTE format('ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check CHECK ((%s) OR op_type IN (''pay_terminal''))', expression);
END $$;
