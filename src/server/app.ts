import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from './config';
import type { Sql } from './db';
import { registerGrantRoutes } from './auth/grants';
import { registerAuthRoutes } from './auth/routes';
import { SESSION_COOKIE, resolveSession } from './auth/session';
import { AppError } from './lib/errors';
import type { Deps } from './lib/context';
import { registerAdminRoutes } from './modules/admin';
import { registerAuditRoutes } from './modules/audit';
import { registerCatalogRoutes } from './modules/catalog';
import { registerFrontdeskRoutes } from './modules/frontdesk/routes';
import { registerDocRoutes } from './modules/inventory/docs';
import { registerMasterRoutes } from './modules/inventory/master';
import { registerPayableRoutes } from './modules/inventory/payables';
import { registerPurchasingRoutes } from './modules/inventory/purchasing';
import { registerReportRoutes } from './modules/inventory/reports';
import { registerLedgerRoutes } from './modules/ledger';
import { registerMemberRoutes } from './modules/members';
import { registerOpeningRoutes } from './modules/opening';
import { registerPrintRoutes } from './modules/print';
import { registerShiftRoutes } from './modules/shifts';
import { registerDashboardRoutes } from './modules/dashboard';
import { registerDashboardReportRoutes } from './modules/reports';
import { registerSettingsRoutes } from './modules/settings';
import { registerSettlementRoutes } from './modules/settlement';
import { registerStaffRoutes } from './modules/staff';
import { registerTechnicianRoutes } from './modules/technicians';
import { registerClockroomRoutes } from './modules/clockroom';
import { registerCommissionRoutes } from './modules/commission';
import { registerWalletRoutes } from './modules/wallet';

function originHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null; // 例如 "null"，按跨站处理
  }
}

export async function buildApp(sql: Sql, config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: 64 * 1024,
  });
  const deps: Deps = { sql, config };

  await app.register(cookie);
  app.decorateRequest('actor', null as never);
  app.decorateRequest('hasSession', false);

  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    // 修改类请求必须来自本站页面（防止跨站请求伪造）
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin && originHost(origin) !== req.headers.host) {
        throw new AppError(403, 'BAD_ORIGIN', '请求来源不正确');
      }
    }
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      const actor = await resolveSession(sql, token, config.sessionTtlHours);
      if (actor) {
        req.actor = actor;
        req.hasSession = true;
      }
    }
  });

  // 浏览器按声明的类型解析响应，不猜测内容类型（测试服 E2E 报告）
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    return payload;
  });

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof AppError) {
      reply.status(error.status).send({ error: { code: error.code, message: error.message, details: error.details } });
      return;
    }
    const e = error as { statusCode?: number; code?: string; message: string };
    if (e.code === '23514' || e.code === '23503') {
      req.log.warn({ err: error }, '数据库约束拦截');
      reply.status(422).send({ error: { code: 'CONSTRAINT', message: '数据校验未通过，操作未生效，请核对后重试' } });
      return;
    }
    if (e.code === '55P03' || e.code === '57014') {
      // 等锁或执行超时：事务已回滚，操作没有生效
      req.log.warn({ err: error }, '记账等待超时');
      const what = req.url.startsWith('/api/inventory') || req.url.startsWith('/api/purchase') || req.url.startsWith('/api/payables')
        ? '相关物料或单据'
        : req.url.startsWith('/api/frontdesk')
          ? '这张手牌或账单'
          : '该会员';
      reply.status(409).send({ error: { code: 'BUSY', message: `${what}正在被其他终端操作，本次未生效，请稍后重试` } });
      return;
    }
    if (e.code === 'P0001') {
      req.log.warn({ err: error }, '只追加保护拦截');
      reply.status(409).send({ error: { code: 'IMMUTABLE', message: '已入账记录不可修改' } });
      return;
    }
    if (e.statusCode && e.statusCode < 500) {
      reply.status(e.statusCode).send({ error: { code: e.code ?? 'BAD_REQUEST', message: '请求格式不正确' } });
      return;
    }
    req.log.error({ err: error }, '未处理的错误');
    reply.status(500).send({ error: { code: 'INTERNAL', message: '服务器出了点问题，操作可能未完成，请通过单号或流水核对结果' } });
  });

  app.get('/api/health', async () => {
    await sql`SELECT 1`;
    return { ok: true, version: config.version, commit: config.commit, instance: config.instance, time: new Date().toISOString() };
  });

  registerAuthRoutes(app, deps);
  registerGrantRoutes(app, deps);
  registerMemberRoutes(app, deps);
  registerWalletRoutes(app, deps);
  registerOpeningRoutes(app, deps);
  registerShiftRoutes(app, deps);
  registerPrintRoutes(app, deps);
  registerDashboardRoutes(app, deps);
  registerDashboardReportRoutes(app, deps);
  registerLedgerRoutes(app, deps);
  registerSettlementRoutes(app, deps);
  registerStaffRoutes(app, deps);
  registerCatalogRoutes(app, deps);
  registerSettingsRoutes(app, deps);
  registerAuditRoutes(app, deps);
  registerAdminRoutes(app, deps);
  registerMasterRoutes(app, deps);
  registerDocRoutes(app, deps);
  registerReportRoutes(app, deps);
  registerPurchasingRoutes(app, deps);
  registerPayableRoutes(app, deps);
  registerFrontdeskRoutes(app, deps);
  registerTechnicianRoutes(app, deps);
  registerClockroomRoutes(app, deps);
  registerCommissionRoutes(app, deps);

  // 前端静态资源（构建产物），全部从本机提供，外网中断不影响使用。
  const staticDir = resolve(process.env.STATIC_DIR ?? 'dist/client');
  const hasClient = existsSync(resolve(staticDir, 'index.html'));
  if (hasClient) {
    await app.register(fastifyStatic, {
      root: staticDir,
      setHeaders(reply, path) {
        reply.header('cache-control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || !hasClient || req.method !== 'GET') {
      reply.status(404).send({ error: { code: 'NOT_FOUND', message: '接口不存在' } });
      return;
    }
    reply.header('cache-control', 'no-cache').sendFile('index.html');
  });

  return app;
}
