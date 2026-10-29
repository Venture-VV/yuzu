// VIP 柜等级校验（店主 2026-10-27 #26：会员等级不低于柜子等级才能使用该柜）。
//
// 会员等级按前台规则的口径计算：累计充值实收（默认，含期初导入的旧系统累计充值）或当前余额（本金 + 赠金）；散客为 0 级。
// 只读会员与充值记录，不加锁：等级是开牌那一刻的经营规则判断，不影响任何账务。
// 等级不够时：规则未开启当场授权 → 拒绝；已开启 → 必须带值班经理 / 店总签发的授权，在同一事务里核销。

import { levelOf, VIP_LEVEL_BASIS_LABELS, type FrontdeskRules, type MemberLevel } from '@shared/frontdesk';
import type { VipGrantTag } from '@shared/grants';
import { formatYuan } from '@shared/money';
import { consumeVipGrant } from '../../auth/grants';
import type { Db, Tx } from '../../db';
import type { Actor } from '../../lib/context';
import { unprocessable } from '../../lib/errors';
import type { LockedTag } from './common';

export async function memberLevels(db: Db, memberIds: number[], rules: FrontdeskRules): Promise<Map<number, MemberLevel>> {
  const ids = [...new Set(memberIds)];
  if (ids.length === 0) return new Map();
  const rows =
    rules.vipLevelBasis === 'balance'
      ? await db<{ id: number; amountCents: number }[]>`
          SELECT id, principal_balance + bonus_balance AS amount_cents FROM members WHERE id IN ${db(ids)}`
      : await db<{ id: number; amountCents: number }[]>`
          SELECT m.id,
                 coalesce((SELECT sum(r.paid_amount) FROM recharges r WHERE r.member_id = m.id), 0)
                 + coalesce((SELECT sum(o.legacy_recharged) FROM opening_balances o WHERE o.member_id = m.id AND o.status = 'active'), 0)
                   AS amount_cents
          FROM members m WHERE m.id IN ${db(ids)}`;
  return new Map(
    rows.map((r) => [
      r.id,
      { memberId: r.id, level: levelOf(Number(r.amountCents), rules.vipLevelThresholds), basis: rules.vipLevelBasis, amountCents: Number(r.amountCents) },
    ]),
  );
}

export interface VipShortfall extends VipGrantTag {
  tagLevel: number;
  memberLevel: number;
  memberName: string | null;
}

/** 找出客人等级低于柜子等级的 VIP 柜 */
export function vipShortfalls(
  guests: { tag: LockedTag; memberId: number | null; memberName: string | null }[],
  levels: Map<number, MemberLevel>,
): VipShortfall[] {
  return guests
    .filter((g) => g.tag.kind === 'vip')
    .map((g) => ({
      code: g.tag.code,
      memberId: g.memberId,
      memberName: g.memberName,
      tagLevel: g.tag.vipLevel!,
      memberLevel: g.memberId ? (levels.get(g.memberId)?.level ?? 0) : 0,
    }))
    .filter((s) => s.memberLevel < s.tagLevel);
}

function describe(s: VipShortfall, levels: Map<number, MemberLevel>) {
  if (!s.memberId) return `VIP 柜 ${s.code} 是第 ${s.tagLevel} 级柜，只供第 ${s.tagLevel} 级及以上的会员使用，散客不能使用`;
  const l = levels.get(s.memberId);
  const basis = l ? `，${VIP_LEVEL_BASIS_LABELS[l.basis]} ${formatYuan(l.amountCents)}` : '';
  return `会员「${s.memberName ?? ''}」当前第 ${s.memberLevel} 级${basis}，不能使用第 ${s.tagLevel} 级 VIP 柜 ${s.code}`;
}

/**
 * 有等级不够的 VIP 柜时，确认可以授权（尽早调用，避免做无用功）：
 * 未开启当场授权 → VIP_LEVEL_TOO_LOW；已开启但没带授权 → VIP_AUTH_REQUIRED。
 */
export function assertVipAllowed(shortfalls: VipShortfall[], levels: Map<number, MemberLevel>, rules: FrontdeskRules, grantId: string | null) {
  if (shortfalls.length === 0) return;
  const first = shortfalls[0]!;
  const details = { shortfalls: shortfalls.map(({ code, memberId, tagLevel, memberLevel }) => ({ code, memberId, tagLevel, memberLevel })) };
  if (!rules.vipOverrideEnabled) {
    throw unprocessable('VIP_LEVEL_TOO_LOW', `${describe(first, levels)}。请换普通柜或等级相符的 VIP 柜`, details);
  }
  if (!grantId) {
    throw unprocessable('VIP_AUTH_REQUIRED', `${describe(first, levels)}。如需使用，请值班经理或店总当场授权`, details);
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
