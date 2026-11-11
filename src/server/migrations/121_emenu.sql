-- 121 点餐系统 · 平板电子菜单（8.0.10，docs/EMENU.md）。
--   ① 岗位「点餐平板」（tablet）：只能打开平板点餐页；
--   ② 点单密码（staff_order_pins）：服务员在平板上确认下单用的 6 位数字，系统生成；
--   ③ 图片（emenu_images）：菜品大图、特写图、起始页氛围图（与采购单、小程序的图片一样存在库里、随备份走，同一张图只存一份）；
--   ④ 菜品图文（emenu_dishes）与规格（emenu_dish_specs）：规格对应价目表里的一个项目，价格仍读价目表、不另存；
--   ⑤ 分类（emenu_categories）、版面（emenu_pages）与每页放哪几道菜（emenu_page_dishes）；
--   ⑥ 点餐单（emenu_orders，只追加）：平板上的一次下单——操作编号、手牌、桌号、人数、备注、确认的服务员、哪台平板的账号。
--      钱仍只在账单明细里（下单走 frontdesk/bills.ts 的 postChargesTx，操作编号记在 idempotency_keys，业务类型还是 bill_post）；
--   ⑦ 出品单的口味备注从最多 40 字放宽到 100 字：平板的整单备注（忌口 + 起菜方式 + 自定义）要放得下。
-- 只加表、放宽约束，不改已有数据。升级后平板点餐默认关闭，原有功能不变。
-- 不改 idempotency_keys、op_fences 的业务类型约束（两条开发线、两个 PR 都整段重写它们，容易互相覆盖）。

-- ───────────── ① 岗位「点餐平板」 ─────────────
ALTER TABLE staff DROP CONSTRAINT staff_role_check;
ALTER TABLE staff ADD CONSTRAINT staff_role_check
  CHECK (role IN ('owner', 'store_manager', 'duty_manager', 'account_manager', 'clerk', 'backoffice', 'other_store', 'tablet'));

-- ───────────── ② 点单密码 ─────────────
-- 6 位数字一共只有一百万种，库泄露后怎么加密都能很快试出来，防护在线上（要先登录平板账号、输错限次、每次确认记审计）。
-- 库里不存明文：pin_hash 是整个密码的 scrypt 摘要（与登录密码同一套）；slot 是密码的前三位，用来按密码找到人，
-- 系统生成时保证不重复（唯一约束兜底）。
CREATE TABLE staff_order_pins (
  staff_id  bigint PRIMARY KEY REFERENCES staff (id),
  slot      text NOT NULL UNIQUE CHECK (slot ~ '^[0-9]{3}$'),
  pin_hash  text NOT NULL,
  set_by    bigint NOT NULL REFERENCES staff (id),
  set_at    timestamptz NOT NULL DEFAULT now()
);

