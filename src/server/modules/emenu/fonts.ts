// 授权的品牌字体（8.1.5，docs/EMENU.md 第 14.2 节，PENDING_DECISIONS.md PP4）：英文 ABC Arizona Flare 是商业字体，
// 网页授权的文件不进 Git（代码库是公开的）、不进镜像，由门店把文件放在服务器的 brand-fonts 目录里（config.brandFontPath）。
// 只认固定的几个文件名，不按请求里的路径找文件；文件头要是 WOFF2（wOF2），放错了文件当没放。

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const FILES = new Set(['en.woff2']);
/** 网页字体一般几十到几百 KB；大于这个的不发 */
const MAX_BYTES = 4 * 1024 * 1024;

export async function readBrandFont(dir: string, name: string): Promise<{ data: Buffer; etag: string } | null> {
  if (!FILES.has(name)) return null;
  const path = join(dir, name);
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size < 4 || info.size > MAX_BYTES) return null;
    const data = await readFile(path);
    if (data.subarray(0, 4).toString('latin1') !== 'wOF2') return null;
    return { data, etag: `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"` };
  } catch {
    return null;
  }
}
