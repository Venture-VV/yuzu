// 实时位置（飞书需求 RQ-004 第一级，v0.7.17，见 docs/ROOMMAP.md 第 3 节）：平面图上的人员图层与「在场」名单。
// 位置由刷卡点刷卡与业务动作推出来（发牌、挂账、开房、上下钟……），停在上一次动作；精度到区域与房间。
// 只显示手牌号与技师，不显示会员姓名、手机号。

import { memo, useMemo, useState } from 'react';
import { MapPin, Search, X } from 'lucide-react';
import {
  LOCATION_EVENT_KIND_LABELS,
  LOCATION_SOURCE_LABELS,
  placeText,
  type LocationPerson,
  type LocationsCurrent,
  type LocationTrackData,
} from '@shared/locations';
import type { FloorMapSpace } from '@shared/floormap';
import { errorMessage } from '../../lib/api';
import { cn, formatTime } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { Badge, Button, Input, Notice, Skeleton } from '../../components/ui';
import { useLocationTrack } from './floormap';

export interface PeopleEntry {
  key: string;
  code: string;
  polygon: [number, number][] | null;
  labelAt: [number, number];
  space: FloorMapSpace | null;
}

export interface ZoneBadge {
  zoneId: number;
  name: string;
  count: number;
  at: [number, number];
}

/** 一个人的称呼：手牌 A023 / 技师 07 号 张三 */
export const personText = (p: Pick<LocationPerson, 'kind' | 'tagCode' | 'techNo' | 'techName'>) =>
  p.kind === 'guest' ? `手牌 ${p.tagCode}` : `技师 ${p.techNo} 号 ${p.techName ?? ''}`.trim();

/** 轨迹接口的查询串 */
export const trackQuery = (p: Pick<LocationPerson, 'kind' | 'id'>) => (p.kind === 'guest' ? `visitId=${p.id}` : `technicianId=${p.id}`);

/** 当前楼层：每个空间里的人、每个区域（没到房间的）里的人，区域人数标在它的空间轮廓中间 */
export function usePeopleOnFloor(people: LocationPerson[], floorCode: string | null, entries: PeopleEntry[]) {
  return useMemo(() => {
    const bySpace = new Map<number, LocationPerson[]>();
    const byZone = new Map<number, { name: string; people: LocationPerson[] }>();
    for (const p of people) {
      if (p.floorCode !== floorCode) continue;
      if (p.spaceId !== null) bySpace.set(p.spaceId, [...(bySpace.get(p.spaceId) ?? []), p]);
      else if (p.zoneId !== null) {
        const z = byZone.get(p.zoneId) ?? { name: p.zoneName ?? '', people: [] };
        z.people.push(p);
        byZone.set(p.zoneId, z);
      }
    }
    // 区域没有轮廓：取图上属于这个区域的空间的位置的中间
    const points = new Map<number, [number, number][]>();
    for (const e of entries) {
      const z = e.space?.zoneId;
      if (z === null || z === undefined) continue;
      points.set(z, [...(points.get(z) ?? []), e.labelAt]);
    }
    const zones: ZoneBadge[] = [];
    for (const [zoneId, z] of byZone) {
      const pts = points.get(zoneId);
      if (!pts?.length) continue;
      const at: [number, number] = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
      zones.push({ zoneId, name: z.name, count: z.people.length, at });
    }
    return { bySpace, byZone, zones };
  }, [people, floorCode, entries]);
}