-- ───────────── ③ 图片 ─────────────
CREATE TABLE emenu_images (
  id          bigserial PRIMARY KEY,
  -- 内容摘要：同一张图只存一份
  sha256      text NOT NULL UNIQUE CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  mime        text NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  data        bytea NOT NULL,
  size_bytes  integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 1048576),
  created_by  bigint NOT NULL REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (octet_length(data) = size_bytes)
);
CREATE TRIGGER emenu_images_append_only BEFORE UPDATE OR DELETE ON emenu_images
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- ───────────── ④ 菜品图文与规格 ─────────────
CREATE TABLE emenu_dishes (
  id               bigserial PRIMARY KEY,
  -- 展示名（平板上显示的菜名；账单上记的仍是价目项目的名称）
  name             text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 32),
  name_en          text NOT NULL DEFAULT '' CHECK (char_length(name_en) <= 80),
  -- 名称后面的小字：（煎档）、(2只)、(姜茸焗，水煮鱼，酸菜鱼)
  tagline          text NOT NULL DEFAULT '' CHECK (char_length(tagline) <= 40),
  description      text NOT NULL DEFAULT '' CHECK (char_length(description) <= 200),
  -- 属性行（文字陈列版面用）：产地：法国 / 年份：NV，最多 3 行
  attrs            text[] NOT NULL DEFAULT '{}' CHECK (cardinality(attrs) <= 3),
  -- 价格后面的单位：¥42/份
  unit             text NOT NULL DEFAULT '份' CHECK (char_length(btrim(unit)) BETWEEN 1 AND 4),
  image_id         bigint REFERENCES emenu_images (id),
  detail_image_id  bigint REFERENCES emenu_images (id),
  active           boolean NOT NULL DEFAULT true,
  version          integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by       bigint NOT NULL REFERENCES staff (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       bigint NOT NULL REFERENCES staff (id),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER emenu_dishes_no_delete BEFORE DELETE ON emenu_dishes
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_delete();

-- 规格：一道菜的每个规格对应价目表里的一个项目（各自的价格、估清）；一个项目只能在一道菜里。修改菜品时整批换
CREATE TABLE emenu_dish_specs (
  dish_id  bigint NOT NULL REFERENCES emenu_dishes (id),
  item_id  bigint NOT NULL REFERENCES service_items (id),
  -- 规格名：大份、小份……只有一个规格的留空
  label    text NOT NULL DEFAULT '' CHECK (char_length(label) <= 8),
  sort_no  integer NOT NULL DEFAULT 0 CHECK (sort_no >= 0),
  PRIMARY KEY (dish_id, item_id)
);
CREATE UNIQUE INDEX emenu_dish_specs_item_uq ON emenu_dish_specs (item_id);

-- ───────────── ⑤ 分类与版面 ─────────────
CREATE TABLE emenu_categories (
  id            bigserial PRIMARY KEY,
  -- 最多 16 个字（与价目表的分类一样长：「从价目表生成初稿」直接用价目表的分类名）；顶栏放得下的大约 6 个字
  name          text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 16),
  name_en       text NOT NULL DEFAULT '' CHECK (char_length(name_en) <= 32),
  -- 供应时段：一天里的第几分钟（门店时区）。都为空 = 全天；start_minute > end_minute = 跨零点（22:00–02:00）
  start_minute  integer CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute    integer CHECK (end_minute BETWEEN 0 AND 1439),
  sort_order    integer NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN -9999 AND 9999),
  active        boolean NOT NULL DEFAULT true,
  -- 分类自己的信息与它的各页共用一个版本号：保存各页、改名、改时段都加一
  version       integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by    bigint NOT NULL REFERENCES staff (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    bigint NOT NULL REFERENCES staff (id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((start_minute IS NULL) = (end_minute IS NULL)),
  CHECK (start_minute IS NULL OR start_minute <> end_minute)
);
CREATE UNIQUE INDEX emenu_categories_name_uq ON emenu_categories (lower(btrim(name)));
CREATE TRIGGER emenu_categories_no_delete BEFORE DELETE ON emenu_categories
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_delete();

-- 分类的各页：版面与竖排小标题。保存一个分类时整批换（先删后建），所以页的编号会变，页面按「第几页」记位置
CREATE TABLE emenu_pages (
  id           bigserial PRIMARY KEY,
  category_id  bigint NOT NULL REFERENCES emenu_categories (id),
  sort_no      integer NOT NULL CHECK (sort_no BETWEEN 0 AND 199),
  layout       text NOT NULL CHECK (layout IN ('cover', 'list_image', 'single_wide', 'single_left', 'single_right',
                                               'duo_stagger', 'duo_row', 'duo_mixed', 'trio_row', 'trio_mixed', 'list_text')),
  title        text NOT NULL DEFAULT '' CHECK (char_length(title) <= 8),
  title_en     text NOT NULL DEFAULT '' CHECK (char_length(title_en) <= 24),
  UNIQUE (category_id, sort_no)
);

CREATE TABLE emenu_page_dishes (
  page_id  bigint NOT NULL REFERENCES emenu_pages (id) ON DELETE CASCADE,
  slot_no  integer NOT NULL CHECK (slot_no BETWEEN 0 AND 9),
  dish_id  bigint NOT NULL REFERENCES emenu_dishes (id),
  PRIMARY KEY (page_id, slot_no)
);
CREATE INDEX emenu_page_dishes_dish_idx ON emenu_page_dishes (dish_id);

-- ───────────── ⑥ 点餐单（只追加） ─────────────
CREATE TABLE emenu_orders (
  id               bigserial PRIMARY KEY,
  -- 这次下单的操作编号，也是这次挂账的编号（bill_lines.post_key、idempotency_keys.key）
  client_key       uuid NOT NULL UNIQUE,
  visit_id         bigint NOT NULL REFERENCES visits (id),
  tag_code         text NOT NULL,
  -- 送到哪张桌（桌台名称；没建桌台时是输入的桌号；没填为空）
  table_name       text NOT NULL DEFAULT '' CHECK (char_length(table_name) <= 12),
  guests           integer NOT NULL CHECK (guests BETWEEN 1 AND 99),
  -- 整单备注的三部分，与拼好的一句（写在每道菜的口味备注上）
  avoid            text[] NOT NULL DEFAULT '{}',
  serve            text NOT NULL DEFAULT '',
  custom_note      text NOT NULL DEFAULT '' CHECK (char_length(custom_note) <= 30),
  note             text NOT NULL DEFAULT '' CHECK (char_length(note) <= 100),
  -- 厨房出品单号
  order_no         text,
  total            bigint NOT NULL CHECK (total > 0),
  line_count       integer NOT NULL CHECK (line_count > 0),
  quantity         integer NOT NULL CHECK (quantity > 0),
  -- 输点单密码确认的服务员（账单明细的经办人也是他）、这台平板登录的账号
  waiter_id        bigint NOT NULL REFERENCES staff (id),
  device_staff_id  bigint NOT NULL REFERENCES staff (id),
  business_date    date NOT NULL,
  created_at       timestamptz NOT NULL
);
CREATE INDEX emenu_orders_visit_idx ON emenu_orders (visit_id);
CREATE INDEX emenu_orders_date_idx ON emenu_orders (business_date);
CREATE TRIGGER emenu_orders_append_only BEFORE UPDATE OR DELETE ON emenu_orders
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- ───────────── ⑦ 出品单的口味备注放宽到 100 字 ─────────────
-- 点单页、小程序扫码点餐的请求格式照旧最多 40 字（MAX_DISH_NOTE）；出品单保护触发器不管备注长度，不用改
ALTER TABLE kitchen_items DROP CONSTRAINT kitchen_items_note_check;
ALTER TABLE kitchen_items ADD CONSTRAINT kitchen_items_note_check CHECK (char_length(note) <= 100);
