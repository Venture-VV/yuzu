// 底图转换（RQ-004 第二段，v0.7.15，见 docs/FLOORPLAN.md）：中性图元（model.ts）→ 每层一份简化 SVG 底图、
// 房间轮廓（房号文字点所在的那块面）、例外清单。纯计算，同样的输入与参数得到同样的结果（可重跑）。
//
// 编码图里没有现成的房间轮廓（闭合线、填充都不包房间），所以轮廓由墙线围合：
// 1. 结构层（墙、柱、门、窗、楼梯电梯）与只参与围合的层（完成面、门套、门的未开虚线）画到栅格上；
// 2. 离墙线不到 R 的格子先当作封住（门洞宽不到 2R 的都封上了），从房号文字点向外漫水填充，得到房间的「芯」；
// 3. 一块芯里有两个以上编码（门洞太宽连成一片）或太大、碰到图边（连到走廊）的，加大 R 重试；
// 4. 所有的芯（房间与走廊等）同时往外长回 R 左右，长到墙线为止，门洞两边各分一半；
// 5. 描出每个房间的外轮廓，按容差简化。
// 重试到最大的 R 仍分不开的，列为例外（连到走廊 / 几个编码连成一片 / 文字附近找不到空地 / 编码重复），人工核对。

import type { PlanDrawing, PlanPath, PlanText, Pt } from './model';

export const CONVERTER_VERSION = 'yuzu-floorplan/1';

/** 底图与轮廓的本地坐标：1 个单位 = 10 毫米，原点在楼层图框左上角，y 向下（直接当 SVG 坐标用） */
export const LOCAL_UNIT_MM = 10;

export interface ConvertParams {
  /** 图纸单位是多少毫米（编码图是毫米：1） */
  unitMm: number;
  /** 栅格一格多少毫米 */
  resolutionMm: number;
  /** 封门洞的半径（毫米），分不开时依次加大重试 */
  closeRadiiMm: number[];
  /** 房间面积上限（平方米），超过算连到走廊 */
  maxRoomM2: number;
  /** 两层图形之间的最小空隙（毫米） */
  floorGapMm: number;
  /** 一块图形至少有这么多条结构线才可能是一层（还要有房号或楼层标题） */
  minFloorPaths: number;
  /** 文字点落在墙边时，往外找空地的最远距离（毫米） */
  seedSearchMm: number;
  /** 底图与轮廓的简化容差（毫米） */
  simplifyMm: number;
  /** 单层 SVG 的体积上限（字节） */
  svgBudgetBytes: number;
}

export const DEFAULT_PARAMS: ConvertParams = {
  unitMm: 1,
  resolutionMm: 50,
  closeRadiiMm: [600, 800, 1000],
  maxRoomM2: 400,
  floorGapMm: 20000,
  minFloorPaths: 10,
  seedSearchMm: 2000,
  simplifyMm: 60,
  svgBudgetBytes: 1_000_000,
};

// ───────────────────────── 图层白名单 ─────────────────────────

/** base：画进底图、参与围合；room：只参与围合（完成面、门套）；label：房间名与房号文字；exclude：明确剔除；other：没认出来，不用 */
export type LayerClass = 'base' | 'room' | 'label' | 'exclude' | 'other';
export type BaseKind = 'wall' | 'window' | 'door' | 'stair';

// 先排除（家具、洁具、天花、机电、填充、标注……），再认只围合的层，最后认结构层
const EXCLUDE_RE =
  /家具|洁具|植物|绿植|设备|顶|天花|灯|EQUIP|VPIPE|WIRE|消火栓|消防栓|卷帘|疏散|灭火器|防火分区|尺寸|标注|填充|HATCH|英文|TEXT|轴号|看线|地坪|地材|分界线|DRAINAGE|标识|FURN|FIXT|LITE|^RC-|^AA-|高差|窗帘|DIM|立面|大样|修改|云线|地漏|人物|淡显/i;
const ROOM_ONLY_RE = /完成面|门套|未开虚线|FINISH/i;
const LABEL_RE = /区域文字/;
const KIND_RES: [BaseKind, RegExp][] = [
  ['door', /门|DOOR/i],
  ['window', /窗|幕墙|Curt|WIND/i],
  ['stair', /楼梯|扶手|电梯|STAIR|Strs|ELEV|EVTR|LIFT|Hdrl/i],
  ['wall', /墙|柱|隔断|WALL|COLUMN|COLS|Hole/i],
];

export function classifyLayer(name: string): { cls: LayerClass; kind: BaseKind | null } {
  if (LABEL_RE.test(name)) return { cls: 'label', kind: null };
  if (EXCLUDE_RE.test(name)) return { cls: 'exclude', kind: null };
  if (ROOM_ONLY_RE.test(name)) return { cls: 'room', kind: null };
  // 墙体图层名里常带「电梯井」「楼梯间」之类，按墙算；其余按门、窗、楼梯电梯的顺序认
  if (/墙|WALL/i.test(name) && !/幕墙|玻璃墙/.test(name)) return { cls: 'base', kind: 'wall' };
  for (const [kind, re] of KIND_RES) if (re.test(name)) return { cls: 'base', kind };
  return { cls: 'other', kind: null };
}

// ───────────────────────── 编码与楼层标题 ─────────────────────────

/** 编码：区域字母 + 楼层数字 + 两位序号（S301、P205）；前面紧挨字母数字或乘号的不算（如「500*600*H900」） */
const CODE_RE = /(?<![A-Za-z0-9*×.])([A-Z][1-9]\d{2})(?![0-9])/g;
const CN_DIGITS = '一二三四五六七八九';
/** 走道、大厅一类的区域文字：房间连到了这样的地方就算连到走廊（走道两头都封着时面积不大，光看面积看不出来） */
const CORRIDOR_RE = /^(走道|走廊|过道|通道|公共走道|内走道|大厅|大堂|门厅|电梯厅|前厅|休息厅|休息区|等候区)$/;
const TITLE_RE = /^\s*(?:([一二三四五六七八九])\s*层|([1-9])\s*F\b|L([1-9])\b)/i;

