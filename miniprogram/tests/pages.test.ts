// 页面的完整性（不开微信开发者工具也能查的部分）：app.json 里的页面四个文件齐全、页面上绑的事件在页面代码里有、
// 标签栏图标存在且不超过 40KB、开发者工具的 TypeScript 编译认得的写法（不用 import 里的 type 修饰、不用 flex 的 gap）。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const app = JSON.parse(readFileSync(join(SRC, 'app.json'), 'utf8')) as {
  pages: string[];
  tabBar: { list: { pagePath: string; iconPath: string; selectedIconPath: string }[] };
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f: string) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('页面', () => {
  it('每个页面都有 .ts .wxml .wxss .json', () => {
    for (const page of app.pages) {
      for (const ext of ['ts', 'wxml', 'wxss', 'json']) expect(existsSync(join(SRC, `${page}.${ext}`)), `${page}.${ext}`).toBe(true);
    }
  });

  it('页面上绑的事件，页面代码里都有这个方法', () => {
    for (const page of app.pages) {
      const wxml = readFileSync(join(SRC, `${page}.wxml`), 'utf8');
      const ts = readFileSync(join(SRC, `${page}.ts`), 'utf8');
      const handlers = [...wxml.matchAll(/\b(?:bind|catch)[a-z]+="([A-Za-z_]\w*)"/g)].map((m) => m[1]!);
      for (const h of handlers) expect(new RegExp(`\\b${h}\\s*\\(`).test(ts), `${page}: ${h}`).toBe(true);
    }
  });

  it('标签栏页面在 pages 里，图标存在且不超过 40KB', () => {
    for (const t of app.tabBar.list) {
      expect(app.pages).toContain(t.pagePath);
      for (const icon of [t.iconPath, t.selectedIconPath]) {
        const p = join(SRC, icon);
        expect(existsSync(p), icon).toBe(true);
        expect(statSync(p).size).toBeLessThan(40 * 1024);
      }
    }
  });

  it('页面里用到的本地图片都在、是 PNG、每张不超过 60KB（标志由 scripts/render-logo.mjs 从 assets-src 生成）', () => {
    for (const page of app.pages) {
      const wxml = readFileSync(join(SRC, `${page}.wxml`), 'utf8');
      for (const m of wxml.matchAll(/\bsrc="(\/assets\/[^"{}]+)"/g)) {
        const p = join(SRC, m[1]!);
        expect(existsSync(p), `${page}: ${m[1]}`).toBe(true);
        expect(readFileSync(p).subarray(1, 4).toString('ascii'), m[1]).toBe('PNG');
        expect(statSync(p).size, m[1]).toBeLessThan(60 * 1024);
      }
    }
    // 每个标志的源文件都生成了图片
    const brand = join(SRC, 'assets', 'brand');
    for (const f of readdirSync(join(SRC, '..', 'assets-src', 'brand'))) {
      expect(readdirSync(brand).some((png) => png.startsWith(f.replace(/\.svg$/, '-'))), f).toBe(true);
    }
  });

  it('只用开发者工具认得的写法', () => {
    for (const f of walk(SRC)) {
      const text = readFileSync(f, 'utf8');
      if (f.endsWith('.ts')) {
        // import { a, type B }（TypeScript 4.5 的写法）换成单独的 import type
        expect(/import\s*\{[^}]*\btype\s/.test(text), f).toBe(false);
        // 只引类型可以；运行时不能引小程序目录外的文件
        for (const m of text.matchAll(/^import\s+(?!type\b)[^;]*from\s+'([^']+)'/gm)) expect(m[1]!.includes('../../../src') || m[1]!.includes('../../../../src'), `${f}: ${m[1]}`).toBe(false);
        expect(/\b\d+_\d+\b/.test(text), `${f}：数字分隔符`).toBe(false);
      }
      if (f.endsWith('.wxss')) expect(/(^|[\s;{])gap:/m.test(text), `${f}：flex 的 gap 老 iOS 不认，用 grid-gap 或外边距`).toBe(false);
    }
  });
});
