// 文档检查（工程治理一期，docs/GOVERNANCE.md）：CI 跑，挂了不能合。npm run check:docs
//   1. AGENTS.md 不超过体积预算：它是每个 AI 会话开工都整份读的入口，专题内容放 docs/ 里的专题文档；
//   2. Markdown 里的相对链接都指得到文件；
//   3. 源码、文档里写到的 docs 目录下的文档都存在（文档改名、删掉以后别处还引用着的）；
//   4. docs/README.md 的文档索引是最新的：每份文档都在里面、标题一致（npm run check:docs -- --fix 重新生成）；
//   5. AGENTS.md 的「快测、门禁与高风险目录（oil-dev）」小节条目齐全，高风险、禁改的每条路径都匹配得到文件。
// 小程序线自己的目录（miniprogram/）与品牌资料（brand/）不查。退出码：0 通过，1 有问题。

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');

/** AGENTS.md 的体积预算（字节）。拆之前是 88 KB；要加规则先想能不能放专题文档，入口只加一行指路 */
export const AGENTS_BUDGET_BYTES = 24 * 1024;

/** 不查的目录：小程序线自己的、品牌资料、依赖与产物 */
const SKIP_PREFIXES = ['miniprogram/', 'brand/', 'node_modules/', 'dist/'];
/** 故意写着不存在的文档名的文件（用例里造的路径） */
const REF_FIXTURES = new Set(['tests/line-scope.test.ts', 'tests/check-docs.test.ts']);

export const INDEX_START = '<!-- docs-index:start（由 npm run check:docs -- --fix 生成，不要手改） -->';
export const INDEX_END = '<!-- docs-index:end -->';

/** 索引里的分组与顺序 */
export const DOC_GROUPS = [
  ['core', '现行规范（写代码前按需读，随代码更新）'],
  ['module', '模块设计与专题（设计稿与实现说明；模块改了要跟着改）'],
  ['ops', '部署、发版与环境'],
  ['mp', '小程序线（Gemini 维护）'],
  ['plan', '排期、规划与调研（当时的计划，写完不再更新）'],
  ['handoff', '交接说明（发版当时的快照，不随代码更新；与专题文档不一致时以专题文档为准）'],
  ['changelog', '更新记录分卷'],
];
/** 现行规范这一组的文档与顺序 */
const CORE_DOCS = ['LOCKING.md', 'COMMANDS.md', 'CONVENTIONS.md', 'TESTING.md', 'ROADMAP.md', 'PENDING_DECISIONS.md', 'GOVERNANCE.md', 'DEVICES.md', 'DESIGN.md', 'UI_V8016.md', 'IA_V8017.md'];

/** 一份文档（docs/ 下的相对路径）归到哪一组 */
export function classifyDoc(rel) {
  if (rel.startsWith('changelog/')) return 'changelog';
  if (rel.startsWith('HANDOFF_')) return 'handoff';
  if (/^(MINIPROGRAM|MP_|DEPLOY_GATEWAY)/.test(rel)) return 'mp';
  if (/^(DEPLOY_|RELEASE_|TRIAL_RUN|EVALUATION|DEMO_DATA)/.test(rel)) return 'ops';
  if (/^(SCHEDULE_|ERP_FINANCE_LEGAL_PLAN|GOVERNANCE_NOTES)/.test(rel)) return 'plan';
  if (CORE_DOCS.includes(rel)) return 'core';
  return 'module';
}

/** 文档的标题：第一个一级标题 */
export function docTitle(markdown) {
  const m = /^# +(.+?)\s*$/m.exec(markdown);
  return m ? m[1] : null;
}

/** 生成索引（两个标记之间的那一段）：docs = [{ rel, title }] */
export function buildIndex(docs) {
  const out = [];
  for (const [key, heading] of DOC_GROUPS) {
    const list = docs.filter((d) => classifyDoc(d.rel) === key);
    if (!list.length) continue;
    if (key === 'core') list.sort((a, b) => CORE_DOCS.indexOf(a.rel) - CORE_DOCS.indexOf(b.rel));
    else list.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    out.push(`## ${heading}`, '');
    for (const d of list) out.push(`- [\`${d.rel}\`](${d.rel})：${d.title}`);
    out.push('');
  }
  return out.join('\n').trimEnd();
}

