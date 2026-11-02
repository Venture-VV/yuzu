// 底图转换的合成样例图纸（RQ-004 第二段，v0.7.15）：两层（L3、L2）、ASCII DXF、毫米。全是编的，不是门店图纸。
// 编码与 docs/data/space-ledger-sample.csv 对应，故意留了几处例外与差异，演示、测试与验收用：
//   · L3：T301、T302、T303、V312、W301、W302 配上轮廓；W303 与 W305 之间没有隔墙（连成一片）；W306 朝走道开了 3 米宽的洞（连到走廊）；
//   · L2：X201、X202；
//   · 与样例台账比对：图上多 T303、W303、W305、W306、X202，台账多 U310；T302 的原文与台账的原始标注不同（1人间 / 2人间）。
// 第二版（variant 2，演示「与在用的那一批比对」）：T303 改成 T305（同一位置换编码），W306 的洞改成门，X202 拆掉。
// 门画成块参照（门扇 + 开启弧线，画在 0 层随块参照的图层），W302 的名称用多行文字，家具画在剔除的图层上。
// 同样的两层也能画成 PDF（floorplanSamplePdf，1:100，见文件后半段），给 PDF 输入的测试与验收用。

import { textWidth } from '../floorplan/convert';

const DEG = 180 / Math.PI;

/** 两种样例图纸共用的画法：楼层的墙、门窗、文字只写一遍（floor3 / floor2），DXF 与 PDF 各自落笔 */
interface SampleSink {
  line(layer: string, x1: number, y1: number, x2: number, y2: number): void;
  rect(layer: string, x0: number, y0: number, x1: number, y1: number): void;
  /** 居中的单行文字（中心在 (x, y)） */
  text(layer: string, x: number, y: number, h: number, s: string): void;
  /** 居中的多行文字 */
  mtext(layer: string, x: number, y: number, h: number, s: string): void;
  insert(layer: string, name: string, x: number, y: number, rotationRad: number): void;
}

class DxfWriter implements SampleSink {
  private out: string[] = [];
  private pair(code: number, value: string | number) {
    this.out.push(String(code), typeof value === 'number' ? fmt(value) : value);
  }
  line(layer: string, x1: number, y1: number, x2: number, y2: number) {
    this.pair(0, 'LINE');
    this.pair(8, layer);
    this.pair(10, x1);
    this.pair(20, y1);
    this.pair(11, x2);
    this.pair(21, y2);
  }
  poly(layer: string, pts: [number, number][], closed: boolean) {
    this.pair(0, 'LWPOLYLINE');
    this.pair(8, layer);
    this.pair(90, pts.length);
    this.pair(70, closed ? 1 : 0);
    for (const [x, y] of pts) {
      this.pair(10, x);
      this.pair(20, y);
    }
  }
  rect(layer: string, x0: number, y0: number, x1: number, y1: number) {
    this.poly(layer, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], true);
  }
  arc(layer: string, cx: number, cy: number, r: number, a0: number, a1: number) {
    this.pair(0, 'ARC');
    this.pair(8, layer);
    this.pair(10, cx);
    this.pair(20, cy);
    this.pair(40, r);
    this.pair(50, a0);
    this.pair(51, a1);
  }
  /** 居中对齐的单行文字（第二对齐点在 (x, y)） */
  text(layer: string, x: number, y: number, h: number, s: string) {
    this.pair(0, 'TEXT');
    this.pair(8, layer);
    this.pair(10, x);
    this.pair(20, y);
    this.pair(40, h);
    this.pair(1, s);
    this.pair(72, 1);
    this.pair(11, x);
    this.pair(21, y);
    this.pair(73, 2);
  }
  /** 中心对齐的多行文字 */
  mtext(layer: string, x: number, y: number, h: number, s: string) {
    this.pair(0, 'MTEXT');
    this.pair(8, layer);
    this.pair(10, x);
    this.pair(20, y);
    this.pair(40, h);
    this.pair(71, 5);
    this.pair(1, s);
  }
  insert(layer: string, name: string, x: number, y: number, rotationRad: number) {
    this.pair(0, 'INSERT');
    this.pair(8, layer);
    this.pair(2, name);
    this.pair(10, x);
    this.pair(20, y);
    this.pair(50, rotationRad * DEG);
  }
  raw(code: number, value: string | number) {
    this.pair(code, value);
  }
  toString() {
    return this.out.join('\n') + '\n';
  }
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(3));

