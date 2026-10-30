-- S5 餐饮第二步（ROADMAP 第 10 节）：桌台、开台（不洗浴客人的桌台账单）与桌台结账。
--   · 桌台（dining_tables）：大厅 A1、包间 1……；停用不删除；
--   · 开台（table_sessions）：不洗浴的客人在一张桌台上用餐，一桌一张账单（bills.kind = 'table'）；一张桌台同时只有一个未结的开台；
--   · 结账单可以结桌台账单：checkout_bills 的来访与门票为空，记开台与人数；收款、储值、团购券、优惠授权、班次与手牌结账相同；
--   · 出品单可以属于开台（kitchen_items.table_session_id）。
-- 只加表、加列、放宽约束，不改已有数据：已有的结账账单都是来访账单，人数按 1。

-- ───────────── 桌台 ─────────────
CREATE TABLE dining_tables (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 12),
  area        text NOT NULL DEFAULT '' CHECK (char_length(area) <= 12),
  seats       integer NOT NULL DEFAULT 4 CHECK (seats BETWEEN 1 AND 99),
  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_by  bigint REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX dining_tables_name_uq ON dining_tables (lower(btrim(name)));
CREATE TRIGGER dining_tables_no_delete BEFORE DELETE ON dining_tables
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_delete();

-- ───────────── 共同账单加「桌台账单」类型 ─────────────
ALTER TABLE bills DROP CONSTRAINT bills_kind_check;
ALTER TABLE bills ADD CONSTRAINT bills_kind_check CHECK (kind IN ('visit', 'table'));

-- ───────────── 开台：一桌一张账单 ─────────────
CREATE TABLE table_sessions (
  id            bigserial PRIMARY KEY,
  session_no    text NOT NULL UNIQUE,
  bill_id       bigint NOT NULL UNIQUE REFERENCES bills (id),
  table_id      bigint NOT NULL REFERENCES dining_tables (id),
  -- 用餐人数（报表的结账客人按人数计）
  guests        integer NOT NULL CHECK (guests BETWEEN 1 AND 99),
  guest_label   text NOT NULL DEFAULT '' CHECK (char_length(guest_label) <= 16),
  -- 登记了会员的桌可以用这位会员的储值结账
  member_id     bigint REFERENCES members (id),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settled', 'cancelled')),
  business_date date NOT NULL,
  opened_at     timestamptz NOT NULL,
  opened_by     bigint NOT NULL REFERENCES staff (id),
  -- 同一次开台的操作编号（结果待确认时据此查回）
  open_key      uuid NOT NULL UNIQUE,
  closed_at     timestamptz,
  closed_by     bigint REFERENCES staff (id),
  close_reason  text CHECK (char_length(close_reason) <= 200),
  CHECK ((status = 'open') = (closed_at IS NULL))
);
-- 一张桌台同时只有一个未结的开台
CREATE UNIQUE INDEX table_sessions_table_open_uq ON table_sessions (table_id) WHERE status = 'open';
CREATE INDEX table_sessions_date_idx ON table_sessions (business_date);
CREATE INDEX table_sessions_member_idx ON table_sessions (member_id);

