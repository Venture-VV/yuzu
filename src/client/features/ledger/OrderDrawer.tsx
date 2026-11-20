// 订单查询的右侧抽屉（8.0.15，docs/ORDERS_V8015.md 第 2.3 节）：结账单的逐行明细（与打印的结账单一致，另加所属部门与优惠）、
// 收款、这张单的退款单；退款单退了哪几项。只读，可以从这里打印结账单。
// 8.1.17（BW-12，docs/FRONTDESK_V8117.md 第 1 节）：结账单用结账完成页、「结账记录」的同一个部件（frontdesk/CheckoutReceipt）。

import { useQuery } from '@tanstack/react-query';
import { ReceiptText, Undo2, X } from 'lucide-react';
import { CHECKOUT_METHOD_LABELS, type CheckoutMethod } from '@shared/checkout';
import { formatYuan } from '@shared/money';
import { orderStatusLabel, type CheckoutOrderDetail, type OrderLine, type OrderRow, type RefundOrderDetail } from '@shared/orders';
import { api, errorMessage } from '../../lib/api';
import { useCan } from '../../lib/session';
import { cn, formatDateTime } from '../../lib/utils';
import { Sheet } from '../../components/Overlay';
import { Money } from '../../components/Money';
import { Badge, IconButton, Notice, Skeleton } from '../../components/ui';
import { SummaryRow } from '../flows/parts';
import { PrintButton } from '../print/PrintButton';
import { CheckoutReceipt } from '../frontdesk/CheckoutReceipt';

export interface OrderTarget {
  kind: 'checkout' | 'refund';
  id: number;
}

export function StatusBadge({ row }: { row: Pick<OrderRow, 'kind' | 'status' | 'refundedAmount'> }) {
  const tone = row.status === 'voided' ? 'clay' : row.kind === 'refund' ? 'ember' : row.refundedAmount > 0 ? 'yuzu' : 'pine';
  return <Badge tone={tone}>{orderStatusLabel(row)}</Badge>;
}

