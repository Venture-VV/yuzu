-- S7 客房（ROADMAP 第 10 节第 3 项，v0.7.4，店主 2026-10-31 选定；见 docs/ROOMS.md）：
--   · 房型（全天房按晚、钟点房按段）与房间（房号、楼层、打扫状态）；停用不删除；
--   · 入住单（room_stays）：一间房同时只有一个在住单；住客都是在店的洗浴客人（店主 2026-10-31：门票必选，没有只住房的客人），
--     房费挂在客人的手牌账单上，离店时随手牌一起结账（房价不含洗浴门票，门票照常按门票规则计）；
--   · 房费（room_stay_charges）：每一晚 / 每一段对应一条账单明细，同一晚、同一段只挂一次；
--   · 押金台账（room_deposits，只追加）：收、退，按收款方式；记经办人当班的班次；
--   · 幂等与作废登记加客房的业务类型。
-- 只加表、放宽约束，不改已有数据。

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
  -- 在店的洗浴客人（来访）与房费挂的手牌账单（来访的账单）
  bill_id                bigint NOT NULL REFERENCES bills (id),
  visit_id               bigint NOT NULL REFERENCES visits (id),
  guest_label            text NOT NULL DEFAULT '' CHECK (char_length(guest_label) <= 16),
  guests                 integer NOT NULL CHECK (guests BETWEEN 1 AND 20),
  -- 预计离店的营业日（全天房只做提醒，房费按夜审与退房时间算）
  expected_checkout_date date,
  -- 在住 → 已退房（房费留在手牌账单上，随手牌结账）/ 已撤销
  status                 text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'checked_out', 'cancelled')),
  business_date          date NOT NULL,
  checked_in_at          timestamptz NOT NULL,
  checked_in_by          bigint NOT NULL REFERENCES staff (id),
  -- 入住的操作编号（结果待确认时据此查回）
  open_key               uuid NOT NULL UNIQUE,
  closed_at              timestamptz,
  closed_by              bigint REFERENCES staff (id),
  close_reason           text CHECK (char_length(close_reason) <= 200),
  CHECK ((kind = 'hourly') = (block_minutes IS NOT NULL)),
  CHECK ((status = 'open') = (closed_at IS NULL))
);
-- 一间房同时只有一个在住单
CREATE UNIQUE INDEX room_stays_room_open_uq ON room_stays (room_id) WHERE status = 'open';
CREATE INDEX room_stays_visit_idx ON room_stays (visit_id);
CREATE INDEX room_stays_date_idx ON room_stays (business_date);

-- 入住单的保护：不能删除；编号、账单、来访、房型与房价、入住信息不可改；退房、撤销之后不能再改
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
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION '已退房或已撤销的入住单不可修改' USING ERRCODE = 'P0001';
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
-- 每种收款方式的余额 = 收 − 退，不能为负（服务端保证，自检核对）；退房、撤销入住之后为 0。
-- 收、退都记经办人当班的班次（现金押金计入交班应有现金）。「其他」收的押金要写明收的是什么；退的写原因
CREATE TABLE room_deposits (
  id            bigserial PRIMARY KEY,
  stay_id       bigint NOT NULL REFERENCES room_stays (id),
  kind          text NOT NULL CHECK (kind IN ('receive', 'refund')),
  method        text NOT NULL CHECK (method IN ('cash', 'wechat', 'alipay', 'bank_card', 'other')),
  amount        integer NOT NULL CHECK (amount BETWEEN 1 AND 10000000),
  ref           text NOT NULL DEFAULT '' CHECK (char_length(ref) <= 64),
  reason        text CHECK (char_length(reason) <= 200),
  shift_id      bigint REFERENCES shifts (id),
  business_date date NOT NULL,
  operator_id   bigint NOT NULL REFERENCES staff (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'receive' OR method <> 'other' OR char_length(btrim(ref)) > 0),
  CHECK (kind <> 'refund' OR char_length(btrim(reason)) > 0)
);
CREATE INDEX room_deposits_stay_idx ON room_deposits (stay_id);
CREATE INDEX room_deposits_shift_idx ON room_deposits (shift_id) WHERE shift_id IS NOT NULL;
CREATE INDEX room_deposits_date_idx ON room_deposits (business_date);
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

-- ───────────── 幂等与作废登记：入住、续住加段、收押金、退押金、退房 ─────────────
ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_op_type_check;
ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'inv_doc', 'purchase_order', 'payment', 'opening_payable',
                     'checkin', 'bill_post', 'tag_swap', 'abandoned', 'checkout', 'table_open', 'table_post', 'table_checkout',
                     'room_checkin', 'room_extend', 'room_deposit', 'room_refund', 'room_close'));
ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'checkin', 'bill_post', 'tag_swap', 'checkout', 'table_open', 'table_post', 'table_checkout',
                     'room_checkin', 'room_extend', 'room_deposit', 'room_refund', 'room_close'));
