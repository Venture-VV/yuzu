// 费用报销规则（店主，v0.7.7）：确认门槛（D13，默认 2000 元）、超期天数、用途与发票类型的固定选项。
// 放在 ERP「模块设置」里；改动记审计，之后登记的报销按新规则，已登记的不变。

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { taxRateText, type ExpenseRules, type InvoiceTypeDef } from '@shared/expenses';
import { centsToInput, parseYuan } from '@shared/money';
import { api, errorMessage } from '../../lib/api';
import { useToast } from '../../components/Toast';
import { Button, Card, Field, Input, MoneyInput, Notice, PendingBadge, Skeleton, Textarea } from '../../components/ui';
import { ek, useExpenseRules } from './queries';

interface Draft {
  threshold: string;
  overdueDays: string;
  purposes: string;
  invoiceTypes: (Omit<InvoiceTypeDef, 'taxRatesBp'> & { rates: string })[];
}

const toDraft = (r: ExpenseRules): Draft => ({
  threshold: centsToInput(r.approvalThresholdCents),
  overdueDays: String(r.overdueDays),
  purposes: r.purposes.join('\n'),
  invoiceTypes: r.invoiceTypes.map((t) => ({ key: t.key, label: t.label, needsNumber: t.needsNumber, rates: t.taxRatesBp.map(taxRateText).join('、') })),
});

/** 「13%、9%、0」→ [1300, 900, 0]；不认识的返回 null */
function parseRates(text: string): number[] | null {
  const parts = text.split(/[、,，\s]+/).filter(Boolean);
  if (parts.length === 0) return null;
  const out: number[] = [];
  for (const p of parts) {
    const m = /^(\d+(?:\.\d{1,2})?)%?$/.exec(p);
    if (!m) return null;
    out.push(Math.round(Number(m[1]) * 100));
  }
  return out;
}

export function ExpenseRulesCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const rules = useExpenseRules();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (rules.data && !draft) setDraft(toDraft(rules.data));
  }, [rules.data, draft]);

  if (!draft) return rules.error ? <Notice tone="error" title={errorMessage(rules.error)} /> : <Skeleton className="h-48" />;

  const save = async () => {
    const threshold = parseYuan(draft.threshold);
    const overdueDays = Number(draft.overdueDays);
    const purposes = draft.purposes.split('\n').map((p) => p.trim()).filter(Boolean);
    const invoiceTypes = draft.invoiceTypes.map((t) => ({ key: t.key, label: t.label.trim(), needsNumber: t.needsNumber, taxRatesBp: parseRates(t.rates) }));
    if (threshold === null) return setError('确认门槛的金额格式不正确');
    if (!Number.isInteger(overdueDays)) return setError('超期天数要填整数');
    const bad = invoiceTypes.find((t) => !t.taxRatesBp);
    if (bad) return setError(`「${bad.label || '新的发票类型'}」的税点格式不正确，例如 13%、9%、0`);
    setBusy(true);
    setError(null);
    try {
      const next = await api.put<ExpenseRules>('/api/erp/expenses/rules', { approvalThresholdCents: threshold, overdueDays, purposes, invoiceTypes });
      qc.setQueryData(ek.rules, next);
      setDraft(toDraft(next));
      toast({ tone: 'success', title: '费用报销规则已保存' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const setType = (i: number, patch: Partial<Draft['invoiceTypes'][number]>) =>
    setDraft((d) => d && { ...d, invoiceTypes: d.invoiceTypes.map((t, j) => (j === i ? { ...t, ...patch } : t)) });

  return (
    <Card className="space-y-4 p-5" data-testid="expense-rules">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[15px] font-bold">费用报销规则</h2>
        <PendingBadge title="默认做法待店主确认（见 PENDING_DECISIONS「费用报销与备用金」）" />
        <span className="text-[12.5px] text-ink-3">改了之后新登记的报销按新规则，已登记的不变</span>
        <Button variant="primary" size="sm" className="ml-auto" loading={busy} onClick={() => void save()} data-testid="expense-rules-save">
          保存规则
        </Button>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="单笔超过多少要负责人确认" htmlFor="er-threshold" hint="飞书需求 D13：默认 2000 元">
          <MoneyInput id="er-threshold" value={draft.threshold} onChange={(e) => setDraft({ ...draft, threshold: e.target.value })} className="h-10" />
        </Field>
        <Field label="打款后超过几天没平账标红" htmlFor="er-days" hint="默认 7 天">
          <Input id="er-days" inputMode="numeric" value={draft.overdueDays} onChange={(e) => setDraft({ ...draft, overdueDays: e.target.value })} className="h-10" />
        </Field>
        <Field label="用途（每行一个）" htmlFor="er-purposes" className="sm:col-span-2">
          <Textarea id="er-purposes" rows={4} value={draft.purposes} onChange={(e) => setDraft({ ...draft, purposes: e.target.value })} />
        </Field>
      </div>
      <div>
        <p className="mb-1.5 text-[13px] font-semibold text-ink-2">发票类型与允许的税点</p>
        <ul className="divide-y divide-line rounded-lg border border-line">
          {draft.invoiceTypes.map((t, i) => (
            <li key={t.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-3 py-2 md:grid-cols-[180px_minmax(0,1fr)_auto_auto]">
              <Input aria-label="发票类型名称" value={t.label} maxLength={20} onChange={(e) => setType(i, { label: e.target.value })} className="h-9" />
              <Input aria-label={`${t.label}的税点`} value={t.rates} onChange={(e) => setType(i, { rates: e.target.value })} placeholder="例如 13%、9%、0" className="h-9" />
              <label className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-2">
                <input type="checkbox" className="size-4 accent-[var(--color-pine)]" checked={t.needsNumber} onChange={(e) => setType(i, { needsNumber: e.target.checked })} />
                必须填发票号
              </label>
              <Button variant="ghost" size="sm" icon={<Trash2 className="size-4" />} disabled={draft.invoiceTypes.length === 1} onClick={() => setDraft({ ...draft, invoiceTypes: draft.invoiceTypes.filter((_, j) => j !== i) })} aria-label={`删除${t.label}`} />
            </li>
          ))}
        </ul>
        <Button
          variant="secondary"
          size="sm"
          className="mt-2"
          icon={<Plus className="size-4" />}
          disabled={draft.invoiceTypes.length >= 10}
          onClick={() => setDraft({ ...draft, invoiceTypes: [...draft.invoiceTypes, { key: `custom_${Date.now().toString(36)}`, label: '', needsNumber: false, rates: '0' }] })}
        >
          加一种发票类型
        </Button>
      </div>
      {error && <Notice tone="error" title={error} />}
    </Card>
  );
}
