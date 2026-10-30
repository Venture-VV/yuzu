import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, CalendarCheck2, ClipboardCheck, ConciergeBell, HandCoins, Inbox, KeyRound, LayoutDashboard, LogOut, ReceiptText, Settings2, ShoppingCart, UsersRound } from 'lucide-react';
import { describeBusinessHours, isOpenAt, minuteOfDay } from '@shared/business-date';
import { describeDate, DUTY_LABELS, ROLE_LABELS } from '@shared/labels';
import { ADMIN_PERMISSIONS } from '@shared/admin';
import type { Permission } from '@shared/permissions';
import { api } from '../lib/api';
import { useCan, useSession } from '../lib/session';
import { cn } from '../lib/utils';
import { LogoMark } from './Brand';
import { InstanceTag } from './InstanceTag';
import { PendingOpsBanner } from './PendingOpsBanner';
import { FrontdeskPendingBanner } from '../features/frontdesk/PendingBanner';
import { Badge } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: typeof UsersRound;
  /** 拥有其中任一权限即显示 */
  perm: Permission | Permission[];
  end?: boolean;
}

// 前台与会员储值、库存采购是独立的业务组，导航中用分隔线区分
const NAV: NavItem[][] = [
  [
    { to: '/frontdesk', label: '前台', icon: ConciergeBell, perm: 'frontdesk.read' },
    { to: '/', label: '会员', icon: UsersRound, end: true, perm: 'member.read' },
    { to: '/ledger', label: '流水', icon: ReceiptText, perm: 'ledger.readToday' },
    { to: '/settlement', label: '日结', icon: CalendarCheck2, perm: 'ledger.readToday' },
    { to: '/shift', label: '交班', icon: ClipboardCheck, perm: 'ledger.readToday' },
    { to: '/dashboard', label: '看板', icon: LayoutDashboard, perm: ['ledger.readToday', 'report.executive', 'report.members'] },
  ],
  [
    { to: '/inventory', label: '库存', icon: Boxes, perm: 'inventory.read' },
    { to: '/purchasing', label: '采购', icon: ShoppingCart, perm: ['purchase.manage', 'inventory.approve', 'payable.read'] },
    { to: '/payables', label: '货款', icon: HandCoins, perm: 'payable.read' },
    { to: '/todo', label: '待办', icon: Inbox, perm: 'inventory.approve' },
  ],
  // 管理后台是单独的一套页面（规则、价目、手牌池、员工与权限）
  [{ to: '/admin', label: '后台', icon: Settings2, perm: [...ADMIN_PERMISSIONS] }],
];

