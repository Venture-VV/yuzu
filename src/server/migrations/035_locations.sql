-- v0.7.17 · 飞书需求 RQ-004 第一级实时位置（docs/ROOMMAP.md 第 3 节）：刷卡点登记、位置事件（只追加）、轨迹段、当前位置；
-- 价目项目记「在哪个区消费」（用来推导挂账的客人在哪）。表结构按第二级精确定位预留：事件带坐标、精度、设备编号（第一级为空），
-- 第二级只换数据源、走同一个上报接口。只加表、加列。

-- ───────────── 刷卡点：读卡器装在哪（区域或空间，二选一） ─────────────
CREATE TABLE location_readers (
  id         bigserial PRIMARY KEY,
  -- 编号：读卡器上贴的号或设备序列号（大写字母、数字、横线）
  code       text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{0,23}$'),
  name       text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 24),
  zone_id    bigint REFERENCES zones (id),
  space_id   bigint REFERENCES spaces (id),
  note       text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  active     boolean NOT NULL DEFAULT true,
  -- 版本号：每次修改加 1；页面提交读到的版本号，对不上就拒绝
  version    integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by bigint REFERENCES staff (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((zone_id IS NULL) <> (space_id IS NULL))
);
CREATE UNIQUE INDEX location_readers_code_uq ON location_readers (code);
CREATE TRIGGER location_readers_no_delete BEFORE DELETE ON location_readers FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_delete();

-- ───────────── 位置事件（只追加）：谁、在哪、怎么知道的、什么时候 ─────────────
CREATE TABLE location_events (
  id            bigserial PRIMARY KEY,
  -- 谁：在店客人（来访）或技师
  visit_id      bigint REFERENCES visits (id),
  technician_id bigint REFERENCES technicians (id),
  -- 当时的手牌号（客人换牌后，旧事件里仍是当时那张）
  tag_code      text CHECK (char_length(tag_code) BETWEEN 1 AND 16),
  -- 在某处 / 离开某处、去向不明（退房、没设休息区时下钟）/ 离店（客人结账、撤销来访；技师下牌）
  kind          text NOT NULL CHECK (kind IN ('at', 'left', 'gone')),
  floor_id      bigint REFERENCES floors (id),
  zone_id       bigint REFERENCES zones (id),
  space_id      bigint REFERENCES spaces (id),
  -- 怎么知道的：刷卡、定位上报（第二级预留）、发牌、消费、开房、换房、退房、上钟、换服务的房间、下钟、技师上牌 / 下牌、结账、撤销来访
  source        text NOT NULL CHECK (source IN ('reader', 'position', 'checkin', 'consume', 'room_checkin', 'room_move', 'room_close',
                                                 'session_start', 'session_room', 'session_end', 'sign_in', 'sign_out', 'checkout', 'visit_cancel')),
  -- 哪条业务单据：来访、账单明细、入住单、钟单、结账单
  ref_type      text CHECK (ref_type IN ('visit', 'bill_line', 'room_stay', 'technician_session', 'checkout')),
  ref_id        bigint,
  reader_id     bigint REFERENCES location_readers (id),
  -- 发生时刻（刷卡时刻、业务时刻）与写入时刻
  at            timestamptz NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  -- 生效：比这个人最近一次位置还早的（迟到的刷卡）只记事件、不改当前位置与轨迹
  applied       boolean NOT NULL,
  -- 上报的操作编号与内容摘要：同一个编号原样重发返回原结果、不重复记（业务动作推导的为空）
  op_key        uuid,
  op_hash       text CHECK (op_hash ~ '^[0-9a-f]{64}$'),
  -- 第二级精确定位预留（UWB、蓝牙信标）：底图坐标（毫米）、精度（毫米）、设备编号；第一级为空
  x_mm          integer,
  y_mm          integer,
  accuracy_mm   integer CHECK (accuracy_mm >= 0),
  device_id     text CHECK (char_length(device_id) BETWEEN 1 AND 64),
  -- 经办人：业务动作的操作员、模拟刷卡的人或设备桥的账号
  staff_id      bigint REFERENCES staff (id),
  CHECK ((visit_id IS NULL) <> (technician_id IS NULL)),
  CHECK (kind <> 'at' OR floor_id IS NOT NULL),
  CHECK (kind <> 'gone' OR (floor_id IS NULL AND zone_id IS NULL AND space_id IS NULL)),
  CHECK (floor_id IS NOT NULL OR (zone_id IS NULL AND space_id IS NULL)),
  CHECK ((ref_type IS NULL) = (ref_id IS NULL)),
  CHECK ((op_key IS NULL) = (op_hash IS NULL)),
  CHECK ((source = 'reader') = (reader_id IS NOT NULL))
);
CREATE INDEX location_events_visit_idx ON location_events (visit_id, at, id) WHERE visit_id IS NOT NULL;
CREATE INDEX location_events_technician_idx ON location_events (technician_id, at, id) WHERE technician_id IS NOT NULL;
CREATE UNIQUE INDEX location_events_op_uq ON location_events (op_key) WHERE op_key IS NOT NULL;
CREATE TRIGGER location_events_append_only BEFORE UPDATE OR DELETE ON location_events
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- ───────────── 轨迹段：同一个地方连续的事件并成一段（进入—离开）；每人最多一段没结束 ─────────────
CREATE TABLE location_tracks (
  id             bigserial PRIMARY KEY,
  visit_id       bigint REFERENCES visits (id),
  technician_id  bigint REFERENCES technicians (id),
  floor_id       bigint NOT NULL REFERENCES floors (id),
  zone_id        bigint REFERENCES zones (id),
  space_id       bigint REFERENCES spaces (id),
  -- 进入：这一段的第一条事件
  entered_at     timestamptz NOT NULL,
  first_event_id bigint NOT NULL REFERENCES location_events (id),
  -- 这一段最近的一条事件与事件数（第二级来了事件更密，段还是按进入—离开）
  last_at        timestamptz NOT NULL,
  last_event_id  bigint NOT NULL REFERENCES location_events (id),
  event_count    integer NOT NULL DEFAULT 1 CHECK (event_count >= 1),
  -- 离开：换到别处、离开、离店的那一条事件；还在这里为空
  left_at        timestamptz,
  end_event_id   bigint REFERENCES location_events (id),
  CHECK ((visit_id IS NULL) <> (technician_id IS NULL)),
  CHECK ((left_at IS NULL) = (end_event_id IS NULL)),
  CHECK (last_at >= entered_at),
  CHECK (left_at IS NULL OR left_at >= last_at)
);
CREATE UNIQUE INDEX location_tracks_visit_open_uq ON location_tracks (visit_id) WHERE left_at IS NULL AND visit_id IS NOT NULL;
CREATE UNIQUE INDEX location_tracks_technician_open_uq ON location_tracks (technician_id) WHERE left_at IS NULL AND technician_id IS NOT NULL;
CREATE INDEX location_tracks_visit_idx ON location_tracks (visit_id, entered_at) WHERE visit_id IS NOT NULL;
CREATE INDEX location_tracks_technician_idx ON location_tracks (technician_id, entered_at) WHERE technician_id IS NOT NULL;

