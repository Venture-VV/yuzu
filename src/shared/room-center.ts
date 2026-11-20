// 房态中心（8.1.15，《浴族系统需求汇总》房态中心 1–4，见 docs/ROOM_CENTER_V8115.md）：
// 房间来自空间台账，按「房型」分页签；每间房五种状态里的一种——空闲、在用、待清、维修、已预订。
//   · 技师服务的房间（service）：点卡片登记手牌、项目、档次、技师、出单员、备注、开始时间（挂账 + 派钟 + 占房一步做完），
//     之后换房、续钟、并房、退房；
//   · 开单即占用的房间（party，派对房等）：沿用使用单（开单、结束计费、撤单）；
//   · 客房（hotel）：沿用入住单与原来的房态（入住、续住、换房、退房、打扫、维修）；
//   · 大厅类（hall）：没有业务单据，只有待清、维修两样手动的状态。
// 这里是页面与服务端共用的名称、状态口径与接口返回的形状。

import type { CallType } from './technicians';
import type { RoomBoardRoom } from './rooms';
import { isTechnicianBusinessType, ROOM_BUSINESS_TYPE } from './spaces';
import type { UsageDetail } from './usages';

export const ROOM_STATUSES = ['free', 'in_use', 'dirty', 'maintenance', 'booked'] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];
export const ROOM_STATUS_LABELS: Record<RoomStatus, string> = { free: '空闲', in_use: '在用', dirty: '待清', maintenance: '维修', booked: '已预订' };

/**
 * 几样同时成立时显示哪一个：维修 > 在用 > 待清 > 已预订 > 空闲。
 * 维修的房间不该有人用（设维修时核对过），真有（两台终端同时操作）也照维修显示，提醒先处理；
 * 用着的房间不算待清（退房、下钟以后才是）；待清的房间今天有预订照样先显示待清——清洁完成之前不能开。
 */
export function roomStatusOf(f: { maintenance: boolean; inUse: boolean; dirty: boolean; booked: boolean }): RoomStatus {
  if (f.maintenance) return 'maintenance';
  if (f.inUse) return 'in_use';
  if (f.dirty) return 'dirty';
  return f.booked ? 'booked' : 'free';
}

export const ROOM_SOURCES = ['service', 'party', 'hotel', 'hall'] as const;
export type RoomSource = (typeof ROOM_SOURCES)[number];
export const ROOM_SOURCE_LABELS: Record<RoomSource, string> = {
  service: '技师服务的房间',
  party: '开单即占用的房间',
  hotel: '客房',
  hall: '大厅类',
};
export const ROOM_SOURCE_HINTS: Record<RoomSource, string> = {
  service: '点卡片登记手牌、项目与技师；之后换房、续钟、退房',
  party: '点卡片开单（使用单），结束时按时长计费',
  hotel: '照客房的入住单：入住、续住、换房、退房',
  hall: '没有业务单据，只标待清、维修',
};

/**
 * 一个空间按它的业态算哪一类（卡片能做什么跟着这个走，房型上选的「来源」保存时核对过与它一致）：
 * 「客房」是客房；技师服务类业态是技师服务的房间；后台设成「开单即占用」的业态是派对房一类；其余是大厅类。
 */
export function roomKindOf(businessType: string, usageTypes: readonly string[]): RoomSource {
  if (businessType === ROOM_BUSINESS_TYPE) return 'hotel';
  if (isTechnicianBusinessType(businessType)) return 'service';
  return usageTypes.includes(businessType) ? 'party' : 'hall';
}

