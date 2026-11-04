// 房态图（飞书需求 RQ-004 第三段，v0.7.16，见 docs/ROOMMAP.md）：「客房」页的「平面图」视图。
// 在用的底图按楼层画，空间台账里的每个空间按业态与状态着色（颜色与图例一一对应，口径见 @shared/floormap）：
// 客房与房态看板同一个口径，点开可开房、查房、续住、换房、收押金、退房、改房态（都用「客房」页原来的对话框）；
// 技师房看钟单（派钟时选的房间），点开看这间房里的钟；派对房等「开单即占用」（v0.7.19）点开可开单、结束使用、撤单；其他业态只显示业态。
// 缩放平移：滚轮、双指、拖动，「适应屏幕」回到整层；底图与轮廓只取一次，状态每 5 秒刷新（只刷颜色，不重画底图）。
// 实时位置（v0.7.17）：「人员」图层在有人的房间写人数、区域写在场人数，侧栏「在场」列名单与轨迹（见 People.tsx）。

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Minus, Plus, Scan, Search, X } from 'lucide-react';
import type { FloorplanFloor } from '@shared/floorplans';
import type { LocationPerson } from '@shared/locations';
import { DASHED_STATES, FLOOR_MAP_LEGEND, FLOOR_MAP_STATES, spaceMatches, spaceStatus, type FloorMapSession, type FloorMapSpace, type FloorMapState, type FloorMapUsage, type SpaceStatus } from '@shared/floormap';
import { durationText, usageEstimate, usageMinutes, type UsageDetail } from '@shared/usages';
import { formatYuan } from '@shared/money';
import { ROOM_BOARD_LABELS, type RoomBoard, type RoomBoardRoom } from '@shared/rooms';
import { areaText, spaceLabel } from '@shared/spaces';
import { api, errorMessage } from '../../lib/api';
import { useCan } from '../../lib/session';
import { cn, formatTime } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Badge, Button, Input, Notice, Segmented, Skeleton } from '../../components/ui';
import { guestOf } from './parts';
import { dayText } from './queries';
import { useActiveFloorplan, useFloorMap, useLocations } from './floormap-api';
import { PeopleLayer, PeoplePanel, personText, TrackDialog, usePeopleOnFloor, type ZoneBadge } from './People';
import type { StayAction } from './StayDialog';

export type MapAction =
  | { kind: 'checkin'; roomId: number }
  | { kind: 'stay'; stayId: number; action?: StayAction | 'move' }
  | { kind: 'housekeep'; room: RoomBoardRoom }
  // 派对房等（v0.7.19）：开单、结束使用、撤单
  | { kind: 'usage_open'; space: FloorMapSpace }
  | { kind: 'usage_close'; space: FloorMapSpace; usage: FloorMapUsage; mode: 'end' | 'cancel' };

interface Entry {
  key: string;
  code: string;
  floorCode: string;
  /** 编码图上的原文 */
  label: string;
  polygon: [number, number][] | null;
  labelAt: [number, number];
  space: FloorMapSpace | null;
  status: SpaceStatus | null;
  state: FloorMapState;
}

const MAX_ZOOM = 12;
const NO_PEOPLE: LocationPerson[] = [];

/** 从顶部「结果待确认」回到派对房等的使用单（v0.7.19）：开单回到那间房，结束、撤单回到那张使用单 */
export interface UsageResume {
  type: 'usage_open' | 'usage_end' | 'usage_cancel';
  spaceId: number | null;
  usageId: number | null;
}

