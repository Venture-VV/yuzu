-- 8.0.20 布草洗涤（docs/ERP_V8020.md 第 4 节，JX-E / JX6 / JX11）：布草品类、送洗 / 收回 / 新增 / 报废四种单据。
--
--   · linen_items：品类（浴巾、浴衣、床单……）、总数 total_qty、在洗 at_laundry_qty（在店 = 总数 − 在洗）、每件洗涤费。
--   · linen_docs / linen_doc_lines：单据只增不改，作废留原因；每张单带操作编号（client_key），原样重提只记一次。
--       新增 add：总数 + 数量；送洗 send：在洗 + 数量；报废 scrap：总数 − 数量；
--       收回 return：在洗 −（完好 + 破损 + 丢失），总数 −（破损 + 丢失）；洗涤费 =（完好 + 破损）× 每件洗涤费（丢失的不算）。
-- 洗涤费这一版只出按洗涤厂、按月的对账表，不自动记进应付货款（JX11）。

CREATE TABLE linen_items (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name             text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 24),
  total_qty        integer NOT NULL DEFAULT 0 CHECK (total_qty >= 0),
  at_laundry_qty   integer NOT NULL DEFAULT 0 CHECK (at_laundry_qty >= 0),
  wash_price_cents integer NOT NULL DEFAULT 0 CHECK (wash_price_cents BETWEEN 0 AND 1000000),
  active           boolean NOT NULL DEFAULT true,
  version          integer NOT NULL DEFAULT 1,
  created_by       bigint NOT NULL REFERENCES staff (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (at_laundry_qty <= total_qty)
);
CREATE UNIQUE INDEX linen_items_name_uq ON linen_items (name) WHERE active;

CREATE TABLE linen_docs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doc_no       text NOT NULL UNIQUE,
  kind         text NOT NULL CHECK (kind IN ('add', 'send', 'return', 'scrap')),
  -- 洗涤厂（供应商档案）：送洗、收回必填
  supplier_id  bigint REFERENCES suppliers (id),
  doc_date     date NOT NULL,
  note         text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  amount_cents bigint NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  status       text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'voided')),
  client_key   uuid NOT NULL UNIQUE,
  -- 原请求的摘要：同一个操作编号、内容不同的拒绝
  request_hash text NOT NULL,
  created_by   bigint NOT NULL REFERENCES staff (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  voided_by    bigint REFERENCES staff (id),
  voided_at    timestamptz,
  void_reason  text,
  CHECK ((kind IN ('send', 'return')) = (supplier_id IS NOT NULL)),
  CHECK ((status = 'voided') = (voided_at IS NOT NULL) AND (voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX linen_docs_date_idx ON linen_docs (doc_date DESC, id DESC);
CREATE INDEX linen_docs_supplier_idx ON linen_docs (supplier_id, doc_date) WHERE supplier_id IS NOT NULL;

CREATE TABLE linen_doc_lines (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doc_id       bigint NOT NULL REFERENCES linen_docs (id),
  item_id      bigint NOT NULL REFERENCES linen_items (id),
  -- 新增、送洗、报废：数量；收回：完好收回的件数
  qty          integer NOT NULL CHECK (qty >= 0),
  damaged_qty  integer NOT NULL DEFAULT 0 CHECK (damaged_qty >= 0),
  lost_qty     integer NOT NULL DEFAULT 0 CHECK (lost_qty >= 0),
  price_cents  integer NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  amount_cents bigint NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  UNIQUE (doc_id, item_id),
  CHECK (qty + damaged_qty + lost_qty > 0)
);

-- 单据生效后内容不改：只允许「已生效 → 已作废」；明细不改不删
CREATE FUNCTION yuzu_linen_doc_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '布草单据不能删除' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'voided' THEN
    RAISE EXCEPTION '已作废的布草单据不能再改' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.doc_no, NEW.kind, NEW.supplier_id, NEW.doc_date, NEW.note, NEW.amount_cents, NEW.client_key, NEW.request_hash, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.doc_no, OLD.kind, OLD.supplier_id, OLD.doc_date, OLD.note, OLD.amount_cents, OLD.client_key, OLD.request_hash, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION '布草单据的内容不能修改' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER linen_docs_guard BEFORE UPDATE OR DELETE ON linen_docs FOR EACH ROW EXECUTE FUNCTION yuzu_linen_doc_guard();

CREATE FUNCTION yuzu_linen_line_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '布草单据的明细不能修改、删除' USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER linen_doc_lines_guard BEFORE UPDATE OR DELETE ON linen_doc_lines FOR EACH ROW EXECUTE FUNCTION yuzu_linen_line_guard();
