-- 小程序第三期 3d：预约技师与派对房（小程序线，docs/MP_PHASE3.md 第 4 节；MP34–MP37；接主线 v0.7.28 的 bookings，迁移 053）。
--   ① mp_booking_ops：小程序的每一次预约、取消——操作编号、哪条绑定、哪位会员、哪张预约单。下单或取消的结果不确定时「确认作废」
--      查的就是它：有记录就是已经办了，回那一张；没有就登记作废，原请求之后再到也不办。只追加，不能改、不能删（触发器兜底）。
--      不存微信标识：按绑定记录找（解绑满 3 年清除时一并清掉，不用另管）。
--   ② mp_op_fences 加一类 mp_booking：预约、取消的确认作废（与绑定、领券、邀请、点餐一样只认同一个微信）。
--   ③ 到期提醒（050）加一种 booking「预约到店」：提醒哪一张预约单；同一条绑定对同一张预约单只记一条（唯一索引带上预约单）。
-- 只建新表、只给小程序线自己的作废登记与提醒的同意加一类；用外键引用绑定记录与主线的预约单（预约、取消时主线已经锁住或刚建了
-- 这张预约单）。会员不用外键：取消时外键检查要给会员一行加共享锁，会在锁着预约单的时候等别的事务锁住的会员（与 062 一样）。
-- 063 登记给小程序线（ROADMAP 第 7 节：主线预留 051–060，小程序线第三期之后从 061 起）。

CREATE TABLE mp_booking_ops (
  id          bigserial PRIMARY KEY,
  client_key  uuid NOT NULL UNIQUE,
  -- create 小程序预约、cancel 小程序取消
  action      text NOT NULL CHECK (action IN ('create', 'cancel')),
  binding_id  bigint NOT NULL REFERENCES mp_bindings (id),
  member_id   bigint NOT NULL,
  booking_id  bigint NOT NULL REFERENCES bookings (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- 一张预约单只有一次小程序预约（主线同一个编号只建一次）
CREATE UNIQUE INDEX mp_booking_ops_create_idx ON mp_booking_ops (booking_id) WHERE action = 'create';
CREATE INDEX mp_booking_ops_member_idx ON mp_booking_ops (member_id, id DESC);
CREATE INDEX mp_booking_ops_created_idx ON mp_booking_ops (created_at DESC);

CREATE FUNCTION yuzu_mp_booking_op_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '小程序的预约记录只追加，不能改、不能删' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER mp_booking_ops_guard BEFORE UPDATE OR DELETE ON mp_booking_ops
  FOR EACH ROW EXECUTE FUNCTION yuzu_mp_booking_op_guard();

-- 预约、取消的确认作废：与绑定、建单、领券、邀请、点餐一样只认同一个微信
ALTER TABLE mp_op_fences DROP CONSTRAINT mp_op_fences_op_type_check;
ALTER TABLE mp_op_fences ADD CONSTRAINT mp_op_fences_op_type_check
  CHECK (op_type IN ('mp_bind', 'mp_banner', 'mp_recharge', 'mp_coupon', 'mp_invite', 'mp_food', 'mp_booking'));
ALTER TABLE mp_op_fences DROP CONSTRAINT mp_op_fences_actor;
ALTER TABLE mp_op_fences ADD CONSTRAINT mp_op_fences_actor CHECK (
  (op_type IN ('mp_bind', 'mp_recharge', 'mp_coupon', 'mp_invite', 'mp_food', 'mp_booking') AND openid IS NOT NULL AND staff_id IS NULL)
  OR (op_type = 'mp_banner' AND staff_id IS NOT NULL AND openid IS NULL)
);

-- 到期提醒加一种「预约到店」：提醒哪一张预约单（只有 booking）；到期的那一天记预约单的营业日，当天 10:00–20:00 发
ALTER TABLE mp_reminder_consents ADD COLUMN booking_id bigint REFERENCES bookings (id);
ALTER TABLE mp_reminder_consents DROP CONSTRAINT mp_reminder_consents_kind_check;
ALTER TABLE mp_reminder_consents ADD CONSTRAINT mp_reminder_consents_kind_check CHECK (kind IN ('coupon', 'membership', 'grace', 'bonus', 'booking'));
ALTER TABLE mp_reminder_consents ADD CONSTRAINT mp_reminder_consents_booking CHECK ((kind = 'booking') = (booking_id IS NOT NULL));
DROP INDEX mp_reminder_consents_target_idx;
CREATE UNIQUE INDEX mp_reminder_consents_target_idx
  ON mp_reminder_consents (binding_id, kind, coalesce(coupon_id, 0), coalesce(booking_id, 0), target_date, seq);
CREATE INDEX mp_reminder_consents_booking_idx ON mp_reminder_consents (booking_id) WHERE booking_id IS NOT NULL;
