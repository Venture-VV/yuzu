-- 037 RQ-006 收银完善（v0.7.20，docs/CASHIER.md 第 3 节、docs/COUPONS.md）：
--   ① 退款单：结账后按项部分退款（退款单、退款项目、退款方式），记到班次
--   ② 券与会员权益：券模板、发券规则、发券记录、券、券的变动（用、退回、作废）
--   ③ 结账收款加「券抵扣」（store_coupon），部门营业额快照按适用的明细分摊券抵扣
-- 只加表、加列、放宽约束、改写快照函数（没有券时结果与原来相同）；升级后没有退款单与券，原有功能与数据不变。

-- ───────────── ① 退款单 ─────────────
CREATE TABLE refunds (
  id            bigserial PRIMARY KEY,
  refund_no     text NOT NULL UNIQUE CHECK (char_length(refund_no) BETWEEN 1 AND 32),
  checkout_id   bigint NOT NULL REFERENCES checkouts (id),
  client_key    uuid NOT NULL UNIQUE,
  amount        bigint NOT NULL CHECK (amount > 0),
  reason        text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 2 AND 200),
  business_date date NOT NULL,
  operator_id   bigint NOT NULL REFERENCES staff (id),
  created_at    timestamptz NOT NULL,
  -- 记到哪个班次：退现金时是所选钱箱当班的班次，否则是经办人当班的班次；没有开班（规则关闭时）为空
  shift_id      bigint REFERENCES shifts (id),
  status        text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'voided')),
  voided_at     timestamptz,
  voided_by     bigint REFERENCES staff (id),
  void_reason   text CHECK (void_reason IS NULL OR char_length(btrim(void_reason)) BETWEEN 2 AND 200),
  CHECK ((status = 'voided') = (voided_at IS NOT NULL)),
  CHECK ((status = 'voided') = (voided_by IS NOT NULL)),
  CHECK ((status = 'voided') = (void_reason IS NOT NULL))
);
CREATE INDEX refunds_checkout_idx ON refunds (checkout_id);
CREATE INDEX refunds_date_idx ON refunds (business_date);
CREATE INDEX refunds_shift_idx ON refunds (shift_id) WHERE shift_id IS NOT NULL;

-- 只能从「生效」变成「作废」，其余不能改；不能删
CREATE FUNCTION yuzu_refund_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '退款单不能删除' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'completed' OR NEW.status <> 'voided' THEN
    RAISE EXCEPTION '退款单只能作废一次，不能再改' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.refund_no, NEW.checkout_id, NEW.client_key, NEW.amount, NEW.reason, NEW.business_date, NEW.operator_id, NEW.created_at, NEW.shift_id)
     IS DISTINCT FROM (OLD.refund_no, OLD.checkout_id, OLD.client_key, OLD.amount, OLD.reason, OLD.business_date, OLD.operator_id, OLD.created_at, OLD.shift_id) THEN
    RAISE EXCEPTION '退款单的内容不能改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refunds_guard BEFORE UPDATE OR DELETE ON refunds
  FOR EACH ROW EXECUTE FUNCTION yuzu_refund_guard();

