// 首页：打招呼、现在（或下一顿）吃什么、亮出饭卡码；跟柚子说的一栏；今天的其他几顿。
// 能收提醒、还没决定过的手机，问一句要不要柚子到点喊你吃饭（docs/CANTEEN.md 第 19 节）。

import { useEffect, useMemo, useState } from 'react';
import { canScan, canUseMailbox, type CanteenMe, type Meal, type MealWindow } from '@shared/canteen';
import { Mascot } from '../Mascot';
import { IconArrow, IconCamera, IconLetter, IconShield, IconTicket } from '../doodles';
import { addDays, call, storeNow } from '../lib';
import { MealCard, useMenus } from '../menus';
import { ReminderPrompt } from '../reminders';
import { Button, Pill, Stamp } from '../ui';

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
          <p className="eyebrow">Yuzu Canteen · 汤崎</p>
          <p className="mt-1 text-[14px] font-bold text-ink-2">{greeting(clock.minute)}，</p>
          <h1 className="truncate text-[26px] font-black tracking-tight">
            <span className="marker">{me.employee.name}</span>
          </h1>
        </div>
        <button
          type="button"
          onClick={() => go('me')}
          className="flex size-14 items-center justify-center rounded-full bg-card text-[30px] shadow-[var(--shadow-sticker)] ring-2 ring-wood-4 active:scale-95"
          aria-label="我的"
        >
          {me.employee.avatar}
        </button>
      </header>

      {!online && <p className="rounded-2xl bg-sky-soft px-4 py-2.5 text-[14px] font-bold text-relax">现在没网：饭卡码照样能亮，菜单是上次看到的</p>}
      <ReminderPrompt online={online} />
      {stale && online && <p className="rounded-2xl bg-sky-soft px-4 py-2.5 text-[14px] font-bold text-relax">菜单是上次看到的，联网后会更新</p>}

      <div data-tour="focus-meal">
        {focus ? (
          <MealCard
            meal={focus.meal}
            window={focus.window}
            menu={menuOf(focus.afterMidnight ? addDays(today, -1) : today, focus.meal)}
            onLike={like}
            highlight
            stamp={focus.open ? <Stamp>开饭中</Stamp> : undefined}
            badge={focus.open ? undefined : <Pill tone="sky">{focus.window.start} 开饭</Pill>}
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
      </div>

      <Button big tone="yuzu" className="w-full" onClick={() => go('code')} data-testid="show-code">
        <IconTicket size={26} /> 亮出饭卡码
      </Button>
      {canScan(me.employee.role) && (
        <Button big className="w-full" onClick={() => go('scan')}>
          <IconCamera size={26} fill="var(--color-yuzu)" /> 扫码打卡
        </Button>
      )}
      {canUseMailbox(me.employee.role) && <MailboxEntry online={online} go={go} />}
      {/* 工作台（8.0.9）：有巡场的人直接去巡场，只看记录的去巡场记录 */}
      {(me.apps?.length ?? 0) > 0 && (
        <button
          type="button"
          onClick={() => go(me.apps!.includes('patrol') ? 'patrol' : 'patrolLog')}
          data-testid="home-work"
          className="sketch flex w-full items-center gap-3 rounded-[var(--radius-card)] bg-yuzu-soft px-4 py-3 text-left shadow-[var(--shadow-sticker)] active:scale-[0.99]"
        >
          <IconShield size={34} fill="var(--color-yuzu)" />
          <span className="min-w-0 flex-1">
            <span className="block text-[17px] font-black">{me.apps!.includes('patrol') ? '巡场打卡' : '巡场记录'}</span>
            <span className="block text-[13px] text-ink-3">{me.apps!.includes('patrol') ? '巡到哪里，扫哪里的场所二维码' : '每天谁几点巡了哪里'}</span>
          </span>
          <IconArrow size={22} className="shrink-0 text-wood-deep" />
        </button>
      )}

      {/* 跟柚子说（第二期，K16）：员工面板上的反馈栏 */}
      <button
        type="button"
        onClick={() => go('talk')}
        data-tour="talk-entry"
        data-testid="talk-entry"
        className="sketch flex w-full items-center gap-3 rounded-[var(--radius-card)] bg-card py-2 pr-4 pl-2 text-left shadow-[var(--shadow-sticker)] active:scale-[0.99]"
      >
        <Mascot mood="wink" className="h-20 w-auto shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="eyebrow block">Talk to Yuzu</span>
          <span className="mt-0.5 flex items-center gap-1.5 text-[17px] font-black">
            <IconLetter size={22} fill="var(--color-yuzu)" /> 跟柚子说
          </span>
          <span className="mt-0.5 block text-[13px] leading-snug text-ink-2">想让柚子在汤崎的线上空间做什么？有什么碎碎念，都可以跟我说～</span>
        </span>
        <span className="text-ink-3">
          <IconArrow size={20} />
        </span>
      </button>

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
      <p className="pt-2 text-center text-[13px] text-ink-3">这个月在饭堂吃了 {me.mealsThisMonth} 顿 · 喜欢的菜记得点个赞</p>
    </div>
  );
}

/** 食堂负责人：柚子信箱的入口（店主 2026-11-10，docs/CANTEEN.md 第 18 节，K20），写着还有几条没看过 */
function MailboxEntry({ online, go }: { online: boolean; go: (route: string) => void }) {
  const [unread, setUnread] = useState<number | null>(null);
  useEffect(() => {
    if (!online) return;
    call<{ unread: number }>('GET', '/api/canteen/mailbox/unread')
      .then((r) => setUnread(r.unread))
      .catch(() => undefined);
  }, [online]);
  return (
    <button
      type="button"
      onClick={() => go('mailbox')}
      data-testid="mailbox-entry"
      className="flex w-full items-center gap-3 rounded-[var(--radius-card)] bg-card px-4 py-3 text-left shadow-[var(--shadow-soft)] ring-1 ring-line/80 active:scale-[0.99]"
    >
      <span className="text-[26px] leading-none">📮</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[16px] font-black">柚子信箱</span>
        <span className="block text-[13px] text-ink-2">同事们跟柚子说的话，在这里看、回信</span>
      </span>
      {!!unread && (
        <span className="num rounded-full bg-energy px-2.5 py-0.5 text-[13px] font-black text-white" data-testid="mailbox-entry-unread">
          {unread} 条没看
        </span>
      )}
      <span className="text-ink-3">
        <IconArrow size={20} />
      </span>
    </button>
  );
}
