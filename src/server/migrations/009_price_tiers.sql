-- Batch 2.3：消费项目多档价格与属性（店主 2026-10-27 #8）
--   · 同一项目可设「标准 / 专业 / 优选」多档价格，某一档不提供时不设；
--   · 项目属性：时长、仅限某一性别（如私汤木桶浴仅女宾）、力道、精油、热疗、「超人气」——不影响计价；
--   · service_items.price 保留为默认档价格（标准 → 专业 → 优选中第一个提供的），旧请求不带档位时按它计价；
--   · 消费明细与挂账明细记下所选档位；多档项目的明细名称带档位（如「日式指压（专业）」），挂账明细名称上限放宽到 48 字。
-- 已有项目原样保留：现价记为「标准」档。

ALTER TABLE service_items
  ADD COLUMN duration_minutes integer CHECK (duration_minutes BETWEEN 1 AND 1440),
  ADD COLUMN gender           text CHECK (gender IN ('male', 'female')),
  ADD COLUMN strength         text CHECK (strength IN ('light', 'medium', 'strong')),
  ADD COLUMN essential_oil    boolean NOT NULL DEFAULT false,
  ADD COLUMN heat_therapy     boolean NOT NULL DEFAULT false,
  ADD COLUMN popular          boolean NOT NULL DEFAULT false,
  ADD COLUMN note             text NOT NULL DEFAULT '' CHECK (char_length(note) <= 100);

CREATE TABLE service_item_prices (
  item_id bigint NOT NULL REFERENCES service_items (id),
  tier    text NOT NULL CHECK (tier IN ('standard', 'professional', 'premium')),
  price   bigint NOT NULL CHECK (price > 0),
  PRIMARY KEY (item_id, tier)
);

INSERT INTO service_item_prices (item_id, tier, price) SELECT id, 'standard', price FROM service_items;

ALTER TABLE consumption_lines ADD COLUMN tier text CHECK (tier IN ('standard', 'professional', 'premium'));
ALTER TABLE bill_lines ADD COLUMN tier text CHECK (tier IN ('standard', 'professional', 'premium'));

ALTER TABLE bill_lines DROP CONSTRAINT bill_lines_name_check;
ALTER TABLE bill_lines ADD CONSTRAINT bill_lines_name_check CHECK (char_length(name) BETWEEN 1 AND 48);

-- 按名称导入价目表时查找项目
CREATE INDEX service_items_name_idx ON service_items (name);
