// 导入文件读取（v0.7.12 起供应商与期初未付导入用，v0.7.14 抽出来给空间台账导入共用）：
// CSV（浏览器已按 UTF-8 / GBK 识别成文字）或 Excel（.xlsx 原文件，读第一个工作表）；第一行是表头，按列名找。
// 供应链二次整改（docs/ERP_ROUND2.md）：表头上面有标题行的（集采最终版）可以给 findHeader，在前几行里找表头；
// Excel 单元格带的超链接一起读出来（links，与 cells 一一对应）。

import { createHash } from 'node:crypto';
import { parseCsvRecords, unclosedQuoteMessage, type CsvRecord } from '@shared/csv-read';
import { unprocessable } from './errors';
import { colName } from './xlsx';
import { readXlsx, serialToDate, XlsxReadError } from './xlsx-read';

export interface Sheet {
  sha256: string;
  header: string[];
  /** 表头在文件里的第几行 */
  headerRow: number;
  /** 文件行号（表头是第 1 行）→ 单元格；links：单元格带的超链接地址（CSV 没有） */
  rows: { row: number; cells: string[]; links: (string | null)[] }[];
}

export interface SheetOptions {
  /** 这几列是日期：Excel 存成序号的换成 YYYY-MM-DD */
  dateColumns?: string[];
  /** 表头是哪一行：在前 headerScan 行（默认 10）里找第一行满足的；不给就是第一行有内容的 */
  findHeader?: (cells: string[]) => boolean;
  headerScan?: number;
}

/** 按 RFC 4180 读 CSV（实现在 @shared/csv-read，页面预览与服务端共用）；引号没有配对时整份拒绝 */
export function parseCsv(text: string): CsvRecord[] {
  const { records, unclosedQuoteLine } = parseCsvRecords(text);
  if (unclosedQuoteLine !== null) throw unprocessable('IMPORT_FILE_INVALID', unclosedQuoteMessage(unclosedQuoteLine));
  return records;
}

export function readSheet(f: { csv?: string; xlsxBase64?: string }, options: string[] | SheetOptions = []): Sheet {
  const opts: SheetOptions = Array.isArray(options) ? { dateColumns: options } : options;
  const dateColumns = opts.dateColumns ?? [];
  const scan = opts.headerScan ?? 10;
  const isHeader = (cells: string[], index: number) => (opts.findHeader ? index < scan && opts.findHeader(cells.map((c) => c.trim())) : true);
  if (f.csv !== undefined) {
    // 空行（包括只有逗号的行）不算数据，与 Excel 一样跳过
    const records = parseCsv(f.csv.replace(/^\ufeff/, '')).filter((r) => r.cells.some((c) => c !== ''));
    if (records.length === 0) throw unprocessable('IMPORT_EMPTY', '文件是空的');
    const at = records.findIndex((r, i) => isHeader(r.cells, i));
    const head = records[at < 0 ? 0 : at]!;
    const rest = records.slice((at < 0 ? 0 : at) + 1);
    return {
      sha256: createHash('sha256').update(f.csv, 'utf8').digest('hex'),
      header: head.cells.map((c) => c.trim()),
      headerRow: head.line,
      rows: rest.map((r) => ({ row: r.line, cells: r.cells, links: r.cells.map(() => null) })),
    };
  }
  const buf = Buffer.from(f.xlsxBase64!, 'base64');
  let book;
  try {
    book = readXlsx(buf);
  } catch (error) {
    if (error instanceof XlsxReadError) throw unprocessable('IMPORT_FILE_INVALID', error.message);
    throw error;
  }
  const sheet = book.sheets[0];
  if (!sheet) throw unprocessable('IMPORT_EMPTY', 'Excel 文件里没有工作表');
  const rowNos = [...sheet.rows.keys()].sort((a, b) => a - b);
  const textAt = (r: number, c: number) => {
    const cell = sheet.rows.get(r)?.get(c);
    return (cell?.value ?? '').trim();
  };
  const filled = rowNos.filter((r) => [...(sheet.rows.get(r)?.values() ?? [])].some((c) => (c.value ?? '').trim() !== ''));
  if (filled.length === 0) throw unprocessable('IMPORT_EMPTY', '文件是空的');
  const lineOf = (r: number) => {
    const line = sheet.rows.get(r)!;
    return Array.from({ length: Math.max(...line.keys()) + 1 }, (_, c) => textAt(r, c));
  };
  const headerRow = filled.find((r, i) => isHeader(lineOf(r), i)) ?? filled[0]!;
  const header = lineOf(headerRow);
  const width = header.length;
  const dateCols = new Set(dateColumns.map((name) => header.indexOf(name)).filter((i) => i >= 0));
  const rows: Sheet['rows'] = [];
  for (const r of rowNos) {
    if (r <= headerRow) continue;
    const cells = Array.from({ length: width }, (_, c) => {
      const cell = sheet.rows.get(r)?.get(c);
      const text = (cell?.value ?? '').trim();
      // Excel 的日期存成序号
      if (dateCols.has(c) && cell?.type === 'number' && /^\d+(\.\d+)?$/.test(text)) return serialToDate(Number(text)) ?? text;
      return text;
    });
    const links = Array.from({ length: width }, (_, c) => sheet.hyperlinks.get(`${colName(c)}${r}`) ?? null);
    if (cells.every((c) => c === '') && links.every((l) => l === null)) continue;
    rows.push({ row: r, cells, links });
  }
  return { sha256: createHash('sha256').update(buf).digest('hex'), header, headerRow, rows };
}
