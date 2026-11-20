// 8.1.7 点菜单（小票可视化，docs/DINING_V817.md 第 6 节，PENDING_DECISIONS.md CF8、CF9）：
// 一桌（或一位手牌客人）点过的菜，像一张点餐小票：抬头门店名、桌号与分区、人数、开台时间；上菜进度；
// 按每次下单分段，每道菜标已上 / 未上 / 制作中 / 已出餐 / 已退；底下合计（只算有效的）。开着时 10 秒刷新一次，可以只看未上的。
// 8.1.15（块 B3）：每次下单写整单备注、送到哪间房。

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Clock3, Flame, RotateCcw, Soup } from 'lucide-react';
import { RECEIPT_STATE_LABELS, slotLabel, type DiningReceipt, type DiningReceiptLine, type ReceiptLineState } from '@shared/dining';
import { partsText } from '@shared/dishes';
import { formatYuan } from '@shared/money';
import { api, errorMessage } from '../../lib/api';
import { useLivePoll } from '../../lib/livePoll';
import { useSession } from '../../lib/session';
import { cn, formatDateTime, formatTime } from '../../lib/utils';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { Skeleton } from '../../components/ui';

/** 看谁的点菜单：一桌（开台 id）或一位手牌客人（来访 id） */
export type ReceiptTarget = { session: number } | { visit: number };

export const receiptKey = (t: ReceiptTarget | null) => ['dining', 'receipt', t ? ('session' in t ? `s${t.session}` : `v${t.visit}`) : null] as const;

/** 点菜单开着时多久刷新一次（出品状态跟得上） */
const RECEIPT_REFRESH_MS = 10_000;

/**
 * 点菜单：数据放在 React Query 里（加载、出错、重试照旧）；开着时的定时刷新走共用的 useLivePoll（AGENTS.md「定时取数」，8.1.3）——
 * 页面在后台、连不上服务器时不取，回到页面、网络恢复时马上取。关着（没有对象）时不起定时器。
 * 刷新不打断正在路上的那一次（cancelRefetch: false），与打开时的第一次取数不会重复
 */
export function useDiningReceipt(t: ReceiptTarget | null) {
  const key = receiptKey(t);
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.get<DiningReceipt>(`/api/dining/receipt?${t && 'session' in t ? `session=${t.session}` : `visit=${t && 'visit' in t ? t.visit : 0}`}`),
    enabled: t !== null,
  });
  useLivePoll(
    async (isLive) => {
      if (t && isLive()) await q.refetch({ cancelRefetch: false });
    },
    [key[2]],
    { intervalMs: t ? RECEIPT_REFRESH_MS : undefined },
  );
  return q;
}

const STAMP: Record<ReceiptLineState, { cls: string; icon: React.ReactNode }> = {
  served: { cls: 'border-pine/50 text-pine bg-pine-tint', icon: <Check className="size-3.5" strokeWidth={3} /> },
  waiting: { cls: 'border-clay/45 text-clay bg-clay/8', icon: <Clock3 className="size-3.5" /> },
  cooking: { cls: 'border-yuzu-deep/45 text-yuzu-deep bg-yuzu-tint', icon: <Flame className="size-3.5" /> },
  done: { cls: 'border-lake/45 text-lake bg-lake-soft', icon: <Soup className="size-3.5" /> },
  voided: { cls: 'border-line-strong text-ink-4 bg-paper-2', icon: <RotateCcw className="size-3.5" /> },
};

export function ReceiptDialog({ target, onClose }: { target: ReceiptTarget | null; onClose: () => void }) {
  const q = useDiningReceipt(target);
  const [onlyWaiting, setOnlyWaiting] = useState(false);
  return (
    <Dialog open={target !== null} onClose={onClose} title="点菜单" description="这桌（这位客人）点过的菜，每道菜写着上了没有；开着时 10 秒刷新一次" width="max-w-[460px]">
      {q.isPending ? (
        <Skeleton className="h-96" />
      ) : q.isError && !q.data ? (
        <LoadFailed title="点菜单加载失败" onRetry={() => void q.refetch()} retrying={q.isFetching} testId="dining-receipt-error">
          {errorMessage(q.error)}
        </LoadFailed>
      ) : q.data ? (
        <ReceiptPaper r={q.data} onlyWaiting={onlyWaiting} onToggle={() => setOnlyWaiting((v) => !v)} refreshing={q.isFetching} />
      ) : null}
    </Dialog>
  );
}

