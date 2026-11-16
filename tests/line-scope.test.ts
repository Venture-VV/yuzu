// 线范围检查（8.1.0，docs/RELEASE_V810.md 第 3 节）：小程序线（Gemini）的 PR 只改小程序线自己的文件。
// 规则在 scripts/check-line-scope.mjs，由 .github/workflows/line-scope.yml 在 pull_request_target 上跑。不连数据库。

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error 检查脚本是 .mjs，没有类型声明
import { checkLineScope, classify, isMpLinePr, parseNameStatus, report } from '../scripts/check-line-scope.mjs';

type Kind = { kind: string; reason?: string; note?: string };
const kindOf = (status: string, path: string, from?: string) => (classify({ status, path, from }) as Kind).kind;

describe('线范围检查 · 哪些 PR 算小程序线', () => {
  it('分支 gemini/…、标题【小程序线】开头、带「小程序线」标签，有一样就算', () => {
    expect(isMpLinePr({ branch: 'gemini/mp-coupons', title: '修领券', labels: [] })).toBe(true);
    expect(isMpLinePr({ branch: 'feature/x', title: '【小程序线】领券页改版', labels: [] })).toBe(true);
    expect(isMpLinePr({ branch: 'feature/x', title: '领券页', labels: ['小程序线'] })).toBe(true);
    expect(isMpLinePr({ branch: 'claude/epic-edison-qhc43r', title: '【主线】8.1.0', labels: ['主线'] })).toBe(false);
    expect(isMpLinePr({})).toBe(false);
  });
});

describe('线范围检查 · 每个文件归哪一类', () => {
  it('小程序线自己的目录、文件、用例与文档：随便改', () => {
    for (const p of [
      'miniprogram/src/pages/home/index.ts',
      'src/gateway/server.ts',
      'src/server/modules/mp/coupons.ts',
      'src/client/features/mp/MpSection.tsx',
      'src/shared/mp.ts',
      'compose.mp.yaml',
      'tests/mp-food.test.ts',
      'tests/gateway.test.ts',
      'e2e/mp-admin.spec.ts',
      'docs/MINIPROGRAM.md',
      'docs/MP_COUPONS.md',
      'docs/HANDOFF_MP4.md',
      'docs/DEPLOY_GATEWAY.md',
    ])
      expect(kindOf('M', p), p).toBe('free');
    expect(kindOf('D', 'miniprogram/src/pages/old/index.ts')).toBe('free');
    expect(kindOf('R', 'miniprogram/src/pages/b.ts', 'miniprogram/src/pages/a.ts')).toBe('free');
  });

  it('名字像小程序线、其实是主线给小程序线的入口的用例：不许改', () => {
    expect(kindOf('M', 'tests/mp-entries.test.ts')).toBe('blocked');
    expect(kindOf('M', 'tests/mp-claim-coupon.test.ts')).toBe('blocked');
    expect(kindOf('M', 'src/server/modules/mp-entries.ts')).toBe('blocked');
  });

  it('登记处：允许改，列出来复核；但不能删', () => {
    for (const p of [
      'src/server/app.ts',
      'src/shared/permissions.ts',
      'src/client/App.tsx',
      'src/server/lib/audit.ts',
      'src/shared/admin.ts',
      'src/server/config.ts',
      'src/shared/types.ts',
      'tests/helpers.ts',
      '.env.example',
      'docs/ROADMAP.md',
      'docs/PENDING_DECISIONS.md',
      'docs/DEPLOY_MAC_MINI.md',
      'docs/DEPLOY_TEST_SERVER.md',
      'GEMINI.md',
      '.gemini/settings.json',
    ])
      expect(kindOf('M', p), p).toBe('registry');
    expect(kindOf('D', 'src/server/app.ts')).toBe('blocked');
    expect(kindOf('R', 'src/server/app2.ts', 'src/server/app.ts')).toBe('blocked');
  });

  it('迁移：只能新加 NNN_mp_<用途>.sql；已有的改、删、改名都不行', () => {
    expect(kindOf('A', 'src/server/migrations/170_mp_feedback.sql')).toBe('migration');
    expect(kindOf('A', 'src/server/migrations/170_feedback.sql')).toBe('blocked');
    expect(kindOf('M', 'src/server/migrations/063_mp_bookings.sql')).toBe('blocked');
    expect(kindOf('D', 'src/server/migrations/063_mp_bookings.sql')).toBe('blocked');
    expect(kindOf('R', 'src/server/migrations/170_mp_x.sql', 'src/server/migrations/063_mp_bookings.sql')).toBe('blocked');
  });

  it('核心与其余文件：不许改；改名进出小程序线目录也不行', () => {
    for (const p of [
      'src/server/modules/wallet.ts',
      'src/server/modules/frontdesk/checkout.ts',
      'src/server/modules/coupons.ts',
      'package.json',
      'package-lock.json',
      'AGENTS.md',
      '.github/workflows/ci.yml',
      '.github/workflows/line-scope.yml',
      'scripts/check-line-scope.mjs',
      'tests/wallet-limits.test.ts',
      'e2e/frontdesk.spec.ts',
    ])
      expect(kindOf('M', p), p).toBe('blocked');
    expect(kindOf('R', 'miniprogram/src/wallet.ts', 'src/server/modules/wallet.ts')).toBe('blocked');
    expect(kindOf('R', 'src/server/modules/wallet2.ts', 'miniprogram/src/wallet.ts')).toBe('blocked');
  });
});

