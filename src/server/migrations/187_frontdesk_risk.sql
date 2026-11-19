-- 8.1.15《浴族系统需求汇总》块 A · 前台：NFC 发牌、发牌前风控、发牌后异常处置（docs/FRONTDESK_RISK_V8115.md）。
-- 只增不改：
--   · 手牌多一列芯片号 hand_tags.card_uid（可空；同一门店里不重复）；
--   · 黑名单 guest_blacklist（会员或手机号；只能「登记 → 解除」，不能改、不能删）；
--   · 来访异常 visit_incidents（只追加）与它的处理记录 visit_incident_events（只追加：指派、处理结果）；
--   · 来访多五列：外出标记（away_since、away_by）与发牌授权留痕（risk_approved_by、risk_approved_at、risk_reason）；
--   · 当场授权的用途加 checkin_risk；操作编号与「确认作废」的类型加 visit_incident——都在当时的约束上追加
--     （几条开发线的迁移在一个库里谁先跑不一定，照旧名单重建会把别的迁移加的类型覆盖掉，写法见 162_customer_workbench.sql）。
-- 现有的手牌、来访一行不改：新列都是可空、没有默认值，老数据读出来就是「没绑芯片号」「没外出」「没有授权留痕」。

-- ───────────── 1. 手牌芯片号 ─────────────
-- 读卡器读到的卡号（NFC 的 UID，或 IC / ID 卡的十进制卡号）：去掉分隔符、转大写后存，4–32 位数字或大写字母
ALTER TABLE hand_tags ADD COLUMN card_uid text CHECK (card_uid ~ '^[0-9A-Z]{4,32}$');
CREATE UNIQUE INDEX hand_tags_card_uid_uq ON hand_tags (store_id, card_uid) WHERE card_uid IS NOT NULL;

-- ───────────── 2. 黑名单 ─────────────
-- 跟着会员走，全公司一份（不按店分）。认会员的记 member_id；只知道手机号的记 phone（这个号码以后办了会员照样拦）。
CREATE TABLE guest_blacklist (
  id          bigserial PRIMARY KEY,
  member_id   bigint REFERENCES members (id),
  phone       text CHECK (phone ~ '^1[0-9]{10}$'),
  name        text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 32),
  reason      text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 2 AND 200),
  created_by  bigint NOT NULL REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  lifted_by   bigint REFERENCES staff (id),
  lifted_at   timestamptz,
  lift_reason text CHECK (char_length(btrim(lift_reason)) BETWEEN 2 AND 200),
  CHECK ((member_id IS NULL) <> (phone IS NULL)),
  CHECK ((lifted_at IS NULL) = (lifted_by IS NULL) AND (lifted_at IS NULL) = (lift_reason IS NULL))
);
-- 同一位会员、同一个手机号同时只有一条没解除的
CREATE UNIQUE INDEX guest_blacklist_member_active_uq ON guest_blacklist (member_id) WHERE lifted_at IS NULL AND member_id IS NOT NULL;
CREATE UNIQUE INDEX guest_blacklist_phone_active_uq ON guest_blacklist (phone) WHERE lifted_at IS NULL AND phone IS NOT NULL;
CREATE INDEX guest_blacklist_member_idx ON guest_blacklist (member_id) WHERE member_id IS NOT NULL;

CREATE FUNCTION yuzu_guest_blacklist_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '黑名单记录禁止删除，请解除并填写原因' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.member_id, NEW.phone, NEW.name, NEW.reason, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.member_id, OLD.phone, OLD.name, OLD.reason, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION '黑名单的登记内容不可修改' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.lifted_at IS NOT NULL THEN
    RAISE EXCEPTION '已解除的黑名单记录不可修改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guest_blacklist_guard BEFORE UPDATE OR DELETE ON guest_blacklist
  FOR EACH ROW EXECUTE FUNCTION yuzu_guest_blacklist_guard();

