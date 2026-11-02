-- 036 平面图收尾（v0.7.19，docs/FLOORPLAN_FINISH.md）：
--   ① 派对房、宠物轰趴房、娱乐室「开单即占用」的使用单（D37 / D39）
--   ② 对客导览：区域的导览分类与颜色、设施图标
--   ③ 图纸治理：入库登记（来源、版本、收图日期）、PDF 图纸与比例、可选保存原图纸、启用 / 换下 / 换回的历史，已换下的批次可以换回
--   ④ 例外房间补画的轮廓
-- 只加表、加列、放宽约束；升级后没有使用单与图标，区域都按「公共」，批次的登记信息为空，原有功能不变。

-- ───────────── ① 使用单 ─────────────
CREATE TABLE space_usages (
  id            bigserial PRIMARY KEY,
  usage_no      text NOT NULL UNIQUE CHECK (char_length(usage_no) BETWEEN 1 AND 32),
  space_id      bigint NOT NULL REFERENCES spaces (id),
  -- 使用人：在店客人（手牌账单上记费用）
  visit_id      bigint NOT NULL REFERENCES visits (id),
  bill_id       bigint NOT NULL REFERENCES bills (id),
  guests        integer NOT NULL DEFAULT 1 CHECK (guests BETWEEN 1 AND 99),
  note          text NOT NULL DEFAULT '' CHECK (char_length(note) <= 100),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
  business_date date NOT NULL,
  opened_at     timestamptz NOT NULL,
  opened_by     bigint NOT NULL REFERENCES staff (id),
  open_key      uuid NOT NULL UNIQUE,
  closed_at     timestamptz,
  closed_by     bigint REFERENCES staff (id),
  -- 怎么结束的：手动结束 / 使用人结账 / 撤销来访 / 开错了撤单
  close_kind    text CHECK (close_kind IN ('end', 'checkout', 'visit_cancel', 'cancel')),
  close_reason  text CHECK (char_length(close_reason) <= 200),
  CHECK ((status = 'open') = (closed_at IS NULL)),
  CHECK ((status = 'open') = (close_kind IS NULL)),
  CHECK ((status = 'open') OR closed_by IS NOT NULL),
  CHECK ((status = 'cancelled') = (close_kind = 'cancel')),
  CHECK (close_kind <> 'cancel' OR char_length(btrim(close_reason)) >= 2)
);
-- 同一间房同时只有一张开着的使用单
CREATE UNIQUE INDEX space_usages_one_open ON space_usages (space_id) WHERE status = 'open';
CREATE INDEX space_usages_visit_open_idx ON space_usages (visit_id) WHERE status = 'open';
CREATE INDEX space_usages_date_idx ON space_usages (business_date);

-- 只能从「开着」变成「结束 / 撤单」，结束后不能再改；不能删
CREATE FUNCTION yuzu_space_usage_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '使用单不能删除' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION '使用单已经结束，不能再改' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.usage_no, NEW.space_id, NEW.visit_id, NEW.bill_id, NEW.guests, NEW.note, NEW.business_date, NEW.opened_at, NEW.opened_by, NEW.open_key)
     IS DISTINCT FROM (OLD.usage_no, OLD.space_id, OLD.visit_id, OLD.bill_id, OLD.guests, OLD.note, OLD.business_date, OLD.opened_at, OLD.opened_by, OLD.open_key) THEN
    RAISE EXCEPTION '使用单的开单信息不能改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER space_usages_guard BEFORE UPDATE OR DELETE ON space_usages
  FOR EACH ROW EXECUTE FUNCTION yuzu_space_usage_guard();

-- 操作编号与「确认作废」登记认开单、结束、撤单
ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_op_type_check;
ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'inv_doc', 'purchase_order', 'payment', 'opening_payable', 'checkin', 'bill_post', 'tag_swap',
                     'abandoned', 'checkout', 'table_open', 'table_post', 'table_checkout', 'room_checkin', 'room_extend', 'room_deposit', 'room_refund',
                     'room_close', 'line_move', 'expense_claim', 'petty_advance', 'petty_settlement', 'purchase_request', 'ap_offset', 'supplier_refund',
                     'erp_import', 'supplier_recon', 'supplier_recon_void', 'space_import', 'usage_open', 'usage_end', 'usage_cancel'));
ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'checkin', 'bill_post', 'tag_swap', 'checkout', 'table_open', 'table_post', 'table_checkout',
                     'room_checkin', 'room_extend', 'room_deposit', 'room_refund', 'room_close', 'line_move',
                     'expense_claim', 'petty_advance', 'petty_settlement', 'purchase_request', 'ap_offset', 'supplier_refund', 'erp_import',
                     'supplier_recon', 'supplier_recon_void', 'space_import', 'location_report', 'usage_open', 'usage_end', 'usage_cancel'));

