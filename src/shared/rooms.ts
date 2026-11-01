// S7 客房（v0.7.4，店主 2026-10-31 选定，见 docs/ROOMS.md）：房型与房价、房间与房态、入住单与房费、押金台账、夜审。
//
// 店主 2026-10-31 定：住客都是在店的洗浴客人（门票必选，没有只住房的客人）；房价不含洗浴门票，门票照常按门票规则计。
// 房费挂在客人的手牌账单上，离店时随手牌一起结账。其余规则先按洗浴中心客房、酒店的常见做法设默认值，标「待确认」，
// 店主在后台「客房」里改：
//   · 全天房按晚计价：入住时挂第一晚，夜审每晚挂一晚，同一晚只挂一次；退房时间 12:00，12:00–18:00 退房加收半天，
//     18:00 以后再加一晚；漏挂的在退房时补上；
//   · 钟点房按段计价（每段时长按房型）：入住时挂第一段，续住加一段，退房时超过已付时段加宽限按段补；
//   · 押金是负债，不算营业额：按收款方式记收、退，退房时原路退回；现金押金计入交班应有现金。

import { businessDateOf, businessDayStart } from './business-date';
import { PAYMENT_METHODS, shiftDate, type PaymentMethod } from './labels';

export interface RoomRules {
  /** 客房功能：关闭时主导航没有「客房」，前台、结账与升级前完全一样（默认关闭） */
  enabled: boolean;
  /** 全天房的退房时间：当天第几分钟（默认 12:00） */
  checkoutMinute: number;
  /** 过了这个时刻退房再加收一晚（默认 18:00）；退房时间到这个时刻之间加收半天。夜审也只能在这个时刻之后做 */
  lateFullMinute: number;
  /** 钟点房超过已付时段的宽限分钟（默认 15） */
  hourlyGraceMinutes: number;
  /** 入住时默认收的押金（分）；0 为默认不收（默认：住客都有手牌，离店前在前台结清） */
  defaultDeposit: number;
}

export const DEFAULT_ROOM_RULES: RoomRules = {
  enabled: false,
  checkoutMinute: 12 * 60,
  lateFullMinute: 18 * 60,
  hourlyGraceMinutes: 15,
  defaultDeposit: 0,
};

export const ROOM_KINDS = ['daily', 'hourly'] as const;
export type RoomKind = (typeof ROOM_KINDS)[number];
export const ROOM_KIND_LABELS: Record<RoomKind, string> = { daily: '全天房', hourly: '钟点房' };
/** 钟点房按小时计费：新建房型时每段默认 1 小时（店主 2026-10-31：要按小时计费，金额先给默认、后台可调；待确认） */
export const DEFAULT_BLOCK_MINUTES = 60;
/** 新建钟点房时默认的每小时房价 ¥60（待确认，后台「客房 → 房型」可改） */
export const DEFAULT_HOURLY_PRICE = 6000;

export const HOUSEKEEPING_STATES = ['clean', 'dirty', 'maintenance'] as const;
export type Housekeeping = (typeof HOUSEKEEPING_STATES)[number];
export const HOUSEKEEPING_LABELS: Record<Housekeeping, string> = { clean: '已打扫', dirty: '待打扫', maintenance: '维修' };

/** 房态看板上的状态：在住看有没有未退房的入住单，其余按打扫状态 */
export type RoomBoardStatus = 'vacant' | 'occupied' | 'dirty' | 'maintenance';
export const ROOM_BOARD_LABELS: Record<RoomBoardStatus, string> = { vacant: '空闲', occupied: '在住', dirty: '待打扫', maintenance: '维修' };

export const STAY_STATUSES = ['open', 'checked_out', 'cancelled'] as const;
export type StayStatus = (typeof STAY_STATUSES)[number];
export const STAY_STATUS_LABELS: Record<StayStatus, string> = { open: '在住', checked_out: '已退房', cancelled: '已撤销' };

/** 押金台账：收、退 */
export const DEPOSIT_KINDS = ['receive', 'refund'] as const;
export type DepositKind = (typeof DEPOSIT_KINDS)[number];
export const DEPOSIT_KIND_LABELS: Record<DepositKind, string> = { receive: '收押金', refund: '退押金' };
/** 押金的收款方式：现金、微信、支付宝、银行卡、其他（储值、团购券不能当押金） */
export const DEPOSIT_METHODS = PAYMENT_METHODS;

export const CHARGE_KINDS = ['night', 'half_day', 'block'] as const;
export type ChargeKind = (typeof CHARGE_KINDS)[number];

export const MAX_ROOM_NO = 8;
export const MAX_ROOM_FLOOR = 8;
export const MAX_ROOM_TYPE_NAME = 16;
export const MAX_STAY_GUESTS = 20;

export interface RoomType {
  id: number;
  name: string;
  kind: RoomKind;
  /** 分：全天房每晚、钟点房每段 */
  price: number;
  /** 钟点房每段分钟；全天房为 null */
  blockMinutes: number | null;
  sortOrder: number;
  active: boolean;
  /** 这个房型的启用房间数 */
  roomCount: number;
}

