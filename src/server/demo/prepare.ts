// 演示数据的总入口（v0.7.18，飞书需求 RQ-007，见 docs/DEMO_DATA.md）：
//   demo-prepare：迁移 → 会员 → 库存 → 前台 → 结账 → 旧账 → 场景块 → 一致性自检 → 演示核对；每块已经有了就跳过，缺的补上；
//   demo-check：只读核对——一致性自检、五块都在、场景块的关键状态与 showcase-expected.json 一致；
//   demo-reset：只在独立演示库（APP_ENV=development、实例标识不是 prod / shadow / test）上用，库名写对才执行，
//               先备份并核验通过，再清空这个库、重新 demo-prepare；没有跳过备份的开关。
// 试用、正式环境一律拒绝（各块自己也拒绝），没有绕过开关。

import { businessDateOf } from '@shared/business-date';
import { INSTANCE_LABELS } from '@shared/instance';
import type { AppConfig } from '../config';
import type { Sql } from '../db';
import { migrate } from '../migrate';
import { ensureMembershipLive } from '../modules/membership';
import { loadSettings } from '../modules/settings';
import { createBackup, type BackupManifest } from '../ops/backup';
import { consistencyChecks } from '../ops/consistency';
import { fingerprintIn } from '../ops/fingerprint';
import { noAppRunning } from '../presence';
import { demoSeedTime, rememberDemoAnchor } from '../ops/demo-time';
import { seedDemo } from '../seed';
import { seedBillingDemo } from '../seed-billing';
import { seedFrontdeskDemo } from '../seed-frontdesk';
import { seedInventoryDemo } from '../seed-inventory';
import { seedLegacyDemo } from '../seed-legacy';
import expected from './showcase-expected.json' with { type: 'json' };
import membershipExpected from './membership-expected.json' with { type: 'json' };
import {
  MEMBERSHIP_DEMO_KEY,
  MEMBERSHIP_P3_DEMO_KEY,
  membershipDemoState,
  membershipTrialDemoState,
  seedMembershipDemo,
  seedMembershipTrialDemo,
  type MembershipDemoState,
  type MembershipTrialDemoState,
} from './membership-demo';
import { seedShowcaseDemo, SHOWCASE_DAILY_FIELDS, SHOWCASE_KEY, showcaseState, type ShowcaseState } from './showcase';


export interface BlockResult {
  block: string;
  written: boolean;
  detail: string;
  /** 场景块写了哪些 */
  items?: string[];
}

export interface DemoCheckLine {
  ok: boolean;
  label: string;
  detail: string;
}

export interface DemoCheckResult {
  ok: boolean;
  lines: DemoCheckLine[];
  notes: string[];
}

export interface PrepareResult {
  blocks: BlockResult[];
  notes: string[];
  check: DemoCheckResult;
}

/** 试用、正式环境拒绝（红线：不向试用库、正式库写演示数据，没有绕过开关） */
export function refuseLiveDemo(config: Pick<AppConfig, 'env'>, what = '写入演示数据') {
  if (config.env === 'production' || config.env === 'trial') {
    throw new Error(`当前是${config.env === 'trial' ? '试用' : '正式'}环境，禁止${what}。请另建独立的演示库（APP_ENV=development）再执行。`);
  }
}

const count = async (q: Promise<{ n: number }[]>) => Number((await q)[0]?.n ?? 0);

