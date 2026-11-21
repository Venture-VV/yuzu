// 房态中心的房间卡片：房号、状态（颜色 + 文字 + 图标）、客人、技师、已用时长、金额（《浴族系统需求汇总》房态中心第 3 条）。
// 点卡片：空闲的技师服务房间直接登记、空闲的派对房直接开单、客房打开入住或入住单；别的打开房间详情。右上角的「详情」什么时候都能点。
// 客房的卡片多两行客房原来的内容：手牌、几号入住（预离）或钟点房已住多久、押金（8.1.16，原来的「客房」页并进来）。

import { ChevronRight, Link2, Users } from 'lucide-react';
import { elapsedText, type RoomCard as Room } from '@shared/room-center';
import type { StaySummary } from '@shared/rooms';
import { usageEstimate } from '@shared/usages';
import { cn, formatDateTime, formatTime } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Badge } from '../../components/ui';
import { dayText } from '../rooms/queries';
import { STATUS_META, StatusChip } from './status';

/** 服务中的钟还剩几分钟（超了为负） */
const minutesLeft = (plannedEnd: string, now: number) => Math.ceil((new Date(plannedEnd).getTime() - now) / 60_000);

/** 客房在住：手牌、入住与预离（钟点房是已住多久）、几位、押金 */
function StayLines({ stay: s, now }: { stay: StaySummary; now: number }) {
  return (
    <>
      <p className="flex items-center gap-1.5 truncate text-[12.5px] text-ink-2" data-testid="rc-stay">
        <span className="num font-semibold">手牌 {s.tagCode}</span>
        <span className="flex items-center gap-0.5 text-ink-3">
          <Users className="size-3.5" aria-hidden />
          {s.guests}
        </span>
        <span className="truncate text-ink-3">
          {s.kind === 'daily' ? `${dayText(s.businessDate)}入住${s.expectedCheckoutDate ? ` · 预离 ${dayText(s.expectedCheckoutDate)}` : ''}` : `钟点房 · 已住 ${elapsedText(s.checkedInAt, now)}`}
        </span>
      </p>
      {s.depositBalance > 0 && (
        <p className="text-[12.5px] text-ink-3">
          押金 <Money cents={s.depositBalance} className="font-semibold text-ink-2" />
        </p>
      )}
    </>
  );
}

