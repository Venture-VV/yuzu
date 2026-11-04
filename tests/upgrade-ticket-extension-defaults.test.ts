// 迁移 047（v0.7.26：浴票延迟的默认分钟数，PENDING_DECISIONS M50 店主 2026-11-04 定）升级：
//   · 已经导入、还没人动过的 QY-004（浴票延迟、草稿、版本 1、起点 L1·尊、没填分钟数）补上默认——
//     L1·初 起 30 分钟，各档阶表与导入清单的 TICKET_EXTENSION_DEFAULT_ROWS 一样（每一档初 30、享 60、尊 90），仍是草稿、版本 1；
//   · 改过的（版本 2）不动；没导入清单的库不新建 QY-004。

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
    expect(await migrate(sql)).toEqual(migrationsFrom('047_ticket_extension_defaults.sql'));

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
