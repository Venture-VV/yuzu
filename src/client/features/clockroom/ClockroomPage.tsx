// 钟房（v0.7.1）：左边轮钟队列（在岗技师按排位，第一位空闲的是「下一位」）、休息与未上牌；
// 右边上钟中的钟（倒计时、快到钟、超时）与待上钟（已派、技师还没到）。派钟、加钟都是挂账，走前台同一套「结果待确认」。

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import type { BookingDetail } from '@shared/bookings';
import { ArrowDownToLine, ArrowRightLeft, BadgeX, CalendarOff, ClipboardList, Coffee, DoorOpen, Hourglass, ListOrdered, LogIn, LogOut, Play, Plus, RotateCcw, ScrollText, Square, Undo2, UsersRound } from 'lucide-react';
import { EVENT_KIND_LABELS, TECH_FILTER_LABELS, TECH_FILTERS, techFilterOf, type BoardSession, type BoardTechnician, type ClockEvent, type ClockroomBoard, type PendingLine, type TechFilter } from '@shared/clockroom';
import { CALL_TYPE_LABELS, gradeLabel } from '@shared/technicians';
import { spaceLabel } from '@shared/spaces';
import { api, errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn, formatTime } from '../../lib/utils';
import { Money } from '../../components/Money';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { PageHeader } from '../../components/AppShell';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, SectionTitle, Skeleton } from '../../components/ui';
import { DispatchDialog, ExtendDialog, TransferDialog, type DispatchPrefill } from './DispatchDialog';
import { RoomDialog } from './RoomPicker';
import { TECH_STATE_DONE, TechStateDialog, type TechStateAction } from './TechStateDialog';
import { useFrontdeskPending } from '../frontdesk/pending';

export const clockKey = ['clockroom'] as const;

export function useClockroom() {
  return useQuery({ queryKey: clockKey, queryFn: () => api.get<ClockroomBoard>('/api/clockroom'), refetchInterval: 10_000 });
}

/** 以服务器时间为准的「现在」，每秒走一次（终端时钟不准也不影响倒计时） */
function useServerClock(serverTime: string | undefined) {
  const [offset, setOffset] = useState(0);
  const [tick, setTick] = useState(Date.now());
  useEffect(() => {
    if (serverTime) setOffset(new Date(serverTime).getTime() - Date.now());
  }, [serverTime]);
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return tick + offset;
}

