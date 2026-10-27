-- 浴族 yuzu · G2 第 3 轮：作废登记绑定业务类型（增量迁移，只新增一张表）
--
-- 「确认作废」改为写入 op_fences（操作编号 + 声明的业务类型 + 经办人），不再占用 idempotency_keys 的编号：
--   · 原请求写入操作编号前，按编号取事务级咨询锁，再检查有没有「同一业务类型」的作废登记，有则整笔回滚；
--     作废登记同样先取这把锁，二者不会交错，原请求一旦写下编号，作废就只能查回结果；
--   · 声明的类型与原请求的真实类型不一致（伪报类型、从别的模块作废）的登记不会拦下原请求；
--   · 作废接口按声明的类型检查权限，所以要让作废生效，必须具备这项业务本身的权限。
-- 005 写入 idempotency_keys 的 abandoned 记录仍按已作废处理（兼容）。
CREATE TABLE op_fences (
  key        uuid NOT NULL,
  op_type    text NOT NULL CHECK (op_type IN ('recharge', 'consume', 'reversal', 'checkin', 'bill_post', 'tag_swap')),
  staff_id   bigint NOT NULL REFERENCES staff (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key, op_type)
);

CREATE TRIGGER op_fences_append_only BEFORE UPDATE OR DELETE ON op_fences
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
