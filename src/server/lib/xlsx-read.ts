// 读 .xlsx（v0.7.10，8–10 月旧账只读对照）：只用 Node 自带的 zlib，不加依赖，也不读样式表
// （WPS 存的样式表有些表格库都读不了）。
//
// 读：工作表名、共享字符串、内联文字、数字、布尔、公式原文与文件里存的计算结果、合并格、超链接、
// WPS 的单元格图（`DISPIMG("ID_…",1)` 指向 xl/cellimages.xml）。只读需要的部分，认不出的结构直接报错。

import { inflateRawSync } from 'node:zlib';

// ───────────────────────── ZIP ─────────────────────────

/** 单个文件解压后最大多少字节；整份文件最多解压多少（防压缩炸弹） */
const MAX_ENTRY = 64 * 1024 * 1024;
const MAX_TOTAL = 256 * 1024 * 1024;

export class XlsxReadError extends Error {}

export function unzip(buf: Buffer): Map<string, Buffer> {
  const sig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const end = buf.lastIndexOf(sig);
  if (end < 0 || end + 22 > buf.length) throw new XlsxReadError('不是有效的 Excel 文件（.xlsx）');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  if (count === 0xffff || p === 0xffffffff) throw new XlsxReadError('文件太大（ZIP64），请另存为普通的 .xlsx');
  const out = new Map<string, Buffer>();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new XlsxReadError('Excel 文件已损坏（目录不完整）');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'latin1');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new XlsxReadError('Excel 文件加了密码，请去掉密码后再导入');
    if (usize > MAX_ENTRY) throw new XlsxReadError(`文件里的「${name}」太大`);
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new XlsxReadError('Excel 文件已损坏（文件头不对）');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const body = buf.subarray(start, start + csize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(body);
    else if (method === 8) data = inflateRawSync(body, { maxOutputLength: MAX_ENTRY });
    else throw new XlsxReadError(`不支持的压缩方式（${method}）`);
    total += data.length;
    if (total > MAX_TOTAL) throw new XlsxReadError('Excel 文件解压后太大');
    out.set(name, data);
  }
  return out;
}

// ───────────────────────── XML（只认元素、属性、文字） ─────────────────────────

export interface XmlNode {
  /** 去掉前缀的标签名 */
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** 直接在这个元素里的文字（不含子元素） */
  text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

const local = (name: string) => name.slice(name.indexOf(':') + 1);

export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      stack[stack.length - 1]!.text += decode(xml.slice(i));
      break;
    }
    if (lt > i) stack[stack.length - 1]!.text += decode(xml.slice(i, lt));
    if (xml.startsWith('<?', lt)) {
      const e = xml.indexOf('?>', lt);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (xml.startsWith('<!--', lt)) {
      const e = xml.indexOf('-->', lt);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const e = xml.indexOf(']]>', lt);
      stack[stack.length - 1]!.text += xml.slice(lt + 9, e < 0 ? n : e);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (xml.startsWith('<!', lt)) {
      const e = xml.indexOf('>', lt);
      i = e < 0 ? n : e + 1;
      continue;
    }
    const gt = xml.indexOf('>', lt);
    if (gt < 0) throw new XlsxReadError('Excel 文件里的 XML 不完整');
    if (xml[lt + 1] === '/') {
      if (stack.length > 1) stack.pop();
      i = gt + 1;
      continue;
    }
    const selfClosing = xml[gt - 1] === '/';
    const inner = xml.slice(lt + 1, selfClosing ? gt - 1 : gt);
    const m = /^([^\s/>]+)/.exec(inner);
    if (!m) throw new XlsxReadError('Excel 文件里的 XML 不完整');
    const node: XmlNode = { name: local(m[1]!), attrs: {}, children: [], text: '' };
    const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let a: RegExpExecArray | null;
    const rest = inner.slice(m[1]!.length);
    while ((a = attrRe.exec(rest))) node.attrs[a[1]!] = decode(a[3] ?? a[4] ?? '');
    stack[stack.length - 1]!.children.push(node);
    if (!selfClosing) stack.push(node);
    i = gt + 1;
  }
  return root;
}

