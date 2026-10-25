import { readdir, readFile } from 'node:fs/promises';
import type { Sql } from './db';

const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url);

/** 按文件名顺序执行未应用的 SQL 迁移；用咨询锁避免多个进程同时迁移。 */
export async function migrate(sql: Sql, log: (msg: string) => void = () => {}): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(918273645)`;
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const rows = await tx<{ version: string }[]>`SELECT version FROM schema_migrations`;
    const done = new Set(rows.map((r) => r.version));
    for (const file of files) {
      if (done.has(file)) continue;
      const content = await readFile(new URL(file, MIGRATIONS_DIR), 'utf8');
      await tx.unsafe(content);
      await tx`INSERT INTO schema_migrations (version) VALUES (${file})`;
      applied.push(file);
      log(`已应用迁移 ${file}`);
    }
  });
  return applied;
}
