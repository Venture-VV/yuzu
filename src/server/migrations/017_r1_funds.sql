-- R1.2 资金轨（店主 2026-10-29 签认，见 docs/PENDING_DECISIONS.md「2026-10-29 店主答复」与 ROADMAP 第 4 节）（增量迁移）
--   · 收款方式「优惠 / 免单」：值班经理及以上当场授权并填原因（记在 ref），不计入实收；一张结账单最多一笔；
--   · 降低票种、改为免票（接待时直接选免票也算）：当场授权并填原因，记下授权人；
--   · 「其他」收款必须填备注（只约束之后的记录）；
--   · 反结账后重结的门票按第一次结账的时间计算：反结账时把结账时刻记到来访上，之后结账按它计价，写入后不再改；
--   · 撤销与反结账时限（#10）默认 48 小时：仍是「不限」的改为 48 小时；跳档宽限（❓6）仍是 0 的改为 15 分钟；
--   · 「收款前必须先开班」是经营规则开关（代码默认开），反结账退款的交班口径只改汇总，都不需要改表。

-- ① 当场授权增加用途：优惠 / 免单（checkout_discount）、降低票种与免票（ticket_discount）
ALTER TABLE auth_grants DROP CONSTRAINT auth_grants_purpose_check;
ALTER TABLE auth_grants ADD CONSTRAINT auth_grants_purpose_check
  CHECK (purpose IN ('vip_tag', 'over_limit', 'checkout_discount', 'ticket_discount'));

-- ② 收款方式「优惠 / 免单」：授权人与授权编号必填，原因记在 ref（至少 2 个字）
ALTER TABLE checkout_payments DROP CONSTRAINT checkout_payments_method_check;
ALTER TABLE checkout_payments ADD CONSTRAINT checkout_payments_method_check
  CHECK (method IN ('cash', 'wechat', 'alipay', 'bank_card', 'other', 'wallet', 'coupon', 'discount'));
ALTER TABLE checkout_payments
  ADD COLUMN approved_by bigint REFERENCES staff (id),
  ADD COLUMN grant_id uuid REFERENCES auth_grants (id),
  ADD CONSTRAINT checkout_payments_discount_check CHECK (
    (method = 'discount') = (approved_by IS NOT NULL) AND (method = 'discount') = (grant_id IS NOT NULL)
    AND (method <> 'discount' OR char_length(btrim(ref)) >= 2));
CREATE UNIQUE INDEX checkout_payments_discount_uq ON checkout_payments (checkout_id) WHERE method = 'discount';
CREATE UNIQUE INDEX checkout_payments_grant_uq ON checkout_payments (grant_id) WHERE grant_id IS NOT NULL;
-- 「其他」收款必须填备注：只约束新记录（收款明细只追加，之前没有备注的记录保持原样）
ALTER TABLE checkout_payments ADD CONSTRAINT checkout_payments_other_note_check
  CHECK (method <> 'other' OR char_length(btrim(ref)) > 0) NOT VALID;

-- ③ 改票种记录：降低票种或改为免票时的授权人与原因（接待时直接选免票也记一条）
ALTER TABLE visit_ticket_changes
  ADD COLUMN approved_by bigint REFERENCES staff (id),
  ADD COLUMN reason text CHECK (reason IS NULL OR char_length(reason) BETWEEN 2 AND 100),
  ADD CONSTRAINT visit_ticket_changes_approval_check CHECK ((approved_by IS NULL) = (reason IS NULL));
CREATE INDEX visit_ticket_changes_approved_idx ON visit_ticket_changes (created_at) WHERE approved_by IS NOT NULL;

-- ④ 门票计到的时间：反结账时写入第一次结账的时刻（多次反结账仍是第一次），之后结账按它计价
ALTER TABLE visits ADD COLUMN ticket_end_at timestamptz;

-- 来访的保护（在 014 的基础上）：门票计到的时间只能在反结账恢复在店时写入，写入后不再改
CREATE OR REPLACE FUNCTION yuzu_visit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '来访记录禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.visit_no, NEW.bill_id, NEW.business_date, NEW.checked_in_at, NEW.checked_in_by, NEW.checkin_key)
     IS DISTINCT FROM (OLD.id, OLD.visit_no, OLD.bill_id, OLD.business_date, OLD.checked_in_at, OLD.checked_in_by, OLD.checkin_key) THEN
    RAISE EXCEPTION '来访编号与开牌信息不可修改' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'settled' AND NEW.status = 'open' AND NEW.closed_at IS NULL AND NEW.closed_by IS NULL
     AND (NEW.tag_id, NEW.zone, NEW.member_id, NEW.group_id, NEW.ticket_type_id, NEW.ticket_price_12h, NEW.ticket_price_24h)
         IS NOT DISTINCT FROM (OLD.tag_id, OLD.zone, OLD.member_id, OLD.group_id, OLD.ticket_type_id, OLD.ticket_price_12h, OLD.ticket_price_24h)
     AND NEW.ticket_end_at IS NOT NULL AND (OLD.ticket_end_at IS NULL OR NEW.ticket_end_at = OLD.ticket_end_at)
     AND current_setting('yuzu.reopen', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION '已离店或已撤销的来访不可修改' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.ticket_end_at IS DISTINCT FROM OLD.ticket_end_at THEN
    RAISE EXCEPTION '门票计到的时间只能在反结账时写入' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- ⑤ 默认值（只改仍是旧默认的，已手动调过的不动）：撤销与反结账时限 48 小时；跳档宽限 15 分钟
UPDATE settings SET value = '48'::jsonb, updated_at = now() WHERE key = 'reversal_window_hours' AND value = 'null'::jsonb;
UPDATE settings SET value = jsonb_set(value, '{overtimeGraceMinutes}', '15'), updated_at = now()
WHERE key = 'frontdesk_rules' AND value->>'overtimeGraceMinutes' = '0';
