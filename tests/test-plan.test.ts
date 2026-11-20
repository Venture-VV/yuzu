// 测试计划（scripts/test-plan.mjs，docs/TESTING.md 第 6 节）：按改动与风险挑用例、按用时分组、迁移的数据风险。不要数据库。
// 这里核对的是「不会少跑」：高风险一定全量，拿不准一定扩大，分组一项不少、不重复。
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error 脚本是 .mjs，没有类型声明
import * as planModule from '../scripts/test-plan.mjs';
// @ts-expect-error 同上
import * as shardsModule from '../scripts/ci/shards.mjs';
// @ts-expect-error 同上
import * as migrationsModule from '../scripts/check-migrations.mjs';

interface Unit {
  project: string;
  file: string;
}
interface Plan {
  risk: string;
  full: boolean;
  reasons: string[];
  dataWrites: string[];
  integration: { all: boolean; files: string[] };
  e2e: { all: boolean; units: Unit[] };
  jobs: { upgrade: boolean; demo: boolean; canteen: boolean };
}
interface PlanInput {
  changed: string[];
  diffs?: Record<string, string>;
  tests: string[];
  unitTests: string[];
  specs: string[];
  e2eUnits: Unit[];
  graph: Map<string, string[]>;
  forceFull?: string;
}
interface Shard {
  id: string;
  name: string;
  files: string | string[];
  args?: string;
  seconds: number;
}
const p = planModule as {
  globToRegExp: (glob: string) => RegExp;
  classifyFile: (file: string) => { level: string; why: string };
  moduleKeywords: (file: string) => string[];
  nameMatches: (testFile: string, keyword: string) => boolean;
  affectedBy: (changed: string[], graph: Map<string, string[]>, hubs?: string[], depth?: number) => Set<string>;
  hasDataWrite: (diff: string) => boolean;
  makePlan: (input: PlanInput) => Plan;
  shardPlan: (plan: Plan, timings: { vitest: Record<string, number>; e2e: Record<string, number> }) => { integration: Shard[]; e2e: Shard[] };
  playwrightArgs: (projects: string[], files: string[]) => string;
};
const s = shardsModule as {
  pack: (items: { key: string; seconds: number }[], n: number) => { keys: string[]; seconds: number }[];
  shardCount: (items: { key: string; seconds: number }[], target: number, max: number) => number;
  estimate: (keys: string[], table: Record<string, number>) => { key: string; seconds: number }[];
};
const m = migrationsModule as {
  splitStatements: (sql: string) => string[];
  findRisks: (sql: string) => { rule: string; acknowledged: boolean }[];
};

// 一个小仓库：两个模块、一个共用文件、一个登记处
const graph = new Map<string, string[]>([
  ['src/server/app.ts', ['src/server/modules/dishes.ts', 'src/server/modules/coupons.ts']],
  ['src/server/modules/dishes.ts', ['src/shared/dishes.ts']],
  ['src/server/modules/coupons.ts', []],
  ['src/client/features/dining/DishesPage.tsx', ['src/shared/dishes.ts']],
  ['src/shared/dishes.ts', []],
  ['tests/helpers.ts', ['src/server/app.ts']],
  ['tests/dishes.test.ts', ['tests/helpers.ts']],
  ['tests/coupons.test.ts', ['tests/helpers.ts']],
  ['tests/dishes-shared.test.ts', ['src/shared/dishes.ts']],
  ['tests/frontdesk.test.ts', ['tests/helpers.ts']],
  ['tests/acceptance.test.ts', ['tests/helpers.ts']],
]);
const base: PlanInput = {
  changed: [],
  tests: ['tests/acceptance.test.ts', 'tests/coupons.test.ts', 'tests/dishes-shared.test.ts', 'tests/dishes.test.ts', 'tests/frontdesk.test.ts'],
  unitTests: ['tests/dishes-shared.test.ts'],
  specs: ['e2e/dishes.spec.ts', 'e2e/flows.spec.ts', 'e2e/frontdesk.spec.ts', 'e2e/viewports.spec.ts'],
  e2eUnits: [
    { project: '门店电脑', file: 'e2e/dishes.spec.ts' },
    { project: '门店电脑', file: 'e2e/flows.spec.ts' },
    { project: '门店电脑', file: 'e2e/frontdesk.spec.ts' },
    { project: '门店电脑', file: 'e2e/viewports.spec.ts' },
    { project: '手机', file: 'e2e/viewports.spec.ts' },
  ],
  graph,
};
const plan = (changed: string[], extra: Partial<PlanInput> = {}) => p.makePlan({ ...base, changed, ...extra });

