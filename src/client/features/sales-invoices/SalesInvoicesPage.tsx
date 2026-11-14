// ERP「财务 → 开票」（8.0.21，docs/FINANCE_V8021.md 第 3 节，CW-B）：处理客人的开票申请。
// 登记已开（手工开好、填号码、可传 PDF）；交给开票服务商开（适配器，8.0.21 只有模拟的）；驳回、作废（红冲后重新申请）。

import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileOutput, Send } from 'lucide-react';
import { formatAmount } from '@shared/money';
import {
  INVOICE_SOURCE_LABELS,
  INVOICE_TITLE_TYPE_LABELS,
  SALES_INVOICE_KIND_LABELS,
  type SalesInvoice,
  type SalesInvoiceList,
} from '@shared/sales-invoices';
import { api, errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { cn, formatDateTime } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { Dialog, Sheet } from '../../components/Overlay';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, Skeleton } from '../../components/ui';
import { ErpPage } from '../erp/ErpHome';
import { SalesInvoiceStatus } from './InvoiceRequest';

const VIEWS = [
  { key: 'requested', label: '申请中' },
  { key: 'issued', label: '已开' },
  { key: 'red', label: '要红冲' },
  { key: 'all', label: '全部' },
] as const;
type View = (typeof VIEWS)[number]['key'];
const KEY = ['sales-invoices'] as const;

