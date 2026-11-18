// 文档检查（工程治理一期，scripts/check-docs.mjs）：每一条认得出该认的、放得过该放的。不要数据库。
import { describe, expect, it } from 'vitest';
// @ts-expect-error 脚本是 .mjs，没有类型声明
import * as docsCheck from '../scripts/check-docs.mjs';

const { AGENTS_BUDGET_BYTES, INDEX_END, INDEX_START, buildIndex, checkDocs, classifyDoc, devProfile, docRefs, docTitle, patternToRegExp, relativeLinks, replaceIndex, resolveLink } = docsCheck as {
  AGENTS_BUDGET_BYTES: number;
  INDEX_END: string;
  INDEX_START: string;
  buildIndex: (docs: { rel: string; title: string }[]) => string;
  checkDocs: (files: string[], read: (path: string) => string | null) => { problems: string[]; docs: { rel: string; title: string }[]; wantedReadme: string | null };
  classifyDoc: (rel: string) => string;
  devProfile: (agents: string) => Record<string, string[]> | null;
  docRefs: (text: string) => string[];
  docTitle: (markdown: string) => string | null;
  patternToRegExp: (pattern: string) => RegExp;
  relativeLinks: (markdown: string) => { line: number; target: string }[];
  replaceIndex: (readme: string, index: string) => string | null;
  resolveLink: (fromFile: string, target: string) => string | null;
};

const PROFILE = [
  '## 快测、门禁与高风险目录（oil-dev）',
  '',
  '- 快测：`npx vitest run tests/{target}.test.ts`',
  '- 门禁：`npm test`',
  '- 高风险：`src/server/migrations/`、`src/shared/money.ts`',
  '- 禁改：`miniprogram/`',
  '',
].join('\n');

/** 一个刚好能过检查的小仓库 */
function repo(overrides: Record<string, string | null> = {}) {
  const base: Record<string, string> = {
    'AGENTS.md': `# AGENTS.md\n\n见 [加锁顺序](docs/LOCKING.md)。\n\n${PROFILE}`,
    'docs/LOCKING.md': '# 加锁顺序\n',
    'docs/HANDOFF_V1.md': '# 1.0 交接说明\n\n命令在 `docs/LOCKING.md`。\n',
    'src/server/migrations/001_init.sql': '-- 见 docs/LOCKING.md\n',
    'src/shared/money.ts': 'export const a = 1;\n',
    'miniprogram/app.ts': '// docs/NOT_CHECKED.md\n',
  };
  const files: Record<string, string | null> = { ...base, ...overrides };
  const present = (path: string) => files[path] ?? null;
  const docs = Object.keys(files)
    .filter((f) => f.startsWith('docs/') && f.endsWith('.md') && f !== 'docs/README.md' && files[f] !== null)
    .sort()
    .map((f) => ({ rel: f.slice(5), title: docTitle(files[f]!) ?? '' }))
    .filter((d) => d.title);
  if (!('docs/README.md' in overrides)) files['docs/README.md'] = replaceIndex(`# 文档索引\n\n${INDEX_START}\n${INDEX_END}\n`, buildIndex(docs));
  return { list: Object.keys(files), read: present };
}
const problemsOf = (overrides: Record<string, string | null> = {}) => {
  const r = repo(overrides);
  return checkDocs(r.list, r.read).problems;
};

