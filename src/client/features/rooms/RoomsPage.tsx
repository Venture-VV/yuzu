// 客房（S7，v0.7.4，见 docs/ROOMS.md）：按楼层的房态看板（空闲 / 在住 / 待打扫 / 维修）。
// 住客都是在店的洗浴客人（店主 2026-10-31：门票必选，没有只住房的客人；房价不含洗浴门票）：
// 点空闲的房入住（填在店客人的手牌，房费挂在手牌账单上，离店时随手牌在前台结账）；
// 点在住的房看入住单：房费与押金、续住、换房、改登记、收退押金、退房、撤销入住；
// 点待打扫、维修的房改房态。全天房每晚过了加收一晚的时刻做夜审，给在住的客人挂今晚的房费（同一晚只挂一次）。
// 入住、续住、收退押金、退房与前台一样有「结果待确认」：断网后查回、原样重提或确认作废。

import { PartyRoomsView } from './PartyRoomsView';
import type { BookingDetail } from '@shared/bookings';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BedDouble, History, LayoutGrid, Map as MapIcon, MoonStar, PartyPopper, Sparkles, Users, Wrench } from 'lucide-react';
import { normalizeTagCode, TAG_CODE_PATTERN } from '@shared/frontdesk';
import { PAYMENT_METHOD_LABELS, shiftDate } from '@shared/labels';
import { centsToInput, formatYuan, parseYuan } from '@shared/money';
import {
  MAX_STAY_GUESTS,
  ROOM_BOARD_LABELS,
  type RoomAuditReport,
  type RoomBoard,
  type RoomBoardRoom,
  type RoomBoardStatus,
  type StayDetail,
} from '@shared/rooms';
import { spaceLabel } from '@shared/spaces';
import { api, errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn, formatDateTime, formatTime } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Field, Input, Notice, Segmented, Skeleton } from '../../components/ui';
import { PendingPanel, useFrontdeskOp } from '../frontdesk/pending';
import { stayText } from '../frontdesk/queries';
import { SHIFT_ERRORS, shiftKeys, ShiftGate, useShiftReady } from '../shift/ShiftGate';
import { DepositFields, depositProblem, guestOf, kindLabel, rateText, type DepositDraft } from './parts';
import { dayText, minuteText, roomsKey, useRoomBoard } from './queries';
import { StayDialog, type StayAction } from './StayDialog';
import { FloorMapView, type MapAction, type UsageResume } from './FloorMap';
import { CloseUsageDialog, OpenUsageDialog } from './UsageDialogs';
import { HousekeepingDialog, RoomDetailDialog } from './RoomDetail';
import { FLOOR_MAP_REFRESH_MS } from './floormap-api';

export function RoomsPage() {
  const session = useSession();
  if (!session.rooms) {
    return (
      <>
        <PageHeader title="客房" />
        <div className="p-8">
          <Notice tone="info" title="客房功能没有开启">
            店主在「后台 → 客房」建好房型与房间、核对退房时间与押金等规则并开启客房功能后，这里看房态、办入住与退房。
          </Notice>
        </div>
      </>
    );
  }
  return (
    <>
      <PageHeader title="客房" subtitle="住客先在前台接待、买门票，再点空闲的房入住；点在住的房看房费与押金、续住、换房、退房；点待打扫、维修的房改房态；「平面图」按楼层看全店房态" />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <RoomsBoardView />
      </div>
    </>
  );
}

const TILE_STYLE: Record<RoomBoardStatus, string> = {
  vacant: 'border-dashed border-line-strong bg-card hover:border-pine',
  occupied: 'border-yuzu-deep/40 bg-yuzu-tint hover:border-yuzu-deep',
  dirty: 'border-clay/30 bg-clay-soft/50 hover:border-clay',
  maintenance: 'border-line bg-paper-2 hover:border-line-strong',
};