-- 轨迹段的保护：不能删除；谁、在哪、进入时刻不可改；结束了的段不能再改
CREATE FUNCTION yuzu_location_track_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '轨迹段不能删除' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.visit_id, NEW.technician_id, NEW.floor_id, NEW.zone_id, NEW.space_id, NEW.entered_at, NEW.first_event_id)
     IS DISTINCT FROM (OLD.visit_id, OLD.technician_id, OLD.floor_id, OLD.zone_id, OLD.space_id, OLD.entered_at, OLD.first_event_id)
     OR OLD.left_at IS NOT NULL THEN
    RAISE EXCEPTION '轨迹段只能续上或结束，不能修改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER location_tracks_guard BEFORE UPDATE OR DELETE ON location_tracks
  FOR EACH ROW EXECUTE FUNCTION yuzu_location_track_guard();

-- ───────────── 当前位置：每人一行（当前所在空间）；离店、下牌后清空位置，行留着作为这个人的写入锁 ─────────────
CREATE TABLE current_locations (
  id            bigserial PRIMARY KEY,
  visit_id      bigint UNIQUE REFERENCES visits (id),
  technician_id bigint UNIQUE REFERENCES technicians (id),
  -- 还没有事件 / 在某处 / 离开了某处（位置不明）/ 离店
  state         text NOT NULL DEFAULT 'none' CHECK (state IN ('none', 'at', 'left', 'gone')),
  floor_id      bigint REFERENCES floors (id),
  zone_id       bigint REFERENCES zones (id),
  space_id      bigint REFERENCES spaces (id),
  -- 进入这里的时刻与当前轨迹段
  since         timestamptz,
  track_id      bigint REFERENCES location_tracks (id),
  -- 最近一条生效事件
  last_at       timestamptz,
  last_event_id bigint REFERENCES location_events (id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((visit_id IS NULL) <> (technician_id IS NULL)),
  CHECK ((state = 'at') = (floor_id IS NOT NULL)),
  CHECK ((state = 'at') = (track_id IS NOT NULL)),
  CHECK ((state = 'at') = (since IS NOT NULL)),
  CHECK (floor_id IS NOT NULL OR (zone_id IS NULL AND space_id IS NULL)),
  CHECK ((state = 'none') = (last_event_id IS NULL)),
  CHECK ((last_at IS NULL) = (last_event_id IS NULL))
);
CREATE INDEX current_locations_at_idx ON current_locations (floor_id, zone_id, space_id) WHERE state = 'at';

-- ───────────── 价目项目在哪个区消费（后台配；没配的项目不推导） ─────────────
ALTER TABLE service_items ADD COLUMN zone_id bigint REFERENCES zones (id);

-- ───────────── 模拟刷卡的「结果待确认」：确认作废登记加上刷卡上报（Codex 复审 PR #33） ─────────────
-- 刷卡上报的操作编号记在位置事件上（location_events.op_key）；作废登记 = 编号 + location_report，原请求晚到也不记
ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'checkin', 'bill_post', 'tag_swap', 'checkout', 'table_open', 'table_post', 'table_checkout',
                     'room_checkin', 'room_extend', 'room_deposit', 'room_refund', 'room_close', 'line_move',
                     'expense_claim', 'petty_advance', 'petty_settlement', 'purchase_request', 'ap_offset', 'supplier_refund', 'erp_import',
                     'supplier_recon', 'supplier_recon_void', 'space_import', 'location_report'));
