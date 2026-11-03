-- 042 会员体系 v2 第三期（v0.7.25，docs/MEMBERSHIP_P3.md）：会员折扣、邀请体验与赠送会籍。
--   ① 折扣类权益的配置：适用明细（客房房费 / 门票 / 整张账单）、每周几、每月几号；「付几成」（75 = 7.5 折）放在原来的数量列与各档阶表；
--      原来「折扣类不能发布」的约束换成「发布要有适用明细与折扣」；还没改过的 QY-011 草稿补上会员文档的默认折扣
--   ② 结账收款加「会员折扣」（member_discount，是优惠、不是收款）：会员、权益与版本、折扣、适用明细（沿用 coupon_lines）；
--      每张结账单最多一笔券抵扣或会员折扣
--   ③ 部门营业额快照：会员折扣与券抵扣一样只按适用的明细分摊（一张结账单最多有其中一种）
--   ④ 临时身份 member_trials（邀请体验、赠送会籍）：只能结束（到期、转正、撤销），不能删除、不能改内容；作废登记加 member_trial
-- 不改已有的结账、券与会员数据。

-- ───────────── ① 折扣类权益的配置 ─────────────
ALTER TABLE benefits
  ADD COLUMN discount_target text CHECK (discount_target IN ('room', 'ticket', 'bill')),
  -- 每周几（1 = 周一 … 7 = 周日）、每月几号；空 = 每天
  ADD COLUMN weekdays smallint[] NOT NULL DEFAULT '{}' CHECK (1 <= ALL (weekdays) AND 7 >= ALL (weekdays) AND cardinality(weekdays) <= 7),
  ADD COLUMN month_days smallint[] NOT NULL DEFAULT '{}' CHECK (1 <= ALL (month_days) AND 31 >= ALL (month_days) AND cardinality(month_days) <= 31),
  ADD CONSTRAINT benefits_discount_fields_check CHECK (
    category = 'discount' OR (discount_target IS NULL AND cardinality(weekdays) = 0 AND cardinality(month_days) = 0));

DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
  WHERE conrelid = 'benefits'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%category <> ''discount''::text%';
  IF c IS NULL THEN RAISE EXCEPTION '042：找不到 041 的「折扣类不能发布」约束'; END IF;
  EXECUTE format('ALTER TABLE benefits DROP CONSTRAINT %I', c);
END $$;

-- 发布要有适用明细与起点的折扣（10–99，即 1 折到 9.9 折）；各档阶的折扣由应用核对
ALTER TABLE benefits ADD CONSTRAINT benefits_discount_publish_check CHECK (
  status <> 'published' OR category <> 'discount' OR (discount_target IS NOT NULL AND quantity BETWEEN 10 AND 99));

-- QY-011 派对房及包房折扣：导入以后没改过的草稿（版本 1）补上会员文档的默认折扣（M44：客房房费；L3·初 7.5 折、L4·初 6.5 折、
-- L5·初 5.5 折、L6·初 5 折），仍是草稿，店主核对后发布；改过的不动
UPDATE benefits
SET discount_target = 'room', quantity = 75,
    tier_quantities = '[{"grade": 4, "tier": 0, "quantity": 65}, {"grade": 5, "tier": 0, "quantity": 55}, {"grade": 6, "tier": 0, "quantity": 50}]'::jsonb
WHERE code = 'QY-011' AND category = 'discount' AND status = 'draft' AND version = 1
  AND start_grade = 3 AND start_tier = 0 AND discount_target IS NULL AND quantity IS NULL AND tier_quantities = '[]'::jsonb;

-- ───────────── ② 结账收款「会员折扣」 ─────────────
ALTER TABLE checkout_payments DROP CONSTRAINT checkout_payments_method_check;
ALTER TABLE checkout_payments ADD CONSTRAINT checkout_payments_method_check
  CHECK (method IN ('cash', 'wechat', 'alipay', 'bank_card', 'other', 'wallet', 'coupon', 'discount', 'store_coupon', 'member_discount'));
ALTER TABLE checkout_payments
  ADD COLUMN discount_member_id bigint REFERENCES members (id),
  ADD COLUMN benefit_id bigint REFERENCES benefits (id),
  ADD COLUMN benefit_version integer CHECK (benefit_version >= 1),
  ADD COLUMN discount_rate smallint CHECK (discount_rate BETWEEN 10 AND 99),
  ADD CONSTRAINT checkout_payments_member_discount_check CHECK (
    (method = 'member_discount') = (discount_member_id IS NOT NULL)
    AND (method = 'member_discount') = (benefit_id IS NOT NULL)
    AND (method = 'member_discount') = (benefit_version IS NOT NULL)
    AND (method = 'member_discount') = (discount_rate IS NOT NULL));
-- 适用的明细：券抵扣与会员折扣都记在 coupon_lines
ALTER TABLE checkout_payments DROP CONSTRAINT checkout_payments_store_coupon_check;
ALTER TABLE checkout_payments ADD CONSTRAINT checkout_payments_store_coupon_check CHECK (
  (method = 'store_coupon') = (store_coupon_id IS NOT NULL)
  AND (method IN ('store_coupon', 'member_discount')) = (coupon_lines IS NOT NULL)
  AND (coupon_lines IS NULL OR cardinality(coupon_lines) > 0));
-- 每张结账单最多一笔券抵扣或会员折扣（M13：一单一种会员折扣、不与券同用）
CREATE UNIQUE INDEX checkout_payments_line_reduction_uq ON checkout_payments (checkout_id) WHERE method IN ('store_coupon', 'member_discount');
CREATE INDEX checkout_payments_member_discount_idx ON checkout_payments (discount_member_id) WHERE discount_member_id IS NOT NULL;