const WALL = 'A-WALL';
const DOOR = 'A-DOOR';
const LABEL = 'W-区域文字';

/** 横墙（画成墙体轮廓），openings 是门洞的 [x0, x1] */
function wallH(w: SampleSink, x0: number, x1: number, y: number, t: number, openings: [number, number][] = []) {
  let from = x0;
  for (const [a, b] of [...openings].sort((p, q) => p[0] - q[0])) {
    if (a > from) w.rect(WALL, from, y - t / 2, a, y + t / 2);
    from = b;
  }
  if (x1 > from) w.rect(WALL, from, y - t / 2, x1, y + t / 2);
}
function wallV(w: SampleSink, x: number, y0: number, y1: number, t: number, openings: [number, number][] = []) {
  let from = y0;
  for (const [a, b] of [...openings].sort((p, q) => p[0] - q[0])) {
    if (a > from) w.rect(WALL, x - t / 2, from, x + t / 2, a);
    from = b;
  }
  if (y1 > from) w.rect(WALL, x - t / 2, from, x + t / 2, y1);
}

/** 横墙上的门（900 宽）：into = 1 往北开、-1 往南开 */
function doorH(w: SampleSink, x: number, y: number, into: 1 | -1) {
  if (into === 1) w.insert(DOOR, 'DOOR900', x, y, 0);
  else w.insert(DOOR, 'DOOR900', x + 900, y, Math.PI);
}

function floor3(w: SampleSink, variant: 1 | 2) {
  // 外墙 30 × 14 米，南面一排房间，中间走道（y 6–8 米），北面一排
  wallH(w, 0, 30000, 0, 200);
  wallH(w, 0, 30000, 14000, 200);
  wallV(w, 0, 0, 14000, 200);
  wallV(w, 30000, 0, 14000, 200);
  w.rect('A-WIND', 1000, -60, 4000, 60);
  w.rect('A-WIND', 6000, -60, 9000, 60);
  // 走道南墙：每间一个门
  const south: [number, number][] = [3500, 8500, 13500, 20500, 24500, 28500].map((x) => [x, x + 900]);
  wallH(w, 0, 30000, 6000, 100, south);
  for (const [x] of south) doorH(w, x, 6000, -1);
  for (const x of [5000, 10000, 15000, 22000, 26000]) wallV(w, x, 0, 6000, 100);
  // 走道北墙：W303/W305 两个门；W306 第一版是 3 米宽的洞，第二版是门；设备间、楼梯间、布草间
  const north: [number, number][] = [
    [2000, 2900],
    [7000, 7900],
    variant === 1 ? [11000, 14000] : [12000, 12900],
    [17000, 17900],
    [21500, 22400],
    [26000, 26900],
  ];
  wallH(w, 0, 30000, 8000, 100, north);
  for (const [x0, x1] of north) if (x1 - x0 === 900) doorH(w, x0, 8000, 1);
  // W303 与 W305 之间（x = 5 米）没有隔墙
  for (const x of [10000, 15000, 20000, 24000]) wallV(w, x, 8000, 14000, 100);
  // 楼梯
  w.rect('A-STAIR', 20600, 10000, 23400, 13400);
  for (let y = 10300; y < 13400; y += 300) w.line('A-STAIR', 20600, y, 23400, y);
  // 家具（剔除的图层，不参与围合）：客房里的床
  w.rect('P-活动家具', 22500, 1000, 24500, 3000);
  w.rect('P-活动家具', 26500, 1000, 28500, 3000);
  w.line('P-活动家具', 1000, 3000, 4000, 3000);
  // 房号与房间名
  w.text(LABEL, 2500, 3000, 300, '样例 SPA T301 1人间');
  w.text(LABEL, 7500, 3000, 300, '样例 SPA T302 1人间');
  w.text(LABEL, 12500, 3000, 300, variant === 1 ? '样例 SPA T303 2人间' : '样例 SPA T305 2人间');
  w.text(LABEL, 18500, 3000, 300, '样例 V312 4人间');
  w.text(LABEL, 24000, 4500, 300, '样例客房 W301');
  w.mtext(LABEL, 28000, 4500, 300, '样例客房 W302');
  w.text(LABEL, 2500, 11000, 300, '样例客房 W303');
  w.text(LABEL, 7500, 11000, 300, '样例客房 W305');
  w.text(LABEL, 12500, 11000, 300, '样例踩背 W306');
  w.text(LABEL, 17500, 11000, 300, '设备间');
  w.text(LABEL, 27000, 11000, 300, '布草间');
  w.text(LABEL, 15000, 7000, 300, '走道');
  w.text('W-文字', 15000, -3000, 800, '三层平面图');
}

