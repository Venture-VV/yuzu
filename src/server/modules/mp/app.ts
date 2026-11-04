// 小程序端口（小程序线，docs/MINIPROGRAM.md 第 12 节）：单开的 Fastify 实例，只挂 /api/mp/*。
// 只认网关：每个请求都要带网关密钥（比对摘要，常量时间）。这个端口上没有员工会话、管理后台和静态页面，
// 员工用的端口（PORT）上也没有 /api/mp/*；Tailscale 只放行网关服务器到这个端口。

import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { MP_GATEWAY_HEADER } from '@shared/mp';
import type { AppConfig } from '../../config';
import type { Sql } from '../../db';
import { AppError } from '../../lib/errors';
import { loadPayRuntime, setActivePay, type PayRuntime } from './pay';
import { registerMpPublicRoutes } from './public';
import { sweepRechargeOrders } from './recharge';
import { registerMpRechargeRoutes } from './recharge-routes';
import { registerMpMemberRoutes } from './routes';

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

export interface MpAppOptions {
  /** 门店系统的微信支付（第二期）：不给就按环境变量建（没配为 null）；测试传模拟的 */
  pay?: PayRuntime | null;
  /** 补查、关单的间隔（毫秒，默认每分钟）；0 不开（测试里直接调 sweepRechargeOrders） */
  sweepMs?: number;
}

export async function buildMpApp(sql: Sql, config: AppConfig, opts: MpAppOptions = {}): Promise<FastifyInstance> {
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
  registerMpMemberRoutes(app, { sql, config });

  // 线上充值（第二期 2a）：微信支付的凭据只在门店 yuzu（MP17）；配错了不开线上充值、写日志，门店系统照常启动
  let pay: PayRuntime | null = null;
  if ('pay' in opts) {
    pay = opts.pay ?? null;
    setActivePay(pay);
  } else {
    try {
      pay = loadPayRuntime(process.env, config.env);
      setActivePay(pay);
      if (pay) app.log.info(pay.mode === 'mock' ? '线上充值用模拟微信支付（只在 development、test）' : `线上充值的微信支付已配好（商户号 ${pay.config.mchId}）`);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      setActivePay(null, why);
      app.log.error(`微信支付的配置不对，线上充值不开：${why}`);
    }
  }
  registerMpRechargeRoutes(app, { sql, config }, pay);
  const sweepMs = opts.sweepMs ?? 60_000;
  if (sweepMs > 0) {
    let timer: NodeJS.Timeout | undefined;
    let running = false;
    app.addHook('onReady', async () => {
      timer = setInterval(() => {
        if (running) return;
        running = true;
        sweepRechargeOrders({ sql, config }, pay)
          .then((r) => {
            if (r.errors) app.log.error(`线上充值单补查：${r.checked} 张里 ${r.errors} 张出错，下一分钟再查`);
          })
          .catch((error) => app.log.error({ err: error }, '线上充值单补查失败，下一分钟重试'))
          .finally(() => {
            running = false;
          });
      }, sweepMs);
    });
    app.addHook('onClose', async () => clearInterval(timer));
  }
  return app;
}
