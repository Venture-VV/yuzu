-- Batch 2.4b：会员自定义字段（店主 2026-10-27 #12）
--   · 字段定义存在经营规则（settings.member_fields），由店主配置；固定字段（姓名、手机号、性别、生日、备注）不变；
--   · 值存在会员档案的 custom_fields（键为字段编号，如 {"f1": "沪A12345"}）；已有会员为空对象；
--   · 一人只能登记一个手机号：members.phone 唯一约束已在 001 建立。

ALTER TABLE members
  ADD COLUMN custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(custom_fields) = 'object');
