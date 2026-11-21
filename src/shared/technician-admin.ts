// 技师管理与排位播报（8.1.15，docs/TECHNICIANS_V8115.md；《浴族系统需求汇总》技师 1–3）：
//   · 技师管理（门店页面）：名册（花名、类型、入职时间）、组别（分组与组长）、班次（班次、排班表、临时调班）、休假（申请、审批）；
//   · 钟房的搜索与筛选（姓名、工号、花名、拼音首字母；类型、可做项目；按状态排）；
//   · 排位播报：叫号记录、主播报终端。
// 没写细的默认做法都标「待确认」（docs/TECHNICIANS_V8115.md 第 10 节，JS1–JS18）。

import { matchesQuery } from './pinyin-initials';
import type { Technician } from './technicians';

/** 技师类型的默认清单（待确认）：技师管理的名册页签里可以改 */
export const DEFAULT_TECH_KINDS: readonly string[] = ['足浴', '按摩', 'SPA', '采耳', '其他'];
export const MAX_TECH_KIND = 12;
export const MAX_TECH_KINDS = 20;

/** 技师的称呼：有花名用花名，没有用名字 */
export const techCallName = (t: { name: string; nickname: string }) => t.nickname || t.name;

/** 搜索：姓名、花名、工号，以及姓名、花名的拼音首字母。query 传归一过的（normalizeQuery） */
export const matchesTechnician = (query: string, t: Pick<Technician, 'name' | 'nickname' | 'techNo'>) => matchesQuery(query, [t.name, t.nickname, t.techNo]);

/** 这位技师做不做这一类项目：可做分类为空表示全部 */
export const servesCategory = (t: Pick<Technician, 'skills'>, category: string) => t.skills.length === 0 || t.skills.includes(category);

// ───────────────────────── 组别 ─────────────────────────

export const MAX_GROUP_NAME = 16;

export interface TechGroup {
  id: number;
  name: string;
  /** 组长（组里的一位技师）；没有为 null */
  leaderId: number | null;
  sortOrder: number;
  active: boolean;
  note: string;
  memberIds: number[];
}

// ───────────────────────── 班次与排班 ─────────────────────────

export const MAX_SHIFT_NAME = 12;

export interface TechShift {
  id: number;
  name: string;
  /** 当天的第几分钟（0–1439）；结束不晚于开始表示做到第二天 */
  startMinute: number;
  endMinute: number;
  sortOrder: number;
  active: boolean;
}

const hhmm = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

/** 「10:00–18:00」「18:00–次日 02:00」 */
export const shiftTimeText = (s: Pick<TechShift, 'startMinute' | 'endMinute'>) => `${hhmm(s.startMinute)}–${s.endMinute <= s.startMinute ? '次日 ' : ''}${hhmm(s.endMinute)}`;

/** 「HH:MM」→ 第几分钟；格式不对返回 null */
export function parseClock(text: string): number | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
export const clockText = hhmm;

/** 排班表的一格：shiftId 有值 = 上这个班；rest = 排休；都没有 = 没排 */
export interface ScheduleCell {
  technicianId: number;
  date: string;
  shiftId: number | null;
  rest: boolean;
}

export const SCHEDULE_CHANGE_KINDS = ['plan', 'adjust', 'swap'] as const;
export type ScheduleChangeKind = (typeof SCHEDULE_CHANGE_KINDS)[number];
export const SCHEDULE_CHANGE_LABELS: Record<ScheduleChangeKind, string> = { plan: '排班', adjust: '临时调班', swap: '对调' };

export interface ScheduleChange {
  id: number;
  at: string;
  kind: ScheduleChangeKind;
  technicianId: number;
  techNo: string;
  techName: string;
  date: string;
  /** 「早班」「排休」「没排」 */
  from: string;
  to: string;
  swapWith: string | null;
  reason: string;
  staffName: string;
}

/** 排班表最多一次排多少天（待确认） */
export const SCHEDULE_MAX_DAYS = 31;
/** 最远能排到今天之后多少天（待确认） */
export const SCHEDULE_AHEAD_DAYS = 92;

export interface ScheduleView {
  from: string;
  days: number;
  /** 当前营业日：今天已经排了的格子只能走临时调班（要写原因），以前的不能改 */
  today: string;
  cells: ScheduleCell[];
  /** 这几天里的休假（待审批、已批准）：排班表上标出来 */
  leaves: { technicianId: number; fromDate: string; toDate: string; status: 'pending' | 'approved' }[];
  /** 这几天最近的改动（最多 50 条，新的在前） */
  changes: ScheduleChange[];
}

// ───────────────────────── 休假 ─────────────────────────

