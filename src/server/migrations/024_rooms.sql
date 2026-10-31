-- S7 客房（ROADMAP 第 10 节第 3 项，v0.7.4，店主 2026-10-31 选定；见 docs/ROOMS.md）：
--   · 房型（全天房按晚、钟点房按段）与房间（房号、楼层、打扫状态）；停用不删除；
--   · 入住单（room_stays）：一间房同时只有一个在住单；洗浴客人的房费挂在手牌账单上，只住房的客人单独开客房账单（bills.kind = 'room'）；
--   · 房费（room_stay_charges）：每一晚 / 每一段对应一条账单明细，同一晚、同一段只挂一次；
--   · 押金台账（room_deposits，只追加）：收、退、退房结账时抵扣、反结账时恢复，按收款方式；收、退记经办人当班的班次；
--   · 结账单可以结入住单（checkout_bills.room_stay_id）；收款方式加「押金抵扣」（checkout_payments.method = 'deposit'）；
--   · 幂等与作废登记加客房的业务类型。
-- 只加表、加列、放宽约束，不改已有数据。

-- ───────────── 房型 ─────────────
CREATE TABLE room_types (
  id            bigserial PRIMARY KEY,
  name          text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 16),
  kind          text NOT NULL CHECK (kind IN ('daily', 'hourly')),
  -- 分：全天房每晚、钟点房每段（房费是账单明细，单价要大于 0）
  price         integer NOT NULL CHECK (price BETWEEN 1 AND 10000000),
  -- 钟点房每段分钟；全天房为空
  block_minutes integer CHECK (block_minutes BETWEEN 30 AND 720),
  sort_order    integer NOT NULL DEFAULT 0,
  active        boolean NOT NULL DEFAULT true,
  created_by    bigint REFERENCES staff (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'hourly') = (block_minutes IS NOT NULL))
);
CREATE UNIQUE INDEX room_types_name_uq ON room_types (lower(btrim(name)));
CREATE TRIGGER room_types_no_delete BEFORE DELETE ON room_types
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_delete();

-- ───────────── 房间 ─────────────
CREATE TABLE rooms (
  id               bigserial PRIMARY KEY,
  room_no          text NOT NULL CHECK (char_length(btrim(room_no)) BETWEEN 1 AND 8),
  floor            text NOT NULL DEFAULT '' CHECK (char_length(floor) <= 8),
  room_type_id     bigint NOT NULL REFERENCES room_types (id),
  -- 打扫状态：已打扫（没人住时就是空闲）、待打扫、维修（要写原因）；在住看有没有未退房的入住单
  housekeeping     text NOT NULL DEFAULT 'clean' CHECK (housekeeping IN ('clean', 'dirty', 'maintenance')),
  maintenance_note text CHECK (char_length(btrim(maintenance_note)) BETWEEN 2 AND 100),
  sort_order       integer NOT NULL DEFAULT 0,
  active           boolean NOT NULL DEFAULT true,
  created_by       bigint REFERENCES staff (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((housekeeping = 'maintenance') = (maintenance_note IS NOT NULL))
);
CREATE UNIQUE INDEX rooms_no_uq ON rooms (lower(btrim(room_no)));
CREATE TRIGGER rooms_no_delete BEFORE DELETE ON rooms
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_delete();

-- ───────────── 共同账单加「客房账单」类型（只住房的客人） ─────────────
ALTER TABLE bills DROP CONSTRAINT bills_kind_check;
ALTER TABLE bills ADD CONSTRAINT bills_kind_check CHECK (kind IN ('visit', 'table', 'room'));

-- ───────────── 入住单 ─────────────
CREATE TABLE room_stays (
  id                     bigserial PRIMARY KEY,
  stay_no                text NOT NULL UNIQUE,
  -- 现在住的房间（换房时改）；房型与房价按入住时记下，之后改房型的价格不影响
  room_id                bigint NOT NULL REFERENCES rooms (id),
  room_type_id           bigint NOT NULL REFERENCES room_types (id),
  kind                   text NOT NULL CHECK (kind IN ('daily', 'hourly')),
  rate                   integer NOT NULL CHECK (rate BETWEEN 1 AND 10000000),
  block_minutes          integer CHECK (block_minutes BETWEEN 30 AND 720),
  -- 房费挂在哪张账单：洗浴客人是手牌账单（visit_id 非空），只住房的客人是客房账单
  bill_id                bigint NOT NULL REFERENCES bills (id),
  visit_id               bigint REFERENCES visits (id),
  guest_label            text NOT NULL DEFAULT '' CHECK (char_length(guest_label) <= 16),
  guests                 integer NOT NULL CHECK (guests BETWEEN 1 AND 20),
  -- 登记了会员的只住房客人，退房结账时可以用这位会员的储值
  member_id              bigint REFERENCES members (id),
  -- 预计离店的营业日（全天房只做提醒，房费按夜审与退房时间算）
  expected_checkout_date date,
  -- 在住 → 已退房（洗浴客人：房费留在手牌账单上）/ 已结账（只住房的客人）/ 已撤销
  status                 text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'checked_out', 'settled', 'cancelled')),
  business_date          date NOT NULL,
  checked_in_at          timestamptz NOT NULL,
  checked_in_by          bigint NOT NULL REFERENCES staff (id),
  -- 入住的操作编号（结果待确认时据此查回）
  open_key               uuid NOT NULL UNIQUE,
  closed_at              timestamptz,
  closed_by              bigint REFERENCES staff (id),
  close_reason           text CHECK (char_length(close_reason) <= 200),
  CHECK ((kind = 'hourly') = (block_minutes IS NOT NULL)),
  CHECK ((status = 'open') = (closed_at IS NULL)),
  CHECK (status <> 'checked_out' OR visit_id IS NOT NULL),
  CHECK (status <> 'settled' OR visit_id IS NULL)
);
-- 一间房同时只有一个在住单
CREATE UNIQUE INDEX room_stays_room_open_uq ON room_stays (room_id) WHERE status = 'open';
-- 客房账单只属于一个入住单
CREATE UNIQUE INDEX room_stays_own_bill_uq ON room_stays (bill_id) WHERE visit_id IS NULL;
CREATE INDEX room_stays_visit_idx ON room_stays (visit_id) WHERE visit_id IS NOT NULL;
CREATE INDEX room_stays_date_idx ON room_stays (business_date);
CREATE INDEX room_stays_member_idx ON room_stays (member_id);

