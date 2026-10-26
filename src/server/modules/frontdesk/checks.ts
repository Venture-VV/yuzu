// 前台账务自检：手牌、来访、账单与明细之间的不变量。
// 与会员日结自检、库存自检一起由 `cli.js check` 与管理页输出。

import type { FrontdeskCheck } from '@shared/frontdesk';
import { formatYuan } from '@shared/money';
import type { Db } from '../../db';

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

  // ② 来访与账单状态一致
  const statusDiff = await db<{ visitNo: string }[]>`
    SELECT v.visit_no FROM visits v JOIN bills b ON b.id = v.bill_id WHERE v.status <> b.status`;

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
      detail: statusDiff.length ? `${statusDiff.length} 笔来访与账单状态不一致（如 ${statusDiff[0]!.visitNo}）` : '每笔来访与其账单同为未结、已结或已撤销',
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
  ];
}
