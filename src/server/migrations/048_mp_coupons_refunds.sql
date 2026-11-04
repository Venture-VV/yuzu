-- 小程序第二期 2c 线上领券（docs/MP_COUPONS.md；MP22、MP27）与 2d 原路退回（docs/MP_RECHARGE.md 第 9 节；MP21），小程序线。
--   ① mp_coupon_claims：领取记录，只追加——哪张券模板、哪位会员、哪个微信（绑定记录）、第几张、主线发的那张券（发券记录与券）。
--      （券模板、会员、第几张）唯一：每人限领 N 张时，同一位会员同时点两次也只出一张；操作编号唯一：同一个编号只领一次。
--      哪些券模板可领、每人限领几张是领券中心的设置（settings 的 mp_coupon_rules，带版本号），不另建表。
--   ② mp_op_fences 加一类 mp_coupon：领取结果不确定时确认作废这个编号（与绑定、建单一样只认同一个微信）。
--   ③ mp_refund_orders（2d）：主线退储值单里交给门店系统原路退回的一行（route = mp_auto，主线 049），按行号唯一建一张原路退回单；
--      商户退款单号建单时定下（重试同一个单号，微信只退一次）；状态只能照设计稿第 9 节变，触发器兜底。
--   ④ mp_refund_events（2d）：原路退回单的记录，只追加：建单、申请退款、查退款、退款通知、店主重试与另行处理。
-- 只建新表、只给小程序线自己的作废登记加一类；只用外键引用券模板、会员、绑定记录、发券记录与券、退储值单与它的行、充值单、
-- 线上充值单与员工。048 登记给小程序线（ROADMAP 第 7 节）。发券记录的种类「小程序领取」与退储值行的 route 是主线 049 加的；
-- 两条线的迁移互不依赖，这里只引用 047 以前就有的表与列。

CREATE TABLE mp_coupon_claims (
  id          bigserial PRIMARY KEY,
  client_key  uuid NOT NULL UNIQUE,
  template_id bigint NOT NULL REFERENCES coupon_templates (id),
  member_id   bigint NOT NULL REFERENCES members (id),
  binding_id  bigint NOT NULL REFERENCES mp_bindings (id),
  openid      text NOT NULL CHECK (openid ~ '^[A-Za-z0-9_-]{6,64}$'),
  -- 这位会员这张券模板领的第几张（从 1 起）
  seq         integer NOT NULL CHECK (seq >= 1),
  issue_id    bigint NOT NULL UNIQUE REFERENCES coupon_issues (id),
  coupon_id   bigint NOT NULL UNIQUE REFERENCES coupons (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, member_id, seq)
);
CREATE INDEX mp_coupon_claims_member_idx ON mp_coupon_claims (member_id, template_id);
CREATE INDEX mp_coupon_claims_created_idx ON mp_coupon_claims (created_at DESC);

CREATE TRIGGER mp_coupon_claims_append_only BEFORE UPDATE OR DELETE ON mp_coupon_claims
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- 领取的确认作废：与绑定、建单一样只认同一个微信
ALTER TABLE mp_op_fences DROP CONSTRAINT mp_op_fences_op_type_check;
ALTER TABLE mp_op_fences ADD CONSTRAINT mp_op_fences_op_type_check CHECK (op_type IN ('mp_bind', 'mp_banner', 'mp_recharge', 'mp_coupon'));
ALTER TABLE mp_op_fences DROP CONSTRAINT mp_op_fences_actor;
ALTER TABLE mp_op_fences ADD CONSTRAINT mp_op_fences_actor CHECK (
  (op_type IN ('mp_bind', 'mp_recharge', 'mp_coupon') AND openid IS NOT NULL AND staff_id IS NULL)
  OR (op_type = 'mp_banner' AND staff_id IS NOT NULL AND openid IS NULL)
);

