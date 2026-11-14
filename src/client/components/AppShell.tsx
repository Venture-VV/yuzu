import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Navigate, NavLink, useLocation, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Building2, KeyRound, LogOut, MonitorSmartphone } from 'lucide-react';
import { useTerminalState } from '../features/devices/terminal';
import { describeBusinessHours, isOpenAt, minuteOfDay } from '@shared/business-date';
import { describeDate, DUTY_LABELS, ROLE_LABELS } from '@shared/labels';
import { api } from '../lib/api';
import { useExitGhost, usePageEnter, useSlidingIndicator } from '../lib/motion';
import { useCan, useSession } from '../lib/session';
import { cn } from '../lib/utils';
import { LogoMark } from './Brand';
import { InstanceTag } from './InstanceTag';
import { storePageOf, useStoreNav } from './storeNav';
import { PendingOpsBanner } from './PendingOpsBanner';
import { FrontdeskPendingBanner } from '../features/frontdesk/PendingBanner';
import { useErpAccess } from '../features/erp/access';
import { TerminalBridgeRunner } from '../features/devices/terminal';
import { Badge } from './ui';

export function AppShell({ children }: { children: ReactNode }) {
  const can = useCan();
  const session = useSession();
  // ERP（库存、采购、货款、待办）在单独的工作区，主导航里没有（v0.7.3）；待办的数字在 ERP 导航上
  const nav = useStoreNav();
  const { pathname } = useLocation();
  // 动效（8.0.16）：换页面时内容区淡入；主导航里当前项的底块滑过去
  const content = usePageEnter<HTMLDivElement>(pathname);
  const pill = useSlidingIndicator<HTMLDivElement>('.nav-on', `${pathname}|${nav.flat().length}`, 220);
  // 没有权限的门店页面（流水、日结、交班、前台……）回到首页：只用 ERP 的人回到 ERP，客户经理回到会员工作台。
  // 功能没开启（钟房、餐饮）不算没有权限，页面自己提示
  const page = storePageOf(pathname);
  if (page && !(Array.isArray(page.perm) ? page.perm : [page.perm]).some((p) => can(p))) return <Navigate to="/" replace />;
  return (
    <div className="flex h-dvh min-h-0 bg-paper">
      {/* 设备（v0.7.21）：选了「这台终端」的设备常连本机的设备服务、替它上报（不在设备页也照常） */}
      <TerminalBridgeRunner />
      <nav
        aria-label="主导航"
        className="flex w-[76px] shrink-0 flex-col items-center gap-1 bg-[#1d3f31] pt-4 pb-4 text-paper short:gap-0.5 short:pt-2.5 short:pb-2.5 md:w-[84px]"
      >
        <NavLink to="/" aria-label="浴族 yuzu 首页" className="mb-5 rounded-[14px] ring-1 ring-white/10 short:mb-2">
          <LogoMark className="size-10 short:size-8" />
        </NavLink>
        <div ref={pill.ref} className="scroll-thin relative flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto short:gap-0.5">
          {pill.style && (
            <span key={pill.jump} aria-hidden className={cn('mo-indicator rounded-[14px] bg-white/12 short:rounded-[12px]', pill.jump > 0 && 'mo-indicator-jump')} data-settled={pill.settled} style={pill.style}>
              <span className="absolute top-1/2 -left-[10px] h-6 w-1 -translate-y-1/2 rounded-r-full bg-yuzu" />
            </span>
          )}
          {nav.map((group, gi) => (
            <div key={group[0]!.to} className="flex flex-col items-center gap-1 short:gap-0.5">
              {gi > 0 && <span className="my-1.5 h-px w-8 bg-white/12 short:my-1" aria-hidden />}
              {group.map(({ to, label, icon: Icon, end }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={end}
                  aria-label={label}
                  className={({ isActive }) =>
                    cn(
                      'group relative flex w-[64px] flex-col items-center gap-0.5 rounded-[14px] py-2 text-[12px] font-semibold transition-colors short:gap-0 short:rounded-[12px] short:py-[3px] short:text-[11px] short:leading-[15px] tiny:py-[2px] tiny:leading-[14px]',
                      // 当前项的底块与左边的黄条：量得到位置时由上面那一块滑过来画，量不到时自己画
                      isActive ? cn('nav-on text-paper', !pill.style && 'bg-white/12') : 'text-paper/60 hover:bg-white/6 hover:text-paper',
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      {isActive && !pill.style && <span className="absolute top-1/2 -left-[10px] h-6 w-1 -translate-y-1/2 rounded-r-full bg-yuzu" />}
                      <Icon className="size-[21px] short:size-[18px] tiny:size-4" strokeWidth={isActive ? 2.2 : 1.8} />
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
      <div ref={content} className="flex min-w-0 flex-1 flex-col">
        <PendingOpsBanner />
        {can('frontdesk.operate') && <FrontdeskPendingBanner />}
        {children}
      </div>
    </div>
  );
}

function UserMenu() {
  const session = useSession();
  const can = useCan();
  const erp = useErpAccess();
  // 这台电脑现在设成了哪台终端（记在本机浏览器里；没设 = 不上报）
  const terminalCode = useTerminalState().terminal;
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
        data-testid="user-menu"
        className="flex size-11 items-center justify-center rounded-full bg-yuzu text-[15px] font-bold text-ink ring-2 ring-white/15 transition hover:ring-white/35 short:size-9 short:text-[14px]"
        title={`${session.staff.displayName} · ${roleText(session.staff)}`}
      >
        {session.staff.displayName.slice(0, 1)}
      </button>
      {open && (
        <MenuPanel>
          <div className="px-3 pt-2 pb-2.5">
            <p className="text-[14px] font-bold">{session.staff.displayName}</p>
            <p className="text-[12px] text-ink-3">
              {roleText(session.staff)} · {session.staff.username}
            </p>
          </div>
          <div className="my-1 h-px bg-line" />
          {erp.canEnter && (
            // ERP 不在主导航里显示（店主 2026-10-30 定）：有 ERP 权限的人从这里进
            <MenuItem icon={<Building2 className="size-4" />} onClick={() => { setOpen(false); navigate('/erp'); }} testId="user-menu-erp">
              进入 ERP
            </MenuItem>
          )}
          {can('device.view') && (
            // 本机终端（8.0.19，IA 第 3.4 节）：这台电脑是哪台终端在门店「设备」页右边设；从哪一页都点得到
            <MenuItem icon={<MonitorSmartphone className="size-4" />} onClick={() => { setOpen(false); navigate('/devices#terminal'); }} testId="user-menu-terminal">
              本机终端<span className="ml-auto max-w-[96px] truncate text-[12px] text-ink-3" data-testid="user-menu-terminal-current">{terminalCode ?? '未设置'}</span>
            </MenuItem>
          )}
          <MenuItem icon={<KeyRound className="size-4" />} onClick={() => { setOpen(false); navigate('/password'); }}>
            修改密码
          </MenuItem>
          <MenuItem icon={<LogOut className="size-4" />} onClick={logout}>
            退出登录
          </MenuItem>
        </MenuPanel>
      )}
    </div>
  );
}

/** 用户菜单的面板：从头像的位置放大出来；关掉时留一个影子缩回去（8.0.16） */
function MenuPanel({ children }: { children: ReactNode }) {
  const ref = useExitGhost<HTMLDivElement>();
  return (
    <div ref={ref} role="menu" data-mo-out="menu" className="absolute bottom-0 left-[calc(100%+12px)] z-30 w-56 origin-bottom-left animate-menu-in rounded-lg border border-line bg-card p-1.5 text-ink shadow-pop">
      {children}
    </div>
  );
}

function roleText(staff: { role: keyof typeof ROLE_LABELS; duties: (keyof typeof DUTY_LABELS)[] }) {
  return [ROLE_LABELS[staff.role], ...staff.duties.map((d) => DUTY_LABELS[d].title)].join(' · ');
}

function MenuItem({ icon, children, onClick, testId }: { icon: ReactNode; children: ReactNode; onClick: () => void; testId?: string }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      data-testid={testId}
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
