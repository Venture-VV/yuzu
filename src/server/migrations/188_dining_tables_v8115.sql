-- 8.1.15《浴族系统需求汇总》块 B · 餐饮（docs/DINING_V8115.md）：桌台动作、台账合并退菜、按出品口下单与房号、整单备注。
-- 只加列、加表、放宽约束；已有的桌台、开台、账单、出品单照旧（新列都有默认值，已有的桌台都是「可用」）。
--   · dining_tables.state：可用 / 待清台 / 维修中（维修要原因与预计恢复时间）；state_since 是现在这个状态从什么时候开始；
--   · table_sessions.merged_into：并台时附台的开台指向主台的开台，拆台清掉；只在用餐中改（开台的保护触发器照旧，结账后不能改）；
--   · table_events：并台、拆台、清台、维修、恢复（只追加，带经办人与时间、操作编号）；
--   · kitchen_items.order_note、deliver_room：整单备注（写进这一单每道菜的出品单）、送达房号；
--   · 职责加「康美部」（kangmei），idempotency_keys / op_fences 的类型加 table_state、table_merge（都在当时的约束上追加）；
--   · 后台「岗位权限」里给哪个岗位加了「餐饮点单」，也给它加上三个出品口的下单权限（原来能点单的岗位三项都有）；
--   · 退菜的审批人、责任岗位记在审计里，台账按明细查审计：给这两种审计动作的 lineId 建索引。

-- ───────────── 桌台状态 ─────────────
ALTER TABLE dining_tables
  ADD COLUMN state text NOT NULL DEFAULT 'available' CHECK (state IN ('available', 'dirty', 'maintenance')),
  ADD COLUMN maintenance_reason text CHECK (maintenance_reason IS NULL OR char_length(btrim(maintenance_reason)) BETWEEN 2 AND 100),
  ADD COLUMN maintenance_until timestamptz,
  ADD COLUMN state_since timestamptz;
ALTER TABLE dining_tables ADD CONSTRAINT dining_tables_maintenance_check CHECK (
  ((state = 'maintenance') = (maintenance_reason IS NOT NULL)) AND ((maintenance_reason IS NULL) = (maintenance_until IS NULL))
);

-- ───────────── 并台：附台的开台指向主台的开台 ─────────────
ALTER TABLE table_sessions ADD COLUMN merged_into bigint REFERENCES table_sessions (id);
ALTER TABLE table_sessions ADD CONSTRAINT table_sessions_merged_into_check CHECK (merged_into IS NULL OR merged_into <> id);
CREATE INDEX table_sessions_merged_into_idx ON table_sessions (merged_into) WHERE merged_into IS NOT NULL;

-- ───────────── 桌台动作记录（只追加） ─────────────
CREATE TABLE table_events (
  id               bigserial PRIMARY KEY,
  store_id         bigint NOT NULL DEFAULT yuzu_store(),
  table_id         bigint NOT NULL REFERENCES dining_tables (id),
  kind             text NOT NULL CHECK (kind IN ('merge', 'split', 'clear', 'maintenance', 'restore')),
  -- 并台、拆台：这张桌上的开台、另一张桌与它的开台；这张桌是主台（main）还是附台（sub）。一次并台两张桌各记一条
  session_id       bigint REFERENCES table_sessions (id),
  other_table_id   bigint REFERENCES dining_tables (id),
  other_session_id bigint REFERENCES table_sessions (id),
  role             text CHECK (role IN ('main', 'sub')),
  -- 维修的原因与预计恢复时间
  reason           text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 100),
  expected_back_at timestamptz,
  op_key           uuid NOT NULL,
  operator_id      bigint NOT NULL REFERENCES staff (id),
  business_date    date NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind IN ('merge', 'split')) = (session_id IS NOT NULL AND other_table_id IS NOT NULL AND other_session_id IS NOT NULL AND role IS NOT NULL)),
  CHECK ((kind = 'maintenance') = (expected_back_at IS NOT NULL)),
  CHECK (kind <> 'maintenance' OR char_length(btrim(reason)) >= 2)
);
CREATE INDEX table_events_table_idx ON table_events (table_id, id);
CREATE INDEX table_events_op_key_idx ON table_events (op_key);
CREATE TRIGGER table_events_append_only BEFORE UPDATE OR DELETE ON table_events
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- ───────────── 出品单：整单备注、送达房号 ─────────────
ALTER TABLE kitchen_items
  ADD COLUMN order_note text NOT NULL DEFAULT '' CHECK (char_length(order_note) <= 60),
  ADD COLUMN deliver_room text NOT NULL DEFAULT '' CHECK (char_length(deliver_room) <= 10);

