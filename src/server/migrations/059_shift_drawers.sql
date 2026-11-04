-- v0.7.28 ⑨（主线）：按钱箱交班（N11，设计见 docs/SCHEDULE_FINISH.md 第 10 节）。
--   · 交班方式是经营规则（settings 表的 shift_mode：person 按人交班，默认、就是现在的做法；drawer 按钱箱交班），钱箱清单也在
--     settings（cash_drawers），都不用迁移；切换后新开的班按新做法，已经开着的班照旧到交班为止；
--   · 班次加钱箱与钱箱名（按钱箱交班开的班才有；钱箱名记开班时的名字）：同一个钱箱同时只有一个未交班的班次；
--   · 当班成员 shift_members：谁在这个班次上、什么时候加入、什么时候离开。收款记到经办人此刻所在的班次（原来是「本人未交班的班次」），
--     按人交班时成员只有开班人自己（开班时加入、交班时离开），与原来一样；按钱箱交班时同一个钱箱的人加入同一个班次，
--     可以中途离开，交班时所有人一起离开。一位员工同时只在一个班次上（替代原来的「一人一个未交班班次」）；
--   · 开班人在开班时自动加入、交班时所有人自动离开（触发器，直接写班次的地方也一样）；升级时已有的班次按开班人补一行。
-- 只加列、加表；不改已有的行（班次的守卫只放行交班，新加的两列开班后不再改）。

ALTER TABLE shifts
  ADD COLUMN drawer text CHECK (drawer ~ '^k[0-9]{1,3}$'),
  ADD COLUMN drawer_name text CHECK (char_length(drawer_name) BETWEEN 1 AND 16),
  ADD CONSTRAINT shifts_drawer_pair_check CHECK ((drawer IS NULL) = (drawer_name IS NULL));
CREATE UNIQUE INDEX shifts_drawer_open_uq ON shifts (drawer) WHERE status = 'open' AND drawer IS NOT NULL;

CREATE TABLE shift_members (
  id        bigserial PRIMARY KEY,
  shift_id  bigint NOT NULL REFERENCES shifts (id),
  staff_id  bigint NOT NULL REFERENCES staff (id),
  joined_at timestamptz NOT NULL,
  left_at   timestamptz,
  -- 谁让他离开的：本人离开钱箱，或交班的人（交班时所有人一起离开）
  left_by   bigint REFERENCES staff (id),
  CHECK (left_at IS NULL OR left_at >= joined_at),
  CHECK (left_at IS NOT NULL OR left_by IS NULL)
);
-- 一位员工同时只在一个班次上
CREATE UNIQUE INDEX shift_members_current_uq ON shift_members (staff_id) WHERE left_at IS NULL;
CREATE INDEX shift_members_shift_idx ON shift_members (shift_id);

-- 升级时已有的班次：开班人从开班起在这个班次上，已交班的在交班时离开
INSERT INTO shift_members (shift_id, staff_id, joined_at, left_at, left_by)
SELECT id, staff_id, started_at, CASE WHEN status = 'closed' THEN ended_at END, CASE WHEN status = 'closed' THEN closed_by END
FROM shifts ORDER BY id;

-- 开班人开班时加入
CREATE FUNCTION yuzu_shift_opener() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO shift_members (shift_id, staff_id, joined_at, left_at, left_by)
  VALUES (NEW.id, NEW.staff_id, NEW.started_at,
          CASE WHEN NEW.status = 'closed' THEN greatest(NEW.ended_at, NEW.started_at) END,
          CASE WHEN NEW.status = 'closed' THEN NEW.closed_by END);
  RETURN NULL;
END $$;
CREATE TRIGGER shifts_opener AFTER INSERT ON shifts FOR EACH ROW EXECUTE FUNCTION yuzu_shift_opener();

-- 交班时还在的人一起离开（班次的守卫只放行「当班 → 已交班」这一次修改）
CREATE FUNCTION yuzu_shift_close_members() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE shift_members SET left_at = greatest(NEW.ended_at, joined_at), left_by = NEW.closed_by
  WHERE shift_id = NEW.id AND left_at IS NULL;
  RETURN NULL;
END $$;
CREATE TRIGGER shifts_close_members AFTER UPDATE OF status ON shifts
  FOR EACH ROW WHEN (OLD.status = 'open' AND NEW.status = 'closed') EXECUTE FUNCTION yuzu_shift_close_members();

-- 成员记录只追加：不能删；只能离开一次（记离开时间与谁），其他字段不改
CREATE FUNCTION yuzu_shift_member_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '当班成员记录禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.left_at IS NOT NULL OR NEW.left_at IS NULL
     OR NEW.shift_id <> OLD.shift_id OR NEW.staff_id <> OLD.staff_id OR NEW.joined_at <> OLD.joined_at THEN
    RAISE EXCEPTION '当班成员只能离开一次，离开后不能修改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shift_members_guard BEFORE UPDATE OR DELETE ON shift_members
  FOR EACH ROW EXECUTE FUNCTION yuzu_shift_member_guard();

-- 原来的「一人一个未交班班次」改由成员表保证：按钱箱交班时开班人可以离开钱箱、去开另一个钱箱
DROP INDEX shifts_open_uq;
