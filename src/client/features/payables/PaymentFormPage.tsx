import { useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { ArrowLeft, CircleAlert, CircleCheck, CloudOff, RotateCw, Wallet } from 'lucide-react';
import { centsToInput, formatAmount, parseYuan } from '@shared/money';
import { PAY_METHOD_LABELS, PAYMENT_METHODS, type PaymentDoc, type PayMethod } from '@shared/purchasing';
import { api, ApiError, errorMessage, UncertainError } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn, uuid } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { useToast } from '../../components/Toast';
import { Button, Field, Input, MoneyInput, Notice, Select, Skeleton } from '../../components/ui';
import { SimRule } from '../inventory/parts';
import { useInvSettings, useSuppliers } from '../inventory/queries';
import { useInvalidateAll, useOpenItems } from '../purchasing/queries';

/** 登记付款：只登记线下已经完成的付款，全额核销到具体货款（首版不登记预付款） */
export function PaymentFormPage() {
  const can = useCan();
  const session = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const invalidate = useInvalidateAll();
  const [params] = useSearchParams();
  const suppliers = useSuppliers();
  const settings = useInvSettings();
  const [supplierId, setSupplierId] = useState<number | null>(Number(params.get('supplier')) || null);
  const items = useOpenItems(supplierId);
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [payDate, setPayDate] = useState(session.calendarToday);
  const [method, setMethod] = useState<PayMethod>('bank_transfer');
  const [evidence, setEvidence] = useState('');
  const [note, setNote] = useState('');
  const [approveNow, setApproveNow] = useState(false);
  // 预付款（#25，v0.7.12）：核销之外多付的部分
  const [prepay, setPrepay] = useState(false);
  const [prepayText, setPrepayText] = useState('');
  const [clientKey, setClientKey] = useState(uuid);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState<unknown>(null);

  const open = useMemo(() => (items.data ?? []).filter((i) => i.openCents > 0 || alloc[`${i.kind}:${i.id}`]), [items.data, alloc]);
  const rows = open.map((i) => {
    const key = `${i.kind}:${i.id}`;
    const text = alloc[key] ?? '';
    const cents = text.trim() ? parseYuan(text) : null;
    const err = text.trim() && cents === null ? '金额格式不正确' : cents !== null && cents > i.openCents ? `最多 ¥${formatAmount(i.openCents)}` : null;
    return { i, key, text, cents, err };
  });
  const chosen = rows.filter((r) => r.cents && r.cents > 0);
  const prepayCents = prepay ? parseYuan(prepayText) : 0;
  const total = chosen.reduce((s, r) => s + (r.cents ?? 0), 0) + (prepayCents ?? 0);
  // #18：金额不超过免确认门槛的登记即确认
  const needsApproval = !!settings.data?.approvalRules.payment && total > (settings.data?.approvalThresholdCents ?? 0);
  const blocking = !supplierId
    ? '请选择供应商'
    : prepay && !prepayCents
      ? '请填写预付金额'
      : chosen.length === 0 && !prepay
        ? '请勾选这笔付款对应的货款；先付款、货还没到的勾选「含预付款」'
        : rows.some((r) => r.err)
          ? '有核销金额需要修改'
          : evidence.trim().length < 2
            ? '请填写凭据说明'
            : prepay && note.trim().length < 2
              ? '预付款请在备注里写明用途'
              : null;

  if (!can('payable.manage')) return <Navigate to="/payables" replace />;

  const send = async (body: unknown) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ payment: PaymentDoc }>('/api/payables/payments', body, { timeoutMs: 20_000 });
      setUncertain(null);
      await invalidate();
      toast({ tone: 'success', title: r.payment.status === 'confirmed' ? '付款已确认' : '已提交，等待负责人确认', body: `${r.payment.docNo} · ¥${formatAmount(r.payment.amountCents)}` });
      navigate(`/payables?view=payments&payment=${r.payment.id}`);
    } catch (e) {
      if (e instanceof UncertainError) {
        setUncertain(body);
      } else {
        setError(e instanceof ApiError ? e.message : errorMessage(e));
        if (e instanceof ApiError && e.code === 'IDEMPOTENCY_CONFLICT') setClientKey(uuid());
        void items.refetch();
      }
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    if (blocking) return;
    void send({
      clientKey,
      supplierId,
      payDate,
      amountCents: total,
      method,
      evidence: evidence.trim(),
      note: note.trim(),
      approveNow: needsApproval && approveNow,
      prepay: prepay && !!prepayCents,
      allocations: chosen.map((r) => ({ kind: r.i.kind, targetId: r.i.id, amountCents: r.cents })),
    });
  };

  const locked = busy || !!uncertain;

  return (
    <>
      <PageHeader
        dateMode="calendar"
        title={
          <span className="flex items-center gap-2.5">
            <Link to="/payables" className="-ml-1 flex size-8 items-center justify-center rounded-md text-ink-3 hover:bg-paper-2 hover:text-ink" aria-label="返回货款">
              <ArrowLeft className="size-[18px]" />
            </Link>
            <span className="flex size-8 items-center justify-center rounded-full bg-lake-soft text-lake">
              <Wallet className="size-4" />
            </span>
            登记付款
          </span>
        }
        subtitle="只登记线下已经完成的付款，核销到具体货款；货还没到先付的记为预付款，以后在对账单里核销"
      />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1080px] space-y-4 px-5 py-5 md:px-7">
          <section className="grid gap-4 rounded-lg border border-line bg-card p-5 shadow-card sm:grid-cols-2 lg:grid-cols-4">
            <Field label="供应商" htmlFor="pay-sup">
              <Select
                id="pay-sup"
                value={supplierId ?? ''}
                disabled={locked}
                onChange={(e) => {
                  setSupplierId(Number(e.target.value) || null);
                  setAlloc({});
                }}
              >
                <option value="">选择供应商</option>
                {suppliers.data?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code} · {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="付款日期" htmlFor="pay-date">
              <Input id="pay-date" type="date" value={payDate} max={session.calendarToday} disabled={locked} onChange={(e) => setPayDate(e.target.value)} className="h-10" />
            </Field>
            <Field label="付款方式" htmlFor="pay-method">
              <Select id="pay-method" value={method} disabled={locked} onChange={(e) => setMethod(e.target.value as PayMethod)}>
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {PAY_METHOD_LABELS[m]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="凭据说明" htmlFor="pay-ev" hint="如转账流水号后四位、收据编号">
              <Input id="pay-ev" value={evidence} maxLength={200} disabled={locked} onChange={(e) => setEvidence(e.target.value)} className="h-10" />
            </Field>
            <Field label="备注" htmlFor="pay-note" className="sm:col-span-2 lg:col-span-3">
              <Input id="pay-note" value={note} maxLength={200} disabled={locked} onChange={(e) => setNote(e.target.value)} placeholder={prepay ? '预付款的用途（必填）' : '可选'} className="h-10" />
            </Field>
            <div className="flex flex-col gap-1.5">
              <label className="flex cursor-pointer items-center gap-2 text-[13px] font-semibold text-ink-2">
                <input type="checkbox" className="size-4 accent-[var(--color-pine)]" checked={prepay} disabled={locked} onChange={(e) => setPrepay(e.target.checked)} data-testid="pay-prepay" />
                含预付款（其余记为预付款）
              </label>
              {prepay && <MoneyInput value={prepayText} disabled={locked} onChange={(e) => setPrepayText(e.target.value)} aria-label="预付金额" className="h-10" />}
            </div>
          </section>

          <section className="rounded-lg border border-line bg-card shadow-card">
            <div className="flex items-center gap-3 border-b border-line px-5 py-3">
              <h2 className="text-[14px] font-bold">核销到哪些货款</h2>
              <span className="text-[12.5px] text-ink-3">支持部分付款；付款金额 = 核销合计 + 预付金额</span>
            </div>
            {!supplierId ? (
              <EmptyState art="search" title="先选择供应商" className="py-8" />
            ) : items.isPending ? (
              <Skeleton className="m-5 h-32" />
            ) : rows.length === 0 ? (
              <EmptyState art="calm" title="这家供应商没有未结清的货款" className="py-8" />
            ) : (
              <ul className="divide-y divide-line/70">
                {rows.map(({ i, key, text, err }) => {
                  const checked = text.trim() !== '';
                  return (
                    <li key={key} className={cn('grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-5 py-3 md:grid-cols-[auto_minmax(0,1fr)_repeat(3,110px)_170px]', checked && 'bg-pine-tint/50')}>
                      <input
                        type="checkbox"
                        aria-label={`核销 ${i.docNo}`}
                        className="size-4 accent-[var(--color-pine)]"
                        checked={checked}
                        disabled={locked}
                        onChange={(e) => setAlloc((a) => ({ ...a, [key]: e.target.checked ? centsToInput(i.openCents) : '' }))}
                      />
                      <span className="min-w-0">
                        <span className="num block text-[13.5px] font-bold">
                          {i.docNo}
                          <span className="ml-2 font-sans text-[12px] font-semibold text-ink-3">{i.kind === 'opening' ? '期初未付' : i.purchaseOrderNo ? `采购单 ${i.purchaseOrderNo}` : '直接收货'}</span>
                        </span>
                        <span className="block truncate text-[12px] text-ink-3">
                          {i.date} · {i.summary}
                        </span>
                      </span>
                      <span className="hidden text-right text-[12.5px] md:block">
                        <span className="block text-ink-3">货款</span>
                        <Money cents={i.amountCents} />
                      </span>
                      <span className="hidden text-right text-[12.5px] md:block">
                        <span className="block text-ink-3">扣款 / 核销 / 已付</span>
                        <Money cents={i.creditCents + i.offsetCents + i.paidCents} />
                      </span>
                      <span className="hidden text-right text-[12.5px] md:block">
                        <span className="block text-ink-3">未结清</span>
                        <Money cents={i.openCents} className="font-bold" />
                        {i.pendingCents > 0 && <span className="block text-[11px] text-yuzu-deep">另有待确认 ¥{formatAmount(i.pendingCents)}</span>}
                      </span>
                      <span>
                        <MoneyInput value={text} disabled={locked} onChange={(e) => setAlloc((a) => ({ ...a, [key]: e.target.value }))} aria-label={`${i.docNo} 本次核销`} invalid={!!err} className="h-10 text-right" />
                        {err && <span className="mt-1 block text-right text-[11.5px] font-semibold text-clay">{err}</span>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {error && <Notice tone="error" title={error} icon={<CircleAlert className="size-5" />}>付款没有登记，内容仍保留在页面上。</Notice>}
          {uncertain != null && (
            <Notice
              tone="warning"
              title="结果待确认"
              icon={<CloudOff className="size-5" />}
              action={
                <Button size="sm" variant="primary" loading={busy} icon={<RotateCw className="size-4" />} onClick={() => void send(uncertain)}>
                  按原内容重新提交（不会重复登记）
                </Button>
              }
            >
              付款可能已经登记。重新提交使用同一操作编号：已登记的会直接返回原记录。
            </Notice>
          )}
        </div>
      </div>
      <footer className="shrink-0 border-t border-line bg-card/95 px-5 py-3 backdrop-blur md:px-7">
        <div className="mx-auto flex w-full max-w-[1080px] flex-wrap items-center gap-x-5 gap-y-2.5">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1">
            <span className="flex items-baseline gap-2">
              <span className="text-[12.5px] font-semibold text-ink-3">付款金额</span>
              <Money cents={total} className="text-[20px] font-bold text-lake" />
            </span>
            <span className="text-[12.5px] font-semibold">
              {needsApproval ? (
                <span className="flex items-center gap-2 text-yuzu-deep">
                  提交后需负责人确认 <SimRule />
                </span>
              ) : (
                <span className="text-pine">提交即确认</span>
              )}
            </span>
            {blocking && <span className="text-[12.5px] font-semibold text-clay">{blocking}</span>}
          </div>
          {needsApproval && can('inventory.approve') && (
            <label className="flex cursor-pointer items-center gap-2 text-[13px] font-semibold text-ink-2">
              <input type="checkbox" className="size-4 accent-[var(--color-pine)]" checked={approveNow} disabled={locked} onChange={(e) => setApproveNow(e.target.checked)} />
              同时以负责人身份确认
            </label>
          )}
          <Button variant="primary" size="lg" disabled={locked || !!blocking} loading={busy} icon={<CircleCheck className="size-[18px]" />} onClick={submit}>
            登记付款
          </Button>
        </div>
      </footer>
    </>
  );
}
