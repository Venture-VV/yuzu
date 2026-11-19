// 前台：NFC 发牌、发牌前风控、发牌后异常处置（8.1.15《浴族系统需求汇总》块 A，docs/FRONTDESK_RISK_V8115.md）。
// 前后端共用的类型、常量与中文名称。金额为分。

import type { HandTag, TagZone } from './frontdesk';

// ───────────── 手牌芯片号 ─────────────

/** 芯片号：读卡器读到的卡号（NFC 的 UID 或十进制卡号），去掉分隔符、转大写后 4–32 位数字或大写字母 */
export const CARD_UID_PATTERN = /^[0-9A-Z]{4,32}$/;

/** 读卡器报上来的卡号写法不一（04:A1:B2、04-a1-b2、带空格）：去掉分隔符、转大写 */
export function normalizeCardUid(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[\s:：\-_.]/g, '');
}

/** 一张手牌现在的状态（刷卡带出牌号时写明为什么不能发） */
export type TagCardState = 'free' | 'in_use' | 'locked' | 'inactive';

/** 按芯片号查手牌 */
export type TagByCard =
  | { found: false; cardUid: string }
  | {
      found: true;
      cardUid: string;
      tag: Pick<HandTag, 'id' | 'code' | 'zone' | 'kind' | 'vipLevel' | 'locked' | 'lockReason' | 'active'>;
      state: TagCardState;
      /** 已在店时：现在是哪一次来访 */
      visit: { id: number; visitNo: string } | null;
    };

/** 按芯片号查到了的那一种（刷卡带出牌号的部件把它交给调用方判断能不能用） */
export type TagCardFound = Extract<TagByCard, { found: true }>;

/** 刷到的这张牌为什么不能发；能发返回 null。zone 为这位客人选的分区（没选过的不核对分区） */
export function cardProblem(found: TagCardFound, zone: TagZone | null, zoneTitle: (z: TagZone) => string): string | null {
  const code = found.tag.code;
  if (found.state === 'inactive') return `手牌 ${code} 已停用，请换一张`;
  if (found.state === 'locked') return `手牌 ${code} 已锁定（${found.tag.lockReason ?? '原因未填'}），请换一张`;
  if (found.state === 'in_use') return `手牌 ${code} 已在店${found.visit ? `（来访 ${found.visit.visitNo}）` : ''}，不能重复发出`;
  if (zone && found.tag.zone !== zone) return `分区不符：${code} 是${zoneTitle(found.tag.zone)}牌，这位客人选的是${zoneTitle(zone)}`;
  return null;
}

// ───────────── 发牌前风控 ─────────────

/** 发牌前风控的开关（功能开关，默认开；关了发牌与以前一样：不查黑名单、不拦未结离店、不带预约） */
export interface FrontdeskRiskRules {
  enabled: boolean;
}
export const DEFAULT_FRONTDESK_RISK_RULES: FrontdeskRiskRules = { enabled: true };

export interface BlacklistEntry {
  id: number;
  memberId: number | null;
  memberNo: string | null;
  phone: string | null;
  name: string;
  reason: string;
  createdByName: string;
  createdAt: string;
  liftedByName: string | null;
  liftedAt: string | null;
  liftReason: string | null;
}

/** 没处理完的「未结离店」（这位会员上一次来欠着的） */
export interface UnsettledDebt {
  incidentId: number;
  visitId: number;
  visitNo: string;
  tagCode: string;
  amountCents: number;
  note: string;
  createdByName: string;
  createdAt: string;
  assigneeName: string | null;
}

/** 今天待到店的预约（发牌成功后自动标「已到店」；派对房要开使用单，仍在「预约」页点到店） */
export interface RiskBooking {
  id: number;
  bookingNo: string;
  kind: 'technician' | 'space' | 'room';
  status: 'pending' | 'confirmed';
  startsAt: string;
  /** 约的是什么：项目名 / 房间 / 房型 */
  what: string;
  technicianText: string | null;
  note: string;
  /** 发牌成功后会不会自动标到店（派对房不会） */
  autoArrive: boolean;
}

