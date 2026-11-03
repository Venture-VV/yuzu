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
//   demo-prepare [--previous-day]         一条命令准备演示库（v0.7.18）：迁移 → 会员 → 库存 → 前台 → 结账 → 旧账 → 场景块（客房、技师与钟房、
//                                         餐饮与厨房、空间台账与底图、实时位置）→ 一致性自检 → 演示核对；已有的块跳过、缺的补上，不改已有记录；
//                                         场景块与已有记录对不上时整块不写并列出冲突；试用 / 正式环境拒绝
//   demo-check                            核对演示库（只读）：一致性自检、五块都在、场景块与 src/server/demo/showcase-expected.json 一致
//   demo-reset --confirm <数据库名>        重建演示库：只在 APP_ENV=development、实例标识不是 prod / shadow / test 时可用；先备份到 BACKUP_PATH
//                                         并在临时库恢复核验，通过后才清空这个库、重新 demo-prepare（请先停掉应用）
//   check                                 核对会员余额与流水、库存结存与库存流水、手牌账单与明细是否一致
//   fingerprint [--json] [--expect 摘要]  当前数据库的数据指纹（逐表行数与内容摘要）；--expect 不一致时退出码为 1
//   backup [--label 备注]                 立即备份一次：导出 → 临时库试恢复 → 自检与数据指纹，文件与 .json 说明写到 BACKUP_PATH
//   backup-loop                           备份服务：按 BACKUP_INTERVAL_MINUTES 定时备份并清理过期文件（compose 的 backup 服务）
//   verify-backup <备份文件.dump>         演练：在临时库恢复这份备份，核对文件摘要、数据指纹与自检（不碰当前数据库）
//   daily-recon [--date YYYY-MM-DD] [--out 目录]
//                                         每日对账包（只读）：日结汇总、结账单、部门参考表、异常清单、交班、技师业绩、客房与押金，写到 <目录>/<营业日>/
//   balance-changes --since "YYYY-MM-DD HH:MM" [--include-opening] [--out 文件.csv]
//                                         某时刻之后有余额变动的会员（只读），退回旧系统时用于回写 EBC；不给 --out 时 CSV 打到标准输出
//   floorplan-convert <图纸.dwg|.dxf|.pdf> [--out 目录] [--scale 比例]
//                                         底图转换（RQ-004 第二段，不连数据库、不需要 DATABASE_URL）：每层 SVG 底图、spaces.geojson、
//                                         转换报告（每个图层的用途与图元数）写到目录（默认 floorplan-<文件名>）；
//                                         矢量 PDF 给了 --scale（100 或 1:100 都行）按它换算尺寸，没给时按图上的比例文字（如 1:100）
//   floorplan-sample <文件.dxf|.pdf>      写出合成的样例图纸（两层、与 docs/data/space-ledger-sample.csv 的编码对应），演示与验收用；
//                                         文件名以 .pdf 结尾时写 PDF 版（1:100、每层一页、英文文字），否则写 DXF
//   import-devices --quote [--apply]      按采购清单（12 类 81 台）登记设备（RQ-001，v0.7.21；真实门店数据，默认只预览，加 --apply 才写入，编号已有的跳过）
//   device-selftest                       硬件连接一键自检（不连数据库、不要真机）：模拟打印机与模拟桥走一遍打印、状态、拔线恢复、读卡、扫码
//   device-printer-mock [--port 9100] [--mode normal|paper_out|cover_open|fault|silent|drop]
//                                         模拟网口打印机（不连数据库）：收到的打印内容打到屏幕上；输入 mode <模式>、stop、start、quit
//   device-bridge-mock [--port 17890] [--terminal 终端编号] [--auto 秒]
//                                         模拟终端上的设备服务（桥，不连数据库）：输入 card <卡号>、scan <条码>、nfc <卡号>、unplug <键>、plug <键>、
//                                         fail、quit；--auto 每隔几秒自动发一次读卡与扫码

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { businessDateOf, ISO_DATE } from '@shared/business-date';
import { ZONE_LABELS } from '@shared/frontdesk';
import { parseHandTagCsv } from '@shared/hand-tag-import';
import { formatYuan, parseYuan } from '@shared/money';
import { parsePriceListCsv } from '@shared/price-list-import';
import { decodeImportFile, encodingNote } from '@shared/text-decode';
import { DEFAULT_BRIDGE_PORT } from '@shared/devices';
import { decodePrintedText } from './devices/escpos';
import { startMockBridge } from './devices/mock-bridge';
import { MOCK_PRINTER_MODES, startMockPrinter, type MockPrinterMode } from './devices/mock-printer';
import { runDeviceSelftest } from './devices/selftest';
import { importDevices, importPreview } from './modules/devices';
import { checkPasswordStrength, generateTempPassword, hashPassword } from './auth/password';
import { destroyStaffSessions } from './auth/session';
import { loadConfig, type AppConfig } from './config';
import { createSql, type Sql } from './db';
import { writeAudit } from './lib/audit';
import { migrate } from './migrate';
import { ensureMembershipLive, runMembershipDaily } from './modules/membership';
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
import { assertResettable, demoCheck, demoPrepare, demoReset, refuseLiveDemo, type DemoCheckResult, type PrepareResult } from './demo/prepare';
import { ShowcaseConflictError } from './demo/showcase';
import { floorplanSampleDxf, floorplanSamplePdf, FLOORPLAN_SAMPLE_EXPECTED } from './demo/floorplan-sample';
import { spacesGeoJson } from './floorplan/geojson';
import { MAX_PDF_SCALE } from './floorplan/read-pdf';
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

