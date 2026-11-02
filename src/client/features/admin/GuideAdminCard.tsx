// 后台「空间台账 → 对客导览」（v0.7.19，见 docs/FLOORPLAN_FINISH.md 第 2 节）：区域的导览分类（动区 / 静区 / 公共 / 后场）与颜色、
// 设施图标（按在用底图的文字自动识别；可挪位置、隐藏、补加，存图纸坐标）、大屏轮播秒数（店主）、预览。

import { useMemo, useRef, useState, type MouseEvent } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, MapPinned, Move, Plus, ScanSearch } from 'lucide-react';
import {
  GUIDE_KIND_HINTS,
  GUIDE_KIND_LABELS,
  GUIDE_KINDS,
  GUIDE_MARKER_KINDS,
  GUIDE_MARKER_LABELS,
  MAX_CAROUSEL_SECONDS,
  MIN_CAROUSEL_SECONDS,
  type GuideAdmin,
  type GuideAdminMarker,
  type GuideAdminZone,
  type GuideKind,
  type GuideMarkerKind,
} from '@shared/guide';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { useCan } from '../../lib/session';
import { cn, uuid } from '../../lib/utils';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Input, Notice, SectionTitle, Segmented, Select, Skeleton } from '../../components/ui';
import { GUIDE_ICONS, GuideMap, useGuide } from '../guide/GuidePage';

const adminKey = ['admin', 'guide'] as const;
const useGuideAdmin = () => useQuery({ queryKey: adminKey, queryFn: () => api.get<GuideAdmin>('/api/admin/guide') });

