// demo-prepare / demo-check / demo-reset 与场景块（v0.7.18，飞书需求 RQ-007，docs/DEMO_DATA.md）：
//   · 内置的样例台账与 docs/data 逐字一致；
//   · 试用 / 正式环境一律拒绝，什么都不写；
//   · 新库准备：中途出错再执行一次接着补（操作编号原样重发，不重复接待、派钟、点单），结果与 showcase-expected.json 一致，自检全过；
//   · 再执行一次全部跳过，数据指纹不变；
//   · demo-check 发现与预期不同的地方；场景块与已有记录冲突时整块不写、列出冲突；
//   · demo-reset：环境、实例标识、库名不对时拒绝，备份没核验通过时不清库；应用开着（空闲也算）时不清库；通过时清库重建。

import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { businessDateOf } from '../src/shared/business-date';
import { loadConfig, type AppConfig } from '../src/server/config';
import { demoCheck, demoPrepare, demoReset } from '../src/server/demo/prepare';
import { runMinuteJobs } from '../src/server/jobs';
import expected from '../src/server/demo/showcase-expected.json' with { type: 'json' };
import { seedShowcaseDemo, ShowcaseConflictError, SHOWCASE_KEY, showcaseState } from '../src/server/demo/showcase';
import { SAMPLE_SPACES_CSV, SAMPLE_ZONES_CSV } from '../src/server/demo/space-sample';
import { loadSettings } from '../src/server/modules/settings';
import { createStaff } from '../src/server/modules/staff';
import { DEMO_PASSWORD } from '../src/server/seed';
import type { BackupManifest } from '../src/server/ops/backup';
import { computeFingerprint } from '../src/server/ops/fingerprint';
import { APP_PRESENCE_LOCK, holdAppPresence, type AppPresence } from '../src/server/presence';
import { setup, type TestContext } from './helpers';

let ctx: TestContext;
let dev: AppConfig;
beforeAll(async () => {
  ctx = await setup();
  dev = loadConfig({ databaseUrl: ctx.config.databaseUrl, env: 'development', logLevel: 'silent' });
});
afterAll(async () => ctx.close());

const fingerprint = async () => (await computeFingerprint(ctx.sql)).digest;
const dbName = async () => (await ctx.sql<{ db: string }[]>`SELECT current_database() AS db`)[0]!.db;
const { 说明: _note, ...want } = expected;
/** 代替真实备份（真实备份的恢复核验见 tests/backup.test.ts 与 CI「演示数据」job）：指纹默认按备份那一刻的库算 */
const fakeBackup = (verified: boolean, digest?: string) => async (): Promise<BackupManifest> => ({
  file: '/backups/yuzu-demo-reset.dump',
  label: 'demo-reset',
  createdAt: new Date().toISOString(),
  bytes: 1024,
  sha256: '0',
  app: { version: 'test', commit: 'test', instance: 'dev' },
  verified,
  verifyError: verified ? undefined : '临时库恢复失败（测试）',
  fingerprintDigest: verified ? (digest ?? (await fingerprint())) : null,
});

describe('内置的样例台账', () => {
  it('与 docs/data 的样例区域、样例空间逐字一致（打包后的命令行读不到 docs/data）', async () => {
    const read = async (name: string) => (await readFile(new URL(`../docs/data/${name}`, import.meta.url), 'utf8')).replace(/^﻿/, '').replace(/\r\n/g, '\n');
    expect(SAMPLE_ZONES_CSV.trim()).toBe((await read('space-zones-sample.csv')).trim());
    expect(SAMPLE_SPACES_CSV.trim()).toBe((await read('space-ledger-sample.csv')).trim());
  });
});

