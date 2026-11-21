import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Building2, KeyRound, LogOut, MonitorSmartphone, Wifi } from 'lucide-react';
import { useTerminalState } from '../features/devices/terminal';
import { describeBusinessHours, isOpenAt, minuteOfDay } from '@shared/business-date';
import { describeDate, DUTY_LABELS, ROLE_LABELS } from '@shared/labels';
import { api } from '../lib/api';
import { useExitGhost, usePageEnter } from '../lib/motion';
import { useCan, useSession } from '../lib/session';
import { cn } from '../lib/utils';
import { InstanceTag } from './InstanceTag';
import { StoreSwitcher } from './StoreSwitcher';
import { ThemeMenuRow } from './ThemeSwitch';
import { storePageOf } from './storeNav';
import { StoreRail } from './StoreRail';
import { PendingOpsBanner } from './PendingOpsBanner';
import { useLocalPendingCount } from './LocalPendingNotice';
import { useConnection } from '../lib/connection';
import { FrontdeskPendingBanner } from '../features/frontdesk/PendingBanner';
import { useErpAccess } from '../features/erp/access';
import { TerminalBridgeRunner } from '../features/devices/terminal';
import { Badge } from './ui';

export function AppShell({ children }: { children: ReactNode }) {
  const can = useCan();
  const session = useSession();
  // ERP（库存、采购、货款、待办）在单独的工作区，主导航里没有（v0.7.3）；待办的数字在 ERP 导航上。
  // 主导航按业务域分组（8.1.15），在 StoreRail 里
  const { pathname } = useLocation();
  // 动效（8.0.16）：换页面时内容区淡入
  const content = usePageEnter<HTMLDivElement>(pathname);
  // 没有权限的门店页面（流水、日结、交班、前台……）回到首页：只用 ERP 的人回到 ERP，客户经理回到会员工作台。
  // 功能没开启（钟房、餐饮）不算没有权限，页面自己提示
  const page = storePageOf(pathname);
  if (page && !(Array.isArray(page.perm) ? page.perm : [page.perm]).some((p) => can(p))) return <Navigate to="/" replace />;
  return (
    // 8.2.0 P02（回测 2-1）：整屏不滚，左侧主导航固定、撑满一屏（菜单长了在导航里面滚）；右边内容区自己滚，
    // 页头（PageHeader）贴在内容区顶上。页面自己有滚动区的照旧在里面滚，不会出现两条滚动条
    <div className="flex h-dvh min-h-0 overflow-hidden bg-paper">
      {/* 设备（v0.7.21）：选了「这台终端」的设备常连本机的设备服务、替它上报（不在设备页也照常） */}
      <TerminalBridgeRunner />
      <StoreRail
        footer={
          <>
            {/* 能进不止一家店的人：当前门店、点一下换店（8.0.22）；只有一家店时不显示 */}
            <StoreSwitcher />
            <InstanceTag instance={session.instance} version={session.version} commit={session.commit} />
            <UserMenu />
          </>
        }
      />
      <div ref={content} className="scroll-thin flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto" data-testid="app-content">
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
  const link = useConnection();
  const pendingCount = useLocalPendingCount();
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
        className="tap relative flex size-11 items-center justify-center rounded-full bg-yuzu text-[15px] font-bold text-ink ring-2 ring-white/15 transition hover:ring-white/35 short:size-9 short:text-[14px]"
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
            <MenuItem
              icon={<Building2 className="size-4" />}
              onClick={() => {
                setOpen(false);
                navigate('/erp');
              }}
              testId="user-menu-erp"
            >
              进入 ERP
            </MenuItem>
          )}
          {can('device.view') && (
            // 本机终端（8.0.19，IA 第 3.4 节）：这台电脑是哪台终端在门店「设备」页右边设；从哪一页都点得到
            <MenuItem
              icon={<MonitorSmartphone className="size-4" />}
              onClick={() => {
                setOpen(false);
                navigate('/devices#terminal');
              }}
              testId="user-menu-terminal"
            >
              本机终端
              <span className="ml-auto max-w-[96px] truncate text-[12px] text-ink-3" data-testid="user-menu-terminal-current">
                {terminalCode ?? '未设置'}
              </span>
            </MenuItem>
          )}
          {/* 网络与同步（8.1.3 WL12）：连接、版本、这台电脑上的待确认、最近的问题 */}
          <MenuItem
            icon={<Wifi className="size-4" />}
            onClick={() => {
              setOpen(false);
              navigate('/network');
            }}
            testId="user-menu-network"
          >
            网络与同步
            <span className="ml-auto flex items-center gap-1.5 text-[12px] text-ink-3">
              {pendingCount > 0 && <span data-testid="user-menu-network-pending">{pendingCount} 笔待确认</span>}
              <span className={cn('size-2 rounded-full', link.state === 'offline' ? 'bg-clay' : link.updated ? 'bg-lake' : 'bg-pine')} />
            </span>
          </MenuItem>
          {/* 外观（8.1.15）：浅色 / 深色 / 跟随系统，记在这台设备上 */}
          <div className="my-1 h-px bg-line" />
          <ThemeMenuRow />
          <div className="my-1 h-px bg-line" />
          <MenuItem
            icon={<KeyRound className="size-4" />}
            onClick={() => {
              setOpen(false);
              navigate('/password');
            }}
          >
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
    <div
      ref={ref}
      role="menu"
      data-mo-out="menu"
      className="absolute bottom-0 left-[calc(100%+12px)] z-30 w-56 origin-bottom-left animate-menu-in rounded-lg border border-line bg-card p-1.5 text-ink shadow-pop"
    >
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
      className="tap relative flex h-10 w-full items-center gap-2.5 rounded-md px-3 text-left text-[14px] font-medium text-ink-2 hover:bg-paper-2 hover:text-ink"
    >
      {icon}
      {children}
    </button>
  );
}

/** 页面顶栏：标题 + 营业日（库存页为自然日）+ 演示数据标记 */
export function PageHeader({ title, subtitle, actions, dateMode = 'business' }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; dateMode?: 'business' | 'calendar' }) {
  const session = useSession();
  const d = describeDate(dateMode === 'business' ? session.today : session.calendarToday);
  const hours = session.rules.businessHours;
  const now = useMinuteClock(!!hours);
  const closed = !!hours && !isOpenAt(minuteOfDay(new Date(now), session.timezone), hours);
  return (
    <header className="sticky top-0 z-20 flex min-h-[64px] shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-paper/90 px-5 py-3 backdrop-blur md:px-7">
      {/* 标题至少留 10rem：窄屏（商米 V3）上右边的按钮放不下时换到下一行，不把标题挤成一个字（8.1.9） */}
      <div className="min-w-0 flex-1 basis-40">
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
        <span className="rounded-full bg-pine px-2.5 py-1 text-[12px] font-bold text-paper">{dateMode === 'business' ? '营业日' : '今天'}</span>
        <span className="num text-[13.5px] font-bold text-ink">{d.md}</span>
        <span className="text-[12.5px] text-ink-3">{d.weekday}</span>
        {closed && (
          <span className="rounded-full bg-clay-soft px-2 py-0.5 text-[12px] font-bold text-clay" data-testid="outside-hours">
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
