// 应用在跑的标记（v0.7.19；main 定时测试报告 P2：应用开着但空闲时 demo-reset 照样清库，与交接说明不符）。
// 应用进程在一条专用连接上持有共享咨询锁，直到退出；demo-reset 清库前试拿同一把锁的排他锁，拿不到就是还有应用开着。
// 不看业务连接池：池里的空闲连接 30 秒就关，空闲的应用在数据库里看不到连接。几个应用进程可以同时持有共享锁。
// 专用连接单独开（只有一条、不因空闲或用久了关掉）。数据库重启、连接断了锁就没了：每分钟的定时扫描顺带检查，
// 没拿着就重新拿；检查出错或卡住（连接断的那一刻发出的查询可能一直等不到回应）就扔掉这条连接、换一条新的再拿。
// 不用业务连接池的 reserve()：那条连接断了以后再用会让进程崩掉。

import postgres from 'postgres';
import type { Tx } from './db';

/** 咨询锁的名字（hashtextextended 算成 64 位的键，与迁移、各模块的锁不会撞） */
export const APP_PRESENCE_LOCK = 'yuzu_app_presence';

export interface AppPresence {
  /** 专用连接上还拿着锁；连接断过（锁没了）就重新拿。拿不到抛错，调用方记日志、下一分钟再试 */
  ensure(): Promise<void>;
  release(): Promise<void>;
}

/** 等 ms 毫秒还没结果就算失败（原来的查询之后再出错也不会变成没人接的异常） */
async function within<T>(p: Promise<T>, ms: number): Promise<T> {
  p.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`等了 ${ms / 1000} 秒没有回应`)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 应用启动时调用：开一条专用连接并拿共享锁。
 * attemptMs：每次检查、拿锁最多等多久（demo-reset 清库的事务拿着排他锁时要等它结束，默认 60 秒；测试用得短）
 */
export async function holdAppPresence(databaseUrl: string, opts: { attemptMs?: number } = {}): Promise<AppPresence> {
  const attemptMs = opts.attemptMs ?? 60_000;
  const open = () =>
    postgres(databaseUrl, {
      max: 1,
      idle_timeout: 0,
      max_lifetime: 0,
      connect_timeout: 10,
      onnotice: () => {},
      connection: { application_name: 'yuzu-app-presence' },
    });
  // 只有一条连接：查有没有拿着与拿锁在同一个会话里
  const attempt = async (c: postgres.Sql) => {
    const [row] = await c<{ held: boolean }[]>`
      WITH k AS (SELECT hashtextextended(${APP_PRESENCE_LOCK}, 0) AS v)
      SELECT EXISTS (
        SELECT 1 FROM pg_locks l, k
        WHERE l.locktype = 'advisory' AND l.pid = pg_backend_pid() AND l.granted AND l.objsubid = 1
          AND l.classid = ((k.v >> 32) & 4294967295)::oid AND l.objid = (k.v & 4294967295)::oid
      ) AS held`;
    if (!row?.held) await c`SELECT pg_advisory_lock_shared(hashtextextended(${APP_PRESENCE_LOCK}, 0))`;
  };
  let conn = open();
  const ensure = async () => {
    try {
      await within(attempt(conn), attemptMs);
      return;
    } catch {
      // 连接断过或卡住：扔掉，换一条新连接
      const old = conn;
      conn = open();
      void old.end({ timeout: 0 }).catch(() => {});
    }
    await within(attempt(conn), attemptMs);
  };
  try {
    await ensure();
  } catch (error) {
    await conn.end({ timeout: 0 }).catch(() => {});
    throw error;
  }
  return {
    ensure,
    async release() {
      // 断开连接锁就放了
      await conn.end({ timeout: 5 }).catch(() => {});
    },
  };
}

/**
 * 在事务里试拿应用标记的排他锁（事务结束自动放开）：拿到说明现在没有应用开着，
 * 而且事务结束前新启动的应用会在拿共享锁那一步等着（不会在清库中途连上来用）
 */
export async function noAppRunning(tx: Tx): Promise<boolean> {
  const [row] = await tx<{ free: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtextextended(${APP_PRESENCE_LOCK}, 0)) AS free`;
  return row?.free === true;
}
