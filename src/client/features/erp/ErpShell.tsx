// ERP 独立工作区（v0.7.3，店主 2026-10-30 定，见 docs/ERP.md）：财务、采购用的页面放在这里，门店主导航看不到。
// 导航按模块注册表（@shared/erp）生成：店主关掉的模块、没有权限的模块都不显示；库存、采购、货款、待办的页面地址不变。

import { useEffect, type ReactNode } from 'react';
import { Navigate, NavLink, Outlet, useLocation } from 'react-router';
import { usePageEnter, useSlidingIndicator } from '../../lib/motion';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Banknote, Boxes, ClipboardCheck, ClipboardList, FileSignature, FileText, HandCoins, Landmark, LayoutGrid, LineChart, Monitor, Package, ReceiptText, ShieldCheck, ShoppingCart, SlidersHorizontal, Soup, type LucideIcon } from 'lucide-react';
import type { ApprovalCounts } from '@shared/approvals';
import type { ContractExpiryItem } from '@shared/contracts';
import type { PaymentTodo } from '@shared/payments';
import type { InvoiceTodo } from '@shared/invoices';
import type { SupplyTodo } from '@shared/supply';
import type { ArTodo } from '@shared/ar';
import { ERP_MODULES, ERP_NAV_GROUPS, ERP_SETTINGS_PATH, erpModuleOfPage, type ErpModuleKey } from '@shared/erp';
import { versionText } from '@shared/instance';
import { DUTY_LABELS, ROLE_LABELS } from '@shared/labels';
import { api } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn } from '../../lib/utils';
import { LogoMark } from '../../components/Brand';
import { InstanceBadge } from '../../components/InstanceTag';
import { Notice } from '../../components/ui';
import { useErpAccess } from './access';
import { erpSettingsTabs } from './settingsTabs';

const ICONS: Record<ErpModuleKey, LucideIcon> = {
  inventory: Boxes,
  purchasing: ShoppingCart,
  requests: ClipboardList,
  deptStock: Package,
  payables: HandCoins,
  assets: Monitor,
  approvals: ClipboardCheck,
  contracts: FileSignature,
  payments: Banknote,
  expenses: ReceiptText,
  invoices: FileText,
  receivables: Landmark,
  revenue: LineChart,
  canteen: Soup,
  patrol: ShieldCheck,
};

interface Item {
  key: string;
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  badge?: number;
  /** 数字标红（审批中心有超时的） */
  alert?: boolean;
}

