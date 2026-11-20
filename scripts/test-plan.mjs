// 测试计划：按这次改了什么、风险多高，挑出该跑的用例（docs/TESTING.md 第 6 节）。
// 开发会话、测试会话、Codex、Gemini 与 CI 用的是同一份计划，谁来测都不会漏掉同一批关键用例。
//
//   node scripts/test-plan.mjs                      本机：相对 origin/main 的改动（含没提交的）
//   node scripts/test-plan.mjs --base v8.1.17       验收：相对上一个版本标签（测试 AI 用）
//   node scripts/test-plan.mjs --base A --head B    任意两个提交之间
//   node scripts/test-plan.mjs --json               输出 JSON（给脚本用）
//   node scripts/test-plan.mjs --ci                 CI 的「测试计划」job：写 GITHUB_OUTPUT、步骤摘要与 test-plan.json
//
// 规则（参照 Nx affected、Bazel、pytest-testmon 与 Google TAP 的「提交前挑选、合并后全量」）：
//   1. 只改文档：不跑集成测试与浏览器验收（静态检查照跑）。
//   2. 改到高风险的文件（资金、账本、加锁、权限、迁移、演示数据、测试与 CI 本身，见 test-plan.config.mjs）：全量。
//   3. 其余：顺着导入关系找受影响的文件（不经过登记处与入口），再按模块名找沾边的用例；加上每次都跑的核心回归。
//      改的内容里有写数据的语句，另加数据一致性的几组用例，计划里单列「数据写入」。
//      影响面太广、或改了页面却找不到一条浏览器用例：那一样按全量。
//   4. main 上每次合并都全量（CI 的 push 事件），版本标签只打在全量通过的提交上；PR 上可以用 ci:full 标签或提交信息里写 [ci full] 要全量。

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimate, loadTimings, pack, shardCount } from './ci/shards.mjs';
import { AFFECT_DEPTH, ALWAYS, AREAS, BROAD_KEYWORDS, BROAD_SHARE, CANTEEN, DATA_WRITE_PATTERNS, DATA_WRITE_TESTS, DOCS_ONLY, HIGH_RISK, HUBS, MP_PACKAGE } from './test-plan.config.mjs';
import { matchesKeyword, needsDatabase, resolveImport, runtimeImports } from './test-tiers.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');

/** glob → 正则：** 跨目录，* 与 ? 不跨目录 */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const globCache = new Map();
export function matchGlob(file, glob) {
  if (!globCache.has(glob)) globCache.set(glob, globToRegExp(glob));
  return globCache.get(glob).test(file);
}
const matchAny = (file, globs) => globs.some((g) => matchGlob(file, g));

