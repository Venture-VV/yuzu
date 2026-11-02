// 第一级实时位置（飞书需求 RQ-004，v0.7.17，见 docs/ROOMMAP.md 第 3 节）：业务推导定位——刷卡点刷卡与业务动作推出
// 客人在哪个区、技师在哪间房；不加硬件，精度到区域与房间。表结构按第二级精确定位预留（坐标、精度、设备编号），第二级只换数据源。

export const LOCATION_SOURCES = [
  'reader',
  'position',
  'checkin',
  'consume',
  'room_checkin',
  'room_move',
  'room_close',
  'session_start',
  'session_room',
  'session_end',
  'sign_in',
  'sign_out',
  'checkout',
  'visit_cancel',
] as const;
export type LocationSource = (typeof LOCATION_SOURCES)[number];

export const LOCATION_SOURCE_LABELS: Record<LocationSource, string> = {
  reader: '刷卡',
  position: '定位上报',
  checkin: '发手牌',
  consume: '消费',
  room_checkin: '开房',
  room_move: '换房',
  room_close: '退房',
  session_start: '上钟',
  session_room: '换房间',
  session_end: '下钟',
  sign_in: '技师上牌',
  sign_out: '技师下牌',
  checkout: '结账离场',
  visit_cancel: '撤销来访',
};

/** 事件：在某处 / 离开某处（去向不明）/ 离店（客人结账、撤销来访；技师下牌） */
export const LOCATION_EVENT_KINDS = ['at', 'left', 'gone'] as const;
export type LocationEventKind = (typeof LOCATION_EVENT_KINDS)[number];
export const LOCATION_EVENT_KIND_LABELS: Record<LocationEventKind, string> = { at: '在', left: '离开', gone: '离店' };

/** 上报接口的数据来源：刷卡点（第一级）/ 定位上报（第二级预留：UWB、蓝牙信标的网关直接报空间或区域，可带坐标） */
export const REPORT_SOURCES = ['reader', 'position'] as const;
export type ReportSource = (typeof REPORT_SOURCES)[number];

export interface LocationRules {
  /** 开关：关着时不推导、刷卡上报拒绝；离开、离店照样清掉已有的位置 */
  enabled: boolean;
  /** 接待区：发手牌后客人在哪（没选不推导） */
  checkinZoneId: number | null;
  /** 技师休息区：技师上牌、下钟后在哪（没选的位置不明） */
  restZoneId: number | null;
}

export const DEFAULT_LOCATION_RULES: LocationRules = { enabled: false, checkinZoneId: null, restZoneId: null };

/** 刷卡上报的时间窗：不能早于 24 小时，不能晚于服务器 2 分钟 */
export const REPORT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const REPORT_MAX_SKEW_MS = 2 * 60 * 1000;

/** 刷卡点编号：读卡器上贴的号或设备序列号 */
export const READER_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{0,23}$/;

/** 地方：楼层，加上区域或空间 */
export interface LocationPlace {
  floorId: number;
  floorCode: string;
  floorName: string;
  zoneId: number | null;
  zoneName: string | null;
  spaceId: number | null;
  spaceCode: string | null;
  spaceName: string | null;
}

/** 「在店」：区域 · 空间，例如「足浴区 · C301 足浴房」 */
export function placeText(p: Pick<LocationPlace, 'floorName' | 'zoneName' | 'spaceCode' | 'spaceName'> | null): string {
  if (!p) return '位置不明';
  const space = p.spaceCode ? `${p.spaceCode}${p.spaceName && p.spaceName !== p.spaceCode ? ` ${p.spaceName}` : ''}` : '';
  return [p.floorName, p.zoneName, space].filter(Boolean).join(' · ');
}

export interface LocationReader {
  id: number;
  code: string;
  name: string;
  zoneId: number | null;
  spaceId: number | null;
  /** 装在哪（台账里停用了也照样显示） */
  place: LocationPlace;
  /** 装的区域或空间已停用：这个刷卡点刷卡会被拒绝 */
  placeInactive: boolean;
  note: string;
  active: boolean;
  version: number;
  /** 最近一次刷卡 */
  lastAt: string | null;
}

export interface LocationItem {
  id: number;
  name: string;
  category: string;
  active: boolean;
  zoneId: number | null;
}

export interface LocationZone {
  id: number;
  floorCode: string;
  floorName: string;
  name: string;
  active: boolean;
}

export interface LocationAdmin {
  rules: LocationRules;
  readers: LocationReader[];
  zones: LocationZone[];
  items: LocationItem[];
}

/** 平面图上的一个人：在店客人（手牌号）或在岗技师（工号与姓名）；不带会员姓名、手机号 */
export interface LocationPerson extends LocationPlace {
  kind: 'guest' | 'technician';
  /** 客人为来访 id，技师为技师 id */
  id: number;
  tagCode: string | null;
  techNo: string | null;
  techName: string | null;
  /** 进入这里的时刻 */
  since: string;
  /** 最近一次动作 */
  lastAt: string;
  lastSource: LocationSource;
}

export interface LocationsCurrent {
  serverTime: string;
  enabled: boolean;
  people: LocationPerson[];
  /** 在店客人（有位置的 + 位置不明的） */
  guestsInStore: number;
  /** 在岗技师（上了牌、没下牌，含休息） */
  techniciansOnDuty: number;
}

export interface LocationTrackSegment extends LocationPlace {
  id: number;
  enteredAt: string;
  lastAt: string;
  leftAt: string | null;
  eventCount: number;
  enterSource: LocationSource;
  endSource: LocationSource | null;
}

export interface LocationEventRow {
  id: number;
  kind: LocationEventKind;
  place: LocationPlace | null;
  source: LocationSource;
  at: string;
  recordedAt: string;
  applied: boolean;
  tagCode: string | null;
  readerCode: string | null;
  readerName: string | null;
  /** 业务单据：来访号、钟单号、入住单号、结账单号……（账单明细写项目名） */
  refText: string | null;
  staffName: string | null;
}

export interface LocationTrackData {
  subject:
    | { kind: 'guest'; visitId: number; visitNo: string; tagCode: string; inStore: boolean; checkedInAt: string }
    | { kind: 'technician'; technicianId: number; techNo: string; name: string; date: string };
  current: LocationPerson | null;
  tracks: LocationTrackSegment[];
  events: LocationEventRow[];
  /** 事件太多只给最近的这么多条 */
  eventsTruncated: boolean;
}

export interface LocationReportResult {
  eventId: number;
  /** 迟到的事件（比这个人最近一次位置还早）只记不改：false */
  applied: boolean;
  /** 原样重发：返回第一次的结果 */
  replayed: boolean;
  /** 上报之后这个人现在在哪（离店、位置不明时为空） */
  current: LocationPerson | null;
}
