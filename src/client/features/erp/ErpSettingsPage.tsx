// ERP 设置（8.0.18，docs/IA_V8017.md 第 3.3 节）：ERP 自己的规则收在这一页。
// 每个页签里还是原来那张卡片（原来的接口、权限、保存按钮都没变），只是不用再记「这条规则在哪个模块的哪个角落」。
// 页签写进地址（/erp/settings/purchase），换页签不卸掉别的页签里填到一半的东西（components/SubNav）。

import { Link, Navigate } from 'react-router';
import { ArrowRight } from 'lucide-react';
import { useCan, useSession } from '../../lib/session';
import { SubPane, SubTabPage } from '../../components/SubNav';
import { Card } from '../../components/ui';
import { InventoryRules } from '../admin/RulesTab';
import { TunablesCard } from '../admin/TunablesCard';
import { DelegationsPanel } from '../approvals/DelegationsPanel';
import { RulesPanel } from '../approvals/RulesPanel';
import { ExpenseRulesCard } from '../expenses/ExpenseRulesCard';
import { PaymentRulesCard } from '../payments/PaymentRulesCard';
import { PurchaseRulesCard } from '../purchasing/PurchaseRulesCard';
import { AutoReplenishCard } from '../purchasing/AutoReplenishCard';
import { UsageRulesCard } from '../inventory/UsageTab';
import { ErpModulesPanel } from './ErpModulesPage';
import { erpSettingsTabs } from './settingsTabs';
import { ERP_SETTINGS_PATH } from '@shared/erp';

export function ErpSettingsPage() {
  const can = useCan();
  const session = useSession();
  const tabs = erpSettingsTabs(can, session.erpModules);
  if (tabs.length === 0) return <Navigate to="/erp" replace />;
  const has = (key: string) => tabs.some((t) => t.key === key);
  const header = (
    <div className="mb-3">
      <h1 className="text-[21px] font-bold tracking-tight text-ink">ERP 设置</h1>
      <p className="mt-0.5 text-[13px] text-ink-3">ERP 的模块开关与各模块的规则都在这里；每个页签各自保存，只影响之后的单据。门店的规则（收款、交班、会员、价目……）在管理后台。</p>
    </div>
  );
  return (
    <div className="mx-auto w-full max-w-[1080px] px-4 py-5 md:px-7 md:py-6" data-testid="erp-settings">
      <SubTabPage tabs={tabs} base={ERP_SETTINGS_PATH} label="ERP 设置的页签" header={header}>
        {has('modules') && (
          <SubPane tab="modules" lazy>
            <ErpModulesPanel />
          </SubPane>
        )}
        {has('purchase') && (
          <SubPane tab="purchase" lazy className="space-y-5">
            <PurchaseRulesCard />
            {/* 8.0.20：自动补货的开关与时间（「采购 → 补货建议」顶上是同一张卡片，两处都能改） */}
            <AutoReplenishCard />
          </SubPane>
        )}
        {has('inventory') && (
          <SubPane tab="inventory" lazy className="space-y-5">
            <InventoryRules />
            {/* 8.0.20：按用料扣库存的开关（「库存 → 用料与扣料」顶上是同一张卡片） */}
            <UsageRulesCard />
          </SubPane>
        )}
        {has('approvals') && (
          <SubPane tab="approvals" lazy className="space-y-5">
            <RulesPanel />
            <DelegationsPanel />
          </SubPane>
        )}
        {has('payments') && (
          <SubPane tab="payments" lazy>
            <PaymentRulesCard />
          </SubPane>
        )}
        {has('expenses') && (
          <SubPane tab="expenses" lazy className="space-y-4">
            <ExpenseRulesCard />
            <div className="grid gap-3 sm:grid-cols-2">
              <JumpCard to="/erp/petty/accounts" title="部门备用金定额" text="每个部门的定额、余额与建议补足；在部门那一行点「设定额」" testId="erp-settings-petty" />
              <JumpCard to="/erp/expenses/budgets" title="费用预算额度" text="按部门、科目、月份设预算；占用与预警在报销时核对" testId="erp-settings-budgets" />
            </div>
          </SubPane>
        )}
        {has('tunables') && (
          <SubPane tab="tunables" lazy>
            <TunablesCard scope="erp" />
          </SubPane>
        )}
      </SubTabPage>
    </div>
  );
}

function JumpCard({ to, title, text, testId }: { to: string; title: string; text: string; testId: string }) {
  return (
    <Link to={to} className="group" data-testid={testId}>
      <Card className="mo-lift flex items-center gap-3 p-4 group-hover:border-pine/40">
        <div className="min-w-0 flex-1">
          <p className="text-[14.5px] font-bold text-ink">{title}</p>
          <p className="mt-0.5 text-[12.5px] text-ink-3">{text}</p>
        </div>
        <ArrowRight className="size-4 shrink-0 text-ink-3 group-hover:text-pine" />
      </Card>
    </Link>
  );
}

/** 旧地址 /erp/modules：能改模块开关的到「ERP 设置 → 模块开关」，别人照旧回 ERP 首页 */
export function ErpModulesMoved() {
  const can = useCan();
  return <Navigate to={can('settings.manage') ? `${ERP_SETTINGS_PATH}/modules` : '/erp'} replace />;
}
