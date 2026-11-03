-- 040 会员体系 v2 第一期（v0.7.23，docs/MEMBERSHIP.md）：等级与会籍全自动。
--   ① 会员的档级（L0–L6）、阶位（初 / 享 / 尊）、会籍周期与补充期，加版本号（会员一行本来就是钱包的锁）
--   ② 状态变化记录 member_grade_events（只追加）：上线定档、期初导入定档、充值升档、消费升阶、到期保级、补充期、降档、手动调整
--   ③ 每天自动任务的运行记录 membership_job_runs
--   ④ 岗位「他店查询」（other_store）：另一家店只读查会员档阶
--   ⑤ 券模板的限定等级、发券规则的等级改成 0–6 档级（原来的 1–9 级按对应表换算，见下）
-- 已有会员的上线定档在应用启动时做一次（要门店时区与营业日切换时刻，见 modules/membership.ts），这里只加列，升级后默认都是 L0。
-- 手牌 VIP 柜的等级不改（店主的柜号清单 1–5 级照旧），会员能用到几级柜由会员规则里的对应表决定。

ALTER TABLE members
  ADD COLUMN grade         smallint NOT NULL DEFAULT 0 CHECK (grade BETWEEN 0 AND 6),
  ADD COLUMN tier          smallint CHECK (tier BETWEEN 0 AND 2),
  ADD COLUMN cycle_start   date,
  ADD COLUMN cycle_end     date,
  ADD COLUMN grace_until   date,
  ADD COLUMN grade_version integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT members_grade_state_check CHECK (
    (grade = 0 AND tier IS NULL AND cycle_start IS NULL AND cycle_end IS NULL AND grace_until IS NULL)
    OR (grade > 0 AND tier IS NOT NULL AND cycle_start IS NOT NULL AND cycle_end IS NOT NULL AND cycle_end >= cycle_start
        AND (grace_until IS NULL OR grace_until > cycle_end))
  );
CREATE INDEX members_cycle_end_idx ON members (cycle_end) WHERE grade > 0;
CREATE INDEX members_grace_idx ON members (grace_until) WHERE grace_until IS NOT NULL;

-- 状态变化记录：每一次档阶或会籍变化一条，只追加。to_* 与 cycle_* 是变化之后的状态；会员当前状态 = 最后一条的结果（自检核对）
CREATE TABLE member_grade_events (
  id               bigserial PRIMARY KEY,
  member_id        bigint NOT NULL REFERENCES members (id),
  kind             text NOT NULL CHECK (kind IN ('go_live', 'import', 'recharge_up', 'spend_up', 'retain', 'grace_start',
                                                 'grace_retain', 'downgrade', 'manual')),
  business_date    date NOT NULL,
  from_grade       smallint NOT NULL CHECK (from_grade BETWEEN 0 AND 6),
  from_tier        smallint CHECK (from_tier BETWEEN 0 AND 2),
  to_grade         smallint NOT NULL CHECK (to_grade BETWEEN 0 AND 6),
  to_tier          smallint CHECK (to_tier BETWEEN 0 AND 2),
  cycle_start      date,
  cycle_end        date,
  grace_until      date,
  -- 当时的周期净储值消费（分）；上线定档、期初导入、充值升档另记当时的累计充值
  cycle_spend      bigint NOT NULL DEFAULT 0,
  rolling_recharge bigint,
  recharge_id      bigint REFERENCES recharges (id),
  consumption_id   bigint REFERENCES consumptions (id),
  -- 经办人；空 = 系统自动
  staff_id         bigint REFERENCES staff (id),
  reason           text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 200),
  -- 手动调整的操作编号（没收到结果再提交返回原来那条）
  client_key       uuid UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((to_grade = 0) = (to_tier IS NULL)),
  CHECK (kind <> 'manual' OR (staff_id IS NOT NULL AND char_length(reason) >= 2))
);
CREATE INDEX member_grade_events_member_idx ON member_grade_events (member_id, id);
CREATE INDEX member_grade_events_date_idx ON member_grade_events (business_date, kind);
CREATE TRIGGER member_grade_events_append_only BEFORE UPDATE OR DELETE ON member_grade_events
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- 每天的自动任务：一个营业日一条，处理了多少人、各是什么结果、有没有出错（同一天多跑几次累加）
CREATE TABLE membership_job_runs (
  id            bigserial PRIMARY KEY,
  job           text NOT NULL CHECK (job IN ('daily')),
  business_date date NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  processed     integer NOT NULL DEFAULT 0 CHECK (processed >= 0),
  retained      integer NOT NULL DEFAULT 0 CHECK (retained >= 0),
  grace         integer NOT NULL DEFAULT 0 CHECK (grace >= 0),
  downgraded    integer NOT NULL DEFAULT 0 CHECK (downgraded >= 0),
  error         text CHECK (char_length(error) <= 500),
  UNIQUE (job, business_date)
);