/** 按去掉前缀的名称取属性；同名时取带前缀的（r:id、r:embed） */
export function attr(node: XmlNode, name: string): string | undefined {
  let plain: string | undefined;
  for (const [k, v] of Object.entries(node.attrs)) {
    if (k === name) plain = v;
    else if (local(k) === name) return v;
  }
  return plain;
}

export function* descendants(node: XmlNode, name: string): Generator<XmlNode> {
  for (const c of node.children) {
    if (c.name === name) yield c;
    yield* descendants(c, name);
  }
}

const child = (node: XmlNode, name: string) => node.children.find((c) => c.name === name);

/** 元素下所有文字（共享字符串的富文本里多段 <t> 拼起来；注音 <rPh> 不算） */
function textOf(node: XmlNode): string {
  if (node.name === 'rPh' || node.name === 'phoneticPr') return '';
  return node.text + node.children.map(textOf).join('');
}

// ───────────────────────── 工作簿 ─────────────────────────

export interface XlsxCell {
  /** 从 1 起 */
  row: number;
  /** 从 0 起（A = 0） */
  col: number;
  type: 'number' | 'string' | 'boolean' | 'error';
  /** 文件里存的值（数字是原文，如「-1924.04」）；公式没有存结果时为 null */
  value: string | null;
  /** 公式原文（不带「=」）；不是公式为 null */
  formula: string | null;
}

