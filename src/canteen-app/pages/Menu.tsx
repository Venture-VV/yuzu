// 这周的菜单：七天横着滑，点哪天看哪天；已发布的菜都能点赞。

import { useState } from 'react';
import type { CanteenMe } from '@shared/canteen';
import { addDays, dayLabel, monthDay, storeNow } from '../lib';
import { MealCard, useMenus } from '../menus';
import { cn } from '../ui';

export function MenuPage({ me, offsetMs }: { me: CanteenMe; offsetMs: number }) {
  const today = storeNow(offsetMs).date;
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i));
  const [day, setDay] = useState(today);
  const { menus, stale, like } = useMenus(today, days[6]!);
  const enabled = me.meals.filter((w) => w.enabled);
  return (
    <div className="space-y-4">
      <h1 className="text-[24px] font-black tracking-tight">这周吃什么 🍽️</h1>
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1" role="tablist" aria-label="选日子">
        {days.map((d) => (
          <button
            key={d}
            type="button"
            role="tab"
            aria-selected={d === day}
            onClick={() => setDay(d)}
            className={cn(
              'flex min-w-[64px] shrink-0 flex-col items-center rounded-2xl px-3 py-2 transition-all active:scale-95',
              d === day ? 'bg-yuzu font-black text-ink shadow-[0_3px_0_#e0a91c]' : 'bg-card text-ink-2 ring-1 ring-line',
            )}
          >
            <span className="text-[14px] font-extrabold">{dayLabel(d, today)}</span>
            <span className="num text-[12px]">{monthDay(d)}</span>
          </button>
        ))}
      </div>
      {stale && <p className="rounded-2xl bg-sky-soft px-4 py-2.5 text-[14px] font-bold text-[#1f6fa8]">没网，显示的是上次看到的菜单</p>}
      <div className="space-y-3">
        {enabled.map((w) => (
          <MealCard key={w.meal} meal={w.meal} window={w} menu={menus?.find((m) => m.date === day && m.meal === w.meal)} onLike={like} />
        ))}
      </div>
    </div>
  );
}
