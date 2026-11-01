// 读 DXF（RQ-004 第二段，v0.7.15）：ASCII DXF 的最小解析，换成与 libredwg-web 输出同样形状的对象，再交给
// fromDwgDatabase 转成中性图元。只认画底图要用的图元：直线、多段线（新旧两种）、圆弧、圆、椭圆、样条、单行与多行文字、
// 块参照（含块属性）；其余（填充、标注……）照样计数、不转换。
// 用途：设计方另存的 DXF、测试与验收用的合成图纸（libredwg-web 的 WebAssembly 版读不了 DXF）。二进制 DXF 不支持。

import { fromDwgDatabase, type DwgDatabaseLike } from './read-dwg';
import type { PlanDrawing } from './model';

type Pair = [number, string];
type Ent = { type: string; layer: string; [key: string]: unknown };

const DEG = Math.PI / 180;

/** DXF 文字里的转义：\U+XXXX、%%c / %%d / %%p */
export function dxfText(raw: string): string {
  return raw
    .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/%%[cC]/g, 'Ø')
    .replace(/%%[dD]/g, '°')
    .replace(/%%[pP]/g, '±')
    .replace(/%%%/g, '%');
}

/** 按文件头的版本与代码页决定怎么解码：R2007（AC1021）起是 UTF-8，之前按 $DWGCODEPAGE */
function decode(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 64 * 1024)));
  const ver = /\$ACADVER\s*\r?\n\s*1\s*\r?\n\s*(AC\d{4})/.exec(head)?.[1] ?? '';
  const page = /\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*(\S+)/.exec(head)?.[1]?.toUpperCase() ?? '';
  let enc = 'utf-8';
  if (ver && ver < 'AC1021') {
    if (page === 'ANSI_936') enc = 'gbk';
    else if (page === 'ANSI_950') enc = 'big5';
    else if (page === 'ANSI_932') enc = 'shift_jis';
    else if (page === 'ANSI_949') enc = 'euc-kr';
  }
  try {
    return new TextDecoder(enc).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export function isDxf(bytes: Uint8Array): boolean {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096)).replace(/^﻿/, '').replace(/^\xEF\xBB\xBF/, '');
  // 开头可能有 999 注释
  return /^\s*(999\s*\r?\n[^\n]*\r?\n\s*)*0\s*\r?\n\s*SECTION\b/.test(head);
}

function pairsOf(text: string): Pair[] {
  const lines = text.split(/\r?\n/);
  const out: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i]!.trim());
    if (!Number.isInteger(code)) throw new Error(`DXF 第 ${i + 1} 行不是组码，文件可能损坏`);
    out.push([code, lines[i + 1]!.replace(/\r$/, '')]);
  }
  return out;
}

const num = (v: string | undefined, d = 0) => {
  if (v === undefined) return d;
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : d;
};

/** 把一个图元的组码收成对象（同一组码出现多次的，按出现顺序放进数组） */
function group(pairs: Pair[]): { type: string; first: Map<number, string>; all: Pair[] } {
  const first = new Map<number, string>();
  for (const [c, v] of pairs.slice(1)) if (!first.has(c)) first.set(c, v);
  return { type: pairs[0]![1].trim(), first, all: pairs.slice(1) };
}

function common(g: ReturnType<typeof group>): Ent {
  const e: Ent = { type: g.type, layer: (g.first.get(8) ?? '0').trim() };
  if (num(g.first.get(60)) === 1) e.isVisible = false;
  const z = g.first.get(230);
  if (z !== undefined) e.extrusionDirection = { x: num(g.first.get(210)), y: num(g.first.get(220)), z: num(z, 1) };
  return e;
}

const pt = (g: ReturnType<typeof group>, cx: number, cy: number) => ({ x: num(g.first.get(cx)), y: num(g.first.get(cy)) });

