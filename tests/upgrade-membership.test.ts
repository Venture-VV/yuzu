// 迁移 040（v0.7.23 会员体系 v2 第一期）升级：
//   · 会员加档阶列，升级后都是 L0、没有状态变化；应用启动时的上线定档按累计充值（含期初的旧系统累计充值）定档、进初阶，最高 L5，只做一次；
//   · 券模板的限定等级、发券规则的等级按对应表换成档级（发过券的模板、规则也换，换完保护照常）；
//   · 岗位约束收「他店查询」；自检全 ✓。

import { readdir, readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { businessDateOf } from '../src/shared/business-date';
import { shiftDate } from '../src/shared/labels';
import { hashPassword } from '../src/server/auth/password';
import { loadConfig } from '../src/server/config';
import { createSql, type Sql } from '../src/server/db';
import { migrate } from '../src/server/migrate';
import { ensureMembershipLive, membershipChecks } from '../src/server/modules/membership';
import { PASSWORD, TEST_DB } from './helpers';
import { resetPublicSchema } from './test-db';

const MIGRATIONS = new URL('../src/server/migrations/', import.meta.url);
let sql: Sql;

beforeAll(() => {
  sql = createSql(TEST_DB, { max: 4 });
});
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

/** 新建一个迁移到 039 的库 */
async function schemaAt039() {
  await resetPublicSchema(sql);
  await sql`CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const f of (await readdir(MIGRATIONS)).filter((x) => x.endsWith('.sql') && x < '040').sort()) {
    await sql.unsafe(await readFile(new URL(f, MIGRATIONS), 'utf8'));
    await sql`INSERT INTO schema_migrations (version) VALUES (${f})`;
  }
}

describe('迁移 040 · 会员体系 v2 第一期', () => {
  it('券的等级换成档级；会员升级后都是 L0，上线定档按累计充值（含旧系统累计）定档、最高 L5、只做一次；自检全 ✓', async () => {
    await schemaAt039();
    const hash = await hashPassword(PASSWORD);
    const [owner] = await sql<{ id: number }[]>`
      INSERT INTO staff (username, display_name, role, password_hash) VALUES ('owner', '店主', 'owner', ${hash}) RETURNING id`;
    const member = async (no: string, name: string, phone: string) =>
      Number((await sql<{ id: number }[]>`INSERT INTO members (member_no, name, phone) VALUES (${no}, ${name}, ${phone}) RETURNING id`)[0]!.id);
    const a = await member('UP001', '四万会员', '13800000001');
    const b = await member('UP002', '老卡会员', '13800000002');
    const c = await member('UP003', '没充值', '13800000003');
    const d = await member('UP004', '四十万会员', '13800000004');
    let seq = 0;
    const recharge = async (memberId: number, paid: number) => {
      seq += 1;
      await sql`
        INSERT INTO recharges (doc_no, member_id, paid_amount, bonus_amount, payment_method, business_date, operator_id)
        VALUES (${`CZ-UP-${seq}`}, ${memberId}, ${paid}, 0, 'cash', '2026-10-01', ${owner!.id})`;
    };
    for (let i = 0; i < 4; i++) await recharge(a, 1_000_000);
    await recharge(b, 100_000);
    await recharge(d, 40_000_000);
    // 老卡会员：期初导入的旧系统累计充值 12 万（有效）；另有一笔作废的期初不算
    const [imp] = await sql<{ id: number }[]>`
      INSERT INTO opening_imports (import_no, client_key, source, file_sha256, row_count, created_count, principal_total, bonus_total, business_date, imported_by)
      VALUES ('QC-UP-1', gen_random_uuid(), 'EBC', ${'a'.repeat(64)}, 1, 0, 0, 0, '2026-10-01', ${owner!.id}) RETURNING id`;
    await sql`
      INSERT INTO opening_balances (import_id, member_id, doc_no, line_no, source_row, principal, bonus, legacy_recharged, member_created)
      VALUES (${imp!.id}, ${b}, 'QC-UP-1-0001', 2, '{}'::jsonb, 0, 0, 12000000, false)`;
    await sql`
      INSERT INTO opening_balances (import_id, member_id, doc_no, line_no, source_row, principal, bonus, legacy_recharged, member_created, status, voided_at, voided_by, void_reason, void_business_date)
      VALUES (${imp!.id}, ${c}, 'QC-UP-1-0002', 3, '{}'::jsonb, 0, 0, 99000000, false, 'voided', now(), ${owner!.id}, '导错了', '2026-10-01')`;

    // 券模板（原来的 1–9 级）与发券规则；模板 T2 发过券、规则不能改，迁移照样换
    const tpl = async (name: string, levels: number[]) =>
      Number(
        (
          await sql<{ id: number }[]>`
            INSERT INTO coupon_templates (name, kind, face_value, scope, validity, valid_days, levels, created_by)
            VALUES (${name}, 'cash', 1000, 'all', 'days', 30, ${levels}::smallint[], ${owner!.id}) RETURNING id`
        )[0]!.id,
      );
    const t1 = await tpl('一级', [1]);
    const t2 = await tpl('二三级', [2, 3]);
    const t3 = await tpl('五级以上', [5, 9]);
    const t4 = await tpl('不限', []);
    const [issue] = await sql<{ id: number }[]>`
      INSERT INTO coupon_issues (issue_no, kind, template_id, member_id, quantity, reason, client_key, issued_by, issued_at, business_date)
      VALUES ('FQ-UP-1', 'manual', ${t2}, ${a}, 1, '升级前发的', gen_random_uuid(), ${owner!.id}, now(), '2026-10-01') RETURNING id`;
    await sql`
      INSERT INTO coupons (code, issue_id, template_id, member_id, valid_from, valid_to, created_at)
      VALUES ('ABCDEFGHJKLM', ${issue!.id}, ${t2}, ${a}, '2026-10-01', '2026-10-30', now())`;
    const rule = async (kind: string, level: number) =>
      Number((await sql<{ id: number }[]>`INSERT INTO coupon_rules (kind, level, template_id, quantity, created_by) VALUES (${kind}, ${level}, ${t4}, 1, ${owner!.id}) RETURNING id`)[0]!.id);
    const rules = [await rule('level_up', 1), await rule('level_up', 2), await rule('birthday', 1), await rule('birthday', 4), await rule('level_up', 7)];

    expect(await migrate(sql)).toEqual(['040_membership_v2.sql']);

    // 券：模板的限定等级、规则的等级换成档级
    const levelsOf = async (id: number) => (await sql<{ levels: number[] }[]>`SELECT levels FROM coupon_templates WHERE id = ${id}`)[0]!.levels.map(Number);
    expect([await levelsOf(t1), await levelsOf(t2), await levelsOf(t3), await levelsOf(t4)]).toEqual([[0, 1, 2, 3], [4, 5], [6], []]);
    const ruleLevels = await sql<{ id: number; level: number }[]>`SELECT id, level FROM coupon_rules ORDER BY id`;
    expect(ruleLevels.map((r) => r.level)).toEqual([1, 4, 0, 5, 6]);
    expect(ruleLevels.map((r) => Number(r.id))).toEqual(rules);
    // 保护照常：发过券的模板不能改条件，规则不能改
    await expect(sql`UPDATE coupon_templates SET levels = '{1}' WHERE id = ${t2}`).rejects.toThrow('已经发过券');
    await expect(sql`UPDATE coupon_rules SET level = 2 WHERE id = ${rules[0]!}`).rejects.toThrow('发券规则不能改');
    await expect(sql`UPDATE coupon_templates SET levels = '{7}' WHERE id = ${t4}`).rejects.toThrow();
    // 岗位：他店查询
    await sql`INSERT INTO staff (username, display_name, role, password_hash) VALUES ('fukuda', '福田同事', 'other_store', ${hash})`;

    // 会员：升级后都是 L0，没有状态变化
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM members WHERE grade <> 0 OR tier IS NOT NULL OR grade_version <> 0`)[0]!.n).toBe(0);
    for (const ck of await membershipChecks(sql)) expect(ck.ok, `${ck.label}：${ck.detail}`).toBe(true);

    // 应用启动时上线定档（只做一次）
    const config = loadConfig({ databaseUrl: TEST_DB, env: 'test', logLevel: 'silent' });
    const now = new Date();
    const today = businessDateOf(now, config.timezone, 6);
    expect(await ensureMembershipLive({ sql, config }, now)).toEqual({ businessDate: today, graded: 3 });
    expect(await ensureMembershipLive({ sql, config }, now)).toBeNull();
    const graded = await sql<{ id: number; grade: number; tier: number | null; cycleStart: string | null; cycleEnd: string | null }[]>`
      SELECT id, grade, tier, cycle_start, cycle_end FROM members ORDER BY id`;
    const end = shiftDate(today, 364);
    expect(graded.map(({ id, ...g }) => [Number(id), g])).toEqual([
      [a, { grade: 3, tier: 0, cycleStart: today, cycleEnd: end }],
      [b, { grade: 5, tier: 0, cycleStart: today, cycleEnd: end }],
      [c, { grade: 0, tier: null, cycleStart: null, cycleEnd: null }],
      [d, { grade: 5, tier: 0, cycleStart: today, cycleEnd: end }],
    ]);
    const events = await sql<{ memberId: number; kind: string; rollingRecharge: number; staffId: number | null }[]>`
      SELECT member_id, kind, rolling_recharge, staff_id FROM member_grade_events ORDER BY member_id`;
    expect(events.map((e) => [Number(e.memberId), e.kind, Number(e.rollingRecharge), e.staffId])).toEqual([
      [a, 'go_live', 4_000_000, null],
      [b, 'go_live', 12_100_000, null],
      [d, 'go_live', 40_000_000, null],
    ]);
    const [flag] = await sql<{ value: { businessDate: string; graded: number } }[]>`SELECT value FROM settings WHERE key = 'membership_live'`;
    expect(flag!.value).toMatchObject({ businessDate: today, graded: 3 });
    for (const ck of await membershipChecks(sql)) expect(ck.ok, `${ck.label}：${ck.detail}`).toBe(true);
  });
});
