-- 8.0.7 供应链收尾 2.1（docs/ERP_V807.md）：供应商准入状态与证照；文件库（erp_files）加两种用途。
--   · 准入状态：待准入 / 已准入 / 暂停。已有的供应商都是「已准入」（升级后行为不变）；页面上新建的是「待准入」
--     （接口新建时写明，种子、导入等其他写入照旧按已准入）。准入、暂停由负责人登记（记谁、什么时候、说明）。
--   · 证照：营业执照、食品经营许可证、卫生许可证、其他；号码、有效期至（空 = 长期）、照片或 PDF；
--     不能删，撤下要写原因（只能补上撤下的人、时间、原因一次，与签约供应商的合同 PDF 一样）。
--   · 文件库用途加 supplier_license（证照 PDF）、contract_scan（合同扫描件 PDF，A4，迁移 099 挂到扫描件上）。

ALTER TABLE suppliers ADD COLUMN admission text NOT NULL DEFAULT 'approved' CHECK (admission IN ('pending', 'approved', 'suspended'));
ALTER TABLE suppliers ADD COLUMN admission_note text NOT NULL DEFAULT '' CHECK (char_length(admission_note) <= 200);
ALTER TABLE suppliers ADD COLUMN admission_by bigint REFERENCES staff (id);
ALTER TABLE suppliers ADD COLUMN admission_at timestamptz;

ALTER TABLE erp_files DROP CONSTRAINT erp_files_scope_check;
ALTER TABLE erp_files ADD CONSTRAINT erp_files_scope_check
  CHECK (scope IN ('supplier_contract', 'receipt', 'invoice', 'supplier_license', 'contract_scan'));

CREATE TABLE supplier_licenses (
  id            bigserial PRIMARY KEY,
  supplier_id   bigint NOT NULL REFERENCES suppliers (id),
  kind          text NOT NULL CHECK (kind IN ('business', 'food', 'hygiene', 'other')),
  -- 「其他」要写名称；另外三种可以不写
  name          text NOT NULL DEFAULT '' CHECK (char_length(name) <= 40),
  license_no    text NOT NULL CHECK (char_length(license_no) BETWEEN 1 AND 64),
  -- 有效期至：空 = 长期
  valid_until   date,
  image_id      bigint REFERENCES erp_images (id),
  file_id       bigint REFERENCES erp_files (id),
  added_by      bigint NOT NULL REFERENCES staff (id),
  added_at      timestamptz NOT NULL DEFAULT now(),
  removed_by    bigint REFERENCES staff (id),
  removed_at    timestamptz,
  remove_reason text CHECK (char_length(remove_reason) BETWEEN 2 AND 200),
  CHECK (num_nonnulls(image_id, file_id) <= 1),
  CHECK (kind <> 'other' OR char_length(name) >= 1),
  CHECK ((removed_at IS NULL) = (removed_by IS NULL) AND (removed_at IS NULL) = (remove_reason IS NULL))
);
CREATE INDEX supplier_licenses_supplier_idx ON supplier_licenses (supplier_id);
CREATE INDEX supplier_licenses_due_idx ON supplier_licenses (valid_until) WHERE removed_at IS NULL;

CREATE FUNCTION yuzu_supplier_license_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '供应商的证照禁止删除（撤下保留记录）' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.removed_at IS NOT NULL
     OR (NEW.supplier_id, NEW.kind, NEW.name, NEW.license_no, NEW.valid_until, NEW.image_id, NEW.file_id, NEW.added_by, NEW.added_at)
        IS DISTINCT FROM (OLD.supplier_id, OLD.kind, OLD.name, OLD.license_no, OLD.valid_until, OLD.image_id, OLD.file_id, OLD.added_by, OLD.added_at) THEN
    RAISE EXCEPTION '供应商的证照只能撤下一次，别的不能改（换证请撤下旧的、登记新的）' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER supplier_licenses_guard BEFORE UPDATE OR DELETE ON supplier_licenses
  FOR EACH ROW EXECUTE FUNCTION yuzu_supplier_license_guard();

-- 证照的照片只能是通用用途的图片（合同扫描件的图片挂不上来）
CREATE FUNCTION yuzu_supplier_license_media_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.image_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM erp_images WHERE id = NEW.image_id AND scope = 'general') THEN
    RAISE EXCEPTION '证照的照片 % 不是通用用途的图片', NEW.image_id;
  END IF;
  IF NEW.file_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM erp_files WHERE id = NEW.file_id AND scope = 'supplier_license') THEN
    RAISE EXCEPTION '证照的 PDF % 不是证照用途的文件', NEW.file_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER supplier_licenses_media BEFORE INSERT ON supplier_licenses
  FOR EACH ROW EXECUTE FUNCTION yuzu_supplier_license_media_guard();
