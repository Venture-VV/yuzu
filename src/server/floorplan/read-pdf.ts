// 读 PDF（RQ-004 第二段的 PDF 输入）：用 Mozilla 的 pdf.js（pdfjs-dist 的 legacy 版，能在 Node 里跑，Apache-2.0，版本在
// package.json 里固定）读出每页的路径（操作列表）与文字（文字内容），换成中性图元（model.ts），之后与 DWG / DXF 走同样的转换。
// 只认矢量 PDF：扫描件（只有图片）、文字转成了曲线的（认不出房号）直接拒绝。
//
// · 单位：PDF 的点（1/72 英寸）→ 纸上的毫米（25.4 / 72）→ 按图纸比例 1:N 换成实际毫米。N 先认图上的比例文字（「1:100」
//   「比例 1：150」「SCALE 1:200」，取出现最多的），认不出用上传时填的比例，都没有拒绝。
// · 坐标：按页面显示的方向（含 /Rotate、裁剪框），y 朝上（与 CAD 一样）。每页一块图形，页与页横向隔开 50 米以上，转换按空隙
//   （≥ 20 米）分楼层时自然分开，页上的楼层标题（L3、3F、三层）就给这一层定楼层。整个落在页面外（被裁掉）的线与文字不要。
// · 线：描边与填充的路径都当轮廓（墙常画成填充的色块），曲线折成纸上约 1 毫米一段，只做裁剪的路径不要；图片、渐变只计数。
// · 文字：位置是基线起点（ax = ay = 0），字高按文字矩阵的缩放，旋转按文字的方向。
// · 图层：PDF 带可选内容组（CAD 导出时的图层）时，在组里的线与文字用组的名字当图层（白名单照用）；不在组里的（以及没有组的 PDF）
//   线算「PDF-墙」、文字算「PDF-区域文字」。
// · pdf.js 只在转换进程里按需加载（readPdf 里导入）：它在 Node 里加载时会试着装 @napi-rs/canvas、补几个全局对象，不放进应用主进程。
//   这里只取操作列表与文字内容、不画图，没有 canvas 也能用。

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { baseLayer, type PlanDrawing, type PlanPath, type PlanText, type Pt } from './model';

/** 没有图层（不在可选内容组里）的线、文字放在这两个图层上：线按墙参与围合，文字按区域文字认房号 */
export const PDF_PATH_LAYER = 'PDF-墙';
export const PDF_TEXT_LAYER = 'PDF-区域文字';

/** 图纸比例 1:N 的 N 的上限 */
export const MAX_PDF_SCALE = 10_000;
/** 页与页之间横向至少隔这么远（实际毫米），比转换分楼层的空隙（20 米）大得多 */
const PAGE_GAP_MM = 50_000;
/** 1 点 = 25.4 / 72 毫米（纸上） */
const MM_PER_PT = 25.4 / 72;
/** 曲线折线：纸上约 1 毫米一段，最多 64 段 */
const CURVE_STEP_PT = 72 / 25.4;
const MAX_CURVE_SEGMENTS = 64;
/** 判断落没落在页面里的容差（点） */
const PAGE_TOLERANCE_PT = 1;

/** pdf.js 6.x 的 constructPath 参数 [画法, [路径], 外框]，路径按这几个编码排（固定版本 6.4.299，pdf.js 没有公开这组常量） */
const DRAW_MOVE = 0;
const DRAW_LINE = 1;
const DRAW_CURVE = 2;
const DRAW_QUAD = 3;
const DRAW_CLOSE = 4;

/** 文件头「%PDF-」（规范允许前面有少量别的字节，阅读器在前 1024 字节里找） */
export function isPdf(bytes: Uint8Array): boolean {
  return new TextDecoder('latin1').decode(bytes.subarray(0, 1024)).includes('%PDF-');
}

// ───────────────────────── 图纸比例 ─────────────────────────

/** 「1:100」「1：150」：前面不能紧挨数字（11:30 这样的时间），后面不能还有数字或冒号；N 不带前导零（1:05 不算） */
const SCALE_RE = /(?<![\d.])1\s*[:：]\s*([1-9]\d{0,4})(?!\d)(?!\.\d)(?!\s*[:：]\s*\d)/g;
const SCALE_WORD_RE = /(?:比例|SCALE)\s*[:：=]?\s*$/i;

