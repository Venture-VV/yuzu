// 小程序网关（小程序线，docs/MINIPROGRAM.md 第 1、12 节）：小程序只连这里（公网 HTTPS，备案域名），网关经 Tailscale 只连 yuzu 的小程序端口。
//   · 登录：wx.login 的 code 换 openid，发网关会话（7 天，只有 openid，MP11）；
//   · 展示内容（门店信息、价目、导览、图片）：缓存，门店断外网时给旧的（最多 7 天）；
//   · 会员相关（绑定、会员卡、流水、券、会员码）：带会话里的 openid 原样转给 yuzu，门店连不上时 503 STORE_OFFLINE；
//   · 绑定：先用手机号快速验证的 code 换手机号，再转给 yuzu（手机号对上会员才绑）；结果不确定时小程序经 /v1/bind/abandon 确认作废。
// 网关不存会员、余额、券、订单；yuzu 返回的错误文字面向顾客，原样转给小程序。

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { GatewayConfig } from './config';
import { ShowCache } from './cache';
import { RateLimiter } from './ratelimit';
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
});
const AbandonInput = z.object({ clientKey: z.uuid('操作编号不正确') });
const LedgerQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });
const FloorParams = z.object({ floor: z.string().regex(/^[A-Za-z0-9-]{1,10}$/, '楼层不正确') });
const SvgQuery = z.object({ b: z.coerce.number().int().positive('底图批次不正确') });
const IdParams = z.object({ id: z.coerce.number().int().positive('编号不正确') });

export interface GatewayDeps {
  config: GatewayConfig;
  wechat: WechatClient;
  upstream: Upstream;
  cache?: ShowCache;
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
    const { phoneCode, clientKey } = parse(BindInput, req.body);
    let phone: string;
    try {
      ({ phone } = await wechat.phoneNumber(phoneCode));
    } catch (error) {
      if (error instanceof WechatError) throw new GatewayError(400, error.code, error.message);
      throw error;
    }
    return member(reply, 'POST', '/api/mp/bind', openid, { clientKey, phone, mock: wechat.mock });
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
  app.post('/v1/code', async (req, reply) => {
    const openid = openidOf(req);
    if (!codeLimit.take(`code:${openid}`)) throw TOO_MANY();
    return member(reply, 'POST', '/api/mp/code', openid, {});
  });

  return app;
}
