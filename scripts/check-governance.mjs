// 治理基线（工程治理一期，docs/GOVERNANCE.md）：CI 跑，挂了不能合。npm run check:gov
// 把「容易越积越多」的几样记成基线（scripts/governance-baseline.json），只许持平或下降：
//   1. 分层：shared 不引 server / client，client 不引 server，server 不引 client（硬规则，一处都不许）；
//   2. 页面代码里的十六进制颜色（按目录记数，不许变多；颜色该进样式表的变量）；
//   3. 页面代码里手写的字号 text-[Npx]（不许出现基线以外的新字号）；
//   4. 超过 1,500 行的源文件（不许有新的）；
//   5. 导出了却没有任何地方引用的函数、常量、类型（knip；不许有新的）；用到了没声明的依赖、声明了没用到的依赖（硬规则，一处都不许）；
//   6. 重复代码的比例（jscpd；不许超过上限）；
//   7. docs/CONVENTIONS.md 里能查的几条约定（三期）：不看 navigator.onLine、不手写 status < 500、新的定时取数用 useLivePoll（查 refetchInterval）、
//      行内样式里不写 dvh（各记一个数，不许变多）；用例里不许留 .only（硬规则）。
// 数字变少了不用管，想把基线收紧跑 npm run check:gov -- --update（只会调低；调高要加 --allow-increase 并在 PR 里说明原因）。
// 小程序线的目录与文件（scripts/check-line-scope.mjs 认作小程序线自己的）不查。退出码：0 通过，1 有问题。

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { classify } from './check-line-scope.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const BASELINE_FILE = 'scripts/governance-baseline.json';
const isMpLine = (path) => classify({ status: 'M', path }).kind === 'free';

/** 多少行以上算大文件 */
export const LARGE_FILE_LINES = 1500;
/** jscpd 的口径：70 个词、8 行起算一处重复 */
const CPD_MIN_TOKENS = 70;
const CPD_MIN_LINES = 8;

/** 页面代码：这些目录里的十六进制颜色与手写字号要记数 */
const PAGE_ROOTS = ['src/client/', 'src/canteen-app/'];

/** 颜色记到哪一级目录：src/client/features/<模块>、src/client/<目录>、src/canteen-app */
export function colorBucket(file) {
  const parts = file.split('/');
  if (file.startsWith('src/client/features/')) return parts.slice(0, 4).join('/');
  if (file.startsWith('src/client/')) return parts.length > 3 ? parts.slice(0, 3).join('/') : 'src/client';
  return parts.slice(0, 2).join('/');
}

const HEX_COLOR = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-zA-Z_-])/g;
const FONT_SIZE = /\btext-\[(\d+(?:\.\d+)?)px\]/g;

/** 一份页面源码里（只看字符串、模板、JSX 文字，注释不算）：{ hex: 个数, fontSizes: { 字号: 次数 } } */
export function scanPageCode(fileName, code) {
  const src = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, false, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let hex = 0;
  let inlineDvh = 0;
  const fontSizes = {};
  const look = (text) => {
    hex += (text.match(HEX_COLOR) ?? []).length;
    // 行内样式里的 dvh（类名里的是 max-h-[88dvh] 这种带方括号的写法，打包时会补 vh；行内的补不到）
    if (/\d(?:d|s|l)vh\b/.test(text) && !text.includes('[')) inlineDvh += 1;
    for (const m of text.matchAll(FONT_SIZE)) fontSizes[m[1]] = (fontSizes[m[1]] ?? 0) + 1;
  };
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) look(node.text);
    ts.forEachChild(node, visit);
  };
  visit(src);
  return { hex, fontSizes, inlineDvh };
}

/**
 * 约定（docs/CONVENTIONS.md「公共小工具」「屏幕高度」里能查的几条，三期）：存量记数、不许变多。
 * scope 是查哪些目录，allow 是这条约定自己的实现所在、不算。
 */
