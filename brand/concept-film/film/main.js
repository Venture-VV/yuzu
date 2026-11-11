// 汤崎品牌概念片《动静之间》—— 时间线与调度。
// 页面上只有一块画布；window.__draw(第几帧) 把那一帧画出来，渲染脚本逐帧截图。
import { buildTextures, dither } from './stage.js';
import { SCENES, DURATION, FPS } from './timeline.js';

const q = new URLSearchParams(location.search);
const W = +(q.get('w') || 1920), H = +(q.get('h') || 1080);

const canvas = document.getElementById('c');
canvas.width = W; canvas.height = H;
const ctx = canvas.getContext('2d', { alpha: false });

const env = {
  W, H, FPS, DURATION,
  portrait: H > W,
  u: Math.min(W, H) / 1080, // 画面里的「1 个单位」：短边 1080 时的 1 像素
  cta: q.get('cta') || '',  // 落版下面可选的一行（门店、活动信息），默认不放
};

async function loadFonts() {
  const faces = [
    ['Harmony', 'HarmonyOS_Sans_SC_Light.ttf', '300'],
    ['Harmony', 'HarmonyOS_Sans_SC_Regular.ttf', '400'],
    ['Harmony', 'HarmonyOS_Sans_SC_Medium.ttf', '500'],
    ['Harmony', 'HarmonyOS_Sans_SC_Bold.ttf', '700'],
    ['Heros', 'heros-regular.otf', '400'],
    ['Heros', 'heros-bold.otf', '700'],
    ['SongNoto', 'notoserifsc-500.woff2', '500'],
    ['SongNoto', 'notoserifsc-900.woff2', '900'],
  ];
  await Promise.all(faces.map(async ([family, file, weight]) => {
    const f = new FontFace(family, `url(../fonts/${file})`, { weight });
    await f.load();
    document.fonts.add(f);
  }));
}

export function draw(frame) {
  const t = frame / FPS;
  env.t = t; env.frame = frame;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  for (const s of SCENES) {
    if (t < s.t0 || t >= s.t1) continue;
    ctx.save();
    s.draw(ctx, env, t - s.t0, s.t1 - s.t0, t);
    ctx.restore();
  }
  dither(ctx, env);
}

async function setup() {
  await loadFonts();
  env.brand = await (await fetch('assets/brand.json')).json();
  buildTextures(env);
  for (const s of SCENES) if (s.init) s.init(env);
  window.__info = { W, H, FPS, DURATION, frames: Math.round(DURATION * FPS) };
  window.__draw = draw;
  draw(+(q.get('f') || 0));
  window.__ready = true;
  if (!q.get('render')) preview();
}

// 浏览器里直接打开时的预览：空格播放 / 暂停，拖动时间轴。
function preview() {
  const bar = document.getElementById('bar');
  if (!bar) return;
  bar.hidden = false;
  const range = bar.querySelector('input'), label = bar.querySelector('span');
  range.max = String(Math.round(DURATION * FPS) - 1);
  let playing = false, start = 0, base = 0;
  const show = (f) => { draw(f); range.value = String(f); label.textContent = (f / FPS).toFixed(2) + 's'; };
  range.addEventListener('input', () => { playing = false; show(+range.value); });
  const tick = (now) => {
    if (!playing) return;
    const f = base + Math.floor(((now - start) / 1000) * FPS);
    if (f >= DURATION * FPS) { playing = false; return; }
    show(f); requestAnimationFrame(tick);
  };
  addEventListener('keydown', (e) => {
    if (e.code !== 'Space') return;
    e.preventDefault();
    playing = !playing;
    if (playing) { base = +range.value; start = performance.now(); requestAnimationFrame(tick); }
  });
}

setup().catch((e) => { console.error(e); window.__error = String(e && e.stack || e); });
