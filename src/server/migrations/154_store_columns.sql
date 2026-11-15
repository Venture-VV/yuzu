-- 8.0.22 多门店：门店维度的业务表加 store_id，按店唯一（docs/MULTISTORE_V8022.md 第 5 节，MD-A）。
-- 默认值取 yuzu_store()（事务开头记上的当前门店，没设就是本店）：现有行都是本店，已有单据内容不改。
-- 按店唯一的索引沿用原来的名字（页面上的「已有」提示照旧认得）。

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    -- 手牌与前台
    'hand_tags', 'visit_groups', 'visits', 'bills', 'checkouts', 'refunds', 'backfill_entries', 'auth_grants',
    -- 班次与日结
    'shifts', 'daily_settlements',
    -- 钱包流水与次卡：只记发生在哪家店，不按店过滤（会员、钱包全公司通用）
    'recharges', 'consumptions', 'reversals', 'ledger_entries', 'member_refunds', 'count_cards',
    -- 设备
    'devices', 'device_jobs',
    -- 客房与预约
    'room_types', 'rooms', 'room_stays', 'bookings',
    -- 技师与钟房
    'technicians', 'technician_sessions',
    -- 餐饮与桌台
    'kitchen_stations', 'dining_tables', 'table_sessions', 'kitchen_items', 'emenu_orders',
    -- 空间、底图、实时位置、导览
    'floors', 'zones', 'spaces', 'space_usages', 'floorplan_batches', 'location_readers', 'current_locations', 'guide_markers',
    -- 审计
    'audit_logs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN store_id bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id)', t);
  END LOOP;
END $$;

-- 按店唯一：手牌代码、设备编号、技师工号、房号、房型名、桌台名、档口名、楼层与空间代码、刷卡点编号
ALTER TABLE hand_tags DROP CONSTRAINT hand_tags_code_key;
CREATE UNIQUE INDEX hand_tags_code_key ON hand_tags (store_id, code);
ALTER TABLE devices DROP CONSTRAINT devices_code_key;
CREATE UNIQUE INDEX devices_code_key ON devices (store_id, code);
ALTER TABLE technicians DROP CONSTRAINT technicians_tech_no_key;
CREATE UNIQUE INDEX technicians_tech_no_key ON technicians (store_id, tech_no);
DROP INDEX rooms_no_uq;
CREATE UNIQUE INDEX rooms_no_uq ON rooms (store_id, lower(btrim(room_no)));
DROP INDEX room_types_name_uq;
CREATE UNIQUE INDEX room_types_name_uq ON room_types (store_id, lower(btrim(name)));
DROP INDEX dining_tables_name_uq;
CREATE UNIQUE INDEX dining_tables_name_uq ON dining_tables (store_id, lower(btrim(name)));
DROP INDEX kitchen_stations_name_uq;
CREATE UNIQUE INDEX kitchen_stations_name_uq ON kitchen_stations (store_id, lower(btrim(name)));
DROP INDEX floors_code_uq;
CREATE UNIQUE INDEX floors_code_uq ON floors (store_id, code);
DROP INDEX spaces_code_uq;
CREATE UNIQUE INDEX spaces_code_uq ON spaces (store_id, code);
DROP INDEX location_readers_code_uq;
CREATE UNIQUE INDEX location_readers_code_uq ON location_readers (store_id, code);

-- 一个钱箱同时只有一个开着的班次：按门店分（每家店有自己的钱箱 k1…）
DROP INDEX shifts_drawer_open_uq;
CREATE UNIQUE INDEX shifts_drawer_open_uq ON shifts (store_id, drawer) WHERE status = 'open' AND drawer IS NOT NULL;

-- 底图：每家店各有一份在用、同时只转换一份
DROP INDEX floorplan_batches_one_active;
CREATE UNIQUE INDEX floorplan_batches_one_active ON floorplan_batches (store_id) WHERE status = 'active';
DROP INDEX floorplan_batches_one_converting;
CREATE UNIQUE INDEX floorplan_batches_one_converting ON floorplan_batches (store_id) WHERE status = 'converting';

-- 日结：按「门店 + 营业日」各一份
ALTER TABLE daily_settlements DROP CONSTRAINT daily_settlements_pkey;
ALTER TABLE daily_settlements ADD PRIMARY KEY (store_id, business_date);

-- 按店看常用的几个
CREATE INDEX checkouts_store_date_idx ON checkouts (store_id, business_date);
CREATE INDEX audit_logs_store_idx ON audit_logs (store_id, id);