export const CONVENTION_RULES = [
  {
    key: 'navigator.onLine',
    pattern: /\bnavigator\.onLine\b/g,
    scope: ['src/client/', 'src/canteen-app/'],
    allow: ['src/client/lib/connection.ts'],
    hint: '判断断网用 lib/connection 的 useConnection / onReconnect，不看 navigator.onLine（它在连着路由器、连不上服务器时也是 true）',
  },
  {
    key: 'status-500',
    pattern: /\bstatus\s*(?:<|>=)\s*500\b/g,
    scope: ['src/client/', 'src/canteen-app/'],
    allow: ['src/client/lib/api.ts'],
    hint: '判断「服务端明确没处理」用 lib/api 的 isRejected，不手写 status < 500',
  },
  // 只认 refetchInterval（react-query 的定时取数，一定是在取数）。setInterval 不查：倒计时、轮播、「现在几点」这类纯界面的计时器
  // 也用它，静态分不清回调里取没取数（Codex 审查 ca1f116：都算进来会把合法的界面计时器拦下，还提示换成语义不同的工具）
  {
    key: 'polling',
    pattern: /\brefetchInterval\b/g,
    scope: ['src/client/features/', 'src/client/components/'],
    allow: [],
    hint: '新的定时取数用 lib/livePoll 的 useLivePoll（后台不取、断网不取、回到页面与网络恢复时马上取），不用 refetchInterval；纯界面的计时器（倒计时、轮播）不在此列',
  },
  // 8.1.17（《浴族系统需求汇总》系统整体，docs/YUZU_REQ_V8117.md YS-1、YS-5）：小于 12 像素的字、手写的表格与弹窗只降不升。
  // allow 里以 / 结尾的是整个目录：打印的纸样（80mm 小票、标签、巡场码、开通卡按毫米排）、平板电子菜单的版面（按设计稿等比缩放）、
  // 工作台画布上的量距标注、图表的坐标刻度不算小字；公共部件自己的实现不算手写
  {
    key: 'small-text',
    pattern: /\btext-\[(?:\d|1[01])(?:\.\d+)?px\]/g,
    scope: ['src/client/', 'src/canteen-app/'],
    allow: [
      'src/client/features/print/',
      'src/client/features/emenu/',
      'src/client/features/canteen/CardsPrintPage.tsx',
      'src/client/features/canteen/PosterPrintPage.tsx',
      'src/client/features/assets/AssetLabelsPrintPage.tsx',
      'src/client/features/patrol/CodesPrintPage.tsx',
      'src/client/features/studio/Canvas.tsx',
      'src/client/features/studio/TemplateCanvas.tsx',
      'src/client/features/dashboard/charts.tsx',
    ],
    hint: '屏幕上给人读的字不小于 12 像素（text-[12px] 起）；打印的纸样、平板电子菜单的版面、画布上的量距、图表刻度除外（docs/YUZU_REQ_V8117.md YS-1）',
  },
  {
    key: 'raw-table',
    pattern: /<table\b/g,
    scope: ['src/client/', 'src/canteen-app/'],
    allow: ['src/client/components/DataTable.tsx', 'src/client/features/print/'],
    hint: '表格用公共的 DataTable（src/client/components/DataTable.tsx：表头、对齐、金额等宽、空态、加载失败、窄屏横向滚动都在里面），不再手写 <table>',
  },
  {
    key: 'raw-dialog',
    pattern: /role=(?:"dialog"|'dialog'|\{'dialog'\})/g,
    scope: ['src/client/', 'src/canteen-app/'],
    allow: ['src/client/components/Overlay.tsx', 'src/client/features/emenu/'],
    hint: '弹窗用公共的 Dialog / Sheet（src/client/components/Overlay.tsx：遮罩、Esc、焦点、手机上全屏都在里面），不再自己画',
  },
];

/** allow 里的一项管不管这个文件：以 / 结尾的是整个目录 */
const allowed = (allow, file) => allow.some((a) => (a.endsWith('/') ? file.startsWith(a) : a === file));

/** 去掉注释（约定检查只看代码；注释里提到这些写法不算） */
export function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

