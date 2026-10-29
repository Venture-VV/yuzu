import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { CHECKOUT_METHOD_LABELS, COUPON_PLATFORM_LABELS, ticketTierLabel } from '@shared/checkout';
import type { CheckoutPrint } from '@shared/print';
import { api, errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { PrintedAt, PrintFrame, Row, Rule, SignLine, SlipHeader, stamp, yuan } from './PrintFrame';

// 80mm 结账单：所结手牌的项目明细与门票段数、各收款方式、储值扣前扣后余额、客人签字栏。

/** 资金轨 R1.2 起「优惠 / 免单」记下当场授权的人（原因记在收款备注）；之前的版本没有这一项 */
const approverOf = (p: CheckoutPrint['payments'][number]) => (p as { approvedByName?: string | null }).approvedByName ?? null;

export function CheckoutPrintPage() {
  const id = Number(useParams().id);
  const q = useQuery({
    queryKey: ['print', 'checkout', id],
    queryFn: () => api.get<CheckoutPrint>(`/api/print/checkouts/${id}`),
    enabled: Number.isInteger(id) && id > 0,
    refetchOnWindowFocus: false,
  });
  return (
    <PrintFrame title={q.data ? `结账单 ${q.data.checkoutNo}` : '结账单'} ready={!!q.data} error={q.error ? errorMessage(q.error) : null}>
      {q.data && <CheckoutSlip d={q.data} />}
    </PrintFrame>
  );
}

function CheckoutSlip({ d }: { d: CheckoutPrint }) {
  const session = useSession();
  const tz = session.timezone;
  return (
    <div data-testid="print-checkout">
      <SlipHeader title="结账单" />
      <Row left="单号" right={d.checkoutNo} />
      <Row left="营业日" right={d.businessDate} />
      <Row left="结账时间" right={stamp(d.createdAt, tz)} />
      <Row left="收银" right={d.operatorName} />
      {d.backfill && (
        <p className="mt-1 border border-black px-1.5 py-0.5 text-center" data-testid="print-backfill">
          补录 · 纸质单 {d.backfill.slipNo}（{d.backfill.enteredByName} {stamp(d.backfill.enteredAt, tz)} 补录）
        </p>
      )}
      {d.status === 'voided' && (
        <div className="mt-1.5 border-2 border-black px-1.5 py-1 text-center" data-testid="print-voided">
          <p className="text-[14px] font-bold">已反结账（本单作废）</p>
          <p>
            {d.voidedByName} {d.voidedAt ? stamp(d.voidedAt, tz) : ''}
          </p>
          <p className="break-all">原因：{d.voidReason}</p>
        </div>
      )}
      <Rule />
      {d.bills.map((b, i) => (
        <section key={b.billId}>
          {i > 0 && <Rule />}
          <Row left={<span className="text-[13px] font-bold">手牌 {b.tagCode}</span>} right={b.memberName ? `会员 ${b.memberName}` : b.guestLabel || '散客'} />
          <p>
            在店 {Math.floor(b.stayMinutes / 60)} 小时 {b.stayMinutes % 60} 分
            {b.ticketAmount === 0 && ` · ${b.ticketName}（${ticketTierLabel(b.ticketSegments)}，免票）`}
          </p>
          <div className="mt-1 space-y-0.5">
            {b.lines.map((l, j) => (
              <div key={j}>
                <Row left={l.name} right={yuan(l.amount)} />
                {l.quantity > 1 && (
                  <p className="pl-3 text-[11px]">
                    {l.quantity} × {yuan(l.unitPrice)}
                  </p>
                )}
              </div>
            ))}
            {b.lines.length === 0 && <p>（无消费）</p>}
          </div>
          {b.linesTotal !== b.amount && <p className="font-bold">明细合计 {yuan(b.linesTotal)} 与结账金额不同，以结账金额为准</p>}
          <Row left="小计" right={yuan(b.amount)} strong />
        </section>
      ))}
      <Rule double />
      <Row left="应收合计" right={yuan(d.totalAmount)} big />
      <p className="mt-1.5 font-bold">收款</p>
      {d.payments.length === 0 && <p>应收为 0，未收款</p>}
      <div className="space-y-1">
        {d.payments.map((p) => (
          <div key={p.id} data-testid={`print-payment-${p.method}`}>
            <Row left={`${CHECKOUT_METHOD_LABELS[p.method] ?? p.method}${p.method === 'wallet' && p.memberName ? ` · ${p.memberName}` : ''}`} right={yuan(p.amount)} />
            {p.method === 'wallet' && p.consumption && (
              <div className="pl-3 text-[11px]">
                <p>
                  扣本金 {yuan(p.consumption.principal)} · 扣赠金 {yuan(p.consumption.bonus)}
                </p>
                {p.balance && (
                  <>
                    <p>
                      扣前 本金 {yuan(p.balance.before.principal)} / 赠金 {yuan(p.balance.before.bonus)}
                    </p>
                    <p>
                      扣后 本金 {yuan(p.balance.after.principal)} / 赠金 {yuan(p.balance.after.bonus)}
                    </p>
                  </>
                )}
                {p.consumption.status === 'reversed' && <p>已随反结账撤销，储值已退回</p>}
              </div>
            )}
            {p.method === 'coupon' && p.coupon && (
              <p className="pl-3 text-[11px] break-all">
                {COUPON_PLATFORM_LABELS[p.coupon.platform]}
                {p.coupon.dealName ? ` ${p.coupon.dealName}` : ''} · 券码尾号 {p.coupon.code.slice(-4)}
                {p.coupon.status === 'voided' ? '（已作废）' : ''}
              </p>
            )}
            {p.method !== 'wallet' && p.method !== 'coupon' && p.ref && <p className="pl-3 text-[11px] break-all">{p.ref}</p>}
            {approverOf(p) && <p className="pl-3 text-[11px]">{approverOf(p)} 当场授权</p>}
          </div>
        ))}
      </div>
      {d.note && <p className="mt-1 break-all">备注：{d.note}</p>}
      {d.status === 'completed' && d.remainingMates.length > 0 && <p className="mt-1">同行仍在店：{d.remainingMates.join('、')}（另行结账）</p>}
      <Rule />
      <SignLine label="客人签字" />
      <PrintedAt />
    </div>
  );
}
