// 房态中心（8.1.15 / 8.1.16，《浴族系统需求汇总》房态中心 1–4，docs/ROOM_CENTER_V8115.md 第 7 节）：
//   · 按房型分页签，另有「总览」；每个页签顶上是总数与空闲、在用、待清、维修、已预订各几间（点一下只看这一种）；
//   · 每间房一张卡片（房号、状态、客人、技师、已用时长、金额）：技师服务的房间点卡片登记、派对房点卡片开单、客房点卡片入住或看入住单，
//     别的（以及卡片右上角的「详情」）打开房间详情——上钟、下钟、续钟、换房、退房、并房、维修、标待清、清洁完成、房间历史；
//   · 原来的「客房」页（房态看板、平面图、派对房）并进来：客房在「客房」页签里（入住、入住单、改房态、夜审都是原来的对话框），
//     平面图是「视图 → 平面图」，派对房在自己的房型页签里；旧地址 /rooms 跳到这里（App.tsx 的 RoomsMoved）；
//   · 地址里记着页签、状态筛选、视图（?tab=c3&status=dirty、?view=map），刷新、返回都还在；顶部「结果待确认」的「去处理」带 ?resume=
//     回到那间房（入住、入住单、开单、使用单、房间动作），预约到店带 ?booking=（客房页签里同房型的空房标出来）。

