// 用餐记录：按日期、餐次、工号或姓名查；撤销（写原因，只做标记）；导出表格。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { MEAL_LABELS, MEALS, type CanteenCheckinRow, type Meal } from '@shared/canteen';
import { api, errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { downloadUrl, formatDateTime } from '../../lib/utils';
import { ReasonDialog } from '../../components/ReasonDialog';
import { EmptyState } from '../../components/EmptyState';
import { Badge, Button, Card, Field, Input, Select, Skeleton } from '../../components/ui';
import { useToast } from '../../components/Toast';

export function RecordsTab() {
  const session = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  // 默认列最近两天（自然日）：过了零点还在开的那一餐（例如夜宵）记在前一天
  const [f, setF] = useState(() => {
    const d = new Date(`${session.calendarToday}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return { from: d.toISOString().slice(0, 10), to: session.calendarToday, meal: '' as Meal | '', q: '', voided: 'include' as 'include' | 'exclude' | 'only' };
  });
  const params = new URLSearchParams({ from: f.from, to: f.to, voided: f.voided, ...(f.meal ? { meal: f.meal } : {}), ...(f.q.trim() ? { q: f.q.trim() } : {}) }).toString();
  const list = useQuery({ queryKey: ['canteen', 'checkins', params], queryFn: () => api.get<CanteenCheckinRow[]>(`/api/erp/canteen/checkins?${params}`), enabled: f.from <= f.to });
  const [voiding, setVoiding] = useState<CanteenCheckinRow | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = list.data?.filter((r) => !r.voidedAt).length ?? 0;
  return (
    <div className="space-y-4" data-testid="canteen-records">
      <Card className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-[repeat(5,minmax(0,1fr))_auto] lg:items-end">
        <Field label="从">
          <Input type="date" value={f.from} max={f.to} onChange={(e) => setF({ ...f, from: e.target.value })} />
        </Field>
        <Field label="到">
          <Input type="date" value={f.to} min={f.from} onChange={(e) => setF({ ...f, to: e.target.value })} />
        </Field>
        <Field label="餐次">
          <Select value={f.meal} onChange={(e) => setF({ ...f, meal: e.target.value as Meal | '' })}>
            <option value="">全部</option>
            {MEALS.map((m) => (
              <option key={m} value={m}>
                {MEAL_LABELS[m]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="工号或姓名">
          <Input value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder="可以不填" />
        </Field>
        <Field label="撤销的">
          <Select value={f.voided} onChange={(e) => setF({ ...f, voided: e.target.value as typeof f.voided })}>
            <option value="include">一起列出</option>
            <option value="exclude">不列</option>
            <option value="only">只看撤销的</option>
          </Select>
        </Field>
        <Button variant="secondary" icon={<Download className="size-4" />} onClick={() => downloadUrl(`/api/erp/canteen/checkins.csv?${params}`)}>
          导出表格
        </Button>
      </Card>
      {list.isLoading ? (
        <Skeleton className="h-48" />
      ) : !list.data?.length ? (
        <Card>
          <EmptyState art="calm" title="这段时间没有用餐记录" />
        </Card>
      ) : (
        <Card className="overflow-x-auto p-0">
          <p className="border-b border-line px-4 py-2.5 text-[12.5px] text-ink-3">
            共 {list.data.length} 条，有效 {valid} 条
          </p>
          <table className="w-full min-w-[820px] text-[13px]">
            <thead className="border-b border-line text-left text-[12px] text-ink-3">
              <tr>
                <th className="px-4 py-2 font-semibold">日子 · 餐次</th>
                <th className="px-3 py-2 font-semibold">员工</th>
                <th className="px-3 py-2 font-semibold">部门</th>
                <th className="px-3 py-2 font-semibold">方式</th>
                <th className="px-3 py-2 font-semibold">扫到的时间</th>
                <th className="px-3 py-2 font-semibold">登记人</th>
                <th className="px-4 py-2 text-right font-semibold">状态</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {list.data.map((r) => (
                <tr key={r.id} className={r.voidedAt ? 'text-ink-3' : ''}>
                  <td className="px-4 py-2">
                    {r.date.slice(5)} {MEAL_LABELS[r.meal]}
                  </td>
                  <td className="px-3 py-2">
                    <span className="mr-1.5">{r.avatar}</span>
                    <span className={r.voidedAt ? 'line-through' : 'font-semibold'}>{r.name}</span> <span className="num text-[12px] text-ink-3">{r.empNo}</span>
                  </td>
                  <td className="px-3 py-2">{r.department || '—'}</td>
                  <td className="px-3 py-2">{r.method === 'scan' ? '扫码' : <Badge tone="yuzu">手动{r.note ? `：${r.note}` : ''}</Badge>}</td>
                  <td className="num px-3 py-2">{formatDateTime(r.scannedAt)}</td>
                  <td className="px-3 py-2">{r.recorderName}</td>
                  <td className="px-4 py-2 text-right">
                    {r.voidedAt ? (
                      <span className="text-[12px]" title={`${r.voidedByName ?? ''} ${formatDateTime(r.voidedAt)}`}>
                        已撤销：{r.voidReason}
                      </span>
                    ) : (
                      <Button size="sm" variant="ghost" onClick={() => setVoiding(r)}>
                        撤销
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <ReasonDialog
        open={!!voiding}
        title={`撤销 ${voiding?.name ?? ''} 的${voiding ? MEAL_LABELS[voiding.meal] : ''}登记`}
        description="只做标记、不删记录；撤销后这位员工这一餐可以重新登记。"
        confirmLabel="撤销"
        danger
        busy={busy}
        onClose={() => setVoiding(null)}
        onConfirm={async (reason) => {
          if (!voiding) return;
          setBusy(true);
          try {
            await api.post(`/api/erp/canteen/checkins/${voiding.id}/void`, { reason });
            setVoiding(null);
            void qc.invalidateQueries({ queryKey: ['canteen'] });
            toast({ tone: 'success', title: '撤销了' });
          } catch (e) {
            toast({ tone: 'error', title: '没撤销成', body: errorMessage(e) });
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}
