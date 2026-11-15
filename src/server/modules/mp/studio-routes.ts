// 小程序端口的版面与素材只读入口（8.1.2，docs/STUDIO_MP.md 第 5 节）：
//   · GET /api/mp/studio：调主线的 readPublishedStudio(sql, 'mp', storeId)，读当前已生效且未撤销的小程序版面（组件已展开）；
//     设计师可以定时发布，所以响应头设 cache-control: no-store，小程序每次进页面、回到前台都重新问一次；
//   · GET /api/mp/studio/assets/:id：调主线的 readStudioAssetFor(sql, 'mp', id)，只返回已发布小程序版面（含定时未到点）里用到的图，
//     内容按 SHA-256 不会变，带长期缓存头。
// 两个函数都只读、不加锁、不写任何表。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MpStudioResponse } from '@shared/mp';
import type { Deps } from '../../lib/context';
import { notFound } from '../../lib/errors';
import { DEFAULT_STORE_ID } from '../../lib/store-context';
import { parse } from '../../lib/validate';
import { assetHeaders } from '../studio/assets';
import { readPublishedStudio, readStudioAssetFor } from '../studio/published';
import { requireMpEnabled } from './rules';

const StudioQuery = z.object({
  store: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, '门店代码不正确').optional(),
});

export function registerMpStudioRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const enabled = requireMpEnabled(sql);

  app.get('/api/mp/studio', { preHandler: enabled }, async (req, reply): Promise<MpStudioResponse> => {
    const { store } = parse(StudioQuery, req.query);
    let storeId = DEFAULT_STORE_ID;
    if (store) {
      const [found] = await sql<{ id: number }[]>`SELECT id FROM stores WHERE code = ${store} AND active LIMIT 1`;
      if (found) storeId = Number(found.id);
    }
    const p = await readPublishedStudio(sql, 'mp', storeId);
    reply.header('cache-control', 'no-store');
    return {
      layout: p ? { id: p.id, version: p.version, publishedAt: p.publishedAt, doc: p.doc } : null,
    };
  });

  app.get('/api/mp/studio/assets/:id', { preHandler: enabled }, async (req, reply) => {
    const id = String((req.params as { id?: string }).id ?? '');
    const a = await readStudioAssetFor(sql, 'mp', id);
    if (!a) {
      reply.header('cache-control', 'no-store');
      throw notFound('图片不存在');
    }
    reply.headers({ ...assetHeaders(a.mime), 'cache-control': 'public, max-age=31536000, immutable' });
    return reply.send(a.data);
  });
}
