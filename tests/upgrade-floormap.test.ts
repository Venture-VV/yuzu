// 迁移 034（v0.7.16 房态图）与 035（v0.7.17 第一级实时位置）升级：迁移前已有的钟单升级后没有房间（space_id 为空、版本 0），
// 状态、钟数、时长不变；035 只加表、加列——升级后没有任何位置数据、项目没有区域、实时位置开关关着；房态图、位置的自检全 ✓。
// （main v0.7.16 定时测试报告的测试缺口 7：原来是手工插入验证的）

import { readdir, readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/server/auth/password';
import { createSql, type Sql } from '../src/server/db';
import { migrate } from '../src/server/migrate';
import { loadLocationRules, locationChecks } from '../src/server/modules/locations';
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

/** 新建一个迁移到 033 的库 */
async function schemaAt033() {
  await resetPublicSchema(sql);
  await sql`CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const f of (await readdir(MIGRATIONS)).filter((x) => x.endsWith('.sql') && x < '034').sort()) {
    await sql.unsafe(await readFile(new URL(f, MIGRATIONS), 'utf8'));
    await sql`INSERT INTO schema_migrations (version) VALUES (${f})`;
  }
}

describe('迁移 034、035 · 迁移前已有的钟单与项目', () => {
  it('钟单没有房间、版本 0，其余不变；没有位置数据、项目没有区域、开关关着；自检全 ✓', async () => {
    await schemaAt033();
    const hash = await hashPassword(PASSWORD);
    const [staff] = await sql<{ id: number }[]>`
      INSERT INTO staff (username, display_name, role, password_hash) VALUES ('clerk', '店员', 'clerk', ${hash}) RETURNING id`;
    const [tech] = await sql<{ id: number }[]>`
      INSERT INTO technicians (tech_no, name, gender, grade) VALUES ('07', '升级技师', 'female', 'standard') RETURNING id`;
    const [item] = await sql<{ id: number }[]>`
      INSERT INTO service_items (name, category, price, technician_required) VALUES ('升级足疗', '足疗', 19800, true) RETURNING id`;
    const [tag] = await sql<{ id: number }[]>`INSERT INTO hand_tags (code, zone) VALUES ('U001', 'female') RETURNING id`;
    const [bill] = await sql<{ id: number }[]>`
      INSERT INTO bills (bill_no, kind, business_date) VALUES ('ZD-U1', 'visit', CURRENT_DATE) RETURNING id`;
    const [visit] = await sql<{ id: number }[]>`
      INSERT INTO visits (visit_no, bill_id, tag_id, zone, business_date, checked_in_at, checked_in_by, checkin_key)
      VALUES ('LF-U1', ${bill!.id}, ${tag!.id}, 'female', CURRENT_DATE, now(), ${staff!.id}, gen_random_uuid()) RETURNING id`;
    const sessions: { status: string; startedAt: Date | null }[] = [
      { status: 'waiting', startedAt: null },
      { status: 'serving', startedAt: new Date(Date.now() - 20 * 60_000) },
    ];
    for (const [i, s] of sessions.entries()) {
      await sql`
        INSERT INTO technician_sessions (session_no, technician_id, visit_id, item_id, call_type, clocks, minutes, status, business_date, created_by, started_by, started_at)
        VALUES (${`ZD-U${i + 1}`}, ${tech!.id}, ${visit!.id}, ${item!.id}, 'designated', ${i + 1}, ${90 * (i + 1)}, ${s.status}, CURRENT_DATE, ${staff!.id},
                ${s.startedAt ? staff!.id : null}, ${s.startedAt})`;
    }
    const before = await sql<{ sessionNo: string; status: string; clocks: number; minutes: number; callType: string }[]>`
      SELECT session_no, status, clocks, minutes, call_type FROM technician_sessions ORDER BY id`;

    expect(await migrate(sql)).toEqual(['034_floormap.sql', '035_locations.sql', '036_floorplan_finish.sql', '037_refunds_coupons.sql', '038_devices.sql', '039_payment_fences.sql', '040_membership_v2.sql', '043_miniprogram.sql']);

    const after = await sql<{ sessionNo: string; status: string; clocks: number; minutes: number; callType: string; spaceId: number | null; spaceVersion: number }[]>`
      SELECT session_no, status, clocks, minutes, call_type, space_id, space_version FROM technician_sessions ORDER BY id`;
    expect(after.map(({ spaceId, spaceVersion, ...rest }) => rest)).toEqual(before);
    expect(after.every((s) => s.spaceId === null && s.spaceVersion === 0)).toBe(true);
    // 035：只加表、加列
    for (const table of ['location_readers', 'location_events', 'location_tracks', 'current_locations']) {
      expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${sql(table)}`)[0]!.n, table).toBe(0);
    }
    expect((await sql<{ zoneId: number | null }[]>`SELECT zone_id FROM service_items`).map((r) => r.zoneId)).toEqual([null]);
    expect(await loadLocationRules(sql)).toEqual({ enabled: false, checkinZoneId: null, restZoneId: null });
    for (const c of [...(await spaceChecks(sql)), ...(await locationChecks(sql))]) expect(c.ok, `${c.label}：${c.detail}`).toBe(true);
  });
});
