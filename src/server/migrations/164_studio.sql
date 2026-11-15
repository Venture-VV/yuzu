-- 164 UI 工作台（8.1.1，docs/WORKBENCH_V811.md 第 11 节）：设计师在系统里直接改版面。
--   ① 岗位「设计师」（designer）：只进工作台（在当时的岗位约束上追加，不照旧名单重建）；
--   ② 版面草稿 studio_designs：每个界面、每家店一份，带版本号（rev），存草稿时对不上拒绝；
--   ③ 已发布的版本 studio_versions：只追加。发布 = 照草稿写一版；回滚 = 照旧的一版再写一版（kind = rollback）。
--      平板读的是这家店最新的一版；这家店没发布过的用本店（编号 1）的，再没有就用代码里内置的默认版面（GZ11、GZ12）；
--   ④ 素材 studio_assets：图片按内容的 SHA-256 存（同一张只存一份，全公司共用），只追加；
--   ⑤ 预览码 studio_preview_codes：「在平板上看」生成，存当时草稿的一份快照，30 分钟有效；
--   ⑥ 「确认作废」与操作编号加业务类型 studio_publish（发布、回滚都用；在当时的约束上追加，写法见 162）。
-- 只加表、追加约束，不改已有数据。升级后没有发布过版面：平板照旧是现在的样子。

-- ───────────── ① 岗位「设计师」 ─────────────
DO $$
DECLARE expression text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = 'staff'::regclass AND conname = 'staff_role_check';
  IF expression IS NULL THEN RAISE EXCEPTION '原岗位约束不存在'; END IF;
  ALTER TABLE staff DROP CONSTRAINT staff_role_check;
  EXECUTE format('ALTER TABLE staff ADD CONSTRAINT staff_role_check CHECK ((%s) OR role = ''designer'')', expression);
END $$;

-- ───────────── ⑥ 业务类型 studio_publish ─────────────
DO $$
DECLARE t text; expression text;
BEGIN
  FOREACH t IN ARRAY ARRAY['idempotency_keys', 'op_fences'] LOOP
    SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = t::regclass AND conname = t || '_op_type_check';
    IF expression IS NULL THEN RAISE EXCEPTION '原操作类型约束不存在'; END IF;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, t || '_op_type_check');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ((%s) OR op_type = ''studio_publish'')', t, t || '_op_type_check', expression);
  END LOOP;
END $$;

-- ───────────── ② 草稿 ─────────────
CREATE TABLE studio_designs (
  id          bigserial PRIMARY KEY,
  surface     text NOT NULL CHECK (surface IN ('emenu')),
  store_id    bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id),
  doc         jsonb NOT NULL,
  rev         integer NOT NULL DEFAULT 1 CHECK (rev > 0),
  updated_by  bigint NOT NULL REFERENCES staff (id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (surface, store_id)
);

-- ───────────── ③ 已发布的版本（只追加） ─────────────
CREATE TABLE studio_versions (
  id               bigserial PRIMARY KEY,
  surface          text NOT NULL CHECK (surface IN ('emenu')),
  store_id         bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id),
  version          integer NOT NULL CHECK (version > 0),
  kind             text NOT NULL CHECK (kind IN ('publish', 'rollback')),
  -- 回滚时是照哪一版重发的
  rollback_of      integer CHECK (rollback_of > 0),
  doc              jsonb NOT NULL,
  doc_hash         text NOT NULL CHECK (doc_hash ~ '^[0-9a-f]{64}$'),
  note             text NOT NULL DEFAULT '' CHECK (length(note) <= 200),
  -- 改了哪几屏（theme、start、menu……）
  screens_changed  text[] NOT NULL DEFAULT '{}',
  client_key       uuid NOT NULL UNIQUE,
  request_hash     text NOT NULL,
  published_by     bigint NOT NULL REFERENCES staff (id),
  published_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (surface, store_id, version),
  CHECK ((kind = 'rollback') = (rollback_of IS NOT NULL))
);
CREATE TRIGGER studio_versions_append_only BEFORE UPDATE OR DELETE ON studio_versions
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- ───────────── ④ 素材（只追加） ─────────────
CREATE TABLE studio_assets (
  id           text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
  mime         text NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp', 'image/svg+xml')),
  data         bytea NOT NULL,
  size_bytes   integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 5242880),
  width        integer CHECK (width > 0),
  height       integer CHECK (height > 0),
  name         text NOT NULL DEFAULT '' CHECK (length(name) <= 80),
  uploaded_by  bigint NOT NULL REFERENCES staff (id),
  uploaded_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (octet_length(data) = size_bytes)
);
CREATE TRIGGER studio_assets_append_only BEFORE UPDATE OR DELETE ON studio_assets
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- ───────────── ⑤ 预览码 ─────────────
CREATE TABLE studio_preview_codes (
  code        text PRIMARY KEY CHECK (code ~ '^[A-Z2-9]{8}$'),
  surface     text NOT NULL CHECK (surface IN ('emenu')),
  store_id    bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id),
  doc         jsonb NOT NULL,
  created_by  bigint NOT NULL REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX studio_preview_codes_expires ON studio_preview_codes (expires_at);
