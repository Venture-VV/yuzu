-- 8.0.3 进项发票台账（docs/BUDGET_INVOICES.md 第 3 节，默认 BI07–BI12 待确认）：在 v0.7.32 的发票登记（supplier_invoices）上扩。
--   · 台账里有三单匹配登记的供应商发票（来源 three_way，分到采购单）、报销单上的专票普票（来源 expense，登记报销时进台账）、
--     财务在台账里直接登记的（来源 manual）；
--   · 加发票类型（费用报销规则的发票类型键与登记时的名称）、开票方名称（报销、台账登记的可以不是供应商）、认证状态与所属期；
--   · 发票的照片或 PDF（只追加，最多 9 份在登记时核对）；erp_files 的用途加「发票」；
--   · 报销单关联台账的发票；一张发票同时只挂一张有效报销单。
-- 只加列、加表、放宽约束：已有的发票登记用列的默认值补上（当作专票、待认证、来源三单），不改已有的行。

ALTER TABLE supplier_invoices
  ALTER COLUMN supplier_id DROP NOT NULL,
  ADD COLUMN issuer_name  text NOT NULL DEFAULT '' CHECK (char_length(issuer_name) <= 60),
  ADD COLUMN kind         text NOT NULL DEFAULT 'vat_special' CHECK (kind ~ '^[a-z0-9_]{1,32}$'),
  ADD COLUMN kind_label   text NOT NULL DEFAULT '增值税专用发票' CHECK (char_length(kind_label) BETWEEN 1 AND 20),
  ADD COLUMN source       text NOT NULL DEFAULT 'three_way' CHECK (source IN ('three_way', 'expense', 'manual')),
  -- 认证：专票待认证 → 已认证（所属期 YYYY-MM）；普票不用认证。可以改回待认证（标错了），作废以后不能再改
  ADD COLUMN cert_status  text NOT NULL DEFAULT 'pending' CHECK (cert_status IN ('pending', 'certified', 'not_required')),
  ADD COLUMN cert_period  text CHECK (cert_period IS NULL OR cert_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  ADD COLUMN cert_by      bigint REFERENCES staff (id),
  ADD COLUMN cert_at      timestamptz,
  ADD COLUMN cert_note    text NOT NULL DEFAULT '' CHECK (char_length(cert_note) <= 100),
  ADD COLUMN cert_version integer NOT NULL DEFAULT 1 CHECK (cert_version >= 1);
ALTER TABLE supplier_invoices
  ADD CONSTRAINT supplier_invoices_certified CHECK ((cert_status = 'certified') = (cert_period IS NOT NULL)),
  ADD CONSTRAINT supplier_invoices_cert_marked CHECK ((cert_by IS NULL) = (cert_at IS NULL)),
  -- 三单匹配的发票分到采购单，要有供应商；报销、台账登记的没有供应商时要么填开票方、要么记「未填」（空，标异常）
  ADD CONSTRAINT supplier_invoices_three_way_supplier CHECK (source <> 'three_way' OR supplier_id IS NOT NULL);
-- 发票号码与报销单一样最多 40 个字（原来 30）
ALTER TABLE supplier_invoices DROP CONSTRAINT supplier_invoices_invoice_no_check;
ALTER TABLE supplier_invoices ADD CONSTRAINT supplier_invoices_invoice_no_check CHECK (char_length(btrim(invoice_no)) BETWEEN 1 AND 40);
-- 按号码找（去掉空白、大写）
CREATE INDEX supplier_invoices_no_norm ON supplier_invoices ((upper(regexp_replace(invoice_no, '\s', '', 'g'))));
-- 没有供应商、填了开票方的：同一开票方同一号码只能有一张没作废的（与供应商的 supplier_invoices_no 一样）
CREATE UNIQUE INDEX supplier_invoices_no_issuer ON supplier_invoices (lower(btrim(issuer_name)), upper(regexp_replace(invoice_no, '\s', '', 'g')))
  WHERE status = 'valid' AND supplier_id IS NULL AND btrim(issuer_name) <> '';

-- 守护：内容不能改；作废只能一次；认证只在没作废时能改；作废时不能同时改认证
CREATE OR REPLACE FUNCTION yuzu_supplier_invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cert text[] := ARRAY['cert_status', 'cert_period', 'cert_by', 'cert_at', 'cert_note', 'cert_version'];
  voiding text[] := ARRAY['status', 'voided_by', 'voided_at', 'void_reason'];
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '发票登记不能删除，只能作废' USING ERRCODE = 'P0001'; END IF;
  IF OLD.status <> 'valid' THEN RAISE EXCEPTION '作废的发票不能再改' USING ERRCODE = 'P0001'; END IF;
  IF ((to_jsonb(NEW) - cert) - voiding) IS DISTINCT FROM ((to_jsonb(OLD) - cert) - voiding) THEN
    RAISE EXCEPTION '发票登记的内容不能改（登错了作废后重新登记）' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status = 'voided' AND (to_jsonb(NEW) - voiding) IS DISTINCT FROM (to_jsonb(OLD) - voiding) THEN
    RAISE EXCEPTION '作废发票时不能同时改认证' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- 发票的照片（erp_images）或 PDF（erp_files，scope = invoice）：只追加
ALTER TABLE erp_files DROP CONSTRAINT erp_files_scope_check;
ALTER TABLE erp_files ADD CONSTRAINT erp_files_scope_check CHECK (scope IN ('supplier_contract', 'receipt', 'invoice'));
CREATE TABLE supplier_invoice_attachments (
  id          bigserial PRIMARY KEY,
  invoice_id  bigint NOT NULL REFERENCES supplier_invoices (id),
  image_id    bigint REFERENCES erp_images (id),
  file_id     bigint REFERENCES erp_files (id),
  name        text NOT NULL DEFAULT '' CHECK (char_length(name) <= 80),
  uploaded_by bigint NOT NULL REFERENCES staff (id),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((image_id IS NULL) <> (file_id IS NULL))
);
CREATE INDEX supplier_invoice_attachments_invoice_idx ON supplier_invoice_attachments (invoice_id);
CREATE UNIQUE INDEX supplier_invoice_attachments_image ON supplier_invoice_attachments (invoice_id, image_id) WHERE image_id IS NOT NULL;
CREATE UNIQUE INDEX supplier_invoice_attachments_file ON supplier_invoice_attachments (invoice_id, file_id) WHERE file_id IS NOT NULL;
CREATE TRIGGER supplier_invoice_attachments_append_only BEFORE UPDATE OR DELETE ON supplier_invoice_attachments
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- 报销单关联台账的发票（8.0.3 起登记的、有号码的专票普票）；一张发票同时只挂一张有效报销单
ALTER TABLE expense_claims ADD COLUMN invoice_id bigint REFERENCES supplier_invoices (id);
CREATE UNIQUE INDEX expense_claims_invoice_once ON expense_claims (invoice_id)
  WHERE invoice_id IS NOT NULL AND status IN ('submitted', 'returned', 'confirmed');
