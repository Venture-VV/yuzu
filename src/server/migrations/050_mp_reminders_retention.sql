-- 小程序第三期 3a：到期提醒（订阅消息；小程序线，docs/MP_PHASE3.md 第 1 节；MP28、MP29）；解绑满 3 年清除（MP16，docs/MP_PRIVACY.md）。
--   ① mp_reminder_consents：顾客的同意，只追加——哪个微信（绑定记录）、哪位会员、提醒什么（券、会籍、补充期、赠金）、
--      提醒哪一张券或哪一天到期的、用的哪个模板、哪天发（北京时间）。微信只给这类门店一次性订阅：顾客点一次「提醒我」、
--      在微信的弹窗里同意一次，门店系统才能给他发一条。同一条绑定对同一样东西的同一种提醒，还在等、已发出的只记一条
--      （再点返回原来那条）；之前那条没发出、不用发了或模板换过的，再同意一次记新的一条（seq 加一）。
--   ② mp_reminder_messages：每条同意最多一条消息，到了那天、在 10:00–20:00 之间排进来（MP29）。状态：排队 → 网关取走 →
--      发出 / 没发出 / 结果不明（网关取走以后没回报：不再发第二次，一次同意只发一条）；到点时、网关来取时已经不用提醒的
--      （券用掉了、过了到期日、会籍续上了、解绑了）记「不发」与原因。要再试的隔一会儿再给网关。状态只能这样变，触发器兜底。
--   ③ 解绑满 3 年清除（MP16）：绑定记录去掉手机号与微信标识，同一条绑定下的单子与记录去掉微信标识，作废登记满 3 年的删掉（见下面）。
-- ①② 只建新表、只用外键引用会员、绑定记录与券；③ 给小程序线自己的几张表放开「清除」这一种改法。050 登记给小程序线（ROADMAP 第 7 节），
-- 只读券、会员档阶、赠金批次，主线不用改。

CREATE TABLE mp_reminder_consents (
  id          bigserial PRIMARY KEY,
  client_key  uuid NOT NULL UNIQUE,
  openid      text NOT NULL CHECK (openid ~ '^[A-Za-z0-9_-]{6,64}$'),
  binding_id  bigint NOT NULL REFERENCES mp_bindings (id),
  member_id   bigint NOT NULL REFERENCES members (id),
  -- coupon 券快到期、membership 会籍快到期、grace 进补充期当天、bonus 赠金快到期
  kind        text NOT NULL CHECK (kind IN ('coupon', 'membership', 'grace', 'bonus')),
  -- 提醒哪一张券（只有 coupon）
  coupon_id   bigint REFERENCES coupons (id),
  -- 到期的那一天：券的有效期到、会籍周期的最后一天（补充期也记这一天）、赠金作废的那一天
  target_date date NOT NULL,
  -- 顾客同意的是哪个模板（微信按模板记次数）
  template_id text NOT NULL CHECK (template_id ~ '^[A-Za-z0-9_-]{10,64}$'),
  -- 哪天发（营业日）：到期前几天（MP28），同意时已经过了就是当天
  due_date    date NOT NULL,
  -- 同一样东西的同一种提醒第几次同意（之前那条没发出、不用发了、模板换过的，再同意记下一次）
  seq         integer NOT NULL DEFAULT 1 CHECK (seq >= 1),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'coupon') = (coupon_id IS NOT NULL)),
  CHECK (due_date <= target_date + 1)
);
CREATE UNIQUE INDEX mp_reminder_consents_target_idx ON mp_reminder_consents (binding_id, kind, coalesce(coupon_id, 0), target_date, seq);
CREATE INDEX mp_reminder_consents_due_idx ON mp_reminder_consents (due_date, id);
CREATE INDEX mp_reminder_consents_member_idx ON mp_reminder_consents (member_id);

CREATE TRIGGER mp_reminder_consents_append_only BEFORE UPDATE OR DELETE ON mp_reminder_consents
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

