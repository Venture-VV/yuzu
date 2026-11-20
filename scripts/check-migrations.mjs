// 迁移的数据风险检查（docs/TESTING.md 第 6.4 节）：参照 squawk、strong_migrations 的思路，
// 只看这次新加的迁移，找出会删数据、改账本、改类型、重建作废约束这类写法。
//
//   node scripts/check-migrations.mjs                  相对 origin/main
//   node scripts/check-migrations.mjs --base <提交>     相对指定提交（CI 用 PR 的目标分支）
//   node scripts/check-migrations.mjs --all            把所有迁移都过一遍（只报告，不算失败；看历史上有哪些高风险写法）
//
// 两类问题：
//   · 改了、删了、改名了已有的迁移：一律失败（迁移只增不改，AGENTS.md「开发约定」）。
//   · 新迁移里的高风险写法：在那一句（或它前面紧挨着的注释）里写「-- 风险已知：<原因>」说明为什么这样做、怎么保证数据不丢不错，才算过；
//     没写就失败。写了的照样列进报告，测试 AI 验收时按第 6.4 节逐条核对。

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const DIR = 'src/server/migrations';

/** 账本与资金表：只追加，不改不删（AGENTS.md「已生效的单据、流水、明细只追加」） */
export const LEDGER_TABLES = ['ledger_entries', 'recharges', 'consumptions', 'consumption_lines', 'reversals', 'checkout_payments', 'refund_payments', 'payments', 'audit_logs', 'daily_settlements'];

/** 表名：可带 ONLY、schema 前缀（public.）与双引号 */
const TABLE = String.raw`(?:ONLY\s+)?(?:"?[a-z_][a-z0-9_]*"?\.)?"?`;
/** UPDATE 目标表与 SET 之间可以有别名（UPDATE ledger_entries l SET …、UPDATE x AS y SET …） */
const ALIAS = String.raw`"?(?:\s+(?:AS\s+)?(?!SET\b)[a-z_][a-z0-9_]*)?\s+SET\b`;
const updateOf = (table) => new RegExp(String.raw`\bUPDATE\s+${TABLE}${table}${ALIAS}`, 'i');
const insertOf = (table) => new RegExp(String.raw`\bINSERT\s+INTO\s+${TABLE}${table}"?(?![a-z0-9_])`, 'i');
const mergeOf = (table) => new RegExp(String.raw`\bMERGE\s+INTO\s+${TABLE}${table}"?(?![a-z0-9_])`, 'i');
const deleteOf = (table) => new RegExp(String.raw`\bDELETE\s+FROM\s+${TABLE}${table}"?(?![a-z0-9_])`, 'i');

