// 运维命令行。容器内用法：docker compose exec app node dist/server/cli.js <命令>
//
//   migrate                               执行数据库迁移
//   create-owner <账号> [--name 姓名] [--password 密码]
//                                         创建店主账号（不填密码则生成临时密码，首次登录需修改）
//   reset-password <账号>                 重置密码为临时密码
//   seed-demo [--force]                   写入合成演示数据（正式环境默认禁止）
//   seed-inventory-demo                   写入库存与采购合成演示数据（仅独立演示库；试用 / 正式环境与已有真实库存数据时拒绝）
//   seed-frontdesk-demo                   写入前台手牌与在店账单合成演示数据（仅独立演示库；试用 / 正式环境与已有真实手牌时拒绝）
//   import-hand-tags <清单.csv> | --store-list [--apply] [--deactivate-missing]
//                                         按清单导入手牌池（真实业务数据，默认只预览，加 --apply 才写入）；
//                                         --store-list 使用店主 2026-10-27 的 747 个真实柜号；--deactivate-missing 同时停用清单外的空闲手牌
//   import-price-list <价目表.csv> | --tangqi [--apply] [--deactivate-missing]
//                                         按价目表导入消费项目与多档价格（真实业务数据，默认只预览，加 --apply 才写入）；
//                                         --tangqi 使用店主 2026-10-27 的汤崎价目表；--deactivate-missing 同时停用清单外的项目
//   check                                 核对会员余额与流水、库存结存与库存流水、手牌账单与明细是否一致

