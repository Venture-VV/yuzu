-- 045 会员体系 v2 第三期续（v0.7.25，docs/MEMBERSHIP_P3.md 第 4 节；PENDING_DECISIONS M50、M63–M66）：浴票延迟（QY-004）。
--   ① 权益加类别「浴票延迟」（extension）：结账时会员的门票在「门票跳档宽限」之上再多给几分钟不跳档。
--      起点与各档阶的分钟数放在原来的数量列与各档阶表里（1–240 分钟），不计次、不发券；发布要填好起点的分钟数。
--      已经导入、还没人动过的 QY-004（服务与资格、草稿、版本 1）改成这一类，仍是草稿、不预填分钟数
--      （会员文档的起点 L1·尊 与梯度「初阶 30 分钟、享阶 1 小时、尊阶 1.5—2 小时」对不上，等店主填好再发布，M50）
--   ② 结账单的每位客人记下浴票延迟了多少分钟、按哪一项权益（没有的是 0）
-- 不改已有的结账数据；权益只改上面那一条没人动过的草稿的类别。

-- ───────────── ① 权益类别「浴票延迟」 ─────────────
ALTER TABLE benefits DROP CONSTRAINT benefits_category_check;
ALTER TABLE benefits ADD CONSTRAINT benefits_category_check
  CHECK (category IN ('coupon', 'event', 'service', 'discount', 'info', 'extension'));

-- 数量：券类张数、服务类次数、折扣的「付几成」都是 1–99；浴票延迟是分钟数 1–240
ALTER TABLE benefits DROP CONSTRAINT benefits_quantity_check;
ALTER TABLE benefits ADD CONSTRAINT benefits_quantity_check
  CHECK (quantity BETWEEN 1 AND 99 OR (category = 'extension' AND quantity BETWEEN 1 AND 240));

-- 浴票延迟不计次、不发券；发布要有起点的分钟数（各档阶的分钟数由应用核对）
ALTER TABLE benefits ADD CONSTRAINT benefits_extension_check
  CHECK (category <> 'extension' OR (period = 'none' AND template_id IS NULL AND cardinality(events) = 0 AND cardinality(festival_dates) = 0));
ALTER TABLE benefits ADD CONSTRAINT benefits_extension_publish_check
  CHECK (status <> 'published' OR category <> 'extension' OR quantity IS NOT NULL);

UPDATE benefits SET category = 'extension'
WHERE code = 'QY-004' AND category = 'service' AND status = 'draft' AND version = 1
  AND period = 'none' AND quantity IS NULL AND tier_quantities = '[]'::jsonb AND template_id IS NULL;

-- ───────────── ② 结账单记下浴票延迟 ─────────────
-- 门票按在店时长、「门票跳档宽限」加上这几分钟算段数；桌台结账、没有会员的客人是 0
ALTER TABLE checkout_bills
  ADD COLUMN ticket_extension_minutes smallint NOT NULL DEFAULT 0 CHECK (ticket_extension_minutes BETWEEN 0 AND 240),
  ADD COLUMN ticket_extension_benefit_id bigint REFERENCES benefits (id),
  ADD CONSTRAINT checkout_bills_extension_check CHECK ((ticket_extension_minutes > 0) = (ticket_extension_benefit_id IS NOT NULL));
