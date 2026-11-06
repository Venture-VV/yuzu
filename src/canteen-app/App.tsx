// 柚子饭堂的外壳：开机先问门店系统「我是谁」（连不上就用上次的，离线也能亮码）；底部五个入口按角色显示。

import { useCallback, useEffect, useState } from 'react';
import { canEditMenu, canScan, type CanteenMe } from '@shared/canteen';
import { inWeChat, InstallGuide, isStandalone, WeChatTip } from './install';
import { ApiError, call, clearCachedMe, loadCachedMe, NetworkError, readJson, removeKey, saveMe, writeJson, type CachedMe } from './lib';
import { Mascot } from './Mascot';
import { ClosedPage, JoinPage, LoginPage, OfflinePage } from './pages/Auth';
import { CodePage } from './pages/Code';
import { HomePage } from './pages/Home';
import { KitchenPage } from './pages/Kitchen';
import { MenuPage } from './pages/Menu';
import { MePage } from './pages/Me';
import { ScanPage } from './pages/Scan';
import { Button, cn, Sheet, Toasts } from './ui';

type Route = 'home' | 'menu' | 'code' | 'kitchen' | 'scan' | 'me';
const ROUTES: Route[] = ['home', 'menu', 'code', 'kitchen', 'scan', 'me'];

/** #join=ABCD2345（开通卡片的二维码）、#/menu 这样的地址 */
function readHash(): { route: Route; join: string | null; login: boolean } {
  const h = window.location.hash.replace(/^#\/?/, '');
  const join = /^join(?:=|\/)([A-Za-z0-9-]*)/.exec(h);
  if (join) return { route: 'home', join: join[1] ?? '', login: false };
  return { route: (ROUTES as string[]).includes(h) ? (h as Route) : 'home', join: null, login: h === 'login' };
}

export function App() {
  const [hash, setHash] = useState(readHash);
  const [cached, setCached] = useState<CachedMe | null>(loadCachedMe);
  const [state, setState] = useState<'loading' | 'ready' | 'auth' | 'closed' | 'offline'>(cached ? 'ready' : 'loading');
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => {
    const on = () => setHash(readHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = useCallback((route: string) => {
    window.location.hash = `/${route}`;
    window.scrollTo(0, 0);
  }, []);

  const adopt = useCallback((me: CanteenMe) => {
    setCached(saveMe(me));
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
    if (hash.join !== null || hash.login) {
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

  const shell = (children: React.ReactNode) => (
    <>
      <Toasts />
      {inWeChat() && (
        <div className="safe-top mx-auto max-w-[480px] px-4">
          <WeChatTip />
        </div>
      )}
      {children}
    </>
  );

  if (state === 'loading')
    return shell(
      <div className="flex min-h-dvh items-center justify-center">
        <Mascot className="size-24 animate-float" />
      </div>,
    );
  if (state === 'closed') return shell(<ClosedPage onRetry={() => void refresh()} />);
  if (state === 'offline') return shell(<OfflinePage onRetry={() => void refresh()} />);
  // 扫开通卡片打开的（#join=…）：哪怕这台手机上登录着别人，也先给开通（换人用、或重新开通）
  if (state === 'auth' || !cached || hash.join !== null) {
    const done = (me: CanteenMe) => {
      adopt(me);
      window.location.hash = '/home';
      setHash(readHash());
    };
    return shell(
      hash.join !== null && !hash.login ? (
        <JoinPage initialCode={hash.join} onDone={done} onLogin={() => (window.location.hash = '/login')} />
      ) : (
        <LoginPage onDone={done} onJoin={() => (window.location.hash = 'join=')} />
      ),
    );
  }

  const { me, offsetMs } = cached;
  const role = me.employee.role;
  const allowed = (r: Route) => (r === 'kitchen' ? canEditMenu(role) : r === 'scan' ? canScan(role) : true);
  const route = allowed(hash.route) ? hash.route : 'home';
  const page = {
    home: <HomePage me={me} offsetMs={offsetMs} online={online} go={go} />,
    menu: <MenuPage me={me} offsetMs={offsetMs} />,
    code: <CodePage me={me} offsetMs={offsetMs} online={online} />,
    kitchen: <KitchenPage me={me} offsetMs={offsetMs} />,
    scan: <ScanPage me={me} offsetMs={offsetMs} online={online} />,
    me: <MePage me={me} offsetMs={offsetMs} online={online} onMe={adopt} onLogout={() => void logout()} />,
  }[route];

  return shell(
    <div className="mx-auto min-h-dvh max-w-[480px]">
      <main className="safe-top px-4 pb-32">
        {route === 'home' && <InstallHint />}
        {page}
      </main>
      <TabBar route={route} role={role} go={go} />
    </div>,
  );
}

function TabBar({ route, role, go }: { route: Route; role: CanteenMe['employee']['role']; go: (r: string) => void }) {
  const center: { key: Route; emoji: string; label: string } = canScan(role) ? { key: 'scan', emoji: '📷', label: '扫码' } : { key: 'code', emoji: '🎫', label: '饭卡码' };
  const items: { key: Route; emoji: string; label: string }[] = [
    { key: 'home', emoji: '🏠', label: '首页' },
    { key: 'menu', emoji: '📖', label: '菜单' },
    center,
    ...(canEditMenu(role) ? [{ key: 'kitchen' as Route, emoji: '👩‍🍳', label: '厨房' }] : []),
    { key: 'me', emoji: '😊', label: '我的' },
  ];
  return (
    <nav className="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-line bg-cream/95 backdrop-blur" aria-label="柚子饭堂">
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
                className="flex w-full flex-col items-center gap-0.5 py-1 active:scale-95"
              >
                {raised ? (
                  <span className={cn('-mt-6 flex size-[58px] items-center justify-center rounded-full text-[28px] shadow-[0_6px_0_#e0a91c] ring-4 ring-cream', active ? 'bg-yuzu' : 'bg-yuzu/90')}>
                    {it.emoji}
                  </span>
                ) : (
                  <span className={cn('flex h-9 w-12 items-center justify-center rounded-full text-[22px] transition-colors', active && 'bg-yuzu-soft')}>{it.emoji}</span>
                )}
                <span className={cn('text-[11px] font-extrabold', active ? 'text-ink' : 'text-ink-3')}>{it.label}</span>
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
    <div className="mb-4 flex animate-rise items-center gap-3 rounded-[var(--radius-card)] bg-leaf-soft px-4 py-3 ring-1 ring-leaf/30">
      <span className="text-[26px]">📲</span>
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
