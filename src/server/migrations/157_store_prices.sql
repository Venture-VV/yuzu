-- 8.0.22 价目按店覆盖（docs/MULTISTORE_V8022.md 第 10 节，MD4）：价目表全公司一套；第二家店可以对某个项目的某一档单独定价。
-- 挂账、菜单取价时先看当前门店有没有单独的价，没有用全公司的；本店不用这张表（与以往完全一样）。
CREATE TABLE service_item_store_prices (
  store_id    bigint NOT NULL REFERENCES stores (id),
  item_id     bigint NOT NULL REFERENCES service_items (id),
  tier        text NOT NULL CHECK (tier IN ('standard', 'professional', 'premium')),
  price       bigint NOT NULL CHECK (price > 0),
  updated_by  bigint NOT NULL REFERENCES staff (id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, item_id, tier),
  CHECK (store_id <> 1)
);
