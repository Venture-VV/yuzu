// 底图转换（飞书需求 RQ-004 第二段，v0.7.15，见 docs/FLOORPLAN.md）：上传 DWG / DXF → 单独的进程转换 →
// 每层一份简化 SVG 底图、房间轮廓（房号文字点所在的面）、例外清单 → 与空间台账、在用的上一批比对 → 店主或店总启用。
// 第三段房态图用启用的那一批。

export const FLOORPLAN_BATCH_STATUSES = ['converting', 'ready', 'failed', 'active', 'retired'] as const;
export type FloorplanBatchStatus = (typeof FLOORPLAN_BATCH_STATUSES)[number];
export const FLOORPLAN_BATCH_LABELS: Record<FloorplanBatchStatus, string> = {
  converting: '转换中',
  ready: '待启用',
  failed: '转换失败',
  active: '在用',
  retired: '已换下',
};

export const FLOORPLAN_ROOM_STATUSES = ['ok', 'leak', 'merged', 'no_seed', 'duplicate'] as const;
export type FloorplanRoomStatus = (typeof FLOORPLAN_ROOM_STATUSES)[number];
export const FLOORPLAN_ROOM_LABELS: Record<FloorplanRoomStatus, string> = {
  ok: '已配上轮廓',
  leak: '连到走廊或图外',
  merged: '几个编码连成一片',
  no_seed: '文字附近找不到空地',
  duplicate: '编码重复',
};
/** 例外怎么处理（预览页上的提示） */
export const FLOORPLAN_ROOM_HINTS: Record<Exclude<FloorplanRoomStatus, 'ok'>, string> = {
  leak: '房间的墙线或门没画闭合（门洞超过 2 米、缺一段墙）。请设计方补上后重新上传；启用后这个编码在房态图上只显示位置点',
  merged: '这几间之间的隔墙不在结构图层上，或门洞太宽。请设计方补墙线后重新上传；启用后只显示位置点',
  no_seed: '编码文字压在墙上或图形外。请设计方把文字移进房间后重新上传；启用后只显示位置点',
  duplicate: '同一个编码在图上出现在两处。请设计方核对编码后重新上传；启用后只显示位置点',
};

/** 上传的图纸最大多少字节（编码图约 13 MB） */
export const MAX_FLOORPLAN_FILE_BYTES = 30 * 1024 * 1024;
/** 底图与轮廓的本地坐标：10 毫米一单位，原点在该层图框左上角，y 向下 */
export const FLOORPLAN_LOCAL_UNIT_MM = 10;

export interface FloorplanBatch {
  id: number;
  fileName: string;
  fileBytes: number;
  fileSha256: string;
  fileFormat: 'dwg' | 'dxf';
  converter: string;
  status: FloorplanBatchStatus;
  error: string | null;
  note: string;
  createdAt: string;
  createdByName: string | null;
  finishedAt: string | null;
  activatedAt: string | null;
  activatedByName: string | null;
  retiredAt: string | null;
  readMs: number | null;
  convertMs: number | null;
  floorCount: number;
  roomCount: number;
  okCount: number;
}

export interface FloorplanFloor {
  code: string;
  /** 图上的楼层标题（如「二层」） */
  title: string;
  width: number;
  height: number;
  svgBytes: number;
  pathCount: number;
  /** 底图地址（GET，image/svg+xml） */
  svgUrl: string;
}

export interface FloorplanRoom {
  floorCode: string;
  code: string;
  /** 编码图上的原文（如「SPA S301 1人间」） */
  label: string;
  status: FloorplanRoomStatus;
  mergedWith: string[];
  /** 分开这间用的封门洞半径（毫米） */
  closeMm: number | null;
  /** 外轮廓（本地坐标），只有配上的才有 */
  polygon: [number, number][] | null;
  /** 文字中心（本地坐标） */
  labelAt: [number, number];
  /** 平方米（轮廓围出的面积，含门洞的一半，不扣柱子） */
  areaM2: number | null;
}

export interface FloorplanIssue {
  kind: string;
  floor?: string;
  code?: string;
  message: string;
}

export interface FloorplanLayer {
  name: string;
  /** base 画进底图；room 只参与围合；label 房间名与房号；exclude 剔除；other 没认出来 */
  cls: 'base' | 'room' | 'label' | 'exclude' | 'other';
  kind: 'wall' | 'window' | 'door' | 'stair' | null;
  count: number;
}

export const FLOORPLAN_LAYER_CLASS_LABELS: Record<FloorplanLayer['cls'], string> = {
  base: '画进底图',
  room: '只参与围合',
  label: '房间名与房号',
  exclude: '剔除',
  other: '没用到',
};

export interface FloorplanReport {
  source: { entities: number; layers: number; inserts: number; paths: number; texts: number; skipped: Record<string, number>; readErrorCode?: number };
  layers: FloorplanLayer[];
  issues: FloorplanIssue[];
  params: Record<string, unknown>;
  /** 转换进程：读图耗时、内存峰值 */
  worker?: { readMs: number | null; peakRssMb: number | null };
}

/** 与空间台账比对（以台账为准，不按图纸自动改台账，D6） */
export interface FloorplanLedgerDiff {
  /** 图上有、台账里没有（或已停用）：要不要在台账里新建 */
  onlyDrawing: { floorCode: string; code: string; label: string; ledgerInactive: boolean }[];
  /** 台账里（图上这几层、在用）有、图上没有 */
  onlyLedger: { floorCode: string; code: string; displayName: string }[];
  /** 编码相同、楼层不同 */
  floorMismatch: { code: string; drawingFloor: string; ledgerFloor: string }[];
  /** 编码相同、图上的原文与台账的「编码图原始标注」不同 */
  labelChanged: { code: string; drawingLabel: string; ledgerLabel: string }[];
  /** 台账里配上的空间数（编码与楼层都对上） */
  matched: number;
}

/** 与在用的那一批比对：房间增减、编码变更 */
export interface FloorplanBatchDiff {
  againstBatchId: number | null;
  added: { floorCode: string; code: string }[];
  removed: { floorCode: string; code: string }[];
  /** 同一个位置换了编码（旧编码不在新图上、新编码不在旧图上） */
  renamed: { floorCode: string; from: string; to: string }[];
  /** 同一个编码，位置挪了 2 米以上 */
  moved: { floorCode: string; code: string; distanceM: number }[];
}

export interface FloorplanDetail {
  batch: FloorplanBatch;
  floors: FloorplanFloor[];
  rooms: FloorplanRoom[];
  report: FloorplanReport | null;
  ledgerDiff: FloorplanLedgerDiff | null;
  batchDiff: FloorplanBatchDiff | null;
}

export interface FloorplanList {
  batches: FloorplanBatch[];
  activeId: number | null;
  converting: FloorplanBatch | null;
}

/** 在用的底图（第三段房态图读这个） */
export interface ActiveFloorplan {
  batchId: number | null;
  activatedAt: string | null;
  floors: FloorplanFloor[];
  rooms: (FloorplanRoom & { spaceId: number | null; displayName: string | null })[];
}

export function fileSizeText(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