import { readFile } from 'node:fs/promises';
import { businessDateOf } from '@shared/business-date';
import { ZONE_LABELS } from '@shared/frontdesk';
import { parseHandTagCsv } from '@shared/hand-tag-import';
import { parsePriceListCsv } from '@shared/price-list-import';
import { checkPasswordStrength, generateTempPassword, hashPassword } from './auth/password';
import { destroyStaffSessions } from './auth/session';
import { loadConfig } from './config';
import { createSql, readSnapshot } from './db';
import { writeAudit } from './lib/audit';
import { migrate } from './migrate';
import { seedDemo, DEMO_PASSWORD } from './seed';
import { seedInventoryDemo } from './seed-inventory';
import { seedFrontdeskDemo } from './seed-frontdesk';
import { STORE_HAND_TAGS_CSV } from './demo/hand-tags-2026-10-27';
import { TANGQI_PRICE_LIST_CSV } from './demo/price-list-tangqi-2026-10-27';
import { importPriceList } from './modules/catalog';
import { importHandTags } from './modules/frontdesk/tags';
import { frontdeskChecks } from './modules/frontdesk/checks';
import { inventoryChecks } from './modules/inventory/reports';
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
      case 'seed-inventory-demo': {
        await migrate(sql);
        const result = await seedInventoryDemo(sql, config);
        if (result.skipped) {
          console.log('已存在库存演示数据，跳过。');
        } else {
          console.log(`已写入库存演示数据：${result.materials} 项物料、${result.suppliers} 家供应商、${result.purchaseOrders} 张采购单、${result.docs} 张单据。`);
          console.log(`演示账号：店主 linlan / 物资经办 lixiao / 采购对账 zhouyi，密码均为 ${DEMO_PASSWORD}`);
        }
        break;
      }
      case 'seed-frontdesk-demo': {
        await migrate(sql);
        const result = await seedFrontdeskDemo(sql, config);
        if (result.skipped) {
          console.log('已存在前台演示数据，跳过。');
        } else {
          console.log(`已写入前台演示数据：${result.tags} 张手牌、${result.inStore} 位在店客人。预期结果见 src/server/demo/frontdesk-expected.json`);
          console.log(`演示账号：店主 linlan / 前台 xiaozhou / 值班经理 zhangjl，密码均为 ${DEMO_PASSWORD}`);
        }
        break;
      }
      case 'import-hand-tags': {
        const storeList = args.includes('--store-list');
        const file = args.find((a) => !a.startsWith('--'));
        if (!storeList && !file) throw new Error('用法：import-hand-tags <清单.csv> | --store-list [--apply] [--deactivate-missing]');
        await migrate(sql);
        const parsed = parseHandTagCsv(storeList ? STORE_HAND_TAGS_CSV : await readFile(file!, 'utf8'));
        if (parsed.errors.length) {
          for (const e of parsed.errors.slice(0, 20)) console.log(`✗ 第 ${e.line} 行：${e.message}`);
          throw new Error(`清单有 ${parsed.errors.length} 处需要修改，未导入`);
        }
        const apply = args.includes('--apply');
        const report = await importHandTags(
          sql,
          { rows: parsed.rows, deactivateMissing: args.includes('--deactivate-missing'), dryRun: !apply },
          { staffId: null, via: 'cli' },
        );
        console.log(`清单共 ${report.total} 个柜号：`);
        for (const g of report.groups) {
          console.log(`  ${ZONE_LABELS[g.zone].title} ${g.kind === 'vip' ? `VIP 第 ${g.vipLevel} 级` : `普通柜 ${g.area || ''} 区`}：${g.count}`);
        }
        console.log(`新建 ${report.created} · 更新 ${report.updated} · 未变 ${report.unchanged} · 停用清单外 ${report.deactivated}`);
        for (const b of report.blocked) console.log(`  未改动 ${b.code}：${b.reason}`);
        console.log(apply ? '✓ 已导入。' : '以上为预览，没有写入。确认无误后加 --apply 执行导入。');
        break;
      }
      case 'import-price-list': {
        const tangqi = args.includes('--tangqi');
        const file = args.find((a) => !a.startsWith('--'));
        if (!tangqi && !file) throw new Error('用法：import-price-list <价目表.csv> | --tangqi [--apply] [--deactivate-missing]');
        await migrate(sql);
        const parsed = parsePriceListCsv(tangqi ? TANGQI_PRICE_LIST_CSV : await readFile(file!, 'utf8'));
        if (parsed.errors.length) {
          for (const e of parsed.errors.slice(0, 20)) console.log(`✗ 第 ${e.line} 行：${e.message}`);
          throw new Error(`价目表有 ${parsed.errors.length} 处需要修改，未导入`);
        }
        const apply = args.includes('--apply');
        const report = await importPriceList(
          sql,
          { rows: parsed.rows, deactivateMissing: args.includes('--deactivate-missing'), dryRun: !apply },
          { staffId: null, via: 'cli' },
        );
        console.log(`价目表共 ${report.total} 个项目：`);
        for (const g of report.groups) console.log(`  ${g.category}：${g.count}`);
        console.log(`新建 ${report.created} · 更新 ${report.updated} · 未变 ${report.unchanged} · 停用清单外 ${report.deactivated}`);
        console.log(apply ? '✓ 已导入。' : '以上为预览，没有写入。确认无误后加 --apply 执行导入。');
        break;
      }
      case 'check': {
        const settings = await loadSettings(sql);
        const today = businessDateOf(new Date(), config.timezone, settings.businessDayStartHour);
        const summary = await readSnapshot(sql, (tx) => computeSettlement(tx, today, today));
        const inventory = await readSnapshot(sql, inventoryChecks);
        const frontdesk = await readSnapshot(sql, frontdeskChecks);
        const all = [...summary.checks, ...inventory, ...frontdesk];
        for (const c of all) console.log(`${c.ok ? '✓' : '✗'} ${c.label}：${c.detail}`);
        if (all.some((c) => !c.ok)) process.exitCode = 1;
        break;
      }
      default:
        console.log('可用命令：migrate | create-owner <账号> | reset-password <账号> | seed-demo [--force] | seed-inventory-demo | seed-frontdesk-demo | import-hand-tags | import-price-list | check');
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