function floor2(w: SampleSink, variant: 1 | 2) {
  const ox = 80000;
  wallH(w, ox, ox + 20000, 0, 200);
  wallH(w, ox, ox + 20000, 12000, 200);
  wallV(w, ox, 0, 12000, 200);
  wallV(w, ox + 20000, 0, 12000, 200);
  const south: [number, number][] = [
    [ox + 4000, ox + 4900],
    [ox + 14000, ox + 14900],
  ];
  wallH(w, ox, ox + 20000, 5000, 100, south);
  for (const [x] of south) doorH(w, x, 5000, -1);
  // 第二版拆掉 X201 与 X202 之间的墙、去掉 X202 的编码
  if (variant === 1) wallV(w, ox + 10000, 0, 5000, 100);
  wallH(w, ox, ox + 20000, 7000, 100, [[ox + 9000, ox + 11000]]);
  w.text(LABEL, ox + 5000, 2500, 350, '样例派对房X201');
  if (variant === 1) w.text(LABEL, ox + 15000, 2500, 350, '样例派对房X202');
  w.text(LABEL, ox + 10000, 9500, 350, '大厅');
  w.text('W-文字', ox + 10000, -3000, 800, '二层平面图');
}

/** 合成样例图纸（ASCII DXF 文本） */
export function floorplanSampleDxf(variant: 1 | 2 = 1): string {
  const w = new DxfWriter();
  w.raw(999, '浴族 yuzu 底图转换合成样例（不是门店图纸）');
  w.raw(0, 'SECTION');
  w.raw(2, 'HEADER');
  w.raw(9, '$ACADVER');
  w.raw(1, 'AC1021');
  w.raw(9, '$INSUNITS');
  w.raw(70, 4);
  w.raw(0, 'ENDSEC');
  w.raw(0, 'SECTION');
  w.raw(2, 'TABLES');
  w.raw(0, 'TABLE');
  w.raw(2, 'LAYER');
  for (const name of ['0', WALL, DOOR, 'A-WIND', 'A-STAIR', LABEL, 'W-文字', 'P-活动家具']) {
    w.raw(0, 'LAYER');
    w.raw(2, name);
    w.raw(70, 0);
  }
  w.raw(0, 'ENDTAB');
  w.raw(0, 'ENDSEC');
  // 门：铰点在原点，门扇朝 +y，弧线从 0° 到 90°；画在 0 层，随块参照的图层
  w.raw(0, 'SECTION');
  w.raw(2, 'BLOCKS');
  w.raw(0, 'BLOCK');
  w.raw(8, '0');
  w.raw(2, 'DOOR900');
  w.raw(70, 0);
  w.raw(10, 0);
  w.raw(20, 0);
  w.line('0', 0, 0, 0, 900);
  w.arc('0', 0, 0, 900, 0, 90);
  w.raw(0, 'ENDBLK');
  w.raw(0, 'ENDSEC');
  w.raw(0, 'SECTION');
  w.raw(2, 'ENTITIES');
  floor3(w, variant);
  floor2(w, variant);
  w.raw(0, 'ENDSEC');
  w.raw(0, 'EOF');
  return w.toString();
}

/** 样例的固定预期（与 floorplan-expected.json 一致；测试与验收按这个核对） */
export const FLOORPLAN_SAMPLE_EXPECTED = {
  floors: ['L2', 'L3'],
  rooms: 11,
  ok: ['T301', 'T302', 'T303', 'V312', 'W301', 'W302', 'X201', 'X202'],
  merged: ['W303', 'W305'],
  leak: ['W306'],
};

/**
 * 第二版上把三层的 T305 与二层的 X201 对调：同一个编码换了楼层（v0.7.15 验收的 F22 场景），
 * 与第二版比对只列在「换了楼层」里，不算增减、不算挪动。图纸在 docs/data/floorplan-sample-v2-swap.dxf。
 */
