// ERP 模块设置（店主）：开关 ERP 的模块。关掉的模块导航不显示、页面打不开、接口拒绝；
// 依赖的模块关着时，这个模块也用不了（开关保留，依赖的模块开了就恢复）。改动记审计。

import { useState } from 'react';
import { Navigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ERP_MODULES, type ErpModuleKey, type ErpModulesInfo } from '@shared/erp';
import { api, errorMessage } from '../../lib/api';
import { qk } from '../../lib/queries';
import { useCan } from '../../lib/session';
import { cn, formatDateTime } from '../../lib/utils';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Notice, PendingBadge, Segmented, Skeleton } from '../../components/ui';
import { ExpenseRulesCard } from '../expenses/ExpenseRulesCard';
import { PurchaseRulesCard } from '../purchasing/PurchaseRulesCard';
import { ErpPage } from './ErpHome';

const erpModulesKey = ['erp', 'modules'] as const;

export function ErpModulesPage() {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const info = useQuery({ queryKey: erpModulesKey, queryFn: () => api.get<ErpModulesInfo>('/api/erp/modules') });
  const [draft, setDraft] = useState<Partial<Record<ErpModuleKey, boolean>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!can('settings.manage')) return <Navigate to="/erp" replace />;
  const d = info.data;
  const on = (k: ErpModuleKey) => draft[k] ?? d?.modules.find((m) => m.key === k)?.switchedOn ?? false;
  const dirty = !!d && d.modules.some((m) => draft[m.key] !== undefined && draft[m.key] !== m.switchedOn);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.put<ErpModulesInfo>('/api/erp/modules', { modules: draft });
      qc.setQueryData(erpModulesKey, next);
      setDraft({});
      // 导航与页面按会话里的模块显示
      await qc.invalidateQueries({ queryKey: qk.session });
      toast({ tone: 'success', title: 'ERP 模块设置已保存' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ErpPage
      title="模块设置"
      description="开关 ERP 的模块：关掉的模块导航里不显示、页面打不开、接口也拒绝；数据都保留，重新开启就恢复。"
      actions={
        <Button variant="primary" disabled={!dirty} loading={busy} onClick={() => void save()} data-testid="erp-modules-save">
          保存
        </Button>
      }
    >
      {!d ? (
        info.error ? <Notice tone="error" title={errorMessage(info.error)} /> : <Skeleton className="h-64" />
      ) : (
        <div className="space-y-3">
          <Notice tone="info" title={d.updatedBy ? `${d.updatedBy} 于 ${formatDateTime(d.updatedAt!)} 改过` : '现在全部按默认开启'}>
            库存、采购原来就在用，默认都开启。以后同事提的新模块（数据字典、自定义字段、审批规则、成本……）也在这里开关。
            <PendingBadge className="ml-2" title="ERP 第一步的默认做法待店主确认" />
          </Notice>
          <Card className="divide-y divide-line/70" data-testid="erp-module-switches">
            {d.modules.map((m) => {
              const missing = m.requires.filter((r) => !on(r));
              return (
                <div key={m.key} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3" data-testid={`erp-switch-${m.key}`}>
                  <div className="min-w-0 flex-1 basis-64">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="text-[15px] font-bold">{m.label}</span>
                      <Badge tone="neutral">{m.group}</Badge>
                      {m.requires.length > 0 && <span className="text-[12px] text-ink-4">依赖：{m.requires.map((r) => ERP_MODULES[r].label).join('、')}</span>}
                    </p>
                    <p className="mt-0.5 text-[12.5px] text-ink-3">{m.description}</p>
                    {on(m.key) && missing.length > 0 && (
                      <p className="mt-1 text-[12.5px] font-semibold text-clay">「{missing.map((r) => ERP_MODULES[r].label).join('」「')}」关着，这个模块暂时用不了</p>
                    )}
                  </div>
                  <Segmented
                    ariaLabel={`${m.label}模块`}
                    value={on(m.key) ? 'on' : 'off'}
                    onChange={(v) => setDraft((x) => ({ ...x, [m.key]: v === 'on' }))}
                    options={[
                      { value: 'on', label: '开启' },
                      { value: 'off', label: '关闭' },
                    ]}
                  />
                  <span className={cn('w-14 text-right text-[12px] font-semibold', m.enabled ? 'text-pine' : 'text-ink-4')}>{m.enabled ? '在用' : '未启用'}</span>
                </div>
              );
            })}
          </Card>
          {error && <Notice tone="error" title={error} />}
          {d.modules.find((m) => m.key === 'inventory')?.enabled && <PurchaseRulesCard />}
          {d.modules.find((m) => m.key === 'expenses')?.enabled && <ExpenseRulesCard />}
        </div>
      )}
    </ErpPage>
  );
}
