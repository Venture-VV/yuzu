-- 8.0.4 会员体系整改（docs/MEMBERSHIP_V804.md）：
--   · 第 5 节 会员标签：自定义字段全部转成标签（字段名做分组，填过的值做标签，单选的可选值都建好）；
--     原来的 custom_fields 原样留在会员档案里不删（只读、不再显示），一个值也不会丢；
--   · 第 2 节 VIP 柜归「会员权益」：各档能用几级柜（原在 membership_rules）、当场授权开关（原在 frontdesk_rules）
--     合成一份设置 vip_locker_rules，原来的值原样搬过来，再从原来两份设置里删掉；
--   · 第 3 节 次卡停售：count_card_sales = false（已售的次卡照常用、退、打印）。

-- ───────────────────────── 会员标签 ─────────────────────────

CREATE TABLE member_tags (
  id          bigserial PRIMARY KEY,
  -- 分组（转来的标签是原来的字段名，例如「了解渠道」；手工建的可以不分组）
  group_name  text NOT NULL DEFAULT '' CHECK (char_length(group_name) <= 16),
  -- 手工建的最多 16 个字（页面与接口限制）；转来的是原来字段里填的值，文字字段最多 100 个字
  name        text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  source      text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'field')),
  -- 转来的标签记着原来的字段编号（f1、f2……）
  field_key   text,
  active      boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0,
  version     integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by  bigint REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  bigint REFERENCES staff (id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_name, name),
  CHECK ((source = 'field') = (field_key IS NOT NULL))
);

-- 标签不能删（只能停用）；来源、建档信息不能改
CREATE FUNCTION yuzu_member_tag_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '会员标签不能删除，请停用' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.source, NEW.field_key, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.source, OLD.field_key, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION '会员标签的来源与建档信息不能改' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER member_tags_guard BEFORE UPDATE OR DELETE ON member_tags
  FOR EACH ROW EXECUTE FUNCTION yuzu_member_tag_guard();

-- 会员挂了哪些标签（编辑会员时整组替换；挂、摘留在会员的审计里）
CREATE TABLE member_tag_links (
  member_id  bigint NOT NULL REFERENCES members (id),
  tag_id     bigint NOT NULL REFERENCES member_tags (id),
  created_by bigint REFERENCES staff (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, tag_id)
);
CREATE INDEX member_tag_links_tag_idx ON member_tag_links (tag_id, member_id);

-- 自定义字段转标签：每个字段名做一个分组；单选字段的每个可选值、每个字段里填过的每个值各做一个标签；
-- 停用的字段转成停用的标签（已挂的照样挂着）
WITH defs AS (
  SELECT d->>'key' AS key, left(btrim(coalesce(d->>'label', '')), 16) AS label, d->>'type' AS type,
         coalesce((d->>'active')::boolean, true) AS active,
         CASE WHEN jsonb_typeof(d->'options') = 'array' THEN d->'options' ELSE '[]'::jsonb END AS options, ord
  FROM settings s
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.value) = 'array' THEN s.value ELSE '[]'::jsonb END) WITH ORDINALITY AS t(d, ord)
  WHERE s.key = 'member_fields' AND coalesce(d->>'key', '') <> ''
), candidates AS (
  SELECT d.key, d.label, d.active, d.ord, left(btrim(o.value), 100) AS value, o.n AS n
  FROM defs d CROSS JOIN LATERAL jsonb_array_elements_text(d.options) WITH ORDINALITY AS o(value, n)
  WHERE d.type = 'select' AND btrim(o.value) <> ''
  UNION ALL
  SELECT DISTINCT d.key, d.label, d.active, d.ord, left(btrim(m.custom_fields->>d.key), 100), 999
  FROM members m JOIN defs d ON m.custom_fields ? d.key
  WHERE btrim(coalesce(m.custom_fields->>d.key, '')) <> ''
)
INSERT INTO member_tags (group_name, name, source, field_key, active, sort_order)
SELECT label, value, 'field', key, active, (ord * 1000 + n)::integer
FROM candidates
ORDER BY ord, n, value
ON CONFLICT (group_name, name) DO NOTHING;

-- 按「分组（字段名）+ 值」挂：两个字段名字相同时，值相同的合成一个标签，两边的会员都挂上（一个值也不丢）
WITH defs AS (
  SELECT d->>'key' AS key, left(btrim(coalesce(d->>'label', '')), 16) AS label
  FROM settings s
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.value) = 'array' THEN s.value ELSE '[]'::jsonb END) AS t(d)
  WHERE s.key = 'member_fields' AND coalesce(d->>'key', '') <> ''
)
INSERT INTO member_tag_links (member_id, tag_id, created_at)
SELECT m.id, t.id, m.created_at
FROM members m
JOIN defs d ON m.custom_fields ? d.key
JOIN member_tags t ON t.group_name = d.label AND t.name = left(btrim(m.custom_fields->>d.key), 100)
WHERE btrim(coalesce(m.custom_fields->>d.key, '')) <> ''
ON CONFLICT DO NOTHING;

-- 需求里举的两个客群标签（HY06）
INSERT INTO member_tags (group_name, name, source, sort_order) VALUES ('客群', '亲子客', 'manual', 1), ('客群', '商务客', 'manual', 2)
ON CONFLICT (group_name, name) DO NOTHING;

-- ───────────────────────── VIP 柜设置归「会员权益」 ─────────────────────────

INSERT INTO settings (key, value, updated_at)
SELECT 'vip_locker_rules',
       jsonb_build_object(
         'levels', coalesce((SELECT value->'vipLockerLevels' FROM settings WHERE key = 'membership_rules' AND jsonb_typeof(value->'vipLockerLevels') = 'array'),
                            '[1, 1, 1, 1, 2, 4, 5]'::jsonb),
         'overrideEnabled', coalesce((SELECT value->'vipOverrideEnabled' FROM settings WHERE key = 'frontdesk_rules' AND jsonb_typeof(value->'vipOverrideEnabled') = 'boolean'),
                                     'false'::jsonb)),
       now()
ON CONFLICT (key) DO NOTHING;
UPDATE settings SET value = value - 'vipLockerLevels' WHERE key = 'membership_rules' AND value ? 'vipLockerLevels';
UPDATE settings SET value = value - 'vipOverrideEnabled' WHERE key = 'frontdesk_rules' AND value ? 'vipOverrideEnabled';

-- ───────────────────────── 次卡停售 ─────────────────────────

INSERT INTO settings (key, value) VALUES ('count_card_sales', 'false'::jsonb) ON CONFLICT (key) DO NOTHING;
