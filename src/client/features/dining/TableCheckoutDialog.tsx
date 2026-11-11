// 桌台结账（S5 第二步）：勾选要一起结的几桌 → 核对明细 → 登记收款 → 确认结清，桌台空出来。
// 收款与手牌结账相同（同一套收款区）：可组合多种方式；储值只能用这几桌登记的会员；「优惠 / 免单」由值班经理及以上
// 当场授权（这几桌、这个金额）；收款前先开班。应收合计、储值扣款构成以服务端为准，变化时拒绝并重新核对。
// 反结账在「结账记录」里，与手牌结账相同（桌台须仍空闲）。

import { invalidateRevenue } from '../../lib/revenue';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Banknote, CircleCheck } from 'lucide-react';
import { CHECKOUT_METHOD_LABELS, type CheckoutDetail } from '@shared/checkout';
import type { CheckoutCouponOption } from '@shared/coupons';
import { KITCHEN_STATUS_LABELS, MAX_TABLES_PER_CHECKOUT, type TableCheckoutPreview } from '@shared/dining';
import { discountGrantFits, sortedVisitIds } from '@shared/grants';
import { formatYuan } from '@shared/money';
import { api, errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn, formatTime } from '../../lib/utils';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { Button, Notice, Skeleton, Textarea } from '../../components/ui';
import { CheckoutReceipt } from '../frontdesk/CheckoutDialog';
import { PaymentsSection, usePayRows } from '../frontdesk/payments';
import { PendingPanel, useFrontdeskOp } from '../frontdesk/pending';
import { PrintButton } from '../print/PrintButton';
import { NetPrintButton } from '../print/NetPrintButton';
import { SHIFT_ERRORS, shiftKeys, ShiftGate, useShiftReady } from '../shift/ShiftGate';
import { tablesKey, useTableCheckoutPreview } from './queries';

/** 用餐中的一桌（可以合并结账的候选） */
export interface OpenTableChoice {
  sessionId: number;
  tableName: string;
  guests: number;
}

const TABLE_WALLET_HINT = { none: '这几桌没有登记会员。', rule: '只能用这几桌登记的会员储值支付；要用储值，请先在桌台详情里登记会员' };

