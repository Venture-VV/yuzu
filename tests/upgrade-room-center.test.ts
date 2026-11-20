// 8.1.16 房态中心的操作编号（迁移 193，docs/ROOM_CENTER_V8115.md 第 5 节）：从 193 之前的库升上来——
//   · idempotency_keys、op_fences 的类型约束在当时的基础上多了 space_state、space_dispatch；原来的类型（含 190 之前、别的分支加的）照旧能写；
//   · 升级前写下的操作编号、作废登记照旧在；乱写的类型照旧拒绝；再跑一次迁移什么都不做。

import { readdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSql, type Sql } from '../src/server/db';
import { migrate } from '../src/server/migrate';
import { TEST_DB } from './helpers';
import { resetPublicSchema } from './test-db';

const MIGRATIONS = new URL('../src/server/migrations/', import.meta.url);
const MINE = '193_room_center_ops.sql';
let sql: Sql;

beforeAll(() => {
  sql = createSql(TEST_DB, { max: 4 });
});
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

/** 193 之前的库：编号小于 193 的迁移都执行过 */
async function schemaBefore193() {
  await resetPublicSchema(sql);
  await sql`CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const f of (await readdir(MIGRATIONS)).filter((x) => x.endsWith('.sql') && x < MINE).sort()) {
    await sql.unsafe(await readFile(new URL(f, MIGRATIONS), 'utf8'));
    await sql`INSERT INTO schema_migrations (version) VALUES (${f})`;
  }
}

describe('迁移 193：房态中心房间动作的操作编号', () => {
  it('两张表的类型约束追加 space_state、space_dispatch，原来的类型与升级前的记录照旧；再跑一次不变', async () => {
    await schemaBefore193();
    const [staff] = await sql<{ id: number }[]>`
      INSERT INTO staff (username, display_name, role, password_hash) VALUES ('u_rc', '升级店员', 'clerk', 'x') RETURNING id`;
    const write = (t: string, key = randomUUID()) => sql`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${key}, ${t}, 'h', 1, ${staff!.id})`;
    const fence = (t: string, key = randomUUID()) => sql`INSERT INTO op_fences (key, op_type, staff_id) VALUES (${key}, ${t}, ${staff!.id})`;
    // 升级前：新的两种写不进去；原来的照常
    await expect(write('space_state')).rejects.toThrow();
    await expect(fence('space_dispatch')).rejects.toThrow();
    const oldKey = randomUUID();
    await write('bill_post', oldKey);
    await fence('table_state', oldKey);

    expect(await migrate(sql)).toContain(MINE);

    // 新的两种两张表都能写；原来的类型（几个分支各自加的）照旧；乱写的照旧拒绝
    for (const t of ['space_state', 'space_dispatch', 'bill_post', 'usage_open', 'table_merge', 'member_create', 'visit_incident', 'customer_note']) {
      await write(t);
      await fence(t);
    }
    await expect(write('space_nonsense')).rejects.toThrow();
    await expect(fence('room_state')).rejects.toThrow();
    // 升级前的记录还在
    const [kept] = await sql<{ n: number }[]>`
      SELECT (SELECT count(*) FROM idempotency_keys WHERE key = ${oldKey} AND op_type = 'bill_post') + (SELECT count(*) FROM op_fences WHERE key = ${oldKey} AND op_type = 'table_state') AS n`;
    expect(Number(kept!.n)).toBe(2);
    // 再跑一次迁移：什么都不做
    expect(await migrate(sql)).toEqual([]);
  });
});
