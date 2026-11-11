// 8.0.9 安保巡场（docs/PATROL_V809.md）：员工端（柚子饭堂「工作台 → 巡场」）与后台（ERP「员工工作台 → 安保巡场」）共用的格式与数据。
// 8.0.11 巡场轮次（店主 2026-11-11，docs/PATROL_V809.md 第 11 节）：营业日按巡场间隔分成几轮，同一个场所每轮只记一次打卡。

import { businessDayStart } from './business-date';

/** 场所码：12 位 base32（大写字母与 2–7），随机生成；印在二维码里 */
export const PATROL_TOKEN_LENGTH = 12;
export const PATROL_TOKEN_PATTERN = /^[A-Z2-7]{12}$/;
export const MAX_PATROL_POINT_NAME = 20;
export const MAX_PATROL_POINT_AREA = 40;
/** 巡场间隔（XC13）：默认 3 小时一轮；可以设 30 分钟到 24 小时，按半小时调 */
export const PATROL_ROUND_DEFAULT_MINUTES = 180;
export const PATROL_ROUND_MIN_MINUTES = 30;
export const PATROL_ROUND_MAX_MINUTES = 1440;
export const PATROL_ROUND_STEP_MINUTES = 30;
/** 扫到与入库差这么多分钟以上的标「离线补登」（XC7） */
export const PATROL_LATE_MINUTES = 2;
/** 只收这么多小时内扫到的（断网补交，XC7） */
export const PATROL_MAX_LATE_HOURS = 24;
/** 记录一次最多查多少天、手机上最多看多少天以前（XC2） */
export const PATROL_MAX_DAYS = 92;
export const MAX_PATROL_VOID_REASON = 100;

export const PATROL_VIAS = ['scan', 'link', 'photo'] as const;
export type PatrolVia = (typeof PATROL_VIAS)[number];
export const PATROL_VIA_LABELS: Record<PatrolVia, string> = { scan: '工作台扫码', link: '直接扫码', photo: '拍照识别' };

/** 二维码里的地址：员工入口地址 + #patrol=场所码（用手机相机、微信直接扫开就是柚子饭堂的巡场页） */
export function patrolLink(portalUrl: string, token: string): string {
  return `${portalUrl.replace(/\/+$/, '')}/#patrol=${token}`;
}

/**
 * 从扫到的文字里认出场所码：整个地址（…#patrol=码，也认 #/patrol=码）或单独的码。
 * 不是巡场码的返回 null（例如扫到了饭卡码、别的网址）。
 */
export function parsePatrolToken(text: string): string | null {
  const t = text.trim();
  const m = /#\/?patrol[=/]([A-Za-z2-7]{12})(?:$|[&?#/])/.exec(t);
  const raw = m ? m[1]! : t;
  const token = raw.toUpperCase();
  return PATROL_TOKEN_PATTERN.test(token) ? token : null;
}

// ── 巡场轮次（XC13–XC15） ──

/** 巡场间隔从哪个营业日起是多少分钟（改间隔时记一条，从改的那个营业日起按新的分轮） */
export interface PatrolRoundChange {
  from: string;
  minutes: number;
}

/** 某个营业日用的巡场间隔：最后一条不晚于这一天的；一条都没有用默认的 3 小时 */
export function patrolRoundMinutesOn(changes: readonly PatrolRoundChange[], date: string): number {
  let minutes = PATROL_ROUND_DEFAULT_MINUTES;
  let best = '';
  for (const c of changes) if (c.from <= date && c.from >= best) [best, minutes] = [c.from, c.minutes];
  return minutes;
}

export interface PatrolRoundSpan {
  /** 第几轮（从 1 起） */
  no: number;
  start: string;
  end: string;
}

/**
 * 一个营业日的各轮：从营业日切换时间起，每 minutes 分钟一轮；最后一轮到下一个营业日开始为止（间隔除不尽 24 小时时最后一轮短一些）。
 */
export function patrolRoundsOf(date: string, timeZone: string, startHour: number, minutes: number): PatrolRoundSpan[] {
  const start = businessDayStart(date, timeZone, startHour).getTime();
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  const end = businessDayStart(next, timeZone, startHour).getTime();
  const step = minutes * 60_000;
  const rounds: PatrolRoundSpan[] = [];
  for (let t = start, no = 1; t < end; t += step, no += 1) {
    rounds.push({ no, start: new Date(t).toISOString(), end: new Date(Math.min(t + step, end)).toISOString() });
  }
  return rounds;
}

/** 某一刻在这一天的第几轮（不在这一天里返回 null） */
export function patrolRoundAt(rounds: readonly PatrolRoundSpan[], at: Date | string): PatrolRoundSpan | null {
  const t = new Date(at).getTime();
  return rounds.find((r) => t >= Date.parse(r.start) && t < Date.parse(r.end)) ?? null;
}

