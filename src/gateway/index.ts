// 小程序网关的启动入口（小程序线）：node dist/gateway/index.js；配置见 src/gateway/config.ts 与 docs/MINIPROGRAM.md 第 6 节。

import { buildGateway } from './app';
import { loadGatewayConfig } from './config';
import { createUpstream } from './upstream';
import { createMockWechat, createWechat } from './wechat';

const config = loadGatewayConfig();
const wechat = config.mockWechat ? createMockWechat() : createWechat(config.wechat!.appId, config.wechat!.appSecret);
const app = await buildGateway({ config, wechat, upstream: createUpstream(config.upstreamUrl, config.gatewayKey) });
await app.listen({ host: config.host, port: config.port });
app.log.info(`小程序网关已启动：${config.host}:${config.port}${config.mockWechat ? '（模拟微信）' : ''}`);

const shutdown = async (signal: string) => {
  app.log.info(`收到 ${signal}，正在关闭…`);
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