/** 房型上选的来源与它管的业态对不对得上：对不上返回原因（保存时用，页面上也先提示） */
export function categoryProblem(source: RoomSource, businessTypes: readonly string[]): string | null {
  if (businessTypes.length === 0) return '请至少选一种业态';
  if (source === 'hotel') return businessTypes.length === 1 && businessTypes[0] === ROOM_BUSINESS_TYPE ? null : `「客房」这一类只管空间台账里的「${ROOM_BUSINESS_TYPE}」业态`;
  if (businessTypes.includes(ROOM_BUSINESS_TYPE)) return `「${ROOM_BUSINESS_TYPE}」业态按入住单算占用，只能放在来源是「客房」的房型里`;
  const tech = businessTypes.filter(isTechnicianBusinessType);
  if (source === 'service') {
    const rest = businessTypes.filter((t) => !isTechnicianBusinessType(t));
    return rest.length ? `「${rest.join('」「')}」不是技师服务类的业态，不能放在「技师服务的房间」里` : null;
  }
  return tech.length ? `「${tech.join('」「')}」是技师服务类的业态，要放在来源是「技师服务的房间」的房型里` : null;
}

export const MAX_CATEGORY_NAME = 12;
export const MAX_CATEGORY_TYPES = 20;

/** 默认的房型（迁移 190 给每家店建了一份；一家店一条都没有时后台可以按这份重建） */
export const DEFAULT_ROOM_CATEGORIES: { name: string; source: RoomSource; businessTypes: string[]; sortOrder: number }[] = [
  { name: '按摩房', source: 'service', businessTypes: ['按摩', '踩背', '头疗'], sortOrder: 10 },
  { name: '足浴房', source: 'service', businessTypes: ['足浴', '投影足浴'], sortOrder: 20 },
  { name: 'SPA 房', source: 'service', businessTypes: ['SPA'], sortOrder: 30 },
  { name: '休息大厅', source: 'hall', businessTypes: ['休息大厅', '休息区', '休息厅'], sortOrder: 40 },
  { name: '宠物轰趴房', source: 'party', businessTypes: ['宠物轰趴房'], sortOrder: 50 },
  { name: '派对房', source: 'party', businessTypes: ['派对房', '娱乐室'], sortOrder: 60 },
  { name: '客房', source: 'hotel', businessTypes: ['客房'], sortOrder: 70 },
];

/** 没归到任何房型的空间放在这一个页签里（不会因为房型没配到就看不到） */
export const OTHER_CATEGORY_KEY = 'other';
export const OTHER_CATEGORY_NAME = '其他';

export interface RoomCategory {
  id: number;
  name: string;
  source: RoomSource;
  businessTypes: string[];
  sortOrder: number;
  active: boolean;
  /** 版本号：修改时原样带回，对不上（刚被改过）就拒绝 */
  version: number;
}

export interface RoomCategoriesAdmin {
  categories: RoomCategory[];
  /** 空间台账里用到的业态与每种有几间在用的空间 */
  businessTypes: { type: string; spaces: number }[];
  /** 后台设成「开单即占用」的业态（派对房一类） */
  usageTypes: string[];
  /** 有空间、却没归到任何在用房型的业态（房态中心里放在「其他」） */
  unmapped: string[];
}

export interface RoomCounts {
  total: number;
  free: number;
  inUse: number;
  dirty: number;
  maintenance: number;
  booked: number;
}
export const EMPTY_ROOM_COUNTS: RoomCounts = { total: 0, free: 0, inUse: 0, dirty: 0, maintenance: 0, booked: 0 };
/** 状态 → 数量里的哪一项 */
export const ROOM_COUNT_KEY: Record<RoomStatus, keyof RoomCounts> = { free: 'free', in_use: 'inUse', dirty: 'dirty', maintenance: 'maintenance', booked: 'booked' };

export interface RoomCategoryView {
  /** 页签的键：房型是 c<编号>，没归类的是 other */
  key: string;
  id: number | null;
  name: string;
  source: RoomSource;
  counts: RoomCounts;
  /** 页签顶上的一句说明（客房功能没开、今天几张客房预约还没到店……）；没有为空 */
  hint: string | null;
}

