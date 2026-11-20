// 桌台提醒（8.1.17 BW-2，docs/FRONTDESK_V8117.md 第 5 节）：维修中的桌过了预计恢复时间、待清台超过 N 分钟（餐饮规则，默认 15）——
// 格子上标出（颜色 + 文字 + 图标，16 像素），算进餐饮的待办数（「桌台」页签上、桌台页顶上）。都按看板上的状态与时刻算（服务器的钟），不另存。

import { AlarmClock, Brush, Wrench } from 'lucide-react';
import { DEFAULT_DINING_RULES } from '@shared/dining';
import { tableTodos, type TableReminder } from '@shared/frontdesk-v8117';
import { useDiningMenu, useServerNow, useTablesBoard } from './queries';

/** 「12 分钟」「1 小时 05 分」 */
export const minutesLabel = (m: number) => (m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时${m % 60 ? ` ${String(m % 60).padStart(2, '0')} 分` : ''}`);

/** 待清台多久算久了：餐饮规则里的分钟数（规则还没取到时按默认） */
export const useDirtyAlertMinutes = () => useDiningMenu().data?.rules.dirtyAlertMinutes ?? DEFAULT_DINING_RULES.dirtyAlertMinutes;

/** 格子上的一行提醒 */
export function TableReminderMark({ reminder, name }: { reminder: TableReminder; name: string }) {
  return reminder.kind === 'overdue' ? (
    <span className="mt-1 flex items-center gap-1 text-[16px] font-bold text-clay" data-testid={`table-reminder-${name}`} data-kind="overdue">
      <AlarmClock className="size-4 shrink-0" /> 已过预计恢复时间
    </span>
  ) : (
    <span className="mt-1 flex items-center gap-1 text-[16px] font-bold text-ember-deep" data-testid={`table-reminder-${name}`} data-kind="dirty_long">
      <AlarmClock className="size-4 shrink-0" /> 已待清台 {minutesLabel(reminder.minutes)}
    </span>
  );
}

/** 桌台页顶上的待办：几桌、各是什么（没有时不显示） */
export function TablesTodoLine({ todo, minutes }: { todo: ReturnType<typeof tableTodos>; minutes: number }) {
  if (todo.total === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px] font-bold text-clay" data-testid="tables-todo">
      <AlarmClock className="size-4 shrink-0" /> 待办 {todo.total} 桌
      {todo.overdue > 0 && (
        <span className="flex items-center gap-1 font-semibold">
          <Wrench className="size-3.5" />
          已过预计恢复时间 {todo.overdue}
        </span>
      )}
      {todo.dirtyLong > 0 && (
        <span className="flex items-center gap-1 font-semibold text-ember-deep">
          <Brush className="size-3.5" />
          待清台超过 {minutes} 分钟 {todo.dirtyLong}
        </span>
      )}
    </span>
  );
}

/** 「桌台」页签上的待办数（餐饮的待办数）：没在用餐的桌里要提醒的几桌；没有时不显示 */
export function TablesTodoBadge({ enabled }: { enabled: boolean }) {
  const board = useTablesBoard(enabled);
  const minutes = useDirtyAlertMinutes();
  const now = useServerNow(board.data?.serverTime, 30_000);
  if (!enabled || !board.data) return null;
  const todo = tableTodos(board.data.tables, now, minutes);
  if (todo.total === 0) return null;
  return (
    <span
      className="ml-1.5 inline-flex h-[22px] items-center rounded-full bg-clay-soft px-2 text-[12px] font-bold text-clay"
      title={`已过预计恢复时间 ${todo.overdue} 桌，待清台超过 ${minutes} 分钟 ${todo.dirtyLong} 桌`}
      data-testid="tables-todo-badge"
    >
      待办 {todo.total}
    </span>
  );
}
