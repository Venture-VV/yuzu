// 前台：手牌、来访、同行组与共同账单。前后端共用的类型与中文名称。金额为分。
//
// 手牌账单只汇总消费明细，不是第二套会员钱包：本阶段（S2）挂账不收款、不扣会员余额。

export const ZONES = ['male', 'female', 'child'] as const;
export type Zone = (typeof ZONES)[number];

export const ZONE_LABELS: Record<Zone, { title: string; short: string }> = {
  male: { title: '男宾', short: '男' },
  female: { title: '女宾', short: '女' },
  child: { title: '儿童', short: '童' },
};

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

/** 前台规则（模拟默认值，待店主确认） */
export interface FrontdeskRules {
  /** 店员可在多少分钟内自行作废本人刚登记的明细、撤销本人刚开的牌 */
  selfVoidMinutes: number;
}

export const DEFAULT_FRONTDESK_RULES: FrontdeskRules = { selfVoidMinutes: 10 };

/** 牌号：0–2 位大写字母前缀 + 1–5 位数字 */
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
 * 结果按「完全匹配 → 数字完全相同 → 末位匹配」排序。
 */
export function matchTags<T extends { code: string }>(tags: T[], input: string): T[] {
  return tags
    .map((t) => ({ t, r: tagMatchRank(t.code, input) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.t.code.length - b.t.code.length || a.t.code.localeCompare(b.t.code))
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
  zone: Zone;
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
    inStoreByZone: Record<Zone, number>;
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
  zone: Zone;
  status: VisitStatus;
  memberName: string | null;
  guestLabel: string;
  amountCents: number;
  lineCount: number;
  checkedInAt: string;
}

export interface VisitHistoryEvent {
  at: string;
  kind: 'checkin' | 'swap' | 'join' | 'leave' | 'post' | 'void' | 'close';
  text: string;
  operatorName: string;
}

export interface VisitDetail {
  id: number;
  visitNo: string;
  status: VisitStatus;
  zone: Zone;
  guestLabel: string;
  businessDate: string;
  checkedInAt: string;
  checkedInById: number;
  checkedInByName: string;
  closedAt: string | null;
  closeReason: string | null;
  tag: HandTag;
  member: VisitMember | null;
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
  | { found: true; type: 'bill_post' | 'tag_swap'; visit: VisitDetail };

export interface CheckinResult {
  replayed: boolean;
  visits: { id: number; visitNo: string; tagCode: string; zone: Zone }[];
  groupNo: string | null;
}

/** 预结账（S2 只汇总已挂明细，不收款） */
export interface PreviewBill {
  visits: {
    visitId: number;
    visitNo: string;
    tagCode: string;
    zone: Zone;
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
