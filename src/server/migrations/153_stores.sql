-- 8.0.22 多门店：公司主体、门店、员工挂门店、门店设置、会话的当前门店（docs/MULTISTORE_V8022.md 第 1–4 节，MD-A / MD-C）。
-- 只有一家店时与现在完全一样：现有数据都归「本店」（编号 1）与「本公司」（编号 1）；本店不设门店上下文。
-- 门店上下文：请求里的当前门店不是本店时，每个事务开头 set_config('yuzu.store', 门店编号, true)；
-- 业务表的 store_id 默认值取 yuzu_store()（没设就是本店，迁移 154 起用）。

CREATE TABLE legal_entities (
  id            bigserial PRIMARY KEY,
  name          text NOT NULL CHECK (btrim(name) <> '' AND char_length(name) <= 60),
  tax_no        text NOT NULL DEFAULT '' CHECK (char_length(tax_no) <= 30),
  address_phone text NOT NULL DEFAULT '' CHECK (char_length(address_phone) <= 120),
  bank_name     text NOT NULL DEFAULT '' CHECK (char_length(bank_name) <= 60),
  bank_account  text NOT NULL DEFAULT '' CHECK (char_length(bank_account) <= 40),
  active        boolean NOT NULL DEFAULT true,
  version       int NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (id <> 1 OR active)
);
CREATE UNIQUE INDEX legal_entities_name_uq ON legal_entities (lower(btrim(name)));

CREATE TABLE stores (
  id          bigserial PRIMARY KEY,
  code        text NOT NULL CHECK (code ~ '^[A-Z0-9]{2,8}$'),
  name        text NOT NULL CHECK (btrim(name) <> '' AND char_length(name) <= 40),
  entity_id   bigint NOT NULL REFERENCES legal_entities (id),
  address     text NOT NULL DEFAULT '' CHECK (char_length(address) <= 120),
  phone       text NOT NULL DEFAULT '' CHECK (char_length(phone) <= 40),
  active      boolean NOT NULL DEFAULT true,
  sort_order  int NOT NULL DEFAULT 0,
  version     int NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- 本店不能停用
  CHECK (id <> 1 OR active)
);
CREATE UNIQUE INDEX stores_code_uq ON stores (code);
CREATE UNIQUE INDEX stores_name_uq ON stores (lower(btrim(name)));

-- 本公司、本店（编号 1）：名称取现在设置里的门店名
INSERT INTO legal_entities (id, name)
VALUES (1, left(coalesce(nullif(btrim((SELECT value #>> '{}' FROM settings WHERE key = 'store_name')), ''), '本公司'), 60));
SELECT setval('legal_entities_id_seq', 1);
INSERT INTO stores (id, code, name, entity_id)
VALUES (1, 'HQ', left(coalesce(nullif(btrim((SELECT value #>> '{}' FROM settings WHERE key = 'store_name')), ''), '本店'), 40), 1);
SELECT setval('stores_id_seq', 1);

-- 员工挂哪几家店；店主不用挂（所有门店都能进）；没挂任何门店的员工按本店算（以往直接建的账号照常能用）
CREATE TABLE staff_stores (
  staff_id      bigint NOT NULL REFERENCES staff (id),
  store_id      bigint NOT NULL REFERENCES stores (id),
  last_used_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (staff_id, store_id)
);
CREATE INDEX staff_stores_store_idx ON staff_stores (store_id);
INSERT INTO staff_stores (staff_id, store_id) SELECT id, 1 FROM staff;

-- 门店单独的设置（按店的那几项，docs/MULTISTORE_V8022.md 第 4 节）：本店照旧用 settings
CREATE TABLE store_settings (
  store_id    bigint NOT NULL REFERENCES stores (id),
  key         text NOT NULL,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  bigint REFERENCES staff (id),
  PRIMARY KEY (store_id, key),
  CHECK (store_id <> 1)
);

-- 会话的当前门店（空 = 按员工挂的第一家，没挂的是本店）
ALTER TABLE sessions ADD COLUMN store_id bigint REFERENCES stores (id);

-- 门店上下文：没设就是本店
CREATE FUNCTION yuzu_store() RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('yuzu.store', true), '')::bigint, 1)
$$;
