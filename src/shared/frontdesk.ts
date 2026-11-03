// 前台：手牌、来访、同行组与共同账单。前后端共用的类型与中文名称。金额为分。
//
// 手牌账单只汇总消费明细，不是第二套会员钱包：本阶段（S2）挂账不收款、不扣会员余额。

import type { BackfillMark } from './backfill';
import type { PriceTier } from './catalog';
import type { CheckoutDetail } from './checkout';
import type { MemberGradeBadge } from './membership';
import type { LineTechnician } from './technicians';

/** 宾客与手牌的分区：只分男宾、女宾（店主 2026-10-27 #27：儿童跟同性别家长用男宾或女宾的牌） */
export const ZONES = ['male', 'female'] as const;
export type Zone = (typeof ZONES)[number];
/** 库里可能出现的分区：child 只存在于 Batch 2.2 之前建的旧手牌与来访（见迁移 008），不能再登记 */
export type TagZone = Zone | 'child';
export const TAG_ZONES: readonly TagZone[] = ['male', 'female', 'child'];

export const ZONE_LABELS: Record<TagZone, { title: string; short: string }> = {
  male: { title: '男宾', short: '男' },
  female: { title: '女宾', short: '女' },
  child: { title: '儿童（旧分区）', short: '童' },
};

/** 柜型：普通柜（区号字母 + 数字，如 A8060）与 VIP 柜（纯数字，按等级使用） */
export const TAG_KINDS = ['normal', 'vip'] as const;
export type TagKind = (typeof TAG_KINDS)[number];
export const TAG_KIND_LABELS: Record<TagKind, string> = { normal: '普通柜', vip: 'VIP 柜' };
export const MAX_VIP_LEVEL = 9;

/** 区号：牌号的字母前缀（A8060 → A）；VIP 柜是纯数字，没有区号 */
export const tagArea = (code: string) => code.replace(/[0-9]/g, '');

export const BILL_SOURCES = ['bath', 'dining', 'therapist', 'room', 'other'] as const;
export type BillSource = (typeof BILL_SOURCES)[number];

export const BILL_SOURCE_LABELS: Record<BillSource, string> = {
  bath: '门票与洗浴项目',
  dining: '餐饮',
  therapist: '技师服务',
  room: '客房',
  other: '其他',
};

export const VISIT_STATUSES = ['open', 'settled', 'cancelled'] as const;
export type VisitStatus = (typeof VISIT_STATUSES)[number];

export const VISIT_STATUS_LABELS: Record<VisitStatus, string> = {
  open: '在店未结',
  settled: '已结离店',
  cancelled: '已撤销',
};

export const VOID_REASONS = ['项目选错', '数量录错', '挂错手牌', '顾客取消', '重复登记'] as const;
export const SWAP_REASONS = ['手牌丢失', '手牌损坏', '柜锁故障', '顾客要求换柜'] as const;
export const CANCEL_REASONS = ['开错手牌', '顾客未入场', '重复开牌'] as const;
export const LOCK_REASONS = ['手牌丢失', '手牌损坏', '柜锁故障', '暂停使用'] as const;

/**
 * 前台规则（店主 2026-10-27 已确认 15 分钟与丢牌 200 元；当场授权开关为默认值，待确认）。
 * 会员等级（原来的等级口径、各级门槛与名称）v0.7.23 起改由会员体系 v2 的「会员规则」管（档级 L0–L6，VIP 柜按档级对应，见 membership.ts）
 */
export interface FrontdeskRules {
  /** 店员可在多少分钟内自行作废本人刚登记的明细、撤销本人刚开的牌 */
  selfVoidMinutes: number;
  /** 丢牌赔偿（分），换牌时挂到客人账单；0 表示不收 */
  lostTagFeeCents: number;
  /** 允许值班经理 / 店总当场授权散客或档级不够的会员使用 VIP 柜（店主 ❓2：默认关闭） */
  vipOverrideEnabled: boolean;
  /** 门票跳档宽限分钟数（店主 ❓6，2026-10-29 签认 15 分钟：12 小时分界点之后 15 分钟内不跳档） */
  overtimeGraceMinutes: number;
}

export const DEFAULT_FRONTDESK_RULES: FrontdeskRules = {
  selfVoidMinutes: 15,
  lostTagFeeCents: 20000,
  vipOverrideEnabled: false,
  overtimeGraceMinutes: 15,
};

/** 牌号：0–2 位大写字母前缀 + 1–5 位数字 */
/** 转单（v0.7.6）：一次最多把几条明细转到另一张手牌 */
export const MAX_MOVE_LINES = 20;

export const TAG_CODE_PATTERN = /^[A-Z]{0,2}[0-9]{1,5}$/;

export function normalizeTagCode(input: string): string {
  return input.trim().toUpperCase().replace(/\s+/g, '');
}

