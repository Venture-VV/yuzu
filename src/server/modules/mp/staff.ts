// 员工端口上的小程序接口（小程序线）：前台用会员码查会员、看会员的微信绑定记录、解绑。
// 后台「小程序」模块（门店信息、首页轮播、项目介绍、开关）也挂在这里（第 12 节 ②）。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { guard, guardAny } from '../../auth/guard';
import { ctxOf, type Deps } from '../../lib/context';
import { notFound } from '../../lib/errors';
import { idParam, parse } from '../../lib/validate';
import { getMember } from '../members';
import { abandonBannerCreate, createBanner, lookupBannerOp, mpAdminData, saveItemIntro, saveMpImage, saveMpRules, saveStore, updateBanner } from './admin';
import { memberBindings, resolveMemberCode, unbindMember } from './member';

const CodeParam = z.object({ code: z.string().trim().max(32) });

export function registerMpStaffRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  // 前台扫码盒扫进会员码：认出会员（只认人，用储值付款时照旧核对）
  app.get('/api/mp-codes/:code', { preHandler: guard('member.read') }, async (req) => resolveMemberCode(deps, parse(CodeParam, req.params).code));
  app.get('/api/admin/mp/members/:id/bindings', { preHandler: guard('member.read') }, async (req) => {
    const { id } = parse(idParam, req.params);
    await getMember(sql, id);
    return memberBindings(sql, id);
  });
  app.post('/api/admin/mp/bindings/:id/unbind', { preHandler: guard('mp.unbind') }, async (req) => unbindMember(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));

  // 后台「小程序」：维护内容要 mp.content；只管解绑的（值班经理）也能打开看
  const content = guard('mp.content');
  app.get('/api/admin/mp', { preHandler: guardAny('mp.content', 'mp.unbind') }, async () => mpAdminData(sql));
  app.put('/api/admin/mp/rules', { preHandler: content }, async (req) => saveMpRules(deps, req.body, ctxOf(req)));
  app.put('/api/admin/mp/stores/:code', { preHandler: content }, async (req) => saveStore(deps, req.params, req.body, ctxOf(req)));
  app.post('/api/admin/mp/images', { preHandler: content, bodyLimit: 1_600_000 }, async (req, reply) => {
    const img = await saveMpImage(sql, req.body, req.actor);
    reply.code(201);
    return img;
  });
  app.get('/api/admin/mp/images/:id', { preHandler: guardAny('mp.content', 'mp.unbind') }, async (req, reply) => {
    const [img] = await sql<{ mime: string; data: Buffer }[]>`SELECT mime, data FROM mp_images WHERE id = ${parse(idParam, req.params).id}`;
    if (!img) throw notFound('图片不存在');
    reply.header('content-type', img.mime).header('cache-control', 'private, max-age=31536000, immutable');
    return reply.send(img.data);
  });
  app.post('/api/admin/mp/banners', { preHandler: content }, async (req, reply) => {
    const banner = await createBanner(deps, req.body, ctxOf(req));
    reply.code(banner.replayed ? 200 : 201);
    return banner;
  });
  // 新建结果不确定时：按编号查回（只读），或确认作废这个编号（已经建了就返回那一条）
  app.get('/api/admin/mp/banners/ops/:key', { preHandler: content }, async (req) => lookupBannerOp(sql, (req.params as { key?: unknown }).key));
  app.post('/api/admin/mp/banners/abandon', { preHandler: content }, async (req) => abandonBannerCreate(deps, req.body, ctxOf(req)));
  app.put('/api/admin/mp/banners/:id', { preHandler: content }, async (req) => updateBanner(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  app.put('/api/admin/mp/items/:id/intro', { preHandler: content }, async (req) => saveItemIntro(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
}
