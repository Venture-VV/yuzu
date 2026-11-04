// 生成小程序里的汤崎标志（src/assets/brand/*.png）：源文件是 assets-src/brand/*.svg（从品牌书 / VI 的 PDF 里按区域取出的原矢量路径），
// 统一是墨色 #1C1A17，这里按用到的地方换成对应的颜色、透明底，按 3 倍屏的清晰度画成 PNG。
// 小程序的 image 组件对 SVG 的支持因机型而异，所以用 PNG。改了源文件或颜色后在仓库根目录执行：node miniprogram/scripts/render-logo.mjs
// 用仓库根目录装好的 Playwright（@playwright/test）带的 Chromium 截图。

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'assets-src', 'brand');
const out = join(here, '..', 'src', 'assets', 'brand');
mkdirSync(out, { recursive: true });

let chromium;
try {
  ({ chromium } = await import('@playwright/test'));
} catch {
  ({ chromium } = await import('playwright'));
}

// 颜色与 app.wxss 一致：light = --card-ink（木色底与照片上），ink = --ink（米白底），wood = --wood（「我的」页没绑定时的虚线卡）
const COLORS = { light: '#FBF6EE', ink: '#1C1A17', wood: '#937051' };
// [源文件, 颜色, 宽（像素）]：宽按显示宽度的 3 倍左右留余量
const OUTPUTS = [
  ['logo-stacked', 'light', 360],
  ['logo-stacked', 'wood', 360],
  ['touchill', 'light', 420],
  ['touchill', 'wood', 420],
  ['logo-horizontal', 'ink', 600],
  ['touchill', 'ink', 320],
];

const browser = await chromium.launch();
for (const [name, color, width] of OUTPUTS) {
  const svg = readFileSync(join(src, `${name}.svg`), 'utf8').replace(/<!--[\s\S]*?-->\s*/g, '');
  const [, , vw, vh] = svg.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
  const height = Math.round((width * vh) / vw);
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const sized = svg.replace('<svg ', `<svg width="${width}" height="${height}" `).replaceAll('#1C1A17', COLORS[color]);
  await page.setContent(`<html><body style="margin:0;background:transparent">${sized}</body></html>`);
  const file = join(out, `${name}-${color}.png`);
  await page.locator('svg').screenshot({ path: file, omitBackground: true });
  await page.close();
  console.log('写入', file, `${width}×${height}`);
}
await browser.close();
