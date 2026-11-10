-- 8.0.8 前台整改 · 钟房（docs/FRONTDESK_V808.md 第 1 节、第 4 节）：
--   ① 钟房「待派钟」（A01）：前台挂了需要技师的项目、交给钟房派钟（没选技师）的明细，钟房派钟时只把技师与钟单记到这条明细上、不另挂一笔。
--      明细保护原来只允许「有效 → 已作废」；放开一种变化：技师明细（source = therapist）还没有技师时，补记一次技师、上钟方式与钟单，
--      其余字段（金额、价格档、项目……）都不能动，补记过的不能再改。
--   ② 休假、停牌（B01）：技师当天的状态加「休假」（leave，只管当天）；停牌记在技师上（时间、原因、经办人），一直停到复牌。
--   ③ 钟房日志加休假（leave）、停牌（suspend）、复牌（resume）、转钟（transfer）；补派记成派钟（detail 里注明是前台已点的那一条）。
--   ④ 转钟（B05）：新钟单记从哪张转来；预约派钟（A04）：钟单记预约编号，一张预约同时只有一张没取消的钟单。
--   ⑤ 护理项目（A01，F1）：类别或名称含「护理」、还没勾「需要技师」的项目设为需要技师（店主可在后台「技师」里取消）。
-- 只加列、放宽约束、改一个保护函数，已有的数据都满足。

CREATE OR REPLACE FUNCTION yuzu_bill_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
          NEW.post_key, NEW.business_date, NEW.posted_by, NEW.posted_at,
          NEW.tier, NEW.ticket_type_id, NEW.ticket_segments, NEW.technician_id, NEW.call_type, NEW.session_id)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.bill_id, OLD.source, OLD.item_id, OLD.name, OLD.unit_price, OLD.quantity, OLD.amount,
          OLD.post_key, OLD.business_date, OLD.posted_by, OLD.posted_at,
          OLD.tier, OLD.ticket_type_id, OLD.ticket_segments, OLD.technician_id, OLD.call_type, OLD.session_id) THEN
    RETURN NEW;
  END IF;
  -- 8.0.8：钟房给「交给钟房派钟」的技师明细补记技师（只此一次）
  IF OLD.status = 'active' AND NEW.status = 'active' AND OLD.source = 'therapist'
     AND OLD.technician_id IS NULL AND OLD.call_type IS NULL AND OLD.session_id IS NULL
     AND NEW.technician_id IS NOT NULL AND NEW.call_type IS NOT NULL AND NEW.session_id IS NOT NULL
     AND (NEW.id, NEW.bill_id, NEW.source, NEW.item_id, NEW.name, NEW.unit_price, NEW.quantity, NEW.amount,
          NEW.post_key, NEW.business_date, NEW.posted_by, NEW.posted_at,
          NEW.tier, NEW.ticket_type_id, NEW.ticket_segments, NEW.void_reason, NEW.voided_by, NEW.voided_at)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.bill_id, OLD.source, OLD.item_id, OLD.name, OLD.unit_price, OLD.quantity, OLD.amount,
          OLD.post_key, OLD.business_date, OLD.posted_by, OLD.posted_at,
          OLD.tier, OLD.ticket_type_id, OLD.ticket_segments, OLD.void_reason, OLD.voided_by, OLD.voided_at) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '账单明细只能作废，不能修改' USING ERRCODE = 'P0001';
END $$;

-- 待派钟：还没派技师的技师明细
CREATE INDEX bill_lines_unassigned_idx ON bill_lines (bill_id, id)
  WHERE source = 'therapist' AND status = 'active' AND technician_id IS NULL;

ALTER TABLE technician_status DROP CONSTRAINT technician_status_state_check;
ALTER TABLE technician_status ADD CONSTRAINT technician_status_state_check CHECK (state IN ('on', 'rest', 'off', 'leave'));

ALTER TABLE technicians
  ADD COLUMN suspended_at     timestamptz,
  ADD COLUMN suspended_reason text CHECK (suspended_reason IS NULL OR char_length(suspended_reason) BETWEEN 2 AND 100),
  ADD COLUMN suspended_by     bigint REFERENCES staff (id),
  ADD CONSTRAINT technicians_suspended_check CHECK ((suspended_at IS NULL) = (suspended_reason IS NULL) AND (suspended_at IS NULL) = (suspended_by IS NULL));

ALTER TABLE technician_events DROP CONSTRAINT technician_events_kind_check;
ALTER TABLE technician_events ADD CONSTRAINT technician_events_kind_check
  CHECK (kind IN ('sign_in', 'rest', 'back', 'sign_out', 'to_end', 'dispatch', 'skip', 'start', 'extend', 'finish', 'cancel', 'reject', 'queue', 'room',
                  'leave', 'suspend', 'resume', 'transfer'));

ALTER TABLE technician_sessions
  ADD COLUMN transferred_from bigint REFERENCES technician_sessions (id),
  ADD COLUMN booking_id       bigint REFERENCES bookings (id);
-- 一张钟单只能转出一次（转出的那张已经结束）；一张预约同时只有一张没取消的钟单（取消、退钟了可以再派）
CREATE UNIQUE INDEX technician_sessions_transferred_uq ON technician_sessions (transferred_from) WHERE transferred_from IS NOT NULL;
CREATE UNIQUE INDEX technician_sessions_booking_uq ON technician_sessions (booking_id)
  WHERE booking_id IS NOT NULL AND status IN ('waiting', 'serving', 'done');

UPDATE service_items SET technician_required = true
WHERE NOT technician_required AND (category LIKE '%护理%' OR name LIKE '%护理%');