/** 牌号里的数字部分，用于「输入末位快速检索」 */
export function tagDigits(code: string): string {
  return code.replace(/[^0-9]/g, '');
}

/**
 * 输入与牌号的匹配程度：0 = 完全相同；1 = 数字完全相同（输入 23 对 A023）或字母前缀开头；
 * 2 = 数字结尾相同（输入 23 对 B123）；-1 = 不匹配。
 */
export function tagMatchRank(code: string, input: string): number {
  const q = normalizeTagCode(input);
  if (!q) return -1;
  if (code === q) return 0;
  const qDigits = tagDigits(q);
  const qLetters = q.replace(/[0-9]/g, '');
  if (qLetters) {
    // 带字母：前缀相同，数字部分相同或结尾相同（A16 → A016）
    const letters = code.replace(/[0-9]/g, '');
    if (letters !== qLetters) return code.startsWith(q) ? 1 : -1;
    if (!qDigits) return 1;
    const d = tagDigits(code);
    if (Number(d) === Number(qDigits)) return 1;
    return d.endsWith(qDigits) ? 2 : -1;
  }
  const d = tagDigits(code);
  if (Number(d) === Number(qDigits)) return 1;
  return d.endsWith(qDigits) ? 2 : -1;
}

/**
 * 按输入匹配手牌：完全相同的牌号优先；否则按数字结尾匹配（输入 23 可找到 A023、B123）。
 * 结果按「完全匹配 → 数字完全相同 → 末位匹配」排序；同一档里普通柜在前、VIP 柜在后
 * （VIP 柜按等级使用，散客最常用的是普通柜）。
 */
