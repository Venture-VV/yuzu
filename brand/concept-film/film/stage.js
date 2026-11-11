// 舞台：品牌色、公用的底层画法（底色、雾气、麻布纹、暗角）、标志与笔画的画法。
import { clamp, mix, E, rgba, makeFbm, makeLinen, P } from './lib.js';

// 色板。木 / 麻六色与五种景象的底色取自品牌书（brand.json 里是从 PDF 读出的原值）；
// 深褐取自 Strategy 的规范封面与章节页。
export const C = {
  night: '#17110D',   // 开场：比深褐再暗一点
  ink: '#2F221A',     // Strategy 章节页的深褐
  brown: '#4C392A',   // Strategy 规范封面的褐
  wood: '#927051',    // 品牌主色（木）
  hemp1: '#AD8E69', hemp2: '#C4A67E', hemp3: '#D2B993', hemp4: '#E4D0B3',
  cream: '#EBDECA',   // 最浅的麻色，深底上的字与标志
  dim: '#5B4838',     // 深底上「退后」的灰褐
};

export function tint(tex, color) {
  const c = new OffscreenCanvas(tex.width, tex.height);
  const g = c.getContext('2d');
  g.fillStyle = color; g.fillRect(0, 0, c.width, c.height);
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(tex, 0, 0);
  return c;
}

// 固定的细噪点：一半像素略亮、一半略暗，幅度 0–3 级（8 位）。只为打散深色渐变的色阶，肉眼看不出纹理。
function makeDither(size, seed) {
  const c = new OffscreenCanvas(size, size);
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const d = img.data;
  let a = seed >>> 0;
  const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (let i = 0; i < size * size; i++) {
    const v = rnd() < 0.5 ? 255 : 0;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
    d[i * 4 + 3] = Math.floor(rnd() * 4);
  }
  g.putImageData(img, 0, 0);
  return c;
}

export function dither(ctx, env) {
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = ctx.createPattern(env.tex.dither, 'repeat');
  ctx.fillRect(0, 0, env.W, env.H);
  ctx.restore();
}

export function buildTextures(env) {
  const fbmA = makeFbm(512, 3, 5, 2);
  const fbmB = makeFbm(512, 11, 5, 3);
  env.tex = {
    mistWarm: tint(fbmA, '#E8C9A0'),
    mistWarm2: tint(fbmB, '#F3DFC2'),
    mistDark: tint(fbmB, '#000000'),
    mistWhite: tint(fbmA, '#FFFFFF'),
    linen: makeLinen(256, 7),
    dither: makeDither(512, 99),
  };
}

export function fill(ctx, env, color, alpha = 1) {
  ctx.save(); ctx.globalAlpha *= alpha; ctx.fillStyle = color; ctx.fillRect(0, 0, env.W, env.H); ctx.restore();
}

// 平铺一张纹理铺满画面。scale 是纹理放大倍数，dx/dy 是位移（像素）。
export function tile(ctx, env, tex, { scale = 1, dx = 0, dy = 0, alpha = 1, op = 'source-over' } = {}) {
  ctx.save();
  const pat = ctx.createPattern(tex, 'repeat');
  pat.setTransform(new DOMMatrix().translate(dx, dy).scale(scale));
  ctx.globalAlpha *= alpha;
  ctx.globalCompositeOperation = op;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, env.W, env.H);
  ctx.restore();
}

// 雾气（氤氲）：两层柔和的云在慢慢飘。
export function mist(ctx, env, t, { alpha = 0.16, speed = 1, tex = 'mistWarm', op = 'screen', scale = 1 } = {}) {
  const { W, H, tex: T } = env;
  const s = (Math.max(W, H) / 512) * 1.15 * scale;
  tile(ctx, env, T[tex], { scale: s, dx: -t * 26 * speed * env.u, dy: -t * 9 * speed * env.u, alpha, op });
  tile(ctx, env, T[tex === 'mistWarm' ? 'mistWarm2' : tex], { scale: s * 0.62, dx: t * 15 * speed * env.u + W * 0.3, dy: -t * 17 * speed * env.u, alpha: alpha * 0.7, op });
}

export function linen(ctx, env, alpha = 0.3) {
  tile(ctx, env, env.tex.linen, { scale: env.u, alpha, op: 'multiply' });
}

export function vignette(ctx, env, strength = 0.5, color = '#000000') {
  const { W, H } = env;
  const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.hypot(W, H) * 0.62);
  g.addColorStop(0, rgba(color, 0));
  g.addColorStop(1, rgba(color, strength));
  ctx.save(); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); ctx.restore();
}

// 深色场的底：深褐 + 一团暖光 + 雾气。开场、提取山水、品牌文字几场共用，换场时底色才接得上。
// calm: 0 = 开场最暗的夜色，1 = 正常的深褐；warm: 往规范封面的褐色再暖一点（口号、落版）。
export function darkBackdrop(ctx, env, tg, calm = 1, warm = 0) {
  const { W, H } = env;
  fill(ctx, env, C.night);
  fill(ctx, env, C.ink, calm);
  if (warm > 0) fill(ctx, env, C.brown, warm * 0.55);
  glow(ctx, env, W * 0.5, H * 0.44, Math.max(W, H) * 0.75, '#B98A58', 0.12 * calm + 0.07 * warm);
  mist(ctx, env, tg, { alpha: 0.05 + 0.07 * calm, speed: 0.9 });
}

