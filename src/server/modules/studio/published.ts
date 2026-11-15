// UI 工作台（8.1.1）：平板现在用哪一版版面。单独一个文件：电子菜单的菜单接口也调它，不跟工作台的其余部分互相引用。

import type { StudioPublishedRef, StudioSurface } from '@shared/studio';
import type { Db } from '../../db';
import { currentStoreId, DEFAULT_STORE_ID } from '../../lib/store-context';

/** 平板现在用哪一版：这家店的，没有就本店的（GZ11）；都没有为空（用内置的默认版面） */
export async function studioPublishedRef(db: Db, surface: StudioSurface): Promise<(StudioPublishedRef & { inherited: boolean }) | null> {
  const storeId = currentStoreId();
  const [own] = await db<{ id: number; version: number }[]>`
    SELECT id, version FROM studio_versions WHERE surface = ${surface} AND store_id = ${storeId} ORDER BY version DESC LIMIT 1`;
  if (own) return { id: Number(own.id), version: Number(own.version), inherited: false };
  if (storeId === DEFAULT_STORE_ID) return null;
  const [base] = await db<{ id: number; version: number }[]>`
    SELECT id, version FROM studio_versions WHERE surface = ${surface} AND store_id = ${DEFAULT_STORE_ID} ORDER BY version DESC LIMIT 1`;
  return base ? { id: Number(base.id), version: Number(base.version), inherited: true } : null;
}