function textOf(g: ReturnType<typeof group>, vCode: number): Record<string, unknown> {
  return {
    text: dxfText(g.first.get(1) ?? ''),
    startPoint: pt(g, 10, 20),
    endPoint: pt(g, 11, 21),
    textHeight: num(g.first.get(40), 1),
    rotation: num(g.first.get(50)) * DEG,
    halign: num(g.first.get(72)),
    valign: num(g.first.get(vCode)),
  };
}

/** 一串图元（ENTITIES 段或块定义）→ 对象；旧式多段线的 VERTEX、块参照后的 ATTRIB 收进上一个图元 */
function entitiesOf(chunks: Pair[][]): Ent[] {
  const out: Ent[] = [];
  let poly: Ent | null = null;
  let insert: Ent | null = null;
  for (const chunk of chunks) {
    const g = group(chunk);
    if (g.type === 'SEQEND') {
      poly = null;
      insert = null;
      continue;
    }
    if (g.type === 'VERTEX' && poly) {
      (poly.vertices as unknown[]).push({ ...pt(g, 10, 20), bulge: num(g.first.get(42)) });
      continue;
    }
    if (g.type === 'ATTRIB' && insert) {
      (insert.attribs as unknown[]).push({ layer: (g.first.get(8) ?? '0').trim(), text: textOf(g, 74) });
      continue;
    }
    poly = null;
    insert = null;
    const e = common(g);
    switch (g.type) {
      case 'LINE':
        Object.assign(e, { startPoint: pt(g, 10, 20), endPoint: pt(g, 11, 21) });
        break;
      case 'LWPOLYLINE': {
        const vertices: { x: number; y: number; bulge: number }[] = [];
        let cur: { x: number; y: number; bulge: number } | null = null;
        for (const [c, v] of g.all) {
          if (c === 10) {
            cur = { x: num(v), y: 0, bulge: 0 };
            vertices.push(cur);
          } else if (c === 20 && cur) cur.y = num(v);
          else if (c === 42 && cur) cur.bulge = num(v);
        }
        Object.assign(e, { vertices, flag: num(g.first.get(70)) & 1 ? 512 : 0 });
        break;
      }
      case 'POLYLINE': {
        const flags = num(g.first.get(70));
        // 网格、多面网格不是平面线，不转换
        if (flags & (16 | 64)) {
          e.type = 'POLYLINE_MESH';
          break;
        }
        e.type = flags & 8 ? 'POLYLINE3D' : 'POLYLINE2D';
        Object.assign(e, { flag: flags & 1, vertices: [] });
        poly = e;
        break;
      }
      case 'ARC':
        Object.assign(e, { center: pt(g, 10, 20), radius: num(g.first.get(40)), startAngle: num(g.first.get(50)) * DEG, endAngle: num(g.first.get(51)) * DEG });
        break;
      case 'CIRCLE':
        Object.assign(e, { center: pt(g, 10, 20), radius: num(g.first.get(40)) });
        break;
      case 'ELLIPSE':
        Object.assign(e, {
          center: pt(g, 10, 20),
          majorAxisEndPoint: pt(g, 11, 21),
          axisRatio: num(g.first.get(40), 1),
          startAngle: num(g.first.get(41)),
          endAngle: num(g.first.get(42), Math.PI * 2),
        });
        break;
      case 'SPLINE': {
        const ctrl: { x: number; y: number }[] = [];
        const fit: { x: number; y: number }[] = [];
        let last: { x: number; y: number } | null = null;
        for (const [c, v] of g.all) {
          if (c === 10) ctrl.push((last = { x: num(v), y: 0 }));
          else if (c === 11) fit.push((last = { x: num(v), y: 0 }));
          else if ((c === 20 || c === 21) && last) last.y = num(v);
        }
        Object.assign(e, { controlPoints: ctrl, fitPoints: fit });
        break;
      }
      case 'TEXT':
        Object.assign(e, textOf(g, 73));
        break;
      case 'MTEXT': {
        // 长文字分成多段：组码 3 依次在前，组码 1 是最后一段
        const parts = g.all.filter(([c]) => c === 3).map(([, v]) => v);
        const dir = g.first.has(11) ? Math.atan2(num(g.first.get(21)), num(g.first.get(11))) : num(g.first.get(50)) * DEG;
        Object.assign(e, {
          text: dxfText(parts.join('') + (g.first.get(1) ?? '')),
          insertionPoint: pt(g, 10, 20),
          textHeight: num(g.first.get(40), 1),
          rotation: dir,
          attachmentPoint: num(g.first.get(71), 1),
        });
        break;
      }
      case 'INSERT':
        Object.assign(e, {
          name: (g.first.get(2) ?? '').trim(),
          insertionPoint: pt(g, 10, 20),
          xScale: num(g.first.get(41), 1),
          yScale: num(g.first.get(42), 1),
          rotation: num(g.first.get(50)) * DEG,
          attribs: [],
        });
        if (num(g.first.get(66)) === 1) insert = e;
        break;
      default:
        break;
    }
    out.push(e);
  }
  return out;
}

