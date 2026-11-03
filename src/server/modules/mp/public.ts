// 小程序端口的公开只读接口（不需要绑定会员）：门店信息与轮播、价目、对客导览、图片。
// 只读，不加锁；对客导览只到区域（v0.7.19 的 guideData：没有房号、房态、人员）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { businessDateOf } from '@shared/business-date';
import type { MpBanner, MpHome, MpPriceItem, MpPrices, MpStore, MpTicket } from '@shared/mp';
import type { Db } from '../../db';
import type { Deps } from '../../lib/context';
import { notFound } from '../../lib/errors';
import { idParam, parse } from '../../lib/validate';
import { loadItems } from '../catalog';
import { guideData } from '../guide';
import { loadSettings } from '../settings';
import { requireMpEnabled } from './rules';

/** 门店当前的营业日（轮播按营业日显示） */
export async function mpToday(db: Db, timezone: string): Promise<string> {
  return businessDateOf(new Date(), timezone, (await loadSettings(db)).businessDayStartHour);
}

export async function mpHome(db: Db, today: string): Promise<MpHome> {
  const stores = await db<(Omit<MpStore, 'latitude' | 'longitude'> & { latitude: string | null; longitude: string | null })[]>`
    SELECT code, name, is_home, hours, address, phone, latitude, longitude, notice, image_id
    FROM mp_stores WHERE visible ORDER BY sort_order, id`;
  const banners = await db<MpBanner[]>`
    SELECT id, title, link, image_id FROM mp_banners
    WHERE active AND (starts_on IS NULL OR starts_on <= ${today}::date) AND (ends_on IS NULL OR ends_on >= ${today}::date)
    ORDER BY sort_order, id`;
  return {
    stores: stores.map((s) => ({ ...s, latitude: s.latitude === null ? null : Number(s.latitude), longitude: s.longitude === null ? null : Number(s.longitude) })),
    banners,
  };
}

export async function mpPrices(db: Db): Promise<MpPrices> {
  const tickets = await db<MpTicket[]>`
    SELECT name, price_12h, price_24h, note FROM ticket_types WHERE active ORDER BY sort_order, id`;
  const intros = new Map(
    (await db<{ itemId: number; intro: string; imageId: number | null }[]>`SELECT item_id, intro, image_id FROM mp_item_intros`).map((r) => [r.itemId, r]),
  );
  const items: MpPriceItem[] = (await loadItems(db)).map((i) => ({
    id: i.id,
    name: i.name,
    category: i.category,
    durationMinutes: i.durationMinutes,
    gender: i.gender,
    prices: i.prices.map((p) => ({ tier: p.tier, price: p.price })),
    intro: intros.get(i.id)?.intro ?? '',
    imageId: intros.get(i.id)?.imageId ?? null,
  }));
  return { tickets, items };
}

const FloorParam = z.object({ floor: z.string().regex(/^[A-Za-z0-9-]{1,10}$/, '楼层不正确') });
const SvgQuery = z.object({ b: z.coerce.number().int().positive('底图批次不正确') });

export function registerMpPublicRoutes(app: FastifyInstance, deps: Deps) {
  const { sql, config } = deps;
  const enabled = requireMpEnabled(sql);

  // 网关查看门店系统是否连得上（不看开关）
  app.get('/api/mp/health', async () => {
    await sql`SELECT 1`;
    return { ok: true, version: config.version, commit: config.commit, instance: config.instance };
  });

  app.get('/api/mp/home', { preHandler: enabled }, async () => mpHome(sql, await mpToday(sql, config.timezone)));
  app.get('/api/mp/prices', { preHandler: enabled }, async () => mpPrices(sql));
  app.get('/api/mp/guide', { preHandler: enabled }, async () => guideData(sql));

  // 对客导览的底图：与员工端口的 /api/guide/floors/:floor/svg 同样只给在用的那一批，并去掉图上的文字
  app.get('/api/mp/guide/floors/:floor/svg', { preHandler: enabled }, async (req, reply) => {
    const { floor } = parse(FloorParam, req.params);
    const { b } = parse(SvgQuery, req.query);
    const [row] = await sql<{ svg: string }[]>`
      SELECT f.svg FROM floorplan_floors f JOIN floorplan_batches bt ON bt.id = f.batch_id
      WHERE f.batch_id = ${b} AND bt.status = 'active' AND f.floor_code = ${floor}`;
    if (!row) {
      reply.header('cache-control', 'no-store');
      throw notFound('这一层的导览图换过了，请刷新');
    }
    reply.header('content-type', 'image/svg+xml; charset=utf-8').header('cache-control', 'public, max-age=86400');
    return row.svg.replace(/<g class="labels"[^>]*>[\s\S]*?<\/g>/, '');
  });

  // 图片只追加、按编号不会变，可以长期缓存（网关缓存后发给小程序）
  app.get('/api/mp/images/:id', { preHandler: enabled }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const [row] = await sql<{ mime: string; data: Buffer }[]>`SELECT mime, data FROM mp_images WHERE id = ${id}`;
    if (!row) throw notFound('图片不存在');
    reply.header('content-type', row.mime).header('cache-control', 'public, max-age=31536000, immutable');
    return row.data;
  });
}