export function ErpShell() {
  const session = useSession();
  const can = useCan();
  const access = useErpAccess();
  const { pathname } = useLocation();
  // 动效（8.0.16）：换页面时内容区淡入；导航里当前模块的底块滑过去（宽屏的侧栏与窄屏的横排各一块）
  const content = usePageEnter<HTMLElement>(pathname);
  const sidePill = useSlidingIndicator<HTMLElement>('.nav-on', pathname, 140);
  const tabPill = useSlidingIndicator<HTMLElement>('.nav-on', pathname, 140);
  useEffect(() => {
    document.title = `ERP · ${session.storeName}`;
    return () => {
      document.title = session.storeName;
    };
  }, [session.storeName]);
  // 审批中心（v0.7.30）：待我审批的张数加急采待补单、急采待验收（负责人）；有超时的数字标红
  const todo = useQuery({
    queryKey: ['approvals', 'count'],
    queryFn: () => api.get<ApprovalCounts>('/api/approvals/count'),
    enabled: access.modules.includes('approvals') && (can('approval.act') || can('inventory.approve') || can('expense.approve')),
    refetchInterval: 60_000,
  });
  // 合同（v0.7.31，C11）：60 天内到期、还没续签的份数（维护合同的人看）
  const expiring = useQuery({
    queryKey: ['inv', 'contracts', 'expiring'],
    queryFn: () => api.get<ContractExpiryItem[]>('/api/erp/contracts/expiring'),
    enabled: access.modules.includes('contracts') && can('contract.manage'),
    refetchInterval: 300_000,
  });
  // 付款（v0.7.32）：批了待付款的申请（登记付款的人）、到期前 30 天的质保金（P9）
  const payTodo = useQuery({
    queryKey: ['inv', 'payments', 'todo'],
    queryFn: () => api.get<PaymentTodo>('/api/erp/payments/todo'),
    enabled: access.modules.includes('payments') && can('payable.read'),
    refetchInterval: 300_000,
  });
  // 费用与备用金（8.0.1 采购组整改 11）：已收货、待报销的现付采购单张数
  const toClaim = useQuery({
    queryKey: ['erp', 'expenses', 'to-claim-count'],
    queryFn: () => api.get<{ received: number }>('/api/erp/expenses/to-claim/count'),
    enabled: access.modules.includes('expenses') && can('expense.read'),
    refetchInterval: 300_000,
  });
  // 发票台账（8.0.3，BI09）：认证期限到期前几天以内（含已过期）的待认证发票
  const invTodo = useQuery({
    queryKey: ['erp', 'invoices', 'todo'],
    queryFn: () => api.get<InvoiceTodo>('/api/erp/invoices/todo'),
    enabled: access.modules.includes('invoices') && (can('payable.read') || can('expense.read') || can('invoice.manage')),
    refetchInterval: 300_000,
  });
  // 供应链（8.0.7）：库存——呆滞、临期与过期的批次；采购——待准入的供应商、快到期与过期的证照
  const supplyTodo = useQuery({
    queryKey: ['inv', 'supply-todo'],
    queryFn: () => api.get<SupplyTodo>('/api/inventory/supply-todo'),
    enabled: access.modules.includes('inventory') && can('inventory.read'),
    refetchInterval: 300_000,
  });
  // 应收与挂账（8.0.7）：超过提醒天数没回的挂账笔数
  const arTodo = useQuery({
    queryKey: ['erp', 'receivables', 'todo'],
    queryFn: () => api.get<ArTodo>('/api/erp/receivables/todo'),
    enabled: access.modules.includes('receivables') && can('ar.read'),
    refetchInterval: 300_000,
  });
  if (!access.canEnter) return <Navigate to="/" replace />;
  const contractsDue = (expiring.data ?? []).filter((x) => !x.renewal);
  const paymentsBadge = payTodo.data ? (can('payable.manage') ? payTodo.data.awaitingPayment : 0) + payTodo.data.warrantyDue : undefined;

  const moduleItem = (k: ErpModuleKey): Item => ({
    key: k,
    to: ERP_MODULES[k].path,
    label: ERP_MODULES[k].label,
    icon: ICONS[k],
    badge:
      k === 'approvals' && todo.data
        ? todo.data.mine + todo.data.backfill + todo.data.accept
        : k === 'contracts'
          ? contractsDue.length
          : k === 'payments'
            ? paymentsBadge
            : k === 'expenses'
              ? toClaim.data?.received
              : k === 'invoices'
                ? invTodo.data?.due
                : k === 'inventory' && supplyTodo.data
                  ? supplyTodo.data.slowMoving + supplyTodo.data.expiringLots + supplyTodo.data.expiredLots || undefined
                  : k === 'purchasing' && supplyTodo.data
                    ? supplyTodo.data.pendingAdmission + supplyTodo.data.licensesDue || undefined
                    : k === 'receivables' && arTodo.data
                      ? arTodo.data.overdueCharges + (arTodo.data.platformOverdueCents > 0 ? 1 : 0) || undefined
                      : undefined,
    alert:
      (k === 'approvals' && !!todo.data?.overdue) ||
      (k === 'contracts' && contractsDue.some((x) => x.daysLeft < 0)) ||
      (k === 'invoices' && !!invTodo.data?.overdue) ||
      (k === 'inventory' && !!supplyTodo.data?.expiredLots) ||
      (k === 'purchasing' && !!supplyTodo.data?.licensesExpired) ||
      (k === 'receivables' && !!arTodo.data && (arTodo.data.overdueCharges > 0 || arTodo.data.platformOverdueCents > 0)),
  });
  // 导航的分组与顺序（8.0.18，docs/IA_V8017.md 第 3.3 节）：审批单列、应付归财务、「法务」改叫「合同」；
  // 员工食堂、安保巡场、营业数据已经挪到后台，这里各留一条跳转（下一个版本去掉）
  const settingsTabs = erpSettingsTabs(can, session.erpModules);
  const groups: { title: string; items: Item[] }[] = [
    { title: '概览', items: [{ key: 'home', to: '/erp', label: 'ERP 首页', icon: LayoutGrid, end: true }] },
    ...ERP_NAV_GROUPS.map((g) => ({ title: g.title, items: g.modules.filter((k) => access.modules.includes(k)).map(moduleItem) })),
    { title: '设置', items: settingsTabs.length ? [{ key: 'settings', to: ERP_SETTINGS_PATH, label: 'ERP 设置', icon: SlidersHorizontal }] : [] },
  ].filter((g) => g.items.length > 0);

  // 现在在哪个模块：模块下的其他页面也算；规则类的旧地址（采购规则）现在都在「ERP 设置」里
  const activeKey = pathname === ERP_SETTINGS_PATH || pathname.startsWith(`${ERP_SETTINGS_PATH}/`) ? 'settings' : erpModuleOfPage(pathname);
  const link = (it: Item, compact: boolean) => {
    const Icon = it.icon;
    const pill = compact ? tabPill : sidePill;
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
            'relative flex shrink-0 items-center gap-2.5 font-semibold whitespace-nowrap transition-colors duration-100',
            compact ? 'h-10 rounded-full px-3.5 text-[13.5px]' : 'h-10 rounded-lg px-3 text-[14px]',
            // 模块下的其他页面（如费用模块的备用金、采购台账、账目自检）也高亮所属模块。
            // 当前项的底块：量得到位置时由导航里那一块滑过来画（8.0.16），量不到时自己画
            isActive || activeKey === it.key ? cn('nav-on text-paper', !pill.style && 'bg-pine') : 'text-ink-2 hover:bg-paper-2 hover:text-ink',
          )
        }
      >
        <Icon className="size-4 shrink-0" />
        <span className="min-w-0 flex-1">{it.label}</span>
        {!!it.badge && (
          <span
            // 待办的数字变了：小幅回弹一下（8.0.16）
            key={it.badge}
            className={cn('num flex h-5 min-w-5 animate-tick items-center justify-center rounded-full px-1.5 text-[11px] font-bold', it.alert ? 'bg-clay text-paper' : 'bg-yuzu text-ink')}
            aria-hidden
            data-testid={`erp-badge-${it.key}`}
          >
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
      <nav ref={tabPill.ref} aria-label="ERP 分区" className="relative flex shrink-0 gap-1.5 overflow-x-auto border-b border-line bg-card px-3 py-2 lg:hidden">
        {tabPill.style && <span key={tabPill.jump} aria-hidden className={cn('mo-indicator rounded-full bg-pine', tabPill.jump > 0 && 'mo-indicator-jump')} data-settled={tabPill.settled} style={tabPill.style} />}
        {groups.flatMap((g) => g.items).map((it) => link(it, true))}
      </nav>
      <div className="flex min-h-0 flex-1">
        <nav ref={sidePill.ref} aria-label="ERP 导航" className="scroll-thin relative hidden w-[212px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-line bg-card px-3 py-4 lg:flex">
          {sidePill.style && <span key={sidePill.jump} aria-hidden className={cn('mo-indicator rounded-lg bg-pine', sidePill.jump > 0 && 'mo-indicator-jump')} data-settled={sidePill.settled} style={sidePill.style} />}
          {groups.map((g) => (
            <div key={g.title} className="flex flex-col gap-0.5">
              <p className="px-3 pb-1 text-[11.5px] font-bold tracking-wide text-ink-4">{g.title}</p>
              {g.items.map((it) => link(it, false))}
            </div>
          ))}
        </nav>
        {/* 不按地址重新挂载：库存的各个页签之间切换时，页面里的状态与原来在门店里一样保留 */}
        <main ref={content} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
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
          店主在「ERP 设置 → 模块开关」里开启后才能使用。
        </Notice>
      </div>
    );
  }
  return <>{children}</>;
}
