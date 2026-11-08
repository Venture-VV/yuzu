-- 8.0.1 采购组整改 09（CG09，docs/PURCHASING_V801.md）：赠品入库台账——记赠品名称、数量（与单位）、哪家供应商、随哪张收货单。
-- 只记台账，不进库存结存、不记成本（要不要进库存以后再定，CG09）。登记以后只能作废（写原因，一次），不能改、不能删。

CREATE TABLE gift_receipts (
  id             bigserial PRIMARY KEY,
  doc_no         text NOT NULL UNIQUE,
  received_on    date NOT NULL,
  -- 赠品名称可以从物料里选（选了记物料），也可以直接写
  material_id    bigint REFERENCES materials (id),
  name           text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  qty_milli      bigint NOT NULL CHECK (qty_milli > 0 AND qty_milli <= 1000000000),
  unit           text NOT NULL CHECK (char_length(btrim(unit)) BETWEEN 1 AND 8),
  supplier_id    bigint REFERENCES suppliers (id),
  receipt_doc_id bigint REFERENCES inv_docs (id),
  note           text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  status         text NOT NULL DEFAULT 'valid' CHECK (status IN ('valid', 'voided')),
  created_by     bigint NOT NULL REFERENCES staff (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  void_reason    text CHECK (void_reason IS NULL OR char_length(btrim(void_reason)) BETWEEN 2 AND 200),
  voided_by      bigint REFERENCES staff (id),
  voided_at      timestamptz,
  CHECK ((status = 'voided') = (voided_at IS NOT NULL)),
  CHECK ((voided_at IS NULL) = (voided_by IS NULL)),
  CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX gift_receipts_date_idx ON gift_receipts (received_on);
CREATE INDEX gift_receipts_supplier_idx ON gift_receipts (supplier_id) WHERE supplier_id IS NOT NULL;

CREATE FUNCTION yuzu_gift_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '赠品登记禁止删除（作废保留记录）' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'voided'
     OR (NEW.doc_no, NEW.received_on, NEW.material_id, NEW.name, NEW.qty_milli, NEW.unit, NEW.supplier_id, NEW.receipt_doc_id, NEW.note,
         NEW.created_by, NEW.created_at)
        IS DISTINCT FROM
        (OLD.doc_no, OLD.received_on, OLD.material_id, OLD.name, OLD.qty_milli, OLD.unit, OLD.supplier_id, OLD.receipt_doc_id, OLD.note,
         OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION '赠品登记只能作废一次，别的不能改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER gift_receipts_guard BEFORE UPDATE OR DELETE ON gift_receipts
  FOR EACH ROW EXECUTE FUNCTION yuzu_gift_receipt_guard();