describe('改动分级', () => {
  it('glob：** 跨目录、* 不跨目录', () => {
    expect(p.globToRegExp('src/server/migrations/**').test('src/server/migrations/200_x.sql')).toBe(true);
    expect(p.globToRegExp('scripts/*.sh').test('scripts/lib/common.sh')).toBe(false);
    expect(p.globToRegExp('src/server/modules/wallet*').test('src/server/modules/wallet-online.ts')).toBe(true);
    expect(p.globToRegExp('tests/**').test('tests/regression/a.test.ts')).toBe(true);
  });

  it('资金、迁移、权限、测试与 CI 本身是高风险；文档、小程序包、代码各归各的；认不出的按高风险', () => {
    for (const f of [
      'src/server/migrations/200_x.sql',
      'src/server/modules/wallet.ts',
      'src/server/modules/frontdesk/visits.ts',
      'src/shared/permissions.ts',
      '.github/workflows/ci.yml',
      'tests/helpers.ts',
      'e2e/nav.ts',
      'package-lock.json',
      'scripts/test-plan.mjs',
      'mystery.toml',
    ])
      expect(p.classifyFile(f).level, f).toBe('high');
    expect(p.classifyFile('e2e/flows.spec.ts').level).toBe('code');
    expect(p.classifyFile('docs/TESTING.md').level).toBe('docs');
    expect(p.classifyFile('miniprogram/pages/index.ts').level).toBe('mp');
    expect(p.classifyFile('src/server/modules/dishes.ts').level).toBe('code');
  });

  it('模块名：目录与文件两层、去掉版本后缀、连字符取第一段；mp 这样的短词只认文件名开头', () => {
    expect(p.moduleKeywords('src/server/modules/dining-v8117.ts')).toEqual(expect.arrayContaining(['dining-v8117', 'dining']));
    expect(p.moduleKeywords('src/server/modules/mp/recharge.ts')).toEqual(expect.arrayContaining(['mp', 'recharge']));
    expect(p.moduleKeywords('src/server/modules/coupon-campaigns.ts')).toEqual(expect.arrayContaining(['coupon-campaigns', 'coupon']));
    expect(p.moduleKeywords('docs/TESTING.md')).toEqual([]);
    expect(p.nameMatches('tests/mp-recharge.test.ts', 'mp')).toBe(true);
    expect(p.nameMatches('tests/ai-mask.test.ts', 'mp')).toBe(false);
    expect(p.nameMatches('tests/coupon-campaigns.test.ts', 'coupons')).toBe(true);
  });

  it('受影响的文件：沿「谁引了我」往上找，不经过登记处，至多给定的层数', () => {
    const hit = p.affectedBy(['src/shared/dishes.ts'], graph, ['src/server/app.ts', 'tests/helpers.ts'], 3);
    expect(hit.has('src/server/modules/dishes.ts')).toBe(true);
    expect(hit.has('tests/dishes-shared.test.ts')).toBe(true);
    expect(hit.has('src/server/app.ts')).toBe(true); // 登记处本身算受影响，但不再往上
    expect(hit.has('tests/helpers.ts')).toBe(false);
    expect(p.affectedBy(['src/shared/dishes.ts'], graph, [], 1).has('src/server/app.ts')).toBe(false);
  });

  it('改动里有写数据的语句（增删的行），才算数据写入', () => {
    expect(p.hasDataWrite('+  await tx`UPDATE dishes SET price = ${x} WHERE id = ${id}`')).toBe(true);
    expect(p.hasDataWrite('-  SELECT * FROM members FOR UPDATE')).toBe(true);
    expect(p.hasDataWrite('   await tx`DELETE FROM x`')).toBe(false); // 上下文行，不是改动
    expect(p.hasDataWrite('+  const label = "更新"')).toBe(false);
  });
});

