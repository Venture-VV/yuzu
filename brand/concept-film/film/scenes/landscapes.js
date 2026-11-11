// 第四场 · 五种景象（24–44 秒，每个 4 秒）
// 品牌书「衍生」里用标志的笔画拼出的五幅图景：湖面波光、山间石洞、林间竹韵、风中摇叶、海中舟迹。
// 笔画与底色都是品牌书的原稿；这里让它们动起来，并排成到店的半日：入汤、疗愈、烟火、欢聚、停泊。
import { clamp, prog, mix, E, hash, font, FONT, text, textReveal, rgba, P } from '../lib.js';
import { fill, linen, tile, glow, layer } from '../stage.js';

export const LANDS = [
  { key: 'ripple', name: '湖面波光', moment: '入汤', line: '把自己交给一池温热', time: '14:00', stroke: '#F6F6F5', ink: '#F6F3EC', shade: '#203646' },
  { key: 'cave', name: '山间石洞', moment: '疗愈', line: '筋骨松开，呼吸慢下来', time: '16:00', stroke: '#F6F6F5', ink: '#F6F3EC', shade: '#2A1F10' },
  { key: 'bamboo', name: '林间竹韵', moment: '烟火', line: '一餐手作的人间烟火', time: '18:30', stroke: '#DDDACB', ink: '#F6F3EC', shade: '#23220F' },
  { key: 'leaf', name: '风中摇叶', moment: '欢聚', line: '和朋友把夜晚玩尽兴', time: '21:00', stroke: '#EBD2C2', ink: '#FBF3EA', shade: '#3A1A08' },
  { key: 'boat', name: '海中舟迹', moment: '停泊', line: '今晚不赶路，就停在这里', time: '23:30', stroke: '#F8F6F0', ink: '#3A2A1E', shade: '#3A2A1E' },
];
export const LAND_T0 = 24, LAND_LEN = 4;

// 每条笔画进场的先后（0..1）与待机时的小动作，按图景各写各的
const ORDER = {
  ripple: (s, pw, ph) => ((s.b[1] + 20) / (ph * 0.86)) * 0.72 + (s.b[0] / pw) * 0.28,
  cave: (s, pw, ph) => Math.hypot((s.b[0] + s.b[2]) / 2 - pw * 0.5, ((s.b[1] + s.b[3]) / 2 - ph * 0.4) * 1.6) / (pw * 0.62),
  bamboo: (s, pw) => clamp(((s.b[0] + s.b[2]) / 2) / pw) * 0.85 + hash(Math.round(s.b[1])) * 0.15,
  leaf: (s, pw, ph) => clamp((((s.b[0] + s.b[2]) / 2) / pw) * 0.55 + (1 - ((s.b[1] + s.b[3]) / 2) / ph) * 0.45),
  boat: (s, pw) => clamp(((s.b[0] + s.b[2]) / 2 + 160) / (pw + 320)),
};

function idle(key, s, i, t) {
  const cx = (s.b[0] + s.b[2]) / 2, cy = (s.b[1] + s.b[3]) / 2;
  switch (key) {
    case 'ripple': { // 一行一行地左右荡
      const row = Math.round(s.b[1] / 26);
      return { dx: Math.sin(t * 1.25 + row * 0.9) * 13 + Math.sin(t * 0.6 + cx * 0.004) * 6, dy: Math.sin(t * 0.9 + row * 1.7) * 1.2 };
    }
    case 'cave': // 洞口一开一合地呼吸，从中间往外传
      return { sx: 1 + 0.045 * Math.sin(t * 1.5 - Math.hypot(cx - 836, cy - 320) * 0.006), dy: Math.sin(t * 0.8 + cx * 0.01) * 1.5 };
    case 'bamboo': // 竹子随风轻摆，绕着根部
      return { rot: (Math.sin(t * 0.95 + cx * 0.0042) * 0.55 + Math.sin(t * 0.43 + cx * 0.011) * 0.25) * Math.PI / 180, pivotY: s.b[3] + 500, dx: Math.sin(t * 0.7 + cx * 0.003) * 3 };
    case 'leaf': // 叶片一片片抖，风从左下吹向右上
      return { rot: Math.sin(t * 2.6 - (cx * 0.006 - cy * 0.008)) * 2.4 * Math.PI / 180, dx: Math.sin(t * 1.3 - cy * 0.006) * 5, dy: Math.sin(t * 1.9 + i) * 1.2 };
    case 'boat': // 小舟一起慢慢向右，各自起伏
      return { dx: t * 9 + Math.sin(t * 0.5 + i * 1.3) * 4, dy: Math.sin(t * 1.1 + i * 2.4) * 3.2, rot: Math.sin(t * 0.9 + i * 1.9) * 0.9 * Math.PI / 180 };
  }
  return {};
}

