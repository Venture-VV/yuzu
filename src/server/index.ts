import { buildApp } from './app';
import { purgeExpiredSessions } from './auth/session';
import { ensureInitialOwner } from './bootstrap';
import { loadConfig } from './config';
import { createSql } from './db';
import { migrate } from './migrate';
import { sweepExpiredBonus } from './modules/bonus';
import { sweepBookings } from './modules/bookings';
import { issueBirthdayCoupons } from './modules/coupons';
import { checkDevicesOnce, recoverJobs } from './modules/devices';
import { ensureMembershipLive, runMembershipDaily } from './modules/membership';
import { runBenefitsDaily } from './modules/benefits';
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

  // 赠金到期作废：启动时先扫描一次，之后每分钟一次（会员记账、打开会员详情时也会先处理这位会员）
  let lastBirthday = 0;
  const sweep = async () => {
    try {
      const n = await sweepExpiredBonus({ sql, config });
      if (n > 0) app.log.info(`赠金到期作废：${n} 位会员`);
    } catch (error) {
      app.log.error({ err: error }, '赠金到期作废扫描失败，下一分钟重试');
    }
    // 会员到期处理（v0.7.23）：营业日开始后处理周期、补充期已结束的会员（今天跑过、没有到期的就什么都不做）。
    // 放在生日礼之前：生日礼按会员现在的档阶发，到期该降的先降，不按过期的档阶发（Codex 自动审查 43d53e9）
    try {
      const run = await runMembershipDaily({ sql, config });
      if (run?.processed) app.log.info(`会员到期处理：${run.processed} 位（保级 ${run.retained}、进补充期 ${run.grace}、降档 ${run.downgraded}）`);
      if (run?.trialsExpired) app.log.info(`临时身份到期：${run.trialsExpired} 位`);
      if (run?.error) app.log.error(`会员到期处理有出错的：${run.error}`);
    } catch (error) {
      app.log.error({ err: error }, '会员到期处理失败，下一分钟重试');
    }
    // 会员权益（v0.7.24）：到期处理之后按新的档阶发本期的券类、生日礼、节日关怀（今天跑过、权益清单没改过就什么都不做）
    try {
      const run = await runBenefitsDaily({ sql, config });
      if (run?.coupons) app.log.info(`会员权益自动发放：${run.processed} 位会员、${run.coupons} 张券`);
      if (run?.error) app.log.error(`会员权益自动发放有出错的：${run.error}`);
    } catch (error) {
      app.log.error({ err: error }, '会员权益自动发放失败，下一分钟重试');
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
    // 预约（v0.7.28）：小程序预约开始前还没确认的自动取消、过了时间没到店的记爽约、客房过了保留时间释放
    try {
      const run = await sweepBookings(sql);
      if (run.cancelled || run.noShow) app.log.info(`预约：自动取消 ${run.cancelled} 张、记爽约 ${run.noShow} 张`);
    } catch (error) {
      app.log.error({ err: error }, '预约的自动处理失败，下一分钟重试');
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