export interface Room {
  id: number;
  roomNo: string;
  floor: string;
  roomTypeId: number;
  housekeeping: Housekeeping;
  maintenanceNote: string | null;
  sortOrder: number;
  active: boolean;
  /** 有没有在住的入住单（有人住的房间不能停用、不能改房型、不能改挂接） */
  occupied: boolean;
  /** 挂接的空间台账空间（v0.7.14，RQ-003 剩余项）：挂上后房号就是空间编码 */
  spaceId: number | null;
  spaceCode: string | null;
  spaceName: string | null;
}

/** 房间可以挂的空间：空间台账里业态是「客房」的（停用的只在已挂着时列出） */
export interface RoomSpaceOption {
  id: number;
  code: string;
  displayName: string;
  floorCode: string;
  active: boolean;
  /** 已挂在哪间房上 */
  roomId: number | null;
}

export interface RoomsAdmin {
  rules: RoomRules;
  rulesUpdatedAt: string | null;
  rulesUpdatedBy: string | null;
  types: RoomType[];
  rooms: Room[];
  /** 空间台账里的「客房」空间（v0.7.14） */
  spaces: RoomSpaceOption[];
  /** 台账里已有在用的「客房」空间：新建房间必须选空间（房号不再手工录入） */
  spaceRequired: boolean;
}

/** 在住的入住单（房态看板、详情） */
export interface StaySummary {
  id: number;
  stayNo: string;
  kind: RoomKind;
  /** 入住时的房价（每晚 / 每段） */
  rate: number;
  guestLabel: string;
  guests: number;
  /** 住客的手牌与来访（房费挂在手牌账单上） */
  tagCode: string;
  visitId: number;
  /** 手牌上登记的会员 */
  memberId: number | null;
  memberName: string | null;
  checkedInAt: string;
  /** 入住的营业日 */
  businessDate: string;
  expectedCheckoutDate: string | null;
  /** 已挂、未作废的房费合计 */
  chargedAmount: number;
  depositBalance: number;
}

export interface RoomBoardRoom {
  id: number;
  roomNo: string;
  /** 挂接空间的显示名（v0.7.14；同名的品牌房号靠编码区分，显示「G305 · 客房 C5」） */
  spaceName: string | null;
  /** 挂接的空间（v0.7.16 房态图按它把房间画到图上） */
  spaceId: number | null;
  floor: string;
  typeName: string;
  kind: RoomKind;
  price: number;
  /** 钟点房每段分钟；全天房为 null */
  blockMinutes: number | null;
  status: RoomBoardStatus;
  maintenanceNote: string | null;
  stay: StaySummary | null;
}

export interface RoomAuditState {
  /** 今天的营业日 */
  date: string;
  /** 今天已经做过夜审 */
  done: boolean;
  runAt: string | null;
  runByName: string | null;
  /** 今晚还没挂房费的在住全天房 */
  pending: number;
  /** 过了加收一晚的时刻，可以做今天的夜审 */
  allowed: boolean;
}

export interface RoomBoard {
  rules: RoomRules;
  rooms: RoomBoardRoom[];
  audit: RoomAuditState;
  counts: Record<RoomBoardStatus, number>;
}

export interface StayCharge {
  id: number;
  kind: ChargeKind;
  nightDate: string | null;
  blockNo: number | null;
  amount: number;
  source: 'checkin' | 'audit' | 'checkout' | 'extend';
  lineId: number;
  /** 明细作废后为 voided（作废过的不再补挂） */
  lineStatus: 'active' | 'voided';
  createdAt: string;
  createdByName: string;
}

export interface DepositEntry {
  id: number;
  kind: DepositKind;
  method: PaymentMethod;
  amount: number;
  ref: string;
  reason: string | null;
  operatorName: string;
  createdAt: string;
}

export interface RoomMove {
  fromRoom: string;
  toRoom: string;
  reason: string;
  operatorName: string;
  createdAt: string;
}

/** 退房时要补的房费 */
export interface RoomDue {
  kind: ChargeKind;
  nightDate: string | null;
  blockNo: number | null;
  amount: number;
}

export interface StayDetail extends StaySummary {
  roomId: number;
  roomNo: string;
  typeName: string;
  blockMinutes: number | null;
  status: StayStatus;
  billId: number;
  billNo: string;
  /** 手牌账单上未作废的明细合计（房费之外还有客人的其他挂账） */
  billAmount: number;
  charges: StayCharge[];
  deposits: DepositEntry[];
  /** 每种收款方式的押金余额（只列不为 0 的） */
  depositByMethod: { method: PaymentMethod; balance: number }[];
  moves: RoomMove[];
  checkedOutAt: string | null;
  checkedOutByName: string | null;
  closeReason: string | null;
}

/** 退房核对：按此刻要补的房费、手牌账单合计与押金 */
export interface StayCheckoutPreview {
  stayId: number;
  at: string;
  dues: RoomDue[];
  dueAmount: number;
  /** 手牌账单上未作废的明细合计（不含要补的房费） */
  billAmount: number;
  depositBalance: number;
  depositByMethod: { method: PaymentMethod; balance: number }[];
}

