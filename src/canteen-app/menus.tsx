// 菜单的读取（离线时用上次看到的）、点赞（先变心、再交给门店系统，失败了变回来）与菜的显示。

import { useCallback, useEffect, useState } from 'react';
import { DISH_TAG_EMOJI, DISH_TAG_LABELS, MEAL_EMOJI, MEAL_LABELS, type CanteenMenu, type Dish, type Meal, type MealWindow } from '@shared/canteen';
import { call, messageOf, NetworkError, readJson, writeJson } from './lib';
import { cn, Pill, toast } from './ui';

const CACHE_KEY = 'yuzu.canteen.menus.v1';

export function useMenus(from: string, to: string) {
  const [menus, setMenus] = useState<CanteenMenu[] | null>(null);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const list = await call<CanteenMenu[]>('GET', `/api/canteen/menus?from=${from}&to=${to}`);
      setMenus(list);
      setStale(false);
      setError('');
      const cache = readJson<Record<string, CanteenMenu>>(CACHE_KEY) ?? {};
      for (const k of Object.keys(cache)) if (k.slice(0, 10) < from) delete cache[k];
      for (const m of list) cache[`${m.date}:${m.meal}`] = m;
      writeJson(CACHE_KEY, cache);
    } catch (e) {
      const cache = readJson<Record<string, CanteenMenu>>(CACHE_KEY) ?? {};
      const cached = Object.values(cache).filter((m) => m.date >= from && m.date <= to);
      if (e instanceof NetworkError && cached.length) {
        setMenus(cached);
        setStale(true);
      } else {
        setError(messageOf(e));
        setMenus((m) => m ?? []);
      }
    }
  }, [from, to]);
  useEffect(() => {
    void load();
  }, [load]);

  /** 点赞 / 取消：先在页面上变，门店系统没收下就变回来 */
  const like = useCallback(async (menu: CanteenMenu, dishId: string) => {
    const liked = !menu.myLikes.includes(dishId);
    const patch = (m: CanteenMenu, on: boolean, count?: number): CanteenMenu => ({
      ...m,
      myLikes: on ? [...m.myLikes.filter((x) => x !== dishId), dishId] : m.myLikes.filter((x) => x !== dishId),
      likes: { ...m.likes, [dishId]: count ?? Math.max(0, (m.likes[dishId] ?? 0) + (on ? 1 : -1)) },
    });
    setMenus((xs) => xs?.map((m) => (m.id === menu.id ? patch(m, liked) : m)) ?? xs);
    try {
      const r = await call<{ likes: number; liked: boolean }>('PUT', '/api/canteen/likes', { menuId: menu.id, dishId, liked });
      setMenus((xs) => xs?.map((m) => (m.id === menu.id ? patch(m, r.liked, r.likes) : m)) ?? xs);
    } catch (e) {
      setMenus((xs) => xs?.map((m) => (m.id === menu.id ? patch(m, !liked) : m)) ?? xs);
      toast(e instanceof NetworkError ? '网络不太好，等会儿再点赞吧' : messageOf(e), 'error');
    }
  }, []);

  return { menus, stale, error, reload: load, like };
}

export function DishRow({ dish, likes, liked, onLike }: { dish: Dish; likes: number; liked: boolean; onLike?: () => void }) {
  return (
    <li className="flex items-center gap-3 py-2">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-cream text-[24px]" aria-hidden>
        {dish.emoji}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[16px] font-bold">{dish.name}</p>
        {dish.tags.length > 0 && (
          <div className="mt-0.5 flex flex-wrap gap-1">
            {dish.tags.map((t) => (
              <Pill key={t} tone={t === 'spicy' ? 'peach' : t === 'veg' ? 'leaf' : 'yuzu'}>
                {DISH_TAG_EMOJI[t]} {DISH_TAG_LABELS[t]}
              </Pill>
            ))}
          </div>
        )}
      </div>
      {onLike && (
        <button
          type="button"
          onClick={onLike}
          aria-pressed={liked}
          aria-label={`${liked ? '取消点赞' : '点赞'}：${dish.name}`}
          className={cn(
            'flex h-10 min-w-14 items-center justify-center gap-1 rounded-full px-3 text-[14px] font-extrabold transition-all active:scale-90',
            liked ? 'bg-peach text-white' : 'bg-cream text-ink-3',
          )}
        >
          <span className={cn(liked && 'animate-pop')}>{liked ? '❤️' : '🤍'}</span>
          <span className="num">{likes}</span>
        </button>
      )}
    </li>
  );
}

/** 一餐的卡片：标题（餐次、开饭时间）+ 菜；没有发布的写「还在想」 */
export function MealCard({
  meal,
  window,
  menu,
  onLike,
  badge,
  highlight,
}: {
  meal: Meal;
  window?: MealWindow;
  menu?: CanteenMenu;
  onLike?: (menu: CanteenMenu, dishId: string) => void;
  badge?: React.ReactNode;
  highlight?: boolean;
}) {
  return (
    <section className={cn('rounded-[var(--radius-card)] p-4 shadow-[var(--shadow-soft)] ring-1', highlight ? 'bg-yuzu-soft ring-yuzu/60' : 'bg-card ring-line/70')} data-testid={`meal-${meal}`}>
      <header className="flex items-center gap-2">
        <span className="text-[24px]" aria-hidden>
          {MEAL_EMOJI[meal]}
        </span>
        <h3 className="text-[18px] font-black">{MEAL_LABELS[meal]}</h3>
        {window && (
          <span className="num text-[13px] font-semibold text-ink-2">
            {window.start}–{window.end}
          </span>
        )}
        <span className="ml-auto">{badge}</span>
      </header>
      {menu && menu.dishes.length > 0 ? (
        <>
          <ul className="mt-2 divide-y divide-line/70">
            {menu.dishes.map((d) => (
              <DishRow key={d.id} dish={d} likes={menu.likes[d.id] ?? 0} liked={menu.myLikes.includes(d.id)} onLike={onLike && menu.published ? () => onLike(menu, d.id) : undefined} />
            ))}
          </ul>
          {menu.note && <p className="mt-2 rounded-2xl bg-cream px-3 py-2 text-[14px] text-ink-2">📝 {menu.note}</p>}
        </>
      ) : (
        <p className="mt-3 text-[14px] text-ink-3">厨师还在想这一顿做什么～</p>
      )}
    </section>
  );
}