/** 把索引放进 docs/README.md 的两个标记之间；没有标记返回 null */
export function replaceIndex(readme, index) {
  const a = readme.indexOf(INDEX_START);
  const b = readme.indexOf(INDEX_END);
  if (a < 0 || b < 0 || b < a) return null;
  return `${readme.slice(0, a + INDEX_START.length)}\n\n${index}\n\n${readme.slice(b)}`;
}

/** 一份 Markdown 里的相对链接：[{ line, target }]（不含网址、页内锚点；代码块里的不算） */
export function relativeLinks(markdown) {
  const found = [];
  let fenced = false;
  markdown.split('\n').forEach((text, i) => {
    if (/^\s*(```|~~~)/.test(text)) fenced = !fenced;
    if (fenced) return;
    const line = text.replace(/`[^`]*`/g, (code) => ' '.repeat(code.length));
    for (const m of line.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
      const target = m[1];
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) continue;
      found.push({ line: i + 1, target });
    }
  });
  return found;
}

/** 链接指到的仓库内路径（相对写它的那份文件）；指到仓库外面返回 null */
export function resolveLink(fromFile, target) {
  const clean = decodeURIComponent(target.split('#')[0].split('?')[0]);
  if (!clean) return fromFile;
  const joined = clean.startsWith('/') ? posix.normalize(clean.slice(1)) : posix.normalize(posix.join(posix.dirname(fromFile), clean));
  return joined.startsWith('..') ? null : joined.replace(/\/$/, '');
}

/** 一段文字里写到的 docs 目录下的 .md 路径 */
export function docRefs(text) {
  return [...text.matchAll(/(?<![\w./-])docs\/[A-Za-z0-9_./-]+\.md\b/g)].map((m) => m[0]);
}

/** 路径模式 → 正则：结尾的 / 是整个目录，** 跨目录，* 不跨目录 */
export function patternToRegExp(pattern) {
  const body = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/?/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${body}${pattern.endsWith('/') ? '.*' : ''}$`);
}

/** AGENTS.md 里标题带 oil-dev 的小节：{ 快测: [...], 门禁: [...], 高风险: [...], 禁改: [...] }；没有这一节返回 null */
export function devProfile(agents) {
  const lines = agents.split('\n');
  const start = lines.findIndex((l) => /^#{2,3} .*oil-dev/.test(l));
  if (start < 0) return null;
  const level = lines[start].match(/^#+/)[0].length;
  const profile = {};
  for (let i = start + 1; i < lines.length; i++) {
    const head = /^(#+) /.exec(lines[i]);
    if (head && head[1].length <= level) break;
    const m = /^- \**([^：:*]+)\**[：:](.*)$/.exec(lines[i]);
    if (m) profile[m[1].trim()] = [...m[2].matchAll(/`([^`]+)`/g)].map((x) => x[1]);
  }
  return profile;
}

function listFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\0').filter(Boolean);
}

