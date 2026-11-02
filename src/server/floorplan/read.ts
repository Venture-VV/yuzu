// 认文件格式、读成中性图元（RQ-004 第二段，v0.7.15）：DWG 走 LibreDWG（read-dwg.ts），ASCII DXF 走 read-dxf.ts，
// 矢量 PDF 走 pdf.js（read-pdf.ts，要知道图纸比例：图上认不出时用 pdfScale）。

import type { PlanDrawing } from './model';
import { readDwg } from './read-dwg';
import { isDxf, readDxf } from './read-dxf';
import { isPdf, readPdf } from './read-pdf';

export type DrawingFormat = 'dwg' | 'dxf' | 'pdf';

/** DWG 文件头是版本号「AC10xx」（AC1015 = R2000 … AC1032 = R2018）；PDF 文件头是「%PDF-」 */
export function detectFormat(bytes: Uint8Array): DrawingFormat | null {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 6));
  if (/^AC10\d\d$/.test(head)) return 'dwg';
  if (isDxf(bytes)) return 'dxf';
  if (isPdf(bytes)) return 'pdf';
  return null;
}

/** opts.pdfScale：PDF 的图纸比例 1:N 的 N（上传时填的；图上认出比例时以图上的为准），DWG / DXF 不用 */
export async function readDrawing(bytes: Uint8Array, opts: { pdfScale?: number } = {}): Promise<{ format: DrawingFormat; drawing: PlanDrawing }> {
  const format = detectFormat(bytes);
  // DWG 的 WebAssembly（十几 MB）在 readDwg 里按需加载，pdf.js 在 readPdf 里按需加载
  if (format === 'dwg') return { format, drawing: await readDwg(bytes) };
  if (format === 'dxf') return { format, drawing: readDxf(bytes) };
  if (format === 'pdf') return { format, drawing: await readPdf(bytes, { scale: opts.pdfScale }) };
  throw new Error('只收 DWG、ASCII DXF 或矢量 PDF 图纸');
}
