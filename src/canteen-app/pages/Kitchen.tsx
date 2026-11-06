// 厨房（厨师、负责人）：选日子和餐次，加菜、选表情和标签、写一句话，保存草稿或发布给大家。
// 改菜单带版本号：别人刚改过时提示，看过最新的再决定覆盖不覆盖。
// 结果待确认（AGENTS.md）：每次保存先把操作编号与原请求存在这台手机上并读回核对，存不下就不发；回复没收到时留着，
// 刷新、关掉再开也还在，只能「原样重试」（同一个编号、同一个版本，不会存两遍）。重试被拒时，只有能说明原来那次以后也不会生效的
// 才放下：菜单刚被别人改过（版本号已经过去了）、内容本身不对（原来那次是同样的内容）、这一天已经过了能改的日子（日子只会往后走）；
// 没登录、没权限、饭堂暂时关着、正忙都说明不了，照样留着。没确认之前不能再存别的，免得把它顶掉。

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
import { ApiError, addDays, call, dayLabel, messageOf, monthDay, NetworkError, readJson, removeKey, storeNow, timeText, uuid, writeJson } from '../lib';
import { Mascot } from '../Mascot';
import { Button, Card, cn, inputClass, Pill, Sheet, toast } from '../ui';

const FOOD = ['🍚', '🍜', '🥟', '🍲', '🥣', '🐟', '🍤', '🦐', '🍗', '🥩', '🍖', '🥓', '🥚', '🫘', '🥬', '🥦', '🍅', '🥕', '🌽', '🍄', '🥔', '🍠', '🍆', '🌶️', '🍞', '🥯', '🍡', '🍮', '🍉', '🍎', '🧋', '🍵'];
const newId = () => Math.random().toString(36).slice(2, 8);
type Draft = { dishes: (Dish & { auto: boolean })[]; note: string };
const fromMenu = (m?: CanteenMenu): Draft => ({ dishes: (m?.dishes ?? []).map((d) => ({ ...d, auto: false })), note: m?.note ?? '' });

interface Pending {
  date: string;
  meal: Meal;
  body: { clientKey: string; version: number; dishes: Dish[]; note: string; published: boolean };
  savedAt: number;
}
const pendingKey = (employeeId: number) => `yuzu.canteen.menuPending.v1.${employeeId}`;

/** 原样重试被拒时：这个拒绝能说明原来那次以后也不会生效，就返回要告诉厨师的话（放下这一笔）；说明不了返回 null（留着） */
function settledBy(e: unknown, p: Pending, today: string): string | null {
  if (!(e instanceof ApiError)) return null;
  // 内容本身不对：原来那次是同样的内容，一样存不上
  if (e.status === 400 || e.code === 'MENU_EMPTY') return `${messageOf(e)}（上一次保存没存上：改一改再存）`;
  // 这一天已经过了能改的日子：日子只会往后走，原来那次以后也存不上了。往后的日子被拒只会是手机和门店系统的日子差了一点，过一会儿就能改，照样留着
  if (e.code === 'MENU_OUT_OF_RANGE' && p.date < today) return `${monthDay(p.date)} ${MEAL_LABELS[p.meal]}已经过了能改的日子，上一次保存不再重试了`;
  return null;
}