-- 实时位置：开单时使用人到那间房、结束 / 撤单时离开（来源与单据类型加使用单）
ALTER TABLE location_events DROP CONSTRAINT location_events_source_check;
ALTER TABLE location_events ADD CONSTRAINT location_events_source_check
  CHECK (source IN ('reader', 'position', 'checkin', 'consume', 'room_checkin', 'room_move', 'room_close',
                    'session_start', 'session_room', 'session_end', 'sign_in', 'sign_out', 'checkout', 'visit_cancel',
                    'usage_open', 'usage_close'));
ALTER TABLE location_events DROP CONSTRAINT location_events_ref_type_check;
ALTER TABLE location_events ADD CONSTRAINT location_events_ref_type_check
  CHECK (ref_type IN ('visit', 'bill_line', 'room_stay', 'technician_session', 'checkout', 'space_usage'));

-- ───────────── ② 对客导览 ─────────────
-- 导览分类：动区（暖色）、静区（冷色）、公共（浅中性色）、后场（不显示）；颜色可单独指定
ALTER TABLE zones ADD COLUMN guide_kind text NOT NULL DEFAULT 'public' CHECK (guide_kind IN ('active', 'quiet', 'public', 'back'));
ALTER TABLE zones ADD COLUMN guide_color text CHECK (guide_color ~ '^#[0-9a-f]{6}$');

