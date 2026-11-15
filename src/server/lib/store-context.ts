// 当前门店（8.0.22，docs/MULTISTORE_V8022.md 第 3 节）。
//   · 请求解析完会话以后，把当前门店放进这次请求的上下文（AsyncLocalStorage）；
//   · 每个事务开头（db.ts 包住的 begin）在当前门店不是本店时 set_config('yuzu.store', 门店编号, true)，
//     业务表 store_id 的默认值取 yuzu_store()（没设就是本店）——新写的单据自动记上当前门店；
//   · 本店（编号 1）什么都不设：只有一家店时与以往完全一样。
//   · 每分钟的自动任务按单据自己的门店处理时用 runInStore 包一层。

import { AsyncLocalStorage } from 'node:async_hooks';
// 只引用类型（编译后不留 import），不会与 db.ts 循环引用
import type { Db, Fragment, Tx } from '../db';

export const DEFAULT_STORE_ID = 1;

const als = new AsyncLocalStorage<{ storeId: number; storeSet?: number[] }>();

/** 这次请求（或 runInStore 里）的当前门店；没有上下文时是本店 */
export function currentStoreId(): number {
  return als.getStore()?.storeId ?? DEFAULT_STORE_ID;
}

/** 在某家店的上下文里执行（请求的门店、自动任务逐家处理时） */
export function runInStore<T>(storeId: number, fn: () => T): T {
  return als.run({ storeId }, fn);
}

/** 报表、看板看哪几家店：默认当前门店；「合并看」时是 runWithStoreSet 给的那几家 */
export function reportStoreIds(): number[] {
  const s = als.getStore();
  return s?.storeSet ?? [s?.storeId ?? DEFAULT_STORE_ID];
}

/** 「合并看」（MD18）：在这几家店的范围里出报表（当前门店不变，写入照旧记当前门店） */
export function runWithStoreSet<T>(ids: number[], fn: () => T): T {
  return als.run({ storeId: currentStoreId(), storeSet: ids }, fn);
}

/** 报表的门店条件：列名 IN（这几家店）。col 形如 'c.store_id' */
export function storeIn(db: Db, col: string): Fragment {
  return db`${db(col)} IN ${db(reportStoreIds())}`;
}

/**
 * 在单据所在的门店里接着处理（小程序入口、每分钟的自动任务）：事务里记上那家店（之后新写的单据落在那家店），
 * currentStoreId() 也换成它。本店照旧什么都不设。
 */
export async function inRowStore<T>(tx: Tx, storeId: number, fn: () => Promise<T>): Promise<T> {
  if (storeId !== DEFAULT_STORE_ID || currentStoreId() !== DEFAULT_STORE_ID) {
    await tx`SELECT set_config('yuzu.store', ${storeId === DEFAULT_STORE_ID ? '' : String(storeId)}, true)`;
  }
  return runInStore(storeId, fn);
}

/** 每家启用的门店各跑一次（自动任务）：只有本店时就是直接跑一次，与以往一样 */
export async function forEachStore(sql: Db, fn: (storeId: number) => Promise<void>): Promise<void> {
  const stores = await sql<{ id: number }[]>`SELECT id FROM stores WHERE active ORDER BY id`;
  for (const s of stores.length ? stores : [{ id: DEFAULT_STORE_ID }]) {
    await runInStore(Number(s.id), () => fn(Number(s.id)));
  }
}