export function FloorMapView({
  board,
  onAction,
  resume = null,
  onResumed,
}: {
  board: RoomBoard;
  onAction: (a: MapAction) => void;
  resume?: UsageResume | null;
  onResumed?: () => void;
}) {
  const fm = useFloorMap();
  const plan = useActiveFloorplan(fm.data ? fm.data.floorplanBatchId : undefined, fm.data?.floorplanRev ?? 0);
  const [floorCode, setFloorCode] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [types, setTypes] = useState<string[]>([]);
  const [vacantOnly, setVacantOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [focus, setFocus] = useState<{ code: string; n: number } | null>(null);
  // 实时位置（v0.7.17）：有「看实时位置」权限、开关开着时才有人员图层
  const can = useCan();
  const canSeePeople = can('location.view');
  const loc = useLocations(canSeePeople);
  const [showPeople, setShowPeople] = useState(true);
  const [zoneFilter, setZoneFilter] = useState<{ id: number; name: string } | null>(null);
  const [trackOf, setTrackOf] = useState<LocationPerson | null>(null);
  const peopleOn = canSeePeople && !!loc.data?.enabled;
  const people = peopleOn && showPeople ? loc.data!.people : NO_PEOPLE;

  const data = fm.data;
  const p = plan.data;

  // 结果待确认的使用单：找到那间房（结束、撤单时那张使用单已不在开着的列表里，就按编号取回）再打开对应的对话框
  useEffect(() => {
    if (!resume || !data) return;
    let cancelled = false;
    const done = () => onResumed?.();
    void (async () => {
      if (resume.type === 'usage_open') {
        const space = data.spaces.find((s) => s.id === resume.spaceId);
        if (space && !cancelled) onAction({ kind: 'usage_open', space });
        done();
        return;
      }
      if (!resume.usageId) return done();
      let usage = data.usages.find((u) => u.id === resume.usageId) ?? null;
      if (!usage) {
        try {
          const d = await api.get<UsageDetail>(`/api/usages/${resume.usageId}`);
          usage = { id: d.id, usageNo: d.usageNo, spaceId: d.spaceId, visitId: d.visitId, tagCode: d.tagCode, guests: d.guests, note: d.note, openedAt: d.openedAt, openedByName: d.openedByName };
        } catch {
          usage = null;
        }
      }
      const space = usage ? data.spaces.find((s) => s.id === usage.spaceId) : undefined;
      if (usage && space && !cancelled) onAction({ kind: 'usage_close', space, usage, mode: resume.type === 'usage_end' ? 'end' : 'cancel' });
      done();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resume, data ? 1 : 0]);
  const spaceByCode = useMemo(() => new Map((data?.spaces ?? []).map((s) => [s.code, s])), [data]);
  const roomBySpace = useMemo(() => new Map(board.rooms.flatMap((r) => (r.spaceId ? [[r.spaceId, r] as const] : []))), [board]);
  const statusOf = useCallback((s: FloorMapSpace) => spaceStatus(s, roomBySpace.get(s.id), data?.sessions ?? [], data?.usages ?? [], data?.usageTypes ?? []), [roomBySpace, data]);

  // 图上的每个编码：按编码对上空间台账（停用的也对上，画成灰色）
  const entries = useMemo<Entry[]>(
    () =>
      (p?.rooms ?? []).map((r, i) => {
        const space = spaceByCode.get(r.code) ?? null;
        const status = space ? statusOf(space) : null;
        return { key: `${r.floorCode}-${r.code}-${i}`, code: r.code, floorCode: r.floorCode, label: r.label, polygon: r.polygon, labelAt: r.labelAt, space, status, state: status?.state ?? 'missing' };
      }),
    [p, spaceByCode, statusOf],
  );
  const onDrawing = useMemo(() => new Set(entries.map((e) => e.code)), [entries]);
  // 台账里在用、图上没有的空间：列在图下面，照样能点开
  const offDrawing = useMemo(() => (data?.spaces ?? []).filter((s) => s.active && !onDrawing.has(s.code)), [data, onDrawing]);

  const floors = p?.floors ?? [];
  const busiest = useMemo(() => {
    const count = (code: string) => entries.filter((e) => e.floorCode === code).length;
    return [...floors].sort((a, b) => count(b.code) - count(a.code))[0]?.code ?? null;
  }, [floors, entries]);
  const floor = floors.find((f) => f.code === floorCode) ?? floors.find((f) => f.code === busiest) ?? floors[0] ?? null;
  const here = useMemo(() => (floor ? entries.filter((e) => e.floorCode === floor.code) : []), [entries, floor]);
  const onFloor = usePeopleOnFloor(people, floor?.code ?? null, here);
  const peopleBySpace = useMemo(() => {
    const m = new Map<number, LocationPerson[]>();
    for (const x of people) if (x.spaceId !== null) m.set(x.spaceId, [...(m.get(x.spaceId) ?? []), x]);
    return m;
  }, [people]);
  const typeOptions = useMemo(() => [...new Set(here.flatMap((e) => (e.space ? [e.space.businessType] : [])))].sort(), [here]);

  const q = query.trim();
  const matchOf = useCallback((e: { code: string; label?: string; space: FloorMapSpace | null }) => (e.space ? spaceMatches(e.space, q) : spaceMatches({ code: e.code, displayName: e.label ?? '', aliases: [] }, q)), [q]);
  const dim = useMemo(() => {
    const set = new Set<string>();
    for (const e of here) {
      if (types.length && (!e.space || !types.includes(e.space.businessType))) set.add(e.key);
      else if (vacantOnly && e.state !== 'vacant') set.add(e.key);
      else if (q && !matchOf(e)) set.add(e.key);
    }
    return set;
  }, [here, types, vacantOnly, q, matchOf]);

  const counts = useMemo(() => {
    const c = Object.fromEntries(FLOOR_MAP_STATES.map((k) => [k, 0])) as Record<FloorMapState, number>;
    for (const e of here) c[e.state] += 1;
    return c;
  }, [here]);

  const locate = (code: string) => {
    const target = entries.find((e) => e.code === code);
    if (target && target.floorCode !== floor?.code) setFloorCode(target.floorCode);
    setSelected(code);
    setFocus((f) => ({ code, n: (f?.n ?? 0) + 1 }));
  };
  /** 点名单里的人：在图上的房间就定位到那一间；只到区域的换到那一层、描出那个区域 */
  const locatePerson = (x: LocationPerson) => {
    if (x.spaceCode && entries.some((e) => e.code === x.spaceCode)) {
      setZoneFilter(null);
      locate(x.spaceCode);
      return;
    }
    if (x.floorCode !== floor?.code && floors.some((f) => f.code === x.floorCode)) setFloorCode(x.floorCode);
    if (x.zoneId !== null) setZoneFilter({ id: x.zoneId, name: x.zoneName ?? '' });
  };
  const pickZone = (zoneId: number) => {
    const z = onFloor.zones.find((b) => b.zoneId === zoneId);
    setZoneFilter((cur) => (cur?.id === zoneId ? null : { id: zoneId, name: z?.name ?? '' }));
  };
  const searchGo = () => {
    if (!q) return;
    const hit = entries.find((e) => e.floorCode === floor?.code && matchOf(e)) ?? entries.find((e) => matchOf(e));
    if (hit) locate(hit.code);
    else {
      const off = offDrawing.find((s) => spaceMatches(s, q));
      if (off) setSelected(off.code);
    }
  };

  if (fm.isPending || (data && plan.isPending)) return <Skeleton className="h-[480px]" />;
  if (fm.error) return <Notice tone="error" title={errorMessage(fm.error)} />;
  if (plan.error) return <Notice tone="error" title={errorMessage(plan.error)} />;
  if (!p || p.batchId === null || !floor) {
    return (
      <div data-testid="floormap-empty">
        <Notice tone="info" title="还没有启用的底图">
          店主或店总在「后台 → 空间台账 → 底图」上传编码图、核对后启用，这里就按楼层显示房态图。房态看板照常可用。
        </Notice>
      </div>
    );
  }

  const selectedEntry = selected ? (here.find((e) => e.code === selected) ?? entries.find((e) => e.code === selected) ?? null) : null;
  const selectedSpace = selected ? (spaceByCode.get(selected) ?? null) : null;
  const searchHits = q ? entries.filter((e) => matchOf(e)).length + offDrawing.filter((s) => spaceMatches(s, q)).length : 0;

  return (
    <div className="space-y-3" data-testid="floormap">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<string>
          size="sm"
          value={floor.code}
          onChange={(v) => {
            setFloorCode(v);
            setFocus(null);
            setSelected(null);
          }}
          ariaLabel="楼层"
          options={floors.map((f) => ({ value: f.code, label: f.title ? `${f.code} ${f.title}` : f.code }))}
        />
        <form
          className="relative min-w-[180px] flex-1 sm:max-w-[260px]"
          onSubmit={(e) => {
            e.preventDefault();
            searchGo();
          }}
        >
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-ink-4" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜编码、显示名、品牌名" className="h-9 pl-8 text-[13px]" aria-label="搜索房间" data-testid="floormap-search" />
          {q && <span className="absolute top-1/2 right-2.5 -translate-y-1/2 text-[11.5px] text-ink-3">{searchHits ? `${searchHits} 个，回车定位` : '没找到'}</span>}
        </form>
        <label className="flex h-9 items-center gap-1.5 rounded-md px-1 text-[13px] font-semibold text-ink-2">
          <input type="checkbox" className="size-4 accent-[var(--color-pine)]" checked={vacantOnly} onChange={(e) => setVacantOnly(e.target.checked)} data-testid="floormap-vacant-only" />
          只看空闲
        </label>
        {peopleOn && (
          <label className="flex h-9 items-center gap-1.5 rounded-md px-1 text-[13px] font-semibold text-ink-2">
            <input type="checkbox" className="size-4 accent-[var(--color-pine)]" checked={showPeople} onChange={(e) => setShowPeople(e.target.checked)} data-testid="floormap-show-people" />
            人员
          </label>
        )}
      </div>
      {typeOptions.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="floormap-types">
          <span className="mr-1 text-[12.5px] text-ink-3">业态</span>
          {typeOptions.map((t) => {
            const on = types.includes(t);
            return (
              <button
                key={t}
                type="button"
                aria-pressed={on}
                onClick={() => setTypes((xs) => (on ? xs.filter((x) => x !== t) : [...xs, t]))}
                className={cn('h-8 rounded-full border px-3 text-[12.5px] font-semibold', on ? 'border-pine bg-pine-tint text-pine' : 'border-line-strong text-ink-2 hover:border-ink-4')}
                data-testid={`floormap-type-${t}`}
              >
                {t}
              </button>
            );
          })}
          {types.length > 0 && (
            <button type="button" className="h-8 px-2 text-[12.5px] text-ink-3 hover:text-ink" onClick={() => setTypes([])}>
              全部
            </button>
          )}
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-2">
          <PlanCanvas
            floor={floor}
            entries={here}
            selected={selected}
            dim={dim}
            focus={focus}
            onPick={(code) => setSelected(code)}
            people={people.length ? { bySpace: onFloor.bySpace, zones: onFloor.zones, highlightZone: zoneFilter?.id ?? null } : null}
            onPickZone={pickZone}
          />
          <Legend counts={counts} />
          {offDrawing.length > 0 && (
            <details className="rounded-lg border border-line bg-card px-3 py-2 text-[13px]" data-testid="floormap-off-drawing">
              <summary className="cursor-pointer font-semibold text-ink-2">台账里有、图上没有的空间 {offDrawing.length} 个（按编码点开）</summary>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {offDrawing.map((s) => {
                  const st = statusOf(s);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setSelected(s.code)}
                      className="flex h-8 items-center gap-1.5 rounded-full border border-line-strong px-2.5 text-[12.5px] font-semibold hover:border-ink-4"
                      data-testid={`floormap-off-${s.code}`}
                      data-state={st.state}
                    >
                      <Swatch state={st.state} />
                      {s.floorCode} {s.code}
                    </button>
                  );
                })}
              </div>
            </details>
          )}
        </div>
        <div className="min-w-0 space-y-3">
          <SpacePanel
            entry={selectedEntry}
            space={selectedSpace}
            status={selectedSpace ? statusOf(selectedSpace) : null}
            serverTime={data!.serverTime}
            fetchedAt={fm.dataUpdatedAt}
            people={selectedSpace ? (peopleBySpace.get(selectedSpace.id) ?? NO_PEOPLE) : NO_PEOPLE}
            onTrack={setTrackOf}
            onAction={onAction}
            onClose={() => setSelected(null)}
          />
          {peopleOn && showPeople && loc.data && (
            <PeoplePanel data={loc.data} floorCode={floor.code} zoneFilter={zoneFilter} onClearZone={() => setZoneFilter(null)} onLocate={locatePerson} onTrack={setTrackOf} />
          )}
        </div>
      </div>
      <TrackDialog person={trackOf} onClose={() => setTrackOf(null)} />
    </div>
  );
}

// ───────────────────────── 画布：底图 + 轮廓 + 编码，缩放平移 ─────────────────────────

interface View {
  k: number;
  x: number;
  y: number;
}

function PlanCanvas({
  floor,
  entries,
  selected,
  dim,
  focus,
  onPick,
  people,
  onPickZone,
}: {
  floor: FloorplanFloor;
  entries: Entry[];
  selected: string | null;
  dim: Set<string>;
  focus: { code: string; n: number } | null;
  onPick: (code: string) => void;
  /** 人员图层（v0.7.17）：有人的房间、区域人数；没有时不画 */
  people: { bySpace: Map<number, LocationPerson[]>; zones: ZoneBadge[]; highlightZone: number | null } | null;
  onPickZone: (zoneId: number) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const view = useRef<View>({ k: 1, x: 0, y: 0 });
  // 已经按它重画了文字的倍数（手势停下来才更新）
  const [k, setK] = useState(1);
  const settle = useRef<number | null>(null);
  const W = floor.width;
  const H = floor.height;

  /** 画布大小与底图在画布里的位置（viewBox 按 meet 居中）：s 为每个底图单位多少像素 */
  const metrics = useCallback(() => {
    const r = boxRef.current!.getBoundingClientRect();
    const s = Math.min(r.width / W, r.height / H) || 1;
    return { r, s, ox: (r.width - W * s) / 2, oy: (r.height - H * s) / 2 };
  }, [W, H]);

  /** 把视图画上去：整个 SVG 用 CSS 变换缩放平移（以左上角为原点），视图按底图单位记 */
  const paint = useCallback(() => {
    const svg = svgRef.current;
    if (!svg || !boxRef.current) return;
    const v = view.current;
    const { s, ox, oy } = metrics();
    svg.style.transform = `translate(${s * v.x + ox * (1 - v.k)}px, ${s * v.y + oy * (1 - v.k)}px) scale(${v.k})`;
    svg.dataset.view = `${v.k.toFixed(3)} ${v.x.toFixed(0)} ${v.y.toFixed(0)}`;
  }, [metrics]);

  /** 停下来：去掉合成层，按最后的倍数清晰重画，字号跟上 */
  const settleNow = useCallback(() => {
    if (settle.current !== null) window.clearTimeout(settle.current);
    settle.current = null;
    if (svgRef.current) svgRef.current.style.willChange = '';
    setK(view.current.k);
  }, []);

  /**
   * 手势进行中（滚轮、拖动、双指）：整张图作为合成层缩放平移，不重画房间与文字（300 个房号每帧重画在没有显卡加速的机器上很慢）；
   * 停 150 毫秒后按最后的倍数清晰重画
   */
  const moving = useCallback(() => {
    const svg = svgRef.current;
    if (!svg) return;
    svg.style.willChange = 'transform';
    paint();
    if (settle.current !== null) window.clearTimeout(settle.current);
    settle.current = window.setTimeout(settleNow, 150);
  }, [paint, settleNow]);

  /** 按钮、搜索定位、换楼层：直接画到位 */
  const jump = useCallback(() => {
    paint();
    settleNow();
  }, [paint, settleNow]);
  useEffect(
    () => () => {
      if (settle.current !== null) window.clearTimeout(settle.current);
    },
    [],
  );
  // 画布大小变了（转屏、拉窗口）重算位置
  useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => paint());
    ro.observe(box);
    return () => ro.disconnect();
  }, [paint]);

  /** 平移不超出太多：整层至少留一半在视野里 */
  const clampPan = useCallback(() => {
    const v = view.current;
    const minX = W - W * v.k - W / 2;
    const minY = H - H * v.k - H / 2;
    v.x = Math.min(W / 2, Math.max(minX, v.x));
    v.y = Math.min(H / 2, Math.max(minY, v.y));
  }, [W, H]);

  const reset = useCallback(() => {
    view.current = { k: 1, x: 0, y: 0 };
    jump();
  }, [jump]);
  // 换了楼层或换了一批底图（店主启用了新的一批）回到整层
  useEffect(() => reset(), [floor.svgUrl, reset]);

  /** 屏幕坐标 → 底图坐标（viewBox，缩放平移之前；按画布算，不受 CSS 变换影响） */
  const toLocal = useCallback(
    (clientX: number, clientY: number) => {
      const { r, s, ox, oy } = metrics();
      return { x: (clientX - r.left - ox) / s, y: (clientY - r.top - oy) / s };
    },
    [metrics],
  );

  /** 以 (px, py) 为中心缩放；live 为手势进行中 */
  const zoomAt = useCallback(
    (px: number, py: number, factor: number, live = false) => {
      const v = view.current;
      const k2 = Math.min(MAX_ZOOM, Math.max(1, v.k * factor));
      const f = k2 / v.k;
      v.x = px - (px - v.x) * f;
      v.y = py - (py - v.y) * f;
      v.k = k2;
      clampPan();
      if (live) moving();
      else jump();
    },
    [clampPan, jump, moving],
  );

  // 滚轮缩放（以鼠标位置为中心）：监听整个画布（平移后露出的空白处也能缩放），要阻止页面滚动，用非被动的监听
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = toLocal(e.clientX, e.clientY);
      zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)), true);
    };
    box.addEventListener('wheel', onWheel, { passive: false });
    return () => box.removeEventListener('wheel', onWheel);
  }, [toLocal, zoomAt]);

  // 拖动平移、双指缩放；移动超过 6 像素就不算点击
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ moved: boolean; downX: number; downY: number; last: { x: number; y: number; d: number } | null }>({ moved: false, downX: 0, downY: 0, last: null });
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) gesture.current = { moved: false, downX: e.clientX, downY: e.clientY, last: null };
    gesture.current.last = null;
  };
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!pointers.current.has(e.pointerId)) return;
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const g = gesture.current;
      if (!g.moved && pointers.current.size < 2) {
        if (Math.hypot(e.clientX - g.downX, e.clientY - g.downY) <= 6) return;
        // 刚超过 6 像素：从按下的位置算起，整段拖动都平移
        g.last = { ...toLocal(g.downX, g.downY), d: 0 };
      }
      const pts = [...pointers.current.values()];
      const mid = pts.length >= 2 ? { x: (pts[0]!.x + pts[1]!.x) / 2, y: (pts[0]!.y + pts[1]!.y) / 2 } : pts[0]!;
      const local = toLocal(mid.x, mid.y);
      const d = pts.length >= 2 ? Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y) : 0;
      if (g.last) {
        const v = view.current;
        v.x += local.x - g.last.x;
        v.y += local.y - g.last.y;
        if (pts.length >= 2 && g.last.d > 0 && d > 0) zoomAt(local.x, local.y, d / g.last.d, true);
        else {
          clampPan();
          moving();
        }
      }
      g.moved = true;
      g.last = { x: local.x, y: local.y, d };
    };
    const up = (e: PointerEvent) => {
      if (!pointers.current.delete(e.pointerId)) return;
      gesture.current.last = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [clampPan, moving, toLocal, zoomAt]);

  const onClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (gesture.current.moved) return;
    const zone = (e.target as Element).closest('[data-zone]');
    if (zone) return onPickZone(Number(zone.getAttribute('data-zone')));
    const el = (e.target as Element).closest('[data-code]');
    if (el) onPick(el.getAttribute('data-code')!);
  };

  // 搜索定位：放大到至少 3 倍，把那一间移到中间
  useEffect(() => {
    if (!focus) return;
    const e = entries.find((x) => x.code === focus.code);
    if (!e) return;
    const xs = e.polygon ? e.polygon.map((pt) => pt[0]) : [e.labelAt[0]];
    const ys = e.polygon ? e.polygon.map((pt) => pt[1]) : [e.labelAt[1]];
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const v = view.current;
    v.k = Math.max(v.k, 3);
    v.x = W / 2 - cx * v.k;
    v.y = H / 2 - cy * v.k;
    clampPan();
    jump();
    // entries 每 5 秒刷新一次，只在定位请求变化时移动
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  // 字号随缩放慢慢变小（按 1/√k），放大 2 倍以上写显示名
  const labelK = 2 ** (Math.round(Math.log2(k) * 4) / 4);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3" data-testid="floormap-zoom" data-zoom={k.toFixed(2)}>
          {k > 1.01 ? `放大 ${k.toFixed(1)} 倍 · ` : ''}滚轮或双指缩放，拖动平移
        </span>
        <Button size="sm" variant="ghost" icon={<Minus className="size-4" />} aria-label="缩小" disabled={k <= 1.001} onClick={() => zoomAt(W / 2, H / 2, 1 / 1.5)} data-testid="floormap-zoom-out" />
        <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} aria-label="放大" disabled={k >= MAX_ZOOM - 0.001} onClick={() => zoomAt(W / 2, H / 2, 1.5)} data-testid="floormap-zoom-in" />
        <Button size="sm" variant="ghost" icon={<Scan className="size-4" />} onClick={reset} data-testid="floormap-fit">
          适应屏幕
        </Button>
      </div>
      {/* 画布按楼层的长宽比定高度（不超过一屏），竖屏、手机上不留大片空白 */}
      <div
        ref={boxRef}
        className="relative min-h-[260px] w-full cursor-grab touch-none overflow-hidden rounded-lg border border-line bg-white select-none active:cursor-grabbing"
        style={{ aspectRatio: `${W} / ${H}`, maxHeight: 'max(260px, calc(100dvh - 330px))' }}
        onPointerDown={onPointerDown}
        data-testid="floormap-canvas"
      >
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="xMidYMid meet"
          className="block h-full w-full origin-top-left"
          role="img"
          aria-label={`${floor.code} 房态图`}
          onClick={onClick}
          data-testid="floormap-view"
        >
          <image href={floor.svgUrl} x={0} y={0} width={W} height={H} />
          <RoomsLayer entries={entries} selected={selected} dim={dim} labelK={labelK} zoom={k} W={W} H={H} flash={focus?.code ?? null} flashN={focus?.n ?? 0} />
          {people && <PeopleLayer entries={entries} bySpace={people.bySpace} zones={people.zones} highlightZone={people.highlightZone} labelK={labelK} zoom={k} W={W} H={H} />}
        </svg>
      </div>
    </div>
  );
}

