-- 165 UI 工作台第二步（8.1.2，docs/WORKBENCH_V811.md 第 8、11 节）：界面加「微信小程序」（mp）与「员工食堂」（canteen）。
-- 版面草稿、已发布的版本、预览码三张表的「界面」约束在当时的约束上追加（读出原表达式再 OR 上新的，不照旧名单重建：
-- 别的分支以后再加界面时不会互相覆盖）。只改约束，不改已有数据。
DO $$
DECLARE t text; expression text;
BEGIN
  FOREACH t IN ARRAY ARRAY['studio_designs', 'studio_versions', 'studio_preview_codes'] LOOP
    SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = t::regclass AND conname = t || '_surface_check';
    IF expression IS NULL THEN RAISE EXCEPTION '%：原界面约束不存在', t; END IF;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, t || '_surface_check');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ((%s) OR surface IN (''mp'', ''canteen''))', t, t || '_surface_check', expression);
  END LOOP;
END $$;
