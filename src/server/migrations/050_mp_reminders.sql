-- 小程序第三期 3a：到期提醒（订阅消息；小程序线，docs/MP_PHASE3.md 第 1 节；MP28、MP29）。
--   ① mp_reminder_consents：顾客的同意，只追加——哪个微信（绑定记录）、哪位会员、提醒什么（券、会籍、补充期、赠金）、
--      提醒哪一张券或哪一天到期的、用的哪个模板、哪天发（北京时间）。微信只给这类门店一次性订阅：顾客点一次「提醒我」、
--      在微信的弹窗里同意一次，门店系统才能给他发一条。同一条绑定对同一样东西的同一种提醒，还在等、已发出的只记一条
--      （再点返回原来那条）；之前那条没发出、不用发了或模板换过的，再同意一次记新的一条（seq 加一）。
--   ② mp_reminder_messages：每条同意最多一条消息，到了那天、在 10:00–20:00 之间排进来（MP29）。状态：排队 → 网关取走 →
--      发出 / 没发出 / 结果不明（网关取走以后没回报：不再发第二次，一次同意只发一条）；到点时、网关来取时已经不用提醒的
--      （券用掉了、过了到期日、会籍续上了、解绑了）记「不发」与原因。要再试的隔一会儿再给网关。状态只能这样变，触发器兜底。
-- 只建新表；只用外键引用会员、绑定记录与券。050 登记给小程序线（ROADMAP 第 7 节），只读券、会员档阶、赠金批次，主线不用改。

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