const mmss = (ms: number) => {
  const total = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(s).padStart(2, '0')}`;
};

export function ClockroomPage() {
  const session = useSession();
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const board = useClockroom();
  const now = useServerClock(board.data?.serverTime);
  const [dispatching, setDispatching] = useState(false);
  const [extending, setExtending] = useState<BoardSession | null>(null);
  const [voiding, setVoiding] = useState<BoardSession | null>(null);
  const [rooming, setRooming] = useState<BoardSession | null>(null);
  const [toEnd, setToEnd] = useState<BoardTechnician | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // 8.0.8：按状态筛选（B01）、待派钟补派（A01）、转钟（B05）、停牌（B01）、预约到店带入（A04）
  const [filter, setFilter] = useState<TechFilter>('all');
  const [assigning, setAssigning] = useState<PendingLine | null>(null);
  const [transferring, setTransferring] = useState<BoardSession | null>(null);
  // 休假、停牌、复牌走「结果待确认」（合并前 Codex 审查 e2cb70d）：在对话框里做，结果不明时留在对话框里处理
  const [techState, setTechState] = useState<{ t: BoardTechnician; action: TechStateAction } | null>(null);
  const techPending = useFrontdeskPending().filter((p) => p.type === 'technician_state');
  const [prefill, setPrefill] = useState<DispatchPrefill | null>(null);

  // 预约到店（8.0.8，A04）：从预约页过来带 ?booking=，打开派钟并带好手牌、项目、技师；前台已点了这个项目的直接给那一条派（不另收费）
  const [params, setParams] = useSearchParams();
  const bookingParam = Number(params.get('booking')) || null;
  const booking = useQuery({ queryKey: ['bookings', 'one', bookingParam], queryFn: () => api.get<BookingDetail>(`/api/bookings/${bookingParam}`), enabled: !!bookingParam });
  useEffect(() => {
    const b = booking.data;
    const data = board.data;
    if (!b || !data || b.id !== bookingParam) return;
    setParams(
      (p) => {
        p.delete('booking');
        return p;
      },
      { replace: true },
    );
    if (b.kind !== 'technician' || b.status !== 'arrived') {
      toast({ tone: 'error', title: `预约 ${b.bookingNo} 不是已到店的技师预约` });
      return;
    }
    if (b.service) {
      toast({ tone: 'info', title: `预约 ${b.bookingNo} 已经派过钟（${b.service.no}）` });
      return;
    }
    setPrefill({
      tagCode: b.arrivalTagCode ?? undefined,
      itemId: b.itemId ?? undefined,
      technicianId: b.technicianId,
      callType: b.technicianId ? 'designated' : 'rotation',
      bookingId: b.id,
      note: `预约 ${b.bookingNo} 到店（${b.memberName ?? b.guestName ?? '散客'}）：手牌、项目${b.technicianId ? '、技师' : ''}已带好`,
    });
    const pend = data.pending.find((p) => p.tagCode === b.arrivalTagCode && p.itemId === b.itemId);
    if (pend) setAssigning(pend);
    else setDispatching(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booking.data, board.data, bookingParam]);

  // 顶部「结果待确认」点「去处理」过来（?resume=technician_state&t=技师）：打开那位技师的对话框
  const resumeTech = params.get('resume') === 'technician_state' ? Number(params.get('t')) || null : null;
  useEffect(() => {
    if (!resumeTech || !board.data) return;
    setParams(
      (p) => {
        p.delete('resume');
        p.delete('t');
        return p;
      },
      { replace: true },
    );
    const t = board.data.technicians.find((x) => x.id === resumeTech);
    const p = techPending.find((x) => x.technicianIds?.includes(resumeTech));
    if (t && p) setTechState({ t, action: ((p.body as { action?: TechStateAction }).action ?? 'suspend') as TechStateAction });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeTech, board.data]);

  const run = async (key: string, fn: () => Promise<ClockroomBoard>, ok?: string) => {
    setBusy(key);
    try {
      qc.setQueryData(clockKey, await fn());
      if (ok) toast({ tone: 'success', title: ok });
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
      void qc.invalidateQueries({ queryKey: clockKey });
    } finally {
      setBusy(null);
    }
  };
  /** 这位技师有一笔停牌 / 复牌 / 休假结果待确认：先在对话框里处理完，才能做别的 */
  const blockedByPending = (t: BoardTechnician) => {
    const p = techPending.find((x) => x.technicianIds?.includes(t.id));
    if (!p) return false;
    toast({ tone: 'info', title: `${t.techNo} 号有一笔停牌 / 复牌 / 休假结果待确认`, body: '先查回或确认作废，再做别的操作' });
    setTechState({ t, action: ((p.body as { action?: TechStateAction }).action ?? 'suspend') as TechStateAction });
    return true;
  };
  const state = (t: BoardTechnician, action: 'sign_in' | 'rest' | 'back' | 'sign_out' | 'leave' | 'resume', ok: string) => {
    if (blockedByPending(t)) return;
    if (action === 'leave' || action === 'resume') {
      setTechState({ t, action });
      return;
    }
    void run(`${action}-${t.id}`, () => api.post<ClockroomBoard>(`/api/clockroom/technicians/${t.id}/state`, { action }), ok);
  };
  const openSuspend = (t: BoardTechnician) => {
    if (!blockedByPending(t)) setTechState({ t, action: 'suspend' });
  };

  const d = board.data;
  const queue = useMemo(() => (d?.technicians ?? []).filter((t) => t.state === 'on').sort((a, b) => a.position! - b.position!), [d]);
  const resting = (d?.technicians ?? []).filter((t) => t.state === 'rest');
  const off = (d?.technicians ?? []).filter((t) => t.state === 'off' && t.active && !t.suspendedAt);
  const onLeave = (d?.technicians ?? []).filter((t) => t.state === 'leave' && t.active && !t.suspendedAt);
  const suspended = (d?.technicians ?? []).filter((t) => t.suspendedAt && t.active);
  const pending = d?.pending ?? [];
  const counts = useMemo(() => {
    const c = Object.fromEntries(TECH_FILTERS.map((f) => [f, 0])) as Record<TechFilter, number>;
    for (const t of d?.technicians ?? []) {
      if (!t.active) continue;
      c.all += 1;
      c[techFilterOf(t)] += 1;
    }
    return c;
  }, [d]);
  const nextFree = queue.find((t) => !t.busy);
  const serving = (d?.sessions ?? []).filter((s) => s.status === 'serving');
  const waiting = (d?.sessions ?? []).filter((s) => s.status === 'waiting');

  if (!session.technicians) {
    return (
      <>
        <PageHeader title="钟房" />
        <div className="p-8">
          <Notice tone="info" title="技师功能没有开启">店主在「后台 → 技师」开启技师功能后，这里排钟、派钟、上下钟。</Notice>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="钟房"
        subtitle={d ? `营业日 ${d.businessDate} · 今日 ${d.today.clocks} 钟（点钟 ${d.today.designated} · 轮钟 ${d.today.rotation}）` : '载入中'}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" icon={<ScrollText className="size-4" />} onClick={() => setShowLog(true)} data-testid="clock-log-open">
              钟房日志
            </Button>
            <Button variant="primary" icon={<Plus className="size-4" />} disabled={!d || !can('frontdesk.operate')} onClick={() => setDispatching(true)} data-testid="clock-dispatch">
              派钟
            </Button>
          </div>
        }
      />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {!d ? (
          <div className="p-6">
            <Skeleton className="h-64" />
          </div>
        ) : (
          <>
          <div className="mx-auto flex max-w-[1280px] flex-wrap gap-1.5 px-5 pt-5 md:px-7" role="group" aria-label="按状态筛选技师" data-testid="clock-filter">
            {TECH_FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                aria-pressed={filter === f}
                className={cn('h-8 rounded-full border px-3 text-[13px] font-semibold', filter === f ? 'border-pine bg-pine text-paper' : 'border-line-strong bg-card text-ink-2 hover:border-ink-4')}
                data-testid={`clock-filter-${f}`}
              >
                {TECH_FILTER_LABELS[f]} <span className="num">{counts[f]}</span>
              </button>
            ))}
          </div>
          {filter !== 'all' ? (
            <FilteredTechs
              filter={filter}
              board={d}
              now={now}
              busy={busy}
              canPost={can('frontdesk.operate')}
              onState={(t, action, ok) => state(t, action, ok)}
              onSuspend={openSuspend}
              onToEnd={(t) => !blockedByPending(t) && setToEnd(t)}
              onStart={(s) => run(`start-${s.id}`, () => api.post(`/api/clockroom/sessions/${s.id}/start`), `${s.techNo} 号上钟`)}
              onFinish={(s) => run(`finish-${s.id}`, () => api.post(`/api/clockroom/sessions/${s.id}/finish`), `${s.techNo} 号下钟`)}
              onTransfer={(s) => setTransferring(s)}
            />
          ) : (
          <div className="mx-auto grid max-w-[1280px] grid-cols-1 gap-5 px-5 py-5 md:px-7 lg:grid-cols-[340px_minmax(0,1fr)]" data-testid="clockroom">
            <div className="space-y-4">
              <Card className="p-4" data-testid="clock-queue">
                <SectionTitle aside={<span className="text-[12px] text-ink-3">在岗 {queue.length} 人</span>}>
                  <span className="flex items-center gap-1.5">
                    <ListOrdered className="size-4 text-pine" /> 轮钟排队
                  </span>
                </SectionTitle>
                {queue.length === 0 ? (
                  <p className="mt-3 rounded-lg border border-dashed border-line-strong px-3 py-6 text-center text-[13px] text-ink-3">还没有技师上牌</p>
                ) : (
                  <ol className="mt-3 space-y-1.5">
                    {queue.map((t) => (
                      <QueueRow
                        key={t.id}
                        t={t}
                        next={t.id === nextFree?.id}
                        sessions={d.sessions}
                        now={now}
                        busy={busy}
                        onRest={() => state(t, 'rest', `${t.techNo} 号休息`)}
                        onOff={() => state(t, 'sign_out', `${t.techNo} 号下牌`)}
                        onToEnd={() => !blockedByPending(t) && setToEnd(t)}
                      />
                    ))}
                  </ol>
                )}
                <p className="mt-3 text-[11.5px] leading-relaxed text-ink-4">
                  轮钟按排位派给第一位空闲的技师；派了轮钟的排到队尾，点钟不动牌（规则在「后台 → 技师」）。
                </p>
              </Card>
              {resting.length > 0 && (
                <Card className="p-4">
                  <SectionTitle>休息中</SectionTitle>
                  <ul className="mt-2 space-y-1.5">
                    {resting.map((t) => (
                      <li key={t.id} className="flex items-center gap-2 text-[13px]" data-testid={`clock-rest-${t.techNo}`}>
                        <span className="num w-9 font-bold">{t.techNo}</span>
                        <span className="min-w-0 flex-1 truncate font-semibold">{t.name}</span>
                        {t.busy && <Badge tone="yuzu">在钟上</Badge>}
                        <Button size="sm" variant="secondary" icon={<LogIn className="size-3.5" />} loading={busy === `back-${t.id}`} onClick={() => state(t, 'back', `${t.techNo} 号回牌`)}>
                          回牌
                        </Button>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
              {onLeave.length > 0 && (
                <Card className="p-4" data-testid="clock-leave">
                  <SectionTitle>休假 {onLeave.length} 人</SectionTitle>
                  <ul className="mt-2 space-y-1.5">
                    {onLeave.map((t) => (
                      <li key={t.id} className="flex items-center gap-2 text-[13px]" data-testid={`clock-leave-${t.techNo}`}>
                        <span className="num w-9 font-bold">{t.techNo}</span>
                        <span className="min-w-0 flex-1 truncate font-semibold">{t.name}</span>
                        <Button size="sm" variant="ghost" loading={busy === `sign_out-${t.id}`} onClick={() => state(t, 'sign_out', `${t.techNo} 号已取消休假`)}>
                          取消休假
                        </Button>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
              {suspended.length > 0 && (
                <Card className="p-4" data-testid="clock-suspended">
                  <SectionTitle>停牌 {suspended.length} 人</SectionTitle>
                  <ul className="mt-2 space-y-1.5">
                    {suspended.map((t) => (
                      <li key={t.id} className="flex items-center gap-2 text-[13px]" data-testid={`clock-suspended-${t.techNo}`}>
                        <span className="num w-9 font-bold">{t.techNo}</span>
                        <span className="min-w-0 flex-1 truncate">
                          <span className="font-semibold">{t.name}</span> <span className="text-[12px] text-ink-3">{t.suspendedReason}</span>
                        </span>
                        <Button size="sm" variant="secondary" icon={<RotateCcw className="size-3.5" />} loading={busy === `resume-${t.id}`} onClick={() => state(t, 'resume', `${t.techNo} 号已复牌`)} data-testid={`clock-resume-${t.techNo}`}>
                          复牌
                        </Button>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
              <Card className="p-4" data-testid="clock-off">
                <SectionTitle
                  aside={
                    off.length > 0 && (
                      <Button size="sm" variant="ghost" loading={busy === 'all'} onClick={() => run('all', () => api.post('/api/clockroom/sign-in-all'), '已全部上牌')} data-testid="clock-sign-in-all">
                        全部上牌
                      </Button>
                    )
                  }
                >
                  未上牌 {off.length ? `${off.length} 人` : ''}
                </SectionTitle>
                {off.length === 0 ? (
                  <p className="mt-2 text-[12.5px] text-ink-3">在职技师都已上牌</p>
                ) : (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {off.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => state(t, 'sign_in', `${t.techNo} 号上牌`)}
                        disabled={busy === `sign_in-${t.id}`}
                        className="flex h-9 items-center gap-1.5 rounded-full border border-line-strong px-3 text-[13px] font-semibold text-ink-2 hover:border-pine hover:text-pine disabled:opacity-50"
                        data-testid={`clock-sign-in-${t.techNo}`}
                      >
                        <span className="num font-bold">{t.techNo}</span> {t.name}
                      </button>
                    ))}
                  </div>
                )}
              </Card>
            </div>

            <div className="min-w-0 space-y-4">
              {pending.length > 0 && (
                <section data-testid="clock-pending">
                  <h2 className="mb-2 flex items-center gap-1.5 text-[14px] font-bold text-ink-2">
                    <ClipboardList className="size-4 text-clay" /> 待派钟 {pending.length}
                    <span className="text-[12px] font-normal text-ink-3">前台已点、交给钟房派技师（派钟不另收费）</span>
                  </h2>
                  <Card className="divide-y divide-line/70">
                    {pending.map((p) => (
                      <div key={p.lineId} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3" data-testid={`clock-pending-${p.lineId}`}>
                        <span className="num text-[15px] font-bold">{p.tagCode}</span>
                        <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">
                          {p.guest} · <span className="font-semibold text-ink">{p.itemName}</span> × {p.quantity} · <Money cents={p.amount} />
                        </span>
                        <span className="text-[12px] text-ink-3">
                          {formatTime(p.postedAt)} {p.postedByName} 点
                        </span>
                        <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} disabled={!can('frontdesk.operate')} onClick={() => setAssigning(p)} data-testid={`clock-assign-${p.lineId}`}>
                          派钟
                        </Button>
                      </div>
                    ))}
                  </Card>
                </section>
              )}
              <section>
                <h2 className="mb-2 flex items-center gap-1.5 text-[14px] font-bold text-ink-2">
                  <Hourglass className="size-4 text-pine" /> 上钟中 {serving.length}
                </h2>
                {serving.length === 0 ? (
                  <Card className="px-4 py-8 text-center text-[13px] text-ink-3">现在没有技师在钟上</Card>
                ) : (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {serving.map((s) => (
                      <ServingCard
                        key={s.id}
                        s={s}
                        now={now}
                        remindMinutes={d.rules.remindMinutes}
                        busy={busy}
                        canPost={can('frontdesk.operate')}
                        onFinish={() => run(`finish-${s.id}`, () => api.post(`/api/clockroom/sessions/${s.id}/finish`), `${s.techNo} 号下钟`)}
                        onExtend={() => setExtending(s)}
                        onVoid={() => setVoiding(s)}
                        onRoom={() => setRooming(s)}
                        onTransfer={() => setTransferring(s)}
                      />
                    ))}
                  </div>
                )}
              </section>
              <section>
                <h2 className="mb-2 flex items-center gap-1.5 text-[14px] font-bold text-ink-2">
                  <UsersRound className="size-4 text-lake" /> 待上钟 {waiting.length}
                </h2>
                {waiting.length === 0 ? (
                  <Card className="px-4 py-6 text-center text-[13px] text-ink-3">没有待上钟的</Card>
                ) : (
                  <Card className="divide-y divide-line/70">
                    {waiting.map((s) => {
                      const t = d.technicians.find((x) => x.id === s.technicianId);
                      const queued = t?.busy?.status === 'serving';
                      return (
                        <div key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3" data-testid={`clock-waiting-${s.sessionNo}`}>
                          <span className="num text-[16px] font-bold">{s.techNo}</span>
                          <span className="font-semibold">{s.techName}</span>
                          <Badge tone={s.callType === 'designated' ? 'yuzu' : 'neutral'}>{CALL_TYPE_LABELS[s.callType]}</Badge>
                          <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">
                            <span className="num font-bold">{s.tagCode}</span> {s.guest} · {s.itemName} × {s.clocks}
                          </span>
                          <span className="text-[12px] text-ink-3">{formatTime(s.createdAt)} 派{queued ? ' · 在等上一钟' : ''}</span>
                          <RoomChip s={s} onClick={() => setRooming(s)} />
                          <div className="flex gap-1.5">
                            <Button size="sm" variant="primary" icon={<Play className="size-3.5" />} disabled={queued} loading={busy === `start-${s.id}`} onClick={() => run(`start-${s.id}`, () => api.post(`/api/clockroom/sessions/${s.id}/start`), `${s.techNo} 号上钟`)} data-testid={`clock-start-${s.sessionNo}`}>
                              上钟
                            </Button>
                            <Button size="sm" variant="ghost" icon={<ArrowRightLeft className="size-3.5" />} disabled={!can('frontdesk.operate')} onClick={() => setTransferring(s)} data-testid={`clock-transfer-${s.sessionNo}`}>
                              转钟
                            </Button>
                            <Button size="sm" variant="ghost" icon={<Undo2 className="size-3.5" />} disabled={!can('frontdesk.operate')} onClick={() => setVoiding(s)} data-testid={`clock-cancel-${s.sessionNo}`}>
                              取消
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </Card>
                )}
              </section>
            </div>
          </div>
          )}
          </>
        )}
      </div>

      {d && (
        <DispatchDialog
          open={dispatching || !!assigning}
          board={d}
          assign={assigning}
          prefill={prefill}
          onClose={() => {
            setDispatching(false);
            setAssigning(null);
            setPrefill(null);
          }}
          onDone={() => {
            setDispatching(false);
            setAssigning(null);
            setPrefill(null);
            void qc.invalidateQueries({ queryKey: clockKey });
            void qc.invalidateQueries({ queryKey: ['bookings'] });
          }}
        />
      )}
      {d && transferring && (
        <TransferDialog
          session={transferring}
          board={d}
          onClose={() => setTransferring(null)}
          onDone={() => {
            setTransferring(null);
            toast({ tone: 'success', title: '已转钟' });
            void qc.invalidateQueries({ queryKey: clockKey });
          }}
        />
      )}
      <TechStateDialog
        technician={techState?.t ?? null}
        action={techState?.action ?? 'suspend'}
        onClose={() => setTechState(null)}
        onDone={(b, how) => {
          const cur = techState;
          setTechState(null);
          if (b) qc.setQueryData(clockKey, b);
          else void qc.invalidateQueries({ queryKey: clockKey });
          if (cur) toast({ tone: 'success', title: how === 'done' ? `${cur.t.techNo} 号${TECH_STATE_DONE[cur.action]}` : `${cur.t.techNo} 号的待确认已处理` });
        }}
      />
      {d && extending && <ExtendDialog session={extending} onClose={() => setExtending(null)} onDone={() => { setExtending(null); void qc.invalidateQueries({ queryKey: clockKey }); }} />}
      <RoomDialog
        session={rooming}
        onClose={() => setRooming(null)}
        onSaved={(b) => {
          const s = rooming!;
          qc.setQueryData(clockKey, b);
          void qc.invalidateQueries({ queryKey: ['clockroom', 'spaces'] });
          setRooming(null);
          const now = b.sessions.find((x) => x.id === s.id)?.space;
          toast({ tone: 'success', title: now ? `${s.techNo} 号：房间 ${spaceLabel(now.code, now.displayName)}` : `${s.techNo} 号：已清掉房间` });
        }}
      />
      <ReasonDialog
        open={!!voiding}
        title={voiding?.status === 'serving' ? `退钟 · ${voiding.techNo} 号 ${voiding.techName}` : `取消派钟 · ${voiding?.techNo ?? ''} 号 ${voiding?.techName ?? ''}`}
        description={voiding ? `${voiding.tagCode} ${voiding.guest} · ${voiding.itemName} × ${voiding.clocks}。这张钟单的挂账全部作废（留痕），技师按规则回到原位。` : ''}
        placeholder={voiding?.status === 'serving' ? '例如：客人要换技师' : '例如：客人不做了'}
        confirm={voiding?.status === 'serving' ? '确认退钟' : '确认取消'}
        onClose={() => setVoiding(null)}
        onConfirm={async (reason) => {
          const s = voiding!;
          await run(`void-${s.id}`, () => api.post(`/api/clockroom/sessions/${s.id}/void`, { reason }), s.status === 'serving' ? '已退钟' : '已取消派钟');
          setVoiding(null);
        }}
      />
      <ReasonDialog
        open={!!toEnd}
        title={`排到队尾 · ${toEnd?.techNo ?? ''} 号 ${toEnd?.name ?? ''}`}
        description="叫了不在岗、拒钟时排到队尾，原因记进钟房日志。"
        placeholder="例如：叫了 3 分钟没到"
        confirm="排到队尾"
        onClose={() => setToEnd(null)}
        onConfirm={async (reason) => {
          const t = toEnd!;
          await run(`to_end-${t.id}`, () => api.post(`/api/clockroom/technicians/${t.id}/state`, { action: 'to_end', reason }), `${t.techNo} 号排到队尾`);
          setToEnd(null);
        }}
      />
      <ClockLog open={showLog} onClose={() => setShowLog(false)} />
    </>
  );
}

function QueueRow({
  t,
  next,
  sessions,
  now,
  busy,
  onRest,
  onOff,
  onToEnd,
}: {
  t: BoardTechnician;
  next: boolean;
  sessions: BoardSession[];
  now: number;
  busy: string | null;
  onRest: () => void;
  onOff: () => void;
  onToEnd: () => void;
}) {
  const s = t.busy ? sessions.find((x) => x.id === t.busy!.sessionId) : undefined;
  const left = s?.plannedEnd ? new Date(s.plannedEnd).getTime() - now : null;
  return (
    <li
      className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-2.5 py-2', next ? 'border-pine bg-pine-tint' : 'border-line bg-card', t.busy && 'bg-paper-2/60')}
      data-testid={`clock-queue-${t.techNo}`}
    >
      <span className={cn('num flex size-6 items-center justify-center rounded-full text-[12px] font-bold', next ? 'bg-pine text-paper' : 'bg-paper-2 text-ink-3')}>{t.position}</span>
      <span className="num text-[15px] font-bold">{t.techNo}</span>
      <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">
        {t.name}
        <span className={cn('ml-1 text-[11.5px]', t.gender === 'female' ? 'text-clay' : 'text-lake')}>{t.gender === 'female' ? '女' : '男'}</span>
      </span>
      {next && <Badge tone="pine">下一位</Badge>}
      {s ? (
        <span className={cn('text-[11.5px] font-semibold', s.status === 'serving' ? (left !== null && left < 0 ? 'text-clay' : 'text-yuzu-deep') : 'text-lake')}>
          {s.status === 'serving' ? (left === null ? '上钟中' : left < 0 ? `超时 ${mmss(left)}` : `剩 ${mmss(left)}`) : '待上钟'}
        </span>
      ) : (
        <span className="text-[11.5px] text-ink-4">今日 {t.todayClocks} 钟</span>
      )}
      <span className="flex w-full items-center justify-end gap-1 pl-8 text-[11.5px] whitespace-nowrap">
        <span className="mr-auto min-w-0 truncate text-ink-4">{gradeLabel(t.grade)}{t.rejectStreak ? ` · 已连续被退 ${t.rejectStreak} 次` : ''}</span>
        <button type="button" className="inline-flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-ink-3 hover:bg-paper-2 hover:text-ink" onClick={onToEnd} disabled={busy !== null}>
          <ArrowDownToLine className="size-3" /> 排尾
        </button>
        <button type="button" className="inline-flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-ink-3 hover:bg-paper-2 hover:text-ink" onClick={onRest} disabled={busy !== null} data-testid={`clock-rest-btn-${t.techNo}`}>
          <Coffee className="size-3" /> 休息
        </button>
        <button type="button" className="inline-flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-ink-3 hover:bg-paper-2 hover:text-ink" onClick={onOff} disabled={busy !== null}>
          <LogOut className="size-3" /> 下牌
        </button>
      </span>
    </li>
  );
}

function ServingCard({
  s,
  now,
  remindMinutes,
  busy,
  canPost,
  onFinish,
  onExtend,
  onVoid,
  onRoom,
  onTransfer,
}: {
  s: BoardSession;
  now: number;
  remindMinutes: number;
  busy: string | null;
  canPost: boolean;
  onFinish: () => void;
  onExtend: () => void;
  onVoid: () => void;
  onRoom: () => void;
  onTransfer: () => void;
}) {
  const start = new Date(s.startedAt!).getTime();
  const end = new Date(s.plannedEnd!).getTime();
  const left = end - now;
  const progress = Math.min(1, Math.max(0, (now - start) / (end - start)));
  const over = left < 0;
  const soon = !over && left <= remindMinutes * 60_000;
  return (
    <Card className={cn('flex flex-col p-4', over ? 'border-clay/60' : soon ? 'border-yuzu-deep/60' : '')} data-testid={`clock-serving-${s.sessionNo}`}>
      <div className="flex items-baseline gap-2">
        <span className="num text-[22px] font-bold">{s.techNo}</span>
        <span className="min-w-0 flex-1 truncate text-[15px] font-bold">{s.techName}</span>
        <Badge tone={s.callType === 'designated' ? 'yuzu' : 'neutral'}>{CALL_TYPE_LABELS[s.callType]}</Badge>
      </div>
      <p className="mt-1 truncate text-[13px] text-ink-2">
        <span className="num font-bold">{s.tagCode}</span> {s.guest} · {s.itemName} × {s.clocks}
      </p>
      <div className="mt-1.5">
        <RoomChip s={s} onClick={onRoom} />
      </div>
      <div className="mt-3 flex items-baseline justify-between">
        <span className={cn('num text-[26px] font-bold', over ? 'text-clay' : soon ? 'text-yuzu-deep' : 'text-pine')} data-testid={`clock-timer-${s.sessionNo}`}>
          {over ? `+${mmss(left)}` : mmss(left)}
        </span>
        <span className="text-[12px] text-ink-3">
          {formatTime(s.startedAt!)} – {formatTime(s.plannedEnd!)} · {s.minutes} 分钟
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-paper-2">
        <div className={cn('h-full rounded-full', over ? 'bg-clay' : soon ? 'bg-yuzu-deep' : 'bg-pine')} style={{ width: `${progress * 100}%` }} />
      </div>
      <p className="mt-1 text-[11.5px] font-semibold text-ink-3">{over ? '已超时，请提醒下钟或加钟' : soon ? '快到钟了' : ' '}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Button size="sm" variant="primary" icon={<Square className="size-3.5" />} loading={busy === `finish-${s.id}`} onClick={onFinish} data-testid={`clock-finish-${s.sessionNo}`}>
          下钟
        </Button>
        <Button size="sm" variant="secondary" icon={<Plus className="size-3.5" />} disabled={!canPost} onClick={onExtend} data-testid={`clock-extend-${s.sessionNo}`}>
          加钟
        </Button>
        <Button size="sm" variant="secondary" icon={<ArrowRightLeft className="size-3.5" />} disabled={!canPost} onClick={onTransfer} data-testid={`clock-transfer-${s.sessionNo}`}>
          转钟
        </Button>
        <Button size="sm" variant="ghost" icon={<Undo2 className="size-3.5" />} disabled={!canPost} onClick={onVoid} data-testid={`clock-void-${s.sessionNo}`}>
          退钟
        </Button>
      </div>
    </Card>
  );
}

type StateAction = 'sign_in' | 'rest' | 'back' | 'sign_out' | 'leave' | 'resume';

/** 按状态筛选（8.0.8，B01）：只列这一类技师，卡片上带这个状态下能做的操作 */
function FilteredTechs({
  filter,
  board,
  now,
  busy,
  canPost,
  onState,
  onSuspend,
  onToEnd,
  onStart,
  onFinish,
  onTransfer,
}: {
  filter: Exclude<TechFilter, 'all'>;
  board: ClockroomBoard;
  now: number;
  busy: string | null;
  canPost: boolean;
  onState: (t: BoardTechnician, action: StateAction, ok: string) => void;
  onSuspend: (t: BoardTechnician) => void;
  onToEnd: (t: BoardTechnician) => void;
  onStart: (s: BoardSession) => void;
  onFinish: (s: BoardSession) => void;
  onTransfer: (s: BoardSession) => void;
}) {
  const list = board.technicians
    .filter((t) => t.active && techFilterOf(t) === filter)
    .sort((a, b) => (a.position ?? 999) - (b.position ?? 999) || Number(a.techNo) - Number(b.techNo) || a.techNo.localeCompare(b.techNo));
  return (
    <div className="mx-auto max-w-[1280px] px-5 py-5 md:px-7" data-testid={`clock-filtered-${filter}`}>
      {list.length === 0 ? (
        <Card className="px-4 py-8 text-center text-[13px] text-ink-3">没有「{TECH_FILTER_LABELS[filter]}」的技师</Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {list.map((t) => {
            const s = t.busy ? board.sessions.find((x) => x.id === t.busy!.sessionId) : undefined;
            const left = s?.plannedEnd ? new Date(s.plannedEnd).getTime() - now : null;
            const act = (action: StateAction, ok: string, label: string, icon: React.ReactNode, variant: 'primary' | 'secondary' | 'ghost' = 'ghost') => (
              <Button size="sm" variant={variant} icon={icon} loading={busy === `${action}-${t.id}`} disabled={busy !== null} onClick={() => onState(t, action, ok)} data-testid={`clock-tech-${action}-${t.techNo}`}>
                {label}
              </Button>
            );
            return (
              <Card key={t.id} className="flex flex-col p-4" data-testid={`clock-tech-${t.techNo}`}>
                <div className="flex items-baseline gap-2">
                  <span className="num text-[20px] font-bold">{t.techNo}</span>
                  <span className="min-w-0 flex-1 truncate text-[15px] font-bold">{t.name}</span>
                  <Badge tone={filter === 'idle' ? 'pine' : filter === 'serving' ? 'yuzu' : filter === 'suspended' ? 'clay' : 'neutral'}>{TECH_FILTER_LABELS[filter]}</Badge>
                </div>
                <p className="mt-1 text-[12px] text-ink-3">
                  {gradeLabel(t.grade)} · {t.gender === 'female' ? '女' : '男'} · 今日 {t.todayClocks} 钟{t.position ? ` · 排第 ${t.position} 位` : ''}
                  {t.rejectStreak ? ` · 已连续被退 ${t.rejectStreak} 次` : ''}
                </p>
                {s && (
                  <p className="mt-1.5 truncate text-[13px] text-ink-2">
                    <span className="num font-bold">{s.tagCode}</span> {s.guest} · {s.itemName} × {s.clocks}
                    {s.status === 'serving' && left !== null ? ` · ${left < 0 ? `超时 ${mmss(left)}` : `剩 ${mmss(left)}`}` : ''}
                  </p>
                )}
                {filter === 'suspended' && <p className="mt-1.5 text-[12.5px] text-clay">停牌：{t.suspendedReason}</p>}
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {filter === 'idle' && (
                    <>
                      {act('rest', `${t.techNo} 号休息`, '休息', <Coffee className="size-3.5" />)}
                      <Button size="sm" variant="ghost" icon={<ArrowDownToLine className="size-3.5" />} disabled={busy !== null} onClick={() => onToEnd(t)}>
                        排尾
                      </Button>
                      {act('sign_out', `${t.techNo} 号下牌`, '下牌', <LogOut className="size-3.5" />)}
                      {act('leave', `${t.techNo} 号今天休假`, '休假', <CalendarOff className="size-3.5" />)}
                    </>
                  )}
                  {filter === 'serving' && s && (
                    <>
                      <Button size="sm" variant="primary" icon={<Square className="size-3.5" />} loading={busy === `finish-${s.id}`} onClick={() => onFinish(s)}>
                        下钟
                      </Button>
                      <Button size="sm" variant="secondary" icon={<ArrowRightLeft className="size-3.5" />} disabled={!canPost} onClick={() => onTransfer(s)}>
                        转钟
                      </Button>
                    </>
                  )}
                  {filter === 'waiting' && s && (
                    <>
                      <Button size="sm" variant="primary" icon={<Play className="size-3.5" />} loading={busy === `start-${s.id}`} onClick={() => onStart(s)}>
                        上钟
                      </Button>
                      <Button size="sm" variant="secondary" icon={<ArrowRightLeft className="size-3.5" />} disabled={!canPost} onClick={() => onTransfer(s)}>
                        转钟
                      </Button>
                    </>
                  )}
                  {filter === 'rest' && (
                    <>
                      {act('back', `${t.techNo} 号回牌`, '回牌', <LogIn className="size-3.5" />, 'secondary')}
                      {act('sign_out', `${t.techNo} 号下牌`, '下牌', <LogOut className="size-3.5" />)}
                      {act('leave', `${t.techNo} 号今天休假`, '休假', <CalendarOff className="size-3.5" />)}
                    </>
                  )}
                  {filter === 'leave' && (
                    <>
                      {act('sign_in', `${t.techNo} 号上牌`, '上牌', <LogIn className="size-3.5" />, 'secondary')}
                      {act('sign_out', `${t.techNo} 号已取消休假`, '取消休假', <Undo2 className="size-3.5" />)}
                    </>
                  )}
                  {filter === 'off' && (
                    <>
                      {act('sign_in', `${t.techNo} 号上牌`, '上牌', <LogIn className="size-3.5" />, 'secondary')}
                      {act('leave', `${t.techNo} 号今天休假`, '休假', <CalendarOff className="size-3.5" />)}
                    </>
                  )}
                  {filter === 'suspended' && act('resume', `${t.techNo} 号已复牌`, '复牌', <RotateCcw className="size-3.5" />, 'secondary')}
                  {(filter === 'idle' || filter === 'rest' || filter === 'off' || filter === 'leave') && (
                    <Button size="sm" variant="ghost" icon={<BadgeX className="size-3.5" />} disabled={busy !== null} onClick={() => onSuspend(t)} data-testid={`clock-tech-suspend-${t.techNo}`}>
                      停牌
                    </Button>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** 钟单的房间（v0.7.16）：点开换房间、补选、清掉 */
function RoomChip({ s, onClick }: { s: BoardSession; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-7 max-w-full items-center gap-1 rounded-full border px-2.5 text-[12px] font-semibold',
        s.space ? 'border-lake/40 bg-lake-soft text-lake hover:border-lake' : 'border-dashed border-line-strong text-ink-3 hover:border-ink-4 hover:text-ink-2',
      )}
      data-testid={`clock-room-${s.sessionNo}`}
    >
      <DoorOpen className="size-3.5 shrink-0" />
      <span className="truncate">{s.space ? spaceLabel(s.space.code, s.space.displayName) : '选房间'}</span>
    </button>
  );
}

function ReasonDialog({
  open,
  title,
  description,
  placeholder,
  confirm,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  placeholder: string;
  confirm: string;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  useResetOnOpen(open, () => setReason(''));
  return (
    <Dialog
      open={open}
      onClose={saving ? () => {} : onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={saving}
            disabled={reason.trim().length < 2}
            onClick={async () => {
              setSaving(true);
              try {
                await onConfirm(reason.trim());
              } finally {
                setSaving(false);
              }
            }}
            data-testid="reason-confirm"
          >
            {confirm}
          </Button>
        </>
      }
    >
      <Field label="原因" htmlFor="clock-reason" hint="至少 2 个字，记进钟房日志与审计">
        <Input id="clock-reason" value={reason} maxLength={100} placeholder={placeholder} onChange={(e) => setReason(e.target.value)} data-autofocus data-testid="reason-input" />
      </Field>
    </Dialog>
  );
}

function ClockLog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const log = useQuery({ queryKey: ['clockroom', 'events'], queryFn: () => api.get<ClockEvent[]>('/api/clockroom/events'), enabled: open });
  return (
    <Dialog open={open} onClose={onClose} title="钟房日志" description="今天的上牌、派钟、跳过、上下钟、加钟、退钟与排位调整（只追加，不能改）" width="max-w-2xl">
      {log.isPending ? (
        <Skeleton className="h-40" />
      ) : (log.data ?? []).length === 0 ? (
        <p className="py-6 text-center text-[13px] text-ink-3">今天还没有记录</p>
      ) : (
        <ul className="max-h-[60vh] divide-y divide-line/70 overflow-y-auto" data-testid="clock-log">
          {log.data!.map((e) => (
            <li key={e.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-2 text-[13px]">
              <span className="num w-12 text-[12px] text-ink-3">{formatTime(e.at)}</span>
              <Badge tone={e.kind === 'skip' || e.kind === 'reject' || e.kind === 'to_end' || e.kind === 'queue' ? 'clay' : 'neutral'}>{EVENT_KIND_LABELS[e.kind]}</Badge>
              {e.techNo && (
                <span className="font-semibold">
                  {e.techNo} 号 {e.techName}
                </span>
              )}
              <span className="min-w-0 flex-1 text-ink-2">{e.text}</span>
              <span className="text-[12px] text-ink-4">{e.staffName}</span>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