/** 一份源码里各条约定的次数：{ 约定: 次数 }（不在这条约定范围里的不算） */
export function conventionCounts(file, code) {
  const counts = {};
  const text = stripComments(code);
  for (const rule of CONVENTION_RULES) {
    if (!rule.scope.some((dir) => file.startsWith(dir)) || allowed(rule.allow, file)) continue;
    const n = (text.match(rule.pattern) ?? []).length;
    if (n) counts[rule.key] = n;
  }
  return counts;
}

/** 用例里留着的 .only（跑的时候别的用例会被悄悄跳过）：返回行号。按语法树认调用，字符串、注释里的字样不算 */
export function focusedTests(code, fileName = 'x.test.ts') {
  const src = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, false);
  const found = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'only') {
      // it.only(…)、test.only(…)、describe.only(…)，以及 test.describe.only(…) 这类多一层的
      let root = node.expression.expression;
      while (ts.isPropertyAccessExpression(root)) root = root.expression;
      if (ts.isIdentifier(root) && ['it', 'test', 'describe'].includes(root.text)) found.push(src.getLineAndCharacterOfPosition(node.expression.name.getStart(src)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return found;
}

const LAYER_RULES = [
  { from: 'src/shared/', banned: ['src/server/', 'src/client/', 'src/canteen-app/', 'src/gateway/'], why: 'shared 是前后端共用的，不能引服务端或页面的代码' },
  { from: 'src/client/', banned: ['src/server/', 'src/gateway/'], why: '页面不能引服务端的代码（共用的放 src/shared）' },
  { from: 'src/canteen-app/', banned: ['src/server/', 'src/gateway/'], why: '页面不能引服务端的代码（共用的放 src/shared）' },
  { from: 'src/server/', banned: ['src/client/', 'src/canteen-app/'], why: '服务端不能引页面的代码（共用的放 src/shared）' },
];

/** 一份源码里违反分层的引用：[{ specifier, target, why }] */
export function layerViolations(file, code) {
  const rule = LAYER_RULES.find((r) => file.startsWith(r.from));
  if (!rule) return [];
  const found = [];
  for (const { fileName: specifier } of ts.preProcessFile(code, true, true).importedFiles) {
    let target = null;
    if (specifier.startsWith('.')) target = posix.normalize(posix.join(posix.dirname(file), specifier));
    else if (specifier.startsWith('@shared/')) target = `src/shared/${specifier.slice('@shared/'.length)}`;
    else if (specifier.startsWith('@client/')) target = `src/client/${specifier.slice('@client/'.length)}`;
    if (target && rule.banned.some((b) => `${target}/`.startsWith(b))) found.push({ specifier, target, why: rule.why });
  }
  return found;
}

/**
 * 现在的数字与基线比：{ problems: 变多了的（不通过）, notes: 变少了的（可以收紧基线） }。
 * current / baseline：{ hexColors: {目录: 个数}, fontSizes: [字号], largeFiles: [文件], deadExports: ['文件:名字'], duplicationPercent / duplicationMaxPercent }
 */
export function compareBaseline(baseline, current) {
  const problems = [];
  const notes = [];

  const moreColors = Object.entries(current.hexColors)
    .filter(([dir, n]) => n > (baseline.hexColors[dir] ?? 0))
    .map(([dir, n]) => `${dir}：${baseline.hexColors[dir] ?? 0} → ${n}`);
  if (moreColors.length)
    problems.push(`页面代码里的十六进制颜色变多了（颜色用样式表里的变量，如 var(--color-…) 或 Tailwind 的色名；设计工具里确实要新加的在 PR 里说明后调基线）：\n  ${moreColors.join('\n  ')}`);
  const fewerColors = Object.entries(baseline.hexColors).filter(([dir, n]) => (current.hexColors[dir] ?? 0) < n).length;
  if (fewerColors) notes.push(`十六进制颜色有 ${fewerColors} 个目录变少了`);

  const knownSizes = new Set(baseline.fontSizes);
  const newSizes = current.fontSizes.filter((s) => !knownSizes.has(s));
  if (newSizes.length) problems.push(`页面里出现了基线以外的新字号（用已有的字号，不要再多一种）：${newSizes.map((s) => `text-[${s}px]`).join('、')}`);
  const goneSizes = baseline.fontSizes.filter((s) => !current.fontSizes.includes(s)).length;
  if (goneSizes) notes.push(`手写字号少了 ${goneSizes} 种`);

  const knownLarge = new Set(baseline.largeFiles);
  const newLarge = current.largeFiles.filter((f) => !knownLarge.has(f));
  if (newLarge.length) problems.push(`新出现了超过 ${LARGE_FILE_LINES} 行的源文件（按职责拆开，或把整段独立的部分搬到新文件）：\n  ${newLarge.join('\n  ')}`);
  const goneLarge = baseline.largeFiles.filter((f) => !current.largeFiles.includes(f)).length;
  if (goneLarge) notes.push(`大文件少了 ${goneLarge} 个`);

  const knownDead = new Set(baseline.deadExports);
  const newDead = current.deadExports.filter((e) => !knownDead.has(e));
  if (newDead.length) problems.push(`导出了却没有任何地方引用（没用就删掉；只在本文件用就去掉 export）：\n  ${newDead.join('\n  ')}`);
  const goneDead = baseline.deadExports.filter((e) => !current.deadExports.includes(e)).length;
  if (goneDead) notes.push(`没人引用的导出少了 ${goneDead} 个`);

  const worseConventions = Object.entries(current.conventions ?? {})
    .filter(([key, n]) => n > (baseline.conventions?.[key] ?? 0))
    .map(
      ([key, n]) =>
        `${key}：${baseline.conventions?.[key] ?? 0} → ${n}。${key === 'inline-dvh' ? '行内样式里不要写 dvh（打包时补不到 vh，老浏览器上整屏版面会没有高度），改用类名 h-dvh、max-h-[88dvh]' : (CONVENTION_RULES.find((r) => r.key === key)?.hint ?? '')}`,
    );
  if (worseConventions.length) problems.push(`没照约定写的地方变多了（docs/CONVENTIONS.md）：\n  ${worseConventions.join('\n  ')}`);
  const fewerConventions = Object.entries(baseline.conventions ?? {}).filter(([key, n]) => (current.conventions?.[key] ?? 0) < n).length;
  if (fewerConventions) notes.push(`没照约定写的地方有 ${fewerConventions} 条变少了`);

  if (current.duplicationPercent > baseline.duplicationMaxPercent)
    problems.push(
      `重复代码 ${current.duplicationPercent.toFixed(2)}%，超过上限 ${baseline.duplicationMaxPercent}%（把重复的部分抽成公共函数或部件；看是哪几处：npx jscpd src --min-tokens ${CPD_MIN_TOKENS} --min-lines ${CPD_MIN_LINES}）`,
    );
  return { problems, notes };
}

/** --update 时：新的基线里有没有比旧的宽的（返回说明；空数组 = 只收紧了） */
export function loosened(oldBase, newBase) {
  const out = [];
  for (const [dir, n] of Object.entries(newBase.hexColors)) if (n > (oldBase.hexColors[dir] ?? 0)) out.push(`颜色 ${dir}：${oldBase.hexColors[dir] ?? 0} → ${n}`);
  for (const [key, n] of Object.entries(newBase.conventions ?? {})) if (oldBase.conventions && n > (oldBase.conventions[key] ?? 0)) out.push(`约定 ${key}：${oldBase.conventions[key] ?? 0} → ${n}`);
  for (const key of ['fontSizes', 'largeFiles', 'deadExports']) {
    const known = new Set(oldBase[key]);
    for (const item of newBase[key]) if (!known.has(item)) out.push(`${key} 新增 ${item}`);
  }
  return out;
}

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

function scanSources() {
  const hexColors = {};
  const sizeCounts = {};
  const largeFiles = [];
  const layers = [];
  const conventions = {};
  const bump = (key, n) => {
    if (n) conventions[key] = (conventions[key] ?? 0) + n;
  };
  for (const abs of sourceFiles(join(ROOT, 'src'))) {
    const file = relative(ROOT, abs).split('\\').join('/');
    if (isMpLine(file)) continue;
    const code = readFileSync(abs, 'utf8');
    if (code.split('\n').length > LARGE_FILE_LINES) largeFiles.push(file);
    for (const v of layerViolations(file, code)) layers.push(`${file}  引了 ${v.specifier}（${v.why}）`);
    for (const [key, n] of Object.entries(conventionCounts(file, code))) bump(key, n);
    if (PAGE_ROOTS.some((r) => file.startsWith(r))) {
      const { hex, fontSizes, inlineDvh } = scanPageCode(file, code);
      bump('inline-dvh', inlineDvh);
      if (hex) hexColors[colorBucket(file)] = (hexColors[colorBucket(file)] ?? 0) + hex;
      for (const [size, n] of Object.entries(fontSizes)) sizeCounts[size] = (sizeCounts[size] ?? 0) + n;
    }
  }
  const fontSizes = Object.keys(sizeCounts).sort((a, b) => Number(a) - Number(b));
  // 用例里的 .only
  const focused = [];
  for (const dir of ['tests', 'e2e', 'e2e-canteen']) {
    let files = [];
    try {
      files = sourceFiles(join(ROOT, dir));
    } catch {
      continue;
    }
    for (const abs of files) {
      const file = relative(ROOT, abs).split('\\').join('/');
      for (const line of focusedTests(readFileSync(abs, 'utf8'), file)) focused.push(`${file}:${line}`);
    }
  }
  return { hexColors, fontSizes, fontSizeUses: Object.values(sizeCounts).reduce((a, b) => a + b, 0), largeFiles: largeFiles.sort(), layers, conventions, focused };
}

/** 依赖包的命令行入口（读它 package.json 的 bin，不写死路径） */
function binOf(pkg) {
  const meta = JSON.parse(readFileSync(join(ROOT, 'node_modules', pkg, 'package.json'), 'utf8'));
  const bin = typeof meta.bin === 'string' ? meta.bin : meta.bin[pkg];
  return join('node_modules', pkg, bin);
}

function runKnip() {
  let out = '';
  try {
    out = execFileSync(
      process.execPath,
      ['--max-old-space-size=4096', binOf('knip'), '--no-exit-code', '--no-progress', '--include', 'exports,types,dependencies,devDependencies,unlisted', '--reporter', 'json'],
      {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (e) {
    throw new Error(`knip 没跑起来：${e.stderr || e.message}`);
  }
  const dead = [];
  const deps = [];
  for (const issue of JSON.parse(out).issues ?? []) {
    if (isMpLine(issue.file)) continue;
    for (const kind of ['exports', 'types']) for (const item of issue[kind] ?? []) dead.push(`${issue.file}:${item.name}`);
    for (const item of issue.unlisted ?? []) deps.push(`${issue.file} 用到了 ${item.name}，package.json 里没声明（间接装上的不算数，哪天上游不带它就断了）`);
    for (const kind of ['dependencies', 'devDependencies'])
      for (const item of issue[kind] ?? []) deps.push(`package.json 声明了 ${item.name}，没有任何地方用到（不用就删；只在样式表或脚本里用的加进 knip.json 的 ignoreDependencies）`);
  }
  return { dead: dead.sort(), deps };
}

function runJscpd() {
  const dir = mkdtempSync(join(tmpdir(), 'yuzu-cpd-'));
  try {
    const ignore = ['**/migrations/**', '**/gateway/**', '**/modules/mp/**', '**/features/mp/**', '**/shared/mp.ts', '**/public/**'].join(',');
    execFileSync(
      process.execPath,
      [
        binOf('jscpd'),
        'src',
        '--min-tokens',
        String(CPD_MIN_TOKENS),
        '--min-lines',
        String(CPD_MIN_LINES),
        '--format',
        'typescript,tsx',
        '--ignore',
        ignore,
        '--reporters',
        'json',
        '--output',
        dir,
        '--silent',
      ],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const total = JSON.parse(readFileSync(join(dir, 'jscpd-report.json'), 'utf8')).statistics.total;
    return { percent: Number(total.percentage), lines: total.duplicatedLines, clones: total.clones };
  } catch (e) {
    throw new Error(`jscpd 没跑起来：${e.stderr || e.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const update = process.argv.includes('--update');
  const allowIncrease = process.argv.includes('--allow-increase');
  const scanned = scanSources();
  const { dead: deadExports, deps } = runKnip();
  const cpd = runJscpd();
  const current = { hexColors: scanned.hexColors, fontSizes: scanned.fontSizes, largeFiles: scanned.largeFiles, deadExports, duplicationPercent: cpd.percent, conventions: scanned.conventions };

  let baseline = null;
  try {
    baseline = JSON.parse(readFileSync(join(ROOT, BASELINE_FILE), 'utf8'));
  } catch {
    if (!update) {
      console.error(`✗ 没有基线文件 ${BASELINE_FILE}：跑 npm run check:gov -- --update --allow-increase 生成`);
      process.exit(1);
    }
  }

  if (update) {
    const next = {
      说明: '治理基线（docs/GOVERNANCE.md）：npm run check:gov 拿现在的数字和这里比，只许持平或下降。清掉一批以后跑 npm run check:gov -- --update 收紧；不要为了让检查通过手改这个文件。',
      hexColors: Object.fromEntries(Object.entries(current.hexColors).sort(([a], [b]) => (a < b ? -1 : 1))),
      fontSizes: current.fontSizes,
      largeFiles: current.largeFiles,
      deadExports: current.deadExports,
      conventions: Object.fromEntries(Object.entries(current.conventions).sort(([a], [b]) => (a < b ? -1 : 1))),
      // 上限留一点余量：比现在的比例高 0.2 个百分点，最少 1%
      duplicationMaxPercent: baseline && !allowIncrease ? baseline.duplicationMaxPercent : Math.max(1, Math.ceil((cpd.percent + 0.2) * 10) / 10),
      // 首屏主包的上限（KB）：npm run check:bundle 在构建之后核对，这里原样带过去
      entryChunkMaxKb: baseline?.entryChunkMaxKb ?? 900,
    };
    const wider = baseline ? loosened(baseline, next) : [];
    if (wider.length && !allowIncrease) {
      console.error(`✗ 基线只许收紧，这次会放宽 ${wider.length} 处（确实要放宽的加 --allow-increase，并在 PR 里说明原因）：\n  ${wider.join('\n  ')}`);
      process.exit(1);
    }
    writeFileSync(join(ROOT, BASELINE_FILE), `${JSON.stringify(next, null, 2)}\n`);
    console.log(`已写入 ${BASELINE_FILE}`);
    baseline = next;
  }

  const { problems, notes } = compareBaseline(baseline, current);
  if (scanned.focused.length) problems.unshift(`用例里留着 .only（别的用例会被悄悄跳过），去掉：\n  ${scanned.focused.join('\n  ')}`);
  if (deps.length) problems.unshift(`依赖的声明与用到的对不上 ${deps.length} 处：\n  ${deps.join('\n  ')}`);
  if (scanned.layers.length) problems.unshift(`分层被打破 ${scanned.layers.length} 处：\n  ${scanned.layers.join('\n  ')}`);
  if (problems.length) {
    console.error(`✗ 治理基线没过（docs/GOVERNANCE.md）：\n\n${problems.join('\n\n')}`);
    process.exit(1);
  }
  const colorTotal = Object.values(current.hexColors).reduce((a, b) => a + b, 0);
  console.log(
    `✓ 治理基线通过：分层 0 处违反、依赖声明与用到的一致；页面里十六进制颜色 ${colorTotal} 处、手写字号 ${current.fontSizes.length} 种（${scanned.fontSizeUses} 处）、` +
      `超过 ${LARGE_FILE_LINES} 行的文件 ${current.largeFiles.length} 个、没人引用的导出 ${deadExports.length} 个、重复代码 ${cpd.percent.toFixed(2)}%（${cpd.lines} 行）、` +
      `没照约定写的 ${Object.values(current.conventions).reduce((a, b) => a + b, 0)} 处（${Object.entries(current.conventions)
        .map(([k, n]) => `${k} ${n}`)
        .join('、')}）`,
  );
  if (notes.length && !update) console.log(`  比基线少了：${notes.join('；')}。可以跑 npm run check:gov -- --update 把基线收紧`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
