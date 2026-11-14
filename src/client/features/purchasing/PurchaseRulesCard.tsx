// 采购规则（v0.7.29 ERP 采购五项，docs/ERP_PURCHASING.md；8.0.1 采购组整改，docs/PURCHASING_V801.md）：
// 8.0.1 起在「采购 → 采购规则」里改（从 ERP「模块设置」挪过来，CG01），要「维护采购规则」（默认只有店主）；有查看库存的只看。
//   · 采购途径固定三类（网购、自采、供应商，CG08），这里只显示；
//   · 询价门槛与最少报价家数（E5、E6）、补货触发与目标天数（E4）、常用天数（E11，自动识别一次性采购）、下单后几天没到货算超期（从费用报销规则挪过来）；
//   · 每日截单（03，CG03）、需求单转的采购单提交即确认（04，CG04）、急采按金额分级审批与每一档的审批人（05，CG05）。
// 改动记审计，之后的单据按新规则，已有的不变。

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { APPROVAL_MAX_STAFF } from '@shared/approvals';
import { centsToInput, parseYuan } from '@shared/money';
import { DEPT_CONFIRM_RULE_LABELS, DEPT_CONFIRM_RULES, PURCHASE_CHANNELS, REPLENISH_LOOKBACK_DAYS, URGENT_TIERS_MAX, type DeptConfirmRule, type PurchaseRules } from '@shared/purchasing';
import { api, errorMessage } from '../../lib/api';
import { useCan } from '../../lib/session';
import { cn } from '../../lib/utils';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, MoneyInput, Notice, PendingBadge, Select, Skeleton } from '../../components/ui';
import { useApprovers } from '../approvals/queries';
import { pk, usePurchaseRules } from './queries';

interface Draft {
  quoteThreshold: string;
  minQuotes: string;
  reorderDays: string;
  targetDays: string;
  regularUseDays: string;
  arrivalOverdueDays: string;
  flowStallDays: string;
  deptConfirm: DeptConfirmRule;
  cutoffEnabled: boolean;
  cutoffTime: string;
  requestPoDirect: boolean;
  tiers: { max: string; approverIds: number[] }[];
}

const toDraft = (r: PurchaseRules): Draft => ({
  quoteThreshold: centsToInput(r.quoteThresholdCents),
  minQuotes: String(r.minQuotes),
  reorderDays: String(r.reorderDays),
  targetDays: String(r.targetDays),
  regularUseDays: String(r.regularUseDays),
  arrivalOverdueDays: String(r.arrivalOverdueDays),
  flowStallDays: String(r.flowStallDays),
  deptConfirm: r.deptConfirm,
  cutoffEnabled: r.cutoffEnabled,
  cutoffTime: r.cutoffTime,
  requestPoDirect: r.requestPoDirect,
  tiers: r.urgentTiers.map((t) => ({ max: centsToInput(t.maxCents), approverIds: [...t.approverIds] })),
});

const TIER_NAMES = ['审批人 A', '审批人 B', '审批人 C'];

