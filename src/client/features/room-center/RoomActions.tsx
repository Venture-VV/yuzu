// 房态中心的房间动作（《浴族系统需求汇总》房态中心第 4 条）：续钟、换房、退房、并房、维修 / 恢复、标待清。
// 续钟要挂账，与前台同一套「结果待确认」；换房、退房、并房、维修、恢复、标待清 8.1.16 起也带操作编号（queries.ts 的 useRoomAction）：
// 结果不确定时这间房上同一类的动作锁住，对话框里查回、按原内容重新提交或确认作废。

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Banknote, CircleStop } from 'lucide-react';
import { formatYuan } from '@shared/money';
import { MAX_MAINTENANCE_REASON, MAX_ROOM_NOTE, ROOM_STATUS_LABELS, type RoomCard, type RoomCenterBoard, type RoomSessionView } from '@shared/room-center';
import { spaceLabel } from '@shared/spaces';
import { api, errorMessage } from '../../lib/api';
import { serverNowMs } from '../../lib/serverClock';
import { useCan, useSession } from '../../lib/session';
import { cn, formatDateTime } from '../../lib/utils';
import { LoadFailed } from '../../components/LoadFailed';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Button, ConfirmCheck, Field, Input, Notice, Segmented, Skeleton } from '../../components/ui';
import { FRONTDESK_OP_LABELS, PendingPanel, useFrontdeskOp } from '../frontdesk/pending';
import { roomUrl, useCheckoutPreview, useRefreshRoomCenter, useRoomAction } from './queries';
import { ClockStepper, foundPosted } from './RegisterDialog';
import { STATUS_META } from './status';

const nameOf = (room: Pick<RoomCard, 'code' | 'name'>) => spaceLabel(room.code, room.name);

/** 房间动作的提交状态：被拒绝的写原因；结果待确认时显示查回 / 按原内容重新提交 / 确认作废（处理完：生效了的提示只生效一次） */
export function RoomActionStatus({ action, room, onResolved }: { action: ReturnType<typeof useRoomAction>; room: Pick<RoomCard, 'code'>; onResolved?: () => void }) {
  const toast = useToast();
  return (
    <>
      <PendingPanel
        op={action.op}
        onResolved={() => {
          action.resolved();
          toast({ tone: 'success', title: `房 ${room.code} 的${FRONTDESK_OP_LABELS[action.type]}已生效`, body: '只生效了一次，不用重新操作。' });
          onResolved?.();
        }}
      />
      {action.op.state.phase === 'error' && <Notice tone="error" title={action.op.state.message} data-testid="rc-action-error" />}
    </>
  );
}

