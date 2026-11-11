// 8.0.8 客房（docs/FRONTDESK_V808.md 第 6 节）：
//   · 改房态（B04）：先选新的房态、写备注（改维修必须写原因），再确认「W301：待打扫 → 已打扫（空闲）」；
//     提交时带上看到的房态，刚被别人改过就提示刷新；最近一次是手动改的、之后没再变过的能撤回一次。
//   · 房间详情（B07）：选房间与日期（默认近 7 天，最多 92 天），按时间倒序列出入住、换进换出、退房，房费、押金，
//     住客住在这间房期间的服务、餐饮、其他消费，房态记录；按类别筛；都从原单据现查。

import { useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { History, Undo2 } from 'lucide-react';
import { shiftDate } from '@shared/labels';
import { formatYuan } from '@shared/money';
import {
  DEFAULT_ROOM_TIMELINE_DAYS,
  HOUSEKEEPING_LABELS,
  HOUSEKEEPING_SOURCE_LABELS,
  MAX_HOUSEKEEPING_NOTE,
  MAX_ROOM_TIMELINE_DAYS,
  ROOM_TIMELINE_KINDS,
  ROOM_TIMELINE_LABELS,
  type Housekeeping,
  type RoomBoardRoom,
  type RoomTimeline,
  type RoomTimelineKind,
} from '@shared/rooms';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useBusinessToday } from '../../lib/revenue';
import { cn, formatDateTime } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Field, Input, Notice, Segmented, Select, Skeleton } from '../../components/ui';
import { roomsKey } from './queries';

/** 改房态时显示的名字：打扫好了就是空闲（在住的房另说） */
const stateText = (s: Housekeeping, occupied: boolean) => (s === 'clean' ? (occupied ? '已打扫（在住）' : '已打扫（空闲）') : HOUSEKEEPING_LABELS[s]);

