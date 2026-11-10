// 员工食堂 · 员工端口（docs/CANTEEN.md 第 3 节）：单开的 Fastify 实例，只挂柚子饭堂的页面与 /api/canteen/*。
//
// 公网入口是网关服务器上的 Caddy（HTTPS）经 Tailscale 转发到这里；这个端口上没有管理后台、没有别的接口，
// 员工端会话与系统账号的会话完全分开（Cookie 名、表都不同）。ERP 的「员工食堂」模块关着时，接口一律回「饭堂还没开张」。

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { canEditMenu, canScan, canUseMailbox, isLanHost, type CanteenMe } from '@shared/canteen';
import { businessDateOf } from '@shared/business-date';
import type { AppConfig } from '../../config';
import type { Sql } from '../../db';
import { AppError, forbidden, unauthorized } from '../../lib/errors';
import { isApiRequest, routePath } from '../../lib/paths';
import { idParam, parse } from '../../lib/validate';
import { enabledErpModules } from '../erp';
import { canteenToday, mealsThisMonth, myCheckins, recordCheckin, searchPeople, voidCheckin } from './checkins';
import { managerMailbox, managerMarkRead, managerReplyFeedback, myFeedback, submitFeedback, unreadFeedbackCount } from './feedback';
import { employeeCodeKey } from './code';
import { likeDish, listMenus, saveMenu } from './menus';
import { pushInfo, removePushSubscription, saveMutedMeals, savePushSubscription, sendTestPush } from './push';
import {
  AttemptLimiter,
  CANTEEN_COOKIE,
  CANTEEN_SESSION_DAYS,
  changeCanteenPassword,
  destroyCanteenSession,
  joinWithActivation,
  loginCanteen,
  lookupActivation,
  resolveCanteenSession,
  setCanteenAvatar,
  type CanteenSessionEmployee,
} from './portal-auth';
import { registerEmployee, registerInfo } from './registration';
import { loadCanteenSettings } from './settings';

declare module 'fastify' {
  interface FastifyRequest {
    canteenEmployee?: CanteenSessionEmployee;
    canteenToken?: string;
  }
}

/** 页面的安全头：只用本站的脚本；相机只给本站（负责人扫码） */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

const originHost = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
};

export interface CanteenAppOptions {
  /** 测试用：固定「此刻」 */
  clock?: () => number;
  /** 模块开关的缓存时间（毫秒，默认 3 秒；测试给 0） */
  openCacheMs?: number;
}

