-- 浴族 yuzu · Batch 2：内置岗位「店总」「值班经理」（增量迁移，只放宽岗位约束）
--
-- 店主 2026-10-27 答复 #29：超过 15 分钟或修改他人录入的内容，需要值班经理或店总权限。
-- 两个岗位的默认权限见 src/shared/permissions.ts（待确认）；Batch 4 改为可配置的「岗位 × 权限」矩阵。
ALTER TABLE staff DROP CONSTRAINT staff_role_check;
ALTER TABLE staff ADD CONSTRAINT staff_role_check
  CHECK (role IN ('owner', 'store_manager', 'duty_manager', 'clerk', 'backoffice'));
