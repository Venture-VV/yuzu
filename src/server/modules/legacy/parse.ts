// 旧账四份原始 Excel 的解析（v0.7.10，见 docs/LEGACY_LEDGER.md）：按表头名称认列，保留原值与行号。
// 只做读取与规整（日期、金额换成分、数量换成千分之一），推定的分类在核验时按口径算，不在这里写死。

import {
  LEGACY_SOURCE_LABELS,
  type LegacyBrandLine,
  type LegacyLedgerLine,
  type LegacyMaterialLine,
  type LegacyOrderedLine,
  type LegacyPaymentDay,
  type LegacyRawCells,
  type LegacySource,
} from '@shared/legacy';
import { dispImgId, readXlsx, serialToDate, XlsxReadError, type XlsxCell, type XlsxSheet } from '../../lib/xlsx-read';

export class LegacyParseError extends Error {}

export type ParsedOrderedLine = Omit<LegacyOrderedLine, 'imageId'> & { imageKey: string | null };

export interface ParsedSheetMeta {
  name: string;
  /** 工作表里写出来的行数（含空行） */
  rowElements: number;
  /** 表头在第几行（没认出表头的表为 0） */
  headerRow: number;
  /** 导入了几行 */
  rows: number;
}

export interface ParsedLegacy {
  source: LegacySource;
  sheets: ParsedSheetMeta[];
  /** 表里自带的合计行（列名 → 分） */
  fileTotals: Record<string, number>;
  ledger: LegacyLedgerLine[];
  payments: LegacyPaymentDay[];
  materials: LegacyMaterialLine[];
  ordered: ParsedOrderedLine[];
  brand: LegacyBrandLine[];
  /** 已下单物料用到的单元格图：图片编号 → 内容 */
  images: Map<string, { data: Buffer; mime: string }>;
  warnings: string[];
}

// ───────────────────────── 单元格取值 ─────────────────────────

const norm = (s: string) => s.replace(/\s+/g, '');

function text(c: XlsxCell | undefined): string {
  if (!c || c.value === null) return '';
  return c.value.trim();
}

function display(c: XlsxCell): string {
  const v = c.value ?? '';
  return c.formula ? `=${c.formula}${v !== '' ? ` → ${v}` : ''}` : v;
}