CREATE TABLE mp_reminder_messages (
  id           bigserial PRIMARY KEY,
  consent_id   bigint NOT NULL UNIQUE REFERENCES mp_reminder_consents (id),
  -- queued 排队、leased 网关取走了、sent 发出、failed 没发出、unknown 结果不明、skipped 不发
  status       text NOT NULL CHECK (status IN ('queued', 'leased', 'sent', 'failed', 'unknown', 'skipped')),
  -- 不发的原因、没发出的原因（顾客看不到，后台看）
  reason       text CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 200),
  -- 点开消息进的页面与模板的各个字段（{"thing1": {"value": "…"}}）；不发的没有
  page         text CHECK (page IS NULL OR page ~ '^pages/[a-z0-9-]+/index(\?[A-Za-z0-9=&_-]*)?$'),
  data         jsonb,
  -- 过了这一天（营业日）就不用发了：券的有效期到、会籍周期的最后一天、补充期的最后一天、赠金最后能用的一天
  valid_until  date,
  -- 网关这一次取走用的凭据与期限：过了期限没回报的记「结果不明」；同一批用同一个批次号（网关没收到回答时按批次号再要一次）
  lease_token  uuid,
  lease_batch  uuid,
  leased_until timestamptz,
  -- 要再试的：这个时间以后再给网关
  retry_after  timestamptz,
  attempts     integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  -- 微信回的错误码（没发出、要再试的）
  errcode      integer,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  -- 要发的都有页面与字段；排期时就不用发的没有，取走前才发现不用发的留着原来排好的
  CHECK (status = 'skipped' OR (page IS NOT NULL AND data IS NOT NULL)),
  CHECK ((page IS NULL) = (data IS NULL)),
  CHECK ((page IS NULL) = (valid_until IS NULL)),
  CHECK ((status IN ('sent', 'failed', 'unknown', 'skipped')) = (finished_at IS NOT NULL)),
  CHECK ((status = 'leased') = (lease_token IS NOT NULL)),
  CHECK ((lease_token IS NULL) = (leased_until IS NULL)),
  CHECK ((lease_token IS NULL) = (lease_batch IS NULL)),
  CHECK (status NOT IN ('skipped', 'failed') OR reason IS NOT NULL)
);
CREATE INDEX mp_reminder_messages_open_idx ON mp_reminder_messages (status, id) WHERE status IN ('queued', 'leased');
CREATE INDEX mp_reminder_messages_batch_idx ON mp_reminder_messages (lease_batch) WHERE lease_batch IS NOT NULL;
CREATE INDEX mp_reminder_messages_created_idx ON mp_reminder_messages (created_at DESC);

-- 状态只能照设计稿变；同意、页面、字段、建的时间不能改；不能删
CREATE FUNCTION yuzu_mp_reminder_message_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '提醒消息不能删除' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.consent_id, NEW.page, NEW.data, NEW.valid_until, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.consent_id, OLD.page, OLD.data, OLD.valid_until, OLD.created_at) THEN
    RAISE EXCEPTION '提醒消息的内容不能改' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION '提醒消息的发送次数只能增加' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'queued' AND NEW.status IN ('leased', 'skipped'))
    OR (OLD.status = 'leased' AND NEW.status IN ('sent', 'failed', 'unknown', 'queued'))
  ) THEN
    RAISE EXCEPTION '提醒消息的状态不能从 % 改成 %', OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status IN ('sent', 'failed', 'unknown', 'skipped') THEN
    RAISE EXCEPTION '已经结束的提醒消息不能再改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER mp_reminder_messages_guard BEFORE UPDATE OR DELETE ON mp_reminder_messages
  FOR EACH ROW EXECUTE FUNCTION yuzu_mp_reminder_message_guard();

