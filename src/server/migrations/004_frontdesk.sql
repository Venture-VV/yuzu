-- 浴族 yuzu · S2 到店与未结手牌（增量迁移，不改动会员钱包、库存与采购的任何已有表或数据）
-- 约定：
--   · 手牌只记「是否锁定 / 是否启用」；是否在店由「有没有未结来访」决定，部分唯一索引保证一牌一人；
--   · 共同账单 bills 只汇总消费明细，没有余额，不是第二套会员钱包。本阶段不收款，
--     不写 consumptions / ledger_entries；S3 结账时才在同一事务内调用会员钱包扣款；
--   · 消费明细只追加：更正 = 作废原明细（必须填写原因）后重新登记，项目、单价、数量不可直接修改；
--   · 加锁顺序固定为：手牌（id 升序）→ 同行组（id 升序）→ 来访 / 账单（id 升序）→ 会员（S3 起）；
--   · 合成演示数据只在手牌上标记 is_synthetic，来访、账单与明细随所用手牌判断。

-- ───────────── 经营设置（模拟规则，待确认） ─────────────
INSERT INTO settings (key, value) VALUES
  -- 店员可在多少分钟内自行作废本人刚登记的明细 / 撤销本人刚开的牌；超过后需店主处理
  ('frontdesk_rules', '{"selfVoidMinutes": 10}')
ON CONFLICT (key) DO NOTHING;

-- ───────────── 手牌池 ─────────────
CREATE TABLE hand_tags (
  id           bigserial PRIMARY KEY,
  -- 牌号：0–2 位大写字母前缀 + 1–5 位数字，例如 A023、1088
  code         text NOT NULL UNIQUE CHECK (code ~ '^[A-Z]{0,2}[0-9]{1,5}$'),
  -- 分区：男宾 / 女宾 / 儿童。接待时宾客分区必须与手牌一致（防发错男女牌）
  zone         text NOT NULL CHECK (zone IN ('male', 'female', 'child')),
  locked       boolean NOT NULL DEFAULT false,
  lock_reason  text CHECK (char_length(lock_reason) BETWEEN 2 AND 100),
  locked_by    bigint REFERENCES staff (id),
  locked_at    timestamptz,
  active       boolean NOT NULL DEFAULT true,
  is_synthetic boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (locked = (lock_reason IS NOT NULL))
);

-- ───────────── 同行组（联牌） ─────────────
CREATE TABLE visit_groups (
  id            bigserial PRIMARY KEY,
  group_no      text NOT NULL UNIQUE,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  business_date date NOT NULL,
  created_by    bigint NOT NULL REFERENCES staff (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz,
  CHECK ((status = 'open') = (closed_at IS NULL))
);

-- ───────────── 共同账单：各模块消费明细的汇聚点（S5 餐饮、S7 客房可新增账单类型） ─────────────
CREATE TABLE bills (
  id            bigserial PRIMARY KEY,
  bill_no       text NOT NULL UNIQUE,
  kind          text NOT NULL CHECK (kind IN ('visit')),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settled', 'cancelled')),
  -- 有效明细的合计与行数（同一事务内随明细更新；自检核对与明细一致）
  amount_cents  bigint NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  line_count    integer NOT NULL DEFAULT 0 CHECK (line_count >= 0),
  business_date date NOT NULL,
  opened_at     timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz,
  CHECK ((status = 'open') = (closed_at IS NULL))
);
CREATE INDEX bills_status_idx ON bills (status);

-- ───────────── 来访：一人一牌，一次来访一张账单 ─────────────
CREATE TABLE visits (
  id            bigserial PRIMARY KEY,
  visit_no      text NOT NULL UNIQUE,
  bill_id       bigint NOT NULL UNIQUE REFERENCES bills (id),
  tag_id        bigint NOT NULL REFERENCES hand_tags (id),
  zone          text NOT NULL CHECK (zone IN ('male', 'female', 'child')),
  member_id     bigint REFERENCES members (id),
  guest_label   text NOT NULL DEFAULT '' CHECK (char_length(guest_label) <= 16),
  group_id      bigint REFERENCES visit_groups (id),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settled', 'cancelled')),
  business_date date NOT NULL,
  checked_in_at timestamptz NOT NULL,
  checked_in_by bigint NOT NULL REFERENCES staff (id),
  -- 同一次接待（含同行多人）共用一个操作编号；重复提交时据此查回同一批来访
  checkin_key   uuid NOT NULL,
  closed_at     timestamptz,
  closed_by     bigint REFERENCES staff (id),
  close_reason  text CHECK (char_length(close_reason) <= 200),
  CHECK ((status = 'open') = (closed_at IS NULL))
);
-- 同一张手牌同时只能有一位在店客人；同一位会员同时只能持一张在店手牌
CREATE UNIQUE INDEX visits_tag_open_uq ON visits (tag_id) WHERE status = 'open';
CREATE UNIQUE INDEX visits_member_open_uq ON visits (member_id) WHERE status = 'open' AND member_id IS NOT NULL;
CREATE INDEX visits_group_idx ON visits (group_id);
CREATE INDEX visits_checkin_key_idx ON visits (checkin_key);
CREATE INDEX visits_date_idx ON visits (business_date);
CREATE INDEX visits_member_idx ON visits (member_id);

-- 换牌记录：账单跟着来访走，不跟着手牌走
CREATE TABLE visit_tag_changes (
  id             bigserial PRIMARY KEY,
  visit_id       bigint NOT NULL REFERENCES visits (id),
  from_tag_id    bigint NOT NULL REFERENCES hand_tags (id),
  to_tag_id      bigint NOT NULL REFERENCES hand_tags (id),
  reason         text NOT NULL CHECK (char_length(reason) BETWEEN 2 AND 100),
  old_tag_locked boolean NOT NULL,
  operator_id    bigint NOT NULL REFERENCES staff (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (from_tag_id <> to_tag_id)
);
CREATE INDEX visit_tag_changes_visit_idx ON visit_tag_changes (visit_id);

-- 同行组进出记录
CREATE TABLE visit_group_events (
  id          bigserial PRIMARY KEY,
  group_id    bigint NOT NULL REFERENCES visit_groups (id),
  visit_id    bigint NOT NULL REFERENCES visits (id),
  action      text NOT NULL CHECK (action IN ('join', 'leave')),
  operator_id bigint NOT NULL REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX visit_group_events_group_idx ON visit_group_events (group_id);
CREATE INDEX visit_group_events_visit_idx ON visit_group_events (visit_id);

-- ───────────── 账单明细（挂账）：价格随明细留存，后续改价不影响 ─────────────
CREATE TABLE bill_lines (
  id            bigserial PRIMARY KEY,
  bill_id       bigint NOT NULL REFERENCES bills (id),
  -- 消费来源：洗浴与项目 / 餐饮（S5）/ 技师（S6）/ 客房（S7）/ 其他
  source        text NOT NULL CHECK (source IN ('bath', 'dining', 'therapist', 'room', 'other')),
  item_id       bigint REFERENCES service_items (id),
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 32),
  unit_price    bigint NOT NULL CHECK (unit_price > 0),
  quantity      integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  amount        bigint NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'voided')),
  -- 同一次挂账提交（可能多行）共用一个操作编号
  post_key      uuid NOT NULL,
  business_date date NOT NULL,
  posted_by     bigint NOT NULL REFERENCES staff (id),
  posted_at     timestamptz NOT NULL DEFAULT now(),
  void_reason   text CHECK (char_length(void_reason) BETWEEN 2 AND 200),
  voided_by     bigint REFERENCES staff (id),
  voided_at     timestamptz,
  CHECK (amount = unit_price * quantity),
  CHECK ((status = 'voided') = (void_reason IS NOT NULL AND voided_by IS NOT NULL AND voided_at IS NOT NULL))
);
CREATE INDEX bill_lines_bill_idx ON bill_lines (bill_id, id);
CREATE INDEX bill_lines_post_key_idx ON bill_lines (post_key);

