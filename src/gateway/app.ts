// 小程序网关（小程序线，docs/MINIPROGRAM.md 第 1、12 节）：小程序只连这里（公网 HTTPS，备案域名），网关经 Tailscale 只连 yuzu 的小程序端口。
//   · 登录：wx.login 的 code 换 openid，发网关会话（7 天，只有 openid，MP11）；
//   · 展示内容（门店信息、价目、导览、图片）：缓存，门店断外网时给旧的（最多 7 天）；
//   · 会员相关（绑定、会员卡、流水、券、会员码）：带会话里的 openid 原样转给 yuzu，门店连不上时 503 STORE_OFFLINE；
//   · 绑定：先用手机号快速验证的 code 换手机号，再转给 yuzu（手机号对上会员才绑）；结果不确定时小程序经 /v1/bind/abandon 确认作废。
//   · 线上充值（第二期 2a，docs/MP_RECHARGE.md）：/v1/recharge… 带会话里的 openid 转给 yuzu（建单、支付参数都在 yuzu 签）；
//     到账通知 /v1/pay/notify 不要会话、不解析内容，连同微信的四个签名头原样转给 yuzu，按 yuzu 的结果回微信。
//     网关不放任何支付凭据（MP17）：验签、解密、入账都在 yuzu，网关被攻破也伪造不了到账。
//   · 线上领券（第二期 2c，docs/MP_COUPONS.md）：/v1/coupon-center、/v1/coupon-claims… 带会话里的 openid 转给 yuzu（发券在 yuzu）。
//   · 到期提醒（第三期 3a）：/v1/reminders 带会话转发；每隔一会儿向门店取待发的订阅消息、发、回报（src/gateway/reminders.ts）。
//   · 邀请好友（第三期 3b）：/v1/invites…；好友领取先用手机号快速验证的 code 换手机号，再转给 yuzu（与绑定一样）。
//   · 扫码点餐（第三期 3c）：/v1/food…；桌码的签名在 yuzu 核对（密钥不在网关），下单挂在顾客自己的手牌账单上。
//   · 预约（第三期 3d）：/v1/bookings…；可约时段、预约、取消都在 yuzu 算与办，网关只转发。
//   · 会员端提醒（RQ-014，主线 8.0.4 批量发券的会员端弹窗）：/v1/notices、/v1/notices/read 带会话转发，读写在 yuzu。
// 网关不存会员、余额、券、订单；yuzu 返回的错误文字面向顾客，原样转给小程序。

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MP_NOTICE_READ_MAX, MP_RECHARGE_ORDER_NO, MP_TABLE_CODE } from '@shared/mp';
import type { GatewayConfig } from './config';
import { ShowCache } from './cache';
import { RateLimiter } from './ratelimit';
import { sendDueReminders } from './reminders';
import { issueSession, verifySession } from './session';
import { UpstreamDown, type Upstream, type UpstreamResponse } from './upstream';
import { WechatError, type WechatClient } from './wechat';

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const OFFLINE = () => new GatewayError(503, 'STORE_OFFLINE', '门店系统连接中，请稍后再试');
const TOO_MANY = () => new GatewayError(429, 'RATE_LIMITED', '操作太频繁，请稍后再试');

function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) throw new GatewayError(400, 'BAD_REQUEST', r.error.issues[0]?.message ?? '请求格式不正确');
  return r.data;
}

