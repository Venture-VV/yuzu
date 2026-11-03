-- 038 硬件连接（v0.7.21，飞书需求 RQ-001，docs/HARDWARE.md）：
--   ① 设备登记：打印机、标签机、读卡器、扫码、终端、打印服务器，每台一行（编号、型号、区域、接法、IP 与端口、挂在哪台终端或打印服务器下）
--   ② 打印任务：测试页、测试标签（按台排队；带操作编号，同一编号只打一张）
--   ③ 设备事件：状态变化、读卡、扫码、错误（只追加）
-- 只加表、放宽约束；升级后没有设备，原有功能不变。

CREATE TABLE devices (
  id                bigserial PRIMARY KEY,
  code              text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{1,31}$'),
  name              text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  kind              text NOT NULL CHECK (kind IN ('printer', 'label_printer', 'card_reader', 'scanner', 'terminal', 'print_server')),
  brand             text NOT NULL DEFAULT '' CHECK (char_length(brand) <= 40),
  model             text NOT NULL DEFAULT '' CHECK (char_length(model) <= 60),
  area              text NOT NULL CHECK (char_length(btrim(area)) BETWEEN 1 AND 20),
  connection        text NOT NULL CHECK (connection IN ('network', 'print_server', 'bridge', 'keyboard', 'none')),
  -- 网口直连、经打印服务器：IP（或主机名）与端口；现场填，没填时状态「还没配好」
  host              text CHECK (host IS NULL OR char_length(host) BETWEEN 1 AND 253),
  port              integer CHECK (port IS NULL OR port BETWEEN 1 AND 65535),
  -- 挂在哪台终端（读卡、扫码）或打印服务器（USB 打印机）下；桥里这台设备的键（同一台终端下唯一）
  host_device_id    bigint REFERENCES devices (id),
  bridge_key        text CHECK (bridge_key IS NULL OR bridge_key ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  -- 纸宽、标签语言与尺寸（打印机、标签机）
  options           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(options) = 'object'),
  enabled           boolean NOT NULL DEFAULT true,
  -- 状态：心跳（网口）与终端上报（桥）维护；原因码见 src/shared/devices.ts
  status            text NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown', 'online', 'offline', 'error')),
  status_code       text CHECK (status_code IS NULL OR char_length(status_code) <= 40),
  last_seen_at      timestamptz,
  status_changed_at timestamptz,
  -- 采购清单的哪一行（按清单导入的）
  catalog_key       text CHECK (catalog_key IS NULL OR char_length(catalog_key) <= 40),
  note              text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  client_key        uuid UNIQUE,
  version           integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by        bigint REFERENCES staff (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (host_device_id IS NULL OR host_device_id <> id),
  CHECK ((connection = 'bridge') = (bridge_key IS NOT NULL))
);
-- 同一台终端下设备键唯一（还没指定终端的可以重复）
CREATE UNIQUE INDEX devices_bridge_key_uq ON devices (host_device_id, bridge_key) WHERE host_device_id IS NOT NULL AND bridge_key IS NOT NULL;
CREATE INDEX devices_area_idx ON devices (area, code);
-- 设备不能删除，只能停用
CREATE TRIGGER devices_no_delete BEFORE DELETE ON devices FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_delete();

CREATE TABLE device_jobs (
  id            bigserial PRIMARY KEY,
  device_id     bigint NOT NULL REFERENCES devices (id),
  kind          text NOT NULL CHECK (kind IN ('test_page', 'label_test')),
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'done', 'failed')),
  attempts      integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error_code    text CHECK (error_code IS NULL OR char_length(error_code) <= 40),
  error_message text CHECK (error_message IS NULL OR char_length(error_message) <= 300),
  client_key    uuid NOT NULL UNIQUE,
  created_by    bigint NOT NULL REFERENCES staff (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  CHECK ((status IN ('done', 'failed')) = (finished_at IS NOT NULL)),
  CHECK ((status = 'failed') = (error_code IS NOT NULL))
);
CREATE INDEX device_jobs_device_idx ON device_jobs (device_id, id DESC);
CREATE INDEX device_jobs_open_idx ON device_jobs (status) WHERE status IN ('queued', 'sending');
CREATE TRIGGER device_jobs_no_delete BEFORE DELETE ON device_jobs FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_delete();

CREATE TABLE device_events (
  id         bigserial PRIMARY KEY,
  device_id  bigint REFERENCES devices (id),
  type       text NOT NULL CHECK (type IN ('status', 'card', 'scan', 'error')),
  data       jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object'),
  -- 终端上报的读卡、扫码事件带编号，重发不会记两次
  event_key  uuid UNIQUE,
  staff_id   bigint REFERENCES staff (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX device_events_device_idx ON device_events (device_id, id DESC);
CREATE INDEX device_events_type_idx ON device_events (type, id DESC);
CREATE TRIGGER device_events_append_only BEFORE UPDATE OR DELETE ON device_events
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- 「结果待确认」的作废登记：新增登记设备、打印任务（同 ERP 一套查回与确认作废）
ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'checkin', 'bill_post', 'tag_swap', 'checkout', 'table_open', 'table_post', 'table_checkout',
                     'room_checkin', 'room_extend', 'room_deposit', 'room_refund', 'room_close', 'line_move',
                     'expense_claim', 'petty_advance', 'petty_settlement', 'purchase_request', 'ap_offset', 'supplier_refund', 'erp_import',
                     'supplier_recon', 'supplier_recon_void', 'space_import', 'location_report', 'usage_open', 'usage_end', 'usage_cancel',
                     'checkout_refund', 'coupon_template', 'coupon_rule', 'coupon_batch', 'coupon_issue',
                     'device_create', 'device_job'));
