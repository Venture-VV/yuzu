// 迁移 029（v0.7.11 两级库存）升级：原有库存与流水全部算总仓；迁移前已生效的领料没进部门小仓；
// 还没生效的领料按新规则进领料部门的小仓，还没生效的领料退回跟着原领料单（原单没有仓，退回只进总仓）——Codex 复审 P1。

import { randomUUID } from 'node:crypto';
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

/** 新建一个迁移到 028 的库 */
async function schemaAt028() {
  await resetPublicSchema(sql);
  await sql`CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const f of (await readdir(MIGRATIONS)).filter((x) => x.endsWith('.sql') && x < '029').sort()) {
    await sql.unsafe(await readFile(new URL(f, MIGRATIONS), 'utf8'));
    await sql`INSERT INTO schema_migrations (version) VALUES (${f})`;
  }
}

describe('迁移 029 · 原有库存与还没生效的领料、退回', () => {
  it('原有流水都在总仓；还没生效的领料进部门小仓，还没生效的退回跟原领料单只进总仓', async () => {
    await schemaAt028();
    const config = loadConfig({ databaseUrl: TEST_DB, env: 'test', logLevel: 'silent' });
    const today = todayIn(config.timezone);
    const hash = await hashPassword(PASSWORD);
    const [keeper] = await sql<{ id: number }[]>`
      INSERT INTO staff (username, display_name, role, duties, password_hash) VALUES ('keeper', '物资经办', 'backoffice', '{stock}', ${hash}) RETURNING id`;
    const [dept] = await sql<{ id: number }[]>`SELECT id FROM departments WHERE name = '浴区'`;
    const [mat] = await sql<{ id: number }[]>`
      INSERT INTO materials (code, name, inventory_unit, purchase_unit, purchase_factor_milli) VALUES ('U001', '升级测试拖鞋', '双', '箱', 100000) RETURNING id`;
    // 028 时期：期初 10 双 → 领给浴区 4 双（都已生效）；之后一张领料退回 2 双、一张领料 1 双都还是草稿
    const docAt = async (no: string, type: string, status: string, extra: { departmentId?: number; sourceDocId?: number } = {}) =>
      (await sql<{ id: number }[]>`
        INSERT INTO inv_docs (doc_no, doc_type, status, doc_date, department_id, source_doc_id, created_by, confirmed_by, confirmed_at)
        VALUES (${no}, ${type}, ${status}, ${today}, ${extra.departmentId ?? null}, ${extra.sourceDocId ?? null}, ${keeper!.id},
                ${status === 'confirmed' ? keeper!.id : null}, ${status === 'confirmed' ? sql`now()` : null})
        RETURNING id`)[0]!.id;
    const lineOf = async (docId: number, qty: number, sourceLineId: number | null = null) =>
      (await sql<{ id: number }[]>`
        INSERT INTO inv_doc_lines (doc_id, line_no, material_id, qty_milli, inventory_unit, purchase_unit, factor_milli, source_line_id)
        VALUES (${docId}, 1, ${mat!.id}, ${qty}, '双', '箱', 100000, ${sourceLineId}) RETURNING id`)[0]!.id;
    const move = async (docId: number, lineId: number, type: string, delta: number, after: number) =>
      (await sql<{ id: number }[]>`
        INSERT INTO stock_moves (material_id, move_type, doc_id, doc_line_id, qty_delta_milli, qty_after_milli, doc_date, operator_id)
        VALUES (${mat!.id}, ${type}, ${docId}, ${lineId}, ${delta}, ${after}, ${today}, ${keeper!.id}) RETURNING id`)[0]!.id;
    const opening = await docAt('QC-U1', 'opening', 'confirmed');
    await move(opening, await lineOf(opening, 10_000), 'opening', 10_000, 10_000);
    const issue = await docAt('LY-U1', 'issue', 'confirmed', { departmentId: dept!.id });
    const issueLine = await lineOf(issue, 4_000);
    const last = await move(issue, issueLine, 'issue', -4_000, 6_000);
    await sql`UPDATE materials SET stock_milli = 6000, last_move_id = ${last} WHERE id = ${mat!.id}`;
    const pendingReturn = await docAt('LT-U1', 'issue_return', 'draft', { departmentId: dept!.id, sourceDocId: issue });
    await lineOf(pendingReturn, 2_000, issueLine);
    const pendingIssue = await docAt('LY-U2', 'issue', 'draft', { departmentId: dept!.id });
    await lineOf(pendingIssue, 1_000);

    expect(await migrate(sql)).toEqual(['029_warehouses.sql', '030_supplier_settlement.sql', '031_stock_cycles.sql', '032_spaces.sql', '033_floorplans.sql', '034_floormap.sql', '035_locations.sql', '036_floorplan_finish.sql', '037_refunds_coupons.sql', '038_devices.sql']);
    const docs = await sql<{ id: number; warehouseId: number | null }[]>`SELECT id, warehouse_id FROM inv_docs ORDER BY id`;
    const whOf = (id: number) => docs.find((d) => d.id === id)!.warehouseId;
    const [bathWh] = await sql<{ id: number }[]>`SELECT id FROM warehouses WHERE department_id = ${dept!.id}`;
    expect(whOf(opening)).toBe(1);
    expect(whOf(issue)).toBeNull(); // 迁移前已生效的领料没进部门小仓
    expect(whOf(pendingIssue)).toBe(bathWh!.id); // 还没生效的领料按新规则进部门小仓
    expect(whOf(pendingReturn)).toBeNull(); // 退回跟原领料单：只进总仓
    expect((await sql<{ n: number }[]>`SELECT count(*) AS n FROM stock_moves WHERE warehouse_id <> 1`)[0]!.n).toBe(0);

    // 升级后照常提交那张退回：总仓 +2，部门小仓不动（原来会去扣部门小仓，库存不足被拒或扣到别的东西）
    app = await buildApp(sql, config);
    const cookie = await login(app, 'keeper');
    const submitted = await api(app, cookie, 'POST', `/api/inventory/docs/${pendingReturn}/submit`, {});
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect(submitted.body).toMatchObject({ status: 'confirmed', warehouse: null });
    expect((await sql<{ s: number }[]>`SELECT stock_milli AS s FROM materials WHERE id = ${mat!.id}`)[0]!.s).toBe(8_000);
    expect(await sql`SELECT 1 FROM warehouse_stock WHERE material_id = ${mat!.id}`).toHaveLength(0);
    // 还没生效的领料提交后进部门小仓
    const issued = await api(app, cookie, 'PUT', `/api/inventory/docs/${pendingIssue}`, {
      docType: 'issue', docDate: today, departmentId: dept!.id, handler: '浴区', action: 'submit', lines: [{ materialId: mat!.id, qtyMilli: 1_000 }],
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect(issued.body.warehouse.id).toBe(bathWh!.id);
    expect((await sql<{ s: number }[]>`SELECT stock_milli AS s FROM warehouse_stock WHERE material_id = ${mat!.id}`)[0]!.s).toBe(1_000);
    for (const c of await inventoryChecks(sql)) expect(c, `${c.key} ${c.detail}`).toMatchObject({ ok: true });
    // 新登记的单据照常有操作编号（升级不影响建单）
    const fresh = await api(app, cookie, 'POST', '/api/inventory/docs', {
      clientKey: randomUUID(), docType: 'issue_return', docDate: today, sourceDocId: pendingIssue, lines: [{ sourceLineId: issued.body.lines[0].id, qtyMilli: 1_000 }],
    });
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(201);
    expect(fresh.body.doc.warehouse.id).toBe(bathWh!.id);
  });
});
