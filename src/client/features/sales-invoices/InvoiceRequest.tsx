// 8.0.21 申请开票（docs/FINANCE_V8021.md 第 3 节，CW-B）：前台结账记录、会员充值记录、协议单位回款上的「申请开票」。
// 可开金额由服务端算（CW13）；同一笔只能有一张申请中 / 已开的。提交走 ERP 的「结果待确认」（业务类型 invoice_request）。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileOutput } from 'lucide-react';
import { centsToInput, formatAmount, parseYuan } from '@shared/money';
import {
  INVOICE_SOURCE_LABELS,
  SALES_INVOICE_KIND_LABELS,
  SALES_INVOICE_STATUS_LABELS,
  TAX_NO_PATTERN,
  type InvoiceSourceInfo,
  type InvoiceSourceType,
  type InvoiceTitleType,
  type SalesInvoice,
  type SalesInvoiceKind,
} from '@shared/sales-invoices';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, useErpPending } from '../../lib/erpPending';
import { useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { formatDateTime, uuid } from '../../lib/utils';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Field, Input, MoneyInput, Notice, Segmented, Skeleton } from '../../components/ui';

const STATUS_TONE = { requested: 'lake', issued: 'pine', rejected: 'clay', voided: 'neutral' } as const;

export function SalesInvoiceStatus({ inv }: { inv: SalesInvoice }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Badge tone={STATUS_TONE[inv.status]}>{inv.issuedVia === 'sending' && inv.status === 'requested' ? '服务商开票中' : SALES_INVOICE_STATUS_LABELS[inv.status]}</Badge>
      {inv.status === 'issued' && inv.sourceVoided && <Badge tone="clay">来源已作废，要红冲</Badge>}
      {inv.status === 'issued' && !inv.sourceVoided && inv.sourceReduced && <Badge tone="clay">开票后退了款，要红冲</Badge>}
      {inv.status === 'requested' && (inv.sourceVoided || inv.sourceReduced) && <Badge tone="clay">金额超过现在可开的，要驳回重申</Badge>}
    </span>
  );
}

const sourceKey = (type: InvoiceSourceType, id: number) => ['sales-invoices', 'source', type, id] as const;

export function InvoiceRequestButton({ sourceType, sourceId, size = 'sm' }: { sourceType: InvoiceSourceType; sourceId: number; size?: 'sm' | 'md' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size={size}
        variant="ghost"
        icon={<FileOutput className="size-4" />}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        data-testid={`invoice-request-${sourceType}-${sourceId}`}
      >
        开票
      </Button>
      <InvoiceRequestDialog open={open} sourceType={sourceType} sourceId={sourceId} onClose={() => setOpen(false)} />
    </>
  );
}

