-- 8.1.17《浴族系统需求汇总》8.1.15 没做完的部分（docs/FRONTDESK_V8117.md）：
--   · BW-4 退菜按出品口：新权限「退菜：餐厅 / 水吧 / 果吧」（dining.voidRestaurant / voidWater / voidFruit）。原来能退菜的是有「前台挂账」
--     （frontdesk.operate）的岗位，默认三项都有；后台「岗位权限」里给哪个岗位加了「前台挂账」，也给它加上这三项，去掉了「前台挂账」的
--     也去掉这三项（不然原来不能退菜的岗位升级以后反而能退）。再跑一次不重复加；
--   · BW-1 超时提醒：异常多一种「超时提醒」（overtime，系统记的），记着是哪一级（12 / 24 / 72 小时）；同一次来访每一级只有一条（部分唯一索引兜底，
--     几个进程同时跑每分钟的任务也只记一次）。种类的约束在当时的约束上追加（几条开发线的迁移在一个库里谁先跑不一定，写法见 162）。
-- 只加列、加约束、加索引；已有的异常一行不改（新列为空），已有的岗位改动只多不少。

-- ───────────── 1. 退菜按出品口的权限（BW-4）：跟上后台「岗位权限」里的改动 ─────────────
UPDATE settings s
SET value = (
  SELECT jsonb_object_agg(e.role, CASE
    WHEN jsonb_typeof(e.cfg) <> 'object' THEN e.cfg
    ELSE coalesce((
      SELECT jsonb_object_agg(k.key, CASE
        WHEN k.key IN ('add', 'remove') AND jsonb_typeof(k.value) = 'array' AND k.value ? 'frontdesk.operate'
          THEN k.value || coalesce((
            SELECT jsonb_agg(p ORDER BY o) FROM unnest(ARRAY['dining.voidRestaurant', 'dining.voidWater', 'dining.voidFruit']) WITH ORDINALITY AS u(p, o)
            WHERE NOT k.value ? p), '[]'::jsonb)
        ELSE k.value END)
      FROM jsonb_each(e.cfg) AS k(key, value)), e.cfg)
    END)
  FROM jsonb_each(s.value) AS e(role, cfg))
WHERE s.key = 'role_permissions' AND jsonb_typeof(s.value) = 'object' AND s.value <> '{}'::jsonb;

-- ───────────── 2. 超时提醒（BW-1）：异常多一种，记着是哪一级 ─────────────
ALTER TABLE visit_incidents ADD COLUMN overtime_hours smallint CHECK (overtime_hours IN (12, 24, 72));

DO $$
DECLARE expression text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = 'visit_incidents'::regclass AND conname = 'visit_incidents_kind_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原异常种类约束 visit_incidents_kind_check 不存在'; END IF;
  ALTER TABLE visit_incidents DROP CONSTRAINT visit_incidents_kind_check;
  EXECUTE format('ALTER TABLE visit_incidents ADD CONSTRAINT visit_incidents_kind_check CHECK ((%s) OR kind = ''overtime'')', expression);
END $$;

-- 超时提醒才有级别，别的种类没有
ALTER TABLE visit_incidents ADD CONSTRAINT visit_incidents_overtime_check CHECK ((kind = 'overtime') = (overtime_hours IS NOT NULL));
-- 同一次来访每一级只记一次
CREATE UNIQUE INDEX visit_incidents_overtime_uq ON visit_incidents (visit_id, overtime_hours) WHERE kind = 'overtime';
-- 「异常待办」也列超时提醒（与 187 的 visit_incidents_todo_idx 并用）
CREATE INDEX visit_incidents_overtime_todo_idx ON visit_incidents (store_id, id) WHERE kind = 'overtime';