export function floorplanSampleFloorSwapDxf(): string {
  return floorplanSampleDxf(2).replace('样例 SPA T305 2人间', '样例 SPA X201 2人间').replace('样例派对房X201', '样例派对房T305');
}

// ───────────────────────── PDF 样例 ─────────────────────────
// 同样的两层（第一版）画成 PDF：1:100，每层一页（三层 A3 横向、二层 A4 横向），未压缩的内容流，标准字体 Helvetica。
// 内容流开头一个 cm 把实际毫米缩成纸上的点，楼层照样按毫米画（floor3 / floor2 原样调用）；墙、窗、楼梯是描边的矩形与线，
// 门是 q … cm … Q 里的一条线与一段三次贝塞尔曲线（开启弧线）。与 DXF 样例的不同：
//   · 标准字体只有 ASCII：文字换成英文（PDF_TEXTS），楼层标题写「L3」「L2」，另加比例文字（第一页「SCALE 1:100」、第二页「1:100」）；
//   · 默认没有图层（OCG）：读进来线都算「PDF-墙」、文字都算「PDF-区域文字」，所以不画家具（不然家具也当成墙）；
//     kind = 'layers' 时按 DXF 的图层名建可选内容组，家具画在「P-活动家具」上，按白名单剔除。
// 拒绝用的几种：'no-scale' 没有比例文字、'no-text' 没有任何文字、'scanned' 只有一张图片（加一行看不见的 OCR 文字）。

export type FloorplanPdfSampleKind = 'standard' | 'layers' | 'no-scale' | 'no-text' | 'scanned';

const PT_PER_MM = 72 / 25.4;
const PDF_SAMPLE_SCALE = 100;
/** 实际 1 毫米在纸上是几点 */
const PDF_K = PT_PER_MM / PDF_SAMPLE_SCALE;
const FURNITURE = 'P-活动家具';
const PDF_LAYERS = [WALL, DOOR, 'A-WIND', 'A-STAIR', LABEL, 'W-文字', FURNITURE];
/** 四分之一圆弧的三次贝塞尔控制点系数 */
const KAPPA = 0.5522847498;

/** 标准字体只有 ASCII：DXF 样例的文字在 PDF 里换成这些 */
const PDF_TEXTS: Record<string, string> = {
  '样例 SPA T301 1人间': 'SPA T301',
  '样例 SPA T302 1人间': 'SPA T302',
  '样例 SPA T303 2人间': 'SPA T303',
  '样例 V312 4人间': 'V312',
  '样例客房 W301': 'ROOM W301',
  '样例客房 W302': 'ROOM W302',
  '样例客房 W303': 'ROOM W303',
  '样例客房 W305': 'ROOM W305',
  '样例踩背 W306': 'MASSAGE W306',
  设备间: 'PLANT',
  布草间: 'LINEN',
  走道: 'CORRIDOR',
  三层平面图: 'L3',
  样例派对房X201: 'PARTY X201',
  样例派对房X202: 'PARTY X202',
  大厅: 'LOBBY',
  二层平面图: 'L2',
};

