// 后台「空间台账 → 底图」（飞书需求 RQ-004 第二段，v0.7.15，见 docs/FLOORPLAN.md）：
// 上传 DWG / ASCII DXF / 矢量 PDF → 服务器上单独的进程转换（DWG 大约半分钟）→ 预览每层底图与房间轮廓、例外清单、
// 与空间台账比对（以台账为准，不按图纸改台账）、与在用的那一批比对（房间增减、编码变更）→ 店主或店总启用。
// 第三段房态图用启用的那一批。同一份图纸重传回到原来那一批。
// 图纸治理（v0.7.19，docs/FLOORPLAN_FINISH.md 第 4、5 节）：上传时登记来源、版本或说明、收图日期，可勾「保存原图纸」；
// 底图档案（所有批次，已换下的只读）、在用历史；已换下的写原因「换回这一批」；例外编码在这一批的底图上点出轮廓补画。

import { useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { CircleCheck, Download, FileUp, History, Minus, PenLine, Plus, RotateCcw, Scan, Undo2 } from 'lucide-react';
import {
  FLOORPLAN_ACTIVATION_LABELS,
  FLOORPLAN_BATCH_LABELS,
  FLOORPLAN_LAYER_CLASS_LABELS,
  FLOORPLAN_ROOM_HINTS,
  FLOORPLAN_ROOM_LABELS,
  FLOORPLAN_SOURCE_KINDS,
  FLOORPLAN_SOURCE_LABELS,
  MAX_FLOORPLAN_FILE_BYTES,
  MAX_OUTLINE_POINTS,
  PDF_SCALE_MAX,
  fileSizeText,
  type FloorplanActivation,
  type FloorplanBatch,
  type FloorplanBatchStatus,
  type FloorplanDetail,
  type FloorplanFloor,
  type FloorplanLedgerDiff,
  type FloorplanRoom,
  type FloorplanSourceKind,
} from '@shared/floorplans';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { bytesToBase64 } from '../../lib/import-file';
import { useSession } from '../../lib/session';
import { cn, downloadUrl, formatDateTime } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, SectionTitle, Segmented, Skeleton, Spinner } from '../../components/ui';
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
      {list.data && list.data.history.length > 0 && <HistoryCard history={list.data.history} onPick={setPicked} />}
      {current !== null && <BatchDetail key={current} id={current} />}
    </div>
  );
}

const registration = (b: FloorplanBatch) =>
  [b.sourceKind ? FLOORPLAN_SOURCE_LABELS[b.sourceKind] : '', b.sourceNote, b.receivedOn ? `${b.receivedOn} 收图` : ''].filter(Boolean).join(' · ') || '升级前上传，没有入库登记';

// ───────────────────────── 在用历史 ─────────────────────────

