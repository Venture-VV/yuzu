// 零采备用金的设置（8.1.9，docs/ERP_V819.md 第 2.1 节，BJ2）：ERP 设置 →「报销与备用金」里的一张卡片，只有店主能改。
// 总额：空着 = 还没配置（面板写「还没配置总额」、不能申用）；归属部门：财务登记这类报销时默认记到这个部门。

import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Wallet } from 'lucide-react';
import { centsToInput, formatYuan, parseYuan } from '@shared/money';
import type { PoolSettings } from '@shared/petty-pool';
import { api, errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { LoadFailed } from '../../components/LoadFailed';
import { useToast } from '../../components/Toast';
import { Button, Card, Field, MoneyInput, Notice, Select, Skeleton } from '../../components/ui';
import { useDepartments } from '../inventory/queries';

const key = ['erp', 'pool', 'settings'] as const;

export function PoolSettingsCard() {
  const can = useCan();
  const session = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: key, queryFn: () => api.get<PoolSettings>('/api/erp/pool/settings') });
  const departments = useDepartments(false);
  const [total, setTotal] = useState('');
  const [departmentId, setDepartmentId] = useState<number | ''>('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!settings.data) return;
    setTotal(settings.data.totalCents === null ? '' : centsToInput(settings.data.totalCents));
    setDepartmentId(settings.data.departmentId ?? '');
  }, [settings.data]);
  // 零采备用金模块关着时不显示
  if (!session.erpModules.includes('pettyPool')) return null;
  const editable = can('settings.manage');

  const save = async () => {
    setError(null);
    const cents = total.trim() === '' ? null : parseYuan(total);
    if (total.trim() !== '' && (cents === null || cents < 0)) return setError('总额写元，最多两位小数；空着表示还没配置');
    setSaving(true);
    try {
      const saved = await api.put<PoolSettings>('/api/erp/pool/settings', { totalCents: cents, departmentId: departmentId === '' ? null : departmentId });
      qc.setQueryData(key, saved);
      await qc.invalidateQueries({ queryKey: ['erp', 'pool'] });
      toast({ tone: 'success', title: '零采备用金的设置已保存', body: saved.totalCents === null ? '总额空着：还不能申用' : `总额 ${formatYuan(saved.totalCents)}` });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-5" data-testid="pool-settings">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Wallet className="size-4 text-ink-3" />
        <h3 className="text-[15px] font-bold">零采备用金（供应链）</h3>
        {can('pool.read') && (
          <Link to="/erp/pool" className="ml-auto flex items-center gap-1 text-[12.5px] font-semibold text-pine hover:underline">
            去面板 <ArrowRight className="size-3.5" />
          </Link>
        )}
      </div>
      <p className="mb-3 text-[12.5px] text-ink-3">申用登记即占用额度，报销单确认后自动回补；剩余可用 = 总额 − 已占用。改了总额立即生效，已有的申用不动。</p>
      {settings.isPending ? (
        <Skeleton className="h-24" />
      ) : settings.isError && !settings.data ? (
        <LoadFailed title="零采备用金的设置没取回来" onRetry={() => void settings.refetch()} retrying={settings.isFetching} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="备用金总额" htmlFor="pool-total" hint="空着 = 还没配置，不能申用">
            <MoneyInput id="pool-total" value={total} disabled={!editable} onChange={(e) => setTotal(e.target.value)} placeholder="例如 5000" data-testid="pool-total-input" />
          </Field>
          <Field label="归属部门" htmlFor="pool-dept" hint="财务登记这类报销时默认记到这个部门（预算按部门算）">
            <Select id="pool-dept" value={departmentId} disabled={!editable} onChange={(e) => setDepartmentId(e.target.value ? Number(e.target.value) : '')} data-testid="pool-dept-select">
              <option value="">不指定（登记报销时选）</option>
              {departments.data?.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
      {error && <Notice tone="error" title={error} className="mt-3" />}
      {editable && settings.data && (
        <div className="mt-3 flex justify-end">
          <Button variant="primary" loading={saving} onClick={() => void save()} data-testid="pool-settings-save">
            保存
          </Button>
        </div>
      )}
    </Card>
  );
}