import { useEffect, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { History, LayoutGrid, Map as MapIcon, MoonStar, Settings2 } from 'lucide-react';
import type { BookingDetail } from '@shared/bookings';
import { ROOM_STATUSES, ROOM_STATUS_LABELS, type RoomCard, type RoomCategoryView, type RoomCenterBoard, type RoomStatus } from '@shared/room-center';
import { ROOM_BOARD_LABELS, type RoomBoard } from '@shared/rooms';
import { api } from '../../lib/api';
import { useServerNow } from '../../lib/serverClock';
import { useCan, useSession } from '../../lib/session';
import { cn } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { useToast } from '../../components/Toast';
import { Button, Notice, Segmented, Skeleton } from '../../components/ui';
import { FLOOR_MAP_REFRESH_MS } from '../rooms/floormap-api';
import { FloorMapView, type MapAction } from '../rooms/FloorMap';
import { AuditDialog, AuditStrip, CheckinDialog } from '../rooms/HotelDialogs';
import { useRoomBoard } from '../rooms/queries';
import { HousekeepingDialog, RoomDetailDialog } from '../rooms/RoomDetail';
import { StayDialog, type StayAction } from '../rooms/StayDialog';
import { CloseUsageDialog, CloseUsageFor, EndUsageById, OpenUsageDialog } from '../rooms/UsageDialogs';
import { roomUrl, useRefreshRoomCenter, useRoomCenter } from './queries';
import { CheckoutRoomDialog, ExtendRoomDialog, MaintenanceDialog, MergeRoomDialog, MoveRoomDialog, NoteActionDialog } from './RoomActions';
import { RoomCard as RoomTile } from './RoomCard';
import { RoomDialog, type RoomDialogAction } from './RoomDialog';
import { RegisterDialog } from './RegisterDialog';
import { CountChips, STATUS_META } from './status';

/** 「总览」页签的键（房型页签是 c<编号>、没归类的是 other；地址里 tab=hotel、tab=party 指第一个客房、派对房房型） */
const OVERVIEW = 'all';
/** 客房功能没开时平面图用的空看板（平面图只用它的房间） */
const NO_HOTEL_ROOMS: Pick<RoomBoard, 'rooms'> = { rooms: [] };
const STAY_RESUME: Record<string, StayAction> = { room_extend: 'extend', room_deposit: 'deposit', room_refund: 'refund', room_close: 'close' };

export function RoomCenterPage() {
  return (
    <>
      <PageHeader title="房态中心" subtitle="按房型看每间房的状态：点卡片登记、开单、入住；卡片右上角看详情、做续钟、换房、退房、并房、维修与清洁完成" />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <RoomCenterBody />
      </div>
    </>
  );
}

type Action = { spaceId: number; a: RoomDialogAction };
type MapUsage = Extract<MapAction, { kind: 'usage_open' | 'usage_close' }>;

function RoomCenterBody() {
  const can = useCan();
  const session = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const q = useRoomCenter();
  const view = params.get('view') === 'map' ? 'map' : 'cards';
  const canOperate = can('room.operate');
  const canHousekeep = can('room.housekeep');
  const canPost = can('technician.dispatch') && can('frontdesk.operate');
  // 客房的房态看板（入住、入住单、夜审要它的规则与房间；平面图上客房的颜色也按它）：客房功能开着、看得了客房的才取
  const hotelQ = useRoomBoard(session.rooms && (canOperate || canHousekeep || can('frontdesk.checkout')), view === 'map' ? FLOOR_MAP_REFRESH_MS : 15_000);
  const hotel = hotelQ.data ?? null;
  const refresh = useRefreshRoomCenter();
  const now = useServerNow(q.data?.serverTime, 30_000);

  const [detail, setDetail] = useState<number | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [checkinRoomId, setCheckinRoomId] = useState<number | null>(null);
  const [stay, setStay] = useState<{ id: number; action?: StayAction | 'move' } | null>(null);
  const [housekeepRoomId, setHousekeepRoomId] = useState<number | null>(null);
  // 客房的房间详情（房态与入住的时间线）：null 关着；0 为没选房间（默认第一间）
  const [hotelDetail, setHotelDetail] = useState<number | null>(null);
  const [auditing, setAuditing] = useState(false);
  const [mapUsage, setMapUsage] = useState<MapUsage | null>(null);
  const [usageById, setUsageById] = useState<{ id: number; mode: 'end' | 'cancel' } | null>(null);
  const [forBooking, setForBooking] = useState<BookingDetail | null>(null);

  const setParam = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  };

  // 顶部「结果待确认」的「去处理」（?resume=）：回到那间房的对话框——客房的入住、入住单，派对房的开单、使用单，房间动作的房间详情
  const resume = params.get('resume');
  useEffect(() => {
    if (!resume) return;
    const num = (k: string) => Number(params.get(k)) || null;
    const [r, s, sp, u] = [num('r'), num('s'), num('sp'), num('u')];
    if (resume === 'room_checkin' && r) setCheckinRoomId(r);
    else if (s && STAY_RESUME[resume]) setStay({ id: s, action: STAY_RESUME[resume] });
    else if (resume === 'usage_open' && sp) setAction({ spaceId: sp, a: { kind: 'usage_open' } });
    else if ((resume === 'usage_end' || resume === 'usage_cancel') && u) setUsageById({ id: u, mode: resume === 'usage_end' ? 'end' : 'cancel' });
    else if ((resume === 'space_state' || resume === 'space_dispatch') && sp) setDetail(sp);
    const next = new URLSearchParams(params);
    for (const k of ['resume', 'r', 's', 'sp', 'u', 'v']) next.delete(k);
    setParams(next, { replace: true });
  }, [resume, params, setParams]);

  // 预约到店（8.0.8，A04）：从预约页过来带 ?booking=，到「客房」页签、标出预约的房型，点一间空房就入住（手牌、人数带好，入住记到这张预约）
  const bookingParam = Number(params.get('booking')) || null;
  const bookingQ = useQuery({ queryKey: ['bookings', 'one', bookingParam], queryFn: () => api.get<BookingDetail>(`/api/bookings/${bookingParam}`), enabled: !!bookingParam });
  useEffect(() => {
    const bk = bookingQ.data;
    if (!bk || bk.id !== bookingParam) return;
    const next = new URLSearchParams(params);
    next.delete('booking');
    if (bk.kind !== 'room' || bk.status !== 'arrived') toast({ tone: 'error', title: `预约 ${bk.bookingNo} 不是已到店的客房预约` });
    else if (bk.service) toast({ tone: 'info', title: `预约 ${bk.bookingNo} 已经入住了（${bk.service.no}）` });
    else {
      setForBooking(bk);
      next.set('tab', 'hotel');
      next.delete('status');
      next.delete('view');
    }
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingQ.data, bookingParam]);

  if (q.isPending) return <Skeleton className="m-4 h-64 md:m-7" />;
  if (q.isError && !q.data) return <LoadFailed title="房态没取回来" className="m-4 md:m-7" onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  const board = q.data!;
  const cats = board.categories;
  const tabParam = params.get('tab');
  const wanted = tabParam === 'hotel' || tabParam === 'party' ? cats.find((c) => c.source === tabParam)?.key : tabParam;
  const tab = wanted && cats.some((c) => c.key === wanted) ? wanted : OVERVIEW;
  const statusParam = params.get('status');
  const filter = (ROOM_STATUSES as readonly string[]).includes(statusParam ?? '') ? (statusParam as RoomStatus) : null;
  const cat = cats.find((c) => c.key === tab) ?? null;
  const hotelTab = cat?.source === 'hotel';

  const byKey = (spaceId: number | null) => board.rooms.find((r) => r.spaceId === spaceId && r.kind !== 'hotel') ?? null;
  const detailRoom = detail === null ? null : byKey(detail);
  const actionRoom = action ? byKey(action.spaceId) : null;
  const checkinRoom = checkinRoomId === null ? null : (hotel?.rooms.find((r) => r.id === checkinRoomId) ?? null);
  const housekeepRoom = housekeepRoomId === null ? null : (hotel?.rooms.find((r) => r.id === housekeepRoomId) ?? null);
  const closeAction = () => setAction(null);
  /** 客房原来的对话框关上时：客房、房态中心两份看板一起刷新 */
  const hotelClosed = () => refresh();
  /** 平面图、「结果待确认」打开的使用单对话框做完了 */
  const usageDone = () => {
    setMapUsage(null);
    setUsageById(null);
    refresh();
  };

  /** 客房的卡片：在住的看入住单，空闲的入住，待打扫、维修的改房态（与原来的「客房」页一样） */
  const openHotel = (room: RoomCard) => {
    const h = room.hotel;
    if (!h) return;
    if (!hotel) return toast({ tone: 'info', title: '客房的房态还在取，请稍等一下再点' });
    if (h.stay) {
      if (canOperate) setStay({ id: h.stay.id });
      else toast({ tone: 'info', title: `${h.roomNo} 在住`, body: '客人退房后房间变为待打扫，打扫好了再点「已打扫」' });
    } else if (h.status === 'vacant' && canOperate) setCheckinRoomId(h.id);
    else if (canHousekeep) setHousekeepRoomId(h.id);
    else toast({ tone: 'info', title: `${h.roomNo} ${ROOM_BOARD_LABELS[h.status]}`, body: '入住要有「客房入住、退房」权限，改房态要有「客房打扫、维修」权限' });
  };
  /** 点卡片：空闲（或已预订）的技师服务房间登记、派对房开单；别的打开房间详情 */
  const open = (room: RoomCard) => {
    if (room.kind === 'hotel') return openHotel(room);
    const vacant = room.status === 'free' || room.status === 'booked';
    if (vacant && room.kind === 'service' && canPost) return setAction({ spaceId: room.spaceId!, a: { kind: 'register', join: false } });
    if (vacant && room.kind === 'party' && canOperate) return setAction({ spaceId: room.spaceId!, a: { kind: 'usage_open' } });
    setDetail(room.spaceId);
  };
  const openDetail = (room: RoomCard) => (room.kind === 'hotel' ? setHotelDetail(room.hotel?.id ?? 0) : setDetail(room.spaceId));
  const mapAction = (a: MapAction) => {
    if (a.kind === 'checkin') setCheckinRoomId(a.roomId);
    else if (a.kind === 'stay') setStay({ id: a.stayId, action: a.action });
    else if (a.kind === 'housekeep') setHousekeepRoomId(a.room.id);
    else setMapUsage(a);
  };
  const highlighted = (room: RoomCard) => !!forBooking && room.kind === 'hotel' && room.hotel?.status === 'vacant' && room.hotel.typeName === forBooking.roomTypeName;
  const grid = (list: RoomCard[]) => (
    <div className="grid grid-cols-1 gap-2.5 min-[480px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5" data-testid="rc-grid">
      {list.map((r) => (
        <RoomTile key={r.key} room={r} now={now} hint={hintOf(r, canPost, canOperate)} highlight={highlighted(r)} onOpen={() => open(r)} onDetail={() => openDetail(r)} />
      ))}
    </div>
  );

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 px-4 py-4 md:px-7 md:py-5" data-testid="room-center" data-tab={tab}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Segmented<'cards' | 'map'>
          size="sm"
          ariaLabel="视图"
          value={view}
          onChange={(v) => setParam({ view: v === 'map' ? 'map' : null })}
          options={[
            {
              value: 'cards',
              label: (
                <span className="flex items-center gap-1">
                  <LayoutGrid className="size-3.5" />
                  房态
                </span>
              ),
            },
            {
              value: 'map',
              label: (
                <span className="flex items-center gap-1" data-testid="rc-view-map">
                  <MapIcon className="size-3.5" />
                  平面图
                </span>
              ),
            },
          ]}
        />
        <span className="flex-1" />
        {(can('settings.manage') || can('catalog.manage')) && (
          <Link
            to="/admin/spaces/room-categories"
            className="flex h-11 items-center gap-1.5 rounded-lg px-3 text-[13px] font-semibold text-ink-2 hover:bg-paper-2 hover:text-ink"
            data-testid="rc-admin-link"
          >
            <Settings2 className="size-4" /> 房型配置
          </Link>
        )}
      </div>

      {view === 'map' ? (
        <FloorMapView board={hotel ?? NO_HOTEL_ROOMS} onAction={mapAction} />
      ) : (
        <>
          <Tabs cats={cats} total={board.total.total} active={tab} onPick={(key) => setParam({ tab: key === OVERVIEW ? null : key, status: null })} />
          {cat?.hint && (
            <Notice tone="info" title={cat.hint} data-testid="rc-tab-hint">
              {hotelTab && '客房照旧走入住单：点卡片入住、看入住单、改房态。'}
            </Notice>
          )}
          <CountChips counts={cat ? cat.counts : board.total} filter={filter} onFilter={(s) => setParam({ status: s })} testId="rc-counts" />
          {hotelTab && hotel && (
            <div className="space-y-2" data-testid="rc-hotel-tools">
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button size="sm" variant="ghost" icon={<History className="size-4" />} className="h-11" onClick={() => setHotelDetail(0)} data-testid="rooms-detail">
                  客房详情
                </Button>
                {canOperate && (
                  <Button size="sm" variant="secondary" icon={<MoonStar className="size-4" />} className="h-11" onClick={() => setAuditing(true)} data-testid="rooms-audit">
                    夜审
                  </Button>
                )}
              </div>
              <AuditStrip board={hotel} onRun={canOperate ? () => setAuditing(true) : undefined} />
              {forBooking && (
                <Notice
                  tone="info"
                  title={`预约 ${forBooking.bookingNo} 到店：${forBooking.roomTypeName ?? ''} · 手牌 ${forBooking.arrivalTagCode ?? ''} · ${forBooking.guests} 人`}
                  data-testid="rooms-for-booking"
                  action={
                    <Button size="sm" variant="ghost" onClick={() => setForBooking(null)}>
                      不按预约开房
                    </Button>
                  }
                >
                  点一间空闲的房入住（同房型的空房已标出）；手牌、人数已带好，入住记到这张预约，同一张预约不会重复开房。
                </Notice>
              )}
            </div>
          )}
          {cat ? (
            <CategoryRooms board={board} cat={cat} filter={filter} grid={grid} onAll={() => setParam({ status: null })} />
          ) : (
            <Overview board={board} filter={filter} grid={grid} onPick={(key) => setParam({ tab: key, status: null })} onAll={() => setParam({ status: null })} />
          )}
        </>
      )}

      {detailRoom && (
        <RoomDialog
          room={detailRoom}
          now={now}
          onClose={() => setDetail(null)}
          onAction={(a) => {
            setDetail(null);
            setAction({ spaceId: detailRoom.spaceId!, a });
          }}
        />
      )}
      {actionRoom && action && (
        <ActionDialog
          room={actionRoom}
          a={action.a}
          rooms={board.rooms}
          onClose={closeAction}
          onDetail={() => {
            closeAction();
            setDetail(actionRoom.spaceId);
          }}
        />
      )}
      {checkinRoom && hotel && (
        <CheckinDialog
          room={checkinRoom}
          board={hotel}
          booking={forBooking}
          onHousekeep={
            canHousekeep
              ? () => {
                  setHousekeepRoomId(checkinRoom.id);
                  setCheckinRoomId(null);
                }
              : undefined
          }
          onClose={() => setCheckinRoomId(null)}
          onDone={(d) => {
            setCheckinRoomId(null);
            setForBooking(null);
            setStay({ id: d.id });
            hotelClosed();
            void qc.invalidateQueries({ queryKey: ['bookings'] });
          }}
        />
      )}
      {stay && hotel && (
        <StayDialog
          id={stay.id}
          action={stay.action}
          board={hotel}
          onClose={() => {
            setStay(null);
            hotelClosed();
          }}
          onRoomDetail={(roomId) => {
            setStay(null);
            setHotelDetail(roomId);
          }}
        />
      )}
      {housekeepRoom && (
        <HousekeepingDialog
          room={housekeepRoom}
          onClose={() => {
            setHousekeepRoomId(null);
            hotelClosed();
          }}
          onDetail={() => {
            setHotelDetail(housekeepRoom.id);
            setHousekeepRoomId(null);
          }}
        />
      )}
      {hotelDetail !== null && hotel && <RoomDetailDialog rooms={hotel.rooms} roomId={hotelDetail || null} onClose={() => setHotelDetail(null)} />}
      {auditing && hotel && (
        <AuditDialog
          board={hotel}
          onClose={() => {
            setAuditing(false);
            hotelClosed();
          }}
        />
      )}
      {/* 平面图上的派对房：开单、结束、撤单照平面图原来的接口（docs/ROOM_CENTER_V8115.md 第 9 节：只拦维修） */}
      {mapUsage?.kind === 'usage_open' && <OpenUsageDialog space={mapUsage.space} onClose={() => setMapUsage(null)} onDone={usageDone} />}
      {mapUsage?.kind === 'usage_close' && <CloseUsageDialog usage={mapUsage.usage} space={mapUsage.space} mode={mapUsage.mode} onClose={() => setMapUsage(null)} onDone={usageDone} />}
      {usageById && <EndUsageById usageId={usageById.id} mode={usageById.mode} onClose={() => setUsageById(null)} onDone={usageDone} />}
    </div>
  );
}

