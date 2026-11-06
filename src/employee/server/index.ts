import { buildEmployeeApp } from './app';
import { loadEmployeeConfig } from './config';
import { migrateEmployee } from './migrate';
import { createSql } from '../../server/db';

const config = loadEmployeeConfig();
const sql = createSql(config.databaseUrl);

async function main() {
  await migrateEmployee(sql);
  const app = await buildEmployeeApp(sql, config);
  await app.listen({ host: config.host, port: config.port });
  console.log(`员工服务已启动 ${config.host}:${config.port} (${config.instance} ${config.version} ${config.commit})`);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
    await sql.end({ timeout: 5 });
  };
  process.once('SIGTERM', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
}

main().catch(async (error: unknown) => {
  // 数据库错误可能包含连接信息，不把完整错误对象输出到启动日志。
  console.error(error instanceof Error ? `员工服务启动失败：${error.name}` : '员工服务启动失败');
  await sql.end({ timeout: 5 });
  process.exitCode = 1;
});
