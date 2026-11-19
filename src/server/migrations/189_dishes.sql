-- 189（8.1.15，迁移号在 docs/ROADMAP.md 第 7 节登记）：菜品管理（店主 2026-11-19《浴族系统需求汇总》餐饮第 4 条，
-- docs/DISHES_V8115.md，默认做法 CP1–CP12）。
--
-- 菜品就是现有的餐饮价目项目（service_items 里挂了出品档口、不需要技师的那些），不另建一张「菜品表」。这里只在它上面补：
--   ① 做法（dish_methods）：这道菜可选的做法，不加钱，点单时选了写进出品单的口味备注；
--   ② 加料（dish_addons）：这道菜可以加的料，是另外的价目项目，点单时另起一行、备注写「配 某菜」；
--   ③ 套餐（dish_combo_items）：一个价目项目带「含哪几样」，下单时一行，出品单上列出来（kitchen_items.parts 记下单当时的内容）；
--   ④ 菜品自己的图片（service_items.dish_image_id；图存在电子菜单的图片表里，按内容去重）；
--   ⑤ 改价记录（dish_price_changes，只追加）：改前、改后、谁、几点、原因、从哪里改的；
--   ⑥ 菜品管理的操作编号（dish_ops，只追加）：同一个编号重提返回第一次的结果。
-- 都是加表、加列：老的价目、订单、出品单一行不动；升级以后什么都不用配，点单与以前一样。
-- 价目全公司一套（docs/CONVENTIONS.md 第 2 节），这几张表也不按门店分；出品单本来就按门店分，parts 跟着出品单。

-- ───────────── ① 做法 ─────────────
-- 保存一道菜时整批换（先删后建）
CREATE TABLE dish_methods (
  item_id  bigint NOT NULL REFERENCES service_items (id),
  -- 少冰、去冰、微辣、免葱……最多 8 个字，前后不带空格
  name     text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 8 AND name = btrim(name)),
  sort_no  integer NOT NULL DEFAULT 0 CHECK (sort_no >= 0),
  PRIMARY KEY (item_id, name)
);

-- ───────────── ② 加料 ─────────────
CREATE TABLE dish_addons (
  item_id        bigint NOT NULL REFERENCES service_items (id),
  -- 加的料：另外一个价目项目（自己的价格、沽清、出品档口）
  addon_item_id  bigint NOT NULL REFERENCES service_items (id),
  sort_no        integer NOT NULL DEFAULT 0 CHECK (sort_no >= 0),
  PRIMARY KEY (item_id, addon_item_id),
  CONSTRAINT dish_addons_not_self CHECK (item_id <> addon_item_id)
);
CREATE INDEX dish_addons_addon_idx ON dish_addons (addon_item_id);

-- ───────────── ③ 套餐 ─────────────
-- 一道菜有「含哪几样」就是套餐；价格是套餐这个价目项目自己的价格，子项不另算钱
CREATE TABLE dish_combo_items (
  combo_item_id  bigint NOT NULL REFERENCES service_items (id),
  item_id        bigint NOT NULL REFERENCES service_items (id),
  -- 每份套餐含几份
  quantity       integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  sort_no        integer NOT NULL DEFAULT 0 CHECK (sort_no >= 0),
  PRIMARY KEY (combo_item_id, item_id),
  CONSTRAINT dish_combo_items_not_self CHECK (combo_item_id <> item_id)
);
CREATE INDEX dish_combo_items_item_idx ON dish_combo_items (item_id);

-- 套餐不套套餐：子项自己不能是套餐，已经在别的套餐里的菜也不能再做成套餐。
-- 接口在锁住这几道菜以后核对过（docs/LOCKING.md 第 1 节），这里兜底
CREATE FUNCTION yuzu_dish_combo_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM dish_combo_items WHERE combo_item_id = NEW.item_id) THEN
    RAISE EXCEPTION '套餐里不能再放套餐' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM dish_combo_items WHERE item_id = NEW.combo_item_id) THEN
    RAISE EXCEPTION '这道菜已经在别的套餐里，不能再做成套餐' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dish_combo_items_guard BEFORE INSERT OR UPDATE ON dish_combo_items
  FOR EACH ROW EXECUTE FUNCTION yuzu_dish_combo_guard();

