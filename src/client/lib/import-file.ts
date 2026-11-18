import { decodeImportFile } from '@shared/text-decode';

/** 读管理页选的导入文件：自动识别 UTF-8 / GBK；识别不了或有乱码时抛出错误（message 直接给员工看） */
export async function readImportFile(file: File): Promise<{ text: string; label: string }> {
  const { text, encoding } = decodeImportFile(new Uint8Array(await file.arrayBuffer()));
  return { text, label: encoding === 'GBK' ? `${file.name}（GBK 编码，已自动识别）` : file.name };
}

/**
 * 导入用的表格文件（OTA 渠道订单表、网银对账单）：.xlsx 原样转 base64 交给服务端解析；CSV 自动识别 UTF-8 / GBK
 * （中文 Excel / WPS「另存为 CSV」默认 GBK，按 UTF-8 读整份乱码、列都认不出来），识别不了或有乱码时抛错（message 直接给员工看）。
 * 原来 OTA 一律按 UTF-8 读、网银按 UTF-8 读出乱码再按 GBK 读，两处各写一份（Codex 审查 970c95c 后补）。
 */
export async function readTablePayload(file: File): Promise<{ csv?: string; xlsxBase64?: string }> {
  const buf = await file.arrayBuffer();
  if (/\.xlsx$/i.test(file.name)) return { xlsxBase64: bytesToBase64(buf) };
  return { csv: decodeImportFile(new Uint8Array(buf)).text };
}

/** 导入页选好的表格文件：读成交给服务端的样子（.xlsx 转 base64，CSV 读成文字），encoding 给页面显示用 */
export interface LoadedTable {
  fileName: string;
  csv?: string;
  xlsxBase64?: string;
  encoding: string;
}

/**
 * 导入页选的表格文件（空间台账、货款期初、库管入库台账、部门表格、集采清单五个导入页共用，工程治理二期：原来各写一份）：
 * 只收 .xlsx 与 .csv，CSV 自动识别 UTF-8 / GBK；别的格式、识别不了或有乱码时抛错（message 直接给员工看）。
 */
export async function loadTableFile(file: File): Promise<LoadedTable> {
  if (/\.xlsx$/i.test(file.name)) return { fileName: file.name, xlsxBase64: bytesToBase64(await file.arrayBuffer()), encoding: 'Excel' };
  if (/\.csv$/i.test(file.name) || file.type === 'text/csv') {
    const loaded = await readImportFile(file);
    return { fileName: file.name, csv: loaded.text, encoding: loaded.label.includes('GBK') ? 'GBK' : 'UTF-8' };
  }
  throw new Error('只能导入 Excel（.xlsx）或 CSV（.csv）文件；老版本的 .xls 请另存为 .xlsx 或 CSV');
}

/** 二进制文件转 base64（上传图纸、Excel 用） */
export function bytesToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
