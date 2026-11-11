// 第五场 · 品牌文字（44–56 秒）、第六场 · 口号（56–64 秒）、第七场 · 落版（64–72 秒）
// 文字取自 Strategy 的「品牌文字方向」与品牌屋：A³（ALIVE / AMUSE / AWAKE）、
// 口号 YOUR NEXT URBAN PLEASURE · 都市新旅生活目的地；口号的排法照 Strategy 的字体应用页
// （Helvetica + 鸿蒙，三行左对齐、行距收紧，上方一排 ALIVE AMUSE AWAKE）。
// 落版只用竖排字标：Strategy 规定「汤崎」与 TOUCHILL 不同时并用，图形标与字标分开使用。
import { prog, mix, E, font, FONT, text, textReveal, textRise, layout } from '../lib.js';
import { C, fill, vignette, darkBackdrop, drawMark, drawLogotype, MARK_ORDER, layer } from '../stage.js';
import { LANDS } from './landscapes.js';

const LINES = [
  ['在动与静之间，', 44.5],
  ['在松弛与活力之间。', 45.6],
  ['一处身体停泊的所在，', 47.2],
  ['一座城市闲暇时光的入口。', 48.3],
  ['让每一次到访，', 49.9],
  ['都成为日常之外的小小旅程。', 51.0],
];
const A3 = [['ALIVE', '松弛社交'], ['AMUSE', '烟火娱乐'], ['AWAKE', '动静身心']];

// 背景里虚焦的大笔画，慢慢漂：让只有字的画面有景深。先画在四分之一大小的离屏画布上，再整层虚化。
function driftStrokes(ctx, env, tg, alpha) {
  if (alpha <= 0) return;
  const { W, H, u, portrait } = env;
  const [oc, og] = layer(env, 'drift', 0.25);
  const w = (portrait ? 1.9 : 1.25) * W;
  const st = {};
  MARK_ORDER.forEach((k, i) => {
    st[k] = { dx: Math.sin(tg * 0.13 + i * 1.9) * 60 * u + (i - 2.5) * 30 * u, dy: Math.cos(tg * 0.11 + i * 2.3) * 40 * u, rot: Math.sin(tg * 0.07 + i) * 0.02 };
  });
  drawMark(og, env, { x: W * (portrait ? -0.25 : 0.12) - (tg - 44) * 9 * u, y: H * (portrait ? 0.30 : 0.16), w }, C.hemp1, st);
  ctx.save();
  ctx.filter = `blur(${(20 * u).toFixed(1)}px)`;
  ctx.globalAlpha *= alpha;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(oc, 0, 0, W, H);
  ctx.restore();
}

// A³ 三个词：先大（居中三列 / 竖版三行），再缩成口号页上方的一排小字
function a3(ctx, env, tg) {
  const { W, H, u, portrait } = env;
  const mx = W * (portrait ? 0.075 : 0.085);
  const move = E.inOutCubic(prog(tg, 54.85, 55.85));
  const gone = prog(tg, 63.2, 63.8);
  for (let i = 0; i < 3; i++) {
    const [en, cn] = A3[i];
    const inP = prog(tg, 52.2 + i * 0.75, 53.1 + i * 0.75);
    if (inP <= 0) continue;
    const big = (portrait ? 150 : 132) * u, small = (portrait ? 30 : 28) * u;
    const size = mix(big, small, move);
    // 起点
    const x0 = portrait ? mx : W * (0.085 + 0.293 * i);
    const y0 = portrait ? H * (0.36 + 0.115 * i) : H * 0.50;
    // 终点：上方一排，左 / 中 / 右
    ctx.save(); ctx.font = font(700, small, FONT.en);
    const wSmall = layout(ctx, en, small * 0.14).total; ctx.restore();
    const x1 = i === 0 ? mx : i === 1 ? (W - wSmall) / 2 : W - mx - wSmall;
    const y1 = portrait ? H * 0.135 : 112 * u;
    const x = mix(x0, x1, move), y = mix(y0, y1, move);
    const tr = mix(big * -0.01, small * 0.14, move);
    const a = (1 - gone);
    textReveal(ctx, en, x, y, { font: font(700, size, FONT.en), color: C.cream, tracking: tr, blur: 14 * u * (1 - move), rise: 26 * u, stagger: 0.5, alpha: a }, inP);
    const subA = E.outCubic(prog(tg, 52.6 + i * 0.75, 53.3 + i * 0.75)) * (1 - prog(tg, 54.6, 55.1));
    if (subA > 0) {
      const cs = (portrait ? 38 : 36) * u;
      text(ctx, cn, x0 + big * 0.02, y0 + cs * 1.75, { font: font(400, cs), color: C.cream, alpha: subA * 0.8, tracking: cs * 0.36 });
    }
  }
}

