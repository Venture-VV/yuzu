// 房态图（飞书需求 RQ-004 第三段，v0.7.16，见 docs/ROOMMAP.md）：在用的底图上按楼层画空间台账里的空间，颜色表达状态。
//   · 客房：与「客房」房态看板同一个口径（房间与入住单）：空闲 / 在住 / 待打扫 / 维修；「客房」空间没挂房间为「未挂接」；
//   · 技师服务类（SPA、按摩、踩背、头疗、足浴、投影足浴）：看钟单记的房间（派钟时选，迁移 034）：空闲 / 待上钟 / 服务中；
//   · 开单即占用的业态（派对房、宠物轰趴房、娱乐室，v0.7.19 D39，后台可改）：看使用单：空闲 / 使用中；
//   · 其他业态没有业务单据，只显示业态；
//   · 停用、不可售的空间灰色（还有人住、还有钟单的照样按占用显示）。
// 颜色与图例共用这一张表，图上与图例一一对应。

import type { RoomBoardRoom } from './rooms';
import { isTechnicianBusinessType, ROOM_BUSINESS_TYPE } from './spaces';

export type FloorMapKind = 'room' | 'technician' | 'usage' | 'other';

/** missing：图上有、空间台账里没有的编码（只出现在房态图上，spaceStatus 不会给） */
export const FLOOR_MAP_STATES = ['vacant', 'occupied', 'in_use', 'waiting', 'serving', 'dirty', 'maintenance', 'unlinked', 'other', 'off', 'missing'] as const;
export type FloorMapState = (typeof FLOOR_MAP_STATES)[number];

export interface FloorMapLegendItem {
  label: string;
  /** 多边形填充 */
  fill: string;
  /** 轮廓 */
  stroke: string;
  /** 图例里的说明 */
  hint: string;
}

export const FLOOR_MAP_LEGEND: Record<FloorMapState, FloorMapLegendItem> = {
  vacant: { label: '空闲', fill: '#cfe3d4', stroke: '#24493a', hint: '客房已打扫可入住；技师房没有钟单；派对房等没有开着的使用单' },
  occupied: { label: '在住', fill: '#f2c230', stroke: '#a87508', hint: '客房有在住的入住单' },
  in_use: { label: '使用中', fill: '#eab4cf', stroke: '#9c3a6c', hint: '派对房、宠物轰趴房、娱乐室有开着的使用单（开单即占用）' },
  waiting: { label: '待上钟', fill: '#f6c7a6', stroke: '#dc7432', hint: '技师房派了钟、技师还没上钟' },
  serving: { label: '服务中', fill: '#8fbcc0', stroke: '#2c6066', hint: '技师房有技师在钟上' },
  dirty: { label: '待打扫', fill: '#e9a99a', stroke: '#b0503a', hint: '客房退房后还没打扫' },
  maintenance: { label: '维修', fill: '#a3a8a0', stroke: '#4a524c', hint: '客房在维修，不能入住' },
  unlinked: { label: '未挂接', fill: '#ffffff', stroke: '#808780', hint: '「客房」空间还没挂客房房间，在「后台 → 客房 → 房间」里挂接' },
  other: { label: '其他业态', fill: '#e4dcef', stroke: '#7a6a99', hint: '没有业务单据的业态，只显示业态' },
  off: { label: '停用 / 不可售', fill: '#d9d9d5', stroke: '#9a9e97', hint: '空间台账里停用或不可售，或挂的客房房间停用' },
  missing: { label: '台账里没有', fill: '#f4f1ea', stroke: '#b9b09c', hint: '图上有这个编码、空间台账里没有：在「后台 → 空间台账」补上' },
};

/** 轮廓画虚线的状态（没挂接、台账里没有） */
export const DASHED_STATES: readonly FloorMapState[] = ['unlinked', 'missing'];

/** 技师房里一张还没结束的钟单（只带手牌号与技师，不带会员姓名、手机号） */
export interface FloorMapSession {
  id: number;
  sessionNo: string;
  spaceId: number;
  techNo: string;
  techName: string;
  tagCode: string;
  itemName: string;
  clocks: number;
  minutes: number;
  status: 'waiting' | 'serving';
  createdAt: string;
  startedAt: string | null;
  /** 计划下钟时刻（上钟后才有） */
  plannedEnd: string | null;
}

