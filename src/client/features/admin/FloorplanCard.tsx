// 后台「空间台账 → 底图」（飞书需求 RQ-004 第二段，v0.7.15，见 docs/FLOORPLAN.md）：
// 上传 DWG / ASCII DXF → 服务器上单独的进程转换（DWG 大约半分钟）→ 预览每层底图与房间轮廓、例外清单、
// 与空间台账比对（以台账为准，不按图纸改台账）、与在用的那一批比对（房间增减、编码变更）→ 店主或店总启用。
// 第三段房态图用启用的那一批。图纸文件本身不保存在系统里；同一份图纸重传回到原来那一批。

import { useMemo, useRef, useState, type ReactNode } from 'react';
import { CircleCheck, Download, FileUp, Minus, Plus, Scan } from 'lucide-react';
import {
  FLOORPLAN_BATCH_LABELS,
  FLOORPLAN_LAYER_CLASS_LABELS,
  FLOORPLAN_ROOM_HINTS,
  FLOORPLAN_ROOM_LABELS,
  MAX_FLOORPLAN_FILE_BYTES,
  fileSizeText,
  type FloorplanBatch,
  type FloorplanBatchStatus,
  type FloorplanDetail,
  type FloorplanFloor,
  type FloorplanRoom,
} from '@shared/floorplans';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { bytesToBase64 } from '../../lib/import-file';
import { cn, downloadUrl, formatDateTime } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Input, Notice, SectionTitle, Segmented, Skeleton, Spinner } from '../../components/ui';
import { useFloorplanDetail, useFloorplans, useInvalidateFloorplans } from '../spaces/floorplans';

const STATUS_TONE: Record<FloorplanBatchStatus, 'neutral' | 'pine' | 'yuzu' | 'clay' | 'lake'> = {
  converting: 'lake',
  ready: 'yuzu',
  failed: 'clay',
  active: 'pine',
  retired: 'neutral',
};

