// 登记发票（v0.7.32，docs/PAYMENTS.md 第 4 节）：发票号码、开票日、价税合计、税额、税率，分到这家供应商已下单的采购单（合计等于价税合计）。
// 提交前把操作编号和原请求存在本机（结果待确认时在付款页「发票」上方查回、重提或作废），同一供应商同一发票号码只能有一张没作废的。
// 8.0.3：选发票类型（费用报销规则里要填号码的，默认增值税专用发票），进项发票台账按它记要不要认证。

import { useState } from 'react';
import { formatAmount, parseYuan } from '@shared/money';
import { parsePercentBp } from '@shared/contracts';
import { errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, useErpPending } from '../../lib/erpPending';
import { useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { uuid } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Button, Field, Input, MoneyInput, Notice, Select } from '../../components/ui';
import { ThreeWayBadge } from './parts';
import { usePaymentMeta, useSupplierPos } from './queries';

export function InvoiceDialog({ open, onClose, onDone, supplierId: presetSupplier }: { open: boolean; onClose: () => void; onDone: () => unknown; supplierId?: number | null }) {
  const session = useSession();
  const toast = useToast();
  const meta = usePaymentMeta();
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const pos = useSupplierPos(supplierId);
  const [invoiceNo, setInvoiceNo] = useState('');
  const [invoiceDate, setInvoiceDate] = useState('');
  const [total, setTotal] = useState('');
  const [tax, setTax] = useState('');
  const [rate, setRate] = useState('13');
  const [kind, setKind] = useState('vat_special');
  const [note, setNote] = useState('');
  const [split, setSplit] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useErpPending(['supplier_invoice']);
  useResetOnOpen(open, () => {
    setSupplierId(presetSupplier ?? null);
    setInvoiceNo('');
    setInvoiceDate(session.calendarToday);
    setTotal('');
    setTax('');
    setRate('13');
    setKind('vat_special');
    setNote('');
    setSplit({});
    setError(null);
  });

  const totalCents = total.trim() ? parseYuan(total) : null;
  const taxCents = tax.trim() ? parseYuan(tax) : 0;
  const rateBp = parsePercentBp(rate);
  const kinds = meta.data?.invoiceKinds ?? [];
  const kindDef = kinds.find((k) => k.key === kind);
  const lines = Object.entries(split)
    .map(([poId, text]) => ({ poId: Number(poId), cents: text.trim() ? parseYuan(text) : null, text }))
    .filter((l) => l.text.trim());
  const splitSum = lines.reduce((s, l) => s + (l.cents ?? 0), 0);
  const problem =
    pending.length > 0
      ? '上一张发票结果待确认，请先在上方查回、按原内容重新提交或作废'
      : !supplierId
        ? '请选择供应商'
        : !invoiceNo.trim()
          ? '请填写发票号码'
          : !invoiceDate || invoiceDate > session.calendarToday
            ? '开票日不能晚于今天'
            : !totalCents
              ? '请填写价税合计'
              : taxCents === null || taxCents > totalCents
                ? '税额格式不对或超过价税合计'
                : rateBp === null
                  ? '税率格式不对'
                  : kinds.length > 0 && !kindDef
                    ? '请选择发票类型'
                    : lines.length === 0
                      ? '请把发票金额分到采购单上'
                      : lines.some((l) => !l.cents)
                        ? '有分到采购单的金额格式不对'
                        : splitSum !== totalCents
                          ? `分到采购单的合计 ¥${formatAmount(splitSum)} 与价税合计 ¥${formatAmount(totalCents)} 不一样`
                          : null;

  const submit = async () => {
    if (problem) return;
    setBusy(true);
    setError(null);
    const supplier = meta.data?.suppliers.find((s) => s.id === supplierId);
    const body = {
      clientKey: uuid(),
      supplierId,
      invoiceNo: invoiceNo.trim(),
      kind,
      invoiceDate,
      totalCents,
      taxCents,
      taxRateBp: rateBp,
      note: note.trim(),
      lines: lines.map((l) => ({ poId: l.poId, amountCents: l.cents })),
    };
    try {
      await sendErpOp({
        key: body.clientKey,
        type: 'supplier_invoice',
        url: '/api/erp/payments/invoices',
        body,
        summary: `${supplier?.name ?? '供应商'} 发票 ${body.invoiceNo} ¥${formatAmount(totalCents!)}`,
        staffName: session.staff.displayName,
      });
      toast({ tone: 'success', title: '发票已登记', body: `${body.invoiceNo} · ¥${formatAmount(totalCents!)}` });
      onClose();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'error', title: '发票登记没收到结果', body: '记在「发票」上方的「结果待确认」里，查回或按原内容重新提交' });
        onClose();
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
      await onDone();
    }
  };

  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title="登记发票"
      description="供应商开来的发票分到对应的采购单上；采购单的收货与发票差额超过 1% 或 ¥50 的会挂起，要财务确认放行。"
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!!problem} onClick={() => void submit()} data-testid="invoice-confirm">
            登记发票
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="供应商" htmlFor="iv-supplier" className="sm:col-span-3">
          <Select id="iv-supplier" value={supplierId ?? ''} onChange={(e) => (setSupplierId(Number(e.target.value) || null), setSplit({}))} data-testid="invoice-supplier">
            <option value="">选择供应商</option>
            {(meta.data?.suppliers ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="发票类型" htmlFor="iv-kind">
          <Select id="iv-kind" value={kinds.length === 0 || kindDef ? kind : ''} onChange={(e) => setKind(e.target.value)} data-testid="invoice-kind">
            {kinds.length === 0 && <option value="vat_special">增值税专用发票</option>}
            {kinds.length > 0 && !kindDef && <option value="">选择发票类型</option>}
            {kinds.map((k) => (
              <option key={k.key} value={k.key}>
                {k.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="发票号码" htmlFor="iv-no">
          <Input id="iv-no" value={invoiceNo} maxLength={40} onChange={(e) => setInvoiceNo(e.target.value)} className="h-10" data-testid="invoice-no" />
        </Field>
        <Field label="开票日" htmlFor="iv-date">
          <Input id="iv-date" type="date" value={invoiceDate} max={session.calendarToday} onChange={(e) => setInvoiceDate(e.target.value)} className="h-10" />
        </Field>
        <Field label="税率（%）" htmlFor="iv-rate">
          <Input id="iv-rate" value={rate} onChange={(e) => setRate(e.target.value)} className="h-10 text-right" />
        </Field>
        <Field label="价税合计" htmlFor="iv-total">
          <MoneyInput id="iv-total" value={total} onChange={(e) => setTotal(e.target.value)} data-testid="invoice-total" />
        </Field>
        <Field label="其中税额" htmlFor="iv-tax">
          <MoneyInput id="iv-tax" value={tax} onChange={(e) => setTax(e.target.value)} />
        </Field>
        <Field label="备注（选填）" htmlFor="iv-note">
          <Input id="iv-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} className="h-10" />
        </Field>
      </div>
      {supplierId && (
        <div className="mt-4">
          <h4 className="mb-1.5 text-[12.5px] font-bold text-ink-2">分到采购单</h4>
          {(pos.data ?? []).length === 0 ? (
            <p className="text-[13px] text-ink-3">这家供应商还没有已下单的采购单。</p>
          ) : (
            <table className="w-full text-[13px]" data-testid="invoice-pos">
              <thead>
                <tr className="border-b border-line text-left text-[12px] text-ink-3">
                  <th className="py-1.5 pr-2 font-semibold">采购单</th>
                  <th className="py-1.5 pr-2 text-right font-semibold">采购单金额</th>
                  <th className="py-1.5 pr-2 text-right font-semibold">已收货</th>
                  <th className="py-1.5 pr-2 text-right font-semibold">已开票</th>
                  <th className="w-36 py-1.5 font-semibold">这张发票分</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/70">
                {(pos.data ?? []).map((p) => (
                  <tr key={p.poId}>
                    <td className="py-1.5 pr-2">
                      <span className="num font-semibold">{p.poNo}</span> <ThreeWayBadge status={p.status} />
                      {p.contractNo && <span className="block text-[11.5px] text-ink-3">合同 {p.contractNo}</span>}
                    </td>
                    <td className="py-1.5 pr-2 text-right">
                      <Money cents={p.poTotalCents} />
                    </td>
                    <td className="py-1.5 pr-2 text-right">
                      <Money cents={p.receivedCents} />
                    </td>
                    <td className="py-1.5 pr-2 text-right">
                      <Money cents={p.invoicedCents} />
                    </td>
                    <td className="py-1.5">
                      <MoneyInput aria-label={`分到 ${p.poNo}`} value={split[p.poId] ?? ''} onChange={(e) => setSplit((s) => ({ ...s, [p.poId]: e.target.value }))} data-testid={`invoice-split-${p.poNo}`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {kindDef && rateBp !== null && !kindDef.taxRatesBp.includes(rateBp) && (
        <p className="mt-2 text-[12.5px] text-yuzu-deep" data-testid="invoice-rate-warning">
          {`${kindDef.label}的税率通常是 ${kindDef.taxRatesBp.map((bp) => `${bp / 100}%`).join('、')}：照常登记，发票台账里会标「税率不符」`}
        </p>
      )}
      {problem && (totalCents || lines.length > 0) && <p className="mt-2 text-[12.5px] font-semibold text-ember">{problem}</p>}
      {error && <Notice tone="error" title={error} className="mt-3" />}
    </Dialog>
  );
}
