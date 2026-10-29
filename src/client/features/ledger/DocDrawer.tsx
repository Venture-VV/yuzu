import { useQuery } from '@tanstack/react-query';
import { lastUsableDate } from '@shared/business-date';
import { Link } from 'react-router';
import { ArrowUpRight, Undo2, X } from 'lucide-react';
import { DEDUCTION_RULE_LABELS, ENTRY_TYPE_LABELS, formatPhone, PAYMENT_METHOD_LABELS } from '@shared/labels';
import type { ConsumptionDoc, LedgerRow, RechargeDoc, ReversalDoc } from '@shared/types';
import { api, errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { formatDateTime } from '../../lib/utils';
import { Sheet } from '../../components/Overlay';
import { Money } from '../../components/Money';
import { Badge, Button, IconButton, Notice, Skeleton } from '../../components/ui';
import { BalanceChange, SummaryRow } from '../flows/parts';
import type { ReversalTarget } from '../flows/ReversalDialog';
import { ENTRY_META } from '../workbench/ActivityList';

/** 流水单据详情：充值单 / 消费单 / 撤销单，含余额变化与关联单据 */
export function DocDrawer({
  row,
  onClose,
  onReverse,
}: {
  row: LedgerRow | null;
  onClose: () => void;
  onReverse: (target: ReversalTarget) => void;
}) {
  const can = useCan();
  const url =
    row?.entryType === 'recharge'
      ? `/api/recharges/${row.rechargeId}`
      : row?.entryType === 'consume'
        ? `/api/consumptions/${row.consumptionId}`
        : row?.entryType === 'reversal'
          ? `/api/reversals/${row.reversalId}`
          : null;
  const doc = useQuery({
    queryKey: ['doc', url],
    queryFn: () => api.get<RechargeDoc | ConsumptionDoc | ReversalDoc>(url!),
    enabled: !!url,
  });
  const original = useQuery({
    queryKey: ['consumption', row?.consumptionId],
    queryFn: () => api.get<ConsumptionDoc>(`/api/consumptions/${row!.consumptionId}`),
    enabled: row?.entryType === 'reversal' && !!row.consumptionId,
  });

  if (!row) return null;
  const meta = ENTRY_META[row.entryType];
  const Icon = meta.icon;
  const before = { principal: row.principalAfter - row.principalDelta, bonus: row.bonusAfter - row.bonusDelta };
  const after = { principal: row.principalAfter, bonus: row.bonusAfter };

  return (
    <Sheet open={!!row} onClose={onClose} label="单据详情" width="w-[min(480px,100vw)]">
      <header className="flex items-start gap-3 border-b border-line bg-card px-5 py-4">
        <span className={`flex size-10 shrink-0 items-center justify-center rounded-full ${meta.tone}`}>
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-semibold text-ink-3">{ENTRY_TYPE_LABELS[row.entryType]}单</p>
          <p className="num text-[18px] font-bold">{row.docNo}</p>
        </div>
        <IconButton label="关闭" onClick={onClose} className="-mr-2">
          <X className="size-[18px]" />
        </IconButton>
      </header>

      <div className="scroll-thin flex-1 space-y-4 overflow-y-auto p-5">
        <div className="rounded-lg border border-line bg-card px-4 py-1">
          <SummaryRow label="会员">
            <Link to={`/?m=${row.memberId}`} className="inline-flex items-center gap-1 text-pine hover:underline">
              {row.memberName} <ArrowUpRight className="size-3.5" />
            </Link>
          </SummaryRow>
          <SummaryRow label="手机号">
            <span className="num">{formatPhone(row.memberPhone)}</span>
          </SummaryRow>
          <SummaryRow label="时间">{formatDateTime(row.createdAt)}</SummaryRow>
          <SummaryRow label="营业日">
            <span className="num">{row.businessDate}</span>
          </SummaryRow>
          <SummaryRow label="经办">{row.operatorName}</SummaryRow>
        </div>

        {row.entryType === 'opening' || row.entryType === 'opening_void' ? (
          <Notice tone={row.entryType === 'opening' ? 'info' : 'warning'} title={row.entryType === 'opening' ? '旧系统余额期初导入' : '期初作废'}>
            {row.summary}。期初是从旧系统迁入的余额，不是收款，也不计入充值实收。
          </Notice>
        ) : row.entryType === 'expire' ? (
          <Notice tone="info" title="赠金到期作废">
            到期未用完的赠金由系统作废，只减赠金、不动本金，不是收款或退款。{row.summary.includes('撤销') ? '这笔是撤销消费时恢复到了已到期的赠金批次，随即作废。' : ''}
          </Notice>
        ) : doc.isPending ? (
          <Skeleton className="h-32" />
        ) : doc.error ? (
          <Notice tone="error" title={errorMessage(doc.error)} />
        ) : row.entryType === 'recharge' ? (
          <RechargeBody d={doc.data as RechargeDoc} />
        ) : row.entryType === 'consume' ? (
          <ConsumeBody d={doc.data as ConsumptionDoc} />
        ) : (
          <ReversalBody d={doc.data as ReversalDoc} original={original.data} />
        )}

        <div>
          <p className="mb-2 text-[13px] font-bold text-ink-2">这笔流水的余额变化</p>
          <BalanceChange before={before} after={after} />
        </div>
      </div>

      {row.entryType === 'consume' && row.consumptionStatus === 'completed' && can('consume.reverse') && row.consumptionId && (
        <footer className="border-t border-line bg-card px-5 py-4">
          <Button variant="danger" className="w-full" icon={<Undo2 className="size-4" />} onClick={() => onReverse({ consumptionId: row.consumptionId!, memberId: row.memberId, memberName: row.memberName })}>
            撤销这张消费单
          </Button>
        </footer>
      )}
    </Sheet>
  );
}

function RechargeBody({ d }: { d: RechargeDoc }) {
  const session = useSession();
  return (
    <div className="rounded-lg border border-line bg-card px-4 py-1">
      <SummaryRow label="实收金额">
        <Money cents={d.paidAmount} className="text-[16px] text-lake" />
      </SummaryRow>
      <SummaryRow label="收款方式">{PAYMENT_METHOD_LABELS[d.paymentMethod]}</SummaryRow>
      <SummaryRow label="充值方案">{d.planName ?? '自定义金额'}</SummaryRow>
      <SummaryRow label="赠金">
        <Money cents={d.bonusAmount} className="text-yuzu-deep" signed />
      </SummaryRow>
      {d.bonusAmount > 0 && (
        <SummaryRow label="赠金有效期">
          {d.bonusExpiresAt ? `至 ${lastUsableDate(d.bonusExpiresAt, session.timezone, session.rules.businessDayStartHour)}` : '长期有效'}
        </SummaryRow>
      )}
      {d.overLimitApproverName && <SummaryRow label="超限授权">{d.overLimitApproverName}</SummaryRow>}
      {d.paymentRef && <SummaryRow label="收款备注">{d.paymentRef}</SummaryRow>}
      {d.note && <SummaryRow label="备注">{d.note}</SummaryRow>}
    </div>
  );
}

function ConsumeBody({ d }: { d: ConsumptionDoc }) {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-line bg-card px-4 py-1">
        {d.lines.map((l) => (
          <SummaryRow key={l.id} label={`${l.name}${l.quantity > 1 ? ` ×${l.quantity}` : ''}`}>
            <Money cents={l.amount} />
          </SummaryRow>
        ))}
        <SummaryRow label="合计" className="border-t border-dashed border-line">
          <Money cents={d.totalAmount} className="text-[16px]" />
        </SummaryRow>
        <SummaryRow label="扣本金 / 扣赠金">
          <Money cents={d.principalAmount} className="text-pine" /> <span className="text-ink-4">/</span>{' '}
          <Money cents={d.bonusAmount} className="text-yuzu-deep" />
        </SummaryRow>
        <SummaryRow label="扣款规则">{DEDUCTION_RULE_LABELS[d.deductionRule].title}</SummaryRow>
        {d.note && <SummaryRow label="备注">{d.note}</SummaryRow>}
      </div>
      {d.status === 'reversed' && d.reversal && (
        <Notice tone="error" title="此单已撤销">
          撤销单 <span className="num font-semibold">{d.reversal.docNo}</span> · {d.reversal.operatorName} · {formatDateTime(d.reversal.createdAt)}
          <br />
          原因：{d.reversal.reason}
        </Notice>
      )}
    </div>
  );
}

