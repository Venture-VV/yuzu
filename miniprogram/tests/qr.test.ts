// 会员码的二维码：自己写的编码器，用独立的解码器（jsQR）读回来核对
import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';
import { drawQr, encodeDigits, type QrMatrix } from '../src/utils/qr';

/** 画成 RGBA 位图（四周留 4 格空白，每格 4 像素），交给解码器 */
function decode(qr: QrMatrix): string | null {
  const scale = 4;
  const n = (qr.size + 8) * scale;
  const data = new Uint8ClampedArray(n * n * 4).fill(255);
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.modules[y]![x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = ((y + 4) * scale + dy) * n * 4 + ((x + 4) * scale + dx) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  const r = jsQR(data, n, n, { inversionAttempts: 'dontInvert' });
  return r ? r.data : null;
}

const digits = (len: number, seed: number) => {
  let s = '';
  let x = seed;
  for (let i = 0; i < len; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    s += String(x % 10);
  }
  return s;
};

describe('会员码二维码', () => {
  it('会员码（16 位、19 位）都能读回来，用版本 1（21×21）', () => {
    for (let seed = 1; seed <= 60; seed++) {
      for (const code of ['8' + digits(15, seed), '9' + digits(18, seed)]) {
        const qr = encodeDigits(code);
        expect(qr.size).toBe(21);
        expect(decode(qr), code).toBe(code);
      }
    }
  });

  it('各种长度：1–34 位版本 1，35–63 位版本 2，64–101 位版本 3', () => {
    for (const len of [1, 2, 3, 4, 33, 34, 35, 50, 63, 64, 80, 101]) {
      const code = digits(len, len * 7 + 3);
      const qr = encodeDigits(code);
      expect(qr.size).toBe(len <= 34 ? 21 : len <= 63 ? 25 : 29);
      expect(decode(qr), `${len} 位`).toBe(code);
    }
  });

  it('前导 0 不丢', () => {
    expect(decode(encodeDigits('0000000000000001'))).toBe('0000000000000001');
    expect(decode(encodeDigits('0'))).toBe('0');
  });

  it('只编码数字；太长报错', () => {
    expect(() => encodeDigits('12a4')).toThrow();
    expect(() => encodeDigits('')).toThrow();
    expect(() => encodeDigits(digits(102, 1))).toThrow();
  });

  it('画到画布上：先铺白底，再画深色格子，四周留空白', () => {
    const calls: { style: unknown; rect: number[] }[] = [];
    const ctx = {
      fillStyle: '' as unknown,
      fillRect(x: number, y: number, w: number, h: number) {
        calls.push({ style: this.fillStyle, rect: [x, y, w, h] });
      },
    };
    const qr = encodeDigits('8000123456789012');
    drawQr(ctx, qr, 290);
    expect(calls[0]).toEqual({ style: '#FFFFFF', rect: [0, 0, 290, 290] });
    const dark = calls.slice(1);
    expect(dark.length).toBe(qr.modules.flat().filter(Boolean).length);
    const cell = 290 / (21 + 8);
    expect(Math.min(...dark.map((c) => c.rect[0]!))).toBeCloseTo(4 * cell);
  });
});
