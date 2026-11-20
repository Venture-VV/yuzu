// 房间详情（技师服务的房间、派对房一类、大厅类）：现在的状态与里面的客人，能做的动作，房间历史。
// 动作按状态给：空闲 → 登记 / 开单、标待清、维修；在用 → 上钟、下钟、续钟、同房加人、换房、并房 / 拆并、退房（派对房是结束计费、撤单）；
// 待清 → 清洁完成；维修 → 恢复、改维修信息。没有权限的按钮是灰的（写明要哪项权限）。客房不在这里：点客房卡片打开的是客房原来的对话框。
// 房间动作带操作编号（8.1.16）：这间房上有一笔「结果待确认」时顶上写明、能查回 / 原样重提 / 确认作废，同一类的动作先锁住。

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { CalendarClock, CircleCheck, DoorOpen, History, Link2, Play, Plus, Shuffle, Sparkles, Square, Timer, Unlink, UserPlus, Wrench } from 'lucide-react';
import { elapsedText, ROOM_SOURCE_HINTS, ROOM_SOURCE_LABELS, type RoomCard, type RoomEventKind, type RoomSessionView } from '@shared/room-center';
import { spaceLabel } from '@shared/spaces';
import { usageEstimate } from '@shared/usages';
import { api, errorMessage } from '../../lib/api';
import { useCan } from '../../lib/session';
import { cn, formatDateTime, formatTime } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Notice, SectionTitle, Skeleton } from '../../components/ui';
import { useRefreshRoomCenter, useRoomAction, useRoomHistory } from './queries';
import { RoomActionStatus } from './RoomActions';
import { StatusChip } from './status';

export type RoomDialogAction =
  | { kind: 'register'; join: boolean }
  | { kind: 'usage_open' }
  | { kind: 'usage_close'; mode: 'end' | 'cancel' }
  | { kind: 'extend'; session: RoomSessionView }
  | { kind: 'move' | 'merge' | 'checkout' | 'maintenance' | 'dirty' | 'restore' };

const SESSION_STATE: Record<RoomSessionView['status'], string> = { waiting: '待上钟', serving: '服务中', done: '已下钟' };
const EVENT_TONE: Partial<Record<RoomEventKind, 'pine' | 'lake' | 'yuzu' | 'clay' | 'neutral'>> = {
  register: 'lake',
  extend: 'lake',
  move_in: 'lake',
  move_out: 'yuzu',
  checkout: 'yuzu',
  dirty: 'yuzu',
  cleaned: 'pine',
  maintenance: 'clay',
  restore: 'pine',
};

/** 一张钟单：技师、项目、计时与金额；上钟、下钟、续钟 */
function SessionRow({
  s,
  now,
  canDispatch,
  canPost,
  busy,
  onClock,
  onExtend,
}: {
  s: RoomSessionView;
  now: number;
  canDispatch: boolean;
  canPost: boolean;
  busy: boolean;
  onClock: (action: 'start' | 'finish') => void;
  onExtend: () => void;
}) {
  const left = s.plannedEnd ? Math.ceil((new Date(s.plannedEnd).getTime() - now) / 60_000) : null;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5" data-testid={`rc-session-${s.sessionNo}`}>
      <span className="min-w-0 flex-1 basis-48">
        <span className="block text-[14px] font-bold text-ink">
          {s.techNo} 号 {s.techName} · {s.itemName} × {s.clocks}
        </span>
        <span className="block text-[12.5px] text-ink-3">
          <span className={cn('font-semibold', s.status === 'serving' ? 'text-lake' : 'text-ember-deep')}>{SESSION_STATE[s.status]}</span>
          {s.status === 'serving' && s.startedAt && (
            <>
              {' '}
              · {formatTime(s.startedAt)} 上钟，已用 {elapsedText(s.startedAt, now)}
              {left !== null && <span className={left < 0 ? 'font-bold text-clay' : undefined}>{left < 0 ? `，超 ${-left} 分` : `，剩 ${left} 分`}</span>}
            </>
          )}
          {s.status === 'done' && s.endedAt && ` · ${formatTime(s.endedAt)} 下钟`} · {s.sessionNo}
        </span>
      </span>
      <Money cents={s.amount} className="text-[16px] font-bold text-ink" />
      <span className="flex gap-1.5">
        {s.status === 'waiting' && (
          <Button size="sm" variant="primary" icon={<Play className="size-3.5" />} disabled={!canDispatch || busy} onClick={() => onClock('start')} data-testid={`rc-start-${s.sessionNo}`}>
            上钟
          </Button>
        )}
        {s.status === 'serving' && (
          <>
            <Button size="sm" variant="secondary" icon={<Plus className="size-3.5" />} disabled={!canPost || busy} onClick={onExtend} data-testid={`rc-extend-${s.sessionNo}`}>
              续钟
            </Button>
            <Button size="sm" variant="secondary" icon={<Square className="size-3.5" />} disabled={!canDispatch || busy} onClick={() => onClock('finish')} data-testid={`rc-finish-${s.sessionNo}`}>
              下钟
            </Button>
          </>
        )}
      </span>
    </li>
  );
}

