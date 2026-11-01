// 运维命令行。容器内用法：docker compose exec app node dist/server/cli.js <命令>
//
//   migrate                               执行数据库迁移
//   create-owner <账号> [--name 姓名] [--password 密码]
//                                         创建店主账号（不填密码则生成临时密码，首次登录需修改）
//   reset-password <账号>                 重置密码为临时密码
//   seed-demo [--force]                   写入合成演示数据（试用、正式环境禁止；--force 在已有演示数据时再写一遍）
//   seed-inventory-demo                   写入库存与采购合成演示数据（仅独立演示库；试用 / 正式环境与已有真实库存数据时拒绝）
//   seed-frontdesk-demo [--previous-day]  写入前台手牌与在店账单合成演示数据（仅独立演示库；试用 / 正式环境与已有真实手牌时拒绝）
//   seed-billing-demo [--previous-day]    在前台演示数据上写入结账、反结账与交班合成演示数据（仅独立演示库；试用 / 正式环境拒绝）
//                                         营业日切换后 5 个半小时内执行时提示演示单据会跨营业日；两条都加 --previous-day 时整体放到前一个营业日
//   import-hand-tags <清单.csv> | --store-list [--apply] [--deactivate-missing]
//                                         按清单导入手牌池（真实业务数据，默认只预览，加 --apply 才写入）；
//                                         --store-list 使用店主 2026-10-27 的 747 个真实柜号；--deactivate-missing 同时停用清单外的空闲手牌
//   import-price-list <价目表.csv> | --tangqi [--apply] [--deactivate-missing]
//                                         按价目表导入消费项目与多档价格（真实业务数据，默认只预览，加 --apply 才写入）；
//                                         --tangqi 使用店主 2026-10-27 的汤崎价目表；--deactivate-missing 同时停用清单外的项目
//   import-opening <余额.csv> --operator <店主账号> [--control 人数,本金,赠金,累计充值] [--exclude <排除清单.csv>]
//                  [--source EBC] [--note 备注] [--apply]
//                                         导入旧系统（EBC）会员余额作为期初（真实业务数据，默认只预览，加 --apply 才写入）；
//                                         本金、赠金分开记「期初导入」流水，不计入充值实收；同一位会员只能有一笔有效的期初；
//                                         给了控制总数时核对「导入 + 排除清单 = 控制总数」，不一致不导入（正式环境必须给）
//   import-legacy <文件.xlsx> --operator <店主账号> [--apply] [--replace 原因]
//                                         8–10 月旧账只读对照（v0.7.10）：认出是四份原始 Excel 中的哪一份，默认只预览（行数与核验结果），
//                                         加 --apply 才写进只读表（不进正式账）；这份表已导入过时要 --replace 写原因（旧的作废）
//   void-legacy-import <导入编号> --operator <店主账号> --reason <原因>
//                                         作废一次旧账导入（页面上不再显示）
//   legacy-samples <目录>                 写出四份旧账的合成样例（结构与原表一致、内容是编的），演示与验收用
//   seed-legacy-demo                      把旧账合成样例导入演示库（仅独立演示库；试用 / 正式环境拒绝）
//   check                                 核对会员余额与流水、库存结存与库存流水、手牌账单与明细是否一致
//   fingerprint [--json] [--expect 摘要]  当前数据库的数据指纹（逐表行数与内容摘要）；--expect 不一致时退出码为 1
//   backup [--label 备注]                 立即备份一次：导出 → 临时库试恢复 → 自检与数据指纹，文件与 .json 说明写到 BACKUP_PATH
//   backup-loop                           备份服务：按 BACKUP_INTERVAL_MINUTES 定时备份并清理过期文件（compose 的 backup 服务）
//   verify-backup <备份文件.dump>         演练：在临时库恢复这份备份，核对文件摘要、数据指纹与自检（不碰当前数据库）
//   daily-recon [--date YYYY-MM-DD] [--out 目录]
//                                         每日对账包（只读）：日结汇总、结账单、部门参考表、异常清单、交班、技师业绩、客房与押金，写到 <目录>/<营业日>/
//   balance-changes --since "YYYY-MM-DD HH:MM" [--include-opening] [--out 文件.csv]
//                                         某时刻之后有余额变动的会员（只读），退回旧系统时用于回写 EBC；不给 --out 时 CSV 打到标准输出
//   floorplan-convert <图纸.dwg|.dxf> [--out 目录]
//                                         底图转换（RQ-004 第二段，不碰数据库）：每层 SVG 底图、spaces.geojson、转换报告写到目录（默认 floorplan-<文件名>）
//   floorplan-sample <文件.dxf>           写出合成的样例图纸（两层、与 docs/data/space-ledger-sample.csv 的编码对应），演示与验收用

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { businessDateOf, ISO_DATE } from '@shared/business-date';
import { ZONE_LABELS } from '@shared/frontdesk';
import { parseHandTagCsv } from '@shared/hand-tag-import';
import { formatYuan, parseYuan } from '@shared/money';
import { parsePriceListCsv } from '@shared/price-list-import';
import { decodeImportFile, encodingNote } from '@shared/text-decode';
import { checkPasswordStrength, generateTempPassword, hashPassword } from './auth/password';
import { destroyStaffSessions } from './auth/session';
import { loadConfig } from './config';
import { createSql } from './db';
import { writeAudit } from './lib/audit';
import { migrate } from './migrate';
import { seedDemo, DEMO_PASSWORD } from './seed';
import { seedInventoryDemo } from './seed-inventory';
import { seedFrontdeskDemo } from './seed-frontdesk';
import { seedBillingDemo } from './seed-billing';
import { seedLegacyDemo } from './seed-legacy';
import { applyLegacyImport, fileMeta, LegacyParseError, parseLegacyWorkbook, previewLegacyImport, voidLegacyImport } from './modules/legacy';
import { legacySampleFiles } from './modules/legacy/samples';
import { LEGACY_SOURCE_LABELS, type LegacyAudit } from '@shared/legacy';
import { STORE_HAND_TAGS_CSV } from './demo/hand-tags-2026-10-27';
import { TANGQI_PRICE_LIST_CSV } from './demo/price-list-tangqi-2026-10-27';
import { importPriceList } from './modules/catalog';
import { importHandTags } from './modules/frontdesk/tags';
import { applyOpeningImport, previewOpeningImport } from './modules/opening';
import { loadSettings } from './modules/settings';
import { createStaff } from './modules/staff';
import { assertBackupTarget, backupDirFromEnv, backupLoop, backupPolicyFromEnv, createBackup, verifyBackup } from './ops/backup';
import { balanceChanges, balanceChangesCsv, parseLocalTime } from './ops/balance-changes';
import { consistencyChecks } from './ops/consistency';
import { demoSeedTime, rememberDemoAnchor } from './ops/demo-time';
import { computeFingerprint } from './ops/fingerprint';
import { buildDailyRecon } from './ops/recon';
import { FLOORPLAN_ROOM_LABELS } from '@shared/floorplans';
import { floorplanSampleDxf, FLOORPLAN_SAMPLE_EXPECTED } from './demo/floorplan-sample';
import { spacesGeoJson } from './floorplan/geojson';
import { startConversion } from './floorplan/run';
import { FLOORPLAN_TIMEOUT_MS } from './modules/floorplans';

