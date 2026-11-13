-- 123 电子菜单的英文（8.0.13，docs/EMENU.md 第 11 节）：外宾在平板上点「中 / EN」切到英文时显示。
--   · 菜品图文：名称后小字的英文、英文介绍、属性行的英文、单位的英文（英文名 name_en 在 121 里就有）；
--   · 规格：规格名的英文（大份 → Large）。
-- 只加列、都有默认值：旧数据不动；没填英文的地方平板上仍显示中文。单位、规格常见的英文内置在程序里（src/shared/emenu.ts），
-- 这里填了的以这里的为准。
-- 中英切换与动效的开关、忌口与起菜方式选项的英文存在 settings 的 emenu_rules 里，不用迁移。

ALTER TABLE emenu_dishes
  ADD COLUMN tagline_en      text NOT NULL DEFAULT '' CHECK (char_length(tagline_en) <= 80),
  ADD COLUMN description_en  text NOT NULL DEFAULT '' CHECK (char_length(description_en) <= 400),
  -- 属性行的英文（一行一条，最多 3 条）；空着时平板上仍显示中文的属性行
  ADD COLUMN attrs_en        text[] NOT NULL DEFAULT '{}' CHECK (cardinality(attrs_en) <= 3),
  ADD COLUMN unit_en         text NOT NULL DEFAULT '' CHECK (char_length(unit_en) <= 12);

ALTER TABLE emenu_dish_specs
  ADD COLUMN label_en  text NOT NULL DEFAULT '' CHECK (char_length(label_en) <= 16);
