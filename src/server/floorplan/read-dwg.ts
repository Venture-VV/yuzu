// 读 DWG（RQ-004 第二段，v0.7.15）：用开源 LibreDWG 的 WebAssembly 版（@mlightcad/libredwg-web，GPL-3.0，版本在
// package.json 里固定）把 DWG 读成图元，再换成中性图元（model.ts）。
// 只在转换进程里用（floorplan/worker.ts、cli 的 floorplan-convert）：读一份 13 MB 的编码图要 20 多秒、约 1 GB 内存，
// 不能放在应用主进程里；也让 GPL 的库与应用分开运行。门店系统只在店主自己的服务器上用，不对外分发。
//
// fromDwgDatabase 是纯函数（测试用合成的对象喂它）；readDwg 只负责加载 WebAssembly、读文件。

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { baseLayer, type PlanDrawing, type PlanPath, type PlanText, type Pt } from './model';

// ───────────────────────── 与 libredwg-web 输出相符的最小类型（只用到的字段） ─────────────────────────

interface P {
  x: number;
  y: number;
}
interface DwgEntityLike {
  type: string;
  layer: string;
  [key: string]: unknown;
}
export interface DwgDatabaseLike {
  entities: DwgEntityLike[];
  tables: {
    LAYER: { entries: { name: string }[] };
    BLOCK_RECORD: { entries: { name: string; basePoint?: P; entities?: DwgEntityLike[] }[] };
  };
}

/** 2D 仿射变换 [a b c d e f]：x' = a x + c y + e，y' = b x + d y + f */
type Mat = [number, number, number, number, number, number];
const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];
const MIRROR_X: Mat = [-1, 0, 0, 1, 0, 0];
const apply = (m: Mat, x: number, y: number): Pt => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const multiply = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
/** 块参照：先减基点，再缩放、旋转，最后移到插入点 */
const insertMatrix = (at: P, sx: number, sy: number, rot: number, base: P): Mat => {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const m: Mat = [c * sx, s * sx, -s * sy, c * sy, at.x, at.y];
  return multiply(m, [1, 0, 0, 1, -base.x, -base.y]);
};
const rotationOf = (m: Mat) => Math.atan2(m[1], m[0]);
const scaleOf = (m: Mat) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;

/** 坐标离谱（图纸里偶尔有几十万公里外的游离图元）的不要 */
const FAR = 1e8;
const sane = (pts: Pt[]) => pts.length > 0 && pts.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) < FAR && Math.abs(y) < FAR);

