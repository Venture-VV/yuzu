// 预约（v0.7.28 ③，docs/SCHEDULE_FINISH.md 第 4 节）：前台预约看板——一天的预约按技师、派对房等、客房分组，
// 新建（前台、电话）、确认（小程序的）、改时间、到店（派对房直接开使用单；技师的去钟房派钟、客房的去客房开房）、取消、记爽约。
// 写操作与前台一样有「结果待确认」：断网后查回、原样重提或确认作废。

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Plus } from 'lucide-react';
import {
  BOOKING_KIND_LABELS,
  BOOKING_SOURCE_LABELS,
  BOOKING_STATUS_LABELS,
  MAX_BOOKING_GUESTS,
  MAX_BOOKING_NOTE,
  type BookingBoard,
  type BookingDetail,
  type BookingKind,
  type BookingSlot,
  type BookingStatus,
} from '@shared/bookings';
import { normalizeTagCode, TAG_CODE_PATTERN } from '@shared/frontdesk';
import type { MemberSummary } from '@shared/types';
import { api, errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { cn, formatTime } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { DateNav } from '../../components/DateNav';
import { EmptyState } from '../../components/EmptyState';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Field, Input, Notice, Segmented, Select, Skeleton } from '../../components/ui';
import { PendingPanel, useFrontdeskOp } from '../frontdesk/pending';

const boardKey = (date: string) => ['bookings', date] as const;
const STATUS_TONE: Record<BookingStatus, 'lake' | 'pine' | 'ember' | 'clay' | 'ink'> = {
  pending: 'ember',
  confirmed: 'lake',
  arrived: 'pine',
  cancelled: 'ink',
  no_show: 'clay',
};

export function BookingsPage() {
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const date = params.get('d') ?? session.today;
  const focus = Number(params.get('b')) || null;
  const board = useQuery({ queryKey: boardKey(date), queryFn: () => api.get<BookingBoard>(`/api/bookings?date=${date}`), refetchInterval: 30_000 });
  const [creating, setCreating] = useState(false);
  const [acting, setActing] = useState<{ booking: BookingDetail; action: Action } | null>(null);
  // 待确认的改动：回到那张预约单（顶部提醒点进来带 b=编号）
  useEffect(() => {
    if (!focus || !board.data) return;
    const b = board.data.bookings.find((x) => x.id === focus);
    if (b) document.getElementById(`booking-${b.id}`)?.scrollIntoView({ block: 'center' });
  }, [focus, board.data]);
  const setDate = (d: string) => setParams((p) => {
    p.set('d', d);
    p.delete('b');
    return p;
  });
  return (
    <>
      <PageHeader
        title="预约"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <DateNav value={date} today={session.today} onChange={setDate} />
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)} data-testid="booking-new">
              新建预约
            </Button>
          </div>
        }
      />
      <div className="space-y-5 p-5 md:p-7" data-testid="bookings">
        {!board.data ? (
          board.isError ? (
            <Notice tone="error">{errorMessage(board.error)}</Notice>
          ) : (
            <Skeleton className="h-60" />
          )
        ) : (
          (['technician', 'space', 'room'] as const).map((kind) => {
            const list = board.data.bookings.filter((b) => b.kind === kind);
            return (
              <section key={kind} className="space-y-2" data-testid={`bookings-${kind}`}>
                <h2 className="flex items-center gap-2 text-[15px] font-bold">
                  <CalendarClock className="size-4 text-pine" />
                  {BOOKING_KIND_LABELS[kind]}
                  <span className="text-[12.5px] font-normal text-ink-3">{list.filter((b) => b.status === 'pending' || b.status === 'confirmed').length} 个待到店</span>
                </h2>
                {list.length === 0 ? (
                  <EmptyState title={`这一天没有${BOOKING_KIND_LABELS[kind]}预约`} />
                ) : (
                  <div className="divide-y divide-line rounded-lg border border-line bg-card">
                    {list.map((b) => (
                      <BookingRow key={b.id} b={b} focused={b.id === focus} onAction={(action) => setActing({ booking: b, action })} />
                    ))}
                  </div>
                )}
              </section>
            );
          })
        )}
      </div>
      {creating && board.data && <CreateBookingDialog board={board.data} date={date} onClose={() => setCreating(false)} />}
      {acting && board.data && <BookingActionDialog board={board.data} booking={acting.booking} action={acting.action} onClose={() => setActing(null)} />}
    </>
  );
}