-- 开台的保护：不能删除；编号、账单与开台信息不可改；结账、撤台之后不能再改，只有反结账的事务（yuzu.reopen）允许「已结 → 未结」
CREATE FUNCTION yuzu_table_session_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '开台记录禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.session_no, NEW.bill_id, NEW.business_date, NEW.opened_at, NEW.opened_by, NEW.open_key)
     IS DISTINCT FROM (OLD.id, OLD.session_no, OLD.bill_id, OLD.business_date, OLD.opened_at, OLD.opened_by, OLD.open_key) THEN
    RAISE EXCEPTION '开台编号与开台信息不可修改' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'settled' AND NEW.status = 'open' AND NEW.closed_at IS NULL AND NEW.closed_by IS NULL
     AND (NEW.table_id, NEW.guests, NEW.guest_label, NEW.member_id) IS NOT DISTINCT FROM (OLD.table_id, OLD.guests, OLD.guest_label, OLD.member_id)
     AND current_setting('yuzu.reopen', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION '已结账或已撤台的开台不可修改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER table_sessions_guard BEFORE UPDATE OR DELETE ON table_sessions
  FOR EACH ROW EXECUTE FUNCTION yuzu_table_session_guard();

-- 转台记录（只追加）：账单跟着开台走，不跟着桌台走
CREATE TABLE table_session_moves (
  id            bigserial PRIMARY KEY,
  session_id    bigint NOT NULL REFERENCES table_sessions (id),
  from_table_id bigint NOT NULL REFERENCES dining_tables (id),
  to_table_id   bigint NOT NULL REFERENCES dining_tables (id),
  reason        text NOT NULL CHECK (char_length(reason) BETWEEN 2 AND 100),
  operator_id   bigint NOT NULL REFERENCES staff (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (from_table_id <> to_table_id)
);
CREATE INDEX table_session_moves_session_idx ON table_session_moves (session_id);
CREATE TRIGGER table_session_moves_append_only BEFORE UPDATE OR DELETE ON table_session_moves
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- ───────────── 结账单所结的账单：来访账单或桌台账单 ─────────────
ALTER TABLE checkout_bills
  ALTER COLUMN visit_id DROP NOT NULL,
  ALTER COLUMN ticket_type_id DROP NOT NULL,
  ALTER COLUMN ticket_name DROP NOT NULL,
  ALTER COLUMN ticket_segments DROP NOT NULL,
  ALTER COLUMN ticket_amount DROP NOT NULL,
  ADD COLUMN table_session_id bigint REFERENCES table_sessions (id),
  -- 结账客人：来访账单 1 人，桌台账单按开台人数
  ADD COLUMN guests smallint NOT NULL DEFAULT 1 CHECK (guests BETWEEN 1 AND 99);
ALTER TABLE checkout_bills ADD CONSTRAINT checkout_bills_owner_check CHECK (
  (visit_id IS NOT NULL AND table_session_id IS NULL AND guests = 1
   AND ticket_type_id IS NOT NULL AND ticket_name IS NOT NULL AND ticket_segments IS NOT NULL AND ticket_amount IS NOT NULL)
  OR
  (visit_id IS NULL AND table_session_id IS NOT NULL
   AND ticket_type_id IS NULL AND ticket_name IS NULL AND ticket_segments IS NULL AND ticket_amount IS NULL)
);
CREATE INDEX checkout_bills_table_session_idx ON checkout_bills (table_session_id);

-- ───────────── 出品单可以属于开台 ─────────────
ALTER TABLE kitchen_items
  ALTER COLUMN visit_id DROP NOT NULL,
  ADD COLUMN table_session_id bigint REFERENCES table_sessions (id);
ALTER TABLE kitchen_items ADD CONSTRAINT kitchen_items_owner_check CHECK ((visit_id IS NULL) <> (table_session_id IS NULL));
CREATE INDEX kitchen_items_table_session_idx ON kitchen_items (table_session_id);

-- 出品单保护（与 022 相同，开台也不可改）
CREATE OR REPLACE FUNCTION yuzu_kitchen_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '出品单禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.order_no, NEW.bill_line_id, NEW.visit_id, NEW.table_session_id, NEW.item_id, NEW.station_id, NEW.quantity, NEW.note,
      NEW.business_date, NEW.limit_taken, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.order_no, OLD.bill_line_id, OLD.visit_id, OLD.table_session_id, OLD.item_id, OLD.station_id, OLD.quantity,
      OLD.note, OLD.business_date, OLD.limit_taken, OLD.created_by, OLD.created_at) THEN
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

-- ───────────── 幂等与作废登记：开台、桌台点单、桌台结账 ─────────────
ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_op_type_check;
ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'inv_doc', 'purchase_order', 'payment', 'opening_payable',
                     'checkin', 'bill_post', 'tag_swap', 'abandoned', 'checkout', 'table_open', 'table_post', 'table_checkout'));
ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'checkin', 'bill_post', 'tag_swap', 'checkout', 'table_open', 'table_post', 'table_checkout'));
