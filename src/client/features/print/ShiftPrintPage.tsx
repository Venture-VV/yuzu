import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { CHECKOUT_METHOD_LABELS, COUPON_PLATFORM_LABELS, type CheckoutMethod, type ShiftRecord, type ShiftSummary } from '@shared/checkout';
import { PAYMENT_METHOD_LABELS } from '@shared/labels';
import { api, errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { PrintedAt, PrintFrame, Row, Rule, SignLine, SlipHeader, stamp, yuan } from './PrintFrame';

// 80mm 交班表：备用金、各收款方式、应有现金、实点现金与长短款、反结账提醒、交接签字。
// 当班中的班次打出来是「预览」，没有实点现金与长短款。

/**
 * 资金轨 R1.2 起，反结账退给客人的现金扣减反结账人当班的应有现金，汇总里多了退款（refunds、cash.refund）；
 * 之前的版本与升级前交班的快照没有这两项，照旧只列反结账提醒。
 */
type Summary = ShiftSummary & {
  refunds?: { count: number; total: number; byMethod: { method: string; amount: number }[] };
  cash: ShiftSummary['cash'] & { refund?: number };
};
const methodLabel = (m: string) => CHECKOUT_METHOD_LABELS[m as CheckoutMethod] ?? m;

export function ShiftPrintPage() {
  const id = Number(useParams().id);
  const q = useQuery({
    queryKey: ['print', 'shift', id],
    queryFn: () => api.get<ShiftRecord>(`/api/shifts/${id}`),
    enabled: Number.isInteger(id) && id > 0,
    refetchOnWindowFocus: false,
  });
  return (
    <PrintFrame title={q.data ? `交班表 ${q.data.shiftNo}` : '交班表'} ready={!!q.data} error={q.error ? errorMessage(q.error) : null}>
      {q.data && <ShiftSlip s={q.data} />}
    </PrintFrame>
  );
}

function ShiftSlip({ s }: { s: ShiftRecord }) {
  const session = useSession();
  const tz = session.timezone;
  const sum = s.summary as Summary;
  const closed = s.status === 'closed';
  const diff = closed && s.countedCash !== null && s.expectedCash !== null ? s.countedCash - s.expectedCash : null;
  return (
    <div data-testid="print-shift">
      <SlipHeader title={closed ? '交班表' : '交班表（预览）'} />
      {!closed && <p className="mb-1 text-center font-bold">当班中，尚未交班</p>}
      <Row left="班次" right={s.shiftNo} />
      {s.drawerName ? (
        <>
          <Row left="钱箱" right={s.drawerName} />
          <p className="text-[11px]" data-testid="print-shift-members">
            当班：{s.members.map((m) => `${m.staffName} ${stamp(m.joinedAt, tz).slice(-5)}${m.leftAt ? `–${stamp(m.leftAt, tz).slice(-5)}` : ' 起'}`).join('、')}
          </p>
        </>
      ) : (
        <Row left="交班人" right={s.staffName} />
      )}
      <Row left="营业日" right={s.businessDate} />
      <Row left="开班" right={stamp(s.startedAt, tz)} />
      <Row left="交班" right={s.endedAt ? stamp(s.endedAt, tz) : '—'} />
      <Rule />
      <Row left="备用金" right={yuan(s.openingCash)} strong />
      <p className="mt-1.5 font-bold">前台结账 {sum.checkouts.count} 张</p>
      {sum.checkoutByMethod.length === 0 && <p>无</p>}
      {sum.checkoutByMethod.map((m) => (
        <Row key={m.method} left={`${methodLabel(m.method)} · ${m.count} 笔`} right={yuan(m.amount)} />
      ))}
      <Row left="结账合计" right={yuan(sum.checkouts.total)} strong />
      {sum.coupons.length > 0 && <p className="text-[11px]">团购：{sum.coupons.map((c) => `${COUPON_PLATFORM_LABELS[c.platform]} ${c.count} 张 ${yuan(c.amount)}`).join('、')}</p>}
      <p className="mt-1.5 font-bold">会员充值 {sum.recharges.count} 笔</p>
      {sum.recharges.byMethod.length === 0 && <p>无</p>}
      {sum.recharges.byMethod.map((m) => (
        <Row key={m.method} left={`${PAYMENT_METHOD_LABELS[m.method] ?? m.method} · ${m.count} 笔`} right={yuan(m.amount)} />
      ))}
      <Row left="充值实收" right={yuan(sum.recharges.paid)} strong />
      <Row left="赠送赠金（不是收款）" right={yuan(sum.recharges.bonus)} />
      {sum.deposits && (
        <div data-testid="print-shift-deposits">
          <p className="mt-1.5 font-bold">客房押金（不算营业额）</p>
          {sum.deposits.received.map((m) => (
            <Row key={`r-${m.method}`} left={`收 ${PAYMENT_METHOD_LABELS[m.method] ?? m.method} · ${m.count} 笔`} right={yuan(m.amount)} />
          ))}
          {sum.deposits.refunded.map((m) => (
            <Row key={`f-${m.method}`} left={`退 ${PAYMENT_METHOD_LABELS[m.method] ?? m.method} · ${m.count} 笔`} right={yuan(m.amount)} />
          ))}
        </div>
      )}
      {sum.countCards && (
        <div data-testid="print-shift-count-cards">
          <p className="mt-1.5 font-bold">次卡（收款，不算营业额）</p>
          {sum.countCards.sales.byMethod.map((m) => (
            <Row key={`s-${m.method}`} left={`卖 ${PAYMENT_METHOD_LABELS[m.method] ?? m.method} · ${m.count} 笔`} right={yuan(m.amount)} />
          ))}
          {sum.countCards.refunds.byMethod.map((m) => (
            <Row key={`r-${m.method}`} left={`退 ${PAYMENT_METHOD_LABELS[m.method] ?? m.method} · ${m.count} 笔`} right={yuan(m.amount)} />
          ))}
        </div>
      )}
      <p className="text-[11px]">
        会员工作台储值消费 {sum.walletConsumes.count} 笔 {yuan(sum.walletConsumes.total)}（不是现金）
      </p>
      {sum.byOperator && sum.byOperator.length > 0 && (
        <div data-testid="print-shift-operators">
          <p className="mt-1.5 font-bold">各人经办（结账 / 充值）</p>
          {sum.byOperator.map((o) => (
            <Row key={o.staffId} left={`${o.staffName} · ${o.checkouts.count} 张 / ${o.recharges.count} 笔`} right={yuan(o.checkouts.total + o.recharges.paid)} />
          ))}
        </div>
      )}
      <Rule />
      <p className="font-bold">现金</p>
      <Row left="备用金" right={yuan(sum.cash.opening)} />
      <Row left="+ 结账现金" right={yuan(sum.cash.checkout)} />
      <Row left="+ 充值现金" right={yuan(sum.cash.recharge)} />
      {!!sum.cash.refund && <Row left="− 反结账退现金" right={yuan(sum.cash.refund)} />}
      {!!sum.cash.deposit && <Row left={sum.cash.deposit > 0 ? '+ 押金现金（收 − 退）' : '− 押金现金（退 − 收）'} right={yuan(Math.abs(sum.cash.deposit))} />}
      {!!sum.cash.refundSlip && <Row left="− 退款单退现金" right={yuan(sum.cash.refundSlip)} />}
      {!!sum.cash.memberRefund && <Row left="− 储值退回的现金" right={yuan(sum.cash.memberRefund)} />}
      {!!sum.cash.countCard && <Row left={sum.cash.countCard > 0 ? '+ 次卡现金（卖 − 退）' : '− 次卡现金（退 − 卖）'} right={yuan(Math.abs(sum.cash.countCard))} />}
      <Row left="= 应有现金" right={yuan(s.expectedCash ?? sum.cash.expected)} strong />
      {closed && s.countedCash !== null && (
        <>
          <Row left="实点现金" right={yuan(s.countedCash)} strong />
          <div data-testid="print-shift-diff">
            <Row left={diff === 0 ? '长短款' : diff! > 0 ? '长款' : '短款'} right={diff === 0 ? '无' : yuan(Math.abs(diff!))} big />
          </div>
          {(s.expectedCash ?? 0) < 0 && (
            <p className="text-[11px]" data-testid="print-shift-cross-drawer">
              应有现金为负：反结账退的现金比本班收的多 {yuan(-(s.expectedCash ?? 0))}，这部分从别的钱箱或保险柜拿出，记成长款，与出钱那个钱箱的短款相抵。
            </p>
          )}
        </>
      )}
      {sum.voids.length > 0 && (
        <>
          <Rule />
          <p className="font-bold">
            本班次反结账 {sum.voids.length} 张{sum.refunds ? ` · 退款 ${yuan(sum.refunds.total)}` : '（提醒）'}
          </p>
          {sum.voids.map((v) => (
            <p key={v.checkoutNo} className="break-all">
              {v.checkoutNo} {yuan(v.amount)} · {v.reason}
              {v.voidedByName ? ` · ${v.voidedByName}反结账、从本班钱箱退` : ''}
            </p>
          ))}
          {sum.refunds ? (
            <p className="text-[11px]" data-testid="print-shift-refunds">
              退款按原收款方式：{sum.refunds.byMethod.map((m) => `${methodLabel(m.method)} ${yuan(m.amount)}`).join('、')}。现金从本班钱箱退，已从应有现金里扣掉；扫码、银行卡、团购在商户后台原路退回。原单是别人收的款时仍算在原收款人的班次，同一钱箱合并核对时相抵；反结账时选了别人的钱箱的，退款记在那个班次。
            </p>
          ) : (
            <p className="text-[11px]">原单收过的现金不计入应有现金，请核对是否已退还或已重新收取。</p>
          )}
        </>
      )}
      {sum.refundSlips && (
        <div data-testid="print-shift-refund-slips">
          <Rule />
          <p className="font-bold">
            退款单 {sum.refundSlips.count} 张 · {yuan(sum.refundSlips.total)}
          </p>
          {sum.refundSlips.list.map((r) => (
            <p key={r.refundNo} className="break-all">
              {r.refundNo}（原单 {r.checkoutNo}）{yuan(r.amount)} · {r.reason}
              {r.operatorName ? ` · ${r.operatorName}从本班钱箱退` : ''}
              {r.refs.filter((x) => x.method !== 'cash').map((x) => ` · ${PAYMENT_METHOD_LABELS[x.method] ?? x.method} ${x.ref}`).join('')}
            </p>
          ))}
          <p className="text-[11px]">现金从本班钱箱退，已从应有现金里扣掉；扫码、银行卡在商户后台原路退回。</p>
        </div>
      )}
      {sum.memberRefunds && (
        <div data-testid="print-shift-member-refunds">
          <Rule />
          <p className="font-bold">
            储值退回 {sum.memberRefunds.count} 张 · {yuan(sum.memberRefunds.total)}
          </p>
          {sum.memberRefunds.list.map((r) => (
            <p key={r.refundNo} className="break-all">
              {r.refundNo} {r.memberName} {yuan(r.amount)} · {r.reason}
              {r.operatorName ? ` · ${r.operatorName}从本班钱箱退` : ''}
            </p>
          ))}
        </div>
      )}
      {s.note && <p className="mt-1 break-all">备注：{s.note}</p>}
      <Rule />
      <SignLine label="交班人签字" />
      <SignLine label="接班人签字" name={s.handedToName} />
      <PrintedAt />
    </div>
  );
}
