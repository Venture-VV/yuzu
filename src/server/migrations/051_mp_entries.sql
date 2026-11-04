-- v0.7.28 ①（主线）：给小程序第三期的入口（设计见 docs/SCHEDULE_FINISH.md 第 2 节、docs/MP_PHASE3.md 第 2–4 节）
--   · entry_claims：小程序线调主线入口时带的 claimKey 的去重记录（同一个 claimKey 只生效一次，再调用返回第一次的结果）。
--     3b 邀请好友（mp_invite）、3c 扫码点餐（mp_food）、3d 预约与取消预约（mp_booking / mp_booking_cancel，预约那一块用）。
--     只追加：生效的那一次记下请求摘要与结果（ref_id：临时身份 / 来访 / 预约单；ref_key：扫码点餐那一次挂账的编号）。
--   · kitchen_items.deliver_to：扫了桌上的码点的菜，出品单写送到哪张桌（桌台名称，空为送到客人手里）。
-- 只加表、加列，不改已有的行。

CREATE TABLE entry_claims (
  claim_key    text PRIMARY KEY CHECK (claim_key ~ '^(mp_invite|mp_food|mp_booking|mp_booking_cancel):[A-Za-z0-9_-]{1,64}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  ref_id       bigint NOT NULL,
  ref_key      uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER entry_claims_append_only BEFORE UPDATE OR DELETE ON entry_claims
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

ALTER TABLE kitchen_items ADD COLUMN deliver_to text NOT NULL DEFAULT '' CHECK (char_length(deliver_to) <= 12);