export function codesIn(text: string): string[] {
  return [...new Set([...text.matchAll(CODE_RE)].map((m) => m[1]!))];
}

function floorTitleNumber(text: string): number | null {
  const m = TITLE_RE.exec(text);
  if (!m) return null;
  if (m[1]) return CN_DIGITS.indexOf(m[1]) + 1;
  return Number(m[2] ?? m[3]);
}

// ───────────────────────── 结果 ─────────────────────────

export type RoomStatus = 'ok' | 'leak' | 'merged' | 'no_seed' | 'duplicate';

export interface ConvertedRoom {
  floor: string;
  code: string;
  /** 编码图上的原文（如「SPA S301 1人间」） */
  label: string;
  status: RoomStatus;
  /** status = merged：连成一片的其他编码 */
  with: string[];
  /** 分开这个房间用的封门洞半径（毫米） */
  closeMm: number | null;
  /** 外轮廓（本地坐标），只有 ok 才有 */
  polygon: Pt[] | null;
  /** 文字中心（本地坐标） */
  labelAt: Pt;
  /** 平方米，两位小数 */
  areaM2: number | null;
}

export interface ConvertedFloor {
  /** 楼层编码（L1、L2、L3） */
  code: string;
  /** 图上的楼层标题（如「二层」），没有为空 */
  title: string;
  /** 图框（图纸坐标）：x0, y0, x1, y1 */
  frame: [number, number, number, number];
  /** 本地坐标的宽高 */
  width: number;
  height: number;
  svg: string;
  svgBytes: number;
  /** 底图里画了多少条线 */
  pathCount: number;
  labelCount: number;
  roomCount: number;
}

export interface ConvertIssue {
  kind: 'read_warning' | 'floor_unknown' | 'floor_duplicate' | 'floor_no_codes' | 'code_outside' | 'code_floor_digit' | 'svg_over_budget';
  floor?: string;
  code?: string;
  message: string;
}

export interface LayerReport {
  name: string;
  cls: LayerClass;
  kind: BaseKind | null;
  /** 这个图层上的图元数（块参照展开后） */
  count: number;
}

export interface ConvertResult {
  converter: string;
  params: ConvertParams;
  localUnitMm: number;
  source: { entities: number; layers: number; inserts: number; paths: number; texts: number; skipped: Record<string, number>; readErrorCode?: number };
  layers: LayerReport[];
  floors: ConvertedFloor[];
  rooms: ConvertedRoom[];
  issues: ConvertIssue[];
  convertMs: number;
}

// ───────────────────────── 几何小工具 ─────────────────────────

type Box = [number, number, number, number];

function bboxOf(pts: Pt[]): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

const isWide = (ch: string) => /[⺀-鿿豈-﫿＀-￯]/.test(ch);

/** 估文字宽度：汉字按一个字高，其余按 0.6 个字高 */
export function textWidth(text: string, height: number): number {
  let w = 0;
  for (const ch of text) w += isWide(ch) ? height : ch === ' ' ? 0.5 * height : 0.6 * height;
  return w;
}

/** 文字的中心点（图纸坐标） */
export function textCenter(t: PlanText): Pt {
  const w = textWidth(t.text, t.height);
  const dx = (0.5 - t.ax) * w;
  const dy = (0.5 - t.ay) * t.height;
  const c = Math.cos(t.rotation);
  const s = Math.sin(t.rotation);
  return [t.x + dx * c - dy * s, t.y + dx * s + dy * c];
}

/** 文字左下角（基线起点，图纸坐标），画 SVG 用 */
function textOrigin(t: PlanText): Pt {
  const w = textWidth(t.text, t.height);
  const dx = -t.ax * w;
  const dy = -t.ay * t.height;
  const c = Math.cos(t.rotation);
  const s = Math.sin(t.rotation);
  return [t.x + dx * c - dy * s, t.y + dx * s + dy * c];
}

/** 道格拉斯–普克简化（非递归），保留首尾 */
export function simplifyLine(pts: Pt[], tol: number): Pt[] {
  if (pts.length <= 2 || tol <= 0) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a]!;
    const [bx, by] = pts[b]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let best = -1;
    let bestD = tol2;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i]!;
      let d: number;
      if (len2 === 0) d = (px - ax) ** 2 + (py - ay) ** 2;
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
      }
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** 闭合环的简化：从离起点最远的点切成两段分别简化 */
export function simplifyRing(ring: Pt[], tol: number): Pt[] {
  if (ring.length <= 4) return ring.slice();
  const [x0, y0] = ring[0]!;
  let far = 1;
  let farD = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = (ring[i]![0] - x0) ** 2 + (ring[i]![1] - y0) ** 2;
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const a = simplifyLine(ring.slice(0, far + 1), tol);
  const b = simplifyLine([...ring.slice(far), ring[0]!], tol);
  return [...a, ...b.slice(1, -1)];
}

