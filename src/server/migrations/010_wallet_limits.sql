-- Batch 2.4a：单笔上限与超限当场授权（店主 2026-10-27 #9、❓4）
--   · 充值与消费的单笔上限默认都改为 50 万元：只改仍是首版默认值（充值 5 万、消费 2 万）的设置，店主手动调过的不动；
--   · 超过上限时由店主或店总在当前弹窗输入账号密码授权（auth_grants，用途 over_limit，008 已建），
--     授权人记在充值单 / 消费单上；
--   · 撤销时限（#10）与营业时间（#4）是新的设置项，没有设置时按「不限」「全天营业」处理，与之前一致，不需要预置。

UPDATE settings SET value = '50000000'::jsonb, updated_at = now() WHERE key = 'max_recharge_cents' AND value = '5000000'::jsonb;
UPDATE settings SET value = '50000000'::jsonb, updated_at = now() WHERE key = 'max_consume_cents' AND value = '2000000'::jsonb;

ALTER TABLE recharges ADD COLUMN over_limit_approved_by bigint REFERENCES staff (id);
ALTER TABLE consumptions ADD COLUMN over_limit_approved_by bigint REFERENCES staff (id);