export function GuideAdminCard() {
  const admin = useGuideAdmin();
  const guide = useGuide();
  const qc = useQueryClient();
  const toast = useToast();
  const can = useCan();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 补加图标的操作编号：没收到结果再补加时用同一个（服务端返回原来那个，不会多出一个），成功后才换新的（Codex 复审 c0a1a7d）
  const addKey = useRef(uuid());
  const d = admin.data;
  const refresh = async (next?: GuideAdmin) => {
    if (next) qc.setQueryData(adminKey, next);
    await qc.invalidateQueries({ queryKey: adminKey });
    await qc.invalidateQueries({ queryKey: ['guide'] });
  };
  const run = async (fn: () => Promise<GuideAdmin | void>, done?: string) => {
    setBusy(true);
    setError(null);
    try {
      const next = await fn();
      await refresh(next ?? undefined);
      if (done) toast({ tone: 'success', title: done });
    } catch (e) {
      setError(errorMessage(e));
      await refresh();
    } finally {
      setBusy(false);
    }
  };
  if (!d) return <Skeleton className="h-96" />;
  return (
    <div className="space-y-4" data-testid="guide-admin">
      <Card className="space-y-2 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <SectionTitle>对客导览</SectionTitle>
          <span className="flex-1" />
          <Link to="/guide" className="inline-flex items-center gap-1 text-[13px] font-semibold text-pine hover:underline" data-testid="guide-admin-preview">
            <MapPinned className="size-4" /> 打开导览页
          </Link>
          <Link to="/guide/screen" className="text-[13px] font-semibold text-pine hover:underline">
            大屏模式 →
          </Link>
        </div>
        <p className="text-[13px] leading-relaxed text-ink-2">
          导览图按在用的底图画：同一区域的空间轮廓填同一种颜色，写区域的中文名、英文名（区域的英文名在「楼层与区域」里填），画设施图标。不显示房号、房态与人员；「后场」的区域不显示。
          所有岗位默认能看（「岗位权限」里的「看对客导览」）；门店大屏用一个只用来看导览的账号登录，打开大屏模式。
        </p>
        {d.batchId === null && <Notice tone="warning">还没有在用的底图：在「底图」里上传图纸、启用一批后，导览图才有内容。</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
      </Card>
      <ZonesCard zones={d.zones} busy={busy} onSave={(z, kind, color) => run(() => api.put<GuideAdmin>(`/api/admin/guide/zones/${z.id}`, { kind, color, version: z.version }))} />
      <MarkersCard
        admin={d}
        guide={guide.data ?? null}
        busy={busy}
        onDetect={() =>
          run(async () => {
            const r = await api.post<{ detected: number; replaced: number; admin: GuideAdmin }>('/api/admin/guide/markers/detect', {});
            toast({ tone: 'success', title: `按在用底图认出 ${r.detected} 个设施`, body: r.replaced ? `替换了原来自动识别的 ${r.replaced} 个（手工加的没动）` : '手工加的没动' });
            return r.admin;
          })
        }
        onAdd={(floorCode, kind, x, y) =>
          run(async () => {
            try {
              const next = await api.post<GuideAdmin>('/api/admin/guide/markers', { clientKey: addKey.current, floorCode, kind, x, y });
              addKey.current = uuid();
              return next;
            } catch (e) {
              // 结果不明（超时、断网）才留着原编号给下一次补加；服务端明确回了的（含拒绝）换新的
              if (!(e instanceof UncertainError)) addKey.current = uuid();
              throw e;
            }
          }, `已加上${GUIDE_MARKER_LABELS[kind].zh}图标`)
        }
        onEdit={(m, patch) =>
          run(() =>
            api.put<GuideAdmin>(`/api/admin/guide/markers/${m.id}`, {
              kind: patch.kind ?? m.kind,
              label: patch.label ?? m.label,
              labelEn: patch.labelEn ?? m.labelEn,
              hidden: patch.hidden ?? m.hidden,
              x: patch.x ?? null,
              y: patch.y ?? null,
              version: m.version,
            }),
          )
        }
      />
      {can('settings.manage') && <CarouselCard seconds={d.rules.carouselSeconds} busy={busy} onSave={(s) => run(() => api.put<GuideAdmin>('/api/admin/guide/rules', { carouselSeconds: s }), '轮播秒数已保存')} />}
    </div>
  );
}

function ZonesCard({ zones, busy, onSave }: { zones: GuideAdminZone[]; busy: boolean; onSave: (z: GuideAdminZone, kind: GuideKind, color: string | null) => void }) {
  return (
    <Card className="overflow-hidden" data-testid="guide-zones">
      <div className="border-b border-line px-5 py-3">
        <SectionTitle>区域的导览分类与颜色</SectionTitle>
        <p className="mt-1 text-[12.5px] text-ink-3">
          {GUIDE_KINDS.map((k) => `${GUIDE_KIND_LABELS[k]}：${GUIDE_KIND_HINTS[k]}`).join('；')}。没单独指定颜色的按分类轮流取色。
        </p>
      </div>
      {zones.length === 0 ? (
        <p className="px-5 py-4 text-[13px] text-ink-3">空间台账里还没有区域。</p>
      ) : (
        <ul className="divide-y divide-line">
          {zones.map((z) => (
            <li key={z.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3 text-[13px]" data-testid={`guide-zone-row-${z.id}`}>
              <span className="w-10 text-ink-3">{z.floorCode}</span>
              <span className="min-w-36 flex-1">
                <span className="font-semibold">{z.name}</span>
                {z.nameEn && <span className="ml-1.5 text-ink-3">{z.nameEn}</span>}
                <span className="ml-2 text-[12px] text-ink-4">
                  {z.drawnSpaces}/{z.spaceCount} 个空间在底图上
                </span>
              </span>
              <Segmented<GuideKind>
                size="sm"
                value={z.kind}
                onChange={(k) => !busy && onSave(z, k, z.color)}
                ariaLabel={`${z.name} 的导览分类`}
                options={GUIDE_KINDS.map((k) => ({ value: k, label: k === 'back' ? '后场' : GUIDE_KIND_LABELS[k] }))}
              />
              <span className="flex items-center gap-1.5">
                {z.kind === 'back' ? (
                  <span className="text-[12px] text-ink-3">不显示</span>
                ) : (
                  <>
                    <input
                      type="color"
                      value={z.shownColor ?? '#ffffff'}
                      disabled={busy}
                      onChange={(e) => onSave(z, z.kind, e.target.value)}
                      className="h-7 w-10 cursor-pointer rounded border border-line bg-white"
                      aria-label={`${z.name} 的颜色`}
                      data-testid={`guide-zone-color-${z.id}`}
                    />
                    {z.color && (
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => onSave(z, z.kind, null)}>
                        按分类取色
                      </Button>
                    )}
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

type Placing = { mode: 'add'; kind: GuideMarkerKind } | { mode: 'move'; marker: GuideAdminMarker } | null;

function MarkersCard({
  admin,
  guide,
  busy,
  onDetect,
  onAdd,
  onEdit,
}: {
  admin: GuideAdmin;
  guide: import('@shared/guide').GuideData | null;
  busy: boolean;
  onDetect: () => void;
  onAdd: (floorCode: string, kind: GuideMarkerKind, x: number, y: number) => void;
  onEdit: (m: GuideAdminMarker, patch: Partial<Pick<GuideAdminMarker, 'kind' | 'label' | 'labelEn' | 'hidden' | 'x' | 'y'>>) => void;
}) {
  const floors = admin.floors;
  const [floorCode, setFloorCode] = useState<string | null>(null);
  const [placing, setPlacing] = useState<Placing>(null);
  const [addKind, setAddKind] = useState<GuideMarkerKind>('toilet');
  const floor = floors.find((f) => f.code === floorCode) ?? floors[0] ?? null;
  const here = useMemo(() => admin.markers.filter((m) => floor && m.floorCode === floor.code), [admin.markers, floor]);
  const offPlan = admin.markers.filter((m) => !m.onPlan);
  const svgRef = useRef<HTMLDivElement>(null);
  const click = (e: MouseEvent<HTMLDivElement>) => {
    if (!placing || !floor || !svgRef.current) return;
    const svg = svgRef.current.querySelector('svg');
    const ctm = svg?.getScreenCTM();
    if (!ctm) return;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    const x = Math.round(Math.max(0, Math.min(floor.width, p.x)));
    const y = Math.round(Math.max(0, Math.min(floor.height, p.y)));
    if (placing.mode === 'add') onAdd(floor.code, placing.kind, x, y);
    else onEdit(placing.marker, { x, y });
    setPlacing(null);
  };
  return (
    <Card className="space-y-3 p-5" data-testid="guide-markers">
      <div className="flex flex-wrap items-center gap-2">
        <SectionTitle>设施图标</SectionTitle>
        <span className="flex-1" />
        <Button size="sm" variant="secondary" icon={<ScanSearch className="size-4" />} disabled={busy || admin.batchId === null} onClick={onDetect} data-testid="guide-detect">
          按在用底图识别
        </Button>
      </div>
      <p className="text-[12.5px] text-ink-3">
        自动识别底图里不带编码的文字（卫生间 / 洗手间 / WC、电梯、楼梯、前台 / 接待、出入口、更衣、餐厅、吸烟），员工区、后场的不认；重新识别只替换自动识别的，手工加的不动。
        图标按图纸坐标存，换了底图也能对上位置。
      </p>
      {floor && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {floors.length > 1 && (
              <Segmented<string>
                size="sm"
                value={floor.code}
                onChange={(v) => {
                  setFloorCode(v);
                  setPlacing(null);
                }}
                ariaLabel="楼层"
                options={floors.map((f) => ({ value: f.code, label: f.title ? `${f.code} ${f.title}` : f.code }))}
              />
            )}
            <span className="flex-1" />
            <Select value={addKind} onChange={(e) => setAddKind(e.target.value as GuideMarkerKind)} className="w-32" aria-label="补加的图标" data-testid="guide-add-kind">
              {GUIDE_MARKER_KINDS.map((k) => (
                <option key={k} value={k}>
                  {GUIDE_MARKER_LABELS[k].zh}
                </option>
              ))}
            </Select>
            <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} disabled={busy} onClick={() => setPlacing({ mode: 'add', kind: addKind })} data-testid="guide-add">
              补加图标
            </Button>
          </div>
          {placing && (
            <Notice tone="info" title={placing.mode === 'add' ? `点图上的位置放${GUIDE_MARKER_LABELS[placing.kind].zh}图标` : `点图上的新位置，把${placing.marker.label}挪过去`}>
              <Button size="sm" variant="ghost" onClick={() => setPlacing(null)}>
                取消
              </Button>
            </Notice>
          )}
          <div ref={svgRef} onClick={click} className={cn('relative aspect-[16/10] w-full overflow-hidden rounded-md border border-line bg-white', placing && 'cursor-crosshair')} data-testid="guide-admin-map">
            <GuideMap floor={floor} zones={(guide?.zones ?? []).filter((z) => z.floorCode === floor.code)} markers={here.filter((m) => !m.hidden && m.onPlan)} />
          </div>
          {here.length === 0 ? (
            <p className="text-[13px] text-ink-3">这一层还没有图标：点「按在用底图识别」，或选好种类点「补加图标」。</p>
          ) : (
            <ul className="divide-y divide-line rounded-md border border-line">
              {here.map((m) => (
                <MarkerRow key={m.id} m={m} busy={busy} onEdit={onEdit} onMove={() => setPlacing({ mode: 'move', marker: m })} />
              ))}
            </ul>
          )}
        </>
      )}
      {offPlan.length > 0 && (
        <Notice tone="warning" title={`${offPlan.length} 个图标不在在用的底图上`}>
          {offPlan.map((m) => `${m.floorCode} ${m.label}`).join('、')}：换了底图后落在了图框外或那一层没有了；挪一下位置或隐藏。
        </Notice>
      )}
    </Card>
  );
}

function MarkerRow({ m, busy, onEdit, onMove }: { m: GuideAdminMarker; busy: boolean; onEdit: (m: GuideAdminMarker, patch: Partial<GuideAdminMarker>) => void; onMove: () => void }) {
  const Icon = GUIDE_ICONS[m.kind];
  const [label, setLabel] = useState(m.label);
  const [labelEn, setLabelEn] = useState(m.labelEn);
  const dirty = label !== m.label || labelEn !== m.labelEn;
  return (
    <li className={cn('flex flex-wrap items-center gap-2 px-3 py-2 text-[13px]', m.hidden && 'opacity-60')} data-testid={`guide-marker-row-${m.id}`}>
      <Icon className="size-4 text-ink-2" />
      <Select value={m.kind} disabled={busy} onChange={(e) => onEdit(m, { kind: e.target.value as GuideMarkerKind })} className="w-28" aria-label="图标种类">
        {GUIDE_MARKER_KINDS.map((k) => (
          <option key={k} value={k}>
            {GUIDE_MARKER_LABELS[k].zh}
          </option>
        ))}
      </Select>
      <Input value={label} maxLength={24} onChange={(e) => setLabel(e.target.value)} className="w-32" aria-label="中文标签" />
      <Input value={labelEn} maxLength={48} onChange={(e) => setLabelEn(e.target.value)} className="w-36" aria-label="英文标签" />
      {dirty && (
        <Button size="sm" variant="primary" disabled={busy} onClick={() => onEdit(m, { label, labelEn })}>
          保存文字
        </Button>
      )}
      <Badge tone={m.source === 'auto' ? 'lake' : 'yuzu'}>{m.source === 'auto' ? '自动识别' : '手工加的'}</Badge>
      <span className="flex-1" />
      <Button size="sm" variant="ghost" icon={<Move className="size-3.5" />} disabled={busy} onClick={onMove} data-testid={`guide-marker-move-${m.id}`}>
        挪位置
      </Button>
      <Button
        size="sm"
        variant="ghost"
        icon={m.hidden ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
        disabled={busy}
        onClick={() => onEdit(m, { hidden: !m.hidden })}
        data-testid={`guide-marker-hide-${m.id}`}
      >
        {m.hidden ? '显示' : '隐藏'}
      </Button>
    </li>
  );
}

function CarouselCard({ seconds, busy, onSave }: { seconds: number; busy: boolean; onSave: (s: number) => void }) {
  const [value, setValue] = useState(String(seconds));
  const n = Number(value);
  const ok = Number.isInteger(n) && n >= MIN_CAROUSEL_SECONDS && n <= MAX_CAROUSEL_SECONDS;
  return (
    <Card className="flex flex-wrap items-center gap-3 p-5" data-testid="guide-carousel">
      <SectionTitle>大屏轮播</SectionTitle>
      <span className="text-[13px] text-ink-2">每层停</span>
      <Input value={value} onChange={(e) => setValue(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" className="num w-20" aria-label="轮播秒数" data-testid="guide-carousel-seconds" />
      <span className="text-[13px] text-ink-2">
        秒（{MIN_CAROUSEL_SECONDS}–{MAX_CAROUSEL_SECONDS}）
      </span>
      <Button size="sm" variant="primary" disabled={busy || !ok || n === seconds} onClick={() => onSave(n)} data-testid="guide-carousel-save">
        保存
      </Button>
    </Card>
  );
}
