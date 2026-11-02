// 对客导览（飞书需求 RQ-004 第四段，v0.7.19，见 docs/FLOORPLAN_FINISH.md 第 2 节）：在用的底图按楼层画，同一区域的空间轮廓
// 填同一种颜色（动区暖色、静区冷色、公共浅中性色，后场不显示），写区域的中文名、英文名，画设施图标（卫生间、电梯、楼梯……）。
// 对客只到区域级：不显示房号、房态、人员，没有经营数据。「大屏模式」（/guide/screen）全屏、按设定的秒数自动轮播楼层，适合门店大屏常开。

import { useEffect, useMemo, useState, type ComponentType } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpDown, Cigarette, ConciergeBell, DoorOpen, Footprints, Maximize2, MonitorPlay, Shirt, Toilet, UtensilsCrossed, X } from 'lucide-react';
import { GUIDE_KIND_EN, GUIDE_KIND_LABELS, GUIDE_MARKER_LABELS, type GuideData, type GuideFloor, type GuideMarker, type GuideMarkerKind, type GuideZone } from '@shared/guide';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { Button, Card, Segmented, Skeleton } from '../../components/ui';

export const GUIDE_ICONS: Record<GuideMarkerKind, ComponentType<{ x?: number; y?: number; width?: number; height?: number; color?: string; strokeWidth?: number; className?: string }>> = {
  toilet: Toilet,
  elevator: ArrowUpDown,
  stairs: Footprints,
  reception: ConciergeBell,
  entrance: DoorOpen,
  locker: Shirt,
  dining: UtensilsCrossed,
  smoking: Cigarette,
};
/** 设施图标的底色 */
const MARKER_FILL = '#2f4b5c';

export const useGuide = () => useQuery({ queryKey: ['guide'], queryFn: () => api.get<GuideData>('/api/guide'), refetchInterval: 60_000 });

/** 楼层按编码排（L1、L2、L3……） */
const sortFloors = (floors: GuideFloor[]) => [...floors].sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }));

export function GuidePage() {
  const guide = useGuide();
  const navigate = useNavigate();
  const [floorCode, setFloorCode] = useState<string | null>(null);
  const d = guide.data;
  const floors = useMemo(() => sortFloors(d?.floors ?? []), [d]);
  const floor = floors.find((f) => f.code === floorCode) ?? floors[0] ?? null;
  return (
    <div className="space-y-4" data-testid="guide-page">
      <PageHeader
        title="对客导览"
        subtitle="给客人看的区域导览图：区域色块、中英双语、设施图标；不显示房号、房态与人员。门店大屏打开「大屏模式」按楼层轮播。"
        actions={
          floors.length > 0 ? (
            <Button variant="primary" icon={<MonitorPlay className="size-4" />} onClick={() => navigate('/guide/screen')} data-testid="guide-screen">
              大屏模式
            </Button>
          ) : undefined
        }
      />
      {!d ? (
        <Skeleton className="h-96" />
      ) : !floor ? (
        <EmptyState art="calm" title="还没有在用的底图" description="店主或店总在「后台 → 空间台账 → 底图」上传图纸、启用一批后，这里按楼层显示导览图。" />
      ) : (
        <>
          {floors.length > 1 && (
            <Segmented<string>
              value={floor.code}
              onChange={setFloorCode}
              ariaLabel="楼层"
              options={floors.map((f) => ({ value: f.code, label: f.title ? `${f.code} ${f.title}` : f.code }))}
            />
          )}
          <Card className="overflow-hidden p-3 sm:p-4">
            <div className="aspect-[16/10] w-full bg-white">
              <GuideMap floor={floor} zones={d.zones.filter((z) => z.floorCode === floor.code)} markers={d.markers.filter((m) => m.floorCode === floor.code)} />
            </div>
          </Card>
          <GuideLegend zones={d.zones.filter((z) => z.floorCode === floor.code)} markers={d.markers.filter((m) => m.floorCode === floor.code)} />
        </>
      )}
    </div>
  );
}

