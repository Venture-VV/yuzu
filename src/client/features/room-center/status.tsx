// 房态中心五种状态的样子：颜色（都走样式表里的色名，深浅两套主题跟着变）+ 文字 + 图标，卡片、数量、总览的小方块共用这一张表。
// 空闲 绿、在用 蓝、待清 黄、维修 红、已预订 灰（《浴族系统需求汇总》房态中心第 2 条）。

import { CalendarClock, CircleCheck, Sparkles, Timer, Wrench } from 'lucide-react';
import { ROOM_COUNT_KEY, ROOM_STATUS_LABELS, ROOM_STATUSES, type RoomCounts, type RoomStatus } from '@shared/room-center';
import { cn } from '../../lib/utils';

export const STATUS_META: Record<RoomStatus, { icon: typeof Timer; card: string; text: string; dot: string }> = {
  free: { icon: CircleCheck, card: 'border-pine/35 bg-pine-tint', text: 'text-pine', dot: 'bg-pine' },
  in_use: { icon: Timer, card: 'border-lake/40 bg-lake-soft/60', text: 'text-lake', dot: 'bg-lake' },
  dirty: { icon: Sparkles, card: 'border-yuzu-deep/45 bg-yuzu-tint', text: 'text-yuzu-deep', dot: 'bg-yuzu' },
  maintenance: { icon: Wrench, card: 'border-clay/40 bg-clay-soft/50', text: 'text-clay', dot: 'bg-clay' },
  booked: { icon: CalendarClock, card: 'border-line-strong bg-paper-2', text: 'text-ink-2', dot: 'bg-ink-3' },
};

/** 状态章：图标 + 文字（16 像素），底色用卡片色、边线与字用状态色——放在哪种底色的卡片上都看得清 */
export function StatusChip({ status, className }: { status: RoomStatus; className?: string }) {
  const m = STATUS_META[status];
  const Icon = m.icon;
  return (
    <span
      className={cn('inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-current/30 bg-card px-2.5 text-[16px] leading-none font-bold whitespace-nowrap', m.text, className)}
      data-testid="rc-status"
    >
      <Icon className="size-4" aria-hidden />
      {ROOM_STATUS_LABELS[status]}
    </span>
  );
}

/**
 * 一排数量：全部、空闲、在用、待清、维修、已预订。给了 onFilter 就是能点的（点一下只看这一种，再点一下看全部）。
 * 每个都是图标 + 文字 + 数字，按钮高 44 像素。
 */
export function CountChips({ counts, filter, onFilter, testId }: { counts: RoomCounts; filter?: RoomStatus | null; onFilter?: (s: RoomStatus | null) => void; testId?: string }) {
  const base = 'flex h-11 min-w-[72px] flex-1 items-center justify-center gap-1.5 rounded-lg border px-2.5 text-[13px] font-semibold whitespace-nowrap sm:flex-none sm:px-3.5';
  const total = (
    <>
      全部 <b className="num text-[18px] text-ink">{counts.total}</b>
    </>
  );
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="各状态的房间数" data-testid={testId}>
      {onFilter ? (
        <button
          type="button"
          onClick={() => onFilter(null)}
          aria-pressed={!filter}
          className={cn(base, 'text-ink-2', !filter ? 'border-ink-3 bg-card' : 'border-line bg-paper hover:border-line-strong')}
          data-testid="rc-count-total"
        >
          {total}
        </button>
      ) : (
        <span className={cn(base, 'border-line bg-paper text-ink-2')} data-testid="rc-count-total">
          {total}
        </span>
      )}
      {ROOM_STATUSES.map((s) => {
        const m = STATUS_META[s];
        const Icon = m.icon;
        const on = filter === s;
        const inner = (
          <>
            <Icon className="size-4" aria-hidden />
            {ROOM_STATUS_LABELS[s]} <b className="num text-[18px]">{counts[ROOM_COUNT_KEY[s]]}</b>
          </>
        );
        return onFilter ? (
          <button
            key={s}
            type="button"
            onClick={() => onFilter(on ? null : s)}
            aria-pressed={on}
            className={cn(base, m.text, on ? cn(m.card, 'ring-2 ring-current/40') : 'border-line bg-card hover:border-line-strong')}
            data-testid={`rc-count-${s}`}
          >
            {inner}
          </button>
        ) : (
          <span key={s} className={cn(base, m.text, 'border-line bg-card')} data-testid={`rc-count-${s}`}>
            {inner}
          </span>
        );
      })}
    </div>
  );
}
