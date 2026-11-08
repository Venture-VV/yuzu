// 采购规则页（8.0.1 采购组整改 01，CG01：采购的配置从财务 / ERP「模块设置」挪到采购模块）。
// 有查看库存的都能看；改要「维护采购规则」（默认只有店主，可以在岗位权限里下放）。

import { Navigate } from 'react-router';
import { useCan } from '../../lib/session';
import { PageHeader } from '../../components/AppShell';
import { PurchaseRulesCard } from './PurchaseRulesCard';

export function PurchaseRulesPage() {
  const can = useCan();
  if (!can('inventory.read')) return <Navigate to="/purchasing" replace />;
  return (
    <>
      <PageHeader dateMode="calendar" title="采购规则" subtitle="截单、需求单转采购单、急采分级审批、询价门槛、补货与到货超期；采购途径固定三类" />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[980px] px-5 py-5 md:px-7">
          <PurchaseRulesCard />
        </div>
      </div>
    </>
  );
}
