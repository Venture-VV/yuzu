-- 8.1.16 房态中心的操作编号（docs/ROOM_CENTER_V8115.md 第 5 节）：
--   换房、退房、并房、拆并、维修、恢复、标待清、清洁完成这八样也带操作编号，照前台的「结果待确认」——查回、原样重提、确认作废。
--   · space_state：维修、恢复、标待清、清洁完成（作废要「客房打扫、维修」）；
--   · space_dispatch：换房、退房、并房、拆并（作废要「钟房派钟」）；
--   编号记在 idempotency_keys（ref_id 是这一步记下的第一条房间事件 space_room_events）。房态版本号照旧留作第二道核对。
-- 只在 idempotency_keys、op_fences 当时的类型约束上追加这两种（写法同 162、188）：几个分支的迁移在一个库里谁先跑不一定，
-- 照固定名单重建会把别的迁移加的类型覆盖掉。190 不改。

DO $$
DECLARE t text; expression text;
BEGIN
  FOREACH t IN ARRAY ARRAY['idempotency_keys', 'op_fences'] LOOP
    SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = t::regclass AND conname = t || '_op_type_check';
    IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, t || '_op_type_check');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ((%s) OR op_type IN (''space_state'', ''space_dispatch''))', t, t || '_op_type_check', expression);
  END LOOP;
END $$;