function RoomsBoardView() {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  // 房态看板 / 平面图（v0.7.16）：记在地址里，刷新、返回都还在原来的视图
  // 派对房看板（8.0.8，A03）：不需要底图也能开派对房、宠物轰趴房
  const view = params.get('view') === 'map' ? 'map' : params.get('view') === 'party' ? 'party' : 'board';
  const board = useRoomBoard(true, view === 'map' ? FLOOR_MAP_REFRESH_MS : 15_000);
  // 入住对话框按房间 id 取看板上最新的房间：房价刚改过被拒绝后，看板刷新，对话框里的房价跟着更新
  const [checkinRoomId, setCheckinRoomId] = useState<number | null>(null);
  const [stay, setStay] = useState<{ id: number; action?: StayAction | 'move' } | null>(null);
  const [housekeepRoom, setHousekeepRoom] = useState<RoomBoardRoom | null>(null);
  // 房间详情（8.0.8，B07）：null 关着；0 为没选房间（从工具栏打开，默认第一间）
  const [detailRoom, setDetailRoom] = useState<number | null>(null);
  const [auditing, setAuditing] = useState(false);
  // 派对房等的使用单（v0.7.19）：开单、结束、撤单的对话框；从顶部「结果待确认」进入时先交给平面图找到那间房
  const [usageAction, setUsageAction] = useState<Extract<MapAction, { kind: 'usage_open' | 'usage_close' }> | null>(null);
  const [usageResume, setUsageResume] = useState<UsageResume | null>(null);
  const canOperate = can('room.operate');

  // 预约到店（8.0.8，A04）：从预约页过来带 ?booking=，标出预约的房型，点一间空房就入住（手牌、人数带好，入住记到这张预约）
  const bookingParam = Number(params.get('booking')) || null;
  const bookingQ = useQuery({ queryKey: ['bookings', 'one', bookingParam], queryFn: () => api.get<BookingDetail>(`/api/bookings/${bookingParam}`), enabled: !!bookingParam });
  const [forBooking, setForBooking] = useState<BookingDetail | null>(null);
  useEffect(() => {
    const bk = bookingQ.data;
    if (!bk || bk.id !== bookingParam) return;
    const next = new URLSearchParams(params);
    next.delete('booking');
    setParams(next, { replace: true });
    if (bk.kind !== 'room' || bk.status !== 'arrived') toast({ tone: 'error', title: `预约 ${bk.bookingNo} 不是已到店的客房预约` });
    else if (bk.service) toast({ tone: 'info', title: `预约 ${bk.bookingNo} 已经入住了（${bk.service.no}）` });
    else setForBooking(bk);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingQ.data, bookingParam]);

  // 顶部「结果待确认」的「去处理」：入住回到那间房的入住对话框，其余回到那张入住单的对应操作
  const resume = params.get('resume');
  useEffect(() => {
    if (!resume || !board.data) return;
    const r = Number(params.get('r')) || null;
    const s = Number(params.get('s')) || null;
    if (resume === 'room_checkin' && r) {
      const room = board.data.rooms.find((x) => x.id === r);
      if (room) setCheckinRoomId(room.id);
    } else if (s && (resume === 'room_extend' || resume === 'room_deposit' || resume === 'room_refund' || resume === 'room_close')) {
      setStay({ id: s, action: resume === 'room_extend' ? 'extend' : resume === 'room_deposit' ? 'deposit' : resume === 'room_refund' ? 'refund' : 'close' });
    } else if (resume === 'usage_open' || resume === 'usage_end' || resume === 'usage_cancel') {
      setUsageResume({ type: resume, spaceId: Number(params.get('sp')) || null, usageId: Number(params.get('u')) || null });
    }
    const next = new URLSearchParams(params);
    for (const k of ['resume', 'r', 's', 'sp', 'u']) next.delete(k);
    setParams(next, { replace: true });
  }, [resume, board.data, params, setParams]);

  const setView = (v: 'board' | 'map' | 'party') => {
    const next = new URLSearchParams(params);
    if (v === 'board') next.delete('view');
    else next.set('view', v);
    setParams(next, { replace: true });
  };
  // 平面图上点房间：都用这一页原来的对话框（入住、入住单、改房态）
  const mapAction = (a: MapAction) => {
    if (a.kind === 'checkin') setCheckinRoomId(a.roomId);
    else if (a.kind === 'stay') setStay({ id: a.stayId, action: a.action });
    else if (a.kind === 'usage_open' || a.kind === 'usage_close') setUsageAction(a);
    else setHousekeepRoom(a.room);
  };

  const rooms = useMemo(() => board.data?.rooms ?? [], [board.data]);
  const checkinRoom = checkinRoomId == null ? null : (rooms.find((r) => r.id === checkinRoomId) ?? null);
  const floors = useMemo(() => {
    const map = new Map<string, RoomBoardRoom[]>();
    for (const r of rooms) map.set(r.floor, [...(map.get(r.floor) ?? []), r]);
    return [...map.entries()];
  }, [rooms]);

  const click = (r: RoomBoardRoom) => {
    if (r.stay) {
      // 只管打扫的岗位（后勤）看不了入住单：在住的房退房后才变待打扫
      if (canOperate) setStay({ id: r.stay.id });
      else toast({ tone: 'info', title: `${r.roomNo} 在住`, body: '客人退房后房间变为待打扫，打扫好了再点「已打扫」' });
    } else if (r.status === 'vacant' && canOperate) setCheckinRoomId(r.id);
    else if (can('room.housekeep')) setHousekeepRoom(r);
    else toast({ tone: 'info', title: `${r.roomNo} ${ROOM_BOARD_LABELS[r.status]}`, body: '入住要有「客房入住、退房」权限，改房态要有「客房打扫、维修」权限' });
  };

  if (board.isPending) return <Skeleton className="m-5 h-64 md:m-7" />;
  if (board.error) return <Notice tone="error" title={errorMessage(board.error)} className="m-5 md:m-7" />;
  const b = board.data!;

  return (
    <div className="mx-auto max-w-[1280px] space-y-4 px-5 py-5 md:px-7" data-testid="rooms-board">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Segmented<'board' | 'map' | 'party'>
          size="sm"
          ariaLabel="视图"
          value={view}
          onChange={setView}
          options={[
            { value: 'board', label: <span className="flex items-center gap-1"><LayoutGrid className="size-3.5" />房态看板</span> },
            { value: 'map', label: <span className="flex items-center gap-1"><MapIcon className="size-3.5" />平面图</span> },
            { value: 'party', label: <span className="flex items-center gap-1" data-testid="rooms-view-party"><PartyPopper className="size-3.5" />派对房</span> },
          ]}
        />
        <span className="flex flex-wrap gap-x-3 gap-y-1 text-[13.5px] text-ink-2" data-testid="rooms-counts">
          {(['vacant', 'occupied', 'dirty', 'maintenance'] as const).map((k) => (
            <span key={k}>
              {ROOM_BOARD_LABELS[k]} <b className="num text-ink">{b.counts[k]}</b>
            </span>
          ))}
        </span>
        <span className="flex-1" />
        {rooms.length > 0 && (
          <Button size="sm" variant="ghost" icon={<History className="size-4" />} onClick={() => setDetailRoom(0)} data-testid="rooms-detail">
            房间详情
          </Button>
        )}
        {canOperate && (
          <Button size="sm" variant="secondary" icon={<MoonStar className="size-4" />} onClick={() => setAuditing(true)} data-testid="rooms-audit">
            夜审
          </Button>
        )}
      </div>

      <AuditStrip board={b} onRun={canOperate ? () => setAuditing(true) : undefined} />

      {forBooking && (
        <Notice tone="info" title={`预约 ${forBooking.bookingNo} 到店：${forBooking.roomTypeName ?? ''} · 手牌 ${forBooking.arrivalTagCode ?? ''} · ${forBooking.guests} 人`} data-testid="rooms-for-booking">
          <span className="block">点一间空闲的房入住（同房型的空房已标出）；手牌、人数已带好，入住记到这张预约，同一张预约不会重复开房。</span>
          <Button size="sm" variant="ghost" className="mt-1" onClick={() => setForBooking(null)}>
            不按预约开房
          </Button>
        </Notice>
      )}

      {view === 'party' ? (
        <PartyRoomsView canOperate={canOperate} />
      ) : view === 'map' ? (
        <FloorMapView board={b} onAction={mapAction} resume={usageResume} onResumed={() => setUsageResume(null)} />
      ) : rooms.length === 0 ? (
        <EmptyState art="calm" title="还没有房间" description="店主或能管理价目的岗位在「后台 → 客房」里建房型（全天房、钟点房与房价）和房间后，这里办入住、退房。" />
      ) : (
        floors.map(([floor, list]) => (
          <section key={floor || '-'} aria-label={floor ? `${floor} 楼` : '未分楼层'}>
            {floors.length > 1 && <h3 className="mb-2 text-[13px] font-bold text-ink-3">{floor ? `${floor} 楼` : '未分楼层'}</h3>}
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
              {list.map((r) => (
                <RoomTile key={r.id} r={r} canCheckin={canOperate} highlight={!!forBooking && r.status === 'vacant' && r.typeName === forBooking.roomTypeName} onClick={() => click(r)} />
              ))}
            </div>
          </section>
        ))
      )}

      {checkinRoom && (
        <CheckinDialog
          room={checkinRoom}
          board={b}
          booking={forBooking}
          onHousekeep={
            can('room.housekeep')
              ? () => {
                  setHousekeepRoom(checkinRoom);
                  setCheckinRoomId(null);
                }
              : undefined
          }
          onClose={() => setCheckinRoomId(null)}
          onDone={(d) => {
            setCheckinRoomId(null);
            setForBooking(null);
            setStay({ id: d.id });
            void qc.invalidateQueries({ queryKey: roomsKey });
            void qc.invalidateQueries({ queryKey: ['bookings'] });
          }}
        />
      )}
      {stay && (
        <StayDialog
          id={stay.id}
          action={stay.action}
          board={b}
          onClose={() => setStay(null)}
          onRoomDetail={(roomId) => {
            setStay(null);
            setDetailRoom(roomId);
          }}
        />
      )}
      {housekeepRoom && (
        <HousekeepingDialog
          // 看板刷新后按 id 取最新的房间（房态、上一次修改跟着变）
          room={rooms.find((r) => r.id === housekeepRoom.id) ?? housekeepRoom}
          onClose={() => setHousekeepRoom(null)}
          onDetail={() => {
            setDetailRoom(housekeepRoom.id);
            setHousekeepRoom(null);
          }}
        />
      )}
      {detailRoom !== null && <RoomDetailDialog rooms={rooms} roomId={detailRoom || null} onClose={() => setDetailRoom(null)} />}
      {usageAction?.kind === 'usage_open' && <OpenUsageDialog space={usageAction.space} onClose={() => setUsageAction(null)} onDone={() => setUsageAction(null)} />}
      {usageAction?.kind === 'usage_close' && (
        <CloseUsageDialog usage={usageAction.usage} space={usageAction.space} mode={usageAction.mode} onClose={() => setUsageAction(null)} onDone={() => setUsageAction(null)} />
      )}
      {auditing && <AuditDialog board={b} onClose={() => setAuditing(false)} />}
    </div>
  );
}

