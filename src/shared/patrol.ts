// 8.0.9 安保巡场（docs/PATROL_V809.md）：员工端（柚子饭堂「工作台 → 巡场」）与后台（ERP「员工工作台 → 安保巡场」）共用的格式与数据。

/** 场所码：12 位 base32（大写字母与 2–7），随机生成；印在二维码里 */
export const PATROL_TOKEN_LENGTH = 12;
export const PATROL_TOKEN_PATTERN = /^[A-Z2-7]{12}$/;
export const MAX_PATROL_POINT_NAME = 20;
export const MAX_PATROL_POINT_AREA = 40;
/** 同一个人这么多分钟内重复扫同一个码只记一次（XC5） */
export const PATROL_DEDUP_MINUTES = 2;
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
  voidedAt: string | null;
  voidReason: string | null;
  voidedByName: string | null;
}

/** 一天的巡场清单（后台「今天」与手机「巡场记录」共用） */
export interface PatrolDay {
  date: string;
  today: string;
  points: {
    id: number;
    name: string;
    area: string;
    active: boolean;
    count: number;
    /** 这一天巡过的（没作废的，按时间） */
    scans: { id: number; at: string; employeeId: number; name: string; empNo: string; via: PatrolVia; late: boolean }[];
  }[];
  /** 这一天巡场的人与次数 */
  people: { employeeId: number; name: string; empNo: string; count: number }[];
  total: number;
  /** 启用的场所里这一天还没人巡的个数 */
  missing: number;
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
  status: 'ok' | 'already';
  checkin: { id: number; pointName: string; area: string; at: string; late: boolean };
  /** 今天（营业日）这个场所一共巡了几次 */
  pointCount: number;
}

/** 员工端「今天」：巡场部门的人看今天，能看记录的人可以看任何一天 */
export interface PatrolPortalDay extends PatrolDay {
  /** 这位员工这一天巡了几次 */
  mine: number;
  canViewHistory: boolean;
}
