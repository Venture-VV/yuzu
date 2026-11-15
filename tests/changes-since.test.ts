// 某时刻之后写进系统的（8.1.0，scripts/rollback.sh 恢复升级前的备份之前列出来；测试会话在 PR #113 be1de5a 报的 P1）。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(quiet.tables.every((t) => t.n === 0)).toBe(true);

    const r = await api(ctx.app, ctx.clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: 'C001', zone: 'male' }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const after = await changesSince(ctx.sql, since);
    expect(after.tables.find((t) => t.table === 'visits')!.n).toBe(1);
    expect(after.total).toBeGreaterThan(0);
    const lines = changesSinceLines(after, '2026-11-15 11:00');
    expect(lines[0]).toBe('2026-11-15 11:00 之后写进系统的：');
    expect(lines.join('\n')).toContain('接待（来访） 1');
    expect(lines.at(-1)).toBe(`CHANGES=${after.total}`);

    // 回退用的是升级前那份备份的 createdAt（带时区的 ISO）：照样认
    const iso = parseLocalTime(since.toISOString(), ctx.config.timezone);
    expect(iso?.getTime()).toBe(since.getTime());
  });
});

describe('rollback.sh 用的 json_str：从备份说明里取 createdAt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuzu-json-str-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const run = (file: string, key: string) =>
    spawnSync('bash', ['-c', `source scripts/lib/common.sh && json_str "$1" "$2"`, 'bash', key, file], { encoding: 'utf8' }).stdout.trim();

  it('取得到带时区的时刻；没有这一项或没有文件时为空（脚本改用升级记录里的时刻）', () => {
    const file = join(dir, 'b.dump.json');
    writeFileSync(file, `${JSON.stringify({ file: 'b.dump', createdAt: '2026-11-15T03:00:00.000Z', sha256: 'a'.repeat(64) }, null, 2)}\n`);
    expect(run(file, 'createdAt')).toBe('2026-11-15T03:00:00.000Z');
    expect(run(file, 'missing')).toBe('');
    expect(run(join(dir, 'none.json'), 'createdAt')).toBe('');
  });
});
