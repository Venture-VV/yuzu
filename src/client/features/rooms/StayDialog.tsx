// 入住单（S7）：房费（入住、夜审、续住、退房时挂上的每一晚 / 每一段，都在住客的手牌账单上）、押金台账与余额、换房记录；
// 续住（全天房改预计离店、钟点房加一段）、换房（写原因）、改登记、收押金、退押金（原路退）、
// 退房（补齐房费挂到手牌账单、押金原路退回，见 CloseStayDialog）、撤销入住。房费挂错了在前台手牌账单上作废。
// 续住、收退押金、退房有「结果待确认」；换房、改登记、撤销入住是普通操作（失败可直接重试，不会重复记账）。

import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, BedDouble, CalendarPlus, HandCoins, History, LogOut, Pencil, ReceiptText, Undo2, Wallet } from 'lucide-react';
import { PAYMENT_METHOD_LABELS, type PaymentMethod } from '@shared/labels';
import { formatYuan, parseYuan, centsToInput } from '@shared/money';
import { DEPOSIT_KIND_LABELS, MAX_STAY_GUESTS, STAY_STATUS_LABELS, type RoomBoard, type StayCharge, type StayDetail } from '@shared/rooms';
import { api, errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn, formatDateTime, formatTime } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, Field, Input, Notice, SectionTitle, Select, Skeleton } from '../../components/ui';
import { PendingPanel, useFrontdeskOp } from '../frontdesk/pending';
import { stayText } from '../frontdesk/queries';
import { SHIFT_ERRORS, shiftKeys, ShiftGate, useShiftReady } from '../shift/ShiftGate';
import { chargeText, CloseStayDialog } from './CloseStayDialog';
import { DepositFields, depositProblem, guestOf, kindLabel, rateText, type DepositDraft } from './parts';
import { dayText, roomsKey, stayKey, useStay } from './queries';

/** 从「结果待确认」回来时直接打开的操作 */
export type StayAction = 'extend' | 'deposit' | 'refund' | 'close';

const SOURCE_LABELS: Record<StayCharge['source'], string> = { checkin: '入住', audit: '夜审', checkout: '退房', extend: '续住' };

