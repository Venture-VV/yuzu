// UI 工作台：现在用哪一版版面。单独一个文件：电子菜单的菜单接口、小程序线都调它，不跟工作台的其余部分互相引用。
//
// 给小程序线（8.1.2，docs/STUDIO_MP.md 第 5 节）：readPublishedStudio 读已发布的版面、readStudioAssetFor 取版面里用到的图。
// 小程序线在 /api/mp 里转出去（不另建表、不改这里）；这两个只读、不加锁。

import { DocSchema, validateStudioDoc, type StudioDoc, type StudioPublishedRef, type StudioSurface } from '@shared/studio';
import type { Db } from '../../db';
import { currentStoreId, DEFAULT_STORE_ID } from '../../lib/store-context';

/** 平板现在用哪一版：这家店的，没有就本店的（GZ11）；都没有为空（用内置的默认版面） */
export async function studioPublishedRef(db: Db, surface: StudioSurface, storeId = currentStoreId()): Promise<(StudioPublishedRef & { inherited: boolean }) | null> {
  const [own] = await db<{ id: number; version: number }[]>`
    SELECT id, version FROM studio_versions WHERE surface = ${surface} AND store_id = ${storeId} ORDER BY version DESC LIMIT 1`;
  if (own) return { id: Number(own.id), version: Number(own.version), inherited: false };
  if (storeId === DEFAULT_STORE_ID) return null;
  const [base] = await db<{ id: number; version: number }[]>`
    SELECT id, version FROM studio_versions WHERE surface = ${surface} AND store_id = ${DEFAULT_STORE_ID} ORDER BY version DESC LIMIT 1`;
  return base ? { id: Number(base.id), version: Number(base.version), inherited: true } : null;
}

export interface PublishedStudio {
  /** 全局编号：内容不会变（只追加），可以按它长期缓存 */
  id: number;
  /** 这家店的第几版 */
  version: number;
  /** 这家店没发布过、用的是本店（编号 1）的 */
  inherited: boolean;
  publishedAt: string;
  doc: StudioDoc;
}

/**
 * 某个界面现在用哪一份已发布的版面（小程序线、员工食堂读）：这家店的最新一版，没有用本店的；都没有返回空（用自己原来的页面）。
 * 存进去时核对过；读出来再按现在的格式与界面登记核对一遍，对不上（界面登记以后改过）也返回空，不给半份。
 */
export async function readPublishedStudio(db: Db, surface: StudioSurface, storeId = currentStoreId()): Promise<PublishedStudio | null> {
  const ref = await studioPublishedRef(db, surface, storeId);
  if (!ref) return null;
  const [r] = await db<{ doc: unknown; publishedAt: string }[]>`SELECT doc, published_at FROM studio_versions WHERE id = ${ref.id}`;
  if (!r) return null;
  const parsed = DocSchema.safeParse(r.doc);
  if (!parsed.success || parsed.data.surface !== surface) return null;
  if (validateStudioDoc(parsed.data).some((i) => i.level === 'error')) return null;
  return { id: ref.id, version: ref.version, inherited: ref.inherited, publishedAt: new Date(r.publishedAt).toISOString(), doc: parsed.data };
}

/**
 * 取版面里的一张图（小程序线转给小程序用）：只给这个界面已经发布过的版面里用到的图（任何一家店、任何一版），
 * 不让小程序的接口变成随便取素材库的口子。没有返回空。图的内容按编号（SHA-256）不会变，可以长期缓存。
 */
export async function readStudioAssetFor(db: Db, surface: StudioSurface, assetId: string): Promise<{ mime: string; data: Buffer } | null> {
  if (!/^[0-9a-f]{64}$/.test(assetId)) return null;
  const [used] = await db<{ ok: number }[]>`
    SELECT 1 AS ok FROM studio_versions
    WHERE surface = ${surface} AND jsonb_path_exists(doc, '$.** ? (@.type == "image" && @.asset == $id)', jsonb_build_object('id', ${assetId}::text))
    LIMIT 1`;
  if (!used) return null;
  const [a] = await db<{ mime: string; data: Buffer }[]>`SELECT mime, data FROM studio_assets WHERE id = ${assetId}`;
  return a ? { mime: a.mime, data: a.data } : null;
}
