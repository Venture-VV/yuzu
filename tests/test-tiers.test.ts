// 测试分档（工程治理三期，scripts/test-tiers.mjs）：不要数据库的用例认得准、沾边的用例找得到。不要数据库。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_ONLY_ENV, clearAppOnlyEnv } from './app-only-env';
// @ts-expect-error 脚本是 .mjs，没有类型声明
import * as tiers from '../scripts/test-tiers.mjs';

const { keywordsOf, matchesKeyword, needsDatabase, resolveImport, runtimeImports } = tiers as {
  keywordsOf: (changedFile: string) => string[];
  matchesKeyword: (testFile: string, keyword: string) => boolean;
  needsDatabase: (testFile: string, read: (path: string) => string | null, exists: (path: string) => boolean) => boolean;
  resolveImport: (fromFile: string, specifier: string, exists: (path: string) => boolean) => string | null;
  runtimeImports: (fileName: string, code: string) => string[];
};

const FILES: Record<string, string> = {
  'tests/helpers.ts': "import { createSql } from '../src/server/db';",
  'src/server/db.ts': "import postgres from 'postgres';",
  'src/server/config.ts': "import type { Sql } from './db';\nimport { loadProtect } from './lib/protect';",
  'src/server/lib/protect.ts': "import { type Sql, type Tx } from '../db';\nexport const loadProtect = () => 1;",
  'src/server/modules/wallet.ts': "import { createSql } from '../db';",
  'src/shared/money.ts': 'export const a = 1;',
  'tests/pure.test.ts': "import { a } from '@shared/money';\nimport { loadConfig } from '../src/server/config';",
  'tests/with-helpers.test.ts': "import { setup } from './helpers';",
  'tests/deep.test.ts': "import { x } from '../src/server/modules/wallet';",
  'tests/dynamic.test.ts': "const m = await import('../src/server/modules/wallet');",
  'tests/direct.test.ts': "import postgres from 'postgres';",
};
const read = (path: string) => FILES[path] ?? null;
const exists = (path: string) => path in FILES;

describe('不要数据库的用例', () => {
  it('只引类型的不算运行时导入；动态 import() 算', () => {
    const code = [
      "import type { A } from './a';",
      "import { type B, type C } from './b';",
      "import { d, type E } from './d';",
      "import f from './f';",
      "export { g } from './g';",
      "export type { H } from './h';",
      "const i = await import('./i');",
    ].join('\n');
    expect(runtimeImports('x.ts', code)).toEqual(['./d', './f', './g', './i']);
  });

  it('相对路径与 @shared 别名指到仓库里的文件；第三方包不管', () => {
    expect(resolveImport('tests/a.test.ts', '../src/server/db', exists)).toBe('src/server/db.ts');
    expect(resolveImport('tests/a.test.ts', '@shared/money', exists)).toBe('src/shared/money.ts');
    expect(resolveImport('tests/a.test.ts', 'vitest', exists)).toBeNull();
  });

  it('顺着导入关系找：引了用例的公共准备、数据库连接（直接、隔几层、动态）或 postgres 包的算要数据库', () => {
    expect(needsDatabase('tests/pure.test.ts', read, exists)).toBe(false); // 配置只引了数据库的类型
    expect(needsDatabase('tests/with-helpers.test.ts', read, exists)).toBe(true);
    expect(needsDatabase('tests/deep.test.ts', read, exists)).toBe(true);
    expect(needsDatabase('tests/dynamic.test.ts', read, exists)).toBe(true);
    expect(needsDatabase('tests/direct.test.ts', read, exists)).toBe(true);
  });
});

describe('快测：按改到的模块找沾边的用例', () => {
  it('改到的文件 → 模块名', () => {
    expect(keywordsOf('src/server/modules/coupons.ts')).toEqual(['coupons']);
    expect(keywordsOf('src/server/modules/inventory/docs.ts')).toEqual(['inventory']);
    expect(keywordsOf('src/client/features/frontdesk/CheckoutDialog.tsx')).toEqual(['frontdesk']);
    expect(keywordsOf('src/shared/membership.ts')).toEqual(['membership']);
    expect(keywordsOf('src/server/lib/idempotency.ts')).toEqual(['idempotency']);
    expect(keywordsOf('tests/wallet-limits.test.ts')).toEqual(['wallet-limits']);
    expect(keywordsOf('docs/TESTING.md')).toEqual([]);
  });

  it('模块名或它的单数出现在用例文件名里就算沾边；太短的词不算', () => {
    expect(matchesKeyword('tests/coupon-campaigns.test.ts', 'coupons')).toBe(true);
    expect(matchesKeyword('tests/wallet-limits.test.ts', 'wallet')).toBe(true);
    expect(matchesKeyword('tests/inventory-seed.test.ts', 'inventory')).toBe(true);
    expect(matchesKeyword('tests/frontdesk.test.ts', 'coupons')).toBe(false);
    expect(matchesKeyword('tests/ai-mask.test.ts', 'ai')).toBe(false);
  });
});

// Codex 审查 ca1f116：秒级一档的配置原来漏了这一步，终端里带着 INTEGRATIONS_MOCK=true 时同一条用例在两档里结果不一样
describe('只给应用用的环境变量不带进用例（两档共用）', () => {
  it('清掉清单里的，别的不动', () => {
    const env: Record<string, string | undefined> = { INTEGRATIONS_MOCK: 'true', ACCESS_ALLOW_CIDRS: '10.0.0.0/8', YUZU_AI_MODEL: 'x', TEST_DATABASE_URL: 'postgres://keep', PATH: '/bin' };
    clearAppOnlyEnv(env);
    expect(env).toEqual({ TEST_DATABASE_URL: 'postgres://keep', PATH: '/bin' });
    expect(APP_ONLY_ENV).toContain('RATE_LIMIT_IP_PER_MIN');
  });

  it('全量与秒级两份配置都在加载时清一遍', () => {
    for (const file of ['vitest.config.ts', 'vitest.unit.config.ts']) {
      const code = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      expect(code, file).toContain("import { clearAppOnlyEnv } from './tests/app-only-env';");
      expect(code, file).toMatch(/^clearAppOnlyEnv\(\);$/m);
    }
  });
});

describe('单条用例的时限', () => {
  it('普通用例还是 30 秒（升级用例另放宽，见 tests/upgrade-timeout.test.ts）', ({ task }) => {
    expect(task.timeout).toBe(30_000);
  });
});
