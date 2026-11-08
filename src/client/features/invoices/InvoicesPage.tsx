// 进项发票台账（8.0.3，docs/BUDGET_INVOICES.md 第 3 节，默认 BI07–BI12 待确认）：
// 三单匹配登记的供应商发票、报销单上的专票普票、在这里直接登记的；认证状态与所属期（一次标一批）、认证期限将到期、
// 异常票（只标记）、照片；挂在有效报销单上的不能作废，三单的要货款权限。直接登记先把操作编号存在本机（结果待确认可查回）。

import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { CheckCheck, Download, FileText, Plus, X } from 'lucide-react';
import { taxRateText } from '@shared/expenses';
import {
  CERT_BATCH_MAX,
  CERT_STATUS_LABELS,
  INVOICE_ANOMALY_LABELS,
  INVOICE_SOURCE_LABELS,
  INVOICE_VIEW_LABELS,
  MAX_INVOICE_ATTACHMENTS,
  expectedTaxCents,
  type CertStatus,
  type InputInvoice,
  type InvoiceView,
} from '@shared/invoices';
import { centsToInput, formatAmount, parseYuan } from '@shared/money';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp } from '../../lib/erpPending';
import { useCan, useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { cn, formatDateTime, uuid } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { Money } from '../../components/Money';
import { Dialog, Sheet } from '../../components/Overlay';
import { ReasonDialog } from '../../components/ReasonDialog';
import { ReceiptAttachmentsPanel } from '../../components/ReceiptAttachments';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, MoneyInput, Notice, Select, Skeleton } from '../../components/ui';
import { ErpPage } from '../erp/ErpHome';
import { useExpenseRules } from '../expenses/queries';
import { useSuppliers } from '../inventory/queries';
import { search, useInputInvoice, useInvalidateInvoices, useInvoiceLedger } from './queries';

const VIEWS: InvoiceView[] = ['all', 'pending', 'due', 'certified', 'not_required', 'anomaly', 'voided'];
const CERT_TONE: Record<CertStatus, 'yuzu' | 'pine' | 'neutral'> = { pending: 'yuzu', certified: 'pine', not_required: 'neutral' };

