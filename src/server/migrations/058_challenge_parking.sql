-- v0.7.28 ⑧（主线）：会员挑战（QY-057，N9）与停车优惠（QY-016，N10）（设计见 docs/SCHEDULE_FINISH.md 第 9 节）。
--   · 会员挑战：事件礼加事件「每月到店满几次」（monthly_visits）与「满几次」（visit_target，2–31）；
--     到店按有结账的营业日算、一天算一次，满了每月每人送一次（发放记录的去重键兜底）；店主填了次数和券才能发布；
--   · 停车优惠：服务类加标记「停车优惠」（is_parking）：每天一次（period = day、quantity = 1），
--     起点与各档阶每次免费几小时（parking_hours、parking_hours_by_tier，1–24）；使用登记加车牌与免费几小时
--     （系统不收停车费，只登记、给停车场对账）。不加新的类别：小程序线按类别显示「本月可享」，停车优惠在那边就是服务类；
--   · 本店权益清单里还没人改过的 QY-016（草稿、版本 1、折扣类、没填折扣）改成服务类的停车优惠，QY-057（暂缓、版本 1、服务类）
--     改成事件礼「每月到店满几次」（仍是暂缓，店主填了次数和券再发布）；改过的不动。
-- 只加列、放宽约束；改的只有上面两行没人动过的草稿。

ALTER TABLE benefits DROP CONSTRAINT benefits_events_check;
ALTER TABLE benefits ADD CONSTRAINT benefits_events_check
  CHECK (events <@ ARRAY['first_recharge', 'grade_up', 'tier_up', 'retain', 'birthday', 'festival', 'monthly_visits']::text[]);

ALTER TABLE benefits
  -- 会员挑战：每月到店满几次（只有事件里有「每月到店满几次」才有）
  ADD COLUMN visit_target smallint CHECK (visit_target BETWEEN 2 AND 31),
  ADD CONSTRAINT benefits_visit_events_check CHECK (visit_target IS NULL OR 'monthly_visits' = ANY (events)),
  ADD CONSTRAINT benefits_visit_publish_check CHECK (status <> 'published' OR 'monthly_visits' <> ALL (events) OR visit_target IS NOT NULL),
  -- 停车优惠：服务类、每天一次；每次免费几小时（起点与各档阶表）
  ADD COLUMN is_parking boolean NOT NULL DEFAULT false,
  ADD COLUMN parking_hours smallint CHECK (parking_hours BETWEEN 1 AND 24),
  ADD COLUMN parking_hours_by_tier jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(parking_hours_by_tier) = 'array'),
  ADD CONSTRAINT benefits_parking_check CHECK (
    (NOT is_parking AND parking_hours IS NULL AND parking_hours_by_tier = '[]'::jsonb)
    OR (is_parking AND category = 'service' AND period = 'day' AND quantity = 1 AND tier_quantities = '[]'::jsonb)),
  ADD CONSTRAINT benefits_parking_publish_check CHECK (status <> 'published' OR NOT is_parking OR parking_hours IS NOT NULL);

-- 使用登记：停车优惠的车牌与免费几小时
ALTER TABLE benefit_uses
  ADD COLUMN plate text CHECK (plate IS NULL OR plate ~ '^[A-Z0-9一-龥]{2,12}$'),
  ADD COLUMN hours smallint CHECK (hours IS NULL OR hours BETWEEN 1 AND 24),
  ADD CONSTRAINT benefit_uses_parking_check CHECK ((plate IS NULL) = (hours IS NULL));
CREATE INDEX benefit_uses_parking_idx ON benefit_uses (business_date) WHERE plate IS NOT NULL;

-- 本店权益清单里还没人改过的两项：按这一版的做法改（仍是草稿 / 暂缓，不改版本号）
UPDATE benefits SET category = 'service', period = 'day', quantity = 1, tier_quantities = '[]'::jsonb, is_parking = true
WHERE code = 'QY-016' AND version = 1 AND status = 'draft' AND category = 'discount' AND discount_target IS NULL AND quantity IS NULL
  AND cardinality(weekdays) = 0 AND cardinality(month_days) = 0;
UPDATE benefits SET category = 'event', period = 'none', quantity = 1, events = ARRAY['monthly_visits']::text[]
WHERE code = 'QY-057' AND version = 1 AND status = 'paused' AND category = 'service' AND template_id IS NULL;
