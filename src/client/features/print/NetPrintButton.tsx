import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import { DEVICE_ERROR_LABELS, DEVICE_STATUS_LABELS, type DeviceErrorCode, type DeviceJob } from '@shared/devices';
import { PRINT_DOC_LABELS, type PrintDoc, type PrintPrinter } from '@shared/print';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, useErpPending } from '../../lib/erpPending';
import { useCan, useSession } from '../../lib/session';
import { cn, uuid } from '../../lib/utils';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Notice, Skeleton } from '../../components/ui';

// 业务单据打到小票机（v0.7.28 ⑥，docs/SCHEDULE_FINISH.md 第 7 节，N7）：浏览器打印按钮旁边的「打到小票机」。
// 选一台网口小票打印机（本机记住上次选的），服务端排好单据内容、按台排队打印；打印机离线、缺纸时进「等打印机恢复」，
// 恢复后自动补打（最多等 30 分钟）。提交带操作编号：没收到结果时同 ERP 一套查回、原样重提或确认作废，同一编号只打一张。

const PRINTER_KEY = 'yuzu.netprint.printer';
const readPrinter = (): number | null => {
  try {
    const v = Number(localStorage.getItem(PRINTER_KEY));
    return Number.isInteger(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
};
const rememberPrinter = (id: number) => {
  try {
    localStorage.setItem(PRINTER_KEY, String(id));
  } catch {
    // 记不住只是下次要重新选，不影响打印
  }
};

const docKey = (doc: PrintDoc) => (doc.type === 'settlement' ? `${doc.type}:${doc.date}` : `${doc.type}:${doc.id}`);
const waitText = (code: DeviceErrorCode | null) => (code ? DEVICE_ERROR_LABELS[code] : '打印机暂时连不上');

/** 浏览器打印按钮旁边的「打到小票机」：有「打印单据到小票机」权限才显示 */
export function NetPrintButton({ doc, docName, size = 'md', testId }: { doc: PrintDoc; docName?: string; size?: 'sm' | 'md' | 'lg'; testId?: string }) {
  const can = useCan();
  const session = useSession();
  const [open, setOpen] = useState(false);
  // 打印方式是「本机打印」（店主 2026-11-10 默认：连接打印机由各自的电脑负责）时只留浏览器打印
  if (!can('print.network') || session.rules.printMode === 'local') return null;
  return (
    <>
      <Button size={size} variant="ghost" icon={<Printer className="size-4" />} onClick={() => setOpen(true)} data-testid={testId}>
        打到小票机
      </Button>
      {open && <NetPrintDialog doc={doc} docName={docName ?? PRINT_DOC_LABELS[doc.type]} onClose={() => setOpen(false)} />}
    </>
  );
}

function NetPrintDialog({ doc, docName, onClose }: { doc: PrintDoc; docName: string; onClose: () => void }) {
  const toast = useToast();
  const session = useSession();
  const qc = useQueryClient();
  const printers = useQuery({ queryKey: ['print', 'printers'], queryFn: () => api.get<PrintPrinter[]>('/api/print/printers'), refetchInterval: 4_000 });
  const [chosen, setChosen] = useState<number | null>(readPrinter);
  const [busy, setBusy] = useState(false);
  const pending = useErpPending(['doc_print']).some((p) => (p.body as { doc?: PrintDoc } | null)?.doc && docKey((p.body as { doc: PrintDoc }).doc) === docKey(doc));
  const list = printers.data ?? [];
  const current = list.find((p) => p.id === chosen) ?? (list.length === 1 ? list[0] : undefined);

  const run = async (printer: PrintPrinter) => {
    setBusy(true);
    rememberPrinter(printer.id);
    try {
      const key = uuid();
      let job: DeviceJob;
      try {
        job = await sendErpOp<DeviceJob>({
          key,
          type: 'doc_print',
          url: '/api/print/jobs',
          body: { clientKey: key, deviceId: printer.id, doc },
          summary: `${docName} → ${printer.name}（${printer.code}）`,
          staffName: session.staff.displayName,
        });
      } catch (e) {
        if (e instanceof UncertainError) toast({ tone: 'info', title: `${docName}：没收到结果`, body: '记录留在本机，在这里或「设备」页上方查回、按原内容重新提交或确认作废，先别重复打' });
        else toast({ tone: 'error', title: `${docName}没打出去`, body: errorMessage(e) });
        return;
      }
      // 任务已经建好：接着查结果（断网、超时的接着查；服务端明确拒绝了查询的不再查），最多 20 秒
      let lookupError: unknown = null;
      const end = Date.now() + 20_000;
      while ((job.status === 'queued' || job.status === 'sending') && Date.now() < end) {
        await new Promise((r) => setTimeout(r, 700));
        try {
          job = await api.get<DeviceJob>(`/api/print/jobs/${job.id}`);
          lookupError = null;
        } catch (e) {
          lookupError = e;
          if (!(e instanceof UncertainError)) break;
        }
      }
      void qc.invalidateQueries({ queryKey: ['print'] });
      if (job.status === 'done') toast({ tone: 'success', title: `${printer.name}：已打出${docName}` });
      else if (job.status === 'waiting')
        toast({
          tone: 'info',
          title: `${printer.name}：${waitText(job.waitCode)}，${docName}已排队`,
          body: `打印机恢复后自动补打（最多等 ${session.rules.printWaitMinutes} 分钟）。可以在「设备」页的打印队列里看或取消，先别重复打`,
        });
      else if (job.status === 'failed') toast({ tone: 'error', title: `${printer.name}：${docName}没打出来`, body: `${job.errorCode ? DEVICE_ERROR_LABELS[job.errorCode] : ''}${job.errorMessage ? `（${job.errorMessage}）` : ''}` });
      else if (job.status === 'canceled') toast({ tone: 'info', title: `${docName}的打印任务已取消` });
      else if (lookupError) toast({ tone: 'info', title: `${printer.name}：已提交，查不到结果`, body: `打印任务 #${job.id}（${errorMessage(lookupError)}）。到「设备」页的打印队列里看，先别重复打` });
      else toast({ tone: 'info', title: `${printer.name}：${docName}还在排队`, body: `打印任务 #${job.id}：到「设备」页的打印队列里看` });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${docName}打到小票机`}
      description="打印机离线或缺纸时先排队，恢复后自动补打（最多等 30 分钟）。这台电脑记住上次选的打印机。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" icon={<Printer className="size-4" />} loading={busy} disabled={!current || pending} onClick={() => current && void run(current)} data-testid="netprint-submit">
            打印
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="netprint-dialog">
        <ErpPendingPanel types={['doc_print']} className="space-y-2" />
        {pending && <Notice tone="warning">这张单据上次打印还没收到结果，先在上面查回或确认作废，再重新打。</Notice>}
        {printers.isLoading ? (
          <Skeleton className="h-24" />
        ) : printers.error ? (
          <Notice tone="error">读不到打印机：{errorMessage(printers.error)}</Notice>
        ) : list.length === 0 ? (
          <Notice tone="info">还没有配好的小票打印机：店主或店总在「后台 → 设备」登记网口打印机、填上 IP 与端口后，这里就能选。现在可以先用浏览器打印。</Notice>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line" role="radiogroup" aria-label="选打印机">
            {list.map((p) => {
              const active = current?.id === p.id;
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setChosen(p.id)}
                    className={cn('flex w-full items-center gap-3 px-3 py-2.5 text-left', active ? 'bg-yuzu-soft/60' : 'hover:bg-paper')}
                    data-testid={`netprint-printer-${p.code}`}
                  >
                    <span className={cn('size-3 shrink-0 rounded-full border', active ? 'border-yuzu bg-yuzu' : 'border-line-strong')} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-semibold">
                        {p.name} <span className="font-mono text-[12px] font-normal text-ink-3">{p.code}</span>
                      </span>
                      <span className="block truncate text-[12px] text-ink-3">
                        {p.area} · {p.paperWidth} 毫米
                        {p.statusCode ? ` · ${DEVICE_ERROR_LABELS[p.statusCode as DeviceErrorCode] ?? p.statusCode}` : ''}
                        {p.waiting > 0 ? ` · 还有 ${p.waiting} 张没打完` : ''}
                      </span>
                    </span>
                    <Badge tone={p.status === 'online' ? 'pine' : p.status === 'error' ? 'clay' : p.status === 'offline' ? 'neutral' : 'yuzu'}>{DEVICE_STATUS_LABELS[p.status]}</Badge>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {current && current.status !== 'online' && current.status !== 'unknown' && (
          <p className="text-[12px] text-ink-3" data-testid="netprint-wait-hint">
            这台现在{DEVICE_STATUS_LABELS[current.status]}：打印后先排队，恢复后自动补打。急用请选别的打印机或用浏览器打印。
          </p>
        )}
      </div>
    </Dialog>
  );
}

/** 设备页的打印队列（v0.7.28）：还没打完的单据（排队、发送中、等打印机恢复），可以取消自己提交的（维护设备的人能取消全部） */
export function PrintQueueCard() {
  const can = useCan();
  const session = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const queue = useQuery({ queryKey: ['print', 'queue'], queryFn: () => api.get<DeviceJob[]>('/api/print/queue'), refetchInterval: 2_000, enabled: can('print.network') });
  const [canceling, setCanceling] = useState<number | null>(null);
  if (!can('print.network') || !queue.data || queue.data.length === 0) return null;
  const cancel = async (j: DeviceJob) => {
    setCanceling(j.id);
    try {
      await api.post(`/api/print/jobs/${j.id}/cancel`, {});
      toast({ tone: 'success', title: `已取消：${j.docLabel ?? `打印任务 #${j.id}`}` });
    } catch (e) {
      toast({ tone: 'error', title: '没取消成功', body: errorMessage(e) });
    } finally {
      setCanceling(null);
      void qc.invalidateQueries({ queryKey: ['print'] });
    }
  };
  return (
    <div className="rounded-lg border border-line bg-card p-4" data-testid="print-queue">
      <h2 className="mb-1 text-[15px] font-bold">打印队列 · {queue.data.length} 张没打完</h2>
      <p className="mb-2 text-[12px] text-ink-3">打印机离线或缺纸时单据在这里排队，恢复后按提交顺序自动补打；等超过 {session.rules.printWaitMinutes} 分钟的不再打。</p>
      <ul className="divide-y divide-line text-[13px]">
        {queue.data.map((j) => (
          <li key={j.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2" data-testid={`print-queue-${j.id}`} data-status={j.status}>
            <span className="min-w-0 flex-1">
              <span className="font-semibold">{j.docLabel}</span> → {j.deviceName}
              <span className="block text-[12px] text-ink-3">
                {j.status === 'waiting' ? `等打印机恢复（${waitText(j.waitCode)}）` : j.status === 'sending' ? '发送中' : '排队'} · {j.createdByName} · #{j.id}
              </span>
            </span>
            {j.status !== 'sending' && (j.createdById === session.staff.id || can('device.manage')) && (
              <Button size="sm" variant="ghost" loading={canceling === j.id} onClick={() => void cancel(j)} data-testid={`print-queue-cancel-${j.id}`}>
                取消
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