describe('线范围检查 · 汇总与结果', () => {
  const diff = [
    'M\tminiprogram/src/app.ts',
    'A\tsrc/server/migrations/170_mp_feedback.sql',
    'M\tsrc/server/app.ts',
    'R100\tsrc/gateway/a.ts\tsrc/gateway/b.ts',
    'C80\tsrc/gateway/b.ts\tsrc/gateway/c.ts',
  ].join('\n');

  it('解析 git diff --name-status：改名、复制两头都认出来', () => {
    expect(parseNameStatus(`${diff}\n`)).toEqual([
      { status: 'M', path: 'miniprogram/src/app.ts' },
      { status: 'A', path: 'src/server/migrations/170_mp_feedback.sql' },
      { status: 'M', path: 'src/server/app.ts' },
      { status: 'R', from: 'src/gateway/a.ts', path: 'src/gateway/b.ts' },
      { status: 'C', from: 'src/gateway/b.ts', path: 'src/gateway/c.ts' },
    ]);
  });

  it('都在范围里：通过，迁移与登记处单独列出来', () => {
    const r = checkLineScope(parseNameStatus(diff)) as { ok: boolean; free: string[]; registry: { path: string }[]; migrations: string[]; blocked: unknown[] };
    expect(r.ok).toBe(true);
    expect(r.free).toEqual(['miniprogram/src/app.ts', 'src/gateway/a.ts → src/gateway/b.ts', 'src/gateway/c.ts']);
    expect(r.registry.map((g) => g.path)).toEqual(['src/server/app.ts']);
    expect(r.migrations).toEqual(['src/server/migrations/170_mp_feedback.sql']);
    expect(r.blocked).toEqual([]);
  });

  it('小程序线的 PR 改了核心：不通过，写明哪个文件、为什么、该怎么办', () => {
    const { ok, text } = report({ branch: 'gemini/mp-x', title: '【小程序线】x', labels: [] }, parseNameStatus(`${diff}\nM\tsrc/server/modules/wallet.ts`)) as { ok: boolean; text: string };
    expect(ok).toBe(false);
    expect(text).toContain('**不通过**');
    expect(text).toContain('`src/server/modules/wallet.ts`（M）');
    expect(text).toContain('在主线开着的 PR 上留言');
    expect(text).toContain('src/server/migrations/170_mp_feedback.sql');
  });

  it('主线的 PR：这个检查不管、通过；改到小程序线目录的只提醒', () => {
    const quiet = report({ branch: 'claude/epic-edison-qhc43r', title: '【主线】8.1.0', labels: ['主线'] }, parseNameStatus('M\tsrc/server/modules/wallet.ts')) as { ok: boolean; text: string };
    expect(quiet.ok).toBe(true);
    expect(quiet.text).toContain('不是小程序线的 PR');
    expect(quiet.text).not.toContain('提醒');
    const touched = report({ branch: 'claude/x', title: '【主线】x', labels: [] }, parseNameStatus('M\tsrc/server/modules/mp/coupons.ts')) as { ok: boolean; text: string };
    expect(touched.ok).toBe(true);
    expect(touched.text).toContain('提醒');
    expect(touched.text).toContain('src/server/modules/mp/coupons.ts');
  });
});

