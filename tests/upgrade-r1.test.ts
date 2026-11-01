// R1.2 · 迁移 017 升级：
//   · 撤销与反结账时限仍是「不限」的改为 48 小时、跳档宽限仍是 0 的改为 15 分钟（店主 2026-10-29 签认），
//     手动调过的不动；没有设置过的按代码默认值（48 小时、15 分钟、收款前必须先开班）；
//   · 反结账退款的交班口径只用于升级之后开的班次：升级时已有的班次（含仍未交班的）里做的反结账仍只列提醒、不扣现金，
//     原单也不计入收款时的班次；之后开的班次里做的反结账扣减现金，原单仍算在收款时的班次。几个班次合起来对得上。

import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { businessDateOf } from '../src/shared/business-date';
import { buildApp } from '../src/server/app';
import { hashPassword } from '../src/server/auth/password';
import { loadConfig } from '../src/server/config';
import { createSql, type Sql } from '../src/server/db';
import { migrate } from '../src/server/migrate';
import { loadFrontdeskRules } from '../src/server/modules/frontdesk/common';
import { loadSettings } from '../src/server/modules/settings';
import { api, login, PASSWORD, TEST_DB } from './helpers';

const MIGRATIONS = new URL('../src/server/migrations/', import.meta.url);
const H = 3_600_000;
let sql: Sql;
let app: FastifyInstance | undefined;

