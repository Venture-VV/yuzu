-- v0.7.28 ③（主线）：预约（设计见 docs/SCHEDULE_FINISH.md 第 4 节；小程序第三期 3d，docs/MP_PHASE3.md 第 4 节，MP34–MP37；客房电话预订，飞书 Q17）。
--   · bookings：预约技师（项目 + 技师或不指定）、派对房等（房间 + 时长）、客房（房型 + 预计到店 + 保留到几点）；
--     来源前台 / 电话 / 小程序；状态 待确认 → 已预约 → 已到店 / 已取消 / 爽约；不收订金、不动钱；
--     改时间带版本号；同一位技师、同一间房的重叠在锁里核对（技师一行、空间一行、房型一行），不另装扩展。
--   · 前台的幂等与「确认作废」加业务类型：预约的新建、改动（确认、改时间、到店、取消、爽约）。
-- 只加表、放宽业务类型，不改已有的行。

CREATE TABLE bookings (
  id               bigserial PRIMARY KEY,
  booking_no       text NOT NULL UNIQUE,
  kind             text NOT NULL CHECK (kind IN ('technician', 'space', 'room')),
  source           text NOT NULL CHECK (source IN ('front', 'phone', 'mp')),
  status           text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('pending', 'confirmed', 'arrived', 'cancelled', 'no_show')),
  member_id        bigint REFERENCES members (id),
  guest_name       text NOT NULL DEFAULT '' CHECK (char_length(guest_name) <= 32),
  guest_phone      text NOT NULL DEFAULT '' CHECK (guest_phone = '' OR guest_phone ~ '^1\d{10}$'),
  guests           integer NOT NULL DEFAULT 1 CHECK (guests BETWEEN 1 AND 99),
  item_id          bigint REFERENCES service_items (id),
  technician_id    bigint REFERENCES technicians (id),
  space_id         bigint REFERENCES spaces (id),
  room_type_id     bigint REFERENCES room_types (id),
  starts_at        timestamptz NOT NULL,
  ends_at          timestamptz NOT NULL,
  -- 客房：保留到几点（过了自动释放、记爽约）
  hold_until       timestamptz,
  note             text NOT NULL DEFAULT '' CHECK (char_length(note) <= 100),
  -- 开始那一刻的营业日（看板按它分天）
  business_date    date NOT NULL,
  created_by       bigint NOT NULL REFERENCES staff (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  client_key       uuid NOT NULL UNIQUE,
  request_hash     text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  confirmed_by     bigint REFERENCES staff (id),
  confirmed_at     timestamptz,
  arrived_by       bigint REFERENCES staff (id),
  arrived_at       timestamptz,
  arrival_visit_id bigint REFERENCES visits (id),
  -- 到店转成的单据：派对房的使用单号（技师、客房到店后由前台另行派钟、开房，这里记手牌号）
  arrival_ref      text CHECK (char_length(arrival_ref) <= 32),
  cancelled_by     bigint REFERENCES staff (id),
  cancelled_at     timestamptz,
  cancel_reason    text CHECK (char_length(btrim(cancel_reason)) BETWEEN 2 AND 200),
  no_show_at       timestamptz,
  no_show_by       bigint REFERENCES staff (id),
  version          integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CHECK (ends_at > starts_at),
  CHECK (kind <> 'technician' OR (item_id IS NOT NULL AND space_id IS NULL AND room_type_id IS NULL)),
  CHECK (kind <> 'space' OR (space_id IS NOT NULL AND item_id IS NULL AND technician_id IS NULL AND room_type_id IS NULL)),
  CHECK (kind <> 'room' OR (room_type_id IS NOT NULL AND hold_until IS NOT NULL AND item_id IS NULL AND technician_id IS NULL AND space_id IS NULL)),
  -- 小程序的预约要有会员；前台、电话的要有会员或客人姓名 / 电话
  CHECK (source <> 'mp' OR member_id IS NOT NULL),
  CHECK (member_id IS NOT NULL OR guest_name <> '' OR guest_phone <> ''),
  CHECK ((status = 'arrived') = (arrived_at IS NOT NULL)),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL)),
  CHECK ((status = 'no_show') = (no_show_at IS NOT NULL)),
  CHECK (status = 'pending' OR source <> 'mp' OR confirmed_at IS NOT NULL OR status IN ('cancelled', 'no_show'))
);
CREATE INDEX bookings_day_idx ON bookings (business_date, kind);
CREATE INDEX bookings_tech_idx ON bookings (technician_id, starts_at) WHERE status IN ('pending', 'confirmed');
CREATE INDEX bookings_space_idx ON bookings (space_id, starts_at) WHERE status IN ('pending', 'confirmed');
CREATE INDEX bookings_room_type_idx ON bookings (room_type_id, business_date) WHERE status IN ('pending', 'confirmed');
CREATE INDEX bookings_member_idx ON bookings (member_id, starts_at);
CREATE INDEX bookings_open_idx ON bookings (starts_at) WHERE status IN ('pending', 'confirmed');
CREATE TRIGGER bookings_no_delete BEFORE DELETE ON bookings FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_delete();

ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_op_type_check;
ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'inv_doc', 'purchase_order', 'payment', 'opening_payable', 'checkin', 'bill_post', 'tag_swap',
                     'abandoned', 'checkout', 'table_open', 'table_post', 'table_checkout', 'room_checkin', 'room_extend', 'room_deposit', 'room_refund',
                     'room_close', 'line_move', 'expense_claim', 'petty_advance', 'petty_settlement', 'purchase_request', 'ap_offset', 'supplier_refund',
                     'erp_import', 'supplier_recon', 'supplier_recon_void', 'space_import', 'usage_open', 'usage_end', 'usage_cancel',
                     'checkout_refund', 'booking_create', 'booking_change'));
ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'checkin', 'bill_post', 'tag_swap', 'checkout', 'table_open', 'table_post', 'table_checkout',
                     'room_checkin', 'room_extend', 'room_deposit', 'room_refund', 'room_close', 'line_move',
                     'expense_claim', 'petty_advance', 'petty_settlement', 'purchase_request', 'ap_offset', 'supplier_refund', 'erp_import',
                     'supplier_recon', 'supplier_recon_void', 'space_import', 'location_report', 'usage_open', 'usage_end', 'usage_cancel',
                     'checkout_refund', 'coupon_template', 'coupon_rule', 'coupon_batch', 'coupon_issue',
                     'device_create', 'device_job', 'payment', 'opening_payable', 'grade_adjust', 'benefit_use', 'member_trial',
                     'member_refund', 'member_status', 'member_merge', 'booking_create', 'booking_change'));
