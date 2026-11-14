// 管理后台（v0.6.0）：与前台分开的一套页面——规则设置、价目、手牌池、员工与岗位权限、期初与审计集中在这里，
// 前台只管当班的业务。分区按权限开放（店主全部；店总看价目、规则总表与审计；值班经理维护手牌池）。
// 数据看板（店主 2026-11-10）：原来门店主导航的「看板」整合到这里；只有看板权限的岗位（值班经理、客户经理、收银）
// 也能进后台，但只看得到「数据看板」（没有后台首页，进来直接到看板）。

import { useEffect, type ReactNode } from 'react';
import { Link, Navigate, NavLink, Outlet, useLocation } from 'react-router';
import { SubTabPage, type SubTab } from '../../components/SubNav';
import { useSlidingIndicator } from '../../lib/motion';
import {
  ArchiveRestore,
  ArrowLeft,
  BedDouble,
  BookOpenText,
  CalendarClock,
  ClipboardList,
  Crown,
  Footprints,
  Gift,
  HandHeart,
  Layers,
  LayoutDashboard,
  LayoutGrid,
  ListChecks,
  Map as MapIcon,
  Printer,
  Scale,
  ShieldCheck,
  Smartphone,
  Soup,
  Tags,
  Ticket,
  UsersRound,
  UtensilsCrossed,
  type LucideIcon,
} from 'lucide-react';
import { ADMIN_GROUPS, ADMIN_SECTION_MODULES, ADMIN_SECTIONS, ADMIN_STANDALONE_SECTIONS, type AdminSection } from '@shared/admin';
import { ERP_MODULES, ERP_SETTINGS_PATH } from '@shared/erp';
import { versionText } from '@shared/instance';
import { ROLE_LABELS } from '@shared/labels';
import { useCan, useSession } from '../../lib/session';
import { cn } from '../../lib/utils';
import { LogoMark } from '../../components/Brand';
import { InstanceBadge } from '../../components/InstanceTag';
import { Notice } from '../../components/ui';

const ICONS: Record<AdminSection, LucideIcon> = {
  home: LayoutGrid,
  dashboard: LayoutDashboard,
  settings: ListChecks,
  rules: Scale,
  membership: Crown,
  coupons: Ticket,
  catalog: Gift,
  tags: Tags,
  technicians: HandHeart,
  dining: UtensilsCrossed,
  emenu: BookOpenText,
  rooms: BedDouble,
  bookings: CalendarClock,
  spaces: Layers,
  guide: MapIcon,
  devices: Printer,
  mp: Smartphone,
  staff: UsersRound,
  permissions: ShieldCheck,
  canteen: Soup,
  patrol: Footprints,
  opening: ArchiveRestore,
  audit: ClipboardList,
};

/** 当前账号能进的后台分区；进不了后台首页、只有看板权限的岗位只看得到数据看板（店主 2026-11-10） */
export function useAdminSections() {
  const can = useCan();
  const session = useSession();
  const all = (Object.keys(ADMIN_SECTIONS) as AdminSection[])
    .filter((k) => ADMIN_SECTIONS[k].perms.some((p) => can(p)))
    // 跟着 ERP 模块开关走的分区（员工食堂、安保巡场，8.0.18）：关着时只有能去开的人还看得到
    .filter((k) => {
      const module = ADMIN_SECTION_MODULES[k];
      return !module || session.erpModules.includes(module) || can('settings.manage');
    });
  return all.includes('home') ? all : all.filter((k) => ADMIN_STANDALONE_SECTIONS.includes(k));
}

