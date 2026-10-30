// 餐饮（S5 第一步）：点单（挂到客人的手牌账单上）、厨房出品屏、估清。
// 功能关闭时（默认）主导航没有「餐饮」；直接打开地址时提示店主到后台开启。
// 店员默认三页都有；后勤（厨房）只有厨房出品与估清；只有点单权限的服务员在出品屏上只能「上菜」。

import { Navigate, NavLink, useParams } from 'react-router';
import type { Permission } from '@shared/permissions';
import { useCan, useSession } from '../../lib/session';
import { cn } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { Notice } from '../../components/ui';
import { KitchenTab, LimitsTab } from './KitchenTab';
import { OrderTab } from './OrderTab';

const TABS = [
  { key: 'order', label: '点单', perms: ['dining.order'], subtitle: '输入手牌号找到客人，点的菜挂在客人的账上（结账时一起结），同时送到厨房' },
  { key: 'kitchen', label: '厨房出品', perms: ['dining.kitchen', 'dining.order'], subtitle: '待做 → 制作中 → 已出餐 → 上菜，5 秒刷新；点错了可以撤回一步' },
  { key: 'limits', label: '估清', perms: ['dining.kitchen'], subtitle: '今天某道菜还剩几份；估清（卖完）后点单页不能再点，退菜按原份数加回' },
] as const satisfies readonly { key: string; label: string; perms: readonly Permission[]; subtitle: string }[];

export function DiningPage() {
  const session = useSession();
  const can = useCan();
  const { tab } = useParams();
  const tabs = TABS.filter((t) => t.perms.some((p) => can(p)));
  const current = tabs.find((t) => t.key === tab) ?? (tab ? undefined : tabs[0]);
  if (!current) return <Navigate to={tabs.length ? '/dining' : '/'} replace />;

  if (!session.dining) {
    return (
      <>
        <PageHeader title="餐饮" />
        <div className="p-8">
          <Notice tone="info" title="餐饮功能没有开启">
            店主在「后台 → 餐饮」建好出品档口、把菜挂到档口上并开启餐饮功能后，这里点单、看厨房出品与估清。
          </Notice>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader title="餐饮" subtitle={current.subtitle} />
      {tabs.length > 1 && (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-5 md:px-7" role="tablist" aria-label="餐饮">
          {tabs.map((t) => (
            <NavLink
              key={t.key}
              to={`/dining/${t.key}`}
              role="tab"
              aria-selected={t.key === current.key}
              className={cn('relative flex h-11 items-center px-3.5 text-[14px] font-semibold whitespace-nowrap', t.key === current.key ? 'text-ink' : 'text-ink-3 hover:text-ink')}
              data-testid={`dining-tab-${t.key}`}
            >
              {t.label}
              {t.key === current.key && <span className="absolute inset-x-2 bottom-0 h-[3px] rounded-t-full bg-pine" />}
            </NavLink>
          ))}
        </div>
      )}
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {/* 点单页一直留着（只是隐藏）：去厨房屏、估清看一眼再回来，客人与已点的菜还在 */}
        {tabs.some((t) => t.key === 'order') && (
          <div hidden={current.key !== 'order'}>
            <OrderTab />
          </div>
        )}
        {current.key === 'kitchen' ? <KitchenTab /> : current.key === 'limits' ? <LimitsTab /> : null}
      </div>
    </>
  );
}
