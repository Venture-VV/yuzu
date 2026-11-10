// 备份与数据指纹：指纹稳定、能指出变化的表、不受排序规则影响；备份在临时库试恢复后记下指纹，与当前数据库一致；
// 演练核验能发现文件或指纹被改动，旧版本的备份补跑迁移后自检；哨兵、中断留下的临时库、保留策略与定时规则。
// 需要本机有 16 版的 pg_dump / pg_restore（CI 固定使用 16 版）。

import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertBackupTarget,
  backupPolicyFromEnv,
  createBackup,
  dropStaleScratch,
  nextAutoBackup,
  planPrune,
  SENTINEL,
  verifyBackup,
  type BackupManifest,
  type BackupPolicy,
} from '../src/server/ops/backup';
import { createSql } from '../src/server/db';
import { computeFingerprint, diffFingerprints } from '../src/server/ops/fingerprint';
import { createMember, setup, type TestContext } from './helpers';

/** 试恢复用的临时库名前缀：与 ops/backup.ts 相同，取测试库的库名（测试库不一定叫 yuzu_test） */
const scratchPrefix = () => `${decodeURIComponent(new URL(ctx.config.databaseUrl).pathname.slice(1)).slice(0, 30)}_v_`;

let ctx: TestContext;
let dir: string;
beforeAll(async () => {
  ctx = await setup();
  dir = await mkdtemp(join(tmpdir(), 'yuzu-backup-'));
});
afterAll(async () => {
  await ctx.close();
  await rm(dir, { recursive: true, force: true });
});

describe('数据指纹', () => {
  it('同样的数据算两次结果相同；数据变了能指出是哪张表', async () => {
    const a = await computeFingerprint(ctx.sql);
    expect(await computeFingerprint(ctx.sql)).toEqual(a);
    expect(a.tables.find((t) => t.name === 'staff')?.rows).toBe(2);
    await createMember(ctx, '指纹会员');
    const b = await computeFingerprint(ctx.sql);
    expect(b.digest).not.toBe(a.digest);
    expect(diffFingerprints(a, b)).toContain('members');
  });
});

describe('数据指纹与排序规则', () => {
  it('同一份数据恢复到排序规则不同的库（ICU en-US），指纹与原库相同（Alpine 与 Debian 镜像的默认排序规则不同）', async () => {
    // 文本主键：大小写与下划线混排，两种排序规则下的顺序不同
    await ctx.sql`CREATE TABLE collation_probe (k text PRIMARY KEY)`;
    await ctx.sql`INSERT INTO collation_probe VALUES ('a'), ('B'), ('_c'), ('b')`;
    const m = await createBackup(ctx.config, dir, 'collate');
    const name = `yuzu_test_icu_${Date.now()}`;
    await ctx.sql.unsafe(`CREATE DATABASE "${name}" TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER icu ICU_LOCALE 'en-US' LOCALE 'C'`);
    const url = new URL(ctx.config.databaseUrl);
    url.pathname = `/${name}`;
    const other = createSql(url.toString(), { max: 1 });
    try {
      await promisify(execFile)('pg_restore', ['--no-owner', '--exit-on-error', '-d', url.toString(), join(dir, m.file)]);
      const [order] = await other<{ icu: string; c: string }[]>`
        SELECT string_agg(k, ',' ORDER BY k) AS icu, string_agg(k, ',' ORDER BY k COLLATE "C") AS c FROM collation_probe`;
      expect(order!.icu).not.toBe(order!.c);
      expect((await computeFingerprint(other)).digest).toBe((await computeFingerprint(ctx.sql)).digest);
    } finally {
      await other.end({ timeout: 5 });
      await ctx.sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await ctx.sql`DROP TABLE IF EXISTS collation_probe`;
    }
    // 一次完整导出、在 ICU 库里恢复、两边各算一遍指纹：CI 上平时 18 秒，并行的用例多、运行机慢时超过默认的 30 秒（PR #71 的 616e446），
    // 单独放宽。超时以后 finally 里的清理还在后台跑，探测表晚删，会连带下一条的指纹对不上
  }, 120_000);
});