/** 一个改动文件的风险：high（全量）/ docs（不跑运行时用例）/ mp（只跑小程序 job）/ code（按影响挑） */
export function classifyFile(file) {
  for (const rule of HIGH_RISK) if (matchGlob(file, rule.glob) && !(rule.unless && rule.unless.test(file))) return { level: 'high', why: rule.why };
  if (matchAny(file, MP_PACKAGE)) return { level: 'mp', why: '小程序包（只跑小程序 job）' };
  if (matchAny(file, DOCS_ONLY)) return { level: 'docs', why: '文档' };
  if (/^(src|tests|e2e|e2e-canteen|scripts)\//.test(file)) return { level: 'code', why: '代码' };
  // 认不出来的（根目录的新文件等）：拿不准就全量
  return { level: 'high', why: '认不出归属（拿不准按全量）' };
}

/**
 * 改到的文件 → 模块名（找沾边的用例用）：目录下的文件给目录名和文件名两个；
 * 去掉 -v8117、-808 这类版本后缀；带连字符的再给第一段（coupon-campaigns → coupon）。
 */
export function moduleKeywords(file) {
  const patterns = [
    /^src\/server\/modules\/([^/.]+)(?:\/([^/.]+))?/,
    /^src\/server\/(?:lib|ops|auth|integrations|devices|floorplan)\/([^/.]+)()/,
    /^src\/shared\/([^/.]+)(?:\/([^/.]+))?/,
    /^src\/client\/features\/([^/.]+)()/,
    /^src\/client\/lib\/([^/.]+)()/,
    /^tests\/([^/.]+)\.test\.ts$()/,
    /^e2e\/([^/.]+)\.spec\.ts$()/,
  ];
  for (const p of patterns) {
    const m = p.exec(file);
    if (!m) continue;
    const words = new Set();
    for (const raw of [m[1], m[2]]) {
      if (!raw || raw === 'index' || raw === 'routes') continue;
      const name = raw.toLowerCase();
      const base = name.replace(/-(?:v?\d{3,5}|core|ops|shared|routes|admin)$/, '');
      words.add(name).add(base);
      if (base.includes('-')) words.add(base.split('-')[0]);
    }
    return [...words];
  }
  return [];
}

/** 用例文件名和模块名沾不沾边：长词照 test-tiers 的规则；mp 这样的短词只认文件名开头的「mp-」 */
export function nameMatches(testFile, keyword) {
  if (keyword.length < 3) return posix.basename(testFile).startsWith(`${keyword}-`);
  return matchesKeyword(testFile, keyword);
}

/** 浏览器用例文件名和模块名沾不沾边（与集成测试同一个规则） */
export function specMatches(specFile, keyword) {
  return nameMatches(specFile.replace(/\.spec\.ts$/, '.test.ts'), keyword);
}

/** 仓库里的导入关系：file → 它运行时引到的仓库文件 */
export function buildGraph(files, read, exists) {
  const graph = new Map();
  for (const file of files) {
    const code = read(file);
    if (code === null) continue;
    const deps = [];
    for (const spec of runtimeImports(file, code)) {
      const target = resolveImport(file, spec, exists);
      if (target) deps.push(target);
    }
    graph.set(file, deps);
  }
  return graph;
}

/**
 * 受影响的文件：从改到的文件出发，沿「谁引了我」往上找，不经过登记处与入口（HUBS），至多 depth 层。
 * 这套代码的模块互相引得很多，一路找到顶几乎就是全部（静态导入比实际执行到的宽得多）；
 * 用例 → 模块 → 模块 → 改到的文件这样三层以内的，才算真正用到。更远的靠每次合并后 main 上的全量兜底。
 */
export function affectedBy(changed, graph, hubs = HUBS, depth = AFFECT_DEPTH) {
  const reverse = new Map();
  for (const [file, deps] of graph) for (const d of deps) (reverse.get(d) ?? reverse.set(d, []).get(d)).push(file);
  const seen = new Set(changed);
  let frontier = [...changed];
  for (let level = 0; level < depth && frontier.length; level++) {
    const next = [];
    for (const file of frontier) {
      if (level > 0 && matchAny(file, hubs)) continue;
      for (const parent of reverse.get(file) ?? []) {
        if (seen.has(parent)) continue;
        seen.add(parent);
        next.push(parent);
      }
    }
    frontier = next;
  }
  return seen;
}

/** 这段改动（增删的行）里有没有写数据的语句 */
export function hasDataWrite(diffText) {
  const lines = diffText.split('\n').filter((l) => /^[+-](?![+-])/.test(l));
  return lines.some((l) => DATA_WRITE_PATTERNS.some((p) => p.test(l)));
}

/**
 * 计划（纯函数，方便单测）。
 * input: { changed: string[], diffs: { [file]: string }, tests: string[], unitTests: string[], specs: string[],
 *          e2eUnits: { project, file }[], graph: Map, forceFull?: string }
 */
export function makePlan(input) {
  const { changed, diffs = {}, tests, unitTests, specs, e2eUnits, graph, forceFull } = input;
  const reasons = [];
  const perFile = changed.map((file) => ({ file, ...classifyFile(file) }));
  const high = perFile.filter((f) => f.level === 'high');
  const code = perFile.filter((f) => f.level === 'code');
  const dataWrites = code.filter((f) => f.file.startsWith('src/server/') && diffs[f.file] && hasDataWrite(diffs[f.file])).map((f) => f.file);
  const canteen = changed.some((f) => matchAny(f, CANTEEN));

  let risk = 'docs';
  if (perFile.length && perFile.every((f) => f.level === 'mp')) risk = 'mp';
  if (code.length) risk = dataWrites.length ? 'data' : 'code';
  if (high.length) risk = 'high';

  const full = Boolean(forceFull) || risk === 'high';
  if (forceFull) reasons.push(forceFull);
  for (const f of high) reasons.push(`高风险：${f.file}（${f.why}）`);

  // 秒级一档（不要数据库的用例）每次都在「静态检查」job 里全跑；这里只挑要数据库的集成测试
  const dbTests = tests.filter((t) => !unitTests.includes(t));
  const plan = {
    risk,
    full,
    reasons,
    changed: perFile,
    dataWrites,
    integration: { all: false, files: [] },
    e2e: { all: false, units: [] },
    jobs: { upgrade: full, demo: full, canteen: full || canteen },
  };
  if (full) {
    plan.integration = { all: true, files: dbTests };
    plan.e2e = { all: true, units: [...e2eUnits] };
    return plan;
  }
  if (
    !code.length &&
    !changed.some((f) =>
      matchAny(
        f,
        AREAS.flatMap((a) => a.paths),
      ),
    )
  ) {
    reasons.push(changed.length ? '只改了文档或小程序包：不跑集成测试与浏览器验收' : '没有改动');
    return plan;
  }

  // 受影响的文件：沿「谁引了我」一路往上（不经过登记处与入口），用例引到其中任何一个就跑
  const changedCode = code.map((f) => f.file);
  const affected = affectedBy(changedCode, graph);
  // 模块名只取改到的文件与直接引它的文件（再往上就是半个系统，按名字找会把什么都带上）
  const near = new Set(changedCode);
  for (const [file, deps] of graph) if (!matchAny(file, HUBS) && deps.some((d) => changedCode.includes(d))) near.add(file);
  // 核心回归只在改了代码时加
  const integration = new Set(code.length ? ALWAYS.integration : []);
  const e2eFiles = new Set(code.length ? ALWAYS.e2e : []);
  let integrationAll = false;
  let e2eAll = false;
  const keywords = new Set([...near].flatMap(moduleKeywords));
  if (keywords.size > BROAD_KEYWORDS) {
    reasons.push(`影响面太广：改到的文件与直接引它们的文件涉及 ${keywords.size} 个模块（上限 ${BROAD_KEYWORDS}），全量`);
    integrationAll = e2eAll = true;
  }
  for (const t of tests) if (affected.has(t) || [...keywords].some((k) => nameMatches(t, k))) integration.add(t);
  for (const s of specs) if (affected.has(s) || [...keywords].some((k) => specMatches(s, k))) e2eFiles.add(s);
  for (const area of AREAS) {
    if (!changed.some((f) => matchAny(f, area.paths))) continue;
    reasons.push(`涉及「${area.name}」`);
    for (const t of tests) if (matchAny(t, area.tests)) integration.add(t);
    for (const s of specs) if (matchAny(s, area.e2e)) e2eFiles.add(s);
  }
  if (dataWrites.length) {
    reasons.push(`数据写入：${dataWrites.join('、')}（另跑数据一致性用例）`);
    for (const t of DATA_WRITE_TESTS) if (tests.includes(t)) integration.add(t);
  }
  // 改了服务端代码却一条集成测试都没对上（核心回归与秒级之外）：拿不准，集成测试全量
  const serverChanged = code.some((f) => f.file.startsWith('src/server/'));
  const matchedIntegration = [...integration].filter((t) => dbTests.includes(t) && !ALWAYS.integration.includes(t));
  if (serverChanged && !matchedIntegration.length) {
    reasons.push('改了服务端代码，按导入关系与模块名都没找到对应的集成测试：集成测试全量');
    integrationAll = true;
  }
  // 改了页面却一条浏览器用例都没对上：拿不准，浏览器验收全量
  // 员工食堂的页面另有一套浏览器验收（员工食堂 job），不算在这里
  const clientChanged = code.some((f) => f.file.startsWith('src/client/') && !matchAny(f.file, CANTEEN));
  if (clientChanged) for (const f of ALWAYS.e2eClient) if (specs.includes(f)) e2eFiles.add(f);
  const matchedSpecs = [...e2eFiles].filter((s) => !ALWAYS.e2e.includes(s) && !ALWAYS.e2eClient.includes(s));
  if (clientChanged && !matchedSpecs.length) {
    reasons.push('改了页面，按模块名找不到对应的浏览器用例：浏览器验收全量');
    e2eAll = true;
  }
  // 改了用例文件本身：跑它
  for (const f of changed) {
    if (tests.includes(f)) integration.add(f);
    if (specs.includes(f)) e2eFiles.add(f);
  }

  // 挑出来的已经占了大半：直接全量（省得漏掉剩下的那一小半）
  if (!integrationAll && [...integration].filter((t) => dbTests.includes(t)).length > dbTests.length * BROAD_SHARE) {
    reasons.push(`挑出的集成测试超过 ${Math.round(BROAD_SHARE * 100)}%：集成测试全量`);
    integrationAll = true;
  }
  if (!e2eAll && e2eUnits.filter((u) => e2eFiles.has(u.file)).length > e2eUnits.length * BROAD_SHARE) {
    reasons.push(`挑出的浏览器用例超过 ${Math.round(BROAD_SHARE * 100)}%：浏览器验收全量`);
    e2eAll = true;
  }
  plan.integration = integrationAll ? { all: true, files: dbTests } : { all: false, files: dbTests.filter((t) => integration.has(t)) };
  plan.e2e = e2eAll ? { all: true, units: [...e2eUnits] } : { all: false, units: e2eUnits.filter((u) => e2eFiles.has(u.file)) };
  if (integrationAll || e2eAll) plan.jobs.demo = plan.jobs.demo || e2eAll;
  return plan;
}

/** 文件名与尺寸名会拼进 CI 的命令行：只认字母、数字、中文与 ./_-，别的一律拒绝 */
const SAFE = /^[\w./\-\u4e00-\u9fff]+$/;
function assertSafe(values) {
  for (const v of values) if (!SAFE.test(v)) throw new Error(`名字里有不能放进命令行的字符：${JSON.stringify(v)}`);
}

/** 计划 → CI 的分组（矩阵）：集成测试每组约 900 秒的单进程用时（组内 4 个进程并行，约 4 分钟）、至多 4 组；浏览器验收门店电脑每组约 6 分钟、至多 6 组，其余尺寸每组约 6 分钟、至多 2 组 */
export function shardPlan(plan, timings) {
  assertSafe([...plan.integration.files, ...plan.e2e.units.flatMap((u) => [u.project, u.file])]);
  const integrationItems = estimate(plan.integration.files, timings.vitest);
  const iGroups = pack(integrationItems, shardCount(integrationItems, 900, 4));
  const integration = iGroups.map((g, i) => ({ id: `i${i + 1}`, name: `${i + 1}/${iGroups.length}`, files: g.keys.join(' '), seconds: Math.round(g.seconds) }));

  const e2e = [];
  const STORE = '门店电脑';
  const storeUnits = plan.e2e.units.filter((u) => u.project === STORE);
  const storeItems = estimate(
    storeUnits.map((u) => `${u.project}|${u.file}`),
    timings.e2e,
  );
  const sGroups = pack(storeItems, shardCount(storeItems, 360, 6));
  sGroups.forEach((g, i) => {
    const files = g.keys.map((k) => k.split('|')[1]);
    e2e.push({ id: `s${i + 1}`, name: `门店电脑 ${i + 1}/${sGroups.length}`, projects: [STORE], files, args: playwrightArgs([STORE], files), seconds: Math.round(g.seconds) });
  });
  // 其余尺寸：按尺寸成组（同一尺寸的用例在一起），尺寸之间按用时分
  const others = plan.e2e.units.filter((u) => u.project !== STORE);
  const byProject = new Map();
  for (const u of others) (byProject.get(u.project) ?? byProject.set(u.project, []).get(u.project)).push(u);
  const projectItems = [...byProject].map(([project, units]) => ({
    key: project,
    seconds: estimate(
      units.map((u) => `${u.project}|${u.file}`),
      timings.e2e,
    ).reduce((s, x) => s + x.seconds, 0),
  }));
  const oGroups = pack(projectItems, shardCount(projectItems, 360, 2));
  oGroups.forEach((g, i) => {
    const files = plan.e2e.all ? [] : [...new Set(others.filter((u) => g.keys.includes(u.project)).map((u) => u.file))].sort();
    e2e.push({ id: `o${i + 1}`, name: `${g.keys.join('、')}`, projects: g.keys, files, args: playwrightArgs(g.keys, files), seconds: Math.round(g.seconds) });
  });
  return { integration, e2e };
}

/** Playwright 的参数：尺寸 + 文件（文件按正则匹配，转义后锚在结尾，不会把 erp.spec.ts 对到 erp-807.spec.ts） */
export function playwrightArgs(projects, files) {
  const p = projects.map((x) => `--project=${x}`);
  const f = files.map((file) => `${file.replace(/[.+^${}()|[\]\\]/g, '\\$&')}$`);
  return [...p, ...f].map((a) => `'${a}'`).join(' ');
}

// ───────────────────────── 读仓库 ─────────────────────────

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return '';
  }
}