export function AdminShell() {
  const session = useSession();
  const sections = useAdminSections();
  const location = useLocation();
  // 动效（8.0.16）：导航里当前分区的底块滑过去（宽屏的侧栏与窄屏的横排各一块）
  const sidePill = useSlidingIndicator<HTMLElement>('.nav-on', `${location.pathname}|${sections.length}`, 140);
  const tabPill = useSlidingIndicator<HTMLElement>('.nav-on', `${location.pathname}|${sections.length}`, 140);
  useEffect(() => {
    document.title = `管理后台 · ${session.storeName}`;
    return () => {
      document.title = session.storeName;
    };
  }, [session.storeName]);
  if (sections.length === 0) return <Navigate to="/" replace />;
  // 没有后台首页的（只有看板、员工食堂或安保巡场的权限）：进来直接到自己的第一个分区
  if (!sections.includes('home') && location.pathname.replace(/\/+$/, '') === ADMIN_SECTIONS.home.path) return <Navigate to={ADMIN_SECTIONS[sections[0]!].path} replace />;

  const groups = ADMIN_GROUPS.map((g) => ({ ...g, items: g.items.filter((k) => sections.includes(k)) })).filter((g) => g.items.length > 0);
  const link = (k: AdminSection, compact: boolean) => {
    const Icon = ICONS[k];
    const pill = compact ? tabPill : sidePill;
    return (
      <NavLink
        key={k}
        to={ADMIN_SECTIONS[k].path}
        end={k === 'home'}
        data-testid={compact ? `admin-tab-${k}` : `admin-nav-${k}`}
        className={({ isActive }) =>
          cn(
            'relative flex shrink-0 items-center gap-2.5 font-semibold whitespace-nowrap transition-colors duration-100',
            compact ? 'h-10 rounded-full px-3.5 text-[13.5px]' : 'h-10 rounded-lg px-3 text-[14px]',
            // 当前项的底块：量得到位置时由导航里那一块滑过来画（8.0.16），量不到时自己画
            isActive ? cn('nav-on text-paper', !pill.style && 'bg-pine') : 'text-ink-2 hover:bg-paper-2 hover:text-ink',
          )
        }
      >
        <Icon className="size-4 shrink-0" />
        {ADMIN_SECTIONS[k].label}
      </NavLink>
    );
  };

  return (
    <div className="flex h-dvh min-h-0 flex-col bg-paper" data-testid="admin-shell">
      <header className="flex h-14 shrink-0 items-center gap-3 bg-[#1d3f31] px-4 text-paper md:px-5">
        <LogoMark className="size-8 rounded-[10px] ring-1 ring-white/10" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] leading-tight font-bold">
            管理后台<span className="hidden font-semibold text-paper/60 sm:inline"> · {session.storeName}</span>
          </p>
          {/* 实例标识与「版本 + SHA」常显（窄屏也显示） */}
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5" data-testid="admin-instance" title={versionText(session.version, session.commit)}>
            <InstanceBadge instance={session.instance} className="h-5 px-2 text-[11px]" />
            <span className="num truncate text-[11px] text-paper/60">{versionText(session.version, session.commit)}</span>
          </p>
        </div>
        <span className="hidden text-[12.5px] text-paper/75 md:inline">
          {session.staff.displayName} · {ROLE_LABELS[session.staff.role]}
        </span>
        <NavLink
          to="/"
          className="flex h-9 items-center gap-1.5 rounded-full bg-white/10 px-3.5 text-[13px] font-semibold text-paper hover:bg-white/18"
          data-testid="admin-exit"
        >
          <ArrowLeft className="size-4" />
          返回前台
        </NavLink>
      </header>
      {/* 窄屏：分区横排在顶部，可横向滑动 */}
      <nav ref={tabPill.ref} aria-label="后台分区" className="relative flex shrink-0 gap-1.5 overflow-x-auto border-b border-line bg-card px-3 py-2 lg:hidden">
        {tabPill.style && <span key={tabPill.jump} aria-hidden className={cn('mo-indicator rounded-full bg-pine', tabPill.jump > 0 && 'mo-indicator-jump')} data-settled={tabPill.settled} style={tabPill.style} />}
        {groups.flatMap((g) => g.items).map((k) => link(k, true))}
      </nav>
      <div className="flex min-h-0 flex-1">
        <nav ref={sidePill.ref} aria-label="后台导航" className="scroll-thin relative hidden w-[212px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-line bg-card px-3 py-4 lg:flex">
          {sidePill.style && <span key={sidePill.jump} aria-hidden className={cn('mo-indicator rounded-lg bg-pine', sidePill.jump > 0 && 'mo-indicator-jump')} data-settled={sidePill.settled} style={sidePill.style} />}
          {groups.map((g) => (
            <div key={g.title} className="flex flex-col gap-0.5">
              <p className="px-3 pb-1 text-[11.5px] font-bold tracking-wide text-ink-4">{g.title}</p>
              {g.items.map((k) => link(k, false))}
            </div>
          ))}
        </nav>
        {/* 换分区重新挂载、内容区淡入（8.0.16）。按分区那一段地址算（/admin/technicians），分区里换二级页签不重新挂载：
            别的页签里填到一半的东西还在（8.0.17） */}
        <main className="scroll-thin min-h-0 min-w-0 flex-1 animate-page-in overflow-y-auto" key={location.pathname.split('/').slice(0, 3).join('/')}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/**
 * 分区页：标题、说明与权限；没有权限时回到后台首页。
 * tabs（8.0.17）：这个分区的二级页签——画在标题下面，写进地址（/admin/<分区>/<页签>）；里面的内容用 SubPane 分到各页签。
 */
export function AdminPage({
  section,
  description,
  actions,
  children,
  wide,
  tabs,
}: {
  section: AdminSection;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  wide?: boolean;
  tabs?: readonly SubTab[];
}) {
  const sections = useAdminSections();
  if (!sections.includes(section)) return <Navigate to="/admin" replace />;
  const header = (
    <div className={cn('flex flex-wrap items-end gap-x-4 gap-y-2', tabs ? 'mb-3' : 'mb-5')}>
      <div className="min-w-0 flex-1">
        <h1 className="text-[21px] font-bold tracking-tight text-ink">{ADMIN_SECTIONS[section].label}</h1>
        {description && <p className="mt-0.5 text-[13px] text-ink-3">{description}</p>}
      </div>
      {actions}
    </div>
  );
  return (
    <div className={cn('mx-auto px-4 py-5 md:px-7 md:py-6', wide ? 'max-w-[1280px]' : 'max-w-[1080px]')}>
      {tabs ? (
        <SubTabPage tabs={tabs} base={ADMIN_SECTIONS[section].path} label={`${ADMIN_SECTIONS[section].label}的页签`} header={header}>
          {children}
        </SubTabPage>
      ) : (
        <>
          {header}
          {children}
        </>
      )}
    </div>
  );
}

/**
 * 跟着 ERP 模块开关走的分区（员工食堂、安保巡场，8.0.18）：模块关着时不画页面，提示去哪开。
 * 关着时接口也拒绝（ERP_MODULE_DISABLED），所以这里先拦住，不让页面一片报错。
 */
export function AdminModuleGate({ section, children }: { section: AdminSection; children: ReactNode }) {
  const session = useSession();
  const module = ADMIN_SECTION_MODULES[section];
  if (!module || session.erpModules.includes(module)) return <>{children}</>;
  const def = ERP_MODULES[module];
  return (
    <div data-testid="admin-module-off">
      <Notice tone="info" title={`「${def.label}」还没有开启`}>
        {def.requires.length ? `它依赖「${def.requires.map((r) => ERP_MODULES[r].label).join('」「')}」。` : ''}
        店主在{' '}
        <Link to={`${ERP_SETTINGS_PATH}`} className="font-bold text-lake hover:underline">
          ERP 设置 → 模块开关
        </Link>{' '}
        里开启后才能使用；数据都保留。
      </Notice>
    </div>
  );
}