/** 一层的导览图：底图（去掉了图上的文字）淡显，区域色块、区域名（中英）、设施图标 */
export function GuideMap({ floor, zones, markers, big = false }: { floor: GuideFloor; zones: GuideZone[]; markers: GuideMarker[]; big?: boolean }) {
  const base = Math.max(floor.width, floor.height) / (big ? 60 : 75);
  return (
    <svg
      viewBox={`0 0 ${floor.width} ${floor.height}`}
      preserveAspectRatio="xMidYMid meet"
      className="block h-full w-full"
      role="img"
      aria-label={`${floor.title || floor.code} 导览图`}
      data-testid={`guide-map-${floor.code}`}
    >
      <image href={floor.svgUrl} x={0} y={0} width={floor.width} height={floor.height} opacity={0.5} />
      {zones.map((z) => (
        <g key={z.id} data-testid={`guide-zone-${z.id}`} data-kind={z.kind} data-color={z.color}>
          {z.polygons.map((p, i) => (
            <polygon key={i} points={p.map((v) => v.join(',')).join(' ')} fill={z.color} fillOpacity={0.92} stroke="#ffffff" strokeWidth={base * 0.12} strokeLinejoin="round" />
          ))}
        </g>
      ))}
      {zones.map((z) => {
        // 字号随区域大小，限制在一个范围里
        const size = Math.min(base * 1.7, Math.max(base * 0.9, Math.sqrt(z.area) / 7));
        return (
          <g key={`${z.id}-label`} className="pointer-events-none" data-testid={`guide-zone-label-${z.id}`}>
            <text
              x={z.labelAt[0]}
              y={z.labelAt[1] - (z.nameEn ? size * 0.35 : 0)}
              fontSize={size}
              fontWeight={700}
              textAnchor="middle"
              dominantBaseline="central"
              fill="#22313a"
              style={{ paintOrder: 'stroke', stroke: 'rgba(255,255,255,0.85)', strokeWidth: size / 5 }}
            >
              {z.name}
            </text>
            {z.nameEn && (
              <text
                x={z.labelAt[0]}
                y={z.labelAt[1] + size * 0.75}
                fontSize={size * 0.55}
                textAnchor="middle"
                dominantBaseline="central"
                fill="#3c4f5a"
                style={{ paintOrder: 'stroke', stroke: 'rgba(255,255,255,0.85)', strokeWidth: size / 8, letterSpacing: '0.02em' }}
              >
                {z.nameEn}
              </text>
            )}
          </g>
        );
      })}
      {markers.map((m) => {
        const Icon = GUIDE_ICONS[m.kind];
        const r = base * (big ? 0.95 : 0.8);
        return (
          <g key={m.id} data-testid={`guide-marker-${m.kind}`} className="pointer-events-none">
            <circle cx={m.x} cy={m.y} r={r} fill={MARKER_FILL} stroke="#ffffff" strokeWidth={r * 0.14} />
            <Icon x={m.x - r * 0.6} y={m.y - r * 0.6} width={r * 1.2} height={r * 1.2} color="#ffffff" strokeWidth={2.2} />
          </g>
        );
      })}
    </svg>
  );
}

export function GuideLegend({ zones, markers, big = false }: { zones: GuideZone[]; markers: GuideMarker[]; big?: boolean }) {
  const kinds = [...new Set(markers.map((m) => m.kind))];
  return (
    <div className={cn('flex flex-wrap items-center gap-x-5 gap-y-2', big ? 'text-[18px]' : 'text-[13px]')} data-testid="guide-legend">
      {zones.map((z) => (
        <span key={z.id} className="flex items-center gap-2">
          <span className={cn('inline-block rounded-sm ring-1 ring-black/10', big ? 'size-5' : 'size-3.5')} style={{ background: z.color }} />
          <span className="font-semibold">{z.name}</span>
          {z.nameEn && <span className="text-ink-3">{z.nameEn}</span>}
          <span className={cn('text-ink-4', big ? 'text-[14px]' : 'text-[11.5px]')}>
            {GUIDE_KIND_LABELS[z.kind]} {GUIDE_KIND_EN[z.kind]}
          </span>
        </span>
      ))}
      {kinds.map((k) => {
        const Icon = GUIDE_ICONS[k];
        return (
          <span key={k} className="flex items-center gap-1.5">
            <span className={cn('flex items-center justify-center rounded-full', big ? 'size-7' : 'size-5')} style={{ background: MARKER_FILL }}>
              <Icon className={big ? 'size-4' : 'size-3'} color="#ffffff" />
            </span>
            {GUIDE_MARKER_LABELS[k].zh} <span className="text-ink-3">{GUIDE_MARKER_LABELS[k].en}</span>
          </span>
        );
      })}
    </div>
  );
}

