-- 8.0.1 采购组整改（docs/PURCHASING_V801.md）第一部分：
--   · 需求单的采购优先级（02，CG02）、提交时间与最早可以通过的日期（03 每日截单，CG03）、来源（填单 / 集采导入，06）；
--   · 需求行的申请人、采购途径与供应商（集采导入带进来，转采购单时按供应商分组）；集采导入记录（同一份文件只能导入一次）；
--   · 急采按金额分级审批（05，CG05）：急采的审批时间；审批中心的单据类型加「急采」；
--   · 「确认作废」的「集采导入」在 093 加（092 重建过这条约束，新装的库按顺序执行时 082 在 092 前面，加在这里会被覆盖）。
-- 只加列、加表、放宽约束。旧数据：需求单当作普通、截单前提交（没有最早可通过日期，随时能审）；
-- 升级前已经提交（待验收）、生效或冲销的急采当作已经审批过，照旧由仓库验收。

-- ───────────── 需求单 ─────────────
ALTER TABLE purchase_requests
  ADD COLUMN priority      text NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent', 'normal')),
  ADD COLUMN submitted_at  timestamptz,
  ADD COLUMN approvable_on date,
  ADD COLUMN source        text NOT NULL DEFAULT 'form' CHECK (source IN ('form', 'import')),
  ADD COLUMN import_id     bigint;
UPDATE purchase_requests SET submitted_at = created_at;
ALTER TABLE purchase_requests
  ALTER COLUMN submitted_at SET NOT NULL,
  ALTER COLUMN submitted_at SET DEFAULT now();

ALTER TABLE purchase_request_lines
  ADD COLUMN applicant   text NOT NULL DEFAULT '' CHECK (char_length(applicant) <= 20),
  ADD COLUMN channel     text CHECK (channel IS NULL OR channel IN ('online', 'self', 'supplier')),
  ADD COLUMN supplier_id bigint REFERENCES suppliers (id);