const RoomsLayer = memo(function RoomsLayer({
  entries,
  selected,
  dim,
  labelK,
  zoom,
  W,
  H,
  flash,
  flashN,
}: {
  entries: Entry[];
  selected: string | null;
  dim: Set<string>;
  labelK: number;
  /** 整张图的 CSS 缩放倍数：轮廓线宽、虚线按它除回去，放大后线不变粗 */
  zoom: number;
  W: number;
  H: number;
  flash: string | null;
  flashN: number;
}) {
  const font = Math.max(W, H) / 90 / Math.sqrt(labelK);
  const showNames = labelK >= 2;
  // 线宽：non-scaling-stroke 抵消 viewBox 的缩放，整张图的 CSS 缩放再除回去
  const sw = (w: number) => w / zoom;
  const dash = (a: number, b: number) => `${sw(a)} ${sw(b)}`;
  return (
    <>
      {entries.map((e) => {
        const c = FLOOR_MAP_LEGEND[e.state];
        const dashed = DASHED_STATES.includes(e.state);
        const isSel = selected === e.code;
        return (
          <g key={e.key} data-code={e.code} data-testid={`map-space-${e.code}`} data-state={e.state} data-dim={dim.has(e.key) ? 'true' : 'false'} className="cursor-pointer" opacity={dim.has(e.key) ? 0.22 : 1}>
            {e.polygon ? (
              <polygon
                points={e.polygon.map((pt) => pt.join(',')).join(' ')}
                fill={c.fill}
                fillOpacity={0.78}
                stroke={isSel ? '#a87508' : c.stroke}
                strokeWidth={sw(isSel ? 3.5 : 1.5)}
                strokeDasharray={dashed ? dash(6, 4) : undefined}
                vectorEffect="non-scaling-stroke"
              />
            ) : (
              <circle cx={e.labelAt[0]} cy={e.labelAt[1]} r={font * 1.1} fill={c.fill} stroke={isSel ? '#a87508' : c.stroke} strokeWidth={sw(isSel ? 3.5 : 1.5)} strokeDasharray={dashed ? dash(4, 3) : undefined} vectorEffect="non-scaling-stroke" />
            )}
            <text
              x={e.labelAt[0]}
              y={e.labelAt[1] - (showNames && e.space ? font * 0.45 : 0)}
              fontSize={font}
              textAnchor="middle"
              dominantBaseline="central"
              className="pointer-events-none font-semibold"
              fill={e.state === 'missing' ? '#808780' : '#1c231f'}
              style={{ paintOrder: 'stroke', stroke: 'white', strokeWidth: font / 5 }}
            >
              {e.code}
              {e.status?.occupancy && (
                <tspan fill="#2c6066" fontSize={font * 0.85}>
                  {` ${e.status.occupancy}`}
                </tspan>
              )}
            </text>
            {showNames && e.space && (
              <text
                x={e.labelAt[0]}
                y={e.labelAt[1] + font * 0.75}
                fontSize={font * 0.62}
                textAnchor="middle"
                dominantBaseline="central"
                className="pointer-events-none"
                fill="#4a524c"
                style={{ paintOrder: 'stroke', stroke: 'white', strokeWidth: font / 7 }}
              >
                {e.space.displayName}
              </text>
            )}
          </g>
        );
      })}
      {flash &&
        entries
          .filter((e) => e.code === flash)
          .map((e) =>
            e.polygon ? (
              <polygon key={`flash-${e.key}-${flashN}`} points={e.polygon.map((pt) => pt.join(',')).join(' ')} fill="none" stroke="#f2c230" strokeWidth={sw(6)} vectorEffect="non-scaling-stroke" className="pointer-events-none animate-flash" />
            ) : (
              <circle key={`flash-${e.key}-${flashN}`} cx={e.labelAt[0]} cy={e.labelAt[1]} r={font * 1.6} fill="none" stroke="#f2c230" strokeWidth={sw(6)} vectorEffect="non-scaling-stroke" className="pointer-events-none animate-flash" />
            ),
          )}
    </>
  );
});

