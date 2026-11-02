// 浏览器验收拆成几个并行 job 之后的汇总核对（CI 用）：
//   · 每个分组都要交回结果（缺了就是没跑完或被取消）；
//   · 各分组跑过的用例（通过 + 跳过 + 失败）合起来 = 不拆分时 `playwright test --list` 的总数，一项不少；
//   · 没有失败的用例。
// 用法：node scripts/ci/e2e-summary.mjs <分组结果目录> <分组数> <用例总数>
// 分组结果是 Playwright json reporter 的输出（PLAYWRIGHT_JSON_OUTPUT_NAME），每组一个文件。
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, groupsArg, totalArg] = process.argv.slice(2);
const groups = Number(groupsArg);
const total = Number(totalArg);
if (!dir || !Number.isInteger(groups) || !Number.isInteger(total) || total <= 0) {
  console.error('用法：node scripts/ci/e2e-summary.mjs <分组结果目录> <分组数> <用例总数>');
  process.exit(2);
}

const files = readdirSync(dir, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.json'))
  .sort();
const rows = [];
const sum = { expected: 0, skipped: 0, unexpected: 0, flaky: 0 };
for (const f of files) {
  const report = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const s = report.stats ?? {};
  const row = { group: f, expected: s.expected ?? 0, skipped: s.skipped ?? 0, unexpected: s.unexpected ?? 0, flaky: s.flaky ?? 0, seconds: Math.round((s.duration ?? 0) / 1000) };
  rows.push(row);
  for (const k of Object.keys(sum)) sum[k] += row[k];
}
const ran = sum.expected + sum.skipped + sum.unexpected + sum.flaky;

const lines = [
  '| 分组 | 通过 | 跳过（按尺寸，设计如此） | 失败 | 重试后通过 | 用时（秒） |',
  '| --- | --- | --- | --- | --- | --- |',
  ...rows.map((r) => `| ${r.group} | ${r.expected} | ${r.skipped} | ${r.unexpected} | ${r.flaky} | ${r.seconds} |`),
  `| **合计** | **${sum.expected}** | **${sum.skipped}** | **${sum.unexpected}** | **${sum.flaky}** | |`,
  '',
  `不拆分时的用例总数（playwright test --list）：${total}；各分组合计跑过：${ran}`,
];
console.log(lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### 浏览器验收汇总\n\n${lines.join('\n')}\n`);

const problems = [];
if (rows.length !== groups) problems.push(`应有 ${groups} 个分组的结果，只找到 ${rows.length} 个（有分组没跑完或被取消）`);
if (ran !== total) problems.push(`各分组合计跑过 ${ran} 项，与总数 ${total} 不一致（有用例没被任何分组跑到，或被重复跑）`);
if (sum.unexpected > 0) problems.push(`有 ${sum.unexpected} 项失败`);
if (sum.flaky > 0) problems.push(`有 ${sum.flaky} 项重试后才通过（不算通过）`);
if (problems.length) {
  for (const p of problems) console.error(`::error::${p}`);
  process.exit(1);
}
console.log('浏览器验收汇总：全部分组都跑完，用例一项不少，没有失败。');
