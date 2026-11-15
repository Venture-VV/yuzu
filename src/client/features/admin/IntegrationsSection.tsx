// 后台「对外接口」（8.0.21，docs/INTEGRATIONS_V8021.md 第 1 节）：
//   · 每一样现在是哪种模式（没配置 / 模拟 / 已配置、等联调）——只由运行环境决定，页面上改不了；正式接口要的环境变量只显示配没配；
//   · 门店开关：启用扫码收款、启用平台验券、平台验券每天自动对账的时间（默认都开、06:10）；
//   · 最近的对外调用（打码后的摘要），可以只看失败的、按业务对象查。

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { INTEGRATION_MODE_LABELS, type IntegrationMode, type IntegrationSwitches } from '@shared/integrations';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/utils';
import { useToast } from '../../components/Toast';
import { LoadFailed } from '../../components/LoadFailed';
import { Badge, Button, Card, Field, Input, Select, Skeleton } from '../../components/ui';
import { AdminPage } from './AdminShell';

interface KindInfo {
  kind: string;
  label: string;
  mode: IntegrationMode;
  note: string | null;
  live: { key: string; label: string; vars: string[]; configured: boolean }[];
}
interface Call {
  id: number;
  kind: string;
  provider: string;
  action: string;
  mode: 'mock' | 'live';
  refType: string | null;
  refId: number | null;
  request: Record<string, unknown>;
  ok: boolean;
  result: Record<string, unknown>;
  error: string | null;
  durationMs: number;
  staffName: string | null;
  createdAt: string;
}

const MODE_TONE: Record<IntegrationMode, 'neutral' | 'yuzu' | 'pine'> = { off: 'neutral', mock: 'yuzu', live: 'pine' };

