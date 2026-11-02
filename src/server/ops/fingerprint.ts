// 数据指纹：逐表的行数与内容摘要（每行一个摘要，按字节序排序后合成），再合成一个总摘要。
// 用来核对备份恢复后的数据与备份时完全一致：备份时在临时库里试恢复并算一次，记在备份旁边；
// 演练或正式恢复后再算一次，两者相同才算恢复无误。
// 在只读的可重复读事务里计算，并固定时区、日期与数字格式；排序不依赖主键与数据库的排序规则，
// 不同机器、不同 PostgreSQL 镜像（Alpine / Debian）算出的结果相同。

import { createHash } from 'node:crypto';
import type { Sql, Tx } from '../db';

export interface TableFingerprint {
  name: string;
  rows: number;
  digest: string;
}

export interface Fingerprint {
  /** 算法编号：以后改算法时换编号，旧备份的指纹按原算法核对 */
  algorithm: string;
  digest: string;
  tables: TableFingerprint[];
}

export const FINGERPRINT_ALGORITHM = 'rows-md5-sorted-v1';

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

export async function computeFingerprint(sql: Sql): Promise<Fingerprint> {
  return (await sql.begin('isolation level repeatable read read only', (tx) => fingerprintIn(tx))) as Fingerprint;
}

/** 在调用方的事务里算（demo-reset 先锁住所有表、挡住写入，再在同一个事务里算，与备份比对后才清库）；算法与 computeFingerprint 相同 */
export async function fingerprintIn(tx: Tx): Promise<Fingerprint> {
  const tables = await (async () => {
    await tx`SET LOCAL TIME ZONE 'UTC'`;
    await tx`SET LOCAL datestyle = 'ISO, YMD'`;
    await tx`SET LOCAL intervalstyle = 'postgres'`;
    await tx`SET LOCAL extra_float_digits = 3`;
    await tx`SET LOCAL bytea_output = 'hex'`;
    const list = await tx<{ name: string }[]>`
      SELECT c.relname AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      ORDER BY c.relname COLLATE "C"`;
    const out: TableFingerprint[] = [];
    for (const t of list) {
      const [row] = await tx.unsafe<{ rows: number; digest: string }[]>(
        `SELECT count(*)::int AS rows, md5(coalesce(string_agg(h, '' ORDER BY h COLLATE "C"), '')) AS digest
         FROM (SELECT md5(t::text) AS h FROM public.${ident(t.name)} t) r`,
      );
      out.push({ name: t.name, rows: row!.rows, digest: row!.digest });
    }
    return out;
  })();
  const hash = createHash('sha256');
  for (const t of tables) hash.update(`${t.name}\t${t.rows}\t${t.digest}\n`);
  return { algorithm: FINGERPRINT_ALGORITHM, digest: hash.digest('hex'), tables };
}

/** 两份指纹不一致的表（名称、行数或摘要不同；只在一边出现的表也算） */
export function diffFingerprints(a: Fingerprint, b: Fingerprint): string[] {
  const left = new Map(a.tables.map((t) => [t.name, t]));
  const right = new Map(b.tables.map((t) => [t.name, t]));
  const names = [...new Set([...left.keys(), ...right.keys()])].sort();
  return names.filter((n) => left.get(n)?.digest !== right.get(n)?.digest || left.get(n)?.rows !== right.get(n)?.rows);
}
