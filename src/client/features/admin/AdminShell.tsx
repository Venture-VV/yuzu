// 管理后台（v0.6.0）：与前台分开的一套页面——规则设置、价目、手牌池、员工与岗位权限、期初与审计集中在这里，
// 前台只管当班的业务。分区按权限开放（店主全部；店总看价目、规则总表与审计；值班经理维护手牌池）。

import { useEffect, type ReactNode } from 'react';
import { Navigate, NavLink, Outlet, useLocation } from 'react-router';
import {
  ArchiveRestore,
  ArrowLeft,
  BedDouble,
  ClipboardList,
  Gift,
  HandHeart,
  IdCard,
  Layers,
  LayoutGrid,
  ListChecks,
  Printer,
  Scale,
  ShieldCheck,
  Tags,
  Ticket,
  UsersRound,
  UtensilsCrossed,
  type LucideIcon,
} from 'lucide-react';
import { ADMIN_SECTIONS, type AdminSection } from '@shared/admin';
import { versionText } from '@shared/instance';
import { ROLE_LABELS } from '@shared/labels';
import { useCan, useSession } from '../../lib/session';
import { cn } from '../../lib/utils';
import { LogoMark } from '../../components/Brand';
import { InstanceBadge } from '../../components/InstanceTag';

const ICONS: Record<AdminSection, LucideIcon> = {
  home: LayoutGrid,
  settings: ListChecks,
  rules: Scale,
  members: IdCard,
  coupons: Ticket,
  catalog: Gift,
  tags: Tags,
  technicians: HandHeart,
  dining: UtensilsCrossed,
  rooms: BedDouble,
  spaces: Layers,
  devices: Printer,
  staff: UsersRound,
  permissions: ShieldCheck,
  opening: ArchiveRestore,
  audit: ClipboardList,
};

const GROUPS: { title: string; items: AdminSection[] }[] = [
  { title: '概览', items: ['home', 'settings'] },
  { title: '经营设置', items: ['rules', 'members', 'coupons', 'catalog', 'tags', 'technicians', 'dining', 'rooms', 'spaces'] },
  { title: '人员与权限', items: ['staff', 'permissions'] },
  { title: '数据', items: ['opening', 'audit'] },
];

/** 当前账号能进的后台分区 */
export function useAdminSections() {
  const can = useCan();
  return (Object.keys(ADMIN_SECTIONS) as AdminSection[]).filter((k) => ADMIN_SECTIONS[k].perms.some((p) => can(p)));
}

export function AdminShell() {
  const session = useSession();
  const sections = useAdminSections();
  const location = useLocation();
  useEffect(() => {
    document.title = `管理后台 · ${session.storeName}`;
    return () => {
      document.title = session.storeName;
    };
  }, [session.storeName]);
  if (!sections.includes('home')) return <Navigate to="/" replace />;

  const groups = GROUPS.map((g) => ({ ...g, items: g.items.filter((k) => sections.includes(k)) })).filter((g) => g.items.length > 0);
  const link = (k: AdminSection, compact: boolean) => {
    const Icon = ICONS[k];
    return (
      <NavLink
        key={k}
        to={ADMIN_SECTIONS[k].path}
        end={k === 'home'}
        data-testid={compact ? `admin-tab-${k}` : `admin-nav-${k}`}
        className={({ isActive }) =>
          cn(
            'flex items-center gap-2.5 font-semibold whitespace-nowrap transition-colors',
            compact ? 'h-10 rounded-full px-3.5 text-[13.5px]' : 'h-10 rounded-lg px-3 text-[14px]',
            isActive ? 'bg-pine text-paper' : 'text-ink-2 hover:bg-paper-2 hover:text-ink',
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
      <nav aria-label="后台分区" className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-line bg-card px-3 py-2 lg:hidden">
        {groups.flatMap((g) => g.items).map((k) => link(k, true))}
      </nav>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="后台导航" className="scroll-thin hidden w-[212px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-line bg-card px-3 py-4 lg:flex">
          {groups.map((g) => (
            <div key={g.title} className="flex flex-col gap-0.5">
              <p className="px-3 pb-1 text-[11.5px] font-bold tracking-wide text-ink-4">{g.title}</p>
              {g.items.map((k) => link(k, false))}
            </div>
          ))}
        </nav>
        <main className="scroll-thin min-h-0 min-w-0 flex-1 overflow-y-auto" key={location.pathname}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/** 分区页：标题、说明与权限；没有权限时回到后台首页 */
export function AdminPage({ section, description, actions, children, wide }: { section: AdminSection; description?: ReactNode; actions?: ReactNode; children: ReactNode; wide?: boolean }) {
  const sections = useAdminSections();
  if (!sections.includes(section)) return <Navigate to="/admin" replace />;
  return (
    <div className={cn('mx-auto px-4 py-5 md:px-7 md:py-6', wide ? 'max-w-[1280px]' : 'max-w-[1080px]')}>
      <div className="mb-5 flex flex-wrap items-end gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <h1 className="text-[21px] font-bold tracking-tight text-ink">{ADMIN_SECTIONS[section].label}</h1>
          {description && <p className="mt-0.5 text-[13px] text-ink-3">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </div>
  );
}
