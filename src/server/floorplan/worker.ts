// 转换进程（RQ-004 第二段，v0.7.15）：node floorplan-worker.js <图纸文件> <结果 JSON 文件>
// 读一份 13 MB 的编码图要 20 多秒、约 1.3 GB 内存，所以不在应用主进程里做；GPL 的 LibreDWG 也只在这个进程里加载。
// 结果写进文件（几 MB 的 SVG 不走进程间消息），退出码 0 成功、1 失败（失败原因也写在结果文件里）。

import { readFile, writeFile } from 'node:fs/promises';
import { convertDrawing } from './convert';
import { readDrawing } from './read';

export interface WorkerOutput {
  ok: boolean;
  error?: string;
  format?: 'dwg' | 'dxf';
  readMs?: number;
  /** 转换进程的内存峰值（MB），给运维看服务器够不够 */
  peakRssMb?: number;
  result?: ReturnType<typeof convertDrawing>;
}

async function main() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error('用法：floorplan-worker <图纸文件> <结果 JSON 文件>');
    process.exit(2);
  }
  let out: WorkerOutput;
  try {
    const bytes = new Uint8Array(await readFile(input));
    const t0 = Date.now();
    const { format, drawing } = await readDrawing(bytes);
    const readMs = Date.now() - t0;
    const result = convertDrawing(drawing);
    out = { ok: true, format, readMs, peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024), result };
  } catch (error) {
    out = { ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 400), peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024) };
  }
  await writeFile(output, JSON.stringify(out));
  process.exit(out.ok ? 0 : 1);
}

void main();
