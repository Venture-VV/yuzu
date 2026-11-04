// 迁移 045（v0.7.25 续：浴票延迟）升级：
//   · 已经导入、还没人动过的 QY-004（服务与资格、草稿、版本 1）改成「浴票延迟」类，仍是草稿、不预填分钟数；改过的（版本 2）不动
//     （升级到最新时 046 接着按默认补上分钟数，见 upgrade-ticket-extension-defaults.test.ts）；
//   · 浴票延迟的分钟数 1–240，别的类别数量仍是 1–99；浴票延迟不计次、不发券，发布要有起点的分钟数；
//   · 结账单的每位客人多两列（延迟的分钟数默认 0、按哪一项权益），两列要么都有、要么都没有。

import { readdir, readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSql, type Sql } from '../src/server/db';
import { migrate } from '../src/server/migrate';
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

/** 新建一个迁移到 044 的库 */
async function schemaAt044() {
  await resetPublicSchema(sql);
  await sql`CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const f of (await readdir(MIGRATIONS)).filter((x) => x.endsWith('.sql') && x < '045').sort()) {
    await sql.unsafe(await readFile(new URL(f, MIGRATIONS), 'utf8'));
    await sql`INSERT INTO schema_migrations (version) VALUES (${f})`;
  }
}

/** 041 导入的 QY-004（服务与资格、草稿、不计次） */
const insertQy004 = (version: number) => sql`
  INSERT INTO benefits (code, name, category, start_grade, start_tier, version, content)
  VALUES ('QY-004', '浴票延迟', 'service', 1, 2, ${version}, '浴票延迟：初阶30分钟、享阶1小时、尊阶1.5—2小时。')`;

describe('迁移 045 · 浴票延迟', () => {
  it('没动过的 QY-004 改成浴票延迟（草稿；046 接着补上默认分钟数）；分钟数 1–240；不计次、不发券；发布要有分钟数；结账单两列', async () => {
    await schemaAt044();
    await insertQy004(1);
    expect(await migrate(sql)).toEqual(migrationsFrom('045_ticket_extension.sql'));

    const [q] = await sql<{ category: string; status: string; version: number; quantity: number | null }[]>`
      SELECT category, status, version, quantity FROM benefits WHERE code = 'QY-004'`;
    // 045 改成浴票延迟（草稿、版本 1）；046 接着按默认补上起点的 30 分钟（v0.7.26，M50）
    expect(q).toEqual({ category: 'extension', status: 'draft', version: 1, quantity: 30 });

    // 分钟数 1–240（浴票延迟）；别的类别仍是 1–99
    await sql`UPDATE benefits SET quantity = 240 WHERE code = 'QY-004'`;
    await expect(sql`UPDATE benefits SET quantity = 241 WHERE code = 'QY-004'`).rejects.toThrow(/benefits_quantity_check/);
    await expect(
      sql`INSERT INTO benefits (code, name, category, start_grade, start_tier, period, quantity) VALUES ('X-1', '服务', 'service', 1, 0, 'month', 100)`,
    ).rejects.toThrow(/benefits_quantity_check/);
    // 浴票延迟不计次
    await expect(sql`UPDATE benefits SET period = 'month' WHERE code = 'QY-004'`).rejects.toThrow(/benefits_extension_check/);
    // 发布要有起点的分钟数
    await sql`UPDATE benefits SET quantity = NULL WHERE code = 'QY-004'`;
    await expect(sql`UPDATE benefits SET status = 'published', published_at = now() WHERE code = 'QY-004'`).rejects.toThrow(/benefits_extension_publish_check/);
    await sql`UPDATE benefits SET quantity = 30, status = 'published', published_at = now(), version = version + 1 WHERE code = 'QY-004'`;

    // 结账单：延迟分钟数默认 0；有分钟数就要记权益
    const cols = await sql<{ column: string; dflt: string | null }[]>`
      SELECT column_name AS column, column_default AS dflt FROM information_schema.columns
      WHERE table_name = 'checkout_bills' AND column_name LIKE 'ticket_extension%' ORDER BY column_name`;
    expect(cols).toEqual([
      { column: 'ticket_extension_benefit_id', dflt: null },
      { column: 'ticket_extension_minutes', dflt: '0' },
    ]);
    const [check] = await sql<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'checkout_bills_extension_check'`;
    expect(check!.def).toContain('ticket_extension_minutes > 0');
  });

  it('改过的 QY-004（版本 2）升级时不动', async () => {
    await schemaAt044();
    await insertQy004(2);
    await migrate(sql);
    const [q] = await sql<{ category: string }[]>`SELECT category FROM benefits WHERE code = 'QY-004'`;
    expect(q).toEqual({ category: 'service' });
  });
});
