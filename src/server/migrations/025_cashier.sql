-- 收银完善第一步（v0.7.6，店主 2026-10-31 同意，见 docs/CASHIER.md）：
--   ① 结账时的部门营业额快照：每张结账单按部门（项目分类）、项目记下数量与金额，优惠 / 免单按金额比例分摊到各项；
--      以后改价目、改分类不影响已结的单。升级时给已有的结账单按原来的算法补记。
--   ② 明细转到另一张手牌：原明细作废、目标手牌新增一条同样的明细，记下转单记录。
-- 只加表与函数、放宽幂等的业务类型，不改已有数据。

-- ───────────── ① 部门营业额快照 ─────────────
CREATE TABLE checkout_items (
  checkout_id bigint NOT NULL REFERENCES checkouts (id),
  -- 部门：门票、客房、其他（手动金额、赔偿等）、价目里的分类（没填的记「未分类」）
  category    text NOT NULL,
  -- 项目：明细名称；房费按种类合并（房费（全天房）、超时半天、钟点房）
  name        text NOT NULL,
  quantity    integer NOT NULL CHECK (quantity > 0),
  amount      bigint NOT NULL CHECK (amount > 0),
  -- 分摊到这一项的优惠 / 免单
  discount    bigint NOT NULL CHECK (discount >= 0 AND discount <= amount),
  PRIMARY KEY (checkout_id, category, name)
);
CREATE TRIGGER checkout_items_append_only BEFORE UPDATE OR DELETE ON checkout_items
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- 记下一张结账单的快照，优惠按金额比例分摊到分，分以下的尾差按舍去部分从大到小逐项补 1 分（最大余数法），
-- 分摊合计正好等于优惠，每项不超过它的金额。用哪些明细：
--   p_current = true：这张结账单所结账单上现在的有效明细，就是这次结掉的（结账时与结账金额一致；补录到更早时刻的结账也一样）。
--     结账（手牌、桌台）在记好收款之后调用；升级补记时，没反结账过的结账单的账单至今仍是它结的，也这样记。
--   p_current = false：按结账那一刻的明细重建（与之前报表的算法相同），只用于升级补记反结账过的结账单。
CREATE FUNCTION yuzu_snapshot_checkout_items(p_checkout bigint, p_current boolean) RETURNS void LANGUAGE sql AS $$
  WITH c AS (SELECT id, created_at FROM checkouts WHERE id = p_checkout),
  r AS (
    SELECT CASE WHEN l.ticket_type_id IS NOT NULL THEN '门票'
                WHEN l.source = 'room' THEN '客房'
                WHEN l.item_id IS NULL THEN '其他（手动金额、赔偿等）'
                ELSE coalesce(nullif(si.category, ''), '未分类') END AS category,
           CASE rc.kind WHEN 'night' THEN '房费（全天房）' WHEN 'half_day' THEN '超时半天' WHEN 'block' THEN '钟点房' ELSE l.name END AS name,
           sum(l.quantity)::int AS quantity, sum(l.amount)::bigint AS amount
    FROM c JOIN checkout_bills cb ON cb.checkout_id = c.id
    JOIN bill_lines l ON l.bill_id = cb.bill_id
     AND CASE WHEN p_current THEN l.status = 'active'
              ELSE l.posted_at <= c.created_at AND (l.voided_at IS NULL OR l.voided_at > c.created_at) END
    LEFT JOIN service_items si ON si.id = l.item_id
    LEFT JOIN room_stay_charges rc ON rc.line_id = l.id
    GROUP BY 1, 2
  ),
  d AS (SELECT coalesce(sum(amount), 0)::bigint AS disc FROM checkout_payments WHERE checkout_id = p_checkout AND method = 'discount'),
  t AS (SELECT coalesce(sum(amount), 0)::bigint AS total FROM r),
  b AS (
    SELECT r.category, r.name, r.quantity, r.amount,
           CASE WHEN t.total > 0 THEN (r.amount * d.disc) / t.total ELSE 0 END AS share,
           CASE WHEN t.total > 0 THEN (r.amount * d.disc) % t.total ELSE 0 END AS frac
    FROM r, d, t
  ),
  ranked AS (
    SELECT b.*, row_number() OVER (ORDER BY b.frac DESC, b.amount DESC, b.category COLLATE "C", b.name COLLATE "C") AS rn
    FROM b
  ),
  left_over AS (SELECT d.disc - coalesce((SELECT sum(share) FROM b), 0) AS n FROM d)
  INSERT INTO checkout_items (checkout_id, category, name, quantity, amount, discount)
  SELECT p_checkout, x.category, x.name, x.quantity, x.amount, x.share + CASE WHEN x.rn <= lo.n THEN 1 ELSE 0 END
  FROM ranked x, left_over lo
$$;

SELECT yuzu_snapshot_checkout_items(id, status = 'completed') FROM checkouts ORDER BY id;

-- ───────────── ② 明细转到另一张手牌 ─────────────
CREATE TABLE bill_line_moves (
  id             bigserial PRIMARY KEY,
  -- 转单的操作编号（同一次转的几条明细共用）
  op_key         uuid NOT NULL,
  from_line_id   bigint NOT NULL UNIQUE REFERENCES bill_lines (id),
  to_line_id     bigint NOT NULL UNIQUE REFERENCES bill_lines (id),
  from_visit_id  bigint NOT NULL REFERENCES visits (id),
  to_visit_id    bigint NOT NULL REFERENCES visits (id),
  reason         text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 2 AND 200),
  operator_id    bigint NOT NULL REFERENCES staff (id),
  business_date  date NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (from_visit_id <> to_visit_id),
  CHECK (from_line_id <> to_line_id)
);
CREATE INDEX bill_line_moves_op_idx ON bill_line_moves (op_key);
CREATE INDEX bill_line_moves_from_visit_idx ON bill_line_moves (from_visit_id);
CREATE INDEX bill_line_moves_to_visit_idx ON bill_line_moves (to_visit_id);
CREATE TRIGGER bill_line_moves_append_only BEFORE UPDATE OR DELETE ON bill_line_moves
  FOR EACH ROW EXECUTE FUNCTION yuzu_forbid_mutation();

-- ───────────── 幂等与作废登记：转单 ─────────────
ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_op_type_check;
ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'inv_doc', 'purchase_order', 'payment', 'opening_payable',
                     'checkin', 'bill_post', 'tag_swap', 'abandoned', 'checkout', 'table_open', 'table_post', 'table_checkout',
                     'room_checkin', 'room_extend', 'room_deposit', 'room_refund', 'room_close', 'line_move'));
ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;
ALTER TABLE op_fences ADD CONSTRAINT op_fences_op_type_check
  CHECK (op_type IN ('recharge', 'consume', 'reversal', 'checkin', 'bill_post', 'tag_swap', 'checkout', 'table_open', 'table_post', 'table_checkout',
                     'room_checkin', 'room_extend', 'room_deposit', 'room_refund', 'room_close', 'line_move'));
