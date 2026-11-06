// 柚子饭堂的外壳：开机先问门店系统「我是谁」（连不上就用上次的，离线也能亮码）；底部五个入口按角色显示。
// 第二期（docs/CANTEEN.md 第 14、15 节）：这台手机第一次打开时先放柚子的开场动画；没登录的进门是「新同事登记」
// （扫注册二维码来的 #reg=口令 自动带上），登记好或第一次登录后接着走新手教程。

import { useCallback, useEffect, useState } from 'react';
import { canEditMenu, canScan, type CanteenMe } from '@shared/canteen';
import { RoughDefs, IconChef, IconCamera, IconHome, IconLetter, IconMe, IconMenu, IconTicket } from './doodles';
import { inWeChat, InstallGuide, isStandalone, WeChatTip } from './install';
import { Intro } from './intro/Intro';
import { ApiError, call, clearCachedMe, loadCachedMe, NetworkError, readJson, removeKey, saveMe, writeJson, type CachedMe } from './lib';
import { Mascot } from './Mascot';
import { ClosedPage, JoinPage, LoginPage, OfflinePage } from './pages/Auth';
import { CodePage } from './pages/Code';
import { HomePage } from './pages/Home';
import { KitchenPage } from './pages/Kitchen';
import { MenuPage } from './pages/Menu';
import { MePage } from './pages/Me';
import { RegisterPage } from './pages/Register';
import { ScanPage } from './pages/Scan';
import { TalkPage } from './pages/Talk';
import { Tour, tourDone, tourSteps } from './tour';
import { Button, cn, Sheet, Toasts } from './ui';

type Route = 'home' | 'menu' | 'code' | 'talk' | 'kitchen' | 'scan' | 'me';
const ROUTES: Route[] = ['home', 'menu', 'code', 'talk', 'kitchen', 'scan', 'me'];

