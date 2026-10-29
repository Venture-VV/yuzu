-- 浴族 yuzu · 库存与采购第二段：采购单版本与补单、价格口径、采购单保护
-- 增量迁移：只新增列、索引与触发器，不改动已有数据。

-- 价格口径随单据留存（例如「含税到货价」）：比价只比较同一口径
ALTER TABLE purchase_orders ADD COLUMN price_basis text NOT NULL DEFAULT '';
ALTER TABLE inv_docs ADD COLUMN price_basis text NOT NULL DEFAULT '';

-- 先收货后补单：补单采购单指向原收货单；确认后只关联，不再入库或形成应付
ALTER TABLE purchase_orders ADD COLUMN backfill_receipt_id bigint REFERENCES inv_docs (id);
CREATE UNIQUE INDEX purchase_orders_backfill_once ON purchase_orders (backfill_receipt_id)
  WHERE backfill_receipt_id IS NOT NULL AND status <> 'cancelled';

-- 采购单禁止删除；已确认 / 已关闭 / 已撤回的采购单明细不可直接修改（修改须走「改版」，先回到待确认）
CREATE FUNCTION yuzu_po_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '采购单禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status IN ('closed', 'cancelled') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION '已关闭或已撤回的采购单不能再变更状态' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'approved'
     AND (NEW.supplier_id, NEW.total_cents, NEW.revision, NEW.doc_no)
         IS DISTINCT FROM (OLD.supplier_id, OLD.total_cents, OLD.revision, OLD.doc_no)
     AND NEW.status = 'approved' THEN
    RAISE EXCEPTION '已确认的采购单不能直接修改，请走改版流程' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER purchase_orders_guard BEFORE UPDATE OR DELETE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION yuzu_po_guard();

CREATE FUNCTION yuzu_po_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  po_status text;
BEGIN
  SELECT status INTO po_status FROM purchase_orders WHERE id = COALESCE(NEW.po_id, OLD.po_id);
  IF po_status IN ('approved', 'closed', 'cancelled') THEN
    RAISE EXCEPTION '采购单当前状态不能修改明细' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER purchase_order_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON purchase_order_lines
  FOR EACH ROW EXECUTE FUNCTION yuzu_po_line_guard();

-- 同一笔付款不能重复核销同一张收货单 / 期初未付
CREATE UNIQUE INDEX payment_allocations_receipt_once ON payment_allocations (payment_id, receipt_doc_id) WHERE receipt_doc_id IS NOT NULL;
CREATE UNIQUE INDEX payment_allocations_opening_once ON payment_allocations (payment_id, opening_payable_id) WHERE opening_payable_id IS NOT NULL;
CREATE INDEX ap_entries_inv_doc_idx ON ap_entries (inv_doc_id);
CREATE INDEX ap_entries_payment_idx ON ap_entries (payment_id);
