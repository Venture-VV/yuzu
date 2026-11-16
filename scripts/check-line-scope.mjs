// 线范围检查（8.1.0，docs/RELEASE_V810.md 第 3 节）：小程序线（店主 2026-11-15 起交给 Gemini）的 PR 只改小程序线自己的文件。
// 由 .github/workflows/line-scope.yml 在 pull_request_target 上运行：用的是 main 上的这份脚本与工作流，PR 自己改不了它们；
// 只读 PR 改了哪些文件（git diff --name-status），不执行 PR 里的任何代码。
//
// 用法：node scripts/check-line-scope.mjs --base <提交> --head <提交或引用>
//   分支名、标题、标签从环境变量 PR_BRANCH、PR_TITLE、PR_LABELS 读（标签用换行或逗号分开）；
//   有 GITHUB_STEP_SUMMARY 时把结果也写进检查的摘要页。退出码：0 通过，1 有不该改的文件，2 用法或 git 出错。

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MP_LINE_LABEL = '小程序线';
export const MP_LINE_TITLE = '【小程序线】';
export const MP_LINE_BRANCH = 'gemini/';

/** 小程序线自己的目录（docs/MINIPROGRAM.md 第 2、8 节） */
const FREE_DIRS = ['miniprogram/', 'src/gateway/', 'src/server/modules/mp/', 'src/client/features/mp/'];
/** 小程序线自己的单个文件：共用类型、网关的 Compose、小程序线的文档 */
const FREE_FILES = new Set(['src/shared/mp.ts', 'compose.mp.yaml', 'docs/MINIPROGRAM.md', 'docs/DEPLOY_GATEWAY.md']);
/** 小程序线自己的用例与文档（按文件名） */
const FREE_PATTERNS = [/^tests\/mp-[^/]+\.test\.ts$/, /^tests\/gateway[^/]*\.test\.ts$/, /^e2e\/mp-[^/]+\.ts$/, /^docs\/MP_[^/]+\.md$/, /^docs\/HANDOFF_MP[^/]*\.md$/];
/** 名字像小程序线、其实是主线写给小程序线的入口与它们的用例（src/server/modules/mp-entries.ts、领券入口） */
const MAINLINE_LOOKALIKES = new Set(['tests/mp-entries.test.ts', 'tests/mp-claim-coupon.test.ts']);
/** 登记处：允许改，但只该是「加挂接的几行」，列出来请主线开发会话复核 */
export const REGISTRY = new Map([
  ['src/server/app.ts', '挂接路由'],
  ['src/shared/permissions.ts', '权限表'],
  ['src/client/App.tsx', '页面路由'],
  ['src/server/lib/audit.ts', '审计动作'],
  ['src/shared/admin.ts', '后台分区'],
  ['src/server/config.ts', '小程序线的环境变量'],
  ['src/shared/types.ts', '共用类型'],
  ['tests/helpers.ts', '用例的迁移清单'],
  ['.env.example', '环境变量样例'],
  ['docs/ROADMAP.md', '迁移号登记与更新记录'],
  ['docs/PENDING_DECISIONS.md', '小程序线的待确认'],
  ['docs/DEPLOY_MAC_MINI.md', '部署手册里小程序端口、网关的几段'],
  ['docs/DEPLOY_TEST_SERVER.md', '部署手册里小程序端口、网关的几段'],
  ['GEMINI.md', 'Gemini 的说明'],
  ['.gemini/settings.json', 'Gemini 的项目设置'],
]);
/** 小程序线可以新加的迁移：NNN_mp_<用途>.sql（号先在 ROADMAP 第 7 节登记） */
const MP_MIGRATION = /^src\/server\/migrations\/[0-9]{3}_mp_[a-z0-9_]+\.sql$/;

/** 是不是小程序线的 PR：分支 gemini/…、标题【小程序线】开头、带「小程序线」标签，有一样就算 */
export function isMpLinePr({ branch = '', title = '', labels = [] } = {}) {
  return branch.startsWith(MP_LINE_BRANCH) || title.trim().startsWith(MP_LINE_TITLE) || labels.some((l) => l.trim() === MP_LINE_LABEL);
}

/** 解析 git diff --name-status -M 的输出：[{ status: 'A'|'M'|'D'|'R'|'C'|'T', path, from? }] */
export function parseNameStatus(text) {
  const changes = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const [code, a, b] = line.split('\t');
    const status = code[0];
    if ((status === 'R' || status === 'C') && b) changes.push({ status, from: a, path: b });
    else changes.push({ status, path: a });
  }
  return changes;
}

function isFree(path) {
  if (MAINLINE_LOOKALIKES.has(path)) return false;
  return FREE_DIRS.some((d) => path.startsWith(d)) || FREE_FILES.has(path) || FREE_PATTERNS.some((p) => p.test(path));
}

/**
 * 一个改动归哪一类：
 *   free 小程序线自己的；registry 登记处（列出来复核）；migration 新加的小程序线迁移（核对号登记过）；
 *   blocked 不该改的（reason 写为什么、该怎么办）
 */
