// 读 CSV（页面预览与服务端导入共用；v0.7.22 从服务端的 sheet-read.ts 移到这里）。
//
// 按 RFC 4180 读：引号里的逗号、换行与两个连写的引号都算单元格内容（Excel 导出的多行备注就是这样）。
// 先按引号状态切出一条条记录，再逐条校验——不能先按换行切：引号里的换行会把一条记录拆成两条，
// 拆出来的后半截如果像一行完整的数据（手机号、金额），会多写一笔。每条记录带它在文件里开始的行号。

export interface CsvRecord {
  /** 这条记录在文件里开始的行号（第 1 行起） */
  line: number;
  cells: string[];
}

/** 引号没有配对时的提示（行号是这条记录开始的行） */
export const unclosedQuoteMessage = (line: number) => `第 ${line} 行开始的引号没有配对，请检查文件（单元格里的引号要写成两个）`;

/** 切出所有记录（含空行）；引号没有配对时 unclosedQuoteLine 是那条记录开始的行号 */
export function parseCsvRecords(text: string): { records: CsvRecord[]; unclosedQuoteLine: number | null } {
  const records: CsvRecord[] = [];
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
  if (quoted) return { records, unclosedQuoteLine: startLine };
  if (cur !== '' || cells.length > 0) {
    cells.push(cur);
    records.push({ line: startLine, cells });
  }
  return { records: records.map((r) => ({ line: r.line, cells: r.cells.map((c) => c.replace(/\r\n?/g, '\n').trim()) })), unclosedQuoteLine: null };
}

/**
 * 读成「表头 + 数据行」：去掉开头的 BOM，跳过整行都空的记录，第一条不空的记录是表头。
 * 导入文件（会员期初、手牌柜号、价目表）都按这个读。
 */
export function readCsvTable(text: string): { header: CsvRecord | null; rows: CsvRecord[]; unclosedQuoteLine: number | null } {
  const { records, unclosedQuoteLine } = parseCsvRecords(text.replace(/^﻿/, ''));
  const filled = records.filter((r) => r.cells.some((c) => c !== ''));
  return { header: filled[0] ?? null, rows: filled.slice(1), unclosedQuoteLine };
}
