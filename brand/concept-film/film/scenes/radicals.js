// 第二场 · 提取山水（8–16 秒）+ 第三场 · 三横三竖，标志成形（16–24 秒）
// 「汤」的偏旁是水，「崎」的偏旁是山（品牌书「起源山水」）。偏旁亮起来，化成品牌的三横、三竖；
// 两组笔画合到一起，就是图形标（品牌书「矗立为山，横流为水」）。
import { prog, mix, E, font, FONT, text, textReveal } from '../lib.js';
import { C, vignette, darkBackdrop, drawMark, tint } from '../stage.js';

// ---------- 把偏旁从字里分出来 ----------
// 宋体的「汤」，三点水与右边不相连：按连通的笔画分，靠左的三块就是偏旁。
// 「崎」的山字旁与「奇」粘在一起：沿着山字旁右边那一竖的右沿切开。
function splitGlyph(ch, size) {
  const pad = Math.round(size * 0.15), w = size + pad * 2, h = Math.round(size * 1.3) + pad;
  const oc = new OffscreenCanvas(w, h), g = oc.getContext('2d', { willReadFrequently: true });
  g.font = font(900, size, FONT.song); g.fillStyle = '#fff'; g.textBaseline = 'alphabetic';
  g.fillText(ch, pad, pad + size);
  const img = g.getImageData(0, 0, w, h), d = img.data;
  const filled = (p) => d[p * 4 + 3] >= 128;
  const isRad = new Uint8Array(w * h); // 1 = 偏旁，2 = 其余

  if (ch === '汤') {
    const lab = new Int32Array(w * h); const comps = []; const stack = [];
    for (let p = 0; p < w * h; p++) {
      if (lab[p] || !filled(p)) continue;
      const id = comps.length + 1; const c = { minx: w, maxx: 0 };
      stack.push(p); lab[p] = id;
      while (stack.length) {
        const q = stack.pop(); const x = q % w;
        if (x < c.minx) c.minx = x; if (x > c.maxx) c.maxx = x;
        if (x > 0 && !lab[q - 1] && filled(q - 1)) { lab[q - 1] = id; stack.push(q - 1); }
        if (x < w - 1 && !lab[q + 1] && filled(q + 1)) { lab[q + 1] = id; stack.push(q + 1); }
        if (q >= w && !lab[q - w] && filled(q - w)) { lab[q - w] = id; stack.push(q - w); }
        if (q + w < w * h && !lab[q + w] && filled(q + w)) { lab[q + w] = id; stack.push(q + w); }
      }
      comps.push(c);
    }
    const rad = comps.map((c) => ((c.minx + c.maxx) / 2 - pad) / size < 0.3);
    for (let p = 0; p < w * h; p++) if (lab[p]) isRad[p] = rad[lab[p] - 1] ? 1 : 2;
  } else {
    // 山字旁右竖：在 0.36 字宽处取每一行的那一段，右沿的众数就是切线
    const probe = pad + Math.round(size * 0.36);
    const ends = new Int32Array(h).fill(-1); const hist = new Map();
    for (let y = 0; y < h; y++) {
      if (!filled(y * w + probe)) continue;
      let x = probe; while (x < w - 1 && filled(y * w + x + 1)) x++;
      ends[y] = x; hist.set(x, (hist.get(x) || 0) + 1);
    }
    let mode = probe, best = 0;
    for (const [x, n] of hist) if (n > best) { best = n; mode = x; }
    const fallback = pad + Math.round(size * 0.39);
    for (let y = 0; y < h; y++) {
      const cut = ends[y] < 0 ? fallback : (ends[y] <= mode + size * 0.035 ? ends[y] : mode);
      for (let x = 0; x < w; x++) { const p = y * w + x; if (filled(p)) isRad[p] = x <= cut ? 1 : 2; }
    }
  }
  // 边缘的半透明像素归给紧挨着的那一块（两遍）
  for (let pass = 0; pass < 2; pass++) {
    const next = isRad.slice();
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      if (isRad[p] || d[p * 4 + 3] === 0) continue;
      next[p] = isRad[p - 1] || isRad[p + 1] || isRad[p - w] || isRad[p + w] || 0;
    }
    isRad.set(next);
  }
  const mk = (which) => {
    const c = new OffscreenCanvas(w, h), cg = c.getContext('2d');
    const im = cg.createImageData(w, h);
    for (let p = 0; p < w * h; p++) { im.data[p * 4] = im.data[p * 4 + 1] = im.data[p * 4 + 2] = 255; im.data[p * 4 + 3] = isRad[p] === which ? d[p * 4 + 3] : 0; }
    cg.putImageData(im, 0, 0);
    return c;
  };
  // 上下的墨迹范围，用来把字摆在正中
  let top = h, bot = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x += 3) if (filled(y * w + x)) { if (y < top) top = y; if (y > bot) bot = y; }
  const rad = mk(1), rest = mk(2);
  return { w, h, pad, size, cy: (top + bot) / 2, radCream: tint(rad, C.cream), radDim: tint(rad, C.dim), restDim: tint(rest, C.dim) };
}