export async function demoPrepare(
  sql: Sql,
  config: AppConfig,
  opts: { previousDay?: boolean; now?: Date; log?: (line: string) => void } = {},
): Promise<PrepareResult> {
  refuseLiveDemo(config);
  const log = opts.log ?? (() => {});
  const previousDay = !!opts.previousDay;
  await migrate(sql);
  // 会员体系 v2 的已有会员上线定档（只做一次；新库没有会员，只记下上线日）
  await ensureMembershipLive({ sql, config }, opts.now);
  const blocks: BlockResult[] = [];
  const notes: string[] = [];
  const skip = (block: string) => blocks.push({ block, written: false, detail: '已存在，跳过' });

  const members = await seedDemo(sql, config);
  if (members.skipped) skip('会员与项目');
  else blocks.push({ block: '会员与项目', written: true, detail: `${members.members} 位合成会员` });

  const inv = await seedInventoryDemo(sql, config);
  if (inv.skipped) skip('库存、采购、应付');
  else blocks.push({ block: '库存、采购、应付', written: true, detail: `${inv.materials} 项物料、${inv.suppliers} 家供应商、${inv.purchaseOrders} 张采购单、${inv.docs} 张单据` });

  // 前台、结账：营业日切换后不久执行时提示，或按 --previous-day 整体放到前一个营业日（与 seed-frontdesk-demo、seed-billing-demo 同一套）
  const [tagCount] = await sql<{ demo: number; real: number }[]>`
    SELECT count(*) FILTER (WHERE is_synthetic)::int AS demo, count(*) FILTER (WHERE NOT is_synthetic)::int AS real FROM hand_tags`;
  if (tagCount!.demo > 0 && tagCount!.real === 0) skip('前台手牌与在店客人');
  else {
    const t = await demoSeedTime(sql, { timeZone: config.timezone, kind: 'frontdesk', previousDay, now: opts.now });
    if (t.warning) log(`⚠ ${t.warning}`);
    const fd = await seedFrontdeskDemo(sql, config, { now: t.now });
    if (fd.skipped) skip('前台手牌与在店客人');
    else {
      if (t.anchored && t.now) await rememberDemoAnchor(sql, t.now);
      if (t.notice) notes.push(t.notice);
      blocks.push({ block: '前台手牌与在店客人', written: true, detail: `${fd.tags} 张合成手牌、${fd.inStore} 位在店客人` });
    }
  }
  if ((await count(sql<{ n: number }[]>`SELECT count(*)::int AS n FROM checkouts WHERE note = '结账演示'`)) > 0) skip('结账、反结账、交班');
  else {
    const t = await demoSeedTime(sql, { timeZone: config.timezone, kind: 'billing', previousDay, now: opts.now });
    if (t.warning) log(`⚠ ${t.warning}`);
    const bill = await seedBillingDemo(sql, config, { now: t.now });
    if (bill.skipped) skip('结账、反结账、交班');
    else {
      if (t.notice) notes.push(t.notice);
      blocks.push({ block: '结账、反结账、交班', written: true, detail: `${bill.checkouts} 张结账单、${bill.voided} 张反结账、一个已交班的班次` });
    }
  }

  const legacy = await seedLegacyDemo(sql, config);
  if (legacy.skipped) skip('旧账对照（合成样例）');
  else blocks.push({ block: '旧账对照（合成样例）', written: true, detail: `${legacy.files.length} 份样例、${legacy.files.reduce((s, f) => s + f.rows, 0)} 行` });

  const scene = await seedShowcaseDemo(sql, config);
  if (scene.skipped) skip('场景块（客房、技师与钟房、餐饮与厨房、空间台账与底图、实时位置）');
  else {
    blocks.push({ block: '场景块（客房、技师与钟房、餐饮与厨房、空间台账与底图、实时位置）', written: true, detail: `${scene.done.length} 步`, items: scene.done });
    notes.push(...scene.notes);
    if (previousDay) notes.push('场景块走正式接口、按执行当时的时间写，不随 --previous-day 前移');
  }

  // 会员体系（v0.7.24）：单独一个标记，已经准备过场景块的演示库也会补上
  const membership = await seedMembershipDemo(sql, config, { now: opts.now });
  if (membership.skipped) skip(MEMBERSHIP_BLOCK);
  else {
    blocks.push({ block: MEMBERSHIP_BLOCK, written: true, detail: `${membership.done.length} 步`, items: membership.done });
    notes.push(...membership.notes);
  }
  // 会员折扣与邀请体验（v0.7.25）：单独一个标记，已经准备过会员体系块的演示库也会补上
  const trialDemo = await seedMembershipTrialDemo(sql, config, { now: opts.now });
  if (trialDemo.skipped) skip(MEMBERSHIP_P3_BLOCK);
  else {
    blocks.push({ block: MEMBERSHIP_P3_BLOCK, written: true, detail: `${trialDemo.done.length} 步`, items: trialDemo.done });
    notes.push(...trialDemo.notes);
  }

  return { blocks, notes, check: await demoCheck(sql, config) };
}