-- 岗位「他店查询」
ALTER TABLE staff DROP CONSTRAINT staff_role_check;
ALTER TABLE staff ADD CONSTRAINT staff_role_check
  CHECK (role IN ('owner', 'store_manager', 'duty_manager', 'account_manager', 'clerk', 'backoffice', 'other_store'));

-- 券的等级换算成档级。原来的等级（v0.6.0 默认门槛）：1 级 = 5 万以下、2 级 = 5 万、3 级 = 10 万、4 级 = 20 万、5 级 = 30 万以上；
-- 新档级的门槛：L1 5 千、L2 1 万、L3 3 万、L4 5 万、L5 10 万、L6 30 万。
--   · 模板的「限定等级」是一组允许的等级：1 级 → L0–L3，2 级 → L4，3、4 级 → L5，5 级及以上 → L6
--   · 发券规则的等级：升级礼 1 级 → L1（原来到 1 级不算升级）、生日礼 1 级 → L0；2 级 → L4，3、4 级 → L5，5 级及以上 → L6
-- 发过券的模板、规则本来不能改，这里临时停用保护触发器做一次换算（只改等级）。
ALTER TABLE coupon_templates DROP CONSTRAINT coupon_templates_levels_check;
ALTER TABLE coupon_templates DISABLE TRIGGER coupon_templates_guard;
UPDATE coupon_templates t
   SET levels = ARRAY(
     SELECT DISTINCT g::smallint
       FROM unnest(t.levels) AS l,
            LATERAL unnest(CASE WHEN l <= 1 THEN ARRAY[0, 1, 2, 3]
                                WHEN l = 2 THEN ARRAY[4]
                                WHEN l IN (3, 4) THEN ARRAY[5]
                                ELSE ARRAY[6] END) AS g
      ORDER BY 1)
 WHERE t.levels <> '{}';
ALTER TABLE coupon_templates ENABLE TRIGGER coupon_templates_guard;
ALTER TABLE coupon_templates ADD CONSTRAINT coupon_templates_levels_check
  CHECK (levels <@ ARRAY[0, 1, 2, 3, 4, 5, 6]::smallint[]);

ALTER TABLE coupon_rules DROP CONSTRAINT coupon_rules_level_check;
ALTER TABLE coupon_rules DISABLE TRIGGER coupon_rules_guard;
UPDATE coupon_rules
   SET level = CASE WHEN level <= 1 THEN (CASE WHEN kind = 'level_up' THEN 1 ELSE 0 END)
                    WHEN level = 2 THEN 4
                    WHEN level IN (3, 4) THEN 5
                    ELSE 6 END
 WHERE level IS NOT NULL;
ALTER TABLE coupon_rules ENABLE TRIGGER coupon_rules_guard;
ALTER TABLE coupon_rules ADD CONSTRAINT coupon_rules_level_check
  CHECK (level BETWEEN 0 AND 6 AND (kind <> 'level_up' OR level >= 1));
