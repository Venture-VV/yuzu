// 楼层导览图（对客，只到区域：没有房号、房态、人员，见 v0.7.19 的对客导览）：
// 后台「空间台账 → 对客导览」配好的区域色块、中英文区域名、设施图标，按楼层画在画布上；底图（去掉了图上文字的线稿）垫在下面、半透明。
// 坐标是楼层的本地坐标（与员工端口的导览图一样），等比缩放放进画布。

import type { GuideMarker, GuideMarkerKind, GuideZone } from '../../../src/shared/guide';

export interface Fit {
  /** 本地坐标 × scale = 画布上的像素 */
  scale: number;
  offsetX: number;
  offsetY: number;
  /** 画布的宽高（像素，不含设备像素比） */
  width: number;
  height: number;
}

/** 等比缩放放进 width 宽的画布：高度随楼层的长宽比，最高 maxHeight */
export function fitFloor(floor: { width: number; height: number }, width: number, maxHeight: number, pad = 8): Fit {
  const fw = Math.max(1, floor.width);
  const fh = Math.max(1, floor.height);
  const scale = Math.min((width - pad * 2) / fw, (maxHeight - pad * 2) / fh);
  const w = fw * scale;
  const h = fh * scale;
  return { scale, offsetX: (width - w) / 2, offsetY: pad, width, height: Math.ceil(h + pad * 2) };
}

/** 设施图标上写的字（地图上只写一个字，图例里写全名） */
export const MARKER_GLYPHS: Record<GuideMarkerKind, string> = {
  toilet: '卫',
  elevator: '电',
  stairs: '梯',
  reception: '台',
  entrance: '入',
  locker: '衣',
  dining: '餐',
  smoking: '烟',
};

/** 画导览图要的画布操作（微信的 canvas 2d 与测试里的假画布都满足） */
export interface GuideCanvas {
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  lineJoin: string;
  globalAlpha: number;
  font: string;
  textAlign: string;
  textBaseline: string;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, start: number, end: number): void;
  fill(): void;
  stroke(): void;
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
  drawImage(image: unknown, x: number, y: number, w: number, h: number): void;
}

const INK = '#1C1A17';
const MUTED = '#5E554B';
const PAPER = '#FCFAF6';
const FONT = '"PingFang SC", "HarmonyOS Sans SC", "Helvetica Neue", sans-serif';
const FONT_EN = '"Helvetica Neue", Helvetica, Arial, sans-serif';

/** 区域名的字号（像素）：随区域大小，限制在 11–15；区域太小写不下时为 0（看图例） */
export function zoneLabelSize(zone: Pick<GuideZone, 'area' | 'name'>, scale: number): number {
  const side = Math.sqrt(Math.max(0, zone.area)) * scale;
  const size = Math.min(15, Math.max(11, side / 6));
  // 中文名的宽度大约是字数 × 字号，比区域的边长还宽就不写
  return zone.name.length * size > side * 1.15 ? 0 : size;
}

export function drawFloor(
  ctx: GuideCanvas,
  fit: Fit,
  zones: GuideZone[],
  markers: GuideMarker[],
  base?: { image: unknown; width: number; height: number } | null,
): void {
  const { scale, offsetX, offsetY } = fit;
  const X = (x: number) => offsetX + x * scale;
  const Y = (y: number) => offsetY + y * scale;
  ctx.clearRect(0, 0, fit.width, fit.height);
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, fit.width, fit.height);
  if (base) {
    ctx.globalAlpha = 0.5;
    ctx.drawImage(base.image, offsetX, offsetY, base.width * scale, base.height * scale);
    ctx.globalAlpha = 1;
  }
  // 区域色块：白色细边分开相邻的房间
  ctx.lineJoin = 'round';
  for (const z of zones) {
    ctx.fillStyle = z.color;
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 1;
    for (const poly of z.polygons) {
      if (poly.length < 3) continue;
      ctx.beginPath();
      ctx.moveTo(X(poly[0]![0]), Y(poly[0]![1]));
      for (let i = 1; i < poly.length; i++) ctx.lineTo(X(poly[i]![0]), Y(poly[i]![1]));
      ctx.closePath();
      ctx.globalAlpha = 0.92;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.stroke();
    }
  }
  // 区域名：中文在上、英文在下，白色描边压在色块上
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const z of zones) {
    const size = zoneLabelSize(z, scale);
    if (!size) continue;
    const x = X(z.labelAt[0]);
    const y = Y(z.labelAt[1]);
    const en = z.nameEn && size >= 12 ? z.nameEn.toUpperCase() : '';
    ctx.font = '600 ' + size + 'px ' + FONT;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.fillStyle = INK;
    const zy = en ? y - size * 0.4 : y;
    ctx.strokeText(z.name, x, zy);
    ctx.fillText(z.name, x, zy);
    if (en) {
      const es = Math.max(8, Math.round(size * 0.55));
      ctx.font = '700 ' + es + 'px ' + FONT_EN;
      ctx.lineWidth = 2;
      ctx.strokeText(en, x, y + size * 0.6);
      ctx.fillStyle = MUTED;
      ctx.fillText(en, x, y + size * 0.6);
    }
  }
  // 设施：深色圆点里写一个字
  const r = 8;
  for (const m of markers) {
    const x = X(m.x);
    const y = Y(m.y);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = INK;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#FFFFFF';
    ctx.stroke();
    ctx.font = '600 10px ' + FONT;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(MARKER_GLYPHS[m.kind] || '·', x, y + 0.5);
  }
}

/** 图例：区域（颜色、中英文名）与设施（图标上的字、全名），设施按种类与文字去重 */
export function legendOf(zones: GuideZone[], markers: GuideMarker[]) {
  const seen: Record<string, boolean> = {};
  const facilities: { key: string; glyph: string; label: string; labelEn: string }[] = [];
  for (const m of markers) {
    const key = m.kind + '|' + m.label + '|' + m.labelEn;
    if (seen[key]) continue;
    seen[key] = true;
    facilities.push({ key, glyph: MARKER_GLYPHS[m.kind] || '·', label: m.label, labelEn: m.labelEn });
  }
  return {
    zones: zones.map((z) => ({ id: z.id, name: z.name, nameEn: z.nameEn, color: z.color })),
    facilities,
  };
}

/** 楼层按编号排（B1、1F、2F…，数字按大小） */
export function sortFloorCodes<T extends { code: string }>(floors: T[]): T[] {
  const num = (c: string) => {
    const m = /-?\d+/.exec(c);
    const n = m ? parseInt(m[0], 10) : 0;
    return /^B/i.test(c) ? -n : n;
  };
  return floors.slice().sort((a, b) => num(a.code) - num(b.code) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}