function HistoryCard({ history, onPick }: { history: FloorplanActivation[]; onPick: (id: number) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? history : history.slice(0, 6);
  return (
    <Card className="overflow-hidden" data-testid="floorplan-history">
      <div className="flex items-center gap-2 border-b border-line px-5 py-3">
        <History className="size-4 text-ink-3" />
        <SectionTitle>在用历史</SectionTitle>
      </div>
      <ol className="divide-y divide-line">
        {shown.map((h) => (
          <li key={h.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-2.5 text-[13px]" data-testid={`floorplan-history-${h.id}`}>
            <span className="w-32 shrink-0 text-ink-3">{formatDateTime(h.at)}</span>
            <Badge tone={h.kind === 'retire' ? 'neutral' : h.kind === 'restore' ? 'yuzu' : 'pine'}>{FLOORPLAN_ACTIVATION_LABELS[h.kind]}</Badge>
            <button type="button" onClick={() => onPick(h.batchId)} className="min-w-0 truncate font-semibold text-pine hover:underline">
              #{h.batchId} {h.fileName}
            </button>
            <span className="text-ink-2">{h.staffName ?? '—'}</span>
            {h.reason && <span className="min-w-0 flex-1 text-ink-3">原因：{h.reason}</span>}
          </li>
        ))}
      </ol>
      {history.length > 6 && (
        <div className="border-t border-line px-5 py-2">
          <Button size="sm" variant="ghost" onClick={() => setAll((v) => !v)}>
            {all ? '收起' : `看全部 ${history.length} 条`}
          </Button>
        </div>
      )}
    </Card>
  );
}

// ───────────────────────── 上传 ─────────────────────────

function UploadCard({ converting, onUploaded }: { converting: FloorplanBatch | null; onUploaded: (id: number) => void }) {
  const toast = useToast();
  const session = useSession();
  const invalidate = useInvalidateFloorplans();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState('');
  // 入库登记（v0.7.19）
  const [sourceKind, setSourceKind] = useState<FloorplanSourceKind | null>(null);
  const [sourceNote, setSourceNote] = useState('');
  const [receivedOn, setReceivedOn] = useState(session.calendarToday);
  const [saveOriginal, setSaveOriginal] = useState(false);
  const [scale, setScale] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isPdf = !!file && /\.pdf$/i.test(file.name);
  const scaleNum = scale.trim() ? Number(scale.trim()) : null;
  const scaleOk = !isPdf || scaleNum === null || (Number.isInteger(scaleNum) && scaleNum >= 1 && scaleNum <= PDF_SCALE_MAX);
  const ready = !!file && !!sourceKind && !!receivedOn && receivedOn <= session.calendarToday && scaleOk;

  const choose = (f: File | undefined) => {
    setError(null);
    setFile(null);
    if (!f) return;
    if (!/\.(dwg|dxf|pdf)$/i.test(f.name)) return setError('只收 DWG、DXF 或矢量 PDF 图纸（.dwg / .dxf / .pdf）');
    if (f.size > MAX_FLOORPLAN_FILE_BYTES) return setError(`图纸 ${fileSizeText(f.size)}，超过 ${fileSizeText(MAX_FLOORPLAN_FILE_BYTES)}；请设计方只保留 L1–L3 后另存`);
    setFile(f);
  };

  const submit = async () => {
    if (!file || !ready) return;
    setBusy(true);
    setError(null);
    try {
      const contentBase64 = bytesToBase64(await file.arrayBuffer());
      const r = await api.post<{ batch: FloorplanBatch; replayed: boolean }>(
        '/api/admin/floorplans',
        { fileName: file.name, contentBase64, note, sourceKind, sourceNote: sourceNote.trim(), receivedOn, saveOriginal, pdfScale: isPdf ? scaleNum : null },
        { timeoutMs: 180_000 },
      );
      toast(
        r.replayed
          ? { tone: 'info', title: `这份图纸已经转换过（批次 #${r.batch.id}）`, body: '同一份图纸不重复转换，已打开原来那一批' }
          : { tone: 'success', title: `已上传，正在转换（批次 #${r.batch.id}）`, body: 'DWG 大约要半分钟到一分钟，完成后这里自动刷新' },
      );
      setFile(null);
      setNote('');
      setSourceNote('');
      setScale('');
      setSaveOriginal(false);
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
        DWG、ASCII DXF 或 CAD 打印出的矢量 PDF，不超过 {fileSizeText(MAX_FLOORPLAN_FILE_BYTES)}。系统按图层白名单只留墙、柱、门窗、楼梯电梯与房间名、房号，按楼层出底图，从房号文字点围合房间轮廓；
        同一份图纸重传会回到原来那一批。扫描件、文字已转曲的导览图 PDF 转不出来（没有可用的线或房号文字）。
      </p>
      {converting && (
        <Notice tone="info" icon={<Spinner className="size-4 text-lake" />} title={`正在转换「${converting.fileName}」`}>
          {formatDateTime(converting.createdAt)} 开始，DWG 大约要半分钟到一分钟；转换完之前不能再传别的图纸。
        </Notice>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input ref={input} type="file" accept=".dwg,.dxf,.pdf" className="hidden" data-testid="floorplan-file" onChange={(e) => choose(e.target.files?.[0])} />
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
        <div className="space-y-3 rounded-md border border-line bg-paper/50 p-3" data-testid="floorplan-intake">
          <p className="text-[12.5px] font-semibold text-ink-3">入库登记</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="图纸来源">
              <Segmented<FloorplanSourceKind>
                size="sm"
                value={sourceKind ?? ('' as FloorplanSourceKind)}
                onChange={setSourceKind}
                ariaLabel="图纸来源"
                options={FLOORPLAN_SOURCE_KINDS.map((k) => ({ value: k, label: FLOORPLAN_SOURCE_LABELS[k] }))}
              />
            </Field>
            <Field label="版本或说明" htmlFor="fp-source-note" hint="选填，例如 设计方 11 月第 2 版">
              <Input id="fp-source-note" value={sourceNote} maxLength={100} onChange={(e) => setSourceNote(e.target.value)} data-testid="floorplan-source-note" />
            </Field>
            <Field label="收图日期" htmlFor="fp-received" error={receivedOn > session.calendarToday ? '收图日期不能晚于今天' : null}>
              <Input id="fp-received" type="date" max={session.calendarToday} value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} data-testid="floorplan-received" />
            </Field>
            {isPdf && (
              <Field label="图纸比例 1:" htmlFor="fp-scale" hint="选填；不填按页面上的比例文字（如「1:100」），都没有时转换失败" error={scaleOk ? null : `比例要是 1–${PDF_SCALE_MAX} 的整数`}>
                <Input id="fp-scale" inputMode="numeric" value={scale} onChange={(e) => setScale(e.target.value.replace(/[^0-9]/g, ''))} placeholder="100" className="num w-28" data-testid="floorplan-pdf-scale" />
              </Field>
            )}
            <Field label="备注" htmlFor="fp-note" className={isPdf ? '' : 'lg:col-span-2'}>
              <Input id="fp-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="选填" />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" checked={saveOriginal} onChange={(e) => setSaveOriginal(e.target.checked)} className="size-4 accent-pine" data-testid="floorplan-save-original" />
            保存原图纸（存进系统，店主、店总可以下载；不勾只记文件名、大小与摘要）
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" loading={busy} onClick={submit} disabled={!!converting || !ready} data-testid="floorplan-upload-submit">
              上传并转换
            </Button>
            {!sourceKind && <span className="text-[12.5px] text-ink-3">请先选图纸来源</span>}
          </div>
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
        <SectionTitle>底图档案（所有批次，已换下的也能打开）</SectionTitle>
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
                  ? `${b.floorCount} 层 · 编码 ${b.roomCount} 个 · 配上轮廓 ${b.okCount} 个${b.outlineCount ? ` · 补画 ${b.outlineCount} 个` : ''}`
                  : b.status === 'failed'
                    ? '没有结果'
                    : '转换中…'}
              </span>
              <span className="w-full text-[12.5px] text-ink-3 sm:w-auto">
                {registration(b)} · {b.createdByName ?? '—'} {formatDateTime(b.createdAt)} 上传
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
  const list = useFloorplans();
  const invalidate = useInvalidateFloorplans();
  const toast = useToast();
  const [switching, setSwitching] = useState<'activate' | 'restore' | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 补画轮廓（v0.7.19）：正在画的编码与已点的点
  const [drawing, setDrawing] = useState<{ room: FloorplanRoom; points: [number, number][] } | null>(null);
  const [outlineBusy, setOutlineBusy] = useState(false);
  const d = detail.data;
  if (!d) return <Skeleton className="h-96" />;
  const b = d.batch;
  const exceptions = d.rooms.filter((r) => r.status !== 'ok');
  const editable = b.status === 'ready' || b.status === 'active';
  const activeId = list.data?.activeId ?? null;
  const active = activeId !== null ? (list.data?.batches.find((x) => x.id === activeId) ?? null) : null;

  // 带上页面看到的在用批次：超时后迟到的这次请求、别人同时的启用，对不上的服务端拒绝（FLOORPLAN_STALE），
  // 不会把后来启用的那批换下；结果不明或被拒绝时刷新，按最新状态再决定
  const switchTo = async () => {
    if (!switching) return;
    const mode = switching;
    setBusy(true);
    setError(null);
    try {
      const next = await api.post<FloorplanDetail>(`/api/admin/floorplans/${b.id}/${mode}`, {
        expectedActiveId: activeId,
        expectedSeq: list.data?.activationSeq ?? 0,
        reason: reason.trim(),
      });
      await invalidate(next);
      setSwitching(null);
      setReason('');
      toast({ tone: 'success', title: `批次 #${b.id} 已${mode === 'activate' ? '启用' : '换回'}`, body: '房态图、对客导览用这一批底图' });
    } catch (e) {
      setError(
        e instanceof UncertainError
          ? `${mode === 'activate' ? '启用' : '换回'}结果不明（网络中断或服务器很久没回应）：已刷新，看这一批是不是已经「在用」；没有的话再点一次。这次请求要是晚到，而在用的底图已经换过，会被拒绝，不会把后来启用的那批换下。`
          : errorMessage(e),
      );
      setSwitching(null);
      await invalidate();
    } finally {
      setBusy(false);
    }
  };

  const saveOutline = async () => {
    if (!drawing || drawing.points.length < 3) return;
    setOutlineBusy(true);
    setError(null);
    try {
      await api.put(`/api/admin/floorplans/${b.id}/outlines/${drawing.room.code}`, {
        polygon: drawing.points,
        expectedOutlineId: drawing.room.drawn?.id ?? null,
        expectedRev: d?.outlineRev ?? 0,
      });
      toast({ tone: 'success', title: `${drawing.room.code} 已补画轮廓`, body: '房态图、对客导览用补画的轮廓（这一批）' });
      setDrawing(null);
      await invalidate();
    } catch (e) {
      setError(errorMessage(e));
      await invalidate();
    } finally {
      setOutlineBusy(false);
    }
  };
  const voidOutline = async (room: FloorplanRoom) => {
    if (!room.drawn) return;
    setOutlineBusy(true);
    setError(null);
    try {
      await api.post(`/api/admin/floorplans/${b.id}/outlines/${room.code}/void`, { expectedOutlineId: room.drawn.id, expectedRev: d?.outlineRev ?? 0 });
      toast({ tone: 'success', title: `${room.code} 的补画已作废`, body: '房态图上回到只显示位置点' });
      await invalidate();
    } catch (e) {
      setError(errorMessage(e));
      await invalidate();
    } finally {
      setOutlineBusy(false);
    }
  };

  const restoreReasonOk = switching !== 'restore' || reason.trim().length >= 2;

  return (
    <Card className="space-y-4 p-5" data-testid="floorplan-detail">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="text-[16px] font-bold" data-testid="floorplan-detail-title">
          批次 #{b.id} · {b.fileName}
        </h3>
        <Badge tone={STATUS_TONE[b.status]}>{FLOORPLAN_BATCH_LABELS[b.status]}</Badge>
        <span className="flex-1" />
        {b.originalSaved && (
          <Button size="sm" variant="secondary" icon={<Download className="size-4" />} onClick={() => downloadUrl(`/api/admin/floorplans/${b.id}/original`)} data-testid="floorplan-original">
            下载原图纸
          </Button>
        )}
        {(b.status === 'ready' || b.status === 'active' || b.status === 'retired') && (
          <Button size="sm" variant="secondary" icon={<Download className="size-4" />} onClick={() => downloadUrl(`/api/admin/floorplans/${b.id}/geojson`)}>
            下载 spaces.geojson
          </Button>
        )}
        {b.status === 'ready' && (
          <Button size="sm" variant="primary" icon={<CircleCheck className="size-4" />} onClick={() => setSwitching('activate')} data-testid="floorplan-activate">
            启用这一批
          </Button>
        )}
        {b.status === 'retired' && (
          <Button size="sm" variant="primary" icon={<RotateCcw className="size-4" />} onClick={() => setSwitching('restore')} data-testid="floorplan-restore">
            换回这一批
          </Button>
        )}
      </div>
      <Dialog
        open={switching !== null}
        onClose={busy ? () => {} : () => setSwitching(null)}
        title={`${switching === 'restore' ? '换回' : '启用'}批次 #${b.id}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setSwitching(null)} disabled={busy}>
              取消
            </Button>
            <Button variant="primary" loading={busy} disabled={!restoreReasonOk} onClick={switchTo} data-testid="floorplan-activate-confirm">
              {switching === 'restore' ? '换回' : '启用'}
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-[14px] leading-relaxed" data-testid="floorplan-activate-dialog">
          <p>
            {switching === 'restore' ? '换回' : '启用'}「{b.fileName}」：{b.floorCount} 层、编码 {b.roomCount} 个。
            {active ? `现在在用的批次 #${active.id}「${active.fileName}」会换下（留在档案里，以后也能换回）。` : '现在没有在用的底图。'}
          </p>
          {exceptions.length > 0 ? (
            <Notice tone="warning" title={`有 ${exceptions.length} 个编码没配上轮廓`}>
              {exceptions.map((r) => `${r.code}${r.drawn ? '（已补画）' : ''}`).join('、')}：没补画的在房态图上只显示位置点；可以在这一批的底图上补画，或请设计方改图后重新上传。
            </Notice>
          ) : (
            <p className="text-ink-2">所有编码都配上了轮廓。</p>
          )}
          {(switching === 'restore' || active) && (
            <Field
              label={switching === 'restore' ? '换回的原因' : `批次 #${active?.id} 为什么换下（选填）`}
              htmlFor="fp-switch-reason"
              hint={switching === 'restore' ? '必填，记进在用历史，例如 新图纸有误，先用回上一版' : '记进在用历史，例如 设计方 11 月新版'}
            >
              <Input id="fp-switch-reason" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} data-testid="floorplan-switch-reason" />
            </Field>
          )}
        </div>
      </Dialog>
      <p className="text-[13px] text-ink-2" data-testid="floorplan-registration">
        入库登记：{registration(b)}
        {b.pdfScale ? ` · PDF 比例 1:${b.pdfScale}` : ''}
        {b.originalSaved ? ' · 原图纸已保存' : ' · 原图纸没保存（只记摘要）'}
      </p>
      <p className="text-[13px] text-ink-2">
        {fileSizeText(b.fileBytes)} · {b.fileFormat.toUpperCase()} · {b.createdByName ?? '—'} {formatDateTime(b.createdAt)} 上传
        {b.finishedAt && ` · 读图 ${seconds(b.readMs)}、转换 ${seconds(b.convertMs)}`}
        {d.report?.worker?.peakRssMb ? ` · 内存峰值 ${d.report.worker.peakRssMb} MB` : ''}
        {b.activatedAt && ` · ${b.activatedByName ?? '—'} ${formatDateTime(b.activatedAt)} 启用`}
        {b.retiredAt && ` · ${b.retiredByName ?? '—'} ${formatDateTime(b.retiredAt)} 换下${b.retireReason ? `（${b.retireReason}）` : ''}`}
        {b.note && ` · 备注：${b.note}`}
      </p>
      {b.status === 'retired' && (
        <Notice tone="info" title="已换下的批次只读">
          底图、轮廓、例外清单、比对与转换报告照样能看；要用回这一批请点「换回这一批」（写原因）。
        </Notice>
      )}
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
      {d.floors.length > 0 && (
        <PlanViewer
          floors={d.floors}
          rooms={d.rooms}
          drawing={drawing}
          onPoint={(p) => setDrawing((cur) => (cur && cur.points.length < MAX_OUTLINE_POINTS ? { ...cur, points: [...cur.points, p] } : cur))}
        />
      )}
      {drawing && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-yuzu-deep/30 bg-yuzu-tint px-4 py-3 text-[13px]" data-testid="floorplan-outline-editor">
          <span className="font-semibold">
            补画 {drawing.room.code}（{drawing.room.floorCode}）：在底图上按墙角顺序依次点，已点 {drawing.points.length} 个
          </span>
          <span className="flex-1" />
          <Button size="sm" variant="ghost" icon={<Undo2 className="size-4" />} disabled={!drawing.points.length || outlineBusy} onClick={() => setDrawing({ ...drawing, points: drawing.points.slice(0, -1) })}>
            撤销一点
          </Button>
          <Button size="sm" variant="ghost" disabled={outlineBusy} onClick={() => setDrawing(null)}>
            取消
          </Button>
          <Button size="sm" variant="primary" loading={outlineBusy} disabled={drawing.points.length < 3} onClick={saveOutline} data-testid="floorplan-outline-save">
            保存轮廓
          </Button>
        </div>
      )}
      {(b.status === 'ready' || b.status === 'active' || b.status === 'retired') && (
        <>
          <Exceptions
            rooms={exceptions}
            total={d.rooms.length}
            editable={editable && !outlineBusy}
            drawingCode={drawing?.room.code ?? null}
            onDraw={(room) => {
              setError(null);
              setDrawing({ room, points: [] });
            }}
            onVoid={voidOutline}
          />
          <LedgerDiffView diff={d.ledgerDiff} title="与现在的空间台账比对（以台账为准，不按图纸改台账）" testId="floorplan-ledger-diff" />
          {d.activationLedgerDiff && (
            <details className="rounded-md border border-line px-4 py-3" data-testid="floorplan-ledger-at-activation">
              <summary className="cursor-pointer text-[13.5px] font-semibold">
                {formatDateTime(d.activationLedgerDiff.at)} {d.activationLedgerDiff.kind === 'restore' ? '换回' : '启用'}时的台账比对
              </summary>
              <div className="mt-3">
                <LedgerDiffView diff={d.activationLedgerDiff.diff} title="" testId="floorplan-ledger-diff-then" />
              </div>
            </details>
          )}
          <BatchDiffView detail={d} />
        </>
      )}
      {d.history.length > 0 && (
        <div className="space-y-1.5" data-testid="floorplan-batch-history">
          <SectionTitle>这一批的在用历史</SectionTitle>
          <ul className="space-y-1 text-[13px] text-ink-2">
            {d.history.map((h) => (
              <li key={h.id}>
                {formatDateTime(h.at)} · {FLOORPLAN_ACTIVATION_LABELS[h.kind]} · {h.staffName ?? '—'}
                {h.reason ? ` · ${h.reason}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
      {d.report && <ReportView detail={d} />}
    </Card>
  );
}

function PlanViewer({
  floors,
  rooms,
  drawing = null,
  onPoint,
}: {
  floors: FloorplanFloor[];
  rooms: FloorplanRoom[];
  /** 补画轮廓（v0.7.19）：正在画的编码与已点的点；画的时候点底图加一个点 */
  drawing?: { room: FloorplanRoom; points: [number, number][] } | null;
  onPoint?: (p: [number, number]) => void;
}) {
  // 默认看编码最多的一层
  const busiest = useMemo(() => {
    const count = (code: string) => rooms.filter((r) => r.floorCode === code).length;
    return [...floors].sort((a, b) => count(b.code) - count(a.code))[0]!.code;
  }, [floors, rooms]);
  const [floorCode, setFloorCode] = useState(busiest);
  const [zoom, setZoom] = useState(1);
  const [focus, setFocus] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  // 画的时候固定在那个编码的楼层
  const floor = floors.find((f) => f.code === (drawing ? drawing.room.floorCode : floorCode)) ?? floors[0]!;
  const here = rooms.filter((r) => r.floorCode === floor.code);
  const font = Math.max(floor.width, floor.height) / 90;
  const picked = here.find((r) => r.code === focus) ?? null;
  const clickAt = (e: MouseEvent<SVGSVGElement>) => {
    if (!drawing || !onPoint || !svgRef.current) return;
    const ctm = svgRef.current.getScreenCTM();
    if (!ctm) return;
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    onPoint([Math.max(0, Math.min(floor.width, Math.round(pt.x))), Math.max(0, Math.min(floor.height, Math.round(pt.y)))]);
  };
  return (
    <div className="space-y-2" data-testid="floorplan-viewer">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<string>
          size="sm"
          value={floor.code}
          onChange={(v) => {
            if (drawing) return;
            setFloorCode(v);
            setFocus(null);
          }}
          ariaLabel="楼层"
          options={floors.map((f) => ({ value: f.code, label: f.title ? `${f.code} ${f.title}` : f.code }))}
        />
        <span className="text-[12.5px] text-ink-3">
          编码 {here.length} 个（配上轮廓 {here.filter((r) => r.status === 'ok').length} 个{here.some((r) => r.drawn) ? `，补画 ${here.filter((r) => r.drawn).length} 个` : ''}）· 底图 {fileSizeText(floor.svgBytes)}
        </span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" icon={<Minus className="size-4" />} aria-label="缩小" onClick={() => setZoom((z) => Math.max(1, z / 1.5))} disabled={zoom <= 1} />
        <Button size="sm" variant="ghost" icon={<Scan className="size-4" />} aria-label="适应宽度" onClick={() => setZoom(1)} disabled={zoom === 1} />
        <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} aria-label="放大" onClick={() => setZoom((z) => Math.min(8, z * 1.5))} disabled={zoom >= 8} />
      </div>
      <div className="max-h-[70vh] overflow-auto rounded-md border border-line bg-white" data-testid="floorplan-canvas">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${floor.width} ${floor.height}`}
          style={{ width: `${zoom * 100}%`, display: 'block' }}
          role="img"
          aria-label={`${floor.code} 底图与房间轮廓`}
          className={cn(drawing && 'cursor-crosshair')}
          onClick={clickAt}
          data-testid="floorplan-svg"
        >
          <image href={floor.svgUrl} x={0} y={0} width={floor.width} height={floor.height} />
          {here.map((r) =>
            r.polygon && r.code !== drawing?.room.code ? (
              <polygon
                key={r.code}
                points={r.polygon.map((p) => p.join(',')).join(' ')}
                className={cn(
                  drawing ? 'pointer-events-none' : 'cursor-pointer',
                  r.drawn ? 'stroke-yuzu-deep' : 'stroke-pine',
                  focus === r.code ? 'fill-yuzu/40' : r.drawn ? 'fill-yuzu/20 hover:fill-yuzu/35' : 'fill-pine/15 hover:fill-pine/30',
                )}
                strokeWidth={1.5}
                strokeDasharray={r.drawn ? '6 4' : undefined}
                vectorEffect="non-scaling-stroke"
                onClick={() => !drawing && setFocus(r.code)}
                data-code={r.code}
                data-drawn={r.drawn ? 'true' : undefined}
              />
            ) : null,
          )}
          {drawing && drawing.points.length > 0 && (
            <g className="pointer-events-none" data-testid="floorplan-outline-draft">
              <polyline
                points={[...drawing.points, ...(drawing.points.length >= 3 ? [drawing.points[0]!] : [])].map((p) => p.join(',')).join(' ')}
                className="fill-yuzu/25 stroke-yuzu-deep"
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
              {drawing.points.map((p, i) => (
                <circle key={i} cx={p[0]} cy={p[1]} r={font * 0.25} className="fill-yuzu-deep" />
              ))}
            </g>
          )}
          {here.map((r) => (
            <g
              key={`${r.code}-label`}
              className={cn(drawing ? 'pointer-events-none' : 'cursor-pointer')}
              onClick={() => !drawing && setFocus(r.code)}
              data-testid={`floorplan-room-${r.code}`}
              data-status={r.status}
              data-drawn={r.drawn ? 'true' : undefined}
            >
              {r.status !== 'ok' && !r.drawn && <circle cx={r.labelAt[0]} cy={r.labelAt[1]} r={font * 0.9} className="fill-clay/25 stroke-clay" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
              <text
                x={r.labelAt[0]}
                y={r.labelAt[1]}
                fontSize={font}
                textAnchor="middle"
                dominantBaseline="central"
                className={cn('font-semibold', r.status === 'ok' ? 'fill-pine' : r.drawn ? 'fill-yuzu-deep' : 'fill-clay')}
                style={{ paintOrder: 'stroke', stroke: 'white', strokeWidth: font / 6 }}
              >
                {r.code}
              </text>
            </g>
          ))}
        </svg>
      </div>
      {picked && !drawing && (
        <p className="text-[13px] text-ink-2" data-testid="floorplan-focus">
          <span className="font-semibold text-ink">{picked.code}</span> · {picked.label} · {FLOORPLAN_ROOM_LABELS[picked.status]}
          {picked.drawn && ` · 手工补画（${picked.drawn.byName ?? '—'} ${formatDateTime(picked.drawn.at)}）`}
          {picked.areaM2 !== null && ` · 约 ${picked.areaM2} ㎡`}
          {picked.mergedWith.length > 0 && ` · 与 ${picked.mergedWith.join('、')} 连成一片`}
        </p>
      )}
    </div>
  );
}

function Exceptions({
  rooms,
  total,
  editable,
  drawingCode,
  onDraw,
  onVoid,
}: {
  rooms: FloorplanRoom[];
  total: number;
  editable: boolean;
  drawingCode: string | null;
  onDraw: (room: FloorplanRoom) => void;
  onVoid: (room: FloorplanRoom) => void;
}) {
  if (!rooms.length) {
    return (
      <Notice tone="success" title={`${total} 个编码都配上了轮廓`}>
        没有要人工核对的例外。
      </Notice>
    );
  }
  const drawn = rooms.filter((r) => r.drawn).length;
  return (
    <div className="space-y-2" data-testid="floorplan-exceptions">
      <SectionTitle>
        例外 {rooms.length} 个（{total} 个编码里没配上轮廓的，人工只核对这些{drawn ? `；已补画 ${drawn} 个` : ''}）
      </SectionTitle>
      <ul className="divide-y divide-line rounded-md border border-line">
        {rooms.map((r) => (
          <li key={`${r.floorCode}-${r.code}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5 text-[13px]" data-testid={`floorplan-exception-${r.code}`}>
            <span className="w-14 font-semibold">{r.code}</span>
            <span className="text-ink-3">{r.floorCode}</span>
            <Badge tone="clay">{FLOORPLAN_ROOM_LABELS[r.status]}</Badge>
            {r.drawn && <Badge tone="yuzu">已补画 · {r.drawn.byName ?? '—'}</Badge>}
            {r.mergedWith.length > 0 && <span className="text-ink-2">与 {r.mergedWith.join('、')}</span>}
            <span className="min-w-0 flex-1 text-ink-3">{r.label}</span>
            {editable && r.status !== 'duplicate' && (
              <span className="flex gap-1.5">
                <Button size="sm" variant="secondary" icon={<PenLine className="size-3.5" />} disabled={drawingCode !== null} onClick={() => onDraw(r)} data-testid={`floorplan-draw-${r.code}`}>
                  {r.drawn ? '重画' : '补画轮廓'}
                </Button>
                {r.drawn && (
                  <Button size="sm" variant="ghost" disabled={drawingCode !== null} onClick={() => onVoid(r)} data-testid={`floorplan-undraw-${r.code}`}>
                    作废补画
                  </Button>
                )}
              </span>
            )}
            {r.status !== 'ok' && !r.drawn && <p className="w-full text-[12.5px] leading-relaxed text-ink-2">{FLOORPLAN_ROOM_HINTS[r.status]}{r.status !== 'duplicate' ? '；也可以在这一批的底图上补画轮廓' : ''}</p>}
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

function LedgerDiffView({ diff, title, testId }: { diff: FloorplanLedgerDiff | null; title: string; testId: string }) {
  if (!diff) return null;
  const none = !diff.onlyDrawing.length && !diff.onlyLedger.length && !diff.floorMismatch.length && !diff.labelChanged.length;
  return (
    <div className="space-y-2" data-testid={testId}>
      {title && <SectionTitle>{title}</SectionTitle>}
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
  const none = !diff.added.length && !diff.removed.length && !diff.renamed.length && !diff.moved.length && !diff.floorChanged.length;
  const label = detail.batch.status === 'active' ? '与它换下的那一批' : '与在用的那一批';
  return (
    <div className="space-y-2" data-testid="floorplan-batch-diff">
      <SectionTitle>
        {label}（#{diff.againstBatchId}）比对：房间增减、编码变更
      </SectionTitle>
      {none && <Notice tone="success">房间与编码没有变化。</Notice>}
      {diff.floorChanged.length > 0 && (
        <DiffRow title={`换了楼层 ${diff.floorChanged.length} 个`} hint="同一个编码在两批图上的楼层不同">
          <CodeChips tone="clay" items={diff.floorChanged.map((x) => `${x.code}：${x.from} → ${x.to}`)} />
        </DiffRow>
      )}
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
