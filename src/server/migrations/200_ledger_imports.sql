-- 8.1.20 出入库台账（docs/ERP_V8120.md，PENDING_DECISIONS「8.1.20」LD1–LD10）：
-- 「库管入库」页右上角的「导入出入库台账 / 导出台账 / 下载模板」，模板换成门店的《仓库出入库记录》格式（一种物料一行，按月记入库、出库）。
-- 物料档案加「库位」；导入记录一份文件（按内容摘要）只能导入一次；生成的库管入库与部门领料都挂着这次导入；
-- 操作编号与「确认作废」加业务类型 ledger_import（在当时的约束上追加，写法见 162）。

ALTER TABLE materials ADD COLUMN location text NOT NULL DEFAULT '' CHECK (char_length(location) <= 20);

CREATE TABLE ledger_imports (
  id           bigserial PRIMARY KEY,
  client_key   uuid NOT NULL UNIQUE,
  file_sha256  text NOT NULL UNIQUE CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_name    text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 120),
  row_count    integer NOT NULL CHECK (row_count > 0),
  receipt_count integer NOT NULL CHECK (receipt_count >= 0),
  issue_count  integer NOT NULL CHECK (issue_count >= 0),
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  created_by   bigint NOT NULL REFERENCES staff (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (receipt_count + issue_count > 0)
);
CREATE TRIGGER ledger_imports_immutable BEFORE UPDATE OR DELETE ON ledger_imports FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

ALTER TABLE inv_docs ADD COLUMN ledger_import_id bigint REFERENCES ledger_imports (id);
-- 台账导入只生成库管入库（收货单、direct）与部门领料
ALTER TABLE inv_docs ADD CONSTRAINT inv_docs_ledger_import_kind CHECK (ledger_import_id IS NULL OR (doc_type = 'receipt' AND direct) OR doc_type = 'issue');
CREATE INDEX inv_docs_ledger_import_idx ON inv_docs (ledger_import_id) WHERE ledger_import_id IS NOT NULL;

DO $$
DECLARE t text; expression text;
BEGIN
 FOREACH t IN ARRAY ARRAY['idempotency_keys','op_fences'] LOOP
  SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint WHERE conrelid=t::regclass AND conname=t||'_op_type_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',t,t||'_op_type_check');
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ((%s) OR op_type IN (''ledger_import''))',t,t||'_op_type_check',expression);
 END LOOP;
END $$;
