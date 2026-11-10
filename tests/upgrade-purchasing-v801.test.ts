// 8.0.0 → 8.0.1 升级（迁移 082–085、093，采购组整改，docs/PURCHASING_V801.md）：
//   · 8.0.0 的库已经有 090–092（柚子饭堂），升级时 082–085 排在它们后面执行，093 最后；
//   · 旧需求单当作普通、截单前提交（提交时间取建单时间，没有最早可通过日期），来源是填单；
//   · 升级前已经提交（待验收）、生效、冲销的急采当作已经审批过（仓库照旧验收）；草稿、退回、撤回的没有审批时间；
//   · 生效以后急采的审批时间不能改；供应商都是「未签约」；「确认作废」能写集采导入、赠品登记两类；审批规则能写「急采」。

import { readdir, readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSql, type Sql } from '../src/server/db';
import { migrate } from '../src/server/migrate';
import { TEST_DB } from './helpers';
import { resetPublicSchema } from './test-db';

const MIGRATIONS = new URL('../src/server/migrations/', import.meta.url);
const NEW = ['082_purchasing_flow.sql', '083_suppliers_contracts.sql', '084_receipt_attachments.sql', '085_gift_receipts.sql', '093_purchasing_ops.sql'];
/** 8.0.1 以后的版本加的迁移：8.0.0 的库里也没有，升级时按文件名一起补上（8.0.7 起的 097… 有的用到 082–087 建的表） */
const LATER_FIXED = ['086_expense_budgets.sql', '087_input_invoices.sql'];
const isLater = (f: string) => LATER_FIXED.includes(f) || f >= '097_';
let sql: Sql;

beforeAll(() => {
  sql = createSql(TEST_DB, { max: 4 });
});
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

