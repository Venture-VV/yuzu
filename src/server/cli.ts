// 运维命令行。容器内用法：docker compose exec app node dist/server/cli.js <命令>
//
//   migrate                               执行数据库迁移
//   create-owner <账号> [--name 姓名] [--password 密码]
//                                         创建店主账号（不填密码则生成临时密码，首次登录需修改）
//   reset-password <账号>                 重置密码为临时密码
//   seed-demo [--force]                   写入合成演示数据（正式环境默认禁止）
//   check                                 核对全部会员余额与流水是否一致

import { businessDateOf } from '@shared/business-date';
import { checkPasswordStrength, generateTempPassword, hashPassword } from './auth/password';
import { destroyStaffSessions } from './auth/session';
import { loadConfig } from './config';
import { createSql } from './db';
import { writeAudit } from './lib/audit';
import { migrate } from './migrate';
import { seedDemo, DEMO_PASSWORD } from './seed';
import { computeSettlement } from './modules/settlement';
import { loadSettings } from './modules/settings';
import { createStaff } from './modules/staff';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const config = loadConfig();
  const sql = createSql(config.databaseUrl, { max: 2 });
  try {
    switch (command) {
      case 'migrate': {
        const applied = await migrate(sql, console.log);
        console.log(applied.length ? `完成，共应用 ${applied.length} 个迁移。` : '数据库已是最新结构。');
        break;
      }
      case 'create-owner': {
        const username = args[0]?.toLowerCase();
        if (!username) throw new Error('用法：create-owner <账号> [--name 姓名] [--password 密码]');
        await migrate(sql);
        const password = flag(args, 'password') ?? generateTempPassword();
        const weak = checkPasswordStrength(password);
        if (weak) throw new Error(weak);
        const id = await createStaff(sql, {
          username,
          displayName: flag(args, 'name') ?? '店主',
          role: 'owner',
          password,
          mustChangePassword: true,
        });
        await writeAudit(sql, { staffId: null, action: 'staff_created', targetType: 'staff', targetId: id, detail: { username, via: 'cli' } });
        console.log(`已创建店主「${username}」，临时密码：${password}\n首次登录后需要修改密码。`);
        break;
      }
      case 'reset-password': {
        const username = args[0]?.toLowerCase();
        if (!username) throw new Error('用法：reset-password <账号>');
        const password = generateTempPassword();
        const rows = await sql<{ id: number }[]>`
          UPDATE staff SET password_hash = ${await hashPassword(password)}, must_change_password = true, active = true, updated_at = now()
          WHERE username = ${username} RETURNING id`;
        if (!rows[0]) throw new Error(`账号「${username}」不存在`);
        await destroyStaffSessions(sql, rows[0].id);
        await writeAudit(sql, { staffId: null, action: 'staff_password_reset', targetType: 'staff', targetId: rows[0].id, detail: { via: 'cli' } });
        console.log(`已重置「${username}」的密码，临时密码：${password}\n首次登录后需要修改密码。`);
        break;
      }
      case 'seed-demo': {
        await migrate(sql);
        const result = await seedDemo(sql, config, { force: args.includes('--force') });
        if (result.skipped) {
          console.log('已存在演示数据，跳过。');
        } else {
          console.log(`已写入演示数据：${result.members} 位合成会员。`);
          console.log(`演示账号：店主 ${result.owner} / 店员 ${result.clerk}，密码均为 ${DEMO_PASSWORD}`);
        }
        break;
      }
      case 'check': {
        const settings = await loadSettings(sql);
        const today = businessDateOf(new Date(), config.timezone, settings.businessDayStartHour);
        const summary = await computeSettlement(sql, today, today);
        for (const c of summary.checks) console.log(`${c.ok ? '✓' : '✗'} ${c.label}：${c.detail}`);
        if (summary.checks.some((c) => !c.ok)) process.exitCode = 1;
        break;
      }
      default:
        console.log('可用命令：migrate | create-owner <账号> | reset-password <账号> | seed-demo [--force] | check');
        process.exitCode = command ? 1 : 0;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
