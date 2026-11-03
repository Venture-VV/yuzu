// 迁移 042（v0.7.25 会员体系 v2 第三期：会员折扣、邀请体验与赠送会籍）升级：
//   · 已经导入、还没人动过的 QY-011（草稿、版本 1）补上会员文档的默认折扣（客房房费 L3 7.5 折、L4 6.5 折、L5 5.5 折、L6 5 折），
//     仍是草稿；改过的（版本 2）不动；其余折扣类没填折扣的仍不能发布，填好适用明细与折扣的能发布；
//   · 作废登记照常、可以登记邀请体验（member_trial）；临时身份只能结束，不能删、不能改内容；
//   · 自检全 ✓。

import { readdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/server/auth/password';
import { createSql, type Sql } from '../src/server/db';
import { migrate } from '../src/server/migrate';
import { benefitChecks } from '../src/server/modules/benefits';
import { trialChecks } from '../src/server/modules/member-trials';
import { PASSWORD, TEST_DB, migrationsFrom } from './helpers';
import { resetPublicSchema } from './test-db';

const MIGRATIONS = new URL('../src/server/migrations/', import.meta.url);
let sql: Sql;

beforeAll(() => {
  sql = createSql(TEST_DB, { max: 4 });
});
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

/** 新建一个迁移到 041 的库 */
async function schemaAt041() {
  await resetPublicSchema(sql);
  await sql`CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const f of (await readdir(MIGRATIONS)).filter((x) => x.endsWith('.sql') && x < '042').sort()) {
    await sql.unsafe(await readFile(new URL(f, MIGRATIONS), 'utf8'));
    await sql`INSERT INTO schema_migrations (version) VALUES (${f})`;
  }
}

/** 041 导入的折扣类（没有折扣、草稿） */
const insertDiscount = (code: string, name: string, version: number, startGrade = 3) => sql`
  INSERT INTO benefits (code, name, category, start_grade, start_tier, version, content)
  VALUES (${code}, ${name}, 'discount', ${startGrade}, 0, ${version}, '升级前导入的')`;

const allOk = async () => {
  for (const c of [...(await benefitChecks(sql)), ...(await trialChecks(sql))]) {
    if (c.label.includes('自动发放')) continue;
    expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
  }
};

describe('迁移 042 · 会员体系 v2 第三期', () => {
  it('没动过的 QY-011 补上默认折扣（仍是草稿）；其余折扣类填好才能发布；作废登记照常、能登记邀请体验；临时身份只能结束', async () => {
    await schemaAt041();
    const hash = await hashPassword(PASSWORD);
    const [owner] = await sql<{ id: number }[]>`
      INSERT INTO staff (username, display_name, role, password_hash) VALUES ('owner', '店主', 'owner', ${hash}) RETURNING id`;
    await insertDiscount('QY-011', '派对房及包房折扣', 1);
    await insertDiscount('QY-054', '会员日', 1, 1);
    const oldFence = randomUUID();
    await sql`INSERT INTO op_fences (key, op_type, staff_id) VALUES (${oldFence}, 'benefit_use', ${owner!.id})`;

    expect(await migrate(sql)).toEqual(migrationsFrom('042_member_discounts_trials.sql'));

    const rows = await sql<{ code: string; status: string; version: number; discountTarget: string | null; quantity: number | null; tierQuantities: unknown }[]>`
      SELECT code, status, version, discount_target, quantity, tier_quantities FROM benefits ORDER BY code`;
    expect(rows).toEqual([
      {
        code: 'QY-011',
        status: 'draft',
        version: 1,
        discountTarget: 'room',
        quantity: 75,
        tierQuantities: [
          { grade: 4, tier: 0, quantity: 65 },
          { grade: 5, tier: 0, quantity: 55 },
          { grade: 6, tier: 0, quantity: 50 },
        ],
      },
      { code: 'QY-054', status: 'draft', version: 1, discountTarget: null, quantity: null, tierQuantities: [] },
    ]);
    // 没填适用明细与折扣的不能发布；QY-011 能发布
    await expect(sql`UPDATE benefits SET status = 'published', published_at = now() WHERE code = 'QY-054'`).rejects.toThrow(/benefits_discount_publish_check/);
    await sql`UPDATE benefits SET status = 'published', published_at = now(), version = version + 1 WHERE code = 'QY-011'`;

    // 作废登记：升级前的照常；能登记邀请体验
    await sql`INSERT INTO op_fences (key, op_type, staff_id) VALUES (${randomUUID()}, 'member_trial', ${owner!.id})`;
    expect((await sql`SELECT op_type FROM op_fences ORDER BY op_type`).map((r) => r.opType)).toEqual(['benefit_use', 'member_trial']);

    // 临时身份：只能结束（到期、转正、撤销），不能删、不能改内容；一位会员同一时间一个
    const [a] = await sql<{ id: number }[]>`INSERT INTO members (member_no, name, phone) VALUES ('UP201', '邀请人', '13800000201') RETURNING id`;
    const [b] = await sql<{ id: number }[]>`INSERT INTO members (member_no, name, phone) VALUES ('UP202', '受邀人', '13800000202') RETURNING id`;
    const [t] = await sql<{ id: number }[]>`
      INSERT INTO member_trials (member_id, kind, grade, starts_on, ends_on, inviter_id, business_date, staff_id, client_key)
      VALUES (${b!.id}, 'invite', 1, '2026-11-03', '2026-11-09', ${a!.id}, '2026-11-03', ${owner!.id}, ${randomUUID()}) RETURNING id`;
    await expect(
      sql`INSERT INTO member_trials (member_id, kind, grade, starts_on, ends_on, inviter_id, business_date, staff_id, client_key)
          VALUES (${b!.id}, 'invite', 1, '2026-11-03', '2026-11-09', ${a!.id}, '2026-11-03', ${owner!.id}, ${randomUUID()})`,
    ).rejects.toThrow(/member_trials_active_uq/);
    await expect(sql`UPDATE member_trials SET ends_on = '2026-12-31' WHERE id = ${t!.id}`).rejects.toThrow(/只能结束/);
    await expect(sql`DELETE FROM member_trials WHERE id = ${t!.id}`).rejects.toThrow(/不能删除/);
    // 赠送会籍要有那次使用登记
    await expect(
      sql`INSERT INTO member_trials (member_id, kind, grade, starts_on, ends_on, inviter_id, business_date, staff_id, client_key)
          VALUES (${a!.id}, 'gift', 1, '2026-11-03', '2026-12-02', ${b!.id}, '2026-11-03', ${owner!.id}, ${randomUUID()})`,
    ).rejects.toThrow(/member_trials_check/);
    await sql`UPDATE member_trials SET status = 'cancelled', ended_on = '2026-11-03', ended_by = ${owner!.id}, end_reason = '登记错了' WHERE id = ${t!.id}`;
    await expect(sql`UPDATE member_trials SET status = 'active', ended_on = NULL, ended_by = NULL, end_reason = NULL WHERE id = ${t!.id}`).rejects.toThrow(/已经结束/);
    await allOk();
  });

  it('改过的 QY-011（版本 2）升级时不动', async () => {
    await schemaAt041();
    await insertDiscount('QY-011', '派对房及包房折扣', 2);
    await migrate(sql);
    const [r] = await sql<{ discountTarget: string | null; quantity: number | null }[]>`SELECT discount_target, quantity FROM benefits WHERE code = 'QY-011'`;
    expect(r).toEqual({ discountTarget: null, quantity: null });
  });
});