function glyphSize(env) { return Math.round((env.portrait ? 400 : 450) * env.u); }
export function initRadicals(env) {
  const size = glyphSize(env);
  env.glyphs = { 汤: splitGlyph('汤', size), 崎: splitGlyph('崎', size) };
}

function glyph(ctx, G, cx, cy, restAlpha, radLit, radAlpha, blur = 0) {
  const x = Math.round(cx - (G.pad + G.size / 2)), y = Math.round(cy - G.cy);
  ctx.save();
  if (blur > 0.3) ctx.filter = `blur(${blur.toFixed(2)}px)`;
  const a = ctx.globalAlpha;
  if (restAlpha > 0) { ctx.globalAlpha = a * restAlpha; ctx.drawImage(G.restDim, x, y); }
  if (radAlpha > 0) {
    ctx.globalAlpha = a * radAlpha * (1 - radLit); if (radLit < 1) ctx.drawImage(G.radDim, x, y);
    ctx.globalAlpha = a * radAlpha * radLit; if (radLit > 0) ctx.drawImage(G.radCream, x, y);
  }
  ctx.restore();
}

// ---------- 两组笔画（横 = 水，竖 = 山）各自的盒子 ----------
// 「提取」时分别待在两个字的位置，之后合到画面中间。
function boxes(env, tg) {
  const { W, H, u, portrait } = env;
  const cxL = W * (portrait ? 0.27 : 0.29), cxR = W * (portrait ? 0.73 : 0.71);
  const cy = H * (portrait ? 0.40 : 0.43);
  const m = env.brand.mark;
  const w0 = (portrait ? 400 : 560) * u;                      // 分开时整枚标志的宽
  const w1 = portrait ? W * 0.74 : W * 0.44;                   // 合成后的宽
  const h1 = w1 * m.h / m.w;
  const final = { x: (W - w1) / 2, y: H * (portrait ? 0.40 : 0.42) - h1 / 2, w: w1 };
  const s0 = w0 / m.w;
  const hC = { x: m.w / 2, y: (99.2 + 274.1) / 2 }, vC = { x: (89.8 + 683.1) / 2, y: (0 + 152.8) / 2 };
  const startH = { x: cxL - hC.x * s0, y: cy - hC.y * s0, w: w0 };
  const startV = { x: cxR - vC.x * s0, y: cy - vC.y * s0, w: w0 };
  const kH = E.inOutCubic(prog(tg, 16.0, 17.5));
  const kV = E.inOutCubic(prog(tg, 16.25, 17.85));
  const lerp = (a, b, k) => ({ x: mix(a.x, b.x, k), y: mix(a.y, b.y, k), w: mix(a.w, b.w, k) });
  return { cxL, cxR, cy, final, boxH: lerp(startH, final, kH), boxV: lerp(startV, final, kV), w1, h1 };
}