/** 新建一个迁移到 016 的库 */
async function schemaAt016() {
  await sql.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await sql`CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const f of (await readdir(MIGRATIONS)).filter((x) => x.endsWith('.sql') && x < '017').sort()) {
    await sql.unsafe(await readFile(new URL(f, MIGRATIONS), 'utf8'));
    await sql`INSERT INTO schema_migrations (version) VALUES (${f})`;
  }
}

/** 迁移到 016 的库写入升级前的设置，再升级 */
async function upgradeWith(settings: Record<string, unknown>) {
  await schemaAt016();
  // 001、004 等迁移已经写入了一些默认设置：按升级前店主保存过的值覆盖
  for (const [key, value] of Object.entries(settings)) {
    await sql`
      INSERT INTO settings (key, value) VALUES (${key}, ${value === null ? sql`'null'::jsonb` : sql.json(value as never)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  }
  expect(await migrate(sql)).toEqual(['017_r1_funds.sql', '018_backfill.sql', '019_admin_members.sql', '020_technicians.sql', '021_clockroom.sql', '022_dining.sql', '023_dining_tables.sql', '024_rooms.sql', '025_cashier.sql', '026_expenses.sql', '027_requisitions.sql', '028_legacy_ledger.sql', '029_warehouses.sql', '030_supplier_settlement.sql', '031_stock_cycles.sql']);
}

beforeAll(() => {
  sql = createSql(TEST_DB, { max: 4 });
});
afterAll(async () => {
  await app?.close();
  await sql.end({ timeout: 5 });
});

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

describe('迁移 017 · 反结账退款的交班口径只用于升级之后开的班次', () => {
  it('升级前的反结账、升级时已有班次里的反结账按原口径；之后开的班次里的反结账扣减现金，原单仍算收款时的班次', async () => {
    await schemaAt016();
    const config = loadConfig({ databaseUrl: TEST_DB, env: 'test', logLevel: 'silent' });
    const hash = await hashPassword(PASSWORD);
    const staff = async (username: string, role: string) =>
      (await sql<{ id: number }[]>`
        INSERT INTO staff (username, display_name, role, password_hash) VALUES (${username}, ${username}, ${role}, ${hash}) RETURNING id`)[0]!.id;
    const cashier = await staff('cashier', 'clerk');
    const mgrb = await staff('mgrb', 'duty_manager');
    await staff('mgrc', 'duty_manager');
    await sql`INSERT INTO hand_tags (code, zone) VALUES ('A001', 'male'), ('A002', 'male')`;
    const now = Date.now();
    const today = businessDateOf(new Date(now), config.timezone, 6);
    // 016 时期：收银员、经理 B 都在 3 小时前开班、升级时仍未交班；收银员 2 小时前的现金结账 557 已被经理 B 反结账（v0.3 口径）
    const shift = async (no: string, staffId: number) =>
      (await sql<{ id: number }[]>`
        INSERT INTO shifts (shift_no, staff_id, business_date, started_at, opening_cash)
        VALUES (${no}, ${staffId}, ${today}, ${new Date(now - 3 * H)}, 0) RETURNING id`)[0]!.id;
    const sa = await shift('BC-UP-A', cashier);
    const sb = await shift('BC-UP-B', mgrb);
    const [c1] = await sql<{ id: number }[]>`
      INSERT INTO checkouts (checkout_no, client_key, status, total_amount, paid_amount, business_date, operator_id, created_at,
                             voided_at, voided_by, void_reason, void_business_date, shift_id, void_shift_id)
      VALUES ('JZ-UP-0001', ${randomUUID()}, 'voided', 55700, 55700, ${today}, ${cashier}, ${new Date(now - 2 * H)},
              ${new Date(now - H)}, ${mgrb}, '收款方式记错', ${today}, ${sa}, ${sb})
      RETURNING id`;
    await sql`INSERT INTO checkout_payments (checkout_id, method, amount) VALUES (${c1!.id}, 'cash', 55700)`;

    expect(await migrate(sql)).toEqual(['017_r1_funds.sql', '018_backfill.sql', '019_admin_members.sql', '020_technicians.sql', '021_clockroom.sql', '022_dining.sql', '023_dining_tables.sql', '024_rooms.sql', '025_cashier.sql', '026_expenses.sql', '027_requisitions.sql', '028_legacy_ledger.sql', '029_warehouses.sql', '030_supplier_settlement.sql', '031_stock_cycles.sql']);
    const legacy = await sql<{ shiftNo: string; legacyRefund: boolean }[]>`SELECT shift_no, legacy_refund FROM shifts ORDER BY id`;
    expect(legacy).toEqual([
      { shiftNo: 'BC-UP-A', legacyRefund: true },
      { shiftNo: 'BC-UP-B', legacyRefund: true },
    ]);

    // 升级之后：收银员（仍在升级前开的班上）现金结账两张 499；经理 C 新开班（新口径）反结账一张，经理 B（升级前开的班）反结账另一张
    app = await buildApp(sql, config);
    const [a, b, c] = [await login(app, 'cashier'), await login(app, 'mgrb'), await login(app, 'mgrc')];
    const settle = async (tagCode: string) => {
      const v = await api(app!, a, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode, zone: 'male' }] });
      expect(v.status).toBe(201);
      const r = await api(app!, a, 'POST', '/api/frontdesk/checkouts', {
        clientKey: randomUUID(), visitIds: [v.body.visits[0].id], expectedTotal: 49900, payments: [{ method: 'cash', amount: 49900 }],
      });
      expect(r.status).toBe(200);
      return r.body.id as number;
    };
    const c2 = await settle('A001');
    const c3 = await settle('A002');
    const sc = (await api(app, c, 'POST', '/api/shifts', { openingCash: 0 })).body;
    expect((await sql<{ legacyRefund: boolean }[]>`SELECT legacy_refund FROM shifts WHERE id = ${sc.id}`)[0]!.legacyRefund).toBe(false);
    expect((await api(app, c, 'POST', `/api/frontdesk/checkouts/${c2}/void`, { reason: '客人投诉退款' })).status).toBe(200);
    expect((await api(app, b, 'POST', `/api/frontdesk/checkouts/${c3}/void`, { reason: '收款方式记错' })).status).toBe(200);

    const summary = async (cookie: string) => (await api(app!, cookie, 'GET', '/api/shifts/current')).body.shift.summary;
    // 收银员：c1、c3 的反结账按原口径（不计入），c2 的反结账按新口径（仍算在这里）
    const sumA = await summary(a);
    expect(sumA.checkouts).toEqual({ count: 1, total: 49900 });
    expect(sumA.cash).toEqual({ opening: 0, checkout: 49900, recharge: 0, expected: 49900 });
    // 经理 B（升级前开的班）：两张反结账只列提醒，不扣现金
    const sumB = await summary(b);
    expect(sumB.voids.map((v: { checkoutNo: string; cashRefund?: number }) => [v.checkoutNo, v.cashRefund])).toEqual([
      ['JZ-UP-0001', undefined],
      [expect.any(String), undefined],
    ]);
    expect(sumB.refunds).toBeUndefined();
    expect(sumB.cash).toEqual({ opening: 0, checkout: 0, recharge: 0, expected: 0 });
    // 经理 C（升级后开的班）：退现金 499，扣减应有现金
    const sumC = await summary(c);
    expect(sumC.refunds).toEqual({ count: 1, total: 49900, byMethod: [{ method: 'cash', amount: 49900 }] });
    expect(sumC.cash).toEqual({ opening: 0, checkout: 0, recharge: 0, refund: 49900, expected: -49900 });
    // 同一钱箱合起来：收了 557 + 499 + 499 现金、全部退回，应有现金合计为 0
    expect(sumA.cash.expected + sumB.cash.expected + sumC.cash.expected).toBe(0);
  });
});
