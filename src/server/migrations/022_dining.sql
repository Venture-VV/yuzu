-- S5 餐饮第一步（ROADMAP 第 10 节）：出品档口、菜品的出品档口、估清、厨房出品单（KDS）。
--   · 出品档口（kitchen_stations）：热菜、凉菜、主食、水吧……菜品挂在哪个档口，下单后就到哪个档口的厨房屏；
--   · 菜品的出品档口（service_items.station_id）：只有挂了档口的项目才进厨房；餐饮功能关闭时不起作用；
--   · 估清（dish_limits）：某营业日某道菜还剩几份，0 为估清（卖完）；没有当天的记录为不限量；
--   · 厨房出品单（kitchen_items）：每条餐饮明细一行，待做 → 制作中 → 已出餐 → 已上菜，退菜（作废明细）为已退。
--     钱仍只在账单明细里，出品单只记出品状态与时间；明细、数量、口味备注写入后不可改。
-- 只加表、加列，不改已有数据。

CREATE TABLE kitchen_stations (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 16),
  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_by  bigint REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX kitchen_stations_name_uq ON kitchen_stations (lower(btrim(name)));

ALTER TABLE service_items ADD COLUMN station_id bigint REFERENCES kitchen_stations (id);

CREATE TABLE dish_limits (
  item_id        bigint PRIMARY KEY REFERENCES service_items (id),
  business_date  date NOT NULL,
  remaining      integer NOT NULL CHECK (remaining >= 0),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     bigint NOT NULL REFERENCES staff (id)
);

CREATE TABLE kitchen_items (
  id             bigserial PRIMARY KEY,
  -- 同一次下单（同一操作编号）的出品单号，厨房按单显示
  order_no       text NOT NULL,
  bill_line_id   bigint NOT NULL UNIQUE REFERENCES bill_lines (id),
  visit_id       bigint NOT NULL REFERENCES visits (id),
  item_id        bigint NOT NULL REFERENCES service_items (id),
  station_id     bigint NOT NULL REFERENCES kitchen_stations (id),
  quantity       integer NOT NULL CHECK (quantity > 0),
  note           text NOT NULL DEFAULT '' CHECK (char_length(note) <= 40),
  status         text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'cooking', 'done', 'served', 'cancelled')),
  rush_count     integer NOT NULL DEFAULT 0 CHECK (rush_count >= 0),
  rushed_at      timestamptz,
  business_date  date NOT NULL,
  -- 下单时扣过估清（退菜时按原份数加回）；补录纸质单与不限量的菜为 false
  limit_taken    boolean NOT NULL DEFAULT false,
  created_by     bigint NOT NULL REFERENCES staff (id),
  created_at     timestamptz NOT NULL,
  started_by     bigint REFERENCES staff (id),
  started_at     timestamptz,
  done_by        bigint REFERENCES staff (id),
  done_at        timestamptz,
  served_by      bigint REFERENCES staff (id),
  served_at      timestamptz,
  cancelled_by   bigint REFERENCES staff (id),
  cancelled_at   timestamptz,
  cancel_reason  text CHECK (cancel_reason IS NULL OR char_length(cancel_reason) BETWEEN 2 AND 200),
  CONSTRAINT kitchen_items_state_check CHECK (
    (status = 'queued' AND started_at IS NULL AND done_at IS NULL AND served_at IS NULL AND cancelled_at IS NULL) OR
    (status = 'cooking' AND started_at IS NOT NULL AND done_at IS NULL AND served_at IS NULL AND cancelled_at IS NULL) OR
    (status = 'done' AND done_at IS NOT NULL AND served_at IS NULL AND cancelled_at IS NULL) OR
    (status = 'served' AND done_at IS NOT NULL AND served_at IS NOT NULL AND cancelled_at IS NULL) OR
    (status = 'cancelled' AND cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL)
  )
);
CREATE INDEX kitchen_items_open_idx ON kitchen_items (station_id, created_at) WHERE status IN ('queued', 'cooking', 'done');
CREATE INDEX kitchen_items_visit_idx ON kitchen_items (visit_id);
CREATE INDEX kitchen_items_date_idx ON kitchen_items (business_date);

-- 出品单的保护：不能删除；明细、菜品、档口、数量、口味备注、下单人与时间写入后不可改；
-- 状态只能前进一步或退回一步（点错了撤回），任何状态都可以因退菜改为已退（终态）；催单次数只增不减
CREATE OR REPLACE FUNCTION yuzu_kitchen_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '出品单禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.order_no, NEW.bill_line_id, NEW.visit_id, NEW.item_id, NEW.station_id, NEW.quantity, NEW.note, NEW.business_date,
      NEW.limit_taken, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.order_no, OLD.bill_line_id, OLD.visit_id, OLD.item_id, OLD.station_id, OLD.quantity, OLD.note,
      OLD.business_date, OLD.limit_taken, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION '出品单的菜品、数量与下单信息不可修改' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.rush_count < OLD.rush_count THEN
    RAISE EXCEPTION '催单次数不能减少' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'cancelled' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION '已退的菜不能再改' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       NEW.status = 'cancelled'
    OR (OLD.status, NEW.status) IN (('queued', 'cooking'), ('queued', 'done'), ('cooking', 'done'), ('done', 'served'),
                                    ('cooking', 'queued'), ('done', 'cooking'), ('done', 'queued'), ('served', 'done'))
  ) THEN
    RAISE EXCEPTION '出品状态不能从 % 改为 %', OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER kitchen_items_guard BEFORE UPDATE OR DELETE ON kitchen_items FOR EACH ROW EXECUTE FUNCTION yuzu_kitchen_item_guard();