function RoomTile({ r, canCheckin, highlight = false, onClick }: { r: RoomBoardRoom; canCheckin: boolean; highlight?: boolean; onClick: () => void }) {
  const s = r.stay;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('flex min-h-[112px] flex-col items-start rounded-lg border px-3 py-2.5 text-left transition-colors', TILE_STYLE[r.status], highlight && 'ring-2 ring-pine ring-offset-1')}
      data-highlight={highlight ? 'booking' : undefined}
      data-testid={`room-tile-${r.roomNo}`}
      data-state={r.status}
    >
      <span className="flex w-full items-baseline gap-2">
        <span className="num min-w-0 flex-1 truncate text-[18px] font-bold">{r.roomNo}</span>
        {s ? (
          <span className="num flex items-center gap-0.5 text-[12.5px] font-bold text-ink-2">
            <Users className="size-3.5" />
            {s.guests}
          </span>
        ) : (
          <span className="truncate text-[12px] text-ink-4">{r.typeName}</span>
        )}
      </span>
      {/* 挂接了空间台账的房间：显示名（品牌图上可能几间同名，靠房号——空间编码——区分） */}
      {r.spaceName && r.spaceName !== r.roomNo && <span className="w-full truncate text-[11.5px] text-ink-3">{r.spaceName}</span>}
      {s ? (
        <>
          <span className="mt-0.5 w-full truncate text-[12.5px] font-semibold text-ink-2">{guestOf(s)}</span>
          <span className="mt-auto flex w-full flex-wrap items-center gap-x-2 gap-y-1 pt-1.5 text-[11.5px] text-ink-3">
            {s.kind === 'daily' ? (
              <span className="num">
                {dayText(s.businessDate)}入住{s.expectedCheckoutDate ? ` · 预离 ${dayText(s.expectedCheckoutDate)}` : ''}
              </span>
            ) : (
              <span className="num">钟点房 · 已住 {stayText(s.checkedInAt, Date.now())}</span>
            )}
            <Badge tone="lake">手牌 {s.tagCode}</Badge>
            {s.depositBalance > 0 && (
              <span className="font-semibold text-ink-2">
                押金 <Money cents={s.depositBalance} />
              </span>
            )}
          </span>
        </>
      ) : r.status === 'vacant' ? (
        <span className="mt-auto pt-1.5 text-[12.5px] font-semibold text-pine">{canCheckin ? '空闲 · 点这里入住' : '空闲'}</span>
      ) : r.status === 'dirty' ? (
        <span className="mt-auto flex items-center gap-1 pt-1.5 text-[12.5px] font-semibold text-clay">
          <Sparkles className="size-3.5" /> 待打扫
        </span>
      ) : (
        <span className="mt-auto flex w-full items-center gap-1 pt-1.5 text-[12.5px] font-semibold text-ink-3">
          <Wrench className="size-3.5 shrink-0" /> <span className="truncate">维修{r.maintenanceNote ? `：${r.maintenanceNote}` : ''}</span>
        </span>
      )}
    </button>
  );
}

