// 前台账务自检：手牌、来访、账单与明细之间的不变量。
// 与会员日结自检、库存自检一起由 `cli.js check` 与管理页输出。

import type { FrontdeskCheck } from '@shared/frontdesk';
import { formatYuan } from '@shared/money';
import type { Db } from '../../db';
import { usageCheck } from '../usages';
import { bookingChecks } from '../bookings';
import { countCardChecks } from '../count-cards';
import { platformChecks } from '../platform-redemptions';
import { conciergeCheck } from '../concierge/checks';
import { emenuCheck } from '../emenu/checks';

export async function frontdeskChecks(db: Db): Promise<FrontdeskCheck[]> {
  // ① 每张账单的合计 / 行数 = 其有效明细之和（未结明细合计 == 未结账单总额）
  const billDiff = await db<{ billNo: string; amountCents: number; lineCount: number; sumAmount: number; cnt: number }[]>`
    SELECT b.bill_no, b.amount_cents, b.line_count, coalesce(l.s, 0) AS sum_amount, coalesce(l.c, 0) AS cnt
    FROM bills b LEFT JOIN (
      SELECT bill_id, sum(amount) AS s, count(*) AS c FROM bill_lines WHERE status = 'active' GROUP BY bill_id
    ) l ON l.bill_id = b.id
    WHERE b.amount_cents <> coalesce(l.s, 0) OR b.line_count <> coalesce(l.c, 0)`;
  const [open] = await db<{ bills: number; amount: number; lines: number; lineSum: number }[]>`
    SELECT count(*) AS bills, coalesce(sum(b.amount_cents), 0) AS amount, coalesce(sum(b.line_count), 0) AS lines,
           (SELECT coalesce(sum(l.amount), 0) FROM bill_lines l JOIN bills ob ON ob.id = l.bill_id
            WHERE ob.status = 'open' AND l.status = 'active') AS line_sum
    FROM bills b WHERE b.status = 'open'`;

  // ② 来访与账单状态一致；桌台的开台（餐饮第二步）同样与账单一致
  const statusDiff = await db<{ visitNo: string }[]>`
    SELECT v.visit_no FROM visits v JOIN bills b ON b.id = v.bill_id WHERE v.status <> b.status
    UNION ALL
    SELECT s.session_no FROM table_sessions s JOIN bills b ON b.id = s.bill_id WHERE s.status <> b.status`;

  // ③ 在店客人所持手牌：启用、未锁定、分区一致；同一张手牌不会有两位在店客人
  const tagIssues = await db<{ code: string; issue: string }[]>`
    SELECT t.code, CASE WHEN NOT t.active THEN '已停用' WHEN t.locked THEN '已锁定' ELSE '分区不一致' END AS issue
    FROM visits v JOIN hand_tags t ON t.id = v.tag_id
    WHERE v.status = 'open' AND (NOT t.active OR t.locked OR t.zone <> v.zone)
    UNION ALL
    SELECT t.code, '同时有多位在店客人' FROM visits v JOIN hand_tags t ON t.id = v.tag_id
    WHERE v.status = 'open' GROUP BY t.code HAVING count(*) > 1`;

  // ④ 同行组：未关闭的组至少有一位在店客人，已关闭的组没有在店客人
  const groupIssues = await db<{ groupNo: string }[]>`
    SELECT g.group_no FROM visit_groups g
    LEFT JOIN (SELECT group_id, count(*) AS n FROM visits WHERE status = 'open' GROUP BY group_id) o ON o.group_id = g.id
    WHERE (g.status = 'open' AND coalesce(o.n, 0) = 0) OR (g.status = 'closed' AND coalesce(o.n, 0) > 0)`;

  // ⑤ 结账单：合计 = 所含账单合计 = 收款合计；每张已结账单恰好属于一张有效结账单且金额一致
  const checkoutDiff = await db<{ checkoutNo: string }[]>`
    SELECT c.checkout_no FROM checkouts c
    LEFT JOIN (SELECT checkout_id, sum(amount) AS s FROM checkout_bills GROUP BY checkout_id) b ON b.checkout_id = c.id
    LEFT JOIN (SELECT checkout_id, sum(amount) AS s FROM checkout_payments GROUP BY checkout_id) p ON p.checkout_id = c.id
    WHERE coalesce(b.s, 0) <> c.total_amount OR coalesce(p.s, 0) <> c.total_amount`;
  const settledDiff = await db<{ billNo: string }[]>`
    SELECT b.bill_no FROM bills b
    LEFT JOIN (
      SELECT cb.bill_id, count(*) AS n, max(cb.amount) AS amount FROM checkout_bills cb JOIN checkouts c ON c.id = cb.checkout_id
      WHERE c.status = 'completed' GROUP BY cb.bill_id
    ) k ON k.bill_id = b.id
    WHERE (b.status = 'settled' AND (coalesce(k.n, 0) <> 1 OR k.amount <> b.amount_cents))
       OR (b.status <> 'settled' AND coalesce(k.n, 0) > 0)`;
  const [paid] = await db<{ checkouts: number; total: number }[]>`
    SELECT count(*) AS checkouts, coalesce(sum(total_amount), 0) AS total FROM checkouts WHERE status = 'completed'`;

  // ⑥ 会员储值支付 = 指向结账单的消费单（有效结账单对应未撤销的消费，反结账后对应已撤销的消费）
  const walletDiff = await db<{ ref: string }[]>`
    SELECT c.checkout_no AS ref FROM checkout_payments p JOIN checkouts c ON c.id = p.checkout_id
    LEFT JOIN consumptions k ON k.id = p.consumption_id
    WHERE p.method = 'wallet' AND (k.id IS NULL OR k.total_amount <> p.amount OR k.member_id <> p.member_id
          OR k.checkout_id IS DISTINCT FROM c.id OR (c.status = 'completed') <> (k.status = 'completed'))
    UNION ALL
    SELECT k.doc_no FROM consumptions k
    WHERE k.checkout_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM checkout_payments p WHERE p.consumption_id = k.id)`;

  // ⑦ 团购券：有效登记对应有效结账单与金额一致的收款，反结账后登记作废
  const couponDiff = await db<{ code: string }[]>`
    SELECT g.code FROM group_buy_coupons g JOIN checkouts c ON c.id = g.checkout_id
    WHERE (g.status = 'active') <> (c.status = 'completed')
       OR NOT EXISTS (SELECT 1 FROM checkout_payments p WHERE p.coupon_id = g.id AND p.amount = g.amount AND p.checkout_id = c.id)`;

  // ⑧ 优惠 / 免单（R1.2）：每笔都对应一次本人申请、已在这次结账核销的当场授权，授权人、金额与授权一致，填了原因
  const discountDiff = await db<{ checkoutNo: string }[]>`
    SELECT c.checkout_no FROM checkout_payments p JOIN checkouts c ON c.id = p.checkout_id
    LEFT JOIN auth_grants g ON g.id = p.grant_id
    WHERE p.method = 'discount'
      AND (g.id IS NULL OR g.purpose <> 'checkout_discount' OR g.used_ref IS DISTINCT FROM 'checkout:' || c.client_key
           OR g.approved_by <> p.approved_by OR g.requested_by <> c.operator_id OR (g.scope->>'amount')::bigint <> p.amount
           OR char_length(btrim(p.ref)) < 2)`;
  const [discounts] = await db<{ n: number; amount: number }[]>`
    SELECT count(*)::int AS n, coalesce(sum(amount), 0) AS amount FROM checkout_payments WHERE method = 'discount'`;

  // ⑨ 补录纸质单（R1.9）：每条补录记录都对应同一操作编号的单据，单据的时间与营业日就是补录的实际时间与营业日
  const backfillDiff = await db<{ slipNo: string }[]>`
    SELECT b.slip_no FROM backfill_entries b LEFT JOIN visits v ON v.id = b.visit_id LEFT JOIN checkouts c ON c.id = b.checkout_id
    WHERE (b.kind = 'checkin' AND (v.id IS NULL OR v.checkin_key <> b.op_key OR v.checked_in_at <> b.actual_at OR v.business_date <> b.business_date))
       OR (b.kind = 'charges' AND (v.id IS NULL
           OR NOT EXISTS (SELECT 1 FROM bill_lines l WHERE l.bill_id = v.bill_id AND l.post_key = b.op_key)
           OR EXISTS (SELECT 1 FROM bill_lines l WHERE l.post_key = b.op_key
                      AND (l.bill_id <> v.bill_id OR l.posted_at <> b.actual_at OR l.business_date <> b.business_date))))
       OR (b.kind = 'checkout' AND (c.id IS NULL OR c.client_key <> b.op_key OR c.created_at <> b.actual_at OR c.business_date <> b.business_date))`;
  const [backfills] = await db<{ n: number; slips: number }[]>`
    SELECT count(*)::int AS n, count(DISTINCT slip_no)::int AS slips FROM backfill_entries`;

  // ⑩ 同一张手牌、同一位会员的来访时段不重叠（按接待与换牌记录逐段，截到离店；反结账后重结的截到第一次结账的时刻）。
  //   在店客人当前这一段还没有终点，不在这里核对（补录的客人结账、换牌时核对），所以补录接待之后、补录结账之前不会误报
  const periodOverlaps = await db<{ kind: 'tag' | 'member'; label: string; visitNo: string }[]>`
    WITH raw AS (
      SELECT v.id AS visit_id, v.visit_no, c.from_tag_id AS tag_id,
             coalesce(lag(c.created_at) OVER (PARTITION BY v.id ORDER BY c.id), v.checked_in_at) AS since, c.created_at AS until,
             coalesce(v.ticket_end_at, v.closed_at) AS left_at
      FROM visits v JOIN visit_tag_changes c ON c.visit_id = v.id WHERE v.status <> 'cancelled'
      UNION ALL
      SELECT v.id, v.visit_no, v.tag_id,
             coalesce((SELECT max(c.created_at) FROM visit_tag_changes c WHERE c.visit_id = v.id), v.checked_in_at), NULL,
             coalesce(v.ticket_end_at, v.closed_at)
      FROM visits v WHERE v.status <> 'cancelled'
    ), segs AS (
      SELECT visit_id, visit_no, tag_id, since,
             CASE WHEN until IS NULL THEN left_at WHEN left_at IS NULL THEN until ELSE least(until, left_at) END AS until
      FROM raw
    ), tag_runs AS (
      SELECT tag_id, visit_no, since,
             max(until) OVER (PARTITION BY tag_id ORDER BY since, visit_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS before_until
      FROM segs WHERE until IS NOT NULL AND since < until
    ), member_runs AS (
      SELECT member_id, visit_no, checked_in_at AS since,
             max(coalesce(ticket_end_at, closed_at)) OVER (PARTITION BY member_id ORDER BY checked_in_at, id
                                                            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS before_until
      FROM visits WHERE status <> 'cancelled' AND member_id IS NOT NULL AND coalesce(ticket_end_at, closed_at) IS NOT NULL
    )
    SELECT 'tag' AS kind, t.code AS label, r.visit_no FROM tag_runs r JOIN hand_tags t ON t.id = r.tag_id WHERE r.since < r.before_until
    UNION ALL
    SELECT 'member', m.name, r.visit_no FROM member_runs r JOIN members m ON m.id = r.member_id WHERE r.since < r.before_until
    LIMIT 5`;

  // ⑪ 餐饮（S5）：每张出品单对应同一位客人（或同一桌）的一条餐饮明细（菜品、份数一致），明细作废的出品单已退、没作废的没退；
  //    每条餐饮明细都有出品单（钱只在明细里，出品单只记出品状态）
  const kitchenDiff = await db<{ ref: string }[]>`
    SELECT k.order_no AS ref FROM kitchen_items k JOIN bill_lines l ON l.id = k.bill_line_id
    LEFT JOIN visits v ON v.id = k.visit_id LEFT JOIN table_sessions ts ON ts.id = k.table_session_id
    WHERE l.bill_id IS DISTINCT FROM coalesce(v.bill_id, ts.bill_id) OR l.source <> 'dining' OR l.item_id IS DISTINCT FROM k.item_id
       OR l.quantity <> k.quantity OR (l.status = 'voided') <> (k.status = 'cancelled')
    UNION ALL
    SELECT '明细 ' || l.id FROM bill_lines l
    WHERE l.source = 'dining' AND NOT EXISTS (SELECT 1 FROM kitchen_items k WHERE k.bill_line_id = l.id)
    LIMIT 5`;
  const [kitchen] = await db<{ n: number; open: number }[]>`
    SELECT count(*)::int AS n, count(*) FILTER (WHERE status IN ('queued', 'cooking', 'done'))::int AS open FROM kitchen_items`;

  // ⑫ 客房（S7）押金台账：每个入住单、每种收款方式的余额（收 − 退）不为负；退房、撤销之后余额为 0
  const depositDiff = await db<{ ref: string }[]>`
    SELECT s.stay_no || ' ' || d.method AS ref FROM room_stays s
    JOIN (SELECT stay_id, method, sum(CASE WHEN kind = 'receive' THEN amount ELSE -amount END) AS balance
          FROM room_deposits GROUP BY stay_id, method) d ON d.stay_id = s.id
    WHERE d.balance < 0 OR (s.status <> 'open' AND d.balance <> 0)
    LIMIT 5`;
  const [deposits] = await db<{ held: number; stays: number }[]>`
    SELECT coalesce(sum(CASE WHEN d.kind = 'receive' THEN d.amount ELSE -d.amount END), 0) AS held,
           count(DISTINCT s.id) FILTER (WHERE s.status = 'open')::int AS stays
    FROM room_stays s LEFT JOIN room_deposits d ON d.stay_id = s.id`;
  // ⑬ 房态与在住单：在住单的房间启用；在住单的手牌客人仍在店；房费挂的就是这位客人的手牌账单
  const stayDiff = await db<{ ref: string }[]>`
    SELECT s.stay_no AS ref FROM room_stays s JOIN rooms r ON r.id = s.room_id WHERE s.status = 'open' AND NOT r.active
    UNION ALL
    SELECT s.stay_no FROM room_stays s JOIN visits v ON v.id = s.visit_id WHERE (s.status = 'open' AND v.status <> 'open') OR s.bill_id <> v.bill_id
    LIMIT 5`;
  const [stays] = await db<{ open: number; rooms: number }[]>`
    SELECT count(*) FILTER (WHERE status = 'open')::int AS open, (SELECT count(*) FROM rooms WHERE active)::int AS rooms FROM room_stays`;
  // ⑭ 房费不重复：每笔房费对应入住单账单上的一条客房明细（金额一致）；每条客房明细都有房费记录（同一晚、同一段由唯一索引兜底）
  const chargeDiff = await db<{ ref: string }[]>`
    SELECT s.stay_no || ' 明细 ' || l.id AS ref FROM room_stay_charges c JOIN room_stays s ON s.id = c.stay_id JOIN bill_lines l ON l.id = c.line_id
    WHERE l.bill_id <> s.bill_id OR l.source <> 'room' OR l.amount <> c.amount OR l.quantity <> 1
    UNION ALL
    SELECT '明细 ' || l.id FROM bill_lines l WHERE l.source = 'room' AND NOT EXISTS (SELECT 1 FROM room_stay_charges c WHERE c.line_id = l.id)
    LIMIT 5`;
  const [charges] = await db<{ n: number; amount: number }[]>`
    SELECT count(*)::int AS n, coalesce(sum(c.amount) FILTER (WHERE l.status = 'active'), 0) AS amount
    FROM room_stay_charges c JOIN bill_lines l ON l.id = c.line_id`;
  // ⑮ 部门营业额快照（v0.7.6）：每张结账单的快照合计 = 结账金额，分摊的优惠合计 = 这张结账单的优惠 / 免单 + 券抵扣（v0.7.20）+ 会员折扣（v0.7.25）
  const itemDiff = await db<{ checkoutNo: string }[]>`
    SELECT c.checkout_no FROM checkouts c
    LEFT JOIN (SELECT checkout_id, sum(amount) AS amount, sum(discount) AS discount FROM checkout_items GROUP BY checkout_id) i ON i.checkout_id = c.id
    LEFT JOIN (SELECT checkout_id, sum(amount) AS amount FROM checkout_payments WHERE method IN ('discount', 'store_coupon', 'member_discount') GROUP BY checkout_id) d
      ON d.checkout_id = c.id
    WHERE coalesce(i.amount, 0) <> c.total_amount OR coalesce(i.discount, 0) <> coalesce(d.amount, 0)
    LIMIT 5`;
  const [items] = await db<{ n: number }[]>`SELECT count(DISTINCT checkout_id)::int AS n FROM checkout_items`;
  // ⑯ 转单（v0.7.6）：原明细已作废、在原客人的账单上；新明细在目标客人的账单上，来源、项目、名称、档位、数量、金额、技师都相同。
  // 8.0.8：转过来时还没派技师、转过来以后钟房补派了的（记了补派 clock_assign），技师可以不同；钱的字段照旧逐项相同（Codex 审查 b4a83d9）
  const moveDiff = await db<{ ref: string }[]>`
    SELECT '转单 ' || m.id AS ref FROM bill_line_moves m
    JOIN bill_lines f ON f.id = m.from_line_id JOIN bill_lines t ON t.id = m.to_line_id
    JOIN visits fv ON fv.id = m.from_visit_id JOIN visits tv ON tv.id = m.to_visit_id
    WHERE f.status <> 'voided' OR f.bill_id <> fv.bill_id OR t.bill_id <> tv.bill_id
       OR (f.source, f.item_id, f.name, f.tier, f.unit_price, f.quantity, f.amount)
          IS DISTINCT FROM (t.source, t.item_id, t.name, t.tier, t.unit_price, t.quantity, t.amount)
       OR ((f.technician_id, f.call_type) IS DISTINCT FROM (t.technician_id, t.call_type)
           AND NOT (f.technician_id IS NULL AND f.call_type IS NULL AND t.session_id IS NOT NULL
                    AND EXISTS (SELECT 1 FROM audit_logs a WHERE a.action = 'clock_assign' AND (a.detail->>'lineId')::bigint = t.id)))
    LIMIT 5`;
  const [moves] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM bill_line_moves`;

  return [
    {
      key: 'bill_amount_vs_lines',
      label: '未结明细合计 = 未结账单总额',
      ok: billDiff.length === 0 && open!.amount === open!.lineSum,
      detail: billDiff.length
        ? `${billDiff.length} 张账单合计与明细不符（如 ${billDiff[0]!.billNo}）`
        : `在店 ${open!.bills} 张账单，未结 ${open!.lines} 项共 ${formatYuan(open!.amount)}，与明细逐项一致`,
    },
    {
      key: 'visit_vs_bill_status',
      label: '来访与账单状态一致',
      ok: statusDiff.length === 0,
      detail: statusDiff.length ? `${statusDiff.length} 笔来访（或开台）与账单状态不一致（如 ${statusDiff[0]!.visitNo}）` : '每笔来访、每次开台与其账单同为未结、已结或已撤销',
    },
    {
      key: 'open_visit_tags',
      label: '在店手牌一牌一人、分区一致',
      ok: tagIssues.length === 0,
      detail: tagIssues.length ? `手牌 ${tagIssues.map((t) => `${t.code}（${t.issue}）`).join('、')}` : '在店客人所持手牌均启用、未锁定、分区一致',
    },
    {
      key: 'group_status',
      label: '同行组状态与在店客人一致',
      ok: groupIssues.length === 0,
      detail: groupIssues.length ? `同行组 ${groupIssues.map((g) => g.groupNo).join('、')} 状态与在店客人不符` : '未关闭的同行组都有在店客人',
    },
    {
      key: 'checkout_vs_bills',
      label: '结账单 = 所结账单 = 收款合计',
      ok: checkoutDiff.length === 0 && settledDiff.length === 0,
      detail:
        checkoutDiff.length || settledDiff.length
          ? `${checkoutDiff.length} 张结账单合计不符，${settledDiff.length} 张账单的结账状态不符（如 ${checkoutDiff[0]?.checkoutNo ?? settledDiff[0]?.billNo}）`
          : `有效结账单 ${paid!.checkouts} 张共 ${formatYuan(paid!.total)}，每张已结账单都对应一张结账单且金额一致`,
    },
    {
      key: 'checkout_wallet',
      label: '结账储值支付 = 会员消费单',
      ok: walletDiff.length === 0,
      detail: walletDiff.length ? `${walletDiff.length} 笔储值支付与会员消费单不符（如 ${walletDiff[0]!.ref}）` : '每笔储值支付都有金额、会员一致的消费单，反结账的已撤销',
    },
    {
      key: 'checkout_coupons',
      label: '团购券登记与结账收款一致',
      ok: couponDiff.length === 0,
      detail: couponDiff.length ? `${couponDiff.length} 张团购券登记与结账单不符（如券码 ${couponDiff[0]!.code}）` : '有效券码都对应有效结账单的收款，反结账的已作废',
    },
    {
      key: 'checkout_discounts',
      label: '优惠 / 免单都有当场授权',
      ok: discountDiff.length === 0,
      detail: discountDiff.length
        ? `${discountDiff.length} 笔优惠没有对应的当场授权或与授权不符（如结账单 ${discountDiff[0]!.checkoutNo}）`
        : `优惠 ${discounts!.n} 笔共 ${formatYuan(discounts!.amount)}，每笔都有经办人申请、值班经理及以上在这次结账核销的授权`,
    },
    {
      key: 'visit_periods',
      label: '同一手牌、同一会员的来访时段不重叠',
      ok: periodOverlaps.length === 0,
      detail: periodOverlaps.length
        ? `${periodOverlaps.map((o) => `${o.kind === 'tag' ? `手牌 ${o.label}` : `会员「${o.label}」`}的来访 ${o.visitNo} 与之前的来访时段重叠`).join('；')}`
        : '已离店的来访按接待、换牌、离店的时间逐段核对，同一张手牌、同一位会员没有重叠的时段',
    },
    {
      key: 'backfill_entries',
      label: '补录记录与单据一致',
      ok: backfillDiff.length === 0,
      detail: backfillDiff.length
        ? `${backfillDiff.length} 条补录记录与单据的时间或营业日不符（如纸质单 ${backfillDiff[0]!.slipNo}）`
        : `补录 ${backfills!.n} 步（纸质单 ${backfills!.slips} 张），单据时间与营业日都按纸质单上的实际时间`,
    },
    {
      key: 'kitchen_items',
      label: '出品单与餐饮明细一致',
      ok: kitchenDiff.length === 0,
      detail: kitchenDiff.length
        ? `${kitchenDiff.length} 张出品单与餐饮明细不符（如 ${kitchenDiff.map((d) => d.ref).join('、')}）`
        : `出品单 ${kitchen!.n} 道（还没上的 ${kitchen!.open} 道），每道都对应一条餐饮明细，退菜的明细已作废`,
    },
    {
      key: 'room_deposits',
      label: '客房押金台账一致',
      ok: depositDiff.length === 0,
      detail: depositDiff.length
        ? `${depositDiff.length} 处押金余额不符（如 ${depositDiff.map((d) => d.ref).join('、')}）`
        : `在住押金余额 ${formatYuan(deposits!.held)}（在住 ${deposits!.stays} 间）；每种收款方式的余额都不为负，退房、撤销后为 0`,
    },
    {
      key: 'room_stays',
      label: '客房房态与在住单一致',
      ok: stayDiff.length === 0,
      detail: stayDiff.length
        ? `${stayDiff.length} 个入住单的房间、手牌客人或账单不符（如 ${stayDiff.map((d) => d.ref).join('、')}）`
        : `在住 ${stays!.open} 间（启用的房间 ${stays!.rooms} 间），一间房最多一个在住单，住客的手牌都在店，房费都挂在住客的手牌账单上`,
    },
    {
      key: 'room_charges',
      label: '客房房费不重复、与账单明细一致',
      ok: chargeDiff.length === 0,
      detail: chargeDiff.length
        ? `${chargeDiff.length} 笔房费与账单明细不符（如 ${chargeDiff.map((d) => d.ref).join('、')}）`
        : `房费 ${charges!.n} 笔（有效 ${formatYuan(charges!.amount)}），每晚、每段只挂一次，都对应一条客房明细`,
    },
    {
      key: 'checkout_items',
      label: '部门营业额快照与结账单一致',
      ok: itemDiff.length === 0,
      detail: itemDiff.length
        ? `${itemDiff.length} 张结账单的部门快照与结账金额或优惠不符（如 ${itemDiff.map((d) => d.checkoutNo).join('、')}）`
        : `${items!.n} 张结账单有部门快照，每张的合计 = 结账金额，分摊的优惠 = 这张结账单的优惠 / 免单与券抵扣`,
    },
    {
      key: 'line_moves',
      label: '转单记录与明细一致',
      ok: moveDiff.length === 0,
      detail: moveDiff.length
        ? `${moveDiff.length} 条转单记录与明细不符（如 ${moveDiff.map((d) => d.ref).join('、')}）`
        : `转单 ${moves!.n} 条：原明细都已作废，目标手牌上的明细与原明细一致`,
    },
    // ⑰ 派对房等的使用单（v0.7.19）
    await usageCheck(db),
    await bookingChecks(db),
    // ⑱ 退款单（v0.7.20）
    await refundCheck(db),
    // ⑲ 券（v0.7.20）
    await couponCheck(db),
    // ⑳ 次卡（v0.7.28）
    ...(await countCardChecks(db)),
    // ㉑ 平台核销补录（v0.7.28）
    await platformChecks(db),
    // ㉒ 班次与当班的人（v0.7.28 按钱箱交班）
    await shiftMemberCheck(db),
    // ㉓ 平板点餐单（8.0.10）
    await emenuCheck(db),
    await conciergeCheck(db),
  ];
}

/**
 * ㉒ 班次与当班的人一致（v0.7.28）：每个班次都有开班人从开班起的那一条；已交班的班次上没有还在的人、离开都不晚于交班
 * （一位员工同时只在一个班次上、一个钱箱同时只有一个开着的班次由唯一索引保证）
 */
async function shiftMemberCheck(db: Db): Promise<FrontdeskCheck> {
  const diff = await db<{ ref: string }[]>`
    SELECT s.shift_no AS ref FROM shifts s
    WHERE NOT EXISTS (SELECT 1 FROM shift_members m WHERE m.shift_id = s.id AND m.staff_id = s.staff_id AND m.joined_at = s.started_at)
       OR (s.status = 'closed' AND EXISTS (SELECT 1 FROM shift_members m WHERE m.shift_id = s.id
                                           AND (m.left_at IS NULL OR m.left_at > greatest(s.ended_at, m.joined_at))))
    ORDER BY s.id LIMIT 5`;
  const [t] = await db<{ open: number; drawer: number; members: number }[]>`
    SELECT count(*) FILTER (WHERE s.status = 'open')::int AS open, count(*) FILTER (WHERE s.status = 'open' AND s.drawer IS NOT NULL)::int AS drawer,
           (SELECT count(*)::int FROM shift_members WHERE left_at IS NULL) AS members
    FROM shifts s`;
  return {
    key: 'shift_members',
    label: '班次与当班的人一致',
    ok: diff.length === 0,
    detail: diff.length
      ? `${diff.length} 个班次的当班记录与班次不符（如 ${diff.map((d) => d.ref).join('、')}）`
      : `未交班的班次 ${t!.open} 个（按钱箱交班 ${t!.drawer} 个），此刻在班上 ${t!.members} 人；每个班次都有开班人，已交班的班次上没有还在的人`,
  };
}

/**
 * ⑲ 券与变动记录、结账收款一致（v0.7.20）：券的状态 = 最后一条变动的结果（用 → 已用在那张结账单，退回 → 可用，作废 → 已作废）；
 * 有效结账单的券抵扣 = 券已用在这张结账单、使用记录的金额；反结账的结账单的券已退回；已用的券都对应有效结账单的券抵扣；
 * 每次发券的张数 = 发出的券
 */
async function couponCheck(db: Db): Promise<FrontdeskCheck> {
  const diff = await db<{ ref: string }[]>`
    WITH last AS (SELECT DISTINCT ON (coupon_id) coupon_id, kind, checkout_id FROM coupon_events ORDER BY coupon_id, id DESC)
    SELECT '券 …' || right(c.code, 4) AS ref FROM coupons c LEFT JOIN last l ON l.coupon_id = c.id
    WHERE (l.kind IS NULL AND c.status <> 'available')
       OR (l.kind = 'use' AND (c.status <> 'used' OR c.checkout_id IS DISTINCT FROM l.checkout_id))
       OR (l.kind = 'return' AND (c.status <> 'available' OR c.checkout_id IS NOT NULL))
       OR (l.kind = 'void' AND c.status <> 'voided')
    UNION ALL
    SELECT ck.checkout_no FROM checkout_payments p JOIN checkouts ck ON ck.id = p.checkout_id JOIN coupons c ON c.id = p.store_coupon_id
    WHERE p.method = 'store_coupon'
      AND ((ck.status = 'completed'
            AND (c.status <> 'used' OR c.checkout_id <> ck.id
                 OR p.amount IS DISTINCT FROM (SELECT e.amount FROM coupon_events e WHERE e.coupon_id = c.id AND e.kind = 'use' AND e.checkout_id = ck.id
                                               ORDER BY e.id DESC LIMIT 1)))
           OR (ck.status = 'voided' AND c.checkout_id IS NOT DISTINCT FROM ck.id))
    UNION ALL
    SELECT '券 …' || right(c.code, 4) FROM coupons c
    WHERE c.status = 'used' AND NOT EXISTS (
      SELECT 1 FROM checkout_payments p JOIN checkouts ck ON ck.id = p.checkout_id
      WHERE p.method = 'store_coupon' AND p.store_coupon_id = c.id AND p.checkout_id = c.checkout_id AND ck.status = 'completed')
    UNION ALL
    SELECT i.issue_no FROM coupon_issues i WHERE i.quantity <> (SELECT count(*) FROM coupons c WHERE c.issue_id = i.id)
    LIMIT 5`;
  const [t] = await db<{ total: number; used: number; voided: number }[]>`
    SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'used')::int AS used, count(*) FILTER (WHERE status = 'voided')::int AS voided FROM coupons`;
  return {
    key: 'coupons',
    label: '券与使用记录、结账收款一致',
    ok: diff.length === 0,
    detail: diff.length
      ? `${diff.length} 处券的状态与记录或结账单不符（如 ${diff.map((d) => d.ref).join('、')}）`
      : `券 ${t!.total} 张（已用 ${t!.used}、作废 ${t!.voided}）：状态与变动记录一致，用券的结账单都对得上，反结账的已退回`,
  };
}

/**
 * ⑱ 退款单与结账单一致（v0.7.20）：每张退款单的金额 = 退的项目合计 = 退款方式合计；生效的退款单累计——每项不超过份数与实收
 * （应收 − 分摊的优惠），每种方式不超过原单这种方式收的钱、只退现金类方式；反结账过的结账单没有生效的退款单
 */
async function refundCheck(db: Db): Promise<FrontdeskCheck> {
  const diff = await db<{ ref: string }[]>`
    SELECT r.refund_no AS ref FROM refunds r
    WHERE r.amount <> (SELECT coalesce(sum(amount), 0) FROM refund_items WHERE refund_id = r.id)
       OR r.amount <> (SELECT coalesce(sum(amount), 0) FROM refund_payments WHERE refund_id = r.id)
    UNION ALL
    SELECT c.checkout_no || ' ' || ci.name FROM checkout_items ci JOIN checkouts c ON c.id = ci.checkout_id
    JOIN (SELECT ri.checkout_id, ri.category, ri.name, sum(ri.quantity) AS q, sum(ri.amount) AS a
          FROM refund_items ri JOIN refunds r ON r.id = ri.refund_id WHERE r.status = 'completed' GROUP BY 1, 2, 3) x
      ON x.checkout_id = ci.checkout_id AND x.category = ci.category AND x.name = ci.name
    WHERE x.q > ci.quantity OR x.a > ci.amount - ci.discount
    UNION ALL
    SELECT c.checkout_no || ' ' || x.method FROM checkouts c
    JOIN (SELECT r.checkout_id, p.method, sum(p.amount) AS a FROM refund_payments p JOIN refunds r ON r.id = p.refund_id
          WHERE r.status = 'completed' GROUP BY 1, 2) x ON x.checkout_id = c.id
    WHERE x.a > (SELECT coalesce(sum(amount), 0) FROM checkout_payments WHERE checkout_id = c.id AND method = x.method)
    UNION ALL
    SELECT c.checkout_no || ' 已反结账' FROM checkouts c
    WHERE c.status = 'voided' AND EXISTS (SELECT 1 FROM refunds r WHERE r.checkout_id = c.id AND r.status = 'completed')
    LIMIT 5`;
  const [t] = await db<{ n: number; amount: number; voided: number }[]>`
    SELECT count(*) FILTER (WHERE status = 'completed')::int AS n, coalesce(sum(amount) FILTER (WHERE status = 'completed'), 0) AS amount,
           count(*) FILTER (WHERE status = 'voided')::int AS voided
    FROM refunds`;
  return {
    key: 'refunds',
    label: '退款单与结账单一致',
    ok: diff.length === 0,
    detail: diff.length
      ? `${diff.length} 处退款单与结账单不符（如 ${diff.map((d) => d.ref).join('、')}）`
      : `生效的退款单 ${t!.n} 张共 ${formatYuan(t!.amount)}（作废 ${t!.voided} 张）：每张的项目合计 = 退款方式合计，每项、每种方式都没有超过原单，反结账过的结账单没有生效的退款单`,
  };
}