export function InvoiceRequestDialog({ open, sourceType, sourceId, onClose }: { open: boolean; sourceType: InvoiceSourceType; sourceId: number; onClose: () => void }) {
  const session = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const info = useQuery({ queryKey: sourceKey(sourceType, sourceId), queryFn: () => api.get<InvoiceSourceInfo>(`/api/invoice-requests/source?type=${sourceType}&id=${sourceId}`), enabled: open });
  const pending = useErpPending(['invoice_request']);
  const [titleType, setTitleType] = useState<InvoiceTitleType>('personal');
  const [title, setTitle] = useState('');
  const [taxNo, setTaxNo] = useState('');
  const [kind, setKind] = useState<SalesInvoiceKind>('normal');
  const [amount, setAmount] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filledFor, setFilledFor] = useState<number | null>(null);
  useResetOnOpen(open, () => {
    setTitleType(sourceType === 'ar_collection' ? 'company' : 'personal');
    setTitle('');
    setTaxNo('');
    setKind('normal');
    setAmount('');
    setEmail('');
    setPhone('');
    setNote('');
    setError(null);
    setFilledFor(null);
  });
  const d = info.data;
  if (d && filledFor !== d.id && open) {
    setFilledFor(d.id);
    setAmount(d.invoiceableCents > 0 ? centsToInput(d.invoiceableCents) : '');
    if (d.partyName) setTitle(d.partyName);
  }
  const cents = amount.trim() ? parseYuan(amount) : null;
  const tax = taxNo.trim().toUpperCase().replace(/\s/g, '');
  const problem = !d
    ? null
    : d.voided
      ? '这一笔已反结账或作废，不能申请'
      : d.active
        ? '这一笔已经有开票申请'
        : d.invoiceableCents <= 0
          ? '这一笔没有能开票的金额'
          : !title.trim()
            ? '请填写抬头'
            : titleType === 'company' && tax && !TAX_NO_PATTERN.test(tax)
              ? '税号是 15–20 位数字或大写字母'
              : kind === 'special' && !tax
                ? '专票要填税号'
                : !cents || cents <= 0
                  ? '请填写开票金额'
                  : cents > d.invoiceableCents
                    ? `开票金额不能超过可开的 ¥${formatAmount(d.invoiceableCents)}`
                    : pending.length > 0
                      ? '上一份申请结果待确认，请先在上面查回或作废'
                      : null;
  const submit = async () => {
    if (!d || problem) return;
    setBusy(true);
    setError(null);
    const body = {
      clientKey: uuid(),
      sourceType,
      sourceId,
      amountCents: cents,
      titleType,
      title: title.trim(),
      taxNo: titleType === 'company' ? tax : '',
      email: email.trim(),
      phone: phone.trim(),
      invoiceKind: titleType === 'company' ? kind : 'normal',
      note: note.trim(),
    };
    try {
      await sendErpOp({
        key: body.clientKey,
        type: 'invoice_request',
        url: '/api/invoice-requests',
        body,
        summary: `${INVOICE_SOURCE_LABELS[sourceType]} ${d.no} 开票 ¥${formatAmount(cents!)}`,
        staffName: session.staff.displayName,
      });
      toast({ tone: 'success', title: '已提交开票申请', body: '财务在 ERP「开票」里处理；开好以后这里看得到发票号码' });
    } catch (e) {
      if (e instanceof UncertainError) toast({ tone: 'error', title: '开票申请没收到结果', body: '记在这个窗口上方的「结果待确认」里，查回或按原内容重新提交' });
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
      await qc.invalidateQueries({ queryKey: ['sales-invoices'] });
    }
  };
  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title={d ? `开票 · ${INVOICE_SOURCE_LABELS[sourceType]} ${d.no}` : '开票'}
      description="给客人开发票：这里只登记申请，财务开好以后填发票号码。同一笔只能开一次，开错了由财务作废后重新申请。"
      footer={
        <>
          {problem && d && !d.active && <span className="mr-auto text-[12.5px] font-semibold text-clay">{problem}</span>}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {d?.active ? '关闭' : '取消'}
          </Button>
          {d && !d.active && !d.voided && (
            <Button variant="primary" loading={busy} disabled={!!problem} onClick={() => void submit()} data-testid="invoice-request-submit">
              提交申请
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4" data-testid="invoice-request-dialog">
        <ErpPendingPanel types={['invoice_request']} onFound={() => void info.refetch()} />
        {!d ? (
          info.error ? <LoadFailed title={`可开票的金额取不回来：${errorMessage(info.error)}`} onRetry={() => void info.refetch()} retrying={info.isFetching} testId="invoice-request-error" /> : <Skeleton className="h-40" />
        ) : (
          <>
            <div className="rounded-lg bg-paper-2/60 px-4 py-3 text-[13px]">
              <p>
                可开金额 <span className="num text-[15px] font-bold">¥{formatAmount(d.invoiceableCents)}</span>
                <span className="ml-2 text-ink-3">{d.date}</span>
              </p>
              <p className="mt-0.5 text-[12.5px] text-ink-3">{d.basis.join('；')}</p>
            </div>
            {d.active ? (
              <ActiveCard inv={d.active} />
            ) : d.voided ? (
              <Notice tone="warning" title="这一笔已反结账或作废，不能申请开票" />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="抬头类型" className="sm:col-span-2">
                  <Segmented
                    ariaLabel="抬头类型"
                    value={titleType}
                    onChange={(v) => {
                      setTitleType(v);
                      if (v === 'personal') setKind('normal');
                    }}
                    options={[
                      { value: 'personal', label: '个人' },
                      { value: 'company', label: '单位' },
                    ]}
                  />
                </Field>
                <Field label="抬头" htmlFor="ir-title" className="sm:col-span-2">
                  <Input id="ir-title" value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} className="h-10" data-testid="ir-title" />
                </Field>
                {titleType === 'company' && (
                  <>
                    <Field label="税号" htmlFor="ir-tax" hint="统一社会信用代码；普票可以不填">
                      <Input id="ir-tax" value={taxNo} maxLength={24} onChange={(e) => setTaxNo(e.target.value)} className="num h-10" data-testid="ir-tax" />
                    </Field>
                    <Field label="发票种类">
                      <Segmented
                        ariaLabel="发票种类"
                        value={kind}
                        onChange={setKind}
                        options={[
                          { value: 'normal', label: '普票' },
                          { value: 'special', label: '专票' },
                        ]}
                      />
                    </Field>
                  </>
                )}
                <Field label="开票金额" htmlFor="ir-amount" hint="默认可开的全部，可以少开">
                  <MoneyInput id="ir-amount" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="ir-amount" />
                </Field>
                <Field label="接收邮箱" htmlFor="ir-email" hint="电子发票发到这里（可选）">
                  <Input id="ir-email" type="email" value={email} maxLength={100} onChange={(e) => setEmail(e.target.value)} className="h-10" />
                </Field>
                <Field label="手机号" htmlFor="ir-phone" hint="可选">
                  <Input id="ir-phone" value={phone} maxLength={20} onChange={(e) => setPhone(e.target.value)} className="num h-10" />
                </Field>
                <Field label="备注" htmlFor="ir-note">
                  <Input id="ir-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="可选" className="h-10" />
                </Field>
              </div>
            )}
            {d.history.filter((h) => h.id !== d.active?.id).length > 0 && (
              <div>
                <p className="mb-1 text-[12.5px] font-semibold text-ink-2">以前的申请</p>
                <ul className="space-y-1 text-[12.5px] text-ink-3">
                  {d.history
                    .filter((h) => h.id !== d.active?.id)
                    .map((h) => (
                      <li key={h.id} className="flex flex-wrap items-center gap-2">
                        <span className="num">{h.requestNo}</span>
                        <SalesInvoiceStatus inv={h} />
                        <span>{h.rejectReason ?? h.voidReason ?? ''}</span>
                      </li>
                    ))}
                </ul>
              </div>
            )}
          </>
        )}
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}

function ActiveCard({ inv }: { inv: SalesInvoice }) {
  return (
    <div className="rounded-lg border border-line px-4 py-3 text-[13px]" data-testid="invoice-request-active">
      <p className="flex flex-wrap items-center gap-2">
        <span className="num font-semibold">{inv.requestNo}</span>
        <SalesInvoiceStatus inv={inv} />
        <span className="num font-bold">¥{formatAmount(inv.amountCents)}</span>
      </p>
      <p className="mt-1 text-ink-2">
        {inv.title}
        {inv.taxNo ? ` · ${inv.taxNo}` : ''} · {SALES_INVOICE_KIND_LABELS[inv.invoiceKind]}
      </p>
      {inv.status === 'issued' && (
        <p className="num mt-1 text-ink-2">
          发票号码 {inv.invoiceNo} · 开票日 {inv.invoiceDate}
        </p>
      )}
      <p className="mt-1 text-[12px] text-ink-3">
        {inv.requestedByName} 申请于 {formatDateTime(inv.requestedAt)}
        {inv.handledByName && inv.handledAt ? ` · ${inv.handledByName} 处理于 ${formatDateTime(inv.handledAt)}` : ''}
      </p>
    </div>
  );
}