describe('演示数据准备', () => {
  it('试用、正式环境：demo-prepare、demo-check、场景块、demo-reset 一律拒绝，什么都不写', async () => {
    const before = await fingerprint();
    for (const env of ['trial', 'production'] as const) {
      const live = loadConfig({ databaseUrl: ctx.config.databaseUrl, env, logLevel: 'silent' });
      const word = env === 'trial' ? /试用/ : /正式/;
      await expect(demoPrepare(ctx.sql, live)).rejects.toThrow(word);
      await expect(demoCheck(ctx.sql, live)).rejects.toThrow(word);
      await expect(seedShowcaseDemo(ctx.sql, live)).rejects.toThrow(word);
      await expect(demoReset(ctx.sql, live, { confirm: 'x', backupDir: '/nonexistent', backup: fakeBackup(true) })).rejects.toThrow(word);
    }
    expect(await fingerprint()).toBe(before);
  });

  it('「收款前必须先开班」临时关掉再原样恢复（连同修改时间），规则本身与数据指纹都不变', async () => {
    await ctx.sql`UPDATE settings SET value = 'true'::jsonb, updated_at = now() - interval '1 day' WHERE key = 'require_open_shift'`;
    const before = await fingerprint();
    const [rule] = await ctx.sql<{ value: unknown; at: string }[]>`SELECT value, updated_at::text AS at FROM settings WHERE key = 'require_open_shift'`;
    const { withShiftOptional } = await import('../src/server/demo/shift-rule');
    const inside = await withShiftOptional(ctx.sql, ctx.config, async () => (await ctx.sql<{ value: unknown }[]>`SELECT value FROM settings WHERE key = 'require_open_shift'`)[0]!.value);
    expect(inside).toBe(false);
    expect(await ctx.sql`SELECT value, updated_at::text AS at FROM settings WHERE key = 'require_open_shift'`).toEqual([rule]);
    expect(await fingerprint()).toBe(before);
    await ctx.sql`UPDATE settings SET value = 'false'::jsonb WHERE key = 'require_open_shift'`;
  });

  it('新库：第一次中途出错，再执行一次接着补（不重复接待、派钟、点单）；结果与预期一致，自检全过', async () => {
    // 上次中途退出留下的技师：演示店主用正式接口建好了 D04、还没来得及打演示标记（Codex 复审 174fa29）——不当冲突，补上标记
    const ownerId = await createStaff(ctx.sql, { username: 'linlan', displayName: '林岚', role: 'owner', password: DEMO_PASSWORD, mustChangePassword: false });
    await ctx.sql`
      INSERT INTO technicians (tech_no, name, gender, grade, note, created_by) VALUES ('D04', '演示技师·许', 'male', 'premium', '演示场景', ${ownerId})`;
    // 预先放一道已估清的「演示果汁」：场景块照常用它（按名称认已有的菜），桌台点单时被估清拦下、中途出错
    const [item] = await ctx.sql<{ id: number }[]>`
      INSERT INTO service_items (name, category, price) VALUES ('演示果汁', '餐饮', 2200) RETURNING id`;
    const today = businessDateOf(new Date(), ctx.config.timezone, (await loadSettings(ctx.sql)).businessDayStartHour);
    await ctx.sql`INSERT INTO dish_limits (item_id, business_date, remaining, updated_by) VALUES (${item!.id}, ${today}, 0, ${ctx.ownerId})`;
    await expect(demoPrepare(ctx.sql, ctx.config)).rejects.toThrow(/演示场景：POST \/api\/dining\/tables\/sessions\/\d+\/orders 没有成功/);
    const [marker] = await ctx.sql`SELECT 1 FROM settings WHERE key = ${SHOWCASE_KEY}`;
    expect(marker).toBeUndefined();
    const partial = await showcaseState(ctx.sql, ctx.config.timezone);
    expect(partial.guests).toHaveLength(4);
    expect(partial.sessions).toHaveLength(3);
    // 派对房的开单在桌台点单之后：还没开
    expect(partial.usages).toEqual([]);

    await ctx.sql`DELETE FROM dish_limits WHERE item_id = ${item!.id}`;
    const r = await demoPrepare(ctx.sql, ctx.config);
    // 场景块第一次中途出错，会员体系块、会员折扣与邀请体验（在它之后）也没有执行：这次三块都写
    expect(r.blocks.map((b) => b.written)).toEqual([false, false, false, false, false, true, true, true]);
    expect(r.check.lines.filter((l) => !l.ok)).toEqual([]);
    expect(r.check.ok).toBe(true);
    expect(await showcaseState(ctx.sql, ctx.config.timezone)).toEqual(want);
    // 没有重复：每位演示客人一张在店的来访、每张钟单一张
    const [dup] = await ctx.sql<{ visits: number; sessions: number; stays: number; tables: number }[]>`
      SELECT (SELECT count(*) FROM visits WHERE guest_label LIKE '演示客人%')::int AS visits,
             (SELECT count(*) FROM technician_sessions s JOIN technicians t ON t.id = s.technician_id WHERE t.tech_no LIKE 'D0%')::int AS sessions,
             (SELECT count(*) FROM room_stays)::int AS stays,
             (SELECT count(*) FROM table_sessions)::int AS tables`;
    expect(dup).toEqual({ visits: 4, sessions: 3, stays: 1, tables: 1 });
    const [usages] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM space_usages`;
    expect(usages!.n).toBe(1);
    // 临时会话用完就删；中途的进度记录清掉
    const [left] = await ctx.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM sessions s JOIN staff st ON st.id = s.staff_id WHERE st.username IN ('linlan', 'xiaozhou')`;
    expect(left!.n).toBe(0);
    expect(await ctx.sql`SELECT 1 FROM settings WHERE key = 'demo_showcase_progress'`).toHaveLength(0);
    // 技师打上合成标记；场景块的业务都按正式流程记了审计
    const synth = await ctx.sql<{ techNo: string }[]>`SELECT tech_no FROM technicians WHERE is_synthetic ORDER BY tech_no`;
    expect(synth.map((t) => t.techNo)).toEqual(['D01', 'D02', 'D03', 'D04']);
    // 从零准备两遍：本机约 6 秒，慢的电脑整套串行跑时会超过默认的 30 秒（Codex 在 main v0.7.20 上的首轮），单独放宽
  }, 120_000);

  it('再执行一次全部跳过，数据指纹不变', async () => {
    const before = await fingerprint();
    const r = await demoPrepare(ctx.sql, ctx.config);
    expect(r.blocks.every((b) => !b.written)).toBe(true);
    expect(r.check.ok).toBe(true);
    expect(await fingerprint()).toBe(before);
  });

  it('准备完以后应用第一次跑每分钟的自动任务不改数据（demo-prepare 最后已经照样跑过一次，main 定时测试 v0.7.29）', async () => {
    // 原来会员折扣块发布 QY-011 在当天的权益发放之后，权益清单变了，应用启动后第一分钟又跑一次（一张没多发，
    // 但运行记录改了、指纹变了，日志写的累计数看起来像又发了一轮）
    const before = await fingerprint();
    const lines: string[] = [];
    await runMinuteJobs({ sql: ctx.sql, config: ctx.config }, { info: (m) => lines.push(m), error: (m) => lines.push(`出错：${m}`) });
    expect(lines).toEqual([]);
    expect(await fingerprint()).toBe(before);
  });

  it('demo-check 写明与预期不同的地方；场景块与已有记录冲突时整块不写、列出冲突', async () => {
    await ctx.sql`UPDATE rooms SET housekeeping = 'clean' WHERE room_no = 'W302'`;
    const check = await demoCheck(ctx.sql, ctx.config);
    expect(check.ok).toBe(false);
    const bad = check.lines.filter((l) => !l.ok);
    expect(bad.map((l) => l.label)).toEqual(['场景块 · 客房房态']);
    expect(bad[0]!.detail).toContain('期望 W301 occupied、W302 dirty');
    expect(bad[0]!.detail).toContain('实际 W301 occupied、W302 clean');

    // 当成「还没准备场景块」的库：工号 D01 换成了一位不带演示标记的技师、T301 改成了别的业态、实时位置被关了；
    // D02 只是没有演示标记（名字、备注、建的人都是演示场景的，像上次中途退出），不算冲突
    await ctx.sql`DELETE FROM settings WHERE key = ${SHOWCASE_KEY}`;
    await ctx.sql`UPDATE technicians SET is_synthetic = false, name = '张师傅' WHERE tech_no = 'D01'`;
    await ctx.sql`UPDATE technicians SET is_synthetic = false WHERE tech_no = 'D02'`;
    await ctx.sql`UPDATE spaces SET business_type = '足浴' WHERE code = 'T301'`;
    await ctx.sql`UPDATE settings SET value = value || '{"enabled": false}'::jsonb WHERE key = 'location_rules'`;
    const before = await fingerprint();
    const error = await seedShowcaseDemo(ctx.sql, ctx.config).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ShowcaseConflictError);
    expect((error as ShowcaseConflictError).conflicts).toEqual([
      '台账里的 T301 是「足浴」业态（演示场景要「SPA」）',
      '工号 D01 是一位不带「演示」标记的技师（张师傅）',
      '后台把「实时位置」功能关了：演示场景要用它，请到后台打开',
    ]);
    expect((error as Error).message).toContain('demo-reset');
    expect(await fingerprint()).toBe(before);
    expect((await demoCheck(ctx.sql, ctx.config)).lines.at(-1)).toEqual({ ok: false, label: '场景块', detail: '还没有准备：请执行 demo-prepare' });
  });

  it('demo-reset：环境、实例标识、库名不对时拒绝；备份没核验通过、恢复出来的数据与现在的库不同、备份之后又有写入时都不清库', async () => {
    const before = await fingerprint();
    const db = await dbName();
    const opts = { backupDir: '/nonexistent', backup: fakeBackup(true) };
    await expect(demoReset(ctx.sql, ctx.config, { ...opts, confirm: db })).rejects.toThrow(/APP_ENV=development/);
    for (const instance of ['prod', 'shadow', 'test'] as const) {
      await expect(demoReset(ctx.sql, { ...dev, instance }, { ...opts, confirm: db })).rejects.toThrow(`YUZU_INSTANCE=${instance}`);
    }
    await expect(demoReset(ctx.sql, dev, { ...opts, confirm: undefined })).rejects.toThrow(`--confirm ${db}`);
    await expect(demoReset(ctx.sql, dev, { ...opts, confirm: `${db}_x` })).rejects.toThrow(`--confirm ${db}`);
    await expect(demoReset(ctx.sql, dev, { ...opts, confirm: db, backup: fakeBackup(false) })).rejects.toThrow(/备份没有核验通过.*没有清库/);
    // 备份恢复出来的数据与现在的库对不上：不清库
    await expect(demoReset(ctx.sql, dev, { ...opts, confirm: db, backup: fakeBackup(true, 'f'.repeat(64)) })).rejects.toThrow(/备份之后库里又有写入.*没有清库/);
    expect(await fingerprint()).toBe(before);
    // 备份（快照）之后、清库之前又有写入（应用没停）：锁住所有表后再算的指纹与备份不同，不清库，这笔写入还在（Codex 复审 174fa29）
    const backupThenWrite = async (): Promise<BackupManifest> => {
      const m = await fakeBackup(true)();
      await ctx.sql`INSERT INTO settings (key, value) VALUES ('test_write_after_backup', '1'::jsonb)`;
      return m;
    };
    await expect(demoReset(ctx.sql, dev, { ...opts, confirm: db, backup: backupThenWrite })).rejects.toThrow(/备份之后库里又有写入.*没有清库/);
    expect(await ctx.sql`SELECT 1 FROM settings WHERE key = 'test_write_after_backup'`).toHaveLength(1);
    await ctx.sql`DELETE FROM settings WHERE key = 'test_write_after_backup'`;
    expect(await fingerprint()).toBe(before);
  });

  it('demo-reset：应用开着（只拿着「应用在跑」的标记、什么都不写）时备份前就拒绝；备份期间才启动的应用在清库的事务里拦下；标记的连接断了会重新拿（main 定时测试报告 P2）', async () => {
    const before = await fingerprint();
    const db = await dbName();
    let backups = 0;
    const counted = async () => {
      backups++;
      return fakeBackup(true)();
    };
    /** 这个库里拿着标记（共享锁）的会话数 */
    const holders = async () =>
      (
        await ctx.sql<{ n: number }[]>`
          WITH k AS (SELECT hashtextextended(${APP_PRESENCE_LOCK}, 0) AS v)
          SELECT count(*)::int AS n FROM pg_locks l, k
          WHERE l.locktype = 'advisory' AND l.granted AND l.mode = 'ShareLock' AND l.objsubid = 1
            AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
            AND l.classid = ((k.v >> 32) & 4294967295)::oid AND l.objid = (k.v & 4294967295)::oid`
      )[0]!.n;
    // 开着、空闲的应用：业务连接池里没有在写的连接（原来只靠锁表，这时照样清库），只有标记
    // 每次检查最多等 3 秒（默认 60 秒）：连接断的那一刻发出的查询可能等不到回应，换新连接再拿
    const app = await holdAppPresence(ctx.config.databaseUrl, { attemptMs: 3000 });
    try {
      expect(await holders()).toBe(1);
      await expect(demoReset(ctx.sql, dev, { confirm: db, backupDir: '/nonexistent', backup: counted })).rejects.toThrow(/应用还开着.*没有清库.*还没有备份/);
      expect(backups).toBe(0);
      // 标记的专用连接断了（数据库重启的效果）：锁跟着没了，下一次检查在新连接上重新拿
      const [conn] = await ctx.sql<{ pid: number }[]>`
        SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'yuzu-app-presence'`;
      await ctx.sql`SELECT pg_terminate_backend(${conn!.pid})`;
      for (let i = 0; i < 50 && (await holders()) > 0; i++) await new Promise((r) => setTimeout(r, 100));
      expect(await holders()).toBe(0);
      await app.ensure();
      expect(await holders()).toBe(1);
      await expect(demoReset(ctx.sql, dev, { confirm: db, backupDir: '/nonexistent', backup: counted })).rejects.toThrow(/应用还开着/);
      expect(backups).toBe(0);
    } finally {
      await app.release();
    }
    expect(await holders()).toBe(0);
    // 备份期间启动了应用：清库的事务里再查一次，不清库，备份已做好
    let late: AppPresence | undefined;
    const appStartsDuringBackup = async () => {
      const m = await counted();
      late = await holdAppPresence(ctx.config.databaseUrl);
      return m;
    };
    try {
      await expect(demoReset(ctx.sql, dev, { confirm: db, backupDir: '/nonexistent', backup: appStartsDuringBackup })).rejects.toThrow(
        /应用还开着.*没有清库.*备份已做好/,
      );
      expect(backups).toBe(1);
    } finally {
      await late?.release();
    }
    expect(await fingerprint()).toBe(before);
  });

  it('demo-reset：备份核验通过后清空这个库、从零重新准备，结果与预期一致', async () => {
    const lines: string[] = [];
    const db = await dbName();
    const r = await demoReset(ctx.sql, dev, { confirm: db, backupDir: '/nonexistent', backup: fakeBackup(true), log: (l) => lines.push(l) });
    expect(lines[0]).toContain('在临时库恢复核验通过');
    expect(lines[1]).toContain('清库前锁住所有表再核对：数据指纹与备份一致');
    expect(r.prepare.blocks.every((b) => b.written)).toBe(true);
    expect(r.prepare.check.ok).toBe(true);
    expect(await showcaseState(ctx.sql, ctx.config.timezone)).toEqual(want);
    // 冲突造的改动都没了：清库重建
    const [t301] = await ctx.sql<{ businessType: string }[]>`SELECT business_type FROM spaces WHERE code = 'T301'`;
    expect(t301!.businessType).toBe('SPA');
    // 清库是先把 public 改名挪开、提交后再分批删（v0.7.30，一句 DROP SCHEMA 锁太多）：挪开的旧模式不留下
    expect(await ctx.sql`SELECT 1 FROM pg_namespace WHERE nspname = 'yuzu_demo_reset_old'`).toHaveLength(0);
    // 清库、跑全部迁移、从零准备：本机约 7 秒，慢的电脑整套串行跑时会超过默认的 30 秒（Codex 在 main v0.7.20 上的首轮），单独放宽
  }, 120_000);
});
