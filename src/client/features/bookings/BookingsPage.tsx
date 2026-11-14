// 预约（v0.7.28 ③，docs/SCHEDULE_FINISH.md 第 4 节）：前台预约看板——一天的预约按技师、派对房等、客房分组，
// 新建（前台、电话）、确认（小程序的）、改时间、到店（派对房直接开使用单；技师的去钟房派钟、客房的去客房开房）、取消、记爽约。
// 写操作与前台一样有「结果待确认」：断网后查回、原样重提或确认作废。

import { useEffect, useMemo, useState } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Plus } from 'lucide-react';
import {
  BOOKING_KIND_LABELS,
  BOOKING_SOURCE_LABELS,
  BOOKING_STATUS_LABELS,
  DEFAULT_BOOKING_RULES,
  MAX_BOOKING_GUESTS,
  MAX_BOOKING_NOTE,
  type BookingBoard,
  type BookingDetail,
  type BookingKind,
  type BookingSlot,
  type BookingStatus,
} from '@shared/bookings';
import { normalizeTagCode, TAG_CODE_PATTERN } from '@shared/frontdesk';
import { describeDate, shiftDate } from '@shared/labels';
import type { MemberSummary } from '@shared/types';
import { api, errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { cn, formatTime } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { DateNav } from '../../components/DateNav';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
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
  // 预约可以约到「今天 + 规则里最远能约的天数」（默认 7 天，后台可改）：日期条只在这一页放开到那一天（需求 2）。
  // 看板还没取回来时先按上一次知道的规则
  const [ahead, setAhead] = useState(DEFAULT_BOOKING_RULES.maxDaysAhead);
  useEffect(() => {
    if (board.data) setAhead(board.data.rules.maxDaysAhead);
  }, [board.data]);
  const lastDay = shiftDate(session.today, ahead);
  // 新建预约填到一半关掉（或时段没取回来先关掉）：再打开时已填的会员、项目、技师、人数、备注都还在（需求 3）；约成了才清掉
  const [draft, setDraft] = useState<CreateDraft | null>(null);
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
            <DateNav value={date} today={session.today} max={lastDay} onChange={setDate} />
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
      {creating && board.data && (
        <CreateBookingDialog
          board={board.data}
          date={date}
          lastDay={lastDay}
          draft={draft}
          onClose={(left, createdOn) => {
            setCreating(false);
            setDraft(left);
            // 约的不是正在看的这一天：切过去，刚约的那张马上看得到
            if (createdOn && createdOn !== date) setDate(createdOn);
          }}
        />
      )}
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
/**
 * 三种状态分开（需求 3）：正在取（骨架）、没取回来（写明加载失败 + 重试，原来会一直停在骨架上）、这一天真的没有能约的时段（一句话）。
 * 重试只重发时段这一个请求，弹窗里已经填的都不动。
 */
function SlotPicker({ kind, query, value, onChange }: { kind: BookingKind; query: UseQueryResult<BookingSlot[]>; value: string | null; onChange: (iso: string) => void }) {
  const slots = query.data;
  if (!slots) {
    if (query.isError)
      return (
        <LoadFailed title="时段加载失败，请检查网络" onRetry={() => void query.refetch()} retrying={query.isFetching} testId="booking-slots-error">
          能约的时段没有取回来，不是没有时段。已经填的内容都还在，点「重试」再取一次。
        </LoadFailed>
      );
    // 还没选好项目 / 房间 / 房型时不会去取
    if (query.fetchStatus === 'idle')
      return (
        <p className="text-[13px] text-ink-3" data-testid="booking-slots-idle">
          {kind === 'technician' ? '先选项目，再选时段' : kind === 'space' ? '先选房间，再选时段' : '先选房型，再选预计到店时间'}
        </p>
      );
    return (
      <div data-testid="booking-slots-loading">
        <Skeleton className="h-16" />
      </div>
    );
  }
  if (kind === 'room') {
    const s = slots[0];
    if (!s)
      return (
        <p className="text-[13px] text-ink-3" data-testid="booking-slots-empty">
          这一天不能约
        </p>
      );
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
  if (slots.length === 0)
    return (
      <p className="text-[13px] text-ink-3" data-testid="booking-slots-empty">
        这一天没有能约的时段了
      </p>
    );
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

/** 新建预约填到一半的内容：关掉弹窗再打开时带回来（时段不带，再打开时按最新的重新选） */
interface CreateDraft {
  day: string;
  kind: BookingKind;
  source: 'front' | 'phone';
  term: string;
  member: MemberSummary | null;
  guestName: string;
  guestPhone: string;
  guests: string;
  itemId: number | null;
  technicianId: number | null;
  spaceId: number | null;
  duration: number;
  roomTypeId: number | null;
  note: string;
}

function CreateBookingDialog({
  board,
  date,
  lastDay,
  draft,
  onClose,
}: {
  board: BookingBoard;
  /** 预约页正在看的那一天：在能约的范围里就默认约这一天，看的是以前的日子就默认今天 */
  date: string;
  /** 最远能约到哪一天 */
  lastDay: string;
  draft: CreateDraft | null;
  /** left：没约成、留着下次接着填的内容；createdOn：约成了，约的是哪一天 */
  onClose: (left: CreateDraft | null, createdOn?: string) => void;
}) {
  const session = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const today = session.today;
  const inRange = (d: string) => d >= today && d <= lastDay;
  const has = <T extends { id: number }>(list: T[], id: number | null | undefined) => (id != null && list.some((x) => x.id === id) ? id : null);
  // 预约日期写在弹窗最上面、可以改（需求 2）：原来弹窗里看不出约的是哪一天，也没有别的地方选
  const [day, setDayRaw] = useState(draft && inRange(draft.day) ? draft.day : inRange(date) ? date : today);
  const [kind, setKind] = useState<BookingKind>(draft?.kind ?? 'technician');
  const [source, setSource] = useState<'front' | 'phone'>(draft?.source ?? 'phone');
  const [term, setTerm] = useState(draft?.term ?? '');
  const [member, setMember] = useState<MemberSummary | null>(draft?.member ?? null);
  const [guestName, setGuestName] = useState(draft?.guestName ?? '');
  const [guestPhone, setGuestPhone] = useState(draft?.guestPhone ?? '');
  const [guests, setGuests] = useState(draft?.guests ?? '1');
  // 留下来的项目、技师、房间、房型这段时间可能已经停用：不在名单里的回到默认
  const [itemId, setItemId] = useState<number | null>(has(board.items, draft?.itemId) ?? board.items[0]?.id ?? null);
  const [technicianId, setTechnicianId] = useState<number | null>(has(board.technicians, draft?.technicianId));
  const [spaceId, setSpaceId] = useState<number | null>(has(board.spaces, draft?.spaceId) ?? board.spaces[0]?.id ?? null);
  const [duration, setDuration] = useState<number>(draft && board.rules.spaceDurations.includes(draft.duration) ? draft.duration : (board.rules.spaceDurations[0] ?? 120));
  const [roomTypeId, setRoomTypeId] = useState<number | null>(has(board.roomTypes, draft?.roomTypeId) ?? board.roomTypes[0]?.id ?? null);
  const [startsAt, setStartsAt] = useState<string | null>(null);
  const [note, setNote] = useState(draft?.note ?? '');
  const [restored, setRestored] = useState(!!draft);
  // 项目多（二三十个）时下拉一长串：加搜索，下拉里按分类分组（需求 6）
  const [itemQuery, setItemQuery] = useState('');
  const itemMatches = useMemo(() => {
    const q = itemQuery.trim().toLowerCase();
    return q ? board.items.filter((i) => i.name.toLowerCase().includes(q) || i.category.toLowerCase().includes(q)) : board.items;
  }, [board.items, itemQuery]);
  const itemList = itemMatches.length > 0 ? itemMatches : board.items;
  const itemGroups = useMemo(() => {
    const map = new Map<string, BookingBoard['items']>();
    for (const i of itemList) map.set(i.category, [...(map.get(i.category) ?? []), i]);
    return [...map];
  }, [itemList]);
  const slots = useSlots({ kind, date: day, itemId, technicianId, spaceId, roomTypeId, durationMinutes: kind === 'space' ? duration : null });
  const found = useQuery({
    queryKey: ['bookings', 'members', term],
    queryFn: () => api.get<MemberSummary[]>(`/api/members?q=${encodeURIComponent(term)}&limit=8`),
    enabled: term.trim().length >= 2 && !member,
  });
  const op = useFrontdeskOp<BookingDetail>({ type: 'booking_create', visitId: null, staffName: session.staff.displayName, pick: (f) => (f.type === 'booking_create' ? f.booking : null) });
  const finish = (b: BookingDetail) => {
    void qc.invalidateQueries({ queryKey: ['bookings'] });
    toast({ tone: 'success', title: `已预约 ${b.bookingNo}`, body: `${describeDate(b.businessDate).md} ${formatTime(b.startsAt)} · ${BOOKING_KIND_LABELS[b.kind]}` });
    onClose(null, b.businessDate);
  };
  /** 没约成就关掉：填了的留着，下次打开接着填 */
  const leave = () => {
    const touched = !!member || !!term.trim() || !!guestName.trim() || !!guestPhone.trim() || !!note.trim() || guests !== '1' || technicianId !== null || kind !== 'technician' || itemId !== (board.items[0]?.id ?? null);
    onClose(touched ? { day, kind, source, term, member, guestName, guestPhone, guests, itemId, technicianId, spaceId, duration, roomTypeId, note } : null);
  };
  const startOver = () => {
    setRestored(false);
    setKind('technician');
    setSource('phone');
    setTerm('');
    setMember(null);
    setGuestName('');
    setGuestPhone('');
    setGuests('1');
    setItemId(board.items[0]?.id ?? null);
    setTechnicianId(null);
    setSpaceId(board.spaces[0]?.id ?? null);
    setDuration(board.rules.spaceDurations[0] ?? 120);
    setRoomTypeId(board.roomTypes[0]?.id ?? null);
    setStartsAt(null);
    setNote('');
    setItemQuery('');
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
    const b = await op.submit((key) => ({ url: '/api/bookings', body: { clientKey: key, ...body }, tagCodes: ['预约'], summary: `新建${BOOKING_KIND_LABELS[kind]}预约 ${describeDate(day).md} ${formatTime(startsAt!)}`, amount: null }));
    if (b) finish(b);
  };
  const pick = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setStartsAt(null);
  };
  const setDay = pick(setDayRaw);
  const dayText = describeDate(day);
  const dayOffset = day === today ? '今天' : day === shiftDate(today, 1) ? '明天' : day === shiftDate(today, 2) ? '后天' : '';
  const searchItems = (text: string) => {
    setItemQuery(text);
    const q = text.trim().toLowerCase();
    if (!q) return;
    const hits = board.items.filter((i) => i.name.toLowerCase().includes(q) || i.category.toLowerCase().includes(q));
    // 现在选着的不在搜到的里面：直接选中搜到的第一个
    if (hits.length > 0 && !hits.some((i) => i.id === itemId)) pick(setItemId)(hits[0]!.id);
  };
  return (
    <Dialog
      open
      onClose={op.busy ? () => {} : leave}
      title="新建预约"
      description={`${dayText.md} ${dayText.weekday}${dayOffset ? `（${dayOffset}）` : ''}`}
      footer={
        <>
          <Button variant="ghost" onClick={leave} disabled={op.busy}>
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
        {restored && (
          <Notice
            tone="info"
            title="上次没填完的内容带回来了"
            data-testid="booking-draft-restored"
            action={
              <Button size="sm" variant="secondary" onClick={startOver} data-testid="booking-draft-clear">
                清空重填
              </Button>
            }
          >
            时段请重新选。
          </Notice>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <Field label="预约日期" htmlFor="booking-day" hint={`今天到 ${describeDate(lastDay).md}（最远约 ${board.rules.maxDaysAhead} 天后）`}>
            <Input
              id="booking-day"
              type="date"
              value={day}
              min={today}
              max={lastDay}
              onChange={(e) => {
                const v = e.target.value;
                if (v && inRange(v)) setDay(v);
              }}
              className="w-44"
              data-testid="booking-day"
            />
          </Field>
          <div className="flex gap-1.5 pb-[26px]">
            {[0, 1, 2]
              .map((n) => shiftDate(today, n))
              .filter(inRange)
              .map((d, n) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDay(d)}
                  className={cn('h-9 rounded-md border px-3 text-[13px] font-semibold', day === d ? 'border-pine bg-pine text-white' : 'border-line bg-card text-ink-2 hover:border-pine')}
                  data-testid={`booking-day-${n}`}
                >
                  {['今天', '明天', '后天'][n]}
                </button>
              ))}
          </div>
        </div>
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
        {kind === 'technician' && board.items.length > 6 && (
          <Field label={`搜项目（共 ${board.items.length} 个）`} htmlFor="booking-item-search">
            <Input id="booking-item-search" value={itemQuery} onChange={(e) => searchItems(e.target.value)} placeholder="输项目名或分类，例如 足疗" autoComplete="off" data-testid="booking-item-search" />
            {itemQuery.trim() && (
              <p className={cn('mt-1 text-[12.5px]', itemMatches.length ? 'text-ink-3' : 'font-semibold text-clay')} data-testid="booking-item-search-result">
                {itemMatches.length ? `找到 ${itemMatches.length} 个，下面的「项目」里只列这些` : '没有叫这个的项目，下面列的是全部'}
              </p>
            )}
          </Field>
        )}
        {kind === 'technician' && (
          <div className="grid grid-cols-2 gap-2">
            <Field label="项目" htmlFor="booking-item">
              <Select id="booking-item" value={itemId ?? ''} onChange={(e) => pick(setItemId)(Number(e.target.value) || null)} data-testid="booking-item">
                {/* 现在选着的不在搜到的里面（搜的字还没出结果）：也列出来，免得下拉显示成别的项目 */}
                {itemId !== null &&
                  !itemList.some((i) => i.id === itemId) &&
                  board.items
                    .filter((i) => i.id === itemId)
                    .map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name}（{i.minutes} 分钟）
                      </option>
                    ))}
                {itemGroups.map(([category, list]) => (
                  <optgroup key={category} label={category}>
                    {list.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name}（{i.minutes} 分钟）
                      </option>
                    ))}
                  </optgroup>
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
        <SlotPicker kind={kind} query={slots} value={startsAt} onChange={setStartsAt} />
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
            <SlotPicker kind={b.kind} query={slots} value={startsAt} onChange={setStartsAt} />
          </>
        )}
        {op.state.phase === 'error' && <Notice tone="error">{op.state.message}</Notice>}
      </div>
    </Dialog>
  );
}
