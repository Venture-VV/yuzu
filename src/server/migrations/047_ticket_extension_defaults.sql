-- 047 浴票延迟的默认分钟数（v0.7.26；PENDING_DECISIONS M50，店主 2026-11-04 定：各档的分钟数按开发会话的默认）。
--   已经导入、还没人动过的 QY-004（浴票延迟、草稿、版本 1、起点 L1·尊、没填分钟数）补上默认：
--   从 L1·初 起 30 分钟；各档阶表 L1·享 60、L1·尊 90，L2–L6 每一档初阶 30、享阶 60、尊阶 90 分钟（共 17 行，
--   与导入清单的 TICKET_EXTENSION_DEFAULT_ROWS 一样）。
--   仍是草稿、不改版本号（与 042 预填 QY-011 的折扣一样），店主或店总在后台「会员权益」核对后发布才生效；改过的不动。
-- 只改这一条权益，不改结账数据。

UPDATE benefits
SET start_grade = 1, start_tier = 0, quantity = 30,
    tier_quantities = (
      SELECT jsonb_agg(jsonb_build_object('grade', g, 'tier', t, 'quantity', (ARRAY[30, 60, 90])[t + 1]) ORDER BY g, t)
      FROM generate_series(1, 6) AS g, generate_series(0, 2) AS t
      WHERE g > 1 OR t > 0)
WHERE code = 'QY-004' AND category = 'extension' AND status = 'draft' AND version = 1
  AND start_grade = 1 AND start_tier = 2 AND period = 'none'
  AND quantity IS NULL AND tier_quantities = '[]'::jsonb AND template_id IS NULL;