-- ───────────── 幂等：接待发牌、挂账、换牌 ─────────────
ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_op_type_check;
ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'inv_doc', 'purchase_order', 'payment', 'opening_payable',
                     'checkin', 'bill_post', 'tag_swap'));

-- ───────────── 保护 ─────────────
CREATE TRIGGER visit_tag_changes_append_only BEFORE UPDATE OR DELETE ON visit_tag_changes
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
CREATE TRIGGER visit_group_events_append_only BEFORE UPDATE OR DELETE ON visit_group_events
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- 手牌、同行组禁止删除（历史来访仍引用它们）
CREATE FUNCTION yuzu_forbid_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% 禁止删除', TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER hand_tags_no_delete BEFORE DELETE ON hand_tags
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_delete();
CREATE TRIGGER visit_groups_no_delete BEFORE DELETE ON visit_groups
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_delete();

-- 账单：只能由未结变为已结 / 已撤销；结束后不可再变
CREATE FUNCTION yuzu_bill_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '账单禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.bill_no, NEW.kind, NEW.business_date, NEW.opened_at)
     IS DISTINCT FROM (OLD.id, OLD.bill_no, OLD.kind, OLD.business_date, OLD.opened_at) THEN
    RAISE EXCEPTION '账单编号与开单信息不可修改' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION '已结束的账单不可修改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bills_guard BEFORE UPDATE OR DELETE ON bills
  FOR EACH ROW EXECUTE FUNCTION yuzu_bill_guard();

-- 来访：开牌信息不可修改；结束后不可再变
CREATE FUNCTION yuzu_visit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '来访记录禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.visit_no, NEW.bill_id, NEW.business_date, NEW.checked_in_at, NEW.checked_in_by, NEW.checkin_key)
     IS DISTINCT FROM (OLD.id, OLD.visit_no, OLD.bill_id, OLD.business_date, OLD.checked_in_at, OLD.checked_in_by, OLD.checkin_key) THEN
    RAISE EXCEPTION '来访编号与开牌信息不可修改' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION '已离店或已撤销的来访不可修改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER visits_guard BEFORE UPDATE OR DELETE ON visits
  FOR EACH ROW EXECUTE FUNCTION yuzu_visit_guard();

-- 明细：只能挂在未结账单上；唯一允许的变化是「有效 → 已作废」，其余字段不可改
CREATE FUNCTION yuzu_bill_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bill_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '账单明细禁止删除，请作废并填写原因' USING ERRCODE = 'P0001';
  END IF;
  SELECT status INTO bill_status FROM bills WHERE id = NEW.bill_id;
  IF bill_status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION '账单已结束，不能再挂账或更正' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' THEN
      RAISE EXCEPTION '新登记的明细必须为有效状态' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'active' AND NEW.status = 'voided'
     AND (NEW.id, NEW.bill_id, NEW.source, NEW.item_id, NEW.name, NEW.unit_price, NEW.quantity, NEW.amount,
          NEW.post_key, NEW.business_date, NEW.posted_by, NEW.posted_at)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.bill_id, OLD.source, OLD.item_id, OLD.name, OLD.unit_price, OLD.quantity, OLD.amount,
          OLD.post_key, OLD.business_date, OLD.posted_by, OLD.posted_at) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '账单明细只能作废，不能修改' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER bill_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON bill_lines
  FOR EACH ROW EXECUTE FUNCTION yuzu_bill_line_guard();