export function SalesInvoicesPage() {
  const [params, setParams] = useSearchParams();
  const view = (VIEWS.find((v) => v.key === params.get('view'))?.key ?? 'requested') as View;
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const list = useQuery({
    queryKey: [...KEY, 'list', view, q.trim()],
    queryFn: () => api.get<SalesInvoiceList>(`/api/erp/sales-invoices?status=${view}&q=${encodeURIComponent(q.trim())}`),
  });
  const counts = list.data?.counts;
  return (
    <ErpPage
      title="开票"
      description="客人的开票申请：前台在结账记录、充值记录上申请，协议单位按回款申请。可开金额只算实收（储值在充值时开、挂账按回款开）。同一笔只能开一次，开错了作废后重新申请。"
    >
      <div className="space-y-4" data-testid="sales-invoices-page">
        {list.data && (
          <Notice tone={list.data.providerMode === 'off' ? 'info' : 'warning'} title={list.data.providerMode === 'off' ? '开票服务商还没接（等服务商账号联调）' : list.data.providerMode === 'mock' ? '开票服务商是模拟的（只在开发、测试环境）' : '开票服务商已接'}>
            {list.data.providerMode === 'off' ? '在开票系统里开好以后，点「登记已开」填发票号码、传 PDF。' : '「交给服务商开」开出来的号码与 PDF 都写着「模拟」，不是真发票。'}
          </Notice>
        )}
        <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="开票视图">
          {VIEWS.map((v) => {
            const n = v.key === 'requested' ? counts?.requested : v.key === 'red' ? counts?.redFlag : undefined;
            return (
              <button
                key={v.key}
                type="button"
                role="tab"
                aria-selected={view === v.key}
                onClick={() => setParams(v.key === 'requested' ? {} : { view: v.key }, { replace: true })}
                className={cn('h-9 rounded-full px-3.5 text-[13px] font-semibold', view === v.key ? 'bg-pine text-paper' : 'bg-paper-2 text-ink-2 hover:text-ink')}
                data-testid={`sales-invoice-view-${v.key}`}
              >
                {v.label}
                {!!n && <span className={cn('num ml-1.5', v.key === 'red' && view !== v.key && 'text-clay')}>{n}</span>}
              </button>
            );
          })}
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="申请号、单号、抬头、发票号码" fullWidth={false} className="ml-auto h-9 w-60" aria-label="搜索开票申请" />
        </div>
        {!list.data ? (
          list.error ? <Notice tone="error" title={errorMessage(list.error)} /> : <Skeleton className="h-60" />
        ) : list.data.rows.length === 0 ? (
          <EmptyState art="leaf" title="没有开票申请" description={view === 'requested' ? '前台申请以后会出现在这里' : '换个视图看看'} />
        ) : (
          <Card className="overflow-hidden">
            <ul className="divide-y divide-line/70">
              {list.data.rows.map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => setOpenId(r.id)} className="grid w-full gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-paper-2/50 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_auto]" data-testid={`sales-invoice-row-${r.requestNo}`}>
                    <span className="min-w-0">
                      <span className="block truncate text-[14px] font-bold">{r.title}</span>
                      <span className="num block truncate text-[12.5px] text-ink-3">
                        {r.requestNo} · {INVOICE_SOURCE_LABELS[r.sourceType]} {r.sourceNo}
                      </span>
                    </span>
                    <span className="text-[12.5px] text-ink-2">
                      <span className="num block font-bold text-ink">¥{formatAmount(r.amountCents)}</span>
                      {SALES_INVOICE_KIND_LABELS[r.invoiceKind]}
                      {r.invoiceNo ? ` · ${r.invoiceNo}` : ''}
                    </span>
                    <SalesInvoiceStatus inv={r} />
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
      <SalesInvoiceSheet id={openId} providerMode={list.data?.providerMode ?? 'off'} onClose={() => setOpenId(null)} />
    </ErpPage>
  );
}

function SalesInvoiceSheet({ id, providerMode, onClose }: { id: number | null; providerMode: SalesInvoiceList['providerMode']; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const detail = useQuery({ queryKey: [...KEY, 'one', id], queryFn: () => api.get<SalesInvoice>(`/api/erp/sales-invoices/${id}`), enabled: id !== null });
  const [issuing, setIssuing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const r = detail.data;
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: KEY });
  };
  const act = async (path: string, body: Record<string, unknown>, ok: string) => {
    if (!r) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/erp/sales-invoices/${r.id}/${path}`, { version: r.version, ...body });
      toast({ tone: 'success', title: ok });
      setRejecting(false);
      setVoiding(false);
      setResetting(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      await refresh();
    }
  };
  const sending = r?.status === 'requested' && r.issuedVia === 'sending';
  return (
    <Sheet open={id !== null} onClose={onClose} label="开票申请" width="w-[min(560px,100vw)]">
      <div className="flex items-center gap-3 border-b border-line px-5 py-4">
        <span className="flex size-8 items-center justify-center rounded-full bg-lake-soft text-lake">
          <FileOutput className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="num text-[16px] font-bold">{r?.requestNo ?? '开票申请'}</p>
          {r && <SalesInvoiceStatus inv={r} />}
        </div>
      </div>
      {!r ? (
        <div className="p-5">
          <Skeleton className="h-40" />
        </div>
      ) : (
        <div className="space-y-4 p-5 text-[13.5px]" data-testid="sales-invoice-sheet">
          <dl className="grid grid-cols-[6em_1fr] gap-x-3 gap-y-1.5">
            <dt className="text-ink-3">来源</dt>
            <dd className="num">
              {INVOICE_SOURCE_LABELS[r.sourceType]} {r.sourceNo}
              {r.sourceVoided && <Badge tone="clay" className="ml-2">已反结账 / 作废</Badge>}
            </dd>
            <dt className="text-ink-3">金额</dt>
            <dd className="num font-bold">¥{formatAmount(r.amountCents)}</dd>
            <dt className="text-ink-3">抬头</dt>
            <dd>
              {r.title}（{INVOICE_TITLE_TYPE_LABELS[r.titleType]}）
            </dd>
            {r.taxNo && (
              <>
                <dt className="text-ink-3">税号</dt>
                <dd className="num">{r.taxNo}</dd>
              </>
            )}
            <dt className="text-ink-3">种类</dt>
            <dd>{SALES_INVOICE_KIND_LABELS[r.invoiceKind]}</dd>
            {(r.email || r.phone) && (
              <>
                <dt className="text-ink-3">接收</dt>
                <dd>{[r.email, r.phone].filter(Boolean).join(' · ')}</dd>
              </>
            )}
            {r.note && (
              <>
                <dt className="text-ink-3">备注</dt>
                <dd>{r.note}</dd>
              </>
            )}
            <dt className="text-ink-3">申请</dt>
            <dd>
              {r.requestedByName} · {formatDateTime(r.requestedAt)}
            </dd>
            {r.status === 'issued' && (
              <>
                <dt className="text-ink-3">发票</dt>
                <dd className="num">
                  {r.invoiceNo} · {r.invoiceDate} · {r.issuedVia === 'manual' ? '手工登记' : r.issuedVia === 'mock' ? '服务商（模拟）' : r.issuedVia}
                </dd>
              </>
            )}
            {r.rejectReason && (
              <>
                <dt className="text-ink-3">驳回</dt>
                <dd>{r.rejectReason}</dd>
              </>
            )}
            {r.voidReason && (
              <>
                <dt className="text-ink-3">作废</dt>
                <dd>
                  {r.voidReason}（{r.voidedByName}）
                </dd>
              </>
            )}
          </dl>
          {r.hasFile && (
            <a href={`/api/erp/sales-invoices/${r.id}/file`} target="_blank" rel="noopener" className="font-semibold text-pine hover:underline">
              看发票 PDF
            </a>
          )}
          {sending && (
            <Notice tone="warning" title="已交给开票服务商，结果还没回来">
              如果确认服务商那边没开出来，可以改回「申请中」再处理。
            </Notice>
          )}
          {r.status === 'issued' && r.sourceVoided && (
            <Notice tone="error" title="来源已反结账或作废">
              这张发票要红冲：在开票系统里作废 / 红冲以后，这里点「作废」写原因；需要的话再按新的结账单重新申请。
            </Notice>
          )}
          {error && <Notice tone="error" title={error} />}
          <div className="flex flex-wrap gap-2">
            {r.status === 'requested' && !sending && (
              <>
                <Button variant="primary" onClick={() => setIssuing(true)} data-testid="sales-invoice-issue">
                  登记已开
                </Button>
                {providerMode !== 'off' && (
                  <Button variant="secondary" icon={<Send className="size-4" />} loading={busy} onClick={() => void act('provider', {}, '服务商已开出')} data-testid="sales-invoice-provider">
                    交给服务商开
                  </Button>
                )}
                <Button variant="ghost" onClick={() => setRejecting(true)} data-testid="sales-invoice-reject">
                  驳回
                </Button>
              </>
            )}
            {sending && (
              <Button variant="secondary" onClick={() => setResetting(true)}>
                改回申请中
              </Button>
            )}
            {(r.status === 'issued' || (r.status === 'requested' && !sending)) && (
              <Button variant="ghost" className="text-clay" onClick={() => setVoiding(true)} data-testid="sales-invoice-void">
                作废
              </Button>
            )}
          </div>
        </div>
      )}
      <IssueDialog open={issuing} inv={r ?? null} onClose={() => setIssuing(false)} onDone={refresh} />
      <ReasonDialog open={rejecting} title="驳回开票申请" description="写清楚原因，前台改好以后可以重新申请。" confirmLabel="驳回" danger busy={busy} onClose={() => setRejecting(false)} onConfirm={(reason) => void act('reject', { reason }, '已驳回')} />
      <ReasonDialog
        open={voiding}
        title={r?.status === 'issued' ? '作废（红冲）这张发票' : '作废开票申请'}
        description={r?.status === 'issued' ? '先在开票系统里红冲 / 作废这张发票，再在这里登记。作废以后这一笔可以重新申请。' : '作废以后这一笔可以重新申请。'}
        confirmLabel="作废"
        danger
        busy={busy}
        onClose={() => setVoiding(false)}
        onConfirm={(reason) => void act('void', { reason }, '已作废')}
      />
      <ReasonDialog
        open={resetting}
        title="改回申请中"
        description="只在确认服务商那边没开出这张发票时用；开出来了又改回，会开出两张。"
        confirmLabel="改回申请中"
        danger
        busy={busy}
        onClose={() => setResetting(false)}
        onConfirm={(reason) => void act('reset-sending', { reason }, '已改回申请中')}
      />
    </Sheet>
  );
}

function IssueDialog({ open, inv, onClose, onDone }: { open: boolean; inv: SalesInvoice | null; onClose: () => void; onDone: () => Promise<void> }) {
  const session = useSession();
  const toast = useToast();
  const [no, setNo] = useState('');
  const [date, setDate] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(open, () => {
    setNo('');
    setDate(session.calendarToday);
    setFile(null);
    setError(null);
  });
  const submit = async () => {
    if (!inv) return;
    setBusy(true);
    setError(null);
    try {
      let pdf: { name: string; data: string } | null = null;
      if (file) {
        if (file.type !== 'application/pdf') throw new Error('只能上传 PDF');
        const buf = new Uint8Array(await file.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        pdf = { name: file.name.slice(0, 80), data: btoa(bin) };
      }
      await api.post(`/api/erp/sales-invoices/${inv.id}/issue`, { version: inv.version, invoiceNo: no.trim(), invoiceDate: date, pdf });
      toast({ tone: 'success', title: '已登记开出', body: no.trim() });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      await onDone();
    }
  };
  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title="登记已开"
      description="在开票系统里开好以后，把发票号码填在这里；可以把电子发票 PDF 一起传上来。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!no.trim() || !date || date > session.calendarToday} onClick={() => void submit()} data-testid="sales-invoice-issue-confirm">
            登记
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="发票号码" htmlFor="si-no">
          <Input id="si-no" value={no} maxLength={40} onChange={(e) => setNo(e.target.value)} className="num h-10" data-autofocus data-testid="si-no" />
        </Field>
        <Field label="开票日" htmlFor="si-date">
          <Input id="si-date" type="date" value={date} max={session.calendarToday} onChange={(e) => setDate(e.target.value)} className="h-10" />
        </Field>
        <Field label="发票 PDF（可选）" htmlFor="si-file" className="sm:col-span-2">
          <input id="si-file" type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-[13px]" />
        </Field>
        {error && <Notice tone="error" title={error} className="sm:col-span-2" />}
      </div>
    </Dialog>
  );
}
