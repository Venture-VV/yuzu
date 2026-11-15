-- 8.0.21 自定义字段（docs/FINANCE_V8021.md 第 1 节，CW-J / CW10 / CW12）：会员、供应商、物料、合同四类，每类启用的最多 10 个。
--
--   · custom_field_defs：定义。编号 key（f1…f99，按建的先后取）建了就不改；名称在启用的里面不重名；停用的不显示、值留着。
--   · custom_field_values：值。单独一张表，不加到业务表上——合同、物料、会员各有保护触发器与版本号，改扩展字段不应该动它们；
--     不进账务口径、不参与结账与任何计算。值都存成文字（数字、日期也是规范化以后的文字），按 (字段, 对象) 一格。
-- 数据字典（快捷原因）是一份设置（settings.dictionaries），不用表。

CREATE TABLE custom_field_defs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity      text NOT NULL CHECK (entity IN ('member', 'supplier', 'material', 'contract')),
  key         text NOT NULL CHECK (key ~ '^f[1-9][0-9]?$'),
  label       text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 12),
  type        text NOT NULL CHECK (type IN ('text', 'number', 'date', 'select')),
  -- 选项类的可选值（其余为空数组）
  options     jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(options) = 'array'),
  -- 列表里显示这一列
  in_list     boolean NOT NULL DEFAULT false,
  active      boolean NOT NULL DEFAULT true,
  sort        integer NOT NULL DEFAULT 0,
  version     integer NOT NULL DEFAULT 1,
  created_by  bigint NOT NULL REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity, key)
);
CREATE UNIQUE INDEX custom_field_defs_label_uq ON custom_field_defs (entity, label) WHERE active;

-- 不能删（值引用它）；类别与编号建了不改
CREATE FUNCTION yuzu_custom_field_def_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '自定义字段不能删除，不用了请停用' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.entity IS DISTINCT FROM OLD.entity OR NEW.key IS DISTINCT FROM OLD.key OR NEW.type IS DISTINCT FROM OLD.type THEN
    RAISE EXCEPTION '自定义字段的类别、编号、类型建了就不能改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER custom_field_defs_guard BEFORE UPDATE OR DELETE ON custom_field_defs
  FOR EACH ROW EXECUTE FUNCTION yuzu_custom_field_def_guard();

CREATE TABLE custom_field_values (
  field_id    bigint NOT NULL REFERENCES custom_field_defs (id),
  -- 会员、供应商、物料、合同的编号（不用外键：四类分在四张表；对象停用、作废也留着值）
  entity_id   bigint NOT NULL,
  value       text NOT NULL CHECK (char_length(value) BETWEEN 1 AND 200),
  updated_by  bigint NOT NULL REFERENCES staff (id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (field_id, entity_id)
);
CREATE INDEX custom_field_values_entity_idx ON custom_field_values (entity_id, field_id);
