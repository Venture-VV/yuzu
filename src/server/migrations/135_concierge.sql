-- 8.0.12 管家部：只新增业务数据，不自动纳入旧站或原生会员，不写钱包。
ALTER TABLE staff DROP CONSTRAINT staff_duties_check;
ALTER TABLE staff ADD CONSTRAINT staff_duties_check CHECK
 (duties <@ ARRAY['stock','purchase','payable','approve','cost','request','legal','concierge','concierge_manager']::text[]);
ALTER TABLE erp_images DROP CONSTRAINT erp_images_scope_check;
ALTER TABLE erp_images ADD CONSTRAINT erp_images_scope_check CHECK (scope IN ('general','contract','concierge'));
ALTER TABLE erp_images DROP CONSTRAINT erp_images_size_bytes_check;
ALTER TABLE erp_images ADD CONSTRAINT erp_images_size_bytes_check CHECK
 (size_bytes BETWEEN 1 AND CASE WHEN scope = 'concierge' THEN 4194304 ELSE 1048576 END);

CREATE TABLE concierge_members (
 id uuid PRIMARY KEY,
 code integer GENERATED ALWAYS AS IDENTITY UNIQUE CHECK (code BETWEEN 1 AND 999999),
 native_member_id bigint UNIQUE REFERENCES members(id),
 data jsonb NOT NULL CHECK (jsonb_typeof(data)='object'),
 version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 created_by bigint NOT NULL REFERENCES staff(id), updated_by bigint NOT NULL REFERENCES staff(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX concierge_card_no_unique ON concierge_members ((data->>'cardNo')) WHERE coalesce(data->>'cardNo','')<>'';
CREATE TABLE concierge_records (
 id uuid PRIMARY KEY, ordinal bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 kind text NOT NULL CHECK (kind IN ('balance','appointment','note','visit','task','receipt','catalog')),
 member_id uuid REFERENCES concierge_members(id),
 native_booking_id bigint REFERENCES bookings(id),
 native_checkout_id bigint REFERENCES checkouts(id),
 data jsonb NOT NULL CHECK (jsonb_typeof(data)='object'),
 version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 created_by bigint NOT NULL REFERENCES staff(id), updated_by bigint NOT NULL REFERENCES staff(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX concierge_records_member_kind ON concierge_records(member_id,kind,created_at DESC,id);
CREATE INDEX concierge_records_recent ON concierge_records(kind,created_at DESC,id);
CREATE UNIQUE INDEX concierge_catalog_name_spec ON concierge_records ((data->>'normalizedName'),(data->>'normalizedSpec')) WHERE kind='catalog';
CREATE UNIQUE INDEX concierge_visit_appointment ON concierge_records ((data->>'appointmentId')) WHERE kind='visit' AND coalesce(data->>'appointmentId','')<>'';
CREATE UNIQUE INDEX concierge_confirmed_receipt ON concierge_records ((data->>'store'),(data->>'number'),(data->>'receiptDay'))
 WHERE kind='receipt' AND data->>'status'='已确认' AND data->>'kind'='结算单';
CREATE TABLE concierge_uploads (
 id uuid PRIMARY KEY, member_id uuid REFERENCES concierge_members(id), image_id bigint NOT NULL REFERENCES erp_images(id),
 created_by bigint NOT NULL REFERENCES staff(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX concierge_upload_dedup ON concierge_uploads(coalesce(member_id::text,''),image_id);
CREATE TRIGGER concierge_uploads_append_only BEFORE UPDATE OR DELETE ON concierge_uploads FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
CREATE TABLE concierge_revisions (
 id bigserial PRIMARY KEY, object_type text NOT NULL, object_id uuid NOT NULL, version integer NOT NULL,
 snapshot jsonb NOT NULL, actor_id bigint NOT NULL REFERENCES staff(id), reason text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(object_type,object_id,version)
);
CREATE TRIGGER concierge_revisions_append_only BEFORE UPDATE OR DELETE ON concierge_revisions FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
CREATE TABLE concierge_operations (
 actor_id bigint NOT NULL REFERENCES staff(id), request_id text NOT NULL CHECK(length(request_id) BETWEEN 1 AND 100),
 request_hash text NOT NULL, response jsonb, abandoned boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(actor_id,request_id)
);
CREATE TRIGGER concierge_operations_append_only BEFORE UPDATE OR DELETE ON concierge_operations FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
CREATE FUNCTION yuzu_concierge_record_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.kind IN ('balance','note') OR NEW.kind<>OLD.kind OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at THEN
  RAISE EXCEPTION '管家核对快照、服务事实及创建信息只追加';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER concierge_records_guard BEFORE UPDATE OR DELETE ON concierge_records FOR EACH ROW EXECUTE FUNCTION yuzu_concierge_record_guard();
CREATE FUNCTION yuzu_concierge_image_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM erp_images WHERE id=NEW.image_id AND scope='concierge') THEN RAISE EXCEPTION '管家凭证用途不匹配'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER concierge_image_guard BEFORE INSERT ON concierge_uploads FOR EACH ROW EXECUTE FUNCTION yuzu_concierge_image_guard();
CREATE TABLE concierge_balance_evidence (
 id bigserial PRIMARY KEY, balance_id uuid NOT NULL REFERENCES concierge_records(id),
 upload_id uuid REFERENCES concierge_uploads(id), receipt_id uuid REFERENCES concierge_records(id),
 created_by bigint NOT NULL REFERENCES staff(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK ((upload_id IS NOT NULL)::int + (receipt_id IS NOT NULL)::int=1),
 UNIQUE(balance_id,upload_id), UNIQUE(balance_id,receipt_id)
);
CREATE TRIGGER concierge_balance_evidence_append_only BEFORE UPDATE OR DELETE ON concierge_balance_evidence FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