export const validScale = (n: number) => Number.isFinite(n) && n >= 1 && n <= MAX_PDF_SCALE;

/**
 * 从图上的文字认图纸比例 1:N：取出现最多的 N；一样多时先取前面写了「比例 / SCALE」的，再取大的
 * （平面图的比例一般比坡度 1:12 一类大）。没有返回 null。
 */
export function scaleFromTexts(texts: Iterable<string>): number | null {
  const tally = new Map<number, { count: number; word: boolean }>();
  for (const text of texts) {
    for (const m of text.matchAll(SCALE_RE)) {
      const n = Number(m[1]);
      if (!validScale(n)) continue;
      const e = tally.get(n) ?? { count: 0, word: false };
      e.count++;
      if (SCALE_WORD_RE.test(text.slice(0, m.index))) e.word = true;
      tally.set(n, e);
    }
  }
  let best: [number, { count: number; word: boolean }] | null = null;
  for (const entry of tally) {
    const [n, e] = entry;
    if (!best || e.count > best[1].count || (e.count === best[1].count && (Number(e.word) - Number(best[1].word) || n - best[0]) > 0)) best = entry;
  }
  return best ? best[0] : null;
}

// ───────────────────────── 几何小工具 ─────────────────────────

/** 2D 仿射变换 [a b c d e f]：x' = a x + c y + e，y' = b x + d y + f（与 PDF、pdf.js 的写法相同） */
type Mat = [number, number, number, number, number, number];
const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];
/** m ∘ n：先 n 后 m（PDF 的 cm：新的 CTM = 旧的 CTM ∘ 矩阵） */
const multiply = (m: Mat, n: ArrayLike<number>): Mat => [
  m[0] * n[0]! + m[2] * n[1]!,
  m[1] * n[0]! + m[3] * n[1]!,
  m[0] * n[2]! + m[2] * n[3]!,
  m[1] * n[2]! + m[3] * n[3]!,
  m[0] * n[4]! + m[2] * n[5]! + m[4],
  m[1] * n[4]! + m[3] * n[5]! + m[5],
];
const apply = (m: Mat, x: number, y: number): Pt => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const isMatrix = (v: unknown): v is ArrayLike<number> =>
  !!v && typeof v === 'object' && (v as ArrayLike<number>).length === 6 && Array.from(v as ArrayLike<number>).every(Number.isFinite);

function cubicTo(out: number[], x0: number, y0: number, [x1, y1]: Pt, [x2, y2]: Pt, [x3, y3]: Pt) {
  const len = Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2);
  const n = Math.max(2, Math.min(MAX_CURVE_SEGMENTS, Math.ceil(len / CURVE_STEP_PT)));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    out.push(a * x0 + b * x1 + c * x2 + d * x3, a * y0 + b * y1 + c * y2 + d * y3);
  }
}

function quadTo(out: number[], x0: number, y0: number, [x1, y1]: Pt, [x2, y2]: Pt) {
  const len = Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1);
  const n = Math.max(2, Math.min(MAX_CURVE_SEGMENTS, Math.ceil(len / CURVE_STEP_PT)));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push(u * u * x0 + 2 * u * t * x1 + t * t * x2, u * u * y0 + 2 * u * t * y1 + t * t * y2);
  }
}

// ───────────────────────── 读一页 ─────────────────────────

/** 一页读出来的东西，坐标是这一页纸上的点（原点在页面左下角、y 朝上，已按页面的显示方向转好） */
interface RawPath {
  layer: string;
  /** x0, y0, x1, y1… */
  xy: number[];
  closed: boolean;
}
interface RawText {
  layer: string;
  text: string;
  x: number;
  y: number;
  height: number;
  rotation: number;
}
interface RawPage {
  width: number;
  height: number;
  paths: RawPath[];
  texts: RawText[];
}

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

