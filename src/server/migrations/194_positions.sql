-- 8.1.18 组织架构与岗位（docs/POSITIONS_V8118.md，GW1–GW9；店主 2026-11-20《组织架构与岗位体系》表格）：
--   · staff.position：新岗位（总裁 / 总经办成员 / 某部门负责人 / 某部门员工，src/shared/positions.ts）；有它的按岗位模板算权限，
--     role、duties 照岗位自动填（只给按旧岗位判断的几处用）。没有的（老账号、专用账号）照旧按旧岗位。
--   · staff.permission_adjust：员工档案里的个人微调（相对岗位模板的增减，GW8）。
--   · staff.needs_position：老账号在这一版以后第一次登录要自己选新岗位（GW7），选完不再提示。
--     店主账号直接定成「总裁」（最高职能由总裁承接，表 4 第 2 条），不用选；
--     点餐平板、他店查询、设计师是专用账号，不是组织里的岗位，不用选；系统账号不登录，不用选。
--   · staff.position_chosen_at：自己选岗的时间（后台员工名单标「自选岗位」，超级管理员可以再改）。

ALTER TABLE staff
  ADD COLUMN position text CHECK (position IS NULL OR position ~ '^(president|gmo|[a-z]+\.(lead|staff))$'),
  ADD COLUMN permission_adjust jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(permission_adjust) = 'object'),
  ADD COLUMN needs_position boolean NOT NULL DEFAULT false,
  ADD COLUMN position_chosen_at timestamptz;

UPDATE staff SET position = 'president' WHERE role = 'owner' AND NOT system;
UPDATE staff SET needs_position = true
WHERE NOT system AND role NOT IN ('owner', 'tablet', 'other_store', 'designer');