function ReceiptPaper({ r, onlyWaiting, onToggle, refreshing }: { r: DiningReceipt; onlyWaiting: boolean; onToggle: () => void; refreshing: boolean }) {
  const session = useSession();
  const t = r.totals;
  const progress = t.quantity > 0 ? Math.round((t.served / t.quantity) * 100) : 0;
  const keep = (l: DiningReceiptLine) => !onlyWaiting || (l.state !== 'served' && l.state !== 'voided');
  const orders = r.orders.map((o) => ({ ...o, shown: o.lines.filter(keep) })).filter((o) => o.shown.length > 0);
  return (
    <div className="-mx-6 -my-5 space-y-3 bg-paper-2/70 px-3 py-5 sm:px-6" data-testid="dining-receipt">
      {/* 小票纸：上下两道锯齿边，里面等宽的数字 */}
      <div className="receipt-paper relative mx-auto max-w-[400px] bg-[#fffdf8] px-5 pt-6 pb-7 text-ink shadow-card" data-testid="dining-receipt-paper">
        <header className="text-center">
          <p className="text-[12px] font-semibold tracking-[0.18em] text-ink-3">{session.storeName}</p>
          <h3 className="mt-0.5 text-[22px] leading-tight font-bold tracking-[0.3em]">点菜单</h3>
          <p className="mt-2 flex flex-wrap items-baseline justify-center gap-x-2 text-[15px] font-bold" data-testid="dining-receipt-title">
            <span className="num">{r.kind === 'table' ? `桌 ${r.title}` : `手牌 ${r.title}`}</span>
            {r.zone && <span className="text-[12.5px] font-semibold text-ink-3">{r.zone}</span>}
          </p>
          <p className="mt-0.5 text-[12.5px] text-ink-3">
            {r.guest}
            {r.guests !== null && ` · ${r.guests} 人`} · {r.kind === 'table' ? '开台' : '到店'} {formatDateTime(r.openedAt)}
          </p>
          {r.closed && (
            <p className="mt-1 inline-block rounded border border-ink-4/50 px-1.5 text-[11.5px] font-semibold text-ink-3" data-testid="dining-receipt-closed">
              {r.kind === 'table' ? '已结账 / 撤台' : '已离店'} · 只读
            </p>
          )}
        </header>

        {/* 上菜进度 */}
        <div className="mt-4 border-t border-dashed border-line-strong pt-3" data-testid="dining-receipt-progress">
          <div className="flex items-baseline justify-between text-[13px]">
            <span className="font-semibold">上菜进度</span>
            <span>
              已上 <b className="num text-pine">{t.served}</b> / 共 <b className="num">{t.quantity}</b> 份
            </span>
          </div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-paper-2" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-label="上菜进度">
            <div className="h-full rounded-full bg-pine transition-[width] duration-500" style={{ width: `${progress}%` }} />
          </div>
          <p className="mt-1.5 flex flex-wrap gap-x-3 text-[12px] text-ink-3">
            <span>
              未上{' '}
              <b className="num text-clay" data-testid="dining-receipt-waiting">
                {t.waiting}
              </b>{' '}
              份
            </span>
            {t.voided > 0 && (
              <span>
                已退 <b className="num">{t.voided}</b> 份
              </span>
            )}
            <span>共 {r.orders.length} 次下单</span>
          </p>
        </div>

        {/* 每次下单一段 */}
        {orders.length === 0 ? (
          <p className="mt-4 border-t border-dashed border-line-strong pt-4 text-center text-[13px] text-ink-3" data-testid="dining-receipt-empty">
            {r.orders.length === 0 ? '还没有点菜' : '点的菜都上齐了'}
          </p>
        ) : (
          orders.map((o) => (
            <section key={o.seq} className="mt-4 border-t border-dashed border-line-strong pt-3" data-testid={`dining-receipt-order-${o.seq}`}>
              <p className="flex items-baseline justify-between text-[12px] text-ink-3">
                <span className="font-bold text-ink-2">第 {o.seq} 次下单</span>
                <span className="num">
                  {formatTime(o.postedAt)} · {o.postedByName}
                </span>
              </p>
              {(o.orderNote || o.deliverRoom) && (
                <p className="mt-1 text-[12.5px] font-semibold text-lake" data-testid={`dining-receipt-order-note-${o.seq}`}>
                  {o.deliverRoom && `送到房 ${o.deliverRoom}`}
                  {o.deliverRoom && o.orderNote && ' · '}
                  {o.orderNote && `整单：${o.orderNote}`}
                </p>
              )}
              <ul className="mt-1.5 space-y-2">
                {o.shown.map((l) => (
                  <li key={l.billLineId} className="flex items-start gap-2.5" data-testid={`dining-receipt-line-${l.billLineId}`} data-state={l.state}>
                    <div className="min-w-0 flex-1">
                      <p className={cn('text-[14.5px] leading-snug font-bold', l.state === 'voided' && 'text-ink-4 line-through')}>{l.name}</p>
                      <p className="mt-0.5 text-[11.5px] text-ink-4">
                        {slotLabel(l)}
                        {l.note && <span className="ml-1.5 font-semibold text-yuzu-deep">{l.note}</span>}
                      </p>
                      {/* 套餐（8.1.15 菜品管理）：下单当时含的几样 */}
                      {l.parts.length > 0 && <p className="mt-0.5 text-[12px] text-ink-3">含 {partsText(l.parts)}</p>}
                    </div>
                    {/* 手持点单机（商米 V3，窄屏）上状态章在上、份数与金额在下，菜名留得宽；平板、收银机上一行排开 */}
                    <div className="flex shrink-0 flex-col items-end gap-1 min-[420px]:flex-row min-[420px]:items-start min-[420px]:gap-2.5">
                      <span className="order-2 flex items-baseline gap-2 min-[420px]:order-1 min-[420px]:pt-0.5">
                        <span className="num text-right text-[13.5px] font-semibold min-[420px]:w-9">×{l.quantity}</span>
                        <span className={cn('num text-right text-[13.5px] font-semibold min-[420px]:w-[4.5rem]', l.state === 'voided' && 'text-ink-4 line-through')}>{formatYuan(l.amount)}</span>
                      </span>
                      <span
                        className={cn(
                          'order-1 inline-flex h-6 w-[4.6rem] shrink-0 -rotate-3 items-center justify-center gap-0.5 rounded border-[1.5px] text-[12px] font-bold min-[420px]:order-2 min-[420px]:mt-0.5',
                          STAMP[l.state].cls,
                        )}
                        data-testid={`dining-receipt-state-${l.billLineId}`}
                      >
                        {STAMP[l.state].icon}
                        {RECEIPT_STATE_LABELS[l.state]}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}

        {/* 合计 */}
        <footer className="mt-4 border-t-2 border-double border-line-strong pt-3">
          <p className="flex items-baseline justify-between">
            <span className="text-[13px] font-semibold">
              合计 <span className="num">{t.quantity}</span> 份
            </span>
            <span className="num text-[22px] font-bold" data-testid="dining-receipt-amount">
              {formatYuan(t.amount)}
            </span>
          </p>
          <p className="mt-1 text-center text-[11px] text-ink-4">
            {r.trackServed ? '已出餐的菜要服务员点「上菜」后才算已上' : '出餐即算已上'} · {formatTime(r.serverTime)} 更新{refreshing ? ' · 刷新中…' : ''}
          </p>
        </footer>
      </div>

      <label className="flex items-center justify-center gap-2 text-[13px] font-semibold text-ink-2">
        <input type="checkbox" checked={onlyWaiting} onChange={onToggle} data-testid="dining-receipt-only-waiting" />
        只看还没上的菜
      </label>
    </div>
  );
}