-- ③ 原路退回单（2d）
CREATE TABLE mp_refund_orders (
  id                bigserial PRIMARY KEY,
  -- 主线退储值单的那一行（route = mp_auto）：按行号唯一，重复取到也只建一张
  line_id           bigint NOT NULL UNIQUE REFERENCES member_refund_lines (id),
  member_refund_id  bigint NOT NULL REFERENCES member_refunds (id),
  member_id         bigint NOT NULL REFERENCES members (id),
  recharge_id       bigint NOT NULL REFERENCES recharges (id),
  -- 原来那笔线上充值单（按充值单找；找不到的记「没能退」给店主看）
  recharge_order_id bigint REFERENCES mp_recharge_orders (id),
  out_trade_no      text CHECK (out_trade_no ~ '^MPR[0-9]{8}[0-9A-Z]{10}$'),
  -- 原来那笔的微信支付交易单号
  transaction_id    text NOT NULL CHECK (char_length(transaction_id) BETWEEN 1 AND 64),
  -- 商户退款单号：建单时定下；店主重试关闭了的退款时换一个新的（旧的记在记录里）
  out_refund_no     text NOT NULL UNIQUE CHECK (out_refund_no ~ '^MPRF[0-9]{8}[0-9A-Z]{10}$'),
  amount            bigint NOT NULL CHECK (amount > 0),
  -- 原订单金额（微信要求带上）
  total             bigint CHECK (total IS NULL OR total >= amount),
  mock              boolean NOT NULL,
  -- new 待申请、processing 微信处理中、success 已退到、abnormal 退款异常（顾客的卡注销等，要到商户平台处理）、
  -- closed 退款关闭、failed 没能退（申请被拒、找不到原单）、handled 店主已另行处理
  status            text NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new', 'processing', 'success', 'abnormal', 'closed', 'failed', 'handled')),
  wx_refund_id      text CHECK (wx_refund_id IS NULL OR char_length(wx_refund_id) BETWEEN 1 AND 64),
  received_account  text CHECK (received_account IS NULL OR char_length(received_account) <= 64),
  succeeded_at      timestamptz,
  fail_code         text CHECK (fail_code IS NULL OR fail_code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  fail_message      text CHECK (fail_message IS NULL OR char_length(fail_message) <= 300),
  -- 申请失败（连不上、微信出错）重试的次数与下一次的时间
  attempts          integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_try_at       timestamptz,
  queried_at        timestamptz,
  handled_note      text CHECK (handled_note IS NULL OR char_length(btrim(handled_note)) BETWEEN 1 AND 200),
  handled_by        bigint REFERENCES staff (id),
  handled_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'success') = (succeeded_at IS NOT NULL)),
  CHECK ((status = 'handled') = (handled_at IS NOT NULL AND handled_by IS NOT NULL AND handled_note IS NOT NULL)),
  CHECK (status <> 'failed' OR fail_code IS NOT NULL)
);
CREATE INDEX mp_refund_orders_open_idx ON mp_refund_orders (id) WHERE status IN ('new', 'processing');
CREATE INDEX mp_refund_orders_member_idx ON mp_refund_orders (member_id, id);

CREATE FUNCTION mp_refund_orders_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '原路退回单不能删除' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.line_id, NEW.member_refund_id, NEW.member_id, NEW.recharge_id, NEW.recharge_order_id, NEW.out_trade_no,
      NEW.transaction_id, NEW.amount, NEW.total, NEW.mock, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.line_id, OLD.member_refund_id, OLD.member_id, OLD.recharge_id, OLD.recharge_order_id, OLD.out_trade_no,
      OLD.transaction_id, OLD.amount, OLD.total, OLD.mock, OLD.created_at) THEN
    RAISE EXCEPTION '原路退回单的退储值行、会员、原单与金额不能改' USING ERRCODE = 'P0001';
  END IF;
  -- 换商户退款单号只在店主重试关闭了、没能退的退款时（回到待申请）
  IF NEW.out_refund_no IS DISTINCT FROM OLD.out_refund_no AND NOT (OLD.status IN ('closed', 'failed') AND NEW.status = 'new') THEN
    RAISE EXCEPTION '原路退回单的商户退款单号不能改' USING ERRCODE = 'P0001';
  END IF;
  IF (OLD.succeeded_at IS NOT NULL AND NEW.succeeded_at IS DISTINCT FROM OLD.succeeded_at)
     OR (OLD.handled_at IS NOT NULL
         AND (NEW.handled_note, NEW.handled_by, NEW.handled_at) IS DISTINCT FROM (OLD.handled_note, OLD.handled_by, OLD.handled_at)) THEN
    RAISE EXCEPTION '原路退回单已经记下的不能改' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'new' AND NEW.status IN ('processing', 'success', 'abnormal', 'closed', 'failed'))
    OR (OLD.status = 'processing' AND NEW.status IN ('success', 'abnormal', 'closed'))
    OR (OLD.status = 'abnormal' AND NEW.status IN ('success', 'closed', 'handled'))
    OR (OLD.status = 'closed' AND NEW.status IN ('new', 'handled'))
    -- 没能退的：店主重试回待申请、另行处理；微信那边对现在这个单号说了在退、退到了的以微信的为准
    OR (OLD.status = 'failed' AND NEW.status IN ('new', 'handled', 'processing', 'success', 'abnormal', 'closed'))) THEN
    RAISE EXCEPTION '原路退回单不能从 % 改成 %', OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER mp_refund_orders_guard BEFORE UPDATE OR DELETE ON mp_refund_orders
  FOR EACH ROW EXECUTE FUNCTION mp_refund_orders_guard();

-- ④ 原路退回单的记录（只追加）
CREATE TABLE mp_refund_events (
  id          bigserial PRIMARY KEY,
  -- 找不到原路退回单的退款通知（例如商户平台上手动退的、配到了这个地址）为空
  order_id    bigint REFERENCES mp_refund_orders (id),
  kind        text NOT NULL CHECK (kind IN ('created', 'apply', 'query', 'notify', 'retry', 'handled')),
  ok          boolean NOT NULL,
  code        text CHECK (code IS NULL OR code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  staff_id    bigint REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mp_refund_events_order_idx ON mp_refund_events (order_id, id);
CREATE TRIGGER mp_refund_events_append_only BEFORE UPDATE OR DELETE ON mp_refund_events
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
