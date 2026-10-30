// 前端构建产物预先压缩（gzip、brotli）：服务端按浏览器声明的 Accept-Encoding 直接发压缩好的文件
// （@fastify/static 的 preCompressed），不在每次请求时压缩。只压缩文本类文件；字体、图片本身已经压缩过，不再处理。
// 测试服首次打开慢（主脚本约 1 MB、没有压缩传输），Codex 2026-10-30 实测 gzip 后约小 72%。
// 用法：node scripts/compress-assets.mjs [目录，默认 dist/client]
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const root = process.argv[2] ?? 'dist/client';
const TEXT = new Set(['.js', '.mjs', '.css', '.html', '.svg', '.json', '.txt', '.webmanifest']);
/** 太小的文件压缩后省不了多少，还多一次查找，不压 */
const MIN_BYTES = 1024;

async function* files(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.isFile()) yield path;
  }
}

const all = [];
for await (const path of files(root)) all.push(path);
// 先清掉上一次留下的压缩文件（只单独重跑这个脚本时才会有），再重新压缩
for (const path of all.filter((p) => p.endsWith('.gz') || p.endsWith('.br'))) await rm(path);

let count = 0;
let raw = 0;
let gz = 0;
let br = 0;
for (const path of all) {
  if (!TEXT.has(extname(path))) continue;
  const data = await readFile(path);
  if (data.length < MIN_BYTES) continue;
  const gzipped = gzipSync(data, { level: 9 });
  const brotli = brotliCompressSync(data, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length },
  });
  // 压缩后不比原文件小就不留（服务端找不到压缩文件时照常发原文件）
  if (gzipped.length < data.length) await writeFile(`${path}.gz`, gzipped);
  if (brotli.length < data.length) await writeFile(`${path}.br`, brotli);
  count += 1;
  raw += data.length;
  gz += Math.min(gzipped.length, data.length);
  br += Math.min(brotli.length, data.length);
}

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(`预压缩 ${count} 个文件：原 ${kb(raw)} → gzip ${kb(gz)}，brotli ${kb(br)}`);
