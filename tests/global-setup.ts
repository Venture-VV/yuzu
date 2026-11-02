// 集成测试并行时的准备（见 tests/test-db.ts）：
//   · 建好每个进程的库（库名加 _w<进程编号>），升级测试直接用它；
//   · 重建模板库（库名加 _tpl）并迁移到最新，每个测试文件开始时从它整库复制。
// 不并行（TEST_WORKERS=1）时什么都不做，测试照旧在 TEST_DATABASE_URL 那一个库里清库、迁移。

import postgres from 'postgres';
import { migrate } from '../src/server/migrate';
import { createSql } from '../src/server/db';
import { assertTestDbName, BASE_TEST_DB, templateDbName, testDb, workerDbName } from './test-db';

export default async function setup() {
  const workers = Number(process.env.TEST_WORKERS) || 1;
  if (workers <= 1) return;
  assertTestDbName(BASE_TEST_DB);
  const base = testDb.dbNameOf(BASE_TEST_DB);
  const tpl = templateDbName(base);
  const admin = postgres(BASE_TEST_DB, { max: 1, onnotice: () => {} });
  try {
    for (let i = 1; i <= workers; i++) {
      const name = workerDbName(base, i);
      const [found] = await admin<{ hit: number }[]>`SELECT 1 AS hit FROM pg_database WHERE datname = ${name}`;
      if (!found) await admin.unsafe(`CREATE DATABASE "${name}"`);
    }
    await admin.unsafe(`DROP DATABASE IF EXISTS "${tpl}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${tpl}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const sql = createSql(testDb.withDbName(BASE_TEST_DB, tpl), { max: 2 });
  try {
    await migrate(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
