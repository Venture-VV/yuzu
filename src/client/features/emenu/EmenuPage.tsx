// 点餐系统 · 平板电子菜单（8.0.10，docs/EMENU.md）：放在餐桌上的平板，照 UI 设计师的《点餐系统版面模板-26.11.11》。
//
// 起始页 → 输入手牌、桌号、人数 → 翻菜单、加菜 → 订单抽屉（未下单 / 已下单）、备注 → 服务员输点单密码确认 → 下单成功。
// 下单与门店系统所有写操作一样带操作编号：提交前把编号与原请求（不含密码）存在这台平板上，断网、超时、服务器出错时进入
// 「结果待确认」——查回、原样重新提交（再输密码）或确认作废（再输密码）之后才能下新的一单。
// 菜单每 15 秒向门店系统取一次：价格、估清、上下架、供应时段、后台改的版面都跟得上。
// 8.0.13（docs/EMENU.md 第 11 节）：「中 | EN」一键切换（i18n.tsx）、键盘弹起时页面不缩放（stage.tsx）、
// 跟手翻页（strip.tsx）与进入 / 退出的动效（motion.tsx、emenu.css）。

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  dishBlock,
  EMENU_MAX_GUESTS,
  EMENU_MAX_LINES,
  EMENU_PIN_LENGTH,
  formatWindow,
  type EmenuCategoryView,
  type EmenuDishView,
  type EmenuGuest,
  type EmenuMenu,
  type EmenuOpLookup,
  type EmenuOrderBody,
  type EmenuOrderResult,
  type EmenuPageView,
  type EmenuSpecView,
} from '@shared/emenu';
import { api, ApiError, errorMessage, UncertainError } from '../../lib/api';
import { useCan } from '../../lib/session';
import { uuid } from '../../lib/utils';
import { Header, LangToggle } from './header';
import { blockLabel, dishNames, dishTagline, guestErrorEn, LangProvider, messages, namePair, optionLabel, specLabel, useLang, useM, type Lang, type Messages } from './i18n';
import { LogoStacked } from './logo';
import { Backdrop, Frame, InfoModal, ModalButton, ModalNote, SmallDialog, SuccessModal, Toast, type InfoField } from './modals';
import { DishDetail, OrderDrawer, RemarkDrawer, SearchOverlay, type CartRow, type SearchHit } from './overlays';
import { flyToOrder, overlayNav } from './motion';
import { PageCanvas, yuan, type PageCtx } from './pages';
import { BIG, box, Stage, useBig, ZoomAt } from './stage';
import { MenuStrip, type StripHandle } from './strip';
import {
  EMPTY_REMARK,
  lastTable,
  loadState,
  PENDING_STORE_FAILED,
  rememberTable,
  removePending,
  savePending,
  saveState,
  usePendingOrder,
  type CartLine,
  type PendingOrder,
  type Remark,
  type TableSession,
} from './store';

const MENU_KEY = ['emenu', 'menu'] as const;
const guestKey = (visitId: number | null) => ['emenu', 'guest', visitId] as const;
/** 页面被系统刷新以后，这么久之内的那一次点餐接着用（之后再按设置的「多久没人动」核对） */
const RESTORE_MS = 3 * 3600_000;
const PIN_ERRORS = ['PIN_INVALID', 'PIN_LOCKED', 'PIN_NO_PERMISSION', 'BAD_REQUEST'];

interface FlatPage {
  category: EmenuCategoryView;
  page: EmenuPageView;
  /** 在这个分类里是第几页 */
  pageNo: number;
}

type Overlay =
  | { kind: 'detail'; dishId: number; categoryId: number; origin?: { x: number; y: number } | null }
  | { kind: 'search' }
  | { kind: 'drawer'; tab: 'cart' | 'ordered' }
  | { kind: 'remark' }
  | { kind: 'confirm'; total: number }
  | { kind: 'notice'; text: string }
  | { kind: 'success' }
  | { kind: 'pending' }
  | { kind: 'end' }
  | { kind: 'exit' }
  | null;