function printDemoCheck(r: DemoCheckResult) {
  for (const l of r.lines) console.log(`${l.ok ? '✓' : '✗'} ${l.label}：${l.detail}`);
  for (const n of r.notes) console.log(`· ${n}`);
  console.log(r.ok ? '✓ 演示库核对通过' : '✗ 演示库与预期不一致（见上面标 ✗ 的项）');
}

function printPrepare(r: PrepareResult, startedAt: number) {
  console.log('\n演示数据：');
  for (const b of r.blocks) {
    console.log(`  ${b.written ? '已写入' : '已存在'}  ${b.block}：${b.detail}`);
    for (const item of b.items ?? []) console.log(`            · ${item}`);
  }
  for (const n of r.notes) console.log(`· ${n}`);
  console.log(`用时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒。演示账号：店主 linlan / 前台 xiaozhou / 值班经理 zhangjl，密码均为 ${DEMO_PASSWORD}\n`);
  printDemoCheck(r.check);
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

/** 不连数据库的命令（底图转换）：不需要 DATABASE_URL；处理了返回 true */
/** 逐行读标准输入（模拟设备的命令行） */
function onStdinLines(handle: (line: string) => void | Promise<void>) {
  process.stdin.setEncoding('utf8');
  let buf = '';
  process.stdin.on('data', (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) void handle(line);
    }
  });
}