-- 入住单的保护：不能删除；编号、账单、房型与房价、入住信息不可改；退房、结账、撤销之后不能再改，
-- 只有反结账的事务（yuzu.reopen）允许「已结账 → 在住」
CREATE FUNCTION yuzu_room_stay_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '入住单禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.stay_no, NEW.room_type_id, NEW.kind, NEW.rate, NEW.block_minutes, NEW.bill_id, NEW.visit_id,
      NEW.business_date, NEW.checked_in_at, NEW.checked_in_by, NEW.open_key)
     IS DISTINCT FROM (OLD.id, OLD.stay_no, OLD.room_type_id, OLD.kind, OLD.rate, OLD.block_minutes, OLD.bill_id, OLD.visit_id,
      OLD.business_date, OLD.checked_in_at, OLD.checked_in_by, OLD.open_key) THEN
    RAISE EXCEPTION '入住单编号、账单、房价与入住信息不可修改' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'settled' AND NEW.status = 'open' AND NEW.closed_at IS NULL AND NEW.closed_by IS NULL
     AND (NEW.room_id, NEW.guest_label, NEW.guests, NEW.member_id, NEW.expected_checkout_date)
         IS NOT DISTINCT FROM (OLD.room_id, OLD.guest_label, OLD.guests, OLD.member_id, OLD.expected_checkout_date)
     AND current_setting('yuzu.reopen', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION '已退房、已结账或已撤销的入住单不可修改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER room_stays_guard BEFORE UPDATE OR DELETE ON room_stays
  FOR EACH ROW EXECUTE FUNCTION yuzu_room_stay_guard();

-- ───────────── 房费：每一晚 / 每一段 / 超时半天对应一条账单明细（只追加） ─────────────
CREATE TABLE room_stay_charges (
  id         bigserial PRIMARY KEY,
  stay_id    bigint NOT NULL REFERENCES room_stays (id),
  kind       text NOT NULL CHECK (kind IN ('night', 'half_day', 'block')),
  -- 全天房：哪一晚（营业日）；超时半天：退房的营业日
  night_date date,
  -- 钟点房：第几段
  block_no   integer CHECK (block_no BETWEEN 1 AND 999),
  line_id    bigint NOT NULL UNIQUE REFERENCES bill_lines (id),
  amount     integer NOT NULL CHECK (amount BETWEEN 1 AND 10000000),
  source     text NOT NULL CHECK (source IN ('checkin', 'audit', 'checkout', 'extend')),
  created_by bigint NOT NULL REFERENCES staff (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'block') = (block_no IS NOT NULL)),
  CHECK ((kind = 'block') = (night_date IS NULL))
);
-- 同一晚、同一段只挂一次（作废过的也算挂过：作废是前台有意的更正，不再补）
CREATE UNIQUE INDEX room_stay_charges_night_uq ON room_stay_charges (stay_id, kind, night_date) WHERE kind <> 'block';
CREATE UNIQUE INDEX room_stay_charges_block_uq ON room_stay_charges (stay_id, block_no) WHERE kind = 'block';
CREATE INDEX room_stay_charges_stay_idx ON room_stay_charges (stay_id);
CREATE TRIGGER room_stay_charges_append_only BEFORE UPDATE OR DELETE ON room_stay_charges
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- ───────────── 换房记录（只追加）：账单跟着入住单走 ─────────────
CREATE TABLE room_moves (
  id           bigserial PRIMARY KEY,
  stay_id      bigint NOT NULL REFERENCES room_stays (id),
  from_room_id bigint NOT NULL REFERENCES rooms (id),
  to_room_id   bigint NOT NULL REFERENCES rooms (id),
  reason       text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 2 AND 100),
  operator_id  bigint NOT NULL REFERENCES staff (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (from_room_id <> to_room_id)
);
CREATE INDEX room_moves_stay_idx ON room_moves (stay_id);
CREATE TRIGGER room_moves_append_only BEFORE UPDATE OR DELETE ON room_moves
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- ───────────── 押金台账（只追加） ─────────────
-- 每种收款方式的余额 = 收 − 退 − 抵扣 + 恢复，不能为负（服务端保证，自检核对）。
-- 收、退：经办人当班的班次（现金押金计入交班应有现金）、操作编号；抵扣、恢复：对应的结账单（不动现金）
CREATE TABLE room_deposits (
  id            bigserial PRIMARY KEY,
  stay_id       bigint NOT NULL REFERENCES room_stays (id),
  kind          text NOT NULL CHECK (kind IN ('receive', 'refund', 'apply', 'unapply')),
  method        text NOT NULL CHECK (method IN ('cash', 'wechat', 'alipay', 'bank_card', 'other')),
  amount        integer NOT NULL CHECK (amount BETWEEN 1 AND 10000000),
  ref           text NOT NULL DEFAULT '' CHECK (char_length(ref) <= 64),
  reason        text CHECK (char_length(reason) <= 200),
  checkout_id   bigint REFERENCES checkouts (id),
  shift_id      bigint REFERENCES shifts (id),
  business_date date NOT NULL,
  operator_id   bigint NOT NULL REFERENCES staff (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind IN ('apply', 'unapply')) = (checkout_id IS NOT NULL)),
  CHECK (kind IN ('apply', 'unapply') OR method <> 'other' OR char_length(btrim(ref)) > 0)
);
CREATE INDEX room_deposits_stay_idx ON room_deposits (stay_id);
CREATE INDEX room_deposits_shift_idx ON room_deposits (shift_id) WHERE shift_id IS NOT NULL;
CREATE INDEX room_deposits_date_idx ON room_deposits (business_date);
CREATE INDEX room_deposits_checkout_idx ON room_deposits (checkout_id) WHERE checkout_id IS NOT NULL;
CREATE TRIGGER room_deposits_append_only BEFORE UPDATE OR DELETE ON room_deposits
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- ───────────── 夜审记录（只追加）：可以重复做，每次记一行 ─────────────
CREATE TABLE room_audits (
  id            bigserial PRIMARY KEY,
  business_date date NOT NULL,
  nights        integer NOT NULL CHECK (nights >= 0),
  amount        integer NOT NULL CHECK (amount >= 0),
  run_by        bigint NOT NULL REFERENCES staff (id),
  run_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX room_audits_date_idx ON room_audits (business_date);
CREATE TRIGGER room_audits_append_only BEFORE UPDATE OR DELETE ON room_audits
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- ───────────── 结账单所结的账单：来访、桌台或入住单（只住房的客人） ─────────────
ALTER TABLE checkout_bills ADD COLUMN room_stay_id bigint REFERENCES room_stays (id);
ALTER TABLE checkout_bills DROP CONSTRAINT checkout_bills_owner_check;
ALTER TABLE checkout_bills ADD CONSTRAINT checkout_bills_owner_check CHECK (
  (visit_id IS NOT NULL AND table_session_id IS NULL AND room_stay_id IS NULL AND guests = 1
   AND ticket_type_id IS NOT NULL AND ticket_name IS NOT NULL AND ticket_segments IS NOT NULL AND ticket_amount IS NOT NULL)
  OR
  (visit_id IS NULL AND (table_session_id IS NULL) <> (room_stay_id IS NULL)
   AND ticket_type_id IS NULL AND ticket_name IS NULL AND ticket_segments IS NULL AND ticket_amount IS NULL)
);
CREATE INDEX checkout_bills_room_stay_idx ON checkout_bills (room_stay_id) WHERE room_stay_id IS NOT NULL;

-- ───────────── 收款方式「押金抵扣」：只住房的客人退房结账时用押金抵扣应收 ─────────────
ALTER TABLE checkout_payments DROP CONSTRAINT checkout_payments_method_check;
ALTER TABLE checkout_payments ADD CONSTRAINT checkout_payments_method_check
  CHECK (method IN ('cash', 'wechat', 'alipay', 'bank_card', 'other', 'wallet', 'coupon', 'discount', 'deposit'));

-- ───────────── 幂等与作废登记：入住、续住加段、收押金、退押金、退房、退房结账 ─────────────
ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_op_type_check;
ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'inv_doc', 'purchase_order', 'payment', 'opening_payable',
                     'checkin', 'bill_post', 'tag_swap', 'abandoned', 'checkout', 'table_open', 'table_post', 'table_checkout',
                     'room_checkin', 'room_extend', 'room_deposit', 'room_refund', 'room_close', 'room_checkout'));
ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'checkin', 'bill_post', 'tag_swap', 'checkout', 'table_open', 'table_post', 'table_checkout',
                     'room_checkin', 'room_extend', 'room_deposit', 'room_refund', 'room_close', 'room_checkout'));
