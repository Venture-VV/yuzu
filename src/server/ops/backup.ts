// 备份：pg_dump 导出 → 在临时库里真正恢复一遍 → 自检与数据指纹 → 备份文件旁写一份 .json 说明。
// 备份服务（compose 的 backup）用 backup-loop 每小时执行一次；scripts/backup.sh 手动执行一次。
// 说明里记下指纹：日后演练或正式恢复后算出同样的指纹，才算恢复无误。

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { AppConfig } from '../config';
import { createSql } from '../db';
import { migrate } from '../migrate';
import { consistencyChecks, type CheckLine } from './consistency';
import { computeFingerprint, diffFingerprints, type Fingerprint } from './fingerprint';

/** 外置盘上的哨兵文件：要求哨兵时，备份目录里没有它就不写（外置盘没挂载时不往内置盘写） */
export const SENTINEL = '.yuzu-backup-target';

const NAME = /^yuzu-(\d{8})-(\d{6})(?:-([a-z0-9-]+))?\.dump$/;

export interface BackupManifest {
  file: string;
  label: string;
  createdAt: string;
  bytes: number;
  sha256: string;
  app: { version: string; commit: string; instance: string };
  /** 在临时库里恢复成功并算出了指纹 */
  verified: boolean;
  verifyError?: string;
  /** 数据指纹的总摘要（restore.sh 直接读这一项比对） */
  fingerprintDigest: string | null;
  fingerprint?: Fingerprint;
  checks?: { total: number; failed: CheckLine[] };
}

export interface BackupPolicy {
  intervalMinutes: number;
  /** 每天这个钟点之后的第一份自动备份记为 daily，保留更久 */
  dailyHour: number;
  hourlyKeepHours: number;
  keepDays: number;
  requireSentinel: boolean;
}

export function backupPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): BackupPolicy {
  const num = (v: string | undefined, fallback: number, min: number, max: number) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
  };
  return {
    intervalMinutes: num(env.BACKUP_INTERVAL_MINUTES, 60, 5, 1440),
    dailyHour: num(env.BACKUP_HOUR, 4, 0, 23),
    hourlyKeepHours: num(env.BACKUP_HOURLY_KEEP_HOURS, 48, 1, 24 * 30),
    keepDays: num(env.BACKUP_KEEP_DAYS, 30, 1, 3650),
    requireSentinel: env.BACKUP_REQUIRE_SENTINEL === 'true',
  };
}

export const backupDirFromEnv = (env: NodeJS.ProcessEnv = process.env) => env.BACKUP_PATH || env.BACKUP_DIR || './backups';

/** 要求哨兵时，备份目录里必须有哨兵文件（手动备份、升级前与恢复前的备份同样要求） */
export async function assertBackupTarget(dir: string, policy: Pick<BackupPolicy, 'requireSentinel'>): Promise<void> {
  if (policy.requireSentinel && !(await exists(join(dir, SENTINEL)))) {
    throw new Error(`${dir} 里没有哨兵文件 ${SENTINEL}：外置盘可能没挂载，不往内置盘写备份。请先接好外置盘再试`);
  }
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function withDatabase(databaseUrl: string, database: string): string {
  const u = new URL(databaseUrl);
  u.pathname = `/${encodeURIComponent(database)}`;
  return u.toString();
}

function databaseOf(databaseUrl: string): string {
  return decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
}

/** pg_dump / pg_restore 用的连接环境变量：密码不出现在命令行上 */
function pgEnv(databaseUrl: string, database?: string): NodeJS.ProcessEnv {
  const u = new URL(databaseUrl);
  return {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: database ?? databaseOf(databaseUrl),
  };
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d: Buffer) => {
      err = (err + d.toString()).slice(-4000);
    });
    child.on('error', (e) => reject(new Error(`无法执行 ${cmd}：${e.message}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} 失败（退出码 ${code}）：${err.trim()}`))));
  });
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

const exists = (path: string) => access(path).then(() => true, () => false);