async function offlineCommand(command: string | undefined, args: string[]): Promise<boolean> {
  switch (command) {
    case 'device-selftest': {
      const r = await runDeviceSelftest((line) => console.log(line));
      console.log(r.ok ? `✓ 硬件连接自检 ${r.checks.length} 项全部通过（模拟打印机、模拟桥，不连数据库、不要真机）` : `✗ 有 ${r.checks.filter((c) => !c.ok).length} 项没通过`);
      if (!r.ok) process.exitCode = 1;
      return true;
    }
    case 'device-printer-mock': {
      const mode = (flag(args, 'mode') ?? 'normal') as MockPrinterMode;
      if (!MOCK_PRINTER_MODES.includes(mode)) throw new Error(`--mode 只能是 ${MOCK_PRINTER_MODES.join(' / ')}`);
      const printer = await startMockPrinter({ host: flag(args, 'host') ?? '127.0.0.1', port: Number(flag(args, 'port') ?? 9100), mode });
      printer.onJob = (job) => console.log(`── 收到打印内容 ${job.length} 字节 ──\n${decodePrintedText(job)}\n──────────`);
      console.log(`模拟打印机在 ${printer.host}:${printer.port}（${mode}）。输入 mode <${MOCK_PRINTER_MODES.join('|')}>、stop（拔线）、start（插回）、quit`);
      onStdinLines(async (line) => {
        const [cmd, arg] = line.split(/\s+/);
        if (cmd === 'mode' && MOCK_PRINTER_MODES.includes(arg as MockPrinterMode)) printer.setMode(arg as MockPrinterMode);
        else if (cmd === 'stop') await printer.stop();
        else if (cmd === 'start') await printer.start();
        else if (cmd === 'quit') {
          await printer.close();
          process.exit(0);
        } else return console.log('不认识的命令');
        console.log('✓');
      });
      await new Promise(() => {});
      return true;
    }
    case 'device-bridge-mock': {
      const bridge = await startMockBridge({ host: '127.0.0.1', port: Number(flag(args, 'port') ?? DEFAULT_BRIDGE_PORT), terminal: (flag(args, 'terminal') ?? 'TRM-MOCK-01').toUpperCase() });
      console.log(`模拟设备服务在 ${bridge.url}（终端 ${bridge.terminal}；设备 ${bridge.devices.map((d) => d.key).join('、')}）`);
      console.log('输入 card <卡号>、scan <条码>、nfc <卡号>、unplug <键>、plug <键>、fail、quit');
      const auto = Number(flag(args, 'auto') ?? 0);
      if (auto > 0) {
        let n = 0;
        setInterval(() => {
          n += 1;
          bridge.sendCard(`00${String(10000000 + n)}`);
          bridge.sendScan(`690${String(1000000000 + n)}`);
        }, auto * 1000);
      }
      onStdinLines(async (line) => {
        const [cmd, arg] = line.split(/\s+/);
        if (cmd === 'card' && arg) bridge.sendCard(arg);
        else if (cmd === 'scan' && arg) bridge.sendScan(arg);
        else if (cmd === 'nfc' && arg) bridge.sendCard(arg, 'nfc');
        else if (cmd === 'unplug' && arg) bridge.setDevice(arg, 'offline', 'DEVICE_OFFLINE');
        else if (cmd === 'plug' && arg) bridge.setDevice(arg, 'online');
        else if (cmd === 'fail') bridge.failRead();
        else if (cmd === 'quit') {
          await bridge.close();
          process.exit(0);
        } else return console.log('不认识的命令');
        console.log(`✓（${bridge.clients()} 个页面连着）`);
      });
      await new Promise(() => {});
      return true;
    }
    case 'floorplan-convert': {
      const file = args[0];
      if (!file || file.startsWith('--')) throw new Error('用法：floorplan-convert <图纸.dwg|.dxf|.pdf> [--out 目录] [--scale 比例]');
      // PDF 的图纸比例 1:N：给了就按它换算（v0.7.19 起优先于图上的比例文字），没给按图上写的
      const scaleText = flag(args, 'scale');
      const pdfScale = scaleText === undefined ? undefined : Number(scaleText.trim().replace(/^1\s*[:：]\s*/, ''));
      if (pdfScale !== undefined && !(Number.isFinite(pdfScale) && pdfScale >= 1 && pdfScale <= MAX_PDF_SCALE)) {
        throw new Error(`--scale 是图纸比例 1:N 里的 N（1 到 ${MAX_PDF_SCALE}），例如 --scale 100`);
      }
      const out = flag(args, 'out') ?? `floorplan-${basename(file).replace(/\.[^.]+$/, '')}`;
      await mkdir(out, { recursive: true });
      const resultFile = join(out, 'worker-result.json');
      console.log(`转换中（单独的进程，DWG 大约要半分钟）：${file}`);
      const t0 = Date.now();
      const res = await startConversion(file, resultFile, FLOORPLAN_TIMEOUT_MS, { pdfScale }).done;
      await rm(resultFile, { force: true });
      if (!res.ok || !res.result) {
        const reason = res.error ?? '转换失败';
        throw new Error(/没有认出图纸比例/.test(reason) ? `${reason}（命令行加 --scale，例如 --scale 100 表示 1:100）` : reason);
      }
      const r = res.result;
      for (const f of r.floors) await writeFile(join(out, `${f.code}.svg`), f.svg);
      await writeFile(join(out, 'spaces.geojson'), JSON.stringify(spacesGeoJson(r.rooms, { converter: r.converter, file: basename(file) }), null, 1));
      // PDF 另写页数、换算比例与比例来源（main 定时测试报告建议：原来只打在屏幕上）
      await writeFile(join(out, 'report.json'), JSON.stringify({ ...r, ...(res.pdf ? { pdf: res.pdf } : {}), floors: r.floors.map((f) => ({ ...f, svg: undefined })) }, null, 1));
      console.log(`读图 ${((res.readMs ?? 0) / 1000).toFixed(1)} 秒，转换 ${(r.convertMs / 1000).toFixed(1)} 秒，共 ${((Date.now() - t0) / 1000).toFixed(1)} 秒；图元 ${r.source.entities} 个、图层 ${r.source.layers} 个`);
      if (res.pdf) {
        const from = res.pdf.scaleFrom === 'text' ? '图上的比例文字' : '--scale';
        // 填的比例优先（v0.7.19）；与图上写的不同时提示
        const differ = res.pdf.scaleFrom === 'option' && res.pdf.textScale !== null && res.pdf.textScale !== res.pdf.scale ? `；图上写的是 1:${res.pdf.textScale}，按 --scale 换算` : '';
        console.log(`PDF ${res.pdf.pages} 页，按 1:${res.pdf.scale} 换算（${from}）${differ}`);
      }
      for (const f of r.floors) {
        const rooms = r.rooms.filter((x) => x.floor === f.code);
        const ok = rooms.filter((x) => x.status === 'ok').length;
        console.log(`  ${f.code}${f.title ? `（${f.title}）` : ''}：底图 ${(f.svgBytes / 1024).toFixed(0)} KB，编码 ${rooms.length} 个，配上轮廓 ${ok} 个`);
      }
      const ex = r.rooms.filter((x) => x.status !== 'ok');
      if (ex.length) console.log(`例外 ${ex.length} 个：${ex.map((x) => `${x.code}（${FLOORPLAN_ROOM_LABELS[x.status]}${x.with.length ? `：${x.with.join('、')}` : ''}）`).join('，')}`);
      for (const i of r.issues) console.log(`  · ${i.message}`);
      console.log(`已写到 ${out}/：每层 SVG、spaces.geojson、report.json`);
      return true;
    }
    case 'floorplan-sample': {
      const file = args[0];
      if (!file) throw new Error('用法：floorplan-sample <文件.dxf|.pdf>');
      const pdf = /\.pdf$/i.test(file);
      await writeFile(file, pdf ? floorplanSamplePdf() : floorplanSampleDxf());
      console.log(
        `已写出 ${file}（合成样例${pdf ? ' PDF 版，1:100' : ''}：两层、${FLOORPLAN_SAMPLE_EXPECTED.rooms} 个编码，预期结果见 src/server/demo/floorplan-expected.json${pdf ? ' 的 pdf' : ''}）`,
      );
      return true;
    }
    default:
      return false;
  }
}