/** 多边形面积（鞋带公式，取绝对值） */
export function polygonArea(ring: Pt[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[(i + 1) % ring.length]!;
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

// ───────────────────────── 分楼层 ─────────────────────────

interface Indexed {
  i: number;
  cx: number;
  cy: number;
  box: Box;
}

/** 按中心点排序后，相邻两个的间距超过 gap 就切开 */
function splitByGap(items: Indexed[], key: 'cx' | 'cy', gap: number): Indexed[][] {
  if (!items.length) return [];
  const sorted = [...items].sort((a, b) => a[key] - b[key] || a.i - b.i);
  const groups: Indexed[][] = [[sorted[0]!]];
  for (let k = 1; k < sorted.length; k++) {
    if (sorted[k]![key] - sorted[k - 1]![key] > gap) groups.push([]);
    groups[groups.length - 1]!.push(sorted[k]!);
  }
  return groups;
}

interface FloorCluster {
  members: Indexed[];
  frame: Box;
  basePaths: number;
}

function clusterFloors(structural: Indexed[], isBase: (i: number) => boolean, p: ConvertParams): FloorCluster[] {
  const gap = p.floorGapMm / p.unitMm;
  const margin = 1000 / p.unitMm;
  const out: FloorCluster[] = [];
  for (const xs of splitByGap(structural, 'cx', gap)) {
    for (const group of splitByGap(xs, 'cy', gap)) {
      const basePaths = group.filter((g) => isBase(g.i)).length;
      if (basePaths < p.minFloorPaths) continue;
      // 图框：组内线的外框，但不让个别很长的线把图框拉出去（限制在中心点范围外扩半个空隙）
      let [cx0, cy0, cx1, cy1] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const g of group) {
        cx0 = Math.min(cx0, g.cx);
        cy0 = Math.min(cy0, g.cy);
        cx1 = Math.max(cx1, g.cx);
        cy1 = Math.max(cy1, g.cy);
      }
      const lim: Box = [cx0 - gap / 2, cy0 - gap / 2, cx1 + gap / 2, cy1 + gap / 2];
      let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const g of group) {
        x0 = Math.min(x0, Math.max(g.box[0], lim[0]));
        y0 = Math.min(y0, Math.max(g.box[1], lim[1]));
        x1 = Math.max(x1, Math.min(g.box[2], lim[2]));
        y1 = Math.max(y1, Math.min(g.box[3], lim[3]));
      }
      out.push({ members: group, frame: [x0 - margin, y0 - margin, x1 + margin, y1 + margin], basePaths });
    }
  }
  return out;
}

/** 没认出楼层的图形，结构线有这么多才在报告里提示 */
const UNKNOWN_FLOOR_REPORT_PATHS = 50;

const inBox = (b: Box, [x, y]: Pt) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];

// ───────────────────────── 栅格与围合 ─────────────────────────

/** 栅格最多这么多格（约 2500 万）；图框太大时自动放粗分辨率 */
const MAX_CELLS = 25_000_000;

interface Grid {
  w: number;
  h: number;
  /** 一格多少图纸单位 */
  res: number;
  /** 一格多少毫米 */
  resMm: number;
  x0: number;
  y1: number;
  wall: Uint8Array;
}

function rasterize(paths: PlanPath[], frame: Box, p: ConvertParams): Grid {
  let resMm = p.resolutionMm;
  const wMm = (frame[2] - frame[0]) * p.unitMm;
  const hMm = (frame[3] - frame[1]) * p.unitMm;
  if ((wMm / resMm) * (hMm / resMm) > MAX_CELLS) resMm = Math.ceil(Math.sqrt((wMm * hMm) / MAX_CELLS));
  const res = resMm / p.unitMm;
  const w = Math.max(1, Math.ceil((frame[2] - frame[0]) / res));
  const h = Math.max(1, Math.ceil((frame[3] - frame[1]) / res));
  const wall = new Uint8Array(w * h);
  const x0 = frame[0];
  const y1 = frame[3];
  const line = (ax: number, ay: number, bx: number, by: number) => {
    // Bresenham：8 连通的线，正好挡住 4 连通的漫水
    let x = Math.floor((ax - x0) / res);
    let y = Math.floor((y1 - ay) / res);
    const tx = Math.floor((bx - x0) / res);
    const ty = Math.floor((y1 - by) / res);
    const dx = Math.abs(tx - x);
    const dy = -Math.abs(ty - y);
    const sx = x < tx ? 1 : -1;
    const sy = y < ty ? 1 : -1;
    let err = dx + dy;
    for (let guard = 0; guard < 1e7; guard++) {
      if (x >= 0 && y >= 0 && x < w && y < h) wall[y * w + x] = 1;
      if (x === tx && y === ty) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
  };
  for (const path of paths) {
    const pts = path.pts;
    for (let k = 0; k + 1 < pts.length; k++) line(pts[k]![0], pts[k]![1], pts[k + 1]![0], pts[k + 1]![1]);
    if (path.closed && pts.length > 2) line(pts[pts.length - 1]![0], pts[pts.length - 1]![1], pts[0]![0], pts[0]![1]);
  }
  return { w, h, res, resMm, x0, y1, wall };
}

/** 每格到最近墙格的距离（格数，两遍倒角距离变换） */
function distanceField(g: Grid): Float32Array {
  const { w, h, wall } = g;
  const dist = new Float32Array(w * h);
  const INF = 1e9;
  for (let i = 0; i < w * h; i++) dist[i] = wall[i] ? 0 : INF;
  const D2 = Math.SQRT2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let d = dist[i]!;
      if (d === 0) continue;
      if (x > 0) d = Math.min(d, dist[i - 1]! + 1);
      if (y > 0) {
        d = Math.min(d, dist[i - w]! + 1);
        if (x > 0) d = Math.min(d, dist[i - w - 1]! + D2);
        if (x < w - 1) d = Math.min(d, dist[i - w + 1]! + D2);
      }
      dist[i] = d;
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let d = dist[i]!;
      if (d === 0) continue;
      if (x < w - 1) d = Math.min(d, dist[i + 1]! + 1);
      if (y < h - 1) {
        d = Math.min(d, dist[i + w]! + 1);
        if (x < w - 1) d = Math.min(d, dist[i + w + 1]! + D2);
        if (x > 0) d = Math.min(d, dist[i + w - 1]! + D2);
      }
      dist[i] = d;
    }
  return dist;
}

