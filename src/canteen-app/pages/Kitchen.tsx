// 厨房（厨师、负责人）：选日子和餐次，加菜、选表情和标签、写一句话，保存草稿或发布给大家。
// 改菜单带版本号：别人刚改过时提示，看过最新的再决定覆盖不覆盖；保存的回复没收到时「原样重试」（同一个编号、同一个版本）。

import { useCallback, useEffect, useState } from 'react';
import {
  DISH_TAG_EMOJI,
  DISH_TAG_LABELS,
  DISH_TAGS,
  MEAL_EMOJI,
  MEAL_LABELS,
  MENU_LIMITS,
  suggestDishEmoji,
  type CanteenMe,
  type CanteenMenu,
  type Dish,
  type DishTag,
  type Meal,
} from '@shared/canteen';
import { ApiError, addDays, call, dayLabel, messageOf, monthDay, NetworkError, storeNow, timeText, uuid } from '../lib';
import { Mascot } from '../Mascot';
import { Button, Card, cn, inputClass, Pill, Sheet, toast } from '../ui';

const FOOD = ['🍚', '🍜', '🥟', '🍲', '🥣', '🐟', '🍤', '🦐', '🍗', '🥩', '🍖', '🥓', '🥚', '🫘', '🥬', '🥦', '🍅', '🥕', '🌽', '🍄', '🥔', '🍠', '🍆', '🌶️', '🍞', '🥯', '🍡', '🍮', '🍉', '🍎', '🧋', '🍵'];
const newId = () => Math.random().toString(36).slice(2, 8);
type Draft = { dishes: (Dish & { auto: boolean })[]; note: string };
const fromMenu = (m?: CanteenMenu): Draft => ({ dishes: (m?.dishes ?? []).map((d) => ({ ...d, auto: false })), note: m?.note ?? '' });

interface Pending {
  key: string;
  date: string;
  meal: Meal;
  body: { clientKey: string; version: number; dishes: Dish[]; note: string; published: boolean };
}