export function classify(change) {
  const { status, path, from } = change;
  if (path.startsWith('src/server/migrations/') || from?.startsWith('src/server/migrations/')) {
    if (status === 'A' && MP_MIGRATION.test(path)) return { kind: 'migration' };
    if (status === 'A') return { kind: 'blocked', reason: '小程序线的新迁移要叫 NNN_mp_<用途>.sql（号先在 docs/ROADMAP.md 第 7 节登记）' };
    return { kind: 'blocked', reason: '迁移只增不改：已有的迁移不能改、删、改名，新变化写新的迁移' };
  }
  // 改名、复制：两头都得是小程序线自己的
  const paths = from && status === 'R' ? [from, path] : [path];
  if (paths.every(isFree)) return { kind: 'free' };
  if (paths.length === 1 && REGISTRY.has(path)) {
    if (status === 'D') return { kind: 'blocked', reason: '登记处的文件不能删' };
    return { kind: 'registry', note: REGISTRY.get(path) };
  }
  if (MAINLINE_LOOKALIKES.has(path)) return { kind: 'blocked', reason: '这是主线给小程序线的入口的用例；要改入口请在主线开着的 PR 上留言，由主线改' };
  return { kind: 'blocked', reason: '不在小程序线的范围里（会员、钱包、券、结账、前台等核心只由主线改）；要核心加能力，在主线开着的 PR 上留言写清需求' };
}

/** 汇总：ok = 没有 blocked */
export function checkLineScope(changes) {
  const result = { free: [], registry: [], migrations: [], blocked: [] };
  for (const c of changes) {
    const r = classify(c);
    const shown = c.from && c.status === 'R' ? `${c.from} → ${c.path}` : c.path;
    if (r.kind === 'free') result.free.push(shown);
    else if (r.kind === 'registry') result.registry.push({ path: shown, note: r.note });
    else if (r.kind === 'migration') result.migrations.push(shown);
    else result.blocked.push({ path: shown, status: c.status, reason: r.reason });
  }
  return { ok: result.blocked.length === 0, ...result };
}

/** 主线等别的 PR 改到了小程序线的目录：只提醒，不拦（测试会话加用例、合并冲突时会碰到） */
export function mpFilesTouched(changes) {
  return changes.filter((c) => [c.path, c.from].some((p) => p && !MAINLINE_LOOKALIKES.has(p) && (FREE_DIRS.some((d) => p.startsWith(d)) || p === 'src/shared/mp.ts'))).map((c) => c.path);
}

/** 写给人看的结果（Markdown，检查的摘要页与日志共用） */
export function report(pr, changes) {
  const lines = [];
  if (!isMpLinePr(pr)) {
    lines.push(`不是小程序线的 PR（分支 \`${pr.branch || '—'}\`），这个检查不管，通过。`);
    const touched = mpFilesTouched(changes);
    if (touched.length) {
      lines.push('', `提醒：这个 PR 改到了小程序线的文件（${touched.length} 个），小程序线由 Gemini 开发，请在 PR 说明里写明为什么：`);
      for (const p of touched.slice(0, 30)) lines.push(`- \`${p}\``);
    }
    return { ok: true, text: lines.join('\n') };
  }
  const r = checkLineScope(changes);
  lines.push(r.ok ? `**通过**：小程序线的 PR，改了 ${changes.length} 个文件，都在小程序线的范围里。` : `**不通过**：小程序线的 PR 改了 ${r.blocked.length} 个不该改的文件。`);
  if (r.blocked.length) {
    lines.push('', '### 不该改的（先撤掉，或在主线开着的 PR 上留言请主线改）');
    for (const b of r.blocked) lines.push(`- \`${b.path}\`（${b.status}）：${b.reason}`);
  }
  if (r.migrations.length) {
    lines.push('', '### 新加的迁移（核对号已在 docs/ROADMAP.md 第 7 节登记、只建小程序线自己的表）');
    for (const m of r.migrations) lines.push(`- \`${m}\``);
  }
  if (r.registry.length) {
    lines.push('', '### 登记处（允许，请主线开发会话复核只是加挂接的几行）');
    for (const g of r.registry) lines.push(`- \`${g.path}\`：${g.note}`);
  }
  lines.push('', `小程序线自己的文件：${r.free.length} 个。规则见 docs/RELEASE_V810.md 第 3 节、AGENTS.md「四个 AI 按线协作」。`);
  return { ok: r.ok, text: lines.join('\n') };
}

function argOf(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = argOf('--base');
  const head = argOf('--head');
  if (!base || !head) {
    console.error('用法：node scripts/check-line-scope.mjs --base <提交> --head <提交或引用>');
    process.exit(2);
  }
  let diff;
  try {
    // 三个点：从两边的分叉点算起，只看 PR 这边改了什么
    diff = execFileSync('git', ['diff', '--name-status', '-M', `${base}...${head}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    console.error(`✗ git diff 出错：${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  const pr = {
    branch: process.env.PR_BRANCH ?? '',
    title: process.env.PR_TITLE ?? '',
    labels: (process.env.PR_LABELS ?? '')
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean),
  };
  const { ok, text } = report(pr, parseNameStatus(diff));
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## 线范围检查\n\n${text}\n`);
  process.exit(ok ? 0 : 1);
}
