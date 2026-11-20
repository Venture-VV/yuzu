-- 197（8.1.17，迁移号在 docs/ROADMAP.md 第 7 节登记）：套餐按子项出品与扣料、可换菜（BW7，docs/DISHES_V8117.md 第 7 节，
-- 默认做法 docs/PENDING_DECISIONS.md BW7）。
--   ① 可换菜：dish_combo_items.swappable（这一样能不能换）；dish_combo_swaps（可以换成哪几样、每份套餐补多少差价，0 = 同价），
--      换菜的差价按份加在套餐那一行的单价上；
--   ② 子项出品：kitchen_item_parts——套餐下单以后每一样子项一行（下单当时的菜名、换过的原来是哪一样、份数、档口），
--      各自记扣没扣沽清（退菜时按原份数加回）；子项的档口与套餐的不一样的（split）在那个档口的厨房屏上单独出一张子项单
--      （待做 → 制作中 → 已出餐，退菜时已退），一样的跟着套餐那一张；
--   ③ 扣料：stock_usage_events.kitchen_part_id——子项出品完成时按它自己的用料记「该扣多少」（同一张出品单下面按子项分开，
--      不与套餐自己的用料、别的子项撞在一条上）。
-- 都是加表、加列：老的套餐、老的出品单（没有子项单）照旧——出品单上的套餐内容（kitchen_items.parts）、套餐自己的沽清与用料都不变。

-- ───────────── ① 可换菜 ─────────────
ALTER TABLE dish_combo_items ADD COLUMN swappable boolean NOT NULL DEFAULT false;

-- 保存套餐内容时整批换（删套餐子项时跟着删）
CREATE TABLE dish_combo_swaps (
  combo_item_id  bigint NOT NULL,
  item_id        bigint NOT NULL,
  -- 换成的那一样（另外的菜品）
  to_item_id     bigint NOT NULL REFERENCES service_items (id),
  -- 每份套餐补多少差价（分；0 = 同价，最多 ¥999）
  price_diff     bigint NOT NULL DEFAULT 0 CHECK (price_diff BETWEEN 0 AND 99900),
  sort_no        integer NOT NULL DEFAULT 0 CHECK (sort_no >= 0),
  PRIMARY KEY (combo_item_id, item_id, to_item_id),
  FOREIGN KEY (combo_item_id, item_id) REFERENCES dish_combo_items (combo_item_id, item_id) ON DELETE CASCADE,
  CONSTRAINT dish_combo_swaps_not_same CHECK (to_item_id <> item_id AND to_item_id <> combo_item_id)
);
CREATE INDEX dish_combo_swaps_to_idx ON dish_combo_swaps (to_item_id);

-- 套餐不套套餐（189 的兜底）：换成的也不能是套餐；已经是别的套餐的子项、可换菜的菜不能再做成套餐
CREATE OR REPLACE FUNCTION yuzu_dish_combo_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM dish_combo_items WHERE combo_item_id = NEW.item_id) THEN
    RAISE EXCEPTION '套餐里不能再放套餐' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM dish_combo_items WHERE item_id = NEW.combo_item_id)
     OR EXISTS (SELECT 1 FROM dish_combo_swaps WHERE to_item_id = NEW.combo_item_id) THEN
    RAISE EXCEPTION '这道菜已经在别的套餐里，不能再做成套餐' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION yuzu_dish_combo_swap_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM dish_combo_items WHERE combo_item_id = NEW.to_item_id) THEN
    RAISE EXCEPTION '套餐里不能换成套餐' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dish_combo_swaps_guard BEFORE INSERT OR UPDATE ON dish_combo_swaps
  FOR EACH ROW EXECUTE FUNCTION yuzu_dish_combo_swap_guard();