const seconds = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(1)} 秒`);

export function FloorplanCard() {
  const list = useFloorplans();
  const [picked, setPicked] = useState<number | null>(null);
  const batches = list.data?.batches ?? [];
  // 默认看：转换中的 → 最新的待启用 → 在用的 → 最新的一批
  const current =
    picked ??
    list.data?.converting?.id ??
    batches.find((b) => b.status === 'ready')?.id ??
    list.data?.activeId ??
    batches[0]?.id ??
    null;
  return (
    <div className="space-y-4" data-testid="floorplans">
      <UploadCard converting={list.data?.converting ?? null} onUploaded={setPicked} />
      {!list.data ? (
        <Skeleton className="h-32" />
      ) : batches.length === 0 ? (
        <Notice tone="info" title="还没有上传过图纸">
          上传设计方的编码图（DWG），系统自动按楼层出底图、从房号文字围合房间轮廓，与空间台账比对后由店主或店总启用。没有门店图纸时可以用 docs/data/floorplan-sample.dxf（合成样例）试。
        </Notice>
      ) : (
        <BatchList batches={batches} current={current} onPick={setPicked} />
      )}
      {current !== null && <BatchDetail key={current} id={current} />}
    </div>
  );
}

// ───────────────────────── 上传 ─────────────────────────

function UploadCard({ converting, onUploaded }: { converting: FloorplanBatch | null; onUploaded: (id: number) => void }) {
  const toast = useToast();
  const invalidate = useInvalidateFloorplans();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = (f: File | undefined) => {
    setError(null);
    setFile(null);
    if (!f) return;
    if (!/\.(dwg|dxf)$/i.test(f.name)) return setError('只收 DWG 或 DXF 图纸（.dwg / .dxf）');
    if (f.size > MAX_FLOORPLAN_FILE_BYTES) return setError(`图纸 ${fileSizeText(f.size)}，超过 ${fileSizeText(MAX_FLOORPLAN_FILE_BYTES)}；请设计方只保留 L1–L3 后另存`);
    setFile(f);
  };

  const submit = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const contentBase64 = bytesToBase64(await file.arrayBuffer());
      const r = await api.post<{ batch: FloorplanBatch; replayed: boolean }>('/api/admin/floorplans', { fileName: file.name, contentBase64, note }, { timeoutMs: 180_000 });
      toast(
        r.replayed
          ? { tone: 'info', title: `这份图纸已经转换过（批次 #${r.batch.id}）`, body: '同一份图纸不重复转换，已打开原来那一批' }
          : { tone: 'success', title: `已上传，正在转换（批次 #${r.batch.id}）`, body: 'DWG 大约要半分钟到一分钟，完成后这里自动刷新' },
      );
      setFile(null);
      setNote('');
      if (input.current) input.current.value = '';
      onUploaded(r.batch.id);
      await invalidate();
    } catch (e) {
      setError(
        e instanceof UncertainError
          ? '上传结果不明（网络中断或服务器很久没回应）。稍后刷新看列表里有没有这份图纸；同一份图纸重新上传不会重复转换。'
          : errorMessage(e),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-3 p-5" data-testid="floorplan-upload">
      <SectionTitle>上传图纸</SectionTitle>
      <p className="text-[13px] leading-relaxed text-ink-2">
        DWG 或 ASCII DXF，不超过 {fileSizeText(MAX_FLOORPLAN_FILE_BYTES)}。系统按图层白名单只留墙、柱、门窗、楼梯电梯与房间名、房号，按楼层出底图，从房号文字点围合房间轮廓；
        图纸文件本身不保存，同一份图纸重传会回到原来那一批。
      </p>
      {converting && (
        <Notice tone="info" icon={<Spinner className="size-4 text-lake" />} title={`正在转换「${converting.fileName}」`}>
          {formatDateTime(converting.createdAt)} 开始，DWG 大约要半分钟到一分钟；转换完之前不能再传别的图纸。
        </Notice>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input ref={input} type="file" accept=".dwg,.dxf" className="hidden" data-testid="floorplan-file" onChange={(e) => choose(e.target.files?.[0])} />
        <Button icon={<FileUp className="size-4" />} onClick={() => input.current?.click()} disabled={busy}>
          选择图纸
        </Button>
        {file && (
          <span className="text-[13px] text-ink-2" data-testid="floorplan-file-name">
            {file.name}（{fileSizeText(file.size)}）
          </span>
        )}
      </div>
      {file && (
        <div className="flex flex-wrap items-center gap-2">
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="备注（可选，例如：设计方 11 月版）" className="min-w-0 flex-1 sm:max-w-md" />
          <Button variant="primary" loading={busy} onClick={submit} disabled={!!converting} data-testid="floorplan-upload-submit">
            上传并转换
          </Button>
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </Card>
  );
}

// ───────────────────────── 批次列表 ─────────────────────────

function BatchList({ batches, current, onPick }: { batches: FloorplanBatch[]; current: number | null; onPick: (id: number) => void }) {
  return (
    <Card className="overflow-hidden" data-testid="floorplan-batches">
      <div className="border-b border-line px-5 py-3">
        <SectionTitle>转换批次</SectionTitle>
      </div>
      <ul className="divide-y divide-line">
        {batches.map((b) => (
          <li key={b.id}>
            <button
              type="button"
              onClick={() => onPick(b.id)}
              className={cn('flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-left hover:bg-paper', b.id === current && 'bg-pine-tint')}
              data-testid={`floorplan-batch-${b.id}`}
              aria-current={b.id === current}
            >
              <span className="w-12 text-[13px] text-ink-3">#{b.id}</span>
              <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">{b.fileName}</span>
              <Badge tone={STATUS_TONE[b.status]}>{FLOORPLAN_BATCH_LABELS[b.status]}</Badge>
              <span className="text-[13px] text-ink-2">
                {b.status === 'ready' || b.status === 'active' || b.status === 'retired'
                  ? `${b.floorCount} 层 · 编码 ${b.roomCount} 个 · 配上轮廓 ${b.okCount} 个`
                  : b.status === 'failed'
                    ? '没有结果'
                    : '转换中…'}
              </span>
              <span className="text-[12.5px] text-ink-3">
                {b.createdByName ?? '—'} · {formatDateTime(b.createdAt)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ───────────────────────── 预览 ─────────────────────────

function BatchDetail({ id }: { id: number }) {
  const detail = useFloorplanDetail(id);
  const invalidate = useInvalidateFloorplans();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const d = detail.data;
  if (!d) return <Skeleton className="h-96" />;
  const b = d.batch;
  const exceptions = d.rooms.filter((r) => r.status !== 'ok');

  const activate = async () => {
    setActivating(true);
    setError(null);
    try {
      const next = await api.post<FloorplanDetail>(`/api/admin/floorplans/${b.id}/activate`);
      await invalidate(next);
      setConfirming(false);
      toast({ tone: 'success', title: `批次 #${b.id} 已启用`, body: '房态图（第三段）会用这一批底图' });
    } catch (e) {
      setError(errorMessage(e));
      setConfirming(false);
    } finally {
      setActivating(false);
    }
  };

  return (
    <Card className="space-y-4 p-5" data-testid="floorplan-detail">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="text-[16px] font-bold" data-testid="floorplan-detail-title">
          批次 #{b.id} · {b.fileName}
        </h3>
        <Badge tone={STATUS_TONE[b.status]}>{FLOORPLAN_BATCH_LABELS[b.status]}</Badge>
        <span className="flex-1" />
        {(b.status === 'ready' || b.status === 'active' || b.status === 'retired') && (
          <Button size="sm" variant="secondary" icon={<Download className="size-4" />} onClick={() => downloadUrl(`/api/admin/floorplans/${b.id}/geojson`)}>
            下载 spaces.geojson
          </Button>
        )}
        {b.status === 'ready' && (
          <Button size="sm" variant="primary" icon={<CircleCheck className="size-4" />} onClick={() => setConfirming(true)} data-testid="floorplan-activate">
            启用这一批
          </Button>
        )}
      </div>
      <Dialog
        open={confirming}
        onClose={activating ? () => {} : () => setConfirming(false)}
        title={`启用批次 #${b.id}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)} disabled={activating}>
              取消
            </Button>
            <Button variant="primary" loading={activating} onClick={activate} data-testid="floorplan-activate-confirm">
              启用
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-[14px] leading-relaxed" data-testid="floorplan-activate-dialog">
          <p>
            启用「{b.fileName}」：{b.floorCount} 层、编码 {b.roomCount} 个。原来在用的底图会换下（留着可以查看，不能再启用）。
          </p>
          {exceptions.length > 0 ? (
            <Notice tone="warning" title={`有 ${exceptions.length} 个编码没配上轮廓`}>
              {exceptions.map((r) => r.code).join('、')}：启用后它们在房态图上只显示位置点；要轮廓请设计方改图后重新上传。
            </Notice>
          ) : (
            <p className="text-ink-2">所有编码都配上了轮廓。</p>
          )}
        </div>
      </Dialog>
      <p className="text-[13px] text-ink-2">
        {fileSizeText(b.fileBytes)} · {b.fileFormat.toUpperCase()} · {b.createdByName ?? '—'} {formatDateTime(b.createdAt)} 上传
        {b.finishedAt && ` · 读图 ${seconds(b.readMs)}、转换 ${seconds(b.convertMs)}`}
        {d.report?.worker?.peakRssMb ? ` · 内存峰值 ${d.report.worker.peakRssMb} MB` : ''}
        {b.activatedAt && ` · ${b.activatedByName ?? '—'} ${formatDateTime(b.activatedAt)} 启用`}
        {b.note && ` · 备注：${b.note}`}
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      {b.status === 'converting' && (
        <Notice tone="info" icon={<Spinner className="size-4 text-lake" />} title="正在转换">
          转换在服务器上单独的进程里跑，完成后这里自动刷新。
        </Notice>
      )}
      {b.status === 'failed' && (
        <Notice tone="error" title="转换失败">
          {b.error}
        </Notice>
      )}
      {d.floors.length > 0 && <PlanViewer floors={d.floors} rooms={d.rooms} />}
      {(b.status === 'ready' || b.status === 'active' || b.status === 'retired') && (
        <>
          <Exceptions rooms={exceptions} total={d.rooms.length} />
          <LedgerDiffView detail={d} />
          <BatchDiffView detail={d} />
        </>
      )}
      {d.report && <ReportView detail={d} />}
    </Card>
  );
}

function PlanViewer({ floors, rooms }: { floors: FloorplanFloor[]; rooms: FloorplanRoom[] }) {
  // 默认看编码最多的一层
  const busiest = useMemo(() => {
    const count = (code: string) => rooms.filter((r) => r.floorCode === code).length;
    return [...floors].sort((a, b) => count(b.code) - count(a.code))[0]!.code;
  }, [floors, rooms]);
  const [floorCode, setFloorCode] = useState(busiest);
  const [zoom, setZoom] = useState(1);
  const [focus, setFocus] = useState<string | null>(null);
  const floor = floors.find((f) => f.code === floorCode) ?? floors[0]!;
  const here = rooms.filter((r) => r.floorCode === floor.code);
  const font = Math.max(floor.width, floor.height) / 90;
  const picked = here.find((r) => r.code === focus) ?? null;
  return (
    <div className="space-y-2" data-testid="floorplan-viewer">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<string>
          size="sm"
          value={floor.code}
          onChange={(v) => {
            setFloorCode(v);
            setFocus(null);
          }}
          ariaLabel="楼层"
          options={floors.map((f) => ({ value: f.code, label: f.title ? `${f.code} ${f.title}` : f.code }))}
        />
        <span className="text-[12.5px] text-ink-3">
          编码 {here.length} 个（配上轮廓 {here.filter((r) => r.status === 'ok').length} 个）· 底图 {fileSizeText(floor.svgBytes)}
        </span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" icon={<Minus className="size-4" />} aria-label="缩小" onClick={() => setZoom((z) => Math.max(1, z / 1.5))} disabled={zoom <= 1} />
        <Button size="sm" variant="ghost" icon={<Scan className="size-4" />} aria-label="适应宽度" onClick={() => setZoom(1)} disabled={zoom === 1} />
        <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} aria-label="放大" onClick={() => setZoom((z) => Math.min(8, z * 1.5))} disabled={zoom >= 8} />
      </div>
      <div className="max-h-[70vh] overflow-auto rounded-md border border-line bg-white" data-testid="floorplan-canvas">
        <svg viewBox={`0 0 ${floor.width} ${floor.height}`} style={{ width: `${zoom * 100}%`, display: 'block' }} role="img" aria-label={`${floor.code} 底图与房间轮廓`}>
          <image href={floor.svgUrl} x={0} y={0} width={floor.width} height={floor.height} />
          {here.map((r) =>
            r.polygon ? (
              <polygon
                key={r.code}
                points={r.polygon.map((p) => p.join(',')).join(' ')}
                className={cn('cursor-pointer stroke-pine', focus === r.code ? 'fill-yuzu/40' : 'fill-pine/15 hover:fill-pine/30')}
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
                onClick={() => setFocus(r.code)}
                data-code={r.code}
              />
            ) : null,
          )}
          {here.map((r) => (
            <g key={`${r.code}-label`} className="cursor-pointer" onClick={() => setFocus(r.code)} data-testid={`floorplan-room-${r.code}`} data-status={r.status}>
              {r.status !== 'ok' && <circle cx={r.labelAt[0]} cy={r.labelAt[1]} r={font * 0.9} className="fill-clay/25 stroke-clay" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
              <text
                x={r.labelAt[0]}
                y={r.labelAt[1]}
                fontSize={font}
                textAnchor="middle"
                dominantBaseline="central"
                className={cn('font-semibold', r.status === 'ok' ? 'fill-pine' : 'fill-clay')}
                style={{ paintOrder: 'stroke', stroke: 'white', strokeWidth: font / 6 }}
              >
                {r.code}
              </text>
            </g>
          ))}
        </svg>
      </div>
      {picked && (
        <p className="text-[13px] text-ink-2" data-testid="floorplan-focus">
          <span className="font-semibold text-ink">{picked.code}</span> · {picked.label} · {FLOORPLAN_ROOM_LABELS[picked.status]}
          {picked.areaM2 !== null && ` · 约 ${picked.areaM2} ㎡`}
          {picked.mergedWith.length > 0 && ` · 与 ${picked.mergedWith.join('、')} 连成一片`}
        </p>
      )}
    </div>
  );
}

function Exceptions({ rooms, total }: { rooms: FloorplanRoom[]; total: number }) {
  if (!rooms.length) {
    return (
      <Notice tone="success" title={`${total} 个编码都配上了轮廓`}>
        没有要人工核对的例外。
      </Notice>
    );
  }
  return (
    <div className="space-y-2" data-testid="floorplan-exceptions">
      <SectionTitle>
        例外 {rooms.length} 个（{total} 个编码里没配上轮廓的，人工只核对这些）
      </SectionTitle>
      <ul className="divide-y divide-line rounded-md border border-line">
        {rooms.map((r) => (
          <li key={`${r.floorCode}-${r.code}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5 text-[13px]">
            <span className="w-14 font-semibold">{r.code}</span>
            <span className="text-ink-3">{r.floorCode}</span>
            <Badge tone="clay">{FLOORPLAN_ROOM_LABELS[r.status]}</Badge>
            {r.mergedWith.length > 0 && <span className="text-ink-2">与 {r.mergedWith.join('、')}</span>}
            <span className="min-w-0 flex-1 text-ink-3">{r.label}</span>
            {r.status !== 'ok' && <p className="w-full text-[12.5px] leading-relaxed text-ink-2">{FLOORPLAN_ROOM_HINTS[r.status]}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CodeChips({ items, tone = 'neutral' }: { items: string[]; tone?: 'neutral' | 'clay' | 'yuzu' | 'pine' }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((x) => (
        <Badge key={x} tone={tone}>
          {x}
        </Badge>
      ))}
    </div>
  );
}

function LedgerDiffView({ detail }: { detail: FloorplanDetail }) {
  const diff = detail.ledgerDiff;
  if (!diff) return null;
  const none = !diff.onlyDrawing.length && !diff.onlyLedger.length && !diff.floorMismatch.length && !diff.labelChanged.length;
  return (
    <div className="space-y-2" data-testid="floorplan-ledger-diff">
      <SectionTitle>与空间台账比对（以台账为准，不按图纸改台账）</SectionTitle>
      <p className="text-[13px] text-ink-2">编码与楼层都对上的 {diff.matched} 个。</p>
      {none && <Notice tone="success">图上的编码与台账（图上这几层的在用空间）一致。</Notice>}
      {diff.onlyDrawing.length > 0 && (
        <DiffRow title={`图上有、台账没有 ${diff.onlyDrawing.length} 个`} hint="核对后在「空间」里新建（或导入），停用的要重新启用">
          <CodeChips tone="yuzu" items={diff.onlyDrawing.map((x) => `${x.code}${x.ledgerInactive ? '（已停用）' : ''}`)} />
        </DiffRow>
      )}
      {diff.onlyLedger.length > 0 && (
        <DiffRow title={`台账有、图上没有 ${diff.onlyLedger.length} 个`} hint="确认已拆除的在「空间」里停用；图纸漏标的请设计方补上">
          <CodeChips tone="clay" items={diff.onlyLedger.map((x) => `${x.code} ${x.displayName}`)} />
        </DiffRow>
      )}
      {diff.floorMismatch.length > 0 && (
        <DiffRow title={`楼层不同 ${diff.floorMismatch.length} 个`} hint="编码相同但图上与台账的楼层不同">
          <CodeChips tone="clay" items={diff.floorMismatch.map((x) => `${x.code}：图上 ${x.drawingFloor} / 台账 ${x.ledgerFloor}`)} />
        </DiffRow>
      )}
      {diff.labelChanged.length > 0 && (
        <DiffRow title={`原始标注变了 ${diff.labelChanged.length} 个`} hint="图上的原文与台账的「编码图原始标注」不同，核对后在空间详情里改">
          <ul className="space-y-1 text-[13px]">
            {diff.labelChanged.map((x) => (
              <li key={x.code}>
                <span className="font-semibold">{x.code}</span>：图上「{x.drawingLabel}」，台账「{x.ledgerLabel}」
              </li>
            ))}
          </ul>
        </DiffRow>
      )}
    </div>
  );
}

function BatchDiffView({ detail }: { detail: FloorplanDetail }) {
  const diff = detail.batchDiff;
  if (!diff) return null;
  const none = !diff.added.length && !diff.removed.length && !diff.renamed.length && !diff.moved.length;
  const label = detail.batch.status === 'active' ? '与它换下的那一批' : '与在用的那一批';
  return (
    <div className="space-y-2" data-testid="floorplan-batch-diff">
      <SectionTitle>
        {label}（#{diff.againstBatchId}）比对：房间增减、编码变更
      </SectionTitle>
      {none && <Notice tone="success">房间与编码没有变化。</Notice>}
      {diff.renamed.length > 0 && (
        <DiffRow title={`编码变更 ${diff.renamed.length} 个`} hint="同一个位置换了编码">
          <CodeChips tone="yuzu" items={diff.renamed.map((x) => `${x.from} → ${x.to}`)} />
        </DiffRow>
      )}
      {diff.added.length > 0 && (
        <DiffRow title={`新增 ${diff.added.length} 个`}>
          <CodeChips tone="pine" items={diff.added.map((x) => x.code)} />
        </DiffRow>
      )}
      {diff.removed.length > 0 && (
        <DiffRow title={`减少 ${diff.removed.length} 个`}>
          <CodeChips tone="clay" items={diff.removed.map((x) => x.code)} />
        </DiffRow>
      )}
      {diff.moved.length > 0 && (
        <DiffRow title={`位置变了 ${diff.moved.length} 个`} hint="同一个编码，文字位置挪了 2 米以上">
          <CodeChips items={diff.moved.map((x) => `${x.code}（${x.distanceM} 米）`)} />
        </DiffRow>
      )}
    </div>
  );
}

function DiffRow({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5 rounded-md border border-line px-4 py-3">
      <p className="text-[13.5px] font-semibold">
        {title}
        {hint && <span className="ml-2 text-[12.5px] font-normal text-ink-3">{hint}</span>}
      </p>
      {children}
    </div>
  );
}

function ReportView({ detail }: { detail: FloorplanDetail }) {
  const r = detail.report!;
  const used = r.layers.filter((l) => l.cls === 'base' || l.cls === 'room' || l.cls === 'label');
  return (
    <details className="rounded-md border border-line px-4 py-3" data-testid="floorplan-report">
      <summary className="cursor-pointer text-[13.5px] font-semibold">
        转换报告：图元 {r.source.entities} 个、图层 {r.source.layers} 个（用到 {used.length} 个）{r.issues.length ? `，提示 ${r.issues.length} 条` : ''}
      </summary>
      <div className="mt-3 space-y-3 text-[13px]">
        {r.issues.length > 0 && (
          <ul className="list-disc space-y-1 pl-5 text-ink-2">
            {r.issues.map((i, k) => (
              <li key={k}>{i.message}</li>
            ))}
          </ul>
        )}
        <p className="text-ink-3">
          展开块参照 {r.source.inserts} 个；转成线 {r.source.paths} 条、文字 {r.source.texts} 个
          {Object.keys(r.source.skipped).length > 0 && `；没转换的：${Object.entries(r.source.skipped).map(([k, v]) => `${k} ${v}`).join('、')}`}
        </p>
        <div className="max-h-72 overflow-auto rounded border border-line">
          <table className="w-full text-left text-[12.5px]">
            <thead className="sticky top-0 bg-paper-2 text-ink-3">
              <tr>
                <th className="px-3 py-1.5 font-semibold">图层</th>
                <th className="px-3 py-1.5 font-semibold">用途</th>
                <th className="px-3 py-1.5 text-right font-semibold">图元</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {r.layers.map((l) => (
                <tr key={l.name} className={cn(l.cls === 'exclude' || l.cls === 'other' ? 'text-ink-3' : 'text-ink')}>
                  <td className="px-3 py-1">{l.name}</td>
                  <td className="px-3 py-1">{FLOORPLAN_LAYER_CLASS_LABELS[l.cls]}</td>
                  <td className="px-3 py-1 text-right tabular-nums">{l.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </details>
  );
}
