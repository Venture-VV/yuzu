// 第一场 · 城市节奏 → 山是层次，水为间奏（0–8.6 秒）
// 一排竖条像城市的节拍一样急促地跳；一句话响起，节拍慢下来，竖条落定成高低错落的山，
// 下面浮出长短不一的横线，是水。竖条与横线的排法照品牌书「层次 & 间奏」那两页。
import { clamp, prog, mix, E, hash2, noise1, font, FONT, text, textReveal } from '../lib.js';
import { C, fill, vignette, darkBackdrop } from '../stage.js';

// 品牌书里「山是层次」竖条的四个错落高度（占竖条自身高度的比例），四条一组循环
const STAGGER = [0.273, 0.0, 0.184, 0.372];
// 品牌书里「水是间奏」四行横线的起止（占整行宽度的比例）
const DASH_ROWS = [
  [[19.4, 93.7], [117.3, 416.0], [439.6, 738.2], [761.8, 1060.5], [1084.1, 1308.3], [1331.9, 1556.2], [1579.8, 1654.2]],
  [[18.2, 153.9], [204.8, 340.5], [394.1, 529.7], [583.4, 719.0], [783.3, 932.0], [999.4, 1135.1], [1201.7, 1337.3], [1401.3, 1537.0], [1601.2, 1654.2]],
  [[19.1, 1654.2]],
  [[55.7, 191.4], [315.7, 451.3], [575.6, 711.3], [836.2, 971.9], [1114.9, 1250.6], [1393.6, 1529.3]],
].map((row) => row.map(([a, b]) => [a / 1672.44, b / 1672.44]));

// 节拍的「钟」：前 1.4 秒每秒 11 拍，之后越来越慢，5 秒左右停住
function beatClock(t) {
  let tau = 0;
  const dt = 1 / 60;
  for (let s = 0; s < t; s += dt) {
    const k = 1 - prog(s, 1.4, 5.0);
    tau += 11 * k * k * dt;
  }
  return tau;
}

export function opening(ctx, env, t) {
  const { W, H, u, portrait } = env;
  const calm = E.inOutCubic(prog(t, 2.2, 5.2)); // 0 = 城市，1 = 山水
  const out = prog(t, 7.1, 8.0);

  darkBackdrop(ctx, env, t, calm);

  // ---- 竖条 ----
  const pitch = 26 * u;
  const n = Math.ceil(W / pitch) + 1;
  const bw = pitch * 0.5;
  const hb = (portrait ? 0.17 : 0.27) * H;                // 落定后每条的高度
  const bandTop = (portrait ? 0.30 : 0.19) * H;            // 山那一带的上沿
  const base = bandTop + hb * (1 + STAGGER[3]) + 4 * u;    // 城市时的地平线
  const tau = beatClock(t);
  const step = Math.floor(tau), frac = tau - step;

  ctx.save();
  for (let i = 0; i < n; i++) {
    const x = i * pitch + (pitch - bw) / 2 - (n * pitch - W) / 2;
    // 城市：一格一格地跳；越接近平静，越像呼吸一样连续
    const stepped = hash2(step + i * 7, i * 13 + 5);
    const smooth = noise1(tau * 0.9 + i * 3.37, 21);
    const lvl = mix(stepped, smooth, clamp(calm * 1.6));
    const hCity = H * (portrait ? 0.03 + 0.22 * lvl * lvl : 0.04 + 0.5 * lvl * lvl);
    const topCity = base - hCity, botCity = base;
    const topCalm = bandTop + STAGGER[i % 4] * hb, botCalm = topCalm + hb;
    let top = mix(topCity, topCalm, calm), bot = mix(botCity, botCalm, calm);
    // 离场：从左到右依次收成一条线
    if (out > 0) {
      const k = E.inCubic(clamp(out * 1.6 - (i / n) * 0.6));
      const mid = (top + bot) / 2;
      top = mix(top, mid, k); bot = mix(bot, mid, k);
    }
    const flick = 0.22 + 0.78 * hash2(step * 3 + i, 77);
    const a = mix(flick, 1, clamp(calm * 1.4)) * (1 - 0.25 * (1 - calm));
    ctx.globalAlpha = a * (1 - E.inQuad(out));
    ctx.fillStyle = calm > 0.5 ? C.cream : '#CDBBA3';
    ctx.fillRect(x, top, bw, Math.max(0, bot - top));
  }
  ctx.restore();

  // ---- 横线（水）----
  const rowH = bw, rowPitch = rowH * 1.56;
  const dashTop = base + (portrait ? 0.075 : 0.105) * H;
  const mx = (portrait ? 0.07 : 0.085) * W;
  ctx.save();
  ctx.fillStyle = C.cream;
  DASH_ROWS.forEach((row, r) => {
    row.forEach(([a, b], j) => {
      const x0 = mx + a * (W - 2 * mx), x1 = mx + b * (W - 2 * mx);
      const start = 5.0 + r * 0.22 + a * 0.9;
      const k = E.outCubic(prog(t, start, start + 0.9));
      if (k <= 0) return;
      const k2 = out > 0 ? 1 - E.inCubic(clamp(out * 1.5 - a * 0.5)) : 1;
      ctx.globalAlpha = 0.92 * k2;
      ctx.fillRect(x0, dashTop + r * rowPitch, (x1 - x0) * k * k2, rowH);
    });
  });
  ctx.restore();

  // ---- 那句话 ----
  const tx = mx, size = (portrait ? 58 : 60) * u;
  const ty = portrait ? H * 0.70 : H * 0.80;
  const f = font(300, size);
  const o = { font: f, color: C.cream, tracking: size * 0.08, blur: 10 * u, rise: 14 * u };
  const gone = prog(t, 5.0, 5.7);
  textReveal(ctx, '今天就先到这里吧，', tx, ty, o, prog(t, 0.8, 2.0), gone);
  textReveal(ctx, '接下来，先放松一下。', tx, ty + size * 1.62, o, prog(t, 2.7, 3.9), gone);

  // ---- 山 / 水 的小字 ----
  const capA = E.outCubic(prog(t, 5.4, 6.2)) * (1 - prog(t, 6.9, 7.4));
  if (capA > 0) {
    const cs = (portrait ? 30 : 27) * u, es = (portrait ? 19 : 17) * u;
    const y1 = bandTop - 46 * u;
    text(ctx, '山是层次', mx, y1, { font: font(500, cs), color: C.cream, alpha: capA, tracking: cs * 0.12 });
    text(ctx, 'MOUNTAINS ARE LEVELS', mx + cs * 5.1, y1 - 1 * u, { font: font(400, es, FONT.en), color: C.cream, alpha: capA * 0.55, tracking: es * 0.16 });
    const y2 = dashTop + rowPitch * 3 + rowH + 62 * u;
    const capB = E.outCubic(prog(t, 5.9, 6.7)) * (1 - prog(t, 6.9, 7.4));
    text(ctx, '水为间奏', mx, y2, { font: font(500, cs), color: C.cream, alpha: capB, tracking: cs * 0.12 });
    text(ctx, 'WATER IS AN INTERLUDE', mx + cs * 5.1, y2 - 1 * u, { font: font(400, es, FONT.en), color: C.cream, alpha: capB * 0.55, tracking: es * 0.16 });
  }

  vignette(ctx, env, 0.5);
  // 片头从黑里亮起来
  fill(ctx, env, '#000', 1 - E.outCubic(prog(t, 0, 0.4)));
}
