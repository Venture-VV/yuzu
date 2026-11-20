// 8.1.18 组织架构与岗位（迁移 194，docs/POSITIONS_V8118.md GW7）：从 194 之前的库升上来——
//   · 店主账号定成总裁，不用选岗；点餐平板、他店查询、设计师与系统账号不用选；其余老账号（含停用的）标要选岗；
//   · 老账号的旧岗位、职责照旧（选岗之前权限不变）；新建的账号默认不用选；岗位只能写认识的格式；再跑一次迁移什么都不做。

import { readdir, readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSql, type Sql } from '../src/server/db';
import { migrate } from '../src/server/migrate';
import { TEST_DB } from './helpers';
import { resetPublicSchema } from './test-db';

const MIGRATIONS = new URL('../src/server/migrations/', import.meta.url);
const MINE = '194_positions.sql';
let sql: Sql;

beforeAll(() => {
  sql = createSql(TEST_DB, { max: 4 });
});
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

async function schemaBefore194() {
  await resetPublicSchema(sql);
  await sql`CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const f of (await readdir(MIGRATIONS)).filter((x) => x.endsWith('.sql') && x < MINE).sort()) {
    await sql.unsafe(await readFile(new URL(f, MIGRATIONS), 'utf8'));
    await sql`INSERT INTO schema_migrations (version) VALUES (${f})`;
  }
}

describe('迁移 194：员工的岗位', () => {
  it('店主定成总裁；专用账号与系统账号不用选；其余老账号要选岗，旧岗位照旧', async () => {
    await schemaBefore194();
    await sql`
      INSERT INTO staff (username, display_name, role, duties, password_hash, active, system) VALUES
        ('boss', '店主', 'owner', '{}', 'x', true, false),
        ('clerk1', '店员', 'clerk', '{}', 'x', true, false),
        ('buyer', '采购', 'backoffice', '{purchase}', 'x', true, false),
        ('gone', '离职的', 'duty_manager', '{}', 'x', false, false),
        ('pad', '平板', 'tablet', '{}', 'x', true, false),
        ('other', '他店', 'other_store', '{}', 'x', true, false),
        ('art', '设计', 'designer', '{}', 'x', true, false),
        ('sys', '系统', 'clerk', '{}', 'system:no-login', false, true)`;

    expect(await migrate(sql)).toContain(MINE);

    const rows = await sql<{ username: string; role: string; duties: string[]; position: string | null; needsPosition: boolean; permissionAdjust: unknown }[]>`
      SELECT username, role, duties, position, needs_position, permission_adjust FROM staff ORDER BY username`;
    const by = Object.fromEntries(rows.map((r) => [r.username, r]));
    expect(by.boss).toMatchObject({ role: 'owner', position: 'president', needsPosition: false });
    for (const u of ['clerk1', 'buyer', 'gone']) expect(by[u], u).toMatchObject({ position: null, needsPosition: true });
    expect(by.buyer).toMatchObject({ role: 'backoffice', duties: ['purchase'] });
    for (const u of ['pad', 'other', 'art', 'sys']) expect(by[u], u).toMatchObject({ position: null, needsPosition: false });
    expect(by.clerk1!.permissionAdjust).toEqual({});

    // 新建的账号默认不用选；岗位只能写认识的格式
    await sql`INSERT INTO staff (username, display_name, role, password_hash, position) VALUES ('newbie', '新人', 'clerk', 'x', 'front.staff')`;
    expect((await sql<{ needsPosition: boolean }[]>`SELECT needs_position FROM staff WHERE username = 'newbie'`)[0]!.needsPosition).toBe(false);
    await expect(sql`UPDATE staff SET position = 'Front staff' WHERE username = 'newbie'`).rejects.toThrow();

    expect(await migrate(sql)).toEqual([]);
  });
});
