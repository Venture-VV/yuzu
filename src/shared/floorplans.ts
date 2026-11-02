// 底图转换（飞书需求 RQ-004 第二段，v0.7.15，见 docs/FLOORPLAN.md）：上传 DWG / DXF（v0.7.19 起也收矢量 PDF）→ 单独的进程转换 →
// 每层一份简化 SVG 底图、房间轮廓（房号文字点所在的面）、例外清单 → 与空间台账、在用的上一批比对 → 店主或店总启用。
// 第三段房态图用启用的那一批。
// 图纸治理（v0.7.19，docs/FLOORPLAN_FINISH.md 第 4、5 节）：入库登记（来源、版本或说明、收图日期）、可选保存原图纸、
// 底图档案（已换下的照样能打开）、在用历史（启用、换下、换回）、已换下的写原因换回；例外编码在这一批上补画轮廓。

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

/** 图纸来源（入库登记，v0.7.19） */
export const FLOORPLAN_SOURCE_KINDS = ['designer', 'store', 'other'] as const;
export type FloorplanSourceKind = (typeof FLOORPLAN_SOURCE_KINDS)[number];
export const FLOORPLAN_SOURCE_LABELS: Record<FloorplanSourceKind, string> = { designer: '设计方', store: '门店', other: '其他' };

/** 在用历史的一条：启用、换下、换回 */
export const FLOORPLAN_ACTIVATION_KINDS = ['activate', 'retire', 'restore'] as const;
export type FloorplanActivationKind = (typeof FLOORPLAN_ACTIVATION_KINDS)[number];
export const FLOORPLAN_ACTIVATION_LABELS: Record<FloorplanActivationKind, string> = { activate: '启用', retire: '换下', restore: '换回' };

export interface FloorplanActivation {
  id: number;
  batchId: number;
  fileName: string;
  kind: FloorplanActivationKind;
  at: string;
  staffName: string | null;
  reason: string;
}

/** PDF 的图纸比例（1:N）范围 */
export const PDF_SCALE_MIN = 1;
export const PDF_SCALE_MAX = 10000;

/** 上传的图纸最大多少字节（编码图约 13 MB） */
export const MAX_FLOORPLAN_FILE_BYTES = 30 * 1024 * 1024;
/** 底图与轮廓的本地坐标：10 毫米一单位，原点在该层图框左上角，y 向下 */
export const FLOORPLAN_LOCAL_UNIT_MM = 10;

export interface FloorplanBatch {
  id: number;
  fileName: string;
  fileBytes: number;
  fileSha256: string;
  fileFormat: 'dwg' | 'dxf' | 'pdf';
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
  retiredByName: string | null;
  /** 换下的原因（换新一批时可选填写；换回旧底图时必填） */
  retireReason: string | null;
  readMs: number | null;
  convertMs: number | null;
  floorCount: number;
  roomCount: number;
  okCount: number;
  /** 入库登记（v0.7.19；升级前的批次为空） */
  sourceKind: FloorplanSourceKind | null;
  sourceNote: string;
  receivedOn: string | null;
  /** PDF 的图纸比例 1:N（上传时填的；没填为 null，按页面上的比例文字） */
  pdfScale: number | null;
  /** 上传时勾了「保存原图纸」 */
  originalSaved: boolean;
  /** 补画了轮廓的例外编码数（不含作废的） */
  outlineCount: number;
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
  /** 例外编码在这一批上补画的轮廓（v0.7.19）：有时 polygon、areaM2 用补画的 */
  drawn?: { id: number; byName: string | null; at: string } | null;
}

/** 补画轮廓的点数上限 */
export const MAX_OUTLINE_POINTS = 64;

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
  /** PDF（v0.7.19）：页数、换算用的比例、比例从哪来（上传时填的 / 页面上的比例文字）、页面上写的比例 */
  pdf?: { pages: number; scale: number; scaleFrom: 'text' | 'option'; textScale: number | null };
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
  /** 同一个编码换了楼层 */
  floorChanged: { code: string; from: string; to: string }[];
}

export interface FloorplanDetail {
  batch: FloorplanBatch;
  floors: FloorplanFloor[];
  rooms: FloorplanRoom[];
  report: FloorplanReport | null;
  /** 与现在的空间台账比对 */
  ledgerDiff: FloorplanLedgerDiff | null;
  batchDiff: FloorplanBatchDiff | null;
  /** 这一批的在用历史（v0.7.19） */
  history: FloorplanActivation[];
  /** 最近一次启用或换回时与空间台账的比对（底图档案里看「当时的台账比对」；升级前启用的没有） */
  activationLedgerDiff: { at: string; kind: 'activate' | 'restore'; diff: FloorplanLedgerDiff } | null;
  /** 这一批补画的版本（补画、作废都让它变大，只增不减）：补画、作废时带上，对不上说明刚被改过（v0.7.19） */
  outlineRev: number;
}

export interface FloorplanList {
  batches: FloorplanBatch[];
  activeId: number | null;
  converting: FloorplanBatch | null;
  /** 在用历史（新的在前，最多 100 条） */
  history: FloorplanActivation[];
  /** 在用历史的版本（最新一行的编号，只增不减）：启用、换回时带上，对不上说明刚被换过（v0.7.19） */
  activationSeq: number;
}

/** 在用的底图（第三段房态图读这个） */
export interface ActiveFloorplan {
  batchId: number | null;
  activatedAt: string | null;
  /** 补画轮廓的版本（v0.7.19）：补画、作废后变，页面据此重新取 */
  outlineRev: number;
  floors: FloorplanFloor[];
  rooms: (FloorplanRoom & { spaceId: number | null; displayName: string | null })[];
}

export function fileSizeText(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