/** 夜审提醒：今晚还有在住的全天房没挂房费；没到时刻时说明几点以后做 */
function AuditStrip({ board, onRun }: { board: RoomBoard; onRun?: () => void }) {
  const a = board.audit;
  if (a.allowed && a.pending > 0) {
    return (
      <div data-testid="rooms-audit-pending">
        <Notice
          tone="warning"
          icon={<MoonStar className="size-4" />}
          title={`今晚还有 ${a.pending} 间在住的全天房没挂房费，请做夜审`}
          action={
            onRun && (
              <Button size="sm" variant="primary" onClick={onRun}>
                做夜审
              </Button>
            )
          }
        >
          夜审给在住的全天房挂今晚的房费（同一晚只挂一次，可以重复做）；漏做的在退房时补上。
        </Notice>
      </div>
    );
  }
  return (
    <p className="text-[12.5px] text-ink-3" data-testid="rooms-audit-state">
      {a.done && a.runAt ? `营业日 ${a.date} 的夜审：${formatTime(a.runAt)} ${a.runByName ?? ''}已做。` : `营业日 ${a.date} 还没做夜审。`}
      {!a.allowed && ` 夜审在 ${minuteText(board.rules.lateFullMinute)} 以后做（这时还在住的客人要付今晚的房费）。`}
    </p>
  );
}