export function KitchenPage({ me, offsetMs }: { me: CanteenMe; offsetMs: number }) {
  const today = storeNow(offsetMs).date;
  const days = Array.from({ length: 8 }, (_, i) => addDays(today, i - 1));
  const meals = me.meals.filter((w) => w.enabled).map((w) => w.meal);
  const [date, setDate] = useState(today);
  const [meal, setMeal] = useState<Meal>(meals[1] ?? meals[0] ?? 'lunch');
  const [server, setServer] = useState<CanteenMenu | undefined>();
  // 编辑框里的内容属于哪一天哪一餐：只有这一份取到了，才能保存（取失败时不会把上一份的菜存到这一份上）
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [loadError, setLoadError] = useState('');
  const [draft, setDraft] = useState<Draft>(fromMenu());
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const storeKey = pendingKey(me.employee.id);
  const [pending, setPending] = useState<Pending | null>(() => readJson<Pending>(storeKey));
  const [conflict, setConflict] = useState<CanteenMenu | null>(null);
  const [emojiFor, setEmojiFor] = useState<string | null>(null);
  const selection = `${date}:${meal}`;
  const latest = useRef(0);
  // 现在选着的那一份：保存的回复回来时拿它比（发出那一刻的 selection 可能已经换掉了）
  const selected = useRef(selection);
  useLayoutEffect(() => {
    selected.current = selection;
  }, [selection]);

  const fetchMenu = useCallback(async (d: string, m: Meal) => (await call<CanteenMenu[]>('GET', `/api/canteen/menus?from=${d}&to=${d}`)).find((x) => x.meal === m), []);
  const load = useCallback(async () => {
    const req = ++latest.current;
    setLoadedFor(null);
    setLoadError('');
    setServer(undefined);
    setDraft(fromMenu());
    setDirty(false);
    try {
      const m = await fetchMenu(date, meal);
      if (req !== latest.current) return;
      setServer(m);
      setDraft(fromMenu(m));
      setLoadedFor(`${date}:${meal}`);
    } catch (e) {
      if (req === latest.current) setLoadError(messageOf(e));
    }
  }, [date, meal, fetchMenu]);
  useEffect(() => {
    void load();
  }, [load]);
  const ready = loadedFor === selection;

  const clearPending = () => {
    removeKey(storeKey);
    setPending(null);
  };

  const edit = (fn: (d: Draft) => Draft) => {
    setDraft(fn);
    setDirty(true);
  };
  const setDish = (id: string, patch: Partial<Dish & { auto: boolean }>) => edit((d) => ({ ...d, dishes: d.dishes.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));

  /** 交一笔（已经存在本机的）：有了明确结果才从本机删掉；回复没收到、或者这次的拒绝说明不了原来那次的，就留着等「原样重试」 */
  const send = async (p: Pending) => {
    const key = `${p.date}:${p.meal}`;
    setBusy(true);
    try {
      const saved = await call<CanteenMenu>('PUT', `/api/canteen/menus/${p.date}/${p.meal}`, p.body);
      clearPending();
      // 厨师可能已经换到别的日子、餐次了：只在还选着这一份时换上存好的内容（还在取的这一份作废：存好的就是最新的）
      if (key === selected.current) {
        latest.current++;
        setServer(saved);
        setDraft(fromMenu(saved));
        setDirty(false);
        setLoadError('');
        setLoadedFor(key);
      }
      toast(saved.published ? '发布啦，大家都能看到了 🎉' : '草稿存好了', 'ok');
    } catch (e) {
      const settled = settledBy(e, p, storeNow(offsetMs).date);
      if (e instanceof ApiError && e.code === 'MENU_CHANGED') {
        // 版本号已经过去了：原来那次以后也不会生效（要么已经存好，要么再也存不上），放下它，给厨师看最新的
        clearPending();
        const latestMenu = (await fetchMenu(p.date, p.meal).catch(() => undefined)) ?? null;
        if (key === selected.current) setConflict(latestMenu);
        else toast(`${monthDay(p.date)} ${MEAL_LABELS[p.meal]}的菜单刚被别人改过：回到这一份看看最新的再改`, 'error');
      } else if (settled) {
        clearPending();
        toast(settled, 'error');
      } else if (e instanceof ApiError && e.status === 401) {
        // 登录过期：这一笔留在手机上，重新登录以后到「厨房」点「原样重试」
        toast('登录过期了：重新登录以后到「厨房」点「原样重试」', 'error');
        window.location.reload();
      } else {
        // 没网、超时、门店系统出错、饭堂暂时关着、没有权限、正忙：都说明不了原来那次存没存上。本机留着原来的编号和内容，原样重试不会存两遍
        setPending(p);
        toast(
          e instanceof NetworkError ? '没收到门店系统的回复：这次可能存好了，也可能没有，联网后点「原样重试」' : `${messageOf(e)}（上一次保存先留在手机上，之后点「原样重试」）`,
          'error',
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const save = (published: boolean, version = server?.version ?? 0) => {
    if (pending) return toast('上一次保存还没确认：先点「原样重试」', 'error');
    if (!ready) return toast('这份菜单还没取到，等一下再存', 'error');
    const dishes = draft.dishes.filter((x) => x.name.trim()).map(({ auto: _auto, ...x }) => ({ ...x, name: x.name.trim() }));
    if (published && !dishes.length) return toast('还没有菜，加几道再发布吧', 'error');
    const p: Pending = { date, meal, body: { clientKey: uuid(), version, dishes, note: draft.note.trim(), published }, savedAt: Date.now() };
    // 先存在这台手机上并读回核对；存不下就不发（AGENTS.md「结果待确认」）
    if (!writeJson(storeKey, p)) return toast('这台手机存不下记录（隐私模式或存储满了），为防止存两遍，这次没有发出', 'error');
    setPending(p);
    void send(p);
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
            className={cn('flex-1 rounded-2xl py-2.5 text-[15px] font-extrabold', m === meal ? 'bg-wood-deep text-white shadow-[0_3px_0_var(--color-wood-ink)]' : 'bg-card text-ink-2 ring-1 ring-line')}
          >
            {MEAL_EMOJI[m]} {MEAL_LABELS[m]}
          </button>
        ))}
      </div>

      {pending && !busy && (
        <Card className="bg-sky-soft ring-sky/30" data-testid="menu-pending">
          <p className="text-[15px] font-extrabold text-relax">
            上一次保存还没确认（{monthDay(pending.date)} {MEAL_LABELS[pending.meal]}，{pending.body.published ? '发布' : '存草稿'}）
          </p>
          <p className="mt-1 text-[13px] text-ink-2">可能存好了，也可能没有。联网后点「原样重试」：同一个编号，不会存两遍；确认之前不能存别的。</p>
          <Button className="mt-3" tone="ink" disabled={busy} onClick={() => void send(pending)}>
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
        {loadError ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <p className="text-[14px] font-bold text-berry">没取到这份菜单：{loadError}</p>
            <Button tone="ghost" onClick={() => void load()}>
              再取一次
            </Button>
          </div>
        ) : !ready ? (
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
        <Button tone="ghost" big disabled={busy || !ready || !!pending} onClick={() => save(false)}>
          {server?.published ? '撤回成草稿' : '存草稿'}
        </Button>
        <Button tone="leaf" big disabled={busy || !ready || !!pending} onClick={() => save(true)}>
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