function HistoryList({ spaceId }: { spaceId: number }) {
  const q = useRoomHistory(spaceId);
  const [all, setAll] = useState(false);
  if (q.isPending) return <Skeleton className="h-24" />;
  if (q.isError && !q.data) return <LoadFailed title="房间历史没取回来" onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  const rows = q.data!.rows;
  if (rows.length === 0) return <EmptyState art="calm" title="还没有记录" description="登记、换房、退房、维修、清洁完成，以及这间房里的钟、使用单，都会记在这里。" className="py-6" />;
  return (
    <>
      <ol className="divide-y divide-line/70" data-testid="rc-history">
        {(all ? rows : rows.slice(0, 8)).map((r) => (
          <li key={r.key} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-2 text-[13px]" data-testid="rc-history-row">
            <span className="num w-[92px] shrink-0 text-[12.5px] text-ink-3">{formatDateTime(r.at)}</span>
            <Badge tone={r.kind ? (EVENT_TONE[r.kind] ?? 'neutral') : 'neutral'}>{r.label}</Badge>
            <span className="min-w-0 flex-1 basis-56 text-ink-2">{r.text}</span>
            <span className="shrink-0 text-[12.5px] text-ink-3">{r.staffName}</span>
          </li>
        ))}
      </ol>
      {rows.length > 8 && !all && (
        <Button size="sm" variant="ghost" className="mt-1" onClick={() => setAll(true)} data-testid="rc-history-more">
          看全部 {rows.length} 条
        </Button>
      )}
    </>
  );
}