-- ───────────── ② 子项出品 ─────────────
CREATE TABLE kitchen_item_parts (
  id               bigserial PRIMARY KEY,
  -- 套餐那一张出品单（主档口看整份套餐）
  kitchen_item_id  bigint NOT NULL REFERENCES kitchen_items (id),
  item_id          bigint NOT NULL REFERENCES service_items (id),
  -- 下单当时的菜名（换过的是换成的那一样）；换过的记原来是哪一样
  name             text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 48),
  swapped_from     text CHECK (swapped_from IS NULL OR char_length(swapped_from) BETWEEN 1 AND 48),
  -- 每份套餐几份；这一张出品单一共几份（套餐的份数 × 每份几份）
  per_combo        integer NOT NULL CHECK (per_combo BETWEEN 1 AND 99),
  quantity         integer NOT NULL CHECK (quantity > 0),
  -- 在哪个档口做；split：与套餐的档口不一样，在那个档口的厨房屏上单独出一张子项单
  station_id       bigint NOT NULL REFERENCES kitchen_stations (id),
  split            boolean NOT NULL,
  -- 下单时扣过这一样的沽清（退菜时按原份数加回）
  limit_taken      boolean NOT NULL DEFAULT false,
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'cooking', 'done', 'cancelled')),
  business_date    date NOT NULL,
  created_at       timestamptz NOT NULL,
  started_by       bigint REFERENCES staff (id),
  started_at       timestamptz,
  done_by          bigint REFERENCES staff (id),
  done_at          timestamptz,
  cancelled_by     bigint REFERENCES staff (id),
  cancelled_at     timestamptz,
  store_id         bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id),
  CONSTRAINT kitchen_item_parts_state_check CHECK (
    (status = 'queued' AND started_at IS NULL AND done_at IS NULL AND cancelled_at IS NULL) OR
    (status = 'cooking' AND started_at IS NOT NULL AND done_at IS NULL AND cancelled_at IS NULL) OR
    (status = 'done' AND done_at IS NOT NULL AND cancelled_at IS NULL) OR
    (status = 'cancelled' AND cancelled_at IS NOT NULL)
  )
);
CREATE INDEX kitchen_item_parts_item_idx ON kitchen_item_parts (kitchen_item_id);
CREATE INDEX kitchen_item_parts_open_idx ON kitchen_item_parts (station_id, created_at) WHERE split AND status IN ('queued', 'cooking', 'done');

-- 子项单的保护：不能删除；子项、份数、档口、下单信息写入以后不能改；状态只能前进一步或退回一步，任何状态都能因退菜改为已退（终态）
CREATE FUNCTION yuzu_kitchen_item_part_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '子项单禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.kitchen_item_id, NEW.item_id, NEW.name, NEW.swapped_from, NEW.per_combo, NEW.quantity, NEW.station_id, NEW.split,
      NEW.limit_taken, NEW.business_date, NEW.created_at, NEW.store_id)
     IS DISTINCT FROM (OLD.id, OLD.kitchen_item_id, OLD.item_id, OLD.name, OLD.swapped_from, OLD.per_combo, OLD.quantity, OLD.station_id, OLD.split,
      OLD.limit_taken, OLD.business_date, OLD.created_at, OLD.store_id) THEN
    RAISE EXCEPTION '子项单的菜品、份数与下单信息不可修改' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'cancelled' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION '已退的子项不能再改' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       NEW.status = 'cancelled'
    OR (OLD.status, NEW.status) IN (('queued', 'cooking'), ('queued', 'done'), ('cooking', 'done'), ('cooking', 'queued'), ('done', 'cooking'), ('done', 'queued'))
  ) THEN
    RAISE EXCEPTION '子项单的状态不能从 % 改为 %', OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER kitchen_item_parts_guard BEFORE UPDATE OR DELETE ON kitchen_item_parts
  FOR EACH ROW EXECUTE FUNCTION yuzu_kitchen_item_part_guard();

-- ───────────── ③ 子项扣料 ─────────────
ALTER TABLE stock_usage_events ADD COLUMN kitchen_part_id bigint REFERENCES kitchen_item_parts (id);
-- 同一张出品单、同一样物料同时只有一条没冲回的（128）：子项的另算（按子项分开）
DROP INDEX stock_usage_events_recipe_uq;
CREATE UNIQUE INDEX stock_usage_events_recipe_uq ON stock_usage_events (kitchen_item_id, material_id)
  WHERE kind = 'recipe' AND sign = 1 AND reversed_at IS NULL AND kitchen_part_id IS NULL;
CREATE UNIQUE INDEX stock_usage_events_part_uq ON stock_usage_events (kitchen_part_id, material_id)
  WHERE kind = 'recipe' AND sign = 1 AND reversed_at IS NULL AND kitchen_part_id IS NOT NULL;

-- 事件只增不改内容（128 的保护）：把子项这一列也算进不能改的
CREATE OR REPLACE FUNCTION yuzu_stock_usage_event_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '扣料事件不能删除' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.kind, NEW.sign, NEW.checkout_id, NEW.kitchen_item_id, NEW.bill_line_id, NEW.reverses_id, NEW.item_id, NEW.item_name, NEW.quantity,
      NEW.recipe_id, NEW.material_id, NEW.warehouse_id, NEW.qty_milli, NEW.business_date, NEW.created_at, NEW.kitchen_part_id)
     IS DISTINCT FROM
     (OLD.kind, OLD.sign, OLD.checkout_id, OLD.kitchen_item_id, OLD.bill_line_id, OLD.reverses_id, OLD.item_id, OLD.item_name, OLD.quantity,
      OLD.recipe_id, OLD.material_id, OLD.warehouse_id, OLD.qty_milli, OLD.business_date, OLD.created_at, OLD.kitchen_part_id) THEN
    RAISE EXCEPTION '扣料事件的内容不能修改' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
