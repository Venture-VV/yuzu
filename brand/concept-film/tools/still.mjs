// 出静帧：检查画面，或者导出封面图。
//   node tools/still.mjs --size 1920x1080 --times 1,3.5,6 --out <目录> [--format jpg] [--cta "落版下面的一行字"]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { serve } from './serve.mjs';

// playwright 用 require 找：仓库装过依赖时来自 @playwright/test，云端环境来自全局安装
const { chromium } = createRequire(import.meta.url)('playwright');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const [W, H] = arg('size', '1920x1080').split('x').map(Number);
const times = arg('times', '0').split(',').map(Number);
const out = arg('out', 'out/stills');
const cta = arg('cta', '');
const format = arg('format', 'png');
fs.mkdirSync(out, { recursive: true });

const { server, port } = await serve();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${port}/film/index.html?render=1&w=${W}&h=${H}${cta ? '&cta=' + encodeURIComponent(cta) : ''}`);
await page.waitForFunction('window.__ready || window.__error', null, { timeout: 60000 });
const err = await page.evaluate('window.__error');
if (err) { console.error(err); process.exit(1); }
const info = await page.evaluate('window.__info');
for (const t of times) {
  const f = Math.round(t * info.FPS);
  const ms = await page.evaluate((f) => { const a = performance.now(); window.__draw(f); return performance.now() - a; }, f);
  const file = path.join(out, `t${t.toFixed(2).padStart(6, '0')}_${W}x${H}.${format}`);
  await page.screenshot(format === 'jpg' ? { path: file, type: 'jpeg', quality: 93 } : { path: file });
  console.log(file, `draw ${ms.toFixed(0)}ms`);
}
await browser.close();
server.close();
