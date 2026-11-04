-- 046 微信小程序第二期 2a（小程序线，docs/MP_RECHARGE.md）：线上充值单
--   ① mp_recharge_orders：线上充值单，一单一行。单号、会员、微信、套餐、金额、预估建单后不能改；状态只能
--      待支付 → 已入账 / 已关闭 / 已付款待处理，已关闭 → 已入账 / 已付款待处理（关单前一刻付了的），
--      已付款待处理 → 已入账 / 已处理；已经写上的（微信下单号、交易单号、入账、关单、待处理的原因、店主的处理）不能改（触发器兜底）。
--      一位会员同时只有一张待支付的（唯一索引）。入账走主线钱包的线上收款入口（recharges 的 channel = 'mp'），这里只记入账的充值单。
--   ② mp_recharge_events：单子的记录，只追加：建单、微信下单、到账通知（验过签的）、查单、关单、入账、待处理、店主处理。
--   ③ mp_op_fences 加一类 mp_recharge：建单结果不确定时确认作废这个编号（与绑定一样只认同一个微信）。
--   ④ mp_recharge_recons（2b 对账）：每天下前一天的微信支付交易账单，与线上充值单逐笔核对的结论，只追加。
-- 只建新表、只给小程序线自己的作废登记加一类；只用外键引用会员、绑定记录、充值套餐、充值单与员工。
-- 046 登记给小程序第二期（ROADMAP 第 7 节）；主线的 047 可能先跑，所以这里只引用 045 以前就有的表与列。