/** 文字内容与操作列表对字时往后找多远（字数）：偶尔有对不上的字，不至于每段都把后面全扫一遍 */
const ALIGN_WINDOW = 4096;
/** 对字时不算的字：空白、零宽字符、软连字符（文字内容会去掉或换成空格） */
const SKIP_CHAR = new RegExp('[\\s\\u00ad\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\ufeff]');
const strip = (s: string) => {
  let out = '';
  for (let i = 0; i < s.length; i++) if (!SKIP_CHAR.test(s[i]!)) out += s[i];
  return out;
};

/** 可选内容（图层）引用 → 组的 id（组合的可选内容取第一个组） */
function ocgId(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as { id?: unknown; ids?: unknown; expression?: unknown };
  if (typeof d.id === 'string') return d.id;
  if (Array.isArray(d.ids) && typeof d.ids[0] === 'string') return d.ids[0];
  // 可见性表达式 ["And", "12R", ["Not", "13R"]]：第一项是运算符
  const first = (e: unknown): string | null => {
    if (!Array.isArray(e)) return null;
    for (let i = 1; i < e.length; i++) {
      const v: unknown = e[i];
      const r = typeof v === 'string' ? v : first(v);
      if (r) return r;
    }
    return null;
  };
  return first(d.expression);
}

interface PageCounts {
  layerCounts: Record<string, number>;
  skipped: Record<string, number>;
}