/** 改房态：选新的房态 → 确认；能撤回上一次手动修改；能打开房间详情 */
export function HousekeepingDialog({ room, onClose, onDetail }: { room: RoomBoardRoom; onClose: () => void; onDetail?: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const current = room.housekeeping;
  const occupied = !!room.stay;
  const [status, setStatus] = useState<Housekeeping>(current === 'clean' ? 'dirty' : 'clean');
  const [note, setNote] = useState('');
  const [step, setStep] = useState<'choose' | 'confirm' | 'revert'>('choose');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noteOk = status !== 'maintenance' || note.trim().length >= 2;
  const ok = status !== current && noteOk;
  const last = room.lastChange;

  const fail = (e: unknown) => {
    setError(errorMessage(e));
    // 房态刚被别人改过：刷新看板，回到第一步重新选
    if (e instanceof ApiError && e.code === 'HOUSEKEEPING_CHANGED') {
      void qc.invalidateQueries({ queryKey: roomsKey });
      setStep('choose');
    }
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/api/rooms/${room.id}/housekeeping`, { status, note: note.trim() || null, expectedFrom: current });
      toast({ tone: 'success', title: `${room.roomNo} 已改为${HOUSEKEEPING_LABELS[status]}`, body: note.trim() || undefined });
      void qc.invalidateQueries({ queryKey: roomsKey });
      onClose();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const revert = async () => {
    if (!last) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/rooms/${room.id}/housekeeping/revert`, { eventId: last.id });
      toast({ tone: 'success', title: `${room.roomNo} 已撤回到「${HOUSEKEEPING_LABELS[last.from]}」` });
      void qc.invalidateQueries({ queryKey: roomsKey });
      onClose();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const footer =
    step === 'confirm' ? (
      <>
        <Button variant="ghost" onClick={() => setStep('choose')} disabled={busy}>
          返回修改
        </Button>
        <Button variant="primary" loading={busy} onClick={save} data-testid="room-housekeeping-confirm">
          确认修改
        </Button>
      </>
    ) : step === 'revert' ? (
      <>
        <Button variant="ghost" onClick={() => setStep('choose')} disabled={busy}>
          不撤回
        </Button>
        <Button variant="danger" loading={busy} onClick={revert} data-testid="room-housekeeping-revert-confirm">
          确认撤回
        </Button>
      </>
    ) : (
      <>
        {onDetail && (
          <Button variant="ghost" className="mr-auto" icon={<History className="size-4" />} onClick={onDetail} data-testid="room-detail-open">
            房间详情
          </Button>
        )}
        <Button variant="ghost" onClick={onClose}>
          取消
        </Button>
        <Button
          variant="primary"
          disabled={!ok}
          onClick={() => {
            setError(null);
            setStep('confirm');
          }}
          data-testid="room-housekeeping-save"
        >
          下一步
        </Button>
      </>
    );

  return (
    <Dialog
      open
      onClose={busy ? () => {} : onClose}
      title={`改房态 · ${room.roomNo}`}
      description={`现在：${occupied ? '在住，' : ''}${stateText(current, occupied)}${room.maintenanceNote ? `（${room.maintenanceNote}）` : ''}。退房、换房后房间自动变为待打扫，打扫好了点「已打扫」才能再入住。`}
      footer={footer}
    >
      {step === 'confirm' ? (
        <div className="space-y-3" data-testid="room-housekeeping-review">
          <p className="rounded-lg bg-paper-2 px-4 py-3 text-[16px] font-bold">
            {room.roomNo}：{stateText(current, occupied)} → <span className="text-pine">{stateText(status, occupied)}</span>
          </p>
          {note.trim() && <p className="text-[13.5px] text-ink-2">{status === 'maintenance' ? '维修原因' : '备注'}：{note.trim()}</p>}
          <p className="text-[12.5px] text-ink-3">确认后看板马上更新；改错了可以撤回（之后房态没再变过时）。</p>
          {error && <Notice tone="error" title={error} />}
        </div>
      ) : step === 'revert' && last ? (
        <div className="space-y-3">
          <p className="rounded-lg bg-paper-2 px-4 py-3 text-[15px] font-bold">
            撤回到「{stateText(last.from, occupied)}」？
          </p>
          <p className="text-[13px] text-ink-2">
            撤回的是 {last.staffName} {formatDateTime(last.at)} 的修改：{HOUSEKEEPING_LABELS[last.from]} → {HOUSEKEEPING_LABELS[last.to]}
            {last.note ? `（${last.note}）` : ''}。撤回也会记一条房态记录。
          </p>
          {error && <Notice tone="error" title={error} />}
        </div>
      ) : (
        <div className="space-y-4" data-testid="room-housekeeping">
          <Segmented
            value={status}
            onChange={(v) => {
              setStatus(v);
              setError(null);
            }}
            ariaLabel="房态"
            options={[
              { value: 'clean', label: '已打扫（空闲）', disabled: current === 'clean' },
              { value: 'dirty', label: '待打扫', disabled: current === 'dirty' },
              { value: 'maintenance', label: '维修', disabled: current === 'maintenance' || occupied },
            ]}
          />
          <Field label={status === 'maintenance' ? '维修原因' : '备注（选填）'} htmlFor="hk-note" hint={status === 'maintenance' ? '至少 2 个字' : '例如：已检查、换了床品'}>
            <Input
              id="hk-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={status === 'maintenance' ? '例如：空调不制冷' : '写给下一班看的'}
              maxLength={MAX_HOUSEKEEPING_NOTE}
              aria-label={status === 'maintenance' ? '维修原因' : '备注'}
              data-testid="room-maintenance-note"
            />
          </Field>
          {last && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-line px-3 py-2 text-[12.5px] text-ink-2" data-testid="room-housekeeping-last">
              <span className="font-semibold text-ink-3">上一次</span>
              <Badge tone={last.source === 'auto' ? 'neutral' : last.source === 'revert' ? 'yuzu' : 'lake'}>{HOUSEKEEPING_SOURCE_LABELS[last.source]}</Badge>
              <span>
                {HOUSEKEEPING_LABELS[last.from]} → {HOUSEKEEPING_LABELS[last.to]}
                {last.note ? `（${last.note}）` : ''} · {last.staffName} {formatDateTime(last.at)}
              </span>
              {last.canRevert && (
                <Button size="sm" variant="ghost" className="ml-auto" icon={<Undo2 className="size-3.5" />} onClick={() => setStep('revert')} data-testid="room-housekeeping-revert">
                  撤回
                </Button>
              )}
            </div>
          )}
          {error && <Notice tone="error" title={error} />}
        </div>
      )}
    </Dialog>
  );
}

const FILTERS = ['all', ...ROOM_TIMELINE_KINDS] as const;
type Filter = (typeof FILTERS)[number];
const KIND_TONE: Record<RoomTimelineKind, 'pine' | 'yuzu' | 'lake' | 'clay' | 'neutral' | 'moss' | 'ember'> = {
  stay: 'pine',
  charge: 'yuzu',
  deposit: 'neutral',
  service: 'lake',
  dining: 'ember',
  other: 'moss',
  housekeeping: 'neutral',
};