-- 设施图标：按楼层、存图纸坐标（毫米，换了底图也能对上位置）；自动识别的可以挪、藏，手工的可以加
CREATE TABLE guide_markers (
  id         bigserial PRIMARY KEY,
  floor_code text NOT NULL CHECK (floor_code ~ '^[A-Z][0-9A-Z]{0,3}$'),
  kind       text NOT NULL CHECK (kind IN ('toilet', 'elevator', 'stairs', 'reception', 'entrance', 'locker', 'dining', 'smoking')),
  x_mm       integer NOT NULL,
  y_mm       integer NOT NULL,
  label      text NOT NULL DEFAULT '' CHECK (char_length(label) <= 24),
  label_en   text NOT NULL DEFAULT '' CHECK (char_length(label_en) <= 48),
  source     text NOT NULL CHECK (source IN ('auto', 'manual')),
  hidden     boolean NOT NULL DEFAULT false,
  version    integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by bigint REFERENCES staff (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX guide_markers_floor_idx ON guide_markers (floor_code);

-- ───────────── ③ 图纸治理 ─────────────
ALTER TABLE floorplan_batches DROP CONSTRAINT floorplan_batches_file_format_check;
ALTER TABLE floorplan_batches ADD CONSTRAINT floorplan_batches_file_format_check CHECK (file_format IN ('dwg', 'dxf', 'pdf'));
-- 入库登记：图纸来源、版本或说明、收图日期；PDF 的比例（1:N）；是否保存了原图纸；换下的原因
ALTER TABLE floorplan_batches ADD COLUMN source_kind text CHECK (source_kind IN ('designer', 'store', 'other'));
ALTER TABLE floorplan_batches ADD COLUMN source_note text NOT NULL DEFAULT '' CHECK (char_length(source_note) <= 100);
ALTER TABLE floorplan_batches ADD COLUMN received_on date;
ALTER TABLE floorplan_batches ADD COLUMN pdf_scale integer CHECK (pdf_scale BETWEEN 1 AND 10000);
ALTER TABLE floorplan_batches ADD COLUMN original_saved boolean NOT NULL DEFAULT false;
ALTER TABLE floorplan_batches ADD COLUMN retire_reason text CHECK (char_length(retire_reason) <= 200);

-- 批次守护：文件信息与入库登记不能改；状态多一条「已换下 → 在用」（写原因换回旧底图）；不能删
CREATE OR REPLACE FUNCTION yuzu_floorplan_batch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '底图批次不能删除' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.file_name, NEW.file_sha256, NEW.file_bytes, NEW.file_format, NEW.converter, NEW.created_by, NEW.created_at,
      NEW.source_kind, NEW.source_note, NEW.received_on, NEW.pdf_scale, NEW.original_saved)
     IS DISTINCT FROM (OLD.file_name, OLD.file_sha256, OLD.file_bytes, OLD.file_format, OLD.converter, OLD.created_by, OLD.created_at,
      OLD.source_kind, OLD.source_note, OLD.received_on, OLD.pdf_scale, OLD.original_saved) THEN
    RAISE EXCEPTION '底图批次的文件信息与入库登记不能改' USING ERRCODE = 'P0001';
  END IF;
  -- 状态：转换中 → 待启用 / 失败；待启用 → 在用；在用 → 换下；换下 → 在用（换回旧底图）
  IF OLD.status <> NEW.status AND NOT (
       (OLD.status = 'converting' AND NEW.status IN ('ready', 'failed'))
    OR (OLD.status = 'ready' AND NEW.status = 'active')
    OR (OLD.status = 'active' AND NEW.status = 'retired')
    OR (OLD.status = 'retired' AND NEW.status = 'active')) THEN
    RAISE EXCEPTION '底图批次的状态不能从 % 改成 %', OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'converting' AND (NEW.report, NEW.read_ms, NEW.convert_ms, NEW.error, NEW.finished_at)
     IS DISTINCT FROM (OLD.report, OLD.read_ms, OLD.convert_ms, OLD.error, OLD.finished_at) THEN
    RAISE EXCEPTION '转换结果不能改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- 保存的原图纸（上传时勾了才有），与批次分表；只追加
CREATE TABLE floorplan_originals (
  batch_id   bigint PRIMARY KEY REFERENCES floorplan_batches (id),
  content    bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER floorplan_originals_append_only BEFORE UPDATE OR DELETE ON floorplan_originals
  FOR EACH ROW EXECUTE FUNCTION yuzu_floorplan_append_only();

-- 在用历史：启用、换下、换回，每次一行（只追加）
CREATE TABLE floorplan_activations (
  id         bigserial PRIMARY KEY,
  batch_id   bigint NOT NULL REFERENCES floorplan_batches (id),
  kind       text NOT NULL CHECK (kind IN ('activate', 'retire', 'restore')),
  at         timestamptz NOT NULL,
  staff_id   bigint REFERENCES staff (id),
  reason     text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 200),
  CHECK (kind <> 'restore' OR char_length(btrim(reason)) >= 2)
);
CREATE INDEX floorplan_activations_batch_idx ON floorplan_activations (batch_id, at, id);
CREATE TRIGGER floorplan_activations_append_only BEFORE UPDATE OR DELETE ON floorplan_activations
  FOR EACH ROW EXECUTE FUNCTION yuzu_floorplan_append_only();
-- 升级前的启用与换下补成历史
INSERT INTO floorplan_activations (batch_id, kind, at, staff_id)
  SELECT id, 'activate', activated_at, activated_by FROM floorplan_batches WHERE activated_at IS NOT NULL;
INSERT INTO floorplan_activations (batch_id, kind, at, staff_id)
  SELECT id, 'retire', retired_at, retired_by FROM floorplan_batches WHERE retired_at IS NOT NULL;

-- ───────────── ④ 例外房间补画的轮廓 ─────────────
-- 按批次存（转换结果本身不改），本地坐标与 floorplan_rooms 同一套；重画时旧的作废、留历史
CREATE TABLE floorplan_room_outlines (
  id            bigserial PRIMARY KEY,
  batch_id      bigint NOT NULL REFERENCES floorplan_batches (id),
  floor_code    text NOT NULL,
  code          text NOT NULL CHECK (code ~ '^[A-Z][0-9A-Z]{1,7}$'),
  polygon       jsonb NOT NULL,
  area_centi_m2 integer NOT NULL CHECK (area_centi_m2 >= 0),
  created_by    bigint NOT NULL REFERENCES staff (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  voided_by     bigint REFERENCES staff (id),
  voided_at     timestamptz,
  FOREIGN KEY (batch_id, floor_code, code) REFERENCES floorplan_rooms (batch_id, floor_code, code),
  CHECK ((voided_at IS NULL) = (voided_by IS NULL))
);
CREATE UNIQUE INDEX floorplan_room_outlines_live ON floorplan_room_outlines (batch_id, code) WHERE voided_at IS NULL;
