// 深浅两套主题的文字对比度（8.1.15，《浴族系统需求汇总》系统整体：文字对比度不低于 4.5 : 1）。
// 从样式表里读两套变量，逐对核对「字 / 底」。改颜色先跑这一份；新加一种写字的颜色，把它常见的底加进 TEXT_PAIRS。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../src/client/styles.css'), 'utf8');

/** 一段 { … } 里的颜色变量：{ paper: '#f6f3ec', … } */
function tokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)) out[m[1]!] = m[2]!.toLowerCase();
  return out;
}

function blockAfter(marker: string): string {
  const start = css.indexOf(marker);
  if (start < 0) throw new Error(`样式表里找不到 ${marker}`);
  return css.slice(start, css.indexOf('\n}', start));
}

const light = tokens(blockAfter('@theme {'));
// 深色只写了要换的变量，没写的沿用浅色的
const dark = { ...light, ...tokens(blockAfter(":root[data-theme='dark'] {")) };

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** 写字的颜色 → 它常见的底色 */
const TEXT_PAIRS: [string, string[]][] = [
  ['ink', ['paper', 'paper-2', 'paper-3', 'card']],
  ['ink-2', ['paper', 'paper-2', 'paper-3', 'card']],
  ['ink-3', ['paper', 'paper-2', 'paper-3', 'card']],
  ['pine', ['paper', 'card', 'pine-soft', 'pine-tint']],
  ['moss', ['paper', 'card', 'moss-soft']],
  ['yuzu-deep', ['paper', 'card', 'yuzu-soft', 'yuzu-tint']],
  ['ember-deep', ['paper', 'card', 'ember-soft']],
  ['clay', ['paper', 'card', 'clay-soft']],
  ['lake', ['paper', 'card', 'lake-soft']],
  // 房态四色（8.2.0 P01）：状态字写在卡片底色与白卡片上
  ['room-free-ink', ['card', 'room-free-soft']],
  ['room-in-use-ink', ['card', 'room-in-use-soft']],
  ['room-dirty-ink', ['card', 'room-dirty-soft']],
  ['room-maintenance-ink', ['card', 'room-maintenance-soft']],
  // 色块上的字：主按钮、危险按钮、深色标签
  ['paper', ['pine', 'pine-hover', 'clay', 'clay-hover', 'lake', 'ink']],
  // 亮色块（柚黄、橙）上的字
  ['on-bright', ['yuzu', 'yuzu-hover', 'ember']],
  // 主导航
  ['rail-ink', ['rail']],
];

describe.each([
  ['浅色', light],
  ['深色', dark],
])('%s主题的对比度', (_name, theme) => {
  it.each(TEXT_PAIRS)('%s 写在它常见的底上不低于 4.5 : 1', (text, grounds) => {
    for (const ground of grounds) {
      const ratio = contrast(theme[text]!, theme[ground]!);
      expect(ratio, `${text}（${theme[text]}）/ ${ground}（${theme[ground]}）= ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('ink-4 只给占位字、停用的控件与装饰线：不低于 3 : 1', () => {
    for (const ground of ['paper', 'card']) {
      const ratio = contrast(theme['ink-4']!, theme[ground]!);
      expect(ratio, `ink-4 / ${ground} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('两套主题的变量', () => {
  it('深色把纸色、墨色、主色都换了；没有写漏成浅色的', () => {
    for (const name of [
      'paper',
      'paper-2',
      'paper-3',
      'card',
      'line',
      'line-strong',
      'ink',
      'ink-2',
      'ink-3',
      'ink-4',
      'pine',
      'pine-soft',
      'pine-tint',
      'clay',
      'clay-soft',
      'lake',
      'lake-soft',
      'yuzu-soft',
      'yuzu-tint',
      'ember-soft',
      'moss-soft',
    ]) {
      expect(dark[name], name).not.toBe(light[name]);
    }
  });

  it('深色的纸比墨暗，浅色的纸比墨亮', () => {
    expect(luminance(light.paper!)).toBeGreaterThan(luminance(light.ink!));
    expect(luminance(dark.paper!)).toBeLessThan(luminance(dark.ink!));
  });
});