export function AppShell({ children }: { children: ReactNode }) {
  const can = useCan();
  const session = useSession();
  const todo = useQuery({
    queryKey: ['inv', 'todo-count'],
    queryFn: () => api.get<{ count: number }>('/api/inventory/todo-count'),
    enabled: can('inventory.approve'),
    refetchInterval: 60_000,
  });
  const badges: Record<string, number | undefined> = { '/todo': todo.data?.count };
  return (
    <div className="flex h-dvh min-h-0 bg-paper">
      <nav
        aria-label="主导航"
        className="flex w-[76px] shrink-0 flex-col items-center gap-1 bg-[#1d3f31] pt-4 pb-4 text-paper short:gap-0.5 short:pt-2.5 short:pb-2.5 md:w-[84px]"
      >
        <NavLink to="/" aria-label="浴族 yuzu 首页" className="mb-5 rounded-[14px] ring-1 ring-white/10 short:mb-2">
          <LogoMark className="size-10 short:size-8" />
        </NavLink>
        <div className="scroll-thin flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto short:gap-0.5">
          {NAV.map((group) => group.filter((n) => (Array.isArray(n.perm) ? n.perm : [n.perm]).some((p) => can(p))))
            .filter((group) => group.length > 0)
            .map((group, gi) => (
              <div key={group[0]!.to} className="flex flex-col items-center gap-1 short:gap-0.5">
                {gi > 0 && <span className="my-1.5 h-px w-8 bg-white/12 short:my-1" aria-hidden />}
                {group.map(({ to, label, icon: Icon, end }) => (
                  <NavLink
                    key={to}
                    to={to}
                    end={end}
                    aria-label={label}
                    title={badges[to] ? `${badges[to]} 项待确认` : undefined}
                    className={({ isActive }) =>
                      cn(
                        'group relative flex w-[64px] flex-col items-center gap-0.5 rounded-[14px] py-2 text-[12px] font-semibold transition-colors short:rounded-[12px] short:py-1 short:text-[11px]',
                        isActive ? 'bg-white/12 text-paper' : 'text-paper/60 hover:bg-white/6 hover:text-paper',
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {isActive && <span className="absolute top-1/2 -left-[10px] h-6 w-1 -translate-y-1/2 rounded-r-full bg-yuzu" />}
                        <span className="relative">
                          <Icon className="size-[21px] short:size-[18px]" strokeWidth={isActive ? 2.2 : 1.8} />
                          {!!badges[to] && (
                            <span aria-hidden className="num absolute -top-1.5 -right-2.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-yuzu px-1 text-[10.5px] font-bold text-ink ring-2 ring-[#1d3f31]">
                              {badges[to]! > 99 ? '99+' : badges[to]}
                            </span>
                          )}
                        </span>
                        <span>{label}</span>
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            ))}
        </div>
        <InstanceTag instance={session.instance} version={session.version} commit={session.commit} />
        <UserMenu />
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <PendingOpsBanner />
        {can('frontdesk.operate') && <FrontdeskPendingBanner />}
        {children}
      </div>
    </div>
  );
}

function UserMenu() {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const qc = useQueryClient();

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const logout = async () => {
    await api.post('/api/auth/logout').catch(() => {});
    qc.clear();
    navigate('/login', { replace: true });
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex size-11 items-center justify-center rounded-full bg-yuzu text-[15px] font-bold text-ink ring-2 ring-white/15 transition hover:ring-white/35 short:size-9 short:text-[14px]"
        title={`${session.staff.displayName} · ${roleText(session.staff)}`}
      >
        {session.staff.displayName.slice(0, 1)}
      </button>
      {open && (
        <div role="menu" className="absolute bottom-0 left-[calc(100%+12px)] z-30 w-56 animate-rise rounded-lg border border-line bg-card p-1.5 text-ink shadow-pop">
          <div className="px-3 pt-2 pb-2.5">
            <p className="text-[14px] font-bold">{session.staff.displayName}</p>
            <p className="text-[12px] text-ink-3">
              {roleText(session.staff)} · {session.staff.username}
            </p>
          </div>
          <div className="my-1 h-px bg-line" />
          <MenuItem icon={<KeyRound className="size-4" />} onClick={() => { setOpen(false); navigate('/password'); }}>
            修改密码
          </MenuItem>
          <MenuItem icon={<LogOut className="size-4" />} onClick={logout}>
            退出登录
          </MenuItem>
        </div>
      )}
    </div>
  );
}

function roleText(staff: { role: keyof typeof ROLE_LABELS; duties: (keyof typeof DUTY_LABELS)[] }) {
  return [ROLE_LABELS[staff.role], ...staff.duties.map((d) => DUTY_LABELS[d].title)].join(' · ');
}

function MenuItem({ icon, children, onClick }: { icon: ReactNode; children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex h-10 w-full items-center gap-2.5 rounded-md px-3 text-left text-[14px] font-medium text-ink-2 hover:bg-paper-2 hover:text-ink"
    >
      {icon}
      {children}
    </button>
  );
}

/** 页面顶栏：标题 + 营业日（库存页为自然日）+ 演示数据标记 */
export function PageHeader({
  title,
  subtitle,
  actions,
  dateMode = 'business',
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  dateMode?: 'business' | 'calendar';
}) {
  const session = useSession();
  const d = describeDate(dateMode === 'business' ? session.today : session.calendarToday);
  const hours = session.rules.businessHours;
  const now = useMinuteClock(!!hours);
  const closed = !!hours && !isOpenAt(minuteOfDay(new Date(now), session.timezone), hours);
  return (
    <header className="flex min-h-[64px] shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-paper/90 px-5 py-3 backdrop-blur md:px-7">
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-[19px] font-bold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="truncate text-[12.5px] text-ink-3">{subtitle}</p>}
      </div>
      {actions}
      {session.hasSyntheticData && session.env !== 'production' && (
        <Badge tone="ember" className="hidden sm:inline-flex">
          合成演示数据
        </Badge>
      )}
      <div
        className="flex items-center gap-2 rounded-full border border-line bg-card py-1 pr-3.5 pl-1 shadow-card"
        title={`营业时间 ${describeBusinessHours(hours)}；营业日每天 ${String(session.rules.businessDayStartHour).padStart(2, '0')}:00 切换`}
      >
        <span className="rounded-full bg-pine px-2.5 py-1 text-[11.5px] font-bold text-paper">{dateMode === 'business' ? '营业日' : '今天'}</span>
        <span className="num text-[13.5px] font-bold text-ink">{d.md}</span>
        <span className="text-[12.5px] text-ink-3">{d.weekday}</span>
        {closed && (
          <span className="rounded-full bg-clay-soft px-2 py-0.5 text-[11.5px] font-bold text-clay" data-testid="outside-hours">
            非营业时间
          </span>
        )}
      </div>
    </header>
  );
}

/** 每分钟更新一次的当前时间（只在需要时启用） */
function useMinuteClock(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [enabled]);
  return now;
}