export function InvoicesPage() {
  const can = useCan();
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const view = (VIEWS as string[]).includes(params.get('view') ?? '') ? (params.get('view') as InvoiceView) : 'all';
  const [source, setSource] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [q, setQ] = useState('');
  const filters = { view, source: source || undefined, from: from || undefined, to: to || undefined, q: q.trim() || undefined };
  const ledger = useInvoiceLedger(filters);
  const openId = Number(params.get('invoice')) || null;
  const open = (id: number | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('invoice', String(id));
    else next.delete('invoice');
    setParams(next, { replace: true });
  };
  const setView = (v: InvoiceView) => {
    const next = new URLSearchParams(params);
    next.set('view', v);
    setParams(next, { replace: true });
    setPicked([]);
  };
  const [picked, setPicked] = useState<number[]>([]);
  const [creating, setCreating] = useState(false);
  const [certifying, setCertifying] = useState(false);
  const manage = can('invoice.manage');
  const rows = ledger.data?.invoices ?? [];
  const pendingRows = rows.filter((r) => r.status === 'valid' && r.certStatus === 'pending');
  // 一次最多标 CERT_BATCH_MAX 张（服务端同样限制）：全选只勾前面这些
  const pickable = pendingRows.slice(0, CERT_BATCH_MAX);
  const counts = ledger.data?.counts;

  return (
    <ErpPage
      title="发票台账"
      description="进项发票：三单匹配登记的供应商发票、报销的专票普票、在这里直接登记的。专票勾选认证以后在这里标已认证，认证期限快到的进待办；异常票只标记、不拦。"
      actions={
        <div className="flex flex-wrap gap-2">
          <a href={`/api/erp/invoices/export?${search(filters)}`} download>
            <Button variant="secondary" icon={<Download className="size-4" />}>
              导出
            </Button>
          </a>
          {manage && picked.length > 0 && (
            <Button variant="secondary" icon={<CheckCheck className="size-4" />} onClick={() => setCertifying(true)} data-testid="invoice-certify-batch">
              {`标已认证（${picked.length} 张）`}
            </Button>
          )}
          {manage && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)} data-testid="invoice-new">
              登记发票
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-4" data-testid="invoices-page">
        <ErpPendingPanel types={['supplier_invoice']} onFound={(_, ref) => open(ref.refId)} />
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="台账视图">
          {VIEWS.map((v) => {
            const n = v === 'pending' ? counts?.pending : v === 'due' ? counts?.due : v === 'anomaly' ? counts?.anomaly : undefined;
            return (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                onClick={() => setView(v)}
                className={cn('h-9 rounded-full px-3.5 text-[13px] font-semibold', view === v ? 'bg-pine text-paper' : 'bg-paper-2 text-ink-2 hover:text-ink')}
                data-testid={`invoice-view-${v}`}
              >
                {INVOICE_VIEW_LABELS[v]}
                {!!n && <span className={cn('ml-1.5 num', v === 'due' || v === 'anomaly' ? 'text-clay' : '', view === v && 'text-paper')}>{n}</span>}
              </button>
            );
          })}
        </div>
        <Card className="flex flex-wrap items-end gap-3 p-4">
          <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-3">
            来源
            <Select fullWidth={false} value={source} onChange={(e) => setSource(e.target.value)} className="h-9 w-36" data-testid="invoice-source">
              <option value="">全部</option>
              {(['three_way', 'expense', 'manual'] as const).map((s) => (
                <option key={s} value={s}>
                  {INVOICE_SOURCE_LABELS[s]}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-3">
            开票日从
            <Input type="date" fullWidth={false} value={from} max={to || session.calendarToday} onChange={(e) => setFrom(e.target.value)} className="h-9 w-40" />
          </label>
          <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-3">
            到
            <Input type="date" fullWidth={false} value={to} max={session.calendarToday} onChange={(e) => setTo(e.target.value)} className="h-9 w-40" />
          </label>
          <label className="flex min-w-[180px] flex-1 flex-col gap-1 text-[12.5px] font-semibold text-ink-3">
            号码或开票方
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索" className="h-9" data-testid="invoice-search" />
          </label>
        </Card>
        {ledger.isPending ? (
          <Skeleton className="h-64" />
        ) : ledger.error ? (
          <Notice tone="error" title={errorMessage(ledger.error)} />
        ) : rows.length === 0 ? (
          <EmptyState art="calm" title="没有发票" description={view === 'all' ? '报销登记专票、普票，三单匹配登记供应商发票，或在这里直接登记。' : '这个视图下没有发票。'} />
        ) : (
          <Card className="overflow-hidden">
            {ledger.data?.truncated && (
              <p className="border-b border-line bg-paper-2 px-4 py-2 text-[12.5px] text-ink-3" data-testid="invoice-truncated">
                只列出开票日最新的 {rows.length} 张：缩短开票日范围、换个视图或导出看全部
              </p>
            )}
            {manage && pendingRows.length > 0 && (
              <label className="flex items-center gap-2 border-b border-line px-4 py-2 text-[12.5px] font-semibold text-ink-3">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--color-pine)]"
                  checked={pickable.every((r) => picked.includes(r.id))}
                  onChange={(e) => setPicked(e.target.checked ? pickable.map((r) => r.id) : [])}
                  data-testid="invoice-pick-all"
                />
                {pendingRows.length > pickable.length
                  ? `勾选前 ${pickable.length} 张待认证发票（一次最多 ${CERT_BATCH_MAX} 张）`
                  : `勾选这里列出的待认证发票（${pendingRows.length} 张）`}
              </label>
            )}
            <ul className="divide-y divide-line/70">
              {rows.map((r) => (
                <InvoiceRow
                  key={r.id}
                  r={r}
                  pickable={manage && r.status === 'valid' && r.certStatus === 'pending'}
                  picked={picked.includes(r.id)}
                  onPick={(on) => setPicked((p) => (on ? (p.length < CERT_BATCH_MAX ? [...p, r.id] : p) : p.filter((x) => x !== r.id)))}
                  onOpen={() => open(r.id)}
                />
              ))}
            </ul>
          </Card>
        )}
      </div>
      <InvoiceSheet id={openId} onClose={() => open(null)} />
      <CreateDialog open={creating} onClose={() => setCreating(false)} onCreated={(id) => open(id)} />
      <CertifyDialog open={certifying} ids={picked} onClose={() => setCertifying(false)} onDone={() => setPicked([])} />
    </ErpPage>
  );
}

function certText(r: InputInvoice) {
  if (r.certStatus === 'certified') return `已认证 · ${r.certPeriod}`;
  if (r.certStatus === 'not_required') return '不用认证';
  if (!r.certDueDate) return '待认证';
  return r.certDueInDays! < 0 ? `待认证 · 已过期 ${-r.certDueInDays!} 天` : `待认证 · ${r.certDueDate} 前（${r.certDueInDays} 天）`;
}

function InvoiceRow({ r, pickable, picked, onPick, onOpen }: { r: InputInvoice; pickable: boolean; picked: boolean; onPick: (on: boolean) => void; onOpen: () => void }) {
  return (
    <li className={cn('flex items-start gap-3 px-4 py-3', r.status === 'voided' && 'opacity-60')} data-testid={`invoice-row-${r.invoiceNo}`}>
      {pickable ? (
        <input type="checkbox" className="mt-1 size-4 accent-[var(--color-pine)]" checked={picked} onChange={(e) => onPick(e.target.checked)} aria-label={`勾选 ${r.invoiceNo}`} data-testid={`invoice-pick-${r.id}`} />
      ) : (
        <span className="w-4" />
      )}
      <button type="button" onClick={onOpen} className="grid min-w-0 flex-1 gap-x-3 gap-y-1 text-left sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <span className="min-w-0">
          <span className="num block truncate text-[14px] font-bold">{r.invoiceNo}</span>
          <span className="block truncate text-[12.5px] text-ink-3">
            {r.kindLabel} · {r.issuerName || <span className="text-clay">开票方未填</span>} · {r.invoiceDate}
          </span>
        </span>
        <span className="text-[12.5px]">
          <Money cents={r.totalCents} className="font-bold" />
          <span className="block text-ink-3">
            税额 ¥{formatAmount(r.taxCents)} · {taxRateText(r.taxRateBp)}
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-1.5 text-[12px]">
          {r.status === 'voided' ? <Badge tone="clay">已作废</Badge> : <Badge tone={r.certDueInDays !== null && r.certDueInDays < 0 ? 'clay' : CERT_TONE[r.certStatus]}>{certText(r)}</Badge>}
          <span className="text-ink-3">
            {INVOICE_SOURCE_LABELS[r.source]}
            {r.claim ? ` · ${r.claim.docNo}` : r.pos.length ? ` · ${r.pos.map((p) => p.docNo).join('、')}` : ''}
          </span>
          {r.anomalies.map((a) => (
            <Badge key={a} tone="ember">
              {INVOICE_ANOMALY_LABELS[a]}
            </Badge>
          ))}
          {r.attachmentCount > 0 && <span className="text-ink-3">照片 {r.attachmentCount}</span>}
        </span>
      </button>
    </li>
  );
}

function InvoiceSheet({ id, onClose }: { id: number | null; onClose: () => void }) {
  const can = useCan();
  const session = useSession();
  const toast = useToast();
  const invalidate = useInvalidateInvoices();
  const inv = useInputInvoice(id);
  const r = inv.data;
  const [certStatus, setCertStatus] = useState<CertStatus>('pending');
  const [period, setPeriod] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voiding, setVoiding] = useState(false);
  useResetOnOpen(!!r, () => {
    setCertStatus(r?.certStatus ?? 'pending');
    setPeriod(r?.certPeriod ?? session.calendarToday.slice(0, 7));
    setNote(r?.certNote ?? '');
    setError(null);
  });
  const manage = can('invoice.manage');
  const saveCert = async () => {
    if (!r) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/erp/invoices/${r.id}/cert`, { status: certStatus, period: certStatus === 'certified' ? period : null, note: note.trim(), version: r.certVersion });
      toast({ tone: 'success', title: `${r.invoiceNo} · ${CERT_STATUS_LABELS[certStatus]}` });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      await invalidate();
    }
  };
  const doVoid = async (reason: string) => {
    if (!r) return;
    setBusy(true);
    try {
      await api.post(`/api/erp/invoices/${r.id}/void`, { reason });
      toast({ tone: 'success', title: `发票 ${r.invoiceNo} 已作废` });
      setVoiding(false);
    } catch (e) {
      toast({ tone: 'error', title: '没有作废', body: errorMessage(e) });
    } finally {
      setBusy(false);
      await invalidate();
    }
  };
  return (
    <Sheet open={!!id} onClose={onClose} label="发票" width="w-[min(560px,100vw)]">
      <div className="flex items-center gap-3 border-b border-line px-5 py-4">
        <span className="flex size-8 items-center justify-center rounded-full bg-lake-soft text-lake">
          <FileText className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="num text-[16px] font-bold">{r?.invoiceNo ?? '发票'}</p>
          {r && (
            <p className="text-[12.5px] text-ink-3">
              {r.kindLabel} · 登记 {r.createdByName} {formatDateTime(r.createdAt)}
            </p>
          )}
        </div>
        <button type="button" onClick={onClose} className="rounded-md p-1.5 text-ink-3 hover:bg-paper-2" aria-label="关闭">
          <X className="size-5" />
        </button>
      </div>
      <div className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4" data-testid="invoice-sheet">
        {!r ? (
          inv.error ? <Notice tone="error" title={errorMessage(inv.error)} /> : <Skeleton className="h-64" />
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
              <dt className="text-ink-3">开票方</dt>
              <dd>{r.issuerName || <span className="text-clay">未填</span>}</dd>
              <dt className="text-ink-3">开票日</dt>
              <dd>{r.invoiceDate}</dd>
              <dt className="text-ink-3">价税合计</dt>
              <dd>
                <Money cents={r.totalCents} className="font-bold" />
              </dd>
              <dt className="text-ink-3">税额 · 税率</dt>
              <dd>
                ¥{formatAmount(r.taxCents)} · {taxRateText(r.taxRateBp)}
                <span className="ml-1 text-[12px] text-ink-4">（按税率算 ¥{formatAmount(expectedTaxCents(r.totalCents, r.taxRateBp))}）</span>
              </dd>
              <dt className="text-ink-3">来源</dt>
              <dd>{INVOICE_SOURCE_LABELS[r.source]}</dd>
              <dt className="text-ink-3">关联单据</dt>
              <dd className="space-x-2">
                {r.claim && (
                  <Link className="font-semibold text-lake" to={`/erp/expenses?claim=${r.claim.id}`}>
                    {r.claim.docNo}
                  </Link>
                )}
                {r.pos.map((p) => (
                  <span key={p.id} className="num">
                    {p.docNo} ¥{formatAmount(p.amountCents)}
                  </span>
                ))}
                {!r.claim && r.pos.length === 0 && <span className="text-ink-3">没有</span>}
              </dd>
              {r.note && (
                <>
                  <dt className="text-ink-3">备注</dt>
                  <dd>{r.note}</dd>
                </>
              )}
            </dl>
            {r.anomalies.length > 0 && (
              <Notice tone="warning" title={`异常：${r.anomalies.map((a) => INVOICE_ANOMALY_LABELS[a]).join('、')}`} data-testid="invoice-anomalies">
                <span className="text-[12.5px]">只标记、不拦；核对后按实际处理（登错了作废重登）。</span>
              </Notice>
            )}
            {r.status === 'voided' ? (
              <Notice tone="error" title={`已作废：${r.voidReason ?? ''}`}>
                <span className="text-[12.5px]">
                  {r.voidedByName} {r.voidedAt ? formatDateTime(r.voidedAt) : ''}
                </span>
              </Notice>
            ) : (
              <section className="space-y-2 rounded-lg border border-line p-4" data-testid="invoice-cert">
                <h3 className="text-[13px] font-bold text-ink-2">
                  认证：{CERT_STATUS_LABELS[r.certStatus]}
                  {r.certPeriod && ` · 所属期 ${r.certPeriod}`}
                  {r.certDueDate && <span className="ml-1 font-normal text-ink-3">（期限 {r.certDueDate}）</span>}
                </h3>
                {r.certByName && (
                  <p className="text-[12px] text-ink-3">
                    {r.certByName} {r.certAt ? formatDateTime(r.certAt) : ''}
                    {r.certNote && ` · ${r.certNote}`}
                  </p>
                )}
                {manage && (
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Field label="改成" htmlFor="inv-cert-status">
                      <Select id="inv-cert-status" value={certStatus} disabled={busy} onChange={(e) => setCertStatus(e.target.value as CertStatus)} data-testid="invoice-cert-status">
                        {(['pending', 'certified', 'not_required'] as const).map((s) => (
                          <option key={s} value={s}>
                            {CERT_STATUS_LABELS[s]}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    {certStatus === 'certified' && (
                      <Field label="所属期" htmlFor="inv-cert-period">
                        <Input id="inv-cert-period" type="month" value={period} max={session.calendarToday.slice(0, 7)} disabled={busy} onChange={(e) => setPeriod(e.target.value)} className="h-10" data-testid="invoice-cert-period" />
                      </Field>
                    )}
                    <Field label="说明" htmlFor="inv-cert-note">
                      <Input id="inv-cert-note" value={note} maxLength={100} disabled={busy} onChange={(e) => setNote(e.target.value)} placeholder="可选" className="h-10" />
                    </Field>
                    <div className="sm:col-span-3">
                      <Button variant="primary" loading={busy} disabled={certStatus === 'certified' && !period} onClick={() => void saveCert()} data-testid="invoice-cert-save">
                        保存认证
                      </Button>
                    </div>
                  </div>
                )}
                {error && <Notice tone="error" title={error} />}
              </section>
            )}
            <ReceiptAttachmentsPanel
              docId={r.id}
              items={r.attachments}
              canUpload={manage && r.status === 'valid'}
              onChanged={invalidate}
              uploadUrl={`/api/erp/invoices/${r.id}/attachments`}
              title="发票照片或 PDF"
              note="拍照上传，不能删"
              max={MAX_INVOICE_ATTACHMENTS}
              testId="invoice-attachments"
            />
            {r.status === 'valid' && (manage || can('payable.manage')) && (
              <div className="flex justify-end">
                <Button variant="danger" onClick={() => setVoiding(true)} data-testid="invoice-void">
                  作废
                </Button>
              </div>
            )}
          </>
        )}
      </div>
      <ReasonDialog
        open={voiding}
        title={`作废发票 ${r?.invoiceNo ?? ''}`}
        description="登错了作废后重新登记；挂在有效报销单上的要先撤回或冲销报销单。"
        confirmLabel="确认作废"
        danger
        busy={busy}
        testId="invoice-void-dialog"
        onClose={() => setVoiding(false)}
        onConfirm={(reason) => void doVoid(reason)}
      />
    </Sheet>
  );
}

function CreateDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: number) => void }) {
  const session = useSession();
  const toast = useToast();
  const invalidate = useInvalidateInvoices();
  const rules = useExpenseRules();
  const suppliers = useSuppliers();
  const kinds = (rules.data?.invoiceTypes ?? []).filter((t) => t.needsNumber);
  const [kind, setKind] = useState('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [issuer, setIssuer] = useState('');
  const [invoiceDate, setInvoiceDate] = useState('');
  const [total, setTotal] = useState('');
  const [rateBp, setRateBp] = useState<number | null>(null);
  const [tax, setTax] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(open, () => {
    setKind('');
    setInvoiceNo('');
    setSupplierId(null);
    setIssuer('');
    setInvoiceDate(session.calendarToday);
    setTotal('');
    setRateBp(null);
    setTax('');
    setNote('');
    setError(null);
  });
  const def = kinds.find((k) => k.key === kind);
  const totalCents = total.trim() ? parseYuan(total) : null;
  const taxCents = tax.trim() ? parseYuan(tax) : totalCents !== null && rateBp !== null ? expectedTaxCents(totalCents, rateBp) : null;
  const problem = !def
    ? '请选择发票类型'
    : !invoiceNo.trim()
      ? '请填写发票号码'
      : !supplierId && !issuer.trim()
        ? '请选择供应商或填写开票方'
        : !invoiceDate || invoiceDate > session.calendarToday
          ? '开票日不能晚于今天'
          : !totalCents || totalCents <= 0
            ? '请填写价税合计'
            : rateBp === null
              ? '请选择税率'
              : taxCents === null || taxCents > totalCents
                ? '税额格式不对或超过价税合计'
                : null;
  const submit = async () => {
    if (problem) return;
    setBusy(true);
    setError(null);
    const body = {
      clientKey: uuid(),
      kind,
      invoiceNo: invoiceNo.trim(),
      supplierId,
      issuerName: supplierId ? '' : issuer.trim(),
      invoiceDate,
      totalCents,
      taxCents,
      taxRateBp: rateBp,
      note: note.trim(),
    };
    try {
      const r = await sendErpOp<{ invoice: { id: number } }>({
        key: body.clientKey,
        type: 'supplier_invoice',
        url: '/api/erp/invoices',
        body,
        summary: `发票 ${body.invoiceNo} ¥${formatAmount(totalCents!)}`,
        staffName: session.staff.displayName,
      });
      toast({ tone: 'success', title: '发票已登记进台账', body: `${body.invoiceNo} · ¥${formatAmount(totalCents!)}` });
      onClose();
      onCreated(r.invoice.id);
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'error', title: '登记没收到结果', body: '记在页面上方的「结果待确认」里，查回或按原内容重新提交' });
        onClose();
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
      await invalidate();
    }
  };
  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title="登记发票"
      description="先拿到票、后报销，或者别的进项票：登记进台账。之后报销时填同一个号码就直接关联。三单匹配的供应商发票请在「付款」里登记。"
      footer={
        <>
          {problem && <span className="mr-auto text-[12.5px] font-semibold text-clay">{problem}</span>}
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!!problem} onClick={() => void submit()} data-testid="invoice-create-submit">
            登记
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2" data-testid="invoice-create">
        <Field label="发票类型" htmlFor="inv-kind">
          <Select
            id="inv-kind"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              const t = kinds.find((k) => k.key === e.target.value);
              setRateBp(t && t.taxRatesBp.length === 1 ? t.taxRatesBp[0]! : null);
            }}
            data-testid="inv-kind"
          >
            <option value="">选择发票类型</option>
            {kinds.map((k) => (
              <option key={k.key} value={k.key}>
                {k.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="发票号码" htmlFor="inv-no">
          <Input id="inv-no" value={invoiceNo} maxLength={40} onChange={(e) => setInvoiceNo(e.target.value)} className="h-10" data-testid="inv-no" />
        </Field>
        <Field label="供应商" htmlFor="inv-supplier" hint="不是档案里的供应商就填开票方">
          <Select id="inv-supplier" value={supplierId ?? ''} onChange={(e) => setSupplierId(Number(e.target.value) || null)} data-testid="inv-supplier">
            <option value="">不是档案里的供应商</option>
            {suppliers.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="开票方" htmlFor="inv-issuer">
          <Input id="inv-issuer" value={supplierId ? '' : issuer} disabled={!!supplierId} maxLength={60} onChange={(e) => setIssuer(e.target.value)} placeholder={supplierId ? '按供应商' : '发票上的销售方名称'} className="h-10" data-testid="inv-issuer" />
        </Field>
        <Field label="开票日" htmlFor="inv-date">
          <Input id="inv-date" type="date" value={invoiceDate} max={session.calendarToday} onChange={(e) => setInvoiceDate(e.target.value)} className="h-10" data-testid="inv-date" />
        </Field>
        <Field label="价税合计" htmlFor="inv-total">
          <MoneyInput id="inv-total" value={total} onChange={(e) => setTotal(e.target.value)} className="h-10" data-testid="inv-total" />
        </Field>
        <Field label="税率" htmlFor="inv-rate">
          <Select id="inv-rate" value={rateBp ?? ''} disabled={!def} onChange={(e) => setRateBp(e.target.value === '' ? null : Number(e.target.value))} data-testid="inv-rate">
            <option value="">{def ? '选择税率' : '先选发票类型'}</option>
            {def?.taxRatesBp.map((bp) => (
              <option key={bp} value={bp}>
                {taxRateText(bp)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="税额" htmlFor="inv-tax" hint={totalCents && rateBp !== null ? `不填按税率算：¥${formatAmount(expectedTaxCents(totalCents, rateBp))}` : '不填按税率算'}>
          <MoneyInput id="inv-tax" value={tax} onChange={(e) => setTax(e.target.value)} placeholder={totalCents && rateBp !== null ? centsToInput(expectedTaxCents(totalCents, rateBp)) : ''} className="h-10" data-testid="inv-tax" />
        </Field>
        <Field label="备注" htmlFor="inv-note" className="sm:col-span-2">
          <Input id="inv-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="可选" className="h-10" />
        </Field>
        {error && <Notice tone="error" title={error} className="sm:col-span-2" />}
      </div>
    </Dialog>
  );
}

function CertifyDialog({ open, ids, onClose, onDone }: { open: boolean; ids: number[]; onClose: () => void; onDone: () => void }) {
  const session = useSession();
  const toast = useToast();
  const invalidate = useInvalidateInvoices();
  const [period, setPeriod] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(open, () => {
    setPeriod(session.calendarToday.slice(0, 7));
    setNote('');
    setError(null);
  });
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ certified: number; skipped: string[] }>('/api/erp/invoices/cert-batch', { ids, period, note: note.trim() });
      toast({ tone: 'success', title: `已标认证 ${r.certified} 张`, body: r.skipped.length ? `跳过 ${r.skipped.length} 张（已经不是待认证）` : `所属期 ${period}` });
      onDone();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      await invalidate();
    }
  };
  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title={`标已认证（${ids.length} 张）`}
      description="在增值税发票平台勾选认证以后在这里标：填所属期（年月）。标错了可以在发票详情里改回待认证。"
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!period} onClick={() => void submit()} data-testid="invoice-certify-submit">
            标已认证
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="所属期" htmlFor="cert-period">
          <Input id="cert-period" type="month" value={period} max={session.calendarToday.slice(0, 7)} onChange={(e) => setPeriod(e.target.value)} className="h-10" data-testid="invoice-certify-period" />
        </Field>
        <Field label="说明" htmlFor="cert-note">
          <Input id="cert-note" value={note} maxLength={100} onChange={(e) => setNote(e.target.value)} placeholder="可选" className="h-10" />
        </Field>
        {error && <Notice tone="error" title={error} className="sm:col-span-2" />}
      </div>
    </Dialog>
  );
}
