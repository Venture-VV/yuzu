// 认文件格式、读成中性图元（RQ-004 第二段，v0.7.15）：DWG 走 LibreDWG（read-dwg.ts），ASCII DXF 走 read-dxf.ts。

import type { PlanDrawing } from './model';
import { readDwg } from './read-dwg';
import { isDxf, readDxf } from './read-dxf';

export type DrawingFormat = 'dwg' | 'dxf';

/** DWG 文件头是版本号「AC10xx」（AC1015 = R2000 … AC1032 = R2018） */
export function detectFormat(bytes: Uint8Array): DrawingFormat | null {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 6));
  if (/^AC10\d\d$/.test(head)) return 'dwg';
  if (isDxf(bytes)) return 'dxf';
  return null;
}

export async function readDrawing(bytes: Uint8Array): Promise<{ format: DrawingFormat; drawing: PlanDrawing }> {
  const format = detectFormat(bytes);
  // DWG 的 WebAssembly（十几 MB）在 readDwg 里按需加载
  if (format === 'dwg') return { format, drawing: await readDwg(bytes) };
  if (format === 'dxf') return { format, drawing: readDxf(bytes) };
  throw new Error('只收 DWG 或 ASCII DXF 图纸');
}
