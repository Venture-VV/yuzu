// 生成底部标签栏的图标（src/assets/tab/*.png）：细线图标，未选中用 #776C60、选中用 #1C1A17（与 app.json 的 tabBar 颜色一致）。
// 微信要求标签栏图标是本地 PNG、不超过 40KB，建议 81×81。改了图形后在仓库根目录执行：node miniprogram/scripts/render-icons.mjs
// 用仓库根目录装好的 Playwright（@playwright/test）带的 Chromium 截图。

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'src', 'assets', 'tab');
mkdirSync(out, { recursive: true });

let chromium;
try {
  ({ chromium } = await import('@playwright/test'));
} catch {
  ({ chromium } = await import('playwright'));
}

// 24×24 的线稿（stroke-width 1.4，圆头圆角），画到 81×81
const ICONS = {
  home: '<path d="M3.5 10.5 12 4l8.5 6.5"/><path d="M5.5 9v10.5h13V9"/><path d="M10 19.5v-5h4v5"/>',
  prices: '<rect x="5" y="3.5" width="14" height="17" rx="1.5"/><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4"/>',
  guide: '<path d="M3.5 6.5 9 4.5l6 2 5.5-2v13l-5.5 2-6-2-5.5 2z"/><path d="M9 4.5v13M15 6.5v13"/>',
  me: '<circle cx="12" cy="8.5" r="3.6"/><path d="M4.5 20c.9-3.9 4-6 7.5-6s6.6 2.1 7.5 6"/>',
};
const COLORS = { '': '#776C60', '-on': '#1C1A17' };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 81, height: 81 }, deviceScaleFactor: 1 });
for (const [name, body] of Object.entries(ICONS)) {
  for (const [suffix, color] of Object.entries(COLORS)) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="81" height="81" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
    const file = join(out, `${name}${suffix}.png`);
    await page.locator('svg').screenshot({ path: file, omitBackground: true });
    console.log('写入', file);
  }
}
await browser.close();