export const LEAVE_TYPES = ['personal', 'sick', 'rest', 'annual', 'other'] as const;
export type LeaveType = (typeof LEAVE_TYPES)[number];
export const LEAVE_TYPE_LABELS: Record<LeaveType, string> = { personal: '事假', sick: '病假', rest: '调休', annual: '年假', other: '其他' };

export const LEAVE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];
export const LEAVE_STATUS_LABELS: Record<LeaveStatus, string> = { pending: '待审批', approved: '已批准', rejected: '已驳回', cancelled: '已取消' };

/** 一张休假单最多请多少天（含头尾，待确认） */
export const LEAVE_MAX_DAYS = 31;
/** 最远能请到今天之后多少天开始（待确认） */
export const LEAVE_AHEAD_DAYS = 92;

export interface TechLeave {
  id: number;
  technicianId: number;
  techNo: string;
  techName: string;
  nickname: string;
  fromDate: string;
  toDate: string;
  /** 请几天（含头尾） */
  days: number;
  leaveType: LeaveType;
  reason: string;
  status: LeaveStatus;
  appliedByName: string;
  appliedAt: string;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string;
  cancelledByName: string | null;
  cancelledAt: string | null;
  cancelReason: string;
}

export const leaveRangeText = (l: { fromDate: string; toDate: string }) => (l.fromDate === l.toDate ? l.fromDate : `${l.fromDate} 至 ${l.toDate}`);

// ───────────────────────── 技师管理页 ─────────────────────────

export interface RosterTechnician extends Technician {
  groupName: string | null;
  /** 今天排的班（没排、排休为 null） */
  shiftToday: Pick<TechShift, 'id' | 'name' | 'startMinute' | 'endMinute'> | null;
  restToday: boolean;
  /** 今天在已批准的休假里 */
  leaveToday: { id: number; fromDate: string; toDate: string; leaveType: LeaveType } | null;
}

export interface TechnicianAdminView {
  businessDate: string;
  /** 能不能改（有「维护技师名册」权限）；只有钟房权限的只能看、能替技师申请休假 */
  canManage: boolean;
  kinds: string[];
  /** 项目分类（技师可做的分类从这里选） */
  categories: string[];
  technicians: RosterTechnician[];
  groups: TechGroup[];
  shifts: TechShift[];
  pendingLeaves: number;
}

// ───────────────────────── 排位播报 ─────────────────────────

export const CALL_KINDS = ['dispatch', 'manual'] as const;
export type CallKind = (typeof CALL_KINDS)[number];
export const CALL_KIND_LABELS: Record<CallKind, string> = { dispatch: '自动叫号', manual: '手动叫号' };

/** 一次叫号：text 是当时念的那一句 */
export interface ClockCall {
  id: number;
  at: string;
  kind: CallKind;
  technicianId: number;
  sessionId: number | null;
  text: string;
  staffName: string;
}

/** 主播报终端：哪个浏览器在念。没有登记为 null */
export interface AnnouncerClaim {
  clientId: string;
  /** 那台终端的名字（设备页选的本机终端，没选就是「浏览器 ××××」） */
  label: string;
  claimedByName: string;
  claimedAt: string;
  /** 那台终端最近一次报到（开着钟房每半分钟报一次） */
  seenAt: string;
}

/** 主播报终端多久没报到算「不在线」（毫秒）：别的终端上提示可以接管 */
export const ANNOUNCER_STALE_MS = 90_000;
/** 看板带最近多久的叫号（毫秒）；主播报终端只念这段时间里新来的 */
export const CALL_WINDOW_MS = 10 * 60_000;
/** 叫号过了多久就不再补念（毫秒）：页面在后台停了一阵再回来，不把旧的都念一遍 */
export const CALL_SPEAK_WITHIN_MS = 90_000;

/**
 * 念的那一句：「请 3 号排位，18 号 小雅，到 201 房」。
 * 排位号是这位技师在轮钟队列里的位置（不在队列里的不念）；有花名念花名，没有念名字；知道房间的念房间，不知道的念「准备上钟」。
 */
export function announceText(c: { position: number | null; techNo: string; name: string; nickname: string; room: string | null }): string {
  return `请${c.position ? ` ${c.position} 号排位，` : ' '}${c.techNo} 号 ${techCallName(c)}，${c.room ? `到 ${c.room}` : '准备上钟'}`;
}

const DIGITS = '零一二三四五六七八九';

/**
 * 交给朗读引擎的写法：三位以上的数字一位一位念（房号「201」念「二零一」，不念「二百零一」）；两位以内的（排位号、工号）照常念。
 * 页面上显示的还是原来那一句。
 */
export const spokenText = (text: string) => text.replace(/\d{3,}/g, (run) => [...run].map((d) => DIGITS[Number(d)]).join(''));
