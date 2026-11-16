// 给小程序线的样例截图（8.1.2，docs/STUDIO_MP.md 第 7 节）：把 tests/fixtures/studio/mp/*.json 用本仓库的 React 渲染器在 375 宽、
// 两倍像素（= 小程序的 750rpx）下画出来，存成同名的 .png。小程序线照这几张核对自己的渲染组件。
//
//   STUDIO_URL=http://127.0.0.1:8080 STUDIO_USER=<有「工作台：编辑」的账号> STUDIO_PASSWORD=<密码> node scripts/studio-mp-shots.mjs
//
// 只在独立演示库（或本地开发库）上跑：会往素材库传样例图、生成预览码（不发布、不改版面）。
// 截图用的是这台机器上的字体（苹方、鸿蒙字体在 Linux 上没有，会换成别的黑体）：比的是位置、大小、颜色、排列，不比字形。
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const DIR = 'tests/fixtures/studio/mp';
const base = (process.env.STUDIO_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const user = process.env.STUDIO_USER;
const password = process.env.STUDIO_PASSWORD;
if (!user || !password) {
  console.error('要给 STUDIO_USER、STUDIO_PASSWORD（有「工作台：编辑」的账号）');
  process.exit(2);
}

const browser = await chromium.launch();
const context = await browser.newContext({ baseURL: base, viewport: { width: 480, height: 900 }, deviceScaleFactor: 2, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
const page = await context.newPage();
const login = await page.request.post('/api/auth/login', { data: { username: user, password } });
if (!login.ok()) throw new Error(`登录不上：${login.status()} ${await login.text()}`);

// 样例用到的图先传进素材库（同一张只存一份）
for (const f of readdirSync(`${DIR}/assets`)) {
  const r = await page.request.post('/api/studio/assets', { data: { name: f, data: readFileSync(`${DIR}/assets/${f}`).toString('base64') } });
  if (!r.ok()) throw new Error(`传图 ${f}：${r.status()} ${await r.text()}`);
}

for (const f of readdirSync(DIR)
  .filter((x) => x.endsWith('.json'))
  .sort()) {
  const sample = JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8'));
  const code = await page.request.post('/api/studio/mp/preview-code', { data: { doc: sample.doc } });
  if (!code.ok()) throw new Error(`${f} 生成预览码：${code.status()} ${await code.text()}`);
  // 只画这一屏（没有工具栏），375 宽
  await page.goto(`/studio-preview/mp/${(await code.json()).code}?screen=${sample.screen}&bare=1`);
  const screen = page.getByTestId('studio-phone-screen');
  await screen.waitFor();
  // 等图都出来、字体都好了
  await page.waitForFunction(() => [...document.images].every((i) => i.complete) && document.fonts.status === 'loaded');
  const png = await screen.screenshot({ animations: 'disabled' });
  writeFileSync(`${DIR}/${f.replace(/\.json$/, '.png')}`, png);
  console.log(`截好 ${DIR}/${f.replace(/\.json$/, '.png')}`);
}
await browser.close();
