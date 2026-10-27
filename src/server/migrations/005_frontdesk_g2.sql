-- 浴族 yuzu · S2 前台 G2 验收修复（增量迁移，只放宽一处约束）
--
-- 「作废待确认操作」：页面断网或超时后，员工确认要放弃一笔前台操作时，服务端先把该操作编号登记为 abandoned。
-- 原请求若仍在路上或正在等锁，之后提交时会因编号已被占用而整笔回滚，保证「已作废」的操作永远不会再生效。
ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_op_type_check;
ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'inv_doc', 'purchase_order', 'payment', 'opening_payable',
                     'checkin', 'bill_post', 'tag_swap', 'abandoned'));
