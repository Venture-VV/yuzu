-- 8.0.20 合并前 Codex 审查（b850838）：布草单据接进全店的「结果待确认 / 确认作废」（AGENTS.md：提交前本机保存原编号与原请求，
-- 查不回只能原样重提，或经服务端确认作废后再重新填写）。
--   · 操作编号照旧记在单据上（linen_docs.client_key，迁移 138）；
--   · 「确认作废」加业务类型 linen_doc：作废登记以后，原请求再到也不会开单。
-- 只放宽约束，不动数据。
--
-- 在当时的约束上追加（读出原表达式再 OR 上新类型，写法同 162_customer_workbench.sql），不照着一份旧名单重建：
-- 几个分支的迁移在一个库里谁先跑不一定——客户部的 162 先合进了 main，按那时的 main 升过的库是「先 162、后 140」；
-- 照旧名单重建会把客户部的六种类型覆盖掉（那一类的「确认作废」写不进去），库里已经有客户部的作废登记时约束还加不上、升级中断
-- （测试会话在 PR #109 上报的 P1；这份迁移还没有发布到任何环境，所以直接改它）。
DO $$
DECLARE expression text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint
   WHERE conrelid = 'op_fences'::regclass AND conname = 'op_fences_op_type_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
  ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
  EXECUTE format('ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check CHECK ((%s) OR op_type IN (''linen_doc''))', expression);
END $$;