export function StayDialog({
  id,
  action,
  board,
  onClose,
  onRoomDetail,
}: {
  id: number;
  action?: StayAction | 'move';
  board: RoomBoard;
  onClose: () => void;
  /** 打开这间房的房间详情（8.0.8，B07） */
  onRoomDetail?: (roomId: number) => void;
}) {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const detail = useStay(id);
  // 一打开就要做的操作（续住、换房、押金、退房）：等入住单的对话框先挂上再打开。两个对话框在同一次渲染里一起挂上时，
  // 子对话框会先插进页面、被入住单压在下面点不到（入住单已经缓存过时就是这样，例如平面图上点「退房」、「去处理」回来）
  const [sub, setSub] = useState<StayAction | 'move' | 'edit' | null>(null);
  useEffect(() => {
    if (action) setSub(action);
  }, [action]);
  const [cancelling, setCancelling] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const d = detail.data;
  const canOperate = can('room.operate');

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: roomsKey });
    void qc.invalidateQueries({ queryKey: ['frontdesk'] });
  };
  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      toast({ tone: 'success', title: ok });
      return true;
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
      return false;
    } finally {
      setBusy(null);
      refresh();
    }
  };

  if (!d) {
    return (
      <Dialog open onClose={onClose} title="入住单">
        {detail.error ? <Notice tone="error" title={errorMessage(detail.error)} /> : <Skeleton className="h-48" />}
      </Dialog>
    );
  }

  const open = d.status === 'open';
  const activeCharges = d.charges.filter((c) => c.lineStatus === 'active');
  const freeRooms = board.rooms.filter((r) => r.status === 'vacant' && r.id !== d.roomId);

  return (
    <Dialog
      open
      onClose={busy ? () => {} : onClose}
      width="max-w-2xl"
      title={
        <span className="flex flex-wrap items-center gap-2">
          <BedDouble className="size-5 text-pine" /> {d.roomNo}
          <span className="text-[14px] font-semibold text-ink-3">
            {d.typeName} · {d.guests} 人 · {guestOf(d)}
          </span>
          {!open && <Badge tone={d.status === 'cancelled' ? 'clay' : 'lake'}>{STAY_STATUS_LABELS[d.status]}</Badge>}
        </span>
      }
      description={`${d.stayNo} · ${formatDateTime(d.checkedInAt)} 入住 · ${kindLabel(d.kind)} ${rateText(d.kind, d.rate, d.blockMinutes)}${
        d.kind === 'hourly' && open ? ` · 已住 ${stayText(d.checkedInAt, Date.now())}` : ''
      }${d.expectedCheckoutDate ? ` · 预离 ${dayText(d.expectedCheckoutDate)}` : ''}`}
      footer={
        open ? (
          <>
            <span className="mr-auto self-center text-[13px] text-ink-3">
              房费 <Money cents={d.chargedAmount} className="text-[16px] font-bold text-ink" /> · 押金 <Money cents={d.depositBalance} className="text-[16px] font-bold text-ink" />
            </span>
            {canOperate && (
              <Button variant="primary" size="lg" icon={<LogOut className="size-4" />} onClick={() => setSub('close')} data-testid="stay-close">
                退房
              </Button>
            )}
          </>
        ) : (
          <Button variant="primary" onClick={onClose}>
            关闭
          </Button>
        )
      }
    >
      <div className="space-y-4" data-testid="stay-detail">
        {d.status === 'cancelled' && <Notice tone="warning" title={`已撤销入住：${d.closeReason ?? ''}`} />}
        {!open && d.status !== 'cancelled' && d.checkedOutAt && (
          <Notice tone="info" title={`${formatDateTime(d.checkedOutAt)} ${d.checkedOutByName ?? ''}退房`}>
            房费已挂在手牌账单上，随手牌一起结账。
          </Notice>
        )}
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-lake-soft/50 px-3 py-2 text-[12.5px] text-ink-2">
          <span className="min-w-0 flex-1">
            手牌 <b className="num">{d.tagCode}</b>：房费挂在手牌账单 {d.billNo} 上（账单合计 <Money cents={d.billAmount} />），离店时随手牌在前台一起结账。
          </span>
          {onRoomDetail && (
            <button type="button" onClick={() => onRoomDetail(d.roomId)} className="inline-flex items-center gap-1 font-semibold text-pine hover:underline" data-testid="stay-room-detail">
              <History className="size-3.5" /> 房间详情
            </button>
          )}
          {can('frontdesk.read') && (
            <Link to={`/frontdesk?v=${d.visitId}`} className="inline-flex items-center gap-1 font-semibold text-pine hover:underline" data-testid="stay-open-bill">
              <ReceiptText className="size-3.5" /> 打开手牌账单
            </Link>
          )}
        </p>
        {open && canOperate && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" icon={<CalendarPlus className="size-3.5" />} onClick={() => setSub('extend')} data-testid="stay-extend">
              {d.kind === 'hourly' ? '加一段' : '续住'}
            </Button>
            <Button size="sm" variant="secondary" icon={<ArrowRightLeft className="size-3.5" />} onClick={() => setSub('move')} disabled={freeRooms.length === 0} data-testid="stay-move">
              换房
            </Button>
            <Button size="sm" variant="secondary" icon={<Pencil className="size-3.5" />} onClick={() => setSub('edit')} data-testid="stay-edit">
              改登记
            </Button>
            <Button size="sm" variant="secondary" icon={<Wallet className="size-3.5" />} onClick={() => setSub('deposit')} data-testid="stay-deposit">
              收押金
            </Button>
            {d.depositBalance > 0 && (
              <Button size="sm" variant="secondary" icon={<HandCoins className="size-3.5" />} onClick={() => setSub('refund')} data-testid="stay-refund">
                退押金
              </Button>
            )}
            {activeCharges.length === 0 && d.depositBalance === 0 && (
              <Button size="sm" variant="ghost" icon={<Undo2 className="size-3.5" />} onClick={() => setCancelling(true)} data-testid="stay-cancel">
                撤销入住
              </Button>
            )}
          </div>
        )}

        {/* 房费 */}
        <div>
          <SectionTitle aside={<span className="text-[12.5px] text-ink-3">已挂 <Money cents={d.chargedAmount} className="font-bold text-ink" /></span>}>房费</SectionTitle>
          {d.charges.length === 0 ? (
            <p className="mt-2 rounded-lg border border-dashed border-line-strong px-3 py-4 text-center text-[13px] text-ink-3">没有房费（都作废了）</p>
          ) : (
            <ul className="mt-2 divide-y divide-line/70 rounded-lg border border-line" data-testid="stay-charges">
              {d.charges.map((c) => {
                const voided = c.lineStatus === 'voided';
                return (
                  <li key={c.id} className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2', voided && 'opacity-60')}>
                    <span className={cn('min-w-0 flex-1 basis-40 text-[13.5px] font-semibold', voided && 'line-through')}>
                      {chargeText(c)}
                      <span className="block text-[11.5px] font-normal text-ink-4">
                        {SOURCE_LABELS[c.source]} · {formatDateTime(c.createdAt)} {c.createdByName}
                        {voided && ' · 已作废（不再补挂）'}
                      </span>
                    </span>
                    <Money cents={c.amount} className="w-20 justify-end text-[13.5px] font-bold" />
                  </li>
                );
              })}
            </ul>
          )}
          {open && <p className="mt-1 text-[12px] text-ink-4">房费挂错了，在前台这张手牌的账单上作废（时限与作废明细相同；作废过的那一晚 / 那一段退房时不再补挂）。</p>}
        </div>

        {/* 押金 */}
        <div>
          <SectionTitle
            aside={
              <span className="text-[12.5px] text-ink-3" data-testid="stay-deposit-balance">
                余额 <Money cents={d.depositBalance} className="font-bold text-ink" />
                {d.depositByMethod.length > 0 && `（${d.depositByMethod.map((m) => `${PAYMENT_METHOD_LABELS[m.method]} ${formatYuan(m.balance)}`).join('、')}）`}
              </span>
            }
          >
            押金
          </SectionTitle>
          {d.deposits.length === 0 ? (
            <p className="mt-2 text-[13px] text-ink-3">没有收押金</p>
          ) : (
            <ul className="mt-2 divide-y divide-line/70 rounded-lg border border-line text-[13px]" data-testid="stay-deposits">
              {d.deposits.map((x) => (
                <li key={x.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-2">
                  <span className="font-semibold">{DEPOSIT_KIND_LABELS[x.kind]}</span>
                  <span className="text-ink-3">{PAYMENT_METHOD_LABELS[x.method]}</span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">
                    {[x.reason, x.ref, `${formatTime(x.createdAt)} ${x.operatorName}`].filter(Boolean).join(' · ')}
                  </span>
                  <Money cents={x.kind === 'receive' ? x.amount : -x.amount} signed className="font-bold" />
                </li>
              ))}
            </ul>
          )}
        </div>

        {d.moves.length > 0 && (
          <div className="text-[12.5px] text-ink-3">
            <p className="font-bold text-ink-2">换房记录</p>
            <ul className="mt-1 space-y-0.5">
              {d.moves.map((m, i) => (
                <li key={i}>
                  {formatDateTime(m.createdAt)} {m.operatorName}：{m.fromRoom} → {m.toRoom}（{m.reason}）
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <ReasonDialog
        open={cancelling}
        title={`撤销入住 · ${d.roomNo}`}
        description="开错房、客人没住就走时撤销：这次入住作废（留痕），房间变为待打扫。房费都在前台手牌账单上作废了、押金都退了才能撤销。"
        confirmLabel="确认撤销"
        danger
        busy={busy === 'cancel'}
        onClose={() => setCancelling(false)}
        onConfirm={(reason) => {
          void run('cancel', () => api.post(`/api/rooms/stays/${d.id}/cancel`, { reason }), `${d.roomNo} 的入住已撤销`).then((ok) => {
            if (ok) {
              setCancelling(false);
              onClose();
            }
          });
        }}
      />
      {sub === 'extend' && <ExtendDialog stay={d} onClose={() => setSub(null)} onDone={refresh} />}
      {sub === 'deposit' && <DepositDialog stay={d} mode="receive" onClose={() => setSub(null)} onDone={refresh} />}
      {sub === 'refund' && <DepositDialog stay={d} mode="refund" onClose={() => setSub(null)} onDone={refresh} />}
      {sub === 'close' && <CloseStayDialog stay={d} onClose={() => setSub(null)} onDone={() => setSub(null)} />}
      {sub === 'move' && <MoveDialog stay={d} free={freeRooms} onClose={() => setSub(null)} onDone={refresh} />}
      {sub === 'edit' && <EditStayDialog stay={d} onClose={() => setSub(null)} onDone={refresh} />}
    </Dialog>
  );
}

/** 刷新这张入住单与看板（结果待确认查回后也一样） */
function useStayRefresh(id: number) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: stayKey(id) });
    void qc.invalidateQueries({ queryKey: roomsKey });
  };
}