/** 只算纯四则运算的公式（文件里没存计算结果时用）；算不了返回 null */
export function evalArithmetic(formula: string): number | null {
  const src = formula.replace(/^=/, '').replace(/\s+/g, '');
  if (!/^[0-9+\-*/().]+$/.test(src)) return null;
  let i = 0;
  const peek = () => src[i];
  function factor(): number {
    const ch = peek();
    if (ch === '+' || ch === '-') {
      i++;
      const v = factor();
      return ch === '-' ? -v : v;
    }
    if (ch === '(') {
      i++;
      const v = expr();
      if (peek() !== ')') throw new Error('paren');
      i++;
      return v;
    }
    const m = /^\d+(\.\d+)?|^\.\d+/.exec(src.slice(i));
    if (!m) throw new Error('number');
    i += m[0].length;
    return Number(m[0]);
  }
  function term(): number {
    let v = factor();
    while (peek() === '*' || peek() === '/') {
      const op = src[i++];
      const r = factor();
      v = op === '*' ? v * r : v / r;
    }
    return v;
  }
  function expr(): number {
    let v = term();
    while (peek() === '+' || peek() === '-') {
      const op = src[i++];
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  try {
    const v = expr();
    return i === src.length && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

function num(c: XlsxCell | undefined): number | null {
  if (!c) return null;
  if (c.value !== null && c.value.trim() !== '') {
    const s = c.value.trim();
    if (c.type === 'number' || /^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s)) {
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }
  return c.formula ? evalArithmetic(c.formula) : null;
}

/** 元 → 分：按最短的十进制写法四舍五入到分（避免 1.005 这类二进制误差） */
export function toCents(n: number): number {
  const sign = n < 0 ? -1 : 1;
  let s = String(Math.abs(n));
  if (/e/i.test(s)) s = Math.abs(n).toFixed(10);
  const [int, frac = ''] = s.split('.');
  const padded = (frac + '000').slice(0, 3);
  let cents = Number(int) * 100 + Number(padded.slice(0, 2));
  if (Number(padded[2]) >= 5) cents += 1;
  return sign * cents;
}

const toMilli = (n: number) => Math.round(n * 1000);

/** 文字写的日期：2026-9-1、2026/9/1、2026.9.1、2026年9月1日 */
export function parseDateText(s: string): string | null {
  const m = /^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$/.exec(s.trim());
  if (!m) return null;
  const iso = `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso;
}

function dateOf(c: XlsxCell | undefined): { date: string | null; text: string } {
  if (!c) return { date: null, text: '' };
  const n = c.type === 'number' ? num(c) : null;
  if (n !== null) return { date: serialToDate(n), text: c.value ?? '' };
  const t = text(c);
  return { date: t ? parseDateText(t) : null, text: t };
}

/** 税点：0.13、13%、13 → 万分之几 */
function taxBp(c: XlsxCell | undefined): number | null {
  const t = text(c);
  if (!t) return null;
  const pct = /^(\d+(\.\d+)?)\s*%$/.exec(t);
  if (pct) return Math.round(Number(pct[1]) * 100);
  const n = num(c);
  if (n === null) return null;
  return n < 1 ? Math.round(n * 10_000) : Math.round(n * 100);
}

const YES = new Set(['是', '√', '✓', '✔', 'Y', 'y', 'yes', 'Yes']);

// ───────────────────────── 表头 ─────────────────────────

interface ColumnSpec {
  key: string;
  /** 表头名称（去掉空白后）；以「…」结尾的按前缀匹配 */
  names: string[];
}

function matches(header: string, name: string): boolean {
  return name.endsWith('…') ? header.startsWith(name.slice(0, -1)) : header === name;
}

function findHeader(sheet: XlsxSheet, specs: ColumnSpec[], maxScan = 6): { row: number; cols: Record<string, number> } | null {
  for (let r = 1; r <= maxScan; r++) {
    const line = sheet.rows.get(r);
    if (!line) continue;
    const cols: Record<string, number> = {};
    for (const c of line.values()) {
      const h = norm(text(c));
      if (!h) continue;
      const spec = specs.find((s) => cols[s.key] === undefined && s.names.some((n) => matches(h, n)));
      if (spec) cols[spec.key] = c.col;
    }
    if (specs.every((s) => cols[s.key] !== undefined)) return { row: r, cols };
  }
  return null;
}

function headerNames(sheet: XlsxSheet, row: number): string[] {
  const line = sheet.rows.get(row);
  return line ? [...line.values()].sort((a, b) => a.col - b.col).map((c) => norm(text(c))) : [];
}

function rawOf(sheet: XlsxSheet, headerRow: number, row: Map<number, XlsxCell>): LegacyRawCells {
  const names = new Map<number, string>();
  const header = sheet.rows.get(headerRow);
  if (header) for (const c of header.values()) names.set(c.col, norm(text(c)) || `第${c.col + 1}列`);
  const out: LegacyRawCells = {};
  for (const c of [...row.values()].sort((a, b) => a.col - b.col)) {
    const v = display(c);
    if (v !== '') out[names.get(c.col) ?? `第${c.col + 1}列`] = v;
  }
  return out;
}

/** 竖着合并的格子：（行，列）→ 合并格第一行 */
function mergedTop(sheet: XlsxSheet): (row: number, col: number) => number | null {
  return (row, col) => {
    for (const m of sheet.merges) if (col >= m.c1 && col <= m.c2 && row > m.r1 && row <= m.r2) return m.r1;
    return null;
  };
}

const isTotalRow = (row: Map<number, XlsxCell>) => [...row.values()].some((c) => c.type === 'string' && /^(合计|小计|总计)$/.test(norm(text(c))));
const colLetter = (col: number) => {
  let s = '';
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

// ───────────────────────── 四份表 ─────────────────────────

const LEDGER_COLS: ColumnSpec[] = [
  { key: 'seq', names: ['序号'] },
  { key: 'date', names: ['日期'] },
  { key: 'item', names: ['类别'] },
  { key: 'qty', names: ['数量'] },
  { key: 'amount', names: ['金额'] },
  { key: 'merchant', names: ['商户'] },
  { key: 'purpose', names: ['用途'] },
  { key: 'invoice', names: ['是否有发票', '发票…'] },
  { key: 'note', names: ['备注'] },
];
const PAYMENT_COLS: ColumnSpec[] = [
  { key: 'date', names: ['日期'] },
  { key: 'advance', names: ['打款金额', '打款'] },
  { key: 'should', names: ['应退回金额', '应退回'] },
  { key: 'returned', names: ['退回出纳', '实际退回…'] },
  { key: 'note', names: ['备注'] },
];
const MATERIAL_COLS: ColumnSpec[] = [
  { key: 'seq', names: ['序号'] },
  { key: 'date', names: ['购买日期'] },
  { key: 'item', names: ['物品名'] },
  { key: 'purpose', names: ['用途'] },
  { key: 'amount', names: ['金额'] },
  { key: 'bought', names: ['购买数量'] },
  { key: 'received', names: ['到货数量'] },
  { key: 'department', names: ['部门'] },
  { key: 'invoice', names: ['发票…'] },
  { key: 'tax', names: ['税点'] },
  { key: 'category', names: ['备注…', '费用科目'] },
];
const ORDERED_COLS: ColumnSpec[] = [
  { key: 'date', names: ['下单时间', '下单日期'] },
  { key: 'product', names: ['产品名称'] },
  { key: 'image', names: ['图片'] },
  { key: 'variant', names: ['选款'] },
  { key: 'department', names: ['部门'] },
  { key: 'orderer', names: ['下单人'] },
  { key: 'qty', names: ['数量'] },
  { key: 'amount', names: ['金额'] },
  { key: 'note', names: ['备注'] },
];
const BRAND_COLS: ColumnSpec[] = [
  { key: 'seq', names: ['序号'] },
  { key: 'ordered', names: ['是否下单'] },
  { key: 'received', names: ['是否到货'] },
  { key: 'returned', names: ['是否退货'] },
  { key: 'product', names: ['产品名称'] },
  { key: 'purpose', names: ['用途'] },
  { key: 'qty', names: ['采购数量'] },
  { key: 'note', names: ['备注'] },
  { key: 'details', names: ['产品详情'] },
  { key: 'link', names: ['参考链接…'] },
];

function emptyResult(source: LegacySource): ParsedLegacy {
  return { source, sheets: [], fileTotals: {}, ledger: [], payments: [], materials: [], ordered: [], brand: [], images: new Map(), warnings: [] };
}

function parsePurchaseLedger(sheets: XlsxSheet[]): ParsedLegacy {
  const out = emptyResult('purchase_ledger');
  const detail = sheets.map((s) => ({ s, h: findHeader(s, LEDGER_COLS) })).find((x) => x.h);
  const pay = sheets.map((s) => ({ s, h: findHeader(s, PAYMENT_COLS) })).find((x) => x.h && x.s !== detail?.s);
  if (!detail?.h || !pay?.h) throw new LegacyParseError('采购台账要有「费用报销明细」与「付款台账」两张表');
  {
    const { s, h } = detail;
    const top = mergedTop(s);
    let seen = false;
    for (const [r, row] of [...s.rows].sort((a, b) => a[0] - b[0])) {
      if (r <= h.row || row.size === 0) continue;
      if (isTotalRow(row)) {
        out.warnings.push(`「${s.name}」第 ${r} 行是合计行，没有导入`);
        continue;
      }
      const seq = text(row.get(h.cols.seq!));
      if (seq) seen = true;
      const d = dateOf(row.get(h.cols.date!));
      const amountCell = row.get(h.cols.amount!);
      const amount = num(amountCell);
      out.ledger.push({
        rowNo: r,
        seq,
        date: d.date,
        dateText: d.text,
        item: text(row.get(h.cols.item!)),
        qtyText: text(row.get(h.cols.qty!)),
        amountCents: amount === null ? null : toCents(amount),
        amountFormula: amountCell?.formula ?? null,
        merchant: text(row.get(h.cols.merchant!)),
        purpose: text(row.get(h.cols.purpose!)),
        invoice: text(row.get(h.cols.invoice!)),
        note: text(row.get(h.cols.note!)),
        mergedInto: amount === null ? top(r, h.cols.amount!) : null,
        preHeader: !seen,
        raw: rawOf(s, h.row, row),
      });
    }
    out.sheets.push({ name: s.name, rowElements: s.rowElements, headerRow: h.row, rows: out.ledger.length });
  }
  {
    const { s, h } = pay;
    for (const [r, row] of [...s.rows].sort((a, b) => a[0] - b[0])) {
      if (r <= h.row || row.size === 0) continue;
      const cellNum = (key: string) => {
        const c = row.get(h.cols[key]!);
        const n = num(c);
        return { cents: n === null ? null : toCents(n), formula: c?.formula ?? null };
      };
      if (isTotalRow(row)) {
        for (const [key, label] of [['advance', '打款金额'], ['should', '应退回金额'], ['returned', '退回出纳']] as const) {
          const v = cellNum(key).cents;
          if (v !== null) out.fileTotals[label] = v;
        }
        continue;
      }
      const d = dateOf(row.get(h.cols.date!));
      const a = cellNum('advance');
      const sr = cellNum('should');
      const rt = cellNum('returned');
      out.payments.push({
        rowNo: r,
        date: d.date,
        dateText: d.text,
        advanceCents: a.cents,
        advanceFormula: a.formula,
        shouldReturnCents: sr.cents,
        shouldReturnFormula: sr.formula,
        returnedCents: rt.cents,
        returnedFormula: rt.formula,
        note: text(row.get(h.cols.note!)),
        raw: rawOf(s, h.row, row),
      });
    }
    out.sheets.push({ name: s.name, rowElements: s.rowElements, headerRow: h.row, rows: out.payments.length });
  }
  return out;
}

function parseMaterialDetail(sheets: XlsxSheet[]): ParsedLegacy {
  const out = emptyResult('material_detail');
  for (const s of sheets) {
    const h = findHeader(s, MATERIAL_COLS);
    if (!h) continue;
    const top = mergedTop(s);
    const before = out.materials.length;
    for (const [r, row] of [...s.rows].sort((a, b) => a[0] - b[0])) {
      if (r <= h.row || row.size === 0) continue;
      if (isTotalRow(row)) {
        out.warnings.push(`「${s.name}」第 ${r} 行是合计行，没有导入`);
        continue;
      }
      const d = dateOf(row.get(h.cols.date!));
      const amountCell = row.get(h.cols.amount!);
      const amount = num(amountCell);
      const bought = num(row.get(h.cols.bought!));
      const received = num(row.get(h.cols.received!));
      out.materials.push({
        sheet: s.name,
        rowNo: r,
        seq: text(row.get(h.cols.seq!)),
        date: d.date,
        dateText: d.text,
        item: text(row.get(h.cols.item!)),
        purpose: text(row.get(h.cols.purpose!)),
        amountCents: amount === null ? null : toCents(amount),
        amountFormula: amountCell?.formula ?? null,
        boughtText: text(row.get(h.cols.bought!)),
        boughtMilli: bought === null ? null : toMilli(bought),
        receivedText: text(row.get(h.cols.received!)),
        receivedMilli: received === null ? null : toMilli(received),
        department: text(row.get(h.cols.department!)),
        invoice: text(row.get(h.cols.invoice!)),
        taxText: text(row.get(h.cols.tax!)),
        taxRateBp: taxBp(row.get(h.cols.tax!)),
        category: text(row.get(h.cols.category!)),
        mergedInto: amount === null ? top(r, h.cols.amount!) : null,
        raw: rawOf(s, h.row, row),
      });
    }
    out.sheets.push({ name: s.name, rowElements: s.rowElements, headerRow: h.row, rows: out.materials.length - before });
  }
  if (out.sheets.length === 0) throw new LegacyParseError('采购物资明细表没有认出任何一张月份表');
  return out;
}

function parseOrdered(sheets: XlsxSheet[], cellImages: Map<string, { data: Buffer; ext: string }>): ParsedLegacy {
  const out = emptyResult('ordered_materials');
  for (const s of sheets) {
    const h = findHeader(s, ORDERED_COLS);
    if (!h) continue;
    const top = mergedTop(s);
    const before = out.ordered.length;
    const keyByRow = new Map<number, string | null>();
    for (const [r, row] of [...s.rows].sort((a, b) => a[0] - b[0])) {
      if (r <= h.row || row.size === 0) continue;
      if (isTotalRow(row)) {
        out.warnings.push(`「${s.name}」第 ${r} 行是合计行，没有导入`);
        continue;
      }
      const d = dateOf(row.get(h.cols.date!));
      let imageKey = dispImgId(row.get(h.cols.image!)?.formula ?? null);
      let imageShared = false;
      if (!imageKey) {
        const t = top(r, h.cols.image!);
        if (t !== null && keyByRow.get(t)) {
          imageKey = keyByRow.get(t)!;
          imageShared = true;
        }
      }
      if (imageKey && !cellImages.has(imageKey)) {
        out.warnings.push(`「${s.name}」第 ${r} 行的图片在文件里找不到`);
        imageKey = null;
      }
      keyByRow.set(r, imageKey);
      if (imageKey && !out.images.has(imageKey)) {
        const img = cellImages.get(imageKey)!;
        const mime = img.ext === 'png' ? 'image/png' : img.ext === 'jpg' || img.ext === 'jpeg' ? 'image/jpeg' : img.ext === 'gif' ? 'image/gif' : img.ext === 'webp' ? 'image/webp' : null;
        if (mime) out.images.set(imageKey, { data: img.data, mime });
        else {
          out.warnings.push(`「${s.name}」第 ${r} 行的图片格式（${img.ext}）不认识，没有导入`);
          imageKey = null;
        }
      }
      const amountCell = row.get(h.cols.amount!);
      const amount = num(amountCell);
      const qty = num(row.get(h.cols.qty!));
      out.ordered.push({
        sheet: s.name,
        rowNo: r,
        date: d.date,
        dateText: d.text,
        product: text(row.get(h.cols.product!)),
        imageKey,
        imageShared,
        variant: text(row.get(h.cols.variant!)),
        department: text(row.get(h.cols.department!)),
        orderer: text(row.get(h.cols.orderer!)),
        qtyText: text(row.get(h.cols.qty!)),
        qtyMilli: qty === null ? null : toMilli(qty),
        amountCents: amount === null ? null : toCents(amount),
        amountFormula: amountCell?.formula ?? null,
        note: text(row.get(h.cols.note!)),
        mergedInto: amount === null ? top(r, h.cols.amount!) : null,
        raw: rawOf(s, h.row, row),
      });
    }
    out.sheets.push({ name: s.name, rowElements: s.rowElements, headerRow: h.row, rows: out.ordered.length - before });
  }
  if (out.sheets.length === 0) throw new LegacyParseError('已下单物料没有认出任何一张表');
  return out;
}

function parseBrand(sheets: XlsxSheet[]): ParsedLegacy {
  const out = emptyResult('brand_requests');
  const found = sheets.map((s) => ({ s, h: findHeader(s, BRAND_COLS) })).find((x) => x.h);
  if (!found?.h) throw new LegacyParseError('品牌新增寻款采购清单没有认出表头');
  const { s, h } = found;
  for (const [r, row] of [...s.rows].sort((a, b) => a[0] - b[0])) {
    if (r <= h.row || row.size === 0) continue;
    if (isTotalRow(row)) {
      out.warnings.push(`「${s.name}」第 ${r} 行是合计行，没有导入`);
      continue;
    }
    const qty = num(row.get(h.cols.qty!));
    const yes = (key: string) => YES.has(text(row.get(h.cols[key]!)));
    out.brand.push({
      rowNo: r,
      seq: text(row.get(h.cols.seq!)),
      ordered: yes('ordered'),
      received: yes('received'),
      returned: yes('returned'),
      product: text(row.get(h.cols.product!)),
      purpose: text(row.get(h.cols.purpose!)),
      qtyText: text(row.get(h.cols.qty!)),
      qtyMilli: qty === null ? null : toMilli(qty),
      note: text(row.get(h.cols.note!)),
      details: text(row.get(h.cols.details!)),
      linkText: text(row.get(h.cols.link!)),
      linkUrl: s.hyperlinks.get(`${colLetter(h.cols.link!)}${r}`) ?? '',
      raw: rawOf(s, h.row, row),
    });
  }
  out.sheets.push({ name: s.name, rowElements: s.rowElements, headerRow: h.row, rows: out.brand.length });
  return out;
}

/** 认出是哪一份表并解析；认不出整份拒绝，说明各份表要的表头 */
export function parseLegacyWorkbook(buf: Buffer): ParsedLegacy {
  let wb;
  try {
    wb = readXlsx(buf);
  } catch (e) {
    if (e instanceof XlsxReadError) throw new LegacyParseError(e.message);
    throw e;
  }
  const has = (specs: ColumnSpec[]) => wb.sheets.some((s) => findHeader(s, specs));
  const candidates: LegacySource[] = [];
  if (has(LEDGER_COLS) && has(PAYMENT_COLS)) candidates.push('purchase_ledger');
  if (has(MATERIAL_COLS)) candidates.push('material_detail');
  if (has(ORDERED_COLS)) candidates.push('ordered_materials');
  if (has(BRAND_COLS)) candidates.push('brand_requests');
  if (candidates.length !== 1) {
    const seen = wb.sheets.map((s) => `「${s.name}」：${headerNames(s, 1).concat(headerNames(s, 2), headerNames(s, 3)).filter(Boolean).slice(0, 12).join('、') || '（空）'}`);
    throw new LegacyParseError(
      candidates.length === 0
        ? `认不出是哪一份旧账。要的表头见 docs/LEGACY_LEDGER.md 第 2 节；这个文件里是：${seen.join('；')}`
        : `同一个文件里认出了几份旧账（${candidates.map((c) => LEGACY_SOURCE_LABELS[c]).join('、')}），请一份一份导入`,
    );
  }
  const source = candidates[0]!;
  if (source === 'purchase_ledger') return parsePurchaseLedger(wb.sheets);
  if (source === 'material_detail') return parseMaterialDetail(wb.sheets);
  if (source === 'ordered_materials') return parseOrdered(wb.sheets, wb.cellImages);
  return parseBrand(wb.sheets);
}
