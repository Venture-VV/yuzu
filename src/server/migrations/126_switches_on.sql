-- 8.0.20：功能开关都默认开（店主 2026-11-14：「把所有功能开关（以往和现在的）都默认为开启，我们后续才会考虑关闭」，
-- docs/PENDING_DECISIONS.md KG1–KG4）。
--
-- 代码里的默认值这一版起都是开（没保存过设置的库直接跟着变）；这里把已经保存成「关」的也改成开：
--   · 技师与钟房、客房、平板点餐、实时位置：各自规则里的 enabled；
--   · 餐饮：enabled 与桌台 tablesEnabled；
--   · ERP 模块开关：存着的每一项都改成开（没存的跟默认，默认现在也都是开）；
--   · 每周一推企业微信：wecom_weekly_push（没配机器人地址时照旧什么都不发）。
-- 只改这几个键里的这几项，别的数不动；之后要关的在各自的设置页关。
--
-- 没有动的（KG3、KG4）：售次卡 count_card_sales（8.0.4 定的停售）、点单密码 requirePin、员工自己登记 canteen_registration、
-- 每日截单与只向准入供应商下单等规矩类的选项，以及小程序线的开关（mp_*）。

UPDATE settings SET value = value || '{"enabled": true}'::jsonb, updated_at = now()
WHERE key IN ('technician_rules', 'room_rules', 'emenu_rules', 'location_rules')
  AND jsonb_typeof(value) = 'object' AND value -> 'enabled' = 'false'::jsonb;

UPDATE settings SET value = value || '{"enabled": true, "tablesEnabled": true}'::jsonb, updated_at = now()
WHERE key = 'dining_rules' AND jsonb_typeof(value) = 'object'
  AND (value -> 'enabled' = 'false'::jsonb OR value -> 'tablesEnabled' = 'false'::jsonb);

UPDATE settings SET value = (SELECT jsonb_object_agg(k, CASE WHEN v = 'false'::jsonb THEN 'true'::jsonb ELSE v END) FROM jsonb_each(value) AS e(k, v)),
       updated_at = now()
WHERE key = 'erp_modules' AND jsonb_typeof(value) = 'object'
  AND EXISTS (SELECT 1 FROM jsonb_each(value) AS e(k, v) WHERE v = 'false'::jsonb);

UPDATE settings SET value = 'true'::jsonb, updated_at = now()
WHERE key = 'wecom_weekly_push' AND value = 'false'::jsonb;
