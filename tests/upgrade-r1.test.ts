// R1.2 · 迁移 017 升级：撤销与反结账时限仍是「不限」的改为 48 小时、跳档宽限仍是 0 的改为 15 分钟（店主 2026-10-29 签认），
// 手动调过的不动；没有设置过的按代码默认值（48 小时、15 分钟、收款前必须先开班）。

import { readdir, readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSql, type Sql } from '../src/server/db';
import { migrate } from '../src/server/migrate';
import { loadFrontdeskRules } from '../src/server/modules/frontdesk/common';
import { loadSettings } from '../src/server/modules/settings';
import { TEST_DB } from './helpers';

const MIGRATIONS = new URL('../src/server/migrations/', import.meta.url);
let sql: Sql;

/** 新建一个迁移到 016 的库，写入升级前的设置，再升级 */
async function upgradeWith(settings: Record<string, unknown>) {
  await sql.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await sql`CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const f of (await readdir(MIGRATIONS)).filter((x) => x.endsWith('.sql') && x < '017').sort()) {
    await sql.unsafe(await readFile(new URL(f, MIGRATIONS), 'utf8'));
    await sql`INSERT INTO schema_migrations (version) VALUES (${f})`;
  }
  // 001、004 等迁移已经写入了一些默认设置：按升级前店主保存过的值覆盖
  for (const [key, value] of Object.entries(settings)) {
    await sql`
      INSERT INTO settings (key, value) VALUES (${key}, ${value === null ? sql`'null'::jsonb` : sql.json(value as never)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  }
  expect(await migrate(sql)).toEqual(['017_r1_funds.sql']);
}

beforeAll(() => {
  sql = createSql(TEST_DB, { max: 4 });
});
afterAll(async () => sql.end({ timeout: 5 }));

describe('迁移 017 的默认值', () => {
  it('仍是旧默认（撤销时限不限、跳档宽限 0）的改为 48 小时、15 分钟，其他前台规则不动', async () => {
    await upgradeWith({
      reversal_window_hours: null,
      frontdesk_rules: { selfVoidMinutes: 20, lostTagFeeCents: 30000, overtimeGraceMinutes: 0 },
    });
    expect((await loadSettings(sql)).reversalWindowHours).toBe(48);
    expect(await loadFrontdeskRules(sql)).toMatchObject({ selfVoidMinutes: 20, lostTagFeeCents: 30000, overtimeGraceMinutes: 15 });
  });

  it('手动调过的不动（撤销时限 24 小时、宽限 5 分钟）', async () => {
    await upgradeWith({ reversal_window_hours: 24, frontdesk_rules: { overtimeGraceMinutes: 5 } });
    expect((await loadSettings(sql)).reversalWindowHours).toBe(24);
    expect((await loadFrontdeskRules(sql)).overtimeGraceMinutes).toBe(5);
  });

  it('没有设置过的按代码默认值：48 小时、15 分钟、收款前必须先开班', async () => {
    await upgradeWith({});
    // 迁移只写过前台规则的更正时限（004、008），没有撤销时限、宽限与先开班的记录
    const rows = await sql<{ key: string; value: Record<string, unknown> }[]>`
      SELECT key, value FROM settings WHERE key IN ('reversal_window_hours', 'require_open_shift', 'frontdesk_rules')`;
    expect(rows).toEqual([{ key: 'frontdesk_rules', value: { selfVoidMinutes: 15 } }]);
    expect(await loadSettings(sql)).toMatchObject({ reversalWindowHours: 48, requireOpenShift: true });
    expect((await loadFrontdeskRules(sql)).overtimeGraceMinutes).toBe(15);
  });
});