function listFiles(dir, pattern) {
  if (!existsSync(resolve(ROOT, dir))) return [];
  return readdirSync(resolve(ROOT, dir), { recursive: true })
    .map((f) => `${dir}/${String(f).split('\\').join('/')}`)
    .filter((f) => pattern.test(f))
    .sort();
}

/** 改到的文件与每个文件的改动内容：给了 head 用两个提交之间的；没给就是相对 base 的已提交 + 没提交 + 没跟踪的 */
function readChanges(base, head) {
  if (head) {
    const changed = git(['diff', '--name-only', `${base}...${head}`])
      .split('\n')
      .filter(Boolean);
    const diffs = Object.fromEntries(changed.map((f) => [f, git(['diff', '-U0', `${base}...${head}`, '--', f])]));
    return { changed, diffs };
  }
  const committed = git(['diff', '--name-only', `${base}...HEAD`])
    .split('\n')
    .filter(Boolean);
  const working = git(['diff', '--name-only', 'HEAD']).split('\n').filter(Boolean);
  const untracked = git(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
  const changed = [...new Set([...committed, ...working, ...untracked])].sort();
  const diffs = {};
  for (const f of changed) {
    if (untracked.includes(f)) diffs[f] = (readFileSafe(f) ?? '').replace(/^/gm, '+');
    else diffs[f] = git(['diff', '-U0', base, '--', f]);
  }
  return { changed, diffs };
}

function readFileSafe(path) {
  try {
    return readFileSync(resolve(ROOT, path), 'utf8');
  } catch {
    return null;
  }
}

/** 浏览器用例的（尺寸, 文件）清单：Playwright --list；拿不到时按配置估（只给本机看，CI 一定拿得到） */
function listE2eUnits() {
  try {
    const out = execFileSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--list', '--reporter=json'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const report = JSON.parse(out);
    const units = new Map();
    const walk = (suite, file) => {
      const f = suite.file ?? file;
      for (const spec of suite.specs ?? []) for (const t of spec.tests ?? []) units.set(`${t.projectName}|e2e/${spec.file ?? f}`, { project: t.projectName, file: `e2e/${spec.file ?? f}` });
      for (const c of suite.suites ?? []) walk(c, f);
    };
    for (const s of report.suites ?? []) walk(s, s.file);
    return [...units.values()].sort((a, b) => a.project.localeCompare(b.project) || a.file.localeCompare(b.file));
  } catch {
    return null;
  }
}

export function collectRepo({ base, head }) {
  const cache = new Map();
  const read = (path) => {
    if (!cache.has(path)) cache.set(path, readFileSafe(path));
    return cache.get(path);
  };
  const exists = (path) => read(path) !== null;
  const tests = listFiles('tests', /\.test\.ts$/);
  const unitTests = tests.filter((t) => !needsDatabase(t, read, exists));
  const specs = listFiles('e2e', /\.spec\.ts$/);
  const sources = [...listFiles('src', /\.(ts|tsx|mjs)$/), ...tests, ...listFiles('tests', /\.ts$/).filter((f) => !f.endsWith('.test.ts')), ...specs];
  const graph = buildGraph(sources, read, exists);
  const e2eUnits = listE2eUnits() ?? specs.map((file) => ({ project: '门店电脑', file }));
  return { ...readChanges(base, head), tests, unitTests, specs, e2eUnits, graph };
}

// ───────────────────────── 输出 ─────────────────────────

const RISK_LABEL = { docs: '只改文档', mp: '只改小程序包', code: '一般代码', data: '数据写入', high: '高风险（全量）' };

export function describePlan(plan, shards) {
  const lines = [];
  lines.push(`风险：${RISK_LABEL[plan.risk]}　方式：${plan.full ? '全量' : '按改动挑选'}　改到 ${plan.changed.length} 个文件`);
  for (const r of plan.reasons) lines.push(`  · ${r}`);
  lines.push(`秒级用例（不要数据库）：每次全跑`);
  lines.push(`集成测试（要数据库）：${plan.integration.all ? '全量 ' : ''}${plan.integration.files.length} 个文件`);
  if (!plan.integration.all && plan.integration.files.length) lines.push(`  ${plan.integration.files.map((f) => posix.basename(f, '.test.ts')).join('、')}`);
  const specFiles = [...new Set(plan.e2e.units.map((u) => u.file))];
  lines.push(`浏览器验收：${plan.e2e.all ? '全量 ' : ''}${specFiles.length} 个文件（${plan.e2e.units.length} 个尺寸 × 文件）`);
  if (!plan.e2e.all && specFiles.length) lines.push(`  ${specFiles.map((f) => posix.basename(f, '.spec.ts')).join('、')}`);
  lines.push(`另外几个 job：升级 ${plan.jobs.upgrade ? '跑' : '不跑'}，演示数据 ${plan.jobs.demo ? '跑' : '不跑'}，员工食堂 ${plan.jobs.canteen ? '跑' : '不跑'}`);
  if (shards) {
    lines.push(
      `CI 分组：集成测试 ${shards.integration.length} 组（${shards.integration.map((s) => `${s.seconds}s`).join(' / ') || '—'}），浏览器验收 ${shards.e2e.length} 组（${shards.e2e.map((s) => `${s.seconds}s`).join(' / ') || '—'}）`,
    );
  }
  return lines.join('\n');
}

/** 本机照着跑的命令 */
export function commandsFor(plan) {
  const cmds = ['npm run test:unit'];
  if (plan.integration.files.length) cmds.push(plan.integration.all ? 'npm test' : `npx vitest run ${plan.integration.files.join(' ')}`);
  const projects = [...new Set(plan.e2e.units.map((u) => u.project))];
  if (plan.e2e.units.length) {
    const files = plan.e2e.all ? [] : [...new Set(plan.e2e.units.map((u) => u.file))];
    cmds.push(`E2E_BASE_URL=http://127.0.0.1:<端口> npx playwright test ${playwrightArgs(projects, files)}`);
  }
  return cmds;
}

function parseArgs(argv) {
  const args = { base: 'origin/main', head: null, json: false, ci: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') args.base = argv[++i];
    else if (a === '--head') args.head = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--ci') args.ci = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const forceFull = process.env.TEST_PLAN_FULL || '';
  const repo = collectRepo(args);
  const plan = makePlan({ ...repo, forceFull });
  const shards = shardPlan(plan, loadTimings());
  if (args.json) return console.log(JSON.stringify({ ...plan, shards }, null, 2));
  const text = describePlan(plan, shards);
  console.log(text);
  if (!args.ci) {
    const cmds = commandsFor(plan);
    if (cmds.length) console.log(`\n本机照着跑：\n${cmds.map((c) => `  ${c}`).join('\n')}`);
    return;
  }
  writeFileSync(resolve(ROOT, 'test-plan.json'), JSON.stringify({ ...plan, shards }, null, 2));
  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    const set = (k, v) => appendFileSync(out, `${k}=${v}\n`);
    set('mode', plan.full ? 'full' : 'selective');
    set('risk', plan.risk);
    set('integration', JSON.stringify(shards.integration));
    set('integration_count', String(shards.integration.length));
    set('e2e', JSON.stringify(shards.e2e));
    set('e2e_count', String(shards.e2e.length));
    set('upgrade', String(plan.jobs.upgrade));
    set('demo', String(plan.jobs.demo));
    set('canteen', String(plan.jobs.canteen));
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### 测试计划\n\n\`\`\`\n${text}\n\`\`\`\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