/** 房间里的一张钟单（待上钟、上钟中，或这次登记里已经下钟的） */
export interface RoomSessionView {
  id: number;
  sessionNo: string;
  visitId: number;
  technicianId: number;
  techNo: string;
  techName: string;
  itemId: number;
  itemName: string;
  callType: CallType;
  clocks: number;
  minutes: number;
  status: 'waiting' | 'serving' | 'done';
  startedAt: string | null;
  /** 计划下钟时刻（上钟后才有） */
  plannedEnd: string | null;
  endedAt: string | null;
  /** 这张钟单有效明细的合计（分） */
  amount: number;
  /** 每钟的单价（续钟按它算；没有有效明细为 null） */
  unitPrice: number | null;
}

/** 房间里的一位客人 */
export interface RoomGuestView {
  /** 登记单；钟房直接把钟派进这间房、没经房态中心登记的为 null（钟做完房间就转待清，不用退房） */
  registrationId: number | null;
  visitId: number;
  tagCode: string;
  /** 会员名或称呼；没有查看客人的权限时只有手牌号 */
  guest: string;
  /** 会员的档阶（「L3 观澜」）；散客、没定档的为 null */
  memberGradeLabel: string | null;
  sellerNo: string;
  sellerName: string;
  note: string;
  /** 登记的时刻（没有登记单的是钟单建的时刻） */
  since: string;
  sessions: RoomSessionView[];
  /** 这次登记里几张钟单的金额合计 */
  amount: number;
  /** 这位客人手牌账单此刻的合计（都还没结；退房前预览用） */
  billAmount: number;
}

export interface RoomMaintenance {
  reason: string;
  /** 预计完成时间 */
  expectedAt: string;
  at: string;
  byName: string;
}

export interface RoomBookingView {
  id: number;
  bookingNo: string;
  guest: string;
  guests: number;
  startsAt: string;
  endsAt: string;
}

export interface RoomCard {
  /** s<空间编号>；客房是 r<房间编号>（客房的卡片来自客房的房态看板） */
  key: string;
  categoryKey: string;
  kind: RoomSource;
  /** 空间台账里的空间；没挂空间的客房房间为 null */
  spaceId: number | null;
  /** 房号（空间编码；客房是房号） */
  code: string;
  /** 显示名（品牌名） */
  name: string;
  floor: string;
  businessType: string;
  capacity: number | null;
  status: RoomStatus;
  /** 房态行的版本号：改状态、换房、退房、并房时带上看到的这个，对不上（刚被别人动过）就拒绝；客房不用 */
  version: number;
  /** 技师服务的房间里的客人（先登记的在前） */
  guests: RoomGuestView[];
  /** 派对房等开着的使用单 */
  usage: UsageDetail | null;
  /** 这个业态设了计费（派对房等；没设的结束不收房费） */
  usagePriced: boolean;
  /** 客房：房态看板上的那一间（入住、入住单、改房态的对话框直接用它） */
  hotel: RoomBoardRoom | null;
  maintenance: RoomMaintenance | null;
  /** 从什么时候起待清；不是待清为 null */
  dirtySince: string | null;
  dirtyNote: string;
  /** 今天订了这间、还没到店的预约（最早的一张） */
  booking: RoomBookingView | null;
  /** 并房：一起的几间（含自己；第一间是主房）；没并房为空 */
  merged: { spaceId: number; code: string }[];
  /** 卡片上的四样：客人、技师、从什么时候起算已用时长、金额（没人用为 null） */
  guestText: string | null;
  techText: string | null;
  since: string | null;
  amount: number | null;
  /** 在用时的小状态：待上钟 / 服务中 / 已下钟（待退房）；别的为 null */
  phase: 'waiting' | 'serving' | 'done' | null;
  /** 服务中的计划下钟时刻（几张钟里最晚的） */
  plannedEnd: string | null;
}

export interface RoomCenterBoard {
  serverTime: string;
  businessDate: string;
  categories: RoomCategoryView[];
  /** 全部房型合起来的数量（总览用） */
  total: RoomCounts;
  rooms: RoomCard[];
}