/** 续钟：原技师继续，按这张钟单的项目与档次加收，计划时长跟着加 */
export function ExtendRoomDialog({ room, session: s, onClose, onDone }: { room: RoomCard; session: RoomSessionView; onClose: () => void; onDone: (board: RoomCenterBoard | null) => void }) {
  const me = useSession();
  const [quantity, setQuantity] = useState(1);
  const op = useFrontdeskOp<RoomCenterBoard | true>({ type: 'bill_post', visitId: s.visitId, staffName: me.staff.displayName, pick: foundPosted });
  const finish = (r: RoomCenterBoard | true) => onDone(r === true ? null : r);
  const total = s.unitPrice !== null ? s.unitPrice * quantity : 0;
  const perClock = Math.round(s.minutes / s.clocks);
  const submit = async () => {
    if (s.unitPrice === null) return;
    const done = await op.submit((key) => ({
      url: roomUrl(room.spaceId!, 'extend'),
      body: { clientKey: key, sessionId: s.id, quantity, expectedTotal: total },
      tagCodes: [room.guests.find((g) => g.visitId === s.visitId)?.tagCode ?? room.code],
      summary: `续钟 ${nameOf(room)}：${s.itemName} × ${quantity}（${s.techNo} 号 ${s.techName}）`,
      amount: total,
    }));
    if (done) finish(done);
  };
  return (
    <Dialog
      open
      onClose={op.busy ? () => {} : onClose}
      title={`续钟 · ${nameOf(room)}`}
      description={`${s.techNo} 号 ${s.techName} · ${s.itemName}。原技师继续，按原来的档次加收，挂到这位客人的手牌账单上；计时跟着往后延。`}
      footer={
        <>
          <span className="mr-auto self-center text-[13px] text-ink-3">
            合计 <Money cents={total} className="text-[18px] font-bold text-ink" />
          </span>
          <Button variant="ghost" onClick={onClose} disabled={op.busy}>
            取消
          </Button>
          <Button variant="primary" size="lg" disabled={s.unitPrice === null || op.locked} loading={op.busy} onClick={() => void submit()} data-testid="rc-extend-submit">
            续 {quantity} 钟
          </Button>
        </>
      }
    >
      <PendingPanel op={op} onResolved={finish} />
      <div className="flex flex-wrap items-center gap-3" data-testid="rc-extend">
        <ClockStepper value={quantity} onChange={setQuantity} disabled={op.locked} label="续几个钟" testId="rc-extend-qty" />
        <span className="text-[13px] text-ink-3">
          × {s.unitPrice !== null ? formatYuan(s.unitPrice) : '（这张钟单没有有效的挂账）'} · 每钟 {perClock} 分钟，续完共 {s.minutes + perClock * quantity} 分钟
        </span>
      </div>
      {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} className="mt-4" />}
    </Dialog>
  );
}

