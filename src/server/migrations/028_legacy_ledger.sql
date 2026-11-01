-- 8–10 月旧账只读对照（v0.7.10，飞书需求 RQ-005 收尾，见 docs/LEGACY_LEDGER.md）
--
-- 四份原始 Excel（采购台账、采购物资明细表、已下单物料、品牌新增寻款采购清单）按原样导入只读表：
-- 不进正式账，任何正式的报表、台账、平账、账目自检、check 都不读这些表。
-- 每一行保留原表的行号与原始单元格；除导入记录的作废三列外都不能改、不能删。

CREATE TABLE legacy_imports (
  id           bigserial PRIMARY KEY,
  source       text NOT NULL CHECK (source IN ('purchase_ledger', 'material_detail', 'ordered_materials', 'brand_requests')),
  file_name    text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 200),
  -- 文件内容摘要：同一份文件重复导入返回原来那次
  sha256       text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  file_bytes   integer NOT NULL CHECK (file_bytes > 0),
  -- 每张表：名称、表格里写出来的行数（含空行）、表头所在行、导入的行数
  sheets       jsonb NOT NULL,
  -- 表里自带的合计行（付款台账的「合计」）：列名 → 分
  file_totals  jsonb NOT NULL DEFAULT '{}',
  warnings     jsonb NOT NULL DEFAULT '[]',
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided')),
  imported_by  bigint NOT NULL REFERENCES staff (id),
  imported_at  timestamptz NOT NULL DEFAULT now(),
  voided_by    bigint REFERENCES staff (id),
  voided_at    timestamptz,
  void_reason  text CHECK (void_reason IS NULL OR char_length(void_reason) BETWEEN 2 AND 200),
  CHECK ((status = 'voided') = (voided_by IS NOT NULL AND voided_at IS NOT NULL AND void_reason IS NOT NULL))
);
-- 每一份表同时只有一次有效导入
CREATE UNIQUE INDEX legacy_imports_one_active ON legacy_imports (source) WHERE status = 'active';

-- 导入记录：只能把有效的作废一次（留原因与经办人），其余不能改、不能删
CREATE FUNCTION yuzu_legacy_import_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '旧账导入记录禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'active' OR NEW.status <> 'voided'
     OR (to_jsonb(NEW) - ARRAY['status', 'voided_by', 'voided_at', 'void_reason']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'voided_by', 'voided_at', 'void_reason']) THEN
    RAISE EXCEPTION '旧账导入记录只能作废一次，其余不能改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER legacy_imports_guard BEFORE UPDATE OR DELETE ON legacy_imports
  FOR EACH ROW EXECUTE FUNCTION yuzu_legacy_import_guard();

-- 采购台账第 1 张「费用报销明细表」
CREATE TABLE legacy_ledger_lines (
  import_id      bigint NOT NULL REFERENCES legacy_imports (id),
  row_no         integer NOT NULL CHECK (row_no > 0),
  seq            text NOT NULL DEFAULT '',
  entry_date     date,
  date_text      text NOT NULL DEFAULT '',
  item           text NOT NULL DEFAULT '',
  qty_text       text NOT NULL DEFAULT '',
  amount_cents   bigint,
  amount_formula text,
  merchant       text NOT NULL DEFAULT '',
  purpose        text NOT NULL DEFAULT '',
  invoice        text NOT NULL DEFAULT '',
  note           text NOT NULL DEFAULT '',
  -- 金额格与上面第几行合并（金额算在那一行）
  merged_into    integer,
  -- 表头下面、序号 1 之前的行：单列，不计入合计
  pre_header     boolean NOT NULL DEFAULT false,
  raw            jsonb NOT NULL,
  PRIMARY KEY (import_id, row_no)
);

-- 采购台账第 2 张「付款台账」
CREATE TABLE legacy_payment_days (
  import_id             bigint NOT NULL REFERENCES legacy_imports (id),
  row_no                integer NOT NULL CHECK (row_no > 0),
  pay_date              date,
  date_text             text NOT NULL DEFAULT '',
  advance_cents         bigint,
  advance_formula       text,
  should_return_cents   bigint,
  should_return_formula text,
  returned_cents        bigint,
  returned_formula      text,
  note                  text NOT NULL DEFAULT '',
  raw                   jsonb NOT NULL,
  PRIMARY KEY (import_id, row_no)
);

