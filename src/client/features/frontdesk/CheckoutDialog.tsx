import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { Banknote, CircleCheck, Clock3, LogOut, ReceiptText, ShieldCheck, Ticket, Undo2 } from 'lucide-react';
import {
  CHECKOUT_METHOD_LABELS,
  COUPON_PLATFORM_LABELS,
  isFreeTicket,
  priceTicket,
  ticketChangeNeedsGrant,
  type CheckoutDetail,
  type CheckoutPreview,
  type RefundShiftOptions,
} from '@shared/checkout';
import { KITCHEN_STATUS_LABELS } from '@shared/dining';
import { ZONE_LABELS, type BoardTag, type VisitDetail } from '@shared/frontdesk';
import { discountGrantFits, sortedVisitIds, ticketGrantCovers, type TicketGrant, type TicketGrantRequest } from '@shared/grants';
import { describeHours, shiftDate } from '@shared/labels';
import { formatYuan } from '@shared/money';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn, formatDateTime, formatTime } from '../../lib/utils';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { AuthorizeDialog } from '../../components/AuthorizeDialog';
import { DateNav } from '../../components/DateNav';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Input, Notice, Select, Skeleton, Textarea } from '../../components/ui';
import { PrintButton } from '../print/PrintButton';
import { CloseStayById } from '../rooms/CloseStayDialog';
import { SHIFT_ERRORS, shiftKeys, ShiftGate, StartShiftForm, useShiftReady } from '../shift/ShiftGate';
import { ZoneChip } from './parts';
import { BackfillNotice, backfillBody, backfillSummary, useBackfill } from './backfill';
import { PaymentsSection, usePayRows } from './payments';
import { PendingPanel, useFrontdeskOp } from './pending';
import { stayText, useCheckout, useCheckoutPreview, useCheckouts, useRefreshFrontdesk, useTicketTypes } from './queries';

// 结账（S3）：勾选要一起结的手牌 → 核对门票与明细 → 登记收款（可组合）→ 确认结清。
// 应收合计、储值扣款构成以服务端为准：门票刚好跳档、余额或扣款规则变化时服务端拒绝，页面刷新后重新核对。
// R1.2（店主 2026-10-29 签认）：收款前先开班；「优惠 / 免单」由值班经理及以上当场授权（这几张手牌、这个金额），
// 原因随授权填写，店员不能自行抹零；「其他」收款必须填备注。

