import { buildApp } from './app';
import { purgeExpiredSessions } from './auth/session';
import { ensureInitialOwner } from './bootstrap';
import { loadConfig } from './config';
import { createSql } from './db';
import { migrate } from './migrate';
import { runMinuteJobs, type JobLog } from './jobs';
import { checkDevicesOnce, recoverJobs, resumeWaitingJobs } from './modules/devices';
import { ensureMembershipLive } from './modules/membership';
import { HEARTBEAT_INTERVAL_MS } from '@shared/devices';
import { holdAppPresence } from './presence';
import { buildMpApp } from './modules/mp/app';

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
  // 会员体系 v2 上线（v0.7.23，只做一次）：已有会员按累计充值（含旧系统累计）定档、进初阶，周期从今天起
  const live = await ensureMembershipLive({ sql, config });
  if (live) console.log(`会员体系 v2 上线：${live.graded} 位已有会员按累计充值定档（营业日 ${live.businessDate}）`);
  await ensureInitialOwner(sql, config, (msg) => console.log(msg));
  await purgeExpiredSessions(sql);

  const app = await buildApp(sql, config);
  // 硬件连接（v0.7.21）：开端口之前先处理上次进程留下的打印任务——还在发送的记失败、排队的接着打。
  // 开端口之后才处理的话，刚提交、正在发的新任务也会被当成上次留下的记失败（Codex 自动审查 9ca8a95）
  const deviceLog = (msg: string, err: unknown) => app.log.error({ err }, msg);
  await recoverJobs({ sql, config }, deviceLog).catch((error) => app.log.error({ err: error }, '打印任务恢复失败'));
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`浴族 yuzu 已启动：http://${config.host}:${config.port}（${config.env}）`);
  // 微信小程序（小程序线）：单开的小程序端口，只挂给网关的 /api/mp/*；没设 MP_PORT 不开
  const mpApp = config.mp.port ? await buildMpApp(sql, config) : null;
  if (mpApp) {
    await mpApp.listen({ host: config.mp.host, port: config.mp.port! });
    app.log.info(`小程序端口已开：${config.mp.host}:${config.mp.port}（只给网关）`);
  }

  // 每分钟的自动任务（赠金到期、会员到期处理、权益发放、生日礼、预约、会员挑战、次卡过期，见 jobs.ts）：
  // 启动时先跑一次，之后每分钟一次；生日礼每 10 分钟查一次
  let lastBirthday = 0;
  const jobLog: JobLog = { info: (msg) => app.log.info(msg), error: (msg, err) => app.log.error({ err }, msg) };
  const sweep = async () => {
    const birthday = Date.now() - lastBirthday >= 10 * 60_000;
    if (birthday) lastBirthday = Date.now();
    await runMinuteJobs({ sql, config }, jobLog, { birthday });
    // 顺带检查应用在跑的标记（数据库重启过、专用连接断了就重新拿）
    try {
      await presence.ensure();
    } catch (error) {
      app.log.error({ err: error }, '应用在跑的标记没拿到，下一分钟重试');
    }
  };
  await sweep();
  const sweeper = setInterval(() => void sweep(), 60_000);

  // 硬件连接（v0.7.21）：每 2 秒查一次设备（网口心跳、终端上报超时）；打印任务的恢复在开端口之前做过了。
  // 断网打印队列（v0.7.28）：每轮心跳之后，恢复在线的打印机把等它的单子改回排队补打，等太久的不再打
  let deviceCheck: Promise<void> | null = null;
  const deviceTimer = setInterval(() => {
    if (deviceCheck) return;
    deviceCheck = checkDevicesOnce({ sql })
      .then(() => resumeWaitingJobs({ sql, config }, { log: deviceLog }))
      .then(() => undefined)
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
    await mpApp?.close();
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
