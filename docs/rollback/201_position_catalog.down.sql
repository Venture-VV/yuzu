-- 8.2.0 P04 的回滚脚本（docs/YUZU_REQ_V820.md 第 5 节）：撤掉 201_position_catalog.sql 建的三张表与配置日志。
-- 用法：先按 docs/RELEASE_V800.md 回滚到 8.2.0 以前的版本（代码），再在数据库里执行这一份，最后删掉迁移记录：
--   psql "$DATABASE_URL" -f docs/rollback/201_position_catalog.down.sql
-- 回滚以后的兼容：算权限回到代码里的岗位模板（与 201 的初始数据逐项一致）；后台「设立岗位」的增减（settings.position_permissions）、
-- 个人微调、旧岗位那张表都没动过，照常生效。P05 页面上改过的建议权限会丢——回滚前先在「分部门岗位职权配置」导出一份 Excel 留底。

BEGIN;
DROP TABLE IF EXISTS position_config_log;
DROP TABLE IF EXISTS position_suggestions;
DROP TABLE IF EXISTS position_catalog;
DROP TABLE IF EXISTS org_departments;
DELETE FROM schema_migrations WHERE version = '201_position_catalog.sql';
COMMIT;
