-- 8.0.8 前台整改 · 客房与派对房（docs/FRONTDESK_V808.md 第 3、4、6 节）：
--   ① 预约到店入住（A04）：入住单记预约编号，一张预约只能有一张没撤销的入住单（部分唯一索引兜底）。
--   ② 房态记录（B04）：每次改房态记一条（手动改、撤回、入住退房换房撤销时自动改），只追加；一次手动修改只能撤回一次。
--   ③ 派对房统计（A03，F8）：结账时营业额按部门的快照里，派对房、宠物轰趴房等的房费、开台费按房间的业态记部门、名称记「房费」「开台费」
--      （原来按计费项目的类别与名称，几种房共用一个计费项目时分不开）。只影响升级之后的结账，已经记下的快照不变。
-- 只加表、加列，改一个快照函数（042 的版本上只多派对房这一类）。

ALTER TABLE room_stays ADD COLUMN booking_id bigint REFERENCES bookings (id);
CREATE UNIQUE INDEX room_stays_booking_uq ON room_stays (booking_id) WHERE booking_id IS NOT NULL AND status <> 'cancelled';

CREATE TABLE room_housekeeping_events (
  id          bigserial PRIMARY KEY,
  room_id     bigint NOT NULL REFERENCES rooms (id),
  from_state  text NOT NULL CHECK (from_state IN ('clean', 'dirty', 'maintenance')),
  to_state    text NOT NULL CHECK (to_state IN ('clean', 'dirty', 'maintenance')),
  note        text NOT NULL DEFAULT '' CHECK (char_length(note) <= 100),
  -- manual 手动改 / revert 撤回上一次手动修改 / auto 入住、退房、换房、撤销入住时自动改
  source      text NOT NULL CHECK (source IN ('manual', 'revert', 'auto')),
  reverts_id  bigint REFERENCES room_housekeeping_events (id),
  -- 自动改的那张入住单号
  ref         text NOT NULL DEFAULT '' CHECK (char_length(ref) <= 32),
  staff_id    bigint NOT NULL REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (from_state <> to_state),
  CHECK ((source = 'revert') = (reverts_id IS NOT NULL))
);
CREATE INDEX room_housekeeping_events_room_idx ON room_housekeeping_events (room_id, id);
CREATE UNIQUE INDEX room_housekeeping_events_revert_uq ON room_housekeeping_events (reverts_id) WHERE reverts_id IS NOT NULL;
CREATE TRIGGER room_housekeeping_events_append_only BEFORE UPDATE OR DELETE ON room_housekeeping_events
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

CREATE OR REPLACE FUNCTION yuzu_snapshot_checkout_items(p_checkout bigint, p_current boolean) RETURNS void LANGUAGE sql AS $$
  WITH c AS (SELECT id, created_at FROM checkouts WHERE id = p_checkout),
  cl AS (
    SELECT coalesce((SELECT coupon_lines FROM checkout_payments
                     WHERE checkout_id = p_checkout AND method IN ('store_coupon', 'member_discount')), '{}'::bigint[]) AS ids
  ),
  l AS (
    SELECT CASE WHEN l.ticket_type_id IS NOT NULL THEN '门票'
                WHEN l.source = 'room' THEN '客房'
                WHEN uc.line_id IS NOT NULL THEN coalesce(nullif(sp.business_type, ''), '派对房')
                WHEN l.item_id IS NULL THEN '其他（手动金额、赔偿等）'
                ELSE coalesce(nullif(si.category, ''), '未分类') END AS category,
           CASE WHEN rc.kind = 'night' THEN '房费（全天房）' WHEN rc.kind = 'half_day' THEN '超时半天' WHEN rc.kind = 'block' THEN '钟点房'
                WHEN uc.kind = 'fee' THEN '房费' WHEN uc.kind = 'open_fee' THEN '开台费' ELSE l.name END AS name,
           l.quantity, l.amount, l.id = ANY (cl.ids) AS in_coupon
    FROM c CROSS JOIN cl JOIN checkout_bills cb ON cb.checkout_id = c.id
    JOIN bill_lines l ON l.bill_id = cb.bill_id
     AND CASE WHEN p_current THEN l.status = 'active'
              ELSE l.posted_at <= c.created_at AND (l.voided_at IS NULL OR l.voided_at > c.created_at) END
    LEFT JOIN service_items si ON si.id = l.item_id
    LEFT JOIN room_stay_charges rc ON rc.line_id = l.id
    LEFT JOIN space_usage_charges uc ON uc.line_id = l.id
    LEFT JOIN space_usages su ON su.id = uc.usage_id
    LEFT JOIN spaces sp ON sp.id = su.space_id
  ),
  r AS (
    SELECT category, name, sum(quantity)::int AS quantity, sum(amount)::bigint AS amount,
           coalesce(sum(amount) FILTER (WHERE in_coupon), 0)::bigint AS coupon_base
    FROM l GROUP BY 1, 2
  ),
  d AS (
    SELECT coalesce(sum(amount) FILTER (WHERE method = 'discount'), 0)::bigint AS disc,
           coalesce(sum(amount) FILTER (WHERE method IN ('store_coupon', 'member_discount')), 0)::bigint AS coup
    FROM checkout_payments WHERE checkout_id = p_checkout
  ),
  t AS (SELECT coalesce(sum(amount), 0)::bigint AS total, coalesce(sum(coupon_base), 0)::bigint AS coupon_total FROM r),
  b AS (
    SELECT r.category, r.name, r.quantity, r.amount, r.coupon_base,
           CASE WHEN t.total > 0 THEN (r.amount * d.disc) / t.total ELSE 0 END AS share,
           CASE WHEN t.total > 0 THEN (r.amount * d.disc) % t.total ELSE 0 END AS frac,
           CASE WHEN t.coupon_total > 0 THEN (r.coupon_base * d.coup) / t.coupon_total ELSE 0 END AS cshare,
           CASE WHEN t.coupon_total > 0 THEN (r.coupon_base * d.coup) % t.coupon_total ELSE 0 END AS cfrac
    FROM r, d, t
  ),
  ranked AS (
    SELECT b.*,
           row_number() OVER (ORDER BY b.frac DESC, b.amount DESC, b.category COLLATE "C", b.name COLLATE "C") AS rn,
           row_number() OVER (ORDER BY b.cfrac DESC, b.coupon_base DESC, b.category COLLATE "C", b.name COLLATE "C") AS crn
    FROM b
  ),
  left_over AS (
    SELECT d.disc - coalesce((SELECT sum(share) FROM b), 0) AS n,
           d.coup - coalesce((SELECT sum(cshare) FROM b), 0) AS cn
    FROM d
  )
  INSERT INTO checkout_items (checkout_id, category, name, quantity, amount, discount)
  SELECT p_checkout, x.category, x.name, x.quantity, x.amount,
         x.share + CASE WHEN x.rn <= lo.n THEN 1 ELSE 0 END
         + x.cshare + CASE WHEN x.crn <= lo.cn AND x.coupon_base > 0 THEN 1 ELSE 0 END
  FROM ranked x, left_over lo
$$;