/** 迁移，并做只做一次的上线处理（会员体系 v2：已有会员按累计充值定档，v0.7.23）；应用启动时同样先做 */
async function prepareDb(sql: Sql, config: AppConfig, log?: (msg: string) => void): Promise<string[]> {
  const applied = await migrate(sql, log);
  const live = await ensureMembershipLive({ sql, config });
  if (live) (log ?? console.log)(`会员体系 v2 上线：${live.graded} 位已有会员按累计充值定档（营业日 ${live.businessDate}）`);
  return applied;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (await offlineCommand(command, args)) return;
  const config = loadConfig();
  const sql = createSql(config.databaseUrl, { max: 2 });
  try {
    switch (command) {
      case 'migrate': {
        const applied = await prepareDb(sql, config, console.log);
        console.log(applied.length ? `完成，共应用 ${applied.length} 个迁移。` : '数据库已是最新结构。');
        break;
      }
      case 'create-owner': {
        const username = args[0]?.toLowerCase();
        if (!username) throw new Error('用法：create-owner <账号> [--name 姓名] [--password 密码]');
        await prepareDb(sql, config);
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
        await prepareDb(sql, config);
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
        await prepareDb(sql, config);
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
        await prepareDb(sql, config);
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
        await prepareDb(sql, config);
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
      case 'import-devices': {
        if (!args.includes('--quote')) throw new Error('用法：import-devices --quote [--apply]（按需求文档里的采购清单登记设备，默认只预览）');
        await prepareDb(sql, config);
        const preview = await importPreview(sql);
        console.log(`采购清单共 ${preview.total} 台：会新建 ${preview.create.length} 台，编号已有、跳过 ${preview.skipped.length} 台`);
        for (const d of preview.create.slice(0, 200)) console.log(`  ${d.code}  ${d.name}（${d.area}）`);
        if (!args.includes('--apply')) {
          console.log('以上为预览，没有写入。确认无误后加 --apply 执行导入（真实门店数据，门店环境须店主同意）；IP、端口、所属终端由现场在后台「设备」填。');
          break;
        }
        const r = await importDevices(sql, null);
        console.log(`✓ 已导入：新建 ${r.created} 台，跳过 ${r.skipped} 台。`);
        break;
      }
      case 'import-hand-tags': {
        const storeList = args.includes('--store-list');
        const file = args.find((a) => !a.startsWith('--'));
        if (!storeList && !file) throw new Error('用法：import-hand-tags <清单.csv> | --store-list [--apply] [--deactivate-missing]');
        await prepareDb(sql, config);
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
        await prepareDb(sql, config);
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
        await prepareDb(sql, config);
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
        await prepareDb(sql, config);
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
        await prepareDb(sql, config);
        const result = await seedLegacyDemo(sql, config);
        if (result.skipped) console.log('已经有旧账导入，跳过。');
        else {
          for (const f of result.files) console.log(`已导入 ${f.name}：「${LEGACY_SOURCE_LABELS[f.source]}」${f.rows} 行（第 ${f.importId} 次导入）`);
          console.log(`导入人：${result.operator}。预期结果见 src/server/demo/legacy-expected.json；在 ERP「费用与备用金 → 旧账对照」查看。`);
        }
        break;
      }
      case 'demo-prepare': {
        refuseLiveDemo(config);
        const startedAt = Date.now();
        try {
          const r = await demoPrepare(sql, config, { previousDay: args.includes('--previous-day'), log: (l) => console.log(l) });
          printPrepare(r, startedAt);
          if (!r.check.ok) process.exitCode = 1;
        } catch (error) {
          if (error instanceof ShowcaseConflictError) console.log('· 前面几块已按顺序准备（已有的跳过），只有场景块没写');
          throw error;
        }
        break;
      }
      case 'demo-check': {
        const r = await demoCheck(sql, config);
        printDemoCheck(r);
        if (!r.ok) process.exitCode = 1;
        break;
      }
      case 'demo-reset': {
        const startedAt = Date.now();
        assertResettable(config);
        const dir = backupDirFromEnv();
        await assertBackupTarget(dir, backupPolicyFromEnv());
        const r = await demoReset(sql, config, { confirm: flag(args, 'confirm'), backupDir: dir, log: (l) => console.log(l) });
        printPrepare(r.prepare, startedAt);
        if (!r.prepare.check.ok) process.exitCode = 1;
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
      case 'verify-backup': {
        const file = args[0];
        if (!file) throw new Error('用法：verify-backup <备份文件.dump>');
        const result = await verifyBackup(config, file);
        for (const line of result.lines) console.log(line);
        console.log(result.ok ? '✓ 备份可以恢复，内容与备份时一致' : '✗ 备份核验没有通过');
        if (!result.ok) process.exitCode = 1;
        break;
      }
      case 'membership-daily': {
        // 会员到期处理（应用每分钟自己会跑；应用停着、要马上补跑时用）
        await prepareDb(sql, config);
        const run = await runMembershipDaily({ sql, config });
        console.log(
          run
            ? `会员到期处理（营业日 ${run.businessDate}）：处理 ${run.processed} 位，保级 ${run.retained}、进补充期 ${run.grace}、降档 ${run.downgraded}${run.error ? `；出错：${run.error}` : ''}`
            : '今天已经处理过，没有到期的会员',
        );
        if (run?.error) process.exitCode = 1;
        break;
      }
      default:
        console.log('可用命令：migrate | create-owner <账号> | reset-password <账号> | seed-demo [--force] | seed-inventory-demo | seed-frontdesk-demo [--previous-day] | seed-billing-demo [--previous-day] | seed-legacy-demo | demo-prepare [--previous-day] | demo-check | demo-reset --confirm <数据库名> | import-hand-tags | import-price-list | import-opening | check | fingerprint | backup | backup-loop | verify-backup | daily-recon | balance-changes | floorplan-convert | floorplan-sample | import-devices | device-selftest | device-printer-mock | device-bridge-mock | membership-daily');
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