interface Seed {
  code: string;
  label: string;
  /** 文字中心（图纸坐标） */
  at: Pt;
}

interface RoomOutcome {
  status: RoomStatus;
  with: string[];
  closeMm: number | null;
  polygon: Pt[] | null;
  areaM2: number | null;
}

/**
 * 一层的房间围合。返回每个编码的结果；polygon 是本地坐标（10 毫米一单位，原点在图框左上角）。
 */
function detectRooms(g: Grid, seeds: Seed[], corridors: Pt[], p: ConvertParams): Map<string, RoomOutcome> {
  const { w, h, wall } = g;
  const n = w * h;
  const dist = distanceField(g);
  const out = new Map<string, RoomOutcome>();
  const maxCells = (p.maxRoomM2 * 1e6) / (g.resMm * g.resMm);
  const searchPx = Math.max(1, Math.round(p.seedSearchMm / g.resMm));

  // 区域：房间（code）或其他（走廊、没编码的房间……），各自记住用的半径（格）
  const regions: { code: string | null; rPx: number; box: Box }[] = [];
  const labels = new Int32Array(n).fill(-1);
  /** 上一轮没分开的块：每格属于其中哪一块（-1 本轮不参与）；第一轮为 null，全图参与 */
  let parent: Int32Array | null = null;
  /** 上一轮没分开的块是不是连到了走廊、图外或太大（这一轮那边还得在，才算真的分开了） */
  let parentLeak: boolean[] = [];
  const comp = new Int32Array(n);
  const stack = new Int32Array(n);
  let pending = seeds.slice();
  /** 每个编码最近一次失败的原因（分不开时用） */
  const lastFail = new Map<string, { status: RoomStatus; with: string[]; closeMm: number }>();
  /** 分不开、不再重试的编码 */
  const settled = new Set<string>();

  const pixelOf = ([x, y]: Pt): [number, number] => [Math.floor((x - g.x0) / g.res), Math.floor((g.y1 - y) / g.res)];
  /** 点所在的块；点本身不在块里就往外找最近的块（最多 seedSearchMm） */
  const nearestComp = (at: Pt): number => {
    const [sx, sy] = pixelOf(at);
    let found = -1;
    let best = Infinity;
    for (let r = 0; r <= searchPx; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = sx + dx;
          const y = sy + dy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const c = comp[y * w + x]!;
          if (c < 0) continue;
          const d = dx * dx + dy * dy;
          if (d < best) {
            best = d;
            found = c;
          }
        }
      }
      if (found >= 0 && Math.sqrt(best) <= r + 1) break;
    }
    return found;
  };

  for (let pass = 0; pass < p.closeRadiiMm.length && pending.length; pass++) {
    const closeMm = p.closeRadiiMm[pass]!;
    const rPx = closeMm / g.resMm;
    const last = pass === p.closeRadiiMm.length - 1;
    const eligible = (i: number) => labels[i] === -1 && dist[i]! > rPx && (!parent || parent[i]! >= 0);
    // 连通块（4 连通）：离墙超过 R、本轮可参与、还没归属的格
    comp.fill(-1);
    const sizes: number[] = [];
    const edges: boolean[] = [];
    const boxes: Box[] = [];
    const compParent: number[] = [];
    for (let i = 0; i < n; i++) {
      if (comp[i] !== -1 || !eligible(i)) continue;
      const id = sizes.length;
      let size = 0;
      let edge = false;
      let bx0 = w;
      let by0 = h;
      let bx1 = -1;
      let by1 = -1;
      let top = 0;
      stack[top++] = i;
      comp[i] = id;
      while (top) {
        const j = stack[--top]!;
        size++;
        const x = j % w;
        const y = (j - x) / w;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (y < by0) by0 = y;
        if (y > by1) by1 = y;
        const nb = [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, y > 0 ? j - w : -1, y < h - 1 ? j + w : -1];
        for (const k of nb) {
          if (k < 0 || comp[k] !== -1 || !eligible(k)) continue;
          comp[k] = id;
          stack[top++] = k;
        }
      }
      sizes.push(size);
      edges.push(edge);
      boxes.push([bx0, by0, bx1, by1]);
      // 半径变大，块只会变小、分开，不会把上一轮的两块连起来
      compParent.push(parent ? parent[i]! : -1);
    }

    const seedComp = new Map<Seed, number>();
    for (const s of pending) seedComp.set(s, nearestComp(s.at));
    // 走道、大厅的文字落在哪些块
    const corridorComps = new Set<number>();
    for (const at of corridors) {
      const c = nearestComp(at);
      if (c >= 0) corridorComps.add(c);
    }

    // 同一个编码落在不同的块：编码重复
    const codeComps = new Map<string, Set<number>>();
    for (const s of pending) {
      const c = seedComp.get(s)!;
      if (c < 0) continue;
      const set = codeComps.get(s.code) ?? new Set<number>();
      set.add(c);
      codeComps.set(s.code, set);
    }
    const duplicate = new Set([...codeComps].filter(([, set]) => set.size > 1).map(([code]) => code));
    for (const code of duplicate) out.set(code, { status: 'duplicate', with: [], closeMm: null, polygon: null, areaM2: null });

    const compCodes = new Map<number, Set<string>>();
    for (const s of pending) {
      const c = seedComp.get(s)!;
      if (c < 0 || duplicate.has(s.code)) continue;
      const set = compCodes.get(c) ?? new Set<string>();
      set.add(s.code);
      compCodes.set(c, set);
    }
    const leaky = (c: number) => sizes[c]! > maxCells || edges[c]! || corridorComps.has(c);
    // 上一轮连到走廊、图外的块：这一轮那边（没有编码、仍然连到走廊或图外的块）还在，才说明房间真的和它分开了；
    // 那边已经消失（走道比 2R 还窄），就分不清房间到哪为止，按上一轮的原因列为例外
    const targetAlive = new Set<number>();
    for (let c = 0; c < sizes.length; c++) if (compParent[c]! >= 0 && !compCodes.has(c) && leaky(c)) targetAlive.add(compParent[c]!);

    const finalize = (c: number, code: string | null) => {
      const id = regions.length;
      regions.push({ code, rPx, box: [...boxes[c]!] as Box });
      const [bx0, by0, bx1, by1] = boxes[c]!;
      for (let y = by0; y <= by1; y++)
        for (let x = bx0; x <= bx1; x++) {
          const i = y * w + x;
          if (comp[i] === c) labels[i] = id;
        }
    };
    const nextParent = last ? null : new Int32Array(n).fill(-1);
    const nextLeak: boolean[] = [];
    const retry = (c: number, isLeak: boolean) => {
      if (!nextParent) return finalize(c, null);
      const id = nextLeak.length;
      nextLeak.push(isLeak);
      const [bx0, by0, bx1, by1] = boxes[c]!;
      for (let y = by0; y <= by1; y++)
        for (let x = bx0; x <= bx1; x++) {
          const i = y * w + x;
          if (comp[i] === c) nextParent[i] = id;
        }
    };
    for (let c = 0; c < sizes.length; c++) {
      const codes = compCodes.get(c);
      if (!codes) {
        finalize(c, null);
        continue;
      }
      const list = [...codes].sort();
      const from = compParent[c]!;
      if (list.length > 1) {
        for (const code of list) lastFail.set(code, { status: 'merged', with: list.filter((x) => x !== code), closeMm });
        retry(c, leaky(c));
      } else if (leaky(c)) {
        lastFail.set(list[0]!, { status: 'leak', with: [], closeMm });
        retry(c, true);
      } else if (from >= 0 && parentLeak[from] && !targetAlive.has(from)) {
        // 看着分开了，但走廊那边已经消失：分不清，按上一轮的原因列为例外
        settled.add(list[0]!);
        finalize(c, null);
      } else {
        finalize(c, list[0]!);
      }
    }
    const done = new Set([...regions.map((r) => r.code).filter((c): c is string => !!c), ...duplicate, ...settled]);
    // 没落进任何块的文字点：下一轮半径更大，空地只会更少，不再重试
    for (const s of pending) if (seedComp.get(s)! < 0 && !lastFail.has(s.code) && !done.has(s.code)) lastFail.set(s.code, { status: 'no_seed', with: [], closeMm });
    pending = nextLeak.length ? pending.filter((s) => !done.has(s.code) && seedComp.get(s)! >= 0) : [];
    parent = nextParent;
    parentLeak = nextLeak;
  }

  // 所有区域同时往外长（4 连通、不过墙），每块最多长到 2R 步，门洞两边各分一半
  let q = new Int32Array(1024);
  let qs = new Uint16Array(1024);
  let qlen = 0;
  const push = (i: number, steps: number) => {
    if (qlen === q.length) {
      const nq = new Int32Array(q.length * 2);
      nq.set(q);
      q = nq;
      const ns = new Uint16Array(qs.length * 2);
      ns.set(qs);
      qs = ns;
    }
    q[qlen] = i;
    qs[qlen] = steps;
    qlen++;
  };
  for (let i = 0; i < n; i++) if (labels[i]! >= 0) push(i, 0);
  const limits = regions.map((r) => Math.ceil(r.rPx * 2) + 1);
  for (let head = 0; head < qlen; head++) {
    const i = q[head]!;
    const steps = qs[head]!;
    const id = labels[i]!;
    if (steps >= limits[id]!) continue;
    const x = i % w;
    const y = (i - x) / w;
    const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    for (const k of nb) {
      if (k < 0 || labels[k] !== -1 || wall[k]) continue;
      labels[k] = id;
      const b = regions[id]!.box;
      const kx = k % w;
      const ky = (k - kx) / w;
      if (kx < b[0]) b[0] = kx;
      if (kx > b[2]) b[2] = kx;
      if (ky < b[1]) b[1] = ky;
      if (ky > b[3]) b[3] = ky;
      push(k, steps + 1);
    }
  }

  // 描房间外轮廓 → 简化 → 本地坐标
  const scale = g.resMm / LOCAL_UNIT_MM;
  const tol = p.simplifyMm / LOCAL_UNIT_MM;
  regions.forEach((r, id) => {
    if (!r.code) return;
    const ring = traceOuter(labels, w, h, id, r.box);
    const local = simplifyRing(
      ring.map(([cx, cy]) => [cx * scale, cy * scale] as Pt),
      tol,
    ).map(([x, y]) => [Math.round(x), Math.round(y)] as Pt);
    const area = polygonArea(local) * (LOCAL_UNIT_MM / 1000) ** 2;
    out.set(r.code, {
      status: 'ok',
      with: [],
      closeMm: Math.round(r.rPx * g.resMm),
      polygon: local,
      areaM2: Math.round(area * 100) / 100,
    });
  });
  for (const [code, f] of lastFail) if (!out.has(code)) out.set(code, { status: f.status, with: f.with, closeMm: f.closeMm, polygon: null, areaM2: null });
  return out;
}

