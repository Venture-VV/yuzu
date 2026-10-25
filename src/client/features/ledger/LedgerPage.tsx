import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Download, Search } from 'lucide-react';
import { ENTRY_TYPE_LABELS, maskPhone, PAYMENT_METHOD_LABELS } from '@shared/labels';
import type { LedgerRow } from '@shared/types';
import { errorMessage } from '../../lib/api';
import { useLedger } from '../../lib/queries';
import { useCan, useSession } from '../../lib/session';
import { cn, downloadUrl, formatTime } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { DateNav } from '../../components/DateNav';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { Badge, Button, Notice, Segmented, Select, Skeleton } from '../../components/ui';
import { ReversalDialog } from '../flows/ReversalDialog';
import { ActivityRow, ENTRY_META } from '../workbench/ActivityList';
import { DocDrawer } from './DocDrawer';

type TypeFilter = 'all' | 'recharge' | 'consume' | 'reversal';

export function LedgerPage() {
  const session = useSession();
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const date = params.get('date') ?? session.today;
  const type = (params.get('type') as TypeFilter) ?? 'all';
  const [q, setQ] = useState(params.get('q') ?? '');
  const [operator, setOperator] = useState('');
  const [open, setOpen] = useState<LedgerRow | null>(null);
  const [reverseId, setReverseId] = useState<number | null>(null);
  const historyAllowed = can('ledger.readHistory');

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };

  // 搜索词停顿 250ms 后再同步到地址栏并查询
  const urlQ = params.get('q') ?? '';
  useEffect(() => {
    if (q.trim() === urlQ) return;
    const t = setTimeout(() => {
      const next = new URLSearchParams(window.location.search);
      if (q.trim()) next.set('q', q.trim());
      else next.delete('q');
      setParams(next, { replace: true });
    }, 250);
    return () => clearTimeout(t);
  }, [q, urlQ, setParams]);

  const ledger = useLedger({
    date: historyAllowed ? date : session.today,
    type: type === 'all' ? undefined : type,
    q: params.get('q') ?? undefined,
  });
  const rows = useMemo(() => (ledger.data ?? []).filter((r) => !operator || r.operatorName === operator), [ledger.data, operator]);
  const operators = useMemo(() => [...new Set((ledger.data ?? []).map((r) => r.operatorName))], [ledger.data]);

  const totals = useMemo(() => {
    const t = { paid: 0, consume: 0, restore: 0, recharges: 0, consumes: 0, reversals: 0 };
    for (const r of rows) {
      if (r.entryType === 'recharge') {
        t.paid += r.paidAmount ?? 0;
        t.recharges++;
      } else if (r.entryType === 'consume') {
        t.consume -= r.principalDelta + r.bonusDelta;
        t.consumes++;
      } else {
        t.restore += r.principalDelta + r.bonusDelta;
        t.reversals++;
      }
    }
    return t;
  }, [rows]);

  return (
    <>
      <PageHeader
        title="流水"
        subtitle="每一笔余额变化都在这里，按营业日核对"
        actions={
          can('ledger.export') && (
            <Button size="sm" variant="secondary" icon={<Download className="size-4" />} onClick={() => downloadUrl(`/api/ledger/export?date=${date}`)}>
              导出 CSV
            </Button>
          )
        }
      />
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-5 py-3 md:px-7">
        <DateNav value={historyAllowed ? date : session.today} today={session.today} locked={!historyAllowed} onChange={(d) => update({ date: d === session.today ? null : d })} />
        <Segmented<TypeFilter>
          size="sm"
          value={type}
          onChange={(v) => update({ type: v === 'all' ? null : v })}
          ariaLabel="类型"
          options={[
            { value: 'all', label: '全部' },
            { value: 'recharge', label: '充值' },
            { value: 'consume', label: '消费' },
            { value: 'reversal', label: '撤销' },
          ]}
        />
        <Select fullWidth={false} value={operator} onChange={(e) => setOperator(e.target.value)} className="h-9 min-w-[128px] text-[13px]" aria-label="操作人">
          <option value="">全部操作人</option>
          {operators.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
        <div className="relative min-w-[200px] flex-1 md:max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="会员 / 手机号 / 单号"
            aria-label="搜索流水"
            className="h-9 w-full rounded-md border border-line-strong bg-card pr-3 pl-9 text-[13px] outline-none focus:border-pine"
          />
        </div>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-5 md:px-7">
        {/* 汇总条：收款、消费、撤销分别展示 */}
        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="充值实收" tone="lake" cents={totals.paid} sub={`${totals.recharges} 笔`} />
          <StatTile label="储值消费" tone="ink" cents={totals.consume} sub={`${totals.consumes} 笔（含已撤销）`} />
          <StatTile label="撤销恢复" tone="clay" cents={totals.restore} sub={`${totals.reversals} 笔`} />
          <StatTile label="记录条数" tone="neutral" count={rows.length} sub={operator ? `仅 ${operator}` : '全部操作人'} />
        </div>

        {ledger.error ? (
          <Notice tone="error" title={errorMessage(ledger.error)} />
        ) : ledger.isPending ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState art="calm" title="这个营业日没有符合条件的流水" description="换个日期或筛选条件试试。" className="rounded-lg border border-dashed border-line-strong" />
        ) : (
          <>
            {/* 桌面：表格 */}
            <div className="hidden overflow-hidden rounded-lg border border-line bg-card shadow-card xl:block">
              <table className="w-full table-fixed text-left text-[13px]">
                <thead className="bg-paper-2/70 text-[12px] font-bold text-ink-3">
                  <tr>
                    <th className="w-[64px] px-4 py-2.5">时间</th>
                    <th className="w-[150px] px-2 py-2.5">单号</th>
                    <th className="w-[70px] px-2 py-2.5">类型</th>
                    <th className="w-[150px] px-2 py-2.5">会员</th>
                    <th className="px-2 py-2.5">内容</th>
                    <th className="w-[110px] px-2 py-2.5 text-right">实收</th>
                    <th className="w-[110px] px-2 py-2.5 text-right">本金变动</th>
                    <th className="w-[100px] px-2 py-2.5 text-right">赠金变动</th>
                    <th className="w-[88px] px-4 py-2.5">经办</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/70">
                  {rows.map((r) => {
                    const meta = ENTRY_META[r.entryType];
                    const reversed = r.consumptionStatus === 'reversed';
                    const crossDay = r.entryType === 'reversal' && r.relatedBusinessDate !== r.businessDate;
                    return (
                      <tr key={r.id} onClick={() => setOpen(r)} className="cursor-pointer transition-colors hover:bg-pine-tint/60">
                        <td className="num px-4 py-3 text-ink-2">{formatTime(r.createdAt)}</td>
                        <td className="num truncate px-2 py-3 font-semibold">{r.docNo}</td>
                        <td className="px-2 py-3">
                          <span className={cn('inline-flex h-6 items-center rounded-full px-2 text-[12px] font-bold', meta.tone)}>
                            {ENTRY_TYPE_LABELS[r.entryType]}
                          </span>
                        </td>
                        <td className="px-2 py-3">
                          <p className="truncate font-semibold">{r.memberName}</p>
                          <p className="num text-[11.5px] text-ink-3">{maskPhone(r.memberPhone)}</p>
                        </td>
                        <td className="px-2 py-3">
                          <div className="flex items-center gap-1.5">
                            <span className={cn('truncate', reversed && 'text-ink-3')}>
                              {r.entryType === 'reversal' ? `原单 ${r.relatedDocNo} · ${r.summary}` : r.summary}
                            </span>
                            {reversed && <Badge tone="clay">已撤销</Badge>}
                            {crossDay && <Badge tone="ember">跨日</Badge>}
                          </div>
                          {r.entryType === 'recharge' && r.paymentMethod && (
                            <p className="text-[11.5px] text-ink-3">{PAYMENT_METHOD_LABELS[r.paymentMethod]}</p>
                          )}
                        </td>
                        <td className="px-2 py-3 text-right">
                          {r.paidAmount != null ? <Money cents={r.paidAmount} className="font-bold text-lake" /> : <span className="text-ink-4">—</span>}
                        </td>
                        <td className="px-2 py-3 text-right">
                          <Money cents={r.principalDelta} signed className={cn('font-bold', reversed ? 'struck text-ink-4' : r.principalDelta < 0 ? 'text-ink' : 'text-pine')} />
                        </td>
                        <td className="px-2 py-3 text-right">
                          {r.bonusDelta === 0 ? (
                            <span className="text-ink-4">—</span>
                          ) : (
                            <Money cents={r.bonusDelta} signed className={cn('font-semibold', reversed ? 'struck text-ink-4' : 'text-yuzu-deep')} />
                          )}
                        </td>
                        <td className="truncate px-4 py-3 text-ink-2">{r.operatorName}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {/* 平板：卡片列表 */}
            <div className="divide-y divide-line/70 rounded-lg border border-line bg-card p-1.5 shadow-card xl:hidden">
              {rows.map((r) => (
                <ActivityRow key={r.id} row={r} showMember onOpen={setOpen} />
              ))}
            </div>
          </>
        )}
      </div>

      <DocDrawer
        row={open}
        onClose={() => setOpen(null)}
        onReverse={(id) => {
          setOpen(null);
          setReverseId(id);
        }}
      />
      <ReversalDialog consumptionId={reverseId} onClose={() => setReverseId(null)} />
    </>
  );
}

function StatTile({
  label,
  cents,
  count,
  sub,
  tone,
}: {
  label: string;
  cents?: number;
  count?: number;
  sub: string;
  tone: 'lake' | 'ink' | 'clay' | 'neutral';
}) {
  const color = { lake: 'text-lake', ink: 'text-ink', clay: 'text-clay', neutral: 'text-ink' }[tone];
  const bar = { lake: 'bg-lake', ink: 'bg-yuzu', clay: 'bg-clay', neutral: 'bg-line-strong' }[tone];
  return (
    <div className="relative overflow-hidden rounded-lg border border-line bg-card px-4 py-3 shadow-card">
      <span className={cn('absolute top-0 left-0 h-full w-1', bar)} />
      <p className="text-[12px] font-semibold text-ink-3">{label}</p>
      {cents !== undefined ? (
        <Money cents={cents} className={cn('mt-0.5 text-[22px] leading-tight font-bold', color)} />
      ) : (
        <p className="num mt-0.5 text-[22px] leading-tight font-bold">{count}</p>
      )}
      <p className="text-[12px] text-ink-3">{sub}</p>
    </div>
  );
}
