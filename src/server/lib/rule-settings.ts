// 规则类设置（settings 表里一个键一份 JSON）的保存（v0.7.22 代码整理：原来九个模块各写一遍）。
//
// 所有规则保存都先取同一把咨询锁、串行执行，在锁里读当前值、算出新值、写回并记审计：
// 只改提交字段的保存（读出当前规则再合并）不会被同时保存的另一个人覆盖。
// 原来前台规则在锁外读当前值、费用规则与库存设置没取锁，两人同时保存会丢掉一方的修改（v0.7.22 修正）。

import type { Sql, Tx } from '../db';
import { writeAudit } from './audit';
import type { OpContext } from './context';

/** 规则保存之间串行（店铺设置、岗位权限等多键保存也用这一把） */
export const lockSettings = (tx: Tx) => tx`SELECT pg_advisory_xact_lock(hashtext('settings'))`;

/**
 * 在锁里读出当前规则，按 next 算出新规则（可以在 next 里校验、抛错回滚），写回并记审计；返回新规则。
 * 只改部分字段时 next 里合并 before：`(before) => parse(Input, { ...before, ...parse(Input.partial(), raw) })`。
 */
export async function saveRuleSetting<T>(
  sql: Sql,
  key: string,
  load: (tx: Tx) => Promise<T>,
  next: (before: T, tx: Tx) => T | Promise<T>,
  ctx: OpContext,
): Promise<T> {
  let saved!: T;
  await sql.begin(async (tx) => {
    await lockSettings(tx);
    const before = await load(tx);
    const after = await next(before, tx);
    await tx`
      INSERT INTO settings (key, value, updated_at, updated_by) VALUES (${key}, ${tx.json(after as never)}, now(), ${ctx.actor.id})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`;
    await writeAudit(tx, { staffId: ctx.actor.id, action: 'settings_updated', targetType: 'settings', detail: { key, before, after }, ip: ctx.ip });
    saved = after;
  });
  return saved;
}
