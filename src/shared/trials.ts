// 临时身份（v0.7.25，docs/MEMBERSHIP_P3.md 第 3 节；PENDING_DECISIONS M51–M56）：低一档邀请体验、赠送记名会籍（QY-042）。
//
// 给对方一个临时的档级（初阶）与起止日期，只享权益：服务类与登记使用、结账会员折扣、VIP 柜按「自己的与临时身份的取高的」；
// 每月券类与事件礼只按自己的档阶，不进升档、升阶、保级的判断，他店查询显示自己的档阶。

import { shiftDate } from './labels';
import type { Grade, Tier } from './membership';

export const TRIAL_KINDS = ['invite', 'gift'] as const;
export type TrialKind = (typeof TRIAL_KINDS)[number];
export const TRIAL_KIND_LABELS: Record<TrialKind, string> = { invite: '邀请体验', gift: '赠送会籍' };

export const TRIAL_STATUSES = ['active', 'expired', 'converted', 'cancelled'] as const;
export type TrialStatus = (typeof TRIAL_STATUSES)[number];
export const TRIAL_STATUS_LABELS: Record<TrialStatus, string> = { active: '体验中', expired: '体验到期', converted: '转正', cancelled: '已撤销' };

/** 赠送记名会籍对应的本店权益（会员文档 QY-042「会籍赠送」） */
export const GIFT_BENEFIT_CODE = 'QY-042';
/** 低一档邀请体验：自己是 L2 起的会员（会员文档第 6 节） */
export const INVITE_MIN_GRADE = 2;
/** 赠送会籍：单次 1 个月（QY-042 的使用条件） */
export const GIFT_MONTHS = 1;

/** 在 ISO 日期上加减月数：下个月没有这一天时落在那个月的最后一天（1 月 31 日加一个月是 2 月 28 / 29 日） */
export function shiftMonths(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10);
}

/**
 * 体验的最后一天：邀请体验从当天起 days 天（含当天）；赠送会籍一个月（到下个月同一天的前一天，
 * 下个月没有这一天时到那个月的最后一天，例如 1 月 31 日起到 2 月 28 日）
 */
export function trialEndsOn(kind: TrialKind, start: string, inviteDays: number): string {
  if (kind === 'invite') return shiftDate(start, inviteDays - 1);
  const [, , d] = start.split('-').map(Number) as [number, number, number];
  const same = shiftMonths(start, GIFT_MONTHS);
  return Number(same.slice(8, 10)) < d ? same : shiftDate(same, -1);
}

/** 受邀人多少个月内只能被邀请或赠送一次：这一天（含）之后开始的都算 */
export const inviteeWindowFrom = (today: string, months: number): string => shiftDate(shiftMonths(today, -months), 1);

/** 一条临时身份 */
export interface TrialRow {
  id: number;
  kind: TrialKind;
  grade: Grade;
  tier: Tier;
  /** 「L3 观澜 · 初」 */
  label: string;
  startsOn: string;
  endsOn: string;
  memberId: number;
  memberNo: string;
  memberName: string;
  inviterId: number;
  inviterNo: string;
  inviterName: string;
  /** 赠送会籍：那次 QY-042 的使用登记 */
  benefitUseId: number | null;
  businessDate: string;
  staffName: string;
  createdAt: string;
  status: TrialStatus;
  endedOn: string | null;
  endedByName: string | null;
  endReason: string | null;
}

/** 会员详情：这位会员现在的临时身份、收到的与发起的 */
export interface MemberTrials {
  memberId: number;
  today: string;
  /** 今天生效中的临时身份（受邀人这一边） */
  active: TrialRow | null;
  /** 收到过的（最近的在前，最多 20 条） */
  received: TrialRow[];
  /** 发起过的邀请体验、赠送会籍（最近的在前，最多 20 条） */
  sent: TrialRow[];
}

/** 发起一种临时身份前的核对：能不能发起、给对方什么、到哪天 */
export interface TrialKindOption {
  allowed: boolean;
  /** 不能发起的原因 */
  reason: string | null;
  /** 给对方的档级（初阶）与「L2 云涧 · 初」 */
  grade: Grade | null;
  label: string | null;
  endsOn: string | null;
  /** 邀请体验：本月已邀请几次、每月几次；赠送会籍：QY-042 本期已用、上限（不计次为空） */
  used: number;
  limit: number | null;
  /** 次数怎么算：「本月」「今年」「不限次数」 */
  limitText: string;
}

/** 受邀人（按手机号）：已有会员时能不能接受这一种，没有会员档案时当场建档 */
export type TrialInvitee =
  | { exists: true; memberId: number; memberNo: string; name: string; label: string; problems: { invite: string | null; gift: string | null } }
  | { exists: false; problems: { invite: string | null; gift: string | null } };

export interface TrialOptions {
  inviterId: number;
  today: string;
  /** 邀请人自己的档阶（发起按自己的，临时身份不能再邀请、赠送别人） */
  own: { grade: Grade; tier: Tier | null; label: string };
  invite: TrialKindOption;
  gift: TrialKindOption;
  /** 带了手机号时的受邀人 */
  invitee: TrialInvitee | null;
}

/** 后台「会员体系」看板：临时身份 */
export interface TrialSummary {
  today: string;
  from: string;
  /** 今天生效中的：合计、邀请体验、赠送会籍 */
  active: number;
  activeInvite: number;
  activeGift: number;
  /** 本月发起、到期结束、转正、撤销 */
  started: number;
  expired: number;
  converted: number;
  cancelled: number;
  /** 7 天内到期的（生效中） */
  endingSoon: number;
}
