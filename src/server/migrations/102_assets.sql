-- 8.0.7 ERP P2 3.2（docs/ERP_V807.md）：资产与易耗台账。
--   · 资产卡片 asset_cards：编号（ZC…）、名称、类别（固定资产 / 低值易耗）、使用部门、存放位置、保管人、原值、取得日期、
--     状态（在用 / 闲置 / 维修 / 报废）；能从收货单的某一行「转资产建卡」（一件一张，不超过收货数量），也能手工建（期初）。
--     不能删；调拨（换部门、位置、保管人）、改状态、报废（写原因）都记在变动记录里（只追加），卡片带版本号。
--   · 扫码盘点：开一次盘点（全部或某个部门），扫资产标签上的二维码（= 资产编号）或手输，结束时列出没扫到的（盘亏）
--     与不在范围里的；结果只记录，不自动改卡片（V15）。
--   · 建卡的操作编号记在卡片上（一次建几张的几张卡同一个编号）；「确认作废」的业务类型 asset_card 在迁移 101 里加了。

CREATE TABLE asset_cards (
  id               bigserial PRIMARY KEY,
  asset_no         text NOT NULL UNIQUE,
  name             text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  category         text NOT NULL CHECK (category IN ('fixed', 'consumable')),
  department_id    bigint REFERENCES departments (id),
  location         text NOT NULL DEFAULT '' CHECK (char_length(location) <= 60),
  keeper           text NOT NULL DEFAULT '' CHECK (char_length(keeper) <= 20),
  original_cents   bigint NOT NULL CHECK (original_cents >= 0),
  acquired_on      date NOT NULL,
  status           text NOT NULL DEFAULT 'in_use' CHECK (status IN ('in_use', 'idle', 'repair', 'scrapped')),
  material_id      bigint REFERENCES materials (id),
  receipt_line_id  bigint REFERENCES inv_doc_lines (id),
  note             text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  client_key       uuid NOT NULL,
  request_hash     text NOT NULL,
  version          integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by       bigint NOT NULL REFERENCES staff (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX asset_cards_client_key_idx ON asset_cards (client_key);
CREATE INDEX asset_cards_receipt_line_idx ON asset_cards (receipt_line_id) WHERE receipt_line_id IS NOT NULL;
CREATE INDEX asset_cards_department_idx ON asset_cards (department_id);

CREATE FUNCTION yuzu_asset_card_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION '资产卡片不能删除，不用了报废' USING ERRCODE = 'P0001'; END IF;
  IF (NEW.asset_no, NEW.category, NEW.original_cents, NEW.acquired_on, NEW.material_id, NEW.receipt_line_id, NEW.client_key,
      NEW.request_hash, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.asset_no, OLD.category, OLD.original_cents, OLD.acquired_on, OLD.material_id, OLD.receipt_line_id, OLD.client_key,
      OLD.request_hash, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION '资产卡片的编号、类别、原值、取得日期与来源不能改' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'scrapped' THEN
    RAISE EXCEPTION '报废的资产卡片不能再改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER asset_cards_guard BEFORE UPDATE OR DELETE ON asset_cards
  FOR EACH ROW EXECUTE FUNCTION yuzu_asset_card_guard();

CREATE TABLE asset_changes (
  id         bigserial PRIMARY KEY,
  asset_id   bigint NOT NULL REFERENCES asset_cards (id),
  kind       text NOT NULL CHECK (kind IN ('create', 'edit', 'transfer', 'status', 'scrap')),
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason     text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 200),
  created_by bigint NOT NULL REFERENCES staff (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'scrap' OR char_length(btrim(reason)) >= 2)
);
CREATE INDEX asset_changes_asset_idx ON asset_changes (asset_id, id);
CREATE TRIGGER asset_changes_append_only BEFORE UPDATE OR DELETE ON asset_changes
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

CREATE TABLE asset_stocktakes (
  id            bigserial PRIMARY KEY,
  doc_no        text NOT NULL UNIQUE,
  department_id bigint REFERENCES departments (id),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  note          text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  started_by    bigint NOT NULL REFERENCES staff (id),
  started_at    timestamptz NOT NULL DEFAULT now(),
  closed_by     bigint REFERENCES staff (id),
  closed_at     timestamptz,
  CHECK ((status = 'closed') = (closed_at IS NOT NULL) AND (closed_at IS NULL) = (closed_by IS NULL))
);
CREATE TABLE asset_stocktake_scans (
  stocktake_id bigint NOT NULL REFERENCES asset_stocktakes (id),
  code         text NOT NULL CHECK (char_length(btrim(code)) BETWEEN 1 AND 40),
  asset_id     bigint REFERENCES asset_cards (id),
  scanned_by   bigint NOT NULL REFERENCES staff (id),
  scanned_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (stocktake_id, code)
);
CREATE TRIGGER asset_stocktake_scans_append_only BEFORE UPDATE OR DELETE ON asset_stocktake_scans
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
