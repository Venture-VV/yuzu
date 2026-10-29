// 生成带 BOM 的 UTF-8 CSV，Excel / Numbers 直接打开不乱码。

function escapeCell(value: string | number): string {
  let text = String(value);
  // 防止表格软件把以 = + - @ 开头的文本当作公式执行（金额列除外）
  if (/^[=+@]/.test(text) || (/^-/.test(text) && !/^-\d/.test(text))) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: (string | number)[][]): string {
  return '﻿' + rows.map((row) => row.map(escapeCell).join(',')).join('\r\n') + '\r\n';
}
