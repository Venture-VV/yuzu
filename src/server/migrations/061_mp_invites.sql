-- 小程序第三期 3b：邀请好友（小程序线，docs/MP_PHASE3.md 第 2 节；MP30、MP31）。
--   ① mp_invites：邀请码——哪位会员（哪条绑定）发的、码、7 天内有效（MP30）、状态（待领取、已领取、已收回；过了有效期的按时间算过期）；
--      好友领取以后记下好友的会员、好友这个微信的绑定（绑上了的话）与主线建的临时身份（member_trials，v0.7.28 的 createTrialInviteFromMp）。
--      不存微信标识：邀请人、好友都按绑定记录找（解绑满 3 年清除时一并清掉，不用另管）。状态只能 待领取 → 已领取 / 已收回，触发器兜底。
--   ② mp_op_fences 加一类 mp_invite：好友领取的结果不确定时确认作废这个编号（与绑定、领券一样只认同一个微信）。
-- 只建新表、只给小程序线自己的作废登记加一类；只用外键引用会员、绑定记录与主线的临时身份。061 登记给小程序线（ROADMAP 第 7 节；
-- 主线预留 051–060，小程序线第三期之后从 061 起）。

CREATE TABLE mp_invites (
  id                 bigserial PRIMARY KEY,
  -- 分享卡片带的邀请码（不含容易看错的 0、1、I、O）
  code               text NOT NULL UNIQUE CHECK (code ~ '^[2-9A-HJ-NP-Z]{10}$'),
  -- 发起的操作编号：同一个编号重提返回同一个码
  client_key         uuid NOT NULL UNIQUE,
  inviter_member_id  bigint NOT NULL REFERENCES members (id),
  inviter_binding_id bigint NOT NULL REFERENCES mp_bindings (id),
  -- 发起时好友能体验的档阶（显示用；领取时以主线那时的规则为准）
  label              text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 40),
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'used', 'revoked')),
  -- 好友领取：领取的操作编号、好友的会员、好友这个微信的绑定（这位会员已经绑了别的微信时为空）、主线的临时身份
  claim_client_key   uuid UNIQUE,
  invitee_member_id  bigint REFERENCES members (id),
  invitee_binding_id bigint REFERENCES mp_bindings (id),
  trial_id           bigint UNIQUE REFERENCES member_trials (id),
  used_at            timestamptz,
  revoked_at         timestamptz,
  CHECK (expires_at > created_at),
  CHECK ((status = 'used') = (used_at IS NOT NULL)),
  CHECK (status <> 'used' OR (trial_id IS NOT NULL AND invitee_member_id IS NOT NULL AND claim_client_key IS NOT NULL)),
  CHECK (status = 'used' OR (trial_id IS NULL AND invitee_member_id IS NULL AND invitee_binding_id IS NULL AND claim_client_key IS NULL)),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (invitee_member_id IS NULL OR invitee_member_id <> inviter_member_id)
);
CREATE INDEX mp_invites_inviter_idx ON mp_invites (inviter_member_id, id DESC);
CREATE INDEX mp_invites_open_idx ON mp_invites (inviter_member_id) WHERE status = 'open';
CREATE INDEX mp_invites_created_idx ON mp_invites (created_at DESC);

-- 邀请码：不能删；码、邀请人、有效期、发起的编号不能改；状态只能 待领取 → 已领取 / 已收回，结束了的不能再改
CREATE FUNCTION yuzu_mp_invite_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '邀请码不能删除' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.code, NEW.client_key, NEW.inviter_member_id, NEW.inviter_binding_id, NEW.label, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM (OLD.id, OLD.code, OLD.client_key, OLD.inviter_member_id, OLD.inviter_binding_id, OLD.label, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION '邀请码的码、邀请人、有效期不能改' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION '已经领取或收回的邀请码不能再改' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status NOT IN ('used', 'revoked') THEN
    RAISE EXCEPTION '邀请码只能领取或收回' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mp_invites_guard BEFORE UPDATE OR DELETE ON mp_invites
  FOR EACH ROW EXECUTE FUNCTION yuzu_mp_invite_guard();

-- 好友领取的确认作废：与绑定、建单、领券一样只认同一个微信
ALTER TABLE mp_op_fences DROP CONSTRAINT mp_op_fences_op_type_check;
ALTER TABLE mp_op_fences ADD CONSTRAINT mp_op_fences_op_type_check CHECK (op_type IN ('mp_bind', 'mp_banner', 'mp_recharge', 'mp_coupon', 'mp_invite'));
ALTER TABLE mp_op_fences DROP CONSTRAINT mp_op_fences_actor;
ALTER TABLE mp_op_fences ADD CONSTRAINT mp_op_fences_actor CHECK (
  (op_type IN ('mp_bind', 'mp_recharge', 'mp_coupon', 'mp_invite') AND openid IS NOT NULL AND staff_id IS NULL)
  OR (op_type = 'mp_banner' AND staff_id IS NOT NULL AND openid IS NULL)
);