/** #join=ABCD2345（开通卡片）、#reg=ABCD2345（注册二维码）、#/menu、#/intro 这样的地址 */
function readHash(): { route: Route; join: string | null; reg: string | null; login: boolean; intro: boolean } {
  const h = window.location.hash.replace(/^#\/?/, '');
  const join = /^join(?:=|\/)([A-Za-z0-9-]*)/.exec(h);
  if (join) return { route: 'home', join: join[1] ?? '', reg: null, login: false, intro: false };
  const reg = /^reg(?:=|\/)([A-Za-z0-9-]*)/.exec(h);
  if (reg) return { route: 'home', join: null, reg: reg[1] ?? '', login: false, intro: false };
  return { route: (ROUTES as string[]).includes(h) ? (h as Route) : 'home', join: null, reg: null, login: h === 'login', intro: h === 'intro' };
}

/** 这台手机看过开场动画没有（K15） */
const INTRO_KEY = 'yuzu.canteen.intro.v1';
const introSeen = () => readJson<boolean>(INTRO_KEY) === true;

export function App() {
  const [hash, setHash] = useState(readHash);
  const [cached, setCached] = useState<CachedMe | null>(loadCachedMe);
  const [state, setState] = useState<'loading' | 'ready' | 'auth' | 'closed' | 'offline'>(cached ? 'ready' : 'loading');
  const [online, setOnline] = useState(navigator.onLine);
  // 开场动画：第一次打开、或从「我的」点「再看一遍」（#/intro）
  const [intro, setIntro] = useState<'first' | 'replay' | null>(() => (hash.intro ? 'replay' : introSeen() ? null : 'first'));
  const [touring, setTouring] = useState(false);
  // 刚看完开场（第一次打开）：没登录的进门就是「新同事登记」；之后再打开没登录的到登录页
  const [justIntroduced, setJustIntroduced] = useState(false);

  useEffect(() => {
    const on = () => {
      const next = readHash();
      setHash(next);
      if (next.intro) setIntro('replay');
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = useCallback((route: string) => {
    window.location.hash = `/${route}`;
    window.scrollTo(0, 0);
  }, []);

  const adopt = useCallback((me: CanteenMe, keepOffsetMs?: number) => {
    setCached(saveMe(me, keepOffsetMs));
    setState('ready');
  }, []);

  /** 问一下门店系统「我是谁」：顺便更新码钥匙与时间差 */
  const refresh = useCallback(async () => {
    try {
      adopt(await call<CanteenMe>('GET', '/api/canteen/me'));
      setOnline(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        clearCachedMe();
        setCached(null);
        setState('auth');
      } else if (e instanceof ApiError && e.code === 'CANTEEN_CLOSED') {
        setState('closed');
      } else if (e instanceof NetworkError) {
        setOnline(false);
        setState((s) => (loadCachedMe() ? 'ready' : s === 'loading' ? 'offline' : s));
      }
    }
  }, [adopt]);

  useEffect(() => {
    if (hash.join !== null || hash.reg !== null || hash.login) {
      setState((s) => (s === 'loading' ? 'auth' : s));
      return;
    }
    void refresh();
    // 只在开机时问一次；之后定时问
  }, []);
  useEffect(() => {
    const up = () => {
      setOnline(true);
      void refresh();
    };
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    const timer = setInterval(() => document.visibilityState === 'visible' && void refresh(), 5 * 60_000);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
      clearInterval(timer);
    };
  }, [refresh]);

  const logout = async () => {
    await call('POST', '/api/canteen/logout').catch(() => undefined);
    clearCachedMe();
    removeKey('yuzu.canteen.menus.v1');
    setCached(null);
    setState('auth');
    window.location.hash = '/login';
  };

  /** 开场动画放完（或跳过）：记下看过了；从「我的」再看的回到「我的」 */
  const introDone = () => {
    writeJson(INTRO_KEY, true);
    const replay = intro === 'replay';
    setIntro(null);
    if (replay) go('me');
    else if (cached && state === 'ready') {
      if (!tourDone()) setTouring(true);
    } else setJustIntroduced(true);
  };

  /** 登记、开通、登录好了：进首页；这台手机没走过新手教程的接着走 */
  const signedIn = (me: CanteenMe) => {
    adopt(me);
    window.location.hash = '/home';
    setHash(readHash());
    if (!tourDone()) setTouring(true);
  };

  const shell = (children: React.ReactNode) => (
    <>
      <RoughDefs />
      <Toasts />
      {inWeChat() && (
        <div className="safe-top mx-auto max-w-[480px] px-4">
          <WeChatTip />
        </div>
      )}
      {children}
    </>
  );

  if (intro) {
    const signedInNow = !!cached && state === 'ready';
    return shell(<Intro cta={intro === 'replay' || signedInNow ? '进门' : hash.join !== null ? '进门开通' : '进门登记'} onDone={introDone} />);
  }

  if (state === 'loading')
    return shell(
      <div className="flex min-h-dvh items-center justify-center">
        <Mascot className="h-32 w-auto" title="柚子" />
      </div>,
    );
  if (state === 'closed') return shell(<ClosedPage onRetry={() => void refresh()} />);
  if (state === 'offline') return shell(<OfflinePage onRetry={() => void refresh()} />);
  // 扫开通卡片（#join=…）或注册二维码（#reg=…）打开的：哪怕这台手机上登录着别人，也先给开通、登记（换人用）
  if (state === 'auth' || !cached || hash.join !== null || hash.reg !== null) {
    // 页面开着时又点了另一个口令的链接（只有 # 后面变了）：按口令换一个新页面，填的口令、核对结果都跟着新链接走，
    // 不会把旧口令（或上一个链接不对时清空的口令）交上去
    if (hash.join !== null && !hash.login) {
      return shell(<JoinPage key={`join:${hash.join}`} initialCode={hash.join} onDone={signedIn} onLogin={() => (window.location.hash = '/login')} />);
    }
    if (hash.reg !== null || (justIntroduced && !hash.login)) {
      return shell(<RegisterPage key={`reg:${hash.reg ?? ''}`} initialCode={hash.reg ?? ''} onDone={signedIn} onLogin={() => (window.location.hash = '/login')} />);
    }
    return shell(<LoginPage onDone={signedIn} onJoin={() => (window.location.hash = 'join=')} onRegister={() => (window.location.hash = 'reg=')} />);
  }

  const { me, offsetMs } = cached;
  const role = me.employee.role;
  const allowed = (r: Route) => (r === 'kitchen' ? canEditMenu(role) : r === 'scan' ? canScan(role) : true);
  const route = allowed(hash.route) ? hash.route : 'home';
  const page = {
    home: <HomePage me={me} offsetMs={offsetMs} online={online} go={go} />,
    menu: <MenuPage me={me} offsetMs={offsetMs} />,
    code: <CodePage me={me} offsetMs={offsetMs} online={online} />,
    talk: <TalkPage me={me} online={online} />,
    kitchen: <KitchenPage me={me} offsetMs={offsetMs} />,
    scan: <ScanPage me={me} offsetMs={offsetMs} online={online} />,
    me: (
      <MePage
        me={me}
        offsetMs={offsetMs}
        online={online}
        onMe={(next) => adopt(next)}
        onPatch={(next) => adopt(next, offsetMs)}
        onLogout={() => void logout()}
        onIntro={() => setIntro('replay')}
        onTour={() => setTouring(true)}
        go={go}
      />
    ),
  }[route];

  return shell(
    <div className="mx-auto min-h-dvh max-w-[480px]">
      <main className="safe-top px-4 pb-32">
        {route === 'home' && <InstallHint />}
        {page}
      </main>
      <TabBar route={route} role={role} go={go} />
      {touring && <Tour steps={tourSteps(role)} route={route} go={go} onClose={() => setTouring(false)} />}
    </div>,
  );
}

type Tab = { key: Route; label: string; icon: (fill: string) => React.ReactNode };

function TabBar({ route, role, go }: { route: Route; role: CanteenMe['employee']['role']; go: (r: string) => void }) {
  const center: Tab = canScan(role)
    ? { key: 'scan', label: '扫码', icon: (f) => <IconCamera size={30} fill={f} /> }
    : { key: 'code', label: '饭卡码', icon: (f) => <IconTicket size={30} fill={f} /> };
  const items: Tab[] = [
    { key: 'home', label: '首页', icon: (f) => <IconHome size={26} fill={f} /> },
    { key: 'menu', label: '菜单', icon: (f) => <IconMenu size={26} fill={f} /> },
    center,
    canEditMenu(role)
      ? { key: 'kitchen', label: '厨房', icon: (f) => <IconChef size={26} fill={f} /> }
      : { key: 'talk', label: '跟柚子说', icon: (f) => <IconLetter size={26} fill={f} /> },
    { key: 'me', label: '我的', icon: (f) => <IconMe size={26} fill={f} /> },
  ];
  return (
    <nav className="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t-[1.5px] border-line-strong bg-cream/95 backdrop-blur" aria-label="柚子饭堂">
      <ul className="mx-auto flex max-w-[480px] items-end justify-around px-2 pt-1.5">
        {items.map((it) => {
          const active = route === it.key;
          const raised = it.key === center.key;
          return (
            <li key={it.key} className="flex-1">
              <button
                type="button"
                onClick={() => go(it.key)}
                aria-current={active ? 'page' : undefined}
                data-testid={`tab-${it.key}`}
                data-tour={`tab-${it.key}`}
                className="flex w-full flex-col items-center gap-0.5 py-1 active:scale-95"
              >
                {raised ? (
                  <span
                    className={cn(
                      '-mt-7 flex size-[60px] items-center justify-center rounded-full text-white ring-4 ring-cream transition-colors',
                      active ? 'bg-wood-deep' : 'bg-wood',
                    )}
                    style={{ boxShadow: '0 5px 0 var(--color-wood-ink)' }}
                  >
                    {it.icon('var(--color-yuzu)')}
                  </span>
                ) : (
                  <span className={cn('flex h-9 w-12 items-center justify-center rounded-full transition-colors', active ? 'text-wood-ink' : 'text-ink-3')}>
                    {it.icon(active ? 'var(--color-yuzu)' : 'none')}
                  </span>
                )}
                <span className={cn('text-[11px] font-extrabold whitespace-nowrap', active ? 'text-ink' : 'text-ink-3')}>{it.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

const HINT_KEY = 'yuzu.canteen.installHint.v1';
function InstallHint() {
  const [hidden, setHidden] = useState(() => isStandalone() || inWeChat() || !!readJson<boolean>(HINT_KEY));
  const [open, setOpen] = useState(false);
  if (hidden) return null;
  return (
    <div className="mb-4 flex animate-rise items-center gap-3 rounded-[var(--radius-card)] bg-organic-soft px-4 py-3 ring-1 ring-organic/30">
      <p className="flex-1 text-[14px] font-bold text-leaf-deep">把柚子饭堂放到桌面，开饭时一点就亮码</p>
      <Button tone="leaf" className="h-9 px-3 text-[13px]" onClick={() => setOpen(true)}>
        怎么放
      </Button>
      <button
        type="button"
        aria-label="不再提示"
        className="text-[18px] text-ink-3"
        onClick={() => {
          writeJson(HINT_KEY, true);
          setHidden(true);
        }}
      >
        ✕
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="添加到桌面">
        <InstallGuide />
      </Sheet>
    </div>
  );
}
