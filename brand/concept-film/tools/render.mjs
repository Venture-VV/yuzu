// 渲染成片：逐帧截图 → ffmpeg 合成（加一点胶片颗粒、配上音乐）。
//   node tools/render.mjs --size 1920x1080 --out out/汤崎品牌概念片-横版-1080p.mp4
// 可选：--workers 4（同时开几个浏览器）  --from 0 --to 72（只渲染一段，秒）  --crf 18  --grain 3
//       --audio audio/score.wav（没有这个文件就出无声的）  --cta "落版下面的一行字"  --keep（留着帧图）
//       --frames <目录>（帧图放哪儿，默认 out/.frames/<宽x高>）  --bitrate 6M（按码率而不是按质量编码）
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { serve, ROOT } from './serve.mjs';

// playwright 用 require 找：仓库装过依赖时来自 @playwright/test，云端环境来自全局安装
const { chromium } = createRequire(import.meta.url)('playwright');

const has = (k) => process.argv.includes('--' + k);
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const [W, H] = arg('size', '1920x1080').split('x').map(Number);
const out = path.resolve(arg('out', `out/concept-film-${W}x${H}.mp4`));
const workers = +arg('workers', 4);
const crf = arg('crf', '18');
const grain = +arg('grain', 3);
const bitrate = arg('bitrate', '');
const cta = arg('cta', '');
const audio = path.resolve(ROOT, arg('audio', 'audio/score.wav'));
const framesDir = path.resolve(arg('frames', path.join(ROOT, 'out', '.frames', `${W}x${H}`)));
fs.mkdirSync(framesDir, { recursive: true });
fs.mkdirSync(path.dirname(out), { recursive: true });

const { server, port } = await serve();
const url = `http://127.0.0.1:${port}/film/index.html?render=1&w=${W}&h=${H}${cta ? '&cta=' + encodeURIComponent(cta) : ''}`;

async function open() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => { console.error('[pageerror]', e.message); process.exitCode = 1; });
  await page.goto(url);
  await page.waitForFunction('window.__ready || window.__error', null, { timeout: 120000 });
  const err = await page.evaluate('window.__error');
  if (err) throw new Error(err);
  const cdp = await page.context().newCDPSession(page);
  return { browser, page, cdp };
}

const first = await open();
const info = await first.page.evaluate('window.__info');
const f0 = Math.round(+arg('from', 0) * info.FPS);
const f1 = Math.min(info.frames, Math.round(+arg('to', info.DURATION) * info.FPS));
const total = f1 - f0;
console.log(`${W}x${H} @ ${info.FPS}fps  帧 ${f0}–${f1 - 1}（${total} 帧）  ${workers} 个浏览器`);

const t0 = Date.now();
let done = 0;
async function work(k, w) {
  const { browser, page, cdp } = w || await open();
  for (let f = f0 + k; f < f1; f += workers) {
    await page.evaluate((f) => window.__draw(f), f);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true });
    fs.writeFileSync(path.join(framesDir, `f${String(f).padStart(6, '0')}.png`), Buffer.from(data, 'base64'));
    if (++done % 300 === 0) console.log(`  ${done} / ${total}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  await browser.close();
}
await Promise.all(Array.from({ length: workers }, (_, k) => work(k, k === 0 ? first : null)));
server.close();
console.log(`帧图完成：${((Date.now() - t0) / 1000).toFixed(0)}s`);
for (let f = f0; f < f1; f++) {
  if (!fs.existsSync(path.join(framesDir, `f${String(f).padStart(6, '0')}.png`))) throw new Error(`缺第 ${f} 帧`);
}

// ---- 音量：量出响度，统一调到 -14 LUFS（各平台的常用基准），峰值留 1 dB ----
const useAudio = !has('no-audio') && fs.existsSync(audio);
let gain = 0;
if (useAudio) {
  const m = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', audio, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' });
  const I = /I:\s+(-?\d+(\.\d+)?) LUFS/.exec(m.stderr.split('Summary:').pop() || '');
  if (I) gain = -14 - parseFloat(I[1]);
  console.log(`配乐响度 ${I ? I[1] : '?'} LUFS，调整 ${gain.toFixed(1)} dB`);
}

// ---- 合成 ----
// 颜色：帧图是 sRGB，按 BT.709 转成视频并写好标记，品牌色在各播放器里才对得上。
// 颗粒：只加在亮度上、每帧都变，很轻；既有胶片感，也盖住深色渐变的色阶。
const vf = [
  'scale=out_color_matrix=bt709:out_range=tv:flags=lanczos+accurate_rnd+full_chroma_int',
  'format=yuv444p',
  grain > 0 ? `noise=c0s=${grain}:c0f=t` : null,
  'format=yuv420p',
].filter(Boolean).join(',');
const args = ['-y', '-hide_banner', '-loglevel', 'warning', '-stats',
  '-framerate', String(info.FPS), '-start_number', String(f0), '-i', path.join(framesDir, 'f%06d.png')];
if (useAudio) args.push('-ss', String(f0 / info.FPS), '-t', String(total / info.FPS), '-i', audio);
args.push('-vf', vf, '-frames:v', String(total),
  '-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
  '-x264-params', 'aq-mode=3:aq-strength=1.0:deblock=-1,-1:keyint=60:min-keyint=30',
  '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv');
if (bitrate) args.push('-b:v', bitrate, '-maxrate', bitrate, '-bufsize', String(parseFloat(bitrate) * 2) + 'M');
else args.push('-crf', crf);
if (useAudio) {
  const fadeAt = Math.max(0, total / info.FPS - 1.2); // 结尾 1.2 秒收掉（换成别的音乐时不会戛然而止）
  args.push('-af', `volume=${gain.toFixed(2)}dB,alimiter=limit=0.79:level=false,afade=t=out:st=${fadeAt.toFixed(2)}:d=1.2`, '-c:a', 'aac', '-b:a', '256k', '-ar', '48000');
}
args.push('-movflags', '+faststart', '-metadata', 'title=汤崎 · 品牌概念片《动静之间》', out);
await new Promise((resolve, reject) => {
  const p = spawn('ffmpeg', args, { stdio: 'inherit' });
  p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg 退出码 ' + code))));
});
// 核对成片的帧数：少一帧都不算数（帧图读到一半出错时 ffmpeg 也可能照样收尾）
const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', out], { encoding: 'utf8' });
const got = parseInt(probe.stdout.trim(), 10);
if (got !== total) throw new Error(`成片只有 ${got} 帧，应为 ${total} 帧`);
if (!has('keep')) fs.rmSync(framesDir, { recursive: true, force: true });
const mb = fs.statSync(out).size / 1e6;
console.log(`成片：${out}  ${mb.toFixed(1)} MB  共 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
