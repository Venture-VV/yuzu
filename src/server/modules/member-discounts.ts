// 会员折扣（v0.7.25，docs/MEMBERSHIP_P3.md 第 2 节；PENDING_DECISIONS M44–M48）：手牌结账时自动算，桌台结账不算（M48）。
//   · 能享：已发布的折扣类权益，会员的档阶不低于起点（自己的与临时身份的取高的，M51），这一天合每周几 / 每月几号；
//   · 金额：只按这位会员本人手牌账单上的适用明细（客房房费 / 门票 / 整张账单）算，省下的 = 合计 − 合计 × 付几成 ÷ 100，四舍五入到分；
//   · 一单一种：几位会员、几项折扣里自动用省得最多的一种；与券抵扣、「优惠 / 免单」二选一；没选券、优惠时必须带上（M45）；
//   · 结账前核对按推算到当天的档阶（只读）；结账事务里在会员一行锁住、到期没处理的处理完以后按此刻的明细重新算，
//     与员工确认的不一致时拒绝（MEMBER_DISCOUNT_CHANGED），收款明细记一笔「会员折扣」（会员、权益与版本、折扣、适用明细）。
// 会员折扣是优惠、不是收款：部门营业额快照只按适用明细分摊（与券抵扣同一个函数），退款单不能退，反结账随结账单作废。

import {
  benefitEligible,
  benefitQuantity,
  DISCOUNT_TARGET_LABELS,
  discountDayMatches,
  discountLines,
  discountOff,
  MAX_DISCOUNT_RATE,
  MIN_DISCOUNT_RATE,
  rateText,
  type DiscountTarget,
  type TierQuantity,
} from '@shared/benefits';
import type { MemberDiscountOption } from '@shared/checkout';
import type { CouponLine } from '@shared/coupons';
import { formatYuan } from '@shared/money';
import { gradeLabel, type Tier } from '@shared/membership';
import type { Db, Tx } from '../db';
import { conflict, unprocessable } from '../lib/errors';
import { couponLines } from './coupon-checkout';
import { loadMembershipRules, projectedGrade, settleMemberDue } from './membership';
import { benefitState } from './member-trials';

interface DiscountDef {
  id: number;
  code: string;
  name: string;
  version: number;
  startGrade: number | null;
  startTier: number | null;
  quantity: number | null;
  tierQuantities: TierQuantity[];
  discountTarget: DiscountTarget | null;
  weekdays: number[];
  monthDays: number[];
  sortOrder: number;
}

/** 已发布的折扣类（不加锁，读已提交的；结账事务里读到的就是这一刻的） */
async function publishedDiscounts(db: Db): Promise<DiscountDef[]> {
  return db<DiscountDef[]>`
    SELECT id, code, name, version, start_grade, start_tier, quantity, tier_quantities, discount_target, weekdays::int[] AS weekdays,
           month_days::int[] AS month_days, sort_order
    FROM benefits WHERE status = 'published' AND category = 'discount' AND discount_target IS NOT NULL
    ORDER BY sort_order, id`;
}

/** 一位会员在这张结账单里：本人手牌、本人账单上的有效明细（结账前核对时含按此刻算出的门票） */
export interface DiscountGuest {
  memberId: number;
  memberName: string;
  tagCode: string;
  grade: number;
  tier: number | null;
  lines: CouponLine[];
}

/** 这几位会员能享的会员折扣，省得多的在前（相同时按折扣低的、清单顺序、会员编号）；省 0 元的不列 */
export function discountOptions(defs: DiscountDef[], guests: DiscountGuest[], date: string, label: (grade: number, tier: number | null) => string): (MemberDiscountOption & { lineIds: number[]; sortOrder: number })[] {
  const out: (MemberDiscountOption & { lineIds: number[]; sortOrder: number })[] = [];
  for (const g of guests) {
    for (const d of defs) {
      if (!d.discountTarget || !benefitEligible(d, g.grade, g.tier) || !discountDayMatches(d, date)) continue;
      const rate = benefitQuantity(d, g.grade, g.tier);
      if (rate === null || rate < MIN_DISCOUNT_RATE || rate > MAX_DISCOUNT_RATE) continue;
      const lines = discountLines(d.discountTarget, g.lines).filter((l) => l.amount > 0);
      const base = lines.reduce((s, l) => s + l.amount, 0);
      const amount = discountOff(base, rate);
      if (amount <= 0) continue;
      out.push({
        memberId: g.memberId,
        memberName: g.memberName,
        tagCode: g.tagCode,
        benefitId: Number(d.id),
        code: d.code,
        name: d.name,
        version: d.version,
        rate,
        stateLabel: label(g.grade, g.tier),
        target: d.discountTarget,
        base,
        amount,
        lineIds: lines.map((l) => Number(l.id)),
        sortOrder: d.sortOrder,
      });
    }
  }
  return out.sort((a, b) => b.amount - a.amount || a.rate - b.rate || a.sortOrder - b.sortOrder || a.benefitId - b.benefitId || a.memberId - b.memberId);
}

const publicOption = ({ lineIds: _l, sortOrder: _s, ...o }: MemberDiscountOption & { lineIds: number[]; sortOrder: number }): MemberDiscountOption => o;