/** 一排可选的房间（换房、并房都是从里面挑一间） */
function RoomPicker({
  rooms,
  value,
  onChange,
  empty,
  disabled,
  testId,
}: {
  rooms: RoomCard[];
  value: number | null;
  onChange: (spaceId: number) => void;
  empty: string;
  disabled?: boolean;
  testId: string;
}) {
  if (rooms.length === 0) return <p className="rounded-lg border border-dashed border-line-strong px-3 py-4 text-center text-[13px] text-ink-3">{empty}</p>;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="radiogroup" data-testid={testId}>
      {rooms.map((r) => {
        const on = r.spaceId === value;
        const Icon = STATUS_META[r.status].icon;
        return (
          <button
            key={r.key}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(r.spaceId!)}
            className={cn('flex min-h-11 flex-col rounded-lg border px-3 py-2 text-left disabled:opacity-60', on ? 'border-pine bg-pine-tint' : 'border-line bg-card hover:border-line-strong')}
            data-testid={`${testId}-${r.code}`}
          >
            <span className="num text-[16px] font-bold">{r.code}</span>
            <span className="truncate text-[12px] text-ink-3">{r.name}</span>
            <span className={cn('flex items-center gap-1 text-[12px] font-semibold', STATUS_META[r.status].text)}>
              <Icon className="size-3.5" aria-hidden />
              {ROOM_STATUS_LABELS[r.status]}
              {r.guestText ? ` · ${r.guestText}` : ''}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** 换房：换到另一间空闲的技师服务房间；单与计时不动 */
export function MoveRoomDialog({ room, rooms, onClose, onDone }: { room: RoomCard; rooms: RoomCard[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const act = useRoomAction(room, 'space_dispatch');
  const [to, setTo] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const targets = rooms.filter((r) => r.kind === 'service' && r.spaceId !== room.spaceId && (r.status === 'free' || r.status === 'booked'));
  const target = targets.find((r) => r.spaceId === to) ?? null;
  const submit = async () => {
    if (!target) return;
    const ok = await act.run(
      'move',
      { toSpaceId: target.spaceId, expectedVersion: room.version, note: note.trim() },
      `换房 ${room.code} → ${target.code}${note.trim() ? `（${note.trim()}）` : ''}`,
      target.spaceId!,
    );
    if (!ok) return;
    toast({ tone: 'success', title: `已换到 ${target.code}`, body: `${room.code} 的客人整间换过去，单与计时不变` });
    onDone();
  };
  return (
    <Dialog
      open
      onClose={act.busy ? () => {} : onClose}
      width="max-w-2xl"
      title={`换房 · ${nameOf(room)}`}
      description="这间房里的客人整间换到另一间空房。单与计时不变：钟单还是那一张，金额、开始时间都不动，只记从哪间换到哪间。原来的房间有人上过钟就转待清。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={act.busy}>
            取消
          </Button>
          <Button variant="primary" size="lg" disabled={!target || act.locked} loading={act.busy} onClick={() => void submit()} data-testid="rc-move-submit">
            确认换房
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-testid="rc-move">
        <RoomActionStatus action={act} room={room} onResolved={onDone} />
        <Field label="换到哪一间（空闲的技师服务房间）">
          <RoomPicker rooms={targets} value={to} onChange={setTo} disabled={act.locked} empty="现在没有空闲的技师服务房间（待清的先点清洁完成）" testId="rc-move-to" />
        </Field>
        <Field label="说明" htmlFor="rc-move-note" hint="选填，例如 空调不凉、客人要安静的">
          <Input id="rc-move-note" value={note} maxLength={MAX_ROOM_NOTE} disabled={act.locked} onChange={(e) => setNote(e.target.value)} data-testid="rc-move-note" />
        </Field>
      </div>
    </Dialog>
  );
}

/** 并房：和另一间在用的房间记成一起的（只连显示与历史，不动钱） */
export function MergeRoomDialog({ room, rooms, onClose, onDone }: { room: RoomCard; rooms: RoomCard[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const act = useRoomAction(room, 'space_dispatch');
  const [to, setTo] = useState<number | null>(null);
  const targets = rooms.filter((r) => (r.kind === 'service' || r.kind === 'party') && r.spaceId !== room.spaceId && r.status === 'in_use');
  const target = targets.find((r) => r.spaceId === to) ?? null;
  const submit = async () => {
    if (!target) return;
    if (!(await act.run('merge', { withSpaceId: target.spaceId, expectedVersion: room.version }, `并房 ${room.code} 并入 ${target.code}`, target.spaceId!))) return;
    toast({ tone: 'success', title: `${room.code} 已并入 ${target.code}` });
    onDone();
  };
  return (
    <Dialog
      open
      onClose={act.busy ? () => {} : onClose}
      width="max-w-2xl"
      title={`并房 · ${nameOf(room)}`}
      description="把这间房并到另一间在用的房间（那一间是主房）：两间在看板与历史上连在一起。账还在各自客人的手牌上，不搬明细、不动钱；哪一间退房，关系自己解除。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={act.busy}>
            取消
          </Button>
          <Button variant="primary" size="lg" disabled={!target || act.locked} loading={act.busy} onClick={() => void submit()} data-testid="rc-merge-submit">
            确认并房
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-testid="rc-merge">
        <RoomActionStatus action={act} room={room} onResolved={onDone} />
        <Field label="并到哪一间（在用的房间）">
          <RoomPicker rooms={targets} value={to} onChange={setTo} disabled={act.locked} empty="现在没有别的在用的房间" testId="rc-merge-to" />
        </Field>
      </div>
    </Dialog>
  );
}

/**
 * 退房：先看结账预览（这次登记的明细、手牌账单此刻多少）。技师还在钟上的先下钟；账没结的要勾「客人带着手牌继续在店」
 * （或者请客人先到收银台结清——结清以后登记单自己结束，不用再退）。退了以后房间转待清。
 */
export function CheckoutRoomDialog({ room, onClose, onDone }: { room: RoomCard; onClose: () => void; onDone: () => void }) {
  const can = useCan();
  const toast = useToast();
  const navigate = useNavigate();
  const refresh = useRefreshRoomCenter();
  const act = useRoomAction(room, 'space_dispatch');
  const preview = useCheckoutPreview(room.spaceId!, room.version);
  const [inHouse, setInHouse] = useState(false);
  const [finishing, setFinishing] = useState<number | null>(null);
  const [finishError, setFinishError] = useState<string | null>(null);
  const p = preview.data;
  const running = p?.guests.flatMap((g) => g.running) ?? [];
  const unpaid = p?.unpaidTotal ?? 0;
  const ok = !!p && p.guests.length > 0 && running.length === 0 && (unpaid === 0 || inHouse);
  const finish = async (sessionId: number, waiting: boolean) => {
    setFinishing(sessionId);
    setFinishError(null);
    try {
      // 还没上钟的不能下钟：在钟房取消派钟（要写原因、作废明细），这里只带过去
      if (waiting) return navigate('/clockroom');
      await api.post(`/api/clockroom/sessions/${sessionId}/finish`);
    } catch (e) {
      setFinishError(errorMessage(e));
    } finally {
      setFinishing(null);
      refresh();
      void preview.refetch();
    }
  };
  const submit = async () => {
    if (!p || !ok) return;
    const tags = p.guests.map((g) => g.tagCode).join('、');
    if (
      !(await act.run(
        'checkout',
        { expectedVersion: room.version, seenUnpaid: p.unpaidTotal, inHouse },
        `退房 ${room.code}（手牌 ${tags}${unpaid > 0 ? `，账单未结 ${formatYuan(unpaid)}，客人带手牌在店` : ''}）`,
      ))
    )
      return;
    toast({ tone: 'success', title: `${room.code} 已退房，转待清`, body: unpaid > 0 ? `手牌 ${tags} 还有 ${formatYuan(unpaid)} 没结，离店时在收银台结` : undefined });
    onDone();
  };
  return (
    <Dialog
      open
      onClose={act.busy ? () => {} : onClose}
      width="max-w-2xl"
      title={`退房 · ${nameOf(room)}`}
      description="退房前先看一遍账：浴场的账挂在手牌上，离店时在收银台一起结。退了以后这间房转待清。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={act.busy}>
            取消
          </Button>
          <Button variant="primary" size="lg" disabled={!ok || act.locked} loading={act.busy} onClick={() => void submit()} data-testid="rc-checkout-submit">
            确认退房
          </Button>
        </>
      }
    >
      <RoomActionStatus action={act} room={room} onResolved={onDone} />
      {preview.isError && !p ? (
        <LoadFailed title="结账预览没取回来" onRetry={() => void preview.refetch()} retrying={preview.isFetching} />
      ) : !p ? (
        <Skeleton className="h-40" />
      ) : p.guests.length === 0 ? (
        <Notice tone="info" title="这间房现在没有登记的客人" data-testid="rc-checkout-empty">
          可能已经退房，或客人已经在收银台结账离店（房间自己转待清）。钟房直接派进来的钟，下钟以后房间也是自己转待清，不用退房。
        </Notice>
      ) : (
        <div className="space-y-4" data-testid="rc-checkout">
          {p.guests.map((g) => (
            <section key={g.registrationId} className="rounded-lg border border-line px-4 py-3" data-testid={`rc-checkout-guest-${g.tagCode}`}>
              <p className="flex flex-wrap items-baseline gap-x-2 text-[14px]">
                <span className="num text-[16px] font-bold">手牌 {g.tagCode}</span>
                <span className="text-ink-2">{g.guest}</span>
              </p>
              <ul className="mt-2 divide-y divide-line/70 text-[13px]">
                {g.lines.map((l, i) => (
                  <li key={i} className="flex items-baseline gap-2 py-1.5">
                    <span className="min-w-0 flex-1 truncate">
                      {l.name} × {l.quantity}
                      {l.technician && <span className="text-ink-3"> · {l.technician}</span>}
                    </span>
                    <Money cents={l.amount} className="font-semibold" />
                  </li>
                ))}
              </ul>
              <p className="mt-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-[13px] text-ink-2">
                <span>
                  这间房 <Money cents={g.roomAmount} className="font-bold text-ink" />
                </span>
                <span data-testid="rc-checkout-bill">
                  手牌账单合计（没结） <Money cents={g.billAmount} className="text-[18px] font-bold text-ink" />
                </span>
              </p>
              {g.running.map((s) => (
                <Notice
                  key={s.sessionId}
                  tone="warning"
                  className="mt-2"
                  title={`${s.techNo} 号 ${s.techName}${s.status === 'serving' ? '还在钟上' : '的钟派了还没上'}（${s.sessionNo}）`}
                  data-testid="rc-checkout-running"
                  action={
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={<CircleStop className="size-4" />}
                      loading={finishing === s.sessionId}
                      disabled={!can('technician.dispatch')}
                      onClick={() => void finish(s.sessionId, s.status === 'waiting')}
                      data-testid={`rc-checkout-finish-${s.sessionId}`}
                    >
                      {s.status === 'serving' ? '下钟' : '去钟房取消派钟'}
                    </Button>
                  }
                >
                  {s.status === 'serving' ? '先下钟，再退房。' : '还没上钟的先在钟房取消派钟（明细一起作废），或上钟、下钟以后再退。'}
                </Notice>
              ))}
              <p className="mt-2">
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Banknote className="size-4" />}
                  disabled={!can('frontdesk.read')}
                  onClick={() => navigate(`/cashier?v=${g.visitId}`)}
                  data-testid={`rc-checkout-cashier-${g.tagCode}`}
                >
                  去收银台给这张手牌结账
                </Button>
              </p>
            </section>
          ))}
          {finishError && <Notice tone="error" title={finishError} />}
          {unpaid > 0 ? (
            <ConfirmCheck checked={inHouse} onChange={setInHouse}>
              <span data-testid="rc-checkout-inhouse">
                账单还有 <b className="num">{formatYuan(unpaid)}</b> 没结：客人带着手牌继续在店，离店时在收银台结
              </span>
            </ConfirmCheck>
          ) : (
            <Notice tone="success" title="手牌账单上没有未结的金额" />
          )}
        </div>
      )}
    </Dialog>
  );
}

const ETA_UNITS = { hour: { label: '小时', ms: 3_600_000, max: 72 }, day: { label: '天', ms: 86_400_000, max: 365 } } as const;
type EtaUnit = keyof typeof ETA_UNITS;

/** 维修：原因 + 预计完成时间（填「多久以后修好」，页面算出几月几日几点）；已经在维修的是改这两样 */
export function MaintenanceDialog({ room, onClose, onDone }: { room: RoomCard; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const act = useRoomAction(room, 'space_state');
  const editing = room.maintenance !== null;
  const [reason, setReason] = useState(room.maintenance?.reason ?? '');
  const [amount, setAmount] = useState('2');
  const [unit, setUnit] = useState<EtaUnit>('hour');
  const n = /^\d{1,3}$/.test(amount.trim()) ? Number(amount.trim()) : 0;
  const etaOk = n >= 1 && n <= ETA_UNITS[unit].max;
  const expectedAt = etaOk ? new Date(serverNowMs() + n * ETA_UNITS[unit].ms) : null;
  const ok = reason.trim().length >= 2 && expectedAt !== null;
  const submit = async () => {
    if (!ok || !expectedAt) return;
    const summary = `${editing ? '改维修信息' : '维修'} ${room.code}：${reason.trim()}，预计 ${formatDateTime(expectedAt.toISOString())} 完成`;
    if (!(await act.run('maintenance', { reason: reason.trim(), expectedAt: expectedAt.toISOString(), expectedVersion: room.version }, summary))) return;
    toast({ tone: 'success', title: `${room.code} ${editing ? '的维修信息已改' : '已设为维修'}` });
    onDone();
  };
  return (
    <Dialog
      open
      onClose={act.busy ? () => {} : onClose}
      title={`${editing ? '改维修信息' : '维修'} · ${nameOf(room)}`}
      description="维修中的房间不能登记、不能开单，钟房也派不进来；修好了点「恢复」。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={act.busy}>
            取消
          </Button>
          <Button variant="danger" size="lg" disabled={!ok || act.locked} loading={act.busy} onClick={() => void submit()} data-testid="rc-maintenance-submit">
            {editing ? '保存' : '设为维修'}
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-testid="rc-maintenance">
        <RoomActionStatus action={act} room={room} onResolved={onDone} />
        <Field label="原因" htmlFor="rc-mt-reason" hint="至少 2 个字，例如 空调漏水、灯坏了">
          <Input
            id="rc-mt-reason"
            value={reason}
            maxLength={MAX_MAINTENANCE_REASON}
            disabled={act.locked}
            onChange={(e) => setReason(e.target.value)}
            data-autofocus
            data-testid="rc-maintenance-reason"
          />
        </Field>
        <Field
          label="预计多久以后修好"
          htmlFor="rc-mt-eta"
          error={amount.trim() && !etaOk ? `请填 1–${ETA_UNITS[unit].max} 的整数` : null}
          hint={expectedAt ? `预计完成时间：${formatDateTime(expectedAt.toISOString())}` : undefined}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="rc-mt-eta"
              fullWidth={false}
              inputMode="numeric"
              value={amount}
              disabled={act.locked}
              onChange={(e) => setAmount(e.target.value)}
              className="num w-24 text-[16px] font-bold"
              data-testid="rc-maintenance-eta"
            />
            <Segmented<EtaUnit> ariaLabel="单位" value={unit} onChange={setUnit} options={(['hour', 'day'] as const).map((u) => ({ value: u, label: ETA_UNITS[u].label }))} />
          </div>
        </Field>
        {editing && (
          <p className="text-[12.5px] text-ink-3">
            现在记的预计完成时间：{formatDateTime(room.maintenance!.expectedAt)}（{room.maintenance!.byName} {formatDateTime(room.maintenance!.at)} 设的）
          </p>
        )}
      </div>
    </Dialog>
  );
}

/** 标为待清、恢复：带一句说明（选填）的确认 */
export function NoteActionDialog({ room, action, onClose, onDone }: { room: RoomCard; action: 'dirty' | 'restore'; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const act = useRoomAction(room, 'space_state');
  const [note, setNote] = useState('');
  const dirty = action === 'dirty';
  const submit = async () => {
    const summary = `${dirty ? '标为待清' : '恢复'} ${room.code}${note.trim() ? `（${note.trim()}）` : ''}`;
    if (!(await act.run(action, { expectedVersion: room.version, note: note.trim() }, summary))) return;
    toast({ tone: 'success', title: dirty ? `${room.code} 已标为待清` : `${room.code} 已恢复使用` });
    onDone();
  };
  return (
    <Dialog
      open
      onClose={act.busy ? () => {} : onClose}
      title={`${dirty ? '标为待清' : '恢复'} · ${nameOf(room)}`}
      description={dirty ? '待清的房间不能登记、不能开单；打扫好了点「清洁完成」。' : '维修结束：房间回到维修以前的样子（维修前就待清的仍是待清）。'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={act.busy}>
            取消
          </Button>
          <Button variant="primary" size="lg" disabled={act.locked} loading={act.busy} onClick={() => void submit()} data-testid={`rc-${action}-submit`}>
            {dirty ? '标为待清' : '恢复使用'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <RoomActionStatus action={act} room={room} onResolved={onDone} />
        <Field label="说明" htmlFor="rc-note-action" hint={dirty ? '选填，例如 客人打翻了茶' : '选填，例如 配件换好了'}>
          <Input id="rc-note-action" value={note} maxLength={MAX_ROOM_NOTE} disabled={act.locked} onChange={(e) => setNote(e.target.value)} data-autofocus data-testid={`rc-${action}-note`} />
        </Field>
      </div>
    </Dialog>
  );
}
