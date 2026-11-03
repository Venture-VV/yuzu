// 临时身份（v0.7.25，docs/MEMBERSHIP_P3.md 第 3 节；PENDING_DECISIONS M51–M56）：邀请体验、赠送会籍。
// 只享权益：本月可享的服务类与登记使用、结账会员折扣、VIP 柜按「自己的与临时身份的取高的」；
// 不发每月券类与事件礼，不进升档、升阶、保级的判断，他店查询显示自己的档阶。

import { stateRank } from '@shared/benefits';
import type { Grade, Tier } from '@shared/membership';
import type { Db } from '../db';

export interface ActiveTrial {
  id: number;
  kind: 'invite' | 'gift';
  grade: Grade;
  tier: Tier;
  startsOn: string;
  endsOn: string;
  inviterId: number;
}

/** 这一天生效中的临时身份（没有为空；到期还没处理的，过了结束日就不算） */
export async function activeTrialOf(db: Db, memberId: number, date: string): Promise<ActiveTrial | null> {
  const [t] = await db<ActiveTrial[]>`
    SELECT id, kind, grade, tier, starts_on::text AS starts_on, ends_on::text AS ends_on, inviter_id FROM member_trials
    WHERE member_id = ${memberId} AND status = 'active' AND starts_on <= ${date}::date AND ends_on >= ${date}::date`;
  return t ? { ...t, id: Number(t.id), inviterId: Number(t.inviterId) } : null;
}

/** 享权益用的档阶（M51）：自己的与生效中的临时身份取高的 */
export async function benefitState(
  db: Db,
  memberId: number,
  own: { grade: Grade; tier: Tier | null },
  date: string,
): Promise<{ grade: Grade; tier: Tier | null; trial: ActiveTrial | null }> {
  const trial = await activeTrialOf(db, memberId, date);
  if (trial && stateRank(trial.grade, trial.tier) > stateRank(own.grade, own.tier)) return { grade: trial.grade, tier: trial.tier, trial };
  return { grade: own.grade, tier: own.tier, trial };
}
