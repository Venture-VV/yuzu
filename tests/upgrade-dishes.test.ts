// 8.1.14 → 8.1.15 升级（迁移 189 菜品管理，docs/DISHES_V8115.md 第 2 节）：在有数据的库上升级——
//   · 老的价目（各档价格、出品档口、点单分类）一行不动，升级以后就是菜品表里的菜；不是菜品的项目照旧不是；
//   · 老的订单不坏：账单明细的单价与金额不动，出品单多一项「套餐内容」、老的都是空的，状态照常能往下走；
//   · 新表都是空的（没有做法、加料、套餐、改价记录），点单页的菜单与以前一样（不带那三项）；
//   · 升级以后在菜品管理里改价：只记改价记录，老订单的明细还是当时的价；
//   · 再跑一次迁移什么都不做。

import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app';
import { hashPassword } from '../src/server/auth/password';
import { loadConfig } from '../src/server/config';
import { createSql, type Sql } from '../src/server/db';
import { migrate } from '../src/server/migrate';
import type { DiningMenu, KitchenBoard } from '../src/shared/dining';
import type { DishesBoard } from '../src/shared/dishes';
import { api, login, PASSWORD, TEST_DB } from './helpers';
import { resetPublicSchema } from './test-db';

const MIGRATIONS = new URL('../src/server/migrations/', import.meta.url);
const NEW = ['189_dishes.sql'];
let sql: Sql;
let app: FastifyInstance | undefined;

beforeAll(() => {
  sql = createSql(TEST_DB, { max: 4 });
});
afterAll(async () => {
  await app?.close();
  await sql.end({ timeout: 5 });
});

