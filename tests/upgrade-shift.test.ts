// G3 复测 · 迁移 016 升级兼容：已在用交班（迁移到 015）的库升级后，
//   · 升级时仍未交班的班次：升级前的充值、结账没有记班次，按原来的时间窗口（开班之后本人经办）补算，升级后的收款按班次记入；
//   · 升级前已交班的班次保留交班时的快照；升级后开的班次只按班次汇总。

import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { businessDateOf } from '../src/shared/business-date';
import { buildApp } from '../src/server/app';
import { hashPassword } from '../src/server/auth/password';
import { loadConfig } from '../src/server/config';
import { createSql, type Sql } from '../src/server/db';
import type { Actor } from '../src/server/lib/context';
import { migrate } from '../src/server/migrate';
import { checkout } from '../src/server/modules/frontdesk/checkout';
import { checkin } from '../src/server/modules/frontdesk/visits';
import { recharge } from '../src/server/modules/wallet';
import { api, login, PASSWORD, TEST_DB } from './helpers';

const config = loadConfig({ databaseUrl: TEST_DB, env: 'test', logLevel: 'silent' });
const MIGRATIONS = new URL('../src/server/migrations/', import.meta.url);
const H = 3_600_000;
const OLD_SUMMARY = { note: '升级前交班的快照' };

let sql: Sql;
let app: FastifyInstance;
let openShiftId: number;
let closedShiftId: number;
let memberId: number;

