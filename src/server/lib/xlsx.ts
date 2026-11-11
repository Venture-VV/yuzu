// 生成带图片的 .xlsx（v0.7.9，下单物料导出「Excel 不丢图」）：只用 Node 自带的 zlib，不加依赖。
//
// 一个工作表；单元格是文字或数字；图片嵌在指定单元格里（按格子大小等比缩放），随文件走，不是链接。
// 只写 Excel / WPS / Numbers / LibreOffice 都认的最小结构：内容类型、关系、工作簿、样式、工作表、绘图与图片。

import { deflateRawSync } from 'node:zlib';

export interface XlsxImage {
  data: Buffer;
  /** 图片格式；WebP 在部分表格软件里打不开，调用方先跳过 */
  ext: 'jpeg' | 'png';
}

export interface XlsxSheet {
  name: string;
  columns: { header: string; width?: number }[];
  rows: (string | number | null)[][];
  /** 图片：第几行（从 0 起，不含表头）、第几列，图片按格子大小等比缩放 */
  images?: { row: number; col: number; image: XlsxImage }[];
  /** 有图片的行的行高（磅），默认 60 */
  imageRowHeight?: number;
}

// ───────────────────────── ZIP（最小实现：存储 / Deflate，单卷，无加密） ─────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Buffer;
  /** 已经压缩过的图片直接存，不再压 */
  store?: boolean;
}

/** 固定的修改时间（1980-01-01），同样的内容生成同样的文件 */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

export function zip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const method = e.store ? 0 : 8;
    const body = e.store ? e.data : deflateRawSync(e.data);
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // 解压所需版本
    local.writeUInt16LE(0x0800, 6); // 文件名是 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const centralSize = centrals.reduce((t, b) => t + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

// ───────────────────────── 图片尺寸 ─────────────────────────