export async function buildCanteenApp(sql: Sql, config: AppConfig, opts: CanteenAppOptions = {}): Promise<FastifyInstance> {
  const secret = config.canteen.codeSecret;
  if (!secret || secret.length < 32) throw new Error('员工端口没有配饭卡码的密钥（CANTEEN_CODE_SECRET，至少 32 个字符），不开');
  const now = opts.clock ?? Date.now;
  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: 32 * 1024,
    trustProxy: config.canteen.trustProxy.length ? config.canteen.trustProxy : false,
  });
  await app.register(fastifyCookie);
  const limiter = new AttemptLimiter();
  /** 同一来源 IP 一小时最多登记 60 个账号（只记成功的，K14） */
  const registrations = new AttemptLimiter(60, 60 * 60_000);

  // 模块开关每个请求查一次太多，缓存 3 秒（店主关了模块，最多 3 秒后员工端就停）
  const cacheMs = opts.openCacheMs ?? 3000;
  let openCache: { at: number; open: boolean } | null = null;
  const canteenOpen = async () => {
    if (!openCache || Date.now() - openCache.at >= cacheMs) openCache = { at: Date.now(), open: (await enabledErpModules(sql)).has('canteen') };
    return openCache.open;
  };

  /**
   * 登录 Cookie 加不加 Secure：https 打开的（直接 TLS，或信任的转发服务器说是 https）都加；设了 CANTEEN_COOKIE_SECURE=true 时
   * 其余的也加，只有店里局域网用 http 打开的不加（K18：加了浏览器存不下，就登录不进去）。Cookie 按地址分开存，
   * 局域网地址上的 Cookie 不会带到外网的 https 地址上去。
   */
  const secureCookie = (req: FastifyRequest) => req.protocol === 'https' || (config.canteen.cookieSecure && !isLanHost(req.hostname));
  const setSession = (req: FastifyRequest, reply: FastifyReply, token: string) =>
    reply.setCookie(CANTEEN_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: secureCookie(req),
      path: '/',
      maxAge: CANTEEN_SESSION_DAYS * 86_400,
    });

  app.addHook('onRequest', async (req, reply) => {
    // 按解码后的路径认接口（/%61pi/… 与 /api/… 进的是同一个接口，见 lib/paths）
    if (!isApiRequest(req)) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin && originHost(origin) !== req.headers.host) throw new AppError(403, 'BAD_ORIGIN', '请求来源不正确');
    }
    if (routePath(req) === '/api/canteen/ping') return;
    if (!(await canteenOpen())) throw new AppError(503, 'CANTEEN_CLOSED', '饭堂还没开张：请管理员在 yuzu 的 ERP「模块设置」里打开「员工食堂」');
    const token = req.cookies[CANTEEN_COOKIE];
    if (token) {
      const found = await resolveCanteenSession(sql, token);
      if (found) {
        req.canteenEmployee = found.me;
        req.canteenToken = token;
        // 库里顺延了，浏览器的 Cookie 也顺延（用着就一直不用重新登录，K7）
        if (found.renewed) setSession(req, reply, token);
      }
    }
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    reply.header('permissions-policy', 'camera=(self), microphone=(), geolocation=()');
    const type = String(reply.getHeader('content-type') ?? '');
    if (type.startsWith('text/html')) reply.header('content-security-policy', CSP);
    if (type.startsWith('application/json')) reply.header('cache-control', 'no-store');
    return payload;
  });

  // 错误文字面向员工；不带内部细节
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof AppError) {
      reply.status(error.status).send({ error: { code: error.code, message: error.message, details: error.details } });
      return;
    }
    const e = error as { statusCode?: number; code?: string };
    if (e.code === '55P03' || e.code === '57014') {
      reply.status(409).send({ error: { code: 'BUSY', message: '饭堂这会儿有点忙，请再试一次' } });
      return;
    }
    if (e.statusCode && e.statusCode < 500) {
      reply.status(e.statusCode).send({ error: { code: 'BAD_REQUEST', message: '请求格式不正确' } });
      return;
    }
    req.log.error({ err: error }, '员工端口未处理的错误');
    reply.status(500).send({ error: { code: 'INTERNAL', message: '门店系统出了点问题，请稍后再试' } });
  });

  const meta = (req: FastifyRequest) => ({ ip: req.ip, userAgent: req.headers['user-agent'] });
  const who = (req: FastifyRequest): CanteenSessionEmployee => {
    if (!req.canteenEmployee) throw unauthorized('请先登录柚子饭堂');
    return req.canteenEmployee;
  };
  const manager = (req: FastifyRequest) => {
    const me = who(req);
    if (!canScan(me.role)) throw forbidden('只有食堂负责人能扫码打卡');
    return me;
  };
  const mailboxKeeper = (req: FastifyRequest) => {
    const me = who(req);
    if (!canUseMailbox(me.role)) throw forbidden('只有食堂负责人能看柚子信箱');
    return me;
  };

  const buildMe = async (employeeId: number): Promise<CanteenMe> => {
    const [e] = await sql<
      (Omit<CanteenMe['employee'], 'username' | 'source'> & { username: string | null; source: CanteenMe['employee']['source']; codeEpoch: number })[]
    >`
      SELECT e.id, e.emp_no, e.name, e.role, e.avatar, coalesce(d.name, '') AS department, e.code_epoch, e.username, e.source
      FROM canteen_employees e LEFT JOIN departments d ON d.id = e.department_id WHERE e.id = ${employeeId} AND e.active`;
    if (!e) throw unauthorized('请先登录柚子饭堂');
    const settings = await loadCanteenSettings(sql);
    const at = new Date(now());
    const today = businessDateOf(at, config.timezone, 0);
    return {
      employee: { id: e.id, empNo: e.empNo, name: e.name, department: e.department, role: e.role, avatar: e.avatar, username: e.username, source: e.source },
      codeKey: employeeCodeKey(secret, e.id, e.codeEpoch).toString('base64url'),
      codeEpoch: e.codeEpoch,
      serverTime: at.toISOString(),
      today,
      meals: settings.meals,
      mealsThisMonth: await mealsThisMonth(sql, e.id, today),
    };
  };

  // ── 不用登录 ──

  /** 连得上门店系统吗、饭堂开张没有（柚子饭堂判断在线用） */
  app.get('/api/canteen/ping', async () => ({ ok: true, open: await canteenOpen(), time: new Date(now()).toISOString() }));

  /** 开通、登录：同一来源 IP 失败太多次先拦下；只记失败（大家同一时间登录、或经同一个转发服务器来时不会互相挡住） */
  const limited = async <T>(req: FastifyRequest, fn: () => Promise<T>): Promise<T> => {
    const key = `ip:${req.ip}`;
    limiter.check(key);
    try {
      return await fn();
    } catch (error) {
      // 被限次挡下的（试太多次、这一会儿登记的人太多）不再算一次失败
      if (error instanceof AppError && error.status < 500 && error.code !== 'TOO_MANY_ATTEMPTS' && error.code !== 'TOO_MANY_REGISTRATIONS') limiter.fail(key);
      throw error;
    }
  };

  app.get('/api/canteen/join/:code', async (req) => limited(req, () => lookupActivation(sql, (req.params as { code: string }).code)));

  app.post('/api/canteen/join', async (req, reply) => {
    const { token, employeeId } = await limited(req, () => joinWithActivation(sql, req.body, meta(req)));
    setSession(req, reply, token);
    return buildMe(employeeId);
  });

  app.post('/api/canteen/login', async (req, reply) => {
    const { token, employeeId } = await limited(req, () => loginCanteen(sql, req.body, meta(req)));
    setSession(req, reply, token);
    return buildMe(employeeId);
  });

  /** 自己登记（第二期，K12–K14）：现在能不能登记（不要注册口令，店主 2026-11-07） */
  app.get('/api/canteen/register', async () => registerInfo(sql));

  app.post('/api/canteen/register', async (req, reply) => {
    const key = `ip:${req.ip}`;
    // 名额用完了也让「同一个手机号再登记、密码对」的进来（回复没收到时原样重试 = 登录，K14），只是不能开新账号
    let canCreate = true;
    try {
      registrations.check(key);
    } catch {
      canCreate = false;
    }
    // 能开新账号的先占一个名额（在等数据库之前，同时来的几个不会都挤过上限），没开成新账号的（出错、当作登录）再还回去
    const reservedAt = canCreate ? Date.now() : null;
    if (reservedAt !== null) registrations.fail(key, reservedAt);
    let created = false;
    try {
      const result = await limited(req, () => registerEmployee(sql, req.body, meta(req), { allowCreate: canCreate }));
      created = result.created;
      setSession(req, reply, result.token);
      return await buildMe(result.employeeId);
    } finally {
      if (reservedAt !== null && !created) registrations.release(key, reservedAt);
    }
  });

  app.post('/api/canteen/logout', async (req, reply) => {
    if (req.canteenToken) await destroyCanteenSession(sql, req.canteenToken);
    reply.clearCookie(CANTEEN_COOKIE, { path: '/' });
    return { ok: true };
  });

  // ── 员工 ──

  app.get('/api/canteen/me', async (req) => buildMe(who(req).id));

  app.put('/api/canteen/me/avatar', async (req) => ({ avatar: await setCanteenAvatar(sql, who(req), req.body) }));

  app.put('/api/canteen/me/password', async (req) => {
    const me = who(req);
    await changeCanteenPassword(sql, me, req.canteenToken!, req.body);
    return buildMe(me.id);
  });

  app.get('/api/canteen/me/meals', async (req) => myCheckins(sql, who(req).id, (req.query as { month?: string }).month));

  app.get('/api/canteen/menus', async (req) => {
    const me = who(req);
    const q = req.query as { from?: string; to?: string };
    return listMenus(sql, q.from, q.to, { drafts: canEditMenu(me.role), viewerId: me.id });
  });

  app.put('/api/canteen/likes', async (req) => likeDish(sql, who(req), req.body));

  /** 跟柚子说（第二期，K16）：自己说过的、发一条 */
  app.get('/api/canteen/feedback', async (req) => myFeedback(sql, who(req).id));
  app.post('/api/canteen/feedback', async (req) => submitFeedback(sql, who(req), req.body, config.timezone, now()));

  /** 饭点提醒（店主 2026-11-10，第 19 节，K23、K24）：这台手机打开、关掉提醒（退出登录时也关），选哪几顿，给自己发一条试试 */
  app.get('/api/canteen/push', async (req) => pushInfo(sql, who(req).id));
  app.put('/api/canteen/push/subscription', async (req) => savePushSubscription(sql, config, who(req).id, req.body, req.headers.origin));
  app.post('/api/canteen/push/off', async (req) =>
    removePushSubscription(sql, who(req).id, req.body, (req.body as { reason?: unknown } | null)?.reason === 'logout' ? 'logout' : 'off'),
  );
  app.put('/api/canteen/push/muted', async (req) => saveMutedMeals(sql, who(req).id, req.body));
  app.post('/api/canteen/push/test', async (req) => sendTestPush(sql, config, who(req).id, null, new Date(now())));

  // ── 厨师、负责人 ──

  app.put('/api/canteen/menus/:date/:meal', async (req) => {
    const me = who(req);
    if (!canEditMenu(me.role)) throw forbidden('只有厨师和食堂负责人能改菜单');
    const p = req.params as { date: string; meal: string };
    return saveMenu(sql, me, p.date, p.meal, req.body, config.timezone);
  });

  // ── 负责人 ──

  app.get('/api/canteen/today', async (req) => {
    manager(req);
    return canteenToday(sql, config, now());
  });

  app.get('/api/canteen/people', async (req) => {
    manager(req);
    return searchPeople(sql, config, (req.query as { q?: string }).q, now());
  });

  app.post('/api/canteen/checkins', async (req) => recordCheckin({ sql, config }, manager(req), req.body, now()));

  app.post('/api/canteen/checkins/:id/void', async (req) => {
    const me = manager(req);
    const { id } = parse(idParam, req.params);
    return voidCheckin(sql, id, req.body, { employee: me }, config.timezone);
  });

  // 柚子信箱（店主 2026-11-10，docs/CANTEEN.md 第 18 节，K20）：负责人在手机上看员工跟柚子说的话、标看过、回信，不用再开电脑
  app.get('/api/canteen/mailbox', async (req) => {
    mailboxKeeper(req);
    return managerMailbox(sql, req.query);
  });
  app.get('/api/canteen/mailbox/unread', async (req) => {
    mailboxKeeper(req);
    return { unread: await unreadFeedbackCount(sql) };
  });
  app.post('/api/canteen/mailbox/:id/read', async (req) => {
    const me = mailboxKeeper(req);
    const { id } = parse(idParam, req.params);
    return managerMarkRead(sql, id, me);
  });
  app.post('/api/canteen/mailbox/:id/reply', async (req) => {
    const me = mailboxKeeper(req);
    const { id } = parse(idParam, req.params);
    return managerReplyFeedback(sql, id, req.body, me, req.ip);
  });

  // ── 柚子饭堂的页面（构建产物） ──
  const staticDir = resolve(process.env.CANTEEN_STATIC_DIR ?? 'dist/canteen-app');
  const hasClient = existsSync(resolve(staticDir, 'index.html'));
  if (hasClient) {
    await app.register(fastifyStatic, {
      root: staticDir,
      preCompressed: true,
      setHeaders(reply, path) {
        reply.header('cache-control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }
  app.setNotFoundHandler((req, reply) => {
    if (isApiRequest(req) || !hasClient || req.method !== 'GET') {
      reply.status(404).send({ error: { code: 'NOT_FOUND', message: '接口不存在' } });
      return;
    }
    reply.header('cache-control', 'no-cache').type('text/html; charset=utf-8').sendFile('index.html');
  });

  return app;
}

/** 管理后台用：员工端口开着没有 */
export const canteenPortOpen = (config: AppConfig) => config.canteen.port !== null;