export function matchTags<T extends { code: string; kind?: TagKind }>(tags: T[], input: string): T[] {
  const vipLast = (t: T) => (t.kind === 'vip' ? 1 : 0);
  return tags
    .map((t) => ({ t, r: tagMatchRank(t.code, input) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || vipLast(a.t) - vipLast(b.t) || a.t.code.length - b.t.code.length || a.t.code.localeCompare(b.t.code))
    .map((x) => x.t);
}

/**
 * 只有能唯一确定时才返回手牌：完全相同的牌号、唯一的数字完全相同、或唯一的候选。
 * 多张候选时返回 null，由员工明确选择，避免把实际拿到的 A026 记成 A016。
 */
export function uniqueTagMatch<T extends { code: string }>(tags: T[], input: string): T | null {
  const ranked = tags.map((t) => ({ t, r: tagMatchRank(t.code, input) })).filter((x) => x.r >= 0);
  const exact = ranked.filter((x) => x.r === 0);
  if (exact.length === 1) return exact[0]!.t;
  const numeric = ranked.filter((x) => x.r === 1);
  if (numeric.length === 1) return numeric[0]!.t;
  if (numeric.length === 0 && ranked.length === 1) return ranked[0]!.t;
  return null;
}

// ───────────── 接口返回 ─────────────

export interface HandTag {
  id: number;
  code: string;
  zone: TagZone;
  kind: TagKind;
  /** VIP 柜等级；普通柜为 null */
  vipLevel: number | null;
  locked: boolean;
  lockReason: string | null;
  active: boolean;
  isSynthetic: boolean;
}

/** 在店手牌状态板上的一张卡片 */
export interface BoardTag extends HandTag {
  visit: BoardVisit | null;
}

export interface BoardVisit {
  id: number;
  visitNo: string;
  billId: number;
  checkedInAt: string;
  memberId: number | null;
  memberName: string | null;
  /** 会员手机号后 4 位：前台按手机尾号找在店客人（不下发完整手机号） */
  memberPhoneTail: string | null;
  guestLabel: string;
  groupId: number | null;
  groupNo: string | null;
  /** 同行组当前在店人数（含自己） */
  groupOpenCount: number;
  amountCents: number;
  lineCount: number;
}

export interface FrontdeskBoard {
  tags: BoardTag[];
  stats: {
    inStore: number;
    inStoreByZone: Record<TagZone, number>;
    free: number;
    locked: number;
    unsettledCents: number;
    groups: number;
  };
  rules: FrontdeskRules;
  /** 服务器当前时间，页面据此计算在店时长，避免终端时钟不准 */
  serverTime: string;
}

export interface BillLine {
  id: number;
  source: BillSource;
  itemId: number | null;
  /** 所选价格档；手动输入金额、丢牌赔偿等明细为 null */
  tier: PriceTier | null;
  name: string;
  unitPrice: number;
  quantity: number;
  amount: number;
  status: 'active' | 'voided';
  postKey: string;
  businessDate: string;
  postedById: number;
  postedByName: string;
  postedAt: string;
  voidReason: string | null;
  voidedByName: string | null;
  voidedAt: string | null;
  /** 按实际时间补录的明细（R1.9）：纸质单号、实际时间与补录人；平时为 null */
  backfill: BackfillMark | null;
  /** 做这项服务的技师与点钟 / 轮钟（v0.7.0）；没有指定技师时为 null */
  technician: LineTechnician | null;
  /** 进厨房的菜（餐饮）：出品状态与口味备注；其他明细为 null */
  kitchen: { status: 'queued' | 'cooking' | 'done' | 'served' | 'cancelled'; note: string; orderNo: string } | null;
  /** 钟房派的钟、加的钟（v0.7.1）所属的钟单；其他明细为 null（v0.7.6 起返回，转单时用来判断能不能转） */
  sessionId: number | null;
}

export interface VisitMember {
  id: number;
  memberNo: string;
  name: string;
  phone: string;
  gender: 'female' | 'male' | null;
  status: 'active' | 'frozen';
  /** 仅供前台查看；S2 挂账不会扣减 */
  principalBalance: number;
  bonusBalance: number;
}

export interface GroupMate {
  visitId: number;
  visitNo: string;
  tagCode: string;
  zone: TagZone;
  status: VisitStatus;
  memberName: string | null;
  guestLabel: string;
  amountCents: number;
  lineCount: number;
  checkedInAt: string;
}

export interface VisitHistoryEvent {
  at: string;
  kind: 'checkin' | 'swap' | 'join' | 'leave' | 'post' | 'void' | 'close' | 'ticket' | 'reopen';
  text: string;
  operatorName: string;
}

export interface VisitDetail {
  id: number;
  visitNo: string;
  status: VisitStatus;
  zone: TagZone;
  guestLabel: string;
  businessDate: string;
  checkedInAt: string;
  checkedInById: number;
  checkedInByName: string;
  closedAt: string | null;
  closeReason: string | null;
  tag: HandTag;
  member: VisitMember | null;
  /** 会员的档阶与能用几级 VIP 柜（散客为 null），用于换牌到 VIP 柜时核对 */
  memberGrade: MemberGradeBadge | null;
  /** 开牌时档级不够、经当场授权使用 VIP 柜的授权人 */
  vipOverrideByName: string | null;
  /** 按实际时间补录的接待（R1.9）：纸质单号、实际时间与补录人；平时为 null */
  backfill: BackfillMark | null;
  /** 票种与按当前时刻计算的门票（Batch 3 之前开的牌没有票种，结账时补选） */
  ticket: {
    typeId: number;
    name: string;
    price12h: number;
    price24h: number;
    segments: number;
    tierLabel: string;
    amount: number;
    nextJumpAt: string;
    nextAmount: number;
    /** 反结账后重结：门票计到第一次结账的时刻，不再随时间跳档；平时为 null */
    endAt: string | null;
    /** 会员的浴票延迟（v0.7.25 续）：多给几分钟不跳档（在店的按门店当前营业日，已结账的按结账单记下的）；没有为 null */
    extension: Omit<import('./checkout').TicketExtension, 'version'> | null;
  } | null;
  /** 已结账离店时的结账单 */
  checkout: { id: number; checkoutNo: string; status: 'completed' | 'voided' } | null;
  bill: { id: number; billNo: string; status: VisitStatus; amountCents: number; lineCount: number };
  lines: BillLine[];
  group: { id: number; groupNo: string; status: 'open' | 'closed'; mates: GroupMate[]; openAmountCents: number } | null;
  history: VisitHistoryEvent[];
  serverTime: string;
}

/** 按操作编号查回 / 作废的结果 */
export type FrontdeskOpLookup =
  | { found: false; abandoned: boolean }
  | { found: true; type: 'checkin'; checkin: CheckinResult }
  | { found: true; type: 'bill_post' | 'tag_swap' | 'line_move'; visit: VisitDetail }
  | { found: true; type: 'checkout' | 'table_checkout'; checkout: CheckoutDetail }
  | { found: true; type: 'table_open' | 'table_post'; session: import('./dining').TableSessionDetail }
  | { found: true; type: 'room_checkin' | 'room_extend' | 'room_deposit' | 'room_refund' | 'room_close'; stay: import('./rooms').StayDetail }
  | { found: true; type: 'usage_open' | 'usage_end' | 'usage_cancel'; usage: import('./usages').UsageDetail }
  | { found: true; type: 'checkout_refund'; refund: import('./checkout').RefundDetail };

export interface CheckinResult {
  replayed: boolean;
  visits: { id: number; visitNo: string; tagCode: string; zone: TagZone }[];
  groupNo: string | null;
}

/** 预结账（S2 只汇总已挂明细，不收款） */
export interface PreviewBill {
  visits: {
    visitId: number;
    visitNo: string;
    tagCode: string;
    zone: TagZone;
    memberName: string | null;
    guestLabel: string;
    checkedInAt: string;
    amountCents: number;
    bySource: { source: BillSource; amountCents: number; lineCount: number }[];
  }[];
  totalCents: number;
  bySource: { source: BillSource; amountCents: number }[];
  serverTime: string;
}

export interface FrontdeskCheck {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}