export function KitchenPage({ me, offsetMs }: { me: CanteenMe; offsetMs: number }) {
  const today = storeNow(offsetMs).date;
  const days = Array.from({ length: 8 }, (_, i) => addDays(today, i - 1));
  const meals = me.meals.filter((w) => w.enabled).map((w) => w.meal);
  const [date, setDate] = useState(today);
  const [meal, setMeal] = useState<Meal>(meals[1] ?? meals[0] ?? 'lunch');
  const [server, setServer] = useState<CanteenMenu | undefined>();
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState<Draft>(fromMenu());
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [conflict, setConflict] = useState<CanteenMenu | null>(null);
  const [emojiFor, setEmojiFor] = useState<string | null>(null);

  const fetchMenu = useCallback(async (d: string, m: Meal) => (await call<CanteenMenu[]>('GET', `/api/canteen/menus?from=${d}&to=${d}`)).find((x) => x.meal === m), []);
  const load = useCallback(async () => {
    setLoaded(false);
    try {
      const m = await fetchMenu(date, meal);
      setServer(m);
      setDraft(fromMenu(m));
      setDirty(false);
    } catch (e) {
      toast(messageOf(e), 'error');
    } finally {
      setLoaded(true);
    }
  }, [date, meal, fetchMenu]);
  useEffect(() => {
    void load();
  }, [load]);

  const edit = (fn: (d: Draft) => Draft) => {
    setDraft(fn);
    setDirty(true);
  };
  const setDish = (id: string, patch: Partial<Dish & { auto: boolean }>) => edit((d) => ({ ...d, dishes: d.dishes.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));

  const send = async (body: Pending['body'], d = date, m = meal) => {
    setBusy(true);
    const key = `${d}:${m}`;
    try {
      const saved = await call<CanteenMenu>('PUT', `/api/canteen/menus/${d}/${m}`, body);
      setPending(null);
      if (d === date && m === meal) {
        setServer(saved);
        setDraft(fromMenu(saved));
        setDirty(false);
      }
      toast(saved.published ? '发布啦，大家都能看到了 🎉' : '草稿存好了', 'ok');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'MENU_CHANGED') {
        setPending(null);
        setConflict((await fetchMenu(d, m).catch(() => undefined)) ?? null);
      } else if (e instanceof NetworkError) {
        // 结果不确定：留着原来的编号和内容，原样重试不会存两遍
        setPending({ key, date: d, meal: m, body });
      } else {
        setPending(null);
        toast(messageOf(e), 'error');
      }
    } finally {
      setBusy(false);
    }
  };

  const save = (published: boolean, version = server?.version ?? 0) => {
    const dishes = draft.dishes.filter((x) => x.name.trim()).map(({ auto: _auto, ...x }) => ({ ...x, name: x.name.trim() }));
    if (published && !dishes.length) return toast('还没有菜，加几道再发布吧', 'error');
    void send({ clientKey: uuid(), version, dishes, note: draft.note.trim(), published });
  };

  const copyFrom = async (from: string) => {
    try {
      const m = await fetchMenu(from, meal);
      if (!m?.dishes.length) return toast(`${dayLabel(from, today)}的${MEAL_LABELS[meal]}没有菜`, 'info');
      edit((d) => ({ ...d, dishes: m.dishes.map((x) => ({ ...x, id: newId(), auto: false })) }));
      toast(`带出了 ${m.dishes.length} 道菜，改一改再发布`, 'ok');
    } catch (e) {
      toast(messageOf(e), 'error');
    }
  };

  const likes = server?.published ? Object.values(server.likes).reduce((a, b) => a + b, 0) : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <h1 className="text-[24px] font-black tracking-tight">厨房 👩‍🍳</h1>
        {likes > 0 && <Pill tone="peach">今天这顿收到 {likes} 个 ❤️</Pill>}
      </div>

      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1" role="tablist" aria-label="选日子">
        {days.map((d) => (
          <button
            key={d}
            type="button"
            role="tab"
            aria-selected={d === date}
            onClick={() => (!dirty || confirm('改的还没保存，换日子会丢掉，确定吗？')) && setDate(d)}
            className={cn('flex min-w-[60px] shrink-0 flex-col items-center rounded-2xl px-3 py-2', d === date ? 'bg-ink text-cream' : 'bg-card text-ink-2 ring-1 ring-line')}
          >
            <span className="text-[13px] font-extrabold">{dayLabel(d, today)}</span>
            <span className="num text-[11px]">{monthDay(d)}</span>
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        {meals.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => (!dirty || confirm('改的还没保存，换餐次会丢掉，确定吗？')) && setMeal(m)}
            aria-pressed={m === meal}
            className={cn('flex-1 rounded-2xl py-2.5 text-[15px] font-extrabold', m === meal ? 'bg-yuzu text-ink shadow-[0_3px_0_#e0a91c]' : 'bg-card text-ink-2 ring-1 ring-line')}
          >
            {MEAL_EMOJI[m]} {MEAL_LABELS[m]}
          </button>
        ))}
      </div>

      {pending && (
        <Card className="bg-sky-soft ring-sky/30">
          <p className="text-[15px] font-extrabold text-[#1f6fa8]">上一次保存没收到回复（{monthDay(pending.date)} {MEAL_LABELS[pending.meal]}）</p>
          <p className="mt-1 text-[13px] text-ink-2">可能存好了，也可能没有。点「原样重试」：同一个编号，不会存两遍。</p>
          <Button className="mt-3" tone="ink" disabled={busy} onClick={() => void send(pending.body, pending.date, pending.meal)}>
            原样重试
          </Button>
        </Card>
      )}

      <Card>
        <div className="flex items-center gap-2">
          <h2 className="text-[17px] font-black">
            {dayLabel(date, today)} {MEAL_LABELS[meal]}
          </h2>
          {server ? server.published ? <Pill tone="leaf">已发布</Pill> : <Pill tone="ink">草稿</Pill> : <Pill tone="ink">还没写</Pill>}
          {server?.updatedByName && <span className="ml-auto text-[12px] text-ink-3">{server.updatedByName} {timeText(server.updatedAt)} 改的</span>}
        </div>
        {!loaded ? (
          <p className="py-6 text-center text-[14px] text-ink-3">正在取菜单…</p>
        ) : (
          <>
            {draft.dishes.length === 0 && (
              <div className="flex flex-col items-center py-4">
                <Mascot mood="yum" className="size-20" />
                <p className="mt-1 text-[14px] text-ink-3">今天做什么好吃的？</p>
              </div>
            )}
            <ul className="mt-2 space-y-3">
              {draft.dishes.map((d, i) => (
                <li key={d.id} className="rounded-2xl bg-cream p-2.5" data-testid="dish-editor">
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => setEmojiFor(d.id)} className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-white text-[24px] ring-1 ring-line" aria-label="换表情">
                      {d.emoji || suggestDishEmoji(d.name)}
                    </button>
                    <input
                      className={`${inputClass} h-11`}
                      value={d.name}
                      maxLength={MENU_LIMITS.name}
                      placeholder={`第 ${i + 1} 道菜`}
                      aria-label={`第 ${i + 1} 道菜的名字`}
                      onChange={(e) => setDish(d.id, { name: e.target.value, ...(d.auto ? { emoji: suggestDishEmoji(e.target.value) } : {}) })}
                    />
                    <button type="button" onClick={() => edit((x) => ({ ...x, dishes: x.dishes.filter((y) => y.id !== d.id) }))} className="size-9 shrink-0 rounded-full text-[18px] text-ink-3 active:bg-white" aria-label={`删掉第 ${i + 1} 道菜`}>
                      ✕
                    </button>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5 pl-[52px]">
                    {DISH_TAGS.map((t: DishTag) => {
                      const on = d.tags.includes(t);
                      return (
                        <button
                          key={t}
                          type="button"
                          aria-pressed={on}
                          onClick={() => setDish(d.id, { tags: on ? d.tags.filter((x) => x !== t) : [...d.tags, t] })}
                          className={cn('rounded-full px-2.5 py-1 text-[12px] font-bold', on ? 'bg-ink text-cream' : 'bg-white text-ink-2 ring-1 ring-line')}
                        >
                          {DISH_TAG_EMOJI[t]} {DISH_TAG_LABELS[t]}
                        </button>
                      );
                    })}
                    {server?.published && (server.likes[d.id] ?? 0) > 0 && <Pill tone="peach">❤️ {server.likes[d.id]}</Pill>}
                  </div>
                </li>
              ))}
            </ul>
            {draft.dishes.length < MENU_LIMITS.dishes && (
              <Button tone="ghost" className="mt-3 w-full" onClick={() => edit((x) => ({ ...x, dishes: [...x.dishes, { id: newId(), name: '', emoji: '', tags: [], auto: true }] }))}>
                ＋ 加一道菜
              </Button>
            )}
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Button tone="ghost" onClick={() => void copyFrom(addDays(date, -1))}>
                复制前一天
              </Button>
              <Button tone="ghost" onClick={() => void copyFrom(addDays(date, -7))}>
                复制上周这天
              </Button>
            </div>
            <textarea
              className="mt-3 min-h-20 w-full rounded-2xl bg-white p-3 text-[15px] ring-2 ring-line outline-none focus:ring-yuzu"
              placeholder="一句话（可以不写）：例如今天有甜品哦"
              maxLength={MENU_LIMITS.note}
              value={draft.note}
              onChange={(e) => edit((x) => ({ ...x, note: e.target.value }))}
              aria-label="一句话备注"
            />
          </>
        )}
      </Card>

      <div className="grid grid-cols-2 gap-3">
        <Button tone="ghost" big disabled={busy || !loaded} onClick={() => save(false)}>
          {server?.published ? '撤回成草稿' : '存草稿'}
        </Button>
        <Button tone="leaf" big disabled={busy || !loaded} onClick={() => save(true)}>
          {server?.published ? '更新菜单' : '发布给大家'}
        </Button>
      </div>

      <Sheet open={!!emojiFor} onClose={() => setEmojiFor(null)} title="选个表情">
        <div className="grid grid-cols-8 gap-1.5 pb-4">
          {FOOD.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => {
                if (emojiFor) setDish(emojiFor, { emoji: e, auto: false });
                setEmojiFor(null);
              }}
              className="flex aspect-square items-center justify-center rounded-xl bg-card text-[24px] ring-1 ring-line active:scale-90"
            >
              {e}
            </button>
          ))}
        </div>
      </Sheet>
      <Sheet open={!!conflict} onClose={() => setConflict(null)} title="菜单刚被别人改过">
        <div className="space-y-3 pb-6">
          <p className="text-[15px] text-ink-2">
            {conflict?.updatedByName ?? '别人'} {conflict && timeText(conflict.updatedAt)} 改过这份菜单，现在是 {conflict?.dishes.length ?? 0} 道菜：
          </p>
          <p className="rounded-2xl bg-card p-3 text-[14px]">{conflict?.dishes.map((d) => `${d.emoji}${d.name}`).join('、') || '（空的）'}</p>
          <Button
            tone="ghost"
            className="w-full"
            onClick={() => {
              setServer(conflict ?? undefined);
              setDraft(fromMenu(conflict ?? undefined));
              setDirty(false);
              setConflict(null);
            }}
          >
            看最新的（放弃我刚才的修改）
          </Button>
          <Button
            tone="peach"
            className="w-full"
            onClick={() => {
              const v = conflict?.version ?? 0;
              setServer(conflict ?? undefined);
              setConflict(null);
              save(conflict?.published ?? false, v);
            }}
          >
            用我的覆盖
          </Button>
        </div>
      </Sheet>
    </div>
  );
}