/** 全部检查：返回问题清单（空数组 = 通过）。files 是仓库里的文件，read(path) 取内容 */
export function checkDocs(files, read) {
  const problems = [];
  const present = files.filter((f) => read(f) !== null);
  const fileSet = new Set(present);
  const dirSet = new Set();
  for (const f of present) for (let d = posix.dirname(f); d !== '.'; d = posix.dirname(d)) dirSet.add(d);
  const inScope = (f) => !SKIP_PREFIXES.some((p) => f.startsWith(p));
  const exists = (p) => p === '' || p === '.' || fileSet.has(p) || dirSet.has(p);

  // 1. 入口的体积
  const agents = read('AGENTS.md') ?? '';
  const size = Buffer.byteLength(agents, 'utf8');
  if (size > AGENTS_BUDGET_BYTES)
    problems.push(
      `AGENTS.md 有 ${size} 字节，超过预算 ${AGENTS_BUDGET_BYTES} 字节：它是每个会话都整份读的入口，专题内容放进 docs/ 里对应的专题文档（加锁顺序 → docs/LOCKING.md，命令 → docs/COMMANDS.md，其余约定 → docs/CONVENTIONS.md），这里只留一行指路`,
    );

  // 2. 相对链接
  const dead = [];
  for (const f of present.filter((x) => x.endsWith('.md') && inScope(x))) {
    for (const { line, target } of relativeLinks(read(f))) {
      const to = resolveLink(f, target);
      if (to === null || !exists(to)) dead.push(`${f}:${line}  ${target}`);
    }
  }
  if (dead.length) problems.push(`指不到文件的相对链接 ${dead.length} 处：\n  ${dead.join('\n  ')}`);

  // 3. 写到的 docs 目录下的文档都存在
  const missing = [];
  for (const f of present.filter((x) => /\.(md|ts|tsx|mjs|cjs|js|sh|ya?ml|sql|css|json)$/.test(x) && inScope(x) && x !== 'package-lock.json' && !REF_FIXTURES.has(x))) {
    const text = read(f);
    if (!text.includes('docs/')) continue;
    text.split('\n').forEach((lineText, i) => {
      for (const ref of docRefs(lineText)) if (!fileSet.has(ref)) missing.push(`${f}:${i + 1}  ${ref}`);
    });
  }
  if (missing.length) problems.push(`引用了不存在的文档 ${missing.length} 处（文档改名或删掉以后这里没跟着改）：\n  ${missing.join('\n  ')}`);

  // 4. 文档索引
  const docs = [];
  const untitled = [];
  for (const f of present.filter((x) => x.startsWith('docs/') && x.endsWith('.md') && x !== 'docs/README.md').sort()) {
    const title = docTitle(read(f));
    if (title) docs.push({ rel: f.slice('docs/'.length), title });
    else untitled.push(f);
  }
  if (untitled.length) problems.push(`没有一级标题的文档 ${untitled.length} 份（第一行写成「# 标题」，索引用它）：\n  ${untitled.join('\n  ')}`);
  const readme = read('docs/README.md');
  const wanted = readme === null ? null : replaceIndex(readme, buildIndex(docs));
  if (wanted === null) problems.push('docs/README.md 不在或缺了索引的两个标记（docs-index:start / docs-index:end）');
  else if (wanted !== readme) problems.push('docs/README.md 的文档索引不是最新的（有文档新加、删掉或改了标题）：跑 npm run check:docs -- --fix 重新生成');

  // 5. 开发约定小节
  const profile = devProfile(agents);
  if (!profile) problems.push('AGENTS.md 没有标题带「oil-dev」的开发约定小节（快测、门禁、高风险目录、禁改目录）');
  else {
    for (const key of ['快测', '门禁', '高风险']) if (!profile[key]?.length) problems.push(`AGENTS.md 的开发约定小节（oil-dev）缺「${key}」`);
    const unmatched = [];
    for (const key of ['高风险', '禁改']) {
      for (const pattern of profile[key] ?? []) {
        const re = patternToRegExp(pattern);
        if (!present.some((f) => re.test(f))) unmatched.push(`${key}：${pattern}`);
      }
    }
    if (unmatched.length) problems.push(`AGENTS.md 开发约定小节里匹配不到任何文件的路径 ${unmatched.length} 条（目录改名了就跟着改）：\n  ${unmatched.join('\n  ')}`);
  }
  return { problems, docs, wantedReadme: wanted };
}

function main() {
  const fix = process.argv.includes('--fix');
  const files = listFiles();
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
  let result = checkDocs(files, read);
  if (fix && result.wantedReadme !== null && result.wantedReadme !== read('docs/README.md')) {
    writeFileSync(resolve(ROOT, 'docs/README.md'), result.wantedReadme);
    cache.delete('docs/README.md');
    console.log('已重新生成 docs/README.md 的文档索引');
    result = checkDocs(files, read);
  }
  if (result.problems.length) {
    console.error(`✗ 文档检查没过：\n\n${result.problems.join('\n\n')}`);
    process.exit(1);
  }
  const size = Buffer.byteLength(read('AGENTS.md') ?? '', 'utf8');
  console.log(`✓ 文档检查通过：AGENTS.md ${size} 字节（预算 ${AGENTS_BUDGET_BYTES}）、相对链接与文档引用都指得到、索引里 ${result.docs.length} 份文档、开发约定小节齐全`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
