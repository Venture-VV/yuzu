import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import type { RefundDetail } from '@shared/checkout';
import { PAYMENT_METHOD_LABELS } from '@shared/labels';
import { api, errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { PrintedAt, PrintFrame, Row, Rule, SignLine, SlipHeader, stamp, yuan } from './PrintFrame';

// 80mm 退款凭条（v0.7.20，退款单）：原结账单、退的项目、退款方式与商户后台的退款单号、经办人与原因、客人签字栏。

export function RefundPrintPage() {
  const id = Number(useParams().id);
  const q = useQuery({
    queryKey: ['print', 'refund', id],
    queryFn: () => api.get<RefundDetail>(`/api/frontdesk/refunds/${id}`),
    enabled: Number.isInteger(id) && id > 0,
    refetchOnWindowFocus: false,
  });
  return (
    <PrintFrame title={q.data ? `退款单 ${q.data.refundNo}` : '退款单'} ready={!!q.data} error={q.error ? errorMessage(q.error) : null}>
      {q.data && <RefundSlip d={q.data} />}
    </PrintFrame>
  );
}

function RefundSlip({ d }: { d: RefundDetail }) {
  const session = useSession();
  const tz = session.timezone;
  return (
    <div data-testid="print-refund">
      <SlipHeader title="退款单" />
      <Row left="单号" right={d.refundNo} />
      <Row left="原结账单" right={d.checkoutNo} />
      {(d.tagCodes.length > 0 || d.tableNames.length > 0) && (
        <Row left={d.tableNames.length ? '桌台' : '手牌'} right={[...d.tagCodes, ...d.tableNames].join('、')} />
      )}
      <Row left="营业日" right={d.businessDate} />
      <Row left="退款时间" right={stamp(d.createdAt, tz)} />
      <Row left="经办" right={d.operatorName} />
      {d.status === 'voided' && (
        <div className="mt-1.5 border-2 border-black px-1.5 py-1 text-center" data-testid="print-refund-voided">
          <p className="text-[14px] font-bold">已作废（本单不算）</p>
          <p>
            {d.voidedByName} {d.voidedAt ? stamp(d.voidedAt, tz) : ''}
          </p>
          <p className="break-all">原因：{d.voidReason}</p>
        </div>
      )}
      <Rule />
      <p className="font-bold">退的项目</p>
      <div className="space-y-0.5">
        {d.items.map((i) => (
          <div key={`${i.category}-${i.name}`}>
            <Row left={i.name} right={yuan(i.amount)} />
            <p className="pl-3 text-[11px]">
              {i.category} · {i.quantity > 0 ? `退 ${i.quantity} 份` : '只退钱、不退份数'}
            </p>
          </div>
        ))}
      </div>
      <Rule double />
      <Row left="退款合计" right={yuan(d.amount)} big />
      <p className="mt-1.5 font-bold">退款方式</p>
      <div className="space-y-1">
        {d.payments.map((p) => (
          <div key={p.method}>
            <Row left={PAYMENT_METHOD_LABELS[p.method]} right={yuan(p.amount)} />
            {p.ref && <p className="pl-3 text-[11px] break-all">{p.method === 'other' ? p.ref : `退款单号 ${p.ref}`}</p>}
            {p.method === 'cash' && d.shift && <p className="pl-3 text-[11px]">从 {d.shift.staffName} 的钱箱退（班次 {d.shift.shiftNo}）</p>}
          </div>
        ))}
      </div>
      <p className="mt-1 break-all">原因：{d.reason}</p>
      <Rule />
      <SignLine label="客人签字" />
      <SignLine label="经办签字" name={d.operatorName} />
      <PrintedAt />
    </div>
  );
}