/** 解析 ASCII DXF 文本，得到与 libredwg-web 输出同样形状的数据库对象 */
export function parseDxf(text: string): DwgDatabaseLike {
  const pairs = pairsOf(text);
  const entities: Ent[] = [];
  const layers: { name: string }[] = [];
  const blocks: { name: string; basePoint: { x: number; y: number }; entities: Ent[] }[] = [];
  let i = 0;
  // 把 [from, to) 里的组码按组码 0 切成一个个图元
  const chunksUntil = (end: (p: Pair) => boolean): Pair[][] => {
    const chunks: Pair[][] = [];
    while (i < pairs.length && !end(pairs[i]!)) {
      if (pairs[i]![0] === 0) chunks.push([pairs[i]!]);
      else if (chunks.length) chunks[chunks.length - 1]!.push(pairs[i]!);
      i++;
    }
    return chunks;
  };
  while (i < pairs.length) {
    const [c, v] = pairs[i]!;
    if (c === 0 && v.trim() === 'SECTION') {
      const name = pairs[i + 1]?.[1]?.trim() ?? '';
      i += 2;
      if (name === 'ENTITIES') {
        entities.push(...entitiesOf(chunksUntil((p) => p[0] === 0 && p[1].trim() === 'ENDSEC')));
      } else if (name === 'BLOCKS') {
        const chunks = chunksUntil((p) => p[0] === 0 && p[1].trim() === 'ENDSEC');
        let cur: { name: string; basePoint: { x: number; y: number }; body: Pair[][] } | null = null;
        for (const chunk of chunks) {
          const type = chunk[0]![1].trim();
          if (type === 'BLOCK') {
            const g = group(chunk);
            cur = { name: (g.first.get(2) ?? '').trim(), basePoint: pt(g, 10, 20), body: [] };
          } else if (type === 'ENDBLK') {
            if (cur) blocks.push({ name: cur.name, basePoint: cur.basePoint, entities: entitiesOf(cur.body) });
            cur = null;
          } else if (cur) cur.body.push(chunk);
        }
      } else if (name === 'TABLES') {
        for (const chunk of chunksUntil((p) => p[0] === 0 && p[1].trim() === 'ENDSEC')) {
          if (chunk[0]![1].trim() !== 'LAYER') continue;
          const g = group(chunk);
          const ln = g.first.get(2);
          if (ln !== undefined) layers.push({ name: ln.trim() });
        }
      } else {
        chunksUntil((p) => p[0] === 0 && p[1].trim() === 'ENDSEC');
      }
    }
    i++;
  }
  if (!layers.length) for (const l of new Set(entities.map((e) => e.layer))) layers.push({ name: l });
  return { entities, tables: { LAYER: { entries: layers }, BLOCK_RECORD: { entries: blocks } } };
}

export function readDxf(bytes: Uint8Array): PlanDrawing {
  if (new TextDecoder('latin1').decode(bytes.subarray(0, 22)).startsWith('AutoCAD Binary DXF')) {
    throw new Error('这是二进制 DXF，请另存为 ASCII DXF，或直接上传 DWG');
  }
  return fromDwgDatabase(parseDxf(decode(bytes)));
}
