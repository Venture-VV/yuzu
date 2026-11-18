// 版本号只写在 package.json 一处（工程治理一期，docs/GOVERNANCE.md）：镜像、Compose、应用配置都不再各写一遍。
// 发版只改 package.json 与 package-lock.json（npm version <新版本号> --no-git-tag-version）。不要数据库。
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/server/config';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json')) as { version: string };
const literal = new RegExp(`(?<![\\d.])${pkg.version.replace(/\./g, '\\.')}(?![\\d.])`);

describe('版本号只写在 package.json 一处', () => {
  const saved = process.env.APP_VERSION;
  afterEach(() => {
    if (saved === undefined) delete process.env.APP_VERSION;
    else process.env.APP_VERSION = saved;
  });
  const load = () => loadConfig({ databaseUrl: 'postgres://nobody@127.0.0.1:1/none', env: 'test', logLevel: 'silent' });

  it('版本号是 X.Y.Z；锁文件里的两处与 package.json 一致', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    const lock = JSON.parse(read('package-lock.json')) as { version: string; packages: Record<string, { version?: string }> };
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages['']?.version).toBe(pkg.version);
  });

  it('没传 APP_VERSION（或传了空的）时，页面显示的就是 package.json 的版本号', () => {
    delete process.env.APP_VERSION;
    expect(load().version).toBe(pkg.version);
    process.env.APP_VERSION = '';
    expect(load().version).toBe(pkg.version);
  });

  it('update.sh 传进来的版本照旧优先，开头的 v 去掉', () => {
    process.env.APP_VERSION = 'v9.9.9-3-g1234567';
    expect(load().version).toBe('9.9.9-3-g1234567');
  });

  it('Dockerfile、compose.yaml、应用配置里不再写版本号', () => {
    expect(read('Dockerfile')).toMatch(/^ARG APP_VERSION=$/m);
    expect(read('compose.yaml')).toContain('APP_VERSION: ${YUZU_VERSION:-}');
    for (const file of ['Dockerfile', 'compose.yaml', 'compose.canteen.yaml', 'compose.mp.yaml', 'compose.dev.yaml', 'src/server/config.ts', '.env.example']) {
      expect(literal.test(read(file)), `${file} 里写着当前的版本号 ${pkg.version}`).toBe(false);
    }
  });
});
