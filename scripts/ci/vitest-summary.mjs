// 集成测试拆成几个并行 job 之后的汇总核对（CI 用，docs/TESTING.md 第 6 节）：
//   · 测试计划里列的每个用例文件都在某一组里跑过、只跑了一次（一项不少、不重复）；
//   · 没有失败的用例，也没有加载就出错的文件。
// 用法：node scripts/ci/vitest-summary.mjs <test-plan.json> <分组结果目录>
// 分组结果是 vitest json reporter 的输出（--outputFile.json），每组一个文件。
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [planPath, dir] = process.argv.slice(2);
if (!planPath || !dir) {
  console.error('用法：node scripts/ci/vitest-summary.mjs <test-plan.json> <分组结果目录>');
  process.exit(2);
}
const root = resolve('.');
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const expected = new Set(plan.integration.files);
const groups = plan.shards.integration.length;

const reports = readdirSync(dir, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.json'))
  .sort();
const seen = new Map();
const rows = [];
const failed = [];
for (const f of reports) {
  const r = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const files = r.testResults ?? [];
  rows.push({ group: f, files: files.length, tests: r.numTotalTests ?? 0, failed: r.numFailedTests ?? 0, ok: r.success === true });
  for (const t of files) {
    const rel = t.name.startsWith(root) ? t.name.slice(root.length + 1) : t.name;
    seen.set(rel, (seen.get(rel) ?? 0) + 1);
    if (t.status === 'failed') failed.push(`${rel}（${t.status}${t.message ? `：${String(t.message).split('\n')[0]}` : ''}）`);
  }
}

const lines = [
  `| 分组 | 文件 | 用例 | 失败 |`,
  `| --- | --- | --- | --- |`,
  ...rows.map((r) => `| ${r.group} | ${r.files} | ${r.tests} | ${r.failed} |`),
  '',
  `测试计划：${plan.integration.all ? '全量' : '按改动挑选'} ${expected.size} 个文件，分 ${groups} 组；各组合计跑过 ${seen.size} 个文件`,
];
console.log(lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### 集成测试汇总\n\n${lines.join('\n')}\n`);

const problems = [];
if (reports.length !== groups) problems.push(`应有 ${groups} 组的结果，只找到 ${reports.length} 组（有分组没跑完或被取消）`);
const missing = [...expected].filter((f) => !seen.has(f));
if (missing.length) problems.push(`计划里的 ${missing.length} 个文件没有跑：${missing.slice(0, 10).join('、')}${missing.length > 10 ? '……' : ''}`);
const extra = [...seen.keys()].filter((f) => !expected.has(f));
if (extra.length) problems.push(`跑了计划外的文件：${extra.slice(0, 10).join('、')}`);
const twice = [...seen].filter(([, n]) => n > 1).map(([f]) => f);
if (twice.length) problems.push(`这些文件被跑了不止一次：${twice.join('、')}`);
if (failed.length) problems.push(`有 ${failed.length} 个文件没通过：${failed.slice(0, 10).join('；')}`);
for (const r of rows) if (!r.ok && !r.failed) problems.push(`${r.group} 没有成功结束（加载出错或被中断）`);
if (problems.length) {
  for (const p of problems) console.error(`::error::${p}`);
  process.exit(1);
}
console.log('集成测试汇总：计划里的文件都跑了，一项不少、没有重复、没有失败。');
