-- 8.1.15 技师（docs/TECHNICIANS_V8115.md；《浴族系统需求汇总》技师 1–3）：技师管理（名册、组别、班次、休假）与排位播报。
--   ① 名册补四样：花名、类型（足浴 / 按摩 / SPA……清单在 settings 的 technician_kinds）、入职日期、离职日期；组别记在技师上（一位技师一个组）。
--   ② 组别（名称、组长）；班次（名称、起止时间）与排班表（一位技师一天一格：上哪个班 / 排休 / 没排），排班的每次改动另记一条（只追加，临时调班要写原因）。
--   ③ 休假单：申请 → 批准 / 驳回；批了的在休假的那几天不进排位（钟房读的时候算，不靠定时任务），撤回、销假留人与时间。
--   ④ 叫号记录（只追加）：派钟时自动记一条、手动叫号另记一条，主播报终端按它念；播报终端的登记一家店一行。
-- 只加列、加表，已有的数据都满足；不动操作编号与「确认作废」的类型约束。

ALTER TABLE technicians
  ADD COLUMN nickname text NOT NULL DEFAULT '' CHECK (char_length(nickname) <= 16),
  ADD COLUMN kind     text NOT NULL DEFAULT '' CHECK (char_length(kind) <= 12),
  ADD COLUMN hired_on date,
  ADD COLUMN left_on  date,
  ADD COLUMN group_id bigint;

CREATE TABLE technician_groups (
  id         bigserial PRIMARY KEY,
  store_id   bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id),
  name       text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 16),
  -- 组长是组里的一位技师（保存时核对）；没有组长为空
  leader_id  bigint REFERENCES technicians (id),
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 9999),
  active     boolean NOT NULL DEFAULT true,
  note       text NOT NULL DEFAULT '' CHECK (char_length(note) <= 100),
  created_by bigint REFERENCES staff (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX technician_groups_name_uq ON technician_groups (store_id, lower(btrim(name)));
ALTER TABLE technicians ADD CONSTRAINT technicians_group_fk FOREIGN KEY (group_id) REFERENCES technician_groups (id);
CREATE INDEX technicians_group_idx ON technicians (group_id) WHERE group_id IS NOT NULL;

-- 班次：起止是当天的第几分钟（0–1439）；结束不晚于开始表示做到第二天
CREATE TABLE technician_shifts (
  id           bigserial PRIMARY KEY,
  store_id     bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id),
  name         text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 12),
  start_minute integer NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute   integer NOT NULL CHECK (end_minute BETWEEN 0 AND 1439),
  sort_order   integer NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 9999),
  active       boolean NOT NULL DEFAULT true,
  created_by   bigint REFERENCES staff (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX technician_shifts_name_uq ON technician_shifts (store_id, lower(btrim(name)));

-- 排班表：一位技师一天一格。shift_id 有值 = 上这个班；is_rest = 排休；两样都没有 = 没排（清掉的格子留着这一行，不删）
CREATE TABLE technician_schedule (
  technician_id bigint NOT NULL REFERENCES technicians (id),
  work_date     date NOT NULL,
  shift_id      bigint REFERENCES technician_shifts (id),
  is_rest       boolean NOT NULL DEFAULT false,
  updated_by    bigint REFERENCES staff (id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (technician_id, work_date),
  CONSTRAINT technician_schedule_cell_check CHECK (NOT (is_rest AND shift_id IS NOT NULL))
);
CREATE INDEX technician_schedule_date_idx ON technician_schedule (work_date);

-- 排班的改动（只追加）：plan 排班、adjust 临时调班、swap 两人对调；临时调班、对调必须写原因
CREATE TABLE technician_schedule_changes (
  id            bigserial PRIMARY KEY,
  technician_id bigint NOT NULL REFERENCES technicians (id),
  work_date     date NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('plan', 'adjust', 'swap')),
  from_shift_id bigint REFERENCES technician_shifts (id),
  from_rest     boolean NOT NULL DEFAULT false,
  to_shift_id   bigint REFERENCES technician_shifts (id),
  to_rest       boolean NOT NULL DEFAULT false,
  swap_with     bigint REFERENCES technicians (id),
  reason        text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 100),
  staff_id      bigint NOT NULL REFERENCES staff (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT technician_schedule_changes_reason_required CHECK (kind = 'plan' OR char_length(btrim(reason)) >= 2),
  CONSTRAINT technician_schedule_changes_swap_check CHECK ((kind = 'swap') = (swap_with IS NOT NULL))
);
CREATE INDEX technician_schedule_changes_date_idx ON technician_schedule_changes (work_date, id);
CREATE TRIGGER technician_schedule_changes_append_only BEFORE UPDATE OR DELETE ON technician_schedule_changes
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- 休假单：pending 待审批 → approved 已批准 / rejected 已驳回；cancelled = 待审批时撤回，或批准以后销假。
-- client_key 是申请时的操作编号：同一个编号重提返回第一次建的那一张，不会建两张
CREATE TABLE technician_leaves (
  id            bigserial PRIMARY KEY,
  store_id      bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id),
  technician_id bigint NOT NULL REFERENCES technicians (id),
  from_date     date NOT NULL,
  to_date       date NOT NULL,
  leave_type    text NOT NULL CHECK (leave_type IN ('personal', 'sick', 'rest', 'annual', 'other')),
  reason        text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 2 AND 100),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  client_key    uuid NOT NULL UNIQUE,
  applied_by    bigint NOT NULL REFERENCES staff (id),
  applied_at    timestamptz NOT NULL DEFAULT now(),
  decided_by    bigint REFERENCES staff (id),
  decided_at    timestamptz,
  decision_note text NOT NULL DEFAULT '' CHECK (char_length(decision_note) <= 100),
  cancelled_by  bigint REFERENCES staff (id),
  cancelled_at  timestamptz,
  cancel_reason text NOT NULL DEFAULT '' CHECK (char_length(cancel_reason) <= 100),
  CONSTRAINT technician_leaves_range_check CHECK (to_date >= from_date AND to_date - from_date <= 92),
  CONSTRAINT technician_leaves_decided_check CHECK ((decided_by IS NULL) = (decided_at IS NULL)),
  CONSTRAINT technician_leaves_cancelled_check CHECK ((cancelled_by IS NULL) = (cancelled_at IS NULL)),
  CONSTRAINT technician_leaves_state_check CHECK (
    (status = 'pending' AND decided_at IS NULL AND cancelled_at IS NULL) OR
    (status IN ('approved', 'rejected') AND decided_at IS NOT NULL AND cancelled_at IS NULL) OR
    (status = 'cancelled' AND cancelled_at IS NOT NULL)
  )
);
-- 钟房每次取看板都查「今天谁在休假」：只看还占着日子的（待审批、已批准）
CREATE INDEX technician_leaves_open_idx ON technician_leaves (technician_id, from_date, to_date) WHERE status IN ('pending', 'approved');
CREATE INDEX technician_leaves_store_idx ON technician_leaves (store_id, id);

