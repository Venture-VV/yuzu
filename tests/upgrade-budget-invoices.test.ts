// 8.0.2 → 8.0.3 升级（迁移 086、087，费用预算与进项发票台账，docs/BUDGET_INVOICES.md）：
//   · 8.0.2 的库已经有 090–093，升级时 086、087 排在它们后面执行；
//   · 已有的发票登记当作专票、待认证、来源三单（列的默认值），内容照旧不能改，认证状态能改；
//   · 已有的报销单不超预算、没有预算核对、不关联台账；报销单的内容照旧不能改，待确认的能改「要不要审批」；
//   · 审批规则能写「超预算报销」，文件能存「发票」用途。

import { readdir, readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSql, type Sql } from '../src/server/db';
import { migrate } from '../src/server/migrate';
import { TEST_DB } from './helpers';
import { resetPublicSchema } from './test-db';

const MIGRATIONS = new URL('../src/server/migrations/', import.meta.url);
const NEW = ['086_expense_budgets.sql', '087_input_invoices.sql'];
let sql: Sql;

beforeAll(() => {
  sql = createSql(TEST_DB, { max: 4 });
});
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

async function schemaAt802() {
  await resetPublicSchema(sql);
  await sql`CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const f of (await readdir(MIGRATIONS)).filter((x) => x.endsWith('.sql') && !NEW.includes(x)).sort()) {
    await sql.unsafe(await readFile(new URL(f, MIGRATIONS), 'utf8'));
    await sql`INSERT INTO schema_migrations (version) VALUES (${f})`;
  }
}

describe('8.0.2 → 8.0.3 · 费用预算与进项发票台账', () => {
  it('已有发票当作专票待认证、来源三单；报销单不超预算、不关联台账；守护照旧，放开的几项能改', async () => {
    await schemaAt802();
    const [staff] = await sql<{ id: number }[]>`INSERT INTO staff (username, display_name, role, password_hash) VALUES ('u_owner', '店主', 'owner', 'x') RETURNING id`;
    const [dept] = await sql<{ id: number }[]>`INSERT INTO departments (name) VALUES ('升级预算部') RETURNING id`;
    const [sup] = await sql<{ id: number }[]>`INSERT INTO suppliers (code, name) VALUES ('S801', '老供应商') RETURNING id`;
    const [inv] = await sql<{ id: number }[]>`
      INSERT INTO supplier_invoices (invoice_no, supplier_id, invoice_date, total_cents, tax_cents, tax_rate_bp, client_key, request_hash, created_by)
      VALUES ('OLD-001', ${sup!.id}, '2026-11-01', 11300, 1300, 1300, gen_random_uuid(), 'h', ${staff!.id}) RETURNING id`;
    const claim = (no: string, status: string) => sql<{ id: number }[]>`
      INSERT INTO expense_claims (doc_no, expense_date, department_id, handler_id, purpose, pay_source, invoice_type, invoice_label, tax_rate_bp, invoice_no,
                                  amount_cents, needs_approval, status, created_by, confirmed_by, confirmed_at)
      VALUES (${no}, '2026-11-02', ${dept!.id}, ${staff!.id}, '办公', 'company', 'vat_special', '增值税专用发票', 1300, ${`FP-${no}`}, 5000, false, ${status},
              ${staff!.id}, ${status === 'confirmed' ? staff!.id : null}, ${status === 'confirmed' ? '2026-11-02 10:00:00+08' : null}) RETURNING id`;
    const [submitted] = await claim('BX-1', 'submitted');
    const [confirmed] = await claim('BX-2', 'confirmed');

    expect(await migrate(sql)).toEqual(NEW);

    expect(await sql`SELECT kind, kind_label, source, cert_status, cert_period, issuer_name, cert_version FROM supplier_invoices WHERE id = ${inv!.id}`).toEqual([
      { kind: 'vat_special', kindLabel: '增值税专用发票', source: 'three_way', certStatus: 'pending', certPeriod: null, issuerName: '', certVersion: 1 },
    ]);
    // 发票内容照旧不能改；认证状态能改
    await expect(sql`UPDATE supplier_invoices SET total_cents = 1 WHERE id = ${inv!.id}`).rejects.toThrow(/发票登记的内容不能改/);
    await sql`UPDATE supplier_invoices SET cert_status = 'certified', cert_period = '2026-11', cert_by = ${staff!.id}, cert_at = now(), cert_version = 2 WHERE id = ${inv!.id}`;
    await expect(sql`UPDATE supplier_invoices SET cert_status = 'certified', cert_period = NULL WHERE id = ${inv!.id}`).rejects.toThrow(/supplier_invoices_certified/);
    await expect(sql`DELETE FROM supplier_invoices WHERE id = ${inv!.id}`).rejects.toThrow(/不能删除/);
    // 三单的发票要有供应商；没有供应商的可以只填开票方
    await expect(
      sql`INSERT INTO supplier_invoices (invoice_no, invoice_date, total_cents, tax_cents, tax_rate_bp, client_key, request_hash, created_by)
          VALUES ('NEW-1', '2026-11-03', 100, 0, 0, gen_random_uuid(), 'h', ${staff!.id})`,
    ).rejects.toThrow(/supplier_invoices_three_way_supplier/);
    await sql`
      INSERT INTO supplier_invoices (invoice_no, issuer_name, invoice_date, total_cents, tax_cents, tax_rate_bp, client_key, request_hash, created_by, source)
      VALUES ('NEW-1', '路边文具', '2026-11-03', 100, 0, 0, gen_random_uuid(), 'h', ${staff!.id}, 'manual')`;

    expect(await sql`SELECT doc_no, over_budget, budget_check, invoice_id FROM expense_claims ORDER BY id`).toEqual([
      { docNo: 'BX-1', overBudget: false, budgetCheck: null, invoiceId: null },
      { docNo: 'BX-2', overBudget: false, budgetCheck: null, invoiceId: null },
    ]);
    // 待确认的能改「要不要审批」与超预算核对（随提交）；已确认的不能；内容照旧不能改
    await sql`UPDATE expense_claims SET needs_approval = true, over_budget = true, budget_check = '[]'::jsonb WHERE id = ${submitted!.id}`;
    await expect(sql`UPDATE expense_claims SET needs_approval = true WHERE id = ${confirmed!.id}`).rejects.toThrow(/已确认的报销单不能改审批与预算核对/);
    await expect(sql`UPDATE expense_claims SET amount_cents = 1 WHERE id = ${submitted!.id}`).rejects.toThrow(/报销单的内容不可修改/);

    // 审批规则的「超预算报销」、文件的「发票」用途、预算表
    await sql`
      INSERT INTO approval_rules (doc_type, steps, allow_self, client_key, request_hash, created_by)
      VALUES ('expense_over_budget', ${sql.json([{ group: 'owner', mode: 'any' }] as never)}, true, gen_random_uuid(), 'h', ${staff!.id})`;
    await sql`INSERT INTO erp_files (scope, sha256, mime, size_bytes, data, created_by) VALUES ('invoice', ${'a'.repeat(64)}, 'application/pdf', 4, '\\x25504446', ${staff!.id})`;
    await sql`INSERT INTO expense_budgets (department_id, category, from_month, amount_cents, updated_by) VALUES (${dept!.id}, 'office', '2026-11-01', 100000, ${staff!.id})`;
    await expect(sql`INSERT INTO expense_budgets (department_id, category, from_month, amount_cents, updated_by) VALUES (${dept!.id}, 'office', '2026-11-15', 1, ${staff!.id})`).rejects.toThrow();
    await expect(sql`DELETE FROM expense_budgets`).rejects.toThrow(/只追加/);
  });
});
