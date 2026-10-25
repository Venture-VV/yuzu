import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarCheck2, KeyRound, LogOut, ReceiptText, Settings2, UsersRound } from 'lucide-react';
import { describeDate, ROLE_LABELS } from '@shared/labels';
import { api } from '../lib/api';
import { useCan, useSession } from '../lib/session';
import { cn } from '../lib/utils';
import { LogoMark } from './Brand';
import { PendingOpsBanner } from './PendingOpsBanner';
import { Badge } from './ui';

const NAV = [
  { to: '/', label: '会员', icon: UsersRound, end: true, perm: 'member.read' },
  { to: '/ledger', label: '流水', icon: ReceiptText, perm: 'ledger.readToday' },
  { to: '/settlement', label: '日结', icon: CalendarCheck2, perm: 'ledger.readToday' },
  { to: '/admin', label: '管理', icon: Settings2, perm: 'staff.manage' },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const can = useCan();
  return (
    <div className="flex h-dvh min-h-0 bg-paper">
      <nav
        aria-label="主导航"
        className="flex w-[76px] shrink-0 flex-col items-center gap-1 bg-[#1d3f31] pt-4 pb-4 text-paper md:w-[84px]"
      >
        <NavLink to="/" aria-label="浴族 yuzu 首页" className="mb-5 rounded-[14px] ring-1 ring-white/10">
          <LogoMark className="size-10" />
        </NavLink>
        {NAV.filter((n) => can(n.perm)).map(({ to, label, icon: Icon, ...n }) => (
          <NavLink
            key={to}
            to={to}
            end={'end' in n}
            className={({ isActive }) =>
              cn(
                'group relative flex w-[64px] flex-col items-center gap-1 rounded-[14px] py-2.5 text-[12px] font-semibold transition-colors',
                isActive ? 'bg-white/12 text-paper' : 'text-paper/60 hover:bg-white/6 hover:text-paper',
              )
            }
          >
            {({ isActive }) => (
              <>
                {isActive && <span className="absolute top-1/2 -left-[10px] h-6 w-1 -translate-y-1/2 rounded-r-full bg-yuzu" />}
                <Icon className="size-[21px]" strokeWidth={isActive ? 2.2 : 1.8} />
                <span>{label}</span>
              </>
            )}
          </NavLink>
        ))}
        <div className="flex-1" />
        <UserMenu />
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <PendingOpsBanner />
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
        className="flex size-11 items-center justify-center rounded-full bg-yuzu text-[15px] font-bold text-ink ring-2 ring-white/15 transition hover:ring-white/35"
        title={`${session.staff.displayName} · ${ROLE_LABELS[session.staff.role]}`}
      >
        {session.staff.displayName.slice(0, 1)}
      </button>
      {open && (
        <div role="menu" className="absolute bottom-0 left-[calc(100%+12px)] z-30 w-56 animate-rise rounded-lg border border-line bg-card p-1.5 text-ink shadow-pop">
          <div className="px-3 pt-2 pb-2.5">
            <p className="text-[14px] font-bold">{session.staff.displayName}</p>
            <p className="text-[12px] text-ink-3">
              {ROLE_LABELS[session.staff.role]} · {session.staff.username}
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

/** 页面顶栏：标题 + 营业日 + 演示数据标记 */
export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  const session = useSession();
  const d = describeDate(session.today);
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
      <div className="flex items-center gap-2 rounded-full border border-line bg-card py-1 pr-3.5 pl-1 shadow-card">
        <span className="rounded-full bg-pine px-2.5 py-1 text-[11.5px] font-bold text-paper">营业日</span>
        <span className="num text-[13.5px] font-bold text-ink">{d.md}</span>
        <span className="text-[12.5px] text-ink-3">{d.weekday}</span>
      </div>
    </header>
  );
}
