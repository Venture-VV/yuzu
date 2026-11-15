// 当前门店（8.0.22，docs/MULTISTORE_V8022.md 第 3 节）。
//   · 请求解析完会话以后，把当前门店放进这次请求的上下文（AsyncLocalStorage）；
//   · 每个事务开头（db.ts 包住的 begin）在当前门店不是本店时 set_config('yuzu.store', 门店编号, true)，
//     业务表 store_id 的默认值取 yuzu_store()（没设就是本店）——新写的单据自动记上当前门店；
//   · 本店（编号 1）什么都不设：只有一家店时与以往完全一样。
//   · 每分钟的自动任务按单据自己的门店处理时用 runInStore 包一层。

import { AsyncLocalStorage } from 'node:async_hooks';

export const DEFAULT_STORE_ID = 1;

const als = new AsyncLocalStorage<{ storeId: number }>();

/** 这次请求（或 runInStore 里）的当前门店；没有上下文时是本店 */
export function currentStoreId(): number {
  return als.getStore()?.storeId ?? DEFAULT_STORE_ID;
}

/** 在某家店的上下文里执行（请求的门店、自动任务逐家处理时） */
export function runInStore<T>(storeId: number, fn: () => T): T {
  return als.run({ storeId }, fn);
}