/**
 * 沿格子边描一块（4 连通）区域的外轮廓，区域保持在前进方向的右侧；返回格角坐标（转弯处才记一个点）。
 */
function traceOuter(labels: Int32Array, w: number, h: number, id: number, box: Box): Pt[] {
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && labels[y * w + x] === id;
  // 起点：按行扫描的第一格，它的上边一定是边界
  let sx = -1;
  let sy = -1;
  outer: for (let y = box[1]; y <= box[3]; y++)
    for (let x = box[0]; x <= box[2]; x++)
      if (labels[y * w + x] === id) {
        sx = x;
        sy = y;
        break outer;
      }
  if (sx < 0) return [];
  // 方向：0 东、1 南、2 西、3 北（图像坐标，y 向下）
  const DX = [1, 0, -1, 0];
  const DY = [0, 1, 0, -1];
  // 在格角 (cx, cy) 朝方向 d 时，前方左、右两格
  const ahead = (cx: number, cy: number, d: number): [boolean, boolean] => {
    switch (d) {
      case 0:
        return [at(cx, cy - 1), at(cx, cy)];
      case 1:
        return [at(cx, cy), at(cx - 1, cy)];
      case 2:
        return [at(cx - 1, cy), at(cx - 1, cy - 1)];
      default:
        return [at(cx - 1, cy - 1), at(cx, cy - 1)];
    }
  };
  const pts: Pt[] = [];
  let cx = sx;
  let cy = sy;
  let d = 0;
  const limit = 4 * (box[2] - box[0] + 2) * (box[3] - box[1] + 2) + 16;
  for (let step = 0; step < limit; step++) {
    const [left, right] = ahead(cx, cy, d);
    let nd: number;
    if (right) nd = left ? (d + 3) % 4 : d;
    else nd = (d + 1) % 4;
    if (nd !== d || step === 0) pts.push([cx, cy]);
    d = nd;
    cx += DX[d]!;
    cy += DY[d]!;
    // 起点格角周围只有起点这一格在区域里，外轮廓只经过它一次：回到起点就描完了
    if (cx === sx && cy === sy) break;
  }
  return pts;
}

