// 测试分三档（工程治理三期，docs/TESTING.md 第 4 节）：
//   npm run test:unit    秒级：不要数据库的用例（看导入关系自动认，不用改文件名）。写代码途中随时跑。
//   npm run test:quick   快测：秒级那一档 + 和这次改动沾边的集成测试（按改到的模块名找用例文件）。写完一块跑一次。
//   npm test             门禁：全量，交 PR 前与 CI 跑。
// 加 --list 只列出会跑哪些文件、不跑。快测按文件名猜、会漏（例如改钱包会影响前台的用例），不能代替全量。

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');

/** 引了这些文件之一，就算要数据库 */
const DB_MARKERS = new Set(['tests/helpers.ts', 'tests/test-db.ts', 'src/server/db.ts']);
/** 直接引了这些包之一，也算 */
const DB_PACKAGES = new Set(['postgres']);

/** 一个导入写法指到仓库里的哪个文件（第三方包返回 null） */
export function resolveImport(fromFile, specifier, exists) {
  let base = null;
  if (specifier.startsWith('.')) base = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  else if (specifier.startsWith('@shared/')) base = `src/shared/${specifier.slice('@shared/'.length)}`;
  else if (specifier.startsWith('@client/')) base = `src/client/${specifier.slice('@client/'.length)}`;
  if (base === null) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}/index.ts`, `${base}/index.tsx`]) if (exists(candidate)) return candidate;
  return null;
}

/** 一份源码运行时会引到的模块（只引类型的不算：import type、全是 type 的花括号；动态 import() 算） */
export function runtimeImports(fileName, code) {
  const src = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, false, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found = [];
  for (const st of src.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const clause = st.importClause;
      const named = clause?.namedBindings;
      const typeOnly = clause?.isTypeOnly || (clause && !clause.name && named && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly));
      if (!typeOnly) found.push(st.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) && !st.isTypeOnly) found.push(st.moduleSpecifier.text);
  }
  // 动态 import('…')：走一遍语法树找（字符串里写着 import( 的不算）
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) found.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(src);
  return found;
}

/** 一个用例文件要不要数据库：顺着导入关系找，碰到数据库连接、用例的公共准备（建库、迁移）就算要 */
export function needsDatabase(testFile, read, exists) {
  const seen = new Set();
  const stack = [testFile];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (DB_MARKERS.has(file)) return true;
    const code = read(file);
    if (code === null) continue;
    for (const specifier of runtimeImports(file, code)) {
      if (DB_PACKAGES.has(specifier)) return true;
      const target = resolveImport(file, specifier, exists);
      if (target && /\.(ts|tsx|mjs)$/.test(target)) stack.push(target);
    }
  }
  return false;
}

/** 改到的文件 → 关键词（模块名）：用来按文件名找沾边的用例 */
export function keywordsOf(changedFile) {
  const patterns = [
    /^src\/server\/modules\/([^/.]+)/,
    /^src\/server\/(?:lib|ops|auth|integrations|devices|floorplan)\/([^/.]+)/,
    /^src\/shared\/([^/.]+)/,
    /^src\/client\/features\/([^/.]+)/,
    /^src\/client\/lib\/([^/.]+)/,
    /^scripts\/([^/.]+)/,
    /^tests\/([^/.]+)\.test\.ts$/,
  ];
  for (const p of patterns) {
    const m = p.exec(changedFile);
    if (m) return [m[1].toLowerCase()];
  }
  return [];
}

/** 用例文件名和关键词沾不沾边：整个词或它的单数形式出现在文件名里（wallet 对上 wallet-limits，coupons 对上 mp-claim-coupon） */
export function matchesKeyword(testFile, keyword) {
  const name = posix
    .basename(testFile)
    .replace(/\.test\.ts$/, '')
    .toLowerCase();
  const stems = new Set([keyword, keyword.replace(/s$/, ''), keyword.replace(/ies$/, 'y')]);
  return [...stems].some((s) => s.length >= 3 && name.includes(s));
}

function changedFiles() {
  const run = (args) => {
    try {
      return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };
  // 相对 main 改过的 + 还没提交的
  return [...new Set([...run(['diff', '--name-only', 'origin/main...HEAD']), ...run(['diff', '--name-only', 'HEAD']), ...run(['ls-files', '--others', '--exclude-standard'])])];
}

function main() {
  const [tier, ...rest] = process.argv.slice(2);
  const listOnly = rest.includes('--list');
  if (tier !== 'unit' && tier !== 'quick') {
    console.error('用法：node scripts/test-tiers.mjs unit|quick [--list]');
    process.exit(2);
  }
  const cache = new Map();
  const read = (path) => {
    if (!cache.has(path)) {
      try {
        cache.set(path, readFileSync(resolve(ROOT, path), 'utf8'));
      } catch {
        cache.set(path, null);
      }
    }
    return cache.get(path);
  };
  const exists = (path) => existsSync(resolve(ROOT, path)) && read(path) !== null;
  // tests/ 下所有的用例文件（含子目录），与 vitest.config.ts 的 include 一致
  const tests = readdirSync(resolve(ROOT, 'tests'), { recursive: true })
    .map((f) => `tests/${String(f).split('\\').join('/')}`)
    .filter((f) => f.endsWith('.test.ts'))
    .sort();
  const unit = tests.filter((t) => !needsDatabase(t, read, exists));

  if (tier === 'unit') {
    console.log(`秒级这一档：${unit.length} 个文件不要数据库（一共 ${tests.length} 个用例文件）`);
    if (listOnly) return console.log(unit.join('\n'));
    process.exit(spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '-c', 'vitest.unit.config.ts', ...unit], { cwd: ROOT, stdio: 'inherit' }).status ?? 1);
  }

  const changed = changedFiles();
  const keywords = [...new Set(changed.flatMap(keywordsOf))];
  const related = tests.filter((t) => !unit.includes(t) && (changed.includes(t) || keywords.some((k) => matchesKeyword(t, k))));
  console.log(`快测：改到 ${changed.length} 个文件，模块 ${keywords.length ? keywords.join('、') : '（没认出模块）'}`);
  console.log(`  秒级 ${unit.length} 个文件 + 沾边的集成测试 ${related.length} 个${related.length ? `：${related.map((t) => posix.basename(t, '.test.ts')).join('、')}` : ''}`);
  console.log('  按文件名找的、会漏（改了什么先跑哪些的对照表在 docs/TESTING.md 第 4 节）；交 PR 前跑全量 npm test');
  if (listOnly) return;
  const unitRun = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '-c', 'vitest.unit.config.ts', ...unit], { cwd: ROOT, stdio: 'inherit' });
  if (unitRun.status !== 0) process.exit(unitRun.status ?? 1);
  if (!related.length) return;
  if (!process.env.TEST_DATABASE_URL) {
    console.error('✗ 沾边的集成测试要数据库：TEST_DATABASE_URL 指向独立测试库（会清空该库）');
    process.exit(1);
  }
  process.exit(spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...related], { cwd: ROOT, stdio: 'inherit' }).status ?? 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
