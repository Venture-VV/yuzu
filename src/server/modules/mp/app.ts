// 小程序端口（小程序线，docs/MINIPROGRAM.md 第 12 节）：单开的 Fastify 实例，只挂 /api/mp/*。
// 只认网关：每个请求都要带网关密钥（比对摘要，常量时间）。这个端口上没有员工会话、管理后台和静态页面，
// 员工用的端口（PORT）上也没有 /api/mp/*；Tailscale 只放行网关服务器到这个端口。

import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { MP_GATEWAY_HEADER } from '@shared/mp';
import type { AppConfig } from '../../config';
import type { Sql } from '../../db';
import { AppError } from '../../lib/errors';
import { registerMpPublicRoutes } from './public';

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

export async function buildMpApp(sql: Sql, config: AppConfig): Promise<FastifyInstance> {
  const key = config.mp.gatewayKey;
  if (!key || key.length < 32) throw new Error('小程序端口没有配网关密钥（MP_GATEWAY_KEY，至少 32 个字符），不开');
  const expected = digest(key);
  const app = Fastify({ logger: { level: config.logLevel }, bodyLimit: 16 * 1024 });

  app.addHook('onRequest', async (req) => {
    const got = req.headers[MP_GATEWAY_HEADER];
    // 先各自取摘要再比：长度不同也不提前返回
    if (typeof got !== 'string' || !timingSafeEqual(digest(got), expected)) {
      throw new AppError(401, 'MP_GATEWAY_REJECTED', '请求来源不正确');
    }
  });
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    return payload;
  });

  // 错误文字网关会原样转给小程序，面向顾客；不带内部细节
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof AppError) {
      reply.status(error.status).send({ error: { code: error.code, message: error.message } });
      return;
    }
    const e = error as { statusCode?: number };
    if (e.statusCode && e.statusCode < 500) {
      reply.status(e.statusCode).send({ error: { code: 'BAD_REQUEST', message: '请求格式不正确' } });
      return;
    }
    req.log.error({ err: error }, '小程序端口未处理的错误');
    reply.status(500).send({ error: { code: 'INTERNAL', message: '门店系统出了点问题，请稍后再试' } });
  });
  app.setNotFoundHandler((_req, reply) => {
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: '接口不存在' } });
  });

  registerMpPublicRoutes(app, { sql, config });
  return app;
}
