// 页面上生成操作编号的写法（8.0.15，docs/ORDERS_V8015.md 第 1 节，GJ12）：
// crypto.randomUUID 只在安全上下文（HTTPS / localhost）里有，门店内网用 http://IP 打开时不存在——8.0.12 的管家部直接用了它，
// 内网点「新增会员」没反应。页面代码一律用 lib/utils 的 uuid()（crypto.getRandomValues 拼 v4，HTTP 下也有）。
// 这里静态扫一遍页面代码，再出现直接调用就不过；并核对 uuid() 在没有 randomUUID 的环境里照样能用。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { uuid } from '../src/client/lib/utils';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' || name === 'public' ? [] : sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** 去掉注释（说明里可以提到这个接口） */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('页面上生成操作编号', () => {
  it('页面与前后端共用的代码里不直接调用 crypto.randomUUID（内网 HTTP 下没有）', () => {
    // src/client：门店系统与管家部；src/canteen：员工手机端；src/shared：两边共用
    const dirs = ['src/client', 'src/canteen', 'src/shared'].map((d) => join(ROOT, d)).filter((d) => {
      try {
        return statSync(d).isDirectory();
      } catch {
        return false;
      }
    });
    expect(dirs.length).toBeGreaterThanOrEqual(2);
    const files = dirs.flatMap(sources);
    expect(files.length).toBeGreaterThan(100);
    const hits = files.filter((f) => /\brandomUUID\b/.test(code(readFileSync(f, 'utf8')))).map((f) => relative(ROOT, f));
    expect(hits, `这些文件直接用了 crypto.randomUUID，请改用 lib/utils 的 uuid()：${hits.join('、')}`).toEqual([]);
  });

  it('uuid() 不依赖 crypto.randomUUID：把它拿掉照样生成 v4 格式、不重复的编号', () => {
    const c = globalThis.crypto as Crypto & { randomUUID?: unknown };
    const original = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(c), 'randomUUID') ?? Object.getOwnPropertyDescriptor(c, 'randomUUID');
    const owner = Object.getOwnPropertyDescriptor(c, 'randomUUID') ? c : Object.getPrototypeOf(c);
    Object.defineProperty(owner, 'randomUUID', { value: undefined, configurable: true, writable: true });
    try {
      expect((globalThis.crypto as { randomUUID?: unknown }).randomUUID).toBeUndefined();
      const ids = Array.from({ length: 200 }, () => uuid());
      for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      if (original) Object.defineProperty(owner, 'randomUUID', original);
    }
  });
});
