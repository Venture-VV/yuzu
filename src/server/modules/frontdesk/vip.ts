// VIP 柜等级校验（店主 2026-10-27 #26：会员等级不低于柜子等级才能使用该柜）。
//
// 会员体系 v2（v0.7.23）起按会员的档级：会员规则里的「VIP 柜对应」写明每一档能用到几级柜（待确认）；散客为 0。
// 只读会员一行，不加锁：等级是开牌那一刻的经营规则判断，不影响任何账务。
// 等级不够时：规则未开启当场授权 → 拒绝；已开启 → 必须带值班经理 / 店总签发的授权，在同一事务里核销。

import type { FrontdeskRules } from '@shared/frontdesk';
import type { VipGrantTag } from '@shared/grants';
import type { MemberGradeBadge } from '@shared/membership';
import { consumeVipGrant } from '../../auth/grants';
import type { Db, Tx } from '../../db';
import type { Actor } from '../../lib/context';
import { unprocessable } from '../../lib/errors';
import { memberGradeBadges } from '../membership';
import type { LockedTag } from './common';

/** 会员的档阶与能用几级 VIP 柜 */
export const memberLockerGrades = (db: Db, memberIds: number[], today: string): Promise<Map<number, MemberGradeBadge>> => memberGradeBadges(db, memberIds, today);

export interface VipShortfall extends VipGrantTag {
  tagLevel: number;
  /** 会员能用到几级柜（散客 0） */
  memberLevel: number;
  memberName: string | null;
}

/** 找出客人能用的等级低于柜子等级的 VIP 柜 */
export function vipShortfalls(
  guests: { tag: LockedTag; memberId: number | null; memberName: string | null }[],
  grades: Map<number, MemberGradeBadge>,
): VipShortfall[] {
  return guests
    .filter((g) => g.tag.kind === 'vip')
    .map((g) => ({
      code: g.tag.code,
      memberId: g.memberId,
      memberName: g.memberName,
      tagLevel: g.tag.vipLevel!,
      memberLevel: g.memberId ? (grades.get(g.memberId)?.lockerLevel ?? 0) : 0,
    }))
    .filter((s) => s.memberLevel < s.tagLevel);
}

function describe(s: VipShortfall, grades: Map<number, MemberGradeBadge>) {
  if (!s.memberId) return `VIP 柜 ${s.code} 是第 ${s.tagLevel} 级柜，只供会员使用，散客不能使用`;
  const g = grades.get(s.memberId);
  const grade = g ? `「${g.label}」` : '';
  const can = s.memberLevel > 0 ? `只能用第 ${s.memberLevel} 级及以下的 VIP 柜` : '不能用 VIP 柜';
  return `会员「${s.memberName ?? ''}」现在是${grade}，${can}，不能使用第 ${s.tagLevel} 级 VIP 柜 ${s.code}`;
}

/**
 * 有等级不够的 VIP 柜时，确认可以授权（尽早调用，避免做无用功）：
 * 未开启当场授权 → VIP_LEVEL_TOO_LOW；已开启但没带授权 → VIP_AUTH_REQUIRED。
 */
export function assertVipAllowed(shortfalls: VipShortfall[], grades: Map<number, MemberGradeBadge>, rules: FrontdeskRules, grantId: string | null) {
  if (shortfalls.length === 0) return;
  const first = shortfalls[0]!;
  const details = { shortfalls: shortfalls.map(({ code, memberId, tagLevel, memberLevel }) => ({ code, memberId, tagLevel, memberLevel })) };
  if (!rules.vipOverrideEnabled) {
    throw unprocessable('VIP_LEVEL_TOO_LOW', `${describe(first, grades)}。请换普通柜或等级相符的 VIP 柜`, details);
  }
  if (!grantId) {
    throw unprocessable('VIP_AUTH_REQUIRED', `${describe(first, grades)}。如需使用，请值班经理或店总当场授权`, details);
  }
}

/** 核销授权（在事务最后、写操作编号之前调用）；没有等级不够的柜时不核销，返回 null */
export async function consumeVipShortfalls(
  tx: Tx,
  shortfalls: VipShortfall[],
  grantId: string | null,
  actor: Actor,
  usedRef: string,
): Promise<{ approverId: number; approverName: string } | null> {
  if (shortfalls.length === 0) return null;
  return consumeVipGrant(tx, {
    grantId: grantId!,
    actor,
    needed: shortfalls.map(({ code, memberId }) => ({ code, memberId })),
    usedRef,
  });
}