/** 续住：全天房改预计离店（只做提醒，房费按实际住的晚数夜审、退房时挂）；钟点房加一段（马上挂上） */
function ExtendDialog({ stay, onClose, onDone }: { stay: StayDetail; onClose: () => void; onDone: () => void }) {
  const session = useSession();
  const toast = useToast();
  const refresh = useStayRefresh(stay.id);
  const [leave, setLeave] = useState(stay.expectedCheckoutDate ?? session.today);
  const op = useFrontdeskOp<StayDetail>({
    type: 'room_extend',
    visitId: null,
    stayId: stay.id,
    staffName: session.staff.displayName,
    pick: (found) => (found.type === 'room_extend' ? found.stay : null),
  });
  const hourly = stay.kind === 'hourly';
  const ok = hourly || (!!leave && leave >= stay.businessDate);
  const finish = (d: StayDetail) => {
    toast({ tone: 'success', title: hourly ? `${d.roomNo} 已加一段` : `${d.roomNo} 预计离店改为 ${dayText(d.expectedCheckoutDate ?? leave)}` });
    refresh();
    onDone();
    onClose();
  };
  const submit = async () => {
    if (!ok) return;
    const d = await op.submit((key) => ({
      url: `/api/rooms/stays/${stay.id}/extend`,
      body: hourly ? { clientKey: key, addBlock: true } : { clientKey: key, expectedCheckoutDate: leave },
      tagCodes: [`房 ${stay.roomNo}`],
      summary: hourly ? `钟点房加一段` : `续住到 ${dayText(leave)}`,
      amount: hourly ? stay.rate : null,
    }));
    if (d) finish(d);
  };
  return (
    <Dialog
      open
      onClose={op.busy ? () => {} : onClose}
      title={`${hourly ? '加一段' : '续住'} · ${stay.roomNo}`}
      description={
        hourly
          ? `钟点房按段计价：加一段马上挂 ${formatYuan(stay.rate)}。退房时超过已付时段（加宽限）的按段补齐。`
          : '改预计离店日期（只做提醒）。房费按实际住的晚数算：每晚夜审挂一晚，漏挂的退房时补上。'
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={op.busy}>
            取消
          </Button>
          <Button variant="primary" disabled={!ok || op.locked} loading={op.busy} onClick={submit} data-testid="stay-extend-submit">
            {hourly ? `加一段 ${formatYuan(stay.rate)}` : '保存'}
          </Button>
        </>
      }
    >
      <PendingPanel op={op} onResolved={finish} />
      {!hourly && (
        <Field label="预计离店" htmlFor="stay-leave">
          <Input fullWidth={false} id="stay-leave" type="date" min={stay.businessDate} value={leave} onChange={(e) => setLeave(e.target.value)} disabled={op.locked} className="w-48" data-testid="stay-extend-date" />
        </Field>
      )}
      {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} className="mt-3" />}
    </Dialog>
  );
}

