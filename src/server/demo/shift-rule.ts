// 合成演示数据按「开班可选」的口径入账：灌数据期间临时关闭「收款前必须先开班」（R1.2），结束后恢复原值。
// 演示数据是事后补建的历史单据，不按当时的班次生成（结账演示另有自己的班次）；
// 只在独立的演示 / 开发库使用：试用、正式环境不改规则（各 seed 命令在那里拒绝执行）。

import type { AppConfig } from '../config';
import type { Sql } from '../db';

export async function withShiftOptional<T>(sql: Sql, config: AppConfig, fn: () => Promise<T>): Promise<T> {
  if (config.env === 'production' || config.env === 'trial') return fn();
  // 原样恢复（连同修改时间与修改人）：演示数据临时改的不算一次规则修改，已灌过、全部跳过时数据指纹也不变（v0.7.18 demo-prepare）
  // 时间按文字取回再原样写回（JS 的 Date 只到毫秒，数据库是微秒）
  const [prev] = await sql<{ value: unknown; updatedAt: string; updatedBy: number | null }[]>`
    SELECT value, updated_at::text AS updated_at, updated_by FROM settings WHERE key = 'require_open_shift'`;
  await sql`
    INSERT INTO settings (key, value) VALUES ('require_open_shift', 'false'::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = 'false'::jsonb, updated_at = now()`;
  try {
    return await fn();
  } finally {
    if (prev) {
      await sql`
        UPDATE settings SET value = ${sql.json(prev.value as never)}, updated_at = ${prev.updatedAt}::timestamptz, updated_by = ${prev.updatedBy}
        WHERE key = 'require_open_shift'`;
    } else await sql`DELETE FROM settings WHERE key = 'require_open_shift'`;
  }
}