export function TableCheckoutDialog({
  open,
  sessionId,
  choices,
  onClose,
  onDone,
}: {
  open: boolean;
  /** 发起结账的那桌 */
  sessionId: number;
  /** 用餐中的桌：可以合并到同一张结账单 */
  choices: OpenTableChoice[];
  onClose: () => void;
  onDone: (detail: CheckoutDetail) => void;
}) {
  const session = useSession();
  const can = useCan();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<number[]>([sessionId]);
  const [showAll, setShowAll] = useState(false);
  const [note, setNote] = useState('');
  const [result, setResult] = useState<CheckoutDetail | null>(null);
  const shiftReady = useShiftReady(open);
  const preview = useTableCheckoutPreview(selected, open && !result);
  const op = useFrontdeskOp<CheckoutDetail>({
    type: 'table_checkout',
    visitId: null,
    sessionId,
    staffName: session.staff.displayName,
    pick: (found) => (found.type === 'table_checkout' ? found.checkout : null),
  });

  useResetOnOpen(open, () => {
    setSelected([sessionId]);
    setShowAll(false);
    setNote('');
    setResult(null);
    op.clearError();
  });

  // 服务端拒绝（这几桌刚点了菜或退了菜、余额变化）后重新取一次核对数据；没有开班或班次刚交班时刷新当前班次
  useEffect(() => {
    if (
      op.state.phase === 'error' &&
      ['PRICE_CHANGED', 'SPLIT_CHANGED', 'INSUFFICIENT_BALANCE', 'TABLE_CLOSED', 'COUPON_AMOUNT_CHANGED', 'COUPON_USED', 'COUPON_NOT_USABLE', 'COUPON_VOIDED'].includes(op.state.code ?? '')
    ) {
      void preview.refetch();
    }
    if (op.state.phase === 'error' && SHIFT_ERRORS.includes(op.state.code ?? '')) void qc.invalidateQueries({ queryKey: shiftKeys.all });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [op.state]);

  // 结清后（含查回待确认的结账）：桌台空出来，交班表的汇总随之变化
  useEffect(() => {
    if (!result) return;
    void qc.invalidateQueries({ queryKey: tablesKey });
    invalidateRevenue(qc);
  }, [result, qc]);

  const locked = op.locked;
  const p = preview.data;
  const total = p ? p.totalAmount : null;
  const sessionIds = p ? p.sessions.map((s) => s.sessionId) : selected;
  const pay = usePayRows({
    open,
    total,
    members: p?.members ?? null,
    grantFits: (grant, cents) => discountGrantFits(grant, [], cents, Date.now(), sessionIds),
    backfill: false,
    scopeName: '桌台',
    locked,
    onEdit: op.clearError,
    coupons: p?.storeCoupons ?? null,
  });
  const { remaining, problems } = pay;
  const ready = total !== null && remaining === 0 && pay.ok && !preview.isFetching && shiftReady.ready;
  const names = (p?.sessions ?? []).map((s) => s.tableName);

  const toggle = (id: number) => {
    if (locked) return;
    op.clearError();
    setSelected((s) => (s.includes(id) ? (s.length > 1 ? s.filter((x) => x !== id) : s) : s.length >= MAX_TABLES_PER_CHECKOUT ? s : [...s, id]));
  };

  const submit = async () => {
    if (!ready || !p) return;
    const ids = p.sessions.map((s) => s.sessionId);
    const tagCodes = p.sessions.map((s) => `桌 ${s.tableName}`);
    const detail = await op.submit((key) => ({
      url: '/api/dining/tables/checkout',
      body: { clientKey: key, sessionIds: ids, expectedTotal: total!, payments: pay.payments(), note: note.trim() },
      tagCodes,
      summary: `桌台结账 ${ids.length} 桌（${pay.methods.join(' + ') || '免收'}）`,
      amount: total!,
      sessionIds: ids,
    }));
    if (detail) setResult(detail);
  };

  if (result) {
    return (
      <Dialog
        open={open}
        onClose={() => onDone(result)}
        width="max-w-xl"
        title={
          <span className="flex items-center gap-2 text-pine">
            <CircleCheck className="size-5" /> 已结清 · {result.checkoutNo}
          </span>
        }
        footer={
          <>
            <PrintButton path={`/print/checkout/${result.id}`} size="lg" testId="checkout-print">
              打印结账单
            </PrintButton>
            <NetPrintButton doc={{ type: 'checkout', id: result.id }} size="lg" testId="checkout-netprint" />
            <Button variant="primary" size="lg" onClick={() => onDone(result)} data-testid="checkout-finish">
              完成
            </Button>
          </>
        }
      >
        <CheckoutReceipt detail={result} />
      </Dialog>
    );
  }

  const busy = op.busy;
  const shown = choices.filter((c) => showAll || selected.includes(c.sessionId));
  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      width="max-w-3xl"
      title={
        <span className="flex items-center gap-2">
          <Banknote className="size-5 text-pine" /> 桌台结账
        </span>
      }
      description="勾选一起结的桌，核对明细后登记收款；收款合计等于应收才能结清，结清后桌台空出来"
      footer={
        <>
          <span className="mr-auto self-center text-[13px] text-ink-3">
            {remaining === null ? (
              '正在核对…'
            ) : remaining > 0 ? (
              <>
                还差 <Money cents={remaining} className="font-bold text-clay" />
              </>
            ) : remaining < 0 ? (
              <>
                多收 <Money cents={-remaining} className="font-bold text-clay" />（现金找零不用登记，按应收记）
              </>
            ) : problems.some(Boolean) ? (
              <span className="font-semibold text-clay" data-testid="checkout-row-problem">
                {problems.find(Boolean)}
              </span>
            ) : (
              <span className="font-semibold text-pine">收款已等于应收</span>
            )}
          </span>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" size="lg" disabled={!ready || locked} loading={busy} onClick={submit} data-testid="checkout-submit">
            确认结清{total !== null ? ` ¥${(total / 100).toFixed(2)}` : ''}
          </Button>
        </>
      }
    >
      <PendingPanel op={op} onResolved={(d) => setResult(d)} />
      <div className="space-y-4" data-testid="table-checkout">
        <ShiftGate action="结账" />
        {/* 桌 */}
        <div>
          <div className="flex flex-wrap gap-1.5">
            {shown.map((c) => {
              const on = selected.includes(c.sessionId);
              return (
                <button
                  key={c.sessionId}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(c.sessionId)}
                  className={cn(
                    'flex h-10 items-center gap-1.5 rounded-full border px-3 text-[14px] font-bold',
                    on ? 'border-pine bg-pine text-paper' : 'border-line bg-card text-ink-2 hover:border-line-strong',
                  )}
                  data-testid={`table-checkout-pick-${c.tableName}`}
                >
                  {on ? <CircleCheck className="size-4" /> : <span className="size-4 rounded-full border-2 border-line-strong" />}
                  <span className="num">桌 {c.tableName}</span>
                  <span className="text-[11.5px] font-semibold opacity-70">{c.guests} 人</span>
                </button>
              );
            })}
          </div>
          {!showAll && choices.length > shown.length && (
            <button type="button" onClick={() => setShowAll(true)} className="mt-2 text-[13px] font-semibold text-pine hover:underline" data-testid="table-checkout-more">
              + 合并其他桌一起结（共 {choices.length} 桌用餐中，一次最多 {MAX_TABLES_PER_CHECKOUT} 桌）
            </button>
          )}
        </div>

        {/* 核对 */}
        {preview.isPending ? (
          <Skeleton className="h-40" />
        ) : preview.error ? (
          <Notice tone="error" title={errorMessage(preview.error)} />
        ) : (
          p && (
            <>
              {p.dishes.length > 0 && <TableDishesNotice dishes={p.dishes} />}
              <TableReview preview={p} />
            </>
          )
        )}

        {/* 收款 */}
        <PaymentsSection
          pay={pay}
          total={total}
          members={p?.members ?? []}
          canWallet={can('consume.create')}
          walletHint={TABLE_WALLET_HINT}
          coupons={{
            options: p?.storeCoupons ?? [],
            check: async (code) => {
              const r = await api.post<{ found: boolean; option?: CheckoutCouponOption }>('/api/frontdesk/checkout-coupon', { tableSessionIds: sessionIds, code });
              return r.found ? r.option! : null;
            },
          }}
          authorize={(amount, reason) => ({
            request: { purpose: 'checkout_discount', scope: { visitIds: [], tableSessionIds: sortedVisitIds(sessionIds), amount, reason } },
            lines: [`桌台 ${names.join('、')} · 应收 ${total !== null ? formatYuan(total) : ''}`, `${CHECKOUT_METHOD_LABELS.discount} ${formatYuan(amount)}`, `原因：${reason}`],
          })}
        />

        <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="备注（选填）" maxLength={200} aria-label="结账备注" className="min-h-[44px]" />
        {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} />}
      </div>
    </Dialog>
  );
}