export function words(ctx, env, tl, dur, tg) {
  const { W, H, u, portrait } = env;
  // 从上一场（沙色的「停泊」）暗下来，像入夜：整场叠化进来
  const inA = E.inOutQuad(prog(tg, 43.6, 44.4));
  ctx.globalAlpha = inA;
  darkBackdrop(ctx, env, tg, 1, prog(tg, 55.5, 58));
  driftStrokes(ctx, env, tg, 0.13 * (1 - prog(tg, 62.5, 63.8)));

  // ---- 一段话，一行一行浮出来 ----
  const size = (portrait ? 56 : 58) * u, lh = size * 1.68;
  const x = W * (portrait ? 0.075 : 0.16);
  const blockH = 5 * lh + 2 * size * 0.55;
  const yTop = H * (portrait ? 0.45 : 0.5) - blockH / 2 + size * 0.36;
  const paraOut = prog(tg, 51.9, 52.5);
  LINES.forEach(([str, t0], i) => {
    const pair = Math.floor(i / 2);
    // 读到下一句时，前面的句子退后一点
    const nextPairAt = pair < 2 ? LINES[(pair + 1) * 2][1] : 99;
    const dim = mix(1, 0.42, E.inOutQuad(prog(tg, nextPairAt - 0.2, nextPairAt + 0.6)));
    const y = yTop + i * lh + pair * size * 0.55;
    textReveal(ctx, str, x, y, { font: font(300, size), color: C.cream, alpha: dim, tracking: size * 0.1, blur: 10 * u, rise: 14 * u, stagger: 0.42 }, prog(tg, t0, t0 + 1.0), paraOut);
  });

  a3(ctx, env, tg);
  vignette(ctx, env, 0.5);
}

export function slogan(ctx, env, tl, dur, tg) {
  const { W, H, u, portrait } = env;
  const mx = W * (portrait ? 0.075 : 0.085);
  const out = prog(tg, 63.2, 63.9);
  const a = 1 - E.inOutQuad(out);
  const push = 1 + 0.018 * prog(tg, 56, 64); // 很慢地推近
  ctx.save();
  ctx.translate(W / 2, H / 2); ctx.scale(push, push); ctx.translate(-W / 2, -H / 2);
  ctx.globalAlpha = a;

  // 三行口号：字号按「URBAN PLEASURE」撑满版心来定
  const avail = W - mx * 2;
  ctx.save(); ctx.font = font(700, 100, FONT.en);
  const w100 = layout(ctx, 'URBAN PLEASURE', -2).total; ctx.restore();
  const en = Math.min((portrait ? 1.0 : 0.80) * avail / w100 * 100, 190 * u);
  const cn = en * (portrait ? 0.80 : 0.84);
  const tr = -en * 0.02;
  const block = en * 0.93 * 2 + cn * 1.02;
  const y0 = H * (portrait ? 0.47 : 0.50) - block / 2 + en * 0.74;
  const oEn = { font: font(700, en, FONT.en), color: C.cream, tracking: tr, size: en, maxWidth: W };
  textRise(ctx, 'YOUR NEXT', mx - en * 0.01, y0, oEn, prog(tg, 55.88, 56.7));
  textRise(ctx, 'URBAN PLEASURE', mx - en * 0.01, y0 + en * 0.93, oEn, prog(tg, 56.88, 57.7));
  textRise(ctx, '都市新旅生活目的地', mx, y0 + en * 0.93 + cn * 1.12, { font: font(700, cn), color: C.cream, tracking: cn * 0.045, size: cn, maxWidth: W }, prog(tg, 57.88, 58.7));

  // 五种景象的五个颜色连成一条线
  const barY = y0 + en * 0.93 + cn * 1.12 + cn * 0.62;
  ctx.save(); ctx.font = font(700, cn);
  const cnW = layout(ctx, '都市新旅生活目的地', cn * 0.045).total; ctx.restore();
  const bw = cnW, seg = bw / 5, bh = Math.max(3, 9 * u);
  for (let i = 0; i < 5; i++) {
    const k = E.outCubic(prog(tg, 58.9 + i * 0.13, 59.5 + i * 0.13));
    if (k <= 0) continue;
    ctx.fillStyle = env.brand.patterns[LANDS[i].key].bg;
    ctx.fillRect(mx + i * seg, barY, seg * k + (i < 4 && k >= 1 ? 0.5 : 0), bh);
  }

  // 下方：左边竖排字标，右边图形标（分开用）
  const la = E.outCubic(prog(tg, 59.6, 60.6));
  if (la > 0) {
    const lw = (portrait ? 118 : 104) * u;
    const L = env.brand.logotype, m = env.brand.mark;
    const by = portrait ? H * 0.765 : H - 104 * u;
    drawLogotype(ctx, env, { x: mx, y: by - lw * L.h / L.w, w: lw }, C.cream, {}, la);
    const mw = (portrait ? 190 : 172) * u;
    drawMark(ctx, env, { x: W - mx - mw, y: by - mw * m.h / m.w, w: mw }, C.cream, true, la);
  }
  ctx.restore();
  vignette(ctx, env, 0.5);
}