export function RoomDialog({ room, now, onClose, onAction }: { room: RoomCard; now: number; onClose: () => void; onAction: (a: RoomDialogAction) => void }) {
  const can = useCan();
  const toast = useToast();
  const navigate = useNavigate();
  const refresh = useRefreshRoomCenter();
  const stateAct = useRoomAction(room, 'space_state');
  const dispatchAct = useRoomAction(room, 'space_dispatch');
  const [clockBusy, setClockBusy] = useState(false);
  const [clockError, setClockError] = useState<string | null>(null);
  const canDispatch = can('technician.dispatch');
  const canPost = canDispatch && can('frontdesk.operate');
  const canHousekeep = can('room.housekeep');
  const canUsage = can('room.operate');
  const label = spaceLabel(room.code, room.name);
  const registered = room.guests.some((g) => g.registrationId !== null);

  // 上钟、下钟走钟房原来的接口（钟房日志、技师排位都照旧）
  const clock = async (s: RoomSessionView, action: 'start' | 'finish') => {
    setClockBusy(true);
    setClockError(null);
    try {
      await api.post(`/api/clockroom/sessions/${s.id}/${action}`);
      toast({ tone: 'success', title: `${s.techNo} 号${action === 'start' ? '上钟' : '下钟'}`, body: `${label} · ${s.itemName}` });
    } catch (e) {
      setClockError(errorMessage(e));
    } finally {
      setClockBusy(false);
      refresh();
    }
  };
  /** 清洁完成（改房态那一类）、拆并（调度那一类）：不用另填什么，点了就提交 */
  const cleaned = async () => {
    if (await stateAct.run('cleaned', { expectedVersion: room.version }, `清洁完成 ${room.code}`)) toast({ tone: 'success', title: `${room.code} 清洁完成，可以用了` });
  };
  const unmerge = async () => {
    if (await dispatchAct.run('unmerge', { expectedVersion: room.version }, `拆并 ${room.code}（${room.merged.map((m) => m.code).join(' + ')}）`))
      toast({ tone: 'success', title: `${room.code} 已拆并` });
  };
  const stateOff = !canHousekeep || stateAct.locked;
  const dispatchOff = !canDispatch || dispatchAct.locked;
  const usageMinutes = room.usage ? Math.max(0, Math.floor((now - new Date(room.usage.openedAt).getTime()) / 60_000)) : 0;

  return (
    <Dialog
      open
      onClose={onClose}
      width="max-w-2xl"
      title={
        <span className="flex flex-wrap items-center gap-2">
          {label} <StatusChip status={room.status} />
        </span>
      }
      description={`${room.businessType}${room.floor ? ` · ${room.floor}` : ''}${room.capacity ? ` · ${room.capacity} 人` : ''} · ${ROOM_SOURCE_LABELS[room.kind]}：${ROOM_SOURCE_HINTS[room.kind]}`}
    >
      <div className="space-y-5" data-testid="rc-room-dialog" data-status={room.status}>
        <RoomActionStatus action={stateAct} room={room} />
        <RoomActionStatus action={dispatchAct} room={room} />
        {room.merged.length > 1 && (
          <Notice
            tone="info"
            icon={<Link2 className="size-4" />}
            title={`并房：${room.merged.map((m) => m.code).join(' + ')}（主房 ${room.merged[0]!.code}）`}
            data-testid="rc-merged"
            action={
              <Button size="sm" variant="secondary" icon={<Unlink className="size-3.5" />} disabled={dispatchOff} loading={dispatchAct.busy} onClick={() => void unmerge()} data-testid="rc-unmerge">
                拆并
              </Button>
            }
          >
            只是看板与历史上连在一起，账还在各自客人的手牌上。
          </Notice>
        )}

        {room.maintenance && (
          <Notice tone="error" icon={<Wrench className="size-4" />} title={`维修中：${room.maintenance.reason}`} data-testid="rc-maintenance-info">
            预计 {formatDateTime(room.maintenance.expectedAt)} 完成
            {new Date(room.maintenance.expectedAt).getTime() < now && <b className="text-clay">（已过预计时间）</b>} · {room.maintenance.byName} {formatDateTime(room.maintenance.at)} 设的
          </Notice>
        )}
        {room.status === 'dirty' && (
          <Notice tone="warning" icon={<Sparkles className="size-4" />} title={room.dirtySince ? `${formatDateTime(room.dirtySince)} 起待清` : '待清'} data-testid="rc-dirty-info">
            {room.dirtyNote ? `${room.dirtyNote}。` : ''}待清的房间不能登记、不能开单；打扫好了点「清洁完成」。
          </Notice>
        )}
        {room.booking && (
          <Notice
            tone="info"
            icon={<CalendarClock className="size-4" />}
            title={`今天 ${formatTime(room.booking.startsAt)}–${formatTime(room.booking.endsAt)} 已预订：${room.booking.guest} · ${room.booking.guests} 人`}
            data-testid="rc-booking-info"
            action={
              <Button size="sm" variant="ghost" disabled={!can('booking.manage')} onClick={() => navigate('/bookings')}>
                去预约看板
              </Button>
            }
          >
            {room.booking.bookingNo}。客人到店时在预约看板点「到店」；现在给别的客人用，注意别和预约的时间撞上。
          </Notice>
        )}

        {room.guests.map((g) => (
          <section key={g.visitId} className="rounded-lg border border-line px-4 py-3" data-testid={`rc-guest-${g.tagCode}`}>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="num text-[16px] font-bold text-ink">手牌 {g.tagCode}</span>
              <span className="text-[14px] font-semibold text-ink-2">{g.guest}</span>
              {g.memberGradeLabel && <Badge tone="yuzu">{g.memberGradeLabel}</Badge>}
              {g.registrationId === null && <Badge tone="neutral">钟房派进来的，没有登记单</Badge>}
            </p>
            <p className="mt-0.5 text-[12.5px] text-ink-3">
              {formatTime(g.since)} {g.registrationId === null ? '派钟' : '登记'}
              {g.sellerNo && ` · 出单员 ${g.sellerNo} ${g.sellerName}`}
              {g.note && ` · 备注：${g.note}`}
            </p>
            <ul className="mt-1 divide-y divide-line/70">
              {g.sessions.map((s) => (
                <SessionRow
                  key={s.id}
                  s={s}
                  now={now}
                  canDispatch={canDispatch}
                  canPost={canPost}
                  busy={clockBusy}
                  onClock={(a) => void clock(s, a)}
                  onExtend={() => onAction({ kind: 'extend', session: s })}
                />
              ))}
            </ul>
            {g.sessions.length === 0 && <p className="mt-1 text-[13px] text-ink-3">这位客人在这间房里没有钟了（钟被取消或转走）：可以退房。</p>}
            <p className="mt-1 flex flex-wrap items-baseline justify-end gap-x-4 text-[12.5px] text-ink-3">
              <span>
                这间房 <Money cents={g.amount} className="text-[16px] font-bold text-ink" />
              </span>
              <span>
                手牌账单 <Money cents={g.billAmount} className="font-semibold text-ink-2" />
              </span>
            </p>
          </section>
        ))}
        {room.usage && (
          <section className="rounded-lg border border-line px-4 py-3" data-testid="rc-usage">
            <p className="flex flex-wrap items-center gap-x-2">
              <span className="num text-[16px] font-bold text-ink">手牌 {room.usage.tagCode}</span>
              <span className="text-[14px] text-ink-2">
                {room.usage.guests} 人 · {formatTime(room.usage.openedAt)} 开单，已用 {elapsedText(room.usage.openedAt, now)}
              </span>
            </p>
            <p className="mt-0.5 text-[12.5px] text-ink-3">
              {room.usage.usageNo}
              {room.usage.note && ` · ${room.usage.note}`}
              {room.usage.pricing ? (
                <>
                  {' '}
                  · 按现在结束约 <Money cents={usageEstimate(usageMinutes, room.usage.pricing)} className="text-[16px] font-bold text-ink" />
                </>
              ) : (
                ' · 这个业态没设计费，结束不收房费'
              )}
            </p>
          </section>
        )}
        {clockError && <Notice tone="error" title={clockError} />}

        <div className="flex flex-wrap gap-2" data-testid="rc-actions">
          {room.kind === 'service' && (room.status === 'free' || room.status === 'booked') && (
            <Button
              variant="primary"
              icon={<DoorOpen className="size-4" />}
              className="h-11"
              disabled={!canPost}
              onClick={() => onAction({ kind: 'register', join: false })}
              data-testid="rc-act-register"
            >
              登记
            </Button>
          )}
          {room.kind === 'party' && (room.status === 'free' || room.status === 'booked') && (
            <Button variant="primary" icon={<DoorOpen className="size-4" />} className="h-11" disabled={!canUsage} onClick={() => onAction({ kind: 'usage_open' })} data-testid="rc-act-usage-open">
              开单
            </Button>
          )}
          {room.usage && (
            <>
              <Button
                variant="primary"
                icon={<Square className="size-4" />}
                className="h-11"
                disabled={!canUsage}
                onClick={() => onAction({ kind: 'usage_close', mode: 'end' })}
                data-testid="rc-act-usage-end"
              >
                {room.usagePriced ? '结束计费' : '结束使用'}
              </Button>
              <Button variant="ghost" className="h-11" disabled={!canUsage} onClick={() => onAction({ kind: 'usage_close', mode: 'cancel' })} data-testid="rc-act-usage-cancel">
                撤单
              </Button>
            </>
          )}
          {room.kind === 'service' && room.status === 'in_use' && (
            <>
              {registered && (
                <Button variant="primary" icon={<DoorOpen className="size-4" />} className="h-11" disabled={dispatchOff} onClick={() => onAction({ kind: 'checkout' })} data-testid="rc-act-checkout">
                  退房
                </Button>
              )}
              <Button variant="secondary" icon={<Shuffle className="size-4" />} className="h-11" disabled={dispatchOff} onClick={() => onAction({ kind: 'move' })} data-testid="rc-act-move">
                换房
              </Button>
              <Button
                variant="secondary"
                icon={<UserPlus className="size-4" />}
                className="h-11"
                disabled={!canPost}
                onClick={() => onAction({ kind: 'register', join: true })}
                data-testid="rc-act-join"
              >
                同房加人
              </Button>
            </>
          )}
          {(room.kind === 'service' || room.kind === 'party') && room.status === 'in_use' && room.merged.length <= 1 && (
            <Button variant="secondary" icon={<Link2 className="size-4" />} className="h-11" disabled={dispatchOff} onClick={() => onAction({ kind: 'merge' })} data-testid="rc-act-merge">
              并房
            </Button>
          )}
          {room.status === 'dirty' && (
            <Button
              variant="primary"
              icon={<CircleCheck className="size-4" />}
              className="h-11"
              disabled={stateOff}
              loading={stateAct.busy}
              onClick={() => void cleaned()}
              data-testid="rc-act-cleaned"
            >
              清洁完成
            </Button>
          )}
          {(room.status === 'free' || room.status === 'booked') && (
            <Button variant="secondary" icon={<Sparkles className="size-4" />} className="h-11" disabled={stateOff} onClick={() => onAction({ kind: 'dirty' })} data-testid="rc-act-dirty">
              标为待清
            </Button>
          )}
          {room.status === 'maintenance' ? (
            <>
              <Button variant="primary" icon={<CircleCheck className="size-4" />} className="h-11" disabled={stateOff} onClick={() => onAction({ kind: 'restore' })} data-testid="rc-act-restore">
                恢复
              </Button>
              <Button
                variant="secondary"
                icon={<Timer className="size-4" />}
                className="h-11"
                disabled={stateOff}
                onClick={() => onAction({ kind: 'maintenance' })}
                data-testid="rc-act-maintenance-edit"
              >
                改维修信息
              </Button>
            </>
          ) : (
            room.status !== 'in_use' && (
              <Button variant="secondary" icon={<Wrench className="size-4" />} className="h-11" disabled={stateOff} onClick={() => onAction({ kind: 'maintenance' })} data-testid="rc-act-maintenance">
                维修
              </Button>
            )
          )}
        </div>
        {(!canDispatch || !canHousekeep) && (
          <p className="text-[12.5px] text-ink-3">
            灰的按钮是当前岗位没有权限：登记、换房、退房、并房要「钟房派钟」，标待清、清洁完成、维修、恢复要「客房打扫、维修」，派对房开单要「客房入住、退房」。
          </p>
        )}

        <section>
          <SectionTitle className="mb-1">
            <span className="flex items-center gap-1.5">
              <History className="size-4" /> 房间历史
            </span>
          </SectionTitle>
          <HistoryList spaceId={room.spaceId!} />
        </section>
      </div>
    </Dialog>
  );
}