export function initLands(env) {
  for (const L of LANDS) {
    const pat = env.brand.patterns[L.key];
    const ord = pat.strokes.map((s) => ORDER[L.key](s, pat.w, pat.h));
    const lo = Math.min(...ord), hi = Math.max(...ord);
    pat.order = ord.map((v) => (v - lo) / (hi - lo || 1));
    pat.vertical = L.key === 'bamboo';
    // 文字那一角留白：按这一景中段的取景决定每条笔画留不留（整景不变）
    const { W, H, portrait } = env;
    const cam = camera(env, pat, LAND_LEN / 2);
    const tx = W * (portrait ? 0.30 : 0.22), ty = H * (portrait ? 0.665 : 0.80);
    const rx = W * (portrait ? 0.60 : 0.33), ry = H * (portrait ? 0.15 : 0.30);
    // 右上角的时刻也留一小块
    const qx = W * (portrait ? 0.86 : 0.905), qy = H * (portrait ? 0.125 : 0.092);
    const qrx = W * (portrait ? 0.30 : 0.135), qry = H * (portrait ? 0.062 : 0.105);
    pat.keep = pat.strokes.map((s) => {
      const sx = cam.ox + ((s.b[0] + s.b[2]) / 2) * cam.s, sy = cam.oy + ((s.b[1] + s.b[3]) / 2) * cam.s;
      // 笔画很长：用中心和两端三个点来判断，任何一个落在留白里就不画
      const hw = ((s.b[2] - s.b[0]) / 2) * cam.s * 0.8, hh = ((s.b[3] - s.b[1]) / 2) * cam.s * 0.8;
      const inside = (cx, cy, ax, ay) => [[sx, sy], [sx - hw, sy - hh], [sx + hw, sy + hh]].some(([x, y]) => Math.hypot((x - cx) / ax, (y - cy) / ay) < 1);
      return !inside(tx, ty, rx, ry) && !inside(qx, qy, qrx, qry);
    });
  }
}

// 图景原稿（1672 × 808 的版面）铺到画面上：铺满、略微推拉，竖版时横向慢摇
function camera(env, pat, ts) {
  const { W, H, portrait } = env;
  const k = clamp(ts / LAND_LEN, -0.2, 1.2);
  const zoom = mix(1.10, 1.02, E.outCubic(clamp(k)));
  const s = Math.max(W / pat.w, H / pat.h) * zoom * (portrait ? 0.74 : 1);
  const panX = portrait ? mix(-0.10, 0.10, k) * pat.w * s * 0.3 : mix(-18, 18, k) * env.u;
  const ox = W / 2 - (pat.w / 2) * s + panX, oy = H / 2 - (pat.h * (portrait ? 0.56 : 0.5)) * s;
  return { s, ox, oy };
}

function strokes(ctx, env, L, pat, cam, ts, color, opts = {}) {
  const { W, u } = env;
  const enter = opts.enter ?? 1.25; // 全部进场用时
  ctx.save();
  ctx.fillStyle = color;
  const baseA = ctx.globalAlpha;
  const n = pat.strokes.length;
  for (let i = 0; i < n; i++) {
    const s = pat.strokes[i];
    const start = pat.order[i] * (enter - 0.55);
    const g = E.outCubic(prog(ts, start, start + 0.55));
    if (g <= 0) continue;
    const [x0, y0, x1, y1] = s.b;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const m = idle(L.key, s, i, ts + 10);
    const sx = cam.ox + (cx + (m.dx || 0)) * cam.s, sy = cam.oy + (cy + (m.dy || 0)) * cam.s;
    if (sx < -400 * u * cam.s || sx > W + 400 * u * cam.s) continue;
    if (opts.clearText !== false && !pat.keep[i]) continue;
    ctx.save();
    ctx.globalAlpha = baseA * clamp(g * 1.6);
    ctx.translate(cam.ox, cam.oy);
    ctx.scale(cam.s, cam.s);
    ctx.translate(m.dx || 0, m.dy || 0);
    if (m.rot) { const py = m.pivotY ?? cy; ctx.translate(cx, py); ctx.rotate(m.rot); ctx.translate(-cx, -py); }
    if (m.sx) { ctx.translate(cx, cy); ctx.scale(m.sx, 1); ctx.translate(-cx, -cy); }
    if (g < 1) { // 像落笔：横向的笔画从左到右，竹子从下往上
      ctx.beginPath();
      if (pat.vertical) { const hh = (y1 - y0 + 8) * g; ctx.rect(x0 - 4, y1 + 4 - hh, x1 - x0 + 8, hh); }
      else ctx.rect(x0 - 4, y0 - 4, (x1 - x0 + 8) * g, y1 - y0 + 8);
      ctx.clip();
    }
    ctx.fill(P(s.d));
    ctx.restore();
  }
  ctx.restore();
}

