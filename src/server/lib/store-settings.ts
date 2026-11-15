// 按店的设置（8.0.22，docs/MULTISTORE_V8022.md 第 4 节）：营业日切换时间、交班、钱箱、打印、前台 / 餐饮 / 客房 / 预约 /
// 技师 / 钟房 / 实时位置 / 导览 / 扣料这些规则，第二家店单独设过的用它自己的（store_settings），没设过的用全公司的；
// 本店照旧只用 settings。读、写都按当前门店（请求的上下文）。

import { STORE_SCOPED_SETTING_KEYS } from '@shared/stores';
import type { Db, Tx } from '../db';
import { currentStoreId, DEFAULT_STORE_ID } from './store-context';

const SCOPED = new Set<string>(STORE_SCOPED_SETTING_KEYS);
export const isStoreScopedKey = (key: string) => SCOPED.has(key);

/** 读一项设置：按店的项，当前门店不是本店、又单独设过的用门店的；不然用全公司的 */
export async function settingRow<T>(db: Db, key: string): Promise<{ value: T } | undefined> {
  const storeId = currentStoreId();
  if (storeId !== DEFAULT_STORE_ID && SCOPED.has(key)) {
    const [own] = await db<{ value: T }[]>`SELECT value FROM store_settings WHERE store_id = ${storeId} AND key = ${key}`;
    if (own) return own;
  }
  const [row] = await db<{ value: T }[]>`SELECT value FROM settings WHERE key = ${key}`;
  return row;
}

/** 当前门店单独设过的那几项（本店是空的） */
export async function storeOverrides(db: Db): Promise<Map<string, unknown>> {
  const storeId = currentStoreId();
  if (storeId === DEFAULT_STORE_ID) return new Map();
  const rows = await db<{ key: string; value: unknown }[]>`SELECT key, value FROM store_settings WHERE store_id = ${storeId}`;
  return new Map(rows.filter((r) => SCOPED.has(r.key)).map((r) => [r.key, r.value]));
}

/** 写一项设置（调用方已经取了设置锁）：按店的项在第二家店里写进 store_settings；「不限」「全天」存 JSON null */
export async function upsertSetting(tx: Tx, key: string, value: unknown, staffId: number): Promise<void> {
  const storeId = currentStoreId();
  const json = value === null ? tx`'null'::jsonb` : tx.json(value as never);
  if (storeId !== DEFAULT_STORE_ID && SCOPED.has(key)) {
    await tx`
      INSERT INTO store_settings (store_id, key, value, updated_at, updated_by) VALUES (${storeId}, ${key}, ${json}, now(), ${staffId})
      ON CONFLICT (store_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`;
    return;
  }
  await tx`
    INSERT INTO settings (key, value, updated_at, updated_by) VALUES (${key}, ${json}, now(), ${staffId})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`;
}
