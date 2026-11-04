// 迁移 047（v0.7.26：浴票延迟的默认分钟数，PENDING_DECISIONS M50 店主 2026-11-04 定）升级：
//   · 已经导入、还没人动过的 QY-004（浴票延迟、草稿、版本 1、起点 L1·尊、没填分钟数）补上默认——
//     L1·初 起 30 分钟，各档阶表与导入清单的 TICKET_EXTENSION_DEFAULT_ROWS 一样（每一档初 30、享 60、尊 90），仍是草稿、版本 1；
//   · 改过的（版本 2）不动；没导入清单的库不新建 QY-004。
// 同一个迁移里 QY-041 同行优惠（M81）：没人动过的草稿补上「同行的门票」、同行 1 位、L6·初 起 2 位，不填折扣（发布不了）；
//   改过的（版本 2 或填了适用明细）不动；别的折扣类不加同行几位。

import { readdir, readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSql, type Sql } from '../src/server/db';
import { migrate } from '../src/server/migrate';
import { benefitQuantity, TICKET_EXTENSION_DEFAULT_ROWS, type TierQuantity } from '../src/shared/benefits';
import { migrationsFrom, TEST_DB } from './helpers';
import { resetPublicSchema } from './test-db';

const MIGRATIONS = new URL('../src/server/migrations/', import.meta.url);
let sql: Sql;

beforeAll(() => {
  sql = createSql(TEST_DB, { max: 4 });
});
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

/** 新建一个迁移到 047 之前的库（045；小程序线的 046 合并以后也含它） */
async function schemaBefore047() {
  await resetPublicSchema(sql);
  await sql`CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const f of (await readdir(MIGRATIONS)).filter((x) => x.endsWith('.sql') && x < '047').sort()) {
    await sql.unsafe(await readFile(new URL(f, MIGRATIONS), 'utf8'));
    await sql`INSERT INTO schema_migrations (version) VALUES (${f})`;
  }
}

/** v0.7.25 导入（或 045 改过类别）的 QY-004：浴票延迟、草稿、起点 L1·尊、没填分钟数 */
const insertQy004 = (version: number, quantity: number | null = null) => sql`
  INSERT INTO benefits (code, name, category, start_grade, start_tier, quantity, version, content)
  VALUES ('QY-004', '浴票延迟', 'extension', 1, 2, ${quantity}, ${version}, '浴票延迟：初阶30分钟、享阶1小时、尊阶1.5—2小时。')`;

type Row = { status: string; version: number; startGrade: number; startTier: number; quantity: number | null; tierQuantities: TierQuantity[] };
const qy004 = async () =>
  (
    await sql<Row[]>`
      SELECT status, version, start_grade, start_tier, quantity, tier_quantities FROM benefits WHERE code = 'QY-004'`
  )[0]!;

describe('迁移 047 · 浴票延迟的默认分钟数', () => {
  it('没动过的 QY-004 补上默认：L1·初 起 30 分钟，每一档初 30、享 60、尊 90；仍是草稿、版本 1', async () => {
    await schemaBefore047();
    await insertQy004(1);
    expect(await migrate(sql)).toEqual(migrationsFrom('047_membership_finish.sql'));

    const q = await qy004();
    expect(q).toMatchObject({ status: 'draft', version: 1, startGrade: 1, startTier: 0, quantity: 30 });
    // 与导入清单预填的一样（导入与升级两条路得到同一份配置）
    expect(q.tierQuantities).toEqual([...TICKET_EXTENSION_DEFAULT_ROWS]);
    for (let grade = 1; grade <= 6; grade += 1) {
      for (const [tier, minutes] of [30, 60, 90].entries()) expect(benefitQuantity(q, grade, tier), `L${grade}·${tier}`).toBe(minutes);
    }
    // 补上以后就能发布（发布要有起点的分钟数）
    await sql`UPDATE benefits SET status = 'published', published_at = now(), version = version + 1 WHERE code = 'QY-004'`;
  });

  it('改过的 QY-004（版本 2）不动；没导入清单的库不新建', async () => {
    await schemaBefore047();
    await insertQy004(2, 45);
    await migrate(sql);
    expect(await qy004()).toMatchObject({ status: 'draft', version: 2, startGrade: 1, startTier: 2, quantity: 45, tierQuantities: [] });

    await schemaBefore047();
    await migrate(sql);
    const [n] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM benefits`;
    expect(n!.n).toBe(0);
  });
});

/** v0.7.24 导入的 QY-041：折扣类、草稿、起点 L3·初、没填适用明细与折扣 */
const insertQy041 = (version: number, discountTarget: string | null = null) => sql`
  INSERT INTO benefits (code, name, category, start_grade, start_tier, quantity, version, discount_target, content)
  VALUES ('QY-041', '同行优惠', 'discount', 3, 0, NULL, ${version}, ${discountTarget}, '高档可带1人、最高档可带2人享同行礼遇的规划。')`;
type CompanionRow = { status: string; version: number; discountTarget: string | null; quantity: number | null; companionCount: number | null; companionCounts: TierQuantity[] };
const qy041 = async () =>
  (
    await sql<CompanionRow[]>`
      SELECT status, version, discount_target, quantity, companion_count, companion_counts FROM benefits WHERE code = 'QY-041'`
  )[0]!;

describe('迁移 047 · QY-041 同行优惠的预填', () => {
  it('没动过的 QY-041 补上同行的门票、同行 1 位、L6·初 起 2 位，不填折扣：仍是草稿、版本 1，发布不了', async () => {
    await schemaBefore047();
    await insertQy041(1);
    // 别的折扣类（本人的门票）不加同行几位
    await sql`
      INSERT INTO benefits (code, name, category, start_grade, start_tier, quantity, discount_target, content)
      VALUES ('QY-011', '门票折扣', 'discount', 1, 0, 90, 'ticket', '门票折扣')`;
    await migrate(sql);
    expect(await qy041()).toEqual({ status: 'draft', version: 1, discountTarget: 'companion_ticket', quantity: null, companionCount: 1, companionCounts: [{ grade: 6, tier: 0, quantity: 2 }] });
    const [other] = await sql<{ companionCount: number | null; companionCounts: TierQuantity[] }[]>`
      SELECT companion_count, companion_counts FROM benefits WHERE code = 'QY-011'`;
    expect(other).toEqual({ companionCount: null, companionCounts: [] });
    // 没填折扣：数据库也不让发布「没填同行几位」的同行优惠；填了同行几位、折扣以后能发布
    await expect(
      sql`UPDATE benefits SET quantity = 80, companion_count = NULL, companion_counts = '[]', status = 'published', published_at = now() WHERE code = 'QY-041'`,
    ).rejects.toThrow(/benefits_companion_publish_check/);
    await sql`UPDATE benefits SET quantity = 80, status = 'published', published_at = now(), version = version + 1 WHERE code = 'QY-041'`;
    // 「同行几位」只给同行的适用明细
    await expect(sql`UPDATE benefits SET companion_count = 1 WHERE code = 'QY-011'`).rejects.toThrow(/benefits_companion_check/);
  });

  it('改过的 QY-041（版本 2，或已经填了适用明细）不动', async () => {
    await schemaBefore047();
    await insertQy041(2);
    await migrate(sql);
    expect(await qy041()).toMatchObject({ version: 2, discountTarget: null, companionCount: null, companionCounts: [] });

    await schemaBefore047();
    await insertQy041(1, 'bill');
    await migrate(sql);
    expect(await qy041()).toMatchObject({ version: 1, discountTarget: 'bill', companionCount: null, companionCounts: [] });
  });
});