/** 读 JPEG / PNG 的像素宽高；读不出来返回 null（按方形放） */
export function imageSize(data: Buffer): { width: number; height: number } | null {
  if (data.length > 24 && data.readUInt32BE(0) === 0x89504e47) return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
    let i = 2;
    while (i + 9 < data.length) {
      if (data[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = data[i + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = data.readUInt16BE(i + 2);
      // SOF0–SOF15（不含 DHT C4、JPG C8、DAC CC）
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: data.readUInt16BE(i + 5), width: data.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

// ───────────────────────── 工作表 ─────────────────────────

// XML 1.0 不允许的控制字符一律去掉
const INVALID_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;
const esc = (s: string) => s.replace(INVALID_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 列号 → 字母（0 → A，26 → AA） */
export function colName(i: number): string {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const EMU_PER_PX = 9525;
/** 列宽（字符数）→ 像素，Calibri 11 的近似 */
const colPx = (width: number) => Math.floor(width * 7 + 5);
const ptToPx = (pt: number) => Math.round((pt * 96) / 72);

function cellXml(ref: string, v: string | number | null, style: number) {
  if (v === null || v === '') return `<c r="${ref}" s="${style}"/>`;
  if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}" s="${style}"><v>${v}</v></c>`;
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${esc(String(v))}</t></is></c>`;
}

export function buildXlsx(sheet: XlsxSheet): Buffer {
  const widths = sheet.columns.map((c) => c.width ?? 14);
  const images = sheet.images ?? [];
  const imageRows = new Set(images.map((i) => i.row));
  const rowHeight = sheet.imageRowHeight ?? 60;

  const rowsXml: string[] = [];
  rowsXml.push(`<row r="1">${sheet.columns.map((c, ci) => cellXml(`${colName(ci)}1`, c.header, 1)).join('')}</row>`);
  sheet.rows.forEach((row, ri) => {
    const r = ri + 2;
    const attrs = imageRows.has(ri) ? ` ht="${rowHeight}" customHeight="1"` : '';
    rowsXml.push(`<row r="${r}"${attrs}>${row.map((v, ci) => cellXml(`${colName(ci)}${r}`, v, 2)).join('')}</row>`);
  });

  const lastRef = `${colName(Math.max(0, sheet.columns.length - 1))}${sheet.rows.length + 1}`;
  const worksheet =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<dimension ref="A1:${lastRef}"/>` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="18"/>` +
    `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` +
    `<sheetData>${rowsXml.join('')}</sheetData>` +
    (images.length ? `<drawing r:id="rId1"/>` : '') +
    `</worksheet>`;

  // 图片：按所在格子的大小等比缩放，四边留 4 像素
  const anchors: string[] = [];
  const drawingRels: string[] = [];
  const media: ZipEntry[] = [];
  images.forEach((img, i) => {
    const n = i + 1;
    const boxW = colPx(widths[img.col] ?? 14) - 8;
    const boxH = ptToPx(rowHeight) - 8;
    const size = imageSize(img.image.data) ?? { width: boxW, height: boxH };
    const scale = Math.min(boxW / size.width, boxH / size.height, 1);
    const w = Math.max(1, Math.round(size.width * scale));
    const h = Math.max(1, Math.round(size.height * scale));
    anchors.push(
      `<xdr:oneCellAnchor><xdr:from><xdr:col>${img.col}</xdr:col><xdr:colOff>${4 * EMU_PER_PX}</xdr:colOff><xdr:row>${img.row + 1}</xdr:row><xdr:rowOff>${4 * EMU_PER_PX}</xdr:rowOff></xdr:from>` +
        `<xdr:ext cx="${w * EMU_PER_PX}" cy="${h * EMU_PER_PX}"/>` +
        `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${n + 1}" name="图片 ${n}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>` +
        `<xdr:blipFill><a:blip r:embed="rId${n}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
        `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${w * EMU_PER_PX}" cy="${h * EMU_PER_PX}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>` +
        `<xdr:clientData/></xdr:oneCellAnchor>`,
    );
    drawingRels.push(`<Relationship Id="rId${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${n}.${img.image.ext}"/>`);
    media.push({ name: `xl/media/image${n}.${img.image.ext}`, data: img.image.data, store: true });
  });

  const entries: ZipEntry[] = [
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
          `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
          `<Default Extension="xml" ContentType="application/xml"/>` +
          `<Default Extension="jpeg" ContentType="image/jpeg"/>` +
          `<Default Extension="png" ContentType="image/png"/>` +
          `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
          `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
          `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
          (images.length ? `<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>` : '') +
          `</Types>`,
      ),
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
          `</Relationships>`,
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
          `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
          `<sheets><sheet name="${esc(sheet.name.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
          `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
          `</Relationships>`,
      ),
    },
    {
      name: 'xl/styles.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
          `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
          `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
          `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>` +
          `<fill><patternFill patternType="solid"><fgColor rgb="FFEFEFEF"/><bgColor indexed="64"/></patternFill></fill></fills>` +
          `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
          `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
          `<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
          `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>` +
          `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf></cellXfs>` +
          `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
          `</styleSheet>`,
      ),
    },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(worksheet) },
  ];
  if (images.length) {
    entries.push(
      {
        name: 'xl/worksheets/_rels/sheet1.xml.rels',
        data: Buffer.from(
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
            `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
            `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>` +
            `</Relationships>`,
        ),
      },
      {
        name: 'xl/drawings/drawing1.xml',
        data: Buffer.from(
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
            `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
            anchors.join('') +
            `</xdr:wsDr>`,
        ),
      },
      {
        name: 'xl/drawings/_rels/drawing1.xml.rels',
        data: Buffer.from(
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
            `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${drawingRels.join('')}</Relationships>`,
        ),
      },
      ...media,
    );
  }
  return zip(entries);
}

// ───────────────────────── 带格式的多工作表（供应链二次整改：导入模板） ─────────────────────────
//
// 导入模板要的：几个工作表、标题行合并、橙色（必填）/ 灰色（选填）表头、冻结表头、列宽行高、
// 下拉（数据验证：固定选项或引用「选项」表里的名称）与点到单元格时的填写提示、超链接（测试造文件用）。
// 只写 Excel / WPS 都认的结构；不写图片。

export type WbStyle = 'default' | 'title' | 'required' | 'optional' | 'body' | 'note';
const WB_STYLE_ID: Record<WbStyle, number> = { default: 0, title: 1, required: 2, optional: 3, body: 4, note: 5 };

export interface WbCell {
  v: string | number | null;
  style?: WbStyle;
  /** 超链接地址（外部网址） */
  link?: string;
}

export interface WbValidation {
  /** 作用范围，如「B3:D502」，几段用空格隔开 */
  sqref: string;
  /** 下拉：固定选项（写进公式，总长不超过 255 个字），或工作簿里定义的名称（引用别的工作表） */
  list?: string[] | { name: string };
  promptTitle?: string;
  prompt?: string;
  /** 不在下拉里时的提示（只对下拉生效） */
  error?: string;
}

export interface WbSheet {
  name: string;
  /** 每一列的宽度（字符数） */
  widths: number[];
  rows: { cells: (WbCell | string | number | null)[]; height?: number }[];
  /** 合并单元格，如「A1:J1」 */
  merges?: string[];
  /** 冻结前几行 */
  freezeRows?: number;
  validations?: WbValidation[];
  /** 打开文件时选中这一张 */
  active?: boolean;
}

/** 工作簿里的名称（下拉引用「选项」表时用）：如 { name: 'opt_dept', sheet: '选项', range: '$A$2:$A$9' } */
export interface WbName {
  name: string;
  sheet: string;
  range: string;
}

const sheetNameOf = (name: string) => name.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31);
const quoteSheet = (name: string) => `'${sheetNameOf(name).replace(/'/g, "''")}'`;

function wbCellXml(ref: string, raw: WbCell | string | number | null): string {
  const cell: WbCell = raw !== null && typeof raw === 'object' ? raw : { v: raw };
  return cellXml(ref, cell.v, WB_STYLE_ID[cell.style ?? 'default']);
}

function validationXml(v: WbValidation): string {
  const attrs: string[] = [];
  let formula = '';
  if (v.list) {
    attrs.push('type="list"', 'allowBlank="1"', 'showErrorMessage="1"');
    if (Array.isArray(v.list)) {
      const inline = v.list.map((x) => x.replace(/[",]/g, '')).join(',');
      if (inline.length > 255) throw new Error('下拉的固定选项太长（超过 255 个字），请改用「选项」表');
      formula = `<formula1>"${esc(inline)}"</formula1>`;
    } else formula = `<formula1>${esc(v.list.name)}</formula1>`;
    if (v.error) attrs.push('errorTitle="请从下拉里选"', `error="${esc(v.error.slice(0, 225))}"`);
  } else attrs.push('allowBlank="1"');
  if (v.prompt) {
    attrs.push('showInputMessage="1"');
    if (v.promptTitle) attrs.push(`promptTitle="${esc(v.promptTitle.slice(0, 32))}"`);
    attrs.push(`prompt="${esc(v.prompt.slice(0, 255))}"`);
  }
  return `<dataValidation ${attrs.join(' ')} sqref="${esc(v.sqref)}">${formula}</dataValidation>`;
}

function worksheetXml(sheet: WbSheet): { xml: string; links: string[] } {
  const width = Math.max(sheet.widths.length, ...sheet.rows.map((r) => r.cells.length), 1);
  const rowsXml: string[] = [];
  const links: { ref: string; target: string }[] = [];
  sheet.rows.forEach((row, ri) => {
    const r = ri + 1;
    const attrs = row.height ? ` ht="${row.height}" customHeight="1"` : '';
    const cells = row.cells.map((c, ci) => {
      const ref = `${colName(ci)}${r}`;
      if (c !== null && typeof c === 'object' && c.link) links.push({ ref, target: c.link });
      return wbCellXml(ref, c);
    });
    rowsXml.push(`<row r="${r}"${attrs}>${cells.join('')}</row>`);
  });
  const lastRef = `${colName(width - 1)}${Math.max(sheet.rows.length, 1)}`;
  const freeze = sheet.freezeRows ?? 0;
  const pane = freeze > 0 ? `<pane ySplit="${freeze}" topLeftCell="A${freeze + 1}" activePane="bottomLeft" state="frozen"/>` : '';
  const xml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<dimension ref="A1:${lastRef}"/>` +
    `<sheetViews><sheetView${sheet.active ? ' tabSelected="1"' : ''} workbookViewId="0">${pane}</sheetView></sheetViews>` +
    `<sheetFormatPr defaultColWidth="14" defaultRowHeight="18"/>` +
    `<cols>${sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` +
    `<sheetData>${rowsXml.join('')}</sheetData>` +
    (sheet.merges?.length ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '') +
    (sheet.validations?.length ? `<dataValidations count="${sheet.validations.length}">${sheet.validations.map(validationXml).join('')}</dataValidations>` : '') +
    (links.length ? `<hyperlinks>${links.map((l, i) => `<hyperlink ref="${l.ref}" r:id="rId${i + 1}"/>`).join('')}</hyperlinks>` : '') +
    `<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>` +
    `</worksheet>`;
  return { xml, links: links.map((l) => l.target) };
}

const WB_STYLES =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="16"/><name val="Calibri"/></font>` +
  `<font><b/><sz val="11"/><name val="Calibri"/></font><font><sz val="10"/><color rgb="FF595959"/><name val="Calibri"/></font></fonts>` +
  `<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>` +
  `<fill><patternFill patternType="solid"><fgColor rgb="FFF8CBAD"/><bgColor indexed="64"/></patternFill></fill>` +
  `<fill><patternFill patternType="solid"><fgColor rgb="FFE7E6E6"/><bgColor indexed="64"/></patternFill></fill></fills>` +
  `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>` +
  `<border><left style="thin"><color rgb="FFBFBFBF"/></left><right style="thin"><color rgb="FFBFBFBF"/></right><top style="thin"><color rgb="FFBFBFBF"/></top><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>` +
  `<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>` +
  `<xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>` +
  `<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  `</styleSheet>`;

export function buildWorkbook(sheets: WbSheet[], names: WbName[] = []): Buffer {
  if (sheets.length === 0) throw new Error('至少一个工作表');
  const built = sheets.map(worksheetXml);
  const n = sheets.length;
  const entries: ZipEntry[] = [
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
          `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
          `<Default Extension="xml" ContentType="application/xml"/>` +
          `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
          sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
          `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
          `</Types>`,
      ),
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
          `</Relationships>`,
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
          `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
          `<bookViews><workbookView activeTab="${Math.max(0, sheets.findIndex((s) => s.active))}"/></bookViews>` +
          `<sheets>${sheets.map((s, i) => `<sheet name="${esc(sheetNameOf(s.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>` +
          (names.length ? `<definedNames>${names.map((d) => `<definedName name="${esc(d.name)}">${esc(`${quoteSheet(d.sheet)}!${d.range}`)}</definedName>`).join('')}</definedNames>` : '') +
          `</workbook>`,
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
          `<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
          `</Relationships>`,
      ),
    },
    { name: 'xl/styles.xml', data: Buffer.from(WB_STYLES) },
  ];
  built.forEach((b, i) => {
    entries.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(b.xml) });
    if (b.links.length) {
      entries.push({
        name: `xl/worksheets/_rels/sheet${i + 1}.xml.rels`,
        data: Buffer.from(
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
            `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
            b.links.map((t, j) => `<Relationship Id="rId${j + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${esc(t)}" TargetMode="External"/>`).join('') +
            `</Relationships>`,
        ),
      });
    }
  });
  return zip(entries);
}
