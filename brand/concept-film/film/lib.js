// 概念片的小工具：缓动、颜色、可复现的随机数、纹理、文字排版。
// 所有画面都只由「第几帧」决定，同一帧任何时候画出来都一样（逐帧渲染要靠这一点）。

export const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const prog = (t, a, b) => clamp((t - a) / (b - a));
export const mix = (a, b, k) => a + (b - a) * k;

export const E = {
  lin: (x) => x,
  inQuad: (x) => x * x,
  outQuad: (x) => 1 - (1 - x) * (1 - x),
  inOutQuad: (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2),
  inCubic: (x) => x * x * x,
  outCubic: (x) => 1 - Math.pow(1 - x, 3),
  inOutCubic: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  outQuart: (x) => 1 - Math.pow(1 - x, 4),
  inOutQuart: (x) => (x < 0.5 ? 8 * x * x * x * x : 1 - Math.pow(-2 * x + 2, 4) / 2),
  outExpo: (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x)),
  inOutSine: (x) => -(Math.cos(Math.PI * x) - 1) / 2,
  outBack: (x, s = 1.25) => 1 + (s + 1) * Math.pow(x - 1, 3) + s * Math.pow(x - 1, 2),
};

// ---------- 颜色 ----------
export function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgba(hex, a = 1) {
  const [r, g, b] = rgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
export function mixHex(a, b, k) {
  const A = rgb(a), B = rgb(b);
  const c = A.map((v, i) => Math.round(mix(v, B[i], k)));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// ---------- 可复现的随机 ----------
export function hash(n) {
  let x = Math.imul((n | 0) ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}
export function hash2(a, b) { return hash(Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663)); }
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// 一维平滑噪声（0..1）
export function noise1(x, seed = 0) {
  const i = Math.floor(x), f = x - i;
  const u = f * f * (3 - 2 * f);
  return mix(hash2(i, seed), hash2(i + 1, seed), u);
}

// ---------- 纹理 ----------
// 可平铺的分形噪声，灰度写在 alpha 里（白色、不同透明度），画的时候再着色。
export function makeFbm(size, seed, octaves = 5, base = 4) {
  const c = new OffscreenCanvas(size, size);
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const d = img.data;
  const grids = [];
  for (let o = 0; o < octaves; o++) {
    const n = base << o;
    const arr = new Float32Array(n * n);
    for (let i = 0; i < n * n; i++) arr[i] = hash2(i, seed * 31 + o);
    grids.push([n, arr]);
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0, amp = 0.5, tot = 0;
      for (let o = 0; o < octaves; o++) {
        const [n, arr] = grids[o];
        const fx = (x / size) * n, fy = (y / size) * n;
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const tx = fx - x0, ty = fy - y0;
        const ux = tx * tx * (3 - 2 * tx), uy = ty * ty * (3 - 2 * ty);
        const x1 = (x0 + 1) % n, y1 = (y0 + 1) % n;
        const a = arr[y0 * n + x0], b = arr[y0 * n + x1], cc = arr[y1 * n + x0], dd = arr[y1 * n + x1];
        v += amp * mix(mix(a, b, ux), mix(cc, dd, ux), uy);
        tot += amp; amp *= 0.5;
      }
      v /= tot;
      const k = (y * size + x) * 4;
      d[k] = d[k + 1] = d[k + 2] = 255;
      d[k + 3] = Math.round(clamp((v - 0.28) / 0.5) * 255);
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

// 麻布纹（品牌书五种景象上盖的那层织物质感）：经纬线 + 粗细不匀。输出黑色、alpha 表示深浅，可平铺。
export function makeLinen(size, seed = 7) {
  const c = new OffscreenCanvas(size, size);
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const d = img.data;
  const pitch = 4; // 线的间距（像素）
  const n = size / pitch;
  const wx = new Float32Array(n), wy = new Float32Array(n);
  for (let i = 0; i < n; i++) { wx[i] = 0.55 + 0.9 * hash2(i, seed); wy[i] = 0.55 + 0.9 * hash2(i, seed + 99); }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ix = Math.floor(x / pitch) % n, iy = Math.floor(y / pitch) % n;
      const fx = (x % pitch) / pitch, fy = (y % pitch) / pitch;
      // 经线与纬线交替压在上面
      const over = (ix + iy) % 2 === 0;
      const warp = Math.sin(fx * Math.PI) * wx[ix];
      const weft = Math.sin(fy * Math.PI) * wy[iy];
      const th = over ? warp * 0.75 + weft * 0.25 : weft * 0.75 + warp * 0.25;
      // 沿着线方向的粗细起伏
      const slub = 0.75 + 0.5 * noise1(over ? y / 23 + ix * 3.1 : x / 23 + iy * 5.7, seed + 5);
      const speck = hash2(x + y * size, seed + 11);
      const v = clamp(1 - th * slub) * 0.85 + speck * 0.15;
      const k = (y * size + x) * 4;
      d[k] = d[k + 1] = d[k + 2] = 0;
      d[k + 3] = Math.round(v * 255);
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

// ---------- 文字 ----------
export const FONT = {
  cn: "'Harmony', sans-serif",
  en: "'Heros', 'Harmony', sans-serif",
  song: "'SongNoto', 'Harmony', serif",
};
export function font(weight, px, family = FONT.cn) { return `${weight} ${px}px ${family}`; }

// 逐字位置：用「到这个字为止的前缀宽度」来算，保留字偶距；tracking 是每个字后面另加的像素。
export function layout(ctx, str, tracking = 0) {
  const chars = Array.from(str);
  const xs = [], ws = [];
  let prefix = '';
  let prevW = 0;
  for (let i = 0; i < chars.length; i++) {
    prefix += chars[i];
    const w = ctx.measureText(prefix).width;
    const cw = ctx.measureText(chars[i]).width;
    xs.push(w - cw + i * tracking);
    ws.push(cw);
    prevW = w;
  }
  const total = prevW + Math.max(0, chars.length - 1) * tracking;
  return { chars, xs, ws, total };
}

// 一行字。o: {font, color, alpha, align('left'|'center'|'right'), tracking, baseline}
export function text(ctx, str, x, y, o = {}) {
  ctx.save();
  ctx.font = o.font;
  ctx.textBaseline = o.baseline || 'alphabetic';
  ctx.fillStyle = o.color || '#fff';
  ctx.globalAlpha *= o.alpha ?? 1;
  const L = layout(ctx, str, o.tracking || 0);
  let x0 = x;
  if (o.align === 'center') x0 = x - L.total / 2;
  else if (o.align === 'right') x0 = x - L.total;
  if (!o.tracking) ctx.fillText(str, x0, y);
  else for (let i = 0; i < L.chars.length; i++) ctx.fillText(L.chars[i], x0 + L.xs[i], y);
  ctx.restore();
  return L.total;
}
// 逐字出现：每个字从略低、略虚的位置浮上来。p 是整行的进度 0..1；stagger 是相邻两个字错开的比例。
// out 是整行淡出的进度 0..1。
export function textReveal(ctx, str, x, y, o = {}, p = 1, out = 0) {
  if (p <= 0 || out >= 1) return 0;
  ctx.save();
  ctx.font = o.font;
  ctx.textBaseline = o.baseline || 'alphabetic';
  ctx.fillStyle = o.color || '#fff';
  const L = layout(ctx, str, o.tracking || 0);
  let x0 = x;
  if (o.align === 'center') x0 = x - L.total / 2;
  else if (o.align === 'right') x0 = x - L.total;
  const n = L.chars.length;
  const stagger = o.stagger ?? 0.6; // 相邻两个字错开多少（占一个字出现时长的比例 × 0.35）
  const span = 1 / (1 + (n - 1) * 0.35 * stagger); // 一个字出现用掉整行进度的多少
  const rise = o.rise ?? 0;
  const baseA = (o.alpha ?? 1) * (1 - E.inOutQuad(out)) * ctx.globalAlpha;
  for (let i = 0; i < n; i++) {
    const start = i * 0.35 * stagger * span;
    const k = clamp((p - start) / span);
    if (k <= 0) continue;
    const e = E.outCubic(k);
    ctx.globalAlpha = baseA * e;
    const blur = (o.blur ?? 0) * (1 - e);
    ctx.filter = blur > 0.3 ? `blur(${blur.toFixed(2)}px)` : 'none';
    ctx.fillText(L.chars[i], x0 + L.xs[i], y + rise * (1 - e));
  }
  ctx.restore();
  return L.total;
}

// 一行字从遮罩里升上来（口号用）。p: 0..1
export function textRise(ctx, str, x, y, o = {}, p = 1) {
  if (p <= 0) return;
  ctx.save();
  ctx.font = o.font;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = o.color || '#fff';
  const size = o.size;
  const e = E.outQuart(clamp(p));
  ctx.beginPath();
  ctx.rect(x - size * 0.2, y - size * 1.02, (o.maxWidth || 99999) + size * 0.4, size * 1.3);
  ctx.clip();
  ctx.globalAlpha *= (o.alpha ?? 1) * clamp(p * 3);
  const L = layout(ctx, str, o.tracking || 0);
  const dy = size * 1.1 * (1 - e);
  if (!o.tracking) ctx.fillText(str, x, y + dy);
  else for (let i = 0; i < L.chars.length; i++) ctx.fillText(L.chars[i], x + L.xs[i], y + dy);
  ctx.restore();
}

// ---------- 路径 ----------
const pathCache = new Map();
export function P(d) {
  let p = pathCache.get(d);
  if (!p) { p = new Path2D(d); pathCache.set(d, p); }
  return p;
}
