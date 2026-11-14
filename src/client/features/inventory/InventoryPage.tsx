import { NavLink, Navigate, useParams } from 'react-router';
import { Archive, BarChart3, Boxes, Calculator, FileStack, Gift, Hourglass, PackageMinus } from 'lucide-react';
import { useCan } from '../../lib/session';
import { cn } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { AgingTab } from './AgingTab';
import { CostTab } from './CostTab';
import { DocsTab } from './DocsTab';
import { GiftsTab } from './GiftsTab';
import { MasterTab } from './MasterTab';
import { useInvSettings } from './queries';
import { StockTab } from './StockTab';
import { SummaryTab } from './SummaryTab';
import { UsageTab } from './UsageTab';

const TABS = [
  { key: 'stock', label: '库存', icon: Boxes },
  { key: 'docs', label: '单据', icon: FileStack },
  { key: 'summary', label: '收发汇总', icon: BarChart3 },
  // 呆滞与周转、临期批次（8.0.7）
  { key: 'aging', label: '呆滞与临期', icon: Hourglass },
  // 赠品台账（8.0.1 采购组整改 09）：只记台账，不进库存
  { key: 'gifts', label: '赠品台账', icon: Gift },
  // 用料与扣料、成本（8.0.20，docs/ERP_V8020.md）
  { key: 'usage', label: '用料与扣料', icon: PackageMinus },
  { key: 'cost', label: '成本', icon: Calculator },
  { key: 'master', label: '档案', icon: Archive },
] as const;
type TabKey = (typeof TABS)[number]['key'];

export function InventoryPage() {
  const can = useCan();
  const settings = useInvSettings();
  const { tab = 'stock' } = useParams<{ tab?: TabKey }>();
  // 成本只给有「看成本」权限的人；别的页签要「查看库存」。有「看成本」没有「查看库存」的（店总默认如此）只有「成本」一个页签
  const read = can('inventory.read');
  const tabs = TABS.filter((t) => (t.key === 'cost' ? can('inventory.cost') : read));
  if (tabs.length === 0) return <Navigate to="/" replace />;
  if (!tabs.some((t) => t.key === tab)) return <Navigate to={tabs[0]!.key === 'stock' ? '/inventory' : `/inventory/${tabs[0]!.key}`} replace />;
  return (
    <>
      <PageHeader
        dateMode="calendar"
        title="库存"
        subtitle={`${settings.data?.scopeName ?? '后勤总库'} · 数量按各自库存单位记录，每一笔变化都可追溯`}
      />
      <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-5 md:px-7">
        {tabs.map(({ key, label, icon: Icon }) => (
          <NavLink
            key={key}
            to={key === 'stock' ? '/inventory' : `/inventory/${key}`}
            className={cn(
              'relative flex h-11 items-center gap-2 px-3.5 text-[14px] font-semibold whitespace-nowrap transition-colors',
              tab === key ? 'text-ink' : 'text-ink-3 hover:text-ink',
            )}
          >
            <Icon className="size-4" />
            {label}
            {tab === key && <span className="absolute inset-x-2 bottom-0 h-[3px] rounded-t-full bg-pine" />}
          </NavLink>
        ))}
      </div>
      {tab === 'stock' && <StockTab />}
      {tab === 'docs' && <DocsTab />}
      {tab === 'summary' && <SummaryTab />}
      {tab === 'aging' && <AgingTab />}
      {tab === 'gifts' && <GiftsTab />}
      {tab === 'usage' && <UsageTab />}
      {tab === 'cost' && <CostTab />}
      {tab === 'master' && <MasterTab />}
    </>
  );
}