async function readPage(pdfjs: PdfJs, page: PDFPageProxy, ocgName: (id: string) => string | null, counts: PageCounts): Promise<RawPage> {
  const { OPS } = pdfjs;
  const vp = page.getViewport({ scale: 1 });
  // 视口坐标 y 朝下，再翻成 y 朝上：页面左下角是原点
  const toPage = multiply([1, 0, 0, -1, 0, vp.height], vp.transform);
  const width = vp.width;
  const height = vp.height;
  const onPage = (x0: number, y0: number, x1: number, y1: number) =>
    x1 >= -PAGE_TOLERANCE_PT && y1 >= -PAGE_TOLERANCE_PT && x0 <= width + PAGE_TOLERANCE_PT && y0 <= height + PAGE_TOLERANCE_PT;
  const count = (layer: string | null, type?: string) => {
    if (layer) counts.layerCounts[layer] = (counts.layerCounts[layer] ?? 0) + 1;
    if (type) counts.skipped[type] = (counts.skipped[type] ?? 0) + 1;
  };

  const paths: RawPath[] = [];
  const fills = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const images = new Set(
    [
      'paintImageXObject',
      'paintImageXObjectRepeat',
      'paintInlineImageXObject',
      'paintInlineImageXObjectGroup',
      'paintImageMaskXObject',
      'paintImageMaskXObjectGroup',
      'paintImageMaskXObjectRepeat',
      'paintSolidColorImageMask',
      'paintJpegXObject',
    ]
      .map((name) => (OPS as Record<string, number>)[name])
      .filter((v): v is number => typeof v === 'number'),
  );

  /** 一个路径对象可能有好几段（子路径），每段一条线 */
  const addPath = (args: unknown[], m: Mat, layer: string | null) => {
    const [paint, holder] = args as [number, unknown];
    // 「n」只做裁剪、不画
    if (paint === OPS.endPath) return;
    const data = Array.isArray(holder) ? (holder[0] as ArrayLike<number> | null) : null;
    if (!data || typeof data.length !== 'number') return;
    // 填充的每段都自动闭合
    const filled = fills.has(paint);
    const target = layer ?? PDF_PATH_LAYER;
    let cur: number[] = [];
    /** 当前点（还没有当前点时，画线、画曲线的第一个点当起点，与画布的做法相同） */
    let has = false;
    let px = 0;
    let py = 0;
    let sx = 0;
    let sy = 0;
    const flush = (closed: boolean) => {
      const xy = cur;
      cur = [];
      // 去掉相邻的重复点；闭合的线不重复记起点
      const pts: number[] = [];
      for (let i = 0; i + 1 < xy.length; i += 2) {
        const n = pts.length;
        if (n && Math.abs(pts[n - 2]! - xy[i]!) < 1e-9 && Math.abs(pts[n - 1]! - xy[i + 1]!) < 1e-9) continue;
        pts.push(xy[i]!, xy[i + 1]!);
      }
      const isClosed = closed || filled;
      if (isClosed && pts.length > 4 && Math.abs(pts[0]! - pts[pts.length - 2]!) < 1e-9 && Math.abs(pts[1]! - pts[pts.length - 1]!) < 1e-9) pts.length -= 2;
      if (pts.length < 4 || !pts.every(Number.isFinite)) return;
      let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
      for (let i = 0; i < pts.length; i += 2) {
        x0 = Math.min(x0, pts[i]!);
        x1 = Math.max(x1, pts[i]!);
        y0 = Math.min(y0, pts[i + 1]!);
        y1 = Math.max(y1, pts[i + 1]!);
      }
      if (!onPage(x0, y0, x1, y1)) return;
      paths.push({ layer: target, xy: pts, closed: isClosed });
      count(target);
    };
    const moveTo = ([x, y]: Pt) => {
      flush(false);
      cur = [x, y];
      [px, py, sx, sy] = [x, y, x, y];
      has = true;
    };
    /** 画线、画曲线前：接着当前点画；闭合之后接着画的从这一段的起点另起一段 */
    const start = (first: Pt) => {
      if (!has) moveTo(first);
      else if (!cur.length) cur = [px, py];
    };
    for (let k = 0; k < data.length; ) {
      switch (data[k++]) {
        case DRAW_MOVE:
          moveTo(apply(m, data[k]!, data[k + 1]!));
          k += 2;
          break;
        case DRAW_LINE: {
          const end = apply(m, data[k]!, data[k + 1]!);
          k += 2;
          start(end);
          cur.push(...end);
          [px, py] = end;
          break;
        }
        case DRAW_CURVE: {
          const c1 = apply(m, data[k]!, data[k + 1]!);
          const c2 = apply(m, data[k + 2]!, data[k + 3]!);
          const end = apply(m, data[k + 4]!, data[k + 5]!);
          k += 6;
          start(c1);
          cubicTo(cur, px, py, c1, c2, end);
          [px, py] = end;
          break;
        }
        case DRAW_QUAD: {
          const c1 = apply(m, data[k]!, data[k + 1]!);
          const end = apply(m, data[k + 2]!, data[k + 3]!);
          k += 4;
          start(c1);
          quadTo(cur, px, py, c1, end);
          [px, py] = end;
          break;
        }
        case DRAW_CLOSE:
          flush(true);
          // 闭合后当前点回到这一段的起点
          px = sx;
          py = sy;
          break;
        default:
          // 认不出的编码（数据损坏）：这个路径对象后面的不要了
          cur = [];
          return;
      }
    }
    flush(false);
  };

  const ops = await page.getOperatorList({ annotationMode: pdfjs.AnnotationMode.DISABLE });
  const hasLayers = ocgName !== noLayers;
  let ctm: Mat = IDENTITY;
  const ctmStack: Mat[] = [];
  /** 标记内容的嵌套：可选内容（图层）给组的名字，其余为 null；取最里面的一个组 */
  const marked: (string | null)[] = [];
  const layerNow = () => {
    for (let i = marked.length - 1; i >= 0; i--) if (marked[i]) return marked[i]!;
    return null;
  };
  /** 操作列表里显示的字（去掉空白）与各自所在的图层：按顺序与文字内容对上，给每段文字找图层 */
  const glyphChars: string[] = [];
  const glyphLayers: (string | null)[] = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i]!;
    const args = (ops.argsArray[i] ?? []) as unknown[];
    switch (fn) {
      case OPS.save:
        ctmStack.push(ctm);
        break;
      case OPS.restore:
        ctm = ctmStack.pop() ?? ctm;
        break;
      case OPS.transform:
        if (isMatrix(args)) ctm = multiply(ctm, args);
        break;
      case OPS.paintFormXObjectBegin:
        // 表单（块）：先存一层，再乘上表单自己的矩阵
        ctmStack.push(ctm);
        if (isMatrix(args[0])) ctm = multiply(ctm, args[0]);
        break;
      case OPS.paintFormXObjectEnd:
        ctm = ctmStack.pop() ?? ctm;
        break;
      case OPS.beginMarkedContent:
        marked.push(null);
        break;
      case OPS.beginMarkedContentProps: {
        const id = args[0] === 'OC' ? ocgId(args[1]) : null;
        marked.push(id ? ocgName(id) : null);
        break;
      }
      case OPS.endMarkedContent:
        marked.pop();
        break;
      case OPS.constructPath:
        addPath(args, multiply(toPage, ctm), layerNow());
        break;
      case OPS.showText:
        if (hasLayers && Array.isArray(args[0])) {
          const layer = layerNow();
          for (const glyph of args[0] as unknown[]) {
            const u = glyph && typeof glyph === 'object' ? (glyph as { unicode?: unknown }).unicode : null;
            if (typeof u !== 'string') continue;
            for (let j = 0; j < u.length; j++) {
              if (SKIP_CHAR.test(u[j]!)) continue;
              glyphChars.push(u[j]!);
              glyphLayers.push(layer);
            }
          }
        }
        break;
      case OPS.shadingFill:
        count(layerNow(), 'SHADING');
        break;
      default:
        if (images.has(fn)) count(layerNow(), 'IMAGE');
    }
  }

  const texts: RawText[] = [];
  const content = await page.getTextContent({ disableNormalization: true });
  const trail = glyphChars.join('');
  let ptr = 0;
  for (const item of content.items) {
    if (!('str' in item)) continue;
    const text = item.str.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    // 图层：这段字在操作列表里第一次出现（从上一段之后、往后最多找 4096 个字）的位置所在的组；对不上的不归组
    let layer: string | null = null;
    if (hasLayers) {
      const key = strip(text);
      const found = !key ? -1 : trail.startsWith(key, ptr) ? 0 : trail.slice(ptr, ptr + key.length + ALIGN_WINDOW).indexOf(key);
      if (found >= 0) {
        layer = glyphLayers[ptr + found] ?? null;
        ptr += found + key.length;
      }
    }
    const [a, b, c, d, e, f] = item.transform as number[];
    if (![a, b, c, d, e, f].every((v) => Number.isFinite(v))) continue;
    const [x, y] = apply(toPage, e!, f!);
    if (!onPage(x, y, x, y)) continue;
    const [ux, uy] = apply(toPage, e! + a!, f! + b!);
    const [vx, vy] = apply(toPage, e! + c!, f! + d!);
    const target = layer ?? PDF_TEXT_LAYER;
    texts.push({ layer: target, text, x, y, height: Math.hypot(vx - x, vy - y) || item.height || 1, rotation: Math.atan2(uy - y, ux - x) });
    count(target);
  }
  return { width, height, paths, texts };
}