/** 房间详情（B07）：选房间与日期，按时间倒序列出这间房的单据 */
export function RoomDetailDialog({ rooms, roomId, onClose }: { rooms: RoomBoardRoom[]; roomId: number | null; onClose: () => void }) {
  const today = useBusinessToday();
  const [id, setId] = useState<number | null>(roomId ?? rooms[0]?.id ?? null);
  const [from, setFrom] = useState(shiftDate(today, -(DEFAULT_ROOM_TIMELINE_DAYS - 1)));
  const [to, setTo] = useState(today);
  const [filter, setFilter] = useState<Filter>('all');
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  const problem = !from || !to ? '请选择起止日期' : from > to ? '开始日期不能晚于结束日期' : days > MAX_ROOM_TIMELINE_DAYS ? `一次最多查 ${MAX_ROOM_TIMELINE_DAYS} 天` : null;
  const q = useQuery({
    queryKey: ['rooms', 'timeline', id, from, to],
    queryFn: () => api.get<RoomTimeline>(`/api/rooms/${id}/timeline?from=${from}&to=${to}`),
    enabled: id !== null && !problem,
    placeholderData: keepPreviousData,
  });
  const entries = (q.data?.entries ?? []).filter((e) => filter === 'all' || e.kind === filter);
  const sumOf = (kinds: RoomTimelineKind[]) =>
    (q.data?.entries ?? []).filter((e) => kinds.includes(e.kind) && e.amount !== null && e.status === null).reduce((n, e) => n + (e.amount ?? 0), 0);
  const room = rooms.find((r) => r.id === id);

  return (
    <Dialog open onClose={onClose} title={`房间详情${room ? ` · ${room.roomNo}` : ''}`} width="max-w-3xl" description="这间房的入住、房费、押金、住客住在这间期间的消费与房态记录，都从原单据现查；金额与账单一致。">
      <div className="space-y-3" data-testid="room-detail">
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <Select value={id ?? ''} onChange={(e) => setId(Number(e.target.value) || null)} fullWidth={false} className="w-40" aria-label="房间" data-testid="room-detail-room">
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.roomNo} · {r.typeName}
              </option>
            ))}
          </Select>
          <Input type="date" value={from} max={today} onChange={(e) => setFrom(e.target.value)} fullWidth={false} className="w-40" aria-label="从" />
          至
          <Input type="date" value={to} max={today} onChange={(e) => setTo(e.target.value)} fullWidth={false} className="w-40" aria-label="到" />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn('h-7 rounded-full border px-3 text-[12.5px] font-semibold', filter === f ? 'border-pine bg-pine-soft text-pine' : 'border-line text-ink-3 hover:text-ink')}
              data-testid={`room-detail-filter-${f}`}
            >
              {f === 'all' ? '全部' : ROOM_TIMELINE_LABELS[f]}
            </button>
          ))}
        </div>
        {problem ? (
          <Notice tone="warning" title={problem} />
        ) : !q.data ? (
          q.error ? <Notice tone="error" title={errorMessage(q.error)} /> : <Skeleton className="h-40" />
        ) : (
          <>
            <p className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-ink-2" data-testid="room-detail-totals">
              <span>
                房费 <b className="num text-ink">{formatYuan(sumOf(['charge']))}</b>
              </span>
              <span>
                服务 <b className="num text-ink">{formatYuan(sumOf(['service']))}</b>
              </span>
              <span>
                餐饮 <b className="num text-ink">{formatYuan(sumOf(['dining']))}</b>
              </span>
              <span>
                其他 <b className="num text-ink">{formatYuan(sumOf(['other']))}</b>
              </span>
              <span className="text-ink-3">（只算有效的；押金不算）</span>
            </p>
            {entries.length === 0 ? (
              <p className="py-6 text-center text-[13px] text-ink-3">这段时间没有{filter === 'all' ? '记录' : ROOM_TIMELINE_LABELS[filter]}。</p>
            ) : (
              <ul className="max-h-[52vh] divide-y divide-line overflow-y-auto rounded-lg border border-line">
                {entries.map((e) => (
                  <li key={e.key} className={cn('flex items-start gap-3 px-3 py-2.5 text-[13px]', e.status && 'opacity-60')} data-testid={`room-detail-entry-${e.key}`}>
                    <span className="num w-[86px] shrink-0 pt-0.5 text-[12px] text-ink-3">{formatDateTime(e.at)}</span>
                    <Badge tone={KIND_TONE[e.kind]} className="mt-px">
                      {ROOM_TIMELINE_LABELS[e.kind]}
                    </Badge>
                    <span className="min-w-0 flex-1">
                      <span className={cn('font-semibold', e.status && 'line-through')}>{e.title}</span>
                      {e.status && <span className="ml-1.5 text-[12px] font-semibold text-clay">{e.status}</span>}
                      <span className="block truncate text-[12px] text-ink-3" title={e.detail}>
                        {[e.detail, e.ref, e.staffName].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    {e.amount !== null && <span className={cn('num shrink-0 font-bold', e.amount < 0 && 'text-clay')}>{formatYuan(e.amount)}</span>}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
