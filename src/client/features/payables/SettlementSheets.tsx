import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowRightLeft, HandCoins, RotateCcw, X } from 'lucide-react';
import { formatAmount, parseYuan } from '@shared/money';
import {
  PAY_METHOD_LABELS,
  PAYMENT_METHODS,
  SETTLEMENT_STATUS_LABELS,
  type ApOffsetDoc,
  type OpenItem,
  type PayMethod,
  type SupplierCredit,
  type SupplierRefundDoc,
} from '@shared/purchasing';
import { api, ApiError, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, useErpPending } from '../../lib/erpPending';
import { useCan, useSession } from '../../lib/session';
import { cn, formatDateTime, uuid } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Dialog, Sheet } from '../../components/Overlay';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, Field, IconButton, Input, MoneyInput, Notice, Select, Spinner } from '../../components/ui';
import { useCredits, useInvalidateAll, useOffset, useOffsets, useOpenItems, useRefund, useRefunds } from '../purchasing/queries';

// 可抵扣（预付款、退货余额）的核销与供应商退款（v0.7.12，#25、#20）

export const creditKindLabel = (c: Pick<SupplierCredit, 'kind' | 'canOffset'>) =>
  c.kind === 'prepayment' ? '预付款' : c.canOffset ? '退货余额' : '现付退货待退款';

const creditLink = (c: { kind: 'prepayment' | 'return'; id: number }) => (c.kind === 'return' ? `/inventory/docs?doc=${c.id}` : `/payables?view=payments&payment=${c.id}`);