// ───────────────────────── SVG ─────────────────────────

const KIND_STYLE: Record<BaseKind, string> = {
  wall: 'stroke="#1f2937"',
  window: 'stroke="#38bdf8"',
  door: 'stroke="#9ca3af"',
  stair: 'stroke="#a8a29e"',
};

const xmlEscape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

interface SvgInput {
  frame: Box;
  width: number;
  height: number;
  paths: { kind: BaseKind; path: PlanPath }[];
  labels: PlanText[];
}

function buildSvg(input: SvgInput, p: ConvertParams, tolMm: number, round: number): { svg: string; pathCount: number } {
  const k = p.unitMm / LOCAL_UNIT_MM;
  const [fx0, , , fy1] = input.frame;
  const toLocal = ([x, y]: Pt): Pt => [(x - fx0) * k, (fy1 - y) * k];
  const tol = tolMm / LOCAL_UNIT_MM;
  const q = (v: number) => Math.round(v / round) * round;
  const byKind: Record<BaseKind, string[]> = { wall: [], window: [], door: [], stair: [] };
  const cursor: Record<BaseKind, Pt | null> = { wall: null, window: null, door: null, stair: null };
  let pathCount = 0;
  const num = (out: string[], v: number, first: boolean) => {
    out.push(first || v < 0 ? String(v) : ` ${v}`);
  };
  for (const { kind, path } of input.paths) {
    const local = path.pts.map(toLocal);
    const simple = path.closed ? simplifyRing(local, tol) : simplifyLine(local, tol);
    const pts: Pt[] = [];
    for (const [x, y] of simple) {
      const pt: Pt = [q(x), q(y)];
      const prev = pts[pts.length - 1];
      if (!prev || prev[0] !== pt[0] || prev[1] !== pt[1]) pts.push(pt);
    }
    if (pts.length < 2) continue;
    const out = byKind[kind];
    const cur = cursor[kind];
    const [x0, y0] = pts[0]!;
    if (!cur) {
      out.push('M');
      num(out, x0, true);
      num(out, y0, false);
    } else {
      out.push('m');
      num(out, x0 - cur[0], true);
      num(out, y0 - cur[1], false);
    }
    out.push('l');
    for (let i = 1; i < pts.length; i++) {
      num(out, pts[i]![0] - pts[i - 1]![0], i === 1);
      num(out, pts[i]![1] - pts[i - 1]![1], false);
    }
    if (path.closed && pts.length > 2) {
      out.push('z');
      cursor[kind] = [x0, y0];
    } else cursor[kind] = pts[pts.length - 1]!;
    pathCount++;
  }
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${input.width} ${input.height}" width="${input.width}" height="${input.height}" data-unit-mm="${LOCAL_UNIT_MM}">`,
    '<g fill="none" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">',
  ];
  for (const kind of ['stair', 'door', 'window', 'wall'] as BaseKind[]) {
    const d = byKind[kind].join('');
    if (d) parts.push(`<path class="${kind}" ${KIND_STYLE[kind]} vector-effect="non-scaling-stroke" d="${d}"/>`);
  }
  parts.push('</g>');
  if (input.labels.length) {
    parts.push('<g class="labels" fill="#6b7280" font-family="sans-serif">');
    for (const t of input.labels) {
      const [x, y] = toLocal(textOrigin(t)).map((v) => Math.round(v)) as Pt;
      const size = Math.max(1, Math.round(t.height * k));
      const deg = Math.round((-t.rotation * 180) / Math.PI);
      const rot = deg % 360 !== 0 ? ` transform="rotate(${deg} ${x} ${y})"` : '';
      parts.push(`<text x="${x}" y="${y}" font-size="${size}"${rot}>${xmlEscape(t.text)}</text>`);
    }
    parts.push('</g>');
  }
  parts.push('</svg>');
  return { svg: parts.join(''), pathCount };
}

