-- 8.0.1 采购组整改 11（CG11，docs/PURCHASING_V801.md）：收货单的附件（货物、送货单、小票的照片与 PDF）。
-- 收货单（按采购单收货、急采）可以挂附件：图片存在 erp_images（与需求单、采购单的图片同一处），PDF 存在 erp_files（scope = receipt，083）。
-- 每张收货单最多 9 份（登记时在收货单一行的锁里核对）；只追加：生效以后还能补传，不能删、不能改。

CREATE TABLE inv_doc_attachments (
  id          bigserial PRIMARY KEY,
  doc_id      bigint NOT NULL REFERENCES inv_docs (id),
  image_id    bigint REFERENCES erp_images (id),
  file_id     bigint REFERENCES erp_files (id),
  name        text NOT NULL DEFAULT '' CHECK (char_length(name) <= 80),
  uploaded_by bigint NOT NULL REFERENCES staff (id),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((image_id IS NULL) <> (file_id IS NULL))
);
CREATE INDEX inv_doc_attachments_doc_idx ON inv_doc_attachments (doc_id);
-- 同一张图、同一份 PDF 在一张收货单上只挂一次
CREATE UNIQUE INDEX inv_doc_attachments_image ON inv_doc_attachments (doc_id, image_id) WHERE image_id IS NOT NULL;
CREATE UNIQUE INDEX inv_doc_attachments_file ON inv_doc_attachments (doc_id, file_id) WHERE file_id IS NOT NULL;
CREATE TRIGGER inv_doc_attachments_append_only BEFORE UPDATE OR DELETE ON inv_doc_attachments
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
