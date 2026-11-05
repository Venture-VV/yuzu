// 采购规则（店主，v0.7.29 ERP 采购五项，docs/ERP_PURCHASING.md）：采购途径的固定选项（E1）、询价比价门槛与最少报价家数（E5、E6）、
// 补货建议的触发与目标天数（E4）。放在 ERP「模块设置」里；改动记审计，之后的单据按新规则，已有的不变。

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import type { PurchaseChannelDef, PurchaseRules } from '@shared/purchasing';
import { centsToInput, parseYuan } from '@shared/money';
import { api, errorMessage } from '../../lib/api';
import { useToast } from '../../components/Toast';
import { Button, Card, Field, Input, MoneyInput, Notice, PendingBadge, Skeleton } from '../../components/ui';
import { pk, usePurchaseRules } from './queries';

interface Draft {
  channels: PurchaseChannelDef[];
  quoteThreshold: string;
  minQuotes: string;
  reorderDays: string;
  targetDays: string;
}

const toDraft = (r: PurchaseRules): Draft => ({
  channels: r.channels.map((c) => ({ ...c })),
  quoteThreshold: centsToInput(r.quoteThresholdCents),
  minQuotes: String(r.minQuotes),
  reorderDays: String(r.reorderDays),
  targetDays: String(r.targetDays),
});

export function PurchaseRulesCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const rules = usePurchaseRules();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (rules.data && !draft) setDraft(toDraft(rules.data));
  }, [rules.data, draft]);

  if (!draft) return rules.error ? <Notice tone="error" title={errorMessage(rules.error)} /> : <Skeleton className="h-48" />;

  const save = async () => {
    const quoteThresholdCents = draft.quoteThreshold.trim() === '' ? 0 : parseYuan(draft.quoteThreshold);
    const ints = { minQuotes: Number(draft.minQuotes), reorderDays: Number(draft.reorderDays), targetDays: Number(draft.targetDays) };
    if (quoteThresholdCents === null) return setError('询价门槛的金额格式不正确');
    if (Object.values(ints).some((n) => !Number.isInteger(n))) return setError('报价家数与天数要填整数');
    if (draft.channels.some((c) => !c.label.trim())) return setError('采购途径的名称不能为空');
    setBusy(true);
    setError(null);
    try {
      const next = await api.put<PurchaseRules>('/api/inventory/purchase-rules', {
        channels: draft.channels.map((c) => ({ ...c, label: c.label.trim() })),
        quoteThresholdCents,
        ...ints,
      });
      qc.setQueryData(pk.purchaseRules, next);
      setDraft(toDraft(next));
      toast({ tone: 'success', title: '采购规则已保存' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const setChannel = (i: number, patch: Partial<PurchaseChannelDef>) => setDraft((d) => d && { ...d, channels: d.channels.map((c, j) => (j === i ? { ...c, ...patch } : c)) });

  return (
    <Card className="space-y-4 p-5" data-testid="purchase-rules">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[15px] font-bold">采购规则</h2>
        <PendingBadge title="默认做法待店主确认（见 PENDING_DECISIONS「ERP 采购五项」E1、E4–E6）" />
        <span className="text-[12.5px] text-ink-3">改了之后新的单据按新规则，已有的不变</span>
        <Button variant="primary" size="sm" className="ml-auto" loading={busy} onClick={() => void save()} data-testid="purchase-rules-save">
          保存规则
        </Button>
      </div>
      <div>
        <p className="mb-1.5 text-[13px] font-semibold text-ink-2">采购途径（采购单、报销单记在哪买的）</p>
        <ul className="divide-y divide-line rounded-lg border border-line">
          {draft.channels.map((c, i) => (
            <li key={c.key} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 px-3 py-2">
              <Input aria-label="采购途径名称" value={c.label} maxLength={20} onChange={(e) => setChannel(i, { label: e.target.value })} className="h-9" data-testid={`pr-channel-${i}`} />
              <label className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-2">
                <input type="checkbox" className="size-4 accent-[var(--color-pine)]" checked={c.needsNote} onChange={(e) => setChannel(i, { needsNote: e.target.checked })} />
                要写说明
              </label>
              <Button
                variant="ghost"
                size="sm"
                icon={<Trash2 className="size-4" />}
                disabled={draft.channels.length === 1}
                onClick={() => setDraft({ ...draft, channels: draft.channels.filter((_, j) => j !== i) })}
                aria-label={`删除${c.label}`}
              />
            </li>
          ))}
        </ul>
        <Button
          variant="secondary"
          size="sm"
          className="mt-2"
          icon={<Plus className="size-4" />}
          disabled={draft.channels.length >= 12}
          onClick={() => setDraft({ ...draft, channels: [...draft.channels, { key: `custom_${Date.now().toString(36)}`, label: '', needsNote: true }] })}
        >
          加一个采购途径
        </Button>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="采购单合计到多少要先询价比价" htmlFor="pr-quote" hint="默认 5000 元；填 0 不要求。补单与已确认后的改版不拦">
          <MoneyInput id="pr-quote" value={draft.quoteThreshold} onChange={(e) => setDraft({ ...draft, quoteThreshold: e.target.value })} className="h-10" data-testid="pr-quote" />
        </Field>
        <Field label="定标至少要几家报价" htmlFor="pr-min" hint="默认 2 家；不够的标单一来源、由负责人定标">
          <Input id="pr-min" inputMode="numeric" value={draft.minQuotes} onChange={(e) => setDraft({ ...draft, minQuotes: e.target.value })} className="h-10" />
        </Field>
        <Field label="可用天数少于几天建议补货" htmlFor="pr-reorder" hint="物料设了提醒天数的按物料的；默认 7 天">
          <Input id="pr-reorder" inputMode="numeric" value={draft.reorderDays} onChange={(e) => setDraft({ ...draft, reorderDays: e.target.value })} className="h-10" />
        </Field>
        <Field label="建议补到能用几天" htmlFor="pr-target" hint="默认 14 天，要比触发天数长">
          <Input id="pr-target" inputMode="numeric" value={draft.targetDays} onChange={(e) => setDraft({ ...draft, targetDays: e.target.value })} className="h-10" />
        </Field>
      </div>
      {error && <Notice tone="error" title={error} />}
    </Card>
  );
}