/** 一位会员发牌前的风控结果（页面预先看；发牌接口里再核对一遍，页面看到的不算数） */
export interface MemberRisk {
  enabled: boolean;
  memberId: number;
  /** 命中黑名单：发牌会被拒绝 */
  blacklist: Pick<BlacklistEntry, 'id' | 'name' | 'reason' | 'createdByName' | 'createdAt'> | null;
  /** 没处理完的未结离店：要值班经理及以上当场授权才能发 */
  unsettled: UnsettledDebt[];
  /** 今天来过几次（不算撤销的）；最后一次的牌号与离店时间（还在店的离店时间为空） */
  visitsToday: { count: number; last: { tagCode: string; visitNo: string; closedAt: string | null } | null };
  bookings: RiskBooking[];
}

// ───────────── 发牌后的异常 ─────────────

/** 超时在店的三级：12 / 24 / 72 小时（黄 / 橙 / 红，都配文字） */
export const OVERSTAY_TIERS = [
  { hours: 72, level: 3, label: '超 72 小时' },
  { hours: 24, level: 2, label: '超 24 小时' },
  { hours: 12, level: 1, label: '超 12 小时' },
] as const;

/** 在店多少分钟 → 超时等级与文字；不到 12 小时返回 null */
export function overstayOf(minutes: number): { level: 1 | 2 | 3; label: string; hours: number } | null {
  const t = OVERSTAY_TIERS.find((x) => minutes >= x.hours * 60);
  return t ? { level: t.level, label: t.label, hours: t.hours } : null;
}

export const INCIDENT_KINDS = ['remind', 'surcharge', 'report', 'away', 'return', 'unsettled'] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];
export const INCIDENT_KIND_LABELS: Record<IncidentKind, string> = {
  remind: '已提醒',
  surcharge: '超时加收',
  report: '上报',
  away: '临时外出',
  return: '返回',
  unsettled: '未结离店',
};
/** 要有人跟进、写处理结果的两种（进「异常待办」） */
export const TODO_KINDS: readonly IncidentKind[] = ['report', 'unsettled'];

/** 加收挂到账单上的明细名称 */
export const SURCHARGE_LINE_NAME = '超时加收';
/** 加收一笔最多多少（分）：防多敲几个零 */
export const MAX_SURCHARGE_CENTS = 10_000_00;

export interface VisitIncident {
  id: number;
  visitId: number;
  kind: IncidentKind;
  note: string;
  amountCents: number | null;
  /** 加收由别人当场授权时的授权人 */
  approvedByName: string | null;
  createdByName: string;
  createdAt: string;
  /** 待办才有：现在的责任人、处理结果 */
  assigneeId: number | null;
  assigneeName: string | null;
  resolved: { note: string; byName: string; at: string } | null;
}

/** 「异常待办」的一行：没处理完的上报、未结离店 */
export interface IncidentTodo extends VisitIncident {
  visitNo: string;
  visitStatus: 'open' | 'settled' | 'cancelled';
  tagCode: string;
  zone: TagZone;
  memberName: string | null;
  guestLabel: string;
  /** 这次来访账单上现在挂着多少（不含门票） */
  billAmountCents: number;
  checkedInAt: string;
}

export interface IncidentTodoList {
  todos: IncidentTodo[];
  /** 能指派给谁：在职的前台岗位（店主、店总、值班经理、收银） */
  assignees: { id: number; name: string; role: string }[];
}

/** 当场授权（用途 checkin_risk）的对象：发牌时放行未结离店的会员，或授权一笔超时加收 */
export type CheckinRiskScope = { kind: 'checkin'; memberIds: number[]; reason: string } | { kind: 'surcharge'; visitId: number; amount: number; reason: string };

/** 发牌授权是否覆盖这几位会员 */
export function riskGrantCovers(scope: CheckinRiskScope, memberIds: readonly number[]): boolean {
  return scope.kind === 'checkin' && memberIds.every((id) => scope.memberIds.includes(id));
}