// 标志在水面上的倒影：一条一条地画，越往下越淡，左右轻轻晃
function reflection(ctx, env, box, h, tg, alpha) {
  if (alpha <= 0) return;
  const { u } = env;
  const pad = Math.ceil(20 * u);
  const oc = env._refl || (env._refl = new OffscreenCanvas(Math.ceil(box.w + pad * 2), Math.ceil(h + pad * 2)));
  if (env._reflKey !== box.w) {
    const g = oc.getContext('2d'); g.clearRect(0, 0, oc.width, oc.height);
    drawMark(g, env, { x: pad, y: pad, w: box.w }, C.cream, true);
    env._reflKey = box.w;
  }
  const gap = 26 * u, slice = Math.max(2, Math.round(3 * u));
  ctx.save();
  const y0 = box.y + h + gap;
  for (let i = 0; i * slice < h * 0.95; i++) {
    const sy = pad + h - (i + 1) * slice;            // 从标志的底往上取
    if (sy < 0) break;
    const k = (i * slice) / (h * 0.95);
    const wob = Math.sin(i * 0.42 + tg * 1.7) * (2 + 9 * k) * u + Math.sin(i * 0.13 - tg * 0.9) * 5 * k * u;
    ctx.globalAlpha = alpha * 0.26 * Math.pow(1 - k, 1.6);
    ctx.drawImage(oc, 0, sy, oc.width, slice, box.x - pad + wob, y0 + i * slice * 0.72, oc.width, slice * 0.72 + 0.6);
  }
  ctx.restore();
}