/** --control 人数,本金,赠金,累计充值（金额单位元），例如 1234,567890.12,12345,987654 */
function parseControl(text: string | undefined) {
  if (text === undefined) return null;
  const parts = text.split(/[,，]/).map((p) => p.trim());
  const count = Number(parts[0]);
  const amounts = parts.slice(1).map((p) => parseYuan(p.replace(/[¥￥元\s]/g, '')));
  if (parts.length !== 4 || !Number.isInteger(count) || count < 0 || amounts.some((a) => a === null || a < 0)) {
    throw new Error('--control 应为「人数,本金,赠金,累计充值」（金额单位元），例如 --control 1234,567890.12,12345,987654');
  }
  return { count, principal: amounts[0]!, bonus: amounts[1]!, legacyRecharged: amounts[2]! };
}

/** 读导入文件：自动识别 UTF-8 / GBK（中文 Excel、WPS 默认存 GBK），乱码时报错 */
async function readImportFile(file: string): Promise<string> {
  const { text, encoding } = decodeImportFile(new Uint8Array(await readFile(file)));
  if (encoding !== 'UTF-8') console.log(`· ${encodingNote(encoding)}`);
  return text;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

/** 试用 / 正式环境先拒绝，再看营业日（测试会话 PR #15：红线提示放在最前，不先报 --previous-day 的问题） */
function refuseLiveEnv(config: { env: string }, what: string) {
  if (config.env === 'production' || config.env === 'trial') {
    throw new Error(`当前是${config.env === 'trial' ? '试用' : '正式'}环境，禁止写入${what}演示数据。请另建独立的演示库（APP_ENV=development）再执行。`);
  }
}

/** 导入、作废旧账要用店主账号经办 */
async function ownerOperator(sql: ReturnType<typeof createSql>, username: string, what: string) {
  const [actor] = await sql<{ id: number; role: string; active: boolean }[]>`SELECT id, role, active FROM staff WHERE username = ${username}`;
  if (!actor || !actor.active) throw new Error(`账号「${username}」不存在或已停用`);
  if (actor.role !== 'owner') throw new Error(`${what}只能由店主账号经办`);
  return { id: Number(actor.id) };
}

function printLegacyAudit(a: LegacyAudit) {
  console.log('\n一、总览');
  for (const o of a.overview) console.log(`  ${o.label}：${o.rows} 行，${o.period}，${o.amountText}；${o.problems}`);
  console.log('二、三套账之间的差额');
  for (const c of a.crossChecks) console.log(`  ${c.title}：${c.detail}`);
  if (a.daily) {
    console.log(`三、每日平账：${a.daily.days.length} 个付款日里 ${a.daily.unbalanced} 天不平（${a.daily.tail} 天尾差不到 1 元）；${a.daily.zeroAdvanceWithSpend.length} 天打款为 0 但当天有支出`);
    const top = [...a.daily.days].filter((d) => d.state === 'unbalanced').sort((x, y) => Math.abs(y.diffCents) - Math.abs(x.diffCents)).slice(0, 5);
    if (top.length) console.log(`  差额最大：${top.map((d) => `${d.date} ${d.diffCents > 0 ? '+' : ''}${formatYuan(d.diffCents)}`).join('、')}`);
  }
  console.log('四、字段与口径问题');
  for (const f of a.fieldIssues) console.log(`  ${f.title}：${f.detail}`);
  console.log('五、12 条规则在旧账上');
  for (const r of a.rules) console.log(`  ${r.no}. ${r.title}：${r.result}`);
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
        refuseLiveEnv(config, '前台');
        await migrate(sql);
        // 营业日切换后不久灌数据会跨营业日（PR #13 复核 P2-3）：提示，或按 --previous-day 整体放到前一个营业日
        const t = await demoSeedTime(sql, { timeZone: config.timezone, kind: 'frontdesk', previousDay: args.includes('--previous-day') });
        if (t.warning) console.warn(`⚠ ${t.warning}`);
        const result = await seedFrontdeskDemo(sql, config, { now: t.now });
        if (result.skipped) {
          console.log('已存在前台演示数据，跳过。');
        } else {
          if (t.anchored && t.now) await rememberDemoAnchor(sql, t.now);
          if (t.notice) console.log(`· ${t.notice}`);
          console.log(`已写入前台演示数据：${result.tags} 张手牌、${result.inStore} 位在店客人。预期结果见 src/server/demo/frontdesk-expected.json`);
          console.log(`演示账号：店主 linlan / 前台 xiaozhou / 值班经理 zhangjl，密码均为 ${DEMO_PASSWORD}`);
        }
        break;
      }
      case 'seed-billing-demo': {
        refuseLiveEnv(config, '结账');
        await migrate(sql);
        const t = await demoSeedTime(sql, { timeZone: config.timezone, kind: 'billing', previousDay: args.includes('--previous-day') });
        if (t.warning) console.warn(`⚠ ${t.warning}`);
        const result = await seedBillingDemo(sql, config, { now: t.now });
        if (result.skipped) {
          console.log('已存在结账演示数据，跳过。');
        } else {
          if (t.notice) console.log(`· ${t.notice}`);
          console.log(`已写入结账演示数据：${result.checkouts} 张结账单、${result.voided} 张反结账，以及一个已交班的班次。预期结果见 src/server/demo/billing-expected.json`);
          console.log(`演示账号：收银员 chenyin / 值班经理 zhangjl / 店主 linlan，密码均为 ${DEMO_PASSWORD}`);
        }
        break;
      }
      case 'import-hand-tags': {
        const storeList = args.includes('--store-list');
        const file = args.find((a) => !a.startsWith('--'));
        if (!storeList && !file) throw new Error('用法：import-hand-tags <清单.csv> | --store-list [--apply] [--deactivate-missing]');
        await migrate(sql);
        const parsed = parseHandTagCsv(storeList ? STORE_HAND_TAGS_CSV : await readImportFile(file!));
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
        const parsed = parsePriceListCsv(tangqi ? TANGQI_PRICE_LIST_CSV : await readImportFile(file!));
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
      case 'import-opening': {
        const file = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
        const username = flag(args, 'operator')?.toLowerCase();
        if (!file || !username) {
          throw new Error('用法：import-opening <余额.csv> --operator <店主账号> [--control 人数,本金,赠金,累计充值] [--exclude <排除清单.csv>] [--source EBC] [--note 备注] [--apply]');
        }
        await migrate(sql);
        const [actor] = await sql<{ id: number; username: string; displayName: string; role: string; active: boolean }[]>`
          SELECT id, username, display_name, role, active FROM staff WHERE username = ${username}`;
        if (!actor || !actor.active) throw new Error(`账号「${username}」不存在或已停用`);
        if (actor.role !== 'owner') throw new Error('期初导入只能由店主账号经办');
        const csv = await readImportFile(file);
        const excludeFile = flag(args, 'exclude');
        const body = {
          source: flag(args, 'source') ?? 'EBC',
          fileName: basename(file),
          note: flag(args, 'note') ?? '',
          csv,
          control: parseControl(flag(args, 'control')),
          excludedCsv: excludeFile ? await readImportFile(excludeFile) : '',
        };
        const deps = { sql, config };
        const preview = await previewOpeningImport(deps, body);
        console.log(`文件共 ${preview.total} 位会员：新建档案 ${preview.createCount} · 匹配已有会员 ${preview.matchCount} · 余额为 0 只建档 ${preview.zeroCount}`);
        console.log(`期初本金 ${formatYuan(preview.principalTotal)} · 期初赠金 ${formatYuan(preview.bonusTotal)} · 旧系统累计充值 ${formatYuan(preview.legacyRechargedTotal)}`);
        if (preview.control) {
          const { expected: e, excluded: x } = preview.control;
          console.log(`EBC 控制总数：${e.count} 位 · 本金 ${formatYuan(e.principal)} · 赠金 ${formatYuan(e.bonus)} · 累计充值 ${formatYuan(e.legacyRecharged)}`);
          if (x.count) console.log(`排除清单：${x.count} 位 · 本金 ${formatYuan(x.principal)} · 赠金 ${formatYuan(x.bonus)} · 累计充值 ${formatYuan(x.legacyRecharged)}`);
          for (const m of preview.control.mismatches) console.log(`✗ ${m}`);
          console.log(preview.control.ok ? '✓ 导入 + 排除 = 控制总数，四项一致' : '✗ 与控制总数不一致：不能导入');
          if (!preview.control.ok) process.exitCode = 1;
        } else {
          console.log('· 没有给 EBC 控制总数（--control 人数,本金,赠金,累计充值），没有比对；正式环境导入时必须给');
        }
        if (preview.errors.length) {
          for (const e of preview.errors.slice(0, 30)) console.log(`✗ 第 ${e.line} 行：${e.message}`);
          throw new Error(`有 ${preview.errors.length} 处需要修改，未导入`);
        }
        if (!args.includes('--apply')) {
          console.log('以上为预览，没有写入。确认无误后加 --apply 执行导入。');
          break;
        }
        const report = await applyOpeningImport(
          deps,
          { ...body, clientKey: randomUUID() },
          { actor: { id: actor.id, username: actor.username, displayName: actor.displayName, role: 'owner', duties: [], mustChangePassword: false } },
          { via: 'cli' },
        );
        console.log(`✓ 已导入，批次 ${report.importNo}：${report.total} 位会员，本金 ${formatYuan(report.principalTotal)}，赠金 ${formatYuan(report.bonusTotal)}。`);
        console.log('请运行 check 核对：期初 + 本日变动 = 期末。');
        break;
      }
      case 'import-legacy': {
        const file = args.find((a, i) => !a.startsWith('--') && !['--operator', '--replace'].includes(args[i - 1] ?? ''));
        const username = flag(args, 'operator')?.toLowerCase();
        if (!file || !username) throw new Error('用法：import-legacy <文件.xlsx> --operator <店主账号> [--apply] [--replace 原因]');
        await migrate(sql);
        const actor = await ownerOperator(sql, username, '旧账导入');
        const buf = await readFile(file);
        let parsed;
        try {
          parsed = parseLegacyWorkbook(buf);
        } catch (e) {
          if (e instanceof LegacyParseError) throw new Error(`✗ ${e.message}`);
          throw e;
        }
        const meta = fileMeta(basename(file), buf);
        const { audit, existing } = await previewLegacyImport(sql, parsed, meta);
        console.log(`文件：${meta.fileName}（${(meta.bytes / 1024).toFixed(0)} KB，摘要 ${meta.sha256.slice(0, 12)}）`);
        console.log(`认出是「${LEGACY_SOURCE_LABELS[parsed.source]}」：${parsed.sheets.map((s) => `「${s.name}」${s.rows} 行`).join('、')}${parsed.images.size ? `；单元格图 ${parsed.images.size} 张` : ''}`);
        for (const w of parsed.warnings) console.log(`· ${w}`);
        for (const [k, v] of Object.entries(parsed.fileTotals)) console.log(`· 表里自带的合计「${k}」：${formatYuan(v)}`);
        printLegacyAudit(audit);
        if (existing) console.log(existing.sha256 === meta.sha256 ? '· 同一个文件已经导入过（再导入直接返回原来那次）' : `· 这份表已经导入过（第 ${existing.id} 次导入：${existing.fileName}）；换成这个文件要加 --replace "原因"`);
        if (!args.includes('--apply')) {
          console.log('\n以上是预览，没有写入。核对无误后加 --apply 写进只读表（不进正式账）。');
          break;
        }
        const r = await applyLegacyImport(sql, parsed, meta, { operatorId: actor.id, replaceReason: flag(args, 'replace') ?? null });
        console.log(r.replayed ? `同一个文件已经导入过：第 ${r.importId} 次导入，没有重复写入。` : `已写入只读表：第 ${r.importId} 次导入${r.voidedId ? `（第 ${r.voidedId} 次导入已作废）` : ''}。在 ERP「费用与备用金 → 旧账对照」查看。`);
        break;
      }
      case 'void-legacy-import': {
        const id = Number(args[0]);
        const username = flag(args, 'operator')?.toLowerCase();
        const reason = flag(args, 'reason');
        if (!Number.isInteger(id) || id <= 0 || !username || !reason) throw new Error('用法：void-legacy-import <导入编号> --operator <店主账号> --reason <原因>');
        const actor = await ownerOperator(sql, username, '作废旧账导入');
        await voidLegacyImport(sql, id, reason, actor.id);
        console.log(`已作废第 ${id} 次旧账导入。`);
        break;
      }
      case 'legacy-samples': {
        const dir = args[0];
        if (!dir) throw new Error('用法：legacy-samples <目录>');
        await mkdir(dir, { recursive: true });
        for (const f of legacySampleFiles()) {
          await writeFile(join(dir, f.name), f.data);
          console.log(`已写出 ${join(dir, f.name)}`);
        }
        console.log('这四份是合成样例（内容是编的），导入后的核验结果见 src/server/demo/legacy-expected.json');
        break;
      }
      case 'seed-legacy-demo': {
        refuseLiveEnv(config, '旧账');
        await migrate(sql);
        const result = await seedLegacyDemo(sql, config);
        if (result.skipped) console.log('已经有旧账导入，跳过。');
        else {
          for (const f of result.files) console.log(`已导入 ${f.name}：「${LEGACY_SOURCE_LABELS[f.source]}」${f.rows} 行（第 ${f.importId} 次导入）`);
          console.log(`导入人：${result.operator}。预期结果见 src/server/demo/legacy-expected.json；在 ERP「费用与备用金 → 旧账对照」查看。`);
        }
        break;
      }
      case 'check': {
        const all = await consistencyChecks(sql, config.timezone);
        for (const c of all) console.log(`${c.ok ? '✓' : '✗'} ${c.label}：${c.detail}`);
        if (all.some((c) => !c.ok)) process.exitCode = 1;
        break;
      }
      case 'fingerprint': {
        const fp = await computeFingerprint(sql);
        const expect = flag(args, 'expect');
        if (args.includes('--json')) console.log(JSON.stringify(fp, null, 2));
        else {
          // 比对时只打印结论，不逐表列出
          if (expect === undefined) for (const t of fp.tables) console.log(`${t.name}\t${t.rows}\t${t.digest}`);
          console.log(`数据指纹：${fp.digest}`);
        }
        if (expect !== undefined) {
          const same = expect === fp.digest;
          console.log(same ? '✓ 与备份时记下的指纹一致' : `✗ 与备份时记下的指纹不同（备份时 ${expect}）`);
          if (!same) process.exitCode = 1;
        }
        break;
      }
      case 'backup': {
        const dir = backupDirFromEnv();
        await assertBackupTarget(dir, backupPolicyFromEnv());
        const m = await createBackup(config, dir, flag(args, 'label') ?? 'manual');
        if (!m.verified) {
          console.error(`✗ 已导出 ${m.file}，但在临时库恢复失败：${m.verifyError}`);
          process.exitCode = 1;
          break;
        }
        console.log(`✓ 已备份：${m.file}（${(m.bytes / 1024 / 1024).toFixed(1)} MB）；已在临时库恢复核验，指纹 ${m.fingerprintDigest}`);
        // 自检不一致说明的是当前数据，备份本身完好：照样算备份成功，升级、恢复（往往正是为了修它）不被拦住
        const failed = m.checks!.failed;
        for (const c of failed) console.log(`✗ ${c.label}：${c.detail}`);
        if (failed.length) console.log(`· 当前数据自检有 ${failed.length} 项不一致（备份本身完好），请告知店主与 Codex`);
        break;
      }
      case 'backup-loop': {
        await backupLoop(config, backupDirFromEnv(), backupPolicyFromEnv());
        break;
      }
      case 'daily-recon': {
        const date = flag(args, 'date') ?? businessDateOf(new Date(), config.timezone, (await loadSettings(sql)).businessDayStartHour);
        if (!ISO_DATE.test(date)) throw new Error('--date 应为 YYYY-MM-DD');
        const recon = await buildDailyRecon(sql, config, date);
        const dir = join(flag(args, 'out') ?? './recon', date);
        await mkdir(dir, { recursive: true });
        for (const f of recon.files) await writeFile(join(dir, f.name), f.content);
        for (const line of recon.summary) console.log(line);
        console.log(`${recon.ok ? '✓' : '✗'} 对账包已写到 ${dir}（${recon.files.length} 个文件）`);
        if (!recon.ok) process.exitCode = 1;
        break;
      }
      case 'balance-changes': {
        const sinceText = flag(args, 'since');
        const since = sinceText ? parseLocalTime(sinceText, config.timezone) : null;
        if (!since) throw new Error('用法：balance-changes --since "YYYY-MM-DD HH:MM"（门店时间）[--include-opening] [--out 文件.csv]');
        const rows = await balanceChanges(sql, since, args.includes('--include-opening'));
        const stampOf = (iso: string) => new Date(iso).toLocaleString('zh-CN', { timeZone: config.timezone, hour12: false });
        const csv = balanceChangesCsv(rows, stampOf);
        const out = flag(args, 'out');
        if (!out) {
          process.stdout.write(csv);
          break;
        }
        await writeFile(out, csv);
        console.log(`${sinceText} 之后有余额变动的会员 ${rows.length} 位，已写到 ${out}`);
        break;
      }
      case 'floorplan-convert': {
        const file = args[0];
        if (!file || file.startsWith('--')) throw new Error('用法：floorplan-convert <图纸.dwg|.dxf> [--out 目录]');
        const out = flag(args, 'out') ?? `floorplan-${basename(file).replace(/\.[^.]+$/, '')}`;
        await mkdir(out, { recursive: true });
        const resultFile = join(out, 'worker-result.json');
        console.log(`转换中（单独的进程，DWG 大约要半分钟）：${file}`);
        const t0 = Date.now();
        const res = await startConversion(file, resultFile, FLOORPLAN_TIMEOUT_MS).done;
        await rm(resultFile, { force: true });
        if (!res.ok || !res.result) throw new Error(res.error ?? '转换失败');
        const r = res.result;
        for (const f of r.floors) await writeFile(join(out, `${f.code}.svg`), f.svg);
        await writeFile(join(out, 'spaces.geojson'), JSON.stringify(spacesGeoJson(r.rooms, { converter: r.converter, file: basename(file) }), null, 1));
        await writeFile(join(out, 'report.json'), JSON.stringify({ ...r, floors: r.floors.map((f) => ({ ...f, svg: undefined })) }, null, 1));
        console.log(`读图 ${((res.readMs ?? 0) / 1000).toFixed(1)} 秒，转换 ${(r.convertMs / 1000).toFixed(1)} 秒，共 ${((Date.now() - t0) / 1000).toFixed(1)} 秒；图元 ${r.source.entities} 个、图层 ${r.source.layers} 个`);
        for (const f of r.floors) {
          const rooms = r.rooms.filter((x) => x.floor === f.code);
          const ok = rooms.filter((x) => x.status === 'ok').length;
          console.log(`  ${f.code}${f.title ? `（${f.title}）` : ''}：底图 ${(f.svgBytes / 1024).toFixed(0)} KB，编码 ${rooms.length} 个，配上轮廓 ${ok} 个`);
        }
        const ex = r.rooms.filter((x) => x.status !== 'ok');
        if (ex.length) console.log(`例外 ${ex.length} 个：${ex.map((x) => `${x.code}（${FLOORPLAN_ROOM_LABELS[x.status]}${x.with.length ? `：${x.with.join('、')}` : ''}）`).join('，')}`);
        for (const i of r.issues) console.log(`  · ${i.message}`);
        console.log(`已写到 ${out}/：每层 SVG、spaces.geojson、report.json`);
        break;
      }
      case 'floorplan-sample': {
        const file = args[0];
        if (!file) throw new Error('用法：floorplan-sample <文件.dxf>');
        await writeFile(file, floorplanSampleDxf());
        console.log(`已写出 ${file}（合成样例：两层、${FLOORPLAN_SAMPLE_EXPECTED.rooms} 个编码，预期结果见 src/server/demo/floorplan-expected.json）`);
        break;
      }
      case 'verify-backup': {
        const file = args[0];
        if (!file) throw new Error('用法：verify-backup <备份文件.dump>');
        const result = await verifyBackup(config, file);
        for (const line of result.lines) console.log(line);
        console.log(result.ok ? '✓ 备份可以恢复，内容与备份时一致' : '✗ 备份核验没有通过');
        if (!result.ok) process.exitCode = 1;
        break;
      }
      default:
        console.log('可用命令：migrate | create-owner <账号> | reset-password <账号> | seed-demo [--force] | seed-inventory-demo | seed-frontdesk-demo [--previous-day] | seed-billing-demo [--previous-day] | import-hand-tags | import-price-list | import-opening | check | fingerprint | backup | backup-loop | verify-backup | daily-recon | balance-changes | floorplan-convert | floorplan-sample');
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