/** 空间台账里的一个空间（房态图着色、点开看信息用） */
export interface FloorMapSpace {
  id: number;
  code: string;
  floorCode: string;
  floorName: string;
  /** 区域（v0.7.17 实时位置：区域人数标在它的空间轮廓中间） */
  zoneId: number | null;
  zoneName: string | null;
  businessType: string;
  capacity: number | null;
  /** 面积 × 100（㎡） */
  areaCentiM2: number | null;
  displayName: string;
  sellable: boolean;
  active: boolean;
  /** 在用的别名（品牌名、旧名……），搜索用 */
  aliases: string[];
  /** 挂接的客房房间 */
  roomId: number | null;
}

/** 派对房等一张开着的使用单（v0.7.19，只带手牌号） */
export interface FloorMapUsage {
  id: number;
  usageNo: string;
  spaceId: number;
  /** 使用人这次来访（「去前台挂账」打开他的账单） */
  visitId: number;
  tagCode: string;
  guests: number;
  note: string;
  openedAt: string;
  openedByName: string;
}

export interface FloorMapData {
  serverTime: string;
  /** 在用的底图批次；换了一批时页面重新取楼层与轮廓 */
  floorplanBatchId: number | null;
  /** 在用那一批补画轮廓的版本（v0.7.19）：补画、作废后变，页面重新取轮廓 */
  floorplanRev: number;
  spaces: FloorMapSpace[];
  /** 记了房间、还没结束的钟单（客人在店） */
  sessions: FloorMapSession[];
  /** 开单即占用的业态（v0.7.19，后台「规则」可改） */
  usageTypes: string[];
  /** 开着的使用单 */
  usages: FloorMapUsage[];
}

export function spaceKind(businessType: string, usageTypes: readonly string[] = []): FloorMapKind {
  if (businessType === ROOM_BUSINESS_TYPE) return 'room';
  if (isTechnicianBusinessType(businessType)) return 'technician';
  return usageTypes.includes(businessType) ? 'usage' : 'other';
}

export interface SpaceStatus {
  kind: FloorMapKind;
  state: FloorMapState;
  /** 挂接的客房房间（房态看板上的那一间；停用、没人住的房间看板上没有，为 null） */
  room: RoomBoardRoom | null;
  sessions: FloorMapSession[];
  /** 派对房等开着的使用单 */
  usage: FloorMapUsage | null;
  /** 技师房的占用：「2/4」（钟单数 / 容量）；没有钟单为 null */
  occupancy: string | null;
}

/**
 * 一个空间现在的状态。客房按房态看板上那一间房（与看板同一个口径，停用、不可售也照看板）；
 * 技师房有钟单时按钟单（服务中优先）；派对房等有开着的使用单为使用中；没人用的停用、不可售空间为灰色。
 */
export function spaceStatus(
  space: FloorMapSpace,
  room: RoomBoardRoom | undefined,
  sessions: FloorMapSession[],
  usages: readonly FloorMapUsage[] = [],
  usageTypes: readonly string[] = [],
): SpaceStatus {
  const kind = spaceKind(space.businessType, usageTypes);
  const mine = sessions.filter((s) => s.spaceId === space.id);
  const usage = usages.find((u) => u.spaceId === space.id) ?? null;
  const occupancy = mine.length ? (space.capacity ? `${mine.length}/${space.capacity}` : String(mine.length)) : null;
  const base = { kind, room: room ?? null, sessions: mine, usage, occupancy };
  if (kind === 'room' && room) return { ...base, state: room.status };
  if (mine.some((s) => s.status === 'serving')) return { ...base, state: 'serving' };
  if (mine.length) return { ...base, state: 'waiting' };
  // 使用单（业态后来改了、不再按开单即占用的，开着的使用单照样显示使用中，结束后才变）
  if (usage) return { ...base, state: 'in_use' };
  if (!space.active || !space.sellable) return { ...base, state: 'off' };
  if (kind === 'room') return { ...base, state: space.roomId ? 'off' : 'unlinked' };
  return { ...base, state: kind === 'technician' || kind === 'usage' ? 'vacant' : 'other' };
}

/** 搜索：编码、显示名、别名（不分大小写） */
export function spaceMatches(space: Pick<FloorMapSpace, 'code' | 'displayName' | 'aliases'>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [space.code, space.displayName, ...space.aliases].some((t) => t.toLowerCase().includes(q));
}

/** 钟房派钟、换房间时可选的技师房（在用、可售的技师服务类空间），带现在的占用 */
export interface ClockSpace {
  id: number;
  code: string;
  displayName: string;
  floorCode: string;
  zoneName: string | null;
  businessType: string;
  capacity: number | null;
  serving: number;
  waiting: number;
}
