// ERP 独立工作区（v0.7.3，店主 2026-10-30 定，见 docs/ERP.md）：财务、采购用的页面放在这里，门店主导航看不到。
// 导航按模块注册表（@shared/erp）生成：店主关掉的模块、没有权限的模块都不显示；库存、采购、货款、待办的页面地址不变。

import { useEffect, type ReactNode } from 'react';
import { Navigate, NavLink, Outlet, useLocation } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Boxes, ClipboardList, HandCoins, Inbox, LayoutGrid, LineChart, ReceiptText, ShoppingCart, SlidersHorizontal, type LucideIcon } from 'lucide-react';
import { ERP_MODULES, erpModuleOfPage, type ErpModuleKey } from '@shared/erp';
import { versionText } from '@shared/instance';
import { DUTY_LABELS, ROLE_LABELS } from '@shared/labels';
import { api } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn } from '../../lib/utils';
import { LogoMark } from '../../components/Brand';
import { InstanceBadge } from '../../components/InstanceTag';
import { Notice } from '../../components/ui';
import { useErpAccess } from './access';

const ICONS: Record<ErpModuleKey, LucideIcon> = {
  inventory: Boxes,
  purchasing: ShoppingCart,
  requests: ClipboardList,
  payables: HandCoins,
  approvals: Inbox,
  expenses: ReceiptText,
  revenue: LineChart,
};

interface Item {
  key: string;
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  badge?: number;
}