/** 这几桌点的菜还没上齐时提醒（不拦结账；结账后厨房屏标出「这桌已结账」） */
function TableDishesNotice({ dishes }: { dishes: TableCheckoutPreview['dishes'] }) {
  const one = new Set(dishes.map((d) => d.tableName)).size === 1;
  return (
    <div data-testid="checkout-dishes">
      <Notice tone="warning" title={`${one ? '这桌' : '这几桌'}点的菜还没上齐：请先问客人还要不要，不要的先退菜再结账`}>
        <ul className="mt-1 space-y-0.5">
          {dishes.map((d, i) => (
            <li key={i}>
              <span className="num font-semibold">桌 {d.tableName}</span> · {d.name} × {d.quantity} · {KITCHEN_STATUS_LABELS[d.status]}
            </li>
          ))}
        </ul>
      </Notice>
    </div>
  );
}

/** 核对：每桌的明细与小计 */
function TableReview({ preview }: { preview: TableCheckoutPreview }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line" data-testid="table-checkout-review">
      <ul className="divide-y divide-line/70">
        {preview.sessions.map((s) => (
          <li key={s.sessionId} className="px-3 py-2.5">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="num text-[15px] font-bold">桌 {s.tableName}</span>
              <span className="text-[12.5px] text-ink-3">
                {s.guests} 人 · {s.memberName ?? (s.guestLabel || '散客')} · {formatTime(s.openedAt)} 开台
              </span>
              <span className="flex-1" />
              <Money cents={s.amount} className="text-[15px] font-bold" />
            </div>
            {s.lines.length === 0 ? (
              <p className="mt-1 text-[12.5px] text-ink-3">没有消费</p>
            ) : (
              <ul className="mt-1 space-y-0.5 text-[12.5px] text-ink-2">
                {s.lines.map((l) => (
                  <li key={l.id} className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate">
                      {l.name} × {l.quantity}
                    </span>
                    <Money cents={l.amount} className="text-ink-3" />
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      <p className="flex items-baseline justify-between border-t border-line bg-paper/60 px-3 py-2.5 text-[13px]">
        <span className="font-bold">应收合计</span>
        <span data-testid="table-checkout-total">
          <Money cents={preview.totalAmount} className="text-[20px] font-bold text-pine" />
        </span>
      </p>
    </div>
  );
}
