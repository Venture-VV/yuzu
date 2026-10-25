import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Undo2 } from 'lucide-react';
import { DEDUCTION_RULE_LABELS, REVERSAL_REASONS } from '@shared/labels';
import type { ConsumptionDoc } from '@shared/types';
import { api, errorMessage } from '../../lib/api';
import { findPending } from '../../lib/pendingOps';
import { useSession } from '../../lib/session';
import { cn, formatDateTime } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { Money } from '../../components/Money';
import { Badge, Button, Field, Notice, Skeleton, Textarea } from '../../components/ui';
import { BalanceChange, OperationStatus, PendingRecovery, SuccessHeader, SummaryRow } from './parts';
import { isBusy, isLocked, useOperation } from './useOperation';

export interface ReversalTarget {
  consumptionId: number;
  memberId: number;
  memberName: string;
}

/** 整单撤销：按原单的本金/赠金构成恢复余额，原单保留并标记为已撤销 */
export function ReversalDialog({ target, onClose }: { target: ReversalTarget | null; onClose: () => void }) {
  const session = useSession();
  const consumptionId = target?.consumptionId ?? null;
  const open = target !== null;
  const doc = useQuery({
    queryKey: ['consumption', consumptionId],
    queryFn: () => api.get<ConsumptionDoc>(`/api/consumptions/${consumptionId}`),
    enabled: open,
  });
  const [preset, setPreset] = useState<string | null>(null);
  const [detail, setDetail] = useState('');
  const reason = [preset, detail.trim()].filter(Boolean).join('：');

  const op = useOperation({
    type: 'reversal',
    url: `/api/consumptions/${consumptionId}/reverse`,
    build: (idempotencyKey) => ({
      body: { idempotencyKey, reason },
      meta: {
        memberId: target?.memberId ?? 0,
        memberName: target?.memberName ?? '',
        consumptionId: consumptionId ?? undefined,
        amount: doc.data ? doc.data.principalAmount + doc.data.bonusAmount : 0,
        summary: `${doc.data?.docNo ?? ''} · ${reason}`,
        staffName: session.staff.displayName,
      },
    }),
  });

  useEffect(() => {
    if (!target) {
      // 对话框关闭：未确认的撤销交给页面顶部的提醒继续处理
      op.reset();
      return;
    }
    setPreset(null);
    setDetail('');
    op.reset();
    // 这张消费单有之前留下的待确认撤销：先查回结果
    const pending = findPending(target.memberId, 'reversal', target.consumptionId);
    if (pending) op.adopt(pending);
  }, [consumptionId]); // 只在切换撤销对象时检查

  const busy = isBusy(op.state);
  const locked = isLocked(op.state);
  const recovering = !!op.adopted && op.state.status !== 'success';
  const done = op.state.status === 'success';
  const c = doc.data;

  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      dismissible={!busy}
      title={done ? '撤销完成' : '撤销消费（整单）'}
      description={done ? undefined : '撤销后按原单扣款构成恢复余额，原单保留并标记为已撤销。'}
      footer={
        done ? (
          <Button variant="primary" onClick={onClose} data-autofocus>
            完成
          </Button>
        ) : recovering ? (
          <Button variant="secondary" onClick={onClose} disabled={op.state.status === 'submitting'}>
            稍后处理
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              取消
            </Button>
            <Button
              variant="danger"
              icon={<Undo2 className="size-4" />}
              loading={op.state.status === 'submitting'}
              disabled={!c || c.status !== 'completed' || reason.length < 2 || locked}
              onClick={op.submit}
            >
              确认撤销并恢复余额
            </Button>
          </>
        )
      }
    >
      {done && op.state.status === 'success' && op.state.result.type === 'reversal' ? (
        <div>
          <SuccessHeader title="余额已恢复" docNo={op.state.result.reversal.docNo} recovered={op.state.recovered} />
          <BalanceChange before={op.state.result.balanceBefore} after={op.state.result.balanceAfter} animate />
          <p className="mt-3 text-center text-[12.5px] text-ink-3">
            原单 {op.state.result.consumption.docNo} 已标记为已撤销 · 原因：{op.state.result.reversal.reason}
          </p>
        </div>
      ) : recovering && op.adopted ? (
        <PendingRecovery op={op.adopted} state={op.state} onCheck={op.check} onRetry={op.retry} onDiscard={op.discard} />
      ) : doc.isPending ? (
        <div className="space-y-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-16" />
        </div>
      ) : doc.error ? (
        <Notice tone="error" title={errorMessage(doc.error)} />
      ) : c ? (
        <div className="space-y-5">
          <div className="rounded-lg border border-line bg-paper/60 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="num text-[14px] font-bold">{c.docNo}</p>
                <p className="mt-0.5 text-[12.5px] text-ink-3">
                  {formatDateTime(c.createdAt)} · {c.operatorName} · 营业日 {c.businessDate}
                </p>
              </div>
              {c.status === 'reversed' ? <Badge tone="clay">已撤销</Badge> : <Badge tone="pine">已完成</Badge>}
            </div>
            <div className="mt-3 border-t border-dashed border-line pt-1">
              {c.lines.map((l) => (
                <SummaryRow key={l.id} label={`${l.name}${l.quantity > 1 ? ` ×${l.quantity}` : ''}`}>
                  <Money cents={l.amount} />
                </SummaryRow>
              ))}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2.5">
              <div className="rounded-md bg-pine-tint px-3 py-2">
                <p className="text-[12px] font-semibold text-pine/80">将恢复本金</p>
                <Money cents={c.principalAmount} className="text-[17px] font-bold text-pine" signed />
              </div>
              <div className="rounded-md bg-yuzu-tint px-3 py-2">
                <p className="text-[12px] font-semibold text-yuzu-deep/80">将恢复赠金</p>
                <Money cents={c.bonusAmount} className="text-[17px] font-bold text-yuzu-deep" signed />
              </div>
            </div>
            <p className="mt-2 text-[12px] text-ink-3">原单扣款规则：{DEDUCTION_RULE_LABELS[c.deductionRule].title}</p>
          </div>

          {c.status === 'reversed' ? (
            <Notice tone="info" title="这张消费单已经撤销过了">
              {c.reversal ? `撤销单 ${c.reversal.docNo} · ${c.reversal.operatorName} · ${c.reversal.reason}` : null}
            </Notice>
          ) : (
            <>
              <div>
                <p className="mb-2 text-[13px] font-semibold text-ink-2">撤销原因</p>
                <div className="flex flex-wrap gap-2">
                  {REVERSAL_REASONS.map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setPreset(preset === r ? null : r)}
                      aria-pressed={preset === r}
                      className={cn(
                        'h-9 rounded-full border px-3.5 text-[13px] font-semibold transition-colors',
                        preset === r ? 'border-clay bg-clay-soft text-clay' : 'border-line-strong bg-card text-ink-2 hover:border-ink-4',
                      )}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>
              <Field label="补充说明" htmlFor="rdetail" hint={preset ? '选填' : '未选择常用原因时必填，至少 2 个字'}>
                <Textarea id="rdetail" value={detail} maxLength={150} onChange={(e) => setDetail(e.target.value)} placeholder="例如：应为儿童票，登记成了成人票" />
              </Field>
              <OperationStatus state={op.state} onCheck={op.check} onRetry={op.retry} />
            </>
          )}
        </div>
      ) : null}
    </Dialog>
  );
}
