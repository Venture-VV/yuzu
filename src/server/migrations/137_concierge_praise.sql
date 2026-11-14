-- 管家好评独立保存；旧消费凭证、钱包和135/136保持不动。
CREATE TABLE concierge_praise (
 id uuid PRIMARY KEY,
 staff_id bigint NOT NULL REFERENCES staff(id),
 staff_name_snapshot text NOT NULL CHECK (length(btrim(staff_name_snapshot)) BETWEEN 1 AND 100),
 occurred_on date NOT NULL,
 source text NOT NULL CHECK (length(btrim(source)) BETWEEN 1 AND 80),
 content text NOT NULL CHECK (length(btrim(content)) BETWEEN 1 AND 4000),
 guest_name text NOT NULL CHECK (length(btrim(guest_name)) BETWEEN 1 AND 80),
 member_id uuid REFERENCES concierge_members(id),
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','voided')),
 version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 created_by bigint NOT NULL REFERENCES staff(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 voided_by bigint REFERENCES staff(id), voided_at timestamptz,
 void_reason text NOT NULL DEFAULT '' CHECK (length(void_reason)<=1000),
 CHECK ((status='active' AND voided_by IS NULL AND voided_at IS NULL AND void_reason='') OR
        (status='voided' AND voided_by IS NOT NULL AND voided_at IS NOT NULL AND length(btrim(void_reason))>=1))
);
CREATE INDEX concierge_praise_month ON concierge_praise(occurred_on DESC,created_at DESC,id DESC) WHERE status='active';
CREATE INDEX concierge_praise_staff_history ON concierge_praise(staff_id,occurred_on DESC,created_at DESC,id DESC);
CREATE TABLE concierge_praise_evidence (
 praise_id uuid NOT NULL REFERENCES concierge_praise(id),
 upload_id uuid NOT NULL REFERENCES concierge_uploads(id),
 position smallint NOT NULL CHECK (position BETWEEN 0 AND 11),
 PRIMARY KEY(praise_id,upload_id), UNIQUE(praise_id,position)
);
CREATE TRIGGER concierge_praise_evidence_append_only BEFORE UPDATE OR DELETE ON concierge_praise_evidence
 FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

CREATE FUNCTION yuzu_concierge_praise_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION '管家好评不能删除，请留原因撤销'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'active' OR NEW.version<>1 THEN RAISE EXCEPTION '管家好评须从有效记录开始'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.status<>'active' OR NEW.status<>'voided' OR NEW.version<>OLD.version+1 OR
    ROW(NEW.id,NEW.staff_id,NEW.staff_name_snapshot,NEW.occurred_on,NEW.source,NEW.content,NEW.guest_name,NEW.member_id,NEW.created_by,NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.id,OLD.staff_id,OLD.staff_name_snapshot,OLD.occurred_on,OLD.source,OLD.content,OLD.guest_name,OLD.member_id,OLD.created_by,OLD.created_at) THEN
  RAISE EXCEPTION '好评原始信息不能覆盖，纠错须撤销后重新登记';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER concierge_praise_guard BEFORE INSERT OR UPDATE OR DELETE ON concierge_praise
 FOR EACH ROW EXECUTE FUNCTION yuzu_concierge_praise_guard();

CREATE FUNCTION yuzu_concierge_praise_image_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_member uuid; photo_member uuid; photo_scope text;
BEGIN
 SELECT member_id INTO target_member FROM concierge_praise WHERE id=NEW.praise_id;
 SELECT u.member_id,i.scope INTO photo_member,photo_scope FROM concierge_uploads u JOIN erp_images i ON i.id=u.image_id WHERE u.id=NEW.upload_id;
 IF photo_scope IS DISTINCT FROM 'concierge' OR (photo_member IS NOT NULL AND photo_member IS DISTINCT FROM target_member) THEN
  RAISE EXCEPTION '好评图片用途或会员关联不匹配';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER concierge_praise_image_guard BEFORE INSERT ON concierge_praise_evidence
 FOR EACH ROW EXECUTE FUNCTION yuzu_concierge_praise_image_guard();

-- 同一事务先保存记录再保存图片；提交前由数据库兜底至少一张。
CREATE FUNCTION yuzu_concierge_praise_require_image() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM concierge_praise_evidence WHERE praise_id=NEW.id) THEN
  RAISE EXCEPTION '每条管家好评至少需要一张原图凭证';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER concierge_praise_require_image AFTER INSERT ON concierge_praise
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION yuzu_concierge_praise_require_image();
