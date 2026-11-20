-- 196（8.1.17，迁移号在 docs/ROADMAP.md 第 7 节登记）：菜品管理补完（店主 2026-11-20「剩下的……接着做，放 8.1.17」；
-- docs/YUZU_REQ_V8117.md BW-6、BW-8、BW-10，设计 docs/DISHES_V8117.md，默认做法 docs/PENDING_DECISIONS.md BW6、BW8、BW10）。
--   ① 做法分组、加价、必选（BW6）：dish_method_groups 记一道菜的做法分哪几组、哪一组必选；dish_methods 加所在的组
--      （空 = 不分组，照旧可以多选）与加价（分，按份加在这一行的单价上；0 = 不加钱）；
--   ② 加料挂在主菜那一行上（BW8）：bill_lines.addon_of 指向同一张账单上主菜的那一行（退主菜时问要不要一起退）；
--      明细的保护函数把它算进「写入以后不能改」的几列；
--   ③ 菜品排序与删除（BW10）：service_items.dish_sort（同一个点单小类里的先后；空 = 没排过，排在排过的后面、照原来的顺序）；
--      dish_deleted_at / dish_deleted_by：删除 = 下架并从菜品表默认隐藏（价目项目不删，以前的订单、账单、报表照旧）；
--      不管从哪里重新上架（菜品表的「恢复」以后上架、后台价目、导入），就不再算删除；
--   ④ 出品单的口味备注放宽到 200 字：做法带上加价（「微辣 +¥2」）、换菜、平板的整单备注拼在一起放得下（点单页手写的备注照旧 40 字）；
--   ⑤ 菜品管理的操作编号（dish_ops）多四种：批量上下架、删除、恢复、排序（在当时的约束上追加）。
-- 都是加表、加列、放宽约束：老的价目、订单、出品单一行不动；不设分组、加价、排序时点单与以前一样。

-- ───────────── ① 做法分组、加价、必选 ─────────────
-- 保存一道菜时与做法一起整批换（先删做法、再删分组，再按新的写）
CREATE TABLE dish_method_groups (
  item_id   bigint NOT NULL REFERENCES service_items (id),
  -- 辣度、冰量、甜度……最多 6 个字，前后不带空格
  name      text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 6 AND name = btrim(name)),
  -- 必选：点单时这一组不选一个不能下单
  required  boolean NOT NULL DEFAULT false,
  sort_no   integer NOT NULL DEFAULT 0 CHECK (sort_no >= 0),
  PRIMARY KEY (item_id, name)
);

-- 做法所在的组（空 = 不分组）与加价（按份加在这一行的单价上，最多 ¥999）
ALTER TABLE dish_methods
  ADD COLUMN group_name text,
  ADD COLUMN price bigint NOT NULL DEFAULT 0 CHECK (price BETWEEN 0 AND 99900),
  ADD CONSTRAINT dish_methods_group_fk FOREIGN KEY (item_id, group_name) REFERENCES dish_method_groups (item_id, name);

-- ───────────── ② 加料挂在主菜那一行上 ─────────────
-- 同一次下单里加料那一行指向它的主菜（同一张账单，主菜先写、编号更小）；老的明细、不是加料的为空
ALTER TABLE bill_lines
  ADD COLUMN addon_of bigint REFERENCES bill_lines (id),
  ADD CONSTRAINT bill_lines_addon_not_self CHECK (addon_of <> id);
CREATE INDEX bill_lines_addon_of_idx ON bill_lines (addon_of) WHERE addon_of IS NOT NULL;

