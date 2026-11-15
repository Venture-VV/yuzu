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
import { buildCanteenApp } from './modules/canteen/portal';

const config = loadConfig();
// 事务开着不动超过 2 分钟由数据库断开、放掉行锁（8.1.3 WL11）
const sql = createSql(config.databaseUrl, { idleInTransactionMs: 120_000 });

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
  // 员工食堂 · 柚子饭堂（docs/CANTEEN.md）：单开的员工端口，只挂柚子饭堂的页面与 /api/canteen/*；没设 CANTEEN_PORT 不开
  const canteenApp = config.canteen.port ? await buildCanteenApp(sql, config) : null;
  if (canteenApp) {
    await canteenApp.listen({ host: config.canteen.host, port: config.canteen.port! });
    app.log.info(`员工端口（柚子饭堂）已开：${config.canteen.host}:${config.canteen.port}`);
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
  // CI 的升级自检等这一行再停应用（停在半路，会员到期处理等记录会停在「没跑完」）
  app.log.info('启动时的每分钟任务已跑完一轮');
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

  // 停机（8.1.3 WL11，照 close-with-grace 的做法）：收到停止信号或出现没接住的异常时，关端口、等正在处理的请求做完、断数据库，
  // 最多等 10 秒，到时间还没收完就直接退出（Docker 自动拉起）。没接住的异常写进日志、按出错退出
  let closing = false;
  const shutdown = async (reason: string, code: number) => {
    if (closing) return;
    closing = true;
    app.log.info(`收到 ${reason}，正在关闭…`);
    const force = setTimeout(() => {
      app.log.error(`${reason}：10 秒内没有收完，直接退出`);
      process.exit(code || 1);
    }, 10_000);
    force.unref();
    try {
      clearInterval(sweeper);
      clearInterval(deviceTimer);
      await app.close();
      await mpApp?.close();
      await canteenApp?.close();
      await presence.release();
      await sql.end({ timeout: 5 });
    } catch (error) {
      app.log.error({ err: error }, '关闭时出错');
    }
    process.exit(code);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.on('SIGINT', () => void shutdown('SIGINT', 0));
  process.on('uncaughtException', (error) => {
    app.log.fatal({ err: error }, '没接住的异常，收尾后退出');
    void shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (error) => {
    app.log.fatal({ err: error }, '没接住的 Promise 拒绝，收尾后退出');
    void shutdown('unhandledRejection', 1);
  });
}

main().catch(async (error) => {
  console.error('启动失败：', error);
  await sql.end({ timeout: 1 }).catch(() => {});
  process.exit(1);
});