const LoginInput = z.object({ code: z.string('缺少微信登录的 code').min(1, '缺少微信登录的 code').max(256) });
const BindInput = z.object({
  phoneCode: z.string('请先验证手机号').min(1, '请先验证手机号').max(256),
  clientKey: z.uuid('操作编号不正确'),
  // 点绑定时看到的绑定状态版本号（/v1/me 给的），原样转给门店系统比对
  bindVersion: z.number('请刷新小程序后再绑定').int('请刷新小程序后再绑定').min(0, '请刷新小程序后再绑定'),
});
const AbandonInput = z.object({ clientKey: z.uuid('操作编号不正确') });
const NoticeRead = z.object({ ids: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).min(1).max(MP_NOTICE_READ_MAX) });
const LedgerQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });
const FloorParams = z.object({ floor: z.string().regex(/^[A-Za-z0-9-]{1,10}$/, '楼层不正确') });
const SvgQuery = z.object({ b: z.coerce.number().int().positive('底图批次不正确') });
const IdParams = z.object({ id: z.coerce.number().int().positive('编号不正确') });
const RechargeNo = z.object({ no: z.string().regex(MP_RECHARGE_ORDER_NO, '充值单号不正确') });
const RechargeCreate = z.object({
  clientKey: z.uuid('操作编号不正确'),
  planId: z.number().int().positive().nullable().optional(),
  amount: z.number().int().positive().nullable().optional(),
  /** 顾客确认时看到的绑定状态版本号：门店系统比对，换绑过的拒绝 */
  bindVersion: z.number('请刷新充值页后再下单').int().min(0),
});
const RechargePreview = z.object({ amount: z.coerce.number('请填写金额').int('金额请填整元').positive('请填写金额') });
const CouponClaim = z.object({
  clientKey: z.uuid('操作编号不正确'),
  templateId: z.number('请选择要领的券').int().positive('请选择要领的券'),
  /** 顾客点领取时看到的绑定状态版本号：门店系统比对，换绑过的拒绝 */
  bindVersion: z.number('请刷新领券中心后再领').int().min(0),
});
/** 设一条到期提醒（第三期 3a）：顾客在微信的弹窗里同意以后；门店系统核对模板、绑定版本号与要提醒的东西 */
const ReminderConsent = z.object({
  clientKey: z.uuid('操作编号不正确'),
  kind: z.enum(['coupon', 'membership', 'grace', 'bonus', 'booking'], '提醒的种类不对'),
  couponCode: z.string().regex(/^[2-9A-HJ-NP-Z]{12}$/, '券码不对').optional(),
  bookingId: z.number().int().positive().optional(),
  targetDate: z.iso.date('到期日不对').optional(),
  templateId: z.string().regex(/^[A-Za-z0-9_-]{10,64}$/, '模板编号不对'),
  bindVersion: z.number('请刷新后再设提醒').int().min(0),
});
/** 邀请好友（第三期 3b）：发一个邀请码；好友领取（先用手机号快速验证的 code 换手机号，与绑定一样） */
const InviteCreate = z.object({ clientKey: z.uuid('操作编号不正确'), bindVersion: z.number('请刷新后再邀请').int().min(0) });
const InviteClaim = z.object({
  clientKey: z.uuid('操作编号不正确'),
  phoneCode: z.string().min(1, '请先验证手机号').max(256),
  name: z.string().trim().max(32, '姓名最多 32 个字').optional(),
  bindVersion: z.number('请刷新后再领取').int().min(0),
});
const INVITE_CODE = /^[2-9A-HJ-NP-Z]{10}$/;
/** 扫码点餐（第三期 3c）：扫到的桌码（签名在门店系统核对）；下单（门店系统核对可点的菜、价格、绑定版本号） */
const FoodQuery = z.object({ table: z.string().regex(MP_TABLE_CODE, '桌码不对，请重新扫桌上的码').optional() });
const FoodOrder = z.object({
  clientKey: z.uuid('操作编号不正确'),
  items: z
    .array(
      z.object({
        itemId: z.number('菜品不对').int('菜品不对').positive('菜品不对'),
        quantity: z.number('份数不对').int('份数不对').min(1, '份数至少为 1').max(20, '一单最多 20 份'),
        note: z.string().max(40, '口味备注最多 40 字').optional(),
      }),
      '请选择菜品',
    )
    .min(1, '请至少选一道菜')
    .max(20, '一单最多 20 份'),
  table: z.string().regex(MP_TABLE_CODE, '桌码不对，请重新扫桌上的码').optional(),
  expectedTotal: z.number('请刷新后再下单').int().nonnegative(),
  bindVersion: z.number('请刷新后再下单').int().min(0),
});
/** 预约（第三期 3d）：可约时段的查询、预约、取消（门店系统核对可约的、时段、绑定版本号） */
const BookingSlotQuery = z.object({
  kind: z.enum(['technician', 'space'], '请选择预约什么'),
  date: z.iso.date('日期不对'),
  itemId: z.coerce.number().int().positive().optional(),
  spaceId: z.coerce.number().int().positive().optional(),
  durationMinutes: z.coerce.number().int().min(30).max(720).optional(),
});
const BookingCreate = z.object({
  clientKey: z.uuid('操作编号不正确'),
  kind: z.enum(['technician', 'space'], '请选择预约什么'),
  itemId: z.number().int().positive().optional(),
  technicianId: z.number().int().positive().nullable().optional(),
  spaceId: z.number().int().positive().optional(),
  startsAt: z.iso.datetime({ offset: true, message: '请选择时段' }),
  durationMinutes: z.number().int().min(30).max(720).optional(),
  guests: z.number().int().min(1).max(30).optional(),
  note: z.string().max(100, '备注最多 100 字').optional(),
  bindVersion: z.number('请刷新后再预约').int().min(0),
});
const BookingCancel = z.object({ clientKey: z.uuid('操作编号不正确'), bindVersion: z.number('请刷新后再取消').int().min(0) });
const BookingId = z.object({ id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
/** 微信支付的到账通知：报文主体原样转（门店系统要用原文验签），最多 8 KB */
const NOTIFY_MAX_BYTES = 8 * 1024;

export interface GatewayDeps {
  config: GatewayConfig;
  wechat: WechatClient;
  upstream: Upstream;
  cache?: ShowCache;
  /** 到期提醒多少毫秒取一次（不给按配置；测试给 0 不开，直接调 sendDueReminders） */
  reminderMs?: number;
}

export async function buildGateway(deps: GatewayDeps): Promise<FastifyInstance> {
  const { config, wechat, upstream } = deps;
  const cache = deps.cache ?? new ShowCache();
  const app = Fastify({
    logger: { level: config.logLevel, redact: ['req.headers.authorization'] },
    bodyLimit: 8 * 1024,
    trustProxy: config.trustProxy,
  });
  const perIp = new RateLimiter(240);
  const loginLimit = new RateLimiter(20);
  const bindLimit = new RateLimiter(10);
  const codeLimit = new RateLimiter(60);
  // 线上充值：建单、继续支付、取消、作废每个微信每分钟 20 次；查单（付完等结果每 2 秒一次）每分钟 60 次
  const rechargeLimit = new RateLimiter(20);
  const rechargeQueryLimit = new RateLimiter(60);
  // 线上领券：领取、确认作废每个微信每分钟 20 次（不限领的券也一样，MP_COUPONS.md 第 2 节）
  const couponLimit = new RateLimiter(20);
  // 会员端提醒记已读（RQ-014）：一次最多 20 条，首页每次打开最多记一次，留足重试的余量
  const noticeLimit = new RateLimiter(30);
  // 到期提醒：设提醒每个微信每分钟 20 次
  const reminderLimit = new RateLimiter(20);
  // 邀请好友：发起、收回每个微信每分钟 20 次；领取要验证手机号，与绑定一样每分钟 10 次
  const inviteLimit = new RateLimiter(20);
  // 扫码点餐：下单、确认作废每个微信每分钟 20 次
  const foodLimit = new RateLimiter(20);
  // 预约：预约、取消、确认作废每个微信每分钟 20 次；查时段每分钟 60 次（换日子、换项目都要查）
  const bookingLimit = new RateLimiter(20);
  const slotLimit = new RateLimiter(60);

  app.addHook('onRequest', async (req) => {
    if (!perIp.take(`ip:${req.ip}`)) throw TOO_MANY();
  });
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    return payload;
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof GatewayError) {
      reply.status(error.status).send({ error: { code: error.code, message: error.message } });
      return;
    }
    const e = error as { statusCode?: number };
    if (e.statusCode && e.statusCode < 500) {
      reply.status(e.statusCode).send({ error: { code: 'BAD_REQUEST', message: '请求格式不正确' } });
      return;
    }
    req.log.error({ err: error }, '网关未处理的错误');
    reply.status(500).send({ error: { code: 'INTERNAL', message: '网络出了点问题，请稍后再试' } });
  });
  app.setNotFoundHandler((_req, reply) => {
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: '接口不存在' } });
  });

  const relay = (reply: FastifyReply, r: UpstreamResponse, cacheState?: 'fresh' | 'stale' | 'miss', fetchedAt?: number) => {
    reply.status(r.status).header('content-type', r.contentType);
    if (cacheState) reply.header('x-cache', cacheState);
    // 这份内容是什么时候从门店取到的：给旧的时小程序照这个算还能用多久（最多 7 天），不重新计时
    if (fetchedAt) reply.header('x-fetched-at', new Date(fetchedAt).toISOString());
    if (r.status === 200 && r.cacheControl) reply.header('cache-control', r.cacheControl);
    return reply.send(r.body);
  };

  /** 展示内容：新鲜的直接给；过期了去 yuzu 取；连不上时给旧的，没有旧的就提示门店系统连接中 */
  const show = async (reply: FastifyReply, key: string, path: string, freshMs: number) => {
    const hit = cache.get(key);
    if (hit?.fresh) return relay(reply, hit.value, 'fresh', hit.fetchedAt);
    let r: UpstreamResponse;
    try {
      r = await upstream.call('GET', path);
    } catch (error) {
      if (!(error instanceof UpstreamDown)) throw error;
      if (hit) return relay(reply, hit.value, 'stale', hit.fetchedAt);
      throw OFFLINE();
    }
    const now = Date.now();
    if (r.status === 200) cache.set(key, r, freshMs, undefined, now);
    return relay(reply, r, 'miss', r.status === 200 ? now : undefined);
  };

  const openidOf = (req: FastifyRequest): string => {
    const h = req.headers.authorization;
    const openid = h?.startsWith('Bearer ') ? verifySession(config.sessionSecret, h.slice(7)) : null;
    if (!openid) throw new GatewayError(401, 'SESSION_REQUIRED', '请重新打开小程序登录');
    return openid;
  };

  const member = async (reply: FastifyReply, method: 'GET' | 'POST', path: string, openid: string, body?: unknown) => {
    try {
      return relay(reply, await upstream.call(method, path, { openid, body }));
    } catch (error) {
      if (error instanceof UpstreamDown) throw OFFLINE();
      throw error;
    }
  };

  // 门店连没连上：10 秒内问过就用上次的；正在问的时候后来的请求等同一个结果，门店连不上时不会每个请求各等一次超时
  let health = { online: false, at: 0 };
  let probing: Promise<boolean> | null = null;
  const storeOnline = (): Promise<boolean> => {
    if (Date.now() - health.at < 10_000) return Promise.resolve(health.online);
    probing ??= (async () => {
      let online = false;
      try {
        online = (await upstream.call('GET', '/api/mp/health')).status === 200;
      } catch {
        online = false;
      }
      health = { online, at: Date.now() };
      return online;
    })().finally(() => {
      probing = null;
    });
    return probing;
  };

  app.get('/v1/health', async () => ({ ok: true, mockWechat: wechat.mock, store: (await storeOnline()) ? 'online' : 'offline' }));
  // 网关进程本身活着没有（容器的健康检查用）：不问门店，门店断外网时网关照样算健康
  app.get('/v1/live', async () => ({ ok: true }));

  app.post('/v1/login', async (req) => {
    if (!loginLimit.take(`login:${req.ip}`)) throw TOO_MANY();
    const { code } = parse(LoginInput, req.body);
    try {
      const { openid } = await wechat.login(code);
      return issueSession(config.sessionSecret, openid, config.sessionDays);
    } catch (error) {
      if (error instanceof WechatError) throw new GatewayError(400, error.code, error.message);
      throw error;
    }
  });

  app.get('/v1/home', async (_req, reply) => show(reply, 'home', '/api/mp/home', 60_000));
  app.get('/v1/prices', async (_req, reply) => show(reply, 'prices', '/api/mp/prices', 300_000));
  app.get('/v1/guide', async (_req, reply) => show(reply, 'guide', '/api/mp/guide', 300_000));
  app.get('/v1/guide/floors/:floor/svg', async (req, reply) => {
    const { floor } = parse(FloorParams, req.params);
    const { b } = parse(SvgQuery, req.query);
    return show(reply, `svg:${b}:${floor}`, `/api/mp/guide/floors/${floor}/svg?b=${b}`, 86_400_000);
  });
  app.get('/v1/images/:id', async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    return show(reply, `img:${id}`, `/api/mp/images/${id}`, 30 * 86_400_000);
  });

  app.post('/v1/bind', async (req, reply) => {
    const openid = openidOf(req);
    if (!bindLimit.take(`bind:${openid}`)) throw TOO_MANY();
    const { phoneCode, clientKey, bindVersion } = parse(BindInput, req.body);
    let phone: string;
    try {
      ({ phone } = await wechat.phoneNumber(phoneCode));
    } catch (error) {
      if (error instanceof WechatError) throw new GatewayError(400, error.code, error.message);
      throw error;
    }
    return member(reply, 'POST', '/api/mp/bind', openid, { clientKey, phone, mock: wechat.mock, bindVersion });
  });
  // 绑定结果不确定（超时、断网、门店出错）时，小程序请门店系统作废这个编号：已经绑上了返回绑定的结果
  app.post('/v1/bind/abandon', async (req, reply) => {
    const openid = openidOf(req);
    if (!bindLimit.take(`bind:${openid}`)) throw TOO_MANY();
    const { clientKey } = parse(AbandonInput, req.body);
    return member(reply, 'POST', '/api/mp/bind/abandon', openid, { clientKey });
  });
  app.get('/v1/me', async (req, reply) => member(reply, 'GET', '/api/mp/me', openidOf(req)));
  app.get('/v1/ledger', async (req, reply) => {
    const openid = openidOf(req);
    const { limit } = parse(LedgerQuery, req.query);
    return member(reply, 'GET', `/api/mp/ledger?limit=${limit}`, openid);
  });
  app.get('/v1/coupons', async (req, reply) => member(reply, 'GET', '/api/mp/coupons', openidOf(req)));
  app.get('/v1/benefits', async (req, reply) => member(reply, 'GET', '/api/mp/benefits', openidOf(req)));
  // 会员端提醒（RQ-014）：首页弹的提醒、看过记已读（只记这个微信此刻绑定的会员自己的）
  app.get('/v1/notices', async (req, reply) => member(reply, 'GET', '/api/mp/notices', openidOf(req)));
  app.post('/v1/notices/read', async (req, reply) => {
    const openid = openidOf(req);
    if (!noticeLimit.take(`notice:${openid}`)) throw TOO_MANY();
    return member(reply, 'POST', '/api/mp/notices/read', openid, parse(NoticeRead, req.body));
  });
  app.post('/v1/code', async (req, reply) => {
    const openid = openidOf(req);
    if (!codeLimit.take(`code:${openid}`)) throw TOO_MANY();
    return member(reply, 'POST', '/api/mp/code', openid, {});
  });

  // ── 线上充值（第二期 2a）──
  const rechargeWrite = (req: FastifyRequest) => {
    const openid = openidOf(req);
    if (!rechargeLimit.take(`recharge:${openid}`)) throw TOO_MANY();
    return openid;
  };
  app.get('/v1/recharge', async (req, reply) => member(reply, 'GET', '/api/mp/recharge', openidOf(req)));
  app.get('/v1/recharge/preview', async (req, reply) => {
    const openid = openidOf(req);
    if (!rechargeQueryLimit.take(`recharge-q:${openid}`)) throw TOO_MANY();
    const { amount } = parse(RechargePreview, req.query);
    return member(reply, 'GET', `/api/mp/recharge/preview?amount=${amount}`, openid);
  });
  app.post('/v1/recharge/orders', async (req, reply) => {
    const openid = rechargeWrite(req);
    return member(reply, 'POST', '/api/mp/recharge/orders', openid, parse(RechargeCreate, req.body));
  });
  // 建单结果不确定（超时、断网、门店出错）时，小程序请门店系统作废这个编号：已经建了返回那张单
  app.post('/v1/recharge/abandon', async (req, reply) => {
    const openid = rechargeWrite(req);
    return member(reply, 'POST', '/api/mp/recharge/abandon', openid, parse(AbandonInput, req.body));
  });
  app.get('/v1/recharge/orders/:no', async (req, reply) => {
    const openid = openidOf(req);
    if (!rechargeQueryLimit.take(`recharge-q:${openid}`)) throw TOO_MANY();
    return member(reply, 'GET', `/api/mp/recharge/orders/${parse(RechargeNo, req.params).no}`, openid);
  });
  for (const action of ['pay', 'cancel', 'mock-pay'] as const) {
    app.post(`/v1/recharge/orders/:no/${action}`, async (req, reply) => {
      // 模拟支付只在模拟微信的网关上有（本机与测试服的演示库）；门店系统另外只在 development、test 认
      if (action === 'mock-pay' && !wechat.mock) throw new GatewayError(404, 'NOT_FOUND', '接口不存在');
      const openid = rechargeWrite(req);
      return member(reply, 'POST', `/api/mp/recharge/orders/${parse(RechargeNo, req.params).no}/${action}`, openid, {});
    });
  }

  // ── 线上领券（第二期 2c）──
  app.get('/v1/coupon-center', async (req, reply) => member(reply, 'GET', '/api/mp/coupon-center', openidOf(req)));
  app.post('/v1/coupon-claims', async (req, reply) => {
    const openid = openidOf(req);
    if (!couponLimit.take(`coupon:${openid}`)) throw TOO_MANY();
    return member(reply, 'POST', '/api/mp/coupon-claims', openid, parse(CouponClaim, req.body));
  });
  // 领取结果不确定（超时、断网、门店出错）时，小程序请门店系统作废这个编号：已经领到了返回那一张
  app.post('/v1/coupon-claims/abandon', async (req, reply) => {
    const openid = openidOf(req);
    if (!couponLimit.take(`coupon:${openid}`)) throw TOO_MANY();
    return member(reply, 'POST', '/api/mp/coupon-claims/abandon', openid, parse(AbandonInput, req.body));
  });

  // 邀请好友（第三期 3b）：邀请人看、发、收回；好友看、领取（网关换手机号）、确认作废
  const inviteCode = (req: FastifyRequest) => {
    const code = (req.params as { code?: string }).code ?? '';
    if (!INVITE_CODE.test(code)) throw new GatewayError(404, 'NOT_FOUND', '邀请不存在');
    return code;
  };
  app.get('/v1/invites', async (req, reply) => member(reply, 'GET', '/api/mp/invites', openidOf(req)));
  app.post('/v1/invites', async (req, reply) => {
    const openid = openidOf(req);
    if (!inviteLimit.take(`invite:${openid}`)) throw TOO_MANY();
    return member(reply, 'POST', '/api/mp/invites', openid, parse(InviteCreate, req.body));
  });
  app.post('/v1/invites/claim/abandon', async (req, reply) => {
    const openid = openidOf(req);
    if (!bindLimit.take(`bind:${openid}`)) throw TOO_MANY();
    return member(reply, 'POST', '/api/mp/invites/claim/abandon', openid, parse(AbandonInput, req.body));
  });
  app.get('/v1/invites/:code', async (req, reply) => {
    const openid = openidOf(req);
    return member(reply, 'GET', `/api/mp/invites/${inviteCode(req)}`, openid);
  });
  app.post('/v1/invites/:code/revoke', async (req, reply) => {
    const openid = openidOf(req);
    if (!inviteLimit.take(`invite:${openid}`)) throw TOO_MANY();
    return member(reply, 'POST', `/api/mp/invites/${inviteCode(req)}/revoke`, openid, {});
  });
  app.post('/v1/invites/:code/claim', async (req, reply) => {
    const openid = openidOf(req);
    const code = inviteCode(req);
    if (!bindLimit.take(`bind:${openid}`)) throw TOO_MANY();
    const { phoneCode, clientKey, name, bindVersion } = parse(InviteClaim, req.body);
    let phone: string;
    try {
      ({ phone } = await wechat.phoneNumber(phoneCode));
    } catch (error) {
      if (error instanceof WechatError) throw new GatewayError(400, error.code, error.message);
      throw error;
    }
    return member(reply, 'POST', `/api/mp/invites/${code}/claim`, openid, { clientKey, phone, ...(name ? { name } : {}), bindVersion, mock: wechat.mock });
  });

  // 扫码点餐（第三期 3c）：点餐页（扫到的桌码带上）、下单、结果不确定时确认作废、我的账单
  app.get('/v1/food/menu', async (req, reply) => {
    const openid = openidOf(req);
    const { table } = parse(FoodQuery, req.query);
    return member(reply, 'GET', `/api/mp/food/menu${table ? `?table=${table}` : ''}`, openid);
  });
  app.post('/v1/food/orders', async (req, reply) => {
    const openid = openidOf(req);
    if (!foodLimit.take(`food:${openid}`)) throw TOO_MANY();
    return member(reply, 'POST', '/api/mp/food/orders', openid, parse(FoodOrder, req.body));
  });
  app.post('/v1/food/orders/abandon', async (req, reply) => {
    const openid = openidOf(req);
    if (!foodLimit.take(`food:${openid}`)) throw TOO_MANY();
    return member(reply, 'POST', '/api/mp/food/orders/abandon', openid, parse(AbandonInput, req.body));
  });
  app.get('/v1/food/bill', async (req, reply) => member(reply, 'GET', '/api/mp/food/bill', openidOf(req)));

  // 预约（第三期 3d）：预约页与我的预约、可约时段、预约、结果不确定时确认作废、自己取消
  app.get('/v1/bookings', async (req, reply) => member(reply, 'GET', '/api/mp/bookings', openidOf(req)));
  app.get('/v1/bookings/slots', async (req, reply) => {
    const openid = openidOf(req);
    if (!slotLimit.take(`slot:${openid}`)) throw TOO_MANY();
    const q = parse(BookingSlotQuery, req.query);
    const qs = new URLSearchParams({ kind: q.kind, date: q.date });
    if (q.itemId !== undefined) qs.set('itemId', String(q.itemId));
    if (q.spaceId !== undefined) qs.set('spaceId', String(q.spaceId));
    if (q.durationMinutes !== undefined) qs.set('durationMinutes', String(q.durationMinutes));
    return member(reply, 'GET', `/api/mp/bookings/slots?${qs.toString()}`, openid);
  });
  app.post('/v1/bookings', async (req, reply) => {
    const openid = openidOf(req);
    if (!bookingLimit.take(`booking:${openid}`)) throw TOO_MANY();
    return member(reply, 'POST', '/api/mp/bookings', openid, parse(BookingCreate, req.body));
  });
  app.post('/v1/bookings/abandon', async (req, reply) => {
    const openid = openidOf(req);
    if (!bookingLimit.take(`booking:${openid}`)) throw TOO_MANY();
    return member(reply, 'POST', '/api/mp/bookings/abandon', openid, parse(AbandonInput, req.body));
  });
  app.post('/v1/bookings/:id/cancel', async (req, reply) => {
    const openid = openidOf(req);
    if (!bookingLimit.take(`booking:${openid}`)) throw TOO_MANY();
    const { id } = parse(BookingId, req.params);
    return member(reply, 'POST', `/api/mp/bookings/${id}/cancel`, openid, parse(BookingCancel, req.body));
  });

  // 到期提醒（第三期 3a）：能设哪几种、已经设了哪些；设一条（顾客在微信的弹窗里同意以后）
  app.get('/v1/reminders', async (req, reply) => member(reply, 'GET', '/api/mp/reminders', openidOf(req)));
  app.post('/v1/reminders', async (req, reply) => {
    const openid = openidOf(req);
    if (!reminderLimit.take(`reminder:${openid}`)) throw TOO_MANY();
    return member(reply, 'POST', '/api/mp/reminders', openid, parse(ReminderConsent, req.body));
  });

  // 微信支付的到账通知：不要会话、不解析内容，报文主体与四个签名头原样转给门店系统（Base64 包一层，一个字节不改）。
  // 门店收下了（入账、记成已付款待处理）回 204；门店没收下、连不上回失败，微信按它的节奏重发
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: NOTIFY_MAX_BYTES }, (_req, body, done) => done(null, body));
    scope.post('/v1/pay/notify', async (req, reply) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const h = (name: string) => {
        const v = req.headers[name];
        return typeof v === 'string' ? v : null;
      };
      const payload = {
        headers: { timestamp: h('wechatpay-timestamp'), nonce: h('wechatpay-nonce'), signature: h('wechatpay-signature'), serial: h('wechatpay-serial') },
        body: raw.toString('base64'),
      };
      let r: UpstreamResponse;
      try {
        r = await upstream.call('POST', '/api/mp/pay/notify', { body: payload });
      } catch (error) {
        if (!(error instanceof UpstreamDown)) throw error;
        req.log.warn('到账通知：门店系统连不上，回微信失败（微信会重发）');
        return reply.status(503).send({ code: 'FAIL', message: '门店系统连不上' });
      }
      if (r.status >= 200 && r.status < 300) return reply.status(204).send();
      req.log.warn({ status: r.status }, '到账通知：门店系统没收下');
      return reply.status(r.status >= 400 && r.status < 600 ? r.status : 500).send({ code: 'FAIL', message: '失败' });
    });
  });

  // 到期提醒的发送：每隔一会儿向门店取一批待发的消息、发、回报（上一轮没完不开下一轮）
  const reminderMs = deps.reminderMs ?? config.reminderSeconds * 1000;
  if (reminderMs > 0) {
    let timer: NodeJS.Timeout | undefined;
    let running = false;
    const memo = {};
    app.addHook('onReady', async () => {
      timer = setInterval(() => {
        if (running) return;
        running = true;
        sendDueReminders({ upstream, wechat, state: config.subscribeState, memo })
          .then((t) => {
            if (t && t.leased) {
              app.log.info(
                `到期提醒：取了 ${t.leased} 条，发出 ${t.sent}、没发出 ${t.failed}、再试 ${t.retry}（其中没轮到发 ${t.notStarted}）、结果不明 ${t.unknown}${t.reportLost ? '；回报没送到门店' : ''}`,
              );
            }
          })
          .catch((error: unknown) => app.log.error({ err: error }, '到期提醒发送出错，下一轮再试'))
          .finally(() => {
            running = false;
          });
      }, reminderMs);
    });
    app.addHook('onClose', async () => clearInterval(timer));
  }
  return app;
}
