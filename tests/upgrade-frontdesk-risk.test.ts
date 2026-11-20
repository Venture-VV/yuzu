// 迁移 187（8.1.15《浴族系统需求汇总》块 A，docs/FRONTDESK_RISK_V8115.md）在 8.1.14 的库（迁移到 186）上升级：
//   · 原来的手牌、来访一行不改：没有芯片号、没有外出标记、没有授权留痕；在店的还在店、撤销的还是撤销；
//   · 授权用途、操作编号与「确认作废」的类型是在当时的约束上追加的——别的迁移先加进去的类型还在（不照旧名单重建）；
//   · 升级完马上能用：给老手牌绑芯片号、按芯片号查到它、在升级前就在店的来访上登记异常、发牌前风控默认开着；
//   · 再跑一次迁移什么都不做。

import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/server/auth/password';
import { buildApp } from '../src/server/app';
import { loadConfig } from '../src/server/config';
import { createSql, type Sql } from '../src/server/db';
import { migrate } from '../src/server/migrate';
import { frontdeskChecks } from '../src/server/modules/frontdesk/checks';
import { loadRiskRules } from '../src/server/modules/frontdesk/risk';
import { api, login, PASSWORD, TEST_DB } from './helpers';
import { resetPublicSchema } from './test-db';

const MIGRATIONS = new URL('../src/server/migrations/', import.meta.url);
let sql: Sql;

beforeAll(() => {
  sql = createSql(TEST_DB, { max: 8 });
});
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

/** 8.1.14 的库：186 及以前的迁移都执行过（187 起是这一版的，由 migrate 补上） */
async function schemaAt186() {
  await resetPublicSchema(sql);
  await sql`CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const f of (await readdir(MIGRATIONS)).filter((x) => x.endsWith('.sql') && x < '187_').sort()) {
    await sql.unsafe(await readFile(new URL(f, MIGRATIONS), 'utf8'));
    await sql`INSERT INTO schema_migrations (version) VALUES (${f})`;
  }
}

/** 模拟另一条开发线的迁移先跑：在当时的约束上各追加一个类型（写法与 162、187 一样） */
const OTHER_BRANCH = `
DO $$
DECLARE expression text; t text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = 'auth_grants'::regclass AND conname = 'auth_grants_purpose_check';
  ALTER TABLE auth_grants DROP CONSTRAINT auth_grants_purpose_check;
  EXECUTE format('ALTER TABLE auth_grants ADD CONSTRAINT auth_grants_purpose_check CHECK ((%s) OR purpose = ''other_branch_purpose'')', expression);
  FOREACH t IN ARRAY ARRAY['idempotency_keys', 'op_fences'] LOOP
    SELECT pg_get_expr(conbin, conrelid) INTO expression FROM pg_constraint WHERE conrelid = t::regclass AND conname = t || '_op_type_check';
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, t || '_op_type_check');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ((%s) OR op_type = ''other_branch_op'')', t, t || '_op_type_check', expression);
  END LOOP;