/** 门店时区的日期与时刻：备份文件名、每天第一份的判断都按门店时间 */
function localStamp(now: Date, timezone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}${parts.month}${parts.day}`, time: `${parts.hour}${parts.minute}${parts.second}`, hour: Number(parts.hour) };
}

const scratchPrefix = (databaseUrl: string) => `${databaseOf(databaseUrl).slice(0, 30)}_v_`;

/**
 * 把备份恢复到一个临时库，算数据指纹、跑自检，然后删掉临时库。不碰当前数据库。
 * 指纹在恢复后立即算（与备份时的数据比对）；之后补跑本版本的迁移再自检，旧版本的备份也能用新版本核验。
 * 临时库名带时间与随机数，手动备份和定时备份同时进行也互不影响。
 */
export async function restoreAndInspect(file: string, databaseUrl: string, timezone: string) {
  const scratch = `${scratchPrefix(databaseUrl)}${Date.now()}_${randomBytes(3).toString('hex')}`;
  const adminUrl = withDatabase(databaseUrl, 'postgres');
  const admin = createSql(adminUrl, { max: 1 });
  try {
    await admin.unsafe(`CREATE DATABASE ${ident(scratch)}`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  try {
    await run('pg_restore', ['--no-owner', '--exit-on-error', '-d', scratch, file], pgEnv(databaseUrl, scratch));
    const db = createSql(withDatabase(databaseUrl, scratch), { max: 2 });
    try {
      const fingerprint = await computeFingerprint(db);
      const migrated = await migrate(db);
      return { fingerprint, migrated, checks: await consistencyChecks(db, timezone) };
    } finally {
      await db.end({ timeout: 5 });
    }
  } finally {
    const cleanup = createSql(adminUrl, { max: 1 });
    try {
      await cleanup.unsafe(`DROP DATABASE IF EXISTS ${ident(scratch)} WITH (FORCE)`);
    } finally {
      await cleanup.end({ timeout: 5 });
    }
  }
}

/** 删掉中途被打断（容器重启、升级）留下的临时库；正在用的临时库不到 maxAgeMs，不会被删 */
export async function dropStaleScratch(databaseUrl: string, now: number, maxAgeMs = 3600_000): Promise<string[]> {
  const prefix = scratchPrefix(databaseUrl);
  const admin = createSql(withDatabase(databaseUrl, 'postgres'), { max: 1 });
  try {
    const rows = await admin<{ datname: string }[]>`SELECT datname FROM pg_database WHERE starts_with(datname, ${prefix})`;
    const stale = rows
      .map((r) => r.datname)
      .filter((name) => {
        const m = /^(\d{13})_[0-9a-f]{6}$/.exec(name.slice(prefix.length));
        return m !== null && now - Number(m[1]) > maxAgeMs;
      });
    for (const name of stale) await admin.unsafe(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`);
    return stale;
  } finally {
    await admin.end({ timeout: 5 });
  }
}