/** 空闲卡片上的那句提示：点了会做什么（没权限的不写） */
function hintOf(room: RoomCard, canPost: boolean, canOperate: boolean): string | null {
  if (room.status !== 'free') return null;
  if (room.kind === 'service') return canPost ? '空闲 · 点这里登记' : '空闲';
  if (room.kind === 'party') return canOperate ? '空闲 · 点这里开单' : '空闲';
  if (room.kind === 'hotel') return canOperate ? '空闲 · 点这里入住' : '空闲';
  return '空闲';
}

/** 页签：总览 + 每个房型（带总间数）；手机上一行左右滑，宽屏折行 */
function Tabs({ cats, total, active, onPick }: { cats: RoomCategoryView[]; total: number; active: string; onPick: (key: string) => void }) {
  const tabs = [{ key: OVERVIEW, name: '总览', total }, ...cats.map((c) => ({ key: c.key, name: c.name, total: c.counts.total }))];
  return (
    <div role="tablist" aria-label="房型" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 sm:flex-wrap sm:overflow-visible" data-testid="rc-tabs">
      {tabs.map((t) => {
        const on = t.key === active;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onPick(t.key)}
            className={cn(
              'flex h-11 shrink-0 items-center gap-1.5 rounded-full border px-4 text-[14px] font-semibold whitespace-nowrap',
              on ? 'border-pine bg-pine text-paper' : 'border-line-strong bg-card text-ink-2 hover:border-ink-4',
            )}
            data-testid={`rc-tab-${t.key}`}
          >
            {t.name}
            <span className={cn('num rounded-full px-1.5 text-[13px]', on ? 'bg-paper/20' : 'bg-paper-2 text-ink-3')}>{t.total}</span>
          </button>
        );
      })}
    </div>
  );
}

