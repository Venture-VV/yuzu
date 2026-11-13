// 8.0.16 → 8.0.17 升级（迁移 124、125，docs/FLOW_V8017.md 第 8、10 节）：
//   · 124：采购规则里存着旧默认 ¥5,000 的询价门槛改成 ¥1,000；店里自己改成别的数的（含 0）不动；没保存过采购规则的没有这一行；
//   · 125：部门都没有主管；原来的需求单都是「不用主管确认」，状态不动（含已结束审核、守护不许改的）；
//     等主管确认的需求单不能是已通过（约束兜底）。

import { readdir, readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSql, type Sql } from '../src/server/db';
import { migrate } from '../src/server/migrate';
import { loadPurchaseRules } from '../src/server/modules/inventory/purchase-rules';
import { TEST_DB } from './helpers';
import { resetPublicSchema } from './test-db';

const MIGRATIONS = new URL('../src/server/migrations/', import.meta.url);
const NEW = ['124_quote_threshold_default.sql', '125_dept_head_confirm.sql'];
let sql: Sql;

beforeAll(() => {
  sql = createSql(TEST_DB, { max: 4 });
});
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

/** 8.0.16 的库：除了这次新加的两个迁移都执行过 */
async function schemaAt8016() {
  await resetPublicSchema(sql);
  await sql`CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const f of (await readdir(MIGRATIONS)).filter((x) => x.endsWith('.sql') && !NEW.includes(x)).sort()) {
    await sql.unsafe(await readFile(new URL(f, MIGRATIONS), 'utf8'));
    await sql`INSERT INTO schema_migrations (version) VALUES (${f})`;
  }
}
const threshold = async () => (await sql<{ value: { quoteThresholdCents?: number } }[]>`SELECT value FROM settings WHERE key = 'purchase_rules'`)[0]?.value.quoteThresholdCents;

describe('8.0.16 → 8.0.17', () => {
  it('124：存着旧默认 ¥5,000 的询价门槛改成 ¥1,000，别的规则不动；自己改过的数、设成 0 的不动；没保存过的用新默认', async () => {
    // 8.0.16 的库只建一次（建一次要几秒，CI 上更慢）：先按真的升级跑一遍，其余几种情形直接执行迁移 124 的 SQL
    await schemaAt8016();
    await sql`INSERT INTO settings (key, value) VALUES ('purchase_rules', ${sql.json({ quoteThresholdCents: 500_000, minQuotes: 3, cutoffEnabled: true })})`;
    expect(await migrate(sql)).toEqual(NEW);
    expect(await threshold()).toBe(100_000);
    // 别的规则不动；8.0.17 新加的几项没存过，按默认
    expect(await loadPurchaseRules(sql)).toMatchObject({ quoteThresholdCents: 100_000, minQuotes: 3, cutoffEnabled: true, flowStallDays: 2, deptConfirm: 'threshold' });
    // 再跑一次什么都不做
    expect(await migrate(sql)).toEqual([]);

    const m124 = await readFile(new URL('124_quote_threshold_default.sql', MIGRATIONS), 'utf8');
    for (const [stored, after] of [[500_000, 100_000], [300_000, 300_000], [0, 0], [100_000, 100_000], [499_999, 499_999]] as const) {
      await sql`UPDATE settings SET value = ${sql.json({ quoteThresholdCents: stored, minQuotes: 3 })} WHERE key = 'purchase_rules'`;
      await sql.unsafe(m124);
      expect(await threshold()).toBe(after);
      expect((await loadPurchaseRules(sql)).minQuotes).toBe(3);
    }
    // 存的不是数字（坏数据）不碰；从没保存过采购规则的没有这一行，直接用新默认 ¥1,000
    await sql`UPDATE settings SET value = ${sql.json({ quoteThresholdCents: '500000' })} WHERE key = 'purchase_rules'`;
    await sql.unsafe(m124);
    expect(await threshold()).toBe('500000');
    await sql`DELETE FROM settings WHERE key = 'purchase_rules'`;
    await sql.unsafe(m124);
    expect(await threshold()).toBeUndefined();
    expect((await loadPurchaseRules(sql)).quoteThresholdCents).toBe(100_000);
  }, 120_000);

  it('125：部门没有主管；原来的需求单都是「不用主管确认」、状态不动；等主管确认的不能是已通过', async () => {
    await schemaAt8016();
    const [staff] = await sql<{ id: number }[]>`INSERT INTO staff (username, display_name, role, password_hash) VALUES ('u_owner', '店主', 'owner', 'x') RETURNING id`;
    const [dept] = await sql<{ id: number }[]>`INSERT INTO departments (name) VALUES ('升级测试部') RETURNING id`;
    for (const [no, status] of [['XQ-S', 'submitted'], ['XQ-A', 'approved'], ['XQ-R', 'rejected'], ['XQ-C', 'cancelled']] as const) {
      await sql`
        INSERT INTO purchase_requests (doc_no, department_id, requester_id, status, reviewed_by, reviewed_at)
        VALUES (${no}, ${dept!.id}, ${staff!.id}, ${status}, ${status === 'approved' || status === 'rejected' ? staff!.id : null},
                ${status === 'approved' || status === 'rejected' ? '2026-11-02 10:00:00+08' : null})`;
    }
    expect(await migrate(sql)).toEqual(NEW);
    expect((await sql<{ headId: number | null }[]>`SELECT head_id FROM departments`).every((d) => d.headId === null)).toBe(true);
    const rows = await sql<{ docNo: string; status: string; deptConfirm: string; deptHeadId: number | null }[]>`SELECT doc_no, status, dept_confirm, dept_head_id FROM purchase_requests ORDER BY doc_no`;
    expect(rows.map((r) => `${r.docNo}:${r.status}:${r.deptConfirm}:${r.deptHeadId}`)).toEqual(['XQ-A:approved:none:null', 'XQ-C:cancelled:none:null', 'XQ-R:rejected:none:null', 'XQ-S:submitted:none:null']);
    // 约束：等主管确认要有主管；已确认要有人、有时间；等主管确认的不能通过
    await expect(sql`UPDATE purchase_requests SET dept_confirm = 'pending' WHERE doc_no = 'XQ-S'`).rejects.toThrow(/purchase_requests_dept_pending_head/);
    await expect(sql`UPDATE purchase_requests SET dept_confirm = 'confirmed' WHERE doc_no = 'XQ-S'`).rejects.toThrow(/purchase_requests_dept_confirmed/);
    await sql`UPDATE purchase_requests SET dept_confirm = 'pending', dept_head_id = ${staff!.id} WHERE doc_no = 'XQ-S'`;
    await expect(sql`UPDATE purchase_requests SET status = 'approved', reviewed_by = ${staff!.id}, reviewed_at = now() WHERE doc_no = 'XQ-S'`).rejects.toThrow(/purchase_requests_dept_before_approve/);
    await sql`UPDATE purchase_requests SET dept_confirm = 'confirmed', dept_confirmed_by = ${staff!.id}, dept_confirmed_at = now() WHERE doc_no = 'XQ-S'`;
    await sql`UPDATE purchase_requests SET status = 'approved', reviewed_by = ${staff!.id}, reviewed_at = now() WHERE doc_no = 'XQ-S'`;
  }, 120_000);
});
