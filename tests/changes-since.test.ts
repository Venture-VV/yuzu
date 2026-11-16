// 某时刻之后写进系统的（8.1.0，scripts/rollback.sh 恢复升级前的备份之前列出来；测试会话在 PR #113 be1de5a 报的 P1）。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { changesSince, changesSinceLines } from '../src/server/ops/changes-since';
import { parseLocalTime } from '../src/server/ops/balance-changes';
import { api, setup, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setup();
  expect((await api(ctx.app, ctx.owner, 'POST', '/api/frontdesk/tags/batch', { prefix: 'C', from: 1, to: 5, width: 3, zone: 'male' })).status).toBe(200);
}, 60_000);
afterAll(async () => ctx.close());

describe('changes-since：某时刻之后写进系统的', () => {
  it('之后没有业务写入：合计 0（登录、登出不算）；接待一位客人以后算得出来，最后一行给脚本读', async () => {
    const since = new Date();
    await new Promise((r) => setTimeout(r, 20));
    const quiet = await changesSince(ctx.sql, since);
    expect(quiet.total).toBe(0);
    expect(quiet.tables).toEqual([]);

    const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: 'C001', zone: 'male' }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const after = await changesSince(ctx.sql, since);
    expect(after.tables.find((t) => t.table === 'visits')).toMatchObject({ label: '接待（来访）', inserted: 1 });
    expect(after.total).toBeGreaterThan(0);
    const lines = changesSinceLines(after, '2026-11-15 11:00');
    expect(lines[0]).toMatch(/^2026-11-15 11:00 之后写进系统的（数了 \d+ 张有时间列的表与审计）：$/);
    expect(lines.join('\n')).toContain('接待（来访）：新增 1 行');
    expect(lines.at(-1)).toBe(`CHANGES=${after.total}`);

    // 回退用的是升级前那份备份的 createdAt（带时区的 ISO）：照样认
    const iso = parseLocalTime(since.toISOString(), ctx.config.timezone);
    expect(iso?.getTime()).toBe(since.getTime());
  });
});

describe('changes-since：不只数固定的几张表（测试会话 3b58876 复验的 P1）', () => {
  it('没写审计、原来又不在固定几张表里的写入也数得到：新增的行、改过的行（有 updated_at 的表）都算', async () => {
    const [old] = await ctx.sql<{ id: number }[]>`INSERT INTO member_tags (name) VALUES ('回退核对·旧标签') RETURNING id`;
    await new Promise((r) => setTimeout(r, 20));
    const since = new Date();
    await new Promise((r) => setTimeout(r, 20));
    expect((await changesSince(ctx.sql, since)).total).toBe(0);
    // 不经接口、不写审计：直接新增一行、改一行
    await ctx.sql`INSERT INTO member_tags (name) VALUES ('回退核对·新标签')`;
    await ctx.sql`UPDATE member_tags SET name = '回退核对·改过', updated_at = now() WHERE id = ${old!.id}`;
    const c = await changesSince(ctx.sql, since);
    expect(c.audit).toEqual([]);
    expect(c.tables.find((t) => t.table === 'member_tags')).toMatchObject({ inserted: 1, updated: 1 });
    expect(c.total).toBe(2);
    expect(c.scanned).toBeGreaterThan(100);
    const text = changesSinceLines(c, 'X').join('\n');
    expect(text).toContain('member_tags：新增 1 行、改过 1 行');
    expect(text).toMatch(/数了 \d+ 张有时间列的表/);
  });
});

describe('rollback.sh 用的 json_str：从备份说明里取 createdAt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuzu-json-str-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const run = (file: string, key: string) => spawnSync('bash', ['-c', `source scripts/lib/common.sh && json_str "$1" "$2"`, 'bash', key, file], { encoding: 'utf8' }).stdout.trim();

  it('取得到带时区的时刻；没有这一项或没有文件时为空（脚本改用升级记录里的时刻）', () => {
    const file = join(dir, 'b.dump.json');
    writeFileSync(file, `${JSON.stringify({ file: 'b.dump', createdAt: '2026-11-15T03:00:00.000Z', sha256: 'a'.repeat(64) }, null, 2)}\n`);
    expect(run(file, 'createdAt')).toBe('2026-11-15T03:00:00.000Z');
    expect(run(file, 'missing')).toBe('');
    expect(run(join(dir, 'none.json'), 'createdAt')).toBe('');
  });
});

describe('运维脚本在 macOS 自带的 bash 3.2 上（测试会话 3b58876 复验的 P1）', () => {
  it('紧跟着中文等非 ASCII 字符的 $变量 一律加花括号：bash 3.2 在 UTF-8 下会把后面的字当成变量名的一部分（set -u 下 unbound variable）', () => {
    const files = [
      ...readdirSync('scripts')
        .filter((f) => f.endsWith('.sh'))
        .map((f) => `scripts/${f}`),
      ...readdirSync('scripts/lib')
        .filter((f) => f.endsWith('.sh'))
        .map((f) => `scripts/lib/${f}`),
    ];
    expect(files).toContain('scripts/rollback.sh');
    const bad: string[] = [];
    for (const f of files) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7f]/.test(line)) bad.push(`${f}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(bad).toEqual([]);
  });

  it('回退：恢复升级前的备份之前一律当面确认，不看清单的合计跳过', () => {
    const s = readFileSync('scripts/rollback.sh', 'utf8');
    const block = s.slice(s.indexOf('changes=$('), s.indexOf('mark_dirty\nif $restore'));
    expect(block).toContain('DISCARD-AFTER-UPGRADE');
    // 确认不在「合计不是 0」的分支里：if 判断合计的那一段在确认之前就结束了
    const confirmAt = block.indexOf('read -r -p');
    const countIf = block.indexOf('if [[ "${changes:-1}" == "0" ]]');
    expect(countIf).toBeGreaterThan(-1);
    expect(block.indexOf('fi', countIf)).toBeLessThan(confirmAt);
  });
});