CREATE TABLE mp_recharge_orders (
  id                  bigserial PRIMARY KEY,
  -- 商户单号（微信支付的 out_trade_no）：MPR + 下单的营业日 + 10 位随机
  order_no            text NOT NULL UNIQUE CHECK (order_no ~ '^MPR[0-9]{8}[0-9A-Z]{10}$'),
  -- 小程序的操作编号：同一个编号重提返回这张单
  client_key          uuid NOT NULL UNIQUE,
  -- 付款的微信（到账通知里的付款人要是它）与下单时的绑定记录
  openid              text NOT NULL CHECK (openid ~ '^[A-Za-z0-9_-]{6,64}$'),
  binding_id          bigint NOT NULL REFERENCES mp_bindings (id),
  member_id           bigint NOT NULL REFERENCES members (id),
  -- 选的充值套餐与下单时的名称；自定义金额两样都空
  plan_id             bigint REFERENCES recharge_plans (id),
  plan_name           text CHECK (plan_name IS NULL OR char_length(plan_name) BETWEEN 1 AND 32),
  -- 实付（分）
  amount              bigint NOT NULL CHECK (amount > 0),
  -- 下单时的预估（以到账时为准）：赠金（分）与充完的档阶
  est_bonus           bigint NOT NULL CHECK (est_bonus >= 0),
  est_label           text NOT NULL DEFAULT '' CHECK (char_length(est_label) <= 40),
  -- 下单的营业日（每人每天的笔数按它算）
  business_date       date NOT NULL,
  -- 微信支付的 time_expire（下单后 15 分钟）
  expires_at          timestamptz NOT NULL,
  -- 模拟微信支付的单子（只在 development、test 实例）
  mock                boolean NOT NULL DEFAULT false,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'closed', 'held', 'handled')),
  -- 微信支付下单拿到的 prepay_id（拿到一次就不变；没拿到的继续支付时再下单）
  prepay_id           text CHECK (prepay_id IS NULL OR prepay_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  -- 微信支付核实的付款：交易单号与付款时间
  transaction_id      text UNIQUE CHECK (transaction_id IS NULL OR transaction_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  paid_at             timestamptz,
  -- 入账：钱包的充值单、实际入账的会员（来源会员合并了时是合并进去的那位）
  recharge_id         bigint UNIQUE REFERENCES recharges (id),
  credited_member_id  bigint REFERENCES members (id),
  booked_at           timestamptz,
  -- 入账后的档阶（入账那一刻，给顾客看「充完是哪一档」）
  booked_label        text CHECK (booked_label IS NULL OR char_length(booked_label) <= 40),
  -- 入账时标出来给店主看的（入账照常）：到账时已停用、记到合并进去的会员、关单之后才付的
  flags               text[] NOT NULL DEFAULT '{}' CHECK (flags <@ ARRAY['frozen', 'merged', 'after_close']::text[]),
  -- 关单：到期、顾客取消、微信那边关了、微信下单失败
  closed_at           timestamptz,
  close_reason        text CHECK (close_reason IN ('expired', 'cancelled', 'wx_closed', 'wx_failed')),
  -- 已付款待处理：入账被拒（拒绝码与说明）或通知与单子对不上（MISMATCH）
  hold_code           text CHECK (hold_code IS NULL OR hold_code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  hold_message        text CHECK (hold_message IS NULL OR char_length(hold_message) BETWEEN 1 AND 300),
  held_at             timestamptz,
  -- 店主处理已付款待处理的：重新入账、按金额入账（不发套餐券）、已另行处理；写原因、记经办人
  resolution          text CHECK (resolution IN ('rebook', 'rebook_amount', 'handled')),
  resolution_note     text CHECK (resolution_note IS NULL OR char_length(btrim(resolution_note)) BETWEEN 1 AND 200),
  resolved_by         bigint REFERENCES staff (id),
  resolved_at         timestamptz,
  resolve_client_key  uuid UNIQUE,
  -- 上次去微信查单的时刻（顾客等结果时同一张单 3 秒一次、每分钟补查时 1 分钟一次）
  queried_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((plan_id IS NULL) = (plan_name IS NULL)),
  CHECK (expires_at > created_at),
  CHECK ((status = 'paid') = (recharge_id IS NOT NULL)),
  CHECK ((recharge_id IS NULL) = (credited_member_id IS NULL) AND (recharge_id IS NULL) = (booked_at IS NULL)
         AND (recharge_id IS NULL) = (booked_label IS NULL)),
  CHECK ((transaction_id IS NULL) = (paid_at IS NULL)),
  CHECK ((status IN ('pending', 'closed')) = (transaction_id IS NULL)),
  CHECK (status <> 'closed' OR closed_at IS NOT NULL),
  CHECK ((closed_at IS NULL) = (close_reason IS NULL)),
  CHECK ((hold_code IS NULL) = (hold_message IS NULL) AND (hold_code IS NULL) = (held_at IS NULL)),
  CHECK (status NOT IN ('held', 'handled') OR hold_code IS NOT NULL),
  CHECK ((resolution IS NULL) = (resolution_note IS NULL) AND (resolution IS NULL) = (resolved_by IS NULL)
         AND (resolution IS NULL) = (resolved_at IS NULL) AND (resolution IS NULL) = (resolve_client_key IS NULL)),
  CHECK (resolution IS NULL OR hold_code IS NOT NULL),
  CHECK ((status = 'handled') = (resolution IS NOT DISTINCT FROM 'handled')),
  CHECK (resolution IS NULL OR resolution = 'handled' OR status = 'paid'),
  CHECK (cardinality(flags) = 0 OR status = 'paid')
);
-- 一位会员同时只有一张待支付的
CREATE UNIQUE INDEX mp_recharge_orders_pending_uq ON mp_recharge_orders (member_id) WHERE status = 'pending';
CREATE INDEX mp_recharge_orders_member_idx ON mp_recharge_orders (member_id, id);
CREATE INDEX mp_recharge_orders_openid_idx ON mp_recharge_orders (openid, id);
-- 每分钟补查、关单的待支付；后台要处理的已付款待处理
CREATE INDEX mp_recharge_orders_open_idx ON mp_recharge_orders (status, created_at) WHERE status IN ('pending', 'held');

CREATE FUNCTION mp_recharge_orders_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '线上充值单不能删除' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.order_no, NEW.client_key, NEW.openid, NEW.binding_id, NEW.member_id, NEW.plan_id, NEW.plan_name, NEW.amount,
      NEW.est_bonus, NEW.est_label, NEW.business_date, NEW.expires_at, NEW.mock, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.order_no, OLD.client_key, OLD.openid, OLD.binding_id, OLD.member_id, OLD.plan_id, OLD.plan_name, OLD.amount,
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
CREATE TRIGGER mp_recharge_orders_guard BEFORE UPDATE OR DELETE ON mp_recharge_orders
  FOR EACH ROW EXECUTE FUNCTION mp_recharge_orders_guard();

CREATE TABLE mp_recharge_events (
  id          bigserial PRIMARY KEY,
  -- 找不到单子的到账通知（例如门店系统从备份恢复过）为空，后台单列给店主看
  order_id    bigint REFERENCES mp_recharge_orders (id),
  kind        text NOT NULL CHECK (kind IN ('created', 'wx_order', 'notify', 'query', 'close', 'booked', 'held', 'resolved')),
  ok          boolean NOT NULL,
  -- 拒绝、出错、对不上的代码
  code        text CHECK (code IS NULL OR code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- 店主处理时的经办人
  staff_id    bigint REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mp_recharge_events_order_idx ON mp_recharge_events (order_id, id);
CREATE INDEX mp_recharge_events_orphan_idx ON mp_recharge_events (id) WHERE order_id IS NULL;
CREATE TRIGGER mp_recharge_events_append_only BEFORE UPDATE OR DELETE ON mp_recharge_events
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- 2b 对账：每天下前一天的微信支付交易账单，与线上充值单逐笔核对的结论（只追加：重新核对再记一条，不改旧的）
CREATE TABLE mp_recharge_recons (
  id            bigserial PRIMARY KEY,
  -- 账单日（北京时间的自然日）
  bill_date     date NOT NULL,
  -- 都对上了；没对上的写在 issues 里（标红给店主看）
  ok            boolean NOT NULL,
  -- 微信账单里这一天的成功交易：笔数、金额（分）
  wx_count      integer NOT NULL CHECK (wx_count >= 0),
  wx_amount     bigint NOT NULL CHECK (wx_amount >= 0),
  -- 门店系统里这一天付款的单子（已入账、已付款待处理、已处理）：笔数、金额（分）
  store_count   integer NOT NULL CHECK (store_count >= 0),
  store_amount  bigint NOT NULL CHECK (store_amount >= 0),
  -- 没对上的（种类、商户单号、交易单号、两边的金额、说明）与账单里的退款
  issues        jsonb NOT NULL DEFAULT '[]'::jsonb,
  refunds       jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- auto 每天自动；manual 店主在后台点「重新核对」（记经办人）
  source        text NOT NULL CHECK (source IN ('auto', 'manual')),
  staff_id      bigint REFERENCES staff (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((source = 'manual') = (staff_id IS NOT NULL)),
  CHECK (ok = (jsonb_array_length(issues) = 0))
);
CREATE INDEX mp_recharge_recons_date_idx ON mp_recharge_recons (bill_date, id);
CREATE TRIGGER mp_recharge_recons_append_only BEFORE UPDATE OR DELETE ON mp_recharge_recons
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- 建单的确认作废：与绑定一样只认同一个微信
ALTER TABLE mp_op_fences DROP CONSTRAINT mp_op_fences_op_type_check;
ALTER TABLE mp_op_fences ADD CONSTRAINT mp_op_fences_op_type_check CHECK (op_type IN ('mp_bind', 'mp_banner', 'mp_recharge'));
ALTER TABLE mp_op_fences DROP CONSTRAINT mp_op_fences_actor;
ALTER TABLE mp_op_fences ADD CONSTRAINT mp_op_fences_actor CHECK (
  (op_type IN ('mp_bind', 'mp_recharge') AND openid IS NOT NULL AND staff_id IS NULL)
  OR (op_type = 'mp_banner' AND staff_id IS NOT NULL AND openid IS NULL)
);