-- ③ 解绑满 3 年清除（MP16，docs/MP_PRIVACY.md：绑定期间保存，解绑后再保存 3 年，期满删除）：
--    绑定记录解绑满 3 年，去掉手机号与微信标识（openid），解绑原因换成固定的一句（原因是员工写的，可能写了手机号），记下清除时间；
--    同一条绑定下的线上充值单、领券记录、到期提醒的同意，去掉 openid（单子与记录照留：会员档案与储值是门店的账目，按账目的规定保存）；
--    「结果待确认」的作废登记只在当时有用，满 3 年的删掉。只放开这几种改法，其余照旧不能改、不能删。
--    之后这个微信的绑定状态版本号（按 openid 数绑定、解绑）会变小：只影响 3 年以前的请求，那些请求的编号门店系统已经认不出这个微信，照样拒绝。
ALTER TABLE mp_bindings ADD COLUMN purged_at timestamptz;
ALTER TABLE mp_bindings ALTER COLUMN openid DROP NOT NULL, ALTER COLUMN phone DROP NOT NULL;
ALTER TABLE mp_bindings ADD CONSTRAINT mp_bindings_purged CHECK (
  (purged_at IS NULL AND openid IS NOT NULL AND phone IS NOT NULL)
  OR (purged_at IS NOT NULL AND openid IS NULL AND phone IS NULL AND unbound_at IS NOT NULL AND purged_at >= unbound_at + interval '3 years')
);
CREATE INDEX mp_bindings_purge_idx ON mp_bindings (unbound_at) WHERE unbound_at IS NOT NULL AND purged_at IS NULL;

-- 绑定记录：只追加；解绑（四个字段从空填上一次）、解绑满 3 年清除（手机号、openid 清空，解绑原因换成固定的一句）以外都不能改
CREATE OR REPLACE FUNCTION mp_bindings_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'mp_bindings 禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.purged_at IS NOT NULL THEN
    RAISE EXCEPTION '已经清除的绑定记录不能再改' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.purged_at IS NOT NULL THEN
    IF OLD.unbound_at IS NULL OR NEW.openid IS NOT NULL OR NEW.phone IS NOT NULL OR NEW.unbind_reason IS DISTINCT FROM '解绑满 3 年，已清除'
       OR (NEW.id, NEW.member_id, NEW.mock, NEW.client_key, NEW.bound_at, NEW.unbound_at, NEW.unbound_by, NEW.unbind_client_key)
          IS DISTINCT FROM (OLD.id, OLD.member_id, OLD.mock, OLD.client_key, OLD.bound_at, OLD.unbound_at, OLD.unbound_by, OLD.unbind_client_key) THEN
      RAISE EXCEPTION '绑定记录只能在解绑满 3 年以后清除手机号与微信标识' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.unbound_at IS NOT NULL OR NEW.unbound_at IS NULL
     OR NEW.id <> OLD.id OR NEW.openid <> OLD.openid OR NEW.member_id <> OLD.member_id OR NEW.phone <> OLD.phone
     OR NEW.mock <> OLD.mock OR NEW.client_key <> OLD.client_key OR NEW.bound_at <> OLD.bound_at THEN
    RAISE EXCEPTION '绑定记录只能解绑一次，其余不可修改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- 领券记录、到期提醒的同意：只追加；绑定记录清除时去掉 openid 以外都不能改、不能删
