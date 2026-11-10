// 二维码画成 SVG 路径（柚子饭堂的饭卡码、管理后台的开通卡片共用）：方块带一点圆角，三个定位角单独画成圆角方框，
// 看着可爱、扫码软件照样认（模块中心是实心的）。用 uqr 编码，不联网、不依赖画布。

import { encode, QrCodeDataType } from 'uqr';

export interface QrShape {
  /** 边长（模块数，不含留白） */
  size: number;
  /** 数据模块的路径 */
  modules: string;
  /** 三个定位角的左上角（模块坐标） */
  eyes: { x: number; y: number }[];
}

const R = 0.28;
const cell = (x: number, y: number) =>
  `M${x + R},${y}h${1 - 2 * R}a${R},${R} 0 0 1 ${R},${R}v${1 - 2 * R}a${R},${R} 0 0 1 -${R},${R}h-${1 - 2 * R}a${R},${R} 0 0 1 -${R},-${R}v-${1 - 2 * R}a${R},${R} 0 0 1 ${R},-${R}z`;

export function qrShape(text: string, ecc: 'L' | 'M' | 'Q' | 'H' = 'M'): QrShape {
  const qr = encode(text, { ecc, border: 0 });
  let modules = '';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.data[y]![x] && qr.types[y]![x] !== QrCodeDataType.Position) modules += cell(x, y);
    }
  }
  return { size: qr.size, modules, eyes: [{ x: 0, y: 0 }, { x: qr.size - 7, y: 0 }, { x: 0, y: qr.size - 7 }] };
}
