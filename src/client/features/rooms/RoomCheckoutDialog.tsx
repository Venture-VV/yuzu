// 只住房的客人退房结账（S7）：勾选一起结的房 → 核对每间房的房费（含此刻要补的）→ 登记收款 → 确认结清。
// 收款与手牌结账、桌台结账同一套（可组合多种方式；储值只能用这几间房登记的会员；「优惠 / 免单」由值班经理及以上当场授权），
// 另有「押金抵扣」：不超过这几间房的押金余额，先抵扫码、银行卡收的部分；余下的押金在结清时原路退回（现金从本班钱箱退）。
// 应收合计以服务端为准（过了退房时间要补的房费会变），变化时拒绝并重新核对。反结账在「结账记录」里（房间须仍空着）。

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Banknote, CircleCheck } from 'lucide-react';
import { CHECKOUT_METHOD_LABELS, type CheckoutDetail } from '@shared/checkout';
import { discountGrantFits, sortedVisitIds } from '@shared/grants';
import { PAYMENT_METHOD_LABELS } from '@shared/labels';
import { formatYuan } from '@shared/money';
import { MAX_ROOMS_PER_CHECKOUT, type RoomBoard, type RoomCheckoutPreview } from '@shared/rooms';
import { errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn, formatDateTime } from '../../lib/utils';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { Button, Notice, Skeleton, Textarea } from '../../components/ui';
import { CheckoutReceipt } from '../frontdesk/CheckoutDialog';
import { PaymentsSection, usePayRows } from '../frontdesk/payments';
import { PendingPanel, useFrontdeskOp } from '../frontdesk/pending';
import { PrintButton } from '../print/PrintButton';
import { SHIFT_ERRORS, shiftKeys, ShiftGate, useShiftReady } from '../shift/ShiftGate';
import { guestOf } from './parts';
import { roomsKey, useRoomCheckoutPreview } from './queries';

const ROOM_WALLET_HINT = { none: '这几间房没有登记会员。', rule: '只能用这几间房登记的会员储值支付；要用储值，请先在入住单里「改登记」登记会员' };

