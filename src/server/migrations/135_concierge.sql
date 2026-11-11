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
 -- 主线整改：能改的记录（预约、接待、待办、凭证、名称）每改一次版本号加一，编号与顺序号不能动——
 -- 每一版都在 concierge_revisions 里有一份，绕过应用直接改库也留得下痕迹（已确认凭证的更正也在内）
 IF NEW.id<>OLD.id OR NEW.ordinal<>OLD.ordinal OR NEW.version<>OLD.version+1 THEN
  RAISE EXCEPTION '管家记录的修改要带上新的版本号，编号不能改';
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

-- ───────── 主线整改（8.0.12 合并前；这个迁移还没有发布到任何环境）─────────

-- 管家会员档案：不能删，编号、六位编码与建档信息不能改，每改一次版本号加一（原来这张表没有任何保护）
CREATE FUNCTION yuzu_concierge_member_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION '管家会员档案不能删除'; END IF;
 IF NEW.id<>OLD.id OR NEW.code<>OLD.code OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1 THEN
  RAISE EXCEPTION '管家会员的编号与建档信息不能改，修改要带上新的版本号';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER concierge_members_guard BEFORE UPDATE OR DELETE ON concierge_members FOR EACH ROW EXECUTE FUNCTION yuzu_concierge_member_guard();

-- 同步版本号：管家部每次写入在模块锁里加一，页面每 3 秒只比这个数。
-- 原来比的是全店 audit_logs 的最大编号：别的模块每记一条审计，所有开着管家部的页面都要重新取一遍整个工作区。
CREATE TABLE concierge_sync (
 only_row boolean PRIMARY KEY DEFAULT true CHECK (only_row),
 revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
INSERT INTO concierge_sync DEFAULT VALUES;

-- 管家部的操作列表、导出按编号倒序读这两类审计；审计表原来没有能用的索引，要扫全表
CREATE INDEX audit_logs_concierge ON audit_logs (id DESC) WHERE action IN ('concierge_record','concierge_upload');