// 一帧完整的图景（不含转场）。ts：这一景开始后的秒数。
function land(ctx, env, idx, ts) {
  const { W, H, u, portrait } = env;
  const L = LANDS[idx], pat = env.brand.patterns[L.key];
  const cam = camera(env, pat, ts);

  fill(ctx, env, pat.bg);
  // 光：一侧亮一点，慢慢移过去
  const lx = W * mix(0.25, 0.75, clamp(ts / LAND_LEN));
  glow(ctx, env, lx, H * 0.2, Math.max(W, H) * 0.8, '#FFFFFF', 0.10, 'soft-light');
  glow(ctx, env, W * 0.5, H * 1.05, Math.max(W, H) * 0.7, L.shade, 0.30, 'multiply');

  // 远处的一层：同样的笔画，放大、压暗、虚焦，移动得慢 —— 景深
  const [fc, fg] = layer(env, 'far', 0.5);
  const far = { s: cam.s * 1.9, ox: cam.ox - W * 0.55 + ts * 14 * u, oy: cam.oy - H * 0.5 };
  strokes(fg, env, L, pat, far, ts + 1.2, L.shade, { clearText: false, enter: 0.2 });
  ctx.save();
  ctx.globalAlpha = 0.16;
  ctx.filter = `blur(${(7 * u).toFixed(1)}px)`;
  ctx.drawImage(fc, 0, 0, W, H);
  ctx.restore();

  // 笔画，下面带一点点投影，像纸片贴在布上
  const [mc, mg] = layer(env, 'main', 1);
  strokes(mg, env, L, pat, cam, ts, L.stroke);
  ctx.save();
  ctx.filter = `drop-shadow(${(3 * u).toFixed(1)}px ${(6 * u).toFixed(1)}px ${(5 * u).toFixed(1)}px ${rgba(L.shade, 0.26)})`;
  ctx.drawImage(mc, 0, 0);
  ctx.restore();
  linen(ctx, env, 0.26);
  tile(ctx, env, env.tex.mistDark, { scale: (Math.max(W, H) / 512) * 1.3, dx: ts * 10 * u, alpha: 0.07, op: 'multiply' });

  // ---- 字 ----
  const mx = W * (portrait ? 0.075 : 0.085);
  const big = (portrait ? 176 : 168) * u, small = (portrait ? 33 : 30) * u, line = (portrait ? 39 : 36) * u, idxS = (portrait ? 27 : 25) * u;
  const baseY = portrait ? H * 0.70 : H - 146 * u;
  const out = prog(ts, 3.55, 3.95);
  const fadeA = 1 - E.inQuad(out);
  // 序号 · 图景名
  const a1 = E.outCubic(prog(ts, 0.35, 0.95)) * fadeA;
  if (a1 > 0) {
    const y = baseY - big * 1.06;
    const wIdx = text(ctx, `0${idx + 1}`, mx, y, { font: font(700, idxS, FONT.en), color: L.ink, alpha: a1, tracking: idxS * 0.1 });
    ctx.save(); ctx.globalAlpha = a1 * 0.7; ctx.fillStyle = L.ink;
    const lw = 54 * u * E.outCubic(prog(ts, 0.4, 1.1));
    ctx.fillRect(mx + wIdx + 16 * u, y - idxS * 0.36, lw, Math.max(1, 1.5 * u)); ctx.restore();
    text(ctx, L.name, mx + wIdx + 16 * u + 54 * u + 16 * u, y, { font: font(500, small), color: L.ink, alpha: a1, tracking: small * 0.22 });
  }
  // 大字
  textReveal(ctx, L.moment, mx - big * 0.035, baseY, { font: font(700, big), color: L.ink, tracking: big * 0.07, blur: 16 * u, rise: 30 * u, stagger: 1 }, prog(ts, 0.45, 1.35), out);
  // 一句话
  textReveal(ctx, L.line, mx, baseY + line * 1.9, { font: font(400, line), color: L.ink, alpha: 0.92, tracking: line * 0.12, blur: 8 * u, rise: 10 * u, stagger: 0.35 }, prog(ts, 0.95, 2.0), out);
  // 时刻（半日的行程）
  const a2 = E.outCubic(prog(ts, 0.3, 0.9)) * fadeA;
  if (a2 > 0) {
    const ts2 = (portrait ? 46 : 44) * u;
    const yy = portrait ? H * 0.135 : 112 * u;
    text(ctx, L.time, W - mx, yy, { font: font(700, ts2, FONT.en), color: L.ink, alpha: a2, tracking: ts2 * 0.04, align: 'right' });
  }
}

