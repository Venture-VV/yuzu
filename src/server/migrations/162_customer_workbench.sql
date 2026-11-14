-- 客户部仅扩展服务、维护、归属试算与目标；不改原生财务数据。
DO $$
DECLARE t text; expression text;
BEGIN
 FOREACH t IN ARRAY ARRAY['idempotency_keys','op_fences'] LOOP
  SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint WHERE conrelid=t::regclass AND conname=t||'_op_type_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',t,t||'_op_type_check');
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ((%s) OR op_type IN (''customer_note'',''customer_binding_request'',''customer_binding_review'',''customer_credit_claim'',''customer_credit_review'',''customer_target''))',t,t||'_op_type_check',expression);
 END LOOP;
END $$;
CREATE TABLE customer_bindings (
 member_id bigint PRIMARY KEY REFERENCES members(id), maintainer_staff_id bigint REFERENCES staff(id),
 version integer NOT NULL DEFAULT 0 CHECK(version>=0), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE customer_binding_requests (
 id bigserial PRIMARY KEY, member_id bigint NOT NULL REFERENCES members(id),
 from_staff_id bigint REFERENCES staff(id), to_staff_id bigint NOT NULL REFERENCES staff(id),
 expected_version integer NOT NULL CHECK(expected_version>=0), reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 requested_by bigint NOT NULL REFERENCES staff(id), requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 reviewed_by bigint REFERENCES staff(id), reviewed_at timestamptz, review_reason text NOT NULL DEFAULT '',
 CHECK((status='pending' AND reviewed_by IS NULL AND reviewed_at IS NULL AND review_reason='') OR (status<>'pending' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND length(btrim(review_reason)) BETWEEN 1 AND 1000))
);
CREATE UNIQUE INDEX customer_one_pending_binding ON customer_binding_requests(member_id) WHERE status='pending';
CREATE TABLE customer_binding_events (
 id bigserial PRIMARY KEY, member_id bigint NOT NULL REFERENCES members(id), from_staff_id bigint REFERENCES staff(id), to_staff_id bigint NOT NULL REFERENCES staff(id),
 request_id bigint NOT NULL UNIQUE REFERENCES customer_binding_requests(id), version integer NOT NULL CHECK(version>0),
 effective_at timestamptz NOT NULL DEFAULT clock_timestamp(), approved_by bigint NOT NULL REFERENCES staff(id), UNIQUE(member_id,version)
);
CREATE INDEX customer_binding_asof ON customer_binding_events(member_id,effective_at DESC,id DESC);
CREATE TABLE customer_service_notes (
 id bigserial PRIMARY KEY, member_id bigint REFERENCES members(id), visit_id bigint REFERENCES visits(id), staff_id bigint NOT NULL REFERENCES staff(id),
 kind text NOT NULL CHECK(kind IN ('reception','maintenance')), occurred_at timestamptz NOT NULL,
 outcome text NOT NULL CHECK(length(btrim(outcome)) BETWEEN 1 AND 500), content text NOT NULL CHECK(length(btrim(content)) BETWEEN 1 AND 4000),
 feedback text NOT NULL DEFAULT '' CHECK(length(feedback)<=2000), next_contact_on date,
 maintainer_at_event bigint REFERENCES staff(id), created_by bigint NOT NULL REFERENCES staff(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(member_id IS NOT NULL OR visit_id IS NOT NULL)
);
CREATE INDEX customer_notes_member ON customer_service_notes(member_id,occurred_at DESC,id DESC);
CREATE INDEX customer_notes_visit ON customer_service_notes(visit_id,occurred_at DESC,id DESC);
CREATE TABLE customer_recharge_credits (
 id bigserial PRIMARY KEY, recharge_id bigint NOT NULL UNIQUE REFERENCES recharges(id), member_id bigint NOT NULL REFERENCES members(id), occurred_at timestamptz NOT NULL,
 seller_staff_id bigint REFERENCES staff(id), first_kind text NOT NULL CHECK(first_kind IN ('unknown','first','renewal')),
 owner_department text NOT NULL CHECK(owner_department IN ('unknown','customer','frontdesk')),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','verified','rejected','voided')), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000), maintainer_at_event bigint REFERENCES staff(id),
 claimed_by bigint NOT NULL REFERENCES staff(id), claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 reviewed_by bigint REFERENCES staff(id), reviewed_at timestamptz, review_reason text NOT NULL DEFAULT '',
 CHECK(status<>'verified' OR (first_kind<>'unknown' AND owner_department<>'unknown' AND (owner_department<>'customer' OR seller_staff_id IS NOT NULL))),
 CHECK((status='pending' AND reviewed_by IS NULL AND reviewed_at IS NULL AND review_reason='') OR (status<>'pending' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND length(btrim(review_reason)) BETWEEN 1 AND 1000))
);
CREATE INDEX customer_credits_seller ON customer_recharge_credits(seller_staff_id,status,occurred_at DESC);
CREATE TABLE customer_credit_events (
 id bigserial PRIMARY KEY, credit_id bigint NOT NULL REFERENCES customer_recharge_credits(id), version integer NOT NULL CHECK(version>0),
 action text NOT NULL CHECK(action IN ('claim','verify','reject','void')), snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
 actor_id bigint NOT NULL REFERENCES staff(id), reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(credit_id,version)
);
CREATE TABLE customer_month_targets (
 id bigserial PRIMARY KEY, month date NOT NULL CHECK(extract(day FROM month)=1), staff_id bigint REFERENCES staff(id),
 group_name text NOT NULL DEFAULT '' CHECK(length(group_name)<=80), target_cents bigint NOT NULL CHECK(target_cents>=0),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), updated_by bigint NOT NULL REFERENCES staff(id), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX customer_target_department ON customer_month_targets(month) WHERE staff_id IS NULL;
CREATE UNIQUE INDEX customer_target_individual ON customer_month_targets(month,staff_id) WHERE staff_id IS NOT NULL;
CREATE TABLE customer_target_versions (
 id bigserial PRIMARY KEY, target_id bigint NOT NULL REFERENCES customer_month_targets(id), version integer NOT NULL CHECK(version>0),
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'), actor_id bigint NOT NULL REFERENCES staff(id), reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(target_id,version)
);
CREATE TRIGGER customer_notes_immutable BEFORE UPDATE OR DELETE ON customer_service_notes FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
CREATE TRIGGER customer_binding_events_immutable BEFORE UPDATE OR DELETE ON customer_binding_events FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
CREATE TRIGGER customer_credit_events_immutable BEFORE UPDATE OR DELETE ON customer_credit_events FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
CREATE TRIGGER customer_target_versions_immutable BEFORE UPDATE OR DELETE ON customer_target_versions FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
CREATE FUNCTION yuzu_customer_projection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION '客户部记录不能删除'; END IF;
 IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION '客户部修改须递增版本'; END IF;
 IF TG_TABLE_NAME='customer_bindings' THEN
  IF NEW.member_id<>OLD.member_id THEN RAISE EXCEPTION '绑定会员不能更改'; END IF;
 ELSIF TG_TABLE_NAME='customer_binding_requests' THEN
  IF OLD.status<>'pending' OR NEW.status NOT IN ('approved','rejected') OR ROW(NEW.id,NEW.member_id,NEW.from_staff_id,NEW.to_staff_id,NEW.expected_version,NEW.reason,NEW.requested_by,NEW.requested_at) IS DISTINCT FROM ROW(OLD.id,OLD.member_id,OLD.from_staff_id,OLD.to_staff_id,OLD.expected_version,OLD.reason,OLD.requested_by,OLD.requested_at) THEN RAISE EXCEPTION '绑定申请原始信息不能覆盖'; END IF;
 ELSIF TG_TABLE_NAME='customer_recharge_credits' THEN
  IF ROW(NEW.id,NEW.recharge_id,NEW.member_id,NEW.occurred_at,NEW.maintainer_at_event) IS DISTINCT FROM ROW(OLD.id,OLD.recharge_id,OLD.member_id,OLD.occurred_at,OLD.maintainer_at_event) OR NOT ((OLD.status IN ('rejected','voided') AND NEW.status='pending') OR (OLD.status='pending' AND NEW.status IN ('verified','rejected')) OR (OLD.status='verified' AND NEW.status='voided')) THEN RAISE EXCEPTION '充值归属状态或原生事实不可更改'; END IF;
  IF NEW.status<>'pending' AND ROW(NEW.seller_staff_id,NEW.first_kind,NEW.owner_department,NEW.reason,NEW.claimed_by,NEW.claimed_at) IS DISTINCT FROM ROW(OLD.seller_staff_id,OLD.first_kind,OLD.owner_department,OLD.reason,OLD.claimed_by,OLD.claimed_at) THEN RAISE EXCEPTION '审核不能覆盖原认领信息'; END IF;
 ELSIF TG_TABLE_NAME='customer_month_targets' THEN
  IF ROW(NEW.id,NEW.month,NEW.staff_id) IS DISTINCT FROM ROW(OLD.id,OLD.month,OLD.staff_id) THEN RAISE EXCEPTION '目标对象与月份不能改'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER customer_bindings_guard BEFORE UPDATE OR DELETE ON customer_bindings FOR EACH ROW EXECUTE FUNCTION yuzu_customer_projection_guard();
CREATE TRIGGER customer_binding_requests_guard BEFORE UPDATE OR DELETE ON customer_binding_requests FOR EACH ROW EXECUTE FUNCTION yuzu_customer_projection_guard();
CREATE TRIGGER customer_credits_guard BEFORE UPDATE OR DELETE ON customer_recharge_credits FOR EACH ROW EXECUTE FUNCTION yuzu_customer_projection_guard();
CREATE TRIGGER customer_targets_guard BEFORE UPDATE OR DELETE ON customer_month_targets FOR EACH ROW EXECUTE FUNCTION yuzu_customer_projection_guard();
