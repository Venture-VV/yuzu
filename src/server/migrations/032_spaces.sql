-- v0.7.14 · 飞书需求 RQ-004 第一段（docs/SPACES.md）：空间台账——楼层、区域、空间（编码图的编码做主键）、别名与导入记录；
-- 客房的房间挂接空间（RQ-003 剩余项）。另：对账登记的撤销带操作编号（v0.7.13 审查的修正）。只加表、加列、放宽约束。

-- ───────────── 导入记录（同一个文件只能写入一次） ─────────────
CREATE TABLE space_imports (
  id            bigserial PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('spaces', 'zones')),
  file_name     text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 200),
  file_sha256   text NOT NULL UNIQUE CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  row_count     integer NOT NULL CHECK (row_count >= 0),
  created_count integer NOT NULL CHECK (created_count >= 0),
  skipped_count integer NOT NULL CHECK (skipped_count >= 0),
  created_by    bigint NOT NULL REFERENCES staff (id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER space_imports_append_only BEFORE UPDATE OR DELETE ON space_imports
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- ───────────── 楼层 ─────────────
CREATE TABLE floors (
  id         bigserial PRIMARY KEY,
  code       text NOT NULL CHECK (code ~ '^[A-Z][0-9A-Z]{0,3}$'),
  name       text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 16),
  sort_order integer NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true,
  -- 版本号：每次修改加 1；页面提交读到的版本号，对不上就拒绝（迟到的旧请求、别人同时修改都不会悄悄覆盖新的修改）
  version    integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX floors_code_uq ON floors (code);
CREATE TRIGGER floors_no_delete BEFORE DELETE ON floors FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_delete();
-- 系统基线：会所 1 至 3 层（D1）
INSERT INTO floors (code, name, sort_order) VALUES ('L1', '一层', 1), ('L2', '二层', 2), ('L3', '三层', 3);

-- ───────────── 区域 ─────────────
CREATE TABLE zones (
  id         bigserial PRIMARY KEY,
  floor_id   bigint NOT NULL REFERENCES floors (id),
  name       text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 24),
  name_en    text NOT NULL DEFAULT '' CHECK (char_length(name_en) <= 48),
  note       text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  sort_order integer NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true,
  import_id  bigint REFERENCES space_imports (id),
  version    integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX zones_floor_name_uq ON zones (floor_id, lower(btrim(name)));
CREATE TRIGGER zones_no_delete BEFORE DELETE ON zones FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_delete();

-- ───────────── 空间（房间）：编码图的编码做主键（D6 方案 A），缺号不补 ─────────────
-- 编码最多 8 位（与客房房号的长度一致：客房挂接后房号就是编码）
CREATE TABLE spaces (
  id            bigserial PRIMARY KEY,
  code          text NOT NULL CHECK (code ~ '^[A-Z][0-9A-Z]{1,7}$'),
  floor_id      bigint NOT NULL REFERENCES floors (id),
  zone_id       bigint REFERENCES zones (id),
  business_type text NOT NULL CHECK (char_length(btrim(business_type)) BETWEEN 1 AND 8),
  capacity      integer CHECK (capacity BETWEEN 1 AND 999),
  -- 面积 × 100（㎡，两位小数）
  area_centi_m2 integer CHECK (area_centi_m2 BETWEEN 1 AND 100000000),
  display_name  text NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 24),
  name_en       text NOT NULL DEFAULT '' CHECK (char_length(name_en) <= 48),
  sellable      boolean NOT NULL DEFAULT true,
  -- 核对状态：已核对 / 推断（图上没直接写，按就近标签或品牌图推断）/ 待现场核对
  verify_status text NOT NULL DEFAULT 'confirmed' CHECK (verify_status IN ('confirmed', 'inferred', 'site_check')),
  verified_by   bigint REFERENCES staff (id),
  verified_at   timestamptz,
  verify_note   text CHECK (char_length(verify_note) <= 200),
  -- 编码图原始标注（如「足浴 C301 2人间」）
  source_label  text NOT NULL DEFAULT '' CHECK (char_length(source_label) <= 60),
  note          text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  active        boolean NOT NULL DEFAULT true,
  import_id     bigint REFERENCES space_imports (id),
  -- 版本号：编辑、核对、设区域各加 1（别名、客房挂接不改这一行）
  version       integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by    bigint REFERENCES staff (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX spaces_code_uq ON spaces (code);
CREATE INDEX spaces_floor_idx ON spaces (floor_id, code);
CREATE INDEX spaces_zone_idx ON spaces (zone_id);

-- 编码建好后不能改（写错了停用、再新建）；不能删除；区域要在同一层
CREATE FUNCTION yuzu_space_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  zone_floor bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '空间不能删除，不用了请停用' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION '空间编码建好后不能改' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.zone_id IS NOT NULL THEN
    SELECT floor_id INTO zone_floor FROM zones WHERE id = NEW.zone_id;
    IF zone_floor IS DISTINCT FROM NEW.floor_id THEN
      RAISE EXCEPTION '空间的区域要在同一层' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER spaces_guard BEFORE INSERT OR UPDATE OR DELETE ON spaces
  FOR EACH ROW EXECUTE FUNCTION yuzu_space_guard();

-- ───────────── 别名：品牌名、编码图原始标注、旧名；只追加，停用一次 ─────────────
CREATE TABLE space_aliases (
  id         bigserial PRIMARY KEY,
  space_id   bigint NOT NULL REFERENCES spaces (id),
  alias      text NOT NULL CHECK (char_length(btrim(alias)) BETWEEN 1 AND 60),
  kind       text NOT NULL CHECK (kind IN ('brand', 'source', 'legacy', 'other')),
  active     boolean NOT NULL DEFAULT true,
  created_by bigint REFERENCES staff (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_by bigint REFERENCES staff (id),
  retired_at timestamptz,
  CHECK (active = (retired_at IS NULL))
);
-- 同一个空间不会有两条一样的在用别名；别名在不同空间之间可以重复（品牌图上 4 间「客房 C5」）
CREATE UNIQUE INDEX space_aliases_active_uq ON space_aliases (space_id, lower(btrim(alias))) WHERE active;
CREATE INDEX space_aliases_alias_idx ON space_aliases (lower(btrim(alias)));
CREATE FUNCTION yuzu_space_alias_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '别名不能删除，不用了请停用' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.space_id, NEW.alias, NEW.kind, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.space_id, OLD.alias, OLD.kind, OLD.created_by, OLD.created_at)
     OR NOT OLD.active OR NEW.active THEN
    RAISE EXCEPTION '别名只能停用一次，不能修改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER space_aliases_guard BEFORE UPDATE OR DELETE ON space_aliases
  FOR EACH ROW EXECUTE FUNCTION yuzu_space_alias_guard();

-- ───────────── 客房房间挂接空间（RQ-003 剩余项）：一个空间最多挂一间房 ─────────────
ALTER TABLE rooms ADD COLUMN space_id bigint REFERENCES spaces (id);
CREATE UNIQUE INDEX rooms_space_uq ON rooms (space_id) WHERE space_id IS NOT NULL;

-- ───────────── 操作编号与作废登记：空间台账导入；对账登记的撤销（v0.7.13 审查的修正） ─────────────
ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_op_type_check;
ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'inv_doc', 'purchase_order', 'payment', 'opening_payable',
                     'checkin', 'bill_post', 'tag_swap', 'abandoned', 'checkout', 'table_open', 'table_post', 'table_checkout',
                     'room_checkin', 'room_extend', 'room_deposit', 'room_refund', 'room_close', 'line_move',
                     'expense_claim', 'petty_advance', 'petty_settlement', 'purchase_request', 'ap_offset', 'supplier_refund', 'erp_import',
                     'supplier_recon', 'supplier_recon_void', 'space_import'));
ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'checkin', 'bill_post', 'tag_swap', 'checkout', 'table_open', 'table_post', 'table_checkout',
                     'room_checkin', 'room_extend', 'room_deposit', 'room_refund', 'room_close', 'line_move',
                     'expense_claim', 'petty_advance', 'petty_settlement', 'purchase_request', 'ap_offset', 'supplier_refund', 'erp_import',
                     'supplier_recon', 'supplier_recon_void', 'space_import'));