const MEMBERSHIP_BLOCK = '会员体系（到期提醒、补充期、降档的演示会员，本店权益清单与本月的券）';
const MEMBERSHIP_P3_BLOCK = '会员折扣与邀请体验（发布包房折扣 QY-011，邀请人与体验中的会员）';

/** 对象按键排序后再比（数据库读出来的顺序不固定） */
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]));
  return v;
}

function fmt(v: unknown): string {
  if (Array.isArray(v)) return v.length ? v.map((x) => (x && typeof x === 'object' ? Object.values(x).map(String).join(' ') : String(x))).join('、') : '（无）';
  if (v && typeof v === 'object') return Object.entries(v).map(([k, x]) => `${k} ${x && typeof x === 'object' ? JSON.stringify(x) : String(x)}`).join('、');
  return String(v);
}

const SHOWCASE_FIELDS: [keyof ShowcaseState, string][] = [
  ['guests', '在店客人'],
  ['rooms', '客房房态'],
  ['sessions', '钟单'],
  ['technicians', '技师在岗'],
  ['kitchen', '厨房出品'],
  ['soldOut', '估清'],
  ['table', '桌台'],
  ['floorplan', '在用底图与样例房间轮廓'],
  ['locations', '平面图上的人员位置'],
  ['readers', '刷卡点'],
  ['usages', '派对房使用单'],
  ['guide', '对客导览的区域分类与图标'],
  ['coupons', '券模板、会员的券与无记名券'],
];

const MEMBERSHIP_FIELDS: [keyof MembershipDemoState, string][] = [
  ['members', '演示会员的档阶与状态'],
  ['published', '发布的本店权益'],
  ['monthCoupons', '演示会员本月的项目券'],
];

const MEMBERSHIP_P3_FIELDS: [keyof MembershipTrialDemoState, string][] = [
  ['discounts', '发布的会员折扣'],
  ['inviterGrade', '邀请人的档级'],
  ['trials', '体验中的会员'],
];