-- 退的项目：结账单部门营业额快照里的一项（同名项目合并成一行），只追加
CREATE TABLE refund_items (
  refund_id   bigint NOT NULL REFERENCES refunds (id),
  checkout_id bigint NOT NULL,
  category    text NOT NULL,
  name        text NOT NULL,
  -- 退的份数，可以是 0（只退钱、不退份数）
  quantity    integer NOT NULL CHECK (quantity >= 0),
  amount      bigint NOT NULL CHECK (amount > 0),
  PRIMARY KEY (refund_id, category, name),
  FOREIGN KEY (checkout_id, category, name) REFERENCES checkout_items (checkout_id, category, name)
);
CREATE INDEX refund_items_checkout_idx ON refund_items (checkout_id);
CREATE TRIGGER refund_items_append_only BEFORE UPDATE OR DELETE ON refund_items
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- 退款方式：只退原单收过的现金类方式；扫码、银行卡登记商户后台的退款单号，「其他」写明怎么退的
CREATE TABLE refund_payments (
  id        bigserial PRIMARY KEY,
  refund_id bigint NOT NULL REFERENCES refunds (id),
  method    text NOT NULL CHECK (method IN ('cash', 'wechat', 'alipay', 'bank_card', 'other')),
  amount    bigint NOT NULL CHECK (amount > 0),
  ref       text NOT NULL DEFAULT '' CHECK (char_length(ref) <= 64),
  CHECK (method = 'cash' OR char_length(btrim(ref)) >= 2),
  UNIQUE (refund_id, method)
);
CREATE TRIGGER refund_payments_append_only BEFORE UPDATE OR DELETE ON refund_payments
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- ───────────── ② 券与会员权益 ─────────────
CREATE TABLE coupon_templates (
  id                      bigserial PRIMARY KEY,
  name                    text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 24),
  -- 代金券 / 折扣券 / 兑换券
  kind                    text NOT NULL CHECK (kind IN ('cash', 'discount', 'exchange')),
  face_value              bigint CHECK (face_value > 0),
  -- 折扣券：按百分比，88 = 8.8 折
  rate_percent            integer CHECK (rate_percent BETWEEN 10 AND 99),
  -- 折扣券「最多减」、兑换券「最多抵」；空 = 不限
  max_off                 bigint CHECK (max_off > 0),
  -- 满多少可用（按适用的明细算）；0 = 不限
  threshold               bigint NOT NULL DEFAULT 0 CHECK (threshold >= 0),
  scope                   text NOT NULL DEFAULT 'all' CHECK (scope IN ('all', 'categories', 'items')),
  scope_categories        text[] NOT NULL DEFAULT '{}',
  scope_items             bigint[] NOT NULL DEFAULT '{}',
  exchange_item_id        bigint REFERENCES service_items (id),
  exchange_ticket_type_id bigint REFERENCES ticket_types (id),
  -- 有效期按营业日：固定起止日期，或发券后 N 天（发券当天算第 1 天）
  validity                text NOT NULL CHECK (validity IN ('fixed', 'days')),
  valid_from              date,
  valid_to                date,
  valid_days              integer CHECK (valid_days BETWEEN 1 AND 3650),
  -- 限定发放等级（空 = 不限）
  levels                  smallint[] NOT NULL DEFAULT '{}' CHECK (levels <@ ARRAY[1, 2, 3, 4, 5, 6, 7, 8, 9]::smallint[]),
  note                    text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  active                  boolean NOT NULL DEFAULT true,
  version                 integer NOT NULL DEFAULT 1,
  created_by              bigint NOT NULL REFERENCES staff (id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  -- 新建时页面的操作编号（没收到结果再提交返回原来那个，不会多建一个）
  client_key              uuid UNIQUE,
  CHECK ((kind = 'cash') = (face_value IS NOT NULL)),
  CHECK ((kind = 'discount') = (rate_percent IS NOT NULL)),
  CHECK (kind <> 'cash' OR max_off IS NULL),
  CHECK ((kind = 'exchange') = (num_nonnulls(exchange_item_id, exchange_ticket_type_id) = 1)),
  CHECK (kind <> 'exchange' OR (scope = 'all' AND threshold = 0)),
  CHECK ((scope = 'categories') = (cardinality(scope_categories) > 0)),
  CHECK ((scope = 'items') = (cardinality(scope_items) > 0)),
  CHECK ((validity = 'fixed') = (valid_from IS NOT NULL AND valid_to IS NOT NULL)),
  CHECK ((validity = 'days') = (valid_days IS NOT NULL)),
  CHECK (validity <> 'fixed' OR (valid_from <= valid_to AND valid_days IS NULL)),
  CHECK (validity <> 'days' OR (valid_from IS NULL AND valid_to IS NULL))
);