describe('文档检查', () => {
  it('小仓库整套通过；小程序线目录里写的文档名不查', () => {
    expect(problemsOf()).toEqual([]);
  });

  it('AGENTS.md 超过预算报出来，刚好在预算里放过', () => {
    const pad = (bytes: number) => `# AGENTS.md\n\n${PROFILE}\n${'x'.repeat(bytes)}`;
    const base = Buffer.byteLength(pad(0), 'utf8');
    expect(problemsOf({ 'AGENTS.md': pad(AGENTS_BUDGET_BYTES - base) })).toEqual([]);
    const over = problemsOf({ 'AGENTS.md': pad(AGENTS_BUDGET_BYTES - base + 1) });
    expect(over).toHaveLength(1);
    expect(over[0]).toContain('超过预算');
  });

  it('相对链接：指不到的报出来；网址、页内锚点、代码里的不算；带锚点的按文件核对', () => {
    const md = ['[好](LOCKING.md#总则) [站外](https://example.com/a.md) [锚点](#x)', '`[代码里](NOPE.md)`', '```', '[代码块里](NOPE2.md)', '```', '[坏](MISSING.md) ![图](screenshots/x.png)'].join(
      '\n',
    );
    expect(relativeLinks(md).map((l) => l.target)).toEqual(['LOCKING.md#总则', 'MISSING.md', 'screenshots/x.png']);
    expect(resolveLink('docs/A.md', '../AGENTS.md')).toBe('AGENTS.md');
    expect(resolveLink('docs/A.md', 'LOCKING.md#总则')).toBe('docs/LOCKING.md');
    expect(resolveLink('AGENTS.md', '../outside.md')).toBeNull();
    const found = problemsOf({ 'docs/A.md': `# A\n\n${md}\n` });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('docs/A.md:8  MISSING.md');
    expect(found[0]).toContain('docs/A.md:8  screenshots/x.png');
    expect(found[0]).not.toContain('NOPE');
  });

  it('源码、文档里写到的文档不存在时报出来（带通配的写法不算）', () => {
    expect(docRefs('见 docs/A.md 与 `docs/sub/B.md`，docs/HANDOFF_*.md 不算，mydocs/C.md 也不算')).toEqual(['docs/A.md', 'docs/sub/B.md']);
    const found = problemsOf({ 'src/shared/money.ts': '// 设计见 docs/GONE.md\nexport const a = 1;\n' });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('src/shared/money.ts:1  docs/GONE.md');
  });

  it('索引：新加了文档没重新生成、文档没有标题，都报出来', () => {
    const stale = repo();
    const withNew: Record<string, string | null> = { ...Object.fromEntries(stale.list.map((f) => [f, stale.read(f)])), 'docs/NEW.md': '# 新文档\n' };
    const found = checkDocs(Object.keys(withNew), (p) => withNew[p] ?? null).problems;
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('--fix');
    expect(problemsOf({ 'docs/NOTITLE.md': '没有标题\n' }).some((p) => p.includes('没有一级标题'))).toBe(true);
    expect(problemsOf({ 'docs/README.md': '# 文档索引\n' }).some((p) => p.includes('两个标记'))).toBe(true);
  });

  it('索引按文件名分组，现行规范按固定顺序、其余按文件名排', () => {
    expect(
      ['LOCKING.md', 'HANDOFF_V819.md', 'HANDOFF_MP1.md', 'MP_PHASE3.md', 'DEPLOY_MAC_MINI.md', 'DEPLOY_GATEWAY.md', 'SCHEDULE_V811.md', 'EMENU.md', 'changelog/CHANGELOG-8.0.md'].map(classifyDoc),
    ).toEqual(['core', 'handoff', 'handoff', 'mp', 'ops', 'mp', 'plan', 'module', 'changelog']);
    const index = buildIndex([
      { rel: 'TESTING.md', title: '测试' },
      { rel: 'ZEBRA.md', title: '斑马' },
      { rel: 'LOCKING.md', title: '加锁' },
      { rel: 'APPLE.md', title: '苹果' },
    ]);
    expect(
      index
        .split('\n')
        .filter((l) => l.startsWith('- '))
        .map((l) => /`([^`]+)`/.exec(l)![1]),
    ).toEqual(['LOCKING.md', 'TESTING.md', 'APPLE.md', 'ZEBRA.md']);
  });

  it('开发约定小节：缺了报出来；高风险、禁改的路径匹配不到文件报出来', () => {
    expect(devProfile(PROFILE)).toEqual({ 快测: ['npx vitest run tests/{target}.test.ts'], 门禁: ['npm test'], 高风险: ['src/server/migrations/', 'src/shared/money.ts'], 禁改: ['miniprogram/'] });
    expect(devProfile('# 没有这一节\n')).toBeNull();
    expect(problemsOf({ 'AGENTS.md': '# AGENTS.md\n' }).some((p) => p.includes('oil-dev'))).toBe(true);
    const moved = problemsOf({ 'src/shared/money.ts': null });
    expect(moved).toHaveLength(1);
    expect(moved[0]).toContain('高风险：src/shared/money.ts');
    expect(patternToRegExp('src/server/modules/wallet*.ts').test('src/server/modules/wallet-core.ts')).toBe(true);
    expect(patternToRegExp('src/server/modules/wallet*.ts').test('src/server/modules/x/wallet.ts')).toBe(false);
    expect(patternToRegExp('src/server/auth/**').test('src/server/auth/a/b.ts')).toBe(true);
    expect(patternToRegExp('scripts/*.sh').test('scripts/lib/common.sh')).toBe(false);
    expect(patternToRegExp('miniprogram/').test('miniprogram/src/app.ts')).toBe(true);
  });
});
