// 房态四色（8.2.0 P01，回测 3-2）：空闲 绿、在用 蓝、待清 黄、维修 红固定且差异明显；样式表里的变量与 @shared/room-colors 同一组值；
// 别的页面不拿这四色表示别的状态。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOM_COLOR_STATES, ROOM_COLORS } from '../src/shared/room-colors';

const root = resolve(__dirname, '..');
const css = readFileSync(join(root, 'src/client/styles.css'), 'utf8');
const lightBlock = css.slice(css.indexOf('@theme {'), css.indexOf('\n}', css.indexOf('@theme {')));
const darkStart = css.indexOf(":root[data-theme='dark'] {");
const darkBlock = css.slice(darkStart, css.indexOf('\n}', darkStart));
const cssName = (s: string) => s.replace('_', '-');
const token = (block: string, name: string) => new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6});`, 'i').exec(block)?.[1]?.toLowerCase();

function hsl(hex: string): { h: number; l: number } {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, l };
}
const hueGap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

describe('房态四色', () => {
  it('样式表浅色主题的 --color-room-* 与 @shared/room-colors 一致；深色主题四样都有', () => {
    for (const s of ROOM_COLOR_STATES) {
      const n = cssName(s);
      expect(token(lightBlock, `room-${n}`), s).toBe(ROOM_COLORS[s].solid);
      expect(token(lightBlock, `room-${n}-soft`), s).toBe(ROOM_COLORS[s].soft);
      expect(token(lightBlock, `room-${n}-ink`), s).toBe(ROOM_COLORS[s].ink);
      for (const suffix of ['', '-soft', '-ink']) expect(token(darkBlock, `room-${n}${suffix}`), `${s}${suffix}`).toBeTruthy();
    }
  });

  it('四种颜色的色相两两至少差 40 度：空闲绿、在用蓝、待清黄、维修红', () => {
    const hues = ROOM_COLOR_STATES.map((s) => hsl(ROOM_COLORS[s].solid).h);
    for (let i = 0; i < hues.length; i++) for (let j = i + 1; j < hues.length; j++) expect(hueGap(hues[i]!, hues[j]!), `${ROOM_COLOR_STATES[i]} / ${ROOM_COLOR_STATES[j]}`).toBeGreaterThanOrEqual(40);
    expect(hsl(ROOM_COLORS.free.solid).h).toBeGreaterThan(90);
    expect(hsl(ROOM_COLORS.free.solid).h).toBeLessThan(170);
    expect(hsl(ROOM_COLORS.in_use.solid).h).toBeGreaterThan(200);
    expect(hsl(ROOM_COLORS.in_use.solid).h).toBeLessThan(240);
    expect(hsl(ROOM_COLORS.dirty.solid).h).toBeGreaterThan(40);
    expect(hsl(ROOM_COLORS.dirty.solid).h).toBeLessThan(60);
    expect(hueGap(hsl(ROOM_COLORS.maintenance.solid).h, 0)).toBeLessThan(15);
    // 明度也拉开：在用（蓝）与待清（黄）差得最多，空闲与在用也不在一个档
    expect(Math.abs(hsl(ROOM_COLORS.free.solid).l - hsl(ROOM_COLORS.in_use.solid).l)).toBeGreaterThan(0.03);
  });

  it('只有房态的几个文件用 room-* 这四色（别的业务状态不复用）', () => {
    const allowed = new Set(['src/client/styles.css', 'src/client/features/room-center/status.tsx', 'src/client/features/room-center/RoomCard.tsx']);
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(tsx?|css)$/.test(name) && /(?:--color-|(?:bg|text|border|border-l|ring|fill|stroke|from|to|via)-)room-(free|in-use|dirty|maintenance)\b/.test(readFileSync(p, 'utf8')))
          hits.push(relative(root, p));
      }
    };
    walk(join(root, 'src/client'));
    expect(hits.filter((h) => !allowed.has(h))).toEqual([]);
  });
});
