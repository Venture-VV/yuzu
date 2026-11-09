// 充值当日的储值消费比例（8.0.4 需求表 04，docs/MEMBERSHIP_V804.md 第 4 节）：算这位会员这个营业日还能用多少储值。
// 判断在钱包已经锁住的会员一行之后（与充值、消费、退储值都串行），这里只读当天的充值、消费与余额流水，不另加锁。

import { spendCap, type SpendQuota } from '@shared/spend-quota';
import { formatYuan } from '@shared/money';
import type { Db } from '../db';
import { unprocessable } from '../lib/errors';

/** 这位会员这个营业日的额度；当天没充值、或比例是「不限」时为 null */
export async function spendQuotaOf(db: Db, memberId: number, businessDate: string, pct: number | null): Promise<SpendQuota | null> {
  if (pct === null) return null;
  const [row] = await db<{ firstId: number | null; prior: number | null; carried: number; recharged: number; spent: number }[]>`
    WITH first AS (
      SELECT id, principal_after + bonus_after - principal_delta - bonus_delta AS prior
      FROM ledger_entries
      WHERE member_id = ${memberId} AND entry_type = 'recharge' AND business_date = ${businessDate}
      ORDER BY id LIMIT 1
    )
    SELECT (SELECT id FROM first) AS first_id,
           (SELECT prior FROM first) AS prior,
           -- 第一笔充值以后合并、期初转进来的是原来的钱，算进「充值前的余额」；
           -- 撤销第一笔充值之前的消费（含前几天的），退回来的也是原来的钱，一样算进去（8.0.4 独立验收 P2：原来退回后用不了）。
           -- 退回到已经到期的赠金批次、随即作废的赠金（撤销单的过期单）没回到卡里，减掉（Codex 自动审查 2f24f8a）。
           -- 第一笔充值以后的消费撤销了不在这里算：那笔消费本来就不再算「已用」（下面只数没撤销的）
           (SELECT coalesce(sum(le.principal_delta + le.bonus_delta), 0) FROM ledger_entries le
             WHERE le.member_id = ${memberId} AND le.entry_type IN ('merge_in', 'opening') AND le.business_date = ${businessDate}
               AND le.id > (SELECT id FROM first))
           + (SELECT coalesce(sum(r.principal_delta + r.bonus_delta - coalesce(x.expired, 0)), 0) FROM ledger_entries r
               JOIN ledger_entries c ON c.consumption_id = r.consumption_id AND c.entry_type = 'consume'
               LEFT JOIN LATERAL (SELECT sum(e.amount) AS expired FROM bonus_expiries e
                                   WHERE e.member_id = r.member_id AND e.reversal_id = r.reversal_id) x ON true
               WHERE r.member_id = ${memberId} AND r.entry_type = 'reversal' AND r.business_date = ${businessDate}
                 AND r.id > (SELECT id FROM first) AND c.id < (SELECT id FROM first)) AS carried,
           (SELECT coalesce(sum(paid_amount), 0) FROM recharges WHERE member_id = ${memberId} AND business_date = ${businessDate}) AS recharged,
           (SELECT coalesce(sum(c.total_amount), 0) FROM consumptions c JOIN ledger_entries le ON le.consumption_id = c.id AND le.entry_type = 'consume'
             WHERE c.member_id = ${memberId} AND c.status = 'completed' AND c.business_date = ${businessDate}
               AND le.id > (SELECT id FROM first)) AS spent`;
  if (!row || row.firstId === null || row.prior === null) return null;
  const recharged = Number(row.recharged);
  const priorBalance = Number(row.prior) + Number(row.carried);
  const cap = spendCap(recharged, priorBalance, pct);
  const spent = Number(row.spent);
  return { businessDate, recharged, priorBalance, pct, cap, spent, remaining: Math.max(0, cap - spent) };
}

/** 储值支付超过剩余额度时拒绝（RECHARGE_SPEND_CAP），带剩余额度；其余请用别的方式付（HY02：不能当场授权放行） */
export function assertWithinSpendQuota(q: SpendQuota | null, amount: number, memberName: string) {
  if (!q || amount <= q.remaining) return;
  throw unprocessable(
    'RECHARGE_SPEND_CAP',
    `会员「${memberName}」今天充了值：今天用储值最多 ${formatYuan(q.cap)}（充值前余额 ${formatYuan(q.priorBalance)} + 今日充值 ${formatYuan(q.recharged)} × ${q.pct}%），` +
      `剩余额度 ${formatYuan(q.remaining)}，这笔 ${formatYuan(amount)} 超了；其余请用别的方式付`,
    { remaining: q.remaining, cap: q.cap, recharged: q.recharged, priorBalance: q.priorBalance, pct: q.pct, spent: q.spent },
  );
}

/** 结账前核对：给结账里的会员带上今天的储值额度（只读） */
export async function withSpendQuota<M extends { id: number }>(db: Db, members: M[], businessDate: string, pct: number | null): Promise<(M & { spendQuota: SpendQuota | null })[]> {
  const out: (M & { spendQuota: SpendQuota | null })[] = [];
  for (const m of members) out.push({ ...m, spendQuota: await spendQuotaOf(db, Number(m.id), businessDate, pct) });
  return out;
}
