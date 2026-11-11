// 点餐系统 · 平板电子菜单的接口（8.0.10，docs/EMENU.md 第 7 节）。
//   · 平板（要登录、要「打开平板点餐」）：菜单、按手牌找客人、核对桌号、下单、结果待确认的查回与作废、图片；
//   · 后台（「维护电子菜单」）：设置、分类、各页、菜品图文、图片上传、从价目表生成初稿；
//   · 点单密码：店主给人生成、收回（「管理员工账号」）；本人自己重新生成（要「餐饮点单」）。

import type { FastifyInstance } from 'fastify';
import { guard, guardAny } from '../../auth/guard';
import { readSnapshot } from '../../db';
import { ctxOf, type Deps } from '../../lib/context';
import { idParam, parse } from '../../lib/validate';
import { createEmenuCategory, createEmenuDish, emenuAdmin, generateEmenuDraft, saveEmenuPages, saveEmenuRules, updateEmenuCategory, updateEmenuDish } from './admin';
import { abandonEmenuOrder, checkEmenuTable, emenuGuest, emenuImage, emenuMenu, emenuOpLookup, placeEmenuOrder, saveEmenuImage } from './core';
import { clearOrderPin, orderPinStatus, setOrderPin } from './pins';

export function registerEmenuRoutes(app: FastifyInstance, deps: Deps) {
  const { sql } = deps;
  const tablet = guard('emenu.view');
  const manage = guard('emenu.manage');

  // ── 平板 ──
  // 维护电子菜单的人预览时也读这一份
  app.get('/api/emenu/menu', { preHandler: guardAny('emenu.view', 'emenu.manage') }, async () => readSnapshot(sql, (tx) => emenuMenu(tx, deps)));
  app.get('/api/emenu/guest', { preHandler: tablet }, async (req) => emenuGuest(sql, req.query ?? {}));
  app.get('/api/emenu/table', { preHandler: tablet }, async (req) => checkEmenuTable(sql, req.query ?? {}));
  app.post('/api/emenu/orders', { preHandler: tablet }, async (req) => placeEmenuOrder(deps, req.body, req.actor, req.ip));
  app.get('/api/emenu/orders/by-key/:key', { preHandler: tablet }, async (req) => emenuOpLookup(sql, req.params));
  app.post('/api/emenu/orders/by-key/:key/abandon', { preHandler: tablet }, async (req) => abandonEmenuOrder(deps, req.params, req.body, req.actor, req.ip));
  // 图片的内容不会变（按内容去重、只追加）：浏览器长期缓存
  app.get('/api/emenu/images/:id', { preHandler: guardAny('emenu.view', 'emenu.manage') }, async (req, reply) => {
    const img = await emenuImage(sql, parse(idParam, req.params).id);
    reply.header('content-type', img.mime).header('cache-control', 'private, max-age=31536000, immutable');
    return reply.send(img.data);
  });

  // ── 后台「电子菜单」 ──
  app.get('/api/admin/emenu', { preHandler: manage }, async () => readSnapshot(sql, emenuAdmin));
  app.put('/api/admin/emenu/rules', { preHandler: manage }, async (req) => saveEmenuRules(deps, req.body, ctxOf(req)));
  app.post('/api/admin/emenu/categories', { preHandler: manage }, async (req) => createEmenuCategory(deps, req.body, ctxOf(req)));
  app.put('/api/admin/emenu/categories/:id', { preHandler: manage }, async (req) => updateEmenuCategory(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  app.put('/api/admin/emenu/categories/:id/pages', { preHandler: manage }, async (req) => saveEmenuPages(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  app.post('/api/admin/emenu/dishes', { preHandler: manage }, async (req) => createEmenuDish(deps, req.body, ctxOf(req)));
  app.put('/api/admin/emenu/dishes/:id', { preHandler: manage }, async (req) => updateEmenuDish(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  // 图片：压缩后的 Base64，单张不超过 1 MB
  app.post('/api/admin/emenu/images', { preHandler: manage, bodyLimit: 1_600_000 }, async (req, reply) => {
    const img = await saveEmenuImage(sql, req.body, req.actor);
    reply.code(201);
    return img;
  });
  app.post('/api/admin/emenu/draft', { preHandler: manage }, async (req) => generateEmenuDraft(deps, ctxOf(req)));

  // ── 点单密码 ──
  // 店主给一位员工生成 / 重置（当场显示一次）、收回
  app.post('/api/staff/:id/order-pin', { preHandler: guard('staff.manage') }, async (req) => setOrderPin(deps, parse(idParam, req.params).id, ctxOf(req)));
  app.post('/api/staff/:id/order-pin/clear', { preHandler: guard('staff.manage') }, async (req) => {
    await clearOrderPin(deps, parse(idParam, req.params).id, ctxOf(req));
    return { ok: true };
  });
  // 本人：看有没有、自己重新生成（能点单的人才用得上）
  app.get('/api/auth/order-pin', { preHandler: guard('dining.order') }, async (req) => orderPinStatus(sql, req.actor.id));
  app.post('/api/auth/order-pin', { preHandler: guard('dining.order') }, async (req) => setOrderPin(deps, req.actor.id, ctxOf(req)));
}
