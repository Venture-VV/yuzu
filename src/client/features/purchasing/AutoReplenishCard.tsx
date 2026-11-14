// 自动补货（8.0.20，docs/ERP_V8020.md 第 3 节）：「采购 → 补货建议」顶上的一条。
// 每天过了设定的时间，系统把下面的建议里有供应商的行按供应商各建一张采购单草稿（不提交）；这里看今天建了几张、改开关与时间、现在跑一次。

import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, RefreshCw } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Input } from '../../components/ui';
import { useInvalidateAll } from './queries';

interface AutoRun {
  date: string;
  status: 'running' | 'done' | 'failed';
  poIds: number[];
  poNos: string[];
  lineCount: number;
  skippedNoSupplier: number;
  error: string | null;
}
interface AutoInfo {
  rules: { enabled: boolean; time: string };
  runs: AutoRun[];
}

export function AutoReplenishCard() {
  const can = useCan();
  const session = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const invalidateAll = useInvalidateAll();
  const info = useQuery({ queryKey: ['purchasing', 'auto-replenish'], queryFn: () => api.get<AutoInfo>('/api/purchase-suggestions/auto') });
  const [busy, setBusy] = useState(false);
  const [time, setTime] = useState<string | null>(null);
  if (!info.data) return null;
  const { rules, runs } = info.data;
  const today = runs.find((r) => r.date === session.calendarToday) ?? null;
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['purchasing', 'auto-replenish'] });
    await invalidateAll();
  };
  const save = async (patch: Record<string, unknown>) => {
    try {
      await api.put('/api/purchase-suggestions/auto/rules', patch);
      setTime(null);
      await refresh();
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    }
  };
  const run = async () => {
    setBusy(true);
    try {
      const r = await api.post<AutoRun | null>('/api/purchase-suggestions/auto/run');
      toast({
        tone: r?.error ? 'error' : 'success',
        title: r?.error ? `没跑完：${r.error}` : `今天一共建了 ${r?.poIds.length ?? 0} 张草稿`,
        body: r?.skippedNoSupplier ? `${r.skippedNoSupplier} 样没有供应商，要先在下面选供应商` : undefined,
      });
      await refresh();
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="flex flex-wrap items-center gap-x-3 gap-y-2 p-4 text-[13.5px]" data-testid="auto-replenish">
      <Bot className="size-4 shrink-0 text-ink-3" />
      <span className="font-bold">自动补货</span>
      <Badge tone={rules.enabled ? 'moss' : 'neutral'}>{rules.enabled ? `每天 ${rules.time} 以后` : '关着'}</Badge>
      <span className="min-w-0 text-ink-2" data-testid="auto-replenish-today">
        {today ? (
          today.poIds.length > 0 ? (
            <>
              今天建了 {today.poIds.length} 张采购单草稿（{today.lineCount} 样物料），确认数量后提交、不要的撤掉（撤掉的第二天还会再建；不想再提的物料在建议行点「不用备货」）：
              {today.poIds.map((id, i) => (
                <Link key={id} to={`/purchasing/${id}/edit`} className="num ml-1.5 font-semibold text-pine underline-offset-2 hover:underline">
                  {today.poNos[i] ?? `#${id}`}
                </Link>
              ))}
            </>
          ) : (
            '今天没有自动建草稿（演示数据写进来的当天不自动跑；要看效果点「现在跑一次」）'
          )
        ) : rules.enabled ? (
          '今天还没到时间'
        ) : (
          '打开后，系统每天把下面有供应商的建议各建一张采购单草稿，等人确认后提交'
        )}
        {today?.skippedNoSupplier ? <span className="text-clay"> · {today.skippedNoSupplier} 样没有供应商</span> : null}
        {today?.error ? <span className="text-clay"> · 出错：{today.error}</span> : null}
      </span>
      <span className="ml-auto flex flex-wrap items-center gap-2">
        {can('purchase.rules') && (
          <>
            <Input type="time" fullWidth={false} className="h-9 w-28" value={time ?? rules.time} onChange={(e) => setTime(e.target.value)} aria-label="每天几点以后跑" data-testid="auto-replenish-time" />
            {time !== null && time !== rules.time && (
              <Button size="sm" variant="secondary" onClick={() => void save({ time })} data-testid="auto-replenish-time-save">
                保存时间
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={() => void save({ enabled: !rules.enabled })} data-testid="auto-replenish-toggle">
              {rules.enabled ? '关掉' : '打开'}
            </Button>
          </>
        )}
        {can('purchase.manage') && (
          <Button size="sm" variant="secondary" icon={<RefreshCw className="size-4" />} disabled={busy} onClick={() => void run()} data-testid="auto-replenish-run">
            现在跑一次
          </Button>
        )}
      </span>
    </Card>
  );
}