/** 画在房间轮廓上：有人的房间右上角写人数；区域在它的空间中间写「区域名 N 人」（点一下看名单）；选中的区域描边 */
export const PeopleLayer = memo(function PeopleLayer({
  entries,
  bySpace,
  zones,
  highlightZone,
  labelK,
  zoom,
  W,
  H,
}: {
  entries: PeopleEntry[];
  bySpace: Map<number, LocationPerson[]>;
  zones: ZoneBadge[];
  highlightZone: number | null;
  labelK: number;
  zoom: number;
  W: number;
  H: number;
}) {
  const font = Math.max(W, H) / 90 / Math.sqrt(labelK);
  const sw = (w: number) => w / zoom;
  return (
    <g data-testid="floormap-people-layer">
      {highlightZone !== null &&
        entries
          .filter((e) => e.space?.zoneId === highlightZone && e.polygon)
          .map((e) => (
            <polygon
              key={`hz-${e.key}`}
              points={e.polygon!.map((pt) => pt.join(',')).join(' ')}
              fill="#2c6066"
              fillOpacity={0.08}
              stroke="#2c6066"
              strokeWidth={sw(2.5)}
              strokeDasharray={`${sw(6)} ${sw(4)}`}
              vectorEffect="non-scaling-stroke"
              className="pointer-events-none"
            />
          ))}
      {entries.map((e) => {
        const n = e.space ? (bySpace.get(e.space.id)?.length ?? 0) : 0;
        if (!n) return null;
        const xs = e.polygon ? e.polygon.map((pt) => pt[0]) : [e.labelAt[0] + font * 1.6];
        const ys = e.polygon ? e.polygon.map((pt) => pt[1]) : [e.labelAt[1] - font * 1.6];
        const x = Math.max(...xs) - font * 0.85;
        const y = Math.min(...ys) + font * 0.85;
        return (
          <g key={`p-${e.key}`} className="pointer-events-none" data-testid={`map-people-${e.code}`} data-count={n}>
            <circle cx={x} cy={y} r={font * 0.78} fill="#2c6066" stroke="white" strokeWidth={sw(1.5)} vectorEffect="non-scaling-stroke" />
            <text x={x} y={y} fontSize={font * 0.85} textAnchor="middle" dominantBaseline="central" fill="white" className="font-bold">
              {n}
            </text>
          </g>
        );
      })}
      {zones.map((z) => {
        const text = `${z.name} ${z.count} 人`;
        const w = font * (z.name.length * 0.98 + String(z.count).length * 0.6 + 2.6);
        const h = font * 1.6;
        const on = highlightZone === z.zoneId;
        return (
          <g key={`z-${z.zoneId}`} data-zone={z.zoneId} data-testid={`map-zone-${z.zoneId}`} data-count={z.count} className="cursor-pointer">
            <rect x={z.at[0] - w / 2} y={z.at[1] - h / 2} width={w} height={h} rx={h / 2} fill={on ? '#2c6066' : 'white'} stroke="#2c6066" strokeWidth={sw(1.5)} vectorEffect="non-scaling-stroke" opacity={0.95} />
            <text x={z.at[0]} y={z.at[1]} fontSize={font * 0.9} textAnchor="middle" dominantBaseline="central" fill={on ? 'white' : '#2c6066'} className="pointer-events-none font-bold">
              {text}
            </text>
          </g>
        );
      })}
    </g>
  );
});

