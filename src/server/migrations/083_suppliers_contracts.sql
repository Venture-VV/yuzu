-- 8.0.1 采购组整改 08（CG08，docs/PURCHASING_V801.md）：供应商分「签约 / 未签约」，签约的可以上传合同 PDF；通用的文件存储（PDF）。
-- 采购途径固定三类（网购、自采、供应商）不改表、不改数据：已经生效的单据只追加，记的还是当时的途径名称；
-- 按三类统计、筛选时旧的途径键按 channelCategory 对应（批发市场、商超门店、其他与自加的算自采），供应商档案里旧的默认途径同样对应、
-- 下次保存时存成三类之一。「到货超期天数」挪到采购规则（CG01）也不改数据：采购规则里没存过的，沿用费用报销规则里原来的值。

ALTER TABLE suppliers ADD COLUMN contracted boolean NOT NULL DEFAULT false;

-- 文件（PDF）：存在数据库里，随备份、异地副本与数据指纹走；同一用途下同一份文件（内容摘要相同）只存一份；只追加
--   supplier_contract：签约供应商的合同（08）；receipt：收货单的附件（11，迁移 084）
CREATE TABLE erp_files (
  id         bigserial PRIMARY KEY,
  scope      text NOT NULL CHECK (scope IN ('supplier_contract', 'receipt')),
  sha256     text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  mime       text NOT NULL CHECK (mime IN ('application/pdf')),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  data       bytea NOT NULL,
  created_by bigint NOT NULL REFERENCES staff (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope, sha256),
  CHECK (octet_length(data) = size_bytes)
);
CREATE TRIGGER erp_files_append_only BEFORE UPDATE OR DELETE ON erp_files
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- 签约供应商的合同 PDF：可以传多份；撤下保留记录（只能补上撤下的人与时间一次，别的不能改、不能删）
CREATE TABLE supplier_contract_files (
  id          bigserial PRIMARY KEY,
  supplier_id bigint NOT NULL REFERENCES suppliers (id),
  file_id     bigint NOT NULL REFERENCES erp_files (id),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  uploaded_by bigint NOT NULL REFERENCES staff (id),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  removed_by  bigint REFERENCES staff (id),
  removed_at  timestamptz,
  CHECK ((removed_by IS NULL) = (removed_at IS NULL))
);
CREATE UNIQUE INDEX supplier_contract_files_active ON supplier_contract_files (supplier_id, file_id) WHERE removed_at IS NULL;
CREATE INDEX supplier_contract_files_supplier_idx ON supplier_contract_files (supplier_id);

CREATE FUNCTION yuzu_supplier_contract_file_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '供应商的合同文件禁止删除（撤下保留记录）' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.removed_at IS NOT NULL
     OR (NEW.supplier_id, NEW.file_id, NEW.name, NEW.uploaded_by, NEW.uploaded_at)
        IS DISTINCT FROM (OLD.supplier_id, OLD.file_id, OLD.name, OLD.uploaded_by, OLD.uploaded_at) THEN
    RAISE EXCEPTION '供应商的合同文件只能撤下一次，别的不能改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER supplier_contract_files_guard BEFORE UPDATE OR DELETE ON supplier_contract_files
  FOR EACH ROW EXECUTE FUNCTION yuzu_supplier_contract_file_guard();
