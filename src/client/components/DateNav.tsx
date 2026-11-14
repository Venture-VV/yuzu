import { ChevronLeft, ChevronRight, Lock } from 'lucide-react';
import { describeDate, shiftDate } from '@shared/labels';
import { cn } from '../lib/utils';

/** 营业日切换：前一天 / 日期选择 / 后一天 / 回到今天 */
export function DateNav({
  value,
  today,
  onChange,
  locked,
  max,
}: {
  value: string;
  today: string;
  onChange: (date: string) => void;
  /** 无权查看历史营业日 */
  locked?: boolean;
  /**
   * 最晚能选到哪一天。不给就是今天——流水、日结、结账记录这些看历史的页面都不给，只能选今天和以前；
   * 只有预约页给「今天 + 规则里最远能约的天数」（店主 2026-11-14 的需求 2：原来预约页也选不了明天）。
   */
  max?: string;
}) {
  const last = max && max > today ? max : today;
  const d = describeDate(value);
  const isToday = value === today;
  if (locked) {
    return (
      <div className="flex h-10 items-center gap-2 rounded-md border border-line bg-card px-3 text-[13.5px] font-semibold shadow-card" title="当前岗位只能查看本营业日">
        <span className="num">{d.md}</span>
        <span className="text-ink-3">{d.weekday}</span>
        <Lock className="size-3.5 text-ink-4" />
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <div className="flex h-10 items-center rounded-md border border-line bg-card shadow-card">
        <button
          type="button"
          aria-label="前一天"
          onClick={() => onChange(shiftDate(value, -1))}
          className="flex h-full w-9 items-center justify-center rounded-l-md text-ink-2 hover:bg-paper-2"
        >
          <ChevronLeft className="size-4" />
        </button>
        <label className="relative flex h-full cursor-pointer items-center gap-2 border-x border-line px-3 text-[13.5px] font-semibold hover:bg-paper-2">
          <span className="num">{d.md}</span>
          <span className="text-ink-3">{d.weekday}</span>
          <input
            type="date"
            aria-label="选择营业日"
            value={value}
            max={last}
            onChange={(e) => e.target.value && onChange(e.target.value)}
            className="absolute inset-0 cursor-pointer opacity-0"
          />
        </label>
        <button
          type="button"
          aria-label="后一天"
          disabled={value >= last}
          onClick={() => onChange(shiftDate(value, 1))}
          className="flex h-full w-9 items-center justify-center rounded-r-md text-ink-2 hover:bg-paper-2 disabled:text-ink-4 disabled:hover:bg-transparent"
        >
          <ChevronRight className="size-4" />
        </button>
      </div>
      <button
        type="button"
        onClick={() => onChange(today)}
        disabled={isToday}
        className={cn(
          'h-10 rounded-md px-3 text-[13px] font-semibold transition-colors',
          isToday ? 'text-ink-4' : 'text-pine hover:bg-pine-tint',
        )}
      >
        今天
      </button>
    </div>
  );
}
