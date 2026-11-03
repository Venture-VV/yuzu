-- 浴族 yuzu · 小程序线（docs/MINIPROGRAM.md 第 12 节）：「结果待确认」的作废登记（Codex 审查 PR #42 的两个 P1）
--
-- 小程序绑定会员、后台新建首页轮播都带操作编号（client_key）。请求超时、断网或回复出错后结果不确定时，
-- 只读查回查不到不能断定没生效（AGENTS.md）：小程序或后台可以请门店系统「确认作废」这个编号，之后原请求即使晚到也不会生效。
--   · 绑定：作废与绑定都先取这个微信的咨询锁（hashtext('mp_bind:' || openid)），二者不交错；
--     已经绑上了就只返回查回的结果，不作废；作废登记只认同一个微信（openid）。
--   · 新建轮播：作废与新建都先取这个编号的咨询锁（hashtext('mp_banner:' || client_key)）；已经建了就返回那一条。
-- 用小程序线自己的表，不动共用的 op_fences（它的业务类型由每个迁移整段重写，两条开发线同时改会互相覆盖）。
-- 只追加：登记了就不能改、不能删。

CREATE TABLE mp_op_fences (
  key        uuid NOT NULL,
  op_type    text NOT NULL CHECK (op_type IN ('mp_bind', 'mp_banner')),
  -- 绑定：哪个微信作废的；新建轮播：哪位员工作废的
  openid     text CHECK (openid ~ '^[A-Za-z0-9_-]{6,64}$'),
  staff_id   bigint REFERENCES staff (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key, op_type),
  CONSTRAINT mp_op_fences_actor CHECK (
    (op_type = 'mp_bind' AND openid IS NOT NULL AND staff_id IS NULL)
    OR (op_type = 'mp_banner' AND staff_id IS NOT NULL AND openid IS NULL)
  )
);

CREATE TRIGGER mp_op_fences_append_only BEFORE UPDATE OR DELETE ON mp_op_fences
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
