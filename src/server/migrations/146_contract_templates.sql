-- 8.0.21 合同模板与起草（docs/FINANCE_V8021.md 第 6 节，CW-E / CW20）。
--   · contract_templates：合同正文的模板。正文是纯文本加段落，用 {{字段}} 占位（内置字段 + 模板自己的可填字段）；可选条款起草时勾选。
--     一份模板按 code 归在一起，每改一次写一份新版本（version + 1），旧版本停用（retired）；同一个 code 同时只有一份在用。
--     已经起草的合同在合同内容里记着用的是哪一行（id，即哪一版），模板改了不影响它。
--   · 合同内容（草稿、各版本）多一项 template：{ id, code, version, name, values, clauses }，跟着合同的版本走，不另建表。

CREATE TABLE contract_templates (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        text NOT NULL CHECK (code ~ '^[A-Za-z0-9-]{1,24}$'),
  version     integer NOT NULL CHECK (version >= 1),
  name        text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  category    text NOT NULL CHECK (category IN ('purchase', 'service', 'lease', 'other')),
  body        text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 30000),
  -- 可填字段：[{ key, label, type: text|number|date, required }]
  fields      jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(fields) = 'array'),
  -- 可选条款：[{ key, title, text, default }]
  clauses     jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(clauses) = 'array'),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_by  bigint NOT NULL REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  retired_by  bigint REFERENCES staff (id),
  retired_at  timestamptz,
  UNIQUE (code, version),
  CHECK ((status = 'retired') = (retired_at IS NOT NULL))
);
CREATE UNIQUE INDEX contract_templates_active_uq ON contract_templates (code) WHERE status = 'active';

-- 一份版本写好了内容不改（改 = 写新版本），只许停用；不能删（合同记着它）
CREATE FUNCTION yuzu_contract_template_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '合同模板不能删除，不用了请停用' USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'retired_by', 'retired_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'retired_by', 'retired_at']) THEN
    RAISE EXCEPTION '合同模板的一个版本写好了就不改，要改请存成新版本' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN
    RAISE EXCEPTION '停用的模板版本不能再启用，请存成新版本' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contract_templates_guard BEFORE UPDATE OR DELETE ON contract_templates
  FOR EACH ROW EXECUTE FUNCTION yuzu_contract_template_guard();
