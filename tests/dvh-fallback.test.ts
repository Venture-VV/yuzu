// 老浏览器的屏幕高度（8.1.4，scripts/dvh-fallback.ts）：每条用到 dvh 的规则后面紧跟着补一块只给不认识 dvh 的浏览器用的 vh；
// Vite 用 Lightning CSS 压缩时（目标浏览器都认识 dvh）不会删掉这一块——同一条规则里写两条声明的老办法会被删（店主 2026-11-16 报的侧栏问题）
import { transform } from 'lightningcss';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import { dvhFallback } from '../scripts/dvh-fallback';

const run = async (css: string) => (await postcss([dvhFallback()]).process(css, { from: undefined })).css;
const flat = (css: string) => css.replace(/\s+/g, '');

describe('给不认识 dvh 的浏览器补 vh', () => {
  it('h-dvh、min-h-dvh、calc、min()：紧跟着补一块 @supports not (height: 1dvh)，只带用到 dvh 的声明，单位换成 vh', async () => {
    const out = flat(await run('.h-dvh{height:100dvh}.a{max-height:calc(100dvh - 48px);color:red}.b{height:min(48dvh,350px)}.c{height:100vh}'));
    expect(out).toBe(
      '.h-dvh{height:100dvh}@supportsnot(height:1dvh){.h-dvh{height:100vh}}' +
        '.a{max-height:calc(100dvh-48px);color:red}@supportsnot(height:1dvh){.a{max-height:calc(100vh-48px)}}' +
        '.b{height:min(48dvh,350px)}@supportsnot(height:1dvh){.b{height:min(48vh,350px)}}' +
        '.c{height:100vh}',
    );
  });

  it('在 @layer、@media 里的：补在同一个地方（层叠的先后不变）', async () => {
    const out = flat(await run('@layer utilities{@media (width>=64rem){.lg\\:h-dvh{height:100dvh}}.x{color:red}}'));
    expect(out).toBe('@layerutilities{@media(width>=64rem){.lg\\:h-dvh{height:100dvh}@supportsnot(height:1dvh){.lg\\:h-dvh{height:100vh}}}.x{color:red}}');
  });

  it('自定义属性、动画关键帧不补；跑两遍不重复', async () => {
    const skipped = '.r{--h:100dvh}@keyframes k{from{height:100dvh}to{height:0}}';
    expect(flat(await run(skipped))).toBe(flat(skipped));
    const once = await run('.h-dvh{height:100dvh}');
    expect(flat(await run(once))).toBe(flat(once));
  });

  it('Lightning CSS 按 Vite 的默认目标（Chrome 111、Safari 16.4……）压缩：给老浏览器的那一块还在', async () => {
    const css = await run('.h-dvh{height:100vh;height:100dvh}');
    const targets = { chrome: 111 << 16, edge: 111 << 16, firefox: 114 << 16, safari: (16 << 16) | (4 << 8), ios_saf: (16 << 16) | (4 << 8) };
    const min = transform({ filename: 'x.css', code: Buffer.from(css), minify: true, targets }).code.toString();
    // 同一条规则里的 height:100vh 被当成多余的删掉了（所以不能靠它）；单独的 @supports 那一块留着
    expect(min).toBe('.h-dvh{height:100dvh}@supports not (height:1dvh){.h-dvh{height:100vh}}');
  });
});
