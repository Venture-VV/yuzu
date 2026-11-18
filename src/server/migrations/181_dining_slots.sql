-- 181（8.1.7，迁移号在 docs/ROADMAP.md 第 7 节登记）：餐饮的点单分类（店主 2026-11-18《餐饮点单面板新增二级菜单 + 全模块分类改造》，
-- docs/DINING_V817.md 第 1 节，PENDING_DECISIONS.md CF1–CF3）。
--
-- 点单页先选一处（餐厅 restaurant / 水吧 water / 果吧 fruit），再按小分类点（餐厅：餐饮、酒水；水吧：手作饮料、糖水、调酒；果吧不分）；
-- 沽清列表、台账、退菜记录也按它分。单独记两列，不动价目表的 category（价目分类还管着部门营业额、券的适用范围、会员折扣）。
-- dining_outlet 为空的是后台还没设：页面按默认归（src/shared/dining.ts 的 diningSlotOf），升级以后什么都不用改就能用。
-- 入口与小分类配不配得上由接口核对（小分类的名单在代码里，CF1）；这里只约束入口是这三个之一、小分类不超过 8 个字、没设入口时小分类为空。

ALTER TABLE service_items ADD COLUMN dining_outlet text;
ALTER TABLE service_items ADD COLUMN dining_group text NOT NULL DEFAULT '';
ALTER TABLE service_items
  ADD CONSTRAINT service_items_dining_slot_check CHECK (
    (dining_outlet IS NULL AND dining_group = '')
    -- 写明 IS NOT NULL：dining_outlet 为空时 IN (...) 得 NULL，CHECK 会把 NULL 当作通过
    OR (dining_outlet IS NOT NULL AND dining_outlet IN ('restaurant', 'water', 'fruit') AND char_length(dining_group) <= 8)
  );