/** 只读核对：任何一项不一致都 ok = false，写明哪一项、期望与实际 */
export async function demoCheck(sql: Sql, config: AppConfig): Promise<DemoCheckResult> {
  refuseLiveDemo(config, '核对演示数据（这里不该有演示数据；一致性自检请用 check）');
  const lines: DemoCheckLine[] = [];
  const notes: string[] = [];
  const checks = await consistencyChecks(sql, config.timezone);
  const failed = checks.filter((c) => !c.ok);
  lines.push({
    ok: failed.length === 0,
    label: '一致性自检（check）',
    detail: failed.length ? failed.map((c) => `${c.label}：${c.detail}`).join('；') : `${checks.length} 项全部一致`,
  });
  const [n] = await sql<{ members: number; materials: number; tags: number; checkouts: number; legacy: number }[]>`
    SELECT (SELECT count(*) FROM members WHERE is_synthetic)::int AS members,
           (SELECT count(*) FROM materials WHERE is_synthetic)::int AS materials,
           (SELECT count(*) FROM hand_tags WHERE is_synthetic)::int AS tags,
           (SELECT count(*) FROM checkouts WHERE note = '结账演示')::int AS checkouts,
           (SELECT count(*) FROM legacy_imports WHERE status = 'active')::int AS legacy`;
  for (const [label, value, unit] of [
    // 各块建的合成会员合计（会员块之外，前台、结账两块也建会员），与准备时会员块写的人数不同（main 定时测试报告）
    ['会员演示数据', n!.members, '位合成会员（各块合计）'],
    ['库存演示数据', n!.materials, '项合成物料'],
    ['前台演示数据', n!.tags, '张合成手牌'],
    ['结账演示数据', n!.checkouts, '张演示结账单'],
    ['旧账合成样例', n!.legacy, '份导入'],
  ] as const) {
    lines.push({ ok: value > 0, label, detail: value > 0 ? `${value} ${unit}` : '没有：请执行 demo-prepare' });
  }
  const [marker] = await sql<{ value: { businessDate?: string } }[]>`SELECT value FROM settings WHERE key = ${SHOWCASE_KEY}`;
  if (!marker) {
    lines.push({ ok: false, label: '场景块', detail: '还没有准备：请执行 demo-prepare' });
    return { ok: false, lines, notes };
  }
  const state = await showcaseState(sql, config.timezone);
  const { businessDayStartHour } = await loadSettings(sql);
  const today = businessDateOf(new Date(), config.timezone, businessDayStartHour);
  const sameDay = marker.value.businessDate === today;
  if (!sameDay) notes.push(`场景块是 ${marker.value.businessDate} 营业日准备的：技师在岗、估清按天清零，今天不核对这两项（要当天的新场景用 demo-reset 重建）`);
  const want = expected as unknown as ShowcaseState;
  for (const [field, label] of SHOWCASE_FIELDS) {
    if (!sameDay && (SHOWCASE_DAILY_FIELDS as readonly string[]).includes(field)) continue;
    const same = JSON.stringify(canon(want[field])) === JSON.stringify(canon(state[field]));
    lines.push({ ok: same, label: `场景块 · ${label}`, detail: same ? fmt(state[field]) : `期望 ${fmt(want[field])}；实际 ${fmt(state[field])}` });
  }
  // 会员体系（v0.7.24）：到期、补充期按日期往前走，只在准备的那个营业日核对
  const [membershipMarker] = await sql<{ value: { businessDate?: string } }[]>`SELECT value FROM settings WHERE key = ${MEMBERSHIP_DEMO_KEY}`;
  if (!membershipMarker) {
    lines.push({ ok: false, label: '会员体系演示', detail: '还没有准备：请执行 demo-prepare' });
  } else if (membershipMarker.value.businessDate !== today) {
    notes.push(`会员体系演示是 ${membershipMarker.value.businessDate} 营业日准备的：到期、补充期按日期往前走，今天不核对这一块（要当天的新状态用 demo-reset 重建）`);
  } else {
    const mState = await membershipDemoState(sql, config.timezone);
    const mWant = membershipExpected as unknown as MembershipDemoState;
    for (const [field, label] of MEMBERSHIP_FIELDS) {
      const same = JSON.stringify(canon(mWant[field])) === JSON.stringify(canon(mState[field]));
      lines.push({ ok: same, label: `会员体系演示 · ${label}`, detail: same ? fmt(mState[field]) : `期望 ${fmt(mWant[field])}；实际 ${fmt(mState[field])}` });
    }
  }
  // 会员折扣与邀请体验（v0.7.25）：体验 7 天后到期，只在准备的那个营业日核对
  const [p3Marker] = await sql<{ value: { businessDate?: string } }[]>`SELECT value FROM settings WHERE key = ${MEMBERSHIP_P3_DEMO_KEY}`;
  if (!p3Marker) {
    lines.push({ ok: false, label: '会员折扣与邀请体验演示', detail: '还没有准备：请执行 demo-prepare' });
  } else if (p3Marker.value.businessDate !== today) {
    notes.push(`会员折扣与邀请体验演示是 ${p3Marker.value.businessDate} 营业日准备的：体验按日期到期，今天不核对这一块`);
  } else {
    const pState = await membershipTrialDemoState(sql);
    const pWant = (membershipExpected as unknown as { p3: MembershipTrialDemoState }).p3;
    for (const [field, label] of MEMBERSHIP_P3_FIELDS) {
      const same = JSON.stringify(canon(pWant[field])) === JSON.stringify(canon(pState[field]));
      lines.push({ ok: same, label: `会员折扣与邀请体验 · ${label}`, detail: same ? fmt(pState[field]) : `期望 ${fmt(pWant[field])}；实际 ${fmt(pState[field])}` });
    }
  }
  return { ok: lines.every((l) => l.ok), lines, notes };
}

