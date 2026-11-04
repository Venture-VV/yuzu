// 迁移清单（v0.7.25）：tests/helpers.ts 的 ALL_MIGRATIONS 是升级用例共用的唯一一份清单。
// 这里核对它与 src/server/migrations 里的文件一致（不缺、不多、没有改名），编号三位、按号排好、没有两个迁移用同一个号——
// 两条开发线各加迁移时撞了号（迁移号要先在 ROADMAP 第 7 节登记），在这里就会失败。不连数据库。

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALL_MIGRATIONS, migrationsFrom } from './helpers';

const dir = fileURLToPath(new URL('../src/server/migrations/', import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

describe('迁移清单', () => {
  it('与迁移目录里的文件一致（不缺、不多、没有改名）', () => {
    expect([...ALL_MIGRATIONS]).toEqual(files);
  });

  it('编号是三位数字、按号排好、没有两个迁移用同一个号', () => {
    const numbers = ALL_MIGRATIONS.map((f) => /^([0-9]{3})_[a-z0-9_]+\.sql$/.exec(f)?.[1] ?? null);
    expect(numbers).not.toContain(null);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect([...numbers].sort()).toEqual(numbers);
  });

  it('migrationsFrom：从给定的迁移（含）到最后一个；清单里没有的直接报错', () => {
    expect(migrationsFrom(ALL_MIGRATIONS.at(-1)!)).toEqual([ALL_MIGRATIONS.at(-1)]);
    expect(migrationsFrom('001_init.sql')).toEqual([...ALL_MIGRATIONS]);
    expect(() => migrationsFrom('999_nothing.sql')).toThrow('迁移清单里没有');
  });
});
