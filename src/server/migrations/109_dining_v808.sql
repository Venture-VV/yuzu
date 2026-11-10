-- 8.0.8 前台整改 · 餐饮（docs/FRONTDESK_V808.md 第 5.2 节，B02）：退超过小额上限的菜可以请值班经理及以上当场授权，
-- 授权的用途加 line_void（绑定那一条明细、金额与原因，5 分钟内有效、只能用一次，与优惠授权一样）。只放宽约束。
ALTER TABLE auth_grants DROP CONSTRAINT auth_grants_purpose_check;
ALTER TABLE auth_grants ADD CONSTRAINT auth_grants_purpose_check
  CHECK (purpose IN ('vip_tag', 'over_limit', 'checkout_discount', 'ticket_discount', 'member_refund', 'member_phone', 'line_void'));
