// 迁移 041（v0.7.24 会员体系 v2 第二期：本店权益自动发放）升级：
//   · 升级前的发券记录（手动发、无记名批次、生日礼——定时任务发的没有经办人、升级礼）照常有效，新约束都满足；
//   · 升级前的每天自动任务运行记录（到期处理）照常，券数记 0；作废登记照常；
//   · 升级后权益清单是空的（不自动导入、不自动发券）；导入后发布、发放、登记都能用；种类「会员权益」的发券记录不挂规则、可以没有经办人；
//   · 自检全 ✓。

import { readdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/server/auth/password';
import { createSql, type Sql } from '../src/server/db';
import { migrate } from '../src/server/migrate';
import { benefitChecks } from '../src/server/modules/benefits';
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

/** 新建一个迁移到 040 的库 */
async function schemaAt040() {
  await resetPublicSchema(sql);
  await sql`CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const f of (await readdir(MIGRATIONS)).filter((x) => x.endsWith('.sql') && x < '041').sort()) {
    await sql.unsafe(await readFile(new URL(f, MIGRATIONS), 'utf8'));
    await sql`INSERT INTO schema_migrations (version) VALUES (${f})`;
  }
}

describe('迁移 041 · 会员体系 v2 第二期', () => {
  it('升级前的发券记录、运行记录、作废登记照常；权益清单是空的；「会员权益」种类的发券记录能写；自检全 ✓', async () => {
    await schemaAt040();
    const hash = await hashPassword(PASSWORD);
    const [owner] = await sql<{ id: number }[]>`
      INSERT INTO staff (username, display_name, role, password_hash) VALUES ('owner', '店主', 'owner', ${hash}) RETURNING id`;
    const [m] = await sql<{ id: number }[]>`INSERT INTO members (member_no, name, phone) VALUES ('UP101', '升级会员', '13800000101') RETURNING id`;
    const [tpl] = await sql<{ id: number }[]>`
      INSERT INTO coupon_templates (name, kind, face_value, scope, validity, valid_days, created_by)
      VALUES ('升级前的券', 'cash', 1000, 'all', 'days', 30, ${owner!.id}) RETURNING id`;
    const [rule] = await sql<{ id: number }[]>`
      INSERT INTO coupon_rules (kind, level, template_id, quantity, created_by) VALUES ('birthday', 0, ${tpl!.id}, 1, ${owner!.id}) RETURNING id`;
    // 手动发、生日礼（定时任务发，没有经办人）各一条，各带一张券
    let n = 0;
    const issue = async (kind: string, extra: { ruleId?: number; dedupe?: string; clientKey?: string; staff?: number | null }) => {
      n += 1;
      const [row] = await sql<{ id: number }[]>`
        INSERT INTO coupon_issues (issue_no, kind, template_id, member_id, quantity, rule_id, reason, client_key, dedupe_key, issued_by, issued_at, business_date)
        VALUES (${`FQ-UP-${n}`}, ${kind}, ${tpl!.id}, ${m!.id}, 1, ${extra.ruleId ?? null}, ${kind === 'manual' ? '升级前发的' : ''}, ${extra.clientKey ?? null},
                ${extra.dedupe ?? null}, ${extra.staff === undefined ? owner!.id : extra.staff}, now(), '2026-10-01') RETURNING id`;
      await sql`
        INSERT INTO coupons (code, issue_id, template_id, member_id, valid_from, valid_to, created_at)
        VALUES (${`ABCDEFGHJK${['MN', 'PQ'][n - 1]}`}, ${row!.id}, ${tpl!.id}, ${m!.id}, '2026-10-01', '2026-10-30', now())`;
    };
    await issue('manual', { clientKey: randomUUID() });
    await issue('birthday', { ruleId: rule!.id, dedupe: `birthday:r${rule!.id}:m${m!.id}:y2026`, staff: null });
    // 升级前的每天自动任务（到期处理）与一条作废登记
    await sql`INSERT INTO membership_job_runs (job, business_date, finished_at, processed) VALUES ('daily', '2026-11-01', now(), 3)`;
    await sql`INSERT INTO op_fences (key, op_type, staff_id) VALUES (${randomUUID()}, 'grade_adjust', ${owner!.id})`;

    expect(await migrate(sql)).toEqual(['041_benefits.sql', '043_miniprogram.sql', '044_miniprogram_fences.sql']);

    const [counts] = await sql<{ issues: number; benefits: number; grants: number; uses: number }[]>`
      SELECT (SELECT count(*) FROM coupon_issues)::int AS issues, (SELECT count(*) FROM benefits)::int AS benefits,
             (SELECT count(*) FROM benefit_grants)::int AS grants, (SELECT count(*) FROM benefit_uses)::int AS uses`;
    expect(counts).toEqual({ issues: 2, benefits: 0, grants: 0, uses: 0 });
    expect(await sql`SELECT job, processed, coupons, catalog_stamp FROM membership_job_runs`).toEqual([{ job: 'daily', processed: 3, coupons: 0, catalogStamp: null }]);

    // 新约束：「会员权益」不挂规则、可以没有经办人；手动发仍要经办人，规则发券仍要挂规则
    await expect(
      sql`INSERT INTO coupon_issues (issue_no, kind, template_id, member_id, quantity, rule_id, dedupe_key, issued_at, business_date)
          VALUES ('FQ-UP-X', 'benefit', ${tpl!.id}, ${m!.id}, 1, ${rule!.id}, 'benefit:x', now(), '2026-11-01')`,
    ).rejects.toThrow(/coupon_issues_rule_check/);
    await sql`
      INSERT INTO coupon_issues (issue_no, kind, template_id, member_id, quantity, dedupe_key, issued_at, business_date)
      VALUES ('FQ-UP-B', 'benefit', ${tpl!.id}, ${m!.id}, 1, 'benefit:up', now(), '2026-11-01')`;
    await expect(
      sql`INSERT INTO coupon_issues (issue_no, kind, template_id, member_id, quantity, reason, client_key, issued_at, business_date)
          VALUES ('FQ-UP-M', 'manual', ${tpl!.id}, ${m!.id}, 1, '没有经办人', gen_random_uuid(), now(), '2026-11-01')`,
    ).rejects.toThrow(/coupon_issues_issued_by_check/);
    await expect(
      sql`INSERT INTO coupon_issues (issue_no, kind, template_id, member_id, quantity, dedupe_key, issued_by, issued_at, business_date)
          VALUES ('FQ-UP-L', 'level_up', ${tpl!.id}, ${m!.id}, 1, 'level_up:x', ${owner!.id}, now(), '2026-11-01')`,
    ).rejects.toThrow(/coupon_issues_rule_check/);
    // 「会员权益」的发券记录没有对应的发放记录，自检报出来；补上发放记录后一致
    const before = await benefitChecks(sql);
    expect(before.find((c) => c.label.includes('发放记录与发券记录一致'))).toMatchObject({ ok: false });
    const [b] = await sql<{ id: number }[]>`
      INSERT INTO benefits (code, name, category, start_grade, period, quantity, template_id, status)
      VALUES ('UP-1', '升级验证', 'coupon', 0, 'month', 1, ${tpl!.id}, 'published') RETURNING id`;
    const [iss] = await sql<{ id: number }[]>`SELECT id FROM coupon_issues WHERE issue_no = 'FQ-UP-B'`;
    await sql`
      INSERT INTO benefit_grants (benefit_id, benefit_version, member_id, reason, period_key, target, quantity, coupon_issue_id, grade, tier, business_date, dedupe_key)
      VALUES (${b!.id}, 1, ${m!.id}, 'monthly', '2026-11', 1, 1, ${iss!.id}, 0, NULL, '2026-11-01', 'benefit:up')`;
    await sql`
      INSERT INTO coupons (code, issue_id, template_id, member_id, valid_from, valid_to, created_at)
      VALUES ('ABCDEFGHJKUP', ${iss!.id}, ${tpl!.id}, ${m!.id}, '2026-11-01', '2026-11-30', now())`;
    for (const c of await benefitChecks(sql)) expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
    // 权益不能删、编号不能改；发放记录只追加；使用登记只能作废
    await expect(sql`DELETE FROM benefits WHERE id = ${b!.id}`).rejects.toThrow(/不能删除/);
    await expect(sql`UPDATE benefits SET code = 'UP-2' WHERE id = ${b!.id}`).rejects.toThrow(/编号不能改/);
    await expect(sql`UPDATE benefit_grants SET quantity = 2`).rejects.toThrow();
    // 已发布的券类没有券模板：约束拦下
    await expect(sql`UPDATE benefits SET template_id = NULL WHERE id = ${b!.id}`).rejects.toThrow(/benefits_check/);
    // 作废登记加了 benefit_use
    await sql`INSERT INTO op_fences (key, op_type, staff_id) VALUES (${randomUUID()}, 'benefit_use', ${owner!.id})`;
    expect(await migrate(sql)).toEqual([]);
  });
});
