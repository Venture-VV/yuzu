// 桌台提醒（8.1.17 BW-2，docs/FRONTDESK_V8117.md 第 5 节）：
//   · 维修中的桌过了预计恢复时间、待清台超过 N 分钟（餐饮规则 dirtyAlertMinutes，默认 15）：格子上标出、进餐饮的待办数——
//     都是看板上现成的状态与时刻算出来的（@shared/frontdesk-v8117 的 tableReminderOf / tableTodos），不另存；
//   · 餐饮规则「到点自动恢复」（autoRestore，默认关）开着时，每分钟的任务替人点「恢复」：走手动恢复的同一个函数 restoreTable
//     （同样的锁：操作编号的咨询锁 → 桌台一行 → 写 table_events），经办人是系统账号「系统」。
//     操作编号按「桌台 + 这一次维修的开始时刻」算出来：几个进程同时跑，后到的按编号原样返回第一次的那条；
//     锁住以后再核对预计恢复时间确实到了（dueAt），挑候选到锁住之间有人恢复后重新报修的不动。

import { createHash } from 'node:crypto';
import type { Deps } from '../lib/context';
import { AppError } from '../lib/errors';
import { currentStoreId, forEachStore } from '../lib/store-context';
import { loadDiningRules } from './dining';
import { systemAutoActor } from './system-staff';
import { restoreTable } from './tables-v8115';

/** 一次维修的自动恢复的操作编号：「桌台 + 这一次维修的开始时刻」 */
export function autoRestoreKey(tableId: number, since: Date | string | null): string {
  const h = createHash('sha256')
    .update(`auto-restore:${tableId}:${since ? new Date(since).toISOString() : ''}`)
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** 每分钟：开了「到点自动恢复」的店，过了预计恢复时间的桌自动恢复；返回这一次恢复了几桌 */
export async function sweepTableRestores(deps: Deps, now = new Date()): Promise<number> {
  let n = 0;
  await forEachStore(deps.sql, async () => {
    const rules = await loadDiningRules(deps.sql);
    if (!rules.enabled || !rules.autoRestore) return;
    const due = await deps.sql<{ id: number; stateSince: Date | null }[]>`
      SELECT id, state_since FROM dining_tables
      WHERE state = 'maintenance' AND maintenance_until <= ${now} AND store_id = ${currentStoreId()}
      ORDER BY id`;
    if (due.length === 0) return;
    const actor = await systemAutoActor(deps.sql);
    for (const t of due) {
      try {
        const r = await restoreTable(deps, Number(t.id), { clientKey: autoRestoreKey(Number(t.id), t.stateSince) }, { actor, at: now }, { dueAt: now });
        if (!r.replayed) n += 1;
      } catch (error) {
        // 刚被人恢复了、又报修了还没到点：这一桌不动，接着下一桌
        if (error instanceof AppError && (error.code === 'TABLE_NOT_MAINTENANCE' || error.code === 'MAINTENANCE_NOT_DUE')) continue;
        throw error;
      }
    }
  });
  return n;
}