describe('挑用例', () => {
  it('高风险：全量，四个 job 都跑', () => {
    const r = plan(['src/server/modules/wallet.ts']);
    expect(r.full).toBe(true);
    expect(r.integration.all && r.e2e.all).toBe(true);
    expect(r.integration.files).not.toContain('tests/dishes-shared.test.ts'); // 秒级的在静态检查里跑
    expect(r.e2e.units).toHaveLength(base.e2eUnits.length);
    expect(r.jobs).toEqual({ upgrade: true, demo: true, canteen: true });
  });

  it('要全量（main 上、ci:full、[ci full]）：照全量', () => {
    expect(plan(['docs/TESTING.md'], { forceFull: 'main 上的推送' }).full).toBe(true);
  });

  it('只改文档：不跑集成测试与浏览器验收', () => {
    const r = plan(['docs/TESTING.md']);
    expect(r.risk).toBe('docs');
    expect(r.integration.files).toEqual([]);
    expect(r.e2e.units).toEqual([]);
  });

  it('一般代码：受影响的 + 模块名对上的 + 核心回归；浏览器用例按模块名找，加完整收银流程', () => {
    const r = plan(['src/server/modules/dishes.ts']);
    expect(r.full).toBe(false);
    expect(r.integration.files).toEqual(['tests/acceptance.test.ts', 'tests/dishes.test.ts']);
    expect(r.e2e.units.map((u) => u.file).sort()).toEqual(['e2e/dishes.spec.ts', 'e2e/flows.spec.ts']); // 只改服务端：不加页面布局冒烟
    expect(r.jobs.upgrade).toBe(false);
  });

  it('数据写入：单列出来，另加数据一致性的用例', () => {
    const r = plan(['src/server/modules/dishes.ts'], { diffs: { 'src/server/modules/dishes.ts': '+ await tx`INSERT INTO dishes (name) VALUES (${n})`' } });
    expect(r.risk).toBe('data');
    expect(r.dataWrites).toEqual(['src/server/modules/dishes.ts']);
    expect(r.reasons.join()).toContain('数据写入');
  });

  it('拿不准就扩大：改了服务端却对不上集成测试 → 集成测试全量；改了页面却对不上浏览器用例 → 浏览器验收全量', () => {
    const g = new Map(graph).set('src/server/modules/linen.ts', []).set('src/client/features/linen/LinenPage.tsx', []);
    const server = plan(['src/server/modules/linen.ts'], { graph: g });
    expect(server.integration.all).toBe(true);
    const client = plan(['src/client/features/linen/LinenPage.tsx'], { graph: g });
    expect(client.e2e.all).toBe(true);
  });

  it('员工端（员工食堂、巡场、设计台）有自己的浏览器验收：改到就跑那个 job（Codex 审查 001ebb4）', () => {
    for (const f of ['src/server/modules/patrol/routes.ts', 'src/shared/patrol.ts', 'src/server/modules/canteen/portal.ts', 'src/client/features/studio/StudioPage.tsx'])
      expect(plan([f]).jobs.canteen, f).toBe(true);
    expect(plan(['src/server/modules/dishes.ts']).jobs.canteen).toBe(false);
  });

  it('文件名对不上的用例靠对照表补上：改预约页要跑 requests-1114（Codex 审查 a88acd1）', () => {
    const extra = { specs: [...base.specs, 'e2e/requests-1114.spec.ts'], e2eUnits: [...base.e2eUnits, { project: '门店电脑', file: 'e2e/requests-1114.spec.ts' }] };
    const r = plan(['src/client/features/bookings/BookingsPage.tsx'], extra);
    expect(r.e2e.units.map((u) => u.file)).toContain('e2e/requests-1114.spec.ts');
  });

  it('改建档表单要跑建档渠道与目标设备的浏览器用例（Codex 审查 a28c2c9）', () => {
    const more = ['e2e/admin-v060.spec.ts', 'e2e/target-devices.spec.ts'];
    const extra = { specs: [...base.specs, ...more], e2eUnits: [...base.e2eUnits, ...more.map((file) => ({ project: '门店电脑', file }))] };
    const files = plan(['src/client/features/workbench/MemberFormDialog.tsx'], extra).e2e.units.map((u) => u.file);
    expect(files).toEqual(expect.arrayContaining(more));
  });

  it('改了页面：另加目标设备与视口冒烟（各尺寸都跑）', () => {
    const units = plan(['src/client/features/dining/DishesPage.tsx']).e2e.units;
    expect(units.filter((u) => u.file === 'e2e/viewports.spec.ts')).toHaveLength(2);
    expect(units.map((u) => u.file)).toContain('e2e/dishes.spec.ts');
  });

  it('改了用例文件本身：跑它', () => {
    const r = plan(['tests/frontdesk.test.ts', 'e2e/viewports.spec.ts']);
    expect(r.integration.files).toContain('tests/frontdesk.test.ts');
    expect(r.e2e.units.filter((u) => u.file === 'e2e/viewports.spec.ts')).toHaveLength(2); // 两个尺寸都跑
  });
});

