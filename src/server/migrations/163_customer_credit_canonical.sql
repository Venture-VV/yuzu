-- 162 已落库后新增认领时主账号快照；禁止用当前关系伪造旧认领历史。
-- （这两份迁移在客户部自己的分支上叫 138、139；整合进主线时与 8.0.20 登记的号撞了，改成 162、163，内容没动。）
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM customer_recharge_credits) THEN
  RAISE EXCEPTION '客户部归属已有历史，无法可靠补齐认领时主账号；请先人工审查升级方案';
 END IF;
END $$;
ALTER TABLE customer_recharge_credits ADD COLUMN canonical_member_id bigint NOT NULL REFERENCES members(id);
CREATE OR REPLACE FUNCTION yuzu_customer_projection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION '客户部记录不能删除'; END IF;
 IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION '客户部修改须递增版本'; END IF;
 IF TG_TABLE_NAME='customer_bindings' THEN
  IF NEW.member_id<>OLD.member_id THEN RAISE EXCEPTION '绑定会员不能更改'; END IF;
 ELSIF TG_TABLE_NAME='customer_binding_requests' THEN
  IF OLD.status<>'pending' OR NEW.status NOT IN ('approved','rejected') OR ROW(NEW.id,NEW.member_id,NEW.from_staff_id,NEW.to_staff_id,NEW.expected_version,NEW.reason,NEW.requested_by,NEW.requested_at) IS DISTINCT FROM ROW(OLD.id,OLD.member_id,OLD.from_staff_id,OLD.to_staff_id,OLD.expected_version,OLD.reason,OLD.requested_by,OLD.requested_at) THEN RAISE EXCEPTION '绑定申请原始信息不能覆盖'; END IF;
 ELSIF TG_TABLE_NAME='customer_recharge_credits' THEN
  IF ROW(NEW.id,NEW.recharge_id,NEW.member_id,NEW.occurred_at,NEW.maintainer_at_event) IS DISTINCT FROM ROW(OLD.id,OLD.recharge_id,OLD.member_id,OLD.occurred_at,OLD.maintainer_at_event) OR NOT ((OLD.status IN ('rejected','voided') AND NEW.status='pending') OR (OLD.status='pending' AND NEW.status IN ('verified','rejected')) OR (OLD.status='verified' AND NEW.status='voided')) THEN RAISE EXCEPTION '充值归属状态或原生事实不可更改'; END IF;
  IF NEW.status<>'pending' AND ROW(NEW.seller_staff_id,NEW.first_kind,NEW.owner_department,NEW.reason,NEW.claimed_by,NEW.claimed_at,NEW.canonical_member_id) IS DISTINCT FROM ROW(OLD.seller_staff_id,OLD.first_kind,OLD.owner_department,OLD.reason,OLD.claimed_by,OLD.claimed_at,OLD.canonical_member_id) THEN RAISE EXCEPTION '审核不能覆盖原认领信息'; END IF;
 ELSIF TG_TABLE_NAME='customer_month_targets' THEN
  IF ROW(NEW.id,NEW.month,NEW.staff_id) IS DISTINCT FROM ROW(OLD.id,OLD.month,OLD.staff_id) THEN RAISE EXCEPTION '目标对象与月份不能改'; END IF;
 END IF;
 RETURN NEW;
END $$;
