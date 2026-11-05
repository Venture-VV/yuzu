-- v0.7.31 合同扫描件与需求单、采购单的图片分开存（Codex 自动审查 315e7f7）。
-- 原来扫描件和需求单、采购单行的图片存在同一张表 erp_images，通用的图片接口 GET /api/erp/images/:id
-- （能看需求单、库存或报销的人都能用）按编号给出任何一张，只有仓库职责、没有「查看合同」的人也能按连续的编号翻到合同扫描件；
-- 需求单、采购单的行也能挂上合同扫描件的编号再看。
-- 图片加「用途」：general（需求单、采购单的行）/ contract（合同扫描件）。通用接口只给 general，需求单、采购单的行只能挂 general；
-- 合同扫描件只经合同的接口看（要「查看合同」、合同模块开着）。同一份内容在两处各存一份：按内容去重只在同一种用途里。

ALTER TABLE erp_images ADD COLUMN scope text NOT NULL DEFAULT 'general' CHECK (scope IN ('general', 'contract'));
ALTER TABLE erp_images DROP CONSTRAINT erp_images_sha256_key;
CREATE UNIQUE INDEX erp_images_scope_sha256 ON erp_images (scope, sha256);

-- 已经挂在合同上的图片（只在 v0.7.31 开发期间的开发、演示库里有）：没被需求单、采购单用到的改成合同扫描件。
-- erp_images 只追加（触发器拦改、删），这里在同一个事务里临时关掉触发器改「用途」一列（同 040）
ALTER TABLE erp_images DISABLE TRIGGER erp_images_append_only;
UPDATE erp_images i SET scope = 'contract'
WHERE EXISTS (SELECT 1 FROM contract_files f WHERE f.image_id = i.id)
  AND NOT EXISTS (SELECT 1 FROM purchase_request_line_images x WHERE x.image_id = i.id)
  AND NOT EXISTS (SELECT 1 FROM purchase_order_line_images y WHERE y.image_id = i.id);
ALTER TABLE erp_images ENABLE TRIGGER erp_images_append_only;

-- 数据库兜底：需求单、采购单的行只能挂 general 的图片；新挂的合同扫描件只能是 contract 的
CREATE FUNCTION yuzu_image_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  want text := CASE WHEN TG_TABLE_NAME = 'contract_files' THEN 'contract' ELSE 'general' END;
  got  text;
BEGIN
  SELECT scope INTO got FROM erp_images WHERE id = NEW.image_id;
  IF got IS DISTINCT FROM want THEN
    RAISE EXCEPTION '图片 % 的用途是 %，这里只能挂 % 的图片', NEW.image_id, got, want;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER purchase_request_line_images_scope BEFORE INSERT ON purchase_request_line_images
  FOR EACH ROW EXECUTE FUNCTION yuzu_image_scope_guard();
CREATE TRIGGER purchase_order_line_images_scope BEFORE INSERT ON purchase_order_line_images
  FOR EACH ROW EXECUTE FUNCTION yuzu_image_scope_guard();
CREATE TRIGGER contract_files_scope BEFORE INSERT ON contract_files
  FOR EACH ROW EXECUTE FUNCTION yuzu_image_scope_guard();