/** 大屏模式：全屏、隐藏导航与操作，按设定的秒数自动轮播楼层；Esc 退出，← → 手动换层 */
export function GuideScreenPage() {
  const guide = useGuide();
  const navigate = useNavigate();
  const d = guide.data;
  const floors = useMemo(() => sortFloors(d?.floors ?? []), [d]);
  const [index, setIndex] = useState(0);
  const seconds = d?.carouselSeconds ?? 15;
  const n = floors.length;
  useEffect(() => {
    if (n < 2) return;
    const t = setInterval(() => setIndex((i) => (i + 1) % n), seconds * 1000);
    return () => clearInterval(t);
  }, [n, seconds, index]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') navigate('/guide');
      if (e.key === 'ArrowRight' && n) setIndex((i) => (i + 1) % n);
      if (e.key === 'ArrowLeft' && n) setIndex((i) => (i - 1 + n) % n);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [n, navigate]);
  const floor = n ? floors[index % n]! : null;
  const fullscreen = () => {
    if (!document.fullscreenElement) void document.documentElement.requestFullscreen?.().catch(() => {});
  };
  return (
    <div className="fixed inset-0 flex flex-col bg-[#f6f3ec] text-ink" data-testid="guide-screen-page" data-floor={floor?.code ?? ''}>
      <header className="flex shrink-0 items-center gap-4 px-6 py-3 sm:px-10 sm:py-5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold tracking-wide text-ink-3 sm:text-[18px]">{d?.storeName ?? ''}</p>
          <h1 className="truncate text-[26px] leading-tight font-bold sm:text-[40px]" data-testid="guide-screen-title">
            {floor ? `${floor.code}${floor.title ? ` ${floor.title}` : ''}` : '对客导览'}
            {floor && <span className="ml-3 text-[16px] font-semibold text-ink-3 sm:text-[22px]">Floor {floor.code}</span>}
          </h1>
        </div>
        {n > 1 && (
          <div className="flex gap-1.5" aria-label="楼层">
            {floors.map((f, i) => (
              <button
                key={f.code}
                type="button"
                onClick={() => setIndex(i)}
                className={cn('h-9 min-w-12 rounded-full px-3 text-[15px] font-bold sm:h-11 sm:text-[18px]', i === index % n ? 'bg-pine text-paper' : 'bg-white/70 text-ink-2')}
                aria-pressed={i === index % n}
              >
                {f.code}
              </button>
            ))}
          </div>
        )}
        <button type="button" onClick={fullscreen} className="rounded-full p-2 text-ink-3 hover:bg-white/60" aria-label="全屏" title="全屏">
          <Maximize2 className="size-5" />
        </button>
        <button type="button" onClick={() => navigate('/guide')} className="rounded-full p-2 text-ink-3 hover:bg-white/60" aria-label="退出大屏模式" title="退出（Esc）" data-testid="guide-screen-exit">
          <X className="size-5" />
        </button>
      </header>
      <main className="min-h-0 flex-1 px-4 pb-2 sm:px-10">
        {!d ? (
          <Skeleton className="h-full" />
        ) : !floor ? (
          <div className="flex h-full items-center justify-center text-[22px] text-ink-3">还没有在用的底图</div>
        ) : (
          <div className="h-full rounded-2xl bg-white p-3 shadow-card sm:p-6">
            <GuideMap key={floor.code} big floor={floor} zones={d.zones.filter((z) => z.floorCode === floor.code)} markers={d.markers.filter((m) => m.floorCode === floor.code)} />
          </div>
        )}
      </main>
      {d && floor && (
        <footer className="shrink-0 px-6 pt-2 pb-4 sm:px-10 sm:pb-6">
          <GuideLegend big zones={d.zones.filter((z) => z.floorCode === floor.code)} markers={d.markers.filter((m) => m.floorCode === floor.code)} />
          {n > 1 && (
            <div className="mt-3 h-1 overflow-hidden rounded-full bg-black/5">
              <div key={`${index}-${seconds}`} className="h-full origin-left bg-pine/60" style={{ animation: `guide-progress ${seconds}s linear forwards` }} />
            </div>
          )}
        </footer>
      )}
      <style>{'@keyframes guide-progress { from { transform: scaleX(0) } to { transform: scaleX(1) } }'}</style>
    </div>
  );
}
