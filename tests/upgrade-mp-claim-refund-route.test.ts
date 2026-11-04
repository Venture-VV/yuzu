// 迁移 049（v0.7.27：给小程序线的两处）升级：
//   · 已有的退储值明细补上 route = manual（员工退），单号照旧；不改已有的行（退储值单只追加）；
//   · 发券记录的种类加「小程序领取」：升级后能写，约束照旧把住（1 张、有会员、去重键 mp_claim:）；
//   · 「交给门店系统原路退回」只能是充值、微信、不带单号的行。

import { readdir, readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSql, type Sql } from '../src/server/db';
import { migrate } from '../src/server/migrate';
import { migrationsFrom, TEST_DB } from './helpers';
import { resetPublicSchema } from './test-db';

const MIGRATIONS = new URL('../src/server/migrations/', import.meta.url);
let sql: Sql;

beforeAll(() => {
  sql = createSql(TEST_DB, { max: 4 });
});
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

/** 新建一个迁移到 049 之前的库（047；小程序线的 048 合并以后也含它） */
async function schemaBefore049() {
  await resetPublicSchema(sql);
  await sql`CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const f of (await readdir(MIGRATIONS)).filter((x) => x.endsWith('.sql') && x < '049').sort()) {
    await sql.unsafe(await readFile(new URL(f, MIGRATIONS), 'utf8'));
    await sql`INSERT INTO schema_migrations (version) VALUES (${f})`;
  }
}

describe('迁移 049 · 小程序领取与原路退回的标记', () => {
  it('已有的退储值明细补上「员工退」，单号照旧；发券记录能写「小程序领取」，约束照旧把住', async () => {
    await schemaBefore049();
    const [staff] = await sql<{ id: number }[]>`INSERT INTO staff (username, display_name, role, password_hash) VALUES ('u_owner', '店主', 'owner', 'x') RETURNING id`;
    const [member] = await sql<{ id: number }[]>`INSERT INTO members (member_no, name, phone) VALUES ('M0001', '老会员', '19900000001') RETURNING id`;
    const [rc] = await sql<{ id: number }[]>`
      INSERT INTO recharges (doc_no, member_id, paid_amount, bonus_amount, payment_method, payment_ref, business_date, operator_id, channel)
      VALUES ('CZ-1', ${member!.id}, 50000, 0, 'wechat', 'WX1', '2026-11-04', ${staff!.id}, 'mp') RETURNING id`;
    const [refund] = await sql<{ id: number }[]>`
      INSERT INTO member_refunds (refund_no, member_id, principal, reason, operator_id, approved_by, business_date, client_key, request_hash)
      VALUES ('TC-1', ${member!.id}, 20000, '退卡', ${staff!.id}, ${staff!.id}, '2026-11-04', gen_random_uuid(), 'h') RETURNING id`;
    await sql`
      INSERT INTO member_refund_lines (refund_id, source, recharge_id, method, amount, ref)
      VALUES (${refund!.id}, 'recharge', ${rc!.id}, 'wechat', 15000, 'WXR-1'), (${refund!.id}, 'recharge', ${rc!.id}, 'cash', 5000, '')`;

    expect(await migrate(sql)).toEqual(migrationsFrom('049_mp_claim_refund_route.sql'));
    expect(await sql`SELECT method, ref, route FROM member_refund_lines ORDER BY id`).toEqual([
      { method: 'wechat', ref: 'WXR-1', route: 'manual' },
      { method: 'cash', ref: '', route: 'manual' },
    ]);
    // 只追加：升级以后也改不了
    await expect(sql`UPDATE member_refund_lines SET route = 'mp_auto', ref = '' WHERE method = 'wechat'`).rejects.toThrow();
    // 交给门店系统的行：充值、微信、不带单号
    await sql`INSERT INTO member_refund_lines (refund_id, source, recharge_id, method, amount, ref, route) VALUES (${refund!.id}, 'recharge', ${rc!.id}, 'wechat', 1, '', 'mp_auto')`;
    await expect(
      sql`INSERT INTO member_refund_lines (refund_id, source, recharge_id, method, amount, ref, route) VALUES (${refund!.id}, 'recharge', ${rc!.id}, 'wechat', 1, 'X', 'mp_auto')`,
    ).rejects.toThrow(/member_refund_lines_route_scope_check/);

    // 发券记录：小程序领取 1 张能写，2 张、去重键不是 mp_claim: 开头、没有去重键的都不行
    const [tpl] = await sql<{ id: number }[]>`
      INSERT INTO coupon_templates (name, kind, face_value, validity, valid_days, created_by) VALUES ('线上领券', 'cash', 1000, 'days', 30, ${staff!.id}) RETURNING id`;
    const issue = (no: string, quantity: number, dedupe: string | null) => sql`
      INSERT INTO coupon_issues (issue_no, kind, template_id, member_id, quantity, dedupe_key, issued_by, issued_at, business_date)
      VALUES (${no}, 'mp_claim', ${tpl!.id}, ${member!.id}, ${quantity}, ${dedupe}, ${staff!.id}, now(), '2026-11-04')`;
    await issue('FQ-1', 1, 'mp_claim:1');
    await expect(issue('FQ-2', 2, 'mp_claim:2')).rejects.toThrow(/coupon_issues_mp_claim_check/);
    await expect(issue('FQ-3', 1, 'other:3')).rejects.toThrow(/coupon_issues_mp_claim_check/);
    // 没有去重键的本来就写不进（自动发券都要去重键）
    await expect(issue('FQ-4', 1, null)).rejects.toThrow();
  });
});
