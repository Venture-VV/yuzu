// 8.1.19（品牌部《工作台需求汇总 1.3》，店主 2026-11-20「所有的英文字体都要替换为数据包提供的示例字体」，PENDING_DECISIONS.md PD1、PD5）：
// 电子菜单里的英文一律先用授权的品牌英文字体 ABC Arizona Flare（Tangqi Brand En；中文字体串里是只含拉丁字母的 Tangqi Brand Latin）。
// 核对样式表里的三串字体与工作台主题的每个字体选项：行框字体之后紧跟着品牌字体。

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EMENU_SURFACE } from '../src/shared/studio/surfaces';

const css = readFileSync(new URL('../src/client/features/emenu/emenu.css', import.meta.url), 'utf8');
const stackOf = (name: string) => {
  const m = new RegExp(`${name}:\\s*([^;]+);`).exec(css);
  if (!m) throw new Error(`样式表里没有 ${name}`);
  return m[1]!.split(',').map((f) => f.trim().replace(/^'|'$/g, ''));
};
const split = (stack: string) => stack.split(',').map((f) => f.trim().replace(/^'|'$/g, ''));

describe('电子菜单的英文都先用品牌字体（8.1.19）', () => {
  it('样式表：英文、衬线展示体、中文三串字体，行框之后就是品牌字体', () => {
    expect(stackOf('--em-en').slice(0, 2)).toEqual(['Em Box En', 'Tangqi Brand En']);
    expect(stackOf('--em-en-display').slice(0, 3)).toEqual(['Em Box En', 'Tangqi Brand En', 'Playfair Display']);
    expect(stackOf('--em-zh').slice(0, 3)).toEqual(['Em Box Zh', 'Tangqi Brand Latin', 'Zhuque Fangsong']);
  });

  it('工作台主题：每个英文字体选项都先用品牌字体；每个中文选项里的字母也是', () => {
    for (const f of EMENU_SURFACE.fonts.en) expect(split(f.stack).slice(0, 2), f.key).toEqual(['Em Box En', 'Tangqi Brand En']);
    for (const f of EMENU_SURFACE.fonts.zh) expect(split(f.stack).slice(0, 2), f.key).toEqual(['Em Box Zh', 'Tangqi Brand Latin']);
  });
});
