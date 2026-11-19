-- 8.1.15 会员中心（《浴族系统需求汇总》会员 1、2；设计见 docs/MEMBERS_V8115.md，默认做法待确认）。
--   · 卡类型：电子卡（ecard，凭手机号认人）、实体卡（physical，发一张卡、收押金）、匿名卡（anonymous，不强制手机号）；
--     现有会员都是电子卡，名下有在用或挂失的实体卡的记成实体卡；
--   · 手机号只有匿名卡可以不留（留了的照旧全公司不重复、照旧核对格式）；
--   · 推荐人（另一位会员）、偏好项目（一组短文字）；
--   · 建档的操作编号记在会员一行上（client_key）：匿名卡没有手机号去重，实体卡建档同时收押金，都要靠它不重复登记；
--   · 会员卡押金台账（member_card_deposits，只追加）：收、退，按收款方式，记经办人当班的班次——照客房押金（024）的做法，
--     押金是负债，不进会员储值、不算营业额；一位会员押着的押金 = 收 − 退，不能为负（服务端在会员一行的锁里核对，自检核对）；
--   · 实体卡多一个状态「已退卡」（returned）：客人把卡退回来、押金退掉；卡号可以再发；
--   · 「确认作废」与操作编号加两种业务类型：建档（member_create）、退卡退押金（member_card_return），在当时的约束上追加（写法见 162）。
-- 只加列、加表、放宽约束，不改已有单据的内容。

ALTER TABLE members
  ADD COLUMN card_type text NOT NULL DEFAULT 'ecard' CHECK (card_type IN ('ecard', 'physical', 'anonymous')),
  ADD COLUMN referrer_member_id bigint REFERENCES members (id),
  ADD COLUMN preferred_items text[] NOT NULL DEFAULT '{}' CHECK (cardinality(preferred_items) <= 10),
  ADD COLUMN client_key uuid UNIQUE,
  ADD COLUMN request_hash text;
ALTER TABLE members ALTER COLUMN phone DROP NOT NULL;
-- 不是匿名卡的一定有手机号；推荐人不能是自己；操作编号与原请求摘要一起有
ALTER TABLE members ADD CONSTRAINT members_phone_card_type_check CHECK (phone IS NOT NULL OR card_type = 'anonymous');
ALTER TABLE members ADD CONSTRAINT members_referrer_check CHECK (referrer_member_id IS NULL OR referrer_member_id <> id);
ALTER TABLE members ADD CONSTRAINT members_client_key_check CHECK ((client_key IS NULL) = (request_hash IS NULL));
CREATE INDEX members_referrer_idx ON members (referrer_member_id) WHERE referrer_member_id IS NOT NULL;

-- 名下有在用或挂失的实体卡的会员记成实体卡（升级前发的卡没有押金，押着的押金是 0）
UPDATE members SET card_type = 'physical'
WHERE id IN (SELECT member_id FROM member_cards WHERE status IN ('active', 'lost'));

-- 换手机号记录：匿名卡补登手机号时原来没有号
ALTER TABLE member_phone_changes ALTER COLUMN old_phone DROP NOT NULL;

-- 实体卡：多一个状态「已退卡」
ALTER TABLE member_cards DROP CONSTRAINT member_cards_status_check;
ALTER TABLE member_cards ADD CONSTRAINT member_cards_status_check CHECK (status IN ('active', 'lost', 'canceled', 'returned'));

-- ───────────── 会员卡押金台账（只追加） ─────────────
-- 收：建档选实体卡、给没有押金的会员发卡时；退：退卡（卡丢了没卡可退的也在这里退）。挂失不退，补卡沿用原来的押金。
-- 「其他」方式收的要写明收的是什么；退的写原因；非现金退的登记退款单号（服务端核对）
CREATE TABLE member_card_deposits (
  id            bigserial PRIMARY KEY,
  doc_no        text NOT NULL UNIQUE,
  member_id     bigint NOT NULL REFERENCES members (id),
  -- 收：发的那张卡；退：退回的那张卡（卡丢了没卡可退的为空）
  card_id       bigint REFERENCES member_cards (id),
  kind          text NOT NULL CHECK (kind IN ('receive', 'refund')),
  method        text NOT NULL CHECK (method IN ('cash', 'wechat', 'alipay', 'bank_card', 'other')),
  amount        integer NOT NULL CHECK (amount BETWEEN 1 AND 100000),
  ref           text NOT NULL DEFAULT '' CHECK (char_length(ref) <= 64),
  reason        text CHECK (reason IS NULL OR char_length(reason) <= 200),
  shift_id      bigint REFERENCES shifts (id),
  business_date date NOT NULL,
  operator_id   bigint NOT NULL REFERENCES staff (id),
  store_id      bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- 操作编号：收的记建档 / 发卡那一次的编号，退的记退卡那一次的编号
  client_key    uuid NOT NULL UNIQUE,
  request_hash  text NOT NULL,
  CHECK (kind <> 'receive' OR card_id IS NOT NULL),
  CHECK (kind <> 'receive' OR method <> 'other' OR char_length(btrim(ref)) > 0),
  CHECK (kind <> 'refund' OR char_length(btrim(reason)) >= 2)
);
CREATE INDEX member_card_deposits_member_idx ON member_card_deposits (member_id, id);
CREATE INDEX member_card_deposits_shift_idx ON member_card_deposits (shift_id) WHERE shift_id IS NOT NULL;
CREATE INDEX member_card_deposits_date_idx ON member_card_deposits (business_date);
CREATE TRIGGER member_card_deposits_append_only BEFORE UPDATE OR DELETE ON member_card_deposits
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- 操作编号与「确认作废」：建档（member_create，编号记在 members.client_key）、退卡退押金（member_card_return，
-- 编号记在 member_card_returns.client_key），在当时的约束上追加
DO $$
DECLARE t text; expression text;
BEGIN
 FOREACH t IN ARRAY ARRAY['idempotency_keys','op_fences'] LOOP
  SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint WHERE conrelid=t::regclass AND conname=t||'_op_type_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',t,t||'_op_type_check');
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ((%s) OR op_type IN (''member_create'',''member_card_return''))',t,t||'_op_type_check',expression);
 END LOOP;
END $$;

-- ───────────── 退卡记录 ─────────────
-- 一次退卡一行：退回哪张卡（卡丢了没卡可退的为空）、退了多少押金（没押金的为 0，这时没有押金台账的行）
CREATE TABLE member_card_returns (
  id            bigserial PRIMARY KEY,
  member_id     bigint NOT NULL REFERENCES members (id),
  card_id       bigint REFERENCES member_cards (id),
  deposit_id    bigint REFERENCES member_card_deposits (id),
  amount        integer NOT NULL CHECK (amount BETWEEN 0 AND 100000),
  reason        text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 2 AND 200),
  operator_id   bigint NOT NULL REFERENCES staff (id),
  business_date date NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  client_key    uuid NOT NULL UNIQUE,
  request_hash  text NOT NULL,
  CHECK ((amount > 0) = (deposit_id IS NOT NULL)),
  CHECK (card_id IS NOT NULL OR amount > 0)
);
CREATE INDEX member_card_returns_member_idx ON member_card_returns (member_id, id);
CREATE TRIGGER member_card_returns_append_only BEFORE UPDATE OR DELETE ON member_card_returns
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