export function radicals(ctx, env, tl, dur, tg) {
  const { W, H, u, portrait } = env;
  const B = boxes(env, tg);
  const size = glyphSize(env);

  darkBackdrop(ctx, env, tg);

  // ---- 两个字 ----
  const restOut = E.inOutCubic(prog(tg, 12.2, 13.2));
  const radOut = E.inOutCubic(prog(tg, 12.9, 13.9));
  const tangIn = E.outCubic(prog(tg, 8.2, 9.2)), qiIn = E.outCubic(prog(tg, 10.0, 11.0));
  const tangRad = E.inOutCubic(prog(tg, 8.9, 9.7)), qiRad = E.inOutCubic(prog(tg, 10.7, 11.5));
  if (radOut < 1) {
    ctx.save();
    glyph(ctx, env.glyphs['汤'], B.cxL, B.cy, tangIn * (1 - restOut), tangRad, tangIn * (1 - radOut), radOut * 16 * u);
    glyph(ctx, env.glyphs['崎'], B.cxR, B.cy, qiIn * (1 - restOut), qiRad, qiIn * (1 - radOut), radOut * 16 * u);
    ctx.restore();
  }

  // ---- 字下面的说明 ----
  const capY = B.cy + size * 0.5 + (portrait ? 96 : 88) * u;
  const cs = (portrait ? 44 : 42) * u, es = (portrait ? 24 : 24) * u, ls = (portrait ? 27 : 27) * u;
  const cap = (cx, en, cn, line, a0) => {
    const a = E.outCubic(prog(tg, a0, a0 + 0.7)) * (1 - prog(tg, 12.0, 12.7));
    if (a <= 0) return;
    text(ctx, en, cx, capY, { font: font(700, es, FONT.en), color: C.cream, alpha: a * 0.8, tracking: es * 0.34, align: 'center' });
    text(ctx, cn, cx, capY + cs * 1.42, { font: font(500, cs), color: C.cream, alpha: a, tracking: cs * 0.42, align: 'center' });
    text(ctx, line, cx, capY + cs * 1.42 + ls * 2.05, { font: font(300, ls), color: C.cream, alpha: a * 0.66, tracking: ls * 0.1, align: 'center' });
  };
  cap(B.cxL, 'FLOW', '流动', '「汤」里的水，是温暖的泉', 9.3);
  cap(B.cxR, 'ROOTED', '根深', '「崎」里的山，是起伏的路', 11.1);

  // ---- 偏旁化成品牌的笔画 ----
  const g = (a) => E.outCubic(prog(tg, a, a + 0.85));
  const stH = { h1: { grow: g(13.1) }, h2: { grow: g(13.3) }, h3: { grow: g(13.5) }, v1: { alpha: 0 }, v2: { alpha: 0 }, v3: { alpha: 0 } };
  const stV = { v1: { grow: g(13.5) }, v2: { grow: g(13.7) }, v3: { grow: g(13.9) }, h1: { alpha: 0 }, h2: { alpha: 0 }, h3: { alpha: 0 } };
  // 分开待着的时候也在轻轻动：横的像水一样左右荡，竖的微微起伏；合拢时收住
  const loose = 1 - E.inOutCubic(prog(tg, 16.0, 17.4));
  ['h1', 'h2', 'h3'].forEach((k, i) => { stH[k].dx = Math.sin(tg * 1.5 + i * 2.1) * 9 * u * loose; });
  // 合上的一刻，竖画轻轻落一下
  const drop = (1 - E.outBack(prog(tg, 16.25, 17.95), 1.6)) * -34 * u;
  ['v1', 'v2', 'v3'].forEach((k, i) => { stV[k].dy = drop + Math.sin(tg * 1.3 + i * 1.7) * 5 * u * loose; });
  const settled = tg >= 18.0;
  const markOut = E.inCubic(prog(tg, 23.35, 23.95));
  if (tg >= 17.7) reflection(ctx, env, B.final, B.h1, tg, E.outCubic(prog(tg, 17.9, 19.4)) * (1 - markOut));
  if (tg >= 13.0) {
    ctx.save();
    ctx.globalAlpha = 1 - markOut;
    if (settled) drawMark(ctx, env, B.final, C.cream, true);
    else { drawMark(ctx, env, B.boxH, C.cream, stH); drawMark(ctx, env, B.boxV, C.cream, stV); }
    ctx.restore();
  }

  // ---- 「三横」「三竖」----
  const lab = (cx, a0, top, sub) => {
    const a = E.outCubic(prog(tg, a0, a0 + 0.6)) * (1 - prog(tg, 15.5, 16.0));
    if (a <= 0) return;
    text(ctx, top, cx, capY + cs * 0.5, { font: font(500, cs), color: C.cream, alpha: a, tracking: cs * 0.42, align: 'center' });
    text(ctx, sub, cx, capY + cs * 0.5 + ls * 2.05, { font: font(300, ls), color: C.cream, alpha: a * 0.66, tracking: ls * 0.34, align: 'center' });
  };
  lab(B.cxL, 14.1, '三横', '横流为水');
  lab(B.cxR, 14.5, '三竖', '矗立为山');

  // ---- 成形之后的两行字 ----
  if (tg >= 18.3) {
    const ty = B.final.y + B.h1 * 1.72 + (portrait ? 150 : 132) * u;
    const ts = (portrait ? 54 : 52) * u, ss = (portrait ? 27 : 27) * u;
    const o = prog(tg, 22.9, 23.5);
    textReveal(ctx, '矗立为山　横流为水', W / 2, ty, { font: font(500, ts), color: C.cream, tracking: ts * 0.34, align: 'center', blur: 10 * u, rise: 12 * u }, prog(tg, 18.5, 19.9), o);
    textReveal(ctx, portrait ? '三横三竖，极简符号展开的山水图境' : '三横三竖，一幅极简符号展开的山水图境', W / 2, ty + ts * 1.5,
      { font: font(300, ss), color: C.cream, alpha: 0.7, tracking: ss * 0.26, align: 'center', blur: 6 * u, rise: 8 * u, stagger: 0.25 }, prog(tg, 19.6, 21.0), o);
  }

  vignette(ctx, env, 0.5);
}
