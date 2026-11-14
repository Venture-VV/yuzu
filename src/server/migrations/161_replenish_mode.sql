-- 161 物料的补货方式（店主 2026-11-14，docs/ERP_PURCHASING.md 第 5.1 节，PENDING_DECISIONS E9–E12；独立 PR、不改版本号）。
-- 原来补货建议把所有受管物料都当成要备货的：近期从总仓领过一次就按日均用量算可用天数，
-- 手机这类部门提了需求才买的东西，领走以后总仓会一直出补货建议。
--   · auto      自动识别（默认，已有物料都是它）：设了提醒天数或低库存提醒数量的算常备；建过资产卡片的不提；
--               近 90 天有领用的天数不到「常用天数」（采购规则，默认 2 天）的看作一次性采购、不提；
--   · stock     常备：一直按用量 / 提醒数量提补货；
--   · on_demand 按需采购：不提补货，也不做低库存提醒。
-- 只加一列、默认 auto，不动已有数据。

ALTER TABLE materials ADD COLUMN replenish_mode text NOT NULL DEFAULT 'auto' CHECK (replenish_mode IN ('auto', 'stock', 'on_demand'));