export function ErpShell() {
  const session = useSession();
  const can = useCan();
  const access = useErpAccess();
  const { pathname } = useLocation();
  useEffect(() => {
    document.title = `ERP · ${session.storeName}`;
    return () => {
      document.title = session.storeName;
    };
  }, [session.storeName]);
  const todo = useQuery({
    queryKey: ['inv', 'todo-count'],
    queryFn: () => api.get<{ count: number }>('/api/inventory/todo-count'),
    enabled: access.modules.includes('approvals') && can('inventory.approve'),
    refetchInterval: 60_000,
  });
  if (!access.canEnter) return <Navigate to="/" replace />;

  const moduleItem = (k: ErpModuleKey): Item => ({ key: k, to: ERP_MODULES[k].path, label: ERP_MODULES[k].label, icon: ICONS[k], badge: k === 'approvals' ? todo.data?.count : undefined });
  const groups: { title: string; items: Item[] }[] = [
    { title: '概览', items: [{ key: 'home', to: '/erp', label: 'ERP 首页', icon: LayoutGrid, end: true }] },
    { title: '供应链', items: access.modules.filter((k) => ERP_MODULES[k].group === '供应链').map(moduleItem) },
    { title: '财务', items: access.modules.filter((k) => ERP_MODULES[k].group === '财务').map(moduleItem) },
    { title: '设置', items: access.canSettings ? [{ key: 'modules', to: '/erp/modules', label: '模块设置', icon: SlidersHorizontal }] : [] },
  ].filter((g) => g.items.length > 0);

  const link = (it: Item, compact: boolean) => {
    const Icon = it.icon;
    return (
      <NavLink
        key={it.key}
        to={it.to}
        end={it.end}
        // 待办的数字不进入链接名称（读屏与自动化按「审批待办」找到它）
        aria-label={it.label}
        data-testid={compact ? `erp-tab-${it.key}` : `erp-nav-${it.key}`}
        className={({ isActive }) =>
          cn(
            'flex items-center gap-2.5 font-semibold whitespace-nowrap transition-colors',
            compact ? 'h-10 rounded-full px-3.5 text-[13.5px]' : 'h-10 rounded-lg px-3 text-[14px]',
            isActive ? 'bg-pine text-paper' : 'text-ink-2 hover:bg-paper-2 hover:text-ink',
          )
        }
      >
        <Icon className="size-4 shrink-0" />
        <span className="min-w-0 flex-1">{it.label}</span>
        {!!it.badge && (
          <span className="num flex h-5 min-w-5 items-center justify-center rounded-full bg-yuzu px-1.5 text-[11px] font-bold text-ink" aria-hidden>
            {it.badge > 99 ? '99+' : it.badge}
          </span>
        )}
      </NavLink>
    );
  };

  return (
    <div className="flex h-dvh min-h-0 flex-col bg-paper" data-testid="erp-shell">
      <header className="flex h-14 shrink-0 items-center gap-3 bg-[#22344a] px-4 text-paper md:px-5">
        <LogoMark className="size-8 rounded-[10px] ring-1 ring-white/10" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] leading-tight font-bold">
            ERP<span className="hidden font-semibold text-paper/60 sm:inline"> · {session.storeName}</span>
          </p>
          {/* 实例标识与「版本 + SHA」常显（窄屏也显示） */}
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5" data-testid="erp-instance" title={versionText(session.version, session.commit)}>
            <InstanceBadge instance={session.instance} className="h-5 px-2 text-[11px]" />
            <span className="num truncate text-[11px] text-paper/60">{versionText(session.version, session.commit)}</span>
          </p>
        </div>
        <span className="hidden text-[12.5px] text-paper/75 md:inline">
          {session.staff.displayName} · {[ROLE_LABELS[session.staff.role], ...session.staff.duties.map((d) => DUTY_LABELS[d].title)].join(' · ')}
        </span>
        {access.storeHome ? (
          <NavLink to={access.storeHome} className="flex h-9 items-center gap-1.5 rounded-full bg-white/10 px-3.5 text-[13px] font-semibold text-paper hover:bg-white/18" data-testid="erp-exit">
            <ArrowLeft className="size-4" />
            返回门店
          </NavLink>
        ) : (
          <NavLink to="/password" className="flex h-9 items-center rounded-full bg-white/10 px-3.5 text-[13px] font-semibold text-paper hover:bg-white/18">
            修改密码
          </NavLink>
        )}
      </header>
      {/* 窄屏：模块横排在顶部，可横向滑动 */}
      <nav aria-label="ERP 分区" className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-line bg-card px-3 py-2 lg:hidden">
        {groups.flatMap((g) => g.items).map((it) => link(it, true))}
      </nav>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="ERP 导航" className="scroll-thin hidden w-[212px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-line bg-card px-3 py-4 lg:flex">
          {groups.map((g) => (
            <div key={g.title} className="flex flex-col gap-0.5">
              <p className="px-3 pb-1 text-[11.5px] font-bold tracking-wide text-ink-4">{g.title}</p>
              {g.items.map((it) => link(it, false))}
            </div>
          ))}
        </nav>
        {/* 不按地址重新挂载：库存的各个页签之间切换时，页面里的状态与原来在门店里一样保留 */}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
          <ErpModuleGate module={erpModuleOfPage(pathname)}>
            <Outlet />
          </ErpModuleGate>
        </main>
      </div>
    </div>
  );
}

/** 模块的页面（按注册表里的页面前缀认出属于哪个模块）：模块关着（或依赖的模块关着）时提示，不打开页面；没有权限时回到 ERP 首页 */
function ErpModuleGate({ module, children }: { module: ErpModuleKey | null; children: ReactNode }) {
  const session = useSession();
  const can = useCan();
  if (!module) return <>{children}</>;
  const def = ERP_MODULES[module];
  if (!def.perms.some((p) => can(p))) return <Navigate to="/erp" replace />;
  if (!session.erpModules.includes(module)) {
    return (
      <div className="mx-auto w-full max-w-[720px] px-5 py-8" data-testid="erp-module-off">
        <Notice tone="info" title={`ERP 的「${def.label}」模块没有开启`}>
          {def.requires.length ? `它依赖「${def.requires.map((r) => ERP_MODULES[r].label).join('」「')}」模块。` : ''}
          店主在 ERP「模块设置」里开启后才能使用。
        </Notice>
      </div>
    );
  }
  return <>{children}</>;
}
