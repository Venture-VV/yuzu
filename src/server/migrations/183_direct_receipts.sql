-- 8.1.9 库管入库（docs/ERP_V819.md 第 3 节，PENDING_DECISIONS「8.1.9」KR1–KR6）。
-- 收货单加一个标记 direct：与按采购单收货一样（确认入库、成本、挂账供应商记应付、冲销、退供应商、补采购单），只是不选采购单。
-- 台账模板导入：一份文件（按内容摘要）只能导入一次，按「入库日期 + 供应商 + 单据分组」合成库管入库单、一次确认入库。

CREATE TABLE receipt_imports (
  id          bigserial PRIMARY KEY,
  client_key  uuid NOT NULL UNIQUE,
  file_sha256 text NOT NULL UNIQUE CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_name   text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 120),
  row_count   integer NOT NULL CHECK (row_count > 0),
  doc_count   integer NOT NULL CHECK (doc_count > 0),
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  created_by  bigint NOT NULL REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER receipt_imports_immutable BEFORE UPDATE OR DELETE ON receipt_imports FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

ALTER TABLE inv_docs ADD COLUMN direct boolean NOT NULL DEFAULT false;
ALTER TABLE inv_docs ADD COLUMN import_id bigint REFERENCES receipt_imports (id);
-- 库管入库只能是收货单、不是急采、没有采购单（补采购单以后挂上的除外：补单只回填采购单号，不改别的）；导入的一定是库管入库
ALTER TABLE inv_docs ADD CONSTRAINT inv_docs_direct_receipt CHECK (NOT direct OR (doc_type = 'receipt' AND NOT urgent AND no_po));
ALTER TABLE inv_docs ADD CONSTRAINT inv_docs_import_direct CHECK (import_id IS NULL OR direct);
CREATE INDEX inv_docs_import_idx ON inv_docs (import_id) WHERE import_id IS NOT NULL;

-- 操作编号与「确认作废」：台账导入（receipt_import），在当时的约束上追加（写法见 162）
DO $$
DECLARE t text; expression text;
BEGIN
 FOREACH t IN ARRAY ARRAY['idempotency_keys','op_fences'] LOOP
  SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint WHERE conrelid=t::regclass AND conname=t||'_op_type_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',t,t||'_op_type_check');
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ((%s) OR op_type IN (''receipt_import''))',t,t||'_op_type_check',expression);
 END LOOP;
END $$;
