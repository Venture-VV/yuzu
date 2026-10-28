// Batch 2.2 升级兼容：已在用 S2 前台（迁移到 007）的库升级到真实柜池（008）。
//   · 库里有旧儿童区手牌与在店儿童来访时，迁移不改不删这些数据，保留原分区约束；
//     旧来访照常挂账、换牌（换到同为旧儿童区的牌），旧的空闲儿童牌可由店主改为男宾 / 女宾；
//   · 应用拒绝新的儿童区登记；
//   · 前台更正时限仍是旧默认 10 分钟时改为 15 分钟；店主手动调过的保持不变；
//   · 已有手牌默认为普通柜，导入清单后按清单更新柜型。

import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app';
import { hashPassword } from '../src/server/auth/password';
import { loadConfig } from '../src/server/config';
import { createSql, type Sql } from '../src/server/db';
import { migrate } from '../src/server/migrate';
import { api, login, PASSWORD, TEST_DB } from './helpers';

const config = loadConfig({ databaseUrl: TEST_DB, env: 'test', logLevel: 'silent' });
const MIGRATIONS = new URL('../src/server/migrations/', import.meta.url);

/** 只执行到 007（S2 + Batch 2.1 的结构） */
async function migrateThrough007(sql: Sql) {
  await sql.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await sql`CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql') && f < '008').sort();
  for (const f of files) {
    await sql.unsafe(await readFile(new URL(f, MIGRATIONS), 'utf8'));
    await sql`INSERT INTO schema_migrations (version) VALUES (${f})`;
  }
}

async function seedStaff(sql: Sql) {
  const hash = await hashPassword(PASSWORD);
  const [owner] = await sql<{ id: number }[]>`
    INSERT INTO staff (username, display_name, role, password_hash) VALUES ('owner', '老店主', 'owner', ${hash}) RETURNING id`;
  await sql`INSERT INTO staff (username, display_name, role, password_hash) VALUES ('clerk', '老店员', 'clerk', ${hash})`;
  return owner!.id;
}

describe('库里有旧儿童区数据时升级', () => {
  let sql: Sql;
  let app: FastifyInstance;
  let childVisitId: number;

  beforeAll(async () => {
    sql = createSql(TEST_DB, { max: 10 });
    await migrateThrough007(sql);
    const ownerId = await seedStaff(sql);
    // S2 时期建的牌：男宾 A001、儿童 C001（在店）、C002（空闲）、C003（空闲）
    await sql`INSERT INTO hand_tags (code, zone) VALUES ('A001', 'male'), ('C001', 'child'), ('C002', 'child'), ('C003', 'child')`;
    const [bill] = await sql<{ id: number }[]>`INSERT INTO bills (bill_no, kind, business_date) VALUES ('ZD-OLD-1', 'visit', '2026-10-26') RETURNING id`;
    const [visit] = await sql<{ id: number }[]>`
      INSERT INTO visits (visit_no, bill_id, tag_id, zone, business_date, checked_in_at, checked_in_by, checkin_key)
      SELECT 'LF-OLD-1', ${bill!.id}, id, 'child', '2026-10-26', now(), ${ownerId}, ${randomUUID()} FROM hand_tags WHERE code = 'C001'
      RETURNING id`;
    childVisitId = visit!.id;
    expect(await migrate(sql)).toEqual(['008_locker_pool.sql', '009_price_tiers.sql']);
    app = await buildApp(sql, config);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await sql?.end({ timeout: 5 });
  });

  it('旧数据原样保留，原分区约束未收紧；已有手牌默认为普通柜；更正时限从 10 改为 15 分钟', async () => {
    const tags = await sql<{ code: string; zone: string; kind: string; vipLevel: number | null }[]>`SELECT code, zone, kind, vip_level FROM hand_tags ORDER BY code`;
    expect(tags).toEqual([
      { code: 'A001', zone: 'male', kind: 'normal', vipLevel: null },
      { code: 'C001', zone: 'child', kind: 'normal', vipLevel: null },
      { code: 'C002', zone: 'child', kind: 'normal', vipLevel: null },
      { code: 'C003', zone: 'child', kind: 'normal', vipLevel: null },
    ]);
    const [check] = await sql<{ def: string }[]>`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'hand_tags_zone_check'`;
    expect(check!.def).toContain('child');
    const owner = await login(app, 'owner');
    expect((await api(app, owner, 'GET', '/api/frontdesk/rules')).body.selfVoidMinutes).toBe(15);
  });

  it('状态板与账单照常显示旧儿童来访；可以挂账、换到另一张旧儿童牌；自检通过', async () => {
    const clerk = await login(app, 'clerk');
    const board = (await api(app, clerk, 'GET', '/api/frontdesk/board')).body;
    expect(board.stats.inStoreByZone).toEqual({ male: 0, female: 0, child: 1 });
    const post = await api(app, clerk, 'POST', `/api/frontdesk/visits/${childVisitId}/charges`, {
      clientKey: randomUUID(),
      lines: [],
      customLines: [{ name: '升级后挂账', amount: 3000 }],
      expectedTotal: 3000,
    });
    expect(post.status).toBe(200);
    // 换到男宾牌：分区不一致；换到旧儿童牌：可以
    const wrong = await api(app, clerk, 'POST', `/api/frontdesk/visits/${childVisitId}/swap`, { clientKey: randomUUID(), toTagCode: 'A001', reason: '顾客要求换柜' });
    expect(wrong.body.error.code).toBe('ZONE_MISMATCH');
    const swap = await api(app, clerk, 'POST', `/api/frontdesk/visits/${childVisitId}/swap`, { clientKey: randomUUID(), toTagCode: 'C002', reason: '柜锁故障', lockOld: true });
    expect(swap.status).toBe(200);
    expect(swap.body.tag.code).toBe('C002');
    for (const c of (await api(app, clerk, 'GET', '/api/frontdesk/checks')).body) expect(c, c.label).toMatchObject({ ok: true });
  });

  it('不能再按儿童分区开牌；空闲的旧儿童牌由店主改为男宾后可正常发出', async () => {
    const owner = await login(app, 'owner');
    const clerk = await login(app, 'clerk');
    const bad = await api(app, clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: 'C003', zone: 'child' }] });
    expect(bad.status).toBe(400);
    const c003 = (await api(app, owner, 'GET', '/api/frontdesk/tags')).body.find((t: { code: string }) => t.code === 'C003');
    expect(c003.zone).toBe('child');
    expect((await api(app, owner, 'PUT', `/api/frontdesk/tags/${c003.id}`, { zone: 'male', active: true })).status).toBe(200);
    const ok = await api(app, clerk, 'POST', '/api/frontdesk/checkins', { clientKey: randomUUID(), guests: [{ tagCode: 'C003', zone: 'male' }] });
    expect(ok.status).toBe(201);
  });

  it('导入真实清单：旧牌不在清单里，勾选「停用清单外」时只停用空闲的，在店的保留', async () => {
    const owner = await login(app, 'owner');
    const rows = [
      { code: 'A8060', zone: 'male', kind: 'normal', vipLevel: null },
      { code: '9058', zone: 'male', kind: 'vip', vipLevel: 3 },
    ];
    const report = (await api(app, owner, 'POST', '/api/frontdesk/tags/import', { rows, deactivateMissing: true, dryRun: false })).body;
    expect(report).toMatchObject({ total: 2, created: 2, updated: 0, unchanged: 0 });
    // A001 空闲 → 停用；C002（旧儿童来访在店）与 C003（刚开牌）在店 → 保留；C001 已锁定但空闲 → 停用
    expect(report.blocked.map((b: { code: string }) => b.code).sort()).toEqual(['C002', 'C003']);
    expect(report.deactivated).toBe(2);
    const active = await sql<{ code: string }[]>`SELECT code FROM hand_tags WHERE active ORDER BY code`;
    expect(active.map((r) => r.code)).toEqual(['9058', 'A8060', 'C002', 'C003']);
  });
});

describe('没有旧儿童区数据时升级', () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = createSql(TEST_DB, { max: 5 });
    await migrateThrough007(sql);
    await seedStaff(sql);
    // 店主手动调过的更正时限（不是旧默认 10）
    await sql`UPDATE settings SET value = '{"selfVoidMinutes": 12}' WHERE key = 'frontdesk_rules'`;
    await sql`INSERT INTO hand_tags (code, zone) VALUES ('A001', 'male'), ('B001', 'female')`;
    expect(await migrate(sql)).toEqual(['008_locker_pool.sql', '009_price_tiers.sql']);
  }, 60_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it('分区约束收紧为男宾 / 女宾；手动调过的更正时限保持不变', async () => {
    await expect(sql`INSERT INTO hand_tags (code, zone) VALUES ('C001', 'child')`).rejects.toThrow(/hand_tags_zone_check/);
    const [rules] = await sql<{ value: { selfVoidMinutes: number } }[]>`SELECT value FROM settings WHERE key = 'frontdesk_rules'`;
    expect(rules!.value.selfVoidMinutes).toBe(12);
  });

  it('VIP 柜必须有等级、普通柜不能有等级（数据库约束兜底）', async () => {
    await expect(sql`INSERT INTO hand_tags (code, zone, kind) VALUES ('9001', 'female', 'vip')`).rejects.toThrow(/hand_tags_vip_kind_check/);
    await expect(sql`INSERT INTO hand_tags (code, zone, kind, vip_level) VALUES ('A002', 'male', 'normal', 2)`).rejects.toThrow(/hand_tags_vip_kind_check/);
  });
});