describe('备份与核验', () => {
  let manifest: BackupManifest;
  let file: string;

  it('导出后在临时库恢复，记下的指纹与当前数据库一致、自检全部通过', async () => {
    manifest = await createBackup(ctx.config, dir, 'manual');
    file = join(dir, manifest.file);
    expect(manifest).toMatchObject({ label: 'manual', verified: true });
    expect(manifest.file).toMatch(/^yuzu-\d{8}-\d{6}-manual\.dump$/);
    expect(manifest.fingerprintDigest).toBe((await computeFingerprint(ctx.sql)).digest);
    expect(manifest.checks!.failed).toEqual([]);
    expect(manifest.checks!.total).toBeGreaterThan(10);
    const saved = JSON.parse(await readFile(`${file}.json`, 'utf8')) as BackupManifest;
    expect(saved.sha256).toBe(manifest.sha256);
    // 临时库已删除
    const left = await ctx.sql`SELECT datname FROM pg_database WHERE datname LIKE ${`${scratchPrefix()}%`}`;
    expect(left).toEqual([]);
    // 导出、在临时库完整恢复、自检：CI 上平时 9 秒，运行机慢时 18 秒以上，与下面几条一样单独放宽
  }, 120_000);

  it('演练核验：恢复后的指纹与备份时一致', async () => {
    const result = await verifyBackup(ctx.config, file);
    expect(result.ok).toBe(true);
    expect(result.lines.join('\n')).toContain('✓ 数据指纹与备份时一致');
    // 在临时库完整恢复一遍再算指纹：同上
  }, 120_000);

  it('文件摘要或记下的指纹被改动时核验不通过', async () => {
    const saved = JSON.parse(await readFile(`${file}.json`, 'utf8')) as BackupManifest;
    await writeFile(`${file}.json`, JSON.stringify({ ...saved, sha256: '0'.repeat(64) }));
    expect((await verifyBackup(ctx.config, file)).lines.join('\n')).toContain('✗ 文件摘要与备份时不同');
    const tables = saved.fingerprint!.tables.map((t) => (t.name === 'staff' ? { ...t, digest: 'x' } : t));
    await writeFile(`${file}.json`, JSON.stringify({ ...saved, fingerprint: { ...saved.fingerprint, tables } }));
    const result = await verifyBackup(ctx.config, file);
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('✗ 数据指纹与备份时不同：staff');
    // 以后换了指纹算法：不硬比，明确说明无法比对
    await writeFile(`${file}.json`, JSON.stringify({ ...saved, fingerprint: { ...saved.fingerprint, algorithm: 'rows-md5-sorted-v0' } }));
    const other = await verifyBackup(ctx.config, file);
    expect(other.ok).toBe(false);
    expect(other.lines.join('\n')).toContain('与本版本（rows-md5-sorted-v1）不同，无法比对');
    await writeFile(`${file}.json`, JSON.stringify(saved));
    // 三次核验，每次都在临时库完整恢复一遍再算指纹：CI 上平时 16–20 秒，并行的用例多、运行机慢时超过默认的 30 秒（PR #65 的 33d0c74），单独放宽
  }, 120_000);

  it('不是有效备份的文件：恢复失败，核验不通过', async () => {
    const bad = join(dir, 'yuzu-20261030-120000-manual.dump');
    await writeFile(bad, 'not a dump');
    const result = await verifyBackup(ctx.config, bad);
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('✗ 在临时库恢复失败');
  });

  it('旧版本的备份也能核验：恢复后先比对指纹，再补跑本版本的迁移后自检', async () => {
    const name = `yuzu_test_old_${Date.now()}`;
    await ctx.sql.unsafe(`CREATE DATABASE "${name}"`);
    const url = new URL(ctx.config.databaseUrl);
    url.pathname = `/${name}`;
    const old = createSql(url.toString(), { max: 1 });
    try {
      // 只应用前 3 个迁移，模拟旧版本的数据库
      const migrations = new URL('../src/server/migrations/', import.meta.url);
      const files = (await readdir(migrations)).filter((f) => f.endsWith('.sql')).sort().slice(0, 3);
      await old`CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
      for (const f of files) {
        await old.unsafe(await readFile(new URL(f, migrations), 'utf8'));
        await old`INSERT INTO schema_migrations (version) VALUES (${f})`;
      }
      const m = await createBackup({ ...ctx.config, databaseUrl: url.toString() }, dir, 'old');
      expect(m.verified).toBe(true);
      const result = await verifyBackup(ctx.config, join(dir, m.file));
      expect(result.ok).toBe(true);
      expect(result.lines.join('\n')).toContain('✓ 数据指纹与备份时一致');
      expect(result.lines.join('\n')).toMatch(/临时库已补跑迁移 004_/);
    } finally {
      await old.end({ timeout: 5 });
      await ctx.sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
    // 建旧版本的库、导出、恢复后补跑本版本的全部迁移：CI 上平时 12 秒，运行机慢时 20 秒以上，同上放宽
  }, 120_000);

  it('备注只能是小写字母、数字与短横线', async () => {
    await expect(createBackup(ctx.config, dir, '../x')).rejects.toThrow(/备份备注/);
  });

  it('要求哨兵时，备份目录里没有哨兵文件就拒绝备份', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'yuzu-nosentinel-'));
    try {
      await expect(assertBackupTarget(empty, { requireSentinel: true })).rejects.toThrow(/哨兵文件/);
      await expect(assertBackupTarget(empty, { requireSentinel: false })).resolves.toBeUndefined();
      await writeFile(join(empty, SENTINEL), '');
      await expect(assertBackupTarget(empty, { requireSentinel: true })).resolves.toBeUndefined();
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('清理中途中断留下的临时库，不动正在用的临时库', async () => {
    const now = Date.now();
    const stale = `${scratchPrefix()}${now - 2 * 3600_000}_abcdef`;
    const fresh = `${scratchPrefix()}${now - 60_000}_fedcba`;
    for (const name of [stale, fresh]) await ctx.sql.unsafe(`CREATE DATABASE "${name}"`);
    try {
      expect(await dropStaleScratch(ctx.config.databaseUrl, now)).toEqual([stale]);
      const left = await ctx.sql<{ datname: string }[]>`SELECT datname FROM pg_database WHERE datname IN (${stale}, ${fresh})`;
      expect(left.map((r) => r.datname)).toEqual([fresh]);
    } finally {
      for (const name of [stale, fresh]) await ctx.sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
  });
});

describe('保留策略与定时规则', () => {
  const policy: BackupPolicy = { intervalMinutes: 60, dailyHour: 4, hourlyKeepHours: 48, keepDays: 30, requireSentinel: false };
  const hour = 3600_000;
  const now = Date.parse('2026-10-30T12:00:00+08:00');
  const entry = (label: string, ageHours: number, date = '20261030') => ({ name: `yuzu-${date}-000000-${label}-${ageHours}.dump`, label, date, mtimeMs: now - ageHours * hour });

  it('hourly 保留 48 小时，daily 与手动、升级前备份保留 30 天', () => {
    const entries = [entry('hourly', 47), entry('hourly', 49), entry('daily', 49), entry('daily', 24 * 31), entry('before-update', 24 * 29)];
    expect(planPrune(entries, now, policy)).toEqual([entries[1]!.name, entries[3]!.name]);
  });

  it('距上一份自动备份满一小时才备份；每天 4 点后的第一份记为 daily；手动备份不影响', () => {
    const at = (iso: string) => new Date(iso);
    expect(nextAutoBackup([], at('2026-10-30T03:00:00+08:00'), 'Asia/Shanghai', policy)).toBe('hourly');
    expect(nextAutoBackup([], at('2026-10-30T04:10:00+08:00'), 'Asia/Shanghai', policy)).toBe('daily');
    const recent = { ...entry('hourly', 0.5), mtimeMs: Date.parse('2026-10-30T11:30:00+08:00') };
    expect(nextAutoBackup([recent], at('2026-10-30T12:00:00+08:00'), 'Asia/Shanghai', policy)).toBeNull();
    const manualOnly = { ...entry('manual', 0.1), mtimeMs: Date.parse('2026-10-30T11:55:00+08:00') };
    expect(nextAutoBackup([manualOnly], at('2026-10-30T12:00:00+08:00'), 'Asia/Shanghai', policy)).toBe('daily');
    const daily = { ...entry('daily', 7), mtimeMs: Date.parse('2026-10-30T05:00:00+08:00') };
    expect(nextAutoBackup([daily], at('2026-10-30T12:00:00+08:00'), 'Asia/Shanghai', policy)).toBe('hourly');
  });

  it('环境变量不合法时用默认值', () => {
    expect(backupPolicyFromEnv({ BACKUP_INTERVAL_MINUTES: '0', BACKUP_HOUR: '25', BACKUP_REQUIRE_SENTINEL: 'true' })).toMatchObject({
      intervalMinutes: 60,
      dailyHour: 4,
      requireSentinel: true,
    });
    expect(backupPolicyFromEnv({ BACKUP_INTERVAL_MINUTES: '30', BACKUP_HOURLY_KEEP_HOURS: '24' })).toMatchObject({ intervalMinutes: 30, hourlyKeepHours: 24, requireSentinel: false });
  });
});