type Action = 'confirm' | 'reschedule' | 'arrive' | 'cancel' | 'no_show';

function BookingRow({ b, focused, onAction }: { b: BookingDetail; focused: boolean; onAction: (a: Action) => void }) {
  const open = b.status === 'pending' || b.status === 'confirmed';
  const who = b.memberName ? `${b.memberName}（会员）` : [b.guestName, b.guestPhone].filter(Boolean).join(' ');
  const what = b.kind === 'technician' ? `${b.itemName} · ${b.technicianText}` : b.kind === 'space' ? `${b.spaceCode} ${b.spaceName}` : b.roomTypeName;
  return (
    <div id={`booking-${b.id}`} className={cn('flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 text-[13.5px]', focused && 'bg-yuzu-tint')} data-testid={`booking-row-${b.bookingNo}`}>
      <span className="num w-28 font-bold">
        {formatTime(b.startsAt)}
        {b.kind !== 'room' && <span className="font-normal text-ink-3">–{formatTime(b.endsAt)}</span>}
      </span>
      <Badge tone={STATUS_TONE[b.status]}>{BOOKING_STATUS_LABELS[b.status]}</Badge>
      <span className="min-w-0 flex-1 truncate">
        <span className="font-semibold">{what}</span> · {who} · {b.guests} 人
        {b.kind === 'room' && b.holdUntil && <span className="text-ink-3"> · 保留到 {formatTime(b.holdUntil)}</span>}
        {b.note && <span className="text-ink-3"> · {b.note}</span>}
      </span>
      <span className="text-[12px] text-ink-3">
        {BOOKING_SOURCE_LABELS[b.source]} · {b.bookingNo}
        {b.arrivalTagCode && ` · 手牌 ${b.arrivalTagCode}`}
        {b.arrivalRef && ` · ${b.arrivalRef}`}
        {b.cancelReason && ` · ${b.cancelReason}`}
      </span>
      {open && (
        <span className="flex flex-wrap gap-1.5">
          {b.status === 'pending' && (
            <Button size="sm" variant="primary" onClick={() => onAction('confirm')} data-testid={`booking-confirm-${b.bookingNo}`}>
              确认
            </Button>
          )}
          <Button size="sm" variant="primary" onClick={() => onAction('arrive')} data-testid={`booking-arrive-${b.bookingNo}`}>
            到店
          </Button>
          <Button size="sm" variant="secondary" onClick={() => onAction('reschedule')} data-testid={`booking-reschedule-${b.bookingNo}`}>
            改时间
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onAction('cancel')} data-testid={`booking-cancel-${b.bookingNo}`}>
            取消
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onAction('no_show')} data-testid={`booking-noshow-${b.bookingNo}`}>
            爽约
          </Button>
        </span>
      )}
      {b.status === 'arrived' && b.service && (
        <Badge tone="pine" data-testid={`booking-service-${b.bookingNo}`}>
          {b.service.kind === 'session' ? '已派钟' : b.service.kind === 'stay' ? '已入住' : '已开单'} {b.service.no}
        </Badge>
      )}
      {/* 8.0.8（A04）：已到店还没派钟、没入住的，点了带着手牌、项目、技师、房型过去 */}
      {b.status === 'arrived' && !b.service && b.kind === 'technician' && (
        <Link to={`/clockroom?booking=${b.id}`} className="text-[13px] font-semibold text-pine hover:underline" data-testid={`booking-go-dispatch-${b.bookingNo}`}>
          去派钟 →
        </Link>
      )}
      {b.status === 'arrived' && !b.service && b.kind === 'room' && (
        <Link to={`/rooms?booking=${b.id}`} className="text-[13px] font-semibold text-pine hover:underline" data-testid={`booking-go-checkin-${b.bookingNo}`}>
          去开房 →
        </Link>
      )}
    </div>
  );
}