-- ───────────── ③ 部门营业额快照（037 的函数改写） ─────────────
-- 优惠 / 免单按各项金额比例分摊（与原来相同）；券抵扣、会员折扣只按它适用的明细的金额比例分摊（一张结账单最多有其中一种）。
-- 都是算到分、分以下的尾差按舍去部分从大到小逐项补 1 分（最大余数法），分摊合计正好等于优惠，每项不超过它的金额。
-- 没有会员折扣的结账单与原来的结果完全相同。
CREATE OR REPLACE FUNCTION yuzu_snapshot_checkout_items(p_checkout bigint, p_current boolean) RETURNS void LANGUAGE sql AS $$
  WITH c AS (SELECT id, created_at FROM checkouts WHERE id = p_checkout),
  cl AS (
    SELECT coalesce((SELECT coupon_lines FROM checkout_payments
                     WHERE checkout_id = p_checkout AND method IN ('store_coupon', 'member_discount')), '{}'::bigint[]) AS ids
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
           coalesce(sum(amount) FILTER (WHERE method IN ('store_coupon', 'member_discount')), 0)::bigint AS coup
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

-- ───────────── ④ 临时身份：邀请体验、赠送会籍 ─────────────
-- 只享权益（本月可享的服务类、结账会员折扣、VIP 柜按体验档级），不发每月券与事件礼，不进升档、升阶、保级；
-- 到期由每天的到期处理结束，自己的档级升到体验档级或更高时转正，店主 / 店总可以撤销（写原因）
CREATE TABLE member_trials (
  id             bigserial PRIMARY KEY,
  member_id      bigint NOT NULL REFERENCES members (id),
  kind           text NOT NULL CHECK (kind IN ('invite', 'gift')),
  grade          smallint NOT NULL CHECK (grade BETWEEN 1 AND 6),
  -- 体验的阶位：初阶
  tier           smallint NOT NULL DEFAULT 0 CHECK (tier = 0),
  starts_on      date NOT NULL,
  ends_on        date NOT NULL,
  inviter_id     bigint NOT NULL REFERENCES members (id),
  -- 赠送会籍：那次 QY-042 的使用登记（撤销时一并作废，次数腾出来）
  benefit_use_id bigint UNIQUE REFERENCES benefit_uses (id),
  business_date  date NOT NULL,
  staff_id       bigint NOT NULL REFERENCES staff (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- 页面的操作编号（没收到结果再提交返回原来那条；结果待确认时可以确认作废）
  client_key     uuid NOT NULL UNIQUE,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'converted', 'cancelled')),
  ended_on       date,
  ended_by       bigint REFERENCES staff (id),
  end_reason     text CHECK (end_reason IS NULL OR char_length(btrim(end_reason)) BETWEEN 2 AND 200),
  CHECK (member_id <> inviter_id),
  CHECK (ends_on >= starts_on),
  CHECK ((kind = 'gift') = (benefit_use_id IS NOT NULL)),
  CHECK ((status = 'active') = (ended_on IS NULL)),
  CHECK ((status = 'cancelled') = (ended_by IS NOT NULL)),
  CHECK ((status = 'cancelled') = (end_reason IS NOT NULL))
);
-- 一位会员同一时间只有一个生效中的临时身份
CREATE UNIQUE INDEX member_trials_active_uq ON member_trials (member_id) WHERE status = 'active';
CREATE INDEX member_trials_member_idx ON member_trials (member_id, starts_on);
CREATE INDEX member_trials_inviter_idx ON member_trials (inviter_id, business_date);
CREATE INDEX member_trials_ends_idx ON member_trials (ends_on) WHERE status = 'active';

CREATE FUNCTION yuzu_member_trial_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '临时身份不能删除'; END IF;
  IF OLD.status <> 'active' THEN RAISE EXCEPTION '临时身份已经结束，不能再改'; END IF;
  IF (NEW.member_id, NEW.kind, NEW.grade, NEW.tier, NEW.starts_on, NEW.ends_on, NEW.inviter_id, NEW.benefit_use_id, NEW.business_date,
      NEW.staff_id, NEW.created_at, NEW.client_key)
     IS DISTINCT FROM
     (OLD.member_id, OLD.kind, OLD.grade, OLD.tier, OLD.starts_on, OLD.ends_on, OLD.inviter_id, OLD.benefit_use_id, OLD.business_date,
      OLD.staff_id, OLD.created_at, OLD.client_key) THEN
    RAISE EXCEPTION '临时身份只能结束（到期、转正、撤销），不能改内容';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER member_trials_guard BEFORE UPDATE OR DELETE ON member_trials
  FOR EACH ROW EXECUTE FUNCTION yuzu_member_trial_guard();

-- 作废登记加「邀请体验 / 赠送会籍」
ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'checkin', 'bill_post', 'tag_swap', 'checkout', 'table_open', 'table_post', 'table_checkout',
                     'room_checkin', 'room_extend', 'room_deposit', 'room_refund', 'room_close', 'line_move',
                     'expense_claim', 'petty_advance', 'petty_settlement', 'purchase_request', 'ap_offset', 'supplier_refund', 'erp_import',
                     'supplier_recon', 'supplier_recon_void', 'space_import', 'location_report', 'usage_open', 'usage_end', 'usage_cancel',
                     'checkout_refund', 'coupon_template', 'coupon_rule', 'coupon_batch', 'coupon_issue',
                     'device_create', 'device_job', 'payment', 'opening_payable', 'grade_adjust', 'benefit_use', 'member_trial'));