/** 入住：填在店客人的手牌（住客要先在前台接待、买门票），房费挂在手牌账单上，离店时随手牌结账；押金按规则默认收或不收 */
function CheckinDialog({
  room,
  board,
  booking = null,
  onHousekeep,
  onClose,
  onDone,
}: {
  room: RoomBoardRoom;
  board: RoomBoard;
  /** 按预约入住（8.0.8，A04）：手牌、人数带好，入住记到这张预约 */
  booking?: BookingDetail | null;
  /** 改房态（例如空闲的房要维修）：有「客房打扫、维修」权限时 */
  onHousekeep?: () => void;
  onClose: () => void;
  onDone: (d: StayDetail) => void;
}) {
  const session = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const rules = board.rules;
  const [tag, setTag] = useState(booking?.arrivalTagCode ?? '');
  const [label, setLabel] = useState(booking ? (booking.memberName ?? booking.guestName ?? '').slice(0, 16) : '');
  const [guests, setGuests] = useState(booking ? Math.min(MAX_STAY_GUESTS, Math.max(1, booking.guests)) : 1);
  const [leave, setLeave] = useState(room.kind === 'daily' ? shiftDate(session.today, 1) : '');
  const [withDeposit, setWithDeposit] = useState(rules.defaultDeposit > 0);
  const [deposit, setDeposit] = useState<DepositDraft>({ method: 'cash', amount: rules.defaultDeposit > 0 ? centsToInput(rules.defaultDeposit) : '', ref: '' });
  const shiftReady = useShiftReady(withDeposit);
  const op = useFrontdeskOp<StayDetail>({
    type: 'room_checkin',
    visitId: null,
    roomId: room.id,
    staffName: session.staff.displayName,
    pick: (found) => (found.type === 'room_checkin' ? found.stay : null),
  });

  useEffect(() => {
    if (op.state.phase === 'error' && op.state.code === 'PRICE_CHANGED') void qc.invalidateQueries({ queryKey: roomsKey });
    if (op.state.phase === 'error' && SHIFT_ERRORS.includes(op.state.code ?? '')) void qc.invalidateQueries({ queryKey: shiftKeys.all });
  }, [op.state, qc]);

  const tagCode = normalizeTagCode(tag);
  const tagOk = TAG_CODE_PATTERN.test(tagCode);
  const depProblem = withDeposit ? depositProblem(deposit, { required: true }) : null;
  const ok =
    tagOk &&
    Number.isInteger(guests) &&
    guests >= 1 &&
    guests <= MAX_STAY_GUESTS &&
    label.trim().length <= 16 &&
    (room.kind !== 'daily' || !leave || leave >= session.today) &&
    depProblem === null &&
    (!withDeposit || shiftReady.ready);

  const finish = (d: StayDetail) => {
    toast({ tone: 'success', title: `${d.roomNo} 已入住`, body: `${d.stayNo} · ${d.guests} 人${d.depositBalance > 0 ? ` · 押金 ${formatYuan(d.depositBalance)}` : ''}` });
    onDone(d);
  };
  const submit = async () => {
    if (!ok) return;
    const dep = withDeposit ? { method: deposit.method, amount: parseYuan(deposit.amount)!, ref: deposit.ref.trim() } : null;
    const who = `手牌 ${tagCode}${label.trim() ? ` · ${label.trim()}` : ''}`;
    const d = await op.submit((key) => ({
      url: '/api/rooms/checkin',
      body: {
        clientKey: key,
        roomId: room.id,
        tagCode,
        guestLabel: label.trim(),
        guests,
        expectedCheckoutDate: room.kind === 'daily' && leave ? leave : null,
        expectedRate: room.price,
        deposit: dep,
        bookingId: booking?.id,
      },
      tagCodes: [`房 ${room.roomNo}`],
      summary: `入住 ${guests} 人（${who}）${dep ? `，${PAYMENT_METHOD_LABELS[dep.method]}押金` : ''}${booking ? `，预约 ${booking.bookingNo}` : ''}`,
      amount: dep?.amount ?? null,
    }));
    if (d) finish(d);
  };

  return (
    <Dialog
      open
      onClose={op.busy ? () => {} : onClose}
      title={
        <span className="flex items-center gap-2">
          <BedDouble className="size-5 text-pine" /> 入住 · {spaceLabel(room.roomNo, room.spaceName)}
        </span>
      }
      description={`${room.typeName} · ${kindLabel(room.kind)} · ${rateText(room.kind, room.price, room.blockMinutes)}。入住时先挂${room.kind === 'daily' ? '第一晚' : '第一段'}房费 ${formatYuan(room.price)}。`}
      footer={
        <>
          {onHousekeep && (
            <Button variant="ghost" className="mr-auto" icon={<Wrench className="size-4" />} onClick={onHousekeep} disabled={op.locked} data-testid="room-checkin-housekeep">
              改房态
            </Button>
          )}
          <Button variant="ghost" onClick={onClose} disabled={op.busy}>
            取消
          </Button>
          <Button variant="primary" size="lg" disabled={!ok || op.locked} loading={op.busy} onClick={submit} data-testid="room-checkin-submit">
            确认入住
          </Button>
        </>
      }
    >
      <PendingPanel op={op} onResolved={finish} />
      <div className="space-y-4" data-testid="room-checkin">
        <Field
          label="住客的手牌号"
          htmlFor="room-tag"
          hint="住客要先在前台接待、买门票（门票必选，房价不含门票）；房费挂在这张手牌的账单上，离店时随手牌一起结账"
          error={tag && !tagOk ? '牌号格式不正确（例如 A023、1088）' : null}
        >
          <Input
            fullWidth={false}
            id="room-tag"
            value={tag}
            onChange={(e) => {
              setTag(e.target.value.toUpperCase());
              op.clearError();
            }}
            disabled={op.locked}
            className="num w-40 text-[16px] font-bold"
            data-autofocus
            data-testid="room-checkin-tag"
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="住客称呼" htmlFor="room-label" hint="选填，例如 王先生">
            <Input id="room-label" value={label} maxLength={16} onChange={(e) => setLabel(e.target.value)} disabled={op.locked} data-testid="room-checkin-label" />
          </Field>
          <Field label="入住人数" htmlFor="room-guests">
            <Input
              fullWidth={false}
              id="room-guests"
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_STAY_GUESTS}
              value={String(guests)}
              onChange={(e) => setGuests(Math.trunc(Number(e.target.value)) || 0)}
              disabled={op.locked}
              className="num w-24 text-[16px] font-bold"
              data-testid="room-checkin-guests"
            />
          </Field>
        </div>
        {room.kind === 'daily' && (
          <Field label="预计离店" htmlFor="room-leave" hint={`只做提醒；房费按实际住的晚数算：${minuteText(rules.checkoutMinute)} 以后退房加收半天，${minuteText(rules.lateFullMinute)} 以后加收一晚`}>
            <Input fullWidth={false} id="room-leave" type="date" min={session.today} value={leave} onChange={(e) => setLeave(e.target.value)} disabled={op.locked} className="w-48" data-testid="room-checkin-leave" />
          </Field>
        )}
        <div className="rounded-lg border border-line bg-paper/50 p-3">
          <label className="flex items-center gap-2 text-[13.5px] font-semibold">
            <input type="checkbox" checked={withDeposit} onChange={(e) => setWithDeposit(e.target.checked)} disabled={op.locked} className="size-4 accent-pine" data-testid="room-checkin-with-deposit" />
            收押金
            <span className="text-[12px] font-normal text-ink-3">押金不算营业额，退房时原路退回；现金押金计入交班</span>
          </label>
          {withDeposit && (
            <div className="mt-2.5 space-y-2">
              <DepositFields value={deposit} onChange={setDeposit} disabled={op.locked} />
              {depProblem && deposit.amount && <p className="text-[12.5px] font-semibold text-clay">{depProblem}</p>}
              <ShiftGate action="收押金" />
            </div>
          )}
        </div>
        {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} />}
      </div>
    </Dialog>
  );
}

