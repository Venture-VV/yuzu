-- 小程序第二期 2c：线上领券（小程序线，docs/MP_COUPONS.md；MP22、MP27）。
--   ① mp_coupon_claims：领取记录，只追加——哪张券模板、哪位会员、哪个微信（绑定记录）、第几张、主线发的那张券（发券记录与券）。
--      （券模板、会员、第几张）唯一：每人限领 N 张时，同一位会员同时点两次也只出一张；操作编号唯一：同一个编号只领一次。
--      哪些券模板可领、每人限领几张是领券中心的设置（settings 的 mp_coupon_rules，带版本号），不另建表。
--   ② mp_op_fences 加一类 mp_coupon：领取结果不确定时确认作废这个编号（与绑定、建单一样只认同一个微信）。
-- 只建新表、只给小程序线自己的作废登记加一类；只用外键引用券模板、会员、绑定记录、发券记录与券。
-- 048 登记给小程序线 2c（ROADMAP 第 7 节）。发券记录的种类「小程序领取」（mp_claim）是主线 049 加的；两条线的迁移互不依赖，
-- 这里只引用 047 以前就有的表与列。

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
