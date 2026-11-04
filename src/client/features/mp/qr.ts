// 后台打印桌码用的二维码（小程序线第三期 3c）：与小程序里会员码的二维码（miniprogram/src/utils/qr.ts）是同一份编码器，
// 只编码数字（数字模式），纠错等级 M，版本 1–3。小程序的目录不进门店系统的构建（.dockerignore），所以这里放一份；
// 两份编出来的一样由 tests/mp-qr.test.ts 核对，改一份要同时改另一份。
// 按 ISO/IEC 18004 生成：数据位 → 补齐 → 里德-所罗门纠错码 → 功能图形 → 之字形摆放 → 8 种掩模里挑扣分最少的 → 格式信息。

export interface QrMatrix {
  size: number;
  /** modules[y][x]，true 为深色 */
  modules: boolean[][];
}

interface Version {
  version: number;
  dataCodewords: number;
  ecCodewords: number;
  /** 校正图形的中心坐标（版本 1 没有） */
  align: number[];
}

// 纠错等级 M、单个数据块
const VERSIONS: Version[] = [
  { version: 1, dataCodewords: 16, ecCodewords: 10, align: [] },
  { version: 2, dataCodewords: 28, ecCodewords: 16, align: [6, 18] },
  { version: 3, dataCodewords: 44, ecCodewords: 26, align: [6, 22] },
];
/** 格式信息里纠错等级 M 的两位 */
const EC_LEVEL_M = 0;

// ── 里德-所罗门（GF(256)，本原多项式 0x11D）──

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

/** 生成多项式 ∏(x − αⁱ)，i = 0…degree−1（系数从高次到低次，省掉最高次的 1） */
function rsDivisor(degree: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < degree - 1; i++) result.push(0);
  result.push(1);
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < result.length) result[j]! ^= result[j + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    for (let i = 0; i < divisor.length; i++) result[i]! ^= gfMultiply(divisor[i]!, factor);
  }
  return result;
}

// ── 掩模 ──

function maskHit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

/** 编码一串数字；超过 101 位时报错 */
export function encodeDigits(digits: string): QrMatrix {
  if (!/^\d+$/.test(digits)) throw new Error('二维码只编码数字');
  const n = digits.length;
  // 模式指示（4 位）+ 字符数（10 位）+ 每 3 位数字 10 位、余 2 位 7 位、余 1 位 4 位
  const needBits = 4 + 10 + Math.floor(n / 3) * 10 + [0, 4, 7][n % 3]!;
  let v: Version | undefined;
  for (const c of VERSIONS) {
    if (needBits <= c.dataCodewords * 8) {
      v = c;
      break;
    }
  }
  if (!v) throw new Error('数字太长，二维码放不下');

  // 数据位
  const bits: number[] = [];
  const push = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0001, 4);
  push(n, 10);
  for (let i = 0; i < n; i += 3) {
    const chunk = digits.slice(i, i + 3);
    push(parseInt(chunk, 10), chunk.length * 3 + 1);
  }
  const capacity = v.dataCodewords * 8;
  push(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]!;
    data.push(b);
  }
  for (let pad = 0xec; data.length < v.dataCodewords; pad ^= 0xec ^ 0x11) data.push(pad);
  const codewords = data.concat(rsRemainder(data, rsDivisor(v.ecCodewords)));

  // 功能图形
  const size = 17 + 4 * v.version;
  const modules: boolean[][] = [];
  const isFunction: boolean[][] = [];
  for (let y = 0; y < size; y++) {
    modules.push(new Array<boolean>(size).fill(false));
    isFunction.push(new Array<boolean>(size).fill(false));
  }
  const set = (x: number, y: number, dark: boolean) => {
    modules[y]![x] = dark;
    isFunction[y]![x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const a = v.align;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < a.length; j++) {
      // 与三个定位图形重叠的不画
      if ((i === 0 && j === 0) || (i === 0 && j === a.length - 1) || (i === a.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) set(a[i]! + dx, a[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  const drawFormat = (mask: number) => {
    const fdata = (EC_LEVEL_M << 3) | mask;
    let rem = fdata;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const fbits = ((fdata << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((fbits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0);

  // 之字形摆放：从右下角起，两列一组上下来回，跳过第 6 列（时序图形）
  let k = 0;
  const total = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y]![x] && k < total) {
          modules[y]![x] = ((codewords[k >>> 3]! >>> (7 - (k & 7))) & 1) !== 0;
          k++;
        }
      }
    }
  }

  const applyMask = (mask: number) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!isFunction[y]![x] && maskHit(mask, x, y)) modules[y]![x] = !modules[y]![x];
      }
    }
  };
  let best = 0;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask);
    drawFormat(mask);
    const p = penalty(modules, size);
    if (p < bestPenalty) {
      best = mask;
      bestPenalty = p;
    }
    applyMask(mask);
  }
  applyMask(best);
  drawFormat(best);
  return { size, modules };
}

const FINDER_LIKE = [
  [true, false, true, true, true, false, true, false, false, false, false],
  [false, false, false, false, true, false, true, true, true, false, true],
];

/** 掩模扣分（N1 连续同色、N2 2×2 同色、N3 像定位图形、N4 深浅比例） */
function penalty(m: boolean[][], size: number): number {
  let p = 0;
  const at = (x: number, y: number, row: boolean) => (row ? m[y]![x]! : m[x]![y]!);
  for (const row of [true, false]) {
    for (let y = 0; y < size; y++) {
      let run = 1;
      for (let x = 1; x <= size; x++) {
        if (x < size && at(x, y, row) === at(x - 1, y, row)) {
          run++;
        } else {
          if (run >= 5) p += 3 + (run - 5);
          run = 1;
        }
      }
      for (let x = 0; x + 11 <= size; x++) {
        for (const pat of FINDER_LIKE) {
          let hit = true;
          for (let i = 0; i < 11 && hit; i++) hit = at(x + i, y, row) === pat[i];
          if (hit) p += 40;
        }
      }
    }
  }
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (m[y]![x]) dark++;
      if (x + 1 < size && y + 1 < size) {
        const c = m[y]![x];
        if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) p += 3;
      }
    }
  }
  const total = size * size;
  p += Math.floor(Math.abs(dark * 100 - total * 50) / (total * 5)) * 10;
  return p;
}

/** SVG 的路径：每个深色格子一个小方块；viewBox 为 0 0 (size+8) (size+8)（四周留 4 格空白，扫码才好认） */
export function qrSvgPath(qr: QrMatrix): string {
  const parts: string[] = [];
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y]![x]) parts.push(`M${x + 4} ${y + 4}h1v1h-1z`);
    }
  }
  return parts.join('');
}