/** PDF 里的数：最多 places 位小数、去掉末尾的 0（PDF 不认科学计数法） */
function pdfNum(v: number, places = 3): string {
  let s = v.toFixed(places);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

const pdfEscape = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
const isAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** 字符串：ASCII 原样，其余按 UTF-16BE（带 BOM）写成十六进制 */
function pdfString(s: string): string {
  if (isAscii(s)) return `(${pdfEscape(s)})`;
  let hex = 'FEFF';
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
  return `<${hex}>`;
}

class PdfSampleWriter implements SampleSink {
  private out: string[] = [];
  /** 当前打开的可选内容段（图层） */
  private open: string | null = null;
  constructor(private readonly opts: { layers: boolean; text: boolean }) {}
  /** 带图层时按需开、关可选内容段；不带图层时不画家具 */
  private use(layer: string): boolean {
    if (!this.opts.layers) return layer !== FURNITURE;
    if (this.open !== layer) {
      const i = PDF_LAYERS.indexOf(layer);
      if (i < 0) throw new Error(`PDF 样例没有图层 ${layer}`);
      if (this.open) this.out.push('EMC');
      this.out.push(`/OC /L${i} BDC`);
      this.open = layer;
    }
    return true;
  }
  line(layer: string, x1: number, y1: number, x2: number, y2: number) {
    if (this.use(layer)) this.out.push(`${pdfNum(x1)} ${pdfNum(y1)} m ${pdfNum(x2)} ${pdfNum(y2)} l S`);
  }
  rect(layer: string, x0: number, y0: number, x1: number, y1: number) {
    if (this.use(layer)) this.out.push(`${pdfNum(x0)} ${pdfNum(y0)} ${pdfNum(x1 - x0)} ${pdfNum(y1 - y0)} re S`);
  }
  text(layer: string, x: number, y: number, h: number, s: string) {
    if (!this.opts.text) return;
    const t = isAscii(s) ? s : PDF_TEXTS[s];
    if (t === undefined) throw new Error(`PDF 样例没有「${s}」对应的英文`);
    if (!this.use(layer)) return;
    // 基线起点：按转换估算字宽的办法往左退半个字宽、往下退半个字高，读回来的文字中心正好在 (x, y)
    this.out.push(`BT /F1 ${pdfNum(h)} Tf 1 0 0 1 ${pdfNum(x - textWidth(t, h) / 2)} ${pdfNum(y - h / 2)} Tm (${pdfEscape(t)}) Tj ET`);
  }
  mtext(layer: string, x: number, y: number, h: number, s: string) {
    this.text(layer, x, y, h, s);
  }
  /** 只有门（DOOR900）：铰点在插入点，门扇朝 +y，开启弧线从 0° 到 90° */
  insert(layer: string, name: string, x: number, y: number, rotationRad: number) {
    if (name !== 'DOOR900') throw new Error(`PDF 样例没有块 ${name}`);
    if (!this.use(layer)) return;
    const c = Math.cos(rotationRad);
    const s = Math.sin(rotationRad);
    const k = pdfNum(900 * KAPPA);
    this.out.push(`q ${pdfNum(c, 6)} ${pdfNum(s, 6)} ${pdfNum(-s, 6)} ${pdfNum(c, 6)} ${pdfNum(x)} ${pdfNum(y)} cm 0 0 m 0 900 l S 900 0 m 900 ${k} ${k} 900 0 900 c S Q`);
  }
  finish(): string {
    if (this.open) this.out.push('EMC');
    this.open = null;
    return this.out.join('\n');
  }
}

export interface PdfPageSpec {
  /** 页面宽高（点） */
  width: number;
  height: number;
  /** 内容流（不压缩，只用 ASCII） */
  content: string;
  /** 页面的显示旋转（/Rotate） */
  rotate?: 0 | 90 | 180 | 270;
  /** 外部对象（图片、表单）：名字 → 字典里 /Length 以外的项 + 流内容；字典里写 {L0} 引用第 0 个图层（可选内容组） */
  xobjects?: Record<string, { dict: string; stream: string }>;
}

/** 手写一份最小的 PDF（不压缩、带交叉引用表），字体 /F1 是 Helvetica，图层在内容流里用 /L0、/L1… 引用。样例与测试用 */
export function writePdf(pages: PdfPageSpec[], opts: { layers?: string[]; title?: string } = {}): Uint8Array {
  const objs: string[] = [];
  const add = (body: string) => objs.push(body);
  const ref = (n: number) => `${n} 0 R`;
  const stream = (dict: string, data: string) => `<< ${dict ? `${dict} ` : ''}/Length ${data.length} >>\nstream\n${data}\nendstream`;
  const catalog = add('');
  const pagesRef = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const ocgs = (opts.layers ?? []).map((name) => add(`<< /Type /OCG /Name ${pdfString(name)} >>`));
  const kids = pages.map((p) => {
    const xobjects = Object.entries(p.xobjects ?? {}).map(
      ([name, x]) => `/${name} ${ref(add(stream(x.dict.replace(/\{L(\d+)\}/g, (_, i: string) => ref(ocgs[Number(i)]!)), x.stream)))}`,
    );
    const contents = add(stream('', p.content));
    const res = [`/Font << /F1 ${ref(font)} >>`];
    if (ocgs.length) res.push(`/Properties << ${ocgs.map((o, i) => `/L${i} ${ref(o)}`).join(' ')} >>`);
    if (xobjects.length) res.push(`/XObject << ${xobjects.join(' ')} >>`);
    const rotate = p.rotate ? ` /Rotate ${p.rotate}` : '';
    return add(`<< /Type /Page /Parent ${ref(pagesRef)} /MediaBox [0 0 ${pdfNum(p.width)} ${pdfNum(p.height)}]${rotate} /Resources << ${res.join(' ')} >> /Contents ${ref(contents)} >>`);
  });
  objs[pagesRef - 1] = `<< /Type /Pages /Kids [${kids.map(ref).join(' ')}] /Count ${kids.length} >>`;
  const ocProperties = ocgs.length ? ` /OCProperties << /OCGs [${ocgs.map(ref).join(' ')}] /D << /Order [${ocgs.map(ref).join(' ')}] >> >>` : '';
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${ref(pagesRef)}${ocProperties} >>`;
  const info = opts.title ? add(`<< /Title ${pdfString(opts.title)} /Producer (yuzu floorplan-sample) >>`) : 0;
  // 第二行的几个高位字节告诉传输工具这是二进制文件
  let out = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${ref(catalog)}${info ? ` /Info ${ref(info)}` : ''} >>\nstartxref\n${xref}\n%%EOF\n`;
  // 全是单字节字符（非 ASCII 的都写成了十六进制）
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i);
  return bytes;
}