/** 圆弧折线：每段最多 10°（大圆弧）或弦长不超过约 100 个图纸单位 */
function arcPoints(cx: number, cy: number, r: number, a0: number, a1: number): Pt[] {
  let sweep = a1 - a0;
  while (sweep <= 0) sweep += Math.PI * 2;
  const n = Math.max(2, Math.min(72, Math.ceil(Math.max(sweep / (Math.PI / 18), (r * sweep) / 100))));
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

/** 多段线的一段带凸度（bulge = tan(θ/4)）：折成圆弧 */
function bulgeSegment(p: Pt, q: Pt, bulge: number): Pt[] {
  if (!bulge || Math.abs(bulge) < 1e-9) return [q];
  const theta = 4 * Math.atan(bulge);
  const chord = Math.hypot(q[0] - p[0], q[1] - p[1]);
  if (chord < 1e-9) return [q];
  const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
  const mx = (p[0] + q[0]) / 2;
  const my = (p[1] + q[1]) / 2;
  const d = Math.sqrt(Math.max(0, r * r - (chord / 2) ** 2));
  // 圆心在弦的左边（逆时针，bulge > 0）或右边
  const nx = -(q[1] - p[1]) / chord;
  const ny = (q[0] - p[0]) / chord;
  const sign = (bulge > 0 ? 1 : -1) * (Math.abs(theta) > Math.PI ? -1 : 1);
  const cx = mx + sign * nx * d;
  const cy = my + sign * ny * d;
  const a0 = Math.atan2(p[1] - cy, p[0] - cx);
  const a1 = Math.atan2(q[1] - cy, q[0] - cx);
  const pts = bulge > 0 ? arcPoints(cx, cy, r, a0, a1) : arcPoints(cx, cy, r, a1, a0).reverse();
  return pts.slice(1);
}

/** 多行文字去掉格式代码：\P 换行、{\f…;} 字体、\H…; 字高等 */
export function plainMText(raw: string): string {
  return raw
    .replace(/\\[Pp]/g, ' ')
    .replace(/\\[A-Za-z][^;\\{}]*;/g, '')
    .replace(/\\[~]/g, ' ')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function fromDwgDatabase(db: DwgDatabaseLike): PlanDrawing {
  const paths: PlanPath[] = [];
  const texts: PlanText[] = [];
  const layerCounts: Record<string, number> = {};
  const skipped: Record<string, number> = {};
  const blocks = new Map(db.tables.BLOCK_RECORD.entries.map((b) => [b.name, b]));
  let inserts = 0;

  const count = (layer: string) => {
    layerCounts[layer] = (layerCounts[layer] ?? 0) + 1;
  };
  const skip = (type: string) => {
    skipped[type] = (skipped[type] ?? 0) + 1;
  };
  const addPath = (layer: string, pts: Pt[], closed: boolean) => {
    // 闭合的线不重复记起点
    if (closed && pts.length > 2) {
      const [a, b] = [pts[0]!, pts[pts.length - 1]!];
      if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) pts = pts.slice(0, -1);
    }
    if (pts.length >= 2 && sane(pts)) paths.push({ layer, pts, closed });
  };
  const addText = (layer: string, text: string, at: P | undefined, height: number, rotation: number, m: Mat, ax = 0, ay = 0) => {
    const t = text.trim();
    if (!t || !at) return;
    const [x, y] = apply(m, at.x, at.y);
    if (!sane([[x, y]])) return;
    texts.push({ layer, text: t, x, y, height: (height || 1) * scaleOf(m), rotation: (rotation || 0) + rotationOf(m), ax, ay });
  };
  /** 单行文字（含块属性）：左对齐、对齐（aligned）、布满（fit）用第一对齐点，其余用第二对齐点 */
  const addSingleLine = (layer: string, e: Record<string, unknown>, m: Mat) => {
    const h = Number(e.halign ?? 0);
    const v = Number(e.valign ?? 0);
    const end = e.endPoint as P | undefined;
    const useEnd = (h === 1 || h === 2 || h === 4 || v !== 0) && end && (end.x !== 0 || end.y !== 0);
    const ax = useEnd ? (h === 2 ? 1 : h === 1 || h === 4 ? 0.5 : 0) : 0;
    const ay = useEnd ? (h === 4 || v === 2 ? 0.5 : v === 3 ? 1 : 0) : 0;
    addText(layer, String(e.text ?? ''), useEnd ? end : (e.startPoint as P), e.textHeight as number, e.rotation as number, m, ax, ay);
  };

  const visit = (e: DwgEntityLike, parent: Mat, parentLayer: string | null, depth: number) => {
    // 块里画在 0 层上的图元随块参照所在的图层（AutoCAD 的约定）
    const layer = baseLayer(e.layer === '0' && parentLayer ? parentLayer : e.layer);
    if (e.isVisible === false) return;
    count(layer);
    // 拉伸方向朝 -Z 的平面图元（镜像出来的圆弧、块参照常见）：它的坐标系 x 轴反向
    const ext = e.extrusionDirection as { z?: number } | undefined;
    const m = ext && typeof ext.z === 'number' && ext.z < 0 ? multiply(parent, MIRROR_X) : parent;
    const tf = (pts: Pt[]) => pts.map(([x, y]) => apply(m, x, y));
    switch (e.type) {
      case 'LINE': {
        const s = e.startPoint as P;
        const t = e.endPoint as P;
        addPath(layer, tf([[s.x, s.y], [t.x, t.y]]), false);
        return;
      }
      case 'LWPOLYLINE': {
        const v = (e.vertices as (P & { bulge?: number })[]) ?? [];
        if (v.length < 2) return;
        const closed = ((e.flag as number) & 512) !== 0;
        const pts: Pt[] = [[v[0]!.x, v[0]!.y]];
        const n = closed ? v.length : v.length - 1;
        for (let i = 0; i < n; i++) {
          const a = v[i]!;
          const b = v[(i + 1) % v.length]!;
          pts.push(...bulgeSegment([a.x, a.y], [b.x, b.y], a.bulge ?? 0));
        }
        addPath(layer, tf(pts), closed);
        return;
      }
      case 'POLYLINE2D':
      case 'POLYLINE3D': {
        const v = (e.vertices as (P & { bulge?: number })[]) ?? [];
        if (v.length < 2) return;
        const closed = ((e.flag as number) & 1) !== 0;
        const pts: Pt[] = [[v[0]!.x, v[0]!.y]];
        const n = closed ? v.length : v.length - 1;
        for (let i = 0; i < n; i++) {
          const a = v[i]!;
          const b = v[(i + 1) % v.length]!;
          pts.push(...bulgeSegment([a.x, a.y], [b.x, b.y], e.type === 'POLYLINE2D' ? (a.bulge ?? 0) : 0));
        }
        addPath(layer, tf(pts), closed);
        return;
      }
      case 'ARC': {
        const c = e.center as P;
        addPath(layer, tf(arcPoints(c.x, c.y, e.radius as number, e.startAngle as number, e.endAngle as number)), false);
        return;
      }
      case 'CIRCLE': {
        const c = e.center as P;
        const pts = arcPoints(c.x, c.y, e.radius as number, 0, Math.PI * 2);
        addPath(layer, tf(pts.slice(0, -1)), true);
        return;
      }
      case 'ELLIPSE': {
        const c = e.center as P;
        const maj = e.majorAxisEndPoint as P;
        const ratio = (e.axisRatio as number) || 1;
        const a = Math.hypot(maj.x, maj.y);
        const rot = Math.atan2(maj.y, maj.x);
        let t0 = (e.startAngle as number) ?? 0;
        let t1 = (e.endAngle as number) ?? Math.PI * 2;
        if (t1 <= t0) t1 += Math.PI * 2;
        const n = Math.max(8, Math.min(72, Math.ceil(((t1 - t0) / (Math.PI * 2)) * 48)));
        const pts: Pt[] = [];
        for (let i = 0; i <= n; i++) {
          const t = t0 + ((t1 - t0) * i) / n;
          const x = a * Math.cos(t);
          const y = a * ratio * Math.sin(t);
          pts.push([c.x + x * Math.cos(rot) - y * Math.sin(rot), c.y + x * Math.sin(rot) + y * Math.cos(rot)]);
        }
        addPath(layer, tf(pts), Math.abs(t1 - t0 - Math.PI * 2) < 1e-6);
        return;
      }
      case 'SPLINE': {
        // 有拟合点用拟合点，否则用控制点连线（只用来画示意底图，够用）
        const fit = (e.fitPoints as P[]) ?? [];
        const ctrl = (e.controlPoints as P[]) ?? [];
        const src = fit.length >= 2 ? fit : ctrl;
        addPath(layer, tf(src.map((p) => [p.x, p.y] as Pt)), false);
        return;
      }
      case 'TEXT':
        addSingleLine(layer, e, m);
        return;
      case 'MTEXT': {
        // 附着点 1–9：上左、上中、上右、中左……下右
        const ap = Math.min(9, Math.max(1, Number(e.attachmentPoint ?? 1) || 1)) - 1;
        const ax = [0, 0.5, 1][ap % 3]!;
        const ay = [1, 0.5, 0][Math.floor(ap / 3)]!;
        addText(layer, plainMText(String(e.text ?? '')), e.insertionPoint as P, e.textHeight as number, (e.rotation as number) ?? 0, m, ax, ay);
        return;
      }
      case 'INSERT': {
        inserts++;
        const block = blocks.get(String(e.name));
        const at = e.insertionPoint as P;
        const im = multiply(
          m,
          insertMatrix(at, (e.xScale as number) || 1, (e.yScale as number) || 1, (e.rotation as number) || 0, block?.basePoint ?? { x: 0, y: 0 }),
        );
        if (block?.entities && depth < 6) for (const child of block.entities) visit(child, im, layer, depth + 1);
        // 块属性已经是块参照所在坐标系里的位置（嵌套块里的按外层变换）
        for (const a of (e.attribs as { layer: string; text?: Record<string, unknown> }[]) ?? []) {
          if (a.text) addSingleLine(baseLayer(a.layer === '0' ? layer : a.layer), a.text, m);
        }
        return;
      }
      default:
        skip(e.type);
    }
  };

  for (const e of db.entities) visit(e, IDENTITY, null, 0);
  return {
    paths,
    texts,
    layerCounts,
    stats: { entities: db.entities.length, layers: db.tables.LAYER.entries.length, inserts, skipped },
  };
}

/** LibreDWG 的错误码：128（DWG_ERR_CRITICAL）及以上是致命错误，读出来的东西不可信 */
const DWG_ERR_CRITICAL = 128;
const unreadable = (code: number) => new Error(`读不了这个文件：不是 DWG，或版本不支持、文件损坏${code ? `（LibreDWG 错误码 ${code}）` : ''}`);

/** 读 DWG 文件内容。读不了（不是 DWG、版本不支持、文件损坏）抛错 */
export async function readDwg(bytes: Uint8Array): Promise<PlanDrawing> {
  const { Dwg_File_Type, LibreDwg } = await import('@mlightcad/libredwg-web');
  // WebAssembly 文件在包的 wasm 目录里（包的 exports 只开放主入口，按主入口的位置找）
  const require = createRequire(import.meta.url);
  const wasmDir = join(dirname(require.resolve('@mlightcad/libredwg-web')), '..', 'wasm') + '/';
  const lib = await LibreDwg.create(wasmDir);
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  // 这个库读完只在控制台打出错误码、不返回（固定版本 0.8.1 的行为），这里接住那一行
  let code = 0;
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    const m = /error code:?\s*(\d+)/i.exec(args.map(String).join(' '));
    if (m) code = Number(m[1]);
    else warn(...args);
  };
  let ptr: number;
  try {
    ptr = lib.dwg_read_data(copy, Dwg_File_Type.DWG) as number;
  } catch (error) {
    if (error instanceof Error && /out of WASM memory/i.test(error.message)) throw new Error('图纸太大，读图时内存不够；请把图纸拆小（例如只保留 L1–L3）后再上传');
    throw unreadable(code);
  } finally {
    console.warn = warn;
  }
  if (!ptr) throw unreadable(code);
  try {
    if (code >= DWG_ERR_CRITICAL) throw unreadable(code);
    const drawing = fromDwgDatabase(lib.convert(ptr) as unknown as DwgDatabaseLike);
    if (!drawing.stats.entities) throw unreadable(code);
    if (code) drawing.stats.readErrorCode = code;
    return drawing;
  } finally {
    lib.dwg_free(ptr);
  }
}
