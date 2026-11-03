-- 043 微信小程序第一期（小程序线，docs/MINIPROGRAM.md 第 12 节）：
--   ① 小程序用的图片：门店、首页轮播、项目介绍（与采购单图片一样存在库里、随备份走，同一张图只存一份）
--   ② 绑定记录：微信 openid ↔ 会员（只追加；解绑记在原行的解绑字段上，只能填一次）
--   ③ 门店信息：两家店的营业时间、地址、电话、定位、公告（本系统所在的门店只有一家）
--   ④ 首页轮播、价目项目的对外介绍（价格仍读价目表，不另存）
-- 只建新表，不改已有的表；只用外键引用会员、员工与价目项目。升级后小程序默认关闭，原有功能不变。

CREATE TABLE mp_images (
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
CREATE TRIGGER mp_images_append_only BEFORE UPDATE OR DELETE ON mp_images
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

CREATE TABLE mp_bindings (
  id                 bigserial PRIMARY KEY,
  -- 小程序用户（网关用 wx.login 的 code 换来的 openid）
  openid             text NOT NULL CHECK (openid ~ '^[A-Za-z0-9_-]{6,64}$'),
  member_id          bigint NOT NULL REFERENCES members (id),
  -- 绑定时微信验证过的手机号（当时等于会员档案上的手机号）
  phone              text NOT NULL CHECK (phone ~ '^1[0-9]{10}$'),
  -- 模拟微信绑定的（只在 development 实例允许）
  mock               boolean NOT NULL DEFAULT false,
  -- 网关带的操作编号：同一编号重提返回原来那次的结果
  client_key         uuid NOT NULL UNIQUE,
  bound_at           timestamptz NOT NULL DEFAULT now(),
  -- 解绑：前台员工在会员详情里做，写原因、记经办人
  unbound_at         timestamptz,
  unbound_by         bigint REFERENCES staff (id),
  unbind_reason      text CHECK (unbind_reason IS NULL OR char_length(btrim(unbind_reason)) BETWEEN 1 AND 200),
  unbind_client_key  uuid UNIQUE,
  CHECK ((unbound_at IS NULL) = (unbound_by IS NULL)),
  CHECK ((unbound_at IS NULL) = (unbind_reason IS NULL)),
  CHECK ((unbound_at IS NULL) = (unbind_client_key IS NULL))
);
-- 同一时刻一个微信、一位会员各只有一条有效绑定
CREATE UNIQUE INDEX mp_bindings_openid_active_uq ON mp_bindings (openid) WHERE unbound_at IS NULL;
CREATE UNIQUE INDEX mp_bindings_member_active_uq ON mp_bindings (member_id) WHERE unbound_at IS NULL;
CREATE INDEX mp_bindings_member_idx ON mp_bindings (member_id, id);

-- 只追加：不能删；除了解绑（解绑的四个字段从空填上一次）以外都不能改
CREATE FUNCTION mp_bindings_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'mp_bindings 禁止删除' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.unbound_at IS NOT NULL OR NEW.unbound_at IS NULL
     OR NEW.id <> OLD.id OR NEW.openid <> OLD.openid OR NEW.member_id <> OLD.member_id OR NEW.phone <> OLD.phone
     OR NEW.mock <> OLD.mock OR NEW.client_key <> OLD.client_key OR NEW.bound_at <> OLD.bound_at THEN
    RAISE EXCEPTION '绑定记录只能解绑一次，其余不可修改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mp_bindings_guard BEFORE UPDATE OR DELETE ON mp_bindings
  FOR EACH ROW EXECUTE FUNCTION mp_bindings_guard();

CREATE TABLE mp_stores (
  id          bigserial PRIMARY KEY,
  code        text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]{1,23}$'),
  name        text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 32),
  -- 本系统所在的门店（会员、余额、券只来自这一家，MP5）
  is_home     boolean NOT NULL DEFAULT false,
  hours       text NOT NULL DEFAULT '' CHECK (char_length(hours) <= 60),
  address     text NOT NULL DEFAULT '' CHECK (char_length(address) <= 120),
  phone       text NOT NULL DEFAULT '' CHECK (char_length(phone) <= 30),
  -- 导航用的坐标（微信地图，GCJ-02）
  latitude    numeric(9, 6) CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  longitude   numeric(9, 6) CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  notice      text NOT NULL DEFAULT '' CHECK (char_length(notice) <= 300),
  image_id    bigint REFERENCES mp_images (id),
  sort_order  integer NOT NULL DEFAULT 0,
  visible     boolean NOT NULL DEFAULT true,
  version     integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by  bigint REFERENCES staff (id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((latitude IS NULL) = (longitude IS NULL))
);
CREATE UNIQUE INDEX mp_stores_one_home_uq ON mp_stores ((true)) WHERE is_home;
CREATE TRIGGER mp_stores_no_delete BEFORE DELETE ON mp_stores
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_delete();
-- 两家店（MP5）：营业时间、地址、电话等由店主在后台「小程序」里填
INSERT INTO mp_stores (code, name, is_home, sort_order) VALUES
  ('baoan', '宝安店', true, 10),
  ('futian', '福田店', false, 20);

CREATE TABLE mp_banners (
  id          bigserial PRIMARY KEY,
  title       text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 40),
  image_id    bigint NOT NULL REFERENCES mp_images (id),
  -- 点了去哪：不跳转、价目表、楼层导览、门店信息
  link        text NOT NULL DEFAULT 'none' CHECK (link IN ('none', 'prices', 'guide', 'store')),
  -- 显示的营业日（含首尾；空 = 不限）
  starts_on   date,
  ends_on     date,
  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  client_key  uuid UNIQUE,
  version     integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by  bigint NOT NULL REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  bigint REFERENCES staff (id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_on IS NULL OR ends_on IS NULL OR ends_on >= starts_on)
);
CREATE TRIGGER mp_banners_no_delete BEFORE DELETE ON mp_banners
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_delete();

CREATE TABLE mp_item_intros (
  item_id     bigint PRIMARY KEY REFERENCES service_items (id),
  intro       text NOT NULL DEFAULT '' CHECK (char_length(intro) <= 300),
  image_id    bigint REFERENCES mp_images (id),
  version     integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by  bigint REFERENCES staff (id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER mp_item_intros_no_delete BEFORE DELETE ON mp_item_intros
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_delete();
