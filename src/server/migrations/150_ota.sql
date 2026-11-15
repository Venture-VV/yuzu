-- 8.0.21 OTA 渠道订单（docs/INTEGRATIONS_V8021.md 第 4 节，CW-I / CW9）：先做渠道后台导出的订单表导入成客房预约，直连是以后的事；
-- 房量房价不自动推给渠道。
--   · ota_channels：渠道（携程、美团酒店、飞猪……）、佣金比例、渠道房型 → 本店房型的对照、导入用的列对照、启用；
--   · ota_imports：每次导入一行（同一渠道同一份文件只导一次），只追加；
--   · ota_orders：渠道 + 订单号唯一，存解析出来的字段与原始行、状态；ota_order_bookings：订单对应的预约（几间就几张）。
--   · bookings.source 加 ota（在当时的约束上追加）；确认作废加业务类型 ota_import。

CREATE TABLE ota_channels (
  id            bigserial PRIMARY KEY,
  name          text NOT NULL UNIQUE CHECK (char_length(btrim(name)) BETWEEN 1 AND 20),
  commission_bp integer NOT NULL DEFAULT 0 CHECK (commission_bp BETWEEN 0 AND 10000),
  -- 渠道房型名 → 本店房型 id
  room_map      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- 导入用的列对照（字段 → 表头）；空的按同义词认
  column_map    jsonb NOT NULL DEFAULT '{}'::jsonb,
  active        boolean NOT NULL DEFAULT true,
  version       integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by    bigint NOT NULL REFERENCES staff (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ota_imports (
  id           bigserial PRIMARY KEY,
  channel_id   bigint NOT NULL REFERENCES ota_channels (id),
  file_name    text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 120),
  file_hash    text NOT NULL CHECK (file_hash ~ '^[0-9a-f]{64}$'),
  rows         integer NOT NULL CHECK (rows >= 0),
  client_key   uuid NOT NULL UNIQUE,
  request_hash text NOT NULL,
  staff_id     bigint NOT NULL REFERENCES staff (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, file_hash)
);
CREATE FUNCTION yuzu_ota_import_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '渠道订单的导入记录只追加' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER ota_imports_guard BEFORE UPDATE OR DELETE ON ota_imports FOR EACH ROW EXECUTE FUNCTION yuzu_ota_import_guard();

CREATE TABLE ota_orders (
  id             bigserial PRIMARY KEY,
  channel_id     bigint NOT NULL REFERENCES ota_channels (id),
  order_no       text NOT NULL CHECK (char_length(order_no) BETWEEN 1 AND 64),
  guest_name     text NOT NULL DEFAULT '' CHECK (char_length(guest_name) <= 32),
  guest_phone    text NOT NULL DEFAULT '' CHECK (char_length(guest_phone) <= 20),
  channel_room   text NOT NULL DEFAULT '' CHECK (char_length(channel_room) <= 60),
  room_type_id   bigint REFERENCES room_types (id),
  checkin_date   date NOT NULL,
  checkout_date  date NOT NULL,
  rooms          integer NOT NULL CHECK (rooms BETWEEN 1 AND 20),
  amount_cents   bigint NOT NULL CHECK (amount_cents >= 0),
  pay_mode       text NOT NULL CHECK (pay_mode IN ('prepaid', 'pay_at_hotel')),
  -- 渠道那边的状态（这次导入时）
  channel_status text NOT NULL CHECK (channel_status IN ('confirmed', 'cancelled')),
  -- 本店这边：new 刚导入、booked 建好预约、cancelled 取消了、failed 房型对照不上（补对照后重试）、skipped 入住日已经过了
  status         text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'booked', 'cancelled', 'failed', 'skipped')),
  fail_reason    text CHECK (fail_reason IS NULL OR char_length(fail_reason) <= 200),
  -- 房量不够照样建了（超订提醒）
  overbooked     boolean NOT NULL DEFAULT false,
  -- 已经到店、渠道又改了或取消了：只提醒，不动预约
  notice         text CHECK (notice IS NULL OR char_length(notice) <= 200),
  raw            jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_import_id bigint REFERENCES ota_imports (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, order_no),
  CHECK (checkout_date > checkin_date)
);
CREATE INDEX ota_orders_checkin ON ota_orders (checkin_date, channel_id);

CREATE TABLE ota_order_bookings (
  order_id   bigint NOT NULL REFERENCES ota_orders (id),
  booking_id bigint NOT NULL UNIQUE REFERENCES bookings (id),
  PRIMARY KEY (order_id, booking_id)
);

-- 预约来源加「渠道」
DO $$
DECLARE expression text;
DECLARE cname text;
BEGIN
  SELECT conname, pg_get_expr(conbin, conrelid) INTO cname, expression FROM pg_constraint
   WHERE conrelid = 'bookings'::regclass AND contype = 'c' AND pg_get_expr(conbin, conrelid) LIKE '%source%' AND pg_get_expr(conbin, conrelid) LIKE '%''phone''%';
  IF expression IS NULL THEN RAISE EXCEPTION '预约来源的约束不存在'; END IF;
  EXECUTE format('ALTER TABLE bookings DROP CONSTRAINT %I', cname);
  EXECUTE format('ALTER TABLE bookings ADD CONSTRAINT %I CHECK ((%s) OR source = ''ota'')', cname, expression);
END $$;

-- 「确认作废」：渠道订单导入（编号记在导入记录上）。在当时的约束上追加
DO $$
DECLARE expression text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint
   WHERE conrelid = 'op_fences'::regclass AND conname = 'op_fences_op_type_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
  ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
  EXECUTE format('ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check CHECK ((%s) OR op_type IN (''ota_import''))', expression);
END $$;