-- 发过券的模板，面额、折扣、门槛、范围、有效期、限定等级不能改（只能改名称、备注、停用）；不能删
CREATE FUNCTION yuzu_coupon_template_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '券模板不能删除，请停用' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.created_by, NEW.created_at, NEW.client_key) IS DISTINCT FROM (OLD.id, OLD.created_by, OLD.created_at, OLD.client_key) THEN
    RAISE EXCEPTION '券模板的建档信息不能改' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.kind, NEW.face_value, NEW.rate_percent, NEW.max_off, NEW.threshold, NEW.scope, NEW.scope_categories, NEW.scope_items,
      NEW.exchange_item_id, NEW.exchange_ticket_type_id, NEW.validity, NEW.valid_from, NEW.valid_to, NEW.valid_days, NEW.levels)
     IS DISTINCT FROM
     (OLD.kind, OLD.face_value, OLD.rate_percent, OLD.max_off, OLD.threshold, OLD.scope, OLD.scope_categories, OLD.scope_items,
      OLD.exchange_item_id, OLD.exchange_ticket_type_id, OLD.validity, OLD.valid_from, OLD.valid_to, OLD.valid_days, OLD.levels)
     AND EXISTS (SELECT 1 FROM coupons WHERE template_id = OLD.id) THEN
    RAISE EXCEPTION '这个模板已经发过券，面额、折扣、门槛、范围、有效期不能改，请另建模板' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- 发券规则：开卡礼（不分等级）、升级礼（达到的等级）、生日礼（发券时的等级）、充值赠券（充值套餐）。
-- 规则不能改，只能停用后另加；自动发券按「规则 + 会员 + 年份 / 充值单」去重
CREATE TABLE coupon_rules (
  id             bigserial PRIMARY KEY,
  kind           text NOT NULL CHECK (kind IN ('open_card', 'level_up', 'birthday', 'recharge')),
  level          smallint CHECK (level BETWEEN 1 AND 9),
  plan_id        bigint REFERENCES recharge_plans (id),
  template_id    bigint NOT NULL REFERENCES coupon_templates (id),
  quantity       integer NOT NULL CHECK (quantity BETWEEN 1 AND 10),
  active         boolean NOT NULL DEFAULT true,
  created_by     bigint NOT NULL REFERENCES staff (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  deactivated_by bigint REFERENCES staff (id),
  deactivated_at timestamptz,
  -- 新建时页面的操作编号（没收到结果再提交返回原来那条：重复的规则会重复发券）
  client_key     uuid UNIQUE,
  CHECK ((kind IN ('level_up', 'birthday')) = (level IS NOT NULL)),
  CHECK ((kind = 'recharge') = (plan_id IS NOT NULL)),
  CHECK (active = (deactivated_at IS NULL)),
  CHECK (active = (deactivated_by IS NULL))
);
CREATE INDEX coupon_rules_active_idx ON coupon_rules (kind) WHERE active;

CREATE FUNCTION yuzu_coupon_rule_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '发券规则不能删除，请停用' USING ERRCODE = 'P0001';
  END IF;
  IF NOT OLD.active OR NEW.active
     OR (NEW.kind, NEW.level, NEW.plan_id, NEW.template_id, NEW.quantity, NEW.created_by, NEW.created_at, NEW.client_key)
        IS DISTINCT FROM (OLD.kind, OLD.level, OLD.plan_id, OLD.template_id, OLD.quantity, OLD.created_by, OLD.created_at, OLD.client_key) THEN
    RAISE EXCEPTION '发券规则不能改，只能停用后另加' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER coupon_rules_guard BEFORE UPDATE OR DELETE ON coupon_rules
  FOR EACH ROW EXECUTE FUNCTION yuzu_coupon_rule_guard();

-- 发券记录：一次发券一条（手动、无记名批次、自动规则），只追加
CREATE TABLE coupon_issues (
  id            bigserial PRIMARY KEY,
  issue_no      text NOT NULL UNIQUE CHECK (char_length(issue_no) BETWEEN 1 AND 32),
  kind          text NOT NULL CHECK (kind IN ('manual', 'batch', 'open_card', 'level_up', 'birthday', 'recharge')),
  template_id   bigint NOT NULL REFERENCES coupon_templates (id),
  member_id     bigint REFERENCES members (id),
  quantity      integer NOT NULL CHECK (quantity BETWEEN 1 AND 500),
  rule_id       bigint REFERENCES coupon_rules (id),
  recharge_id   bigint REFERENCES recharges (id),
  -- 升级礼：达到的等级；生日礼：发券时的等级
  level         smallint CHECK (level BETWEEN 0 AND 9),
  reason        text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 200),
  -- 手动、批次：页面的操作编号（重复提交返回原记录）；自动：去重键（规则 + 会员 + 年份 / 充值单）
  client_key    uuid UNIQUE,
  dedupe_key    text UNIQUE,
  -- 自动发券记触发它的员工（建档、充值的经办人）；生日礼由定时任务发，为空
  issued_by     bigint REFERENCES staff (id),
  issued_at     timestamptz NOT NULL,
  business_date date NOT NULL,
  CHECK ((kind = 'batch') = (member_id IS NULL)),
  CHECK ((kind IN ('manual', 'batch')) = (client_key IS NOT NULL)),
  CHECK ((kind IN ('manual', 'batch')) = (rule_id IS NULL)),
  CHECK ((kind IN ('manual', 'batch')) = (dedupe_key IS NULL)),
  CHECK ((kind = 'recharge') = (recharge_id IS NOT NULL)),
  CHECK (kind <> 'manual' OR char_length(btrim(reason)) >= 2),
  CHECK (kind = 'batch' OR quantity <= 10),
  CHECK (kind = 'birthday' OR issued_by IS NOT NULL)
);
CREATE INDEX coupon_issues_member_idx ON coupon_issues (member_id) WHERE member_id IS NOT NULL;
CREATE INDEX coupon_issues_date_idx ON coupon_issues (business_date);
CREATE TRIGGER coupon_issues_append_only BEFORE UPDATE OR DELETE ON coupon_issues
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- 券：12 位券码（去掉易混的 0、O、1、I）；有效期按营业日（发券时按模板算好）。
-- 状态是变动记录的结果：可用 → 已用（结账）→ 可用（反结账退回）；可用 → 作废。过期不改数据，按日期算
CREATE TABLE coupons (
  id          bigserial PRIMARY KEY,
  code        text NOT NULL UNIQUE CHECK (code ~ '^[2-9A-HJ-NP-Z]{12}$'),
  issue_id    bigint NOT NULL REFERENCES coupon_issues (id),
  template_id bigint NOT NULL REFERENCES coupon_templates (id),
  member_id   bigint REFERENCES members (id),
  valid_from  date NOT NULL,
  valid_to    date NOT NULL,
  status      text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'used', 'voided')),
  -- 用在哪张结账单（已用时）
  checkout_id bigint REFERENCES checkouts (id),
  created_at  timestamptz NOT NULL,
  CHECK (valid_from <= valid_to),
  CHECK ((status = 'used') = (checkout_id IS NOT NULL))
);
CREATE INDEX coupons_member_idx ON coupons (member_id, status) WHERE member_id IS NOT NULL;
CREATE INDEX coupons_issue_idx ON coupons (issue_id);
CREATE INDEX coupons_template_idx ON coupons (template_id);
CREATE INDEX coupons_checkout_idx ON coupons (checkout_id) WHERE checkout_id IS NOT NULL;