-- ───────────── 3. 来访异常 ─────────────
-- 一行一件事，只追加：提醒、加收、上报、临时外出、返回、未结离店。上报、未结离店是「待办」，处理结果另记在 visit_incident_events。
CREATE TABLE visit_incidents (
  id            bigserial PRIMARY KEY,
  store_id      bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id),
  visit_id      bigint NOT NULL REFERENCES visits (id),
  -- 当时这位客人是哪位会员（散客为空）：未结离店按它在下次发牌时拦下来授权
  member_id     bigint REFERENCES members (id),
  kind          text NOT NULL CHECK (kind IN ('remind', 'surcharge', 'report', 'away', 'return', 'unsettled')),
  note          text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  -- 加收的金额、未结离店的应收（分）
  amount_cents  bigint CHECK (amount_cents > 0),
  -- 加收挂到账单上的那条明细（手动金额的明细，走原来的挂账）
  bill_line_id  bigint REFERENCES bill_lines (id),
  -- 加收由别人当场授权时的授权人（值班经理及以上自己加收的为空）
  approved_by   bigint REFERENCES staff (id),
  -- 上报、未结离店登记时指给的责任人（之后改派记在处理记录里）
  assignee_id   bigint REFERENCES staff (id),
  -- 这一次操作的编号：一个编号一条，原样重提返回第一次的结果
  op_key        uuid NOT NULL UNIQUE,
  business_date date NOT NULL,
  created_by    bigint NOT NULL REFERENCES staff (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind IN ('surcharge', 'unsettled')) = (amount_cents IS NOT NULL)),
  CHECK ((kind = 'surcharge') = (bill_line_id IS NOT NULL)),
  CHECK (kind = 'surcharge' OR approved_by IS NULL),
  CHECK (kind IN ('report', 'unsettled') OR assignee_id IS NULL),
  -- 提醒、外出、返回可以不写备注；加收、上报、未结离店要写明原因（至少 2 个字）
  CHECK (kind IN ('remind', 'away', 'return') OR char_length(btrim(note)) >= 2)
);
CREATE INDEX visit_incidents_visit_idx ON visit_incidents (visit_id, id);
-- 「异常待办」只看上报与未结离店
CREATE INDEX visit_incidents_todo_idx ON visit_incidents (store_id, id) WHERE kind IN ('report', 'unsettled');
-- 发牌前按会员找没处理完的未结离店
CREATE INDEX visit_incidents_member_unsettled_idx ON visit_incidents (member_id) WHERE kind = 'unsettled' AND member_id IS NOT NULL;
CREATE TRIGGER visit_incidents_append_only BEFORE UPDATE OR DELETE ON visit_incidents
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- 待办的处理记录（只追加）：指派给谁、处理结果。一条待办只能写一次处理结果。
CREATE TABLE visit_incident_events (
  id          bigserial PRIMARY KEY,
  incident_id bigint NOT NULL REFERENCES visit_incidents (id),
  action      text NOT NULL CHECK (action IN ('assign', 'resolve')),
  assignee_id bigint REFERENCES staff (id),
  note        text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  operator_id bigint NOT NULL REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((action = 'assign') = (assignee_id IS NOT NULL)),
  CHECK (action <> 'resolve' OR char_length(btrim(note)) >= 2)
);
CREATE INDEX visit_incident_events_incident_idx ON visit_incident_events (incident_id, id);
CREATE UNIQUE INDEX visit_incident_events_resolved_uq ON visit_incident_events (incident_id) WHERE action = 'resolve';
CREATE TRIGGER visit_incident_events_append_only BEFORE UPDATE OR DELETE ON visit_incident_events
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- ───────────── 4. 来访：外出标记与发牌授权留痕 ─────────────
ALTER TABLE visits
  -- 临时外出：从几点起、谁登记的；回来清掉（每一次外出、返回各有一条异常记录）
  ADD COLUMN away_since       timestamptz,
  ADD COLUMN away_by          bigint REFERENCES staff (id),
  -- 这位会员名下有没处理完的「未结离店」时，发牌要值班经理及以上当场授权：授权人、时间、原因
  ADD COLUMN risk_approved_by bigint REFERENCES staff (id),
  ADD COLUMN risk_approved_at timestamptz,
  ADD COLUMN risk_reason      text CHECK (char_length(btrim(risk_reason)) BETWEEN 2 AND 100),
  ADD CONSTRAINT visits_away_check CHECK ((away_since IS NULL) = (away_by IS NULL)),
  ADD CONSTRAINT visits_risk_check
    CHECK ((risk_approved_by IS NULL) = (risk_approved_at IS NULL) AND (risk_approved_by IS NULL) = (risk_reason IS NULL));

-- ───────────── 5. 授权用途、操作编号类型：在当时的约束上追加 ─────────────
DO $$
DECLARE
  expression text;
  t text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO expression
  FROM pg_constraint WHERE conrelid = 'auth_grants'::regclass AND conname = 'auth_grants_purpose_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原授权用途约束不存在'; END IF;
  ALTER TABLE auth_grants DROP CONSTRAINT auth_grants_purpose_check;
  EXECUTE format('ALTER TABLE auth_grants ADD CONSTRAINT auth_grants_purpose_check CHECK ((%s) OR purpose = ''checkin_risk'')', expression);

  FOREACH t IN ARRAY ARRAY['idempotency_keys', 'op_fences'] LOOP
    SELECT pg_get_expr(conbin, conrelid) INTO expression
    FROM pg_constraint WHERE conrelid = t::regclass AND conname = t || '_op_type_check';
    IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, t || '_op_type_check');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ((%s) OR op_type = ''visit_incident'')', t, t || '_op_type_check', expression);
  END LOOP;
END $$;
