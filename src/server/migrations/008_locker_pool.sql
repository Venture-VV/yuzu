-- Batch 2.2：真实柜池（店主 2026-10-27 #26、#27、#29、#30）
--   · 手牌增加柜型（普通柜 / VIP 柜）与 VIP 等级；区号不单独存，取牌号的字母前缀（A8060 → A 区）；
--   · 取消儿童区：只在库里没有任何儿童区手牌与来访时收紧约束；有旧数据时保留（不改不删已有数据），
--     由应用拒绝新的儿童区登记，旧手牌在「管理 → 手牌」改为男宾或女宾；
--   · 当场授权凭据：值班经理 / 店总在当前弹窗输入账号密码后签发，绑定用途、申请人与对象，5 分钟内一次有效；
--   · 低于柜子等级的客人经授权使用 VIP 柜时，记下授权人；
--   · 前台更正时限默认改为 15 分钟（仍是旧默认 10 分钟时才改，已手动调整过的不动）。

ALTER TABLE hand_tags
  ADD COLUMN kind      text NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal', 'vip')),
  ADD COLUMN vip_level smallint CHECK (vip_level BETWEEN 1 AND 9),
  ADD CONSTRAINT hand_tags_vip_kind_check CHECK ((kind = 'vip') = (vip_level IS NOT NULL));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM hand_tags WHERE zone = 'child') AND NOT EXISTS (SELECT 1 FROM visits WHERE zone = 'child') THEN
    ALTER TABLE hand_tags DROP CONSTRAINT hand_tags_zone_check;
    ALTER TABLE hand_tags ADD CONSTRAINT hand_tags_zone_check CHECK (zone IN ('male', 'female'));
    ALTER TABLE visits DROP CONSTRAINT visits_zone_check;
    ALTER TABLE visits ADD CONSTRAINT visits_zone_check CHECK (zone IN ('male', 'female'));
  ELSE
    RAISE NOTICE '库里有儿童区的手牌或来访，保留原分区约束；请在「管理 → 手牌」把旧儿童区手牌改为男宾或女宾';
  END IF;
END $$;

-- 当场授权凭据（Batch 2.4 的单笔超限授权也使用）
CREATE TABLE auth_grants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose      text NOT NULL CHECK (purpose IN ('vip_tag', 'over_limit')),
  requested_by bigint NOT NULL REFERENCES staff (id),
  approved_by  bigint NOT NULL REFERENCES staff (id),
  -- 授权对象，例如 {"tagCodes": ["9058"], "memberId": 12}
  scope        jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  -- 用在哪一笔业务（操作编号）
  used_ref     text,
  CHECK (expires_at > created_at),
  CHECK ((used_at IS NULL) = (used_ref IS NULL))
);
CREATE INDEX auth_grants_requested_idx ON auth_grants (requested_by, created_at);

-- 已使用的授权不能改回、不能删除
CREATE FUNCTION yuzu_auth_grant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'auth_grants 禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.used_at IS NOT NULL
     OR NEW.id <> OLD.id OR NEW.purpose <> OLD.purpose OR NEW.requested_by <> OLD.requested_by
     OR NEW.approved_by <> OLD.approved_by OR NEW.scope <> OLD.scope OR NEW.created_at <> OLD.created_at
     OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'auth_grants 只能登记一次使用' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER auth_grants_guard BEFORE UPDATE OR DELETE ON auth_grants
  FOR EACH ROW EXECUTE FUNCTION yuzu_auth_grant_guard();

-- 开牌时的 VIP 授权人；换牌的授权记在换牌记录上
ALTER TABLE visits ADD COLUMN vip_override_by bigint REFERENCES staff (id);
ALTER TABLE visit_tag_changes ADD COLUMN vip_override_by bigint REFERENCES staff (id);

UPDATE settings SET value = jsonb_set(value, '{selfVoidMinutes}', '15')
WHERE key = 'frontdesk_rules' AND value->>'selfVoidMinutes' = '10';