CREATE TRIGGER coupon_templates_guard BEFORE UPDATE OR DELETE ON coupon_templates
  FOR EACH ROW EXECUTE FUNCTION yuzu_coupon_template_guard();

CREATE FUNCTION yuzu_store_coupon_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '券不能删除，请作废' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.code, NEW.issue_id, NEW.template_id, NEW.member_id, NEW.valid_from, NEW.valid_to, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.code, OLD.issue_id, OLD.template_id, OLD.member_id, OLD.valid_from, OLD.valid_to, OLD.created_at) THEN
    RAISE EXCEPTION '券的券码、会员、有效期不能改' USING ERRCODE = 'P0001';
  END IF;
  IF NOT ((OLD.status = 'available' AND NEW.status IN ('used', 'voided'))
          OR (OLD.status = 'used' AND NEW.status = 'available')) THEN
    RAISE EXCEPTION '券的状态不能这样改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER coupons_guard BEFORE UPDATE OR DELETE ON coupons
  FOR EACH ROW EXECUTE FUNCTION yuzu_store_coupon_guard();

-- 券的变动：用（结账）、退回（反结账）、作废，只追加；券的状态与这些记录一致（自检核对）
CREATE TABLE coupon_events (
  id            bigserial PRIMARY KEY,
  coupon_id     bigint NOT NULL REFERENCES coupons (id),
  kind          text NOT NULL CHECK (kind IN ('use', 'return', 'void')),
  checkout_id   bigint REFERENCES checkouts (id),
  amount        bigint CHECK (amount > 0),
  reason        text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 200),
  staff_id      bigint NOT NULL REFERENCES staff (id),
  at            timestamptz NOT NULL,
  business_date date NOT NULL,
  CHECK ((kind IN ('use', 'return')) = (checkout_id IS NOT NULL)),
  CHECK ((kind IN ('use', 'return')) = (amount IS NOT NULL)),
  CHECK (kind <> 'void' OR char_length(btrim(reason)) >= 2)
);
CREATE INDEX coupon_events_coupon_idx ON coupon_events (coupon_id);
CREATE INDEX coupon_events_date_idx ON coupon_events (business_date);
CREATE TRIGGER coupon_events_append_only BEFORE UPDATE OR DELETE ON coupon_events
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- ───────────── ③ 结账收款「券抵扣」 ─────────────
-- 券抵扣是优惠（营业额减少），不是收款；记下用的券与适用的明细（部门快照按这些明细分摊），一张结账单最多一张
ALTER TABLE checkout_payments DROP CONSTRAINT checkout_payments_method_check;
ALTER TABLE checkout_payments ADD CONSTRAINT checkout_payments_method_check
  CHECK (method IN ('cash', 'wechat', 'alipay', 'bank_card', 'other', 'wallet', 'coupon', 'discount', 'store_coupon'));
