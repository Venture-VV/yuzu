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
import { bookingMpAdminData, saveBookingMpRules } from './bookings';
import { couponAdminData, saveCouponRules } from './coupon-center';
import { foodAdminData, saveFoodRules } from './food';
import { memberBindings, resolveMemberCode, unbindMember } from './member';
import { activePay } from './pay';
import { closeUnboundOrders } from './recharge';
import { rechargeAdminData, resolveHeldOrder, runRecon, saveRechargeRules } from './recharge-admin';
import { handleRefund, retryRefund } from './refund';
import { inviteAdminData, saveInviteRules } from './invites';
import { reminderAdminData, saveReminderRules } from './reminders';

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
  app.post('/api/admin/mp/bindings/:id/unbind', { preHandler: guard('mp.unbind') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const row = await unbindMember(deps, id, req.body, ctxOf(req));
    // 解绑提交之后：这条绑定还没付的线上充值单马上请微信关掉，旧微信不能再付（小程序线测试 866ccfa 的 P1）。
    // 关不上的（微信连不上）每分钟的补查接着关，不影响解绑的结果；同一个操作编号重提时这里没有可关的
    await closeUnboundOrders(deps, activePay(), id).catch(() => {});
    return row;
  });

  // 后台「小程序」：维护内容要 mp.content；只管解绑的（值班经理）也能打开看
  const content = guard('mp.content');
  app.get('/api/admin/mp', { preHandler: guardAny('mp.content', 'mp.unbind', 'mp.recharge', 'mp.coupon', 'mp.reminder', 'mp.invite', 'mp.food', 'mp.booking') }, async () => mpAdminData(sql));
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

  // 线上充值（第二期 2a）：设置、线上充值单、处理已付款待处理的（mp.recharge：店主、店总）
  const recharge = guard('mp.recharge');
  app.get('/api/admin/mp/recharge', { preHandler: recharge }, async () => rechargeAdminData(sql));
  app.put('/api/admin/mp/recharge/rules', { preHandler: recharge }, async (req) => saveRechargeRules(deps, req.body, ctxOf(req)));
  app.post('/api/admin/mp/recharge/orders/:id/resolve', { preHandler: recharge }, async (req) =>
    resolveHeldOrder(deps, parse(idParam, req.params).id, req.body, ctxOf(req)),
  );
  // 2b 对账：按天重新核对（只追加一条结论）
  app.post('/api/admin/mp/recharge/recon', { preHandler: recharge }, async (req) => runRecon(deps, req.body, ctxOf(req)));
  // 2d 原路退回：没退成的重试、已另行处理
  app.post('/api/admin/mp/refunds/:id/retry', { preHandler: recharge }, async (req) => retryRefund(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));
  app.post('/api/admin/mp/refunds/:id/handle', { preHandler: recharge }, async (req) => handleRefund(deps, parse(idParam, req.params).id, req.body, ctxOf(req)));

  // 领券中心（第二期 2c）：哪些券可领、每人限领几张、停领，领取记录（mp.coupon：店主、店总，MP27）
  const coupon = guard('mp.coupon');
  app.get('/api/admin/mp/coupons', { preHandler: coupon }, async () => couponAdminData(deps));
  app.put('/api/admin/mp/coupons/rules', { preHandler: coupon }, async (req) => saveCouponRules(deps, req.body, ctxOf(req)));
  // 到期提醒（第三期 3a）：开关、三种订阅消息模板，最近的消息（mp.reminder：店主、店总）
  const reminder = guard('mp.reminder');
  app.get('/api/admin/mp/reminders', { preHandler: reminder }, async () => reminderAdminData(deps));
  app.put('/api/admin/mp/reminders/rules', { preHandler: reminder }, async (req) => saveReminderRules(deps, req.body, ctxOf(req)));
  // 邀请好友（第三期 3b）：开关，最近的邀请（mp.invite：店主、店总）
  const invite = guard('mp.invite');
  app.get('/api/admin/mp/invites', { preHandler: invite }, async () => inviteAdminData(deps));
  app.put('/api/admin/mp/invites/rules', { preHandler: invite }, async (req) => saveInviteRules(deps, req.body, ctxOf(req)));
  // 扫码点餐（第三期 3c）：开关、小程序可点的菜、桌码，最近的点单（mp.food：店主、店总）
  const food = guard('mp.food');
  app.get('/api/admin/mp/food', { preHandler: food }, async () => foodAdminData(deps));
  app.put('/api/admin/mp/food/rules', { preHandler: food }, async (req) => saveFoodRules(deps, req.body, ctxOf(req)));
  // 预约（第三期 3d）：开关、小程序可约的项目与房间，最近的小程序预约（mp.booking：店主、店总）
  const booking = guard('mp.booking');
  app.get('/api/admin/mp/bookings', { preHandler: booking }, async () => bookingMpAdminData(deps));
  app.put('/api/admin/mp/bookings/rules', { preHandler: booking }, async (req) => saveBookingMpRules(deps, req.body, ctxOf(req)));
}