/** 8.0.0 的库：除了这次新加的三个迁移都执行过（含 090–092） */
async function schemaAt800() {
  await resetPublicSchema(sql);
  await sql`CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const f of (await readdir(MIGRATIONS)).filter((x) => x.endsWith('.sql') && !NEW.includes(x) && !isLater(x)).sort()) {
    await sql.unsafe(await readFile(new URL(f, MIGRATIONS), 'utf8'));
    await sql`INSERT INTO schema_migrations (version) VALUES (${f})`;
  }
}

describe('8.0.0 → 8.0.1 · 采购组整改', () => {
  it('旧需求单当作普通、截单前提交；升级前待验收、生效、冲销的急采当作已审批；供应商未签约；约束放宽', async () => {
    await schemaAt800();
    const [staff] = await sql<{ id: number }[]>`INSERT INTO staff (username, display_name, role, password_hash) VALUES ('u_owner', '店主', 'owner', 'x') RETURNING id`;
    const [dept] = await sql<{ id: number }[]>`INSERT INTO departments (name) VALUES ('升级测试部') RETURNING id`;
    const [wh] = await sql<{ id: number }[]>`SELECT id FROM warehouses WHERE department_id = ${dept!.id}`;
    const [sup] = await sql<{ id: number }[]>`INSERT INTO suppliers (code, name, default_channel) VALUES ('S001', '老供应商', 'market') RETURNING id`;
    const [req] = await sql<{ id: number }[]>`
      INSERT INTO purchase_requests (doc_no, department_id, requester_id, status, created_at)
      VALUES ('XQ-1', ${dept!.id}, ${staff!.id}, 'submitted', '2026-11-01 09:30:00+08') RETURNING id`;
    // 结束审核的需求单（守护不许改）：升级时照样补上提交时间，别的不动
    for (const [no, status] of [['XQ-A', 'approved'], ['XQ-R', 'rejected'], ['XQ-C', 'cancelled']] as const) {
      await sql`
        INSERT INTO purchase_requests (doc_no, department_id, requester_id, status, reviewed_by, reviewed_at, created_at)
        VALUES (${no}, ${dept!.id}, ${staff!.id}, ${status}, ${status === 'cancelled' ? null : staff!.id}, ${status === 'cancelled' ? null : '2026-11-02 10:00:00+08'},
                '2026-11-01 08:00:00+08')`;
    }
    const urgent = (no: string, status: string) => sql<{ id: number }[]>`
      INSERT INTO inv_docs (doc_no, doc_type, status, doc_date, created_by, supplier_id, warehouse_id, urgent, urgent_cap_cents, amount_cents, submitted_at)
      VALUES (${no}, 'receipt', ${status}, '2026-11-02', ${staff!.id}, ${sup!.id}, ${wh!.id}, true, 200000, 45000,
              ${status === 'draft' ? null : '2026-11-02 10:00:00+08'}) RETURNING id`;
    const ids: Record<string, number> = {};
    for (const s of ['draft', 'submitted', 'returned', 'confirmed', 'cancelled', 'voided']) ids[s] = (await urgent(`JC-${s}`, s))[0]!.id;
    await sql`
      INSERT INTO settings (key, value) VALUES ('expense_rules', ${sql.json({ approvalThresholdCents: 200000, overdueDays: 7, arrivalOverdueDays: 12 } as never)})`;

    const later = (await readdir(MIGRATIONS)).filter((x) => x.endsWith('.sql') && isLater(x));
    expect(await migrate(sql)).toEqual([...NEW, ...later].sort());

    const [r] = await sql<{ priority: string; sameTime: boolean; approvableOn: string | null; source: string; importId: number | null }[]>`
      SELECT priority, submitted_at = created_at AS same_time, approvable_on, source, import_id FROM purchase_requests WHERE id = ${req!.id}`;
    expect(r).toEqual({ priority: 'normal', sameTime: true, approvableOn: null, source: 'form', importId: null });
    expect(await sql`SELECT doc_no, status, submitted_at = created_at AS same_time FROM purchase_requests WHERE doc_no IN ('XQ-A', 'XQ-C', 'XQ-R') ORDER BY doc_no`).toEqual([
      { docNo: 'XQ-A', status: 'approved', sameTime: true },
      { docNo: 'XQ-C', status: 'cancelled', sameTime: true },
      { docNo: 'XQ-R', status: 'rejected', sameTime: true },
    ]);
    // 守护照旧：结束审核的需求单还是改不了
    await expect(sql`UPDATE purchase_requests SET priority = 'urgent' WHERE doc_no = 'XQ-A'`).rejects.toThrow(/需求单已结束审核/);
    // 新的需求单：提交时间默认现在，来源与导入记录对得上
    await expect(sql`INSERT INTO purchase_requests (doc_no, department_id, requester_id, status, source) VALUES ('XQ-2', ${dept!.id}, ${staff!.id}, 'submitted', 'import')`).rejects.toThrow(
      /purchase_requests_source_import/,
    );
    await expect(sql`INSERT INTO purchase_requests (doc_no, department_id, requester_id, status, priority) VALUES ('XQ-3', ${dept!.id}, ${staff!.id}, 'submitted', 'asap')`).rejects.toThrow();

    const docs = await sql<{ id: number; urgentApprovedAt: string | null }[]>`SELECT id, urgent_approved_at FROM inv_docs ORDER BY id`;
    const approvedAt = (s: string) => docs.find((d) => d.id === ids[s])!.urgentApprovedAt;
    for (const s of ['submitted', 'confirmed', 'voided']) expect(approvedAt(s), s).not.toBeNull();
    for (const s of ['draft', 'returned', 'cancelled']) expect(approvedAt(s), s).toBeNull();
    // 生效以后审批时间不能改；不是急采的不能有审批时间
    await expect(sql`UPDATE inv_docs SET urgent_approved_at = now() WHERE id = ${ids.confirmed!}`).rejects.toThrow(/已生效的库存单据不可修改/);
    await sql`UPDATE inv_docs SET urgent_approved_at = NULL WHERE id = ${ids.submitted!}`;
    await expect(
      sql`INSERT INTO inv_docs (doc_no, doc_type, status, doc_date, created_by, urgent_approved_at) VALUES ('BS-1', 'damage', 'draft', '2026-11-02', ${staff!.id}, now())`,
    ).rejects.toThrow(/inv_docs_urgent_approved/);

    // 供应商：未签约，旧的默认途径原样留着（读的时候按三类对应）
    expect(await sql`SELECT contracted, default_channel FROM suppliers`).toEqual([{ contracted: false, defaultChannel: 'market' }]);
    // 「确认作废」的两类、审批规则的「急采」
    for (const op of ['request_import', 'gift_receipt']) {
      await sql`INSERT INTO op_fences (key, op_type, staff_id) VALUES (gen_random_uuid(), ${op}, ${staff!.id})`;
      await sql`INSERT INTO idempotency_keys (key, op_type, request_hash, ref_id, staff_id) VALUES (gen_random_uuid(), ${op}, 'h', 1, ${staff!.id})`;
    }
    await expect(sql`INSERT INTO op_fences (key, op_type, staff_id) VALUES (gen_random_uuid(), 'nothing', ${staff!.id})`).rejects.toThrow();
    await sql`
      INSERT INTO approval_rules (doc_type, steps, allow_self, client_key, request_hash, created_by)
      VALUES ('urgent_purchase', ${sql.json([{ kind: 'group', group: 'manager' }] as never)}, false, gen_random_uuid(), 'h', ${staff!.id})`;
    // 设置原样（到货超期天数还在费用报销规则里，读采购规则时沿用）
    expect((await sql<{ value: { arrivalOverdueDays: number } }[]>`SELECT value FROM settings WHERE key = 'expense_rules'`)[0]!.value.arrivalOverdueDays).toBe(12);
  });
});