beforeAll(async () => {
  sql = createSql(TEST_DB, { max: 10 });
  await sql.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await sql`CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const f of (await readdir(MIGRATIONS)).filter((x) => x.endsWith('.sql') && x < '016').sort()) {
    await sql.unsafe(await readFile(new URL(f, MIGRATIONS), 'utf8'));
    await sql`INSERT INTO schema_migrations (version) VALUES (${f})`;
  }
  const hash = await hashPassword(PASSWORD);
  const [owner] = await sql<{ id: number }[]>`
    INSERT INTO staff (username, display_name, role, password_hash) VALUES ('owner', '老店主', 'owner', ${hash}) RETURNING id`;
  const [clerk] = await sql<{ id: number }[]>`
    INSERT INTO staff (username, display_name, role, password_hash) VALUES ('clerk', '老店员', 'clerk', ${hash}) RETURNING id`;
  const [member] = await sql<{ id: number }[]>`
    INSERT INTO members (member_no, name, phone, created_by) VALUES ('V0001', '升级前会员', '19900001111', ${owner!.id}) RETURNING id`;
  memberId = member!.id;
  await sql`INSERT INTO hand_tags (code, zone) VALUES ('A001', 'male')`;
  const now = Date.now();
  const today = businessDateOf(new Date(now), config.timezone, 6);
  // 015 时期：店员 2 小时前开班、仍未交班；另有一个已交班的旧班次
  const [s] = await sql<{ id: number }[]>`
    INSERT INTO shifts (shift_no, staff_id, business_date, started_at, opening_cash)
    VALUES ('BC-UP-OPEN', ${clerk!.id}, ${today}, ${new Date(now - 2 * H)}, 10000) RETURNING id`;
  openShiftId = s!.id;
  const [c] = await sql<{ id: number }[]>`
    INSERT INTO shifts (shift_no, staff_id, status, business_date, started_at, opening_cash, ended_at, expected_cash, counted_cash, summary, closed_by)
    VALUES ('BC-UP-OLD', ${owner!.id}, 'closed', ${today}, ${new Date(now - 6 * H)}, 0, ${new Date(now - 5 * H)}, 0, 0, ${sql.json(OLD_SUMMARY)}, ${owner!.id})
    RETURNING id`;
  closedShiftId = c!.id;

  // 用现版本的记账流程写入升级前的单据。现版本会写充值单、结账单的班次（016 才有），写入期间临时加这两列，迁移前删掉
  await sql`ALTER TABLE recharges ADD COLUMN shift_id bigint`;
  await sql`ALTER TABLE checkouts ADD COLUMN shift_id bigint`;
  // 现版本结账按来访的「门票计到的时间」计价（017 才有）；收款前必须先开班的规则（R1.2）在升级前不存在
  await sql`ALTER TABLE visits ADD COLUMN ticket_end_at timestamptz`;
  await sql`ALTER TABLE checkout_payments ADD COLUMN approved_by bigint`;
  await sql`INSERT INTO settings (key, value) VALUES ('require_open_shift', 'false'::jsonb)`;
  // 现版本结账时核对补录记录（018 才有）：写入期间临时建表，迁移前删掉
  await sql.unsafe(await readFile(new URL('018_backfill.sql', MIGRATIONS), 'utf8'));
  // 现版本读会员资料带渠道来源（019 才有）
  await sql`ALTER TABLE members ADD COLUMN channel text`;
  // 现版本结账时收尾钟房的钟单（021 才有）：写入期间临时建一张最小的表，迁移前删掉
  await sql`CREATE TABLE technician_sessions (id bigint, visit_id bigint, status text)`;
  const deps = { sql, config };
  const as = (id: number, username: string): Actor => ({ id, username, displayName: username, role: username === 'owner' ? 'owner' : 'clerk', duties: [], mustChangePassword: false });
  const cash = (amount: number) => ({ idempotencyKey: randomUUID(), memberId, planId: null, paidAmount: amount, bonusAmount: 0, paymentMethod: 'cash' as const, paymentConfirmed: true as const });
  // 开班之后店员的现金充值 300（计入）；开班之前店员的充值 50、店主的充值 70（都不计入）
  await recharge(deps, cash(30000), { actor: as(clerk!.id, 'clerk') });
  await recharge(deps, cash(5000), { actor: as(clerk!.id, 'clerk'), at: new Date(now - 3 * H) });
  await recharge(deps, cash(7000), { actor: as(owner!.id, 'owner') });
  // 开班之后店员的现金结账 499（计入）
  const v = await checkin(deps, { clientKey: randomUUID(), guests: [{ tagCode: 'A001', zone: 'male' }] }, { actor: as(clerk!.id, 'clerk'), at: new Date(now - H) });
  await checkout(deps, { clientKey: randomUUID(), visitIds: [v.visits[0]!.id], expectedTotal: 49900, payments: [{ method: 'cash', amount: 49900 }] }, { actor: as(clerk!.id, 'clerk') });
  await sql`ALTER TABLE recharges DROP COLUMN shift_id`;
  await sql`ALTER TABLE checkouts DROP COLUMN shift_id`;
  await sql`ALTER TABLE visits DROP COLUMN ticket_end_at`;
  await sql`ALTER TABLE checkout_payments DROP COLUMN approved_by`;
  await sql`DELETE FROM settings WHERE key = 'require_open_shift'`;
  await sql`DROP TABLE backfill_entries`;
  await sql`ALTER TABLE members DROP COLUMN channel`;
  await sql`DROP TABLE technician_sessions`;

  expect(await migrate(sql)).toEqual(['016_shift_boundary.sql', '017_r1_funds.sql', '018_backfill.sql', '019_admin_members.sql', '020_technicians.sql', '021_clockroom.sql', '022_dining.sql', '023_dining_tables.sql']);
  app = await buildApp(sql, config);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await sql?.end({ timeout: 5 });
});

describe('迁移 016 升级', () => {
  it('升级前的班次标为按时间窗口补算；升级前的单据没有记班次', async () => {
    const rows = await sql<{ shiftNo: string; legacyWindow: boolean }[]>`SELECT shift_no, legacy_window FROM shifts ORDER BY id`;
    expect(rows).toEqual([
      { shiftNo: 'BC-UP-OPEN', legacyWindow: true },
      { shiftNo: 'BC-UP-OLD', legacyWindow: true },
    ]);
    const [n] = await sql<{ n: number }[]>`
      SELECT (SELECT count(*) FROM recharges WHERE shift_id IS NOT NULL) + (SELECT count(*) FROM checkouts WHERE shift_id IS NOT NULL) AS n`;
    expect(n!.n).toBe(0);
  });

  it('升级时仍未交班的班次：升级前开班之后本人的单据按时间窗口补算，升级后的收款按班次记入，交班快照包含两者', async () => {
    const clerk = await login(app, 'clerk');
    const cur = (await api(app, clerk, 'GET', '/api/shifts/current')).body.shift;
    expect(cur.id).toBe(openShiftId);
    expect(cur.summary.recharges).toMatchObject({ count: 1, paid: 30000 });
    expect(cur.summary.checkouts).toEqual({ count: 1, total: 49900 });
    expect(cur.summary.cash.expected).toBe(10000 + 30000 + 49900);

    const after = await api(app, clerk, 'POST', '/api/recharges', {
      idempotencyKey: randomUUID(), memberId, planId: null, paidAmount: 20000, bonusAmount: 0, paymentMethod: 'cash', paymentConfirmed: true,
    });
    expect(after.status).toBe(200);
    const [r] = await sql<{ shiftId: number }[]>`SELECT shift_id FROM recharges WHERE id = ${after.body.recharge.id}`;
    expect(r!.shiftId).toBe(openShiftId);
    const closed = await api(app, clerk, 'POST', `/api/shifts/${openShiftId}/close`, { countedCash: 109900, expectedCash: 109900 });
    expect(closed.status).toBe(200);
    expect(closed.body.summary.recharges).toMatchObject({ count: 2, paid: 50000 });
    expect(closed.body.summary.checkouts).toEqual({ count: 1, total: 49900 });
  });

  it('升级前已交班的班次保留原快照；升级后开的班次只按班次汇总', async () => {
    const owner = await login(app, 'owner');
    expect((await api(app, owner, 'GET', `/api/shifts/${closedShiftId}`)).body.summary).toEqual(OLD_SUMMARY);
    const clerk = await login(app, 'clerk');
    const s = await api(app, clerk, 'POST', '/api/shifts', { openingCash: 0 });
    expect(s.status).toBe(200);
    expect(s.body.summary.recharges.count).toBe(0);
    const [row] = await sql<{ legacyWindow: boolean }[]>`SELECT legacy_window FROM shifts WHERE id = ${s.body.id}`;
    expect(row!.legacyWindow).toBe(false);
  });
});