// ---------- 转场：每一景像一层色纸盖上来，方向各不相同 ----------
// 返回这一层的前沿（用来画投影）；同时把裁剪区域设好。
function wipe(ctx, env, idx, p) {
  const { W, H, u } = env;
  const e = E.inOutCubic(clamp(p));
  ctx.beginPath();
  let edge = null;
  if (idx === 0) { // 水从下面漫上来，水面带一点起伏
    const y = H * (1.06 - 1.14 * e);
    ctx.moveTo(0, H); ctx.lineTo(0, y);
    for (let x = 0; x <= W; x += W / 48) ctx.lineTo(x, y + Math.sin(x / W * 9 + p * 7) * 16 * u * (1 - e) + Math.sin(x / W * 23 - p * 5) * 6 * u * (1 - e));
    ctx.lineTo(W, H); ctx.closePath();
    edge = { x0: 0, y0: y, x1: W, y1: y, nx: 0, ny: -1 };
  } else if (idx === 1) { // 从右往左
    const x = W * (1 - e) - 2;
    ctx.rect(x, 0, W - x + 2, H);
    edge = { x0: x, y0: 0, x1: x, y1: H, nx: -1, ny: 0 };
  } else if (idx === 2) { // 从上往下，像放下一道竹帘
    const y = H * e + 2;
    ctx.rect(0, 0, W, y);
    edge = { x0: 0, y0: y, x1: W, y1: y, nx: 0, ny: 1 };
  } else if (idx === 3) { // 一阵风从左下斜着吹过
    const d = (W + H) * (1.12 * e) - H * 0.06;
    ctx.moveTo(-H, H); ctx.lineTo(d - H, H); ctx.lineTo(d, 0); ctx.lineTo(-H, 0); ctx.closePath();
    edge = { x0: d - H, y0: H, x1: d, y1: 0, nx: 0.7071, ny: 0.7071 };
  } else { // 从左往右，像船靠过来
    const x = W * e + 2;
    ctx.rect(0, 0, x, H);
    edge = { x0: x, y0: 0, x1: x, y1: H, nx: 1, ny: 0 };
  }
  return edge;
}

// 前沿外侧的一道投影，让新的一层像是压在上一层上面
function edgeShadow(ctx, env, edge, p) {
  if (!edge) return;
  const { u } = env;
  const w = 46 * u;
  const a = 0.26 * Math.sin(Math.PI * clamp(p));
  if (a <= 0.005) return;
  const g = ctx.createLinearGradient(edge.x0, edge.y0, edge.x0 + edge.nx * w, edge.y0 + edge.ny * w);
  g.addColorStop(0, `rgba(20,12,6,${a})`); g.addColorStop(1, 'rgba(20,12,6,0)');
  ctx.save();
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(edge.x0, edge.y0); ctx.lineTo(edge.x1, edge.y1);
  ctx.lineTo(edge.x1 + edge.nx * w, edge.y1 + edge.ny * w); ctx.lineTo(edge.x0 + edge.nx * w, edge.y0 + edge.ny * w);
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

export function landscapes(ctx, env, tl, dur, tg) {
  for (let i = 0; i < LANDS.length; i++) {
    const t0 = LAND_T0 + i * LAND_LEN;
    const a = i === 0 ? t0 - 0.55 : t0 - 0.38, b = i === 0 ? t0 + 0.2 : t0 + 0.42; // 盖上来的时间段
    if (tg < a || tg >= t0 + LAND_LEN + 0.5) continue;
    const p = (tg - a) / (b - a);
    ctx.save();
    const edge = tg < b ? wipe(ctx, env, i, p) : null;
    if (edge) ctx.clip();
    land(ctx, env, i, tg - t0);
    ctx.restore();
    if (edge && i > 0) edgeShadow(ctx, env, edge, p);
  }
}
