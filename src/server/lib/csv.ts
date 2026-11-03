import type { FastifyReply } from 'fastify';

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

export const CSV_TYPE = 'text/csv; charset=utf-8';

/** 下载文件的响应头：内容类型与文件名（中文文件名按 RFC 5987 编码）。各导出接口原来各写一份（v0.7.22 合到这里） */
export function attachment(reply: FastifyReply, fileName: string, contentType: string): FastifyReply {
  return reply.header('content-type', contentType).header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
}

/** CSV 下载：设好响应头，原样返回内容 */
export function csvReply(reply: FastifyReply, fileName: string, csv: string): string {
  attachment(reply, fileName, CSV_TYPE);
  return csv;
}