export function RoomCheckoutDialog({
  open,
  stayId,
  board,
  onClose,
  onDone,
}: {
  open: boolean;
  /** 发起退房结账的那间房的入住单 */
  stayId: number;
  board: RoomBoard;
  onClose: () => void;
  onDone: (detail: CheckoutDetail) => void;
}) {
  const session = useSession();
  const can = useCan();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<number[]>([stayId]);
  const [showAll, setShowAll] = useState(false);
  const [note, setNote] = useState('');
  const [result, setResult] = useState<CheckoutDetail | null>(null);
  const shiftReady = useShiftReady(open);
  const preview = useRoomCheckoutPreview(selected, open && !result);
  const op = useFrontdeskOp<CheckoutDetail>({
    type: 'room_checkout',
    visitId: null,
    stayId,
    staffName: session.staff.displayName,
    pick: (found) => (found.type === 'room_checkout' ? found.checkout : null),
  });

  useResetOnOpen(open, () => {
    setSelected([stayId]);
    setShowAll(false);
    setNote('');
    setResult(null);
    op.clearError();
  });

  // 服务端拒绝（过了退房时间要补的房费变了、押金或余额变化）后重新取一次核对数据；没有开班或班次刚交班时刷新当前班次
  useEffect(() => {
    if (op.state.phase === 'error' && ['PRICE_CHANGED', 'SPLIT_CHANGED', 'INSUFFICIENT_BALANCE', 'DEPOSIT_INSUFFICIENT', 'STAY_CLOSED'].includes(op.state.code ?? '')) {
      void preview.refetch();
    }
    if (op.state.phase === 'error' && SHIFT_ERRORS.includes(op.state.code ?? '')) void qc.invalidateQueries({ queryKey: shiftKeys.all });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [op.state]);

  // 结清后（含查回待确认的结账）：房间变待打扫，交班表的汇总随之变化
  useEffect(() => {
    if (!result) return;
    void qc.invalidateQueries({ queryKey: roomsKey });
    void qc.invalidateQueries({ queryKey: shiftKeys.all });
    void qc.invalidateQueries({ queryKey: ['frontdesk', 'checkouts'] });
  }, [result, qc]);

  const locked = op.locked;
  const p = preview.data;
  const total = p ? p.totalAmount : null;
  const stayIds = p ? p.stays.map((s) => s.stayId) : selected;
  const pay = usePayRows({
    open,
    total,
    members: p?.members ?? null,
    grantFits: (grant, cents) => discountGrantFits(grant, [], cents, Date.now(), [], stayIds),
    backfill: false,
    scopeName: '房间',
    locked,
    onEdit: op.clearError,
    deposit: p ? p.depositBalance : null,
  });
  const { remaining, problems } = pay;
  const ready = total !== null && remaining === 0 && pay.ok && !preview.isFetching && shiftReady.ready;
  const rooms = (p?.stays ?? []).map((s) => s.roomNo);
  const depositUsed = pay.rows.reduce((sum, r, i) => sum + (r.method === 'deposit' ? (pay.rowCents[i] ?? 0) : 0), 0);
  const depositBack = p ? Math.max(0, p.depositBalance - depositUsed) : 0;

  // 这几间房之外，还可以合并结的：只住房的客人在住的其他房间
  const choices = board.rooms.filter((r) => r.stay && r.stay.visitId === null).map((r) => ({ stayId: r.stay!.id, roomNo: r.roomNo, guests: r.stay!.guests }));
  if (!choices.some((c) => c.stayId === stayId)) {
    const s = p?.stays.find((x) => x.stayId === stayId);
    choices.unshift({ stayId, roomNo: s?.roomNo ?? '', guests: s?.guests ?? 1 });
  }
  const shown = choices.filter((c) => showAll || selected.includes(c.stayId));

  const toggle = (id: number) => {
    if (locked) return;
    op.clearError();
    setSelected((s) => (s.includes(id) ? (s.length > 1 ? s.filter((x) => x !== id) : s) : s.length >= MAX_ROOMS_PER_CHECKOUT ? s : [...s, id]));
  };

  const submit = async () => {
    if (!ready || !p) return;
    const ids = p.stays.map((s) => s.stayId);
    const detail = await op.submit((key) => ({
      url: '/api/rooms/checkout',
      body: { clientKey: key, stayIds: ids, expectedTotal: total!, payments: pay.payments(), note: note.trim() },
      tagCodes: p.stays.map((s) => `房 ${s.roomNo}`),
      summary: `退房结账 ${ids.length} 间（${pay.methods.join(' + ') || '免收'}）`,
      amount: total!,
      stayIds: ids,
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
            <CircleCheck className="size-5" /> 已退房结账 · {result.checkoutNo}
          </span>
        }
        footer={
          <>
            <PrintButton path={`/print/checkout/${result.id}`} size="lg" testId="checkout-print">
              打印结账单
            </PrintButton>
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
  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      width="max-w-3xl"
      title={
        <span className="flex items-center gap-2">
          <Banknote className="size-5 text-pine" /> 退房结账
        </span>
      }
      description="勾选一起结的房，核对房费（含此刻要补的）后登记收款；可以用押金抵扣，余下的押金结清时原路退回"
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
      <div className="space-y-4" data-testid="room-checkout">
        <ShiftGate action="退房结账" />
        <div>
          <div className="flex flex-wrap gap-1.5">
            {shown.map((c) => {
              const on = selected.includes(c.stayId);
              return (
                <button
                  key={c.stayId}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(c.stayId)}
                  className={cn(
                    'flex h-10 items-center gap-1.5 rounded-full border px-3 text-[14px] font-bold',
                    on ? 'border-pine bg-pine text-paper' : 'border-line bg-card text-ink-2 hover:border-line-strong',
                  )}
                  data-testid={`room-checkout-pick-${c.roomNo}`}
                >
                  {on ? <CircleCheck className="size-4" /> : <span className="size-4 rounded-full border-2 border-line-strong" />}
                  <span className="num">{c.roomNo}</span>
                  <span className="text-[11.5px] font-semibold opacity-70">{c.guests} 人</span>
                </button>
              );
            })}
          </div>
          {!showAll && choices.length > shown.length && (
            <button type="button" onClick={() => setShowAll(true)} className="mt-2 text-[13px] font-semibold text-pine hover:underline" data-testid="room-checkout-more">
              + 合并其他房间一起结（共 {choices.length} 间只住房的客人在住，一次最多 {MAX_ROOMS_PER_CHECKOUT} 间）
            </button>
          )}
        </div>

        {preview.isPending ? (
          <Skeleton className="h-40" />
        ) : preview.error ? (
          <Notice tone="error" title={errorMessage(preview.error)} />
        ) : (
          p && <RoomReview preview={p} />
        )}

        <PaymentsSection
          pay={pay}
          total={total}
          members={p?.members ?? []}
          canWallet={can('consume.create')}
          walletHint={ROOM_WALLET_HINT}
          authorize={(amount, reason) => ({
            request: { purpose: 'checkout_discount', scope: { visitIds: [], roomStayIds: sortedVisitIds(stayIds), amount, reason } },
            lines: [`房间 ${rooms.join('、')} · 应收 ${total !== null ? formatYuan(total) : ''}`, `${CHECKOUT_METHOD_LABELS.discount} ${formatYuan(amount)}`, `原因：${reason}`],
          })}
        />
        {p && p.depositBalance > 0 && (
          <p className="text-[12.5px] text-ink-3" data-testid="room-checkout-deposit-back">
            押金 <Money cents={p.depositBalance} />
            {depositUsed > 0 && (
              <>
                {' '}
                · 抵扣 <Money cents={Math.min(depositUsed, p.depositBalance)} />
              </>
            )}{' '}
            · 结清时原路退回 <Money cents={depositBack} className="font-bold text-ink" />
            {depositBack > 0 && `（${p.depositByMethod.map((m) => PAYMENT_METHOD_LABELS[m.method]).join('、')}收的按原方式退，现金从你当班的钱箱退）`}
          </p>
        )}

        <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="备注（选填）" maxLength={200} aria-label="结账备注" className="min-h-[44px]" />
        {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} />}
      </div>
    </Dialog>
  );
}

/** 核对：每间房的明细、退房时补挂的房费与小计 */
function RoomReview({ preview }: { preview: RoomCheckoutPreview }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line" data-testid="room-checkout-review">
      <ul className="divide-y divide-line/70">
        {preview.stays.map((s) => (
          <li key={s.stayId} className="px-3 py-2.5">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="num text-[15px] font-bold">{s.roomNo}</span>
              <span className="text-[12.5px] text-ink-3">
                {s.typeName} · {s.guests} 人 · {guestOf(s)} · {formatDateTime(s.checkedInAt)} 入住
              </span>
              <span className="flex-1" />
              <Money cents={s.amount} className="text-[15px] font-bold" />
            </div>
            <ul className="mt-1 space-y-0.5 text-[12.5px] text-ink-2">
              {s.lines.map((l) => (
                <li key={l.id} className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate">
                    {l.name}
                    {l.quantity !== 1 && ` × ${l.quantity}`}
                  </span>
                  <Money cents={l.amount} className="text-ink-3" />
                </li>
              ))}
              {s.dues.map((d, i) => (
                <li key={`due-${i}`} className="flex items-baseline gap-2 font-semibold text-yuzu-deep" data-testid="room-checkout-due">
                  <span className="min-w-0 flex-1 truncate">{d.name}（退房时补挂）</span>
                  <Money cents={d.amount} />
                </li>
              ))}
              {s.lines.length === 0 && s.dues.length === 0 && <li className="text-ink-3">没有房费</li>}
            </ul>
          </li>
        ))}
      </ul>
      <p className="flex items-baseline justify-between border-t border-line bg-paper/60 px-3 py-2.5 text-[13px]">
        <span className="font-bold">应收合计</span>
        <span data-testid="room-checkout-total">
          <Money cents={preview.totalAmount} className="text-[20px] font-bold text-pine" />
        </span>
      </p>
    </div>
  );
}
