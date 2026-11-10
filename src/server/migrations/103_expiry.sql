-- 8.0.7 ERP P2 3.3（docs/ERP_V807.md）：批次与效期。
--   · 物料加「效期管理」开关与保质期天数（可空）。管效期的物料收货时要填到期日（填了生产日期和保质期的页面上自动算，V16），
--     批号选填。
--   · 剩余按先进先出推算：总仓的结存按最近的收货批次往回分（最近收的最后用），剩下的是最新的几批；部门小仓不分批（V17）。
--   · 到期前 N 天（V18，默认 30）的批次与已过期的进 ERP 待办；库存页「呆滞与临期」列出、能导出。
--   · 收货行加批号、生产日期、到期日：单据生效以后不能改，单据行守卫（与 030 相同）多守这三列。

ALTER TABLE materials ADD COLUMN expiry_tracked boolean NOT NULL DEFAULT false;
ALTER TABLE materials ADD COLUMN shelf_life_days integer CHECK (shelf_life_days IS NULL OR shelf_life_days BETWEEN 1 AND 3650);

ALTER TABLE inv_doc_lines ADD COLUMN batch_no text CHECK (batch_no IS NULL OR char_length(btrim(batch_no)) BETWEEN 1 AND 40);
ALTER TABLE inv_doc_lines ADD COLUMN produced_on date;
ALTER TABLE inv_doc_lines ADD COLUMN expires_on date;
ALTER TABLE inv_doc_lines ADD CONSTRAINT inv_doc_lines_expiry_order CHECK (produced_on IS NULL OR expires_on IS NULL OR produced_on <= expires_on);
CREATE INDEX inv_doc_lines_expires_idx ON inv_doc_lines (material_id, expires_on) WHERE expires_on IS NOT NULL;

CREATE OR REPLACE FUNCTION yuzu_inv_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  doc_status text;
BEGIN
  SELECT status INTO doc_status FROM inv_docs WHERE id = OLD.doc_id;
  IF doc_status IN ('awaiting_supplier', 'confirmed', 'voided') THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION '已生效单据的明细不可删除' USING ERRCODE = 'P0001';
    END IF;
    IF (NEW.doc_id, NEW.material_id, NEW.qty_milli, NEW.factor_milli, NEW.price_cents, NEW.amount_cents,
        NEW.delivered_milli, NEW.rejected_milli, NEW.counted_milli, NEW.book_milli, NEW.source_line_id,
        NEW.batch_no, NEW.produced_on, NEW.expires_on)
       IS DISTINCT FROM
       (OLD.doc_id, OLD.material_id, OLD.qty_milli, OLD.factor_milli, OLD.price_cents, OLD.amount_cents,
        OLD.delivered_milli, OLD.rejected_milli, OLD.counted_milli, OLD.book_milli, OLD.source_line_id,
        OLD.batch_no, OLD.produced_on, OLD.expires_on)
       OR (OLD.po_line_id IS NOT NULL AND NEW.po_line_id IS DISTINCT FROM OLD.po_line_id) THEN
      RAISE EXCEPTION '已生效单据的明细不可修改' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;