/** 夜审报告 */
export interface RoomAuditReport {
  date: string;
  runAt: string;
  runByName: string;
  /** 这次挂的房费 */
  posted: { stayNo: string; roomNo: string; nightDate: string; amount: number }[];
  postedAmount: number;
  /** 在住的入住单 */
  stays: (StaySummary & { roomNo: string })[];
  depositBalance: number;
  counts: Record<RoomBoardStatus, number>;
}

/** 看板「客房」（经营总览的岗位看）：此刻的房态与押金、任选时段的入住、房费营业额（结账口径）与押金 */
export interface RoomsReport {
  from: string;
  to: string;
  now: {
    counts: Record<RoomBoardStatus, number>;
    /** 启用的房间数 */
    rooms: number;
    /** 在住押金余额 */
    depositHeld: number;
  };
  /** 时段内入住的入住单（不含撤销的），按入住营业日 */
  checkins: number;
  /** 时段内挂上、没作废的全天房晚数（按哪一晚）与钟点房段数（按挂上的营业日） */
  nights: number;
  blocks: number;
  /** 客房营业额：时段内结账的房费（反结账冲回），与部门参考表的「客房」同一口径，按房费种类 */
  revenue: { total: number; byKind: { name: string; quantity: number; amount: number }[] };
  /** 平均房价：结账口径的全天房房费 ÷ 晚数；没有全天房房费时为 null */
  averageRate: number | null;
  /** 时段内押金的收、退 */
  deposits: { received: number; refunded: number };
  days: { date: string; checkins: number; nights: number; revenue: number }[];
}

/** 门店时区某天的第几分钟对应的时刻 */
export function localMinuteAt(date: string, minute: number, timeZone: string): Date {
  return new Date(businessDayStart(date, timeZone, 0).getTime() + minute * 60_000);
}

/**
 * 退房时要付的房费（服务端结账、退房与页面核对共用，见 docs/ROOMS.md 第 3 节）。charged 是已经挂过的（含作废过的：作废是前台有意的更正，不再补）。
 * 全天房：从入住营业日到退房营业日的前一天每晚一次（至少一晚）；过了退房营业日的退房时间、没到加收一晚的时刻加收半天；
 * 过了加收一晚的时刻，退房营业日这一晚也要付。钟点房：超过已付时段加宽限按段补齐（至少一段）。
 */
export function roomDues(
  stay: { kind: RoomKind; rate: number; blockMinutes: number | null; businessDate: string; checkedInAt: string | Date },
  charged: { nights: ReadonlySet<string>; halfDays: ReadonlySet<string>; blocks: ReadonlySet<number> },
  at: Date,
  rules: Pick<RoomRules, 'checkoutMinute' | 'lateFullMinute' | 'hourlyGraceMinutes'>,
  clock: { timeZone: string; startHour: number },
): RoomDue[] {
  const dues: RoomDue[] = [];
  if (stay.kind === 'hourly') {
    const block = stay.blockMinutes ?? DEFAULT_BLOCK_MINUTES;
    const elapsed = Math.max(0, (at.getTime() - new Date(stay.checkedInAt).getTime()) / 60_000);
    const needed = Math.max(1, Math.ceil((elapsed - rules.hourlyGraceMinutes) / block));
    for (let n = 1; n <= needed; n++) {
      if (!charged.blocks.has(n)) dues.push({ kind: 'block', nightDate: null, blockNo: n, amount: stay.rate });
    }
    return dues;
  }
  const checkoutDate = businessDateOf(at, clock.timeZone, clock.startHour);
  let lastNight = shiftDate(checkoutDate, -1) < stay.businessDate ? stay.businessDate : shiftDate(checkoutDate, -1);
  let halfDay = false;
  if (checkoutDate > stay.businessDate) {
    if (at.getTime() >= localMinuteAt(checkoutDate, rules.lateFullMinute, clock.timeZone).getTime()) lastNight = checkoutDate;
    else if (at.getTime() > localMinuteAt(checkoutDate, rules.checkoutMinute, clock.timeZone).getTime()) halfDay = true;
  }
  for (let d = stay.businessDate; d <= lastNight; d = shiftDate(d, 1)) {
    if (!charged.nights.has(d)) dues.push({ kind: 'night', nightDate: d, blockNo: null, amount: stay.rate });
  }
  if (halfDay && !charged.halfDays.has(checkoutDate) && !charged.nights.has(checkoutDate)) {
    dues.push({ kind: 'half_day', nightDate: checkoutDate, blockNo: null, amount: Math.round(stay.rate / 2) });
  }
  return dues;
}

/** 房费明细的名称（账单、结账单与打印上显示） */
export function chargeLineName(roomNo: string, d: Pick<RoomDue, 'kind' | 'nightDate' | 'blockNo'>): string {
  if (d.kind === 'block') return `钟点房 ${roomNo} 第 ${d.blockNo} 段`;
  const md = d.nightDate ? `${Number(d.nightDate.slice(5, 7))}月${Number(d.nightDate.slice(8, 10))}日` : '';
  return d.kind === 'half_day' ? `房费 ${roomNo} ${md} 超时半天` : `房费 ${roomNo} ${md}`;
}
