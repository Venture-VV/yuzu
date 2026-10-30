// 会员等级详情（v0.6.0）：当前等级与达到时间、到下一级还差多少、升降级记录。
// 口径与 VIP 柜核对相同（frontdesk/vip.ts 的 memberLevels）：累计充值实收（含期初导入的旧系统累计充值）或当前余额。
// 升降级记录按流水推算，不另存：累计充值按充值时间（期初按导入时间）逐笔累加；余额口径按每条余额流水之后的余额。

import { levelOf, type FrontdeskRules } from '@shared/frontdesk';
import { LEVEL_VALIDITY, levelName, type LevelChange, type MemberLevelInfo } from '@shared/members';
import type { Db } from '../db';

const iso = (v: string | Date) => new Date(v).toISOString();

export async function memberLevelInfo(db: Db, member: { id: number; createdAt: string }, rules: FrontdeskRules): Promise<MemberLevelInfo> {
  const memberId = member.id;
  const { vipLevelThresholds: thresholds, vipLevelNames: names, vipLevelBasis: basis } = rules;
  // 口径金额随时间的变化：余额口径取每条余额流水之后的余额；累计充值口径逐笔累加（期初按导入时间）
  let series: { at: string; amount: number }[];
  if (basis === 'balance') {
    series = await db<{ at: string; amount: number }[]>`
      SELECT created_at AS at, principal_after + bonus_after AS amount
      FROM ledger_entries WHERE member_id = ${memberId} ORDER BY id`;
  } else {
    const rows = await db<{ at: string; amount: number }[]>`
      SELECT at, amount FROM (
        SELECT created_at AS at, paid_amount AS amount, id, 0 AS src FROM recharges WHERE member_id = ${memberId}
        UNION ALL
        SELECT i.created_at, o.legacy_recharged, o.id, 1 FROM opening_balances o JOIN opening_imports i ON i.id = o.import_id
        WHERE o.member_id = ${memberId} AND o.status = 'active' AND o.legacy_recharged > 0
      ) x ORDER BY at, src, id`;
    let sum = 0;
    series = rows.map((r) => ({ at: r.at, amount: (sum += Number(r.amount)) }));
  }

  const history: LevelChange[] = [];
  // 第 1 级门槛为 0 时，建档即为第 1 级
  let level = levelOf(0, thresholds);
  let since: string | null = level > 0 ? iso(member.createdAt) : null;
  for (const p of series) {
    const next = levelOf(Number(p.amount), thresholds);
    if (next !== level) {
      history.push({ at: iso(p.at), from: level, to: next, fromName: levelName(level, names), toName: levelName(next, names) });
      level = next;
      since = next > 0 ? iso(p.at) : null;
    }
  }
  const amountCents = series.length ? Number(series[series.length - 1]!.amount) : 0;
  const nextThreshold = thresholds[level];
  return {
    basis,
    amountCents,
    level,
    name: levelName(level, names),
    since,
    next:
      nextThreshold === undefined
        ? null
        : { level: level + 1, name: levelName(level + 1, names), thresholdCents: nextThreshold, gapCents: Math.max(0, nextThreshold - amountCents) },
    history: history.reverse().slice(0, 20),
    validity: LEVEL_VALIDITY[basis],
  };
}