export function EmenuPage() {
  const qc = useQueryClient();
  const can = useCan();
  const menuQ = useQuery({ queryKey: MENU_KEY, queryFn: () => api.get<EmenuMenu>('/api/emenu/menu'), refetchInterval: 15_000, staleTime: 5_000 });
  const menu = menuQ.data ?? null;

  const saved = useMemo(() => loadState(RESTORE_MS), []);
  const [phase, setPhase] = useState<'start' | 'input' | 'menu'>(saved ? 'menu' : 'start');
  const [session, setSession] = useState<TableSession | null>(saved?.session ?? null);
  const [cart, setCart] = useState<CartLine[]>(saved?.cart ?? []);
  const [remark, setRemark] = useState<Remark>(saved?.remark ?? EMPTY_REMARK);
  const [overlay, setOverlayRaw] = useState<Overlay>(null);
  // 换层之前记下「从哪一层来、到哪一层去」：抽屉里换内容（未下单 ⇄ 备注）时旧的不播滑出、新的不重新滑进（motion.tsx）
  const cameFrom = useRef<string | null>(null);
  const setOverlay = useCallback((next: Overlay | ((cur: Overlay) => Overlay)) => {
    setOverlayRaw((cur) => {
      const to = typeof next === 'function' ? next(cur) : next;
      cameFrom.current = cur?.kind ?? null;
      overlayNav.to = to?.kind ?? null;
      return to;
    });
  }, []);
  const [lang, setLangRaw] = useState<Lang>(saved?.lang === 'en' ? 'en' : 'zh');
  const [toast, setToast] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<number | null>(null);
  const [bump, setBump] = useState(0);
  const pending = usePendingOrder();
  const lastTouch = useRef(saved?.touchedAt ?? Date.now());

  // 这一次点餐随手存在平板上：页面被系统刷新了还在。
  // 下单成功、正在提示的那两秒里这一次点餐已经结束（马上回起始页），不再存——这时候页面被刷新也不会回到上一位客人的菜单里
  const ended = overlay?.kind === 'success';
  useEffect(() => {
    saveState(phase === 'menu' && session && !ended ? { session, cart, remark, lang } : null);
  }, [phase, session, cart, remark, lang, ended]);

  const say = useCallback((text: string) => {
    setToast(text);
    window.setTimeout(() => setToast((t) => (t === text ? null : t)), 2200);
  }, []);

  const reset = useCallback(() => {
    setPhase('start');
    setSession(null);
    setCart([]);
    setRemark(EMPTY_REMARK);
    setOverlay(null);
    // 下一位客人从中文开始（EN8）
    setLangRaw('zh');
  }, [setOverlay]);

  // 中英切换（8.0.13）：后台关掉以后只有中文
  const langOn = menu?.rules.langSwitch ?? false;
  const shown: Lang = langOn ? lang : 'zh';
  const m = messages(shown);
  const toggleLang = useCallback(() => {
    lastTouch.current = Date.now();
    setLangRaw((l) => (l === 'en' ? 'zh' : 'en'));
  }, []);
  // 在起始页切到 EN 以后 1 分钟没人开始点：回到中文（EN8）
  useEffect(() => {
    if (phase !== 'start' || lang !== 'en') return;
    const t = window.setInterval(() => {
      if (Date.now() - lastTouch.current > 60_000) setLangRaw('zh');
    }, 5_000);
    return () => window.clearInterval(t);
  }, [phase, lang]);

  // 没人动回到起始页（DC12）：清掉没下单的菜；「结果待确认」那一笔记在别处，不清
  const idleMinutes = menu?.rules.idleMinutes ?? 0;
  useEffect(() => {
    const touch = () => {
      lastTouch.current = Date.now();
    };
    window.addEventListener('pointerdown', touch, true);
    window.addEventListener('keydown', touch, true);
    return () => {
      window.removeEventListener('pointerdown', touch, true);
      window.removeEventListener('keydown', touch, true);
    };
  }, []);
  useEffect(() => {
    if (!idleMinutes || phase === 'start') return;
    const check = () => {
      if (Date.now() - lastTouch.current > idleMinutes * 60_000) reset();
    };
    check();
    const t = window.setInterval(check, 5_000);
    // 平板待机时定时器是停的：屏幕一亮（页面重新可见、回到前台）马上核对一次，不等下一个 5 秒——
    // 唤醒看到的直接是起始页，不会先闪一下上一位客人的菜单（店主 2026-11-14 的需求 7 第 5 点）
    const wake = () => {
      if (document.visibilityState !== 'hidden') check();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('pageshow', wake);
    window.addEventListener('focus', wake);
    return () => {
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('pageshow', wake);
      window.removeEventListener('focus', wake);
    };
  }, [idleMinutes, phase, reset]);

  // ───────────── 菜单：把各分类的页排成一条 ─────────────
  const categories = useMemo(() => menu?.categories ?? [], [menu]);
  const flat = useMemo<FlatPage[]>(() => categories.flatMap((category) => category.pages.map((page, pageNo) => ({ category, page, pageNo }))), [categories]);
  const strip = useRef<StripHandle>(null);
  const [index, setIndex] = useState(0);
  const at = flat[Math.min(index, flat.length - 1)] ?? null;
  /** 翻到第 i 页：slide 滑过去（翻页小点、键盘左右键）；jump 直接到；zoom 直接到、那一页轻微放大缓入（点分类页签） */
  const goTo = useCallback((i: number, mode: 'slide' | 'jump' | 'zoom' = 'slide') => {
    strip.current?.goTo(i, mode);
    setIndex(i);
  }, []);
  // 后台改了版面、过了供应时段：尽量留在原来那个分类的那一页
  const anchor = useRef<{ categoryId: number; pageNo: number } | null>(null);
  useEffect(() => {
    if (at) anchor.current = { categoryId: at.category.id, pageNo: at.pageNo };
  }, [at]);
  useEffect(() => {
    const a = anchor.current;
    if (!a || flat.length === 0) return;
    const same = flat.findIndex((f) => f.category.id === a.categoryId && f.pageNo === a.pageNo);
    const next = same >= 0 ? same : Math.max(0, flat.findIndex((f) => f.category.id === a.categoryId));
    if (next !== index || (strip.current && strip.current.page() !== next)) goTo(next, 'jump');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flat]);
  useEffect(() => {
    if (phase !== 'menu' || overlay) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' && index < flat.length - 1) goTo(index + 1);
      if (e.key === 'ArrowLeft' && index > 0) goTo(index - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, overlay, index, flat.length, goTo]);

  // 一个价目项目 → 它是哪道菜的哪个规格、有没有哪个现在能点的分类排着它
  const specIndex = useMemo(() => {
    const map = new Map<number, { dish: EmenuDishView; spec: EmenuSpecView; open: boolean }>();
    for (const c of categories) {
      for (const p of c.pages) {
        for (const d of p.dishes) {
          if (!d) continue;
          for (const s of d.specs) {
            const cur = map.get(s.itemId);
            map.set(s.itemId, { dish: d, spec: s, open: (cur?.open ?? false) || c.open });
          }
        }
      }
    }
    return map;
  }, [categories]);

  const rows = useMemo<CartRow[]>(
    () =>
      cart.map((l) => {
        const hit = specIndex.get(l.itemId);
        if (!hit) return { ...l, names: { main: m.goneDish, sub: '', mainEn: shown === 'en' }, tagline: { text: '', en: false }, label: '', price: 0, problem: m.goneProblem };
        const { dish, spec, open } = hit;
        const why = (block: 'off' | 'closed' | 'sold_out') => m.blockedProblem(blockLabel(block, shown).main);
        const problem =
          spec.state === 'off'
            ? why('off')
            : !open
              ? why('closed')
              : spec.state === 'sold_out'
                ? why('sold_out')
                : spec.remaining !== null && l.quantity > spec.remaining
                  ? m.leftProblem(spec.remaining)
                  : null;
        return { ...l, names: dishNames(dish, shown), tagline: dishTagline(dish, shown), label: specLabel(spec, shown), price: spec.price, problem };
      }),
    [cart, specIndex, shown, m],
  );
  const total = rows.reduce((s, r) => s + r.price * r.quantity, 0);
  const count = cart.reduce((s, l) => s + l.quantity, 0);
  const cartProblem = rows.length === 0 ? m.cartEmpty : (rows.find((r) => r.problem) ? m.cartHasBlocked : null);
  // 页面上显示的备注（切到英文时选项显示英文）；送进厨房的仍是中文选项，由门店系统按交上去的选项拼
  const optionsEn = menu?.rules.optionsEn ?? {};
  // 下单要不要服务员输点单密码（后台设置，8.0.15 起默认不要）；菜单还没取到时按不要
  const requirePin = menu?.rules.requirePin ?? false;
  const remarkText = [...remark.avoid.map((o) => optionLabel(o, shown, optionsEn)), ...(remark.serve ? [optionLabel(remark.serve, shown, optionsEn)] : []), ...(remark.custom.trim() ? [remark.custom.trim()] : [])].join(shown === 'en' ? ', ' : '，');

  const addSpec = useCallback(
    (dish: EmenuDishView, spec: EmenuSpecView, open: boolean, from?: Element) => {
      const name = dishNames(dish, shown).main;
      if (pending) return say(m.pendingFirst);
      const block = dishBlock(dish, open);
      if (block) return say(m.dishBlocked(name, blockLabel(block, shown).main));
      if (spec.state !== 'ok') return say(m.specBlocked(name, spec.state === 'sold_out'));
      const cur = cart.find((l) => l.itemId === spec.itemId);
      const want = (cur?.quantity ?? 0) + 1;
      if (want > 99) return say(m.maxPerDish);
      if (spec.remaining !== null && want > spec.remaining) return say(m.onlyLeft(name, spec.remaining));
      if (!cur && cart.length >= EMENU_MAX_LINES) return say(m.maxLines);
      setCart((c) => (c.some((l) => l.itemId === spec.itemId) ? c.map((l) => (l.itemId === spec.itemId ? { ...l, quantity: l.quantity + 1 } : l)) : [...c, { itemId: spec.itemId, dishId: dish.id, quantity: 1 }]));
      setBump((n) => n + 1);
      // 一个小圆点从加号飞向右上角的订单图标
      if (from) flyToOrder(from);
      say(m.added(name, specLabel(spec, shown)));
    },
    [cart, pending, say, shown, m],
  );

  const setQuantity = (itemId: number, quantity: number) => {
    const hit = specIndex.get(itemId);
    const max = Math.min(99, hit?.spec.remaining ?? 99);
    setCart((c) => c.flatMap((l) => (l.itemId !== itemId ? [l] : quantity <= 0 ? [] : [{ ...l, quantity: quantity > l.quantity ? Math.max(l.quantity, Math.min(quantity, max)) : quantity }])));
  };

  // ───────────── 已下单 ─────────────
  const drawerOrdered = overlay?.kind === 'drawer' && overlay.tab === 'ordered';
  const guestQ = useQuery({
    queryKey: guestKey(session?.visitId ?? null),
    queryFn: () => api.get<EmenuGuest>(`/api/emenu/guest?tag=${encodeURIComponent(session!.tagCode)}`),
    enabled: !!session && drawerOrdered,
    refetchInterval: drawerOrdered ? 15_000 : false,
    retry: false,
  });
  const guest = guestQ.data && session && guestQ.data.visitId === session.visitId ? guestQ.data : null;

  // ───────────── 下单与结果待确认 ─────────────
  // 几件事在办（下单、查回、作废）：用计数，一件办完不会把另一件还没办完的也当成办完
  const [opCount, setOpCount] = useState(0);
  const opBusy = opCount > 0;
  const opBegin = () => setOpCount((n) => n + 1);
  const opEnd = () => setOpCount((n) => Math.max(0, n - 1));
  const [opNote, setOpNote] = useState<{ error?: string; hint?: string } | null>(null);
  /** 正在发的那一单的操作编号（发出去到有答复之间） */
  const sending = useRef<string | null>(null);
  /** 已经自动查回过、或是这一页自己发出去的操作编号：不再自动查 */
  const autoChecked = useRef<string | null>(null);

  const finish = useCallback(
    (order: EmenuOrderResult) => {
      qc.setQueryData(guestKey(order.guest.visitId), order.guest);
      void qc.invalidateQueries({ queryKey: MENU_KEY });
      rememberTable(order.tableName);
      setCart([]);
      setRemark(EMPTY_REMARK);
      setOpNote(null);
      setOverlay({ kind: 'success' });
    },
    [qc, setOverlay],
  );

  /**
   * 发出一单（新的一单或原样重提）。返回：ok 成功；rejected 被明确拒绝（message 是原因）；uncertain 结果不明。
   * 发出去到有答复之间，这一单已经记在平板上（pending 不为空）——这段时间不自动查回：查不到会把「下单」按钮放开，
   * 再点一次就是另一个操作编号的第二单。
   */
  const send = useCallback(
    async (p: PendingOrder, pin: string, isRetry: boolean): Promise<{ outcome: 'ok' | 'rejected' | 'uncertain'; message?: string }> => {
      const rejected = (message: string) => {
        setOpNote({ error: message });
        return { outcome: 'rejected' as const, message };
      };
      const saved = savePending(p);
      // 这台平板上还有另一单结果待确认：先处理完，不发新的（也不覆盖那一单的记录）
      if (saved === 'other') {
        setOverlay({ kind: 'pending' });
        return rejected('这台平板上还有一单结果待确认，请先处理完再下新的一单');
      }
      // 记录存不进这台平板：一旦回复丢了就找不回原编号，所以这一单不发
      if (saved === 'failed') return rejected(PENDING_STORE_FAILED);
      autoChecked.current = p.key;
      sending.current = p.key;
      opBegin();
      try {
        const order = await api.post<EmenuOrderResult>('/api/emenu/orders', { ...p.body, pin });
        removePending(p.key);
        finish(order);
        return { outcome: 'ok' };
      } catch (error) {
        if (error instanceof ApiError && error.status < 500) {
          // 点单密码不对、锁了、这位员工没有权限：门店系统在动账单之前就拒绝了，这一次什么都没做
          const pinProblem = PIN_ERRORS.includes(error.code) || error.status === 401;
          if (!isRetry) {
            removePending(p.key);
            return rejected(error.message);
          }
          if (pinProblem) {
            // 后台刚把「点单密码」打开或关掉：取一次最新的设置，弹窗跟着变
            void qc.invalidateQueries({ queryKey: MENU_KEY });
            setOpNote({ error: `${error.message}（原来那一单仍待确认）` });
            return { outcome: 'uncertain' };
          }
          if (error.code !== 'OP_ABANDONED') {
            // 重提被明确拒绝，不代表之前那次结果不明的请求不会随后生效：先在门店系统作废编号，再下结论
            let fenced: EmenuOpLookup | null = null;
            try {
              fenced = await api.post<EmenuOpLookup>(`/api/emenu/orders/by-key/${p.key}/abandon`, { pin });
            } catch {
              /* 作废没有完成，下面按待确认处理 */
            }
            if (fenced?.found) {
              removePending(p.key);
              finish(fenced.order);
              return { outcome: 'ok' };
            }
            if (!fenced?.abandoned) {
              setOpNote({ error: `重新提交被拒绝（${error.message}），但原来那一单会不会生效还不确定` });
              return { outcome: 'uncertain' };
            }
          }
          // 门店系统明确拒绝（含这个编号已经作废）：没有生效
          removePending(p.key);
          return rejected(error.message);
        }
        const reason = error instanceof UncertainError && error.reason !== 'server' ? error.message : '门店系统出了点问题';
        setOpNote({ error: `${reason}，这一单有没有下成暂时不确定` });
        return { outcome: 'uncertain' };
      } finally {
        sending.current = null;
        opEnd();
      }
    },
    [finish, setOverlay, qc],
  );

  const settle = useCallback(
    (key: string, found: EmenuOpLookup, miss: string) => {
      if (found.found) {
        removePending(key);
        finish(found.order);
      } else if (found.abandoned) {
        // 门店系统确认已经作废：原来那一单永远不会生效。这一笔到此结束，回到起始页、清掉手牌与没下单的菜，
        // 下一位直接开始（需求 7：下单成功、作废都算一笔结束；原来是留在这张手牌的菜单里）
        removePending(key);
        setOpNote(null);
        reset();
        say('原来那一单已作废，没有下成；要点的话请重新开始点单');
      } else {
        setOpNote({ hint: miss });
      }
    },
    [finish, say, reset],
  );

  const checkPending = useCallback(async () => {
    if (!pending) return;
    opBegin();
    try {
      settle(pending.key, await api.get<EmenuOpLookup>(`/api/emenu/orders/by-key/${pending.key}`), `暂时没有查到已经下单，原来的请求可能还在路上。可以${requirePin ? '输点单密码' : ''}重新提交（不会重复），或者作废后重填。`);
    } catch (error) {
      setOpNote({ error: `还是确认不了：${errorMessage(error)}` });
    } finally {
      opEnd();
    }
  }, [pending, settle, requirePin]);

  const abandonPending = useCallback(
    async (pin: string) => {
      if (!pending) return;
      opBegin();
      try {
        settle(pending.key, await api.post<EmenuOpLookup>(`/api/emenu/orders/by-key/${pending.key}/abandon`, { pin }), '作废没有完成，原来那一单仍待确认');
      } catch (error) {
        setOpNote({ error: error instanceof ApiError && error.status < 500 ? error.message : `作废没有完成，原来那一单仍待确认：${errorMessage(error)}` });
      } finally {
        opEnd();
      }
    },
    [pending, settle],
  );

  // 上一次留下的待确认记录（页面被刷新、平板重开）：进菜单时自动只读查一次。
  // 这一页自己发出去的一单不在这里查（send 已经记进 autoChecked）：正在发的时候查不到不说明什么，发完没有答复会弹出「结果待确认」
  useEffect(() => {
    if (!pending || phase !== 'menu' || sending.current || autoChecked.current === pending.key) return;
    autoChecked.current = pending.key;
    void checkPending();
  }, [pending, phase, checkPending]);

  // ───────────── 页面 ─────────────
  if (!menu) {
    return (
      <Stage testId="emenu">
        <StartBackdrop coverUrl={null} />
        <div style={{ ...box(0, 480, 1024), textAlign: 'center', fontSize: 13, color: 'var(--em-mute)' }} data-testid="emenu-loading">
          {menuQ.isError ? (
            <>
              连不上门店系统
              <br />
              <button type="button" onClick={() => void menuQ.refetch()} style={{ marginTop: 14, height: 28, padding: '0 22px', border: '0.5px solid var(--em-mute)', background: 'transparent', fontSize: 14, color: 'var(--em-ink)' }}>
                再试一次
              </button>
            </>
          ) : (
            '正在打开菜单…'
          )}
        </div>
      </Stage>
    );
  }

  if (!menu.enabled) {
    return (
      <Stage testId="emenu">
        <StartBackdrop coverUrl={null} />
        <div style={{ ...box(262, 470, 500), textAlign: 'center', fontSize: 14, lineHeight: '24px' }} data-testid="emenu-disabled">
          平板点餐没有开启
          <div style={{ fontSize: 12, color: 'var(--em-mute)' }}>
            请店主在「后台 → 电子菜单 → 设置」里打开（还要开着餐饮功能）
            {can('emenu.manage') && (
              <>
                <br />
                <a href="/admin/emenu" style={{ color: 'var(--em-tan)', textDecoration: 'underline' }}>
                  去后台设置
                </a>
              </>
            )}
          </div>
        </div>
      </Stage>
    );
  }

  const pageCtx = (f: FlatPage): PageCtx => ({
    categoryName: f.category.name,
    categoryNameEn: f.category.nameEn,
    open: f.category.open,
    flashId,
    onOpen: (dish, origin) => setOverlay({ kind: 'detail', dishId: dish.id, categoryId: f.category.id, origin }),
    onAdd: (dish, from) => {
      const usable = dish.specs.filter((s) => s.state === 'ok');
      // 有几个规格的进详情选；只有一个的直接加
      if (dish.specs.length > 1) setOverlay({ kind: 'detail', dishId: dish.id, categoryId: f.category.id });
      else addSpec(dish, usable[0] ?? dish.specs[0]!, f.category.open, from);
    },
  });

  const detail = (() => {
    if (overlay?.kind !== 'detail') return null;
    const category = categories.find((c) => c.id === overlay.categoryId);
    if (!category) return null;
    const dishes = [...new Map(category.pages.flatMap((p) => p.dishes).filter((d): d is EmenuDishView => !!d).map((d) => [d.id, d])).values()];
    const i = dishes.findIndex((d) => d.id === overlay.dishId);
    if (i < 0) return null;
    const move = (to: number) => () => {
      const d = dishes[to]!;
      // 上一道 / 下一道：关掉时缩回屏幕正中（不是最初点开的那道菜的位置）
      setOverlay({ kind: 'detail', dishId: d.id, categoryId: category.id, origin: null });
      // 后面的菜单页跟着翻到这道菜所在的那一页
      const page = flat.findIndex((f) => f.category.id === category.id && f.page.dishes.some((x) => x?.id === d.id));
      if (page >= 0) goTo(page, 'jump');
    };
    return { dish: dishes[i]!, category, origin: overlay.origin, prev: i > 0 ? move(i - 1) : null, next: i < dishes.length - 1 ? move(i + 1) : null };
  })();

  const searchHits = (q: string): SearchHit[] => {
    const needle = q.toLowerCase();
    const seen = new Set<number>();
    const out: SearchHit[] = [];
    flat.forEach((f, pageIndex) => {
      for (const d of f.page.dishes) {
        if (!d || seen.has(d.id)) continue;
        if (`${d.name}${d.tagline}`.toLowerCase().includes(needle) || `${d.nameEn} ${d.taglineEn}`.toLowerCase().includes(needle)) {
          seen.add(d.id);
          out.push({ dish: d, pageIndex });
        }
      }
    });
    return out;
  };

  const inMenu = phase === 'menu' && !!session;
  // 抽屉里换内容（未下单 ⇄ 备注）：新的那一块不重新滑进来
  const swap = cameFrom.current === 'drawer' || cameFrom.current === 'remark';
  return (
    <Stage testId="emenu" motion={menu.rules.motion} lang={shown} big={menu.rules.textSize !== 'design'}>
      <LangProvider value={shown}>
      {inMenu ? (
        <>
          {flat.length === 0 ? (
            <NoMenu menu={menu} />
          ) : (
            <div key={session.visitId} className="em-page-in" style={{ ...box(0, 0, 1024, 768) }}>
              <MenuStrip
                ref={strip}
                count={flat.length}
                index={Math.min(index, flat.length - 1)}
                onIndex={setIndex}
                pageKey={(i) => `${flat[i]!.category.id}-${flat[i]!.pageNo}`}
                renderPage={(i) => <PageCanvas page={flat[i]!.page} ctx={pageCtx(flat[i]!)} />}
              />
            </div>
          )}
          {detail && (
            <DishDetail
              dish={detail.dish}
              open={detail.category.open}
              origin={detail.origin}
              onClose={() => setOverlay(null)}
              onPrev={detail.prev}
              onNext={detail.next}
              onAdd={(spec, from) => addSpec(detail.dish, spec, detail.category.open, from)}
            />
          )}
          <Header
            categories={categories}
            activeId={detail?.category.id ?? at?.category.id ?? null}
            onCategory={(id) => {
              setOverlay(null);
              const i = flat.findIndex((f) => f.category.id === id);
              // 直接到那个分类的第一页（不横向滚过中间的页），那一页轻微放大缓入
              if (i >= 0) goTo(i, 'zoom');
            }}
            tagCode={session.tagCode}
            count={count}
            bump={bump}
            pending={!!pending}
            onSearch={() => setOverlay({ kind: 'search' })}
            onOrder={() => setOverlay(pending ? { kind: 'pending' } : { kind: 'drawer', tab: 'cart' })}
            onTag={() => setOverlay({ kind: 'end' })}
            onLang={langOn ? toggleLang : undefined}
          />
          {!detail && at && <PageDots flat={flat} index={index} onGo={goTo} />}
        </>
      ) : (
        <StartPage
          menu={menu}
          asking={phase === 'input'}
          pending={!!pending}
          onStart={() => setPhase('input')}
          onCancel={() => setPhase('start')}
          onReady={(s, g) => {
            qc.setQueryData(guestKey(s.visitId), g);
            setSession(s);
            setCart([]);
            setRemark(EMPTY_REMARK);
            setIndex(0);
            setPhase('menu');
            lastTouch.current = Date.now();
          }}
          onExit={() => setOverlay({ kind: 'exit' })}
          onLang={langOn ? toggleLang : undefined}
        />
      )}

      {inMenu && overlay?.kind === 'search' && (
        <SearchOverlay
          hits={searchHits}
          onClose={() => setOverlay(null)}
          onPick={(hit) => {
            setOverlay(null);
            goTo(hit.pageIndex, 'zoom');
            setFlashId(hit.dish.id);
            window.setTimeout(() => setFlashId((id) => (id === hit.dish.id ? null : id)), 2400);
          }}
        />
      )}
      {inMenu && overlay?.kind === 'drawer' && (
        <OrderDrawer
          tab={overlay.tab}
          swap={swap}
          onTab={(tab) => setOverlay({ kind: 'drawer', tab })}
          rows={rows}
          total={total}
          guest={guest}
          guestLoading={guestQ.isFetching}
          tableName={session.tableName}
          remarkText={remarkText}
          locked={!!pending}
          problem={cartProblem}
          callStaff={requirePin}
          onQuantity={setQuantity}
          onRemark={() => setOverlay({ kind: 'remark' })}
          onSubmit={() => {
            setOpNote(null);
            // 记下客人这时看到的合计：输密码的这段时间菜单又取了一次、价格变了的话，门店系统按这个数拒绝（PRICE_CHANGED），不会按没看过的价格下单
            setOverlay({ kind: 'confirm', total });
          }}
          onClose={() => setOverlay(null)}
        />
      )}
      {inMenu && overlay?.kind === 'remark' && (
        <RemarkDrawer
          remark={remark}
          avoidOptions={menu.rules.avoidOptions}
          serveOptions={menu.rules.serveOptions}
          optionsEn={optionsEn}
          swap={swap}
          tableName={session.tableName}
          onChange={setRemark}
          onDone={() => setOverlay({ kind: 'drawer', tab: 'cart' })}
        />
      )}
      {inMenu && overlay?.kind === 'confirm' && (
        <ConfirmOrder
          session={session}
          requirePin={requirePin}
          busy={opBusy}
          note={opNote}
          onCancel={() => {
            setOpNote(null);
            setOverlay({ kind: 'drawer', tab: 'cart' });
          }}
          onResolved={(next) => setSession(next)}
          onSubmit={async (next, pin) => {
            // 还有一单结果待确认（正在发的也算）：不发新的
            if (pending) {
              setOverlay({ kind: 'pending' });
              return;
            }
            const body: EmenuOrderBody = {
              clientKey: uuid(),
              visitId: next.visitId,
              tagCode: next.tagCode,
              tableName: next.tableName,
              guests: next.guests,
              lines: cart.map((l) => ({ itemId: l.itemId, quantity: l.quantity })),
              avoid: remark.avoid,
              serve: remark.serve,
              customNote: remark.custom.trim(),
              expectedTotal: overlay.total,
            };
            const result = await send({ key: body.clientKey, body, quantity: count, createdAt: new Date().toISOString() }, pin, false);
            if (result.outcome === 'uncertain') setOverlay({ kind: 'pending' });
            // 价格、估清、时段刚变过的：马上取一次最新的菜单
            if (result.outcome === 'rejected') void qc.invalidateQueries({ queryKey: MENU_KEY });
          }}
        />
      )}
      {overlay?.kind === 'pending' && pending && (
        <PendingOrderModal
          pending={pending}
          requirePin={requirePin}
          busy={opBusy}
          note={opNote}
          onClose={() => {
            setOpNote(null);
            setOverlay(null);
          }}
          onCheck={() => void checkPending()}
          onRetry={(pin) =>
            void send(pending, pin, true).then((r) => {
              // 重新提交被明确拒绝：待确认的记录已经没有了（弹窗跟着关），要告诉服务员这一单没有下成、为什么
              if (r.outcome === 'rejected') {
                void qc.invalidateQueries({ queryKey: MENU_KEY });
                setOverlay({ kind: 'notice', text: `这一单没有下成：${r.message ?? '门店系统拒绝了'}。菜还在「未下单」里，可以改了再下单。` });
              }
            })
          }
          onAbandon={(pin) => void abandonPending(pin)}
        />
      )}
      {/* 下单成功提示 2 秒（点一下马上关）之后回到起始页：手牌、桌号、人数、备注都清掉，下一位客人不用服务员先退出（需求 7）。
          下单没成（断网、超时、密码不对、被拒绝）不走这里：留在原页，菜还在 */}
      {overlay?.kind === 'success' && <SuccessModal onDone={reset} />}
      {overlay?.kind === 'notice' && (
        <SmallDialog
          title="没有下成"
          subtitle="ORDER NOT PLACED"
          testId="emenu-notice"
          actions={
            <ModalButton x={110} y={196} w={140} primary onClick={() => setOverlay(session ? { kind: 'drawer', tab: 'cart' } : null)} testId="emenu-notice-ok">
              知道了
            </ModalButton>
          }
        >
          {overlay.text}
        </SmallDialog>
      )}
      {overlay?.kind === 'end' && session && (
        <SmallDialog
          title="结束点餐"
          subtitle="FINISH ORDERING"
          onClose={() => setOverlay(null)}
          testId="emenu-end"
          actions={
            <>
              <ModalButton x={28} y={196} w={140} onClick={() => setOverlay(null)} testId="emenu-end-cancel">
                {m.keepOrdering}
              </ModalButton>
              <ModalButton x={192} y={196} w={140} primary onClick={reset} testId="emenu-end-ok">
                {m.finish}
              </ModalButton>
            </>
          }
        >
          <span className={shown === 'en' ? 'em-en' : undefined}>
            {m.endBody(session.tagCode)[0]}
            <span className="em-en">{session.tagCode}</span>
            {m.endBody(session.tagCode)[2]}
            <br />
            {count > 0 ? m.endCart(count) : m.endNoCart}
          </span>
        </SmallDialog>
      )}
      {overlay?.kind === 'exit' && (
        <SmallDialog
          title="退出登录"
          subtitle="STAFF ONLY"
          onClose={() => setOverlay(null)}
          testId="emenu-exit"
          actions={
            <>
              <ModalButton x={28} y={196} w={140} onClick={() => setOverlay(null)} testId="emenu-exit-cancel">
                取消
              </ModalButton>
              <ModalButton
                x={192}
                y={196}
                w={140}
                primary
                onClick={() => {
                  void api.post('/api/auth/logout').finally(() => window.location.assign('/login'));
                }}
                testId="emenu-exit-ok"
              >
                退出
              </ModalButton>
            </>
          }
        >
          这一步是给员工用的：退出这台平板登录的账号。
          <br />
          退出以后要重新登录才能点餐。
        </SmallDialog>
      )}
      <Toast text={toast} />
      </LangProvider>
    </Stage>
  );
}

// ───────────────────────── 起始页与「输入信息」 ─────────────────────────

/** 起始页的底：氛围大图铺满；没传图时是设计稿的浅灰底 */
function StartBackdrop({ coverUrl }: { coverUrl: string | null }) {
  return (
    <>
      <div style={{ ...box(0, 0, 1024, 768), background: 'var(--em-photo)' }} />
      {coverUrl && <img src={coverUrl} alt="" draggable={false} style={{ ...box(0, 0, 1024, 768), objectFit: 'cover' }} />}
      <div style={{ ...box(472.6, 342.8) }}>
        <LogoStacked />
      </div>
    </>
  );
}

function StartPage({
  menu,
  asking,
  pending,
  onStart,
  onCancel,
  onReady,
  onExit,
  onLang,
}: {
  menu: EmenuMenu;
  asking: boolean;
  pending: boolean;
  onStart: () => void;
  onCancel: () => void;
  onReady: (session: TableSession, guest: EmenuGuest) => void;
  onExit: () => void;
  onLang?: () => void;
}) {
  const lang = useLang();
  const m = useM();
  const hold = useRef<number | null>(null);
  const cover = menu.rules.coverUrl;
  // 压在氛围图上的字：有图时用浅色（图一般偏深），没图时照设计稿的深棕
  const tone = cover ? '#f4f3f2' : 'var(--em-ink)';
  const large = useBig();
  return (
    <>
      <div
        role="button"
        aria-label={m.startAria}
        onClick={() => !asking && onStart()}
        className="em-settle"
        style={{ ...box(0, 0, 1024, 768), background: 'var(--em-photo)', cursor: asking ? undefined : 'pointer', overflow: 'hidden' }}
        data-testid="emenu-start"
      >
        {/* 氛围大图极慢地放大缩小（24 秒一个来回） */}
        {cover && <img src={cover} alt="" draggable={false} className="em-kenburns" style={{ ...box(0, 0, 1024, 768), objectFit: 'cover' }} />}
        {cover && <div style={{ ...box(0, 0, 1024, 768), background: 'rgb(0 0 0 / 0.18)' }} />}
        <div style={{ ...box(472.6, 342.8), color: tone }}>
          <LogoStacked />
        </div>
        {!asking && pending && (
          <div style={{ ...box(0, 600, 1024), textAlign: 'center', fontSize: large ? 16 : 12, color: tone }} data-testid="emenu-start-pending">
            有一单结果待确认，请服务员输入手牌后在订单里处理
          </div>
        )}
        {/* 长按版权行 3 秒：员工退出这台平板的登录 */}
        <div
          className="em-en"
          onPointerDown={() => {
            hold.current = window.setTimeout(onExit, 3000);
          }}
          onPointerUp={() => hold.current && window.clearTimeout(hold.current)}
          onPointerLeave={() => hold.current && window.clearTimeout(hold.current)}
          style={{ ...box(0, 715.2, 1024), textAlign: 'center', fontSize: 12, lineHeight: '12px', letterSpacing: '0.09em', color: tone, transform: large ? 'scale(1.2)' : undefined, transformOrigin: '50% 100%' }}
          data-testid="emenu-footer"
        >
          {/* 设计稿：英文 12 号、夹在中间的中文（汤崎）13 号，同一条基线 */}
          {menu.rules.footerText.split(/([\u2E80-\u9FFF\uF900-\uFAFF]+)/).map((part, i) =>
            i % 2 ? (
              <span key={i} style={{ fontFamily: 'var(--em-zh)', fontSize: 13, letterSpacing: '0.5px' }}>
                {part}
              </span>
            ) : (
              part
            ),
          )}
        </div>
      </div>
      {asking && <AskInfo onCancel={onCancel} onReady={onReady} />}
      {/* 「中 | EN」：输入信息的弹窗开着时也能点（画在弹窗的后面一层之上） */}
      {onLang &&
        (large ? (
          // 放大的一档：开关绕自己的中心放大，右边仍贴在 984
          <ZoomAt x={984 - 24 * BIG.ui} y={55.45} k={BIG.ui}>
            <LangToggle lang={lang} onToggle={onLang} x={-24} y={-11.15} light={!!cover && !asking} />
          </ZoomAt>
        ) : (
          <LangToggle lang={lang} onToggle={onLang} x={936} y={44.3} light={!!cover && !asking} />
        ))}
    </>
  );
}

/** 给客人看的出错提示：切到英文时按拒绝码换成英文（没有对应英文的照门店系统给的） */
const guestMessage = (error: unknown, m: Messages, lang: Lang) => (error instanceof ApiError ? ((lang === 'en' && guestErrorEn(error.code)) || error.message) : m.network);
/** 给服务员看的（确认下单那一步）：照门店系统给的中文 */
const message = (error: unknown) => (error instanceof ApiError ? error.message : messages('zh').network);
const candidatesOf = (error: unknown): string[] | null =>
  error instanceof ApiError && (error.code === 'TAG_AMBIGUOUS' || error.code === 'TABLE_AMBIGUOUS') && Array.isArray(error.details?.candidates) ? (error.details.candidates as string[]) : null;

function parseGuests(text: string): number | null {
  const n = Number(text);
  return /^[0-9]{1,2}$/.test(text) && n >= 1 && n <= EMENU_MAX_GUESTS ? n : null;
}

/** 向门店系统核对手牌与桌号：对上了返回这一次点餐；数字重了返回候选让客人点选 */
async function resolveInfo(tag: string, table: string, m: Messages): Promise<{ guest: EmenuGuest; tableName: string } | { pick: 'tag' | 'table'; candidates: string[]; text: string }> {
  let guest: EmenuGuest;
  try {
    guest = await api.get<EmenuGuest>(`/api/emenu/guest?tag=${encodeURIComponent(tag)}`);
  } catch (error) {
    const c = candidatesOf(error);
    if (c) return { pick: 'tag', candidates: c, text: m.pickTag };
    throw error;
  }
  try {
    const { tableName } = await api.get<{ tableName: string }>(`/api/emenu/table?table=${encodeURIComponent(table)}`);
    return { guest, tableName };
  } catch (error) {
    const c = candidatesOf(error);
    if (c) return { pick: 'table', candidates: c, text: m.pickTable };
    throw error;
  }
}

/** 设计稿「起始页——输入手牌号、桌号、人数」 */
function AskInfo({ onCancel, onReady }: { onCancel: () => void; onReady: (session: TableSession, guest: EmenuGuest) => void }) {
  const lang = useLang();
  const m = useM();
  const [values, setValues] = useState({ tag: '', table: lastTable(), guests: '' });
  const [active, setActive] = useState('tag');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ error?: string; hint?: string; pick?: 'tag' | 'table'; candidates?: string[] } | null>(null);
  const fields: InfoField[] = [
    { key: 'tag', label: '手牌', labelEn: 'Tag', value: values.tag, kind: 'tag', maxLength: 7 },
    { key: 'table', label: '桌号', labelEn: 'Table', value: values.table, kind: 'table', maxLength: 12 },
    { key: 'guests', label: '人数', labelEn: 'Guests', value: values.guests, kind: 'digits', maxLength: 2 },
  ];
  const go = async (v = values) => {
    if (busy) return;
    const guests = parseGuests(v.guests);
    const missing = !v.tag ? ['tag', m.needTag] : !v.table ? ['table', m.needTable] : guests === null ? ['guests', m.needGuests] : null;
    if (missing) {
      setActive(missing[0]!);
      setNote({ error: missing[1] });
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const r = await resolveInfo(v.tag, v.table, m);
      if ('pick' in r) {
        setActive(r.pick);
        setNote({ hint: r.text, pick: r.pick, candidates: r.candidates });
      } else {
        onReady({ visitId: r.guest.visitId, tagCode: r.guest.tagCode, tableName: r.tableName, guests: guests! }, r.guest);
      }
    } catch (error) {
      setNote({ error: guestMessage(error, m, lang) });
      if (error instanceof ApiError) setActive(error.code.startsWith('TABLE') ? 'table' : 'tag');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Backdrop blur>
      <InfoModal
        title="输入信息"
        subtitle="INPUT INFORMATION"
        fields={fields}
        active={active}
        onActive={setActive}
        onChange={(key, value) => {
          setValues((v) => ({ ...v, [key]: value }));
          setNote(null);
        }}
        onEnter={() => {
          // 扫码枪、外接键盘的回车：还有没填的就跳到下一项，都填了就开始
          const next = fields.find((f) => !f.value && f.key !== active);
          if (next && fields.find((f) => f.key === active)?.value) setActive(next.key);
          else void go();
        }}
        disabled={busy}
        testId="emenu-ask"
        footer={
          <>
            <ModalButton x={21.4} y={357.2} w={116.1} onClick={onCancel} disabled={busy} testId="emenu-ask-cancel">
              {m.cancel}
            </ModalButton>
            <ModalButton x={19.3} y={423.8} w={388.3} primary onClick={() => void go()} disabled={busy} testId="emenu-ask-go">
              {m.startOrdering}
            </ModalButton>
            <ModalNote
              error={note?.error}
              hint={note ? note.hint : m.askHint}
              candidates={note?.candidates}
              onPick={(c) => {
                const next = { ...values, [note!.pick!]: c };
                setValues(next);
                void go(next);
              }}
            />
          </>
        }
      />
    </Backdrop>
  );
}

// ───────────────────────── 确认下单、结果待确认 ─────────────────────────

/**
 * 设计稿「确认下单」：带出起始页填的手牌、桌号、人数（都还能改），服务员输点单密码。
 * 后台没开「点单密码」（8.0.15 起默认不开）时没有密码那一项：核对一下手牌、桌号、人数，点「下单」。
 */
function ConfirmOrder({
  session,
  requirePin,
  busy,
  note,
  onCancel,
  onResolved,
  onSubmit,
}: {
  session: TableSession;
  requirePin: boolean;
  busy: boolean;
  note: { error?: string; hint?: string } | null;
  onCancel: () => void;
  /** 手牌、桌号改过并且核对上了：这一次点餐跟着改 */
  onResolved: (next: TableSession) => void;
  onSubmit: (session: TableSession, pin: string) => Promise<void>;
}) {
  const m = useM();
  const [values, setValues] = useState({ tag: session.tagCode, table: session.tableName, guests: String(session.guests), pin: '' });
  // 不要密码时一开始哪一项都不接收键盘：手牌、桌号、人数是带出来的，免得碰到键盘改掉
  const [active, setActive] = useState(requirePin ? 'pin' : '');
  const [checking, setChecking] = useState(false);
  const [local, setLocal] = useState<{ error?: string; hint?: string; pick?: 'tag' | 'table'; candidates?: string[] } | null>(null);
  const off = busy || checking;
  const fields: InfoField[] = [
    { key: 'tag', label: '手牌', labelEn: 'Tag', value: values.tag, kind: 'tag', maxLength: 7 },
    { key: 'table', label: '桌号', labelEn: 'Table', value: values.table, kind: 'table', maxLength: 12 },
    { key: 'guests', label: '人数', labelEn: 'Guests', value: values.guests, kind: 'digits', maxLength: 2 },
    ...(requirePin ? [{ key: 'pin', label: '密码', labelEn: 'PIN', value: values.pin, kind: 'digits' as const, maxLength: EMENU_PIN_LENGTH, mask: true }] : []),
  ];
  const go = async (v = values) => {
    if (off) return;
    const guests = parseGuests(v.guests);
    const missing = !v.tag ? ['tag', m.needTag] : !v.table ? ['table', m.needTable] : guests === null ? ['guests', m.needGuests] : requirePin && v.pin.length !== EMENU_PIN_LENGTH ? ['pin', m.needPin] : null;
    if (missing) {
      setActive(missing[0]!);
      setLocal({ error: missing[1] });
      return;
    }
    let next: TableSession = { ...session, guests: guests! };
    setLocal(null);
    // 手牌、桌号改过：先向门店系统核对
    if (v.tag !== session.tagCode || v.table !== session.tableName) {
      setChecking(true);
      try {
        const r = await resolveInfo(v.tag, v.table, m);
        if ('pick' in r) {
          setActive(r.pick);
          setLocal({ hint: r.text, pick: r.pick, candidates: r.candidates });
          return;
        }
        next = { visitId: r.guest.visitId, tagCode: r.guest.tagCode, tableName: r.tableName, guests: guests! };
        setValues((cur) => ({ ...cur, tag: next.tagCode, table: next.tableName }));
      } catch (error) {
        setLocal({ error: message(error) });
        if (error instanceof ApiError) setActive(error.code.startsWith('TABLE') ? 'table' : 'tag');
        return;
      } finally {
        setChecking(false);
      }
    }
    onResolved(next);
    await onSubmit(next, requirePin ? v.pin : '');
    // 没下成（密码不对等）：密码清掉重输
    setValues((cur) => ({ ...cur, pin: '' }));
    setActive(requirePin ? 'pin' : '');
  };
  const shown = local ?? note;
  return (
    <Backdrop>
      <InfoModal
        title="确认信息"
        subtitle="CONFIRM INFORMATION"
        fields={fields}
        active={active}
        onActive={setActive}
        onChange={(key, value) => {
          setValues((v) => ({ ...v, [key]: value }));
          setLocal(null);
        }}
        onEnter={() => void go()}
        disabled={off}
        testId="emenu-confirm"
        footer={
          <>
            <ModalButton x={21.4} y={423.8} w={119} onClick={onCancel} disabled={off} testId="emenu-confirm-cancel">
              {m.cancel}
            </ModalButton>
            <ModalButton x={150.7} y={423.8} w={256.9} primary onClick={() => void go()} disabled={off} testId="emenu-confirm-go">
              {off ? m.placing : m.placeOrder}
            </ModalButton>
            <ModalNote
              error={shown?.error}
              hint={shown?.hint}
              candidates={local?.candidates}
              onPick={(c) => {
                const next = { ...values, [local!.pick!]: c };
                setValues(next);
                void go(next);
              }}
            />
          </>
        }
      />
    </Backdrop>
  );
}

/**
 * 设计稿之外补的「下单结果待确认」：查回、原样重新提交、作废重填。
 * 开着「点单密码」时后两样要服务员输密码（左边一项密码、右边数字键盘）；没开时就是三个按钮，不要键盘。
 */
function PendingOrderModal({
  pending,
  requirePin,
  busy,
  note,
  onClose,
  onCheck,
  onRetry,
  onAbandon,
}: {
  pending: PendingOrder;
  requirePin: boolean;
  busy: boolean;
  note: { error?: string; hint?: string } | null;
  onClose: () => void;
  onCheck: () => void;
  onRetry: (pin: string) => void;
  onAbandon: (pin: string) => void;
}) {
  const [pin, setPin] = useState('');
  const [local, setLocal] = useState<string | null>(null);
  const needPin = (then: (pin: string) => void) => () => {
    if (!requirePin) return then('');
    if (pin.length !== EMENU_PIN_LENGTH) return setLocal(`这一步要服务员输入 ${EMENU_PIN_LENGTH} 位点单密码`);
    setLocal(null);
    then(pin);
    setPin('');
  };
  const info = (label: string, value: ReactNode, i: number) =>
    requirePin ? (
      <div style={{ ...box(21.4, 151.6 + i * 34, 120), fontSize: 13, lineHeight: '16px', whiteSpace: 'nowrap' }}>
        <span style={{ color: 'var(--em-mute)' }}>{label}</span> <span className="em-en">{value}</span>
      </div>
    ) : (
      <div style={{ ...box(0, 122 + i * 32, 429.1), textAlign: 'center', fontSize: 16, lineHeight: '18px', whiteSpace: 'nowrap' }}>
        <span style={{ color: 'var(--em-mute)' }}>{label}</span> <span className="em-en">{value}</span>
      </div>
    );
  const body = (
    <>
      {info('手牌', pending.body.tagCode, 0)}
      {info('桌号', pending.body.tableName, 1)}
      {info('这一单', `${pending.quantity} 份 ¥${yuan(pending.body.expectedTotal)}`, 2)}
      <ModalButton x={21.4} y={423.8} w={119} onClick={onCheck} disabled={busy} testId="emenu-pending-check">
        查回结果
      </ModalButton>
      <ModalButton x={150.7} y={423.8} w={124} primary onClick={needPin(onRetry)} disabled={busy} testId="emenu-pending-retry">
        重新提交
      </ModalButton>
      <ModalButton x={283.6} y={423.8} w={124} onClick={needPin(onAbandon)} disabled={busy} testId="emenu-pending-abandon">
        作废重填
      </ModalButton>
      {requirePin ? (
        <ModalNote
          error={local ?? note?.error}
          hint={local || note?.error ? null : (note?.hint ?? '刚才那一单没有收到门店系统的答复。请服务员处理：先查回；查不到就输密码重新提交（不会重复下单），或作废后重填。')}
        />
      ) : (
        <div style={{ ...box(40, 232, 349.1, 178), display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, textAlign: 'center', fontSize: 14, lineHeight: '22px' }}>
          {note?.error && (
            <span role="alert" style={{ color: 'var(--em-error)' }} data-testid="emenu-error">
              {note.error}
            </span>
          )}
          <span style={{ color: 'var(--em-mute)' }} data-testid="emenu-hint">
            {note?.hint ?? '请先点「查回结果」；查不到就点「重新提交」（不会重复下单），或「作废重填」后改了再下。'}
          </span>
        </div>
      )}
      <button type="button" onClick={onClose} disabled={busy} style={{ ...box(388, 8, 30, 30), padding: 0, border: 0, background: 'none', fontSize: 18, color: 'var(--em-mute)' }} aria-label="先不处理" data-testid="emenu-pending-close">
        ×
      </button>
    </>
  );
  return (
    <Backdrop>
      {requirePin ? (
        <InfoModal
          title="结果待确认"
          subtitle="ORDER NOT CONFIRMED YET"
          fields={[{ key: 'pin', label: '密码', value: pin, kind: 'digits', maxLength: EMENU_PIN_LENGTH, mask: true, row: 3 }]}
          active="pin"
          onActive={() => {}}
          onChange={(_, value) => {
            setPin(value);
            setLocal(null);
          }}
          disabled={busy}
          testId="emenu-pending"
          footer={body}
        />
      ) : (
        <Frame title="结果待确认" subtitle="ORDER NOT CONFIRMED YET" testId="emenu-pending">
          {body}
        </Frame>
      )}
    </Backdrop>
  );
}

// ───────────────────────── 顶栏、翻页小点、没有菜单 ─────────────────────────

/** 页面底部的翻页小点（设计稿之外补的）：只画当前分类的各页 */
function PageDots({ flat, index, onGo }: { flat: FlatPage[]; index: number; onGo: (i: number, mode?: 'slide' | 'jump' | 'zoom') => void }) {
  const at = flat[index];
  if (!at) return null;
  const first = index - at.pageNo;
  const n = at.category.pages.length;
  const hasMore = flat.length > 1;
  const large = useBig();
  if (!hasMore) return null;
  return (
    <div style={{ ...box(0, 742, 1024, 14), display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 7, transform: large ? 'scale(1.5)' : undefined }} data-testid="emenu-dots" data-page={index} data-pages={flat.length}>
      {first > 0 && <Dot onClick={() => onGo(first - 1)} label="上一个分类" small testId="emenu-dot-prev" />}
      {Array.from({ length: n }, (_, i) => (
        <Dot key={i} on={first + i === index} onClick={() => onGo(first + i)} label={`第 ${i + 1} 页`} testId={`emenu-dot-${i}`} />
      ))}
      {first + n < flat.length && <Dot onClick={() => onGo(first + n)} label="下一个分类" small testId="emenu-dot-next" />}
    </div>
  );
}

function Dot({ on, onClick, label, small, testId }: { on?: boolean; onClick: () => void; label: string; small?: boolean; testId: string }) {
  const size = small ? 2.4 : 4;
  return (
    <button type="button" onClick={onClick} aria-label={label} aria-current={on || undefined} style={{ position: 'relative', width: on ? 12 : size, height: size, padding: 0, border: 0, borderRadius: 2, background: on ? 'var(--em-tan)' : 'var(--em-photo)', transition: 'width var(--em-in) var(--em-ease), background-color var(--em-in) ease' }} data-testid={testId}>
      <span style={{ position: 'absolute', inset: '-10px -3.5px' }} />
    </button>
  );
}

/** 现在没有可点的分类（设计稿之外补的）：告诉客人各分类什么时候供应 */
function NoMenu({ menu }: { menu: EmenuMenu }) {
  const lang = useLang();
  const title = menu.later.length ? namePair('现在不在供餐时段', 'KITCHEN IS RESTING NOW', lang) : namePair('菜单还在准备', 'MENU IS ON THE WAY', lang);
  const large = useBig();
  return (
    <div className="em-page-in" style={{ ...box(0, 0, 1024, 768) }} data-testid="emenu-empty">
     <div style={{ ...box(0, 0, 1024, 768), transform: large ? `scale(${BIG.ui})` : undefined, transformOrigin: '512px 384px' }}>
      {title.mainEn ? (
        <>
          <div className="em-en" style={{ ...box(0, 304, 1024), textAlign: 'center', fontSize: 22, lineHeight: '22px', letterSpacing: '0.06em' }}>{title.main}</div>
          <div style={{ ...box(0, 336, 1024), textAlign: 'center', fontSize: 13, color: 'var(--em-mute)' }}>{title.sub}</div>
        </>
      ) : (
        <>
          <div style={{ ...box(0, 300, 1024), textAlign: 'center', fontSize: 28, lineHeight: '28px' }}>{title.main}</div>
          <div className="em-en" style={{ ...box(0, 336, 1024), textAlign: 'center', fontSize: 11, color: 'var(--em-mute)', letterSpacing: '0.4px' }}>
            {title.sub}
          </div>
        </>
      )}
      <div style={{ ...box(312, 384, 400), fontSize: 14, lineHeight: '28px', textAlign: 'center' }}>
        {menu.later.map((c) => (
          <div key={c.name}>
            {namePair(c.name, c.nameEn, lang).mainEn ? <span className="em-en">{c.nameEn}</span> : c.name}
            <span className="em-en" style={{ color: 'var(--em-mute)', marginLeft: 12 }}>
              {formatWindow(c.window)}
            </span>
          </div>
        ))}
        {menu.later.length === 0 && <span style={{ fontSize: 12, color: 'var(--em-mute)' }}>请店主在「后台 → 电子菜单」里排好分类与版面</span>}
      </div>
     </div>
    </div>
  );
}
