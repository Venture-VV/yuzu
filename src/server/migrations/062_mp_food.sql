-- 小程序第三期 3c：扫码点餐（小程序线，docs/MP_PHASE3.md 第 3 节；MP32、MP33）。
--   ① mp_food_orders：小程序下的每一单——哪条绑定、哪位会员、挂在哪次来访（手牌）、出品单号、送到哪张桌、合计，
--      以及下单那一刻点了什么（名称、份数、金额、口味备注；后台看记录、顾客重提时回第一次的结果用，账以主线的账单明细为准）。
--      下单的操作编号唯一：同一个编号重提返回这一单；结果不确定时「确认作废」查的也是它。只追加，不能改、不能删（触发器兜底）。
--      不存微信标识：按绑定记录找（解绑满 3 年清除时一并清掉，不用另管）。
--   ② mp_op_fences 加一类 mp_food：点单的结果不确定时确认作废这个编号（与绑定、领券、邀请一样只认同一个微信）。
-- 只建新表、只给小程序线自己的作废登记加一类；用外键引用绑定记录与来访（下单时主线已经锁住这次来访、绑定在小程序线的锁里，
-- 外键检查不另等）。会员不用外键（独立审查 3b/3c 的 P3）：记下这一单时主线已经写了实时位置，AGENTS.md 要求之后不再等别的业务锁，
-- 外键检查却要给会员一行加共享锁、会等充值、每天的会员处理这类锁住会员的事务；会员就是这条绑定的会员（同一个事务里取的）。
-- 062 登记给小程序线（ROADMAP 第 7 节；主线预留 051–060，小程序线第三期之后从 061 起）。

CREATE TABLE mp_food_orders (
  id          bigserial PRIMARY KEY,
  client_key  uuid NOT NULL UNIQUE,
  binding_id  bigint NOT NULL REFERENCES mp_bindings (id),
  member_id   bigint NOT NULL,
  visit_id    bigint NOT NULL REFERENCES visits (id),
  tag_code    text NOT NULL,
  -- 厨房出品单号（主线的出品单；没有进厨房的菜时为空，小程序只能点进厨房的菜，正常不会为空）
  order_no    text,
  -- 扫了桌码的：送到哪张桌（下单那一刻桌台的名字）；没扫的为空，服务员按手牌送
  deliver_to  text NOT NULL DEFAULT '' CHECK (char_length(deliver_to) <= 12),
  total       bigint NOT NULL CHECK (total >= 0),
  -- [{ name, quantity, amount, note }]
  lines       jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) BETWEEN 1 AND 20),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mp_food_orders_member_idx ON mp_food_orders (member_id, id DESC);
CREATE INDEX mp_food_orders_created_idx ON mp_food_orders (created_at DESC);

CREATE FUNCTION yuzu_mp_food_order_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '小程序的点单记录只追加，不能改、不能删' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER mp_food_orders_guard BEFORE UPDATE OR DELETE ON mp_food_orders
  FOR EACH ROW EXECUTE FUNCTION yuzu_mp_food_order_guard();

-- 点单的确认作废：与绑定、建单、领券、邀请一样只认同一个微信
ALTER TABLE mp_op_fences DROP CONSTRAINT mp_op_fences_op_type_check;
ALTER TABLE mp_op_fences ADD CONSTRAINT mp_op_fences_op_type_check CHECK (op_type IN ('mp_bind', 'mp_banner', 'mp_recharge', 'mp_coupon', 'mp_invite', 'mp_food'));
ALTER TABLE mp_op_fences DROP CONSTRAINT mp_op_fences_actor;
ALTER TABLE mp_op_fences ADD CONSTRAINT mp_op_fences_actor CHECK (
  (op_type IN ('mp_bind', 'mp_recharge', 'mp_coupon', 'mp_invite', 'mp_food') AND openid IS NOT NULL AND staff_id IS NULL)
  OR (op_type = 'mp_banner' AND staff_id IS NOT NULL AND openid IS NULL)
);