-- ───────────── 职责「康美部」：在当时的约束上追加（几个分支的迁移谁先跑不一定，读出原来的名单再加） ─────────────
-- 名单从约束定义里「<@」后面取（ARRAY['stock'::text, …] 或 '{stock,…}'::text[] 两种写法都认），新约束照旧写成 ARRAY[...]。
DO $$
DECLARE def text; allowed text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid = 'staff'::regclass AND conname = 'staff_duties_check';
  IF def IS NULL OR position('<@' IN def) = 0 THEN RAISE EXCEPTION '职责约束 staff_duties_check 不存在或不是一份名单'; END IF;
  SELECT array_agg(DISTINCT x.d ORDER BY x.d) INTO allowed
  FROM (SELECT (regexp_matches(substring(def FROM position('<@' IN def)), '([a-z][a-z_]*)', 'g'))[1] AS d UNION SELECT 'kangmei') x
  WHERE x.d <> 'text';
  ALTER TABLE staff DROP CONSTRAINT staff_duties_check;
  EXECUTE format('ALTER TABLE staff ADD CONSTRAINT staff_duties_check CHECK (duties <@ ARRAY[%s]::text[])',
    (SELECT string_agg(quote_literal(a.d), ', ' ORDER BY a.d) FROM unnest(allowed) AS a(d)));
END $$;

-- ───────────── 操作编号的类型：桌台动作（清台、维修、恢复；并台、拆台），在当时的约束上追加（写法同 162） ─────────────
DO $$
DECLARE t text; expression text;
BEGIN
  FOREACH t IN ARRAY ARRAY['idempotency_keys', 'op_fences'] LOOP
    SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = t::regclass AND conname = t || '_op_type_check';
    IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, t || '_op_type_check');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ((%s) OR op_type IN (''table_state'', ''table_merge''))', t, t || '_op_type_check', expression);
  END LOOP;
END $$;

-- ───────────── 后台岗位权限：加了「餐饮点单」的岗位也加上三个出品口的下单权限 ─────────────
UPDATE settings s
SET value = (
  SELECT jsonb_object_agg(e.role, CASE
    WHEN jsonb_typeof(e.cfg) = 'object' AND jsonb_typeof(e.cfg -> 'add') = 'array' AND (e.cfg -> 'add') ? 'dining.order'
      THEN jsonb_set(e.cfg, '{add}', (e.cfg -> 'add') || coalesce((
        SELECT jsonb_agg(p ORDER BY o) FROM unnest(ARRAY['dining.orderRestaurant', 'dining.orderWater', 'dining.orderFruit']) WITH ORDINALITY AS u(p, o)
        WHERE NOT (e.cfg -> 'add') ? p), '[]'::jsonb))
    ELSE e.cfg END)
  FROM jsonb_each(s.value) AS e(role, cfg))
WHERE s.key = 'role_permissions' AND jsonb_typeof(s.value) = 'object' AND s.value <> '{}'::jsonb;

-- ───────────── 台账查退菜的审批人与责任岗位：按明细查审计 ─────────────
CREATE INDEX audit_logs_void_line_idx ON audit_logs ((detail ->> 'lineId')) WHERE action IN ('frontdesk_void', 'table_void');
