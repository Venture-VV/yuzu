import { NavLink, Navigate, useParams } from 'react-router';
import { ClipboardList, Gift, Scale, UsersRound } from 'lucide-react';
import { useCan } from '../../lib/session';
import { cn } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { AuditTab } from './AuditTab';
import { CatalogTab } from './CatalogTab';
import { RulesTab } from './RulesTab';
import { StaffTab } from './StaffTab';

const TABS = [
  { key: 'staff', label: '员工', icon: UsersRound },
  { key: 'catalog', label: '套餐与项目', icon: Gift },
  { key: 'rules', label: '经营规则', icon: Scale },
  { key: 'audit', label: '操作审计', icon: ClipboardList },
] as const;

export function AdminPage() {
  const can = useCan();
  const { tab = 'staff' } = useParams();
  if (!can('staff.manage')) return <Navigate to="/" replace />;
  return (
    <>
      <PageHeader title="管理" subtitle="员工、套餐项目与经营规则（仅店主）" />
      <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-5 md:px-7">
        {TABS.map(({ key, label, icon: Icon }) => (
          <NavLink
            key={key}
            to={`/admin/${key}`}
            className={cn(
              'relative flex h-12 items-center gap-2 px-3.5 text-[14px] font-semibold whitespace-nowrap transition-colors',
              tab === key ? 'text-ink' : 'text-ink-3 hover:text-ink',
            )}
          >
            <Icon className="size-4" />
            {label}
            {tab === key && <span className="absolute inset-x-2 bottom-0 h-[3px] rounded-t-full bg-pine" />}
          </NavLink>
        ))}
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1080px] px-5 py-6 md:px-7">
          {tab === 'staff' && <StaffTab />}
          {tab === 'catalog' && <CatalogTab />}
          {tab === 'rules' && <RulesTab />}
          {tab === 'audit' && <AuditTab />}
        </div>
      </div>
    </>
  );
}
