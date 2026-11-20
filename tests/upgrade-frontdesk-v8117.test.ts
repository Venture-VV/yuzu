// 8.1.17 的两个迁移（docs/FRONTDESK_V8117.md 第 7 节）：从 198 之前的库升上来——
//   · 198 本店价改价留痕：以前的改价记录一行不改（都是全公司的）；来源多一种 store_price（另一条开发线先加的来源还在），
//     本店价的记录要带门店、不能是本店，全公司的不带门店；
//   · 199 退菜按出品口的权限：后台岗位权限里加了「前台挂账」的补上三项退菜权限，去掉了的也去掉，没动的不动，再跑一次不变；
//     异常多一种「超时提醒」，记级别；同一次来访每一级只能有一条；老的异常一行不改。

import { readdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSql, type Sql } from '../src/server/db';
import { migrate } from '../src/server/migrate';
import { TEST_DB } from './helpers';
import { resetPublicSchema } from './test-db';

const MIGRATIONS = new URL('../src/server/migrations/', import.meta.url);
const FIRST = '198_store_price_changes.sql';
let sql: Sql;

beforeAll(() => {
  sql = createSql(TEST_DB, { max: 4 });
});
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

/** 198 之前的库：编号小于 198 的迁移都执行过 */
async function schemaBefore198() {
  await resetPublicSchema(sql);
  await sql`CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const f of (await readdir(MIGRATIONS)).filter((x) => x.endsWith('.sql') && x < FIRST).sort()) {
    await sql.unsafe(await readFile(new URL(f, MIGRATIONS), 'utf8'));
    await sql`INSERT INTO schema_migrations (version) VALUES (${f})`;
  }
}

describe('迁移 198、199', () => {
  it('老数据一行不改；约束在当时的上面追加；岗位权限补上退菜按出品口；再跑一次不变', async () => {
    await schemaBefore198();
    const [staff] = await sql<{ id: number }[]>`INSERT INTO staff (username, display_name, role, password_hash) VALUES ('u_v8117', '升级店员', 'clerk', 'x') RETURNING id`;
    const [item] = await sql<{ id: number }[]>`INSERT INTO service_items (name, category, price) VALUES ('升级面', '面食', 3800) RETURNING id`;
    const [store] = await sql<{ id: number }[]>`INSERT INTO stores (code, name, entity_id) VALUES ('UP', '升级店', 1) RETURNING id`;
    await sql`
      INSERT INTO dish_price_changes (item_id, item_name, tier, old_price, new_price, reason, source, staff_id)
      VALUES (${item!.id}, '升级面', 'standard', 3600, 3800, '食材涨价', 'dishes', ${staff!.id})`;
    // 另一条开发线先在来源里加了一种（模拟）：升级以后还在
    await sql.unsafe(`ALTER TABLE dish_price_changes DROP CONSTRAINT dish_price_changes_source_check;
      ALTER TABLE dish_price_changes ADD CONSTRAINT dish_price_changes_source_check CHECK (source IN ('dishes', 'import', 'catalog', 'price_list', 'other_line'))`);
    // 来访与一条老的异常
    const [tag] = await sql<{ id: number }[]>`INSERT INTO hand_tags (code, zone, kind) VALUES ('UV01', 'male', 'normal') RETURNING id`;
    const [bill] = await sql<{ id: number }[]>`INSERT INTO bills (bill_no, kind, business_date, opened_at) VALUES ('ZD-UV-1', 'visit', current_date, now()) RETURNING id`;
    const [visit] = await sql<{ id: number }[]>`
      INSERT INTO visits (visit_no, bill_id, tag_id, zone, business_date, checked_in_at, checked_in_by, checkin_key)
      VALUES ('LF-UV-1', ${bill!.id}, ${tag!.id}, 'male', current_date, now() - interval '13 hours', ${staff!.id}, ${randomUUID()}) RETURNING id`;
    await sql`
      INSERT INTO visit_incidents (visit_id, kind, note, op_key, business_date, created_by)
      VALUES (${visit!.id}, 'remind', '已当面提醒', ${randomUUID()}, current_date, ${staff!.id})`;
    await sql`
      INSERT INTO settings (key, value) VALUES ('role_permissions', ${sql.json({
        backoffice: { add: ['dining.order', 'frontdesk.operate'], remove: [] },
        clerk: { add: [], remove: ['frontdesk.operate', 'dining.order'] },
        account_manager: { add: ['dining.kitchen'], remove: [] },
        duty_manager: {},
      })})`;

    const applied = await migrate(sql);
    expect(applied).toEqual(expect.arrayContaining([FIRST, '199_dining_voids_v8117.sql']));

    // ── 198 ──
    const old = await sql<{ source: string; storeId: number | null; basePrice: number | null }[]>`SELECT source, store_id, base_price FROM dish_price_changes`;
    expect(old).toEqual([{ source: 'dishes', storeId: null, basePrice: null }]);
    const ins = (source: string, storeId: number | null, basePrice: number | null) => sql`
      INSERT INTO dish_price_changes (item_id, item_name, tier, old_price, new_price, reason, source, staff_id, store_id, base_price)
      VALUES (${item!.id}, '升级面', 'standard', NULL, 3500, '分店定价', ${source}, ${staff!.id}, ${storeId}, ${basePrice})`;
    await ins('store_price', store!.id, 3800);
    await ins('other_line', null, null);
    await expect(ins('store_price', null, 3800)).rejects.toThrow();
    await expect(ins('store_price', 1, 3800)).rejects.toThrow();
    await expect(ins('catalog', store!.id, null)).rejects.toThrow();
    await expect(ins('catalog', null, 3800)).rejects.toThrow();
    await expect(sql`UPDATE dish_price_changes SET reason = '改' WHERE source = 'store_price'`).rejects.toThrow();

    // ── 199：岗位权限 ──
    const perms = async () => (await sql<{ value: Record<string, unknown> }[]>`SELECT value FROM settings WHERE key = 'role_permissions'`)[0]!.value;
    const v = await perms();
    expect(v).toEqual({
      backoffice: { add: ['dining.order', 'frontdesk.operate', 'dining.voidRestaurant', 'dining.voidWater', 'dining.voidFruit'], remove: [] },
      clerk: { add: [], remove: ['frontdesk.operate', 'dining.order', 'dining.voidRestaurant', 'dining.voidWater', 'dining.voidFruit'] },
      account_manager: { add: ['dining.kitchen'], remove: [] },
      duty_manager: {},
    });
    const m199 = await readFile(new URL('199_dining_voids_v8117.sql', MIGRATIONS), 'utf8');
    await sql.unsafe(m199.slice(m199.indexOf('UPDATE settings s'), m199.indexOf('-- ───────────── 2.')));
    expect(await perms()).toEqual(v);

    // ── 199：超时提醒 ──
    const remind = (kind: string, hours: number | null, note = '在店超过 12 小时') => sql`
      INSERT INTO visit_incidents (visit_id, kind, note, overtime_hours, op_key, business_date, created_by)
      VALUES (${visit!.id}, ${kind}, ${note}, ${hours}, ${randomUUID()}, current_date, ${staff!.id})`;
    await remind('overtime', 12);
    await expect(remind('overtime', 12)).rejects.toThrow();
    await expect(remind('overtime', null)).rejects.toThrow();
    await expect(remind('overtime', 6)).rejects.toThrow();
    await expect(remind('remind', 12)).rejects.toThrow();
    await remind('overtime', 24);
    await remind('remind', null, '');
    const kinds = await sql<{ kind: string; hours: number | null }[]>`SELECT kind, overtime_hours AS hours FROM visit_incidents ORDER BY id`;
    expect(kinds).toEqual([
      { kind: 'remind', hours: null },
      { kind: 'overtime', hours: 12 },
      { kind: 'overtime', hours: 24 },
      { kind: 'remind', hours: null },
    ]);
    expect(await migrate(sql)).toEqual([]);
  });
});