describe('线范围检查 · 命令行（在临时 git 仓库里走一遍）', () => {
  const script = fileURLToPath(new URL('../scripts/check-line-scope.mjs', import.meta.url));
  const repo = mkdtempSync(join(tmpdir(), 'yuzu-line-scope-'));
  afterAll(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' }).trim();
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  const run = (head: string, env: Record<string, string>) => {
    const r = spawnSync('node', [script, '--base', 'main', '--head', head], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_STEP_SUMMARY: '', PR_BRANCH: '', PR_TITLE: '', PR_LABELS: '', ...env },
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  git('init', '-q', '-b', 'main');
  put('miniprogram/src/app.ts', 'a\n');
  put('src/server/modules/wallet.ts', 'w\n');
  put('src/server/app.ts', 'app\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'gemini/ok');
  put('miniprogram/src/app.ts', 'b\n');
  put('src/server/app.ts', 'app\nmp\n');
  put('src/server/migrations/170_mp_feedback.sql', 'select 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'ok');
  git('checkout', '-q', '-b', 'gemini/bad');
  put('src/server/modules/wallet.ts', 'w2\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'bad');
  // 目标分支在 PR 之后又往前走了：三个点按分叉点算，main 上新改的不算到 PR 头上
  git('checkout', '-q', 'main');
  put('src/server/modules/frontdesk.ts', 'f\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'main moves on');

  it('只改了小程序线的文件与登记处：退出码 0，列出迁移与登记处', () => {
    const r = run('gemini/ok', { PR_BRANCH: 'gemini/ok' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('**通过**');
    expect(r.out).toContain('170_mp_feedback.sql');
    expect(r.out).toContain('src/server/app.ts');
    expect(r.out).not.toContain('frontdesk.ts');
  });

  it('改了核心：退出码 1；标签认出来的也一样', () => {
    expect(run('gemini/bad', { PR_BRANCH: 'gemini/bad' }).code).toBe(1);
    const viaLabel = run('gemini/bad', { PR_BRANCH: 'feature/x', PR_LABELS: '小程序线,其他' });
    expect(viaLabel.code).toBe(1);
    expect(viaLabel.out).toContain('src/server/modules/wallet.ts');
  });

  it('不是小程序线的 PR：退出码 0；参数不全：退出码 2', () => {
    expect(run('gemini/bad', { PR_BRANCH: 'claude/x', PR_TITLE: '【主线】x' }).code).toBe(0);
    const r = spawnSync('node', [script], { cwd: repo, encoding: 'utf8' });
    expect(r.status).toBe(2);
  });
});

describe('线范围检查 · 工作流本身', () => {
  const wf = readFileSync(fileURLToPath(new URL('../.github/workflows/line-scope.yml', import.meta.url)), 'utf8');
  it('pull_request_target、只读令牌；不检出 PR 的代码，标题等不拼进命令行', () => {
    expect(wf).toMatch(/^on:\n {2}pull_request_target:/m);
    expect(wf).toMatch(/^permissions:\n {2}contents: read$/m);
    // 不检出 PR 的提交（检出的是目标分支），也不执行 PR 里的脚本
    expect(wf).not.toMatch(/ref:\s*\$\{\{\s*github\.event\.pull_request\.head/);
    expect(wf).not.toMatch(/npm (ci|install|run|test)/);
    // run: 里不直接用 PR 带来的文字（标题、分支名、标签只经 env 传）
    const runLines = wf.split('\n').filter((l) => /^\s*run:/.test(l));
    expect(runLines.length).toBeGreaterThan(0);
    for (const l of runLines) expect(l).not.toContain('${{');
    expect(wf).toContain('node scripts/check-line-scope.mjs');
  });
});
