// 升级兼容：已在使用会员系统（只有 001 结构）的库，增量迁移到库存与采购版本后，
// 原有员工、会员余额、流水与幂等记录保持不变，会员业务照常，库存模块可用。

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app';
import { hashPassword } from '../src/server/auth/password';
import { loadConfig } from '../src/server/config';
import { createSql, type Sql } from '../src/server/db';
import type { Actor } from '../src/server/lib/context';
import { migrate } from '../src/server/migrate';
import { consume, recharge } from '../src/server/modules/wallet';
import { api, login, PASSWORD, TEST_DB } from './helpers';

let sql: Sql;
let app: FastifyInstance;
const config = loadConfig({ databaseUrl: TEST_DB, env: 'test', logLevel: 'silent' });
let memberId: number;
let rechargeKey: string;
let itemId: number;

beforeAll(async () => {
  sql = createSql(TEST_DB, { max: 10 });
  await sql.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  // 只建到第一版结构（会员 MVP）
  await sql`CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  await sql.unsafe(await readFile(new URL('../src/server/migrations/001_init.sql', import.meta.url), 'utf8'));
  await sql`INSERT INTO schema_migrations (version) VALUES ('001_init.sql')`;
  const hash = await hashPassword(PASSWORD);
  const [owner] = await sql<{ id: number }[]>`
    INSERT INTO staff (username, display_name, role, password_hash) VALUES ('owner', '老店主', 'owner', ${hash}) RETURNING id`;
  const [clerk] = await sql<{ id: number }[]>`
    INSERT INTO staff (username, display_name, role, password_hash) VALUES ('clerk', '老店员', 'clerk', ${hash}) RETURNING id`;
  const [member] = await sql<{ id: number }[]>`
    INSERT INTO members (member_no, name, phone, created_by) VALUES ('V0001', '升级前会员', '19900001111', ${owner!.id}) RETURNING id`;
  memberId = member!.id;

  // 用第一版就有的记账流程写入真实流水。现版本记账还会查作废登记表（006 才有）、写消费明细的价格档（009 才有），
  // 写入期间临时放一张空表、加一列，迁移前删掉，升级仍从「只有 001」的结构开始
  await sql`CREATE TABLE op_fences (key uuid, op_type text, staff_id bigint, created_at timestamptz)`;
  await sql`ALTER TABLE consumption_lines ADD COLUMN tier text`;
  // 升级前已有的消费项目（只有一个价格）
  const [item] = await sql<{ id: number }[]>`INSERT INTO service_items (name, category, price) VALUES ('升级前项目', '护理', 6800) RETURNING id`;
  itemId = item!.id;
  const ownerActor: Actor = { id: owner!.id, username: 'owner', displayName: '老店主', role: 'owner', duties: [], mustChangePassword: false };
  const clerkActor: Actor = { id: clerk!.id, username: 'clerk', displayName: '老店员', role: 'clerk', duties: [], mustChangePassword: false };
  const deps = { sql, config };
  rechargeKey = randomUUID();
  await recharge(deps, { idempotencyKey: rechargeKey, memberId, planId: null, paidAmount: 50000, bonusAmount: 5000, paymentMethod: 'cash', paymentConfirmed: true }, { actor: ownerActor });
  await consume(deps, { idempotencyKey: randomUUID(), memberId, customLines: [{ name: '升级前消费', amount: 12800 }], expectedTotal: 12800 }, { actor: clerkActor });
  await sql`DROP TABLE op_fences`;
  await sql`ALTER TABLE consumption_lines DROP COLUMN tier`;

  // 升级：增量执行 002 之后的全部迁移
  const applied = await migrate(sql);
  expect(applied).toEqual(['002_inventory.sql', '003_purchasing.sql', '004_frontdesk.sql', '005_frontdesk_g2.sql', '006_op_fences.sql', '007_manager_roles.sql', '008_locker_pool.sql', '009_price_tiers.sql']);
  app = await buildApp(sql, config);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await sql?.end({ timeout: 5 });
});

describe('升级后', () => {
  it('原有员工照常登录，岗位不变，库存职责默认为空', async () => {
    const owner = await login(app, 'owner');
    const clerk = await login(app, 'clerk');
    const me = await api(app, clerk, 'GET', '/api/auth/me');
    expect(me.body.staff).toMatchObject({ role: 'clerk', duties: [] });
    expect(me.body.permissions).toContain('consume.create');
    expect(me.body.permissions).not.toContain('inventory.read');
    expect((await api(app, owner, 'GET', '/api/auth/me')).body.permissions).toContain('inventory.approve');
  });

  it('会员余额与流水保持不变，会员业务照常，日结自检通过', async () => {
    const owner = await login(app, 'owner');
    const clerk = await login(app, 'clerk');
    const m = await api(app, clerk, 'GET', `/api/members/${memberId}`);
    expect(m.body).toMatchObject({ principalBalance: 37200, bonusBalance: 5000 });
    // 升级前的操作编号重放：仍识别为同一笔，不重复入账
    const replay = await api(app, owner, 'POST', '/api/recharges', {
      idempotencyKey: rechargeKey,
      memberId,
      planId: null,
      paidAmount: 50000,
      bonusAmount: 5000,
      paymentMethod: 'cash',
      paymentConfirmed: true,
    });
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    const c = await api(app, clerk, 'POST', '/api/consumptions', {
      idempotencyKey: randomUUID(),
      memberId,
      customLines: [{ name: '升级后消费', amount: 2000 }],
      expectedTotal: 2000,
      expectedSplit: { principal: 2000, bonus: 0 },
    });
    expect(c.status).toBe(200);
    expect(c.body.balanceAfter).toEqual({ principal: 35200, bonus: 5000 });
    const today = c.body.consumption.businessDate;
    const st = await api(app, owner, 'GET', `/api/settlements/${today}`);
    for (const check of st.body.checks) expect(check, check.label).toMatchObject({ ok: true });
  });

  it('库存模块可用：默认部门与规则已就绪，店主可建档与期初', async () => {
    const owner = await login(app, 'owner');
    const deps = await api(app, owner, 'GET', '/api/inventory/departments');
    expect(deps.body.map((d: { name: string }) => d.name)).toContain('浴区');
    const settings = await api(app, owner, 'GET', '/api/inventory/settings');
    expect(settings.body.approvalRules).toMatchObject({ purchase_order: true, payment: true });
    const m = await api(app, owner, 'POST', '/api/inventory/materials', { code: 'U001', name: '升级后物料', inventoryUnit: '包', purchaseUnit: '箱', purchaseFactorMilli: 20000 });
    expect(m.status).toBe(201);
    const today = (await api(app, owner, 'GET', '/api/auth/me')).body.calendarToday;
    const d = await api(app, owner, 'POST', '/api/inventory/docs', { clientKey: randomUUID(), docType: 'opening', docDate: today, approveNow: true, lines: [{ materialId: m.body.id, qtyMilli: 5000 }] });
    expect(d.status).toBe(201);
    expect(d.body.doc.status).toBe('confirmed');
    // 店员仍看不到库存
    const clerk = await login(app, 'clerk');
    expect((await api(app, clerk, 'GET', '/api/inventory/materials')).status).toBe(403);
  });

  it('前台模块可用：手牌池为空（升级不预置样例），自检通过，店员可开牌挂账', async () => {
    const owner = await login(app, 'owner');
    const clerk = await login(app, 'clerk');
    const board = await api(app, clerk, 'GET', '/api/frontdesk/board');
    expect(board.status).toBe(200);
    expect(board.body.tags).toEqual([]);
    const { n } = (await sql<{ n: number }[]>`SELECT (SELECT count(*) FROM hand_tags) + (SELECT count(*) FROM visits) + (SELECT count(*) FROM bills) AS n`)[0]!;
    expect(n).toBe(0);
    for (const c of (await api(app, owner, 'GET', '/api/frontdesk/checks')).body) expect(c, c.label).toMatchObject({ ok: true });
    expect((await api(app, owner, 'POST', '/api/frontdesk/tags/batch', { prefix: '', from: 1, to: 5, width: 3, zone: 'female' })).body.created).toBe(5);
    const v = await api(app, clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: '003', zone: 'female', memberId }] });
    expect(v.status).toBe(201);
    const p = await api(app, clerk, 'POST', `/api/frontdesk/visits/${v.body.visits[0].id}/charges`, { clientKey: randomUUID(), lines: [], customLines: [{ name: '升级后挂账', amount: 3000 }], expectedTotal: 3000 });
    expect(p.body.bill.amountCents).toBe(3000);
    // 挂账不扣会员余额
    expect((await api(app, clerk, 'GET', `/api/members/${memberId}`)).body).toMatchObject({ principalBalance: 35200, bonusBalance: 5000 });
  });

  it('升级前的项目记为「标准」档，价格不变；照常可消费，不带档位的旧请求按原价', async () => {
    const owner = await login(app, 'owner');
    const clerk = await login(app, 'clerk');
    const [tier] = await sql<{ tier: string; price: number }[]>`SELECT tier, price FROM service_item_prices WHERE item_id = ${itemId}`;
    expect(tier).toEqual({ tier: 'standard', price: 6800 });
    const item = (await api(app, owner, 'GET', '/api/catalog?all=1')).body.items.find((i: { id: number }) => i.id === itemId);
    expect(item).toMatchObject({ price: 6800, prices: [{ tier: 'standard', price: 6800 }], durationMinutes: null, gender: null, strength: null });
    const c = await api(app, clerk, 'POST', '/api/consumptions', {
      idempotencyKey: randomUUID(),
      memberId,
      lines: [{ itemId, quantity: 1 }],
      expectedTotal: 6800,
      expectedSplit: { principal: 6800, bonus: 0 },
    });
    expect(c.status).toBe(200);
    expect(c.body.consumption.lines[0]).toMatchObject({ name: '升级前项目', tier: 'standard', unitPrice: 6800 });
    // 升级前的消费明细没有价格档
    const [old] = await sql<{ tier: string | null }[]>`SELECT tier FROM consumption_lines WHERE name = '升级前消费'`;
    expect(old!.tier).toBeNull();
  });

  it('再次执行迁移不会重复应用', async () => {
    expect(await migrate(sql)).toEqual([]);
  });
});
