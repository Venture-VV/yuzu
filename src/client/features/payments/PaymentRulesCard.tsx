// 付款规则（8.0.6，店主 2026-11-10：付款流 P1–P12 照默认，有争议的数值与开关不写死，docs/PAYMENTS.md 第 11 节）。
// 在 ERP「付款 → 付款规则」里看；改要「修改经营规则设置」（默认只有店主）。改了立即生效、记审计，
// 已经算出来的结果（已提交的付款申请的审批链、已经记下的放行）不回头改。

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { bpToInput, parsePercentBp } from '@shared/contracts';
import { centsToInput, parseYuan } from '@shared/money';
import { DEFAULT_PAYMENT_RULES, nextPayDay, normalizePayDays, PAY_DAYS_MAX, PAYMENT_RULE_LIMITS, threeWayToleranceText, type PaymentRules } from '@shared/payments';
import { api, errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { useToast } from '../../components/Toast';
import { Button, Card, Field, Input, MoneyInput, Notice, Skeleton } from '../../components/ui';
import { pk, usePaymentRules } from './queries';

interface Draft {
  ownerLevelOn: boolean;
  ownerLevel: string;
  requireRequest: boolean;
  pct: string;
  cap: string;
  remindDays: string;
  weeks: string;
  /** 固定付款日：写成「15、30」 */
  payDays: string;
}

const toDraft = (r: PaymentRules): Draft => ({
  ownerLevelOn: r.ownerLevelCents !== null,
  ownerLevel: centsToInput(r.ownerLevelCents ?? DEFAULT_PAYMENT_RULES.ownerLevelCents!),
  requireRequest: r.requireRequestForContractGoods,
  pct: bpToInput(r.threeWayPctBp),
  cap: centsToInput(r.threeWayCapCents),
  remindDays: String(r.warrantyRemindDays),
  weeks: String(r.weeklyWeeks),
  payDays: r.payDays.join('、'),
});

const inRange = (n: number, l: { min: number; max: number }) => Number.isInteger(n) && n >= l.min && n <= l.max;

/** 页面的草稿 → 提交的规则；不合格返回要提示的话 */
function fromDraft(d: Draft): PaymentRules | string {
  const L = PAYMENT_RULE_LIMITS;
  const ownerLevelCents = d.ownerLevelOn ? parseYuan(d.ownerLevel) : null;
  if (d.ownerLevelOn && (ownerLevelCents === null || !inRange(ownerLevelCents, L.ownerLevelCents))) return `加店主一级的金额要在 ¥${centsToInput(L.ownerLevelCents.min)} 到 ¥${centsToInput(L.ownerLevelCents.max)} 之间`;
  const threeWayPctBp = parsePercentBp(d.pct);
  if (threeWayPctBp === null || !inRange(threeWayPctBp, L.threeWayPctBp)) return '三单差额比例写成 1 或 0.5 这样（百分之几，0–100，最多两位小数）';
  const threeWayCapCents = d.cap.trim() === '' ? 0 : parseYuan(d.cap);
  if (threeWayCapCents === null || !inRange(threeWayCapCents, L.threeWayCapCents)) return `三单差额上限要在 ¥0 到 ¥${centsToInput(L.threeWayCapCents.max)} 之间`;
  const warrantyRemindDays = Number(d.remindDays);
  if (!inRange(warrantyRemindDays, L.warrantyRemindDays)) return `质保金提前提醒天数要是 ${L.warrantyRemindDays.min}–${L.warrantyRemindDays.max} 的整数`;
  const weeklyWeeks = Number(d.weeks);
  if (!inRange(weeklyWeeks, L.weeklyWeeks)) return `本周应付的周数要是 ${L.weeklyWeeks.min}–${L.weeklyWeeks.max} 的整数`;
  // 固定付款日：用顿号、逗号或空格隔开的几号；空着 = 没有固定付款日
  const dayTexts = d.payDays.split(/[、,，\s/]+/).map((x) => x.replace(/号$/, '').trim()).filter(Boolean);
  const dayNumbers = dayTexts.map(Number);
  if (dayNumbers.some((n) => !Number.isInteger(n) || n < 1 || n > 31)) return '固定付款日写成「15、30」这样（每月几号，1–31）；空着就是没有固定付款日';
  const payDays = normalizePayDays(dayNumbers);
  if (payDays.length > PAY_DAYS_MAX) return `固定付款日最多 ${PAY_DAYS_MAX} 个`;
  return { ownerLevelCents, requireRequestForContractGoods: d.requireRequest, threeWayPctBp, threeWayCapCents, warrantyRemindDays, weeklyWeeks, payDays };
}

export function PaymentRulesCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const can = useCan();
  const session = useSession();
  const editable = can('settings.manage');
  const rules = usePaymentRules();
  const [draft, setDraft] = useState<Draft | null>(null);
  // 打开时（或上次保存后）的规则：保存时只交改过的字段，两个页面同时开着时不会把别人刚改的改回去（Codex 审查 #82 b240f89 的 P1）
  const [base, setBase] = useState<PaymentRules | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (rules.data && !draft) {
      setDraft(toDraft(rules.data));
      setBase(rules.data);
    }
  }, [rules.data, draft]);

  if (!draft || !base) return rules.error ? <Notice tone="error" title={errorMessage(rules.error)} /> : <Skeleton className="h-48" />;

  const save = async () => {
    const next = fromDraft(draft);
    if (typeof next === 'string') return setError(next);
    const changed = Object.fromEntries(Object.entries(next).filter(([k, v]) => v !== base[k as keyof PaymentRules])) as Partial<PaymentRules>;
    if (Object.keys(changed).length === 0) {
      setError(null);
      toast({ tone: 'info', title: '没有改动' });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await api.put<PaymentRules>('/api/erp/payments/rules', changed);
      qc.setQueryData(pk.rules, saved);
      setDraft(toDraft(saved));
      setBase(saved);
      // 三单状态、质保金台账、本周应付都按新规则重算
      await qc.invalidateQueries({ queryKey: pk.all });
      toast({ tone: 'success', title: '付款规则已保存' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const set = (patch: Partial<Draft>) => setDraft((d) => d && { ...d, ...patch });
  const toggle = (label: string, checked: boolean, onChange: (v: boolean) => void, testId: string) => (
    <label className="flex items-center gap-2 text-[13.5px] font-semibold text-ink-2">
      <input type="checkbox" className="size-4 accent-[var(--color-pine)]" checked={checked} disabled={!editable} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
      {label}
    </label>
  );
  const saved = rules.data;

  return (
    <Card className="space-y-5 p-5" data-testid="payment-rules">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[15px] font-bold">付款规则</h2>
        <span className="text-[12.5px] text-ink-3">
          {editable ? '店主 2026-11-10 定：照默认，下面几项有争议的在这里改；改了立即生效，已经提交的申请、已经放行的三单不回头改' : '只能看：改付款规则要「修改经营规则设置」（默认只有店主）'}
        </span>
        {editable && (
          <Button variant="primary" size="sm" className="ml-auto" loading={busy} onClick={() => void save()} data-testid="payment-rules-save">
            保存规则
          </Button>
        )}
      </div>

      <section className="space-y-3 rounded-lg border border-line p-4">
        <p className="text-[13.5px] font-bold">付款申请的审批（P5）</p>
        <p className="text-[12.5px] text-ink-3">
          没有在「审批中心 → 审批规则」里为付款申请建规则时：财务 → 负责人，满下面的金额再加一级店主；提前付款一律 财务 → 负责人 → 店主（P6）。
          审批人在审批规则里另定。
        </p>
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          {toggle('满这个金额加一级店主', draft.ownerLevelOn, (v) => set({ ownerLevelOn: v }), 'pay-rules-owner-on')}
          <Field label="加店主一级的金额" htmlFor="pay-rules-owner" hint="默认 ¥50,000；不勾上时付款申请一律两级" className="min-w-[220px]">
            <MoneyInput id="pay-rules-owner" value={draft.ownerLevel} disabled={!editable || !draft.ownerLevelOn} onChange={(e) => set({ ownerLevel: e.target.value })} className="h-10 w-44" data-testid="pay-rules-owner" />
          </Field>
        </div>
      </section>

      <section className="space-y-3 rounded-lg border border-line p-4">
        <p className="text-[13.5px] font-bold">挂合同的货款（P7）</p>
        {toggle('挂了合同的采购单的货款必须先提付款申请', draft.requireRequest, (v) => set({ requireRequest: v }), 'pay-rules-require-request')}
        <p className="text-[12.5px] text-ink-3">
          默认开：批了以后按申请登记付款。关掉以后也可以在「应付货款」里直接登记付款核销到这些收货单上，合同的付款计划里这部分记在「不带付款申请的付款」，不算在各段里。
        </p>
      </section>

      <section className="space-y-3 rounded-lg border border-line p-4">
        <p className="text-[13.5px] font-bold">三单差额（P8）</p>
        <p className="text-[12.5px] text-ink-3">
          按采购单比：发票与收货（减退货）的差额不超过收货金额的这个比例、并且不超过这个金额，才算对得上；超过的挂起，要财务写原因放行。
          改了以后三单状态按新门槛算（包括已经批了还没付的申请，登记付款时还会再核对一次）。
        </p>
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <Field label="差额比例（%）" htmlFor="pay-rules-pct" hint="默认 1" className="min-w-[160px]">
            <Input id="pay-rules-pct" inputMode="decimal" value={draft.pct} disabled={!editable} onChange={(e) => set({ pct: e.target.value })} fullWidth={false} className="h-10 w-28" data-testid="pay-rules-pct" />
          </Field>
          <Field label="差额上限" htmlFor="pay-rules-cap" hint="默认 ¥50" className="min-w-[180px]">
            <MoneyInput id="pay-rules-cap" value={draft.cap} disabled={!editable} onChange={(e) => set({ cap: e.target.value })} className="h-10 w-36" data-testid="pay-rules-cap" />
          </Field>
          {saved && <span className="pb-2 text-[12.5px] text-ink-3">现在：{threeWayToleranceText(saved)}</span>}
        </div>
      </section>

      <section className="space-y-3 rounded-lg border border-line p-4">
        <p className="text-[13.5px] font-bold">质保金与本周应付（P9、P11）</p>
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <Field label="质保金到期前几天提醒" htmlFor="pay-rules-remind" hint="默认 30 天；进 ERP 待办，已到期没付的一直提醒" className="min-w-[220px]">
            <Input id="pay-rules-remind" inputMode="numeric" value={draft.remindDays} disabled={!editable} onChange={(e) => set({ remindDays: e.target.value })} fullWidth={false} className="h-10 w-28" data-testid="pay-rules-remind" />
          </Field>
          <Field label="本周应付看几周" htmlFor="pay-rules-weeks" hint="默认 4 周，从本周一算起" className="min-w-[200px]">
            <Input id="pay-rules-weeks" inputMode="numeric" value={draft.weeks} disabled={!editable} onChange={(e) => set({ weeks: e.target.value })} fullWidth={false} className="h-10 w-28" data-testid="pay-rules-weeks" />
          </Field>
        </div>
      </section>

      <section className="space-y-3 rounded-lg border border-line p-4" data-testid="pay-rules-days-section">
        <p className="text-[13.5px] font-bold">固定付款日（8.0.17）</p>
        <p className="text-[12.5px] text-ink-3">
          每月固定几号付款（店主 2026-11-13：15、30 号）。只是日子，不改审批与付款登记：新建付款申请的期望付款日默认取下一个付款日；采购流程图的「财务付款」写下个付款日，
          过了入库以后的第一个付款日还没付清的标红。这个月没有的日子（30、31 号遇上二月、小月）按月底算；空着 = 没有固定付款日。
        </p>
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <Field label="每月几号付款" htmlFor="pay-rules-days" hint={`默认 15、30；最多 ${PAY_DAYS_MAX} 个，用顿号或逗号隔开`} className="min-w-[220px]">
            <Input id="pay-rules-days" value={draft.payDays} disabled={!editable} onChange={(e) => set({ payDays: e.target.value })} fullWidth={false} placeholder="15、30" className="h-10 w-44" data-testid="pay-rules-days" />
          </Field>
          {saved && saved.payDays.length > 0 && (
            <p className="pb-2 text-[12.5px] text-ink-2" data-testid="pay-rules-next-day">
              下个付款日 <b className="num font-bold text-ink">{nextPayDay(session.calendarToday, saved.payDays)}</b>
            </p>
          )}
        </div>
      </section>

      <p className="text-[12.5px] text-ink-3">付款节点比例、质保期在每份合同里填（新合同默认 30% / 0% / 60% / 10%、质保 12 个月）；登记付款、发起申请的权限在后台「岗位权限」里改（P10）。</p>
      {error && <Notice tone="error" title={error} />}
    </Card>
  );
}
