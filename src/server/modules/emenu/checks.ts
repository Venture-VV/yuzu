// 自检（8.0.10）：平板点餐单与餐饮明细一致。前台自检（frontdesk/checks.ts）里的一条。
//   · 每张点餐单的合计、行数、份数 = 这次挂账（同一个操作编号）记在这张手牌账单上的餐饮明细之和（之后退掉的也算：明细只作废、不删除），
//     经办人是确认的那位服务员；
//   · 这次挂账的操作编号在、业务类型是挂账、指向这次来访；
//   · 这几条明细都有出品单，出品单上送到的桌号、口味备注与点餐单一致。

import type { FrontdeskCheck } from '@shared/frontdesk';
import { formatYuan } from '@shared/money';
import type { Db } from '../../db';

export async function emenuCheck(db: Db): Promise<FrontdeskCheck> {
  const diff = await db<{ ref: string }[]>`
    SELECT '点餐单 ' || o.id AS ref
    FROM emenu_orders o JOIN visits v ON v.id = o.visit_id
    LEFT JOIN LATERAL (
      SELECT coalesce(sum(l.amount), 0) AS amount, count(*)::int AS n, coalesce(sum(l.quantity), 0)::int AS quantity
      FROM bill_lines l
      WHERE l.post_key = o.client_key AND l.bill_id = v.bill_id AND l.source = 'dining' AND l.posted_by = o.waiter_id
    ) s ON true
    WHERE s.amount <> o.total OR s.n <> o.line_count OR s.quantity <> o.quantity
       OR NOT EXISTS (SELECT 1 FROM idempotency_keys k WHERE k.key = o.client_key AND k.op_type = 'bill_post' AND k.ref_id = o.visit_id)
       OR EXISTS (SELECT 1 FROM bill_lines l LEFT JOIN kitchen_items ki ON ki.bill_line_id = l.id
                  WHERE l.post_key = o.client_key AND (ki.id IS NULL OR ki.deliver_to <> o.table_name OR ki.note <> o.note))
    ORDER BY o.id LIMIT 5`;
  const [t] = await db<{ n: number; amount: number }[]>`SELECT count(*)::int AS n, coalesce(sum(total), 0) AS amount FROM emenu_orders`;
  return {
    key: 'emenu_orders',
    label: '平板点餐单与餐饮明细一致',
    ok: diff.length === 0,
    detail: diff.length
      ? `${diff.length} 张点餐单与餐饮明细、出品单不符（如 ${diff.map((d) => d.ref).join('、')}）`
      : `平板点餐单 ${t!.n} 张（下单时合计 ${formatYuan(Number(t!.amount))}），每张都对应这次挂账的餐饮明细与出品单，经办人是确认的服务员`,
  };
}
