// demo-prepare / demo-check / demo-reset 与场景块（v0.7.18，飞书需求 RQ-007，docs/DEMO_DATA.md）：
//   · 内置的样例台账与 docs/data 逐字一致；
//   · 试用 / 正式环境一律拒绝，什么都不写；
//   · 新库准备：中途出错再执行一次接着补（操作编号原样重发，不重复接待、派钟、点单），结果与 showcase-expected.json 一致，自检全过；
//   · 再执行一次全部跳过，数据指纹不变；
//   · demo-check 发现与预期不同的地方；场景块与已有记录冲突时整块不写、列出冲突；
//   · demo-reset：环境、实例标识、库名不对时拒绝，备份没核验通过时不清库；通过时清库重建。

import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { businessDateOf } from '../src/shared/business-date';
import { loadConfig, type AppConfig } from '../src/server/config';
import { demoCheck, demoPrepare, demoReset } from '../src/server/demo/prepare';
import expected from '../src/server/demo/showcase-expected.json' with { type: 'json' };
import { seedShowcaseDemo, ShowcaseConflictError, SHOWCASE_KEY, showcaseState } from '../src/server/demo/showcase';
import { SAMPLE_SPACES_CSV, SAMPLE_ZONES_CSV } from '../src/server/demo/space-sample';
import { loadSettings } from '../src/server/modules/settings';
import type { BackupManifest } from '../src/server/ops/backup';
import { computeFingerprint } from '../src/server/ops/fingerprint';
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
    // 预先放一道已估清的「演示果汁」：场景块照常用它（按名称认已有的菜），桌台点单时被估清拦下、中途出错
    const [item] = await ctx.sql<{ id: number }[]>`
      INSERT INTO service_items (name, category, price) VALUES ('演示果汁', '餐饮', 2200) RETURNING id`;
    const today = businessDateOf(new Date(), ctx.config.timezone, (await loadSettings(ctx.sql)).businessDayStartHour);
    await ctx.sql`INSERT INTO dish_limits (item_id, business_date, remaining, updated_by) VALUES (${item!.id}, ${today}, 0, ${ctx.ownerId})`;
    await expect(demoPrepare(ctx.sql, ctx.config)).rejects.toThrow(/演示场景：POST \/api\/dining\/tables\/sessions\/\d+\/orders 没有成功/);
    const [marker] = await ctx.sql`SELECT 1 FROM settings WHERE key = ${SHOWCASE_KEY}`;
    expect(marker).toBeUndefined();
    const partial = await showcaseState(ctx.sql, ctx.config.timezone);
    expect(partial.guests).toHaveLength(3);
    expect(partial.sessions).toHaveLength(3);

    await ctx.sql`DELETE FROM dish_limits WHERE item_id = ${item!.id}`;
    const r = await demoPrepare(ctx.sql, ctx.config);
    expect(r.blocks.map((b) => b.written)).toEqual([false, false, false, false, false, true]);
    expect(r.check.lines.filter((l) => !l.ok)).toEqual([]);
    expect(r.check.ok).toBe(true);
    expect(await showcaseState(ctx.sql, ctx.config.timezone)).toEqual(want);
    // 没有重复：每位演示客人一张在店的来访、每张钟单一张
    const [dup] = await ctx.sql<{ visits: number; sessions: number; stays: number; tables: number }[]>`
      SELECT (SELECT count(*) FROM visits WHERE guest_label LIKE '演示客人%')::int AS visits,
             (SELECT count(*) FROM technician_sessions s JOIN technicians t ON t.id = s.technician_id WHERE t.tech_no LIKE 'D0%')::int AS sessions,
             (SELECT count(*) FROM room_stays)::int AS stays,
             (SELECT count(*) FROM table_sessions)::int AS tables`;
    expect(dup).toEqual({ visits: 3, sessions: 3, stays: 1, tables: 1 });
    // 临时会话用完就删；中途的进度记录清掉
    const [left] = await ctx.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM sessions s JOIN staff st ON st.id = s.staff_id WHERE st.username IN ('linlan', 'xiaozhou')`;
    expect(left!.n).toBe(0);
    expect(await ctx.sql`SELECT 1 FROM settings WHERE key = 'demo_showcase_progress'`).toHaveLength(0);
    // 技师打上合成标记；场景块的业务都按正式流程记了审计
    const synth = await ctx.sql<{ techNo: string }[]>`SELECT tech_no FROM technicians WHERE is_synthetic ORDER BY tech_no`;
    expect(synth.map((t) => t.techNo)).toEqual(['D01', 'D02', 'D03', 'D04']);
  });

  it('再执行一次全部跳过，数据指纹不变', async () => {
    const before = await fingerprint();
    const r = await demoPrepare(ctx.sql, ctx.config);
    expect(r.blocks.every((b) => !b.written)).toBe(true);
    expect(r.check.ok).toBe(true);
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

    // 当成「还没准备场景块」的库：工号 D01 被改成不带演示标记的技师、T301 改成了别的业态、实时位置被关了
    await ctx.sql`DELETE FROM settings WHERE key = ${SHOWCASE_KEY}`;
    await ctx.sql`UPDATE technicians SET is_synthetic = false WHERE tech_no = 'D01'`;
    await ctx.sql`UPDATE spaces SET business_type = '足浴' WHERE code = 'T301'`;
    await ctx.sql`UPDATE settings SET value = value || '{"enabled": false}'::jsonb WHERE key = 'location_rules'`;
    const before = await fingerprint();
    const error = await seedShowcaseDemo(ctx.sql, ctx.config).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ShowcaseConflictError);
    expect((error as ShowcaseConflictError).conflicts).toEqual([
      '台账里的 T301 是「足浴」业态（演示场景要「SPA」）',
      '工号 D01 是一位不带「演示」标记的技师（演示技师·林）',
      '后台把「实时位置」功能关了：演示场景要用它，请到后台打开',
    ]);
    expect((error as Error).message).toContain('demo-reset');
    expect(await fingerprint()).toBe(before);
    expect((await demoCheck(ctx.sql, ctx.config)).lines.at(-1)).toEqual({ ok: false, label: '场景块', detail: '还没有准备：请执行 demo-prepare' });
  });

  it('demo-reset：环境、实例标识、库名不对时拒绝；备份没核验通过、或恢复出来的数据与现在的库不同时不清库', async () => {
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
    // 备份恢复出来的数据与现在的库对不上（备份期间有写入）：也不清库
    await expect(demoReset(ctx.sql, dev, { ...opts, confirm: db, backup: fakeBackup(true, 'f'.repeat(64)) })).rejects.toThrow(/数据指纹与现在的库不同.*没有清库/);
    expect(await fingerprint()).toBe(before);
  });

  it('demo-reset：备份核验通过后清空这个库、从零重新准备，结果与预期一致', async () => {
    const lines: string[] = [];
    const db = await dbName();
    const r = await demoReset(ctx.sql, dev, { confirm: db, backupDir: '/nonexistent', backup: fakeBackup(true), log: (l) => lines.push(l) });
    expect(lines[0]).toContain('在临时库恢复核验，数据指纹与现在的库一致');
    expect(r.prepare.blocks.every((b) => b.written)).toBe(true);
    expect(r.prepare.check.ok).toBe(true);
    expect(await showcaseState(ctx.sql, ctx.config.timezone)).toEqual(want);
    // 冲突造的改动都没了：清库重建
    const [t301] = await ctx.sql<{ businessType: string }[]>`SELECT business_type FROM spaces WHERE code = 'T301'`;
    expect(t301!.businessType).toBe('SPA');
  });
});