CREATE FUNCTION yuzu_mp_purge_openid_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% 只追加，不能删除', TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  IF NEW.openid IS NULL AND OLD.openid IS NOT NULL
     AND (to_jsonb(NEW) - 'openid') = (to_jsonb(OLD) - 'openid')
     AND EXISTS (SELECT 1 FROM mp_bindings b WHERE b.id = OLD.binding_id AND b.purged_at IS NOT NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% 只追加，只能在绑定记录清除时去掉微信标识', TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$;
ALTER TABLE mp_coupon_claims ALTER COLUMN openid DROP NOT NULL;
DROP TRIGGER mp_coupon_claims_append_only ON mp_coupon_claims;
CREATE TRIGGER mp_coupon_claims_append_only BEFORE UPDATE OR DELETE ON mp_coupon_claims
  FOR EACH ROW EXECUTE FUNCTION yuzu_mp_purge_openid_guard();
ALTER TABLE mp_reminder_consents ALTER COLUMN openid DROP NOT NULL;
DROP TRIGGER mp_reminder_consents_append_only ON mp_reminder_consents;
CREATE TRIGGER mp_reminder_consents_append_only BEFORE UPDATE OR DELETE ON mp_reminder_consents
  FOR EACH ROW EXECUTE FUNCTION yuzu_mp_purge_openid_guard();

-- 线上充值单（046）：照原来的规则，另外放开绑定记录清除时去掉 openid
ALTER TABLE mp_recharge_orders ALTER COLUMN openid DROP NOT NULL;
CREATE OR REPLACE FUNCTION mp_recharge_orders_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '线上充值单不能删除' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.openid IS DISTINCT FROM OLD.openid
     AND NOT (NEW.openid IS NULL AND EXISTS (SELECT 1 FROM mp_bindings b WHERE b.id = OLD.binding_id AND b.purged_at IS NOT NULL)) THEN
    RAISE EXCEPTION '线上充值单的单号、会员、套餐、金额与预估不能改' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.order_no, NEW.client_key, NEW.binding_id, NEW.member_id, NEW.plan_id, NEW.plan_name, NEW.amount,
      NEW.est_bonus, NEW.est_label, NEW.business_date, NEW.expires_at, NEW.mock, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.order_no, OLD.client_key, OLD.binding_id, OLD.member_id, OLD.plan_id, OLD.plan_name, OLD.amount,
      OLD.est_bonus, OLD.est_label, OLD.business_date, OLD.expires_at, OLD.mock, OLD.created_at) THEN
    RAISE EXCEPTION '线上充值单的单号、会员、套餐、金额与预估不能改' USING ERRCODE = 'P0001';
  END IF;
  IF (OLD.prepay_id IS NOT NULL AND NEW.prepay_id IS DISTINCT FROM OLD.prepay_id)
     OR (OLD.transaction_id IS NOT NULL AND (NEW.transaction_id, NEW.paid_at) IS DISTINCT FROM (OLD.transaction_id, OLD.paid_at))
     OR (OLD.recharge_id IS NOT NULL
         AND (NEW.recharge_id, NEW.credited_member_id, NEW.booked_at, NEW.booked_label, NEW.flags)
             IS DISTINCT FROM (OLD.recharge_id, OLD.credited_member_id, OLD.booked_at, OLD.booked_label, OLD.flags))
     OR (OLD.closed_at IS NOT NULL AND (NEW.closed_at, NEW.close_reason) IS DISTINCT FROM (OLD.closed_at, OLD.close_reason))
     OR (OLD.hold_code IS NOT NULL AND (NEW.hold_code, NEW.hold_message, NEW.held_at) IS DISTINCT FROM (OLD.hold_code, OLD.hold_message, OLD.held_at))
     OR (OLD.resolution IS NOT NULL
         AND (NEW.resolution, NEW.resolution_note, NEW.resolved_by, NEW.resolved_at, NEW.resolve_client_key)
             IS DISTINCT FROM (OLD.resolution, OLD.resolution_note, OLD.resolved_by, OLD.resolved_at, OLD.resolve_client_key)) THEN
    RAISE EXCEPTION '线上充值单已经记下的不能改' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'pending' AND NEW.status IN ('paid', 'closed', 'held'))
    OR (OLD.status = 'closed' AND NEW.status IN ('paid', 'held'))
    OR (OLD.status = 'held' AND NEW.status IN ('paid', 'handled'))) THEN
    RAISE EXCEPTION '线上充值单不能从 % 改成 %', OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- 作废登记（044）：只追加；满 3 年的可以删（只在当时有用）
CREATE FUNCTION yuzu_mp_op_fences_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.created_at <= now() - interval '3 years' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'mp_op_fences 只追加，满 3 年的才能删除' USING ERRCODE = 'P0001';
END $$;
DROP TRIGGER mp_op_fences_append_only ON mp_op_fences;
CREATE TRIGGER mp_op_fences_append_only BEFORE UPDATE OR DELETE ON mp_op_fences
  FOR EACH ROW EXECUTE FUNCTION yuzu_mp_op_fences_guard();
