// 流水页的「订单查询」页签（8.0.15，docs/ORDERS_V8015.md 第 2 节）：按单号、手牌号、手机号、称呼查结账单与退款单，
// 点开看逐行明细，导出当前结果的逐行明细。只读。

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Download, Search, X } from 'lucide-react';
import { CHECKOUT_METHOD_LABELS, type CheckoutMethod } from '@shared/checkout';
import { ORDER_QUERY_MAX, ORDER_SEARCH_LIMIT, type OrderRow, type OrderSearchResult } from '@shared/orders';
import { api, errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn, downloadUrl, formatDateTime, formatTime } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { DateNav } from '../../components/DateNav';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { Button, Notice, Skeleton } from '../../components/ui';
import { LedgerTabs } from './LedgerTabs';
import { OrderDrawer, StatusBadge, type OrderTarget } from './OrderDrawer';

const methodsText = (row: OrderRow) => row.methods.map((m) => CHECKOUT_METHOD_LABELS[m as CheckoutMethod] ?? m).join('、') || '—';
const holderText = (row: OrderRow) => [...row.tagCodes, ...row.tableNames.map((t) => `桌 ${t}`)].join('、') || '—';

export function OrdersPanel() {
  const session = useSession();
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const historyAllowed = can('ledger.readHistory');
  const date = historyAllowed ? (params.get('date') ?? session.today) : session.today;
  const urlQ = params.get('oq') ?? '';
  const [q, setQ] = useState(urlQ);
  const [open, setOpen] = useState<OrderTarget | null>(null);

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };

  // 搜索词停顿 250ms 后再同步到地址栏并查询（与余额流水一样）
  useEffect(() => {
    if (q.trim() === urlQ) return;
    const t = setTimeout(() => {
      const next = new URLSearchParams(window.location.search);
      if (q.trim()) next.set('oq', q.trim());
      else next.delete('oq');
      setParams(next, { replace: true });
    }, 250);
    return () => clearTimeout(t);
  }, [q, urlQ, setParams]);

  const search = new URLSearchParams(urlQ ? { q: urlQ } : { date }).toString();
  const orders = useQuery({
    queryKey: ['ledger', 'orders', urlQ, urlQ ? '' : date],
    queryFn: () => api.get<OrderSearchResult>(`/api/ledger/orders?${search}`),
    placeholderData: keepPreviousData,
  });
  const data = orders.data;
  const rows = data?.rows ?? [];

  const totals = useMemo(() => {
    const t = { checkouts: 0, amount: 0, voided: 0, refunds: 0, refunded: 0 };
    for (const r of rows) {
      if (r.kind === 'checkout') {
        if (r.status === 'voided') t.voided++;
        else {
          t.checkouts++;
          t.amount += r.amount;
        }
      } else if (r.status === 'completed') {
        t.refunds++;
        t.refunded += r.amount;
      }
    }
    return t;
  }, [rows]);

  return (
    <>
      <PageHeader
        title="流水"
        subtitle="按单号、手牌号、手机号、称呼查账单，点开看每一行消费"
        actions={
          can('ledger.export') && (
            <Button
              size="sm"
              variant="secondary"
              icon={<Download className="size-4" />}
              disabled={rows.length === 0}
              onClick={() => downloadUrl(`/api/ledger/orders/export?${search}`)}
              data-testid="orders-export"
            >
              导出明细 CSV
            </Button>
          )
        }
      />
      <LedgerTabs value="orders" />
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-5 py-3 md:px-7">
        <div className="relative min-w-[260px] flex-1 md:max-w-md">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            maxLength={ORDER_QUERY_MAX}
            placeholder="结账单号 / 手牌号 / 手机号后 4 位或全号 / 称呼"
            aria-label="搜索订单"
            className="h-10 w-full rounded-md border border-line-strong bg-card pr-9 pl-9 text-[13.5px] outline-none focus:border-pine"
            data-testid="orders-search"
          />
          {q && (
            <button type="button" aria-label="清空搜索" onClick={() => setQ('')} className="absolute top-1/2 right-2 flex size-6 -translate-y-1/2 items-center justify-center rounded-full text-ink-3 hover:bg-paper-2">
              <X className="size-4" />
            </button>
          )}
        </div>
        {!urlQ && <DateNav value={date} today={session.today} locked={!historyAllowed} onChange={(d) => update({ date: d === session.today ? null : d })} />}
        <p className="text-[12.5px] text-ink-3" data-testid="orders-scope">
          {urlQ
            ? historyAllowed
              ? '在全部营业日里查，按时间从近到远'
              : '当前岗位只查得到本营业日的单'
            : '没输搜索词时列这个营业日的全部账单'}
        </p>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-5 md:px-7">
        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Tile label="结账单" cents={totals.amount} sub={`${totals.checkouts} 张（不含已反结账）`} bar="bg-lake" color="text-lake" />
          <Tile label="退款单" cents={totals.refunded} sub={`${totals.refunds} 张（不含已作废）`} bar="bg-ember" color="text-ember" />
          <Tile label="已反结账" count={totals.voided} sub="张" bar="bg-clay" color="text-clay" />
          <Tile label="列出" count={rows.length} sub={urlQ ? `符合「${urlQ}」的单` : `营业日 ${date}`} bar="bg-line-strong" color="text-ink" />
        </div>

        {data?.truncated && (
          <Notice tone="warning" className="mb-4" title={`符合的不止这些，只列了最近的 ${ORDER_SEARCH_LIMIT} 张`}>
            把搜索词输得完整一点（整张手牌号、整个单号）能缩小范围。导出的也是这 {ORDER_SEARCH_LIMIT} 张。
          </Notice>
        )}

        {orders.error ? (
          <Notice tone="error" title={errorMessage(orders.error)} />
        ) : orders.isPending ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            art={urlQ ? 'search' : 'calm'}
            title={urlQ ? `没有查到「${urlQ}」的账单` : '这个营业日还没有结账单'}
            description={
              urlQ
                ? historyAllowed
                  ? '可以输结账单号、手牌号（如 A8067 或 8067）、会员手机号后 4 位或 11 位全号、会员姓名或客人称呼。'
                  : '当前岗位只查得到本营业日的单；之前的单请值班经理来查。'
                : '换个营业日，或者直接输单号、手牌号、手机号来查。'
            }
            className="rounded-lg border border-dashed border-line-strong"
          />
        ) : (
          <>
            {/* 桌面：表格 */}
            <div className="hidden overflow-hidden rounded-lg border border-line bg-card shadow-card xl:block">
              <table className="w-full table-fixed text-left text-[13px]" data-testid="orders-table">
                <thead className="bg-paper-2/70 text-[12px] font-bold text-ink-3">
                  <tr>
                    <th className="w-[164px] px-4 py-2.5">单号</th>
                    <th className="w-[128px] px-2 py-2.5">时间</th>
                    <th className="w-[104px] px-2 py-2.5">营业日</th>
                    <th className="w-[120px] px-2 py-2.5">手牌 / 桌号</th>
                    <th className="px-2 py-2.5">会员 / 称呼</th>
                    <th className="w-[110px] px-2 py-2.5 text-right">金额</th>
                    <th className="w-[150px] px-2 py-2.5">收款方式</th>
                    <th className="w-[128px] px-2 py-2.5">状态</th>
                    <th className="w-[88px] px-4 py-2.5">经办</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/70">
                  {rows.map((r) => {
                    const off = r.status === 'voided';
                    return (
                      <tr
                        key={`${r.kind}-${r.id}`}
                        onClick={() => setOpen({ kind: r.kind, id: r.id })}
                        className="cursor-pointer transition-colors hover:bg-pine-tint/60"
                        data-testid={`order-row-${r.docNo}`}
                      >
                        <td className="num truncate px-4 py-3 font-semibold">{r.docNo}</td>
                        <td className="num px-2 py-3 text-ink-2">{formatDateTime(r.createdAt)}</td>
                        <td className="num px-2 py-3 text-ink-2">{r.businessDate}</td>
                        <td className="num truncate px-2 py-3 font-semibold">{holderText(r)}</td>
                        <td className="truncate px-2 py-3">{r.guests.join('、') || <span className="text-ink-4">散客</span>}</td>
                        <td className="px-2 py-3 text-right">
                          <Money cents={r.kind === 'refund' ? -r.amount : r.amount} className={cn('font-bold', off ? 'struck text-ink-4' : r.kind === 'refund' ? 'text-ember' : 'text-ink')} />
                          {r.kind === 'checkout' && r.refundedAmount > 0 && (
                            <p className="text-[11.5px] text-ink-3">
                              已退 <Money cents={r.refundedAmount} />
                            </p>
                          )}
                        </td>
                        <td className="truncate px-2 py-3 text-ink-2">{methodsText(r)}</td>
                        <td className="px-2 py-3">
                          <StatusBadge row={r} />
                        </td>
                        <td className="truncate px-4 py-3 text-ink-2">{r.operatorName}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {/* 平板：卡片列表 */}
            <div className="divide-y divide-line/70 rounded-lg border border-line bg-card p-1.5 shadow-card xl:hidden" data-testid="orders-cards">
              {rows.map((r) => (
                <button
                  key={`${r.kind}-${r.id}`}
                  type="button"
                  onClick={() => setOpen({ kind: r.kind, id: r.id })}
                  className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-pine-tint/60"
                  data-testid={`order-card-${r.docNo}`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="num text-[13.5px] font-bold">{r.docNo}</span>
                      <StatusBadge row={r} />
                    </p>
                    <p className="truncate text-[12.5px] text-ink-3">
                      <span className="num">{r.businessDate === session.today ? formatTime(r.createdAt) : formatDateTime(r.createdAt)}</span> · {holderText(r)}
                      {r.guests.length > 0 && ` · ${r.guests.join('、')}`} · {methodsText(r)} · {r.operatorName}
                    </p>
                  </div>
                  <Money cents={r.kind === 'refund' ? -r.amount : r.amount} className={cn('text-[15px] font-bold', r.status === 'voided' ? 'struck text-ink-4' : r.kind === 'refund' ? 'text-ember' : 'text-ink')} />
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <OrderDrawer target={open} onClose={() => setOpen(null)} onOpen={setOpen} />
    </>
  );
}

function Tile({ label, cents, count, sub, bar, color }: { label: string; cents?: number; count?: number; sub: string; bar: string; color: string }) {
  return (
    <div className="relative overflow-hidden rounded-lg border border-line bg-card px-4 py-3 shadow-card">
      <span className={cn('absolute top-0 left-0 h-full w-1', bar)} />
      <p className="text-[12px] font-semibold text-ink-3">{label}</p>
      {cents !== undefined ? <Money cents={cents} className={cn('mt-0.5 text-[22px] leading-tight font-bold', color)} /> : <p className={cn('num mt-0.5 text-[22px] leading-tight font-bold', color)}>{count}</p>}
      <p className="truncate text-[12px] text-ink-3">{sub}</p>
    </div>
  );
}