/** 选时段：技师、派对房按时段格子；客房选预计到店（营业时段内每半小时） */
function SlotPicker({ kind, slots, value, onChange }: { kind: BookingKind; slots: BookingSlot[] | undefined; value: string | null; onChange: (iso: string) => void }) {
  if (!slots) return <Skeleton className="h-16" />;
  if (kind === 'room') {
    const s = slots[0];
    if (!s) return <p className="text-[13px] text-ink-3">这一天不能约</p>;
    // 预计到店：能约的时段内每半小时，已经过了的不列
    const options: string[] = [];
    for (let t = Date.parse(s.startsAt); t < Date.parse(s.endsAt); t += 30 * 60_000) if (t >= Date.now() - 5 * 60_000) options.push(new Date(t).toISOString());
    return (
      <div className="space-y-1">
        <p className="text-[13px]">
          这个房型当天还剩 <span className="num font-bold">{s.free}</span> 间
        </p>
        <Select value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={s.free < 1} aria-label="预计到店" data-testid="booking-arrival-time">
          <option value="">选预计到店时间</option>
          {options.map((o) => (
            <option key={o} value={o}>
              {formatTime(o)}
            </option>
          ))}
        </Select>
      </div>
    );
  }
  if (slots.length === 0) return <p className="text-[13px] text-ink-3">这一天没有能约的时段了</p>;
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="booking-slots">
      {slots.map((s) => (
        <button
          key={s.startsAt}
          type="button"
          disabled={s.free < 1}
          onClick={() => onChange(s.startsAt)}
          className={cn(
            'num rounded-md border px-2.5 py-1 text-[13px] disabled:cursor-not-allowed disabled:opacity-35',
            value === s.startsAt ? 'border-pine bg-pine text-white' : 'border-line bg-card hover:border-pine',
          )}
          data-testid={`booking-slot-${formatTime(s.startsAt)}`}
        >
          {formatTime(s.startsAt)}
        </button>
      ))}
    </div>
  );
}

function useSlots(q: { kind: BookingKind; date: string; itemId?: number | null; technicianId?: number | null; spaceId?: number | null; roomTypeId?: number | null; durationMinutes?: number | null }) {
  const ready = q.kind === 'technician' ? !!q.itemId : q.kind === 'space' ? !!q.spaceId : !!q.roomTypeId;
  const params = new URLSearchParams({ kind: q.kind, date: q.date });
  if (q.itemId) params.set('itemId', String(q.itemId));
  if (q.technicianId) params.set('technicianId', String(q.technicianId));
  if (q.spaceId) params.set('spaceId', String(q.spaceId));
  if (q.roomTypeId) params.set('roomTypeId', String(q.roomTypeId));
  if (q.durationMinutes) params.set('durationMinutes', String(q.durationMinutes));
  return useQuery({ queryKey: ['bookings', 'slots', params.toString()], queryFn: () => api.get<BookingSlot[]>(`/api/bookings/slots?${params}`), enabled: ready });
}