/** 「3 小时」「1.5 小时」「30 分钟」 */
export function patrolIntervalText(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Number((minutes / 60).toFixed(1))} 小时`;
}

// ── 后台 ──

export interface PatrolPoint {
  id: number;
  name: string;
  area: string;
  token: string;
  active: boolean;
  sortOrder: number;
  version: number;
  createdAt: string;
  tokenChangedAt: string | null;
  /** 今天（营业日）巡了几次 */
  todayCount: number;
}

/** 巡场记录筛选用的场所（含停用的、不含场所码；有「看记录」权限就能取，Codex 审查 41a2fbb） */
export interface PatrolPointOption {
  id: number;
  name: string;
  area: string;
  active: boolean;
}

export interface PatrolPointsAdmin {
  points: PatrolPoint[];
  /** 员工入口地址（「员工食堂 → 设置」里填的）：打印二维码用；没填为空 */
  portalUrl: string;
  today: string;
}

export interface PatrolSettings {
  /** 巡场部门（XC1） */
  departmentIds: number[];
  /** 手机上能看巡场记录的员工（柚子饭堂的员工账号，XC2） */
  viewerIds: number[];
  /** 现在（今天起）的巡场间隔，分钟（XC13） */
  roundMinutes: number;
  /** 巡场间隔改过的记录：过去的营业日按当时的间隔分轮 */
  roundChanges: PatrolRoundChange[];
  /** 版本号：两个人同时改，后保存的拒绝 */
  rev: number;
}

export interface PatrolSettingsAdmin extends PatrolSettings {
  departments: { id: number; name: string; active: boolean }[];
  employees: { id: number; empNo: string; name: string; department: string; active: boolean }[];
  /** 现在巡场部门里有几位启用的员工 */
  patrolStaffCount: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface PatrolCheckinRow {
  id: number;
  pointId: number;
  pointName: string;
  employeeId: number;
  empNo: string;
  name: string;
  department: string;
  businessDate: string;
  scannedAt: string;
  recordedAt: string;
  via: PatrolVia;
  /** 离线补登：扫到与入库差 2 分钟以上 */
  late: boolean;
  /** 扫到的时间在这一天的第几轮（按这一天的巡场间隔） */
  roundNo: number | null;
  voidedAt: string | null;
  voidReason: string | null;
  voidedByName: string | null;
}

export interface PatrolScan {
  id: number;
  at: string;
  employeeId: number;
  name: string;
  empNo: string;
  via: PatrolVia;
  late: boolean;
}

/** 一轮：过去的（已经结束）、正在巡的这一轮、还没到的 */
export interface PatrolRound extends PatrolRoundSpan {
  state: 'past' | 'current' | 'future';
  /** 这一轮要巡的场所数（这一轮结束前建的启用场所，加上这一轮巡过的停用场所） */
  expected: number;
  /** 这一轮巡过的场所数 */
  done: number;
}

/** 一天的巡场清单（后台「今天」与手机「巡场记录」共用） */
export interface PatrolDay {
  date: string;
  today: string;
  /** 这一天的巡场间隔（分钟） */
  roundMinutes: number;
  rounds: PatrolRound[];
  /** 今天正在巡的是第几轮（看的不是今天时为 null） */
  currentRound: number | null;
  points: {
    id: number;
    name: string;
    area: string;
    active: boolean;
    count: number;
    /** 这一天巡过的（没作废的，按时间） */
    scans: PatrolScan[];
    /** 每一轮的打卡（与 rounds 一一对应）：null 是这一轮不用巡（那时还没建这个场所，或停用了、这一轮也没人巡） */
    byRound: (PatrolScan[] | null)[];
  }[];
  /** 这一天巡场的人与次数 */
  people: { employeeId: number; name: string; empNo: string; count: number }[];
  total: number;
  /** 已经结束的各轮里漏巡的（场所 × 轮）个数 */
  missed: number;
  /** 正在巡的这一轮还没巡的场所数（看的不是今天时为 null） */
  currentMissing: number | null;
}

export interface PatrolRecords {
  rows: PatrolCheckinRow[];
  /** 没作废的条数 */
  total: number;
  voided: number;
}

// ── 员工端（柚子饭堂） ──

/** 员工端工作台里的应用（巡场相关的由门店系统按部门、名单算，食堂的按角色在手机上算） */
export const PATROL_APPS = ['patrol', 'patrolLog'] as const;
export type PatrolApp = (typeof PATROL_APPS)[number];

export interface PatrolCheckinResult {
  /** ok：记上了；already：这个场所这一轮已经有人打过卡（XC14），不另记 */
  status: 'ok' | 'already';
  /** status 为 already 时是这一轮之前打的那一笔（可能是别人打的） */
  checkin: { id: number; pointName: string; area: string; at: string; late: boolean; employeeName: string; mine: boolean };
  /** 这一笔落在这一天的第几轮 */
  round: PatrolRoundSpan | null;
  /** 今天（营业日）这个场所一共巡了几次 */
  pointCount: number;
}

/** 员工端「今天」：巡场部门的人看今天，能看记录的人可以看任何一天 */
export interface PatrolPortalDay extends PatrolDay {
  /** 这位员工这一天巡了几次 */
  mine: number;
  canViewHistory: boolean;
}
