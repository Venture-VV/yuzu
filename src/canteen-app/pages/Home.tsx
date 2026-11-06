// 首页：打招呼、现在（或下一顿）吃什么、亮出饭卡码；今天的其他几顿。

import { useMemo } from 'react';
import { canScan, type CanteenMe, type Meal, type MealWindow } from '@shared/canteen';
import { Mascot } from '../Mascot';
import { addDays, storeNow } from '../lib';
import { MealCard, useMenus } from '../menus';
import { Button, Pill } from '../ui';

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

function greeting(minute: number) {
  if (minute < 300) return '夜深了';
  if (minute < 660) return '早上好';
  if (minute < 840) return '中午好';
  if (minute < 1080) return '下午好';
  if (minute < 1380) return '晚上好';
  return '夜深了';
}

/** 现在在开饭的那一顿、或今天下一顿；都过了返回 null。afterMidnight：跨午夜的夜宵过了零点，菜单记在前一天 */
function mealNow(windows: MealWindow[], minute: number): { meal: Meal; window: MealWindow; open: boolean; afterMidnight: boolean } | null {
  const on = windows.filter((w) => w.enabled);
  for (const w of on) {
    const s = toMin(w.start);
    const e = toMin(w.end);
    const open = s < e ? minute >= s && minute < e : minute >= s || minute < e;
    if (open) return { meal: w.meal, window: w, open: true, afterMidnight: s > e && minute < e };
  }
  const next = on.filter((w) => toMin(w.start) > minute).sort((a, b) => toMin(a.start) - toMin(b.start))[0];
  return next ? { meal: next.meal, window: next, open: false, afterMidnight: false } : null;
}

export function HomePage({ me, offsetMs, online, go }: { me: CanteenMe; offsetMs: number; online: boolean; go: (route: string) => void }) {
  const clock = storeNow(offsetMs);
  const today = clock.date;
  const tomorrow = addDays(today, 1);
  const { menus, stale, like } = useMenus(addDays(today, -1), tomorrow);
  const focus = useMemo(() => mealNow(me.meals, clock.minute), [me.meals, clock.minute]);
  const menuOf = (date: string, meal: Meal) => menus?.find((m) => m.date === date && m.meal === meal);
  const enabled = me.meals.filter((w) => w.enabled);
  const firstTomorrow = enabled[0];

  return (
    <div className="space-y-4">
      <header className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-bold text-ink-2">{greeting(clock.minute)}，</p>
          <h1 className="truncate text-[26px] font-black tracking-tight">{me.employee.name} 👋</h1>
        </div>
        <button
          type="button"
          onClick={() => go('me')}
          className="flex size-14 items-center justify-center rounded-full bg-card text-[30px] shadow-[var(--shadow-soft)] ring-2 ring-yuzu active:scale-95"
          aria-label="我的"
        >
          {me.employee.avatar}
        </button>
      </header>

      {!online && (
        <p className="rounded-2xl bg-sky-soft px-4 py-2.5 text-[14px] font-bold text-[#1f6fa8]">📶 现在没网：饭卡码照样能亮，菜单是上次看到的</p>
      )}
      {stale && online && <p className="rounded-2xl bg-sky-soft px-4 py-2.5 text-[14px] font-bold text-[#1f6fa8]">菜单是上次看到的，联网后会更新</p>}

      {focus ? (
        <MealCard
          meal={focus.meal}
          window={focus.window}
          menu={menuOf(focus.afterMidnight ? addDays(today, -1) : today, focus.meal)}
          onLike={like}
          highlight
          badge={focus.open ? <Pill tone="leaf">开饭中</Pill> : <Pill tone="sky">{focus.window.start} 开饭</Pill>}
        />
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-3 rounded-[var(--radius-card)] bg-card px-4 py-3 shadow-[var(--shadow-soft)] ring-1 ring-line/70">
            <Mascot mood="sleepy" className="size-14 shrink-0" />
            <p className="text-[15px] font-bold text-ink-2">今天的饭都开完啦，明天见～</p>
          </div>
          {firstTomorrow && <MealCard meal={firstTomorrow.meal} window={firstTomorrow} menu={menuOf(tomorrow, firstTomorrow.meal)} onLike={like} badge={<Pill tone="ink">明天</Pill>} />}
        </div>
      )}

      <Button big className="w-full" onClick={() => go('code')} data-testid="show-code">
        <span className="text-[22px]">🎫</span> 亮出饭卡码
      </Button>
      {canScan(me.employee.role) && (
        <Button big tone="leaf" className="w-full" onClick={() => go('scan')}>
          <span className="text-[22px]">📷</span> 扫码打卡
        </Button>
      )}

      <section className="space-y-3">
        <h2 className="px-1 text-[15px] font-extrabold text-ink-2">今天的菜单</h2>
        {enabled
          .filter((w) => w.meal !== focus?.meal)
          .map((w) => (
            <MealCard key={w.meal} meal={w.meal} window={w} menu={menuOf(today, w.meal)} onLike={like} />
          ))}
        <button type="button" onClick={() => go('menu')} className="w-full rounded-2xl py-3 text-[15px] font-bold text-ink-2 active:bg-cream-2">
          明天吃什么？看看这周的菜单 →
        </button>
      </section>
      {enabled.length === 0 && <p className="text-center text-[14px] text-ink-3">管理员还没设开饭时间</p>}
      <p className="pt-2 text-center text-[13px] text-ink-3">这个月在饭堂吃了 {me.mealsThisMonth} 顿 🍚 喜欢的菜记得点个赞</p>
    </div>
  );
}