/** 对账单里的「可抵扣」：预付款与退货余额，能核销到以后的货款或登记供应商退款 */
export function CreditsSection({ supplierId }: { supplierId: number }) {
  const can = useCan();
  const credits = useCredits(supplierId);
  const offsets = useOffsets({ supplierId: String(supplierId) });
  const refunds = useRefunds({ supplierId: String(supplierId) });
  const [offsetFor, setOffsetFor] = useState<SupplierCredit | null>(null);
  const [refundFor, setRefundFor] = useState<SupplierCredit | null>(null);
  const [offsetId, setOffsetId] = useState<number | null>(null);
  const [refundId, setRefundId] = useState<number | null>(null);
  const manage = can('payable.manage');
  const history = [
    ...(offsets.data ?? []).map((o) => ({ kind: 'offset' as const, id: o.id, docNo: o.docNo, date: o.offsetDate, amountCents: o.amountCents, status: o.status, from: o.credit.docNo })),
    ...(refunds.data ?? []).map((r) => ({ kind: 'refund' as const, id: r.id, docNo: r.docNo, date: r.refundDate, amountCents: r.amountCents, status: r.status, from: r.credit.docNo })),
  ].sort((a, b) => b.date.localeCompare(a.date) || b.docNo.localeCompare(a.docNo));
  return (
    <section data-testid="credits-section">
      <h3 className="mb-2 text-[13px] font-bold text-ink-2">可抵扣（预付款、退货余额）</h3>
      {credits.error ? (
        <Notice tone="error" title={errorMessage(credits.error)} />
      ) : !credits.data ? (
        <Spinner />
      ) : credits.data.length === 0 ? (
        <p className="text-[13px] text-ink-3">没有可抵扣的预付款或退货余额。</p>
      ) : (
        <ul className="divide-y divide-line/70 rounded-lg border border-line bg-card shadow-card">
          {credits.data.map((c) => (
            <li key={`${c.kind}${c.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5 text-[13px]" data-testid={`credit-${c.docNo}`}>
              <Badge tone={c.kind === 'prepayment' ? 'lake' : c.canOffset ? 'ember' : 'clay'}>{creditKindLabel(c)}</Badge>
              <Link to={creditLink(c)} className="num font-semibold text-pine hover:underline">
                {c.docNo}
              </Link>
              <span className="min-w-0 flex-1 truncate text-ink-3">
                {c.date} · {c.summary}
                {(c.offsetCents > 0 || c.refundedCents > 0) && ` · 已核销 ¥${formatAmount(c.offsetCents)}、已退款 ¥${formatAmount(c.refundedCents)}`}
              </span>
              <Money cents={c.availableCents} className="text-[15px] font-bold text-ember" />
              {manage && (
                <span className="flex gap-1.5">
                  {c.canOffset && (
                    <Button size="sm" variant="secondary" icon={<ArrowRightLeft className="size-4" />} onClick={() => setOffsetFor(c)}>
                      核销
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" icon={<HandCoins className="size-4" />} onClick={() => setRefundFor(c)}>
                    登记退款
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {history.length > 0 && (
        <>
          <h3 className="mt-4 mb-2 text-[13px] font-bold text-ink-2">核销与供应商退款记录</h3>
          <ul className="divide-y divide-line/70 rounded-lg border border-line bg-card">
            {history.map((h) => (
              <li key={`${h.kind}${h.id}`}>
                <button type="button" onClick={() => (h.kind === 'offset' ? setOffsetId(h.id) : setRefundId(h.id))} className="flex w-full items-center gap-3 px-4 py-2 text-left text-[13px] hover:bg-pine-tint/50">
                  <span className="num font-semibold">{h.docNo}</span>
                  <span className="text-ink-3">
                    {h.kind === 'offset' ? '核销' : '供应商退款'} · {h.date} · 来自 {h.from}
                  </span>
                  <span className="flex-1" />
                  <Money cents={h.amountCents} className={cn('font-bold', h.status === 'voided' && 'text-ink-4 line-through')} />
                  {h.status === 'voided' && <Badge tone="clay">已冲销</Badge>}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <OffsetDialog supplierId={supplierId} credit={offsetFor} onClose={() => setOffsetFor(null)} />
      <RefundDialog supplierId={supplierId} credit={refundFor} onClose={() => setRefundFor(null)} />
      <OffsetSheet id={offsetId} onClose={() => setOffsetId(null)} />
      <RefundSheet id={refundId} onClose={() => setRefundId(null)} />
    </section>
  );
}

/** 核销：用这笔可抵扣抵扣同一供应商还没付的货款（不动钱、不记应付流水） */
export function OffsetDialog({ supplierId, credit, onClose }: { supplierId: number; credit: SupplierCredit | null; onClose: () => void }) {
  const session = useSession();
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const items = useOpenItems(credit ? supplierId : null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [date, setDate] = useState(session.calendarToday);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 结果待确认的核销记在本机（AGENTS.md）：在页面上方查回、按原内容重新提交或作废之前，不能再登记新的一笔
  const pending = useErpPending(['ap_offset']);
  const [last, setLast] = useState<SupplierCredit | null>(null);
  if (credit !== last) {
    setLast(credit);
    if (credit) {
      setAmounts({});
      setDate(session.calendarToday);
      setNote('');
      setError(null);
    }
  }
  const open = (items.data ?? []).filter((i) => i.openCents > 0);
  const keyOf = (i: OpenItem) => `${i.kind}:${i.id}`;
  const lines = open
    .map((i) => ({ i, cents: parseYuan(amounts[keyOf(i)] ?? '') }))
    .filter((l): l is { i: OpenItem; cents: number } => !!l.cents && l.cents > 0);
  const total = lines.reduce((t, l) => t + l.cents, 0);
  const fill = (i: OpenItem) => {
    const remaining = (credit?.availableCents ?? 0) - total + (parseYuan(amounts[keyOf(i)] ?? '') ?? 0);
    const cents = Math.max(0, Math.min(i.openCents, remaining));
    setAmounts({ ...amounts, [keyOf(i)]: cents ? (cents / 100).toFixed(2) : '' });
  };
  // 每次提交用新的操作编号：先记在本机并读回核对（记不下就不发请求），结果不明的那一笔由页面上方按原编号处理
  const save = async () => {
    if (!credit) return;
    if (pending.length > 0) return setError('上一笔核销结果待确认：请先在页面上方查回、按原内容重新提交或作废');
    if (lines.length === 0) return setError('请在要核销的货款上填金额');
    if (total > credit.availableCents) return setError(`核销合计 ¥${formatAmount(total)} 超过可抵扣 ¥${formatAmount(credit.availableCents)}`);
    const body = {
      clientKey: uuid(),
      supplierId,
      offsetDate: date,
      credit: { kind: credit.kind, id: credit.id },
      note: note.trim(),
      lines: lines.map((l) => ({ kind: l.i.kind, targetId: l.i.id, amountCents: l.cents })),
    };
    setBusy(true);
    setError(null);
    try {
      await sendErpOp({
        key: body.clientKey,
        type: 'ap_offset',
        url: '/api/payables/offsets',
        body,
        summary: `${credit.docNo} 核销 ¥${formatAmount(total)} → ${lines.map((l) => l.i.docNo).join('、')}`,
        staffName: session.staff.displayName,
      });
      await invalidate();
      toast({ tone: 'success', title: '已核销', body: `${credit.docNo} 抵扣 ¥${formatAmount(total)}` });
      onClose();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '核销结果待确认', body: '已记在本机：请在页面上方查回、按原内容重新提交或作废，不要重新填写。' });
        onClose();
      } else setError(e instanceof ApiError ? e.message : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!credit}
      onClose={busy ? () => {} : onClose}
      width="max-w-2xl"
      title={credit ? `核销 ${credit.docNo}` : '核销'}
      description={credit ? `${creditKindLabel(credit)}还可以抵扣 ¥${formatAmount(credit.availableCents)}；核销不动钱，只把它抵到下面这些还没付的货款上。` : ''}
      footer={
        <>
          <span className="mr-auto text-[13px] font-semibold text-ink-2">
            本次核销 <Money cents={total} className="font-bold" />
          </span>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={pending.length > 0} onClick={save} data-testid="offset-submit">
            确认核销
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {pending.length > 0 && <Notice tone="warning" title="上一笔核销结果待确认">请先在页面上方查回、按原内容重新提交或作废，再登记新的核销。</Notice>}
        {items.isPending ? (
          <Spinner />
        ) : open.length === 0 ? (
          <Notice tone="info" title="这个供应商没有还没付的货款">有新的收货生效后再来核销。</Notice>
        ) : (
          <ul className="divide-y divide-line/70 rounded-lg border border-line">
            {open.map((i) => (
              <li key={keyOf(i)} className="flex flex-wrap items-center gap-3 px-3 py-2 text-[13px]">
                <span className="num font-semibold">{i.docNo}</span>
                <span className="min-w-0 flex-1 truncate text-ink-3">
                  {i.kind === 'opening' ? '期初未付' : i.purchaseOrderNo ? `采购单 ${i.purchaseOrderNo}` : '收货'} · {i.date} · 未付 ¥{formatAmount(i.openCents)}
                </span>
                <Button size="sm" variant="ghost" onClick={() => fill(i)}>
                  填满
                </Button>
                <MoneyInput
                  aria-label={`核销 ${i.docNo}`}
                  value={amounts[keyOf(i)] ?? ''}
                  onChange={(e) => setAmounts({ ...amounts, [keyOf(i)]: e.target.value })}
                  className="w-[130px]"
                />
              </li>
            ))}
          </ul>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="核销日期" htmlFor="off-date">
            <Input id="off-date" type="date" value={date} max={session.calendarToday} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="说明" htmlFor="off-note">
            <Input id="off-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="例如：退货款抵 10 月货款" />
          </Field>
        </div>
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}

/** 供应商退款：供应商把预付款或退货的钱退回来（挂账的记应付流水「供应商退款」） */
export function RefundDialog({ supplierId, credit, onClose }: { supplierId: number; credit: SupplierCredit | null; onClose: () => void }) {
  const session = useSession();
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const [form, setForm] = useState({ amount: '', date: session.calendarToday, method: 'bank_transfer' as PayMethod, evidence: '', note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 结果待确认的退款记在本机（AGENTS.md）：查回、重新提交或作废之前不能再登记新的一笔
  const pending = useErpPending(['supplier_refund']);
  const [last, setLast] = useState<SupplierCredit | null>(null);
  if (credit !== last) {
    setLast(credit);
    if (credit) {
      setForm({ amount: (credit.availableCents / 100).toFixed(2), date: session.calendarToday, method: 'bank_transfer', evidence: '', note: '' });
      setError(null);
    }
  }
  const cents = parseYuan(form.amount);
  const save = async () => {
    if (!credit) return;
    if (pending.length > 0) return setError('上一笔供应商退款结果待确认：请先在页面上方查回、按原内容重新提交或作废');
    if (!cents || cents <= 0) return setError('请填写正确的退款金额');
    if (cents > credit.availableCents) return setError(`最多还能退 ¥${formatAmount(credit.availableCents)}`);
    if (form.evidence.trim().length < 2) return setError('请填写凭据说明，例如到账流水号后四位');
    const body = {
      clientKey: uuid(),
      supplierId,
      refundDate: form.date,
      amountCents: cents,
      method: form.method,
      evidence: form.evidence.trim(),
      note: form.note.trim(),
      credit: { kind: credit.kind, id: credit.id },
    };
    setBusy(true);
    setError(null);
    try {
      await sendErpOp({
        key: body.clientKey,
        type: 'supplier_refund',
        url: '/api/payables/refunds',
        body,
        summary: `${credit.docNo} 供应商退款 ¥${formatAmount(cents)}`,
        staffName: session.staff.displayName,
      });
      await invalidate();
      toast({ tone: 'success', title: '已登记供应商退款', body: `${credit.docNo} 退回 ¥${formatAmount(cents)}` });
      onClose();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '供应商退款结果待确认', body: '已记在本机：请在页面上方查回、按原内容重新提交或作废，不要重新填写。' });
        onClose();
      } else setError(e instanceof ApiError ? e.message : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!credit}
      onClose={busy ? () => {} : onClose}
      title={credit ? `登记供应商退款 · ${credit.docNo}` : '登记供应商退款'}
      description={
        credit
          ? credit.canOffset
            ? `收到供应商退回的钱后登记；记应付流水「供应商退款」，供应商余额相应回到 0 附近。还能退 ¥${formatAmount(credit.availableCents)}。`
            : `现付供应商的退货没记应付，退回的钱登记在这里（不记应付）。还能退 ¥${formatAmount(credit.availableCents)}。`
          : ''
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={pending.length > 0} onClick={save} data-testid="refund-submit">
            登记退款
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {pending.length > 0 && (
          <Notice tone="warning" title="上一笔供应商退款结果待确认" className="sm:col-span-2">
            请先在页面上方查回、按原内容重新提交或作废，再登记新的退款。
          </Notice>
        )}
        <Field label="退款金额" htmlFor="rf-amt">
          <MoneyInput id="rf-amt" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
        </Field>
        <Field label="到账日期" htmlFor="rf-date">
          <Input id="rf-date" type="date" value={form.date} max={session.calendarToday} onChange={(e) => setForm({ ...form, date: e.target.value })} />
        </Field>
        <Field label="方式" htmlFor="rf-method">
          <Select id="rf-method" value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value as PayMethod })}>
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {PAY_METHOD_LABELS[m]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="凭据说明" htmlFor="rf-evidence">
          <Input id="rf-evidence" value={form.evidence} maxLength={200} onChange={(e) => setForm({ ...form, evidence: e.target.value })} placeholder="到账流水号后四位" />
        </Field>
        <Field label="说明" htmlFor="rf-note" className="sm:col-span-2">
          <Input id="rf-note" value={form.note} maxLength={200} onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </Field>
        {error && <Notice tone="error" title={error} className="sm:col-span-2" />}
      </div>
    </Dialog>
  );
}

function useVoid(base: string, docNo: string) {
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const [busy, setBusy] = useState(false);
  const run = async (reason: string) => {
    setBusy(true);
    try {
      await api.post(`${base}/void`, { reason });
      await invalidate();
      toast({ tone: 'success', title: '已冲销', body: docNo });
      return true;
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
      await invalidate();
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

function SheetHeader({ title, docNo, status, synthetic, onClose }: { title: string; docNo: string; status: ApOffsetDoc['status']; synthetic: boolean; onClose: () => void }) {
  return (
    <header className="flex items-start gap-3 border-b border-line bg-card px-5 py-4">
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] font-semibold text-ink-3">{title}</p>
        <p className="num text-[18px] font-bold">{docNo}</p>
        <div className="mt-1 flex items-center gap-1.5">
          <Badge tone={status === 'voided' ? 'clay' : 'pine'}>{SETTLEMENT_STATUS_LABELS[status]}</Badge>
          {synthetic && <Badge tone="ember">合成演示</Badge>}
        </div>
      </div>
      <IconButton label="关闭" onClick={onClose} className="-mr-2">
        <X className="size-[18px]" />
      </IconButton>
    </header>
  );
}

function VoidFooter({ status, onVoid }: { status: ApOffsetDoc['status']; onVoid: () => void }) {
  const can = useCan();
  if (status !== 'confirmed' || !can('finance.void')) return null;
  return (
    <footer className="flex shrink-0 justify-end gap-2 border-t border-line bg-card px-5 py-3.5">
      <Button variant="ghost" size="sm" icon={<RotateCcw className="size-4" />} onClick={onVoid} className="text-clay hover:bg-clay-soft/60 hover:text-clay">
        冲销
      </Button>
    </footer>
  );
}

export function OffsetSheet({ id, onClose }: { id: number | null; onClose: () => void }) {
  const o = useOffset(id);
  const { busy, run } = useVoid(`/api/payables/offsets/${id ?? 0}`, o.data?.docNo ?? '');
  const [voiding, setVoiding] = useState(false);
  return (
    <Sheet open={!!id} onClose={onClose} label="核销详情" width="w-[min(520px,100vw)]">
      {o.error ? (
        <Notice tone="error" title={errorMessage(o.error)} className="m-5" />
      ) : !o.data ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      ) : (
        <>
          <SheetHeader title="核销" docNo={o.data.docNo} status={o.data.status} synthetic={o.data.isSynthetic} onClose={onClose} />
          <div className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
            {o.data.status === 'voided' && <Notice tone="error" title={`已冲销 · ${o.data.voidedByName ?? ''}`}>{o.data.voidReason}</Notice>}
            <div className="rounded-lg border border-line bg-card px-4 py-3.5">
              <p className="text-[12px] font-semibold text-ink-3">核销金额</p>
              <Money cents={o.data.amountCents} className="text-[26px] font-bold" />
              <dl className="mt-2 grid grid-cols-2 gap-x-5 gap-y-2 text-[13px]">
                <Info label="供应商">{o.data.supplier.name}</Info>
                <Info label="核销日期">
                  <span className="num">{o.data.offsetDate}</span>
                </Info>
                <Info label="用的是">
                  <Link to={creditLink(o.data.credit)} className="num text-pine hover:underline">
                    {o.data.credit.kind === 'prepayment' ? '预付款' : '退货余额'} {o.data.credit.docNo}
                  </Link>
                </Info>
                <Info label="登记">
                  {o.data.createdByName} · {formatDateTime(o.data.createdAt)}
                </Info>
                {o.data.note && (
                  <Info label="说明" wide>
                    {o.data.note}
                  </Info>
                )}
              </dl>
            </div>
            <section>
              <h3 className="mb-2 text-[13px] font-bold text-ink-2">抵扣到</h3>
              <ul className="divide-y divide-line/70 rounded-lg border border-line bg-card">
                {o.data.lines.map((l) => (
                  <li key={l.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                    {l.kind === 'receipt' ? (
                      <Link to={`/inventory/docs?doc=${l.targetId}`} className="num font-semibold text-pine hover:underline">
                        {l.docNo}
                      </Link>
                    ) : (
                      <span className="num font-semibold">{l.docNo}</span>
                    )}
                    <span className="text-ink-3">{l.kind === 'receipt' ? '收货货款' : '期初未付'}</span>
                    <span className="flex-1" />
                    <Money cents={l.amountCents} className="font-bold" />
                  </li>
                ))}
              </ul>
            </section>
            <p className="text-[12.5px] text-ink-3">核销不动钱、不记应付流水，只改这些货款的未付和可抵扣的余额。</p>
          </div>
          <VoidFooter status={o.data.status} onVoid={() => setVoiding(true)} />
          <ReasonDialog
            open={voiding}
            busy={busy}
            title={`冲销核销 ${o.data.docNo}`}
            description="冲销后可抵扣与这些货款的未付都回到核销前（只限当月）。"
            confirmLabel="确认冲销"
            danger
            onClose={() => setVoiding(false)}
            onConfirm={async (text) => {
              if (await run(text)) setVoiding(false);
            }}
          />
        </>
      )}
    </Sheet>
  );
}

export function RefundSheet({ id, onClose }: { id: number | null; onClose: () => void }) {
  const r = useRefund(id);
  const { busy, run } = useVoid(`/api/payables/refunds/${id ?? 0}`, r.data?.docNo ?? '');
  const [voiding, setVoiding] = useState(false);
  return (
    <Sheet open={!!id} onClose={onClose} label="供应商退款详情" width="w-[min(520px,100vw)]">
      {r.error ? (
        <Notice tone="error" title={errorMessage(r.error)} className="m-5" />
      ) : !r.data ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      ) : (
        <RefundBody r={r.data} onClose={onClose} onVoid={() => setVoiding(true)} />
      )}
      {r.data && (
        <ReasonDialog
          open={voiding}
          busy={busy}
          title={`冲销供应商退款 ${r.data.docNo}`}
          description={r.data.postsAp ? '冲销后反向记应付，可抵扣回到退款前（只限当月）。' : '冲销后这笔退货重新等供应商退款（只限当月）。'}
          confirmLabel="确认冲销"
          danger
          onClose={() => setVoiding(false)}
          onConfirm={async (text) => {
            if (await run(text)) setVoiding(false);
          }}
        />
      )}
    </Sheet>
  );
}

function RefundBody({ r, onClose, onVoid }: { r: SupplierRefundDoc; onClose: () => void; onVoid: () => void }) {
  return (
    <>
      <SheetHeader title="供应商退款" docNo={r.docNo} status={r.status} synthetic={r.isSynthetic} onClose={onClose} />
      <div className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
        {r.status === 'voided' && <Notice tone="error" title={`已冲销 · ${r.voidedByName ?? ''}`}>{r.voidReason}</Notice>}
        <div className="rounded-lg border border-line bg-card px-4 py-3.5">
          <p className="text-[12px] font-semibold text-ink-3">退款金额</p>
          <Money cents={r.amountCents} className="text-[26px] font-bold text-pine" />
          <dl className="mt-2 grid grid-cols-2 gap-x-5 gap-y-2 text-[13px]">
            <Info label="供应商">{r.supplier.name}</Info>
            <Info label="到账日期">
              <span className="num">{r.refundDate}</span>
            </Info>
            <Info label="方式">{PAY_METHOD_LABELS[r.method]}</Info>
            <Info label="凭据说明">{r.evidence}</Info>
            <Info label="退的是">
              <Link to={creditLink(r.credit)} className="num text-pine hover:underline">
                {r.credit.kind === 'prepayment' ? '预付款' : '退货'} {r.credit.docNo}
              </Link>
            </Info>
            <Info label="记应付">{r.postsAp ? '是（供应商退款）' : '否（现付供应商）'}</Info>
            <Info label="登记">
              {r.createdByName} · {formatDateTime(r.createdAt)}
            </Info>
            {r.note && (
              <Info label="说明" wide>
                {r.note}
              </Info>
            )}
          </dl>
        </div>
      </div>
      <VoidFooter status={r.status} onVoid={onVoid} />
    </>
  );
}

function Info({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={cn('min-w-0', wide && 'col-span-2')}>
      <dt className="text-[11.5px] font-semibold text-ink-3">{label}</dt>
      <dd className="truncate font-semibold text-ink">{children}</dd>
    </div>
  );
}