// 一团柔光（暖色的环境光）
export function glow(ctx, env, x, y, r, color, alpha = 0.3, op = 'screen') {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, rgba(color, alpha));
  g.addColorStop(0.5, rgba(color, alpha * 0.35));
  g.addColorStop(1, rgba(color, 0));
  ctx.save(); ctx.globalCompositeOperation = op; ctx.fillStyle = g; ctx.fillRect(0, 0, env.W, env.H); ctx.restore();
}

// 一块离屏画布：一层笔画先在上面画好，再整层做一次虚化 / 投影（逐条笔画做滤镜太慢）。
// scale < 1 时用较小的画布，适合反正要虚化的那一层。
export function layer(env, name, scale = 1) {
  const w = Math.ceil(env.W * scale), h = Math.ceil(env.H * scale);
  const key = '_layer_' + name;
  let c = env[key];
  if (!c || c.width !== w || c.height !== h) c = env[key] = new OffscreenCanvas(w, h);
  const g = c.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; g.filter = 'none';
  g.clearRect(0, 0, w, h);
  g.scale(scale, scale);
  return [c, g];
}

// 图形标「三横三竖」。box: 标志放的位置 {x, y, w}（x、y 是左上角，w 是宽）。
// pieces: 每一笔的 {alpha, dx, dy, rot, grow}（都可省）。settled=1 时画原稿的四条轮廓。
export const MARK_ORDER = ['h3', 'h2', 'h1', 'v1', 'v2', 'v3'];
export function drawMark(ctx, env, box, color, state = {}, alpha = 1) {
  const m = env.brand.mark;
  const s = box.w / m.w;
  ctx.save();
  ctx.translate(box.x, box.y);
  ctx.scale(s, s);
  ctx.globalAlpha *= alpha;
  ctx.fillStyle = color;
  if (state === true || state.settled) {
    for (const d of m.full) ctx.fill(P(d));
    ctx.restore();
    return;
  }
  for (const k of MARK_ORDER) {
    const st = state[k] || {};
    const a = st.alpha ?? 1;
    if (a <= 0) continue;
    const pc = m.pieces[k];
    const [x0, y0, x1, y1] = pc.b;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    ctx.save();
    ctx.globalAlpha *= a;
    ctx.translate(cx + (st.dx || 0) / s, cy + (st.dy || 0) / s);
    if (st.rot) ctx.rotate(st.rot);
    if (st.scale != null) ctx.scale(st.scale, st.scale);
    ctx.translate(-cx, -cy);
    const grow = st.grow ?? 1;
    if (grow < 1) {
      // 像落笔一样长出来：横画从起笔一端向收笔一端，竖画从下往上
      ctx.beginPath();
      const pad = 6;
      if (k[0] === 'h') {
        const fromLeft = k !== 'h2';
        const w = (x1 - x0 + pad * 2) * grow;
        ctx.rect(fromLeft ? x0 - pad : x1 + pad - w, y0 - pad, w, y1 - y0 + pad * 2);
      } else {
        const h = (y1 - y0 + pad * 2) * grow;
        ctx.rect(x0 - pad, y1 + pad - h, x1 - x0 + pad * 2, h);
      }
      ctx.clip();
    }
    ctx.fill(P(pc.d));
    ctx.restore();
  }
  ctx.restore();
}

// 竖排字标（2026 主标志）。box: {x, y, w}。state: 各部分 {alpha, grow}。
export function drawLogotype(ctx, env, box, color, state = {}, alpha = 1) {
  const L = env.brand.logotype;
  const s = box.w / L.w;
  ctx.save();
  ctx.translate(box.x, box.y);
  ctx.scale(s, s);
  ctx.globalAlpha *= alpha;
  ctx.fillStyle = color;
  const part = (p, st, dir) => {
    const a = st?.alpha ?? 1;
    if (a <= 0) return;
    ctx.save();
    ctx.globalAlpha *= a;
    const [x0, y0, x1, y1] = p.b;
    const grow = st?.grow ?? 1;
    if (grow < 1) {
      ctx.beginPath();
      const pad = 3;
      if (dir === 'x') ctx.rect(x0 - pad, y0 - pad, (x1 - x0 + pad * 2) * grow, y1 - y0 + pad * 2);
      else { const h = (y1 - y0 + pad * 2) * grow; ctx.rect(x0 - pad, y1 + pad - h, x1 - x0 + pad * 2, h); }
      ctx.clip();
    }
    if (st?.dy) ctx.translate(0, st.dy / s);
    ctx.fill(P(p.d));
    ctx.restore();
  };
  L.water.forEach((p, i) => part(p, state['w' + i], 'x'));
  L.shan.forEach((p, i) => part(p, state['s' + i], 'y'));
  L.tang.forEach((p) => part(p, state.tang));
  L.qi.forEach((p) => part(p, state.qi));
  ctx.restore();
}

export { clamp, mix, E };