/** 能用 demo-reset 的库：APP_ENV=development、实例标识不是正式服 / 影子运行 / 测试服 */
export function assertResettable(config: Pick<AppConfig, 'env' | 'instance'>) {
  refuseLiveDemo(config, '重建演示库');
  if (config.env !== 'development') throw new Error(`demo-reset 只能在 APP_ENV=development 的独立演示库上用（当前是 ${config.env}）`);
  if (config.instance === 'prod' || config.instance === 'shadow' || config.instance === 'test') {
    throw new Error(`实例标识是「${INSTANCE_LABELS[config.instance]}」（YUZU_INSTANCE=${config.instance}）：demo-reset 只能用在独立演示库上`);
  }
}

export async function demoReset(
  sql: Sql,
  config: AppConfig,
  opts: { confirm: string | undefined; backupDir: string; backup?: typeof createBackup; log?: (line: string) => void },
): Promise<{ backup: BackupManifest; prepare: PrepareResult }> {
  assertResettable(config);
  const log = opts.log ?? (() => {});
  const [{ db } = { db: '' }] = await sql<{ db: string }[]>`SELECT current_database() AS db`;
  if (!opts.confirm || opts.confirm !== db) throw new Error(`demo-reset 会清空数据库「${db}」：确认无误后加 --confirm ${db}（库名写对才执行）`);
  // 应用还开着就不清库（v0.7.19，main 定时测试报告 P2：原来只靠锁表，应用开着但空闲时照样清库）：
  // 应用进程一直拿着「应用在跑」的共享锁（src/server/presence.ts），这里先查一次、免得白做备份，清库的事务里再查一次
  const APP_RUNNING = '应用还开着（有应用进程连着这个库），没有清库；请先停掉应用再执行';
  if (!(await sql.begin((tx) => noAppRunning(tx)))) throw new Error(`${APP_RUNNING}。还没有备份。`);
  // 清库的前提（备份不成功就不清库）：pg_dump 成功写出文件（记下大小与摘要），并在临时库完整恢复、算出数据指纹
  const backup = await (opts.backup ?? createBackup)(config, opts.backupDir, 'demo-reset');
  if (!backup.verified) throw new Error(`备份没有核验通过（${backup.verifyError ?? '原因不明'}），没有清库。备份文件：${backup.file}`);
  log(`✓ 已备份（${(backup.bytes / 1024).toFixed(0)} KB），在临时库恢复核验通过：${backup.file}`);
  // 清库在一个事务里：先确认没有应用开着，再给 public 下所有表加共享锁（挡住写入；别的连接还在写、等锁 10 秒拿不到就放弃），再算一次数据指纹，
  // 与备份恢复出来的指纹相同才删——备份里就是现在的全部数据。备份之后有过写入的指纹对不上，拒绝；
  // 锁住之后再来的写入被挡在锁外，删库后失败，不会提交（Codex 复审 174fa29：原来只比对备份前的指纹，备份到删库之间的写入会悄悄丢掉）
  try {
    await sql.begin(async (tx) => {
      // 备份期间启动了应用：不清库；拿到锁之后（到事务结束）新启动的应用等在拿锁那一步
      if (!(await noAppRunning(tx))) throw new Error(`${APP_RUNNING}。备份已做好：${backup.file}`);
      await tx`SET LOCAL lock_timeout = '10s'`;
      const tables = await tx<{ name: string }[]>`
        SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname COLLATE "C"`;
      if (tables.length) await tx.unsafe(`LOCK TABLE ${tables.map((t) => `public."${t.name.replace(/"/g, '""')}"`).join(', ')} IN SHARE MODE`);
      const now = await fingerprintIn(tx);
      if (now.digest !== backup.fingerprintDigest) {
        throw new Error(`备份之后库里又有写入（现在的数据指纹与备份恢复出来的不同，应用没停？），没有清库。请停掉应用后再执行。备份文件：${backup.file}`);
      }
      await tx.unsafe('DROP SCHEMA public CASCADE');
      await tx.unsafe('CREATE SCHEMA public');
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === '55P03') throw new Error(`数据库正被别的连接使用（有连接正在写），没有清库；等它写完或断开后再执行。备份已做好：${backup.file}`);
    throw error;
  }
  log('清库前锁住所有表再核对：数据指纹与备份一致');
  log(`已清空数据库「${db}」，重新准备演示数据…`);
  return { backup, prepare: await demoPrepare(sql, config, { log }) };
}