describe('分组', () => {
  it('最长的先放、放进最空的一组；同样的输入分法一样；组数不超过项数', () => {
    const items = [
      { key: 'a', seconds: 10 },
      { key: 'b', seconds: 9 },
      { key: 'c', seconds: 5 },
      { key: 'd', seconds: 4 },
      { key: 'e', seconds: 1 },
    ];
    const g = s.pack(items, 2);
    expect(g.map((x) => x.seconds).sort()).toEqual([14, 15]);
    expect(g.flatMap((x) => x.keys).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(s.pack(items, 2)).toEqual(g);
    expect(s.pack(items.slice(0, 1), 4)).toHaveLength(1);
    expect(s.shardCount(items, 10, 4)).toBe(3);
    expect(s.shardCount(items, 1, 4)).toBe(4);
    expect(s.estimate(['a', 'z'], { a: 3, b: 7, c: 5 })).toEqual([
      { key: 'a', seconds: 3 },
      { key: 'z', seconds: 5 },
    ]);
  });

  it('全量时各组合起来一项不少、不重复；门店电脑与其余尺寸分开；文件名转义并锚在结尾', () => {
    const r = plan(['src/server/modules/wallet.ts']);
    const sh = p.shardPlan(r, { vitest: {}, e2e: {} });
    const files = sh.integration.flatMap((x) => String(x.files).split(' '));
    expect(files.sort()).toEqual([...r.integration.files].sort());
    expect(new Set(files).size).toBe(files.length);
    const store = sh.e2e.filter((x) => x.id.startsWith('s'));
    expect(store.flatMap((x) => x.files as string[]).sort()).toEqual(['e2e/dishes.spec.ts', 'e2e/flows.spec.ts', 'e2e/frontdesk.spec.ts', 'e2e/viewports.spec.ts']);
    expect(sh.e2e.find((x) => x.id === 'o1')?.args).toBe("'--project=手机'");
    expect(p.playwrightArgs(['门店电脑'], ['e2e/erp.spec.ts'])).toBe("'--project=门店电脑' 'e2e/erp\\.spec\\.ts$'");
  });

  it('文件名里有不能放进命令行的字符：拒绝', () => {
    const bad = { ...plan(['README.md']), integration: { all: false, files: ["tests/x';rm -rf /;'.test.ts"] } };
    expect(() => p.shardPlan(bad, { vitest: {}, e2e: {} })).toThrow('不能放进命令行');
  });
});

describe('迁移的数据风险', () => {
  it('拆语句：跳过字符串、$$ 块与注释里的分号', () => {
    const sql = "-- a; b\nINSERT INTO t VALUES ('x;y');\nDO $$ BEGIN PERFORM 1; END $$;\nSELECT 1";
    expect(m.splitStatements(sql)).toHaveLength(3);
  });

  it('删数据、整表改写、改账本、改类型、改名、加 NOT NULL、重建作废约束都报出来', () => {
    const rules = (sql: string) => m.findRisks(sql).map((f) => f.rule);
    expect(rules('ALTER TABLE x DROP COLUMN y;')).toEqual(['drop']);
    expect(rules('UPDATE dishes SET price = 0;')).toEqual(['unbounded-write']);
    expect(rules('UPDATE dishes SET price = 0 WHERE id = 1;')).toEqual([]);
    expect(rules('UPDATE ledger_entries SET amount = 0 WHERE id = 1;')).toEqual(['ledger-write']);
    // 带别名、schema、引号的也认（Codex 审查 001ebb4）；名字只是前缀相同的别的表不算
    expect(rules('UPDATE ledger_entries l SET amount_cents = 0 WHERE l.id = 1;')).toEqual(['ledger-write']);
    expect(rules('DELETE FROM public.ledger_entries WHERE id = 1;')).toEqual(['ledger-write']);
    expect(rules('UPDATE public."recharges" AS r SET note = 1 WHERE r.id = 1;')).toEqual(['ledger-write']);
    expect(rules('UPDATE ledger_entries_archive SET a = 1 WHERE id = 1;')).toEqual([]);
    expect(rules('UPDATE dishes d SET price = 0;')).toEqual(['unbounded-write']);
    expect(rules('ALTER TABLE x ALTER COLUMN y TYPE bigint;')).toEqual(['type-change']);
    expect(rules('ALTER TABLE x RENAME COLUMN a TO b;')).toEqual(['rename']);
    expect(rules('ALTER TABLE x ALTER COLUMN y SET NOT NULL;')).toEqual(['not-null']);
    expect(rules('ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check;')).toEqual(['fence-constraint']);
    // 照 162 的写法读出原表达式再追加：不报
    expect(rules("DO $$ BEGIN SELECT pg_get_expr(conbin, conrelid) INTO e FROM pg_constraint; EXECUTE 'ALTER TABLE op_fences DROP CONSTRAINT op_fences_op_type_check'; END $$;")).toEqual([]);
    // 加表、加列、建索引：不报
    expect(rules('CREATE TABLE x (id int); ALTER TABLE x ADD COLUMN y text; CREATE INDEX ON x (y);')).toEqual([]);
  });

  it('写了「-- 风险已知：原因」算说明过', () => {
    expect(m.findRisks('-- 风险已知：这张表 8.1.3 起没人写，先导出备份\nDROP TABLE old_drafts;').map((f) => f.acknowledged)).toEqual([true]);
    expect(m.findRisks('DROP TABLE old_drafts;').map((f) => f.acknowledged)).toEqual([false]);
  });
});

describe('集成测试汇总', () => {
  const run = (planJson: object, reports: Record<string, object>) => {
    const dir = mkdtempSync(join(tmpdir(), 'vitest-summary-'));
    const results = join(dir, 'results');
    mkdirSync(results);
    writeFileSync(join(dir, 'plan.json'), JSON.stringify(planJson));
    for (const [name, r] of Object.entries(reports)) writeFileSync(join(results, `${name}.json`), JSON.stringify(r));
    try {
      execFileSync(process.execPath, ['scripts/ci/vitest-summary.mjs', join(dir, 'plan.json'), results], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });
      return 0;
    } catch (e) {
      return (e as { status: number }).status;
    }
  };
  const planJson = { integration: { all: false, files: ['tests/a.test.ts', 'tests/b.test.ts'] }, shards: { integration: [{}, {}] } };
  const report = (files: string[], status = 'passed') => ({
    success: status === 'passed',
    numTotalTests: files.length,
    numFailedTests: status === 'passed' ? 0 : 1,
    testResults: files.map((f) => ({ name: `${process.cwd()}/${f}`, status })),
  });

  it('一项不少、没有失败：通过', () => {
    expect(run(planJson, { i1: report(['tests/a.test.ts']), i2: report(['tests/b.test.ts']) })).toBe(0);
  });
  it('少一组、少一个文件、有失败、跑了两次：都不通过', () => {
    expect(run(planJson, { i1: report(['tests/a.test.ts']) })).toBe(1);
    expect(run(planJson, { i1: report(['tests/a.test.ts']), i2: report([]) })).toBe(1);
    expect(run(planJson, { i1: report(['tests/a.test.ts']), i2: report(['tests/b.test.ts'], 'failed') })).toBe(1);
    expect(run(planJson, { i1: report(['tests/a.test.ts', 'tests/b.test.ts']), i2: report(['tests/b.test.ts']) })).toBe(1);
  });
});