// ───────────────────────── 总流程 ─────────────────────────

export function convertDrawing(drawing: PlanDrawing, params: Partial<ConvertParams> = {}): ConvertResult {
  const t0 = Date.now();
  const p: ConvertParams = { ...DEFAULT_PARAMS, ...params, closeRadiiMm: [...(params.closeRadiiMm ?? DEFAULT_PARAMS.closeRadiiMm)] };
  const issues: ConvertIssue[] = [];
  if (drawing.stats.readErrorCode)
    issues.push({ kind: 'read_warning', message: `读图时有非致命错误（LibreDWG 错误码 ${drawing.stats.readErrorCode}），个别图元可能没读出来；转换照常进行，请对照底图核对` });

  const classCache = new Map<string, { cls: LayerClass; kind: BaseKind | null }>();
  const classOf = (layer: string) => {
    let c = classCache.get(layer);
    if (!c) {
      c = classifyLayer(layer);
      classCache.set(layer, c);
    }
    return c;
  };

  // 结构线（画进底图的与只参与围合的）
  const structural: Indexed[] = [];
  drawing.paths.forEach((path, i) => {
    const c = classOf(path.layer).cls;
    if (c !== 'base' && c !== 'room') return;
    const box = bboxOf(path.pts);
    structural.push({ i, cx: (box[0] + box[2]) / 2, cy: (box[1] + box[3]) / 2, box });
  });
  const clusters = clusterFloors(structural, (i) => classOf(drawing.paths[i]!.layer).cls === 'base', p);

  // 房号文字、区域文字、楼层标题
  const labelTexts = drawing.texts.filter((t) => classOf(t.layer).cls === 'label');
  const codeTexts: { text: PlanText; center: Pt; codes: string[] }[] = [];
  for (const t of labelTexts) {
    const codes = codesIn(t.text);
    if (codes.length) codeTexts.push({ text: t, center: textCenter(t), codes });
  }
  const titles = drawing.texts
    .map((t) => ({ t, n: floorTitleNumber(t.text), c: textCenter(t) }))
    .filter((x): x is { t: PlanText; n: number; c: Pt } => x.n !== null);

  // 每块图形是哪一层：先看图上的楼层标题（图框横向范围内、上下一个空隙之内；按距离从近到远分配，一个标题只给一块），
  // 没有标题再按房号楼层位的多数（v0.7.15 审查：个别房号换了楼层时不能让整层认错）
  const gapUnits = p.floorGapMm / p.unitMm;
  const pairs: { cluster: number; title: number; d: number }[] = [];
  clusters.forEach((cl, ci) => {
    titles.forEach((tt, ti) => {
      const [x, y] = tt.c;
      if (x < cl.frame[0] || x > cl.frame[2]) return;
      const d = y < cl.frame[1] ? cl.frame[1] - y : y > cl.frame[3] ? y - cl.frame[3] : 0;
      if (d <= gapUnits) pairs.push({ cluster: ci, title: ti, d });
    });
  });
  pairs.sort((a, b) => a.d - b.d || a.cluster - b.cluster || a.title - b.title);
  const titleOf = new Map<number, number>();
  const usedTitles = new Set<number>();
  for (const pr of pairs) {
    if (titleOf.has(pr.cluster) || usedTitles.has(pr.title)) continue;
    titleOf.set(pr.cluster, pr.title);
    usedTitles.add(pr.title);
  }
  const candidates = clusters.map((cl, idx) => {
    const digits = new Map<number, number>();
    let codeCount = 0;
    for (const ct of codeTexts) {
      if (!inBox(cl.frame, ct.center)) continue;
      for (const code of ct.codes) {
        const dgt = Number(code[1]);
        digits.set(dgt, (digits.get(dgt) ?? 0) + 1);
        codeCount++;
      }
    }
    const ti = titleOf.get(idx);
    const title = ti === undefined ? '' : titles[ti]!.t.text.replace(/\s+/g, '').slice(0, 16);
    const titleN = ti === undefined ? null : titles[ti]!.n;
    // 没有标题：楼层位多数，票数相同取小的
    let n: number | null = null;
    let best = 0;
    for (const [dgt, cnt] of [...digits].sort((a, b) => a[0] - b[0])) {
      if (cnt > best) {
        best = cnt;
        n = dgt;
      }
    }
    return { idx, cl, n: titleN ?? n, codeCount, title };
  });
  const byFloor = new Map<number, (typeof candidates)[number]>();
  for (const c of candidates) {
    const box = c.cl.frame.map((v) => Math.round(v / 1000)).join(', ');
    if (c.n === null) {
      // 零星的小块（图例、大样）不报；像一层平面那么大的才提示
      if (c.cl.basePaths >= UNKNOWN_FLOOR_REPORT_PATHS)
        issues.push({ kind: 'floor_unknown', message: `有一块图形（${c.cl.basePaths} 条结构线，图框约 [${box}] 米）没有房号也没有楼层标题，没当成楼层` });
      continue;
    }
    const prev = byFloor.get(c.n);
    if (!prev) {
      byFloor.set(c.n, c);
      continue;
    }
    const keep = c.codeCount > prev.codeCount || (c.codeCount === prev.codeCount && c.cl.basePaths > prev.cl.basePaths) ? c : prev;
    const drop = keep === c ? prev : c;
    byFloor.set(c.n, keep);
    issues.push({ kind: 'floor_duplicate', floor: `L${c.n}`, message: `L${c.n} 有两块图形，用房号多的那块；另一块（图框约 [${drop.cl.frame.map((v) => Math.round(v / 1000)).join(', ')}] 米）没用` });
  }

  const floors: ConvertedFloor[] = [];
  const rooms: ConvertedRoom[] = [];
  const usedCodeTexts = new Set<PlanText>();
  const k = p.unitMm / LOCAL_UNIT_MM;

  for (const [n, c] of [...byFloor].sort((a, b) => a[0] - b[0])) {
    const code = `L${n}`;
    const frame = c.cl.frame;
    const width = Math.ceil((frame[2] - frame[0]) * k);
    const height = Math.ceil((frame[3] - frame[1]) * k);
    const memberPaths = c.cl.members.map((m) => drawing.paths[m.i]!);

    // 房号：落在这层图框里的编码文字
    const seeds: Seed[] = [];
    for (const ct of codeTexts) {
      if (!inBox(frame, ct.center)) continue;
      usedCodeTexts.add(ct.text);
      for (const cd of ct.codes) {
        seeds.push({ code: cd, label: ct.text.text.slice(0, 60), at: ct.center });
        if (Number(cd[1]) !== n) issues.push({ kind: 'code_floor_digit', floor: code, code: cd, message: `${cd} 在 ${code} 的图上，但编码的楼层位是 ${cd[1]}` });
      }
    }

    let outcomes = new Map<string, RoomOutcome>();
    if (seeds.length) {
      const grid = rasterize(memberPaths, frame, p);
      const corridors = labelTexts.filter((t) => CORRIDOR_RE.test(t.text.replace(/\s+/g, ''))).map(textCenter).filter((pt) => inBox(frame, pt));
      outcomes = detectRooms(grid, seeds, corridors, p);
    } else {
      issues.push({ kind: 'floor_no_codes', floor: code, message: `${code} 的图上没有房号，只出底图` });
    }
    const seen = new Set<string>();
    for (const s of seeds) {
      if (seen.has(s.code)) continue;
      seen.add(s.code);
      const o = outcomes.get(s.code) ?? { status: 'no_seed' as const, with: [], closeMm: null, polygon: null, areaM2: null };
      const [lx, ly] = [(s.at[0] - frame[0]) * k, (frame[3] - s.at[1]) * k];
      rooms.push({ floor: code, code: s.code, label: s.label, status: o.status, with: o.with, closeMm: o.closeMm, polygon: o.polygon, labelAt: [Math.round(lx), Math.round(ly)], areaM2: o.areaM2 });
    }

    // 底图：结构层的线 + 不带编码的区域文字（编码由房间轮廓那一层显示）
    const svgPaths = memberPaths
      .map((path) => ({ path, c: classOf(path.layer) }))
      .filter((x) => x.c.cls === 'base' && x.c.kind)
      .map((x) => ({ kind: x.c.kind!, path: x.path }));
    const svgLabels = labelTexts.filter((t) => !codesIn(t.text).length && inBox(frame, textCenter(t)));
    let built = buildSvg({ frame, width, height, paths: svgPaths, labels: svgLabels }, p, p.simplifyMm, 1);
    for (const [tol, round] of [
      [p.simplifyMm * 2, 2],
      [p.simplifyMm * 4, 5],
    ] as const) {
      if (Buffer.byteLength(built.svg) <= p.svgBudgetBytes) break;
      built = buildSvg({ frame, width, height, paths: svgPaths, labels: svgLabels }, p, tol, round);
    }
    const svgBytes = Buffer.byteLength(built.svg);
    if (svgBytes > p.svgBudgetBytes)
      issues.push({ kind: 'svg_over_budget', floor: code, message: `${code} 的底图 ${(svgBytes / 1e6).toFixed(2)} MB，超过 ${(p.svgBudgetBytes / 1e6).toFixed(1)} MB` });
    floors.push({
      code,
      title: c.title,
      frame: frame.map((v) => Math.round(v)) as Box,
      width,
      height,
      svg: built.svg,
      svgBytes,
      pathCount: built.pathCount,
      labelCount: svgLabels.length,
      roomCount: seeds.length ? new Set(seeds.map((s) => s.code)).size : 0,
    });
  }

  // 落在所有楼层图框外的编码文字
  for (const ct of codeTexts) {
    if (usedCodeTexts.has(ct.text)) continue;
    for (const cd of ct.codes) issues.push({ kind: 'code_outside', code: cd, message: `「${ct.text.text.slice(0, 30)}」不在任何一层的图框里，没处理` });
  }
  // 同一个编码出现在两层
  const codeFloors = new Map<string, string[]>();
  for (const r of rooms) codeFloors.set(r.code, [...(codeFloors.get(r.code) ?? []), r.floor]);
  for (const r of rooms) if (codeFloors.get(r.code)!.length > 1) Object.assign(r, { status: 'duplicate', with: [], polygon: null, areaM2: null, closeMm: null });

  const layers: LayerReport[] = Object.entries(drawing.layerCounts)
    .map(([name, count]) => ({ name, ...classOf(name), count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return {
    converter: CONVERTER_VERSION,
    params: p,
    localUnitMm: LOCAL_UNIT_MM,
    source: {
      entities: drawing.stats.entities,
      layers: drawing.stats.layers,
      inserts: drawing.stats.inserts,
      paths: drawing.paths.length,
      texts: drawing.texts.length,
      skipped: drawing.stats.skipped,
      ...(drawing.stats.readErrorCode ? { readErrorCode: drawing.stats.readErrorCode } : {}),
    },
    layers,
    floors,
    rooms: rooms.sort((a, b) => a.floor.localeCompare(b.floor) || a.code.localeCompare(b.code)),
    issues,
    convertMs: Date.now() - t0,
  };
}