export const RULES = [
  { id: 'drop', title: '删表、删列或清空表（数据会丢）', test: (st) => /\bDROP\s+(TABLE|COLUMN)\b|\bTRUNCATE\b/i.test(st) },
  {
    id: 'unbounded-write',
    title: '整表改写：UPDATE / DELETE 没有 WHERE',
    test: (st) => (updateOf('[a-z_][a-z0-9_]*').test(st) || /\bDELETE\s+FROM\b/i.test(st)) && !/\bWHERE\b/i.test(st),
  },
  {
    id: 'ledger-write',
    title: '改动账本或资金表的已有行（只许追加）',
    // UPDATE / DELETE；INSERT … ON CONFLICT … DO UPDATE（UPSERT 会改已有行）；MERGE INTO（Codex 审查 692dc3c）。只追加的 INSERT 与 DO NOTHING 不算
    test: (st) => LEDGER_TABLES.some((t) => updateOf(t).test(st) || deleteOf(t).test(st) || (insertOf(t).test(st) && /\bON\s+CONFLICT\b[\s\S]*\bDO\s+UPDATE\b/i.test(st)) || mergeOf(t).test(st)),
  },
  { id: 'type-change', title: '改列的类型（旧数据要能转、旧版本代码回滚时还认得）', test: (st) => /\bALTER\s+COLUMN\s+[a-z_"]+\s+(SET\s+DATA\s+)?TYPE\b/i.test(st) },
  { id: 'rename', title: '改表名或列名（回滚到上一版时旧代码找不到）', test: (st) => /\bRENAME\s+(COLUMN\s+|TO\s+)/i.test(st) },
  { id: 'not-null', title: '已有列加 NOT NULL（旧数据里有空值就失败）', test: (st) => /\bALTER\s+COLUMN\s+[a-z_"]+\s+SET\s+NOT\s+NULL\b/i.test(st) },
  {
    id: 'fence-constraint',
    title: '重建「确认作废」或操作编号的类型约束，没有在当时的约束上追加（会把别的迁移加的类型覆盖掉）',
    test: (st, file) => /\b(op_fences|idempotency_keys)\b/i.test(st) && /\bDROP\s+CONSTRAINT\b/i.test(st) && !/pg_get_(constraintdef|expr)/i.test(file),
  },
];

const ACK = /--\s*风险已知[:：]\s*\S/;

/** 把一份迁移拆成语句（跳过单引号字符串、$$ 块与注释里的分号）；每句带上前面紧挨着的注释 */
export function splitStatements(sql) {
  const out = [];
  let cur = '';
  let i = 0;
  let dollar = null;
  while (i < sql.length) {
    const c = sql[i];
    if (dollar) {
      if (sql.startsWith(dollar, i)) {
        cur += dollar;
        i += dollar.length;
        dollar = null;
      } else cur += sql[i++];
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      cur += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === "'") {
      const end = sql.indexOf("'", i + 1);
      const stop = end === -1 ? sql.length : end + 1;
      cur += sql.slice(i, stop);
      i = stop;
      continue;
    }
    const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 40));
    if (tag) {
      dollar = tag[0];
      cur += dollar;
      i += dollar.length;
      continue;
    }
    if (c === ';') {
      out.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  if (cur.trim()) out.push(cur);
  return out.filter((s) => s.replace(/--.*$/gm, '').trim());
}

/** 一份迁移里的高风险写法：[{ rule, title, statement, acknowledged }] */
export function findRisks(sql) {
  const findings = [];
  for (const st of splitStatements(sql)) {
    const code = st.replace(/--.*$/gm, '');
    for (const rule of RULES) {
      if (!rule.test(code, sql)) continue;
      findings.push({ rule: rule.id, title: rule.title, statement: code.trim().replace(/\s+/g, ' ').slice(0, 160), acknowledged: ACK.test(st) });
    }
  }
  return findings;
}

/**
 * 迁移目录相对 base 的改动：[{ status, file }]（A 新加、M 改了、D 删了、R 改名）。
 * 比的是分叉点与工作区：已提交、暂存、没暂存的都算（Codex 审查 9ef7126：本地改了已有迁移还没提交也要拦住），另加没跟踪的新文件。
 * 拿不到（没有这个提交）返回 null。
 */
function migrationChanges(base) {
  const run = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let untracked = '';
  try {
    const forkPoint = run(['merge-base', base, 'HEAD']).trim();
    out = run(['diff', '--name-status', '-M', forkPoint, '--', DIR]);
    untracked = run(['ls-files', '--others', '--exclude-standard', '--', DIR]);
  } catch {
    return null;
  }
  const changes = out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, ...files] = line.split('\t');
      return { status: status[0], file: files.at(-1), from: files[0] };
    });
  for (const f of untracked.split('\n').filter(Boolean)) changes.push({ status: 'A', file: f, from: f });
  return changes.filter((c) => c.file.endsWith('.sql') || c.from.endsWith('.sql'));
}

function main() {
  const argv = process.argv.slice(2);
  const all = argv.includes('--all');
  const baseIdx = argv.indexOf('--base');
  const base = baseIdx >= 0 ? argv[baseIdx + 1] : 'origin/main';
  const problems = [];
  const report = [];
  let targets;
  if (all) {
    targets = readdirSync(resolve(ROOT, DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => `${DIR}/${f}`);
  } else {
    const changes = migrationChanges(base);
    if (changes === null) {
      console.error(`✗ 拿不到相对 ${base} 的改动（没有这个提交？CI 里要 fetch-depth: 0）`);
      process.exit(2);
    }
    for (const c of changes.filter((x) => x.status !== 'A')) problems.push(`${c.from}：已有的迁移被${{ M: '改动', D: '删除', R: '改名' }[c.status] ?? '改动'}了——迁移只增不改，新变化写新的迁移`);
    targets = changes.filter((c) => c.status === 'A').map((c) => c.file);
  }
  for (const file of targets) {
    const findings = findRisks(readFileSync(resolve(ROOT, file), 'utf8'));
    for (const f of findings) {
      report.push(`${f.acknowledged ? '已说明' : '✗ 未说明'}　${file}　${f.title}\n      ${f.statement}`);
      if (!all && !f.acknowledged) problems.push(`${file}：${f.title}。在这句前面写「-- 风险已知：<原因与保护办法>」，或改成不动已有数据的写法`);
    }
  }
  console.log(`迁移数据风险：${all ? '全部' : `相对 ${base} 新加的`} ${targets.length} 份迁移，高风险写法 ${report.length} 处`);
  if (report.length) console.log(report.join('\n'));
  if (problems.length) {
    for (const p of problems) console.error(`✗ ${p}`);
    process.exit(1);
  }
  console.log('✓ 迁移的数据风险检查通过');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