/** 卡片中间那几行：按状态说这间房现在怎么样 */
function CardBody({ room, now, hint }: { room: Room; now: number; hint: string | null }) {
  if (room.status === 'maintenance') {
    const m = room.maintenance;
    const late = m ? new Date(m.expectedAt).getTime() < now : false;
    return (
      <>
        <p className="line-clamp-2 text-[13px] font-semibold text-ink-2">{m?.reason ?? room.hotel?.maintenanceNote ?? '维修中'}</p>
        {m && (
          <p className={cn('text-[12.5px]', late ? 'font-semibold text-clay' : 'text-ink-3')}>
            {late ? `已过预计时间（${formatDateTime(m.expectedAt)}）` : `预计 ${formatDateTime(m.expectedAt)} 完成`}
          </p>
        )}
      </>
    );
  }
  if (room.status === 'in_use') {
    const left = room.phase === 'serving' && room.plannedEnd ? minutesLeft(room.plannedEnd, now) : null;
    const estimate = room.usage?.pricing && room.since ? usageEstimate(Math.max(0, Math.floor((now - new Date(room.since).getTime()) / 60_000)), room.usage.pricing) : null;
    return (
      <>
        <p className="truncate text-[13.5px] font-bold text-ink" data-testid="rc-guest">
          {room.guestText ?? '有客人'}
        </p>
        {room.techText && (
          <p className="truncate text-[13px] text-ink-2" data-testid="rc-tech">
            技师 {room.techText}
          </p>
        )}
        {room.hotel?.stay ? (
          <StayLines stay={room.hotel.stay} now={now} />
        ) : (
          <p className="text-[12.5px] text-ink-2" data-testid="rc-elapsed">
            {room.phase === 'waiting' ? (
              <span className="font-semibold text-ember-deep">待上钟</span>
            ) : room.phase === 'done' ? (
              <span className="font-semibold text-ember-deep">已下钟 · 待退房</span>
            ) : room.since ? (
              <>
                已用 <b className="num">{elapsedText(room.since, now)}</b>
                {left !== null && <span className={cn('ml-1.5', left < 0 ? 'font-bold text-clay' : 'text-ink-3')}>{left < 0 ? `超 ${-left} 分` : `剩 ${left} 分`}</span>}
              </>
            ) : null}
          </p>
        )}
        {(room.amount !== null || estimate !== null) && (
          <p className="mt-auto flex items-baseline justify-end gap-1 pt-1 text-[12px] text-ink-3" data-testid="rc-amount">
            {room.amount === null ? '按现在约' : room.hotel ? '房费' : null}
            <Money cents={room.amount ?? estimate ?? 0} className="text-[17px] font-bold text-ink" />
          </p>
        )}
      </>
    );
  }
  if (room.status === 'dirty') {
    return (
      <>
        <p className="text-[13px] font-semibold text-ink-2">{room.dirtySince ? `${formatTime(room.dirtySince)} 起待清` : '待打扫'}</p>
        {room.dirtyNote && <p className="truncate text-[12.5px] text-ink-3">{room.dirtyNote}</p>}
      </>
    );
  }
  if (room.status === 'booked' && room.booking) {
    return (
      <p className="text-[13px] font-semibold text-ink-2">
        今天 {formatTime(room.booking.startsAt)} · {room.booking.guest} · {room.booking.guests} 人
      </p>
    );
  }
  return hint ? <p className={cn('mt-auto pt-1 text-[13px] font-semibold', STATUS_META.free.text)}>{hint}</p> : null;
}

export function RoomCard({
  room,
  now,
  hint,
  highlight = false,
  onOpen,
  onDetail,
}: {
  room: Room;
  now: number;
  hint: string | null;
  /** 预约到店（客房）：同房型的空房标出来 */
  highlight?: boolean;
  onOpen: () => void;
  onDetail: () => void;
}) {
  return (
    <div
      className={cn(
        'relative flex min-h-[148px] rounded-xl border border-l-[6px] transition-colors',
        STATUS_META[room.status].card,
        STATUS_META[room.status].bar,
        highlight && 'ring-2 ring-pine ring-offset-1',
      )}
      data-testid={`rc-room-${room.code}`}
      data-status={room.status}
      data-highlight={highlight ? 'booking' : undefined}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 flex-col items-stretch gap-0.5 rounded-xl px-3.5 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-pine/50"
        data-testid={`rc-open-${room.code}`}
      >
        <span className="flex items-center gap-2 pr-9">
          <span className="num min-w-0 truncate text-[20px] leading-7 font-bold text-ink">{room.code}</span>
          <StatusChip status={room.status} />
        </span>
        <span className="truncate text-[12px] text-ink-3">
          {room.name}
          {room.floor ? ` · ${room.floor}` : ''}
          {room.capacity ? ` · ${room.capacity} 人` : ''}
        </span>
        {room.merged.length > 1 && (
          <Badge tone="lake" icon={<Link2 className="size-3" />} className="mt-0.5 self-start">
            并房 {room.merged.map((m) => m.code).join(' + ')}
          </Badge>
        )}
        <CardBody room={room} now={now} hint={hint} />
      </button>
      <button
        type="button"
        onClick={onDetail}
        aria-label={`${room.code} 的详情、动作与历史`}
        title="详情、动作与历史"
        className="absolute top-1 right-1 flex size-11 items-center justify-center rounded-lg text-ink-3 hover:bg-card/70 hover:text-ink"
        data-testid={`rc-detail-${room.code}`}
      >
        <ChevronRight className="size-5" />
      </button>
    </div>
  );
}