export function IntegrationsSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const info = useQuery({ queryKey: ['admin', 'integrations'], queryFn: () => api.get<{ kinds: KindInfo[]; switches: IntegrationSwitches; defaults: IntegrationSwitches }>('/api/admin/integrations') });
  const [kind, setKind] = useState('');
  const [failed, setFailed] = useState(false);
  const calls = useQuery({
    queryKey: ['admin', 'integrations', 'calls', kind, failed],
    queryFn: () => api.get<Call[]>(`/api/admin/integrations/calls?${new URLSearchParams({ ...(kind ? { kind } : {}), ...(failed ? { failed: '1' } : {}) })}`),
  });
  const [sw, setSw] = useState<IntegrationSwitches | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (info.data) setSw(info.data.switches);
  }, [info.data]);
  const save = async () => {
    if (!sw) return;
    setBusy(true);
    try {
      await api.put('/api/admin/integrations/switches', sw);
      await qc.invalidateQueries({ queryKey: ['admin', 'integrations'] });
      await qc.invalidateQueries({ queryKey: ['pay'] });
      await qc.invalidateQueries({ queryKey: ['voucher'] });
      toast({ tone: 'success', title: '门店开关已保存' });
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <AdminPage section="integrations" description="扫码收款、平台验券、开票服务商、银企直连、OTA 渠道：现在是哪种模式（只看运行环境的配置）、门店开关、最近的对外调用。密钥只放运行环境，这里只显示配没配。">
      <div className="space-y-5" data-testid="integrations">
        <Card className="p-5">
          <h2 className="mb-3 text-[15px] font-bold">模式</h2>
          {!info.data ? (
            info.isError ? (
              <LoadFailed title="对外接口的模式取不回来，请检查网络" onRetry={() => void info.refetch()} retrying={info.isFetching} testId="integration-kinds-error" />
            ) : (
              <Skeleton className="h-32" />
            )
          ) : (
            <ul className="divide-y divide-line/70 text-[13px]" data-testid="integration-kinds">
              {info.data.kinds.map((k) => (
                <li key={k.kind} className="space-y-1 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{k.label}</span>
                    <Badge tone={MODE_TONE[k.mode]}>{INTEGRATION_MODE_LABELS[k.mode]}</Badge>
                  </div>
                  {k.note && <p className="text-[12.5px] text-ink-3">{k.note}</p>}
                  {k.live.map((l) => (
                    <p key={l.key} className="text-[12.5px] text-ink-3">
                      {l.label}：{l.configured ? '环境变量已配' : `没配（${l.vars.join('、')}）`}
                    </p>
                  ))}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[12.5px] text-ink-3">
            8.0.21 只有接口与模拟实现：正式的等店主拿到商户号、平台应用后联调（「已配置，等联调」时照旧手选、手输）。模拟只在开发、测试实例里能开（INTEGRATIONS_MOCK=true）。
          </p>
        </Card>

        <Card className="p-5">
          <h2 className="mb-3 text-[15px] font-bold">门店开关</h2>
          {!sw ? (
            <Skeleton className="h-20" />
          ) : (
            <div className="space-y-3 text-[13.5px]">
              <label className="flex items-center gap-2">
                <input type="checkbox" className="size-4 accent-[var(--color-pine)]" checked={sw.payTerminal} onChange={(e) => setSw({ ...sw, payTerminal: e.target.checked })} data-testid="sw-pay-terminal" />
                结账、充值显示「扫码收款」
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" className="size-4 accent-[var(--color-pine)]" checked={sw.platformVoucher} onChange={(e) => setSw({ ...sw, platformVoucher: e.target.checked })} data-testid="sw-platform-voucher" />
                结账登记团购券时「验券」，每天自动对账
              </label>
              <Field label="平台验券每天自动对账的时间（对前一个营业日）" htmlFor="sw-recon">
                <Input id="sw-recon" type="time" fullWidth={false} value={sw.voucherReconcileAt} onChange={(e) => setSw({ ...sw, voucherReconcileAt: e.target.value })} className="h-9 w-32" />
              </Field>
              <Button variant="primary" loading={busy} onClick={() => void save()} data-testid="sw-save">
                保存
              </Button>
            </div>
          )}
        </Card>

        <Card className="p-5">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="text-[15px] font-bold">最近的对外调用</h2>
            <span className="flex-1" />
            <Select value={kind} fullWidth={false} className="h-9 w-48" onChange={(e) => setKind(e.target.value)} aria-label="哪一样">
              <option value="">全部</option>
              {(info.data?.kinds ?? []).map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </Select>
            <label className="flex items-center gap-1 text-[13px]">
              <input type="checkbox" className="size-4 accent-[var(--color-pine)]" checked={failed} onChange={(e) => setFailed(e.target.checked)} />
              只看失败的
            </label>
          </div>
          {!calls.data ? (
            calls.isError ? (
              <LoadFailed title="对外调用记录取不回来，请检查网络" onRetry={() => void calls.refetch()} retrying={calls.isFetching} testId="integration-calls-error" />
            ) : (
              <Skeleton className="h-32" />
            )
          ) : calls.data.length === 0 ? (
            <p className="text-[13px] text-ink-3">还没有对外调用。</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]" data-testid="integration-calls">
                <thead className="text-left text-ink-3">
                  <tr>
                    <th className="px-2 py-1">时间</th>
                    <th className="px-2 py-1">接口</th>
                    <th className="px-2 py-1">动作</th>
                    <th className="px-2 py-1">对象</th>
                    <th className="px-2 py-1">结果</th>
                    <th className="px-2 py-1 text-right">耗时</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/70">
                  {calls.data.map((c) => (
                    <tr key={c.id}>
                      <td className="px-2 py-1 whitespace-nowrap">{formatDateTime(c.createdAt)}</td>
                      <td className="px-2 py-1">
                        {c.provider}
                        {c.mode === 'mock' && <span className="ml-1 text-ink-3">（模拟）</span>}
                      </td>
                      <td className="px-2 py-1">{c.action}</td>
                      <td className="px-2 py-1 text-ink-3">{c.refType ? `${c.refType} #${c.refId}` : '—'}</td>
                      <td className="max-w-[360px] truncate px-2 py-1" title={JSON.stringify(c.ok ? c.result : c.error)}>
                        {c.ok ? <span className="text-pine">成功</span> : <span className="text-clay">失败：{c.error}</span>} <span className="text-ink-3">{JSON.stringify(c.ok ? c.result : c.request)}</span>
                      </td>
                      <td className="num px-2 py-1 text-right">{c.durationMs} ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </AdminPage>
  );
}
