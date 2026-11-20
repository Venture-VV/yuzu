// 8.1.15 块 B 的迁移 188（docs/DINING_V8115.md 第 1 节）：从 188 之前的库升上来——
//   · 老的桌台都是「可用」，开着的开台、结过的开台、账单、明细照旧（结过的开台照旧改不了）；
//   · 职责约束多了「康美部」、别的职责照旧；操作编号的类型多了 table_state、table_merge、原来的类型照旧；
//   · 后台给哪个岗位加了「餐饮点单」，也给它加上三个出品口的下单权限（没加的不动，再跑一次不变）；
//   · 出品单多了整单备注、送达房号两列（老的出品单是空的）；退菜审计按明细查的索引建好了。

import { readdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSql, type Sql } from '../src/server/db';
import { migrate } from '../src/server/migrate';
import { TEST_DB } from './helpers';
import { resetPublicSchema } from './test-db';

const MIGRATIONS = new URL('../src/server/migrations/', import.meta.url);
const MINE = '188_dining_tables_v8115.sql';
let sql: Sql;

beforeAll(() => {
  sql = createSql(TEST_DB, { max: 4 });
});
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

/** 188 之前的库：编号小于 188 的迁移都执行过 */
async function schemaBefore188() {
  await resetPublicSchema(sql);
  await sql`CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const f of (await readdir(MIGRATIONS)).filter((x) => x.endsWith('.sql') && x < MINE).sort()) {
    await sql.unsafe(await readFile(new URL(f, MIGRATIONS), 'utf8'));
    await sql`INSERT INTO schema_migrations (version) VALUES (${f})`;
  }
}

describe('迁移 188：桌台动作、出品口下单权限与康美部', () => {
  it('老的桌台、开台、账单照旧；约束追加；岗位权限补上出品口；再跑一次不变', async () => {
    await schemaBefore188();
    const [staff] = await sql<{ id: number }[]>`
      INSERT INTO staff (username, display_name, role, password_hash, duties) VALUES ('u_up', '升级店员', 'clerk', 'x', ARRAY['request']) RETURNING id`;
    const tables = await sql<{ id: number }[]>`INSERT INTO dining_tables (name, area, seats) VALUES ('U1', '散桌', 4), ('U2', '散桌', 4) RETURNING id`;
    const bills = await sql<{ id: number }[]>`
      INSERT INTO bills (bill_no, kind, business_date, status, closed_at) VALUES ('ZDU1', 'table', '2026-11-18', 'open', NULL), ('ZDU2', 'table', '2026-11-18', 'settled', now())
      RETURNING id`;
    const sessions = await sql<{ id: number }[]>`
      INSERT INTO table_sessions (session_no, bill_id, table_id, guests, business_date, opened_at, opened_by, open_key, status, closed_at, closed_by)
      VALUES ('KTU1', ${bills[0]!.id}, ${tables[0]!.id}, 2, '2026-11-18', now(), ${staff!.id}, ${randomUUID()}, 'open', NULL, NULL),
             ('KTU2', ${bills[1]!.id}, ${tables[1]!.id}, 3, '2026-11-18', now(), ${staff!.id}, ${randomUUID()}, 'settled', now(), ${staff!.id})
      RETURNING id`;
    await sql`
      INSERT INTO bill_lines (bill_id, source, name, unit_price, quantity, amount, post_key, business_date, posted_by)
      VALUES (${bills[0]!.id}, 'dining', '老的菜', 3800, 1, 3800, ${randomUUID()}, '2026-11-18', ${staff!.id})`;
    await sql`UPDATE bills SET amount_cents = 3800, line_count = 1 WHERE id = ${bills[0]!.id}`;
    await sql`
      INSERT INTO settings (key, value) VALUES ('role_permissions', ${sql.json({
        backoffice: { add: ['dining.order', 'frontdesk.operate'], remove: [] },
        account_manager: { add: ['dining.kitchen'], remove: [] },
        clerk: { add: [], remove: ['dining.order'] },
      })})`;

    expect(await migrate(sql)).toContain(MINE);

    // 桌台、开台、账单照旧
    const after = await sql<{ name: string; state: string; maintenanceReason: string | null; stateSince: string | null }[]>`
      SELECT name, state, maintenance_reason, state_since FROM dining_tables ORDER BY id`;
    expect(after).toEqual([
      { name: 'U1', state: 'available', maintenanceReason: null, stateSince: null },
      { name: 'U2', state: 'available', maintenanceReason: null, stateSince: null },
    ]);
    const ss = await sql<{ sessionNo: string; status: string; mergedInto: number | null }[]>`SELECT session_no, status, merged_into FROM table_sessions ORDER BY id`;
    expect(ss).toEqual([
      { sessionNo: 'KTU1', status: 'open', mergedInto: null },
      { sessionNo: 'KTU2', status: 'settled', mergedInto: null },
    ]);
    expect((await sql<{ amountCents: number; lineCount: number }[]>`SELECT amount_cents, line_count FROM bills WHERE id = ${bills[0]!.id}`)[0]).toEqual({ amountCents: 3800, lineCount: 1 });
    // 结过的开台照旧改不了；开着的能并台（合并到自己不行）
    await expect(sql`UPDATE table_sessions SET merged_into = ${sessions[0]!.id} WHERE id = ${sessions[1]!.id}`).rejects.toThrow();
    await expect(sql`UPDATE table_sessions SET merged_into = ${sessions[0]!.id} WHERE id = ${sessions[0]!.id}`).rejects.toThrow();
    // 维修要原因与预计恢复时间
    await expect(sql`UPDATE dining_tables SET state = 'maintenance' WHERE id = ${tables[0]!.id}`).rejects.toThrow();
    await sql`UPDATE dining_tables SET state = 'maintenance', maintenance_reason = '桌腿松了', maintenance_until = now() + interval '1 hour' WHERE id = ${tables[0]!.id}`;
    // table_events 只追加
    const [e] = await sql<{ id: number }[]>`
      INSERT INTO table_events (table_id, kind, op_key, operator_id, business_date) VALUES (${tables[0]!.id}, 'clear', ${randomUUID()}, ${staff!.id}, '2026-11-18') RETURNING id`;
    await expect(sql`UPDATE table_events SET reason = '改' WHERE id = ${e!.id}`).rejects.toThrow();
    await expect(sql`DELETE FROM table_events WHERE id = ${e!.id}`).rejects.toThrow();
    await expect(sql`INSERT INTO table_events (table_id, kind, op_key, operator_id, business_date) VALUES (${tables[0]!.id}, 'merge', ${randomUUID()}, ${staff!.id}, '2026-11-18')`).rejects.toThrow();

    // 职责：康美部能存，原来的照旧，乱写的照旧拒绝
    await sql`UPDATE staff SET duties = ARRAY['kangmei', 'request', 'concierge_manager'] WHERE id = ${staff!.id}`;
    await expect(sql`UPDATE staff SET duties = ARRAY['nobody'] WHERE id = ${staff!.id}`).rejects.toThrow();
    // 操作编号的类型：新的两种能写，原来的照旧
    for (const t of ['table_state', 'table_merge', 'checkin', 'customer_note']) {
      await sql`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${randomUUID()}, ${t}, 'h', 1, ${staff!.id})`;
      await sql`INSERT INTO op_fences (key, op_type, staff_id) VALUES (${randomUUID()}, ${t}, ${staff!.id})`;
    }
    // 出品单的两列、审计索引
    const cols = await sql<{ columnName: string; columnDefault: string }[]>`
      SELECT column_name, column_default FROM information_schema.columns WHERE table_name = 'kitchen_items' AND column_name IN ('order_note', 'deliver_room') ORDER BY column_name`;
    expect(cols.map((c) => c.columnName)).toEqual(['deliver_room', 'order_note']);
    expect((await sql`SELECT 1 FROM pg_indexes WHERE indexname = 'audit_logs_void_line_idx'`).length).toBe(1);

    // 岗位权限：加了「餐饮点单」的补上三个出品口；没加的、去掉了的不动
    const perms = async () => (await sql<{ value: Record<string, { add: string[]; remove: string[] }> }[]>`SELECT value FROM settings WHERE key = 'role_permissions'`)[0]!.value;
    const v = await perms();
    // （之后的迁移 199，8.1.17 BW-4：加了「前台挂账」的再补上三个出品口的退菜权限）
    expect(v.backoffice).toEqual({
      add: ['dining.order', 'frontdesk.operate', 'dining.orderRestaurant', 'dining.orderWater', 'dining.orderFruit', 'dining.voidRestaurant', 'dining.voidWater', 'dining.voidFruit'],
      remove: [],
    });
    expect(v.account_manager).toEqual({ add: ['dining.kitchen'], remove: [] });
    expect(v.clerk).toEqual({ add: [], remove: ['dining.order'] });
    // 职责名单、岗位权限两段再跑一次：什么都不变（职责照旧认、权限不重复加）
    const m188 = await readFile(new URL(MINE, MIGRATIONS), 'utf8');
    const part = (from: string, to: string) => m188.slice(m188.indexOf(from), m188.indexOf(to));
    await sql.unsafe(part('-- ───────────── 职责', '-- ───────────── 操作编号'));
    await sql.unsafe(part('-- ───────────── 后台岗位权限', '-- ───────────── 台账查退菜'));
    expect(await perms()).toEqual(v);
    await sql`UPDATE staff SET duties = ARRAY['kangmei', 'legal'] WHERE id = ${staff!.id}`;
    expect(await migrate(sql)).toEqual([]);
  });
});