export function ending(ctx, env, tl, dur, tg) {
  const { W, H, u, portrait } = env;
  const inA = E.inOutQuad(prog(tg, 63.5, 64.3));
  ctx.save();
  ctx.globalAlpha = inA;
  darkBackdrop(ctx, env, tg, 1, 1.35);

  // 竖排字标：三横（水）流出来，山立起来，其余笔画显出来
  const L = env.brand.logotype;
  const push = 1 + 0.03 * prog(tg, 64, 72);
  const lw = (portrait ? 400 : 330) * u * push;
  const lh = lw * L.h / L.w;
  const box = { x: (W - lw) / 2, y: H * (portrait ? 0.42 : 0.435) - lh / 2, w: lw };
  const g = (a, d = 0.8) => E.outCubic(prog(tg, a, a + d));
  const state = {
    w0: { grow: g(64.25) }, w1: { grow: g(64.45) }, w2: { grow: g(64.65) },
    s0: { grow: g(64.9, 0.9) }, s1: { grow: g(65.1, 0.9) },
    tang: { alpha: E.inOutQuad(prog(tg, 65.2, 66.2)) }, qi: { alpha: E.inOutQuad(prog(tg, 65.5, 66.5)) },
  };
  drawLogotype(ctx, env, box, C.cream, state);

  const s1 = (portrait ? 36 : 33) * u, s2 = (portrait ? 21 : 20) * u;
  const ty = box.y + lh + (portrait ? 118 : 104) * u;
  textReveal(ctx, '都市新旅生活目的地', W / 2, ty, { font: font(500, s1), color: C.cream, tracking: s1 * 0.5, align: 'center', blur: 8 * u, rise: 10 * u, stagger: 0.35 }, prog(tg, 66.3, 67.5));
  textReveal(ctx, 'YOUR NEXT URBAN PLEASURE', W / 2, ty + s1 * 1.45, { font: font(700, s2, FONT.en), color: C.cream, alpha: 0.78, tracking: s2 * 0.34, align: 'center', blur: 6 * u, rise: 8 * u, stagger: 0.2 }, prog(tg, 66.8, 68.0));
  if (env.cta) {
    const s3 = (portrait ? 27 : 25) * u;
    textReveal(ctx, env.cta, W / 2, portrait ? H * 0.745 : H - 96 * u, { font: font(400, s3), color: C.cream, alpha: 0.86, tracking: s3 * 0.16, align: 'center', blur: 6 * u, rise: 8 * u, stagger: 0.15 }, prog(tg, 67.4, 68.6));
  }
  vignette(ctx, env, 0.55);
  ctx.restore();
  // 片尾暗下去
  fill(ctx, env, '#000', E.inOutQuad(prog(tg, 70.9, 71.9)));
}
