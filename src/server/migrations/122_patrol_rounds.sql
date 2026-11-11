-- 8.0.11 巡场轮次（店主 2026-11-11，docs/PATROL_V809.md 第 11 节）：营业日按巡场间隔（默认 3 小时）分成几轮，
-- 同一个场所每轮只记一次打卡（XC14）。打卡记下它落在哪一轮（这一轮开始的时刻与当时的巡场间隔），同一个场所同一轮只能有一条
-- 没作废的打卡（唯一索引兜底；判断在「场所」的咨询锁里按时间做）。带上间隔：当天改了间隔以后，新的一轮与改之前的某一轮开始时刻
-- 相同、长短不同，不算同一轮。之前的打卡这两列为空，不受这条约束。
-- 只给自己的表加两列、一条索引，换掉打卡保护触发器的函数（把新的两列也保护起来）；不改任何别的表。

ALTER TABLE patrol_checkins
  ADD COLUMN round_start   timestamptz,
  ADD COLUMN round_minutes integer CHECK (round_minutes BETWEEN 30 AND 1440),
  ADD CONSTRAINT patrol_checkins_round_both CHECK ((round_start IS NULL) = (round_minutes IS NULL));

CREATE UNIQUE INDEX patrol_checkins_round_uq ON patrol_checkins (point_id, round_start, round_minutes)
  WHERE voided_at IS NULL AND round_start IS NOT NULL;

-- 打卡记录的保护：不能删除；除了作废那几列，什么都不能改（含新加的轮次）；作废过的不能再改（XC10）
CREATE OR REPLACE FUNCTION yuzu_patrol_checkin_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '巡场打卡记录禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION '已作废的巡场打卡记录不可修改' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.point_id, NEW.point_name, NEW.employee_id, NEW.emp_no, NEW.employee_name, NEW.department_name, NEW.business_date,
      NEW.scanned_at, NEW.recorded_at, NEW.via, NEW.client_key, NEW.round_start, NEW.round_minutes)
     IS DISTINCT FROM (OLD.id, OLD.point_id, OLD.point_name, OLD.employee_id, OLD.emp_no, OLD.employee_name, OLD.department_name, OLD.business_date,
      OLD.scanned_at, OLD.recorded_at, OLD.via, OLD.client_key, OLD.round_start, OLD.round_minutes) THEN
    RAISE EXCEPTION '巡场打卡记录只能作废，其他内容不可修改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