/** 收押金 / 退押金：退按原收款方式原路退，不超过这种方式收的押金余额 */
function DepositDialog({ stay, mode, onClose, onDone }: { stay: StayDetail; mode: 'receive' | 'refund'; onClose: () => void; onDone: () => void }) {
  const session = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = useStayRefresh(stay.id);
  const receive = mode === 'receive';
  const methods = stay.depositByMethod.filter((m) => m.balance > 0);
  const first = methods[0];
  const [draft, setDraft] = useState<DepositDraft>(() => ({ method: receive ? 'cash' : (first?.method ?? 'cash'), amount: receive ? '' : first ? centsToInput(first.balance) : '', ref: '' }));
  const [reason, setReason] = useState('');
  const shiftReady = useShiftReady();
  const op = useFrontdeskOp<StayDetail>({
    type: receive ? 'room_deposit' : 'room_refund',
    visitId: null,
    stayId: stay.id,
    staffName: session.staff.displayName,
    pick: (found) => ((found.type === 'room_deposit' && receive) || (found.type === 'room_refund' && !receive) ? found.stay : null),
  });
  useEffect(() => {
    if (op.state.phase === 'error' && SHIFT_ERRORS.includes(op.state.code ?? '')) void qc.invalidateQueries({ queryKey: shiftKeys.all });
    if (op.state.phase === 'error' && op.state.code === 'DEPOSIT_INSUFFICIENT') refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [op.state]);
  const cents = parseYuan(draft.amount);
  const balance = methods.find((m) => m.method === draft.method)?.balance ?? 0;
  const problem = receive
    ? depositProblem(draft, { required: true })
    : !cents || cents <= 0
      ? '请填写退的金额'
      : cents > balance
        ? `${PAYMENT_METHOD_LABELS[draft.method]}收的押金只剩 ${formatYuan(balance)}`
        : reason.trim().length < 2
          ? '请填写退押金原因（至少 2 个字）'
          : null;
  const ok = problem === null && shiftReady.ready;
  const finish = (d: StayDetail) => {
    toast({ tone: 'success', title: `${d.roomNo} ${receive ? '已收押金' : '已退押金'}`, body: `押金余额 ${formatYuan(d.depositBalance)}` });
    refresh();
    onDone();
    onClose();
  };
  const submit = async () => {
    if (!ok || !cents) return;
    const d = await op.submit((key) => ({
      url: `/api/rooms/stays/${stay.id}/${receive ? 'deposits' : 'refunds'}`,
      body: receive ? { clientKey: key, method: draft.method, amount: cents, ref: draft.ref.trim() } : { clientKey: key, method: draft.method, amount: cents, reason: reason.trim() },
      tagCodes: [`房 ${stay.roomNo}`],
      summary: `${receive ? '收' : '退'}押金（${PAYMENT_METHOD_LABELS[draft.method]}）`,
      amount: cents,
    }));
    if (d) finish(d);
  };
  return (
    <Dialog
      open
      onClose={op.busy ? () => {} : onClose}
      title={`${receive ? '收押金' : '退押金'} · ${stay.roomNo}`}
      description={
        receive
          ? '押金是负债，不算营业额；现金押金计入你当班的应有现金。退房时原路退回或抵扣房费。'
          : '押金按原收款方式原路退：现金从你当班的钱箱退，扫码、银行卡在商户后台退。退房时余下的押金会自动原路退回。'
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={op.busy}>
            取消
          </Button>
          <Button variant="primary" disabled={!ok || op.locked} loading={op.busy} onClick={submit} data-testid="stay-deposit-submit">
            {receive ? '确认收押金' : '确认退押金'}
          </Button>
        </>
      }
    >
      <PendingPanel op={op} onResolved={finish} />
      <div className="space-y-3" data-testid="stay-deposit-form">
        <ShiftGate action={receive ? '收押金' : '退押金'} />
        {receive ? (
          <DepositFields value={draft} onChange={setDraft} disabled={op.locked} />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                fullWidth={false}
                value={draft.method}
                onChange={(e) => {
                  const m = e.target.value as PaymentMethod;
                  const b = methods.find((x) => x.method === m)?.balance ?? 0;
                  setDraft({ ...draft, method: m, amount: b > 0 ? centsToInput(b) : '' });
                }}
                disabled={op.locked}
                className="h-10 w-[160px]"
                aria-label="退回的方式"
              >
                {methods.map((m) => (
                  <option key={m.method} value={m.method}>
                    {PAYMENT_METHOD_LABELS[m.method]}（{formatYuan(m.balance)}）
                  </option>
                ))}
              </Select>
              <Input
                fullWidth={false}
                value={draft.amount}
                onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
                inputMode="decimal"
                disabled={op.locked}
                className="num h-10 w-[140px] font-semibold"
                aria-label="退的金额"
                data-testid="stay-refund-amount"
              />
            </div>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="退押金原因（至少 2 个字），例如：客人要求少押一些" maxLength={200} disabled={op.locked} aria-label="退押金原因" data-testid="stay-refund-reason" />
          </>
        )}
        {problem && (receive ? draft.amount : true) && <p className="text-[12.5px] font-semibold text-clay">{problem}</p>}
        {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} />}
      </div>
    </Dialog>
  );
}

