import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { CHECKOUT_METHOD_LABELS, COUPON_PLATFORM_LABELS, type ShiftRecord } from '@shared/checkout';
import { PAYMENT_METHOD_LABELS } from '@shared/labels';
import { api, errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { PrintedAt, PrintFrame, Row, Rule, SignLine, SlipHeader, stamp, yuan } from './PrintFrame';

// 80mm 交班表：备用金、各收款方式、应有现金、实点现金与长短款、反结账提醒、交接签字。
// 当班中的班次打出来是「预览」，没有实点现金与长短款。

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
  const sum = s.summary;
  const closed = s.status === 'closed';
  const diff = closed && s.countedCash !== null && s.expectedCash !== null ? s.countedCash - s.expectedCash : null;
  return (
    <div data-testid="print-shift">
      <SlipHeader title={closed ? '交班表' : '交班表（预览）'} />
      {!closed && <p className="mb-1 text-center font-bold">当班中，尚未交班</p>}
      <Row left="班次" right={s.shiftNo} />
      <Row left="交班人" right={s.staffName} />
      <Row left="营业日" right={s.businessDate} />
      <Row left="开班" right={stamp(s.startedAt, tz)} />
      <Row left="交班" right={s.endedAt ? stamp(s.endedAt, tz) : '—'} />
      <Rule />
      <Row left="备用金" right={yuan(s.openingCash)} strong />
      <p className="mt-1.5 font-bold">前台结账 {sum.checkouts.count} 张</p>
      {sum.checkoutByMethod.length === 0 && <p>无</p>}
      {sum.checkoutByMethod.map((m) => (
        <Row key={m.method} left={`${CHECKOUT_METHOD_LABELS[m.method] ?? m.method} · ${m.count} 笔`} right={yuan(m.amount)} />
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
      <p className="text-[11px]">
        会员工作台储值消费 {sum.walletConsumes.count} 笔 {yuan(sum.walletConsumes.total)}（不是现金）
      </p>
      <Rule />
      <p className="font-bold">现金</p>
      <Row left="备用金" right={yuan(sum.cash.opening)} />
      <Row left="+ 结账现金" right={yuan(sum.cash.checkout)} />
      <Row left="+ 充值现金" right={yuan(sum.cash.recharge)} />
      <Row left="= 应有现金" right={yuan(s.expectedCash ?? sum.cash.expected)} strong />
      {closed && s.countedCash !== null && (
        <>
          <Row left="实点现金" right={yuan(s.countedCash)} strong />
          <div data-testid="print-shift-diff">
            <Row left={diff === 0 ? '长短款' : diff! > 0 ? '长款' : '短款'} right={diff === 0 ? '无' : yuan(Math.abs(diff!))} big />
          </div>
        </>
      )}
      {sum.voids.length > 0 && (
        <>
          <Rule />
          <p className="font-bold">本班次反结账 {sum.voids.length} 张（提醒）</p>
          {sum.voids.map((v) => (
            <p key={v.checkoutNo} className="break-all">
              {v.checkoutNo} {yuan(v.amount)} · {v.reason}
            </p>
          ))}
          <p className="text-[11px]">原单收过的现金不计入应有现金，请核对是否已退还或已重新收取。</p>
        </>
      )}
      {s.note && <p className="mt-1 break-all">备注：{s.note}</p>}
      <Rule />
      <SignLine label="交班人签字" />
      <SignLine label="接班人签字" name={s.handedToName} />
      <PrintedAt />
    </div>
  );
}