/** 一个房型页签：卡片（按状态筛过的）；一间都没有、筛完没有的写明 */
function CategoryRooms({ board, cat, filter, grid, onAll }: { board: RoomCenterBoard; cat: RoomCategoryView; filter: RoomStatus | null; grid: (list: RoomCard[]) => ReactNode; onAll: () => void }) {
  const all = board.rooms.filter((r) => r.categoryKey === cat.key);
  const list = filter ? all.filter((r) => r.status === filter) : all;
  if (all.length === 0) {
    return (
      <EmptyState
        art="calm"
        title={`「${cat.name}」还没有房间`}
        description={
          cat.source === 'hotel'
            ? '客房的房间在「后台 → 客房」里建、挂接空间台账的空间；客房功能开启后，这里看客房的房态。'
            : `空间台账里还没有归到这个房型的空间：店主在「后台 → 空间台账」把房间的业态设好，在「房态中心房型」里把业态归到「${cat.name}」。`
        }
      />
    );
  }
  if (list.length === 0) return <NoMatch filter={filter!} onAll={onAll} />;
  return grid(list);
}

function NoMatch({ filter, onAll }: { filter: RoomStatus; onAll: () => void }) {
  return (
    <EmptyState
      art="calm"
      title={`没有${ROOM_STATUS_LABELS[filter]}的房间`}
      action={
        <Button variant="secondary" className="h-11" onClick={onAll}>
          看全部
        </Button>
      }
    />
  );
}