/** 侧栏「在场」：在店客人与在岗技师有多少有位置；按楼层、地方列名单，点人定位，看轨迹 */
export function PeoplePanel({
  data,
  floorCode,
  zoneFilter,
  onClearZone,
  onLocate,
  onTrack,
}: {
  data: LocationsCurrent;
  floorCode: string | null;
  zoneFilter: { id: number; name: string } | null;
  onClearZone: () => void;
  onLocate: (p: LocationPerson) => void;
  onTrack: (p: LocationPerson) => void;
}) {
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const guests = data.people.filter((p) => p.kind === 'guest');
  const techs = data.people.filter((p) => p.kind === 'technician');
  const shown = data.people.filter(
    (p) =>
      (!zoneFilter || p.zoneId === zoneFilter.id) &&
      (!query || [p.tagCode, p.techNo, p.techName, p.spaceCode].some((x) => x?.toLowerCase().includes(query))),
  );
  // 当前楼层排在前面，再按楼层、地方
  const groups = useMemo(() => {
    const m = new Map<string, { floor: string; place: string; people: LocationPerson[] }>();
    for (const p of shown) {
      const key = `${p.floorCode}|${p.zoneId ?? ''}|${p.spaceId ?? ''}`;
      const g = m.get(key) ?? { floor: p.floorCode, place: placeText({ ...p, floorName: '' }), people: [] };
      g.people.push(p);
      m.set(key, g);
    }
    return [...m.values()].sort((a, b) => Number(b.floor === floorCode) - Number(a.floor === floorCode) || a.floor.localeCompare(b.floor) || a.place.localeCompare(b.place));
  }, [shown, floorCode]);

  return (
    <section className="space-y-2.5 rounded-lg border border-line bg-card p-4" data-testid="floormap-people">
      <div>
        <h3 className="flex items-center gap-1.5 text-[15px] font-bold">
          <MapPin className="size-4 text-lake" /> 在场
        </h3>
        <p className="mt-0.5 text-[12.5px] text-ink-3" data-testid="floormap-people-summary">
          在店客人 {data.guestsInStore}（有位置 {guests.length}
          {data.guestsInStore > guests.length ? ` · 位置不明 ${data.guestsInStore - guests.length}` : ''}） · 在岗技师 {data.techniciansOnDuty}（有位置 {techs.length}）
        </p>
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-ink-4" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && shown[0]) onLocate(shown[0]);
          }}
          placeholder="找手牌号、技师工号或姓名"
          className="h-9 pl-8 text-[13px]"
          aria-label="找人"
          data-testid="floormap-people-search"
        />
      </div>
      {zoneFilter && (
        <p className="flex items-center gap-1.5 text-[12.5px]">
          <Badge tone="lake">只看 {zoneFilter.name}</Badge>
          <button type="button" onClick={onClearZone} className="flex items-center gap-0.5 text-ink-3 hover:text-ink" data-testid="floormap-people-clear-zone">
            <X className="size-3.5" /> 全部
          </button>
        </p>
      )}
      {groups.length === 0 ? (
        <p className="text-[12.5px] text-ink-3">{data.people.length === 0 ? '现在没有推出位置的人。发手牌、挂账、开房、上钟、刷卡之后，这里列出每个人在哪。' : '没有对得上的人。'}</p>
      ) : (
        <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
          {groups.map((g) => (
            <div key={`${g.floor}-${g.place}`}>
              <p className="text-[12px] font-semibold text-ink-3">
                {g.floor} · {g.place || '未分区域'} <span className="num text-ink-4">{g.people.length}</span>
              </p>
              <ul className="mt-1 space-y-1">
                {g.people.map((p) => (
                  <li key={`${p.kind}-${p.id}`} className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1.5 text-[12.5px]" data-testid={`floormap-person-${p.kind}-${p.kind === 'guest' ? p.tagCode : p.techNo}`}>
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onLocate(p)}>
                      <span className={cn('font-bold', p.kind === 'technician' && 'text-lake')}>{personText(p)}</span>
                      <span className="block text-[11.5px] text-ink-3">
                        {formatTime(p.since)} 起 · {LOCATION_SOURCE_LABELS[p.lastSource]} {formatTime(p.lastAt)}
                      </span>
                    </button>
                    <Button size="sm" variant="ghost" onClick={() => onTrack(p)} data-testid="floormap-person-track">
                      轨迹
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      <p className="text-[11.5px] text-ink-4">位置停在上一次动作（刷卡、发牌、挂账、开房、上下钟），精度到区域与房间。</p>
    </section>
  );
}

/** 一个人的轨迹：进入—离开的段，加原始事件（迟到的刷卡标出来） */
export function TrackDialog({ person, onClose }: { person: LocationPerson | null; onClose: () => void }) {
  const t = useLocationTrack(person ? trackQuery(person) : null);
  if (!person) return null;
  const d = t.data;
  return (
    <Dialog open onClose={onClose} width="max-w-2xl" title={`${personText(person)} 的轨迹`} description={person.kind === 'guest' ? '这次来访的全部位置；位置停在上一次动作。' : '今天（营业日）的位置。'}>
      {t.isPending ? (
        <Skeleton className="h-40" />
      ) : t.error ? (
        <Notice tone="error" title={errorMessage(t.error)} />
      ) : d ? (
        <TrackBody data={d} />
      ) : null}
    </Dialog>
  );
}

function TrackBody({ data: d }: { data: LocationTrackData }) {
  const [raw, setRaw] = useState(false);
  return (
    <div className="space-y-3" data-testid="track-dialog">
      <p className="text-[13px]">
        现在：<b data-testid="track-current">{d.current ? placeText(d.current) : d.subject.kind === 'guest' && !d.subject.inStore ? '已离店' : '位置不明'}</b>
        {d.current && <span className="text-ink-3"> · {formatTime(d.current.since)} 起</span>}
      </p>
      {d.tracks.length === 0 ? (
        <p className="text-[12.5px] text-ink-3">还没有位置记录。</p>
      ) : (
        <ol className="divide-y divide-line rounded-md border border-line text-[12.5px]" data-testid="track-segments">
          {d.tracks.map((s) => (
            <li key={s.id} className="flex flex-wrap items-baseline gap-x-2 px-3 py-1.5">
              <span className="num w-[92px] shrink-0 text-ink-3">
                {formatTime(s.enteredAt)}–{s.leftAt ? formatTime(s.leftAt) : '现在'}
              </span>
              <span className="min-w-0 flex-1 font-semibold">{placeText(s)}</span>
              <span className="text-ink-3">
                {LOCATION_SOURCE_LABELS[s.enterSource]}
                {s.eventCount > 1 ? ` · ${s.eventCount} 次` : ''}
                {s.endSource ? ` → ${LOCATION_SOURCE_LABELS[s.endSource]}` : ''}
              </span>
            </li>
          ))}
        </ol>
      )}
      <button type="button" className="text-[12.5px] font-semibold text-pine hover:underline" onClick={() => setRaw((x) => !x)} data-testid="track-raw-toggle">
        {raw ? '收起原始事件' : `原始事件 ${d.events.length} 条`}
      </button>
      {raw && (
        <ul className="max-h-[260px] space-y-1 overflow-y-auto text-[12px]" data-testid="track-events">
          {d.eventsTruncated && <li className="text-ink-3">事件太多，只列最近的 {d.events.length} 条</li>}
          {d.events.map((e) => (
            <li key={e.id} className={cn('rounded border border-line px-2 py-1', !e.applied && 'border-dashed text-ink-3')}>
              <span className="num">{formatTime(e.at)}</span> · {LOCATION_EVENT_KIND_LABELS[e.kind]} {e.place ? placeText(e.place) : ''} · {LOCATION_SOURCE_LABELS[e.source]}
              {e.readerCode ? `（刷卡点 ${e.readerCode} ${e.readerName ?? ''}）` : ''}
              {e.refText ? ` · ${e.refText}` : ''}
              {e.tagCode ? ` · 手牌 ${e.tagCode}` : ''}
              {e.staffName ? ` · ${e.staffName}` : ''}
              {!e.applied && <Badge className="ml-1">迟到，只记不改</Badge>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
