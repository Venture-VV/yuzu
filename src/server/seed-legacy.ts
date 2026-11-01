// 旧账合成样例导入演示库（v0.7.10）：四份合成样例走正式的导入流程写进只读表。
// 仅独立演示库：试用 / 正式环境拒绝；已经有有效的旧账导入时跳过。预期结果见 src/server/demo/legacy-expected.json。

import type { AppConfig } from './config';
import type { Sql } from './db';
import { applyLegacyImport, fileMeta, parseLegacyWorkbook } from './modules/legacy';
import { legacySampleFiles } from './modules/legacy/samples';

export async function seedLegacyDemo(sql: Sql, config: Pick<AppConfig, 'env'>) {
  if (config.env === 'production' || config.env === 'trial') {
    throw new Error(`当前是${config.env === 'trial' ? '试用' : '正式'}环境，禁止写入旧账演示数据。请另建独立的演示库（APP_ENV=development）再执行。`);
  }
  const [done] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM legacy_imports WHERE status = 'active'`;
  if (done!.n > 0) return { skipped: true as const };
  const [owner] = await sql<{ id: number; username: string }[]>`
    SELECT id, username FROM staff WHERE role = 'owner' AND active ORDER BY (username = 'linlan') DESC, id LIMIT 1`;
  if (!owner) throw new Error('演示库里还没有店主账号，请先执行 seed-demo');
  const files = [];
  for (const f of legacySampleFiles()) {
    const parsed = parseLegacyWorkbook(f.data);
    const r = await applyLegacyImport(sql, parsed, fileMeta(f.name, f.data), { operatorId: Number(owner.id) });
    files.push({ name: f.name, source: parsed.source, importId: r.importId, rows: parsed.sheets.reduce((s, x) => s + x.rows, 0) });
  }
  return { skipped: false as const, files, operator: owner.username };
}