-- 明细的保护（107 的版本）把 addon_of 加进不能改的几列：作废时、钟房补记技师时都不能动它
CREATE OR REPLACE FUNCTION yuzu_bill_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bill_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '账单明细禁止删除，请作废并填写原因' USING ERRCODE = 'P0001';
  END IF;
  SELECT status INTO bill_status FROM bills WHERE id = NEW.bill_id;
  IF bill_status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION '账单已结束，不能再挂账或更正' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' THEN
      RAISE EXCEPTION '新登记的明细必须为有效状态' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'active' AND NEW.status = 'voided'
     AND (NEW.id, NEW.bill_id, NEW.source, NEW.item_id, NEW.name, NEW.unit_price, NEW.quantity, NEW.amount,
          NEW.post_key, NEW.business_date, NEW.posted_by, NEW.posted_at,
          NEW.tier, NEW.ticket_type_id, NEW.ticket_segments, NEW.technician_id, NEW.call_type, NEW.session_id, NEW.addon_of)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.bill_id, OLD.source, OLD.item_id, OLD.name, OLD.unit_price, OLD.quantity, OLD.amount,
          OLD.post_key, OLD.business_date, OLD.posted_by, OLD.posted_at,
          OLD.tier, OLD.ticket_type_id, OLD.ticket_segments, OLD.technician_id, OLD.call_type, OLD.session_id, OLD.addon_of) THEN
    RETURN NEW;
  END IF;
  -- 8.0.8：钟房给「交给钟房派钟」的技师明细补记技师（只此一次）
  IF OLD.status = 'active' AND NEW.status = 'active' AND OLD.source = 'therapist'
     AND OLD.technician_id IS NULL AND OLD.call_type IS NULL AND OLD.session_id IS NULL
     AND NEW.technician_id IS NOT NULL AND NEW.call_type IS NOT NULL AND NEW.session_id IS NOT NULL
     AND (NEW.id, NEW.bill_id, NEW.source, NEW.item_id, NEW.name, NEW.unit_price, NEW.quantity, NEW.amount,
          NEW.post_key, NEW.business_date, NEW.posted_by, NEW.posted_at,
          NEW.tier, NEW.ticket_type_id, NEW.ticket_segments, NEW.void_reason, NEW.voided_by, NEW.voided_at, NEW.addon_of)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.bill_id, OLD.source, OLD.item_id, OLD.name, OLD.unit_price, OLD.quantity, OLD.amount,
          OLD.post_key, OLD.business_date, OLD.posted_by, OLD.posted_at,
          OLD.tier, OLD.ticket_type_id, OLD.ticket_segments, OLD.void_reason, OLD.voided_by, OLD.voided_at, OLD.addon_of) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '账单明细只能作废，不能修改' USING ERRCODE = 'P0001';
END $$;

-- ───────────── ③ 菜品排序与删除 ─────────────
ALTER TABLE service_items
  ADD COLUMN dish_sort integer CHECK (dish_sort >= 0),
  ADD COLUMN dish_deleted_at timestamptz,
  ADD COLUMN dish_deleted_by bigint REFERENCES staff (id),
  ADD CONSTRAINT service_items_dish_deleted_check CHECK ((dish_deleted_at IS NULL) = (dish_deleted_by IS NULL)),
  -- 删除了的一定是下架的
  ADD CONSTRAINT service_items_dish_deleted_off CHECK (dish_deleted_at IS NULL OR NOT active);

-- 不管从哪里重新上架（后台价目、价目表导入、菜品导入……），就不再算删除：清掉删除标记
CREATE FUNCTION yuzu_dish_undelete_on_active() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.active AND NEW.dish_deleted_at IS NOT NULL THEN
    NEW.dish_deleted_at := NULL;
    NEW.dish_deleted_by := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER service_items_dish_undelete BEFORE UPDATE OF active ON service_items
  FOR EACH ROW WHEN (NEW.active AND NOT OLD.active) EXECUTE FUNCTION yuzu_dish_undelete_on_active();

-- ───────────── ④ 出品单的口味备注放宽到 200 字 ─────────────
ALTER TABLE kitchen_items DROP CONSTRAINT kitchen_items_note_check;
ALTER TABLE kitchen_items ADD CONSTRAINT kitchen_items_note_check CHECK (char_length(note) <= 200);

-- ───────────── ⑤ 菜品管理的操作编号多四种（在当时的约束上追加） ─────────────
DO $$
DECLARE expression text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = 'dish_ops'::regclass AND conname = 'dish_ops_op_type_check';
  IF expression IS NULL THEN RAISE EXCEPTION '菜品操作编号的类型约束 dish_ops_op_type_check 不存在'; END IF;
  ALTER TABLE dish_ops DROP CONSTRAINT dish_ops_op_type_check;
  EXECUTE format('ALTER TABLE dish_ops ADD CONSTRAINT dish_ops_op_type_check CHECK ((%s) OR op_type IN (''bulk_active'', ''delete'', ''restore'', ''sort''))', expression);
END $$;