/** 总览：每个房型一张小卡（各状态几间，点一下进那个页签），下面按房型分组列全部的房间（按状态筛过的） */
function Overview({
  board,
  filter,
  grid,
  onPick,
  onAll,
}: {
  board: RoomCenterBoard;
  filter: RoomStatus | null;
  grid: (list: RoomCard[]) => ReactNode;
  onPick: (key: string) => void;
  onAll: () => void;
}) {
  if (board.rooms.length === 0) {
    return <EmptyState art="calm" title="还没有房间" description="房间来自空间台账：店主在「后台 → 空间台账」导入或新建房间，在「房态中心房型」里把业态归到房型以后，这里按房型看房态。" />;
  }
  const groups = board.categories.map((c) => [c, board.rooms.filter((r) => r.categoryKey === c.key && (!filter || r.status === filter))] as const).filter(([, list]) => list.length > 0);
  return (
    <div className="space-y-5" data-testid="rc-overview">
      <div className="grid grid-cols-1 gap-2 min-[480px]:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4" data-testid="rc-summary">
        {board.categories.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => onPick(c.key)}
            className="flex min-h-11 flex-col gap-1 rounded-xl border border-line bg-card px-3.5 py-2.5 text-left hover:border-line-strong"
            data-testid={`rc-summary-${c.key}`}
          >
            <span className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate text-[15px] font-bold text-ink">{c.name}</span>
              <span className="text-[13px] text-ink-3">
                共 <b className="num text-[16px] text-ink">{c.counts.total}</b> 间
              </span>
            </span>
            <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-[13px]">
              {(['free', 'in_use', 'dirty', 'maintenance'] as const).map((s) => {
                const Icon = STATUS_META[s].icon;
                const n = c.counts[s === 'in_use' ? 'inUse' : s];
                return (
                  <span key={s} className={cn('flex items-center gap-1 font-semibold', n > 0 ? STATUS_META[s].text : 'text-ink-4')}>
                    <Icon className="size-3.5" aria-hidden />
                    {ROOM_STATUS_LABELS[s]} <b className="num">{n}</b>
                  </span>
                );
              })}
            </span>
          </button>
        ))}
      </div>
      {groups.length === 0 && filter ? (
        <NoMatch filter={filter} onAll={onAll} />
      ) : (
        groups.map(([c, list]) => (
          <section key={c.key} aria-label={c.name} data-testid={`rc-group-${c.key}`}>
            <h3 className="mb-2 flex items-baseline gap-2 text-[15px] font-bold text-ink-2">
              {c.name}
              <span className="text-[13px] font-normal text-ink-3">{list.length} 间</span>
            </h3>
            {grid([...list])}
          </section>
        ))
      )}
    </div>
  );
}

