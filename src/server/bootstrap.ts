import type { AppConfig } from './config';
import type { Sql } from './db';
import { checkPasswordStrength } from './auth/password';
import { createStaff } from './modules/staff';

/**
 * 首次启动且还没有任何员工时，按环境变量 INIT_OWNER_* 创建第一位店主。
 * 该店主首次登录后必须修改密码。
 */
export async function ensureInitialOwner(sql: Sql, config: AppConfig, log: (msg: string) => void): Promise<void> {
  const [row] = await sql<{ count: number }[]>`SELECT count(*) AS count FROM staff`;
  if (row && row.count > 0) return;
  if (!config.initOwner) {
    log('尚未创建任何员工账号。请设置 INIT_OWNER_USERNAME / INIT_OWNER_PASSWORD 后重启，或执行 create-owner 命令。');
    return;
  }
  const weak = checkPasswordStrength(config.initOwner.password);
  if (weak) {
    log(`INIT_OWNER_PASSWORD 不符合要求：${weak}，未创建店主账号。`);
    return;
  }
  await createStaff(sql, {
    username: config.initOwner.username.toLowerCase(),
    displayName: config.initOwner.displayName,
    role: 'owner',
    password: config.initOwner.password,
    mustChangePassword: true,
  });
  log(`已创建初始店主账号「${config.initOwner.username}」，首次登录后需修改密码。`);
}
