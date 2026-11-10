-- 8.0.7 供应链收尾 2.5 与 A4（docs/ERP_V807.md）：
--   · 验收标准模板：名称与逐条标准；合同的「验收」一节可以选模板，逐条标准写进合同内容（随合同版本走，不在这里存）；
--   · 验收登记的逐条结果（合格 / 不合格）：有一条不合格整次就是不合格；之前的登记为空（没有逐条）；
--   · 合同扫描件可以是 PDF（文件库用途 contract_scan，迁移 097 已加）：扫描件一行要么是图片、要么是 PDF；
--     归档要求的「至少一张扫描件」算 PDF。守卫（077、079）跟着更新。

CREATE TABLE acceptance_templates (
  id         bigserial PRIMARY KEY,
  name       text NOT NULL UNIQUE CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  items      jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) BETWEEN 1 AND 20),
  active     boolean NOT NULL DEFAULT true,
  version    integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by bigint NOT NULL REFERENCES staff (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by bigint REFERENCES staff (id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER acceptance_templates_no_delete BEFORE DELETE ON acceptance_templates
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- ───────────── 验收登记的逐条结果 ─────────────
ALTER TABLE contract_acceptances ADD COLUMN items jsonb CHECK (items IS NULL OR (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) BETWEEN 1 AND 20));

CREATE OR REPLACE FUNCTION yuzu_contract_acceptance_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '验收登记不能删除，只能作废'; END IF;
  IF OLD.voided_at IS NOT NULL OR NEW.voided_at IS NULL
     OR NEW.contract_id <> OLD.contract_id OR NEW.accepted_on <> OLD.accepted_on OR NEW.result <> OLD.result
     OR NEW.signer <> OLD.signer OR NEW.note <> OLD.note OR NEW.client_key <> OLD.client_key
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
     OR NEW.items IS DISTINCT FROM OLD.items THEN
    RAISE EXCEPTION '验收登记只能作废一次，不能改';
  END IF;
  RETURN NEW;
END $$;

-- ───────────── 合同扫描件可以是 PDF ─────────────
ALTER TABLE contract_files ALTER COLUMN image_id DROP NOT NULL;
ALTER TABLE contract_files ADD COLUMN file_id bigint REFERENCES erp_files (id);
ALTER TABLE contract_files ADD COLUMN name text NOT NULL DEFAULT '' CHECK (char_length(name) <= 80);
ALTER TABLE contract_files ADD CONSTRAINT contract_files_one_media CHECK (num_nonnulls(image_id, file_id) = 1);

CREATE OR REPLACE FUNCTION yuzu_contract_file_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '合同的扫描件不能删除，只能标记删掉'; END IF;
  IF (NEW.contract_id, NEW.image_id, NEW.file_id, NEW.name, NEW.sort_no, NEW.added_by, NEW.added_at)
       IS DISTINCT FROM (OLD.contract_id, OLD.image_id, OLD.file_id, OLD.name, OLD.sort_no, OLD.added_by, OLD.added_at)
     OR OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION '合同的扫描件只能标记删掉一次';
  END IF;
  RETURN NEW;
END $$;

-- 扫描件的图片只能是合同用途的、PDF 只能是 contract_scan 用途的（替换 079 挂在 contract_files 上的图片用途守卫）
DROP TRIGGER contract_files_scope ON contract_files;
CREATE FUNCTION yuzu_contract_file_media_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.image_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM erp_images WHERE id = NEW.image_id AND scope = 'contract') THEN
    RAISE EXCEPTION '图片 % 不是合同扫描件用途的，这里只能挂合同扫描件的图片', NEW.image_id;
  END IF;
  IF NEW.file_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM erp_files WHERE id = NEW.file_id AND scope = 'contract_scan') THEN
    RAISE EXCEPTION '文件 % 不是合同扫描件用途的 PDF', NEW.file_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contract_files_media BEFORE INSERT ON contract_files
  FOR EACH ROW EXECUTE FUNCTION yuzu_contract_file_media_guard();
