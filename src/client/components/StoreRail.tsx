// 门店主导航（8.1.15，《浴族系统需求汇总》系统整体，docs/YUZU_REQ_V8115.md 3.G）：按业务域分组，有二级入口，能折叠。
//
// - 展开：带分组标题的侧栏（宽 200）。当前页面所在的组默认打开，别的组点标题打开 / 折起；
// - 收起：一列业务域的图标（宽 76 / 84）。当前所在的组把二级入口直接列在下面（点组名能折起），别的组点一下在右边弹出二级入口；
// - 1440 宽起默认展开，窄一些的默认收起（1280×720 的收银机、平板横屏照旧是一列图标，不用滚动就看得到全部业务域）；
//   左下角的按钮在两种之间换，记在这台设备的浏览器里；
// - 8.2.0 P02（回测 2-1）：导航固定在左边、撑满一屏，菜单长了在导航里面滚（内容区另滚，见 AppShell）。
//   窄屏（1024 以下）平时是一列图标，点「展开导航」是盖在内容上的抽屉，带遮罩，点遮罩、按 Esc、换页面都收回；
//   收起时鼠标停在业务域上就弹出二级入口（触屏照旧点一下弹出）；
// - 每个二级入口都是主导航里的一个链接（名字就是页面名），带 data-nav-item；所在的组折着时链接在页面上但看不见，
//   用例用 e2e/nav.ts 的 navLink 先打开组再点。
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router';
import { ChevronDown, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useSlidingIndicator } from '../lib/motion';
import { useSession } from '../lib/session';
import { cn } from '../lib/utils';
import { LogoMark } from './Brand';
import { storeDomainOf, useStoreNav, type StoreNavDomain, type StoreNavDomainKey, type StoreNavItem } from './storeNav';

type NavMode = 'expanded' | 'collapsed';
interface NavPrefs {
  /** 使用者自己选过的展开 / 收起；没选过按屏幕宽度 */
  mode?: NavMode;
  /** 使用者自己打开、折起过的组；没动过的组：当前所在的打开，别的折着 */
  open?: Partial<Record<StoreNavDomainKey, boolean>>;
}

const PREFS_KEY = 'yuzu.storeNav.v1';
const WIDE = '(min-width: 1440px)';
/** 1024 起展开是挤开内容的侧栏；窄一些展开是盖在内容上的抽屉 */
const DOCKED = '(min-width: 1024px)';
/** 能悬停的指针（鼠标、触控板）：收起时停在业务域上就弹出二级入口 */
const HOVER = '(hover: hover) and (pointer: fine)';

function loadPrefs(): NavPrefs {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? '{}');
    return value && typeof value === 'object' ? (value as NavPrefs) : {};
  } catch {
    return {};
  }
}

function useNavPrefs(): [NavPrefs, (next: NavPrefs) => void] {
  const [prefs, setPrefs] = useState<NavPrefs>(loadPrefs);
  const save = (next: NavPrefs) => {
    setPrefs(next);
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    } catch {
      // 存不了（无痕窗口、被禁用）：这一次照样换，刷新后回到默认
    }
  };
  return [prefs, save];
}

function useMedia(query: string): boolean {
  const [match, setMatch] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query);
    const update = () => setMatch(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return match;
}

/** 弹出的二级入口贴着业务域按钮的右边；放不下时往上挪，不出屏幕 */
function flyoutPosition(button: HTMLElement, itemCount: number): CSSProperties {
  const rect = button.getBoundingClientRect();
  const height = 44 + itemCount * 46;
  const top = Math.max(8, Math.min(rect.top, window.innerHeight - height - 8));
  return { top, left: rect.right + 10 };
}