-- 采购物资明细表（每月一张表）
CREATE TABLE legacy_material_lines (
  import_id      bigint NOT NULL REFERENCES legacy_imports (id),
  sheet          text NOT NULL,
  row_no         integer NOT NULL CHECK (row_no > 0),
  seq            text NOT NULL DEFAULT '',
  buy_date       date,
  date_text      text NOT NULL DEFAULT '',
  item           text NOT NULL DEFAULT '',
  purpose        text NOT NULL DEFAULT '',
  amount_cents   bigint,
  amount_formula text,
  bought_text    text NOT NULL DEFAULT '',
  bought_milli   bigint,
  received_text  text NOT NULL DEFAULT '',
  received_milli bigint,
  department     text NOT NULL DEFAULT '',
  invoice        text NOT NULL DEFAULT '',
  tax_text       text NOT NULL DEFAULT '',
  tax_rate_bp    integer,
  category       text NOT NULL DEFAULT '',
  merged_into    integer,
  raw            jsonb NOT NULL,
  PRIMARY KEY (import_id, sheet, row_no)
);

-- 已下单物料的 WPS 单元格图（原图，随备份走）
CREATE TABLE legacy_images (
  id         bigserial PRIMARY KEY,
  import_id  bigint NOT NULL REFERENCES legacy_imports (id),
  image_key  text NOT NULL,
  mime       text NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
  data       bytea NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 5242880),
  CHECK (octet_length(data) = size_bytes),
  UNIQUE (import_id, image_key)
);

-- 已下单物料
CREATE TABLE legacy_ordered_lines (
  import_id      bigint NOT NULL REFERENCES legacy_imports (id),
  sheet          text NOT NULL,
  row_no         integer NOT NULL CHECK (row_no > 0),
  order_date     date,
  date_text      text NOT NULL DEFAULT '',
  product        text NOT NULL DEFAULT '',
  image_id       bigint REFERENCES legacy_images (id),
  image_shared   boolean NOT NULL DEFAULT false,
  variant        text NOT NULL DEFAULT '',
  department     text NOT NULL DEFAULT '',
  orderer        text NOT NULL DEFAULT '',
  qty_text       text NOT NULL DEFAULT '',
  qty_milli      bigint,
  amount_cents   bigint,
  amount_formula text,
  note           text NOT NULL DEFAULT '',
  merged_into    integer,
  raw            jsonb NOT NULL,
  PRIMARY KEY (import_id, sheet, row_no)
);

-- 品牌新增寻款采购清单
CREATE TABLE legacy_brand_requests (
  import_id bigint NOT NULL REFERENCES legacy_imports (id),
  row_no    integer NOT NULL CHECK (row_no > 0),
  seq       text NOT NULL DEFAULT '',
  ordered   boolean NOT NULL DEFAULT false,
  received  boolean NOT NULL DEFAULT false,
  returned  boolean NOT NULL DEFAULT false,
  product   text NOT NULL DEFAULT '',
  purpose   text NOT NULL DEFAULT '',
  qty_text  text NOT NULL DEFAULT '',
  qty_milli bigint,
  note      text NOT NULL DEFAULT '',
  details   text NOT NULL DEFAULT '',
  link_text text NOT NULL DEFAULT '',
  link_url  text NOT NULL DEFAULT '',
  raw       jsonb NOT NULL,
  PRIMARY KEY (import_id, row_no)
);

CREATE TRIGGER legacy_ledger_lines_append_only BEFORE UPDATE OR DELETE ON legacy_ledger_lines FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
CREATE TRIGGER legacy_payment_days_append_only BEFORE UPDATE OR DELETE ON legacy_payment_days FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
CREATE TRIGGER legacy_material_lines_append_only BEFORE UPDATE OR DELETE ON legacy_material_lines FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
CREATE TRIGGER legacy_images_append_only BEFORE UPDATE OR DELETE ON legacy_images FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
CREATE TRIGGER legacy_ordered_lines_append_only BEFORE UPDATE OR DELETE ON legacy_ordered_lines FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
CREATE TRIGGER legacy_brand_requests_append_only BEFORE UPDATE OR DELETE ON legacy_brand_requests FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