/** 结账前核对（只读）：visits 是这张结账单里有会员的客人；ticketOf 给出这位客人按此刻算出的门票（还没挂到账单，用负数编号） */
export async function memberDiscountPreview(
  db: Db,
  visits: { visitId: number; billId: number; memberId: number; memberName: string; tagCode: string; ticket: CouponLine | null }[],
  date: string,
): Promise<MemberDiscountOption[]> {
  if (visits.length === 0) return [];
  const defs = await publishedDiscounts(db);
  if (defs.length === 0) return [];
  const rules = await loadMembershipRules(db);
  const guests: DiscountGuest[] = [];
  for (const v of visits) {
    const [m] = await db<{ status: string }[]>`SELECT status FROM members WHERE id = ${v.memberId}`;
    if (m?.status !== 'active') continue;
    const own = await projectedGrade(db, v.memberId, date);
    if (!own) continue;
    const s = await benefitState(db, v.memberId, own, date);
    guests.push({ memberId: v.memberId, memberName: v.memberName, tagCode: v.tagCode, grade: s.grade, tier: s.tier, lines: [...(await couponLines(db, [v.billId])), ...(v.ticket ? [v.ticket] : [])] });
  }
  return discountOptions(defs, guests, date, (g, t) => gradeLabel(rules, g, t as Tier | null)).map(publicOption);
}

/** 结账收款里的「会员折扣」：员工确认时看到的会员、权益与金额 */
export interface MemberDiscountInput {
  memberId: number;
  benefitId: number;
  amount: number;
}

/** 核对通过、要记账的会员折扣 */
export interface MemberDiscountEntry {
  memberId: number;
  benefitId: number;
  version: number;
  rate: number;
  amount: number;
  lineIds: number[];
  ref: string;
}

/**
 * 结账事务里（账单已锁、门票已挂到账单）：这张结账单里的会员按 id 升序锁住、到期没处理的先按规则处理掉，按此刻的明细重新算能享的会员折扣。
 * - 带了会员折扣：必须就是省得最多的那一项、金额一致，否则拒绝（MEMBER_DISCOUNT_CHANGED）；
 * - 没带、也没有券抵扣与「优惠 / 免单」：有能享的就拒绝（MEMBER_DISCOUNT_REQUIRED，M45 不能漏）；
 * - 用了券或优惠：不算会员折扣（二选一）。
 * 返回要记账的会员折扣（没有为空）
 */
export async function settleMemberDiscount(
  tx: Tx,
  o: {
    guests: { memberId: number; memberName: string; tagCode: string; billId: number }[];
    input: MemberDiscountInput | null;
    otherReduction: boolean;
    date: string;
  },
): Promise<MemberDiscountEntry | null> {
  const ids = [...new Set(o.guests.map((g) => g.memberId))].sort((a, b) => a - b);
  if (ids.length === 0) {
    if (o.input) throw unprocessable('MEMBER_DISCOUNT_NOT_AVAILABLE', '这张结账单里没有会员，不能用会员折扣');
    return null;
  }
  if (o.input && o.otherReduction) throw unprocessable('MEMBER_DISCOUNT_WITH_COUPON', '会员折扣不能和券、优惠 / 免单同时用，请二选一');
  // 用了券或优惠（二选一），或者没有发布的折扣类：不算会员折扣，也不多锁会员
  if (o.otherReduction) return null;
  const defs = await publishedDiscounts(tx);
  if (defs.length === 0 && !o.input) return null;
  // 会员一行（id 升序；会员储值随后再锁同样的行，顺序不变）→ 到期没处理的先处理（与储值消费一样）
  const locked = await tx<{ id: number; status: string }[]>`SELECT id, status FROM members WHERE id IN ${tx(ids)} ORDER BY id FOR UPDATE`;
  const rules = await loadMembershipRules(tx);
  const guests: DiscountGuest[] = [];
  for (const g of o.guests) {
    if (locked.find((m) => Number(m.id) === g.memberId)?.status !== 'active') continue;
    const own = await settleMemberDue(tx, g.memberId, o.date);
    if (!own) continue;
    const s = await benefitState(tx, g.memberId, own, o.date);
    guests.push({ memberId: g.memberId, memberName: g.memberName, tagCode: g.tagCode, grade: s.grade, tier: s.tier, lines: await couponLines(tx, [g.billId]) });
  }
  const options = defs.length ? discountOptions(defs, guests, o.date, (gr, t) => gradeLabel(rules, gr, t as Tier | null)) : [];
  const best = options[0] ?? null;
  if (o.input) {
    if (!best || best.memberId !== o.input.memberId || best.benefitId !== o.input.benefitId || best.amount !== o.input.amount) {
      throw conflict(
        'MEMBER_DISCOUNT_CHANGED',
        best
          ? `会员折扣现在是「${best.memberName} · ${best.name} · ${rateText(best.rate)}」省 ${formatYuan(best.amount)}（会员的档阶、折扣或账单明细刚有变化），请核对后重新确认`
          : '这张结账单现在没有能享的会员折扣（会员的档阶、折扣或账单明细刚有变化），请核对后重新确认',
        { best: best ? publicOption(best) : null },
      );
    }
  } else if (best) {
    throw unprocessable(
      'MEMBER_DISCOUNT_REQUIRED',
      `会员「${best.memberName}」能享「${best.name}」${rateText(best.rate)}，省 ${formatYuan(best.amount)}：会员折扣要带上（或改用券、优惠 / 免单，二选一），请重新核对`,
      { best: publicOption(best) },
    );
  }
  if (!best || !o.input) return null;
  return {
    memberId: best.memberId,
    benefitId: best.benefitId,
    version: best.version,
    rate: best.rate,
    amount: best.amount,
    lineIds: best.lineIds,
    ref: `${best.name}（${best.stateLabel} ${rateText(best.rate)} · ${DISCOUNT_TARGET_LABELS[best.target]}）`.slice(0, 64),
  };
}