export function OrderDrawer({ target, onClose, onOpen }: { target: OrderTarget | null; onClose: () => void; onOpen: (t: OrderTarget) => void }) {
  const url = target ? `/api/ledger/orders/${target.kind === 'checkout' ? 'checkouts' : 'refunds'}/${target.id}` : null;
  const doc = useQuery({
    queryKey: ['ledger', 'order', target?.kind, target?.id],
    queryFn: () => api.get<CheckoutOrderDetail | RefundOrderDetail>(url!),
    enabled: !!url,
  });
  if (!target) return null;
  const isCheckout = target.kind === 'checkout';
  const checkout = isCheckout && doc.data ? (doc.data as CheckoutOrderDetail) : null;
  const refund = !isCheckout && doc.data ? (doc.data as RefundOrderDetail) : null;

  return (
    <Sheet open onClose={onClose} label={isCheckout ? '结账单明细' : '退款单明细'} width="w-[min(680px,100vw)]">
      <header className="flex items-start gap-3 border-b border-line bg-card px-5 py-4">
        <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-full', isCheckout ? 'bg-lake-soft text-lake' : 'bg-ember-soft text-ember')}>
          {isCheckout ? <ReceiptText className="size-5" /> : <Undo2 className="size-5" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-semibold text-ink-3">{isCheckout ? '结账单' : '退款单'}</p>
          <p className="num text-[18px] font-bold" data-testid="order-drawer-no">
            {checkout?.doc.checkoutNo ?? refund?.refundNo ?? '…'}
          </p>
        </div>
        <IconButton label="关闭" onClick={onClose} className="-mr-2">
          <X className="size-[18px]" />
        </IconButton>
      </header>

      <div className="scroll-thin flex-1 space-y-4 overflow-y-auto p-5" data-testid="order-drawer">
        {doc.error ? (
          <Notice tone="error" title={errorMessage(doc.error)} />
        ) : !doc.data ? (
          <div className="space-y-2">
            <Skeleton className="h-24" />
            <Skeleton className="h-40" />
          </div>
        ) : checkout ? (
          <CheckoutBody d={checkout} onOpen={onOpen} />
        ) : refund ? (
          <RefundBody d={refund} onOpen={onOpen} />
        ) : null}
      </div>
    </Sheet>
  );
}

// ───────────────────────── 结账单 ─────────────────────────

/**
 * 结账单（8.1.17 BW-12）：与结账完成页、「结账记录」同一个部件（CheckoutReceipt）——「优惠与赠送」一栏写每笔的经办人，
 * 每张手牌下面是结账那一刻的明细，被签赠、券、会员折扣抵到的行标「赠」「券」「折」，另写所属部门与摊到这一行的优惠；
 * 储值支付写扣前扣后的余额。下面是「流水」自己的：营业日、这张单的退款单、打印
 */
function CheckoutBody({ d, onOpen }: { d: CheckoutOrderDetail; onOpen: (t: OrderTarget) => void }) {
  const can = useCan();
  const { doc } = d;
  const refunded = doc.refunds.filter((r) => r.status === 'completed').reduce((s, r) => s + r.amount, 0);
  return (
    <CheckoutReceipt
      detail={doc}
      showLines={d.source === 'lines'}
      footer={
        <>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-2" data-testid="order-meta">
            <StatusBadge row={{ kind: 'checkout', status: doc.status, refundedAmount: refunded }} />
            <span>
              营业日 <span className="num">{doc.businessDate}</span>
            </span>
            {doc.note && <span className="min-w-0 break-all">备注：{doc.note}</span>}
          </p>
          {d.source === 'items' && (
            <>
              <Notice tone="info" title="这张单按结账时记下的项目显示" data-testid="order-source-items">
                它的结账时间是补录的，按时刻取不全当时的明细，所以这里没有手牌与技师两栏，也标不出哪一行用了签赠、券、会员折扣；部门、数量、金额、优惠与看板、对账包一致。
              </Notice>
              <section className="overflow-hidden rounded-lg border border-line bg-card" data-testid="order-bill">
                <LinesTable lines={d.lines} />
              </section>
            </>
          )}
          {doc.refunds.length > 0 && (
            <section className="rounded-lg border border-line bg-card px-4 py-3" data-testid="order-refunds">
              <p className="mb-1.5 text-[12.5px] font-bold text-ink-3">这张单的退款单</p>
              <div className="divide-y divide-line/70">
                {doc.refunds.map((r) => (
                  <button key={r.id} type="button" onClick={() => onOpen({ kind: 'refund', id: r.id })} className="flex min-h-11 w-full items-center gap-2 py-2 text-left text-[13px] hover:text-pine">
                    <span className="num font-semibold">{r.refundNo}</span>
                    <StatusBadge row={{ kind: 'refund', status: r.status, refundedAmount: 0 }} />
                    <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">
                      {formatDateTime(r.createdAt)} · {r.operatorName} · {r.reason}
                    </span>
                    <Money cents={-r.amount} className={cn('font-bold', r.status === 'voided' ? 'struck text-ink-4' : 'text-ember-deep')} />
                  </button>
                ))}
              </div>
            </section>
          )}
          {can('frontdesk.read') && (
            <div className="flex flex-wrap gap-2">
              <PrintButton path={`/print/checkout/${doc.id}`} testId="order-print">
                打印结账单
              </PrintButton>
            </div>
          )}
        </>
      }
    />
  );
}

/** 按项目快照显示的明细（补录到更早时刻的单：没有手牌、技师，标不出抵到哪一行） */
function LinesTable({ lines }: { lines: OrderLine[] }) {
  if (lines.length === 0) return <p className="px-3 py-3 text-[13px] text-ink-3">没有消费明细（免票）</p>;
  return (
    <>
      {/* 手机：一行一块（项目、部门 · 数量 × 单价，右边金额与优惠） */}
      <ul className="divide-y divide-line/70 text-[13px] sm:hidden">
        {lines.map((l, i) => (
          <li key={i} className="flex items-start gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="font-semibold break-words">{l.name}</p>
              <p className="text-[12px] text-ink-3">
                {l.category} · {l.unitPrice == null ? `${l.quantity} 份` : `${l.quantity} × ${formatYuan(l.unitPrice)}`}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <Money cents={l.amount} className="font-bold" />
              {l.discount > 0 && (
                <p className="text-[12px] text-ember-deep">
                  优惠 <Money cents={-l.discount} />
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
      <table className="hidden w-full table-fixed text-[13px] sm:table" data-testid="order-lines">
        <thead className="text-[12px] text-ink-3">
          <tr className="border-b border-line/70">
            <th className="px-3 py-2 text-left font-semibold">项目</th>
            <th className="w-[112px] px-2 py-2 text-left font-semibold">所属部门</th>
            <th className="w-[48px] px-2 py-2 text-right font-semibold">数量</th>
            <th className="w-[84px] px-2 py-2 text-right font-semibold">单价</th>
            <th className="w-[92px] px-2 py-2 text-right font-semibold">金额</th>
            <th className="w-[84px] px-3 py-2 text-right font-semibold">优惠</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line/70">
          {lines.map((l, i) => (
            <tr key={i} data-testid="order-line">
              <td className="px-3 py-2">
                <p className="font-semibold break-words">{l.name}</p>
              </td>
              <td className="px-2 py-2 break-words text-ink-2">{l.category}</td>
              <td className="num px-2 py-2 text-right">{l.quantity}</td>
              <td className="px-2 py-2 text-right">{l.unitPrice == null ? <span className="text-ink-4">—</span> : <Money cents={l.unitPrice} className="text-ink-2" />}</td>
              <td className="px-2 py-2 text-right">
                <Money cents={l.amount} className="font-bold" />
              </td>
              <td className="px-3 py-2 text-right">{l.discount ? <Money cents={-l.discount} className="text-ember-deep" /> : <span className="text-ink-4">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

// ───────────────────────── 退款单 ─────────────────────────

function RefundBody({ d, onOpen }: { d: RefundOrderDetail; onOpen: (t: OrderTarget) => void }) {
  const can = useCan();
  return (
    <>
      <div className="rounded-lg border border-line bg-card px-4 py-1">
        <SummaryRow label="状态">
          <StatusBadge row={{ kind: 'refund', status: d.status, refundedAmount: 0 }} />
        </SummaryRow>
        <SummaryRow label="原结账单">
          <button type="button" onClick={() => onOpen({ kind: 'checkout', id: d.checkoutId })} className="num text-pine hover:underline" data-testid="order-refund-origin">
            {d.checkoutNo}
          </button>
        </SummaryRow>
        <SummaryRow label="手牌 / 桌号">
          <span className="num">{[...d.tagCodes, ...d.tableNames.map((t) => `桌 ${t}`)].join('、') || '—'}</span>
        </SummaryRow>
        <SummaryRow label="时间">{formatDateTime(d.createdAt)}</SummaryRow>
        <SummaryRow label="营业日">
          <span className="num">{d.businessDate}</span>
        </SummaryRow>
        <SummaryRow label="经办">{d.operatorName}</SummaryRow>
        <SummaryRow label="原因">{d.reason}</SummaryRow>
        <SummaryRow label="记到的班次">{d.shift ? `${d.shift.shiftNo} · ${d.shift.staffName}${d.shift.drawerName ? ` · ${d.shift.drawerName}` : ''}` : '没有开班'}</SummaryRow>
      </div>

      {d.status === 'voided' && (
        <Notice tone="warning" icon={<Undo2 className="size-4" />} title={`${d.voidedByName ?? ''} 于 ${d.voidedAt ? formatDateTime(d.voidedAt) : ''} 作废了这张退款单`}>
          {d.voidReason}。作废后不算退款。
        </Notice>
      )}

      <section className="overflow-hidden rounded-lg border border-line bg-card" data-testid="order-refund-items">
        <table className="w-full text-[13px]">
          <thead className="text-[12px] text-ink-3">
            <tr className="border-b border-line/70">
              <th className="px-3 py-2 text-left font-semibold">项目</th>
              <th className="px-2 py-2 text-left font-semibold">所属部门</th>
              <th className="w-[64px] px-2 py-2 text-right font-semibold">退的份数</th>
              <th className="w-[100px] px-3 py-2 text-right font-semibold">退的金额</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/70">
            {d.items.map((i) => (
              <tr key={`${i.category}-${i.name}`}>
                <td className="px-3 py-2 font-semibold">{i.name}</td>
                <td className="px-2 py-2 text-ink-2">{i.category}</td>
                <td className="num px-2 py-2 text-right">{i.quantity}</td>
                <td className="px-3 py-2 text-right">
                  <Money cents={-i.amount} className="font-bold text-ember-deep" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="rounded-lg border border-line bg-card px-4 py-3">
        <p className="mb-1.5 text-[12.5px] font-bold text-ink-3">退款方式</p>
        <div className="space-y-1.5 text-[13px]">
          {d.payments.map((p, i) => (
            <p key={i} className="flex flex-wrap items-baseline gap-2">
              <span className="font-semibold">{CHECKOUT_METHOD_LABELS[p.method as CheckoutMethod]}</span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">{p.ref}</span>
              <Money cents={-p.amount} className="font-bold" />
            </p>
          ))}
        </div>
        <p className="mt-2 flex items-baseline justify-between border-t border-dashed border-line pt-2 text-[13px]">
          <span className="font-bold">合计退款</span>
          <Money cents={-d.amount} className="text-[18px] font-bold text-ember-deep" />
        </p>
      </section>

      {can('frontdesk.read') && (
        <div className="flex flex-wrap gap-2">
          <PrintButton path={`/print/refund/${d.id}`} testId="order-refund-print">
            打印退款单
          </PrintButton>
        </div>
      )}
    </>
  );
}