interface SamplePage {
  widthMm: number;
  heightMm: number;
  /** 楼层的原点（实际坐标 0, 0）在纸上的位置（毫米） */
  originMm: [number, number];
  /** 楼层图形整体平移（实际毫米），二层画在 x = 80 米处，移回页面上 */
  shiftMm: number;
  scaleText: string;
  /** 比例文字的中心（实际坐标），在楼层标题下面 */
  scaleAt: [number, number];
}

function samplePage(kind: FloorplanPdfSampleKind, page: SamplePage, draw: (w: SampleSink) => void): PdfPageSpec {
  const w = new PdfSampleWriter({ layers: kind === 'layers', text: kind !== 'no-text' });
  draw(w);
  if (kind !== 'no-scale') w.text('W-文字', page.scaleAt[0], page.scaleAt[1], 350, page.scaleText);
  const tx = page.originMm[0] * PT_PER_MM + page.shiftMm * PDF_K;
  const ty = page.originMm[1] * PT_PER_MM;
  const content = [`q ${pdfNum(PDF_K, 10)} 0 0 ${pdfNum(PDF_K, 10)} ${pdfNum(tx, 6)} ${pdfNum(ty, 6)} cm`, '35 w 1 J 1 j', w.finish(), 'Q'].join('\n');
  return { width: page.widthMm * PT_PER_MM, height: page.heightMm * PT_PER_MM, content };
}

/** 合成样例图纸的 PDF 版（1:100，与 DXF 第一版同样的两层）；kind 见上面的说明，预期结果在 floorplan-expected.json 的 pdf */
export function floorplanSamplePdf(kind: FloorplanPdfSampleKind = 'standard'): Uint8Array {
  const title = '浴族 yuzu 底图转换合成样例（不是门店图纸）';
  if (kind === 'scanned') {
    const [w, h] = [210 * PT_PER_MM, 297 * PT_PER_MM];
    const image = { dict: '/Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode', stream: `${'80'.repeat(64)}>` };
    const content = [`q ${pdfNum(w)} 0 0 ${pdfNum(h)} 0 0 cm /Im0 Do Q`, 'BT 3 Tr /F1 12 Tf 1 0 0 1 72 760 Tm (SPA T301 SCALE 1:100) Tj ET'].join('\n');
    return writePdf([{ width: w, height: h, content, xobjects: { Im0: image } }], { title });
  }
  const pages = [
    samplePage(kind, { widthMm: 420, heightMm: 297, originMm: [60, 100], shiftMm: 0, scaleText: 'SCALE 1:100', scaleAt: [15000, -4300] }, (w) => floor3(w, 1)),
    samplePage(kind, { widthMm: 297, heightMm: 210, originMm: [50, 70], shiftMm: -80000, scaleText: '1:100', scaleAt: [90000, -4300] }, (w) => floor2(w, 1)),
  ];
  return writePdf(pages, { layers: kind === 'layers' ? PDF_LAYERS : [], title });
}
