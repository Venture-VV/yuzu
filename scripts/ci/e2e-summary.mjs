// 浏览器验收拆成几个并行 job 之后的汇总核对（CI 用，docs/TESTING.md 第 6 节）：
//   · 测试计划里的每一组都交回了结果（缺了就是没跑完或被取消）；
//   · 每一组跑过的用例（通过 + 跳过 + 失败）= 这一组参数下 `playwright test --list` 的数目，合起来一项不少；
//   · 全量时，各组的 --list 合起来 = 不拆分时 `playwright test --list` 的总数（分组没有漏掉任何「尺寸 × 文件」）；
//   · 没有失败的用例，也没有「重试后才通过」的。
// 用法：node scripts/ci/e2e-summary.mjs <test-plan.json> <分组结果目录>
// 分组结果是 Playwright json reporter 的输出（PLAYWRIGHT_JSON_OUTPUT_FILE），每组一个文件。
import { execSync } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [planPath, dir] = process.argv.slice(2);
if (!planPath || !dir) {
  console.error('用法：node scripts/ci/e2e-summary.mjs <test-plan.json> <分组结果目录>');
  process.exit(2);
}
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const shards = plan.shards.e2e;

/** `playwright test --list` 的用例数（参数原样交给 shell，与分组 job 的写法一样） */
function listCount(args) {
  const out = execSync(`npx playwright test --list ${args}`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const m = /Total: (\d+) tests?/.exec(out.trim().split('\n').at(-1) ?? '');
  if (!m) throw new Error(`读不出 --list 的总数：${args}`);
  return Number(m[1]);
}

const expectedById = Object.fromEntries(shards.map((s) => [s.id, listCount(s.args)]));
const expected = Object.values(expectedById).reduce((a, b) => a + b, 0);

const rows = [];
const sum = { expected: 0, skipped: 0, unexpected: 0, flaky: 0 };
const files = readdirSync(dir, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.json'))
  .sort();
for (const f of files) {
  const report = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const s = report.stats ?? {};
  const id = f.replace(/^.*\//, '').replace(/\.json$/, '');
  const row = { id, expected: s.expected ?? 0, skipped: s.skipped ?? 0, unexpected: s.unexpected ?? 0, flaky: s.flaky ?? 0, seconds: Math.round((s.duration ?? 0) / 1000) };
  rows.push(row);
  for (const k of Object.keys(sum)) sum[k] += row[k];
}
const ran = sum.expected + sum.skipped + sum.unexpected + sum.flaky;
const nameOf = Object.fromEntries(shards.map((s) => [s.id, s.name]));

const lines = [
  '| 分组 | 通过 | 跳过（按尺寸，设计如此） | 失败 | 重试后通过 | 应跑 | 用时（秒） |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  ...rows.map((r) => `| ${nameOf[r.id] ?? r.id} | ${r.expected} | ${r.skipped} | ${r.unexpected} | ${r.flaky} | ${expectedById[r.id] ?? '—'} | ${r.seconds} |`),
  `| **合计** | **${sum.expected}** | **${sum.skipped}** | **${sum.unexpected}** | **${sum.flaky}** | **${expected}** | |`,
  '',
  `测试计划：${plan.e2e.all ? '全量' : '按改动挑选'}，${shards.length} 组；应跑 ${expected} 项，各组合计跑过 ${ran} 项`,
];

const problems = [];
if (plan.e2e.all) {
  const total = listCount('');
  lines.push(`不拆分时的用例总数（playwright test --list）：${total}`);
  if (expected !== total) problems.push(`各组的 --list 合起来 ${expected} 项，与不拆分时的 ${total} 项不一致（分组漏了或重复了「尺寸 × 文件」）`);
}
console.log(lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### 浏览器验收汇总\n\n${lines.join('\n')}\n`);

if (rows.length !== shards.length) problems.push(`应有 ${shards.length} 组的结果，只找到 ${rows.length} 组（有分组没跑完或被取消）`);
for (const r of rows) {
  const want = expectedById[r.id];
  const got = r.expected + r.skipped + r.unexpected + r.flaky;
  if (want === undefined) problems.push(`结果 ${r.id} 不在测试计划里`);
  else if (got !== want) problems.push(`${nameOf[r.id]} 跑过 ${got} 项，应跑 ${want} 项`);
}
if (sum.unexpected > 0) problems.push(`有 ${sum.unexpected} 项失败`);
if (sum.flaky > 0) problems.push(`有 ${sum.flaky} 项重试后才通过（不算通过）`);
if (problems.length) {
  for (const p of problems) console.error(`::error::${p}`);
  process.exit(1);
}
console.log('浏览器验收汇总：计划里的分组都跑完，用例一项不少，没有失败。');
