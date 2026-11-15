-- 166（8.1.2，迁移号在 docs/ROADMAP.md 第 7 节登记）：UI 工作台的定时发布与批注（docs/WORKBENCH_V811.md 第 11、13 节，GZ27、GZ28）。
--
-- ① 定时发布：发布时可以定一个以后的时间生效（effective_at；空 = 发布时就生效）。studio_versions 照旧只追加，
--    撤销还没生效的那一版记在 studio_version_cancels（一版只能撤一次，主键兜底；也只追加）。
--    现在用哪一版 = 这家店没撤销、已经生效的里面生效时间（空的按发布时间）最晚的，同时的取版本号大的。
-- ② 批注：在画布上留言（某一屏的某个位置，可以挂在某一块上），设计师和店主来回说；回复挂在第一条下面；
--    解决了标一下（可以重新打开）。同一个操作编号只记一条（原样重提返回那一条）。

ALTER TABLE studio_versions ADD COLUMN effective_at timestamptz;
ALTER TABLE studio_versions ADD CONSTRAINT studio_versions_effective_check CHECK (effective_at IS NULL OR effective_at > published_at);

CREATE TABLE studio_version_cancels (
  version_id    bigint PRIMARY KEY REFERENCES studio_versions (id),
  cancelled_by  bigint NOT NULL REFERENCES staff (id),
  cancelled_at  timestamptz NOT NULL DEFAULT now(),
  reason        text NOT NULL DEFAULT '' CHECK (length(reason) <= 200)
);
CREATE TRIGGER studio_version_cancels_append_only BEFORE UPDATE OR DELETE ON studio_version_cancels
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

CREATE TABLE studio_comments (
  id           bigserial PRIMARY KEY,
  surface      text NOT NULL CONSTRAINT studio_comments_surface_check CHECK (surface IN ('emenu', 'mp', 'canteen')),
  store_id     bigint NOT NULL DEFAULT yuzu_store() REFERENCES stores (id),
  -- 哪一屏（改组件时是「@组件编号」）、画布上的位置（设计稿的像素），挂在哪一块上（可以不挂）
  screen       text NOT NULL CHECK (screen ~ '^@?[A-Za-z0-9_-]{1,40}$'),
  node_id      text CHECK (node_id IS NULL OR node_id ~ '^[A-Za-z0-9_-]{1,40}$'),
  x            double precision NOT NULL CHECK (x BETWEEN -10000 AND 30000),
  y            double precision NOT NULL CHECK (y BETWEEN -10000 AND 30000),
  -- 回复挂在第一条下面（只套一层）
  parent_id    bigint REFERENCES studio_comments (id),
  body         text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 1000),
  client_key   uuid NOT NULL UNIQUE,
  created_by   bigint NOT NULL REFERENCES staff (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  resolved_by  bigint REFERENCES staff (id),
  CHECK ((resolved_at IS NULL) = (resolved_by IS NULL)),
  CHECK (parent_id IS NULL OR resolved_at IS NULL)
);
CREATE INDEX studio_comments_list ON studio_comments (surface, store_id, created_at);
CREATE INDEX studio_comments_parent ON studio_comments (parent_id) WHERE parent_id IS NOT NULL;