/** 房间详情里点的动作：登记、开单、结束 / 撤单、续钟、换房、并房、退房、维修、标待清、恢复 */
function ActionDialog({ room, a, rooms, onClose, onDetail }: { room: RoomCard; a: RoomDialogAction; rooms: RoomCard[]; onClose: () => void; onDetail: () => void }) {
  const toast = useToast();
  const refresh = useRefreshRoomCenter();
  const done = (board?: RoomCenterBoard | null) => {
    refresh(board ?? null);
    onClose();
  };
  switch (a.kind) {
    case 'register':
      return (
        <RegisterDialog
          room={room}
          join={a.join}
          onClose={onClose}
          onDetail={onDetail}
          onDone={(board) => {
            toast({ tone: 'success', title: `${room.code} 已登记`, body: '挂账、派钟、占房一步做完' });
            done(board);
          }}
        />
      );
    case 'usage_open':
      return (
        <OpenUsageDialog
          space={{ id: room.spaceId!, code: room.code, displayName: room.name, businessType: room.businessType, capacity: room.capacity }}
          priced={room.usagePriced}
          url={roomUrl(room.spaceId!, 'usage')}
          onClose={onClose}
          onDone={() => done()}
        />
      );
    case 'usage_close':
      return room.usage ? <CloseUsageFor usage={room.usage} mode={a.mode} onClose={onClose} onDone={() => done()} /> : null;
    case 'extend':
      return <ExtendRoomDialog room={room} session={a.session} onClose={onClose} onDone={(board) => done(board)} />;
    case 'move':
      return <MoveRoomDialog room={room} rooms={rooms} onClose={onClose} onDone={onClose} />;
    case 'merge':
      return <MergeRoomDialog room={room} rooms={rooms} onClose={onClose} onDone={onClose} />;
    case 'checkout':
      return <CheckoutRoomDialog room={room} onClose={onClose} onDone={onClose} />;
    case 'maintenance':
      return <MaintenanceDialog room={room} onClose={onClose} onDone={onClose} />;
    case 'dirty':
    case 'restore':
      return <NoteActionDialog room={room} action={a.kind} onClose={onClose} onDone={onClose} />;
  }
}
