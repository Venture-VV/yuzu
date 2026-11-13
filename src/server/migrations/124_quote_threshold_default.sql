-- 124 询价门槛的默认值改成 ¥1,000（8.0.17，店主 2026-11-13，docs/FLOW_V8017.md 第 10 节，PENDING_DECISIONS LC2）。
-- 程序里的默认值（src/shared/purchasing.ts）从 500000 分改成 100000 分；采购规则保存过的库里存着当时的默认 500000，
-- 这里一起改成 100000。店里自己改成别的数的（含 0 = 不要求询价）不动；从没保存过采购规则的库没有这一行，直接用新默认。
-- 改了以后：合计 ≥ ¥1,000 的采购单第一次提交要来自已定标的询价单（补单、合成演示数据、挂了合同的、改版的照旧不受限）。
-- 已经提交、确认的采购单不回头改。

UPDATE settings
SET value = jsonb_set(value, '{quoteThresholdCents}', '100000'::jsonb), updated_at = now()
WHERE key = 'purchase_rules'
  AND jsonb_typeof(value -> 'quoteThresholdCents') = 'number'
  AND (value ->> 'quoteThresholdCents')::numeric = 500000;