END $$;`;

describe('迁移 187 · 前台风控', () => {
  it('从 186 的库升上来：老的手牌、来访不坏；类型约束是追加的；升级完马上能用', async () => {
    await schemaAt186();
    const hash = await hashPassword(PASSWORD);
    const [owner] = await sql<{ id: number }[]>`
      INSERT INTO staff (username, display_name, role, password_hash, must_change_password) VALUES ('owner', '升级店主', 'owner', ${hash}, false) RETURNING id`;
    const staffId = Number(owner!.id);
    const tags = await sql<{ id: number; code: string }[]>`
      INSERT INTO hand_tags (code, zone, kind) VALUES ('U001', 'male', 'normal'), ('U002', 'male', 'normal'), ('U003', 'female', 'normal') RETURNING id, code`;
    const tag = (code: string) => Number(tags.find((t) => t.code === code)!.id);
    await sql`UPDATE hand_tags SET locked = true, lock_reason = '柜锁故障', locked_by = ${staffId}, locked_at = now() WHERE code = 'U003'`;
    const [member] = await sql<{ id: number }[]>`INSERT INTO members (member_no, name, phone) VALUES ('YZ09001', '升级会员', '13912340001') RETURNING id`;
    // 一位在店（会员），一位已撤销
    const [bill1] = await sql<{ id: number }[]>`INSERT INTO bills (bill_no, kind, business_date, opened_at) VALUES ('ZD-U-1', 'visit', current_date, now() - interval '13 hours') RETURNING id`;
    const [open] = await sql<{ id: number }[]>`
      INSERT INTO visits (visit_no, bill_id, tag_id, zone, member_id, business_date, checked_in_at, checked_in_by, checkin_key)
      VALUES ('LF-U-1', ${bill1!.id}, ${tag('U001')}, 'male', ${member!.id}, current_date, now() - interval '13 hours', ${staffId}, ${randomUUID()}) RETURNING id`;
    const [bill2] = await sql<{ id: number }[]>`
      INSERT INTO bills (bill_no, kind, status, business_date, opened_at, closed_at) VALUES ('ZD-U-2', 'visit', 'cancelled', current_date, now() - interval '2 hours', now() - interval '1 hour') RETURNING id`;
    const [gone] = await sql<{ id: number }[]>`
      INSERT INTO visits (visit_no, bill_id, tag_id, zone, status, business_date, checked_in_at, checked_in_by, checkin_key, closed_at, closed_by, close_reason)
      VALUES ('LF-U-2', ${bill2!.id}, ${tag('U002')}, 'male', 'cancelled', current_date, now() - interval '2 hours', ${staffId}, ${randomUUID()}, now() - interval '1 hour', ${staffId}, '开错牌')
      RETURNING id`;
    // 升级前就有的授权、操作编号、作废登记（老类型），与另一条开发线先加进去的类型
    await sql.unsafe(OTHER_BRANCH);
    const [oldGrant] = await sql<{ id: string }[]>`
      INSERT INTO auth_grants (purpose, requested_by, approved_by, scope, expires_at) VALUES ('vip_tag', ${staffId}, ${staffId}, '{}'::jsonb, now() + interval '5 minutes') RETURNING id`;
    const oldKey = randomUUID();
    await sql`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${oldKey}, 'checkin', ${'a'.repeat(64)}, ${open!.id}, ${staffId})`;
    const before = await sql<Record<string, unknown>[]>`SELECT * FROM visits ORDER BY id`;
    const tagsBefore = await sql<Record<string, unknown>[]>`SELECT * FROM hand_tags ORDER BY id`;

    const applied = await migrate(sql);
    expect(applied[0]).toBe('187_frontdesk_risk.sql');
    expect(await migrate(sql)).toEqual([]);

    // 老的手牌、来访：原来的列一个没动，新列都是空的
    const after = await sql<Record<string, unknown>[]>`SELECT * FROM visits ORDER BY id`;
    expect(after).toHaveLength(2);
    for (const [i, row] of after.entries()) {
      expect(row).toMatchObject(before[i]!);
      expect(row).toMatchObject({ awaySince: null, awayBy: null, riskApprovedBy: null, riskApprovedAt: null, riskReason: null });
    }
    const tagsAfter = await sql<Record<string, unknown>[]>`SELECT * FROM hand_tags ORDER BY id`;
    for (const [i, row] of tagsAfter.entries()) {
      expect(row).toMatchObject(tagsBefore[i]!);
      expect(row.cardUid).toBeNull();
    }
    expect((await sql`SELECT 1 FROM guest_blacklist`).length + (await sql`SELECT 1 FROM visit_incidents`).length + (await sql`SELECT 1 FROM visit_incident_events`).length).toBe(0);
    expect((await sql<{ id: string }[]>`SELECT id FROM auth_grants WHERE id = ${oldGrant!.id}`).length).toBe(1);
    expect((await sql`SELECT 1 FROM idempotency_keys WHERE key = ${oldKey}`).length).toBe(1);

    // 类型约束是追加的：老类型、另一条线的类型、这次新加的都认；不认识的照旧拒绝
    const grantOf = (purpose: string) => sql`
      INSERT INTO auth_grants (purpose, requested_by, approved_by, scope, expires_at) VALUES (${purpose}, ${staffId}, ${staffId}, '{}'::jsonb, now() + interval '5 minutes')`;
    for (const p of ['vip_tag', 'line_void', 'member_phone', 'other_branch_purpose', 'checkin_risk']) await grantOf(p);
    await expect(grantOf('no_such_purpose')).rejects.toThrow(/auth_grants_purpose_check/);
    const keyOf = (opType: string) => sql`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (${randomUUID()}, ${opType}, ${'b'.repeat(64)}, 1, ${staffId})`;
    const fenceOf = (opType: string) => sql`INSERT INTO op_fences (key, op_type, staff_id) VALUES (${randomUUID()}, ${opType}, ${staffId})`;
    for (const t of ['checkin', 'bill_post', 'technician_state', 'request_stock', 'other_branch_op', 'visit_incident']) {
      await keyOf(t);
      await fenceOf(t);
    }
    await expect(keyOf('no_such_op')).rejects.toThrow(/idempotency_keys_op_type_check/);
    await expect(fenceOf('no_such_op')).rejects.toThrow(/op_fences_op_type_check/);

    // 芯片号：格式、同一门店里不重复（没绑的互不相干）
    await expect(sql`UPDATE hand_tags SET card_uid = 'ab' WHERE code = 'U002'`).rejects.toThrow();
    await sql`UPDATE hand_tags SET card_uid = '04A1B2C3' WHERE code = 'U002'`;
    await expect(sql`UPDATE hand_tags SET card_uid = '04A1B2C3' WHERE code = 'U003'`).rejects.toThrow(/hand_tags_card_uid_uq/);
    await sql`UPDATE hand_tags SET card_uid = NULL WHERE code = 'U002'`;

    // 升级完马上能用（真的走接口）
    process.env.APP_ENV = 'test';
    const config = loadConfig({ databaseUrl: TEST_DB, env: 'test', logLevel: 'silent', integrations: { mock: true, liveConfigured: [] } });
    const app = await buildApp(sql, config);
    try {
      const cookie = await login(app, 'owner');
      expect(await loadRiskRules(sql)).toEqual({ enabled: true });
      const board = (await api(app, cookie, 'GET', '/api/frontdesk/board')).body;
      expect(board.risk).toEqual({ enabled: true, openTodos: 0 });
      const card = board.tags.find((t: { code: string }) => t.code === 'U001');
      expect(card.visit).toMatchObject({ id: Number(open!.id), awaySince: null, openTodos: 0 });
      expect(board.tags.find((t: { code: string }) => t.code === 'U002').visit).toBeNull();
      // 给老手牌绑芯片号、按芯片号查到它（在店）
      expect((await api(app, cookie, 'PUT', `/api/frontdesk/tags/${tag('U001')}/card`, { cardUid: '0011223344' })).status).toBe(200);
      expect((await api(app, cookie, 'GET', '/api/frontdesk/tags/by-card?uid=0011223344')).body).toMatchObject({
        found: true,
        state: 'in_use',
        tag: { code: 'U001' },
        visit: { id: Number(open!.id) },
      });
      // 升级前就在店的来访：详情读得出，能登记异常、标外出
      const detail = (await api(app, cookie, 'GET', `/api/frontdesk/visits/${open!.id}`)).body;
      expect(detail).toMatchObject({ status: 'open', awaySince: null, riskApproval: null, incidents: [] });
      const away = await api(app, cookie, 'POST', `/api/frontdesk/visits/${open!.id}/incidents`, { clientKey: randomUUID(), kind: 'away', note: '升级后登记' });
      expect(away.status, JSON.stringify(away.body)).toBe(200);
      expect(away.body.awaySince).toBeTruthy();
      const add = await api(app, cookie, 'POST', `/api/frontdesk/visits/${open!.id}/incidents`, { clientKey: randomUUID(), kind: 'surcharge', amount: 5000, note: '超 12 小时加收' });
      expect(add.status, JSON.stringify(add.body)).toBe(200);
      expect(add.body.bill.amountCents).toBe(5000);
      // 撤销了的来访照旧读得出、不能再记
      expect((await api(app, cookie, 'GET', `/api/frontdesk/visits/${gone!.id}`)).body).toMatchObject({ status: 'cancelled', incidents: [] });
      expect((await api(app, cookie, 'POST', `/api/frontdesk/visits/${gone!.id}/incidents`, { clientKey: randomUUID(), kind: 'remind' })).body.error.code).toBe('VISIT_CLOSED');
      // 老会员发牌前的风控读得出（他现在还在店：今天来过 1 次）
      const risk = (await api(app, cookie, 'GET', `/api/frontdesk/members/${member!.id}/risk`)).body;
      expect(risk).toMatchObject({ enabled: true, blacklist: null, unsettled: [], bookings: [] });
      for (const k of await frontdeskChecks(sql)) expect(k, k.detail).toMatchObject({ ok: true });
    } finally {
      await app.close();
    }
  });
});
