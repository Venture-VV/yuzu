// 测试库地址与重建（集成测试按文件并行，见 vitest.config.ts）：
//   · 并行跑时（TEST_WORKERS > 1）每个进程用自己的库，库名加 _w<进程编号>（vitest 的 VITEST_POOL_ID）；
//   · 每个测试文件开始时，从开跑前迁移好的模板库（库名加 _tpl）整库复制出一份新的，不再整个删 public 模式：
//     一句 DROP SCHEMA 删一个迁移好的模式，要在一个事务里拿下所有表、索引、类型的锁（v0.7.30 实测约 6500 把，表越多越多），
//     数据库的共享锁表（默认 max_locks_per_transaction 64）快被占满，同一时刻别的进程要锁就报 out of shared memory；
//   · 要清空模式的（升级测试从空库按旧版本迁移；不并行时每个测试文件开始时）分批删表（dropPublicSchema），每批一个事务、锁随事务放掉；
//     并行时几个进程还排队（在基础库上取同一把咨询锁），同一时刻只有一个在删。
// 只在名字含 test 的库上做这些（防止 TEST_DATABASE_URL 误指到演示库或正式库）。

import postgres from 'postgres';
import { dropSchemaInBatches } from '../src/server/lib/drop-schema';

export const BASE_TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://yuzu:yuzu_dev_only@127.0.0.1:5432/yuzu_test';

const dbNameOf = (url: string) => decodeURIComponent(new URL(url).pathname.slice(1));
const withDbName = (url: string, name: string) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};

export const workerDbName = (baseName: string, worker: number) => `${baseName}_w${worker}`;
export const templateDbName = (baseName: string) => `${baseName}_tpl`;

export function assertTestDbName(url: string) {
  const name = dbNameOf(url);
  if (!/test/i.test(name)) throw new Error(`TEST_DATABASE_URL 的库名「${name}」不像测试库（应含 test），为防误清别的库，已停止`);
}

/** 是否按进程分库并行 */
export const parallelDbs = () => (Number(process.env.TEST_WORKERS) || 1) > 1 && !!Number(process.env.VITEST_POOL_ID);

/** 这个测试进程用的库 */
export function testDbUrl(): string {
  if (!parallelDbs()) return BASE_TEST_DB;
  return withDbName(BASE_TEST_DB, workerDbName(dbNameOf(BASE_TEST_DB), Number(process.env.VITEST_POOL_ID)));
}

/** 在基础库上执行管理语句（建库、删库、咨询锁） */
async function withAdmin<T>(fn: (admin: postgres.Sql) => Promise<T>): Promise<T> {
  const admin = postgres(BASE_TEST_DB, { max: 1, onnotice: () => {} });
  try {
    return await fn(admin);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

/**
 * 删库（WITH FORCE 断开别的连接）。上一轮刚写满的库可能正被自动清理（autovacuum）处理：那是超级用户的进程，
 * 普通账号断不开，会报 permission denied to terminate process——稍等重试，清理完就能删
 */
export async function dropDatabase(admin: postgres.Sql, name: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      return;
    } catch (e) {
      if (attempt >= 20 || !/permission denied to terminate process/.test(String((e as Error).message))) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/** 并行时：把这个进程的库换成模板库的一份新复制（已迁移到最新）；返回是否换了（不并行时返回 false，由调用方自己清库迁移） */
export async function recreateFromTemplate(): Promise<boolean> {
  if (!parallelDbs()) return false;
  assertTestDbName(BASE_TEST_DB);
  const base = dbNameOf(BASE_TEST_DB);
  const name = dbNameOf(testDbUrl());
  await withAdmin(async (admin) => {
    await dropDatabase(admin, name);
    await admin.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${templateDbName(base)}"`);
  });
  return true;
}

/**
 * 清空 public 模式重建：分批删表（每批一个事务，锁随事务放掉），再删模式里剩下的函数、类型与序列（src/server/lib/drop-schema.ts，
 * demo-reset 也用它）。不一句 DROP SCHEMA public CASCADE：那要在一个事务里拿下整个模式的锁（约 6500 把），见文件开头
 */
export async function dropPublicSchema(sql: { unsafe: (q: string) => PromiseLike<unknown> }): Promise<void> {
  await dropSchemaInBatches(sql, 'public');
  await sql.unsafe('CREATE SCHEMA public');
}

/** 删掉 public 模式重建（升级测试用）：分批删表；并行时几个进程排队，同一时刻只有一个在删 */
export async function resetPublicSchema(sql: postgres.Sql | { unsafe: (q: string) => Promise<unknown> }) {
  const drop = () => dropPublicSchema(sql);
  if (!parallelDbs()) {
    await drop();
    return;
  }
  await withAdmin(async (admin) => {
    await admin`SELECT pg_advisory_lock(hashtext('yuzu-test-drop-schema'))`;
    try {
      await drop();
    } finally {
      await admin`SELECT pg_advisory_unlock(hashtext('yuzu-test-drop-schema'))`;
    }
  });
}

export const testDb = { dbNameOf, withDbName };