export function StoreRail({ footer }: { footer: ReactNode }) {
  const session = useSession();
  const domains = useStoreNav();
  const { pathname } = useLocation();
  const current = storeDomainOf(pathname);
  const [prefs, savePrefs] = useNavPrefs();
  const wide = useMedia(WIDE);
  const docked = useMedia(DOCKED);
  const hover = useMedia(HOVER);
  // 窄屏的抽屉：换了页面就收回（记着打开时的地址）
  const [drawerAt, setDrawerAt] = useState<string | null>(null);
  const drawer = !docked && drawerAt === pathname;
  const expanded = docked ? (prefs.mode ?? (wide ? 'expanded' : 'collapsed')) === 'expanded' : drawer;
  useEffect(() => {
    if (!drawer) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setDrawerAt(null);
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [drawer]);
  const isOpen = (key: StoreNavDomainKey) => prefs.open?.[key] ?? key === current;
  const toggleOpen = (key: StoreNavDomainKey) => savePrefs({ ...prefs, open: { ...prefs.open, [key]: !isOpen(key) } });

  // 收起时弹出的那一组：换了页面、换了展开 / 收起就不算开着
  const [flyout, setFlyout] = useState<{ key: StoreNavDomainKey; path: string; style: CSSProperties; hover?: boolean } | null>(null);
  const hoverTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);
  const openFlyout = flyout && flyout.path === pathname && !expanded ? flyout : null;
  const railRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!openFlyout) return;
    const close = (e: MouseEvent) => {
      if (!railRef.current?.contains(e.target as Node)) setFlyout(null);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setFlyout(null);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [openFlyout]);

  const openKey = domains.map((d) => (isOpen(d.key) ? '1' : '0')).join('');
  // 当前项的底块：量得到位置时滑过去画，量不到时（所在的组折着、在弹出层里）各自画
  const pill = useSlidingIndicator<HTMLDivElement>('.nav-on', `${pathname}|${expanded}|${openKey}|${domains.length}`, 220);

  const ctx: DomainCtx = {
    expanded,
    current,
    pillDrawn: !!pill.style,
    isOpen,
    onToggle: (d, button) => {
      if (expanded || d.key === current) return toggleOpen(d.key);
      window.clearTimeout(hoverTimer.current);
      // 鼠标停上去已经弹出来的：点一下是留住它，不是关掉
      if (openFlyout?.key === d.key && openFlyout.hover) return setFlyout({ ...openFlyout, hover: false });
      setFlyout(openFlyout?.key === d.key ? null : { key: d.key, path: pathname, style: flyoutPosition(button, d.items.length) });
    },
    onHover: hover
      ? (d, button) => {
          window.clearTimeout(hoverTimer.current);
          if (expanded || d.key === current) return;
          if (!button) {
            // 移出了这一组（含弹出层）：稍等一下再收，让鼠标走过按钮与弹出层之间的空隙
            hoverTimer.current = window.setTimeout(() => setFlyout((f) => (f?.key === d.key && f.hover ? null : f)), 220);
            return;
          }
          if (openFlyout?.key === d.key) return;
          if (openFlyout && !openFlyout.hover) return;
          hoverTimer.current = window.setTimeout(() => setFlyout({ key: d.key, path: pathname, style: flyoutPosition(button, d.items.length), hover: true }), 120);
        }
      : undefined,
    // 进了这一组（按钮或弹出来的二级入口）就不收：鼠标从按钮走到弹出层要经过一道空隙（Codex 审查 f1e5186 的 P2）
    onKeep: hover ? () => window.clearTimeout(hoverTimer.current) : undefined,
    flyout: openFlyout,
  };

  const nav = (
    <nav
      ref={railRef}
      aria-label="主导航"
      data-surface="rail"
      data-mode={expanded ? 'expanded' : 'collapsed'}
      data-drawer={drawer ? 'open' : undefined}
      data-testid="store-rail"
      className={cn(
        'flex h-full min-h-0 shrink-0 flex-col bg-rail pt-4 pb-4 text-paper short:pt-2.5 short:pb-2.5',
        expanded ? 'w-[200px] items-stretch gap-1' : 'w-[76px] items-center gap-1 short:gap-0.5 md:w-[84px]',
        drawer && 'fixed inset-y-0 left-0 z-40 w-[240px] shadow-pop',
      )}
    >
      <NavLink to="/" aria-label="浴族 yuzu 首页" className={cn('mb-4 flex items-center gap-2.5 short:mb-2', expanded ? 'mx-3 rounded-[14px]' : 'rounded-[14px] ring-1 ring-white/10')}>
        <LogoMark className={cn('size-10 shrink-0 short:size-8', expanded && 'rounded-[14px] ring-1 ring-white/10')} />
        {expanded && (
          <span className="min-w-0">
            <span className="block text-[15px] leading-tight font-bold">浴族</span>
            <span className="block truncate text-[12px] leading-tight text-paper/60">{session.storeName}</span>
          </span>
        )}
      </NavLink>
      <div
        ref={pill.ref}
        data-testid="nav-list"
        className={cn('scroll-thin relative flex min-h-0 w-full flex-1 flex-col overflow-y-auto', expanded ? 'gap-0.5 px-2' : 'items-center gap-1 short:gap-0.5')}
      >
        {pill.style && (
          <span
            key={pill.jump}
            aria-hidden
            className={cn('mo-indicator rounded-[14px] bg-white/12 short:rounded-[12px]', expanded && 'rounded-lg short:rounded-lg', pill.jump > 0 && 'mo-indicator-jump')}
            data-settled={pill.settled}
            style={pill.style}
          >
            <span className={cn('absolute top-1/2 h-6 w-1 -translate-y-1/2 rounded-r-full bg-yuzu', expanded ? '-left-2' : '-left-[10px]')} />
          </span>
        )}
        {domains.map((d) => (
          <Domain key={d.key} domain={d} ctx={ctx} />
        ))}
      </div>
      <button
        type="button"
        onClick={() => (docked ? savePrefs({ ...prefs, mode: expanded ? 'collapsed' : 'expanded' }) : setDrawerAt(drawer ? null : pathname))}
        aria-label={expanded ? '收起导航' : '展开导航'}
        title={expanded ? '收起成一列图标' : '展开成带分组的侧栏'}
        data-testid="nav-mode-toggle"
        className={cn(
          'flex shrink-0 items-center rounded-[12px] text-paper/60 transition-colors hover:bg-white/6 hover:text-paper',
          expanded ? 'mx-2 h-11 gap-2.5 px-3 text-[13px] font-semibold' : 'size-11 justify-center',
        )}
      >
        {expanded ? <PanelLeftClose className="size-[18px]" /> : <PanelLeftOpen className="size-[18px]" />}
        {expanded && '收起导航'}
      </button>
      <div className="flex flex-col items-center">{footer}</div>
    </nav>
  );
  if (!drawer) return nav;
  // 抽屉开着：原地留一列图标宽的空位（内容不跳），抽屉盖在内容上，遮罩点一下收回
  return (
    <>
      <div aria-hidden className="w-[76px] shrink-0 bg-rail md:w-[84px]" />
      <div aria-hidden className="fixed inset-0 z-30 bg-ink/35 animate-fade" onClick={() => setDrawerAt(null)} data-testid="nav-drawer-scrim" />
      {nav}
    </>
  );
}