function CreateBookingDialog({ board, date, onClose }: { board: BookingBoard; date: string; onClose: () => void }) {
  const session = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [kind, setKind] = useState<BookingKind>('technician');
  const [source, setSource] = useState<'front' | 'phone'>('phone');
  const [term, setTerm] = useState('');
  const [member, setMember] = useState<MemberSummary | null>(null);
  const [guestName, setGuestName] = useState('');
  const [guestPhone, setGuestPhone] = useState('');
  const [guests, setGuests] = useState('1');
  const [itemId, setItemId] = useState<number | null>(board.items[0]?.id ?? null);
  const [technicianId, setTechnicianId] = useState<number | null>(null);
  const [spaceId, setSpaceId] = useState<number | null>(board.spaces[0]?.id ?? null);
  const [duration, setDuration] = useState<number>(board.rules.spaceDurations[0] ?? 120);
  const [roomTypeId, setRoomTypeId] = useState<number | null>(board.roomTypes[0]?.id ?? null);
  const [startsAt, setStartsAt] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const slots = useSlots({ kind, date, itemId, technicianId, spaceId, roomTypeId, durationMinutes: kind === 'space' ? duration : null });
  const found = useQuery({
    queryKey: ['bookings', 'members', term],
    queryFn: () => api.get<MemberSummary[]>(`/api/members?q=${encodeURIComponent(term)}&limit=8`),
    enabled: term.trim().length >= 2 && !member,
  });
  const op = useFrontdeskOp<BookingDetail>({ type: 'booking_create', visitId: null, staffName: session.staff.displayName, pick: (f) => (f.type === 'booking_create' ? f.booking : null) });
  const finish = (b: BookingDetail) => {
    void qc.invalidateQueries({ queryKey: ['bookings'] });
    toast({ tone: 'success', title: `已预约 ${b.bookingNo}`, body: `${formatTime(b.startsAt)} · ${BOOKING_KIND_LABELS[b.kind]}` });
    onClose();
  };
  const ok = !!startsAt && (member || guestName.trim() || guestPhone.trim()) && Number(guests) >= 1;
  const submit = async () => {
    if (!ok) return;
    const body = {
      kind,
      source,
      memberId: member?.id ?? null,
      guestName: member ? '' : guestName.trim(),
      guestPhone: member ? '' : guestPhone.trim(),
      guests: Number(guests),
      ...(kind === 'technician' ? { itemId, technicianId } : {}),
      ...(kind === 'space' ? { spaceId, durationMinutes: duration } : {}),
      ...(kind === 'room' ? { roomTypeId } : {}),
      startsAt,
      note: note.trim(),
    };
    const b = await op.submit((key) => ({ url: '/api/bookings', body: { clientKey: key, ...body }, tagCodes: ['预约'], summary: `新建${BOOKING_KIND_LABELS[kind]}预约 ${formatTime(startsAt!)}`, amount: null }));
    if (b) finish(b);
  };
  const pick = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setStartsAt(null);
  };
  return (
    <Dialog
      open
      onClose={op.busy ? () => {} : onClose}
      title="新建预约"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={op.busy}>
            取消
          </Button>
          <Button variant="primary" size="lg" disabled={!ok || op.locked} loading={op.busy} onClick={submit} data-testid="booking-create-submit">
            预约
          </Button>
        </>
      }
    >
      <PendingPanel op={op} onResolved={finish} />
      <div className="space-y-3" data-testid="booking-create">
        <Segmented value={kind} onChange={pick(setKind)} ariaLabel="预约什么" options={(['technician', 'space', 'room'] as const).map((k) => ({ value: k, label: BOOKING_KIND_LABELS[k] }))} />
        <Segmented value={source} onChange={setSource} ariaLabel="来源" size="sm" options={[{ value: 'phone', label: '电话' }, { value: 'front', label: '前台' }]} />
        {member ? (
          <p className="flex items-center gap-2 text-[13.5px]">
            会员 <span className="font-bold">{member.name}</span> {member.memberNo}
            <Button size="sm" variant="ghost" onClick={() => setMember(null)}>
              换一位
            </Button>
          </p>
        ) : (
          <>
            <Field label="会员（手机号或会员号查）" htmlFor="booking-member">
              <Input id="booking-member" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="不是会员可以不填，下面写客人姓名、电话" data-testid="booking-member" />
            </Field>
            {(found.data ?? []).length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {found.data!.map((m) => (
                  <Button key={m.id} size="sm" variant="secondary" onClick={() => setMember(m)}>
                    {m.name} {m.memberNo}
                  </Button>
                ))}
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <Field label="客人姓名" htmlFor="booking-guest-name">
                <Input id="booking-guest-name" value={guestName} maxLength={32} onChange={(e) => setGuestName(e.target.value)} data-testid="booking-guest-name" />
              </Field>
              <Field label="客人电话" htmlFor="booking-guest-phone">
                <Input id="booking-guest-phone" value={guestPhone} maxLength={13} onChange={(e) => setGuestPhone(e.target.value)} data-testid="booking-guest-phone" />
              </Field>
            </div>
          </>
        )}
        {kind === 'technician' && (
          <div className="grid grid-cols-2 gap-2">
            <Field label="项目" htmlFor="booking-item">
              <Select id="booking-item" value={itemId ?? ''} onChange={(e) => pick(setItemId)(Number(e.target.value) || null)} data-testid="booking-item">
                {board.items.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}（{i.minutes} 分钟）
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="技师" htmlFor="booking-tech">
              <Select id="booking-tech" value={technicianId ?? ''} onChange={(e) => pick(setTechnicianId)(Number(e.target.value) || null)} data-testid="booking-technician">
                <option value="">不指定</option>
                {board.technicians.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.techNo} 号 {t.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
        {kind === 'space' && (
          <div className="grid grid-cols-2 gap-2">
            <Field label="房间" htmlFor="booking-space">
              <Select id="booking-space" value={spaceId ?? ''} onChange={(e) => pick(setSpaceId)(Number(e.target.value) || null)} data-testid="booking-space">
                {board.spaces.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code} {s.name}（{s.businessType}）
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="时长" htmlFor="booking-duration">
              <Select id="booking-duration" value={duration} onChange={(e) => pick(setDuration)(Number(e.target.value))}>
                {board.rules.spaceDurations.map((m) => (
                  <option key={m} value={m}>
                    {m / 60} 小时
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
        {kind === 'room' && (
          <Field label="房型" htmlFor="booking-room-type">
            <Select id="booking-room-type" value={roomTypeId ?? ''} onChange={(e) => pick(setRoomTypeId)(Number(e.target.value) || null)}>
              {board.roomTypes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}（{r.rooms} 间）
                </option>
              ))}
            </Select>
          </Field>
        )}
        <SlotPicker kind={kind} slots={slots.data} value={startsAt} onChange={setStartsAt} />
        {kind === 'room' && <p className="text-[12.5px] text-ink-3">保留到预计到店后 {board.rules.roomHoldMinutes} 分钟，过了自动释放、记爽约。</p>}
        <div className="grid grid-cols-2 gap-2">
          <Field label="人数" htmlFor="booking-guests">
            <Input id="booking-guests" type="number" min={1} max={MAX_BOOKING_GUESTS} value={guests} onChange={(e) => setGuests(e.target.value)} />
          </Field>
          <Field label="备注" htmlFor="booking-note">
            <Input id="booking-note" value={note} maxLength={MAX_BOOKING_NOTE} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
        {op.state.phase === 'error' && <Notice tone="error">{op.state.message}</Notice>}
      </div>
    </Dialog>
  );
}

const ACTION_TITLES: Record<Action, string> = { confirm: '确认预约', reschedule: '改时间', arrive: '到店', cancel: '取消预约', no_show: '记爽约' };

function BookingActionDialog({ board, booking: b, action, onClose }: { board: BookingBoard; booking: BookingDetail; action: Action; onClose: () => void }) {
  const session = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  // 8.0.8（A04）：这位会员此刻在店的，手牌自动带出（可改）
  const [tag, setTag] = useState(action === 'arrive' ? (b.memberOpenTag ?? '') : '');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(b.businessDate);
  const [startsAt, setStartsAt] = useState<string | null>(null);
  const [technicianId, setTechnicianId] = useState<number | null>(b.technicianId);
  const duration = Math.round((Date.parse(b.endsAt) - Date.parse(b.startsAt)) / 60_000);
  const slots = useSlots(
    action === 'reschedule'
      ? { kind: b.kind, date, itemId: b.itemId, technicianId, spaceId: b.spaceId, roomTypeId: b.roomTypeId, durationMinutes: b.kind === 'space' ? duration : null }
      : { kind: b.kind, date },
  );
  const op = useFrontdeskOp<BookingDetail>({ type: 'booking_change', visitId: null, bookingId: b.id, staffName: session.staff.displayName, pick: (f) => (f.type === 'booking_change' ? f.booking : null) });
  const tagCode = normalizeTagCode(tag);
  const ok =
    action === 'arrive' ? TAG_CODE_PATTERN.test(tagCode) : action === 'cancel' ? reason.trim().length >= 2 : action === 'reschedule' ? !!startsAt : true;
  const finish = (r: BookingDetail) => {
    void qc.invalidateQueries({ queryKey: ['bookings'] });
    toast({ tone: 'success', title: `${b.bookingNo} ${BOOKING_STATUS_LABELS[r.status]}`, body: r.arrivalRef ? `已开使用单 ${r.arrivalRef}` : undefined });
    onClose();
    // 8.0.8（A04）：到店后一步到位——技师预约直接打开派钟、客房预约到客房页挑这个房型的空房（带着手牌、项目、技师、房型）
    if (action === 'arrive' && r.status === 'arrived' && !r.service) {
      if (r.kind === 'technician') navigate(`/clockroom?booking=${r.id}`);
      if (r.kind === 'room') navigate(`/rooms?booking=${r.id}`);
    }
  };
  const submit = async () => {
    if (!ok) return;
    const body =
      action === 'confirm'
        ? { action, expectedVersion: b.version }
        : action === 'reschedule'
          ? { action, expectedVersion: b.version, startsAt, ...(b.kind === 'technician' ? { technicianId } : {}), ...(b.kind === 'space' ? { durationMinutes: duration } : {}) }
          : action === 'arrive'
            ? { action, tagCode }
            : action === 'cancel'
              ? { action, reason: reason.trim() }
              : { action };
    const r = await op.submit((key) => ({ url: `/api/bookings/${b.id}/change`, body: { clientKey: key, ...body }, tagCodes: [b.bookingNo], summary: `${ACTION_TITLES[action]} ${b.bookingNo}`, amount: null }));
    if (r) finish(r);
  };
  const hint = useMemo(() => {
    if (action !== 'arrive') return null;
    if (b.kind === 'space') return `到店即在 ${b.spaceCode} 开使用单（开单即占用），使用人是这张手牌。`;
    if (b.kind === 'technician') return '到店后直接打开钟房派钟，手牌、项目、技师都带好（约了技师按点钟，没约按轮钟）。';
    return '到店后打开客房页，标出这个房型的空房，点一间就入住（手牌、人数带好）。';
  }, [action, b]);
  return (
    <Dialog
      open
      onClose={op.busy ? () => {} : onClose}
      title={`${ACTION_TITLES[action]} · ${b.bookingNo}`}
      description={`${formatTime(b.startsAt)} · ${BOOKING_KIND_LABELS[b.kind]} · ${b.memberName ?? b.guestName ?? ''}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={op.busy}>
            关闭
          </Button>
          <Button variant={action === 'cancel' || action === 'no_show' ? 'danger' : 'primary'} size="lg" disabled={!ok || op.locked} loading={op.busy} onClick={submit} data-testid="booking-action-submit">
            {ACTION_TITLES[action]}
          </Button>
        </>
      }
    >
      <PendingPanel op={op} onResolved={finish} />
      <div className="space-y-3" data-testid="booking-action">
        {action === 'arrive' && (
          <>
            <Field label="客人的手牌号（先在前台接待开手牌）" htmlFor="booking-tag">
              <Input id="booking-tag" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="例如 A023" data-autofocus data-testid="booking-arrive-tag" />
            </Field>
            {hint && <p className="text-[13px] text-ink-2">{hint}</p>}
          </>
        )}
        {action === 'cancel' && (
          <Field label="取消原因" htmlFor="booking-cancel-reason">
            <Input id="booking-cancel-reason" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="例如 客人改天" data-testid="booking-cancel-reason" />
          </Field>
        )}
        {action === 'no_show' && (
          <Notice tone="warning">
            记爽约后这张预约不再占时段
            {board.rules.noShowBanDays > 0 && `；会员 ${board.rules.noShowWindowDays} 天内爽约 ${board.rules.noShowLimit} 次，之后 ${board.rules.noShowBanDays} 天不能在小程序预约`}。
          </Notice>
        )}
        {action === 'confirm' && <p className="text-[13.5px]">确认后顾客在小程序看到「已预约」。</p>}
        {action === 'reschedule' && (
          <>
            <Field label="日期" htmlFor="booking-date">
              <Input id="booking-date" type="date" value={date} onChange={(e) => { setDate(e.target.value); setStartsAt(null); }} />
            </Field>
            {b.kind === 'technician' && (
              <Field label="技师" htmlFor="booking-retech">
                <Select id="booking-retech" value={technicianId ?? ''} onChange={(e) => { setTechnicianId(Number(e.target.value) || null); setStartsAt(null); }}>
                  <option value="">不指定</option>
                  {board.technicians.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.techNo} 号 {t.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <SlotPicker kind={b.kind} slots={slots.data} value={startsAt} onChange={setStartsAt} />
          </>
        )}
        {op.state.phase === 'error' && <Notice tone="error">{op.state.message}</Notice>}
      </div>
    </Dialog>
  );
}