/** 夜审：给在住的全天房挂到今晚为止还没挂的房费（同一晚只挂一次，可以重复做），出夜审报告 */
function AuditDialog({ board, onClose }: { board: RoomBoard; onClose: () => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<RoomAuditReport | null>(null);
  const a = board.audit;
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await api.post<RoomAuditReport>('/api/rooms/audit'));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: roomsKey });
    }
  };
  return (
    <Dialog
      open
      onClose={busy ? () => {} : onClose}
      width="max-w-2xl"
      title={
        <span className="flex items-center gap-2">
          <MoonStar className="size-5 text-pine" /> 夜审 · 营业日 {a.date}
        </span>
      }
      description={`过了 ${minuteText(board.rules.lateFullMinute)} 还在住的全天房要付今晚的房费：夜审给它们挂上（同一晚只挂一次，可以重复做）。钟点房按段计价，不参加夜审。`}
      footer={
        report ? (
          <Button variant="primary" onClick={onClose} data-testid="room-audit-close">
            完成
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              取消
            </Button>
            <Button variant="primary" size="lg" loading={busy} disabled={!a.allowed} onClick={run} data-testid="room-audit-run">
              做夜审
            </Button>
          </>
        )
      }
    >
      {report ? (
        <div className="space-y-4" data-testid="room-audit-report">
          <Notice tone="success" title={`夜审完成：挂了 ${report.posted.length} 晚房费，共 ${formatYuan(report.postedAmount)}`}>
            {formatDateTime(report.runAt)} {report.runByName}。在住 {report.stays.length} 间，押金余额 {formatYuan(report.depositBalance)}。
          </Notice>
          {report.posted.length > 0 && (
            <ul className="divide-y divide-line/70 rounded-lg border border-line text-[13px]">
              {report.posted.map((p, i) => (
                <li key={i} className="flex items-baseline gap-2 px-3 py-2">
                  <span className="num font-bold">{p.roomNo}</span>
                  <span className="text-ink-3">
                    {p.stayNo} · {dayText(p.nightDate)}
                  </span>
                  <span className="flex-1" />
                  <Money cents={p.amount} className="font-semibold" />
                </li>
              ))}
            </ul>
          )}
          <div>
            <p className="text-[13px] font-bold text-ink-2">在住</p>
            {report.stays.length === 0 ? (
              <p className="mt-1 text-[13px] text-ink-3">没有在住的房间</p>
            ) : (
              <ul className="mt-1 space-y-0.5 text-[12.5px] text-ink-2">
                {report.stays.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="num font-bold">{s.roomNo}</span>
                    <span>
                      {guestOf(s)} · {s.guests} 人 · {kindLabel(s.kind)} · {dayText(s.businessDate)}入住
                    </span>
                    <span className="flex-1" />
                    <span>
                      房费 <Money cents={s.chargedAmount} /> · 押金 <Money cents={s.depositBalance} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-3" data-testid="room-audit">
          {a.done && a.runAt && <Notice tone="info" title={`今天 ${formatTime(a.runAt)} ${a.runByName ?? ''}已做过夜审`}>再做一次只会补挂之后入住、还没挂今晚房费的房间。</Notice>}
          {!a.allowed && <Notice tone="warning" title={`夜审要在 ${minuteText(board.rules.lateFullMinute)} 以后做`}>这时还在住的客人才要付今晚的房费。</Notice>}
          <p className="text-[13.5px] text-ink-2">
            今晚还没挂房费的在住全天房：<b className="num">{a.pending}</b> 间
          </p>
          {error && <Notice tone="error" title={error} />}
        </div>
      )}
    </Dialog>
  );
}