ALTER TABLE checkout_payments
  ADD COLUMN store_coupon_id bigint REFERENCES coupons (id),
  ADD COLUMN coupon_lines bigint[],
  ADD CONSTRAINT checkout_payments_store_coupon_check CHECK (
    (method = 'store_coupon') = (store_coupon_id IS NOT NULL)
    AND (method = 'store_coupon') = (coupon_lines IS NOT NULL)
    AND (coupon_lines IS NULL OR cardinality(coupon_lines) > 0));
CREATE UNIQUE INDEX checkout_payments_store_coupon_uq ON checkout_payments (checkout_id) WHERE method = 'store_coupon';
CREATE INDEX checkout_payments_store_coupon_idx ON checkout_payments (store_coupon_id) WHERE store_coupon_id IS NOT NULL;

-- 部门营业额快照（025 的函数改写）：优惠 / 免单按各项金额比例分摊（与原来相同）；券抵扣只按它适用的明细的金额比例分摊。
-- 都是算到分、分以下的尾差按舍去部分从大到小逐项补 1 分（最大余数法），分摊合计正好等于优惠（券抵扣），每项不超过它的金额。
-- 没有券抵扣的结账单与原来的结果完全相同。
CREATE OR REPLACE FUNCTION yuzu_snapshot_checkout_items(p_checkout bigint, p_current boolean) RETURNS void LANGUAGE sql AS $$
  WITH c AS (SELECT id, created_at FROM checkouts WHERE id = p_checkout),
  cl AS (
    SELECT coalesce((SELECT coupon_lines FROM checkout_payments WHERE checkout_id = p_checkout AND method = 'store_coupon'), '{}'::bigint[]) AS ids
  ),
  l AS (
    SELECT CASE WHEN l.ticket_type_id IS NOT NULL THEN '门票'
                WHEN l.source = 'room' THEN '客房'
                WHEN l.item_id IS NULL THEN '其他（手动金额、赔偿等）'
                ELSE coalesce(nullif(si.category, ''), '未分类') END AS category,
           CASE rc.kind WHEN 'night' THEN '房费（全天房）' WHEN 'half_day' THEN '超时半天' WHEN 'block' THEN '钟点房' ELSE l.name END AS name,
           l.quantity, l.amount, l.id = ANY (cl.ids) AS in_coupon
    FROM c CROSS JOIN cl JOIN checkout_bills cb ON cb.checkout_id = c.id
    JOIN bill_lines l ON l.bill_id = cb.bill_id
     AND CASE WHEN p_current THEN l.status = 'active'
              ELSE l.posted_at <= c.created_at AND (l.voided_at IS NULL OR l.voided_at > c.created_at) END
    LEFT JOIN service_items si ON si.id = l.item_id
    LEFT JOIN room_stay_charges rc ON rc.line_id = l.id
  ),
  r AS (
    SELECT category, name, sum(quantity)::int AS quantity, sum(amount)::bigint AS amount,
           coalesce(sum(amount) FILTER (WHERE in_coupon), 0)::bigint AS coupon_base
    FROM l GROUP BY 1, 2
  ),
  d AS (
    SELECT coalesce(sum(amount) FILTER (WHERE method = 'discount'), 0)::bigint AS disc,
           coalesce(sum(amount) FILTER (WHERE method = 'store_coupon'), 0)::bigint AS coup
    FROM checkout_payments WHERE checkout_id = p_checkout
  ),
  t AS (SELECT coalesce(sum(amount), 0)::bigint AS total, coalesce(sum(coupon_base), 0)::bigint AS coupon_total FROM r),
  b AS (
    SELECT r.category, r.name, r.quantity, r.amount, r.coupon_base,
           CASE WHEN t.total > 0 THEN (r.amount * d.disc) / t.total ELSE 0 END AS share,
           CASE WHEN t.total > 0 THEN (r.amount * d.disc) % t.total ELSE 0 END AS frac,
           CASE WHEN t.coupon_total > 0 THEN (r.coupon_base * d.coup) / t.coupon_total ELSE 0 END AS cshare,
           CASE WHEN t.coupon_total > 0 THEN (r.coupon_base * d.coup) % t.coupon_total ELSE 0 END AS cfrac
    FROM r, d, t
  ),
  ranked AS (
    SELECT b.*,
           row_number() OVER (ORDER BY b.frac DESC, b.amount DESC, b.category COLLATE "C", b.name COLLATE "C") AS rn,
           row_number() OVER (ORDER BY b.cfrac DESC, b.coupon_base DESC, b.category COLLATE "C", b.name COLLATE "C") AS crn
    FROM b
  ),
  left_over AS (
    SELECT d.disc - coalesce((SELECT sum(share) FROM b), 0) AS n,
           d.coup - coalesce((SELECT sum(cshare) FROM b), 0) AS cn
    FROM d
  )
  INSERT INTO checkout_items (checkout_id, category, name, quantity, amount, discount)
  SELECT p_checkout, x.category, x.name, x.quantity, x.amount,
         x.share + CASE WHEN x.rn <= lo.n THEN 1 ELSE 0 END
         + x.cshare + CASE WHEN x.crn <= lo.cn AND x.coupon_base > 0 THEN 1 ELSE 0 END
  FROM ranked x, left_over lo