/** 8.1.14 的库：除了这次新加的迁移都执行过 */
async function schemaBefore189() {
  await resetPublicSchema(sql);
  await sql`CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const f of (await readdir(MIGRATIONS)).filter((x) => x.endsWith('.sql') && !NEW.includes(x)).sort()) {
    await sql.unsafe(await readFile(new URL(f, MIGRATIONS), 'utf8'));
    await sql`INSERT INTO schema_migrations (version) VALUES (${f})`;
  }
}

describe('8.1.14 → 8.1.15：迁移 189（菜品管理）', () => {
  it('老的价目、订单、出品单不坏；升级以后老的菜就在菜品表里，改价只留记录、不动老订单', async () => {
    await schemaBefore189();
    const today = '2026-11-18';
    const [owner] = await sql<{ id: number }[]>`
      INSERT INTO staff (username, display_name, role, password_hash, must_change_password) VALUES ('owner', '老店主', 'owner', ${await hashPassword(PASSWORD)}, false) RETURNING id`;
    const [hot] = await sql<{ id: number }[]>`INSERT INTO kitchen_stations (name, created_by) VALUES ('热菜', ${owner!.id}) RETURNING id`;
    const [bar] = await sql<{ id: number }[]>`INSERT INTO kitchen_stations (name, created_by) VALUES ('水吧', ${owner!.id}) RETURNING id`;
    // 老的价目：两道菜（一道两档价格、设过点单分类；一道一档、没设过）与一个不是菜品的项目
    const [chicken] = await sql<{ id: number }[]>`
      INSERT INTO service_items (name, category, price, station_id, dining_outlet, dining_group) VALUES ('宫保鸡丁', '餐饮', 4800, ${hot!.id}, 'restaurant', '餐饮') RETURNING id`;
    await sql`INSERT INTO service_item_prices (item_id, tier, price) VALUES (${chicken!.id}, 'standard', 4800), (${chicken!.id}, 'premium', 6800)`;
    const [tea] = await sql<{ id: number }[]>`INSERT INTO service_items (name, category, price, station_id) VALUES ('柠檬茶', '饮品', 1500, ${bar!.id}) RETURNING id`;
    await sql`INSERT INTO service_item_prices (item_id, tier, price) VALUES (${tea!.id}, 'standard', 1500)`;
    const [ticket] = await sql<{ id: number }[]>`INSERT INTO service_items (name, category, price) VALUES ('汤泉门票', '门票', 12800) RETURNING id`;
    await sql`INSERT INTO service_item_prices (item_id, tier, price) VALUES (${ticket!.id}, 'standard', 12800)`;
    // 老的订单：一位在店客人点了两份宫保鸡丁（少辣），还没做
    const [tag] = await sql<{ id: number }[]>`INSERT INTO hand_tags (code, zone) VALUES ('A001', 'male') RETURNING id`;
    const [bill] = await sql<{ id: number }[]>`
      INSERT INTO bills (bill_no, kind, business_date, amount_cents, line_count) VALUES ('ZD-OLD-1', 'visit', ${today}, 9600, 1) RETURNING id`;
    const [visit] = await sql<{ id: number }[]>`
      INSERT INTO visits (visit_no, bill_id, tag_id, zone, business_date, checked_in_at, checked_in_by, checkin_key)
      VALUES ('LF-OLD-1', ${bill!.id}, ${tag!.id}, 'male', ${today}, now(), ${owner!.id}, ${randomUUID()}) RETURNING id`;
    const [line] = await sql<{ id: number }[]>`
      INSERT INTO bill_lines (bill_id, source, item_id, tier, name, unit_price, quantity, amount, post_key, business_date, posted_by, posted_at)
      VALUES (${bill!.id}, 'dining', ${chicken!.id}, 'standard', '宫保鸡丁（标准）', 4800, 2, 9600, ${randomUUID()}, ${today}, ${owner!.id}, now()) RETURNING id`;
    const [kitchen] = await sql<{ id: number }[]>`
      INSERT INTO kitchen_items (order_no, bill_line_id, visit_id, item_id, station_id, quantity, note, business_date, created_by, created_at)
      VALUES ('CD-OLD-1', ${line!.id}, ${visit!.id}, ${chicken!.id}, ${hot!.id}, 2, '少辣', ${today}, ${owner!.id}, now()) RETURNING id`;
    const itemsBefore = await sql`SELECT id, name, category, price, active, station_id, dining_outlet, dining_group, updated_at FROM service_items ORDER BY id`;
    const pricesBefore = await sql`SELECT item_id, tier, price FROM service_item_prices ORDER BY item_id, tier`;
    const lineBefore = await sql`SELECT * FROM bill_lines WHERE id = ${line!.id}`;

    expect(await migrate(sql)).toEqual(NEW);

    // 老的价目、明细一行不动
    expect(await sql`SELECT id, name, category, price, active, station_id, dining_outlet, dining_group, updated_at FROM service_items ORDER BY id`).toEqual(itemsBefore);
    expect(await sql`SELECT item_id, tier, price FROM service_item_prices ORDER BY item_id, tier`).toEqual(pricesBefore);
    expect(await sql`SELECT * FROM bill_lines WHERE id = ${line!.id}`).toEqual(lineBefore);
    expect((await sql<{ dishImageId: number | null }[]>`SELECT dish_image_id FROM service_items`).every((r) => r.dishImageId === null)).toBe(true);
    // 出品单：多一项套餐内容，老的是空的；口味备注、状态照旧
    expect(await sql`SELECT note, status, parts FROM kitchen_items WHERE id = ${kitchen!.id}`).toEqual([{ note: '少辣', status: 'queued', parts: [] }]);
    // 新表都是空的
    for (const table of ['dish_methods', 'dish_addons', 'dish_combo_items', 'dish_price_changes', 'dish_ops']) {
      expect((await sql.unsafe(`SELECT count(*)::int AS n FROM ${table}`))[0]!.n, table).toBe(0);
    }

    // 升级以后：老的菜就在菜品表里（出品口、价格照旧），不是菜品的不在
    app = await buildApp(sql, loadConfig({ databaseUrl: TEST_DB, env: 'test', logLevel: 'silent', integrations: { mock: true, liveConfigured: [] } }));
    const cookie = await login(app, 'owner');
    const board = (await api(app, cookie, 'GET', '/api/dining/dishes')).body as DishesBoard;
    expect(board.dishes.map((d) => `${d.name}|${d.outlet}|${d.group}|${d.slotAssigned}|${d.stationName}|${d.price}|${d.prices.length}|${d.active}`)).toEqual([
      '宫保鸡丁|restaurant|餐饮|true|热菜|4800|2|true',
      '柠檬茶|water|手作饮料|false|水吧|1500|1|true',
    ]);
    expect(board.dishes.every((d) => d.methods.length === 0 && d.addons.length === 0 && d.combo.length === 0 && d.imageUrl === null)).toBe(true);
    // 点单页的菜单与以前一样（不带做法、加料、套餐那三项）
    const menu = (await api(app, cookie, 'GET', '/api/dining/menu')).body as DiningMenu;
    expect(menu.dishes.map((d) => d.name)).toEqual(['宫保鸡丁', '柠檬茶']);
    expect(menu.dishes.every((d) => !('methods' in d) && !('addons' in d) && !('combo' in d))).toBe(true);
    // 厨房屏照常：老的出品单在，能开始做
    const kds = (await api(app, cookie, 'GET', '/api/kitchen')).body as KitchenBoard;
    expect(kds.items.map((k) => `${k.name}×${k.quantity}|${k.note}|${JSON.stringify(k.parts)}|${k.status}`)).toEqual(['宫保鸡丁×2|少辣|[]|queued']);
    expect((await api(app, cookie, 'POST', `/api/kitchen/items/${kitchen!.id}/start`, { from: 'queued' })).status).toBe(200);

    // 改价：记改价记录；老订单的明细还是当时的价
    const d = board.dishes[0]!;
    const priced = await api(app, cookie, 'POST', `/api/dining/dishes/${d.id}/price`, {
      clientKey: randomUUID(),
      prices: { standard: 5200, premium: 6800 },
      expected: { standard: 4800, premium: 6800 },
      reason: '升级后调价',
    });
    expect(priced.status, JSON.stringify(priced.body)).toBe(200);
    expect(await sql`SELECT tier, old_price, new_price, reason, source FROM dish_price_changes`).toEqual([
      { tier: 'standard', oldPrice: 4800, newPrice: 5200, reason: '升级后调价', source: 'dishes' },
    ]);
    expect(await sql`SELECT unit_price, amount FROM bill_lines WHERE id = ${line!.id}`).toEqual([{ unitPrice: 4800, amount: 9600 }]);
    expect((await sql<{ amountCents: number }[]>`SELECT amount_cents FROM bills WHERE id = ${bill!.id}`)[0]!.amountCents).toBe(9600);

    // 再跑一次什么都不做
    expect(await migrate(sql)).toEqual([]);
  });
});
