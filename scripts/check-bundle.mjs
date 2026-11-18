// 打包体积检查（工程治理二期，docs/GOVERNANCE.md）：npm run build 之后跑 npm run check:bundle，CI 跑。
// 首屏主包（index.html 直接引的那个脚本）不许超过上限：重的库（PDF、二维码识别、识别模型）和不常用的页面都该按需加载，
// 不小心在入口直接 import 了，这里会报出来。上限记在 scripts/governance-baseline.json 的 entryChunkMaxKb。
// 退出码：0 通过，1 超了或没找到产物。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');

/** index.html 里直接引的脚本（入口）：返回相对 dist/client 的路径 */
export function entryScripts(html) {
  return [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+\.js)"/g)].map((m) => m[1].replace(/^\//, ''));
}

/** 与上限比：返回问题（null = 通过） */
export function bundleProblem(entryKb, maxKb) {
  if (entryKb <= maxKb) return null;
  return `首屏主包 ${entryKb} KB，超过上限 ${maxKb} KB：看看是不是在入口（App.tsx、AppShell、公共部件）直接 import 了重的库或不常用的页面，改成按需加载（lib/lazyPage 的 lazyPage、动态 import()）`;
}

function main() {
  const dist = join(ROOT, 'dist/client');
  let html;
  try {
    html = readFileSync(join(dist, 'index.html'), 'utf8');
  } catch {
    console.error('✗ 没找到 dist/client/index.html：先跑 npm run build');
    process.exit(1);
  }
  const entries = entryScripts(html);
  if (!entries.length) {
    console.error('✗ dist/client/index.html 里没找到入口脚本');
    process.exit(1);
  }
  const entryKb = Math.ceil(entries.reduce((sum, f) => sum + statSync(join(dist, f)).size, 0) / 1024);
  const assets = readdirSync(join(dist, 'assets')).filter((f) => f.endsWith('.js'));
  const totalKb = Math.ceil(assets.reduce((sum, f) => sum + statSync(join(dist, 'assets', f)).size, 0) / 1024);
  const { entryChunkMaxKb } = JSON.parse(readFileSync(join(ROOT, 'scripts/governance-baseline.json'), 'utf8'));
  const problem = bundleProblem(entryKb, entryChunkMaxKb);
  if (problem) {
    console.error(`✗ 打包体积检查没过：${problem}`);
    process.exit(1);
  }
  console.log(`✓ 打包体积检查通过：首屏主包 ${entryKb} KB（上限 ${entryChunkMaxKb} KB），页面脚本共 ${assets.length} 个、${totalKb} KB（按需加载）`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
