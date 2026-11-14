-- 8.0.20 用料与配方、销售与出品扣库存（docs/ERP_V8020.md 第 2 节，JX-A / JX-B）。
--
--   · item_recipes / item_recipe_lines：价目项目的用料（零售品就是只有一行的配方），带版本——改用料 = 旧的停用、写一份新的。
--   · stock_usage_events：结账（不进厨房的明细）、出品（进厨房的明细）时记下「该扣多少」；冲回是一条 sign = -1 的、指向原来那条。
--     业务事务里只插入这一张表，不碰库存的锁。
--   · stock_usage_batches：每分钟的任务把还没入账的事件按「种类 + 仓 + 物料」轧差，净数大于 0 且库存够的合成一张耗用单；
--     批次带自己的操作编号（client_key），开单后没记下结果的下一轮按它对账。
-- 事件表不用外键引用物料与仓：外键检查要对被引用的行加共享锁，会让结账、出品去等库存单据（库存单据把物料行 FOR UPDATE 锁住）。

CREATE TABLE item_recipes (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id       bigint NOT NULL REFERENCES service_items (id),
  version       integer NOT NULL CHECK (version >= 1),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  -- 从哪个仓扣；空 = 按规则里的默认仓
  warehouse_id  bigint REFERENCES warehouses (id),
  note          text NOT NULL DEFAULT '' CHECK (char_length(note) <= 100),
  created_by    bigint NOT NULL REFERENCES staff (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  retired_by    bigint REFERENCES staff (id),
  retired_at    timestamptz,
  UNIQUE (item_id, version)
);
CREATE UNIQUE INDEX item_recipes_active_uq ON item_recipes (item_id) WHERE status = 'active';

CREATE TABLE item_recipe_lines (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recipe_id    bigint NOT NULL REFERENCES item_recipes (id),
  material_id  bigint NOT NULL REFERENCES materials (id),
  -- 一份用多少（库存单位的千分之一）；损耗率是万分比
  qty_milli    bigint NOT NULL CHECK (qty_milli > 0 AND qty_milli <= 1000000000),
  loss_bp      integer NOT NULL DEFAULT 0 CHECK (loss_bp BETWEEN 0 AND 5000),
  UNIQUE (recipe_id, material_id)
);

CREATE TABLE stock_usage_batches (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('sale', 'recipe')),
  warehouse_id bigint NOT NULL,
  client_key   uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  status       text NOT NULL DEFAULT 'posting' CHECK (status IN ('posting', 'done', 'released')),
  inv_doc_id   bigint REFERENCES inv_docs (id),
  doc_date     date NOT NULL,
  line_count   integer NOT NULL DEFAULT 0,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX stock_usage_batches_posting_idx ON stock_usage_batches (id) WHERE status = 'posting';

CREATE TABLE stock_usage_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind            text NOT NULL CHECK (kind IN ('sale', 'recipe')),
  sign            smallint NOT NULL CHECK (sign IN (1, -1)),
  checkout_id     bigint REFERENCES checkouts (id),
  kitchen_item_id bigint REFERENCES kitchen_items (id),
  bill_line_id    bigint,
  reverses_id     bigint REFERENCES stock_usage_events (id),
  item_id         bigint NOT NULL,
  item_name       text NOT NULL,
  quantity        integer NOT NULL CHECK (quantity > 0),
  recipe_id       bigint NOT NULL REFERENCES item_recipes (id),
  material_id     bigint NOT NULL,
  warehouse_id    bigint NOT NULL,
  qty_milli       bigint NOT NULL CHECK (qty_milli > 0),
  business_date   date NOT NULL,
  -- 处理状态（只有这几列会改）：pending 还没入账；batched 进了某一批；netted 与冲回轧平了、不用出库
  state           text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'batched', 'netted')),
  batch_id        bigint REFERENCES stock_usage_batches (id),
  -- 库存不够、这一轮没扣成的时间（待扣料里看）
  blocked_at      timestamptz,
  -- 被冲回的时间（只在 sign = 1 的行上）
  reversed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'sale' AND checkout_id IS NOT NULL) OR (kind = 'recipe' AND kitchen_item_id IS NOT NULL)),
  CHECK ((sign = 1 AND reverses_id IS NULL) OR (sign = -1 AND reverses_id IS NOT NULL AND reversed_at IS NULL))
);
-- 同一张结账单的同一条明细、同一张出品单，同一样物料同时只有一条没冲回的；一条只能冲回一次
CREATE UNIQUE INDEX stock_usage_events_sale_uq ON stock_usage_events (checkout_id, bill_line_id, material_id) WHERE kind = 'sale' AND sign = 1 AND reversed_at IS NULL;
CREATE UNIQUE INDEX stock_usage_events_recipe_uq ON stock_usage_events (kitchen_item_id, material_id) WHERE kind = 'recipe' AND sign = 1 AND reversed_at IS NULL;
CREATE UNIQUE INDEX stock_usage_events_reverse_uq ON stock_usage_events (reverses_id) WHERE reverses_id IS NOT NULL;
CREATE INDEX stock_usage_events_pending_idx ON stock_usage_events (kind, warehouse_id, material_id) WHERE state = 'pending';
CREATE INDEX stock_usage_events_batch_idx ON stock_usage_events (batch_id) WHERE batch_id IS NOT NULL;

-- 事件只增不改内容：只允许改处理状态那几列
CREATE FUNCTION yuzu_stock_usage_event_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '扣料事件不能删除' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.kind, NEW.sign, NEW.checkout_id, NEW.kitchen_item_id, NEW.bill_line_id, NEW.reverses_id, NEW.item_id, NEW.item_name, NEW.quantity,
      NEW.recipe_id, NEW.material_id, NEW.warehouse_id, NEW.qty_milli, NEW.business_date, NEW.created_at)
     IS DISTINCT FROM
     (OLD.kind, OLD.sign, OLD.checkout_id, OLD.kitchen_item_id, OLD.bill_line_id, OLD.reverses_id, OLD.item_id, OLD.item_name, OLD.quantity,
      OLD.recipe_id, OLD.material_id, OLD.warehouse_id, OLD.qty_milli, OLD.business_date, OLD.created_at) THEN
    RAISE EXCEPTION '扣料事件的内容不能修改' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER stock_usage_events_guard BEFORE UPDATE OR DELETE ON stock_usage_events
  FOR EACH ROW EXECUTE FUNCTION yuzu_stock_usage_event_guard();