/** 应用是否已完成首次迁移：全新安装时备份服务可能比应用先启动，空库不备份 */
async function databaseReady(databaseUrl: string): Promise<boolean> {
  const sql = createSql(databaseUrl, { max: 1 });
  try {
    const [row] = await sql<{ ready: boolean }[]>`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS ready`;
    if (!row?.ready) return false;
    const [count] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM schema_migrations`;
    return (count?.n ?? 0) > 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** 备份一次：导出 → 临时库试恢复 → 指纹与自检 → 写文件与说明。恢复失败也保留文件，说明里 verified=false */
export async function createBackup(config: AppConfig, dir: string, label: string, now = new Date()): Promise<BackupManifest> {
  if (!/^[a-z0-9-]{1,32}$/.test(label)) throw new Error('备份备注只能用小写字母、数字和短横线（最多 32 个字符）');
  await mkdir(dir, { recursive: true });
  const stamp = localStamp(now, config.timezone);
  const file = `yuzu-${stamp.date}-${stamp.time}-${label}.dump`;
  const target = join(dir, file);
  const partial = `${target}.partial`;
  await run('pg_dump', ['-Fc', '-f', partial], pgEnv(config.databaseUrl));
  const manifest: BackupManifest = {
    file,
    label,
    createdAt: now.toISOString(),
    bytes: (await stat(partial)).size,
    sha256: await sha256File(partial),
    app: { version: config.version, commit: config.commit, instance: config.instance },
    verified: false,
    fingerprintDigest: null,
  };
  try {
    const { fingerprint, checks } = await restoreAndInspect(partial, config.databaseUrl, config.timezone);
    manifest.verified = true;
    manifest.fingerprintDigest = fingerprint.digest;
    manifest.fingerprint = fingerprint;
    manifest.checks = { total: checks.length, failed: checks.filter((c) => !c.ok) };
  } catch (e) {
    manifest.verifyError = message(e);
  }
  // 先写说明再改名：看到 .dump 时说明已经写完（上传脚本按 .dump 判断备份完整）
  await writeFile(`${target}.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(partial, target);
  return manifest;
}

export interface VerifyResult {
  ok: boolean;
  lines: string[];
}

/** 演练：把一份备份恢复到临时库，核对文件摘要、数据指纹与自检。不碰当前数据库 */
export async function verifyBackup(config: AppConfig, file: string): Promise<VerifyResult> {
  const lines: string[] = [];
  let ok = true;
  const manifestPath = `${file}.json`;
  const manifest = (await exists(manifestPath)) ? (JSON.parse(await readFile(manifestPath, 'utf8')) as BackupManifest) : null;
  if (manifest) {
    const sha = await sha256File(file);
    const same = sha === manifest.sha256;
    ok &&= same;
    lines.push(`${same ? '✓' : '✗'} 文件摘要${same ? '与备份时一致' : `与备份时不同（备份时 ${manifest.sha256.slice(0, 12)}…，现在 ${sha.slice(0, 12)}…）：文件在传输或保存中被改动`}`);
  } else {
    lines.push('· 没有找到备份旁的 .json 说明，只做恢复与自检，不比对指纹');
  }
  let inspected: Awaited<ReturnType<typeof restoreAndInspect>>;
  try {
    inspected = await restoreAndInspect(file, config.databaseUrl, config.timezone);
  } catch (e) {
    lines.push(`✗ 在临时库恢复失败：${message(e)}`);
    return { ok: false, lines };
  }
  const { fingerprint, migrated, checks } = inspected;
  lines.push(`✓ 已在临时库恢复：${fingerprint.tables.length} 张表，指纹 ${fingerprint.digest.slice(0, 12)}…`);
  if (manifest?.fingerprint && manifest.fingerprint.algorithm !== fingerprint.algorithm) {
    ok = false;
    lines.push(`✗ 备份时的指纹算法（${manifest.fingerprint.algorithm ?? '未记录'}）与本版本（${fingerprint.algorithm}）不同，无法比对`);
  } else if (manifest?.fingerprint) {
    const diff = diffFingerprints(manifest.fingerprint, fingerprint);
    ok &&= diff.length === 0;
    lines.push(diff.length === 0 ? '✓ 数据指纹与备份时一致' : `✗ 数据指纹与备份时不同：${diff.join('、')}`);
  }
  if (migrated.length) lines.push(`· 备份来自旧版本，临时库已补跑迁移 ${migrated.join('、')} 后再自检`);
  for (const c of checks) lines.push(`${c.ok ? '✓' : '✗'} ${c.label}：${c.detail}`);
  ok &&= checks.every((c) => c.ok);
  return { ok, lines };
}

interface BackupEntry {
  name: string;
  label: string;
  date: string;
  mtimeMs: number;
}

export async function listBackups(dir: string): Promise<BackupEntry[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: BackupEntry[] = [];
  for (const name of names) {
    const m = NAME.exec(name);
    if (!m) continue;
    const { mtimeMs } = await stat(join(dir, name));
    // 旧版每天一份的文件名不带备注，按 daily 对待
    out.push({ name, label: m[3] ?? 'daily', date: m[1]!, mtimeMs });
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

/** 按保留策略算出要删除的备份：hourly 保留 hourlyKeepHours 小时，其余（daily、升级前、手动等）保留 keepDays 天 */
export function planPrune(entries: BackupEntry[], now: number, policy: Pick<BackupPolicy, 'hourlyKeepHours' | 'keepDays'>): string[] {
  return entries
    .filter((e) => now - e.mtimeMs > (e.label === 'hourly' ? policy.hourlyKeepHours * 3600_000 : policy.keepDays * 86400_000))
    .map((e) => e.name);
}

async function prune(dir: string, policy: BackupPolicy, now: number): Promise<string[]> {
  const doomed = planPrune(await listBackups(dir), now, policy);
  for (const name of doomed) {
    await rm(join(dir, name), { force: true });
    await rm(join(dir, `${name}.json`), { force: true });
  }
  // 中途失败留下的半截文件，以及没有对应备份的说明
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    const orphan = name.endsWith('.dump.json') && !names.includes(name.slice(0, -'.json'.length));
    if ((name.endsWith('.partial') || orphan) && now - (await stat(join(dir, name))).mtimeMs > 86400_000) await rm(join(dir, name), { force: true });
  }
  return doomed;
}

/** 这一刻该不该做自动备份、记为哪一类（纯函数，便于测试） */
export function nextAutoBackup(entries: BackupEntry[], now: Date, timezone: string, policy: BackupPolicy): 'hourly' | 'daily' | null {
  const autos = entries.filter((e) => e.label === 'hourly' || e.label === 'daily');
  const last = autos.length ? Math.max(...autos.map((e) => e.mtimeMs)) : 0;
  // 留 30 秒余量：上一份备份本身要花时间，避免每次都往后推一分钟
  if (now.getTime() - last < policy.intervalMinutes * 60_000 - 30_000) return null;
  const stamp = localStamp(now, timezone);
  const dailyDone = entries.some((e) => e.label === 'daily' && e.date === stamp.date);
  return !dailyDone && stamp.hour >= policy.dailyHour ? 'daily' : 'hourly';
}

/** 备份服务：每分钟看一次，到时间就备份并清理过期文件 */
export async function backupLoop(config: AppConfig, dir: string, policy: BackupPolicy): Promise<never> {
  console.log(
    `[backup] 已启动：每 ${policy.intervalMinutes} 分钟一份（每天 ${policy.dailyHour}:00 后第一份记为 daily）；hourly 保留 ${policy.hourlyKeepHours} 小时，其余保留 ${policy.keepDays} 天；目录 ${dir}${policy.requireSentinel ? `，要求哨兵文件 ${SENTINEL}` : ''}`,
  );
  // 容器停止或升级时立即退出；做到一半的备份只留下 .partial 文件和临时库，之后的备份会清理掉
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => process.exit(0));
  let lastSentinelWarning = 0;
  let lastNotReady = 0;
  for (;;) {
    const now = new Date();
    try {
      if (policy.requireSentinel && !(await exists(join(dir, SENTINEL)))) {
        if (now.getTime() - lastSentinelWarning > 3600_000) {
          console.error(`[backup] ✗ ${dir} 里没有哨兵文件 ${SENTINEL}：外置盘可能没挂载，本次不备份（不往内置盘写）`);
          lastSentinelWarning = now.getTime();
        }
      } else {
        const label = nextAutoBackup(await listBackups(dir), now, config.timezone, policy);
        if (label && !(await databaseReady(config.databaseUrl))) {
          if (now.getTime() - lastNotReady > 3600_000) {
            console.log('[backup] · 数据库还没有初始化（应用尚未完成首次迁移），稍后再备份');
            lastNotReady = now.getTime();
          }
        } else if (label) {
          const dropped = await dropStaleScratch(config.databaseUrl, now.getTime());
          if (dropped.length) console.log(`[backup] 已清理中途中断留下的临时库 ${dropped.length} 个`);
          const m = await createBackup(config, dir, label, now);
          const failed = m.checks?.failed.length ?? 0;
          if (!m.verified) console.error(`[backup] ✗ ${m.file} 已导出，但在临时库恢复失败：${m.verifyError}`);
          else console.log(`[backup] ✓ ${m.file}（${(m.bytes / 1024 / 1024).toFixed(1)} MB，指纹 ${m.fingerprintDigest!.slice(0, 12)}…，自检 ${m.checks!.total - failed}/${m.checks!.total}）`);
          if (failed) console.error(`[backup] ✗ 自检有 ${failed} 项不一致：${m.checks!.failed.map((c) => c.label).join('、')}`);
          const removed = await prune(dir, policy, Date.now());
          if (removed.length) console.log(`[backup] 已清理过期备份 ${removed.length} 份`);
        }
      }
    } catch (e) {
      console.error(`[backup] ✗ ${basename(dir)}：${message(e)}`);
    }
    await new Promise((r) => setTimeout(r, 60_000));
  }
}
