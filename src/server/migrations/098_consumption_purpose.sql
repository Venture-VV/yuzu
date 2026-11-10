-- 8.0.7 供应链收尾 2.3（docs/ERP_V807.md）：部门耗用记用途与经办人。
--   · 耗用单（direct_use）加「用途」（从「经营规则 → 可调的数值」里的列表选，V6）与「经办人」（选员工，默认是自己）；
--     原来的「耗用用途」文字改叫「说明」（照旧必填，照旧存在 note）。
--   · 之前的耗用单这两列为空（页面显示「（v8.0.7 以前没记）」）；自动生成的耗用（台面日耗品）也为空。
--   · 生效、冲销以后不能改：单据守卫（与 082 相同）多守这两列。

ALTER TABLE inv_docs ADD COLUMN use_purpose text CHECK (char_length(use_purpose) BETWEEN 1 AND 12);
ALTER TABLE inv_docs ADD COLUMN use_handler_id bigint REFERENCES staff (id);
ALTER TABLE inv_docs ADD CONSTRAINT inv_docs_use_fields
  CHECK ((use_purpose IS NULL AND use_handler_id IS NULL) OR doc_type = 'direct_use');
CREATE INDEX inv_docs_use_purpose_idx ON inv_docs (use_purpose) WHERE doc_type = 'direct_use';

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
        NEW.supplier_answer_by, NEW.supplier_answer_at, NEW.supplier_answer_date, NEW.supplier_answer_note,
        NEW.use_purpose, NEW.use_handler_id)
       IS DISTINCT FROM
       (OLD.doc_no, OLD.doc_type, OLD.doc_date, OLD.supplier_id, OLD.department_id, OLD.source_doc_id,
        OLD.amount_cents, OLD.created_by, OLD.created_at, OLD.confirmed_by, OLD.confirmed_at, OLD.settlement,
        OLD.warehouse_id, OLD.urgent, OLD.urgent_cap_cents, OLD.urgent_approved_at, OLD.co_acceptor_id, OLD.return_applied_cents,
        OLD.supplier_answer_by, OLD.supplier_answer_at, OLD.supplier_answer_date, OLD.supplier_answer_note,
        OLD.use_purpose, OLD.use_handler_id) THEN
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
