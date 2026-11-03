-- 041 会员体系 v2 第二期（v0.7.24，docs/BENEFITS.md）：本店权益自动发放。
--   ① 权益清单 benefits：会员文档附录三 A「汤崎洗浴与会员服务」57 项与 F 补充 2 项（导入为草稿，店主、店总逐项发布；不能删除，只能暂缓）
--   ② 发放记录 benefit_grants（只追加）：券类每期发放与当场补发、事件礼，去重键唯一；每条对应一条发券记录
--   ③ 使用登记 benefit_uses（只能作废，留原因与经办人）：服务类的次数
--   ④ 发券记录加种类「会员权益」（benefit，不挂发券规则，定时任务发的没有经办人）；每天的自动任务加「会员权益」；作废登记加 benefit_use
-- 已经发出的券、登记的使用不随权益的修改变化（发放记录记当时的版本号）。

CREATE TABLE benefits (
  id              bigserial PRIMARY KEY,
  code            text NOT NULL UNIQUE CHECK (code ~ '^[A-Za-z0-9-]{1,32}$'),
  name            text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  category        text NOT NULL CHECK (category IN ('coupon', 'event', 'service', 'discount', 'info')),
  -- 配置起点：档级 L0–L6 与阶位（L0 没有阶位）；空 = 未配置（设好才能发布）
  start_grade     smallint CHECK (start_grade BETWEEN 0 AND 6),
  start_tier      smallint CHECK (start_tier BETWEEN 0 AND 2),
  -- 券类按月、按年发；服务类次数按天、月、年数；不计次（none）只列出来
  period          text NOT NULL DEFAULT 'none' CHECK (period IN ('none', 'day', 'month', 'year')),
  -- 券类：每期张数；事件礼：每次张数；服务类：每期上限（空 = 不限次）
  quantity        smallint CHECK (quantity BETWEEN 1 AND 99),
  -- 各档阶数量：[{grade, tier, quantity}]，从这个状态起（含更高的）按它，不相加
  tier_quantities jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tier_quantities) = 'array'),
  template_id     bigint REFERENCES coupon_templates (id),
  events          text[] NOT NULL DEFAULT '{}'
                  CHECK (events <@ ARRAY['first_recharge', 'grade_up', 'tier_up', 'retain', 'birthday', 'festival']::text[]),
  -- 节日关怀的日期（农历节日每年由店主填当年的日期）
  festival_dates  date[] NOT NULL DEFAULT '{}' CHECK (cardinality(festival_dates) <= 12),
  content         text NOT NULL DEFAULT '' CHECK (char_length(content) <= 500),
  conditions      text NOT NULL DEFAULT '' CHECK (char_length(conditions) <= 500),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'paused')),
  version         integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  sort_order      integer NOT NULL DEFAULT 0,
  -- 导入的人（命令行导入为空）、最后修改的人
  created_by      bigint REFERENCES staff (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      bigint REFERENCES staff (id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz,
  CHECK ((start_grade IS NULL OR start_grade = 0) = (start_tier IS NULL)),
  CHECK (status <> 'published' OR start_grade IS NOT NULL),
  -- 折扣类第三期（v0.7.25）结账时自动算，这一期不能发布
  CHECK (status <> 'published' OR category <> 'discount'),
  CHECK (status <> 'published' OR category <> 'coupon'
         OR (template_id IS NOT NULL AND quantity BETWEEN 1 AND 10 AND period IN ('month', 'year'))),
  CHECK (status <> 'published' OR category <> 'event'
         OR (template_id IS NOT NULL AND quantity BETWEEN 1 AND 10 AND cardinality(events) > 0
             AND ('festival' <> ALL (events) OR cardinality(festival_dates) > 0))),
  CHECK (status <> 'published' OR category <> 'service' OR ((period = 'none') = (quantity IS NULL)))
);
CREATE INDEX benefits_published_idx ON benefits (category) WHERE status = 'published';

-- 权益不能删除（只能暂缓），编号不能改
CREATE FUNCTION yuzu_benefit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '权益不能删除，不再提供请暂缓' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.code <> OLD.code OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION '权益的编号不能改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER benefits_guard BEFORE UPDATE OR DELETE ON benefits
  FOR EACH ROW EXECUTE FUNCTION yuzu_benefit_guard();

-- 发券记录加种类「会员权益」：不挂发券规则；每天的定时任务发的没有经办人（与生日礼一样）
ALTER TABLE coupon_issues DROP CONSTRAINT coupon_issues_kind_check;
ALTER TABLE coupon_issues ADD CONSTRAINT coupon_issues_kind_check
  CHECK (kind IN ('manual', 'batch', 'open_card', 'level_up', 'birthday', 'recharge', 'benefit'));
ALTER TABLE coupon_issues DROP CONSTRAINT coupon_issues_check2;
ALTER TABLE coupon_issues ADD CONSTRAINT coupon_issues_rule_check CHECK ((kind IN ('manual', 'batch', 'benefit')) = (rule_id IS NULL));
ALTER TABLE coupon_issues DROP CONSTRAINT coupon_issues_check7;
ALTER TABLE coupon_issues ADD CONSTRAINT coupon_issues_issued_by_check CHECK (kind IN ('birthday', 'benefit') OR issued_by IS NOT NULL);

-- 发放记录：一次发放一条（只追加），对应一条发券记录。
--   · 券类：这一期（2026-11 / 2026）与发完以后这一期应得的累计张数（target）；同一会员、同一项、同一期的张数合计 = 最大的 target
--   · 事件礼：事件键（first、grade_up:e<状态变化>、tier_up:e…、retain:e…、birthday:2026、festival:2026-10-01）
-- 去重键：benefit:<权益>:<会员>:<期>:<应得累计> 或 benefit:<权益>:<会员>:<事件键>，几个进程同时发也只发一次
CREATE TABLE benefit_grants (
  id              bigserial PRIMARY KEY,
  benefit_id      bigint NOT NULL REFERENCES benefits (id),
  benefit_version integer NOT NULL CHECK (benefit_version >= 1),
  member_id       bigint NOT NULL REFERENCES members (id),
  reason          text NOT NULL CHECK (reason IN ('monthly', 'top_up', 'event')),
  period_key      text CHECK (period_key ~ '^[0-9]{4}(-[0-9]{2})?$'),
  target          smallint CHECK (target BETWEEN 1 AND 10),
  event_key       text CHECK (char_length(event_key) BETWEEN 1 AND 64),
  quantity        smallint NOT NULL CHECK (quantity BETWEEN 1 AND 10),
  coupon_issue_id bigint NOT NULL UNIQUE REFERENCES coupon_issues (id),
  -- 发放时会员的档阶
  grade           smallint NOT NULL CHECK (grade BETWEEN 0 AND 6),
  tier            smallint CHECK (tier BETWEEN 0 AND 2),
  business_date   date NOT NULL,
  dedupe_key      text NOT NULL UNIQUE CHECK (char_length(dedupe_key) <= 128),
  -- 触发它的员工（手动调整档阶的店主）；自动的为空
  staff_id        bigint REFERENCES staff (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((reason = 'event') = (event_key IS NOT NULL)),
  CHECK ((reason = 'event') = (period_key IS NULL)),
  CHECK ((reason = 'event') = (target IS NULL)),
  CHECK (reason = 'event' OR quantity <= target),
  CHECK ((grade = 0) = (tier IS NULL))
);
CREATE INDEX benefit_grants_member_idx ON benefit_grants (member_id, benefit_id, period_key);
CREATE INDEX benefit_grants_date_idx ON benefit_grants (business_date);
CREATE TRIGGER benefit_grants_append_only BEFORE UPDATE OR DELETE ON benefit_grants
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- 使用登记：服务的同事点「登记使用」一次一条；设了次数的记下这一期与当时的上限（自检核对没有超过），不计次的两者都空。
-- 登记错的只能作废（写原因、记经办人），不能改、不能删
CREATE TABLE benefit_uses (
  id            bigserial PRIMARY KEY,
  benefit_id    bigint NOT NULL REFERENCES benefits (id),
  member_id     bigint NOT NULL REFERENCES members (id),
  business_date date NOT NULL,
  period_key    text CHECK (period_key ~ '^[0-9]{4}(-[0-9]{2}){0,2}$'),
  quantity      smallint NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  limit_at      smallint CHECK (limit_at BETWEEN 1 AND 99),
  note          text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  staff_id      bigint NOT NULL REFERENCES staff (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- 页面的操作编号（没收到结果再提交返回原来那条；结果待确认时可以确认作废）
  client_key    uuid NOT NULL UNIQUE,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided')),
  voided_by     bigint REFERENCES staff (id),
  voided_at     timestamptz,
  void_reason   text CHECK (void_reason IS NULL OR char_length(btrim(void_reason)) BETWEEN 2 AND 200),
  CHECK ((period_key IS NULL) = (limit_at IS NULL)),
  CHECK ((status = 'voided') = (voided_by IS NOT NULL)),
  CHECK ((status = 'voided') = (voided_at IS NOT NULL)),
  CHECK ((status = 'voided') = (void_reason IS NOT NULL))
);
CREATE INDEX benefit_uses_member_idx ON benefit_uses (member_id, benefit_id, period_key);
CREATE INDEX benefit_uses_date_idx ON benefit_uses (business_date);

CREATE FUNCTION yuzu_benefit_use_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '权益使用登记不能删除，登记错了请作废' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'active' OR NEW.status <> 'voided'
     OR (NEW.benefit_id, NEW.member_id, NEW.business_date, NEW.period_key, NEW.quantity, NEW.limit_at, NEW.note, NEW.staff_id,
         NEW.created_at, NEW.client_key)
        IS DISTINCT FROM (OLD.benefit_id, OLD.member_id, OLD.business_date, OLD.period_key, OLD.quantity, OLD.limit_at, OLD.note,
                          OLD.staff_id, OLD.created_at, OLD.client_key) THEN
    RAISE EXCEPTION '权益使用登记只能作废' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER benefit_uses_guard BEFORE UPDATE OR DELETE ON benefit_uses
  FOR EACH ROW EXECUTE FUNCTION yuzu_benefit_use_guard();

-- 每天的自动任务加「会员权益」（每期发放、生日礼、节日关怀）：发了几位会员（processed）、几张券（coupons）；
-- catalog_stamp 是开始时权益清单的版本合计，之后有人修改、发布、暂缓（合计变了）同一天再跑一次
ALTER TABLE membership_job_runs DROP CONSTRAINT membership_job_runs_job_check;
ALTER TABLE membership_job_runs ADD CONSTRAINT membership_job_runs_job_check CHECK (job IN ('daily', 'benefits'));
ALTER TABLE membership_job_runs
  ADD COLUMN coupons integer NOT NULL DEFAULT 0 CHECK (coupons >= 0),
  ADD COLUMN catalog_stamp bigint;

-- 登记权益使用的「确认作废」：编号记在使用登记上（benefit_uses.client_key），作废登记加业务类型 benefit_use（只放宽约束）
ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'checkin', 'bill_post', 'tag_swap', 'checkout', 'table_open', 'table_post', 'table_checkout',
                     'room_checkin', 'room_extend', 'room_deposit', 'room_refund', 'room_close', 'line_move',
                     'expense_claim', 'petty_advance', 'petty_settlement', 'purchase_request', 'ap_offset', 'supplier_refund', 'erp_import',
                     'supplier_recon', 'supplier_recon_void', 'space_import', 'location_report', 'usage_open', 'usage_end', 'usage_cancel',
                     'checkout_refund', 'coupon_template', 'coupon_rule', 'coupon_batch', 'coupon_issue',
                     'device_create', 'device_job', 'payment', 'opening_payable', 'grade_adjust', 'benefit_use'));