function ReversalBody({ d, original }: { d: ReversalDoc; original?: ConsumptionDoc }) {
  const crossDay = original && original.businessDate !== d.businessDate;
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-line bg-card px-4 py-1">
        <SummaryRow label="原消费单">
          <span className="num">{d.consumptionDocNo}</span>
        </SummaryRow>
        {original && (
          <SummaryRow label="原单营业日">
            <span className="num">{original.businessDate}</span> {crossDay && <Badge tone="ember">跨日</Badge>}
          </SummaryRow>
        )}
        <SummaryRow label="恢复本金">
          <Money cents={d.principalAmount} className="text-pine" signed />
        </SummaryRow>
        <SummaryRow label="恢复赠金">
          <Money cents={d.bonusAmount} className="text-yuzu-deep" signed />
        </SummaryRow>
        <SummaryRow label="撤销原因">{d.reason}</SummaryRow>
        {d.expiredBonus && (
          <SummaryRow label="恢复后随即作废">
            <span className="text-clay">
              <Money cents={d.expiredBonus.amount} /> 赠金已过期 · <span className="num">{d.expiredBonus.docNo}</span>
            </span>
          </SummaryRow>
        )}
      </div>
      {original && (
        <p className="text-[12.5px] text-ink-3">
          原单内容：{original.lines.map((l) => `${l.name}${l.quantity > 1 ? `×${l.quantity}` : ''}`).join('、')} · 原经办 {original.operatorName}
        </p>
      )}
    </div>
  );
}
