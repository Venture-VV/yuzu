// 迁移 030（v0.7.12 供应商结算）升级：迁移前已生效的退货按「付款优先」补记抵了原收货单多少——
// 原收货单已经付清的，超出的部分记为退货余额；现付供应商的退货记为已了结；没生效的退货不动。不改金额、不改流水。

import { readdir, readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app';
import { hashPassword } from '../src/server/auth/password';
import { loadConfig } from '../src/server/config';
import { createSql, type Sql } from '../src/server/db';
import { migrate } from '../src/server/migrate';
import { todayIn } from '../src/server/modules/inventory/common';
import { inventoryChecks } from '../src/server/modules/inventory/reports';
import { api, login, PASSWORD, TEST_DB } from './helpers';
import { resetPublicSchema } from './test-db';

const MIGRATIONS = new URL('../src/server/migrations/', import.meta.url);
let sql: Sql;
let app: FastifyInstance | undefined;

beforeAll(() => {
  sql = createSql(TEST_DB, { max: 4 });
});
afterAll(async () => {
  await app?.close();
  await sql.end({ timeout: 5 });
});

/** 新建一个迁移到 029 的库 */
async function schemaAt029() {
  await resetPublicSchema(sql);
  await sql`CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const f of (await readdir(MIGRATIONS)).filter((x) => x.endsWith('.sql') && x < '030').sort()) {
    await sql.unsafe(await readFile(new URL(f, MIGRATIONS), 'utf8'));
    await sql`INSERT INTO schema_migrations (version) VALUES (${f})`;
  }
}

describe('迁移 030 · 迁移前已生效的退货', () => {
  it('付清后的退货记退货余额，没付的抵原收货单，现付的记为已了结；供应商往来自检全 ✓', async () => {
    await schemaAt029();
    const config = loadConfig({ databaseUrl: TEST_DB, env: 'test', logLevel: 'silent' });
    const today = todayIn(config.timezone);
    const hash = await hashPassword(PASSWORD);
    const [payer] = await sql<{ id: number }[]>`
      INSERT INTO staff (username, display_name, role, duties, password_hash) VALUES ('payer', '对账', 'backoffice', '{payable}', ${hash}) RETURNING id`;
    const sup = async (code: string, settlement: string) =>
      (await sql<{ id: number }[]>`INSERT INTO suppliers (code, name, settlement) VALUES (${code}, ${`升级供应商${code}`}, ${settlement}) RETURNING id`)[0]!.id;
    const credit = await sup('U1', 'credit');
    const cash = await sup('U2', 'cash');
    let n = 0;
    const docAt = async (type: string, supplierId: number, amountCents: number, settlement: string, sourceDocId: number | null = null, status = 'confirmed') => {
      n += 1;
      return (await sql<{ id: number }[]>`
        INSERT INTO inv_docs (doc_no, doc_type, status, doc_date, supplier_id, source_doc_id, amount_cents, settlement, warehouse_id, created_by,
                              confirmed_by, confirmed_at)
        VALUES (${`U-${n}`}, ${type}, ${status}, ${today}, ${supplierId}, ${sourceDocId}, ${amountCents},
                ${status === 'confirmed' ? settlement : null}, 1, ${payer!.id},
                ${status === 'confirmed' ? payer!.id : null}, ${status === 'confirmed' ? sql`now() + make_interval(secs => ${n})` : null})
        RETURNING id`)[0]!.id;
    };
    const ap = (supplierId: number, type: string, delta: number, refs: { inv?: number; payment?: number }) =>
      sql`INSERT INTO ap_entries (supplier_id, entry_type, amount_delta_cents, inv_doc_id, payment_id, entry_date, operator_id)
          VALUES (${supplierId}, ${type}, ${delta}, ${refs.inv ?? null}, ${refs.payment ?? null}, ${today}, ${payer!.id})`;

    // A：100 元，已全额付款 → 之后的 20 元退货没抵到 A，记退货余额
    const a = await docAt('receipt', credit, 10_000, 'credit');
    await ap(credit, 'receipt', 10_000, { inv: a });
    const [p] = await sql<{ id: number }[]>`
      INSERT INTO payments (doc_no, supplier_id, pay_date, amount_cents, method, evidence, status, created_by, confirmed_by, confirmed_at)
      VALUES ('UP-1', ${credit}, ${today}, 10000, 'bank_transfer', '升级测试', 'confirmed', ${payer!.id}, ${payer!.id}, now()) RETURNING id`;
    await sql`INSERT INTO payment_allocations (payment_id, receipt_doc_id, amount_cents) VALUES (${p!.id}, ${a}, 10000)`;
    await ap(credit, 'payment', -10_000, { payment: p!.id });
    const r1 = await docAt('supplier_return', credit, 2_000, 'credit', a);
    await ap(credit, 'supplier_return', -2_000, { inv: r1 });
    // B：50 元没付 → 10 元退货抵 B
    const b = await docAt('receipt', credit, 5_000, 'credit');
    await ap(credit, 'receipt', 5_000, { inv: b });
    const r2 = await docAt('supplier_return', credit, 1_000, 'credit', b);
    await ap(credit, 'supplier_return', -1_000, { inv: r2 });
    // 现付的收货与退货：不记应付，以前的退款已按旧办法处理过
    const c = await docAt('receipt', cash, 3_000, 'cash');
    const r3 = await docAt('supplier_return', cash, 500, 'cash', c);
    // 还没生效的退货不动
    const r4 = await docAt('supplier_return', credit, 300, 'credit', b, 'submitted');

    expect(await migrate(sql)).toEqual(['030_supplier_settlement.sql', '031_stock_cycles.sql', '032_spaces.sql', '033_floorplans.sql', '034_floormap.sql', '035_locations.sql', '036_floorplan_finish.sql', '037_refunds_coupons.sql', '038_devices.sql', '039_payment_fences.sql', '040_membership_v2.sql', '043_miniprogram.sql', '044_miniprogram_fences.sql']);
    const applied = new Map(
      (await sql<{ id: number; returnAppliedCents: number | null }[]>`SELECT id, return_applied_cents FROM inv_docs WHERE doc_type = 'supplier_return'`).map((r) => [
        r.id,
        r.returnAppliedCents,
      ]),
    );
    expect(applied.get(r1)).toBe(0);
    expect(applied.get(r2)).toBe(1_000);
    expect(applied.get(r3)).toBe(500);
    expect(applied.get(r4)).toBeNull();
    // 迁移只补记，不改金额与流水
    expect((await sql<{ s: number }[]>`SELECT sum(amount_delta_cents) AS s FROM ap_entries WHERE supplier_id = ${credit}`)[0]!.s).toBe(2_000);
    const checks = await inventoryChecks(sql);
    for (const key of ['ap_balance', 'ap_settlements', 'awaiting_supplier']) {
      expect(checks.find((x) => x.key === key), key).toMatchObject({ ok: true });
    }

    app = await buildApp(sql, config);
    const cookie = await login(app, 'payer');
    const credits = (await api(app, cookie, 'GET', `/api/payables/suppliers/${credit}/credits`)).body;
    expect(credits).toEqual([expect.objectContaining({ kind: 'return', id: r1, availableCents: 2_000, canOffset: true })]);
    expect((await api(app, cookie, 'GET', `/api/payables/suppliers/${cash}/credits`)).body).toEqual([]);
    const items = (await api(app, cookie, 'GET', `/api/payables/suppliers/${credit}/open-items`)).body as { id: number; creditCents: number; openCents: number }[];
    expect(items.find((i) => i.id === a)).toMatchObject({ creditCents: 0, openCents: 0 });
    expect(items.find((i) => i.id === b)).toMatchObject({ creditCents: 1_000, openCents: 4_000 });
    // 余额 20 元 = B 未付 40 元 − 退货余额 20 元
    const overview = (await api(app, cookie, 'GET', '/api/payables/overview')).body.suppliers.find((s: { supplierId: number }) => s.supplierId === credit);
    expect(overview).toMatchObject({ balanceCents: 2_000, creditCents: 2_000 });
  });
});