$$;

-- ───────────── 幂等与作废登记：退款单 ─────────────
ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_op_type_check;
ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'inv_doc', 'purchase_order', 'payment', 'opening_payable', 'checkin', 'bill_post', 'tag_swap',
                     'abandoned', 'checkout', 'table_open', 'table_post', 'table_checkout', 'room_checkin', 'room_extend', 'room_deposit', 'room_refund',
                     'room_close', 'line_move', 'expense_claim', 'petty_advance', 'petty_settlement', 'purchase_request', 'ap_offset', 'supplier_refund',
                     'erp_import', 'supplier_recon', 'supplier_recon_void', 'space_import', 'usage_open', 'usage_end', 'usage_cancel',
                     'checkout_refund'));
ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'checkin', 'bill_post', 'tag_swap', 'checkout', 'table_open', 'table_post', 'table_checkout',
                     'room_checkin', 'room_extend', 'room_deposit', 'room_refund', 'room_close', 'line_move',
                     'expense_claim', 'petty_advance', 'petty_settlement', 'purchase_request', 'ap_offset', 'supplier_refund', 'erp_import',
                     'supplier_recon', 'supplier_recon_void', 'space_import', 'location_report', 'usage_open', 'usage_end', 'usage_cancel',
                     'checkout_refund', 'coupon_template', 'coupon_rule', 'coupon_batch', 'coupon_issue'));