export const ROOM_EVENT_KINDS = ['register', 'move_out', 'move_in', 'checkout', 'extend', 'merge', 'unmerge', 'dirty', 'cleaned', 'maintenance', 'restore'] as const;
export type RoomEventKind = (typeof ROOM_EVENT_KINDS)[number];
export const ROOM_EVENT_LABELS: Record<RoomEventKind, string> = {
  register: '登记',
  move_out: '换房（换出）',
  move_in: '换房（换入）',
  checkout: '退房',
  extend: '续钟',
  merge: '并房',
  unmerge: '拆并',
  dirty: '标为待清',
  cleaned: '清洁完成',
  maintenance: '维修',
  restore: '恢复',
};

/**
 * 房间动作（换房、退房、并房、拆并、维修、恢复、标待清、清洁完成）带的操作编号记下的那一条房间事件（8.1.16）：
 * 「结果待确认」时按编号查回的就是它（页面查回以后重新取看板）
 */
export interface RoomActionResult {
  eventId: number;
  spaceId: number;
  kind: RoomEventKind;
  at: string;
  replayed: boolean;
}

/** 房间历史的一行：房态中心自己的事件，加上这间房里的钟单（派钟、上钟、下钟）与使用单（开单、结束），按时间倒排 */
export interface RoomHistoryRow {
  /** 事件是 e<编号>，钟单、使用单推出来的各有前缀（只用来当列表的 key） */
  key: string;
  at: string;
  /** 「登记」「换房（换入）」「上钟」「结束使用」…… */
  label: string;
  text: string;
  staffName: string;
  /** 记在房态中心事件里的才有（用来着色） */
  kind: RoomEventKind | null;
}

export interface RoomHistory {
  spaceId: number;
  code: string;
  name: string;
  rows: RoomHistoryRow[];
}

/** 登记表单的选项之外，另两样要问服务端的：手牌上的客人、出单员的工号 */
export interface RoomGuestLookup {
  visitId: number;
  tagCode: string;
  zone: 'male' | 'female' | 'child';
  guest: string;
  memberGradeLabel: string | null;
  billAmount: number;
  /** 这位客人已经登记在哪间房（要先退房或换房）；没有为 null */
  registeredIn: string | null;
}

export interface RoomSellerLookup {
  no: string;
  name: string;
}

/** 退房前的预览：这间房里每位客人的账（都挂在手牌上，离店时在收银台结） */
export interface RoomCheckoutPreview {
  spaceId: number;
  code: string;
  version: number;
  guests: {
    registrationId: number;
    visitId: number;
    tagCode: string;
    guest: string;
    /** 这次登记里的钟单明细合计 */
    roomAmount: number;
    /** 手牌账单此刻的合计（没结） */
    billAmount: number;
    lines: { name: string; quantity: number; amount: number; technician: string | null }[];
    /** 还没下钟的钟单（要先下钟或取消派钟才能退房） */
    running: { sessionId: number; sessionNo: string; techNo: string; techName: string; status: 'waiting' | 'serving' }[];
  }[];
  /** 几位客人手牌账单的合计（退房时带回来核对：看过预览以后账又变了要重新看） */
  unpaidTotal: number;
}

export const MAX_ROOM_NOTE = 100;
export const MAX_MAINTENANCE_REASON = 100;
export const MAX_SELLER_NO = 32;
/** 开始时间可以补记到多久以前（分钟）：客人已经做了一会儿才来登记 */
export const MAX_START_BACKDATE_MINUTES = 120;
/** 预计完成时间最远到多少天以后 */
export const MAX_MAINTENANCE_DAYS = 365;

export type RoomStartMode = 'now' | 'at' | 'later';
export const ROOM_START_LABELS: Record<RoomStartMode, string> = { now: '现在开始', at: '已经开始了', later: '稍后上钟' };

/** 已用时长：「35 分」「1 小时 20 分」 */
export function elapsedText(sinceIso: string, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs - new Date(sinceIso).getTime()) / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} 小时${m ? ` ${m} 分` : ''}` : `${m} 分`;
}