interface DomainCtx {
  expanded: boolean;
  current: StoreNavDomainKey | null;
  /** 滑动的底块画出来了：当前项自己就不再画底色 */
  pillDrawn: boolean;
  isOpen: (key: StoreNavDomainKey) => boolean;
  onToggle: (domain: StoreNavDomain, button: HTMLButtonElement) => void;
  /** 鼠标停上去（button）/ 移开（null）；触屏没有 */
  onHover?: (domain: StoreNavDomain, button: HTMLButtonElement | null) => void;
  /** 鼠标回到这一组里：取消正要收起的弹出层 */
  onKeep?: () => void;
  flyout: { key: StoreNavDomainKey; style: CSSProperties } | null;
}

function Domain({ domain, ctx }: { domain: StoreNavDomain; ctx: DomainCtx }) {
  const groupId = useId();
  const single = domain.items.length === 1 ? domain.items[0]! : null;
  const here = domain.key === ctx.current;
  const open = ctx.isOpen(domain.key);
  const Icon = domain.icon;

  // 只有一个二级入口的组（例如「餐饮」）：直接是那一页的链接
  if (single) {
    return (
      <div data-nav-domain={domain.key} data-testid={`nav-domain-${domain.key}`} className={cn(!ctx.expanded && 'flex flex-col items-center')}>
        <ItemLink item={single} ctx={ctx} level="top" title={single.label === domain.label ? single.label : `${domain.label} · ${single.label}`} />
      </div>
    );
  }

  // 展开时，或收起时当前所在的组：二级入口列在组名下面
  const inline = ctx.expanded || here;
  const flyoutOpen = !inline && ctx.flyout?.key === domain.key;
  // 当前所在的组折着时，组名就是「当前」
  const headerOn = here && !open;

  return (
    <div
      data-nav-domain={domain.key}
      data-testid={`nav-domain-${domain.key}`}
      // 收起时当前所在的组：组名和下面的入口放在一块浅底上，一眼看得出是一组
      className={cn(ctx.expanded ? 'flex flex-col' : 'flex flex-col items-center gap-0.5', !ctx.expanded && here && open && 'rounded-[16px] bg-white/6 pb-0.5')}
      onMouseLeave={ctx.onHover && !inline ? () => ctx.onHover!(domain, null) : undefined}
      onMouseEnter={ctx.onKeep && !inline ? ctx.onKeep : undefined}
    >
      <button
        type="button"
        data-nav-toggle
        aria-expanded={inline ? open : flyoutOpen}
        aria-controls={groupId}
        aria-haspopup={inline ? undefined : 'true'}
        title={`${domain.label}：${domain.items.map((i) => i.label).join('、')}`}
        onClick={(e) => ctx.onToggle(domain, e.currentTarget)}
        onMouseEnter={ctx.onHover && !inline ? (e) => ctx.onHover!(domain, e.currentTarget) : undefined}
        className={cn(
          'group relative transition-colors',
          ctx.expanded
            ? 'flex h-11 w-full items-center gap-2.5 rounded-lg px-3 text-[13px] font-bold'
            : 'flex w-[64px] flex-col items-center gap-0.5 rounded-[14px] py-2 text-[12px] font-semibold short:gap-0 short:rounded-[12px] short:py-1 tiny:py-[3px]',
          headerOn ? cn('nav-on text-paper', !ctx.pillDrawn && 'bg-white/12') : here ? 'text-paper' : 'text-paper/60 hover:bg-white/6 hover:text-paper',
          flyoutOpen && 'bg-white/12 text-paper',
        )}
      >
        <Icon className={cn(ctx.expanded ? 'size-[18px] shrink-0' : 'size-[21px] short:size-[18px]')} strokeWidth={here ? 2.2 : 1.8} />
        <span className={cn(ctx.expanded && 'flex-1 text-left')}>{domain.label}</span>
        {ctx.expanded ? (
          <ChevronDown className={cn('size-4 shrink-0 text-paper/50 transition-transform', open && 'rotate-180')} />
        ) : (
          inline && <ChevronDown aria-hidden className={cn('absolute right-1 bottom-1 size-3 text-paper/40 transition-transform', open && 'rotate-180')} />
        )}
      </button>
      {inline ? (
        <div id={groupId} role="group" aria-label={domain.label} hidden={!open} className={cn(ctx.expanded ? 'flex flex-col gap-0.5 pb-1.5' : 'flex flex-col items-center gap-0.5 pb-1')}>
          {domain.items.map((item) => (
            <ItemLink key={item.to} item={item} ctx={ctx} level="sub" />
          ))}
        </div>
      ) : (
        <div
          id={groupId}
          role="group"
          aria-label={domain.label}
          hidden={!flyoutOpen}
          data-surface="panel"
          data-testid={`nav-flyout-${domain.key}`}
          style={flyoutOpen ? ctx.flyout!.style : undefined}
          className="fixed z-40 w-52 animate-menu-in rounded-lg border border-line bg-card p-1.5 text-ink shadow-pop"
        >
          <p className="px-3 pt-1 pb-1.5 text-[12px] font-bold tracking-wide text-ink-3">{domain.label}</p>
          {domain.items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              data-nav-item={item.label}
              className={({ isActive }) =>
                cn('flex h-11 items-center gap-2.5 rounded-md px-3 text-[14px] font-semibold', isActive ? 'bg-pine-tint text-pine' : 'text-ink-2 hover:bg-paper-2 hover:text-ink')
              }
            >
              <item.icon className="size-4 shrink-0" />
              {item.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

/** 一个页面入口：展开时是一行（二级的往里缩），收起时是图标加字 */
function ItemLink({ item, ctx, level, title }: { item: StoreNavItem; ctx: DomainCtx; level: 'top' | 'sub'; title?: string }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.end}
      aria-label={item.label}
      title={title}
      data-nav-item={item.label}
      className={({ isActive }) =>
        cn(
          'group relative transition-colors',
          ctx.expanded
            ? cn('flex h-11 items-center gap-2.5 rounded-lg pr-3 text-[14px] font-semibold', level === 'sub' ? 'pl-9' : 'pl-3')
            : cn(
                'flex flex-col items-center gap-0.5 rounded-[14px] font-semibold short:gap-0 short:rounded-[12px]',
                level === 'sub' ? 'w-[60px] py-1.5 text-[12px] short:py-1 tiny:py-[3px]' : 'w-[64px] py-2 text-[12px] short:py-1 tiny:py-[3px]',
              ),
          isActive ? cn('nav-on text-paper', !ctx.pillDrawn && 'bg-white/12') : 'text-paper/60 hover:bg-white/6 hover:text-paper',
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive && !ctx.pillDrawn && <span className={cn('absolute top-1/2 h-6 w-1 -translate-y-1/2 rounded-r-full bg-yuzu', ctx.expanded ? '-left-2' : '-left-[10px]')} />}
          <Icon
            className={cn('shrink-0', ctx.expanded ? 'size-[18px]' : level === 'sub' ? 'size-[17px] short:size-4' : 'size-[21px] short:size-[18px]', ctx.expanded && level === 'sub' && 'size-4')}
            strokeWidth={isActive ? 2.2 : 1.8}
          />
          <span>{item.label}</span>
        </>
      )}
    </NavLink>
  );
}