-- 集采导入（06）：一次导入一条；同一份文件（按内容摘要）只能导入一次
CREATE TABLE purchase_request_imports (
  id            bigserial PRIMARY KEY,
  client_key    uuid NOT NULL UNIQUE,
  file_sha256   text NOT NULL UNIQUE CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_name     text NOT NULL DEFAULT '' CHECK (char_length(file_name) <= 120),
  row_count     integer NOT NULL CHECK (row_count > 0),
  request_count integer NOT NULL CHECK (request_count > 0),
  created_by    bigint NOT NULL REFERENCES staff (id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE purchase_requests
  ADD CONSTRAINT purchase_requests_import_fk FOREIGN KEY (import_id) REFERENCES purchase_request_imports (id),
  ADD CONSTRAINT purchase_requests_source_import CHECK ((source = 'import') = (import_id IS NOT NULL));
CREATE INDEX purchase_requests_import_idx ON purchase_requests (import_id) WHERE import_id IS NOT NULL;

-- ───────────── 急采：按金额分级审批（审批中心），批了以后仓库到部门验收 ─────────────
ALTER TABLE inv_docs ADD COLUMN urgent_approved_at timestamptz;
ALTER TABLE inv_docs ADD CONSTRAINT inv_docs_urgent_approved CHECK (urgent_approved_at IS NULL OR urgent);
UPDATE inv_docs SET urgent_approved_at = coalesce(submitted_at, updated_at, created_at)
WHERE urgent AND status IN ('submitted', 'confirmed', 'voided');

-- 生效、冲销以后急采的审批时间也不能改（与 030 的守护相同，只多了 urgent_approved_at；放在上面补数据之后）
CREATE OR REPLACE FUNCTION yuzu_inv_doc_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '库存单据禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'awaiting_supplier' THEN
    IF (NEW.doc_no, NEW.doc_type, NEW.doc_date, NEW.supplier_id, NEW.department_id, NEW.source_doc_id, NEW.amount_cents,
        NEW.created_by, NEW.created_at, NEW.warehouse_id, NEW.note, NEW.purchase_order_id)
       IS DISTINCT FROM
       (OLD.doc_no, OLD.doc_type, OLD.doc_date, OLD.supplier_id, OLD.department_id, OLD.source_doc_id, OLD.amount_cents,
        OLD.created_by, OLD.created_at, OLD.warehouse_id, OLD.note, OLD.purchase_order_id) THEN
      RAISE EXCEPTION '等供应商确认的退货单内容不可修改' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.status NOT IN ('awaiting_supplier', 'confirmed', 'cancelled') THEN
      RAISE EXCEPTION '等供应商确认的退货单只能生效或撤回' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF OLD.status IN ('confirmed', 'voided') THEN
    IF (NEW.doc_no, NEW.doc_type, NEW.doc_date, NEW.supplier_id, NEW.department_id, NEW.source_doc_id,
        NEW.amount_cents, NEW.created_by, NEW.created_at, NEW.confirmed_by, NEW.confirmed_at, NEW.settlement,
        NEW.warehouse_id, NEW.urgent, NEW.urgent_cap_cents, NEW.urgent_approved_at, NEW.co_acceptor_id, NEW.return_applied_cents,
        NEW.supplier_answer_by, NEW.supplier_answer_at, NEW.supplier_answer_date, NEW.supplier_answer_note)
       IS DISTINCT FROM
       (OLD.doc_no, OLD.doc_type, OLD.doc_date, OLD.supplier_id, OLD.department_id, OLD.source_doc_id,
        OLD.amount_cents, OLD.created_by, OLD.created_at, OLD.confirmed_by, OLD.confirmed_at, OLD.settlement,
        OLD.warehouse_id, OLD.urgent, OLD.urgent_cap_cents, OLD.urgent_approved_at, OLD.co_acceptor_id, OLD.return_applied_cents,
        OLD.supplier_answer_by, OLD.supplier_answer_at, OLD.supplier_answer_date, OLD.supplier_answer_note) THEN
      RAISE EXCEPTION '已生效的库存单据不可修改' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.status <> OLD.status AND NOT (OLD.status = 'confirmed' AND NEW.status = 'voided') THEN
      RAISE EXCEPTION '已生效的库存单据只能冲销' USING ERRCODE = 'P0001';
    END IF;
    -- 补单：直接收货 / 急采后关联到新建的采购单（只能从空变为有）
    IF NEW.purchase_order_id IS DISTINCT FROM OLD.purchase_order_id AND OLD.purchase_order_id IS NOT NULL THEN
      RAISE EXCEPTION '收货单已关联采购单，不能更改' USING ERRCODE = 'P0001';
    END IF;
    -- 部门签收：只能签一次
    IF OLD.dept_signed_at IS NOT NULL
       AND (NEW.dept_signed_by, NEW.dept_signed_at, NEW.dept_sign_note) IS DISTINCT FROM (OLD.dept_signed_by, OLD.dept_signed_at, OLD.dept_sign_note) THEN
      RAISE EXCEPTION '领料单已签收，不能再改' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE approval_rules DROP CONSTRAINT approval_rules_doc_type_check;
ALTER TABLE approval_rules ADD CONSTRAINT approval_rules_doc_type_check
  CHECK (doc_type IN ('purchase_order', 'damage', 'supplier_return', 'opening', 'payment', 'expense_claim', 'stocktake',
                      'contract', 'contract_change', 'contract_seal', 'payment_request', 'payment_early', 'urgent_purchase'));
ALTER TABLE approval_requests DROP CONSTRAINT approval_requests_doc_type_check;
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_doc_type_check
  CHECK (doc_type IN ('purchase_order', 'damage', 'supplier_return', 'opening', 'payment', 'expense_claim', 'stocktake',
                      'contract', 'contract_change', 'contract_seal', 'payment_request', 'payment_early', 'urgent_purchase'));