/** 换房：只能换到空闲的房间；房价按入住时的不变；原房间变待打扫 */
function MoveDialog({ stay, free, onClose, onDone }: { stay: StayDetail; free: RoomBoard['rooms']; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [to, setTo] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = free.find((r) => r.id === to) ?? null;
  const save = async () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/rooms/stays/${stay.id}/move`, { toRoomId: target.id, reason: reason.trim() });
      toast({ tone: 'success', title: `已换到 ${target.roomNo}`, body: `${stay.roomNo} 变为待打扫；房价按入住时的不变。` });
      onDone();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={busy ? () => {} : onClose}
      title={`换房 · ${stay.roomNo}`}
      description="客人换房：入住单、房费与押金跟着换过去，房价按入住时的不变；原房间变为待打扫。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!target || reason.trim().length < 2} onClick={save} data-testid="stay-move-save">
            {target ? `换到 ${target.roomNo}` : '换房'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="换到哪间房">
          {free.map((r) => (
            <button
              key={r.id}
              type="button"
              role="radio"
              aria-checked={to === r.id}
              onClick={() => setTo(r.id)}
              className={cn('h-10 rounded-full border px-3.5 text-[14px] font-bold', to === r.id ? 'border-pine bg-pine text-paper' : 'border-line bg-card text-ink-2 hover:border-line-strong')}
              data-testid={`stay-move-to-${r.roomNo}`}
            >
              <span className="num">{r.roomNo}</span> <span className="text-[11.5px] font-semibold opacity-70">{r.typeName}</span>
            </button>
          ))}
        </div>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="换房原因（至少 2 个字），例如：空调坏了" maxLength={100} aria-label="换房原因" data-testid="stay-move-reason" />
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}

/** 改登记：住客称呼、人数（会员按手牌上登记的） */
function EditStayDialog({ stay, onClose, onDone }: { stay: StayDetail; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [guests, setGuests] = useState(stay.guests);
  const [label, setLabel] = useState(stay.guestLabel);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok = Number.isInteger(guests) && guests >= 1 && guests <= MAX_STAY_GUESTS && label.trim().length <= 16;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/api/rooms/stays/${stay.id}`, { guests, guestLabel: label.trim() });
      toast({ tone: 'success', title: `${stay.roomNo} 的登记已保存` });
      onDone();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={busy ? () => {} : onClose}
      title={`改登记 · ${stay.roomNo}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!ok} onClick={save} data-testid="stay-edit-save">
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="入住人数" htmlFor="stay-guests">
          <Input
            fullWidth={false}
            id="stay-guests"
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_STAY_GUESTS}
            value={String(guests)}
            onChange={(e) => setGuests(Math.trunc(Number(e.target.value)) || 0)}
            className="num w-24 text-[16px] font-bold"
            data-testid="stay-edit-guests"
          />
        </Field>
        <Field label="住客称呼" htmlFor="stay-label">
          <Input id="stay-label" value={label} maxLength={16} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}