-- ───────────── ④ 菜品自己的图片 ─────────────
-- 菜品表、点单时的选项弹窗用；空着的带出电子菜单里那道菜的图（电子菜单的图仍在后台「电子菜单」里维护）
ALTER TABLE service_items ADD COLUMN dish_image_id bigint REFERENCES emenu_images (id);

-- ───────────── 出品单上的套餐内容 ─────────────
-- 下单当时套餐含哪几样（[{ "name": "柠檬茶", "quantity": 1 }]，每份套餐的份数）；不是套餐的为空数组。
-- 记快照：以后改了套餐的内容，已经下的单还是当时的
ALTER TABLE kitchen_items ADD COLUMN parts jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE kitchen_items ADD CONSTRAINT kitchen_items_parts_check CHECK (jsonb_typeof(parts) = 'array');

-- 出品单原来的保护（022）不知道这一列：另加一条，写入以后不可改
CREATE FUNCTION yuzu_kitchen_item_parts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parts IS DISTINCT FROM OLD.parts THEN
    RAISE EXCEPTION '出品单上的套餐内容不可修改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER kitchen_items_parts_guard BEFORE UPDATE ON kitchen_items
  FOR EACH ROW EXECUTE FUNCTION yuzu_kitchen_item_parts_guard();

-- ───────────── ⑤ 改价记录（只追加） ─────────────
-- 以前的订单照下单时的价：明细上本来就留着当时的单价（bill_lines.unit_price），改价不碰明细
CREATE TABLE dish_price_changes (
  id          bigserial PRIMARY KEY,
  item_id     bigint NOT NULL REFERENCES service_items (id),
  -- 当时的菜名（以后改了名，记录里还是当时的）
  item_name   text NOT NULL CHECK (char_length(item_name) BETWEEN 1 AND 32),
  -- 规格 = 价目里的档
  tier        text NOT NULL CHECK (tier IN ('standard', 'professional', 'premium')),
  -- 改前、改后（分）。改前为空 = 原来没有这一档（新建菜品的定价也记一条）；改后为空 = 去掉了这一档
  old_price   bigint CHECK (old_price > 0),
  new_price   bigint CHECK (new_price > 0),
  reason      text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 2 AND 100),
  -- 从哪里改的：菜品管理、菜品导入、后台价目（单个项目）、后台价目表导入
  source      text NOT NULL CHECK (source IN ('dishes', 'import', 'catalog', 'price_list')),
  -- 命令行导入价目表时没有经办人
  staff_id    bigint REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dish_price_changes_changed CHECK (old_price IS DISTINCT FROM new_price)
);
CREATE INDEX dish_price_changes_item_idx ON dish_price_changes (item_id, id);
CREATE TRIGGER dish_price_changes_append_only BEFORE UPDATE OR DELETE ON dish_price_changes
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- ───────────── ⑥ 菜品管理的操作编号（只追加） ─────────────
-- 新增、编辑、上下架、改价、导入各带一个操作编号：同一个编号、同样的内容重提返回第一次的结果（result），内容不同拒绝。
-- 菜品维护不是收款，不进门店的「结果待确认」（没有「确认作废」），所以不占 idempotency_keys / op_fences 的类型
CREATE TABLE dish_ops (
  client_key    uuid PRIMARY KEY,
  op_type       text NOT NULL CHECK (op_type IN ('create', 'update', 'active', 'price', 'import')),
  request_hash  text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  -- 哪道菜（导入是整批，为空）
  item_id       bigint REFERENCES service_items (id),
  -- 第一次的结果（导入：新建、修改、没变各几道）
  result        jsonb NOT NULL DEFAULT '{}'::jsonb,
  staff_id      bigint NOT NULL REFERENCES staff (id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER dish_ops_append_only BEFORE UPDATE OR DELETE ON dish_ops
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();
