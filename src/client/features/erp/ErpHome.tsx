// ERP 首页：能用的模块（店主关掉的、没有权限的不显示）；店主另外看到关着的模块与「模块设置」入口。

import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowRight, SlidersHorizontal } from 'lucide-react';
import { ERP_MODULE_KEYS, ERP_MODULES } from '@shared/erp';
import { useSession } from '../../lib/session';
import { Badge, Card } from '../../components/ui';
import { useErpAccess } from './access';
import { Stagger } from '../../lib/motion';

/** ERP 里的设置页、首页：标题与说明（模块页沿用各自的页头） */
export function ErpPage({ title, description, actions, children }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[1080px] px-4 py-5 md:px-7 md:py-6">
      <div className="mb-5 flex flex-wrap items-end gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <h1 className="text-[21px] font-bold tracking-tight text-ink">{title}</h1>
          {description && <p className="mt-0.5 text-[13px] text-ink-3">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </div>
  );
}

export function ErpHome() {
  const session = useSession();
  const access = useErpAccess();
  const off = access.canSettings ? ERP_MODULE_KEYS.filter((k) => !session.erpModules.includes(k)) : [];
  return (
    <ErpPage title="ERP 首页" description="财务、采购用的功能都在这里（含供应链：供应商、采购、库存、应付货款）；门店前台看不到。模块由店主在「模块设置」里开关。">
      {access.modules.length === 0 ? (
        <Card className="p-6 text-center text-[13.5px] text-ink-3" data-testid="erp-empty">
          现在没有能用的 ERP 模块。{access.canSettings ? '在「模块设置」里开启需要的模块。' : '请店主在 ERP「模块设置」里开启，或在「岗位权限」里给你相应的权限。'}
        </Card>
      ) : (
        <Stagger className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="erp-modules">
          {access.modules.map((k) => (
            <Link key={k} to={ERP_MODULES[k].path} className="group" data-testid={`erp-card-${k}`}>
              <Card className="mo-lift flex h-full flex-col gap-1.5 p-4 group-hover:border-pine">
                <span className="flex items-center gap-2">
                  <span className="text-[16px] font-bold">{ERP_MODULES[k].label}</span>
                  <Badge tone="neutral">{ERP_MODULES[k].group}</Badge>
                  <ArrowRight className="ml-auto size-4 text-ink-4 group-hover:text-pine" />
                </span>
                <span className="text-[12.5px] leading-relaxed text-ink-3">{ERP_MODULES[k].description}</span>
              </Card>
            </Link>
          ))}
        </Stagger>
      )}
      {off.length > 0 && (
        <p className="mt-4 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3" data-testid="erp-off">
          关着的模块：{off.map((k) => ERP_MODULES[k].label).join('、')}
          <Link to="/erp/modules" className="inline-flex items-center gap-1 font-semibold text-pine hover:underline">
            <SlidersHorizontal className="size-3.5" /> 模块设置
          </Link>
        </p>
      )}
    </ErpPage>
  );
}
