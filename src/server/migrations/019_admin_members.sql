-- v0.6.0 管理后台与会员资料（店主 2026-10-30：规则设置集中到后台；同事反馈会员要有渠道来源，看板要按岗位分版本）
--   · 会员渠道来源：存渠道编号（c1、c2…），名称与可选项在后台「会员与渠道」维护（settings.member_channels），
--     改名不影响已登记的会员；停用的渠道仍保留在会员资料上。没有登记的为空（老会员、期初导入）。
--   · 新岗位「客户经理」（account_manager）：储值会员的开发与维护；默认权限见 src/shared/permissions.ts，店主可在后台调整。

ALTER TABLE members ADD COLUMN channel text CHECK (channel IS NULL OR channel ~ '^c[0-9]{1,3}$');
CREATE INDEX members_created_idx ON members (created_at);

ALTER TABLE staff DROP CONSTRAINT staff_role_check;
ALTER TABLE staff ADD CONSTRAINT staff_role_check
  CHECK (role IN ('owner', 'store_manager', 'duty_manager', 'account_manager', 'clerk', 'backoffice'));
