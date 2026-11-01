// 导入文件读取（v0.7.12 起供应商与期初未付导入用，v0.7.14 抽出来给空间台账导入共用）：
// CSV（浏览器已按 UTF-8 / GBK 识别成文字）或 Excel（.xlsx 原文件，读第一个工作表）；第一行是表头，按列名找。

import { createHash } from 'node:crypto';
import { unprocessable } from './errors';
import { readXlsx, serialToDate, XlsxReadError } from './xlsx-read';

export interface Sheet {
  sha256: string;
  header: string[];
  /** 文件行号（表头是第 1 行）→ 单元格 */
  rows: { row: number; cells: string[] }[];
}

/**
 * 按 RFC 4180 读 CSV：引号里的逗号、换行与两个连写的引号都算单元格内容（Excel 导出的多行备注就是这样）。
 * 先按引号状态切出一条条记录，再逐条校验——不能先按换行切：引号里的换行会把一条记录拆成两条，
 * 拆出来的后半截如果像一行完整的数据（编码、金额、日期），会多写一笔。返回每条记录在文件里开始的行号。
 */
export function parseCsv(text: string): { line: number; cells: string[] }[] {
  const records: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cur = '';
  let quoted = false;
  let line = 1;
  let startLine = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === '\n' || (ch === '\r' && text[i + 1] !== '\n')) line++;
        cur += ch;
      }
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      cells.push(cur);
      cur = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      cells.push(cur);
      records.push({ line: startLine, cells });
      cells = [];
      cur = '';
      line++;
      startLine = line;
    } else cur += ch;
  }
  if (quoted) throw unprocessable('IMPORT_FILE_INVALID', `第 ${startLine} 行开始的引号没有配对，请检查文件（单元格里的引号要写成两个）`);
  if (cur !== '' || cells.length > 0) {
    cells.push(cur);
    records.push({ line: startLine, cells });
  }
  return records.map((r) => ({ line: r.line, cells: r.cells.map((c) => c.replace(/\r\n?/g, '\n').trim()) }));
}

export function readSheet(f: { csv?: string; xlsxBase64?: string }, dateColumns: string[] = []): Sheet {
  if (f.csv !== undefined) {
    // 空行（包括只有逗号的行）不算数据，与 Excel 一样跳过
    const records = parseCsv(f.csv.replace(/^\ufeff/, '')).filter((r) => r.cells.some((c) => c !== ''));
    const [head, ...rest] = records;
    if (!head) throw unprocessable('IMPORT_EMPTY', '文件是空的');
    return { sha256: createHash('sha256').update(f.csv, 'utf8').digest('hex'), header: head.cells, rows: rest.map((r) => ({ row: r.line, cells: r.cells })) };
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
  const headerRow = rowNos.find((r) => [...(sheet.rows.get(r)?.values() ?? [])].some((c) => (c.value ?? '').trim() !== ''));
  if (headerRow === undefined) throw unprocessable('IMPORT_EMPTY', '文件是空的');
  const width = Math.max(...[...sheet.rows.get(headerRow)!.keys()]) + 1;
  const header = Array.from({ length: width }, (_, c) => textAt(headerRow, c));
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
    if (cells.every((c) => c === '')) continue;
    rows.push({ row: r, cells });
  }
  return { sha256: createHash('sha256').update(buf).digest('hex'), header, rows };
}