export function CheckoutDialog({
  open,
  visit,
  tags,
  initialIds,
  onClose,
  onDone,
}: {
  open: boolean;
  visit: VisitDetail;
  tags: BoardTag[];
  /** 从预结账进入时带上已勾选的手牌 */
  initialIds?: number[];
  onClose: () => void;
  onDone: (detail: CheckoutDetail) => void;
}) {
  const session = useSession();
  const can = useCan();
  const [selected, setSelected] = useState<number[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [ticketPick, setTicketPick] = useState<Record<number, number>>({});
  const [note, setNote] = useState('');
  const [result, setResult] = useState<CheckoutDetail | null>(null);
  const shiftReady = useShiftReady(open);
  const qc = useQueryClient();
  // 补录纸质单：按纸质单上的实际离店时间计价；补录的结账不能用会员储值
  const backfill = useBackfill();
  const backfillBlocked = backfill.state.active && !backfill.request;
  const preview = useCheckoutPreview(selected, open && !result && !backfillBlocked, backfill.request?.at);
  const ticketTypes = useTicketTypes();
  const op = useFrontdeskOp<CheckoutDetail>({
    type: 'checkout',
    visitId: visit.id,
    staffName: session.staff.displayName,
    pick: (found) => (found.type === 'checkout' ? found.checkout : null),
  });

  useResetOnOpen(open, () => {
    const mates = visit.group?.mates.filter((m) => m.status === 'open').map((m) => m.visitId) ?? [];
    setSelected(initialIds?.length ? initialIds : mates.length ? mates : [visit.id]);
    setShowAll(false);
    setTicketPick({});
    setNote('');
    setResult(null);
    op.clearError();
  });

  // 服务端拒绝（门票跳档、余额变化）后重新取一次核对数据；没有开班或班次刚交班时刷新当前班次，出现开班提示
  useEffect(() => {
    if (op.state.phase === 'error' && ['PRICE_CHANGED', 'SPLIT_CHANGED', 'INSUFFICIENT_BALANCE', 'TICKET_CHANGED', 'ROOM_OPEN'].includes(op.state.code ?? '')) {
      void preview.refetch();
    }
    if (op.state.phase === 'error' && SHIFT_ERRORS.includes(op.state.code ?? '')) void qc.invalidateQueries({ queryKey: shiftKeys.all });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [op.state]);

  // 结清后（含查回待确认的结账）交班表的汇总随之变化：刷新当前班次，交班页与开班提示共用这份数据
  useEffect(() => {
    if (result) void qc.invalidateQueries({ queryKey: shiftKeys.all });
  }, [result, qc]);

  const locked = op.locked;
  const edit = (fn: () => void) => {
    if (locked) return;
    op.clearError();
    fn();
  };

  const p = preview.data;
  const pricedAt = p ? new Date(p.pricedAt) : new Date();
  // 每位客人的应收：已挂明细 + 门票（没有票种的按补选的票种在页面先算，服务端再核对）
  const amounts = (p?.visits ?? []).map((v) => {
    if (!v.needsTicket) return v.amount;
    const t = ticketTypes.data?.find((x) => x.id === ticketPick[v.visitId]);
    return t ? v.linesAmount + priceTicket(t, v.checkedInAt, pricedAt, p!.graceMinutes).amount : null;
  });
  const total = p && amounts.every((a) => a !== null) ? amounts.reduce<number>((s, a) => s + a!, 0) : null;

  const visitIds = p ? p.visits.map((v) => v.visitId) : selected;
  const pay = usePayRows({
    open,
    total,
    members: p?.members ?? null,
    grantFits: (grant, cents) => discountGrantFits(grant, visitIds, cents),
    backfill: backfill.state.active,
    scopeName: '手牌',
    locked,
    onEdit: op.clearError,
  });
  const { remaining, problems } = pay;
  // 客房（S7）：还住着客房的客人要先退房（补齐房费挂到手牌账单、退押金），房费才都在账单上
  const roomsOpen = (preview.data?.rooms ?? []).length > 0;
  const ready = total !== null && remaining === 0 && pay.ok && !preview.isFetching && shiftReady.ready && !backfillBlocked && !roomsOpen;

  const submit = async () => {
    if (!ready || !p) return;
    const visitIds = p.visits.map((v) => v.visitId);
    const tagCodes = p.visits.map((v) => v.tagCode);
    const payments = pay.payments();
    const detail = await op.submit((key) => ({
      url: '/api/frontdesk/checkouts',
      body: {
        clientKey: key,
        visitIds,
        tickets: p.visits.filter((v) => v.needsTicket).map((v) => ({ visitId: v.visitId, ticketTypeId: ticketPick[v.visitId]! })),
        expectedTotal: total!,
        payments,
        note: note.trim(),
        ...backfillBody(backfill),
      },
      tagCodes,
      summary: `结账 ${tagCodes.length} 张（${pay.methods.join(' + ') || '免收'}）${backfillSummary(backfill)}`,
      amount: total!,
      visitIds,
    }));
    if (detail) setResult(detail);
  };

  const inStore = tags.filter((t) => t.visit);
  const groupIds = new Set(visit.group?.mates.filter((m) => m.status === 'open').map((m) => m.visitId) ?? [visit.id]);
  const choices = inStore.filter((t) => showAll || groupIds.has(t.visit!.id) || selected.includes(t.visit!.id));
  const toggle = (id: number) => edit(() => setSelected((s) => (s.includes(id) ? (s.length > 1 ? s.filter((x) => x !== id) : s) : [...s, id])));
  const busy = op.busy;

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

  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      width="max-w-3xl"
      title={
        <span className="flex items-center gap-2">
          <Banknote className="size-5 text-pine" /> 结账
        </span>
      }
      description="勾选一起结的手牌，核对门票与明细后登记收款；收款合计等于应收才能结清，结清后手牌释放"
      footer={
        <>
          <span className="mr-auto self-center text-[13px] text-ink-3">
            {remaining === null ? (
              '请先为没有票种的客人选择票种'
            ) : remaining > 0 ? (
              <>
                还差 <Money cents={remaining} className="font-bold text-clay" />
              </>
            ) : remaining < 0 ? (
              <>
                多收 <Money cents={-remaining} className="font-bold text-clay" />（现金找零不用登记，按应收记）
              </>
            ) : problems.some(Boolean) ? (
              // 金额对上了但还有收款没填好（例如客人实给少于现金），不写「已等于应收」，免得以为可以结清
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
      <div className="space-y-4" data-testid="checkout">
        <BackfillNotice action="结账" />
        <ShiftGate action="结账" />
        {/* 手牌 */}
        <div>
          <div className="flex flex-wrap gap-1.5">
            {choices.map((t) => {
              const on = selected.includes(t.visit!.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(t.visit!.id)}
                  className={cn(
                    'flex h-10 items-center gap-1.5 rounded-full border px-3 text-[14px] font-bold',
                    on ? 'border-pine bg-pine text-paper' : 'border-line bg-card text-ink-2 hover:border-line-strong',
                  )}
                >
                  {on ? <CircleCheck className="size-4" /> : <span className="size-4 rounded-full border-2 border-line-strong" />}
                  <span className="num">{t.code}</span>
                  <span className="text-[11.5px] font-semibold opacity-70">{ZONE_LABELS[t.zone].short}</span>
                </button>
              );
            })}
          </div>
          {!showAll && inStore.length > choices.length && (
            <button type="button" onClick={() => setShowAll(true)} className="mt-2 text-[13px] font-semibold text-pine hover:underline">
              + 合并其他在店手牌（共 {inStore.length} 张在店）
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
              {(p.sessions ?? []).length > 0 && <SessionsNotice sessions={p.sessions} />}
              {(p.dishes ?? []).length > 0 && <DishesNotice dishes={p.dishes} />}
              {(p.rooms ?? []).length > 0 && <RoomsNotice rooms={p.rooms!} onClosed={() => void preview.refetch()} />}
              <ReviewTable preview={p} amounts={amounts} ticketPick={ticketPick} onPick={(id, t) => edit(() => setTicketPick((x) => ({ ...x, [id]: t })))} />
            </>
          )
        )}

        {/* 收款 */}
        <PaymentsSection
          pay={pay}
          total={total}
          members={p?.members ?? []}
          canWallet={can('consume.create') && !backfill.state.active}
          authorize={(amount, reason) => ({
            request: { purpose: 'checkout_discount', scope: { visitIds: sortedVisitIds(visitIds), amount, reason } },
            lines: [
              `手牌 ${(p?.visits ?? []).map((v) => v.tagCode).join('、')} · 应收 ${total !== null ? formatYuan(total) : ''}`,
              `${CHECKOUT_METHOD_LABELS.discount} ${formatYuan(amount)}`,
              `原因：${reason}`,
            ],
          })}
        />

        <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="备注（选填）" maxLength={200} aria-label="结账备注" className="min-h-[44px]" />
        {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} />}
      </div>
    </Dialog>
  );
}

/** 钟房里还没结束的钟（v0.7.1）：在钟上的结账时下钟；还没上钟的按已做完记，客人没做的先到钟房取消派钟 */
function SessionsNotice({ sessions }: { sessions: CheckoutPreview['sessions'] }) {
  const waiting = sessions.some((s) => s.status === 'waiting');
  return (
    <div data-testid="checkout-sessions">
      <Notice tone="warning" title={waiting ? '有技师还没上钟：客人没做的项目，请先到钟房取消派钟再结账' : '有技师还在钟上：结账时自动下钟'}>
        <ul className="mt-1 space-y-0.5">
          {sessions.map((s) => (
            <li key={s.sessionNo}>
              <span className="num font-semibold">{s.tagCode}</span> · {s.techNo} 号 {s.techName} · {s.itemName} × {s.clocks} ·{' '}
              {s.status === 'waiting' ? '还没上钟（结账后按已做完记）' : '在钟上（结账时下钟）'}
            </li>
          ))}
        </ul>
      </Notice>
    </div>
  );
}

/**
 * 客房（S7）：客人还住着客房时不能结账，先退房——补齐此刻要付的房费（挂到手牌账单上）、押金原路退回、房间变待打扫；
 * 退房后重新核对，房费就在这张结账单里一起结。有客房权限的在这里直接退房
 */
function RoomsNotice({ rooms, onClosed }: { rooms: NonNullable<CheckoutPreview['rooms']>; onClosed: () => void }) {
  const can = useCan();
  const [closing, setClosing] = useState<number | null>(null);
  return (
    <div data-testid="checkout-rooms">
      <Notice tone="warning" title="有客人还住着客房：先退房，房费挂到手牌账单上再一起结账">
        <ul className="mt-1 space-y-1">
          {rooms.map((r) => (
            <li key={r.stayId} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>
                <span className="num font-semibold">{r.tagCode}</span> · 客房 <span className="num font-semibold">{r.roomNo}</span>（{r.stayNo}）
              </span>
              {can('room.operate') ? (
                <Button size="sm" variant="secondary" icon={<LogOut className="size-3.5" />} onClick={() => setClosing(r.stayId)} data-testid={`checkout-room-close-${r.roomNo}`}>
                  退房
                </Button>
              ) : (
                <span className="text-[12px] text-ink-3">请有客房权限的同事退房</span>
              )}
            </li>
          ))}
        </ul>
      </Notice>
      {closing !== null && (
        <CloseStayById
          stayId={closing}
          onClose={() => setClosing(null)}
          onDone={() => {
            setClosing(null);
            onClosed();
          }}
        />
      )}
    </div>
  );
}

/** 餐饮（S5）：客人点的菜还没上齐时提醒（不拦结账；结账后厨房屏标出「客人已结账」） */
function DishesNotice({ dishes }: { dishes: CheckoutPreview['dishes'] }) {
  return (
    <div data-testid="checkout-dishes">
      <Notice tone="warning" title="客人点的菜还没上齐：请先问客人还要不要，不要的先退菜再结账">
        <ul className="mt-1 space-y-0.5">
          {dishes.map((d, i) => (
            <li key={i}>
              <span className="num font-semibold">{d.tagCode}</span> · {d.name} × {d.quantity} · {KITCHEN_STATUS_LABELS[d.status]}
            </li>
          ))}
        </ul>
      </Notice>
    </div>
  );
}

function ReviewTable({
  preview,
  amounts,
  ticketPick,
  onPick,
}: {
  preview: CheckoutPreview;
  amounts: (number | null)[];
  ticketPick: Record<number, number>;
  onPick: (visitId: number, ticketTypeId: number) => void;
}) {
  const ticketTypes = useTicketTypes();
  const total = amounts.every((a) => a !== null) ? amounts.reduce<number>((s, a) => s + a!, 0) : null;
  const now = new Date(preview.pricedAt).getTime();
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-card" data-testid="checkout-review">
      <ul className="divide-y divide-line/70">
        {preview.visits.map((v, i) => (
          <li key={v.visitId} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="num text-[17px] font-bold">{v.tagCode}</span>
              <ZoneChip zone={v.zone} />
              <span className="min-w-0 truncate text-[13px] text-ink-2">{v.memberName ? `会员 ${v.memberName}` : v.guestLabel || '散客'}</span>
              <span className="num flex items-center gap-1 text-[12.5px] text-ink-3">
                <Clock3 className="size-3.5" />
                {formatTime(v.checkedInAt)} 入场 · 在店 {stayText(v.checkedInAt, now)}
              </span>
              <span className="flex-1" />
              {amounts[i] !== null ? <Money cents={amounts[i]!} className="text-[16px] font-bold" /> : <span className="text-[12.5px] text-clay">待选票种</span>}
            </div>
            <div className="mt-1.5 space-y-0.5 pl-0.5 text-[12.5px] text-ink-2">
              {v.ticket ? (
                <p className="flex flex-wrap items-center gap-x-2" data-testid={`checkout-ticket-${v.tagCode}`}>
                  <Ticket className="size-3.5 text-pine" />
                  门票 · {v.ticket.name}（{v.ticket.tierLabel}）<Money cents={v.ticket.amount} className="font-semibold" />
                  {v.ticket.endAt ? (
                    // 反结账后重结：门票按第一次结账的时刻计算，不再随时间跳档
                    <span className="text-ink-3" data-testid="ticket-frozen">
                      按第一次结账 {formatTime(v.ticket.endAt)} 计算（反结账后重结）
                    </span>
                  ) : (
                    <span className="text-ink-3">
                      {formatTime(v.ticket.nextJumpAt)} 后跳到 <Money cents={v.ticket.nextAmount} />
                    </span>
                  )}
                </p>
              ) : (
                <p className="flex flex-wrap items-center gap-2">
                  <Ticket className="size-3.5 text-clay" />
                  <span className="font-semibold text-clay">还没有选票种，请补选：</span>
                  <Select
                    fullWidth={false}
                    value={String(ticketPick[v.visitId] ?? '')}
                    onChange={(e) => onPick(v.visitId, Number(e.target.value))}
                    className="h-8 w-[160px] text-[13px]"
                    aria-label={`${v.tagCode} 票种`}
                  >
                    <option value="" disabled>
                      选择票种
                    </option>
                    {/* 免票要当场授权：请先在手牌详情里改票种并授权 */}
                    {ticketTypes.data
                      ?.filter((t) => !isFreeTicket(t))
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                  </Select>
                  <span className="text-ink-3">免票请在手牌详情里改票种并授权</span>
                </p>
              )}
              {v.lines.map((l) => (
                <p key={l.id} className="flex items-baseline gap-2 pl-5">
                  <span className="min-w-0 flex-1 truncate">
                    {l.name} × {l.quantity}
                  </span>
                  <Money cents={l.amount} className="text-ink-3" />
                </p>
              ))}
            </div>
          </li>
        ))}
      </ul>
      <div className="flex items-end justify-between gap-3 border-t border-line bg-paper/60 px-4 py-3">
        <p className="text-[12px] text-ink-3">
          {preview.visits.length} 张手牌 · 按 {formatTime(preview.pricedAt)} 计算门票{preview.graceMinutes ? `（跳档宽限 ${preview.graceMinutes} 分钟）` : ''}
        </p>
        <div className="text-right">
          <p className="text-[12px] text-ink-3">应收合计</p>
          <span data-testid="checkout-total">{total !== null ? <Money cents={total} className="text-[28px] font-bold text-pine" /> : <span className="text-[14px] text-clay">待选票种</span>}</span>
        </div>
      </div>
    </div>
  );
}

/** 结账单结的是餐饮桌台（S5 第二步）：反结账后恢复的是桌台，不是在店客人 */
const isTableCheckout = (d: CheckoutDetail) => d.bills.some((b) => b.tableSessionId !== null);

/** 结账单：所结手牌（桌台）、门票与收款明细 */
export function CheckoutReceipt({ detail }: { detail: CheckoutDetail }) {
  return (
    <div className="space-y-3" data-testid="checkout-receipt">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
        <ReceiptText className="size-4" />
        <span className="num font-semibold text-ink-2">{detail.checkoutNo}</span>
        <span>
          {formatDateTime(detail.createdAt)} · {detail.operatorName}
        </span>
        {detail.status === 'voided' && <Badge tone="clay">已反结账</Badge>}
        {detail.backfill && (
          <span data-testid="checkout-backfill">
            <Badge tone="lake">补录 · 纸质单 {detail.backfill.slipNo}</Badge>
          </span>
        )}
      </div>
      {detail.backfill && (
        <p className="text-[12px] text-ink-3">
          按纸质单上的实际时间结账：{detail.backfill.enteredByName}于 {formatDateTime(detail.backfill.enteredAt)} 补录。
        </p>
      )}
      {detail.status === 'voided' && (
        <Notice tone="warning" icon={<Undo2 className="size-4" />} title={`${detail.voidedByName ?? ''} 于 ${detail.voidedAt ? formatDateTime(detail.voidedAt) : ''} 反结账`}>
          {detail.voidReason}。储值消费已按原单撤销，团购券登记已作废，{isTableCheckout(detail) ? '这几桌恢复为用餐中' : '客人恢复为在店未结'}。
        </Notice>
      )}
      <div className="overflow-hidden rounded-lg border border-line">
        <table className="w-full text-[13px]">
          <thead className="bg-paper-2 text-[12px] text-ink-3">
            <tr>
              <th className="px-3 py-2 text-left font-semibold">手牌</th>
              <th className="px-3 py-2 text-left font-semibold">门票</th>
              <th className="px-3 py-2 text-right font-semibold">金额</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/70">
            {detail.bills.map((b) => (
              <tr key={b.billId}>
                <td className="px-3 py-2">
                  <span className="num font-bold">{b.tableName !== null ? `桌 ${b.tableName}` : b.tagCode}</span>{' '}
                  <span className="text-ink-3">
                    {b.memberName ?? (b.guestLabel || '散客')}
                    {b.tableName !== null && ` · ${b.guests} 人`}
                  </span>
                </td>
                <td className="px-3 py-2 text-ink-2">
                  {b.ticketName !== null && (
                    <>
                      {b.ticketName} · {b.ticketSegments === 1 ? '12 小时档' : `${b.ticketSegments} 段`} <Money cents={b.ticketAmount ?? 0} className="text-ink-3" />
                    </>
                  )}
                  <span className="block text-[11.5px] text-ink-3">
                    {b.tableName !== null ? '用餐' : '在店'} {Math.floor(b.stayMinutes / 60)} 时 {b.stayMinutes % 60} 分
                  </span>
                </td>
                <td className="px-3 py-2 text-right">
                  <Money cents={b.amount} className="font-bold" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="space-y-1 border-t border-line bg-paper/60 px-3 py-2.5 text-[13px]">
          {detail.payments.length === 0 && <p className="text-ink-3">应收为 0，未收款</p>}
          {detail.payments.map((pm) => (
            <p key={pm.id} className="flex flex-wrap items-baseline gap-2">
              <span className="font-semibold">{CHECKOUT_METHOD_LABELS[pm.method]}</span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">
                {pm.method === 'wallet' && pm.consumption
                  ? `${pm.memberName ?? ''} · ${pm.consumption.docNo} · 本金 ¥${(pm.consumption.principal / 100).toFixed(2)} / 赠金 ¥${(pm.consumption.bonus / 100).toFixed(2)}${pm.consumption.status === 'reversed' ? '（已撤销）' : ''}`
                  : pm.method === 'coupon' && pm.coupon
                    ? `${COUPON_PLATFORM_LABELS[pm.coupon.platform]} ${pm.coupon.code}${pm.coupon.dealName ? ` · ${pm.coupon.dealName}` : ''}${pm.coupon.status === 'voided' ? '（已作废）' : ''}`
                    : pm.method === 'discount'
                      ? `${pm.ref} · ${pm.approvedByName ?? ''}授权`
                      : pm.ref}
              </span>
              <Money cents={pm.amount} className="font-bold" />
            </p>
          ))}
          <p className="flex items-baseline justify-between border-t border-dashed border-line pt-1.5">
            <span className="font-bold">合计</span>
            <Money cents={detail.totalAmount} className="text-[20px] font-bold text-pine" />
          </p>
        </div>
      </div>
      {detail.remainingMates.length > 0 && detail.status === 'completed' && (
        <p className="text-[12.5px] text-ink-3">同行组里还有 {detail.remainingMates.join('、')} 在店，离店时另行结账。</p>
      )}
    </div>
  );
}

/** 结账记录：查看结账单、反结账；可以切换营业日（过了营业日切换点仍能找到前一晚的单），之前的营业日需要历史营业日权限 */
export function CheckoutRecordsDialog({ open, onClose, focusId }: { open: boolean; onClose: () => void; focusId?: number | null }) {
  const session = useSession();
  const can = useCan();
  const [date, setDate] = useState(session.today);
  const list = useCheckouts(date, open);
  const [openId, setOpenId] = useState<number | null>(focusId ?? null);
  useResetOnOpen(
    open,
    () => {
      setOpenId(focusId ?? null);
      setDate(session.today);
    },
    [focusId, session.today],
  );
  const isToday = date === session.today;
  return (
    <Dialog open={open} onClose={onClose} width="max-w-2xl" title="结账记录" description={`营业日 ${date} 的结账单（含当天反结账的）`}>
      {!openId && (
        <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="checkout-records-date">
          <DateNav value={date} today={session.today} onChange={setDate} locked={!can('ledger.readHistory')} />
          {isToday && can('ledger.readHistory') && (
            <Button size="sm" variant="ghost" onClick={() => setDate(shiftDate(session.today, -1))}>
              前一晚的单
            </Button>
          )}
        </div>
      )}
      {openId ? (
        <CheckoutDetailView id={openId} onBack={() => setOpenId(null)} />
      ) : list.isPending ? (
        <Skeleton className="h-40" />
      ) : list.error ? (
        <Notice tone="error" title={errorMessage(list.error)} />
      ) : (list.data ?? []).length === 0 ? (
        <EmptyState art="calm" title={isToday ? '今天还没有结账' : '这一天没有结账'} description="在账单上点「结账」后，结账单会出现在这里。" />
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line" data-testid="checkout-records">
          {list.data!.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => setOpenId(c.id)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-paper-2/60">
                <span className="num font-bold">{c.checkoutNo}</span>
                <span className="num text-[13px] font-semibold text-ink-2">{[...(c.tagCodes ?? []), ...(c.tableNames ?? []).map((n) => `桌 ${n}`)].join('、')}</span>
                <span className="text-[12.5px] text-ink-3">
                  {formatTime(c.createdAt)} · {c.operatorName} · {(c.methods ?? []).map((m) => CHECKOUT_METHOD_LABELS[m]).join(' + ') || '免收'}
                </span>
                <span className="flex-1" />
                {c.backfillSlipNo && <Badge tone="lake">补录 · {c.backfillSlipNo}</Badge>}
                {c.status === 'voided' && <Badge tone="clay">已反结账</Badge>}
                <Money cents={c.totalAmount} className={cn('font-bold', c.status === 'voided' && 'line-through opacity-60')} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

function CheckoutDetailView({ id, onBack }: { id: number; onBack: () => void }) {
  const detail = useCheckout(id);
  const can = useCan();
  const session = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const refresh = useRefreshFrontdesk();
  const shiftReady = useShiftReady(true);
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const d = detail.data;
  // 撤销与反结账时限（默认 48 小时）：超过只有店主可以反结账（服务端同样核对）
  const windowHours = session.rules.reversalWindowHours;
  const pastWindow = !!d && windowHours !== null && Date.now() - new Date(d.createdAt).getTime() > windowHours * 3_600_000;
  const blockedByWindow = pastWindow && session.staff.role !== 'owner';
  const cashRefund = d?.payments.filter((pm) => pm.method === 'cash').reduce((n, pm) => n + pm.amount, 0) ?? 0;
  // 跨钱箱退款（店主 2026-10-30 定）：原单收了现金时选从哪个钱箱退，退款记到那个钱箱当班的班次
  const drawers = useQuery({
    queryKey: ['frontdesk', 'refund-shifts', id],
    queryFn: () => api.get<RefundShiftOptions>(`/api/frontdesk/checkouts/${id}/refund-shifts`),
    enabled: voiding && cashRefund > 0,
  });
  const [drawer, setDrawer] = useState<number | null>(null);
  useEffect(() => {
    const data = drawers.data;
    if (data) setDrawer((cur) => (cur !== null && data.shifts.some((x) => x.id === cur) ? cur : data.suggested));
  }, [drawers.data]);
  const chosen = drawers.data?.shifts.find((x) => x.id === drawer) ?? null;
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post<CheckoutDetail>(`/api/frontdesk/checkouts/${id}/void`, { reason: reason.trim(), ...(cashRefund > 0 && drawer !== null ? { refundShiftId: drawer } : {}) });
      const restored = d && isTableCheckout(d) ? '这几桌恢复为用餐中' : '客人恢复为在店未结';
      toast({
        tone: 'success',
        title: `已反结账 ${d?.checkoutNo ?? ''}`,
        body: cashRefund
          ? `${restored}；退给客人的现金 ¥${(cashRefund / 100).toFixed(2)} 计入${chosen && !chosen.mine ? ` ${chosen.staffName} ` : '你'}当班的交班表`
          : `${restored}，可更正后重新结账`,
      });
      setVoiding(false);
      void qc.invalidateQueries({ queryKey: ['frontdesk'] });
      void qc.invalidateQueries({ queryKey: ['dining'] });
      void qc.invalidateQueries({ queryKey: ['member'] });
      void qc.invalidateQueries({ queryKey: shiftKeys.all });
      refresh();
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiError && SHIFT_ERRORS.includes(e.code)) void qc.invalidateQueries({ queryKey: shiftKeys.all });
      if (e instanceof ApiError && e.code.startsWith('REFUND_SHIFT')) void drawers.refetch();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <Button size="sm" variant="ghost" onClick={onBack}>
        ← 返回列表
      </Button>
      {!d ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          <CheckoutReceipt detail={d} />
          <PrintButton path={`/print/checkout/${d.id}`} testId="checkout-reprint">
            打印结账单
          </PrintButton>
          {d.status === 'completed' && can('frontdesk.checkoutVoid') && blockedByWindow && (
            <Notice tone="warning" icon={<Undo2 className="size-4" />} title={`已超过反结账时限（结账后 ${describeHours(windowHours!)}内）`}>
              这张单只能由店主反结账；需要退款或更正时请联系店主。
            </Notice>
          )}
          {d.status === 'completed' && can('frontdesk.checkoutVoid') && !blockedByWindow && !voiding && (
            <Button variant="secondary" icon={<Undo2 className="size-4" />} onClick={() => setVoiding(true)} data-testid="checkout-void">
              反结账
            </Button>
          )}
          {voiding && (
            <div className="space-y-2 rounded-lg border border-clay/30 bg-clay-soft/40 p-3">
              {cashRefund === 0 && <ShiftGate action="反结账" />}
              <p className="text-[13px] text-ink-2">
                {isTableCheckout(d)
                  ? '反结账后：储值消费按原单撤销，团购券登记作废，这几桌恢复为用餐中（桌台须仍空闲），可以继续点单或更正后重新结账。'
                  : '反结账后：储值消费按原单撤销，团购券登记作废，门票明细作废，客人恢复为在店未结（手牌须仍空闲）；重新结账时门票按第一次结账的时刻计算。'}
                {cashRefund ? ` 原单收了现金 ¥${(cashRefund / 100).toFixed(2)}：选从哪个钱箱退给客人，计入那个钱箱当班的交班表（扣减应有现金）。` : ''}
                扫码、银行卡、团购请在商户后台原路退回并登记退款单号。
              </p>
              {cashRefund > 0 && <RefundDrawerPicker query={drawers} value={drawer} onChange={setDrawer} />}
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="反结账原因（至少 2 个字），例如：收款方式记错" maxLength={200} aria-label="反结账原因" />
              <div className="flex gap-2">
                <Button
                  variant="danger"
                  disabled={reason.trim().length < 2 || (cashRefund > 0 ? drawer === null : !shiftReady.ready)}
                  loading={busy}
                  onClick={() => void run()}
                  data-testid="checkout-void-confirm"
                >
                  确认反结账
                </Button>
                <Button variant="ghost" onClick={() => setVoiding(false)} disabled={busy}>
                  取消
                </Button>
              </div>
              {error && <Notice tone="error" title={error} />}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** 跨钱箱退款：退给客人的现金从哪个钱箱出（此刻当班的班次）；默认原单收款的班次，已交班时是自己的班次 */
function RefundDrawerPicker({ query, value, onChange }: { query: UseQueryResult<RefundShiftOptions>; value: number | null; onChange: (id: number) => void }) {
  if (query.isPending) return <Skeleton className="h-16" />;
  if (query.error) return <Notice tone="error" title={errorMessage(query.error)} />;
  const list = query.data!.shifts;
  if (list.length === 0) {
    return (
      <div data-testid="refund-drawer-none">
        <Notice tone="warning" title="现在没有当班的钱箱">
          退给客人的现金要记到当班的交班表里：先开班（登记钱箱里的备用金），再反结账。
          <StartShiftForm compact onStarted={() => void query.refetch()} />
        </Notice>
      </div>
    );
  }
  return (
    <div role="radiogroup" aria-label="从哪个钱箱退现金" className="space-y-1.5" data-testid="refund-drawer">
      <p className="text-[12.5px] font-bold text-ink-2">从哪个钱箱退现金</p>
      {list.map((x) => (
        <button
          key={x.id}
          type="button"
          role="radio"
          aria-checked={value === x.id}
          onClick={() => onChange(x.id)}
          className={cn(
            'flex w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-3 py-2 text-left text-[13px]',
            value === x.id ? 'border-pine bg-pine-tint' : 'border-line bg-card hover:border-line-strong',
          )}
          data-testid={`refund-drawer-${x.shiftNo}`}
        >
          <span className="font-bold">{x.staffName}的钱箱</span>
          <span className="text-[12px] text-ink-3">
            班次 {x.shiftNo} · {formatTime(x.startedAt)} 开班
          </span>
          {x.original && <Badge tone="pine">原单收款的班次</Badge>}
          {x.mine && <Badge tone="lake">你的班次</Badge>}
        </button>
      ))}
    </div>
  );
}

/**
 * 改票种（在店期间）：之后结账按新票种（选定时的票价）计算门票。
 * 改成更便宜的票种或免票要值班经理及以上当场授权并填原因（R1.2，店主 2026-10-29 签认）。
 */
export function TicketDialog({ open, visit, onClose, onDone }: { open: boolean; visit: VisitDetail; onClose: () => void; onDone: (v: VisitDetail) => void }) {
  const types = useTicketTypes();
  const [pick, setPick] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [grant, setGrant] = useState<TicketGrant | null>(null);
  const [authorizing, setAuthorizing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(
    open,
    () => {
      setPick(visit.ticket?.typeId ?? null);
      setReason('');
      setGrant(null);
      setError(null);
    },
    [visit],
  );
  const options = useMemo(() => types.data ?? [], [types.data]);
  const type = options.find((t) => t.id === pick) ?? null;
  const current = visit.ticket ? { price12h: visit.ticket.price12h, price24h: visit.ticket.price24h } : null;
  const needsGrant = !!type && pick !== visit.ticket?.typeId && ticketChangeNeedsGrant(type, current);
  const item = { tagCode: visit.tag.code, ticketTypeId: pick ?? 0 };
  const granted = !!grant && ticketGrantCovers(grant.scope, [item]) && new Date(grant.expiresAt).getTime() > Date.now();
  const run = async () => {
    if (!pick) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await api.post<VisitDetail>(`/api/frontdesk/visits/${visit.id}/ticket`, { ticketTypeId: pick, grantId: needsGrant && grant ? grant.grantId : null }));
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiError && e.code.startsWith('GRANT_')) setGrant(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title={`${visit.ticket ? '改票种' : '选择票种'} · ${visit.tag.code}`}
      description="门票离店结账时按在店时长计算：每 12 小时跳一档（12 小时档 → 24 小时档 → 24 + 12 …）；改成更便宜的票种或免票要值班经理授权"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" disabled={!pick || pick === visit.ticket?.typeId || (needsGrant && !granted)} loading={busy} onClick={() => void run()} data-testid="ticket-confirm">
            确认
          </Button>
        </>
      }
    >
      <ul className="space-y-2" role="radiogroup" aria-label="票种">
        {options.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              role="radio"
              aria-checked={pick === t.id}
              onClick={() => {
                setPick(t.id);
                setError(null);
              }}
              className={cn(
                'flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left',
                pick === t.id ? 'border-pine bg-pine-tint' : 'border-line bg-card hover:border-line-strong',
              )}
            >
              <Ticket className={cn('size-4', pick === t.id ? 'text-pine' : 'text-ink-3')} />
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-bold">{t.name}</span>
                {t.note && <span className="block text-[12px] text-ink-3">{t.note}</span>}
              </span>
              <span className="num text-right text-[12.5px] text-ink-2">
                {t.price12h || t.price24h ? (
                  <>
                    12 小时 <Money cents={t.price12h} className="font-bold" /> · 24 小时 <Money cents={t.price24h} className="font-bold" />
                  </>
                ) : (
                  '免票'
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {needsGrant && type && (
        <div className="mt-3 space-y-2 rounded-lg border border-yuzu-deep/25 bg-yuzu-tint/60 p-3" data-testid="ticket-grant">
          <p className="text-[13px] text-ink-2">
            改成「{type.name}」{isFreeTicket(type) ? '是免票' : '比原来的票种便宜'}，需要值班经理、店总或店主当场授权，并填写原因。
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              fullWidth={false}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                setGrant(null);
              }}
              placeholder={isFreeTicket(type) ? '原因（必填），例如：1 米以下儿童' : '原因（必填），例如：接待时选错票种'}
              maxLength={100}
              className="h-9 min-w-0 flex-1 basis-48 text-[13px]"
              aria-label="降档原因"
            />
            {granted ? (
              <Badge tone="pine" className="h-8 px-3 text-[12.5px]">
                <ShieldCheck className="size-3.5" /> {grant!.approverName}已授权
              </Badge>
            ) : (
              <Button size="sm" variant="primary" icon={<ShieldCheck className="size-3.5" />} disabled={reason.trim().length < 2} onClick={() => setAuthorizing(true)} data-testid="ticket-authorize">
                请值班经理授权
              </Button>
            )}
          </div>
        </div>
      )}
      {error && <Notice tone="error" title={error} className="mt-3" />}
      {authorizing && type && (
        <AuthorizeDialog<TicketGrantRequest>
          open
          request={{ purpose: 'ticket_discount', scope: { items: [item], reason: reason.trim() } }}
          lines={[`手牌 ${visit.tag.code}：${visit.ticket?.name ?? '未选票种'} → ${type.name}`, `原因：${reason.trim()}`]}
          onClose={() => setAuthorizing(false)}
          onGranted={(g) => {
            setGrant(g);
            setAuthorizing(false);
          }}
        />
      )}
    </Dialog>
  );
}