export function PurchaseRulesCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const can = useCan();
  const editable = can('purchase.rules');
  const rules = usePurchaseRules();
  // 指定审批人要从能用审批中心的人里选（审批中心模块关着或没有权限时读不到，急采由负责人审）
  const approvers = useApprovers(editable);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (rules.data && !draft) setDraft(toDraft(rules.data));
  }, [rules.data, draft]);

  if (!draft) return rules.error ? <Notice tone="error" title={errorMessage(rules.error)} /> : <Skeleton className="h-48" />;
  const names = new Map((approvers.data ?? []).map((a) => [a.id, a.name]));

  const save = async () => {
    const quoteThresholdCents = draft.quoteThreshold.trim() === '' ? 0 : parseYuan(draft.quoteThreshold);
    const ints = {
      minQuotes: Number(draft.minQuotes),
      reorderDays: Number(draft.reorderDays),
      targetDays: Number(draft.targetDays),
      regularUseDays: Number(draft.regularUseDays),
      arrivalOverdueDays: Number(draft.arrivalOverdueDays),
      flowStallDays: Number(draft.flowStallDays),
    };
    if (quoteThresholdCents === null) return setError('询价门槛的金额格式不正确');
    if (Object.values(ints).some((n) => !Number.isInteger(n))) return setError('报价家数与天数要填整数');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.cutoffTime)) return setError('截单时间要写成 17:00 这样（24 小时制）');
    const urgentTiers = draft.tiers.map((t) => ({ maxCents: parseYuan(t.max), approverIds: t.approverIds }));
    if (urgentTiers.some((t) => t.maxCents === null || t.maxCents <= 0)) return setError('急采每一档的金额要大于 0');
    setBusy(true);
    setError(null);
    try {
      const next = await api.put<PurchaseRules>('/api/inventory/purchase-rules', {
        quoteThresholdCents,
        ...ints,
        cutoffEnabled: draft.cutoffEnabled,
        cutoffTime: draft.cutoffTime,
        requestPoDirect: draft.requestPoDirect,
        deptConfirm: draft.deptConfirm,
        urgentTiers,
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
  const setTier = (i: number, patch: Partial<Draft['tiers'][number]>) => setDraft((d) => d && { ...d, tiers: d.tiers.map((t, j) => (j === i ? { ...t, ...patch } : t)) });
  const toggle = (label: string, checked: boolean, onChange: (v: boolean) => void, testId: string) => (
    <label className="flex items-center gap-2 text-[13.5px] font-semibold text-ink-2">
      <input type="checkbox" className="size-4 accent-[var(--color-pine)]" checked={checked} disabled={!editable} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
      {label}
    </label>
  );

  return (
    <Card className="space-y-5 p-5" data-testid="purchase-rules">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[15px] font-bold">采购规则</h2>
        <PendingBadge title="默认做法待店主确认（见 PENDING_DECISIONS「ERP 采购五项」与「采购组整改 CG01–CG11」）" />
        <span className="text-[12.5px] text-ink-3">{editable ? '改了之后新的单据按新规则，已有的不变' : '只能看：改采购规则要「维护采购规则」（默认只有店主）'}</span>
        {editable && (
          <Button variant="primary" size="sm" className="ml-auto" loading={busy} onClick={() => void save()} data-testid="purchase-rules-save">
            保存规则
          </Button>
        )}
      </div>

      <section>
        <p className="mb-1.5 text-[13px] font-semibold text-ink-2">采购途径（固定三类，采购单、报销单、需求单记在哪买的）</p>
        <ul className="flex flex-wrap gap-2" data-testid="pr-channels">
          {PURCHASE_CHANNELS.map((c) => (
            <li key={c.key} className="flex items-center gap-1.5 rounded-full border border-line-strong bg-card px-3 py-1 text-[13px] font-semibold">
              {c.label}
              {c.needsNote && <span className="text-[12px] font-medium text-ink-3">要写在哪买</span>}
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3 rounded-lg border border-line p-4">
        <p className="text-[13.5px] font-bold">需求单与审核</p>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          {toggle('每日截单', draft.cutoffEnabled, (v) => setDraft({ ...draft, cutoffEnabled: v }), 'pr-cutoff')}
          <Field label="截单时间" htmlFor="pr-cutoff-time" hint="截单以后提交的需求单照常提交，当天不能审核通过（第二天起可以）" className="min-w-[220px]">
            <Input id="pr-cutoff-time" type="time" value={draft.cutoffTime} disabled={!editable || !draft.cutoffEnabled} onChange={(e) => setDraft({ ...draft, cutoffTime: e.target.value })} className="h-10 w-36" data-testid="pr-cutoff-time" />
          </Field>
        </div>
        {toggle('需求单转的采购单提交即确认（部门 → 供应链审核 → 可以采购，不用再等负责人确认）', draft.requestPoDirect, (v) => setDraft({ ...draft, requestPoDirect: v }), 'pr-request-direct')}
      </section>

      <section className="space-y-3 rounded-lg border border-line p-4" data-testid="pr-urgent">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[13.5px] font-bold">急采按金额分级审批</p>
          <span className="text-[12.5px] text-ink-3">最高一档就是急采上限；超过的请先开采购单。没指定人的一档由负责人审；登记的人不能审自己的急采</span>
        </div>
        <ul className="space-y-3">
          {draft.tiers.map((t, i) => {
            const prev = i === 0 ? null : draft.tiers[i - 1]!.max;
            return (
              <li key={i} className="space-y-2 rounded-md bg-paper-2/60 p-3" data-testid={`pr-tier-${i}`}>
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <Badge tone="yuzu">{TIER_NAMES[i]}</Badge>
                  <span className="text-ink-2">{prev ? `超过 ¥${prev} 、` : ''}不超过</span>
                  <div className="w-36">
                    <MoneyInput aria-label={`第 ${i + 1} 档上限`} value={t.max} disabled={!editable} onChange={(e) => setTier(i, { max: e.target.value })} className="h-9" data-testid={`pr-tier-max-${i}`} />
                  </div>
                  <span className="text-ink-2">的急采由</span>
                  <span className="font-semibold">{t.approverIds.length ? t.approverIds.map((id) => names.get(id) ?? `#${id}`).join('、') : '负责人'}</span>
                  <span className="text-ink-2">审</span>
                  {editable && draft.tiers.length > 1 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto"
                      icon={<Trash2 className="size-4" />}
                      onClick={() => setDraft({ ...draft, tiers: draft.tiers.filter((_, j) => j !== i) })}
                      aria-label={`删除第 ${i + 1} 档`}
                    />
                  )}
                </div>
                {editable && (
                  <div className="flex flex-wrap gap-1.5">
                    {approvers.error && <span className="text-[12.5px] text-ink-3">读不到审批中心的人员（审批中心模块关着或没有权限），这一档由负责人审</span>}
                    {(approvers.data ?? []).map((a) => {
                      const on = t.approverIds.includes(a.id);
                      return (
                        <button
                          key={a.id}
                          type="button"
                          disabled={!on && t.approverIds.length >= APPROVAL_MAX_STAFF}
                          onClick={() => setTier(i, { approverIds: on ? t.approverIds.filter((x) => x !== a.id) : [...t.approverIds, a.id] })}
                          className={cn('h-8 rounded-full border px-3 text-[12.5px] font-semibold disabled:opacity-40', on ? 'border-pine bg-pine text-paper' : 'border-line-strong bg-card text-ink-2')}
                          aria-pressed={on}
                          data-testid={`pr-tier-${i}-approver-${a.id}`}
                        >
                          {a.name}
                        </button>
                      );
                    })}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {editable && draft.tiers.length < URGENT_TIERS_MAX && (
          <Button variant="secondary" size="sm" icon={<Plus className="size-4" />} onClick={() => setDraft({ ...draft, tiers: [...draft.tiers, { max: '', approverIds: [] }] })}>
            加一档
          </Button>
        )}
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="采购单合计到多少要先询价比价" htmlFor="pr-quote" hint="默认 1000 元（8.0.17 起，原来 5000）；填 0 不要求。补单与已确认后的改版不拦">
          <MoneyInput id="pr-quote" value={draft.quoteThreshold} disabled={!editable} onChange={(e) => setDraft({ ...draft, quoteThreshold: e.target.value })} className="h-10" data-testid="pr-quote" />
        </Field>
        <Field label="定标至少要几家报价" htmlFor="pr-min" hint="默认 2 家；不够的标单一来源、由负责人定标">
          <Input id="pr-min" inputMode="numeric" value={draft.minQuotes} disabled={!editable} onChange={(e) => setDraft({ ...draft, minQuotes: e.target.value })} className="h-10" />
        </Field>
        <Field label="可用天数少于几天建议补货" htmlFor="pr-reorder" hint="物料设了提醒天数的按物料的；默认 7 天">
          <Input id="pr-reorder" inputMode="numeric" value={draft.reorderDays} disabled={!editable} onChange={(e) => setDraft({ ...draft, reorderDays: e.target.value })} className="h-10" />
        </Field>
        <Field label="建议补到能用几天" htmlFor="pr-target" hint="默认 14 天，要比触发天数长">
          <Input id="pr-target" inputMode="numeric" value={draft.targetDays} disabled={!editable} onChange={(e) => setDraft({ ...draft, targetDays: e.target.value })} className="h-10" />
        </Field>
        <Field
          label="领用几天以上才算常用（自动识别）"
          htmlFor="pr-regular"
          hint={`补货方式是「自动识别」、没设提醒、也不是台面日耗品这类消耗品的物料：近 ${REPLENISH_LOOKBACK_DAYS} 天里有领用的天数不到这个数的，看作一次性采购、不提补货（手机这类领一次就完的）。默认 2 天，填 1 = 领过一次就算。单个物料在物料档案里可以直接定成「常备」或「按需采购」`}
        >
          <Input id="pr-regular" inputMode="numeric" value={draft.regularUseDays} disabled={!editable} onChange={(e) => setDraft({ ...draft, regularUseDays: e.target.value })} className="h-10" data-testid="pr-regular" />
        </Field>
        <Field label="下单后几天没到货算超期" htmlFor="pr-arrival" hint="采购单没填预计到货日时用（账目自检第 9 条），默认 7 天；8.0.1 从费用报销规则挪过来">
          <Input id="pr-arrival" inputMode="numeric" value={draft.arrivalOverdueDays} disabled={!editable} onChange={(e) => setDraft({ ...draft, arrivalOverdueDays: e.target.value })} className="h-10" data-testid="pr-arrival" />
        </Field>
        <Field label="哪些需求单要部门主管先确认" htmlFor="pr-dept-confirm" hint="8.0.17：主管确认以后采购才能审核通过。估价 = 各行参考价 × 数量（没填参考价的行不算）；主管在「库存 → 档案 → 部门」里设，没设主管的部门不拦">
          <Select id="pr-dept-confirm" value={draft.deptConfirm} disabled={!editable} onChange={(e) => setDraft({ ...draft, deptConfirm: e.target.value as DeptConfirmRule })} className="h-10" data-testid="pr-dept-confirm">
            {DEPT_CONFIRM_RULES.map((v) => (
              <option key={v} value={v}>
                {DEPT_CONFIRM_RULE_LABELS[v]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="流程图里一个环节等了几天标红" htmlFor="pr-stall" hint="采购 → 流程进度（8.0.17）：待审核、询价、定标、待审批、待下单、待入库等了这么多天就标红；默认 2 天，0 = 不标。到货按预计到货日，另算">
          <Input id="pr-stall" inputMode="numeric" value={draft.flowStallDays} disabled={!editable} onChange={(e) => setDraft({ ...draft, flowStallDays: e.target.value })} className="h-10" data-testid="pr-stall" />
        </Field>
      </div>
      {error && <Notice tone="error" title={error} />}
    </Card>
  );
}
