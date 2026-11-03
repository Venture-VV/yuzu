// 迁移 036（v0.7.19 平面图收尾）升级：只加表、加列、放宽约束——
// 升级前已有的底图批次：登记信息为空、没保存原图纸；启用、换下补成在用历史（换回要写原因，旧数据没有换回）；
// 区域都按「公共」、没有单独的颜色；没有使用单、图标、补画轮廓；原有的来访、批次守护照常；批次表收 pdf；自检全 ✓。

import { readdir, readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/server/auth/password';
import { createSql, type Sql } from '../src/server/db';
import { migrate } from '../src/server/migrate';
import { floorplanChecks } from '../src/server/modules/floorplans';
import { frontdeskChecks } from '../src/server/modules/frontdesk/checks';
import { spaceChecks } from '../src/server/modules/spaces';
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

/** 新建一个迁移到 035 的库 */
async function schemaAt035() {
  await resetPublicSchema(sql);
  await sql`CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const f of (await readdir(MIGRATIONS)).filter((x) => x.endsWith('.sql') && x < '036').sort()) {
    await sql.unsafe(await readFile(new URL(f, MIGRATIONS), 'utf8'));
    await sql`INSERT INTO schema_migrations (version) VALUES (${f})`;
  }
}

describe('迁移 036 · 升级前已有的底图批次、区域与来访', () => {
  it('批次没有登记信息、启用与换下补成在用历史；区域按公共；没有使用单与图标；守护照常；自检全 ✓', async () => {
    await schemaAt035();
    const hash = await hashPassword(PASSWORD);
    const [owner] = await sql<{ id: number }[]>`
      INSERT INTO staff (username, display_name, role, password_hash) VALUES ('owner', '店主', 'owner', ${hash}) RETURNING id`;
    // 两批底图：第一批启用过、后来换下；第二批在用
    const batch = async (name: string, sha: string) => {
      const [b] = await sql<{ id: number }[]>`
        INSERT INTO floorplan_batches (file_name, file_sha256, file_bytes, file_format, converter, created_by)
        VALUES (${name}, ${sha}, 1024, 'dxf', 'yuzu-floorplan/1', ${owner!.id}) RETURNING id`;
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80"></svg>';
      await sql`
        INSERT INTO floorplan_floors (batch_id, floor_code, title, width, height, frame, svg, svg_bytes, path_count)
        VALUES (${b!.id}, 'L2', '二层', 100, 80, ${sql.json([0, 0, 1000, 800] as never)}, ${svg}, ${svg.length}, 0)`;
      await sql`UPDATE floorplan_batches SET status = 'ready', finished_at = now() WHERE id = ${b!.id}`;
      return Number(b!.id);
    };
    const v1 = await batch('第一版.dxf', 'a'.repeat(64));
    const v2 = await batch('第二版.dxf', 'b'.repeat(64));
    await sql`UPDATE floorplan_batches SET status = 'active', activated_by = ${owner!.id}, activated_at = now() - interval '2 days' WHERE id = ${v1}`;
    await sql`UPDATE floorplan_batches SET status = 'retired', retired_by = ${owner!.id}, retired_at = now() - interval '1 day' WHERE id = ${v1}`;
    await sql`UPDATE floorplan_batches SET status = 'active', activated_by = ${owner!.id}, activated_at = now() - interval '1 day' WHERE id = ${v2}`;
    // 032 已建好 L1–L3 楼层
    const [floor] = await sql<{ id: number }[]>`SELECT id FROM floors WHERE code = 'L2'`;
    const [zone] = await sql<{ id: number }[]>`INSERT INTO zones (floor_id, name, name_en) VALUES (${floor!.id}, '升级派对区', 'Party') RETURNING id`;
    await sql`INSERT INTO spaces (code, floor_id, zone_id, business_type, display_name) VALUES ('X201', ${floor!.id}, ${zone!.id}, '派对房', '升级派对房')`;

    expect(await migrate(sql)).toEqual(['036_floorplan_finish.sql', '037_refunds_coupons.sql', '038_devices.sql', '039_payment_fences.sql', '040_membership_v2.sql', '041_benefits.sql', '043_miniprogram.sql', '044_miniprogram_fences.sql']);

    const batches = await sql<{ id: number; sourceKind: string | null; sourceNote: string; receivedOn: string | null; pdfScale: number | null; originalSaved: boolean; retireReason: string | null }[]>`
      SELECT id, source_kind, source_note, received_on, pdf_scale, original_saved, retire_reason FROM floorplan_batches ORDER BY id`;
    expect(batches.map(({ id, ...rest }) => rest)).toEqual([
      { sourceKind: null, sourceNote: '', receivedOn: null, pdfScale: null, originalSaved: false, retireReason: null },
      { sourceKind: null, sourceNote: '', receivedOn: null, pdfScale: null, originalSaved: false, retireReason: null },
    ]);
    // 启用与换下补成在用历史（按时间）
    const history = await sql<{ batchId: number; kind: string; reason: string; ledgerDiff: unknown }[]>`
      SELECT batch_id, kind, reason, ledger_diff FROM floorplan_activations ORDER BY at, id`;
    expect(history.map((h) => [Number(h.batchId), h.kind, h.reason, h.ledgerDiff])).toEqual([
      [v1, 'activate', '', null],
      [v1, 'retire', '', null],
      [v2, 'activate', '', null],
    ]);
    // 区域按公共、没有单独的颜色
    const [z] = await sql<{ guideKind: string; guideColor: string | null }[]>`SELECT guide_kind, guide_color FROM zones WHERE id = ${zone!.id}`;
    expect(z).toEqual({ guideKind: 'public', guideColor: null });
    for (const t of ['space_usages', 'guide_markers', 'floorplan_originals', 'floorplan_room_outlines']) {
      const [n] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${sql(t)}`;
      expect(n!.n, t).toBe(0);
    }
    // 守护照常：批次的文件信息与登记不能改；在用历史只追加；换下的现在可以换回（状态多一条），乱跳的状态照样拒绝
    await expect(sql`UPDATE floorplan_batches SET file_name = 'x' WHERE id = ${v1}`).rejects.toThrow(/不能改/);
    await expect(sql`UPDATE floorplan_batches SET source_note = 'x' WHERE id = ${v1}`).rejects.toThrow(/入库登记不能改/);
    await expect(sql`UPDATE floorplan_activations SET reason = 'x'`).rejects.toThrow(/只追加/);
    await expect(sql`UPDATE floorplan_batches SET status = 'ready' WHERE id = ${v1}`).rejects.toThrow(/状态不能/);
    // 批次表收 pdf
    await sql`
      INSERT INTO floorplan_batches (file_name, file_sha256, file_bytes, file_format, converter, created_by, source_kind, received_on, pdf_scale)
      VALUES ('新图纸.pdf', ${'c'.repeat(64)}, 2048, 'pdf', 'yuzu-floorplan/1', ${owner!.id}, 'designer', CURRENT_DATE, 100)`;
    // 自检
    for (const c of [...(await frontdeskChecks(sql)), ...(await spaceChecks(sql)), ...(await floorplanChecks(sql))]) {
      expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
    }
    expect((await frontdeskChecks(sql)).find((c) => c.key === 'space_usages')!.detail).toContain('使用单 0 张');
  });
});