-- 叫号记录（只追加）：dispatch 派钟时自动叫、manual 手动叫号。text 是当时念的那一句（排位号、工号、花名、房间都按叫的那一刻）
CREATE TABLE technician_calls (
  id             bigserial PRIMARY KEY,
  store_id       bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id),
  technician_id  bigint NOT NULL REFERENCES technicians (id),
  session_id     bigint REFERENCES technician_sessions (id),
  kind           text NOT NULL CHECK (kind IN ('dispatch', 'manual')),
  queue_position integer CHECK (queue_position IS NULL OR queue_position > 0),
  room           text NOT NULL DEFAULT '' CHECK (char_length(room) <= 60),
  text           text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 160),
  business_date  date NOT NULL,
  staff_id       bigint NOT NULL REFERENCES staff (id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX technician_calls_store_idx ON technician_calls (store_id, id);
CREATE TRIGGER technician_calls_append_only BEFORE UPDATE OR DELETE ON technician_calls
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- 主播报终端：一家店一行。client_id 是那个浏览器自己记的编号；空 = 现在没有终端负责播报
CREATE TABLE technician_announcer (
  store_id   bigint PRIMARY KEY DEFAULT yuzu_store() REFERENCES stores (id),
  client_id  text CHECK (client_id IS NULL OR char_length(client_id) BETWEEN 8 AND 64),
  label      text NOT NULL DEFAULT '' CHECK (char_length(label) <= 40),
  claimed_by bigint REFERENCES staff (id),
  claimed_at timestamptz,
  seen_at    timestamptz
);