/** 没有可选内容组的 PDF */
const noLayers = () => null;

// ───────────────────────── 读整份 ─────────────────────────

/** pdf.js 自带的 CMap（中文等预定义编码的字体要用）、标准字体与 WebAssembly 解码器：按包的位置找（路径要以 / 结尾） */
function assetUrls() {
  const dir = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  return {
    cMapUrl: `${join(dir, 'cmaps')}/`,
    cMapPacked: true,
    standardFontDataUrl: `${join(dir, 'standard_fonts')}/`,
    wasmUrl: `${join(dir, 'wasm')}/`,
  };
}

const round2 = (v: number) => Math.round(v * 100) / 100 + 0;

/** 读 PDF 文件内容；opts.scale 是上传时填的图纸比例 1:N 的 N（图上认不出比例时才用）。读不了或不能转换的抛错 */
export async function readPdf(bytes: Uint8Array, opts: { scale?: number } = {}): Promise<PlanDrawing> {
  if (opts.scale !== undefined && !validScale(opts.scale)) throw new Error(`图纸比例要在 1 到 ${MAX_PDF_SCALE} 之间（1:100 就填 100）`);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // 复制一份交给 pdf.js：它会把传进去的内存转给（同一进程里的）解析线程，原来的就不能用了；也不收 Node 的 Buffer
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: pdfjs.VerbosityLevel.ERRORS, ...assetUrls() });
  const pages: RawPage[] = [];
  const counts: PageCounts = { layerCounts: {}, skipped: {} };
  const layerNames = new Set<string>();
  try {
    let doc: Awaited<typeof task.promise>;
    try {
      doc = await task.promise;
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'PasswordException') throw new Error('这个 PDF 设了打开密码，请另存一份不带密码的再上传');
      throw new Error(`读不了这个 PDF：文件损坏或不是 PDF（${error instanceof Error ? error.message : String(error)}）`.slice(0, 300));
    }
    // 可选内容组（图层）：id → 名字（去掉外部参照绑定的前缀，与 DWG 一样）
    const groups = new Map<string, string>();
    try {
      const config = await doc.getOptionalContentConfig();
      for (const [id, group] of config as Iterable<[string, { name?: unknown }]>) {
        const name = typeof group?.name === 'string' ? baseLayer(group.name) : '';
        if (name) {
          groups.set(id, name);
          layerNames.add(name);
        }
      }
    } catch {
      // 可选内容的定义坏了：当没有图层
    }
    const ocgName = groups.size ? (id: string) => groups.get(id) ?? null : noLayers;
    for (let p = 1; p <= doc.numPages; p++) {
      let page: PDFPageProxy | null = null;
      try {
        page = await doc.getPage(p);
        pages.push(await readPage(pdfjs, page, ocgName, counts));
      } catch (error) {
        throw new Error(`读不了这个 PDF 的第 ${p} 页：${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
      } finally {
        // 一页读完就放掉这一页的解析结果（大图纸页数多时不攒内存）
        page?.cleanup();
      }
    }
  } finally {
    await task.destroy().catch(() => {});
  }

  const pathCount = pages.reduce((n, pg) => n + pg.paths.length, 0);
  const textCount = pages.reduce((n, pg) => n + pg.texts.length, 0);
  if (!pathCount) {
    const img = counts.skipped.IMAGE ?? 0;
    throw new Error(
      `PDF 里没有矢量线条${img ? `（只有 ${img} 张图片）` : ''}，可能是扫描件或图片转成的 PDF，转换不了；请让设计方从 CAD 导出矢量 PDF，或直接上传 DWG / DXF`,
    );
  }
  if (!textCount) throw new Error('PDF 里没有可读的文字（可能导出时把文字转成了曲线），认不出房号；请导出时保留文字，或直接上传 DWG / DXF');
  const fromText = scaleFromTexts(pages.flatMap((pg) => pg.texts.map((t) => t.text)));
  const scale = fromText ?? opts.scale;
  if (scale === undefined) throw new Error('PDF 上没有认出图纸比例（如 1:100），请在上传时填写比例');

  // 纸上的点 → 实际毫米；页与页横向排开
  const k = MM_PER_PT * scale;
  const paths: PlanPath[] = [];
  const texts: PlanText[] = [];
  let offset = 0;
  for (const pg of pages) {
    for (const p of pg.paths) {
      const pts: Pt[] = [];
      for (let i = 0; i < p.xy.length; i += 2) pts.push([round2(offset + p.xy[i]! * k), round2(p.xy[i + 1]! * k)]);
      paths.push({ layer: p.layer, pts, closed: p.closed });
    }
    for (const t of pg.texts) {
      texts.push({
        layer: t.layer,
        text: t.text,
        x: round2(offset + t.x * k),
        y: round2(t.y * k),
        height: round2(t.height * k),
        rotation: Math.round(t.rotation * 1e9) / 1e9 + 0,
        ax: 0,
        ay: 0,
      });
    }
    offset += pg.width * k + PAGE_GAP_MM;
  }
  for (const name of Object.keys(counts.layerCounts)) layerNames.add(name);
  const skippedTotal = Object.values(counts.skipped).reduce((a, b) => a + b, 0);
  return {
    paths,
    texts,
    layerCounts: counts.layerCounts,
    stats: {
      entities: paths.length + texts.length + skippedTotal,
      layers: layerNames.size,
      inserts: 0,
      skipped: counts.skipped,
      pdf: { pages: pages.length, scale, scaleFrom: fromText !== null ? 'text' : 'option' },
    },
  };
}