export interface XlsxMerge {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export interface XlsxSheet {
  name: string;
  /** 行号 → 列号 → 单元格（只含有值或有公式的单元格） */
  rows: Map<number, Map<number, XlsxCell>>;
  /** 工作表里写出来的行数（含没有值的空行，WPS 常带很多格式行） */
  rowElements: number;
  merges: XlsxMerge[];
  /** 单元格引用（如「J3」）→ 超链接网址 */
  hyperlinks: Map<string, string>;
}

export interface XlsxWorkbook {
  sheets: XlsxSheet[];
  /** WPS 单元格图：图片编号（ID_…）→ 图片 */
  cellImages: Map<string, { data: Buffer; ext: string }>;
}

export function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function parseRef(ref: string): { row: number; col: number } {
  const m = /^\$?([A-Z]+)\$?(\d+)$/.exec(ref.toUpperCase());
  if (!m) throw new XlsxReadError(`单元格引用不对：${ref}`);
  return { row: Number(m[2]), col: colIndex(m[1]!) };
}

function resolve(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

function rels(files: Map<string, Buffer>, partPath: string): Map<string, { target: string; external: boolean }> {
  const dir = partPath.split('/').slice(0, -1).join('/');
  const relsPath = `${dir ? `${dir}/` : ''}_rels/${partPath.split('/').pop()}.rels`;
  const out = new Map<string, { target: string; external: boolean }>();
  const raw = files.get(relsPath);
  if (!raw) return out;
  for (const r of descendants(parseXml(raw.toString('utf8')), 'Relationship')) {
    const id = attr(r, 'Id');
    const target = attr(r, 'Target');
    if (!id || target === undefined) continue;
    const external = attr(r, 'TargetMode') === 'External';
    out.set(id, { target: external ? target : resolve(partPath, target), external });
  }
  return out;
}

/** 单元格最多多少个（防止异常文件把内存撑爆） */
const MAX_CELLS = 500_000;

export function readXlsx(buf: Buffer): XlsxWorkbook {
  const files = unzip(buf);
  const wbPath = 'xl/workbook.xml';
  const wbRaw = files.get(wbPath);
  if (!wbRaw) throw new XlsxReadError('不是 Excel 工作簿（缺 xl/workbook.xml）');
  const wbRels = rels(files, wbPath);

  const shared: string[] = [];
  const ssRaw = files.get('xl/sharedStrings.xml');
  if (ssRaw) for (const si of descendants(parseXml(ssRaw.toString('utf8')), 'si')) shared.push(textOf(si));

  const sheets: XlsxSheet[] = [];
  let cells = 0;
  for (const s of descendants(parseXml(wbRaw.toString('utf8')), 'sheet')) {
    const name = attr(s, 'name') ?? '';
    const rid = attr(s, 'id');
    const rel = rid ? wbRels.get(rid) : undefined;
    if (!rel || rel.external) continue;
    const raw = files.get(rel.target);
    if (!raw) throw new XlsxReadError(`工作表「${name}」缺内容`);
    const root = parseXml(raw.toString('utf8'));
    const sheet: XlsxSheet = { name, rows: new Map(), rowElements: 0, merges: [], hyperlinks: new Map() };
    let nextRow = 1;
    for (const row of descendants(root, 'row')) {
      sheet.rowElements += 1;
      const r = Number(attr(row, 'r') ?? nextRow);
      nextRow = r + 1;
      let nextCol = 0;
      for (const c of row.children) {
        if (c.name !== 'c') continue;
        const ref = attr(c, 'r');
        const pos = ref ? parseRef(ref) : { row: r, col: nextCol };
        nextCol = pos.col + 1;
        const t = attr(c, 't') ?? 'n';
        const f = child(c, 'f');
        const v = child(c, 'v');
        let value: string | null = null;
        let type: XlsxCell['type'] = 'number';
        if (t === 's') {
          type = 'string';
          value = v ? (shared[Number(v.text)] ?? '') : null;
        } else if (t === 'inlineStr') {
          type = 'string';
          const is = child(c, 'is');
          value = is ? textOf(is) : '';
        } else if (t === 'str') {
          type = 'string';
          value = v ? v.text : null;
        } else if (t === 'b') {
          type = 'boolean';
          value = v ? v.text : null;
        } else if (t === 'e') {
          type = 'error';
          value = v ? v.text : null;
        } else {
          value = v && v.text.trim() !== '' ? v.text.trim() : null;
        }
        const formula = f && f.text.trim() !== '' ? f.text.trim() : null;
        if (value === null && formula === null) continue;
        if (value !== null && type === 'string' && value === '' && formula === null) continue;
        if (++cells > MAX_CELLS) throw new XlsxReadError('Excel 文件的单元格太多');
        let line = sheet.rows.get(pos.row);
        if (!line) sheet.rows.set(pos.row, (line = new Map()));
        line.set(pos.col, { row: pos.row, col: pos.col, type, value, formula });
      }
    }
    for (const m of descendants(root, 'mergeCell')) {
      const ref = attr(m, 'ref');
      if (!ref) continue;
      const [a, b] = ref.split(':');
      const p1 = parseRef(a!);
      const p2 = parseRef(b ?? a!);
      sheet.merges.push({ r1: p1.row, c1: p1.col, r2: p2.row, c2: p2.col });
    }
    const sheetRels = rels(files, rel.target);
    for (const h of descendants(root, 'hyperlink')) {
      const ref = attr(h, 'ref');
      const id = attr(h, 'id');
      const target = id ? sheetRels.get(id) : undefined;
      if (ref && target?.external) sheet.hyperlinks.set(ref.split(':')[0]!.toUpperCase(), target.target);
    }
    sheets.push(sheet);
  }

  const cellImages = new Map<string, { data: Buffer; ext: string }>();
  const ciPath = 'xl/cellimages.xml';
  const ciRaw = files.get(ciPath);
  if (ciRaw) {
    const ciRels = rels(files, ciPath);
    for (const pic of descendants(parseXml(ciRaw.toString('utf8')), 'pic')) {
      const nv = [...descendants(pic, 'cNvPr')][0];
      const blip = [...descendants(pic, 'blip')][0];
      const name = nv ? attr(nv, 'name') : undefined;
      const embed = blip ? attr(blip, 'embed') : undefined;
      const target = embed ? ciRels.get(embed) : undefined;
      const data = target && !target.external ? files.get(target.target) : undefined;
      if (name && data) cellImages.set(name, { data, ext: (target!.target.split('.').pop() ?? '').toLowerCase() });
    }
  }
  return { sheets, cellImages };
}

/** WPS 单元格图的公式：`_xlfn.DISPIMG("ID_…",1)` → 图片编号 */
export function dispImgId(formula: string | null): string | null {
  if (!formula) return null;
  const m = /DISPIMG\(\s*"([^"]+)"/i.exec(formula);
  return m ? m[1]! : null;
}

/** Excel 日期序号（1900 日期系统）→ YYYY-MM-DD */
export function serialToDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2_958_465) return null;
  const ms = Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}