function Swatch({ state, className }: { state: FloorMapState; className?: string }) {
  const c = FLOOR_MAP_LEGEND[state];
  return <span className={cn('inline-block size-3.5 shrink-0 rounded-[4px] border', DASHED_STATES.includes(state) && 'border-dashed', className)} style={{ background: c.fill, borderColor: c.stroke }} aria-hidden />;
}

function Legend({ counts }: { counts: Record<FloorMapState, number> }) {
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1.5 text-[12.5px] text-ink-2" data-testid="floormap-legend" aria-label="图例">
      {FLOOR_MAP_STATES.map((s) => (
        <li key={s} className="flex items-center gap-1.5" title={FLOOR_MAP_LEGEND[s].hint} data-testid={`floormap-legend-${s}`}>
          <Swatch state={s} />
          {FLOOR_MAP_LEGEND[s].label}
          <span className="num text-ink-4">{counts[s]}</span>
        </li>
      ))}
    </ul>
  );
}

// ───────────────────────── 侧栏：点开的房间 ─────────────────────────

function SpacePanel({
  entry,
  space,
  status,
  serverTime,
  fetchedAt,
  people,
  onTrack,
  onAction,
  onClose,
}: {
  entry: Entry | null;
  space: FloorMapSpace | null;
  status: SpaceStatus | null;
  serverTime: string;
  fetchedAt: number;
  /** 现在在这间的客人与技师（实时位置，v0.7.17） */
  people: LocationPerson[];
  onTrack: (p: LocationPerson) => void;
  onAction: (a: MapAction) => void;
  onClose: () => void;
}) {
  const can = useCan();
  const ref = useRef<HTMLElement>(null);
  const code = space?.code ?? entry?.code ?? null;
  // 窄屏（侧栏在图下面）：点了房间把侧栏露出来
  useEffect(() => {
    if (code && ref.current && window.matchMedia('(max-width: 1023px)').matches) ref.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [code]);
  if (!entry && !space) {
    return (
      <aside className="hidden rounded-lg border border-dashed border-line-strong px-4 py-6 text-center text-[13px] text-ink-3 lg:block" data-testid="floormap-panel-empty">
        点图上的房间看状态、开房、查房、退房
      </aside>
    );
  }
  const state: FloorMapState = status?.state ?? 'missing';
  const now = Date.now() + (new Date(serverTime).getTime() - fetchedAt);
  return (
    <aside ref={ref} className="space-y-3 rounded-lg border border-line bg-card p-4" data-testid="floormap-panel" data-code={code!} data-state={state}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-[17px] leading-tight font-bold">{space ? spaceLabel(space.code, space.displayName) : code}</h3>
          <p className="mt-0.5 text-[12.5px] text-ink-3">
            {space ? [space.businessType, `${space.floorCode}${space.zoneName ? ` · ${space.zoneName}` : ''}`, space.capacity ? `${space.capacity} 人` : '', space.areaCentiM2 ? `${areaText(space.areaCentiM2)} ㎡` : ''].filter(Boolean).join(' · ') : `图上原文：${entry!.label}`}
          </p>
        </div>
        <button type="button" onClick={onClose} className="rounded p-1 text-ink-3 hover:bg-paper-2 hover:text-ink" aria-label="关闭">
          <X className="size-4" />
        </button>
      </div>
      <p className="flex items-center gap-1.5 text-[13.5px] font-bold" data-testid="floormap-panel-state">
        <Swatch state={state} />
        {FLOOR_MAP_LEGEND[state].label}
        {status?.occupancy && <span className="num font-semibold text-lake">{status.occupancy}</span>}
      </p>
      {people.length > 0 && (
        <div data-testid="floormap-panel-people">
          <p className="text-[12.5px] font-semibold text-ink-3">在这里 {people.length} 人（实时位置）</p>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {people.map((x) => (
              <li key={`${x.kind}-${x.id}`}>
                <button type="button" onClick={() => onTrack(x)} className="h-7 rounded-full border border-line-strong px-2.5 text-[12px] font-semibold hover:border-lake" title="看轨迹">
                  {personText(x)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!space ? (
        <Notice tone="warning" title="空间台账里没有这个编码">
          店主或店总在「后台 → 空间台账」补上（以台账为准，不按图纸改台账），这里就显示状态。
        </Notice>
      ) : status?.kind === 'room' ? (
        <RoomPart space={space} status={status} canOperate={can('room.operate')} canHousekeep={can('room.housekeep')} onAction={onAction} />
      ) : status?.kind === 'technician' ? (
        <SessionsPart sessions={status.sessions} now={now} canDispatch={can('technician.dispatch')} />
      ) : status?.kind === 'usage' || status?.usage ? (
        <UsagePart space={space} status={status} now={now} canOperate={can('room.operate')} canPost={can('frontdesk.operate')} onAction={onAction} />
      ) : (
        <p className="text-[13px] text-ink-3">{state === 'off' ? '空间台账里停用或不可售。' : `「${space.businessType}」目前没有对应的业务单据，房态图只显示业态。`}</p>
      )}
      {space && space.aliases.length > 0 && <p className="text-[12px] text-ink-4">别名：{space.aliases.join('、')}</p>}
    </aside>
  );
}

function RoomPart({ space, status, canOperate, canHousekeep, onAction }: { space: FloorMapSpace; status: SpaceStatus; canOperate: boolean; canHousekeep: boolean; onAction: (a: MapAction) => void }) {
  const r = status.room;
  if (!r) {
    return status.state === 'unlinked' ? (
      <Notice tone="info" title="还没挂客房房间">
        「客房」空间要在「后台 → 客房 → 房间」里挂接房间后才能开房（房号就是编码 {space.code}）。
      </Notice>
    ) : (
      <p className="text-[13px] text-ink-3">{space.roomId ? '挂接的客房房间已停用。' : '空间台账里停用或不可售。'}</p>
    );
  }
  const s = r.stay;
  const buttons: ReactNode[] = [];
  if (s && canOperate) {
    buttons.push(
      <Button key="view" size="sm" variant="primary" onClick={() => onAction({ kind: 'stay', stayId: s.id })} data-testid="floormap-stay">
        查房
      </Button>,
      <Button key="extend" size="sm" variant="secondary" onClick={() => onAction({ kind: 'stay', stayId: s.id, action: 'extend' })} data-testid="floormap-extend">
        续住
      </Button>,
      <Button key="move" size="sm" variant="secondary" onClick={() => onAction({ kind: 'stay', stayId: s.id, action: 'move' })} data-testid="floormap-move">
        换房
      </Button>,
      <Button key="deposit" size="sm" variant="secondary" onClick={() => onAction({ kind: 'stay', stayId: s.id, action: 'deposit' })} data-testid="floormap-deposit">
        押金
      </Button>,
      <Button key="close" size="sm" variant="secondary" onClick={() => onAction({ kind: 'stay', stayId: s.id, action: 'close' })} data-testid="floormap-close">
        退房
      </Button>,
    );
  }
  if (!s && r.status === 'vacant' && canOperate) {
    buttons.push(
      <Button key="checkin" size="sm" variant="primary" onClick={() => onAction({ kind: 'checkin', roomId: r.id })} data-testid="floormap-checkin">
        开房
      </Button>,
    );
  }
  if (!s && canHousekeep) {
    buttons.push(
      <Button key="hk" size="sm" variant={r.status === 'vacant' ? 'ghost' : 'primary'} onClick={() => onAction({ kind: 'housekeep', room: r })} data-testid="floormap-housekeep">
        {r.status === 'vacant' ? '改房态' : r.status === 'dirty' ? '打扫好了' : '维修好了'}
      </Button>,
    );
  }
  return (
    <div className="space-y-2.5">
      <p className="text-[13px] text-ink-2">
        房间 <b className="num">{r.roomNo}</b> · {r.typeName} · {ROOM_BOARD_LABELS[r.status]}
        {r.status === 'maintenance' && r.maintenanceNote ? `：${r.maintenanceNote}` : ''}
      </p>
      {s && (
        <div className="space-y-1 rounded-md bg-yuzu-tint px-3 py-2 text-[13px]" data-testid="floormap-stay-info">
          <p className="font-bold">
            {guestOf(s)} <Badge tone="lake">手牌 {s.tagCode}</Badge>
          </p>
          <p className="text-ink-2">
            {s.kind === 'daily' ? `${dayText(s.businessDate)}入住${s.expectedCheckoutDate ? ` · 预离 ${dayText(s.expectedCheckoutDate)}` : ''}` : `钟点房 · ${formatTime(s.checkedInAt)} 入住`} · {s.guests} 人
          </p>
          <p className="text-ink-2">
            房费 <Money cents={s.chargedAmount} />
            {s.depositBalance > 0 && (
              <>
                {' '}
                · 押金 <Money cents={s.depositBalance} />
              </>
            )}
          </p>
        </div>
      )}
      {buttons.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">{buttons}</div>
      ) : (
        <p className="text-[12.5px] text-ink-3">{s ? '查看入住单要有「客房入住、退房」权限' : '入住要有「客房入住、退房」权限，改房态要有「客房打扫、维修」权限'}</p>
      )}
    </div>
  );
}

/** 派对房等「开单即占用」（v0.7.19）：使用中显示使用单（手牌、开单时刻、已用时长、人数），可结束、撤单、去前台挂账；空闲可开单 */
function UsagePart({
  space,
  status,
  now,
  canOperate,
  canPost,
  onAction,
}: {
  space: FloorMapSpace;
  status: SpaceStatus;
  now: number;
  canOperate: boolean;
  canPost: boolean;
  onAction: (a: MapAction) => void;
}) {
  const u = status.usage;
  if (!u) {
    if (status.state === 'off') return <p className="text-[13px] text-ink-3">空间台账里停用或不可售，不能开单。</p>;
    return canOperate ? (
      <div className="space-y-2">
        <p className="text-[13px] text-ink-3">「{space.businessType}」按开单即占用：开单后显示使用中，结束、使用人结账或撤单后空闲。</p>
        <Button size="sm" variant="primary" onClick={() => onAction({ kind: 'usage_open', space })} data-testid="floormap-usage-open">
          开单
        </Button>
      </div>
    ) : (
      <p className="text-[12.5px] text-ink-3">开单要有「客房入住、退房」权限</p>
    );
  }
  const minutes = usageMinutes({ openedAt: u.openedAt, closedAt: null }, now);
  return (
    <div className="space-y-2.5">
      <div className="space-y-1 rounded-md bg-yuzu-tint px-3 py-2 text-[13px]" data-testid="floormap-usage-info">
        <p className="font-bold">
          使用中 <Badge tone="lake">手牌 {u.tagCode}</Badge>
        </p>
        <p className="text-ink-2">
          {formatTime(u.openedAt)} 开单 · 已用 {durationText(minutes)} · {u.guests} 人
        </p>
        {u.pricing && (
          <p className="font-semibold text-pine" data-testid="floormap-usage-fee">
            到现在房费约 {formatYuan(usageEstimate(minutes, u.pricing))}（结束使用时挂到手牌 {u.tagCode} 的账单）
          </p>
        )}
        <p className="text-[12px] text-ink-3">
          {u.usageNo} · {u.openedByName}
          {u.note ? ` · ${u.note}` : ''}
        </p>
      </div>
      {canOperate ? (
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="primary" onClick={() => onAction({ kind: 'usage_close', space, usage: u, mode: 'end' })} data-testid="floormap-usage-end">
            结束使用
          </Button>
          <Button size="sm" variant="secondary" onClick={() => onAction({ kind: 'usage_close', space, usage: u, mode: 'cancel' })} data-testid="floormap-usage-cancel">
            撤单
          </Button>
          {canPost && (
            <Link to={`/frontdesk?v=${u.visitId}`} className="inline-flex h-8 items-center px-2 text-[13px] font-semibold text-pine hover:underline" data-testid="floormap-usage-post">
              去前台挂账 →
            </Link>
          )}
        </div>
      ) : (
        <p className="text-[12.5px] text-ink-3">结束、撤单要有「客房入住、退房」权限</p>
      )}
    </div>
  );
}

function SessionsPart({ sessions, now, canDispatch }: { sessions: FloorMapSession[]; now: number; canDispatch: boolean }) {
  return (
    <div className="space-y-2">
      {sessions.length === 0 ? (
        <p className="text-[13px] text-ink-3">现在没有钟。钟房派钟时选这间房，这里就显示服务中。</p>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line" data-testid="floormap-sessions">
          {sessions.map((s) => {
            const left = s.plannedEnd ? Math.round((new Date(s.plannedEnd).getTime() - now) / 60_000) : null;
            return (
              <li key={s.id} className="px-3 py-2 text-[13px]" data-testid={`floormap-session-${s.sessionNo}`}>
                <p className="flex items-baseline gap-1.5">
                  <span className="num font-bold">{s.techNo}</span>
                  <span className="font-semibold">{s.techName}</span>
                  <span className="ml-auto text-[12px] font-semibold text-lake">{s.status === 'serving' ? (left === null ? '服务中' : left >= 0 ? `服务中 · 剩 ${left} 分` : `超时 ${-left} 分`) : '待上钟'}</span>
                </p>
                <p className="text-[12.5px] text-ink-3">
                  手牌 <span className="num font-semibold text-ink-2">{s.tagCode}</span> · {s.itemName} × {s.clocks}
                  {s.startedAt ? ` · ${formatTime(s.startedAt)} 上钟` : ` · ${formatTime(s.createdAt)} 派钟`}
                </p>
              </li>
            );
          })}
        </ul>
      )}
      {canDispatch && (
        <Link to="/clockroom" className="inline-block text-[13px] font-semibold text-pine hover:underline" data-testid="floormap-to-clockroom">
          去钟房 →
        </Link>
      )}
    </div>
  );
}
