-- v0.7.1 S6 技师第二步（ROADMAP 第 10 节）：钟房看板、轮钟排队、上下钟计时、提成。
--   · 钟单（technician_sessions）：一位技师给一位客人的一段连续服务（含加钟）。钱仍只在账单明细里，钟单只记钟数、时长与状态；
--     明细挂账时写上钟单编号（随明细只追加、不可改）。
--   · 技师上牌状态（technician_status）：每位技师一行，记当天在岗 / 休息 / 下牌与轮钟队列里的位置（queue_key 越早越靠前）。
--   · 钟房日志（technician_events，只追加）：上牌、派钟、跳过、上钟、加钟、下钟、退钟、取消，排钟是否公平可以逐条查。
--   · 提成规则版本（commission_rule_versions，只追加）：每次保存是一个新版本，按结账时刻取当时的规则，改规则不影响已结的钟。
-- 只加表、加列，不改已有数据。

CREATE TABLE technician_sessions (
  id               bigserial PRIMARY KEY,
  session_no       text NOT NULL UNIQUE,
  technician_id    bigint NOT NULL REFERENCES technicians (id),
  visit_id         bigint NOT NULL REFERENCES visits (id),
  item_id          bigint NOT NULL REFERENCES service_items (id),
  call_type        text NOT NULL CHECK (call_type IN ('designated', 'rotation')),
  -- 钟数与计划时长（分钟），都含加钟
  clocks           integer NOT NULL CHECK (clocks > 0),
  minutes          integer NOT NULL CHECK (minutes > 0),
  status           text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'serving', 'done', 'cancelled', 'rejected')),
  business_date    date NOT NULL,
  -- 派钟前在轮钟队列里的位置：退钟、取消时按规则回到原位
  queue_key_before timestamptz,
  created_by       bigint NOT NULL REFERENCES staff (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_by       bigint REFERENCES staff (id),
  started_at       timestamptz,
  ended_by         bigint REFERENCES staff (id),
  ended_at         timestamptz,
  void_reason      text CHECK (void_reason IS NULL OR char_length(void_reason) BETWEEN 2 AND 200),
  CONSTRAINT technician_sessions_state_check CHECK (
    (status = 'waiting' AND started_at IS NULL AND ended_at IS NULL) OR
    (status = 'serving' AND started_at IS NOT NULL AND ended_at IS NULL) OR
    (status = 'done' AND started_at IS NOT NULL AND ended_at IS NOT NULL) OR
    (status = 'cancelled' AND started_at IS NULL AND ended_at IS NOT NULL AND void_reason IS NOT NULL) OR
    (status = 'rejected' AND started_at IS NOT NULL AND ended_at IS NOT NULL AND void_reason IS NOT NULL)
  )
);
-- 一位技师同一时间只能在一个钟上
CREATE UNIQUE INDEX technician_sessions_serving_uq ON technician_sessions (technician_id) WHERE status = 'serving';
CREATE INDEX technician_sessions_active_idx ON technician_sessions (technician_id, id) WHERE status IN ('waiting', 'serving');
CREATE INDEX technician_sessions_visit_idx ON technician_sessions (visit_id);
CREATE INDEX technician_sessions_date_idx ON technician_sessions (business_date);

ALTER TABLE bill_lines ADD COLUMN session_id bigint REFERENCES technician_sessions (id);
CREATE INDEX bill_lines_session_idx ON bill_lines (session_id) WHERE session_id IS NOT NULL;

CREATE TABLE technician_status (
  technician_id bigint PRIMARY KEY REFERENCES technicians (id),
  -- 状态只对这个营业日有效；换了营业日没有重新上牌的，按「未上牌」处理
  business_date date NOT NULL,
  state         text NOT NULL CHECK (state IN ('on', 'rest', 'off')),
  queue_key     timestamptz NOT NULL,
  -- 连续被退钟的次数（正常下钟后清零）
  reject_streak integer NOT NULL DEFAULT 0 CHECK (reject_streak >= 0),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    bigint REFERENCES staff (id)
);

CREATE TABLE technician_events (
  id            bigserial PRIMARY KEY,
  technician_id bigint REFERENCES technicians (id),
  session_id    bigint REFERENCES technician_sessions (id),
  kind          text NOT NULL CHECK (kind IN ('sign_in', 'rest', 'back', 'sign_out', 'to_end', 'dispatch', 'skip', 'start', 'extend',
                                              'finish', 'cancel', 'reject', 'queue')),
  detail        jsonb NOT NULL DEFAULT '{}',
  business_date date NOT NULL,
  staff_id      bigint NOT NULL REFERENCES staff (id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX technician_events_date_idx ON technician_events (business_date, id);
CREATE TRIGGER technician_events_append_only BEFORE UPDATE OR DELETE ON technician_events
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

CREATE TABLE commission_rule_versions (
  id           bigserial PRIMARY KEY,
  rules        jsonb NOT NULL,
  effective_at timestamptz NOT NULL DEFAULT now(),
  note         text NOT NULL DEFAULT '' CHECK (char_length(note) <= 100),
  created_by   bigint REFERENCES staff (id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX commission_rule_versions_effective_idx ON commission_rule_versions (effective_at, id);
CREATE TRIGGER commission_rule_versions_append_only BEFORE UPDATE OR DELETE ON commission_rule_versions
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- 明细保护：唯一允许的变化仍是「有效 → 已作废」；钟单编号同样不可改
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
  RAISE EXCEPTION '账单明细只能作废，不能修改' USING ERRCODE = 'P0001';
END $$;
