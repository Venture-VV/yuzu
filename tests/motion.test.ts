// 动效套件（8.0.16，docs/UI_V8016.md）里纯的部分与几条静态的规矩。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dwellMs, GHOST_MS } from '../src/client/lib/motion';

const ROOT = join(__dirname, '..', 'src', 'client');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(tsx?|css)$/.test(name) ? [path] : [];
  });
const css = readFileSync(join(ROOT, 'styles.css'), 'utf8');

describe('提示条停留多久（UI7）', () => {
  it('至少 3.6 秒，10 个字以上每多 10 个字加 0.6 秒，最长 10 秒；出错的至少 6 秒', () => {
    expect(dwellMs('已保存')).toBe(3600);
    expect(dwellMs('十个字十个字十个字十')).toBe(3600);
    expect(dwellMs('十个字十个字十个字十一')).toBe(4200);
    expect(dwellMs('字'.repeat(30))).toBe(4800);
    expect(dwellMs('字'.repeat(500))).toBe(10_000);
    expect(dwellMs('不行', 'error')).toBe(6000);
    expect(dwellMs('字'.repeat(60), 'error')).toBe(6600);
    expect(dwellMs('字'.repeat(500), 'error')).toBe(10_000);
    // 表情、生僻字按一个字算
    expect(dwellMs('👍'.repeat(10))).toBe(3600);
  });
});

describe('动效的规矩（静态检查）', () => {
  it('时间与曲线的变量都在；没有匀速的进退场', () => {
    for (const name of ['--ease-out-soft', '--ease-out-expo', '--ease-in-quick', '--ease-spring', '--dur-micro', '--dur-fast', '--dur-base', '--dur-slow']) {
      expect(css, name).toContain(`${name}:`);
    }
    // 套件自己的动画（--animate-* 与 mo- 开头的）不用 linear
    const ours = css.split('\n').filter((l) => /--animate-(dialog|sheet|toast|menu|page|notice|tick)|animation: mo-/.test(l));
    expect(ours.length).toBeGreaterThan(8);
    expect(ours.filter((l) => /\blinear\b/.test(l))).toEqual([]);
  });

  it('退场比进场快：影子的退场都不超过 220 毫秒，影子留的时间比最慢的退场长', () => {
    const outs = [...css.matchAll(/animation: mo-(fade|dialog|sheet|toast|menu)-out ([^;]+);/g)].map((m) => m[2]!);
    expect(outs).toHaveLength(5);
    const ms = (v: string) => {
      const token = v.trim().split(/\s+/)[0]!;
      if (token.endsWith('ms')) return Number.parseFloat(token);
      const name = /var\((--dur-[a-z]+)\)/.exec(token)?.[1];
      return Number.parseFloat(new RegExp(`${name}:\\s*(\\d+)ms`).exec(css)![1]!);
    };
    for (const o of outs) {
      expect(ms(o), o).toBeLessThanOrEqual(220);
      expect(o, o).toContain('var(--ease-in-quick)');
    }
    expect(GHOST_MS).toBeGreaterThan(Math.max(...outs.map(ms)));
    // 进场：弹窗、提示条 260，抽屉 380
    expect(Number.parseFloat(/--dur-base:\s*(\d+)ms/.exec(css)![1]!)).toBeGreaterThan(Number.parseFloat(/--dur-fast:\s*(\d+)ms/.exec(css)![1]!));
  });

  it('页面上写的每一种退场（data-mo-out）在样式表里都有；用了影子的组件都标了怎么退', () => {
    const kinds = new Set<string>();
    const users: string[] = [];
    for (const f of files(ROOT)) {
      if (f.endsWith('.css') || f.includes(`${join('features', 'emenu')}`)) continue;
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/data-mo-out="([a-z]+)"/g)) kinds.add(m[1]!);
      if (/useExitGhost</.test(text) && !f.endsWith(join('lib', 'motion.tsx'))) users.push(f);
    }
    expect([...kinds].sort()).toEqual(['dialog', 'fade', 'menu', 'sheet', 'toast']);
    for (const k of kinds) expect(css, k).toContain(`.mo-ghost [data-mo-out='${k}']`);
    expect(users.length).toBeGreaterThanOrEqual(3);
    for (const f of users) expect(readFileSync(f, 'utf8'), f).toMatch(/data-mo-out="/);
  });

  it('系统「减少动态效果」时全部关掉；影子不能点', () => {
    const reduce = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduce).toContain('animation-duration: 0.01ms !important');
    expect(reduce).toContain('transition-duration: 0.01ms !important');
    expect(css).toMatch(/\.mo-ghost,\s*\.mo-ghost \*\s*\{[^}]*pointer-events: none !important/);
    // 影子在系统要求减少动态效果时根本不留
    expect(readFileSync(join(ROOT, 'lib', 'motion.tsx'), 'utf8')).toMatch(/!node\.isConnected \|\| prefersReducedMotion\(\)/);
  });

  it('不引入动画库（UI4）', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const all = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(all.filter((n) => /^(framer-motion|motion|gsap|animejs|@react-spring\/|react-transition-group|lottie)/.test(n))).toEqual([]);
  });
});
