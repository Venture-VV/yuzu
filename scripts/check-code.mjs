// 代码整洁检查（8.1.3，docs/RESILIENCE_V813.md 第 3.1 节，WL1）：CI 跑，挂了不能合。npm run check:code
//   1. 没用到的导入、变量、参数（tsc --noUnusedLocals --noUnusedParameters；用不到的参数写成下划线开头）；
//   2. 事务里没等结果的查询：tx`…`、tx.unsafe(…) 写成一句单独的语句（没有 await / return / 赋值）。postgres.js 3.x
//      在事务结束以后才发出的语句会落到别的连接上、不在事务里（4.0 的更新日志），这种写法一律不许；
//   3. 只用到类型的导入写成 import type（import { type A, type B } 改成 import type { A, B }）。
// 小程序线的目录与文件（scripts/check-line-scope.mjs 的 classify 认作小程序线自己的）不查，由小程序线决定什么时候接上。
// 退出码：0 通过，1 有问题。

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { classify } from './check-line-scope.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const isMpLine = (path) => classify({ status: 'M', path }).kind === 'free';

/** 1. tsc 报的没用到的东西（只留主线的） */
export function unusedFindings(tscOutput) {
  return tscOutput
    .split('\n')
    .filter((line) => /error TS6(133|138|192|196|198|199|205)/.test(line))
    .filter((line) => !isMpLine(line.split('(')[0].trim()));
}

const QUERY_NAMES = new Set(['tx', 'db', 'sql', 'trx', 'conn', 'lockConn']);

/** 2. 一份源码里没等结果的查询：返回 [{ line, text }] */
export function floatingQueries(fileName, code) {
  const src = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
  const found = [];
  const visit = (node) => {
    if (ts.isExpressionStatement(node)) {
      let e = node.expression;
      const voided = ts.isVoidExpression(e);
      if (voided) e = e.expression;
      while (ts.isParenthesizedExpression(e)) e = e.expression;
      let what = null;
      if (ts.isTaggedTemplateExpression(e) && ts.isIdentifier(e.tag) && QUERY_NAMES.has(e.tag.text)) what = `${e.tag.text}\`…\``;
      else if (
        ts.isCallExpression(e) &&
        ts.isPropertyAccessExpression(e.expression) &&
        ts.isIdentifier(e.expression.expression) &&
        QUERY_NAMES.has(e.expression.expression.text) &&
        ['unsafe', 'savepoint'].includes(e.expression.name.text)
      )
        what = `${e.expression.expression.text}.${e.expression.name.text}(…)`;
      if (what) found.push({ line: src.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: `${voided ? 'void ' : ''}${what}` });
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return found;
}

/** 3. 一份源码里写成 import { type A, type B } 的（整句都是类型；跨几行的也算） */
export function inlineTypeImports(code, fileName = 'x.ts') {
  const src = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
  const found = [];
  for (const st of src.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause || st.importClause.isTypeOnly || st.importClause.name) continue;
    const named = st.importClause.namedBindings;
    if (!named || !ts.isNamedImports(named) || named.elements.length === 0) continue;
    if (named.elements.every((el) => el.isTypeOnly)) found.push({ line: src.getLineAndCharacterOfPosition(st.getStart()).line + 1, text: st.getText().replace(/\s+/g, ' ') });
  }
  return found;
}

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

function main() {
  const problems = [];
  let tscOutput = '';
  try {
    execFileSync(process.execPath, ['--max-old-space-size=4096', 'node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--noEmit', '--noUnusedLocals', '--noUnusedParameters'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    tscOutput = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  const unused = unusedFindings(tscOutput);
  const otherTscErrors = tscOutput.split('\n').filter((l) => /error TS/.test(l) && !/error TS6(133|138|192|196|198|199|205)/.test(l));
  if (otherTscErrors.length) problems.push(`类型检查本身有错（先跑 npm run typecheck）：\n  ${otherTscErrors.slice(0, 20).join('\n  ')}`);
  if (unused.length) problems.push(`没用到的导入、变量、参数 ${unused.length} 处（删掉；用不到的参数写成下划线开头）：\n  ${unused.join('\n  ')}`);

  const floating = [];
  const typeImports = [];
  for (const dir of ['src', 'tests', 'e2e', 'e2e-canteen', 'scripts']) {
    let files = [];
    try {
      files = sourceFiles(join(ROOT, dir));
    } catch {
      continue;
    }
    for (const file of files) {
      const rel = relative(ROOT, file).split('\\').join('/');
      if (isMpLine(rel)) continue;
      const code = readFileSync(file, 'utf8');
      if (rel.startsWith('src/server/')) for (const f of floatingQueries(rel, code)) floating.push(`${rel}:${f.line}  ${f.text}`);
      for (const f of inlineTypeImports(code, rel)) typeImports.push(`${rel}:${f.line}  ${f.text}`);
    }
  }
  if (floating.length) problems.push(`事务里没等结果的查询 ${floating.length} 处（前面加 await，或 return / 交给 Promise.all）：\n  ${floating.join('\n  ')}`);
  if (typeImports.length) problems.push(`只用到类型的导入 ${typeImports.length} 处（改成 import type { … }）：\n  ${typeImports.join('\n  ')}`);

  if (problems.length) {
    console.error(`✗ 代码整洁检查没过：\n\n${problems.join('\n\n')}`);
    process.exit(1);
  }
  console.log('✓ 代码整洁检查通过：没有没用到的导入与变量、没有不等结果的查询、类型导入写法统一（小程序线的目录不查）');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
