// 把要跑的用例按上次的用时分到几个并行的 job（docs/TESTING.md 第 6 节）：
// 最长的先放、每次放进当前最空的一组（LPT 贪心），各组用时尽量接近，最慢的那组决定整次 CI 等多久。
// 用时从 scripts/ci/timings.json 读（集成测试按文件，浏览器验收按「尺寸|文件」）；没记过的按中位数估。
// 用时只影响分得匀不匀，不影响跑不跑：哪个文件进哪一组都会跑，汇总 job 再核对一项不少。

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TIMINGS_FILE = fileURLToPath(new URL('./timings.json', import.meta.url));

export function loadTimings(path = TIMINGS_FILE) {
  try {
    const t = JSON.parse(readFileSync(path, 'utf8'));
    return { vitest: t.vitest ?? {}, e2e: t.e2e ?? {} };
  } catch {
    return { vitest: {}, e2e: {} };
  }
}

function median(values) {
  if (!values.length) return 1;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** 每一项的估计用时（秒）：记过的用记录，没记过的用中位数 */
export function estimate(keys, table) {
  const fallback = median(Object.values(table));
  return keys.map((key) => ({ key, seconds: table[key] ?? fallback }));
}

/**
 * LPT 分组：items = [{ key, seconds }]，分成至多 n 组（项少于 n 时组数 = 项数）。
 * 结果按组内第一项排序、组内按 key 排序，同样的输入一定得到同样的分法。
 */
export function pack(items, n) {
  const groups = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, () => ({ keys: [], seconds: 0 }));
  const sorted = [...items].sort((a, b) => b.seconds - a.seconds || a.key.localeCompare(b.key));
  for (const item of sorted) {
    let target = groups[0];
    for (const g of groups) if (g.seconds < target.seconds) target = g;
    target.keys.push(item.key);
    target.seconds += item.seconds;
  }
  for (const g of groups) g.keys.sort();
  return groups.filter((g) => g.keys.length).sort((a, b) => a.keys[0].localeCompare(b.keys[0]));
}

/** 按目标用时算要几组：总用时 / 每组目标，向上取整，夹在 [1, max] 之间 */
export function shardCount(items, targetSeconds, max) {
  const total = items.reduce((s, i) => s + i.seconds, 0);
  return Math.max(1, Math.min(max, Math.ceil(total / targetSeconds)));
}

/** 集成测试每个文件另有的固定开销（秒）：从模板库复制一份新库、加载应用；json 报告里的用时不含这一段 */
const VITEST_FILE_OVERHEAD = 9;

/** 从 vitest 的 json 报告与 Playwright 的 json 报告收集用时（给 scripts/ci/timings.json 更新用） */
export function collectTimings({ vitestReports = [], playwrightReports = [] }, root) {
  const vitest = {};
  for (const r of vitestReports) {
    for (const t of r.testResults ?? []) {
      const file = t.name.startsWith(root) ? t.name.slice(root.length + 1) : t.name;
      vitest[file] = Math.round(((t.endTime ?? 0) - (t.startTime ?? 0)) / 100) / 10 + VITEST_FILE_OVERHEAD;
    }
  }
  const e2e = {};
  const walk = (suite, file) => {
    const f = suite.file ?? file;
    for (const spec of suite.specs ?? [])
      for (const test of spec.tests ?? []) {
        const key = `${test.projectName}|e2e/${spec.file ?? f}`;
        const seconds = (test.results ?? []).reduce((s, res) => s + (res.duration ?? 0), 0) / 1000;
        e2e[key] = Math.round(((e2e[key] ?? 0) + seconds) * 10) / 10;
      }
    for (const child of suite.suites ?? []) walk(child, f);
  };
  for (const r of playwrightReports) for (const s of r.suites ?? []) walk(s, s.file);
  return { vitest, e2e };
}

// 更新用时表：从 main 上最近一次全量 CI 下载 vitest-results-*、e2e-results-* 两类结果，解压到一个目录，然后
//   node scripts/ci/shards.mjs update <目录>
// 新的用时覆盖旧的，没跑到的保留。
function main() {
  const [cmd, dir] = process.argv.slice(2);
  if (cmd !== 'update' || !dir) {
    console.error('用法：node scripts/ci/shards.mjs update <放着 CI 结果 json 的目录>');
    process.exit(2);
  }
  const vitestReports = [];
  const playwrightReports = [];
  for (const f of readdirSync(dir, { recursive: true })
    .map(String)
    .filter((x) => x.endsWith('.json'))) {
    const r = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    if (Array.isArray(r.testResults)) vitestReports.push(r);
    else if (Array.isArray(r.suites)) playwrightReports.push(r);
  }
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const fresh = collectTimings({ vitestReports, playwrightReports }, root);
  const current = JSON.parse(readFileSync(TIMINGS_FILE, 'utf8'));
  const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  // CI 的报告里文件是绝对路径（/home/runner/work/yuzu/yuzu/tests/...）：只留 tests/ 起的那一段
  const vitest = Object.fromEntries(Object.entries(fresh.vitest).map(([k, v]) => [k.replace(/^.*?\/(?=tests\/)/, ''), v]));
  const next = { ...current, vitest: sorted({ ...current.vitest, ...vitest }), e2e: sorted({ ...current.e2e, ...fresh.e2e }) };
  writeFileSync(TIMINGS_FILE, `${JSON.stringify(next, null, 1)}\n`);
  console.log(
    `用时表已更新：集成测试 ${Object.keys(vitest).length} 个文件、浏览器验收 ${Object.keys(fresh.e2e).length} 项（${vitestReports.length} 份 vitest 报告、${playwrightReports.length} 份 Playwright 报告）`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
