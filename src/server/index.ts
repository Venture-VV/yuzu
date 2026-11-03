import { buildApp } from './app';
import { purgeExpiredSessions } from './auth/session';
import { ensureInitialOwner } from './bootstrap';
import { loadConfig } from './config';
import { createSql } from './db';
import { migrate } from './migrate';
import { sweepExpiredBonus } from './modules/bonus';
import { issueBirthdayCoupons } from './modules/coupons';
import { checkDevicesOnce, recoverJobs } from './modules/devices';
import { HEARTBEAT_INTERVAL_MS } from '@shared/devices';
import { holdAppPresence } from './presence';

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
  // 应用在跑的标记（v0.7.19）：专用连接上的共享咨询锁，demo-reset 看到它就不清库（应用空闲、连接池没有连接时也看得到）
  const presence = await holdAppPresence(config.databaseUrl);
  await migrate(sql, (msg) => console.log(msg));
  await ensureInitialOwner(sql, config, (msg) => console.log(msg));
  await purgeExpiredSessions(sql);

  const app = await buildApp(sql, config);
  // 硬件连接（v0.7.21）：开端口之前先处理上次进程留下的打印任务——还在发送的记失败、排队的接着打。
  // 开端口之后才处理的话，刚提交、正在发的新任务也会被当成上次留下的记失败（Codex 自动审查 9ca8a95）
  const deviceLog = (msg: string, err: unknown) => app.log.error({ err }, msg);
  await recoverJobs({ sql, config }, deviceLog).catch((error) => app.log.error({ err: error }, '打印任务恢复失败'));
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`浴族 yuzu 已启动：http://${config.host}:${config.port}（${config.env}）`);

  // 赠金到期作废：启动时先扫描一次，之后每分钟一次（会员记账、打开会员详情时也会先处理这位会员）
  let lastBirthday = 0;
  const sweep = async () => {
    try {
      const n = await sweepExpiredBonus({ sql, config });
      if (n > 0) app.log.info(`赠金到期作废：${n} 位会员`);
    } catch (error) {
      app.log.error({ err: error }, '赠金到期作废扫描失败，下一分钟重试');
    }
    // 生日礼（v0.7.20）：每 10 分钟检查一次生日当月还没发的会员（去重键兜底，几个进程同时跑也只发一次）
    if (Date.now() - lastBirthday >= 10 * 60_000) {
      lastBirthday = Date.now();
      try {
        const n = await issueBirthdayCoupons({ sql, config });
        if (n > 0) app.log.info(`生日礼：发给 ${n} 位会员`);
      } catch (error) {
        app.log.error({ err: error }, '生日礼发券失败，10 分钟后重试');
      }
    }
    // 顺带检查应用在跑的标记（数据库重启过、专用连接断了就重新拿）
    try {
      await presence.ensure();
    } catch (error) {
      app.log.error({ err: error }, '应用在跑的标记没拿到，下一分钟重试');
    }
  };
  await sweep();
  const sweeper = setInterval(() => void sweep(), 60_000);

  // 硬件连接（v0.7.21）：每 2 秒查一次设备（网口心跳、终端上报超时）；打印任务的恢复在开端口之前做过了
  let deviceCheck: Promise<void> | null = null;
  const deviceTimer = setInterval(() => {
    if (deviceCheck) return;
    deviceCheck = checkDevicesOnce({ sql })
      .catch((error) => app.log.error({ err: error }, '设备心跳失败，2 秒后重试'))
      .finally(() => {
        deviceCheck = null;
      });
  }, HEARTBEAT_INTERVAL_MS);

  const shutdown = async (signal: string) => {
    app.log.info(`收到 ${signal}，正在关闭…`);
    clearInterval(sweeper);
    clearInterval(deviceTimer);
    await app.close();
    await presence.release();
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
