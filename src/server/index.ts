import { buildApp } from './app';
import { purgeExpiredSessions } from './auth/session';
import { ensureInitialOwner } from './bootstrap';
import { loadConfig } from './config';
import { createSql } from './db';
import { migrate } from './migrate';
import { sweepExpiredBonus } from './modules/bonus';

const config = loadConfig();
const sql = createSql(config.databaseUrl);

async function waitForDatabase(retries = 30) {
  for (let i = 1; ; i++) {
    try {
      await sql`SELECT 1`;
      return;
    } catch (error) {
      if (i >= retries) throw error;
      console.log(`等待数据库就绪…（${i}/${retries}）`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function main() {
  await waitForDatabase();
  await migrate(sql, (msg) => console.log(msg));
  await ensureInitialOwner(sql, config, (msg) => console.log(msg));
  await purgeExpiredSessions(sql);

  const app = await buildApp(sql, config);
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`浴族 yuzu 已启动：http://${config.host}:${config.port}（${config.env}）`);

  // 赠金到期作废：启动时先扫描一次，之后每分钟一次（会员记账、打开会员详情时也会先处理这位会员）
  const sweep = async () => {
    try {
      const n = await sweepExpiredBonus({ sql, config });
      if (n > 0) app.log.info(`赠金到期作废：${n} 位会员`);
    } catch (error) {
      app.log.error({ err: error }, '赠金到期作废扫描失败，下一分钟重试');
    }
  };
  await sweep();
  const sweeper = setInterval(() => void sweep(), 60_000);

  const shutdown = async (signal: string) => {
    app.log.info(`收到 ${signal}，正在关闭…`);
    clearInterval(sweeper);
    await app.close();
    await sql.end({ timeout: 5 });
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch(async (error) => {
  console.error('启动失败：', error);
  await sql.end({ timeout: 1 }).catch(() => {});
  process.exit(1);
});
