-- v0.7.15 · 飞书需求 RQ-004 第二段（docs/FLOORPLAN.md）：底图转换——转换批次、每层底图（简化 SVG）、房间轮廓。
-- 上传的图纸本身不进数据库（只记文件名、大小、摘要）；转换结果只追加，启用、换下只改批次的状态。只加表。

CREATE TABLE floorplan_batches (
  id           bigserial PRIMARY KEY,
  file_name    text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 200),
  file_sha256  text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_bytes   bigint NOT NULL CHECK (file_bytes > 0),
  file_format  text NOT NULL CHECK (file_format IN ('dwg', 'dxf')),
  -- 转换程序的版本（同一份图纸、同一版程序只转换一次）
  converter    text NOT NULL CHECK (char_length(converter) BETWEEN 1 AND 40),
  status       text NOT NULL DEFAULT 'converting' CHECK (status IN ('converting', 'ready', 'failed', 'active', 'retired')),
  error        text CHECK (char_length(error) <= 500),
  -- 转换报告：图元与图层统计、图层分类、提示、参数
  report       jsonb,
  read_ms      integer CHECK (read_ms >= 0),
  convert_ms   integer CHECK (convert_ms >= 0),
  note         text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  created_by   bigint NOT NULL REFERENCES staff (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  activated_by bigint REFERENCES staff (id),
  activated_at timestamptz,
  retired_by   bigint REFERENCES staff (id),
  retired_at   timestamptz,
  CHECK ((status = 'converting') = (finished_at IS NULL)),
  CHECK ((status = 'failed') = (error IS NOT NULL)),
  CHECK ((status IN ('active', 'retired')) = (activated_at IS NOT NULL AND activated_by IS NOT NULL)),
  CHECK ((status = 'retired') = (retired_at IS NOT NULL))
);
-- 同时只有一批在用、只有一份在转换；同一份图纸（摘要）、同一版程序只转换一次（失败的可以重传）
CREATE UNIQUE INDEX floorplan_batches_one_active ON floorplan_batches ((true)) WHERE status = 'active';
CREATE UNIQUE INDEX floorplan_batches_one_converting ON floorplan_batches ((true)) WHERE status = 'converting';
CREATE UNIQUE INDEX floorplan_batches_same_file ON floorplan_batches (file_sha256, converter) WHERE status <> 'failed';
CREATE FUNCTION yuzu_floorplan_batch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '底图批次不能删除' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.file_name, NEW.file_sha256, NEW.file_bytes, NEW.file_format, NEW.converter, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.file_name, OLD.file_sha256, OLD.file_bytes, OLD.file_format, OLD.converter, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION '底图批次的文件信息不能改' USING ERRCODE = 'P0001';
  END IF;
  -- 状态只能往前走：转换中 → 待启用 / 失败；待启用 → 在用；在用 → 换下
  IF OLD.status <> NEW.status AND NOT (
       (OLD.status = 'converting' AND NEW.status IN ('ready', 'failed'))
    OR (OLD.status = 'ready' AND NEW.status = 'active')
    OR (OLD.status = 'active' AND NEW.status = 'retired')) THEN
    RAISE EXCEPTION '底图批次的状态不能从 % 改成 %', OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'converting' AND (NEW.report, NEW.read_ms, NEW.convert_ms, NEW.error, NEW.finished_at)
     IS DISTINCT FROM (OLD.report, OLD.read_ms, OLD.convert_ms, OLD.error, OLD.finished_at) THEN
    RAISE EXCEPTION '转换结果不能改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER floorplan_batches_guard BEFORE UPDATE OR DELETE ON floorplan_batches
  FOR EACH ROW EXECUTE FUNCTION yuzu_floorplan_batch_guard();

-- 每层底图：本地坐标 10 毫米一单位，原点在图框左上角，y 向下；frame 是图框的图纸坐标 [x0, y0, x1, y1]
CREATE TABLE floorplan_floors (
  id         bigserial PRIMARY KEY,
  batch_id   bigint NOT NULL REFERENCES floorplan_batches (id),
  floor_code text NOT NULL CHECK (floor_code ~ '^[A-Z][0-9A-Z]{0,3}$'),
  title      text NOT NULL DEFAULT '' CHECK (char_length(title) <= 16),
  width      integer NOT NULL CHECK (width > 0),
  height     integer NOT NULL CHECK (height > 0),
  frame      jsonb NOT NULL,
  svg        text NOT NULL,
  svg_bytes  integer NOT NULL CHECK (svg_bytes > 0),
  path_count integer NOT NULL CHECK (path_count >= 0),
  UNIQUE (batch_id, floor_code)
);

-- 房间轮廓：每个编码一行；没配上轮廓的（例外）只有文字位置
CREATE TABLE floorplan_rooms (
  id            bigserial PRIMARY KEY,
  batch_id      bigint NOT NULL REFERENCES floorplan_batches (id),
  floor_code    text NOT NULL,
  code          text NOT NULL CHECK (code ~ '^[A-Z][0-9A-Z]{1,7}$'),
  label         text NOT NULL DEFAULT '' CHECK (char_length(label) <= 60),
  status        text NOT NULL CHECK (status IN ('ok', 'leak', 'merged', 'no_seed', 'duplicate')),
  merged_with   text[] NOT NULL DEFAULT '{}',
  close_mm      integer CHECK (close_mm > 0),
  polygon       jsonb,
  label_x       integer NOT NULL,
  label_y       integer NOT NULL,
  area_centi_m2 integer CHECK (area_centi_m2 >= 0),
  UNIQUE (batch_id, floor_code, code),
  FOREIGN KEY (batch_id, floor_code) REFERENCES floorplan_floors (batch_id, floor_code),
  CHECK ((status = 'ok') = (polygon IS NOT NULL))
);
CREATE INDEX floorplan_rooms_code_idx ON floorplan_rooms (code);

-- 底图与轮廓只追加
CREATE FUNCTION yuzu_floorplan_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '底图与房间轮廓只追加，不能修改或删除' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER floorplan_floors_append_only BEFORE UPDATE OR DELETE ON floorplan_floors
  FOR EACH ROW EXECUTE FUNCTION yuzu_floorplan_append_only();
CREATE TRIGGER floorplan_rooms_append_only BEFORE UPDATE OR DELETE ON floorplan_rooms
  FOR EACH ROW EXECUTE FUNCTION yuzu_floorplan_append_only();
