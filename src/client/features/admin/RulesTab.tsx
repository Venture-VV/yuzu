import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { describeBusinessHours, HHMM } from '@shared/business-date';
import { DEDUCTION_RULES, splitDeduction, type DeductionRule } from '@shared/deduction';
import { APPROVAL_RULE_LABELS, type ApprovalRules, type InventorySettings } from '@shared/inventory';
import { DEDUCTION_RULE_LABELS, describeHours } from '@shared/labels';
import { centsToInput, parseYuan } from '@shared/money';
import { api, errorMessage } from '../../lib/api';
import { qk, useSettings } from '../../lib/queries';
import { useSession } from '../../lib/session';
import { cn } from '../../lib/utils';
import { Money } from '../../components/Money';
import { useToast } from '../../components/Toast';
import { Button, Card, Field, Input, MoneyInput, Notice, PendingBadge, SectionTitle, Segmented, Select, Skeleton } from '../../components/ui';
import { useInvSettings } from '../inventory/queries';
import { ShiftModeCard } from './ShiftModeCard';
import { TunablesCard } from './TunablesCard';
import { SubPane } from '../../components/SubNav';
import { AdminPage } from './AdminShell';

const EXAMPLE = { balance: { principal: 50000, bonus: 5000 }, amount: 11000 };
/** 撤销时限的常用选项（小时）；null 为不限 */
const REVERSAL_WINDOWS: (number | null)[] = [null, 2, 24, 48, 72, 168, 720];

interface Draft {
  storeName: string;
  deductionRule: DeductionRule;
  businessDayStartHour: number;
  maxRecharge: string;
  maxConsume: string;
  /** 充值当日的储值消费比例（%，8.0.4）；空为不限 */
  spendPct: string;
  reversalWindowHours: number | null;
  /** 全天营业时为 null */
  businessHours: { open: string; close: string } | null;
  /** 自定义赠金的有效期（天），空为长期有效 */
  customBonusValidDays: string;
  /** 充值、结账、反结账前必须先开班（R1.2） */
  requireOpenShift: boolean;
  /** 店主签认后隐藏页面上的「待确认」标记 */
  hidePendingMarks: boolean;
}

export function RulesTab() {
  const session = useSession();
  const settings = useSettings();
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (settings.data && !draft) {
    setDraft({
      storeName: settings.data.storeName,
      deductionRule: settings.data.deductionRule,
      businessDayStartHour: settings.data.businessDayStartHour,
      maxRecharge: centsToInput(settings.data.maxRechargeCents),
      maxConsume: centsToInput(settings.data.maxConsumeCents),
      spendPct: settings.data.rechargeSpendPct === null ? '' : String(settings.data.rechargeSpendPct),
      reversalWindowHours: settings.data.reversalWindowHours,
      businessHours: settings.data.businessHours,
      customBonusValidDays: settings.data.customBonusValidDays ? String(settings.data.customBonusValidDays) : '',
      requireOpenShift: settings.data.requireOpenShift,
      hidePendingMarks: settings.data.hidePendingMarks,
    });
  }
  if (!draft) return <Skeleton className="h-96" />;
  const windowOptions = REVERSAL_WINDOWS.includes(draft.reversalWindowHours) ? REVERSAL_WINDOWS : [...REVERSAL_WINDOWS, draft.reversalWindowHours];

  const save = async () => {
    const maxRechargeCents = parseYuan(draft.maxRecharge);
    const maxConsumeCents = parseYuan(draft.maxConsume);
    if (!maxRechargeCents || !maxConsumeCents) return setError('请填写正确的单笔上限');
    const spendPct = draft.spendPct.trim() ? Number(draft.spendPct.trim()) : null;
    if (spendPct !== null && (!Number.isInteger(spendPct) || spendPct < 1 || spendPct > 100)) return setError('充值当日的消费比例请填 1–100 的整数，不限请留空');
    const hours = draft.businessHours;
    if (hours && (!HHMM.test(hours.open) || !HHMM.test(hours.close))) return setError('请填写营业时间（开门与打烊时间）');
    if (hours && hours.open === hours.close) return setError('开门与打烊时间不能相同；全天营业请选「全天 24 小时」');
    const customDays = draft.customBonusValidDays.trim() ? Number(draft.customBonusValidDays) : null;
    if (customDays !== null && (!Number.isInteger(customDays) || customDays < 1 || customDays > 3650)) {
      return setError('自定义赠金有效期请填 1–3650 天，长期有效请留空');
    }
    setSaving(true);
    setError(null);
    try {
      await api.put('/api/settings', {
        storeName: draft.storeName,
        deductionRule: draft.deductionRule,
        businessDayStartHour: draft.businessDayStartHour,
        maxRechargeCents,
        maxConsumeCents,
        rechargeSpendPct: spendPct,
        reversalWindowHours: draft.reversalWindowHours,
        businessHours: draft.businessHours,
        customBonusValidDays: customDays,
        requireOpenShift: draft.requireOpenShift,
        hidePendingMarks: draft.hidePendingMarks,
      });
      await qc.invalidateQueries({ queryKey: qk.settings });
      await qc.invalidateQueries({ queryKey: qk.session });
      toast({ tone: 'success', title: '经营规则已保存', body: '新规则对之后的业务生效，已入账的单据不受影响。' });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  // 二级页签（8.0.17）：原来一长页 5 张大卡。8.0.18：库存与采购的规则、可调的数值里属于 ERP 的，挪到「ERP 设置」
  // （旧地址 /admin/rules/inventory 跳过去；这一页的「可调的数值」底下留一条链接）
  const tabs = [
    { key: 'basic', label: '基本与收款' },
    { key: 'shift', label: '交班方式' },
    { key: 'tunables', label: '可调的数值' },
  ];
  return (
    <AdminPage section="rules" description="门店与营业时间、扣款顺序、单笔上限、撤销时限、收款前开班；交班方式；可调的数值。库存、采购、审批、付款这些 ERP 的规则在「ERP 设置」里。修改只影响之后的业务。" tabs={tabs}>
     <SubPane tab="basic" className="space-y-5">
      {settings.data?.hidePendingMarks ? (
        <Notice tone="info" title="店主已签认经营规则，「待确认」标记已隐藏">
          修改只影响之后的业务；已入账单据按当时的规则记录，撤销按原单构成恢复。
        </Notice>
      ) : (
        <Notice tone="warning" title="标着「待确认」的是模拟规则，正式试用前需店主确认">
          扣款顺序、营业日口径、岗位权限都标为「待确认」。修改只影响之后的业务；已入账单据按当时的规则记录，撤销按原单构成恢复。店主签认后，可以在下面把「待确认」标记设为隐藏。
        </Notice>
      )}

      <Card className="p-5">
        <SectionTitle aside={<PendingBadge />}>本金与赠金的扣款顺序</SectionTitle>
        <p className="mt-1 text-[12.5px] text-ink-3">
          示例：会员本金 <Money cents={EXAMPLE.balance.principal} />、赠金 <Money cents={EXAMPLE.balance.bonus} />，消费 <Money cents={EXAMPLE.amount} />
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {DEDUCTION_RULES.map((rule) => {
            const r = splitDeduction(EXAMPLE.amount, EXAMPLE.balance, rule);
            const active = draft.deductionRule === rule;
            return (
              <button
                key={rule}
                type="button"
                aria-pressed={active}
                onClick={() => setDraft({ ...draft, deductionRule: rule })}
                className={cn(
                  'rounded-lg border bg-card p-4 text-left transition-all',
                  active ? 'border-pine shadow-[0_0_0_3px_rgb(36_73_58/0.12)]' : 'border-line hover:border-line-strong',
                )}
              >
                <div className="flex items-center justify-between">
                  <p className="text-[14.5px] font-bold">{DEDUCTION_RULE_LABELS[rule].title}</p>
                  <span className={cn('flex size-5 items-center justify-center rounded-full border-2', active ? 'border-pine bg-pine text-paper' : 'border-ink-4')}>
                    {active && <Check className="size-3" strokeWidth={3.5} />}
                  </span>
                </div>
                <p className="mt-1 text-[12.5px] text-ink-3">{DEDUCTION_RULE_LABELS[rule].description}</p>
                {r.ok && (
                  <div className="mt-3 grid grid-cols-2 gap-2 rounded-md bg-paper-2/70 p-2.5 text-[12px]">
                    <div>
                      <p className="text-ink-3">扣本金</p>
                      <Money cents={r.principal} className="text-[14px] font-bold text-pine" />
                    </div>
                    <div>
                      <p className="text-ink-3">扣赠金</p>
                      <Money cents={r.bonus} className="text-[14px] font-bold text-yuzu-deep" />
                    </div>
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </Card>

      <Card className="grid gap-5 p-5 md:grid-cols-2">
        <Field label="门店名称" htmlFor="r-store">
          <Input id="r-store" value={draft.storeName} maxLength={32} onChange={(e) => setDraft({ ...draft, storeName: e.target.value })} />
        </Field>
        <Field label={<span className="inline-flex items-center gap-2">营业日切换时间 <PendingBadge /></span>} hint="例如 6:00：凌晨 2 点的业务仍记入前一天营业日">
          <Select value={draft.businessDayStartHour} onChange={(e) => setDraft({ ...draft, businessDayStartHour: Number(e.target.value) })}>
            {Array.from({ length: 13 }, (_, h) => (
              <option key={h} value={h}>
                每天 {String(h).padStart(2, '0')}:00
              </option>
            ))}
          </Select>
        </Field>
        <Field label="单笔充值上限" htmlFor="r-maxr" hint="超过时需店主或店总在弹窗里输入账号密码当场授权（店主确认默认 50 万元）">
          <MoneyInput id="r-maxr" value={draft.maxRecharge} onChange={(e) => setDraft({ ...draft, maxRecharge: e.target.value })} />
        </Field>
        <Field label="单笔消费上限" htmlFor="r-maxc" hint="同上，超过需当场授权">
          <MoneyInput id="r-maxc" value={draft.maxConsume} onChange={(e) => setDraft({ ...draft, maxConsume: e.target.value })} />
        </Field>
        <Field
          label={<span className="inline-flex items-center gap-2">充值当日的储值消费比例（%） <PendingBadge title="HY01：会员充了值的那一天，储值支付不超过「当天第一笔充值前的余额 + 当天充值实收 × 这个比例」；默认 70，待店主确认" /></span>}
          htmlFor="r-spend-pct"
          hint="会员充了值的那一天，用储值付的钱不超过「充值前的余额 + 当天充值实收 × 这个比例」；例：新会员充 10 万、比例 70，当天最多用 7 万储值。超过的直接拒绝并显示剩余额度；留空不限"
        >
          <Input id="r-spend-pct" value={draft.spendPct} inputMode="numeric" placeholder="不限" data-testid="rules-spend-pct" onChange={(e) => setDraft({ ...draft, spendPct: e.target.value })} />
        </Field>
        <Field
          label="撤销与反结账时限"
          htmlFor="r-window"
          hint="消费或结账后多长时间内，值班经理及以上可以撤销消费、反结账；超过后只有店主可以（店主 2026-10-29 签认默认 48 小时）"
        >
          <Select
            id="r-window"
            value={draft.reversalWindowHours ?? ''}
            onChange={(e) => setDraft({ ...draft, reversalWindowHours: e.target.value ? Number(e.target.value) : null })}
          >
            {windowOptions.map((h) => (
              <option key={h ?? 'none'} value={h ?? ''}>
                {h === null ? '不限' : `消费 / 结账后 ${describeHours(h)}内`}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="「待确认」标记"
          hint="页面上标着「待确认」的是还没签认、先按推荐做的模拟规则；店主签认后可以隐藏这些标记（只影响显示，不改任何规则，随时可以再显示）"
        >
          <Segmented
            ariaLabel="「待确认」标记"
            value={draft.hidePendingMarks ? 'hide' : 'show'}
            onChange={(v) => setDraft({ ...draft, hidePendingMarks: v === 'hide' })}
            options={[
              { value: 'show', label: '显示' },
              { value: 'hide', label: '隐藏（店主已签认）' },
            ]}
          />
        </Field>
        <Field label="收款前必须先开班" hint="开启时充值、结账、反结账前都要先开班（页面上可以就地开班），每笔收款都记到当班的交班表（店主 2026-10-29 签认默认开启）">
          <Segmented
            ariaLabel="收款前必须先开班"
            value={draft.requireOpenShift ? 'on' : 'off'}
            onChange={(v) => setDraft({ ...draft, requireOpenShift: v === 'on' })}
            options={[
              { value: 'on', label: '必须先开班' },
              { value: 'off', label: '不要求（不记班次）' },
            ]}
          />
        </Field>
        <Field
          label={<span className="inline-flex items-center gap-2">自定义赠金有效期（天） <PendingBadge /></span>}
          htmlFor="r-bonus-days"
          hint="不按套餐、手动填写赠金时使用；留空为长期有效。套餐的赠金有效期在「套餐与项目」里设置"
        >
          <Input
            id="r-bonus-days"
            inputMode="numeric"
            className="num"
            maxLength={4}
            placeholder="长期有效"
            value={draft.customBonusValidDays}
            onChange={(e) => setDraft({ ...draft, customBonusValidDays: e.target.value.replace(/\D/g, '') })}
          />
        </Field>
        <Field
          label={<span className="inline-flex items-center gap-2">营业时间 <PendingBadge /></span>}
          hint={`${describeBusinessHours(draft.businessHours)}；只用于显示与提醒，不影响营业日切换与记账`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              ariaLabel="营业时间"
              value={draft.businessHours ? 'hours' : 'all_day'}
              onChange={(v) => setDraft({ ...draft, businessHours: v === 'all_day' ? null : (draft.businessHours ?? { open: '10:00', close: '02:00' }) })}
              options={[
                { value: 'all_day', label: '全天 24 小时' },
                { value: 'hours', label: '指定时间' },
              ]}
            />
            {draft.businessHours && (
              <span className="flex items-center gap-1.5">
                <Input
                  type="time"
                  aria-label="开门时间"
                  fullWidth={false}
                  className="w-[140px]"
                  value={draft.businessHours.open}
                  onChange={(e) => setDraft({ ...draft, businessHours: { ...draft.businessHours!, open: e.target.value } })}
                />
                <span className="text-ink-3">至</span>
                <Input
                  type="time"
                  aria-label="打烊时间"
                  fullWidth={false}
                  className="w-[140px]"
                  value={draft.businessHours.close}
                  onChange={(e) => setDraft({ ...draft, businessHours: { ...draft.businessHours!, close: e.target.value } })}
                />
              </span>
            )}
          </div>
        </Field>
      </Card>

      {error && <Notice tone="error" title={error} />}
      <div className="flex justify-end">
        <Button variant="primary" loading={saving} onClick={save}>
          保存规则
        </Button>
      </div>
      <Notice tone="info" title="渠道来源与会员标签在「渠道与标签」设置，档级与会籍在「会员规则」设置；各岗位的权限在「岗位权限」设置" />
     </SubPane>

      {/* 交班方式与钱箱（v0.7.28 ⑨）单独保存 */}
      <SubPane tab="shift">
        <ShiftModeCard />
      </SubPane>

      {/* 可调的数值（8.0.7 A1：原来写死、标「待确认」的数值，含打印方式）单独保存 */}
      <SubPane tab="tunables">
        <TunablesCard scope="store" />
      </SubPane>
    </AdminPage>
  );
}

type CycleKey = 'weighTolerancePct' | 'stocktakeDay' | 'stocktakeGraceDays' | 'monthlyReconDay' | 'monthlyReconGraceDays' | 'batchReconGraceDays' | 'countBigPct';
const CYCLE_FIELDS: { key: CycleKey; label: string; hint: string; min: number; max: number }[] = [
  { key: 'weighTolerancePct', label: '称重收货容差（%）', hint: '称重的物料按实际称重收货，可以比采购单多出这么多（0–30）', min: 0, max: 30 },
  { key: 'stocktakeDay', label: '每月盘点日', hint: '每月几号起提醒盘点（1–28）', min: 1, max: 28 },
  { key: 'stocktakeGraceDays', label: '盘点宽限天数', hint: '盘点日过了几天还没盘完标红', min: 0, max: 27 },
  { key: 'monthlyReconDay', label: '月结对账日', hint: '每月几号起提醒月结供应商对上个月的账（1–28）', min: 1, max: 28 },
  { key: 'monthlyReconGraceDays', label: '月结对账宽限天数', hint: '对账日过了几天还没登记标红', min: 0, max: 27 },
  { key: 'batchReconGraceDays', label: '按批次对账宽限天数', hint: '按批次的供应商，收货后几天还没登记对账标红', min: 0, max: 30 },
  { key: 'countBigPct', label: '盘点大差异（超过账面的 %）', hint: '差异超过账面的这个比例算大差异：要写原因、走审批（v0.7.30，1–50）', min: 1, max: 50 },
];

/** 库存与采购的经营规则（模拟规则，可由店主调整） */
/** 库存与采购的规则（8.0.18 起显示在「ERP 设置 → 库存与审批开关」） */
export function InventoryRules() {
  const settings = useInvSettings();
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<InventorySettings | null>(null);
  const [capText, setCapText] = useState('');
  const [thresholdText, setThresholdText] = useState('');
  const [windowText, setWindowText] = useState('');
  // 称重容差与盘点、对账提醒（#14、#23，v0.7.13）
  const [cycle, setCycle] = useState<Record<CycleKey, string>>({
    weighTolerancePct: '',
    stocktakeDay: '',
    stocktakeGraceDays: '',
    monthlyReconDay: '',
    monthlyReconGraceDays: '',
    batchReconGraceDays: '',
    countBigPct: '',
  });
  // 盘点大差异的金额（v0.7.30）：差异数量 × 参考价超过它也算大差异
  const [bigCentsText, setBigCentsText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (settings.data && !draft) {
    setDraft(settings.data);
    setCapText(centsToInput(settings.data.urgentCapCents));
    setThresholdText(centsToInput(settings.data.approvalThresholdCents));
    setWindowText(String(settings.data.usageWindowDays));
    setCycle(Object.fromEntries(CYCLE_FIELDS.map((f) => [f.key, String(settings.data![f.key])])) as Record<CycleKey, string>);
    setBigCentsText(centsToInput(settings.data.countBigCents));
  }
  if (!draft) return <Skeleton className="h-48" />;

  const save = async () => {
    const urgentCapCents = parseYuan(capText);
    if (!urgentCapCents || urgentCapCents < 100) return setError('请填写急采上限（至少 1 元）');
    const approvalThresholdCents = thresholdText.trim() === '' ? 0 : parseYuan(thresholdText);
    if (approvalThresholdCents === null || approvalThresholdCents < 0) return setError('免确认门槛要是不小于 0 的金额（0 表示全部要负责人确认）');
    const usageWindowDays = Number(windowText);
    if (!Number.isInteger(usageWindowDays) || usageWindowDays < 7 || usageWindowDays > 90) return setError('用量统计天数要在 7 到 90 天之间');
    const cycleValues = {} as Record<CycleKey, number>;
    for (const f of CYCLE_FIELDS) {
      const v = Number(cycle[f.key]);
      if (cycle[f.key].trim() === '' || !Number.isInteger(v) || v < f.min || v > f.max) return setError(`${f.label}要在 ${f.min} 到 ${f.max} 之间`);
      cycleValues[f.key] = v;
    }
    const countBigCents = parseYuan(bigCentsText);
    if (!countBigCents || countBigCents < 100 || countBigCents > 10_000_000) return setError('盘点大差异的金额要在 ¥1 到 ¥10 万之间');
    setSaving(true);
    setError(null);
    try {
      const next = await api.put<InventorySettings>('/api/inventory/settings', { ...draft, urgentCapCents, approvalThresholdCents, usageWindowDays, ...cycleValues, countBigCents });
      qc.setQueryData(['inv', 'settings'], next);
      toast({ tone: 'success', title: '库存与采购规则已保存', body: '只影响之后提交的单据。' });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  const rule = (key: keyof ApprovalRules, value: boolean) => setDraft({ ...draft, approvalRules: { ...draft.approvalRules, [key]: value } });

  return (
    <Card className="p-5">
      <SectionTitle aside={<PendingBadge />}>库存与采购</SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">库存范围、价格口径、急采上限与负责人确认（没有审批规则命中时的默认规则；多级审批在 ERP「审批中心」设）。常规领料、收货、退回不需要逐笔审批；总仓的盘点调整固定需要确认，部门小仓只有大差异的要审批。</p>
      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <Field label="库存范围" htmlFor="i-scope" hint="库存数字代表哪里，避免重复管理">
          <Input id="i-scope" value={draft.scopeName} maxLength={20} onChange={(e) => setDraft({ ...draft, scopeName: e.target.value })} />
        </Field>
        <Field label="价格口径" htmlFor="i-basis" hint="比价只比较同规格、同单位、同口径">
          <Input id="i-basis" value={draft.priceBasis} maxLength={20} onChange={(e) => setDraft({ ...draft, priceBasis: e.target.value })} />
        </Field>
        <Field label="急采上限" htmlFor="i-urgent-cap" hint="收货必须按采购单；没有采购单只能登记急采，每张不超过这个金额">
          <MoneyInput id="i-urgent-cap" value={capText} onChange={(e) => setCapText(e.target.value)} />
        </Field>
        <Field label="免确认门槛" htmlFor="i-threshold" hint="下面勾选的单据，金额不超过这个数的提交即生效（报损按参考价估算）；填 0 全部要确认">
          <MoneyInput id="i-threshold" value={thresholdText} onChange={(e) => setThresholdText(e.target.value)} />
        </Field>
        <Field label="可用天数按近几天的用量算" htmlFor="i-window" hint="物料设了提醒天数时：可用天数 = 结存 ÷ 这段时间的日均用量（7–90 天）">
          <Input id="i-window" inputMode="numeric" value={windowText} onChange={(e) => setWindowText(e.target.value.replace(/\D/g, ''))} />
        </Field>
      </div>
      <p className="mt-5 mb-2 text-[13px] font-bold text-ink-2">称重与盘点、对账提醒</p>
      <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3">
        {CYCLE_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} htmlFor={`i-${f.key}`} hint={f.hint}>
            <Input id={`i-${f.key}`} inputMode="numeric" value={cycle[f.key]} onChange={(e) => setCycle({ ...cycle, [f.key]: e.target.value.replace(/\D/g, '') })} />
          </Field>
        ))}
        <Field label="盘点大差异（差异金额）" htmlFor="i-count-big-cents" hint="差异数量 × 参考价超过这个金额也算大差异（v0.7.30）">
          <MoneyInput id="i-count-big-cents" value={bigCentsText} onChange={(e) => setBigCentsText(e.target.value)} />
        </Field>
      </div>
      <p className="mt-5 mb-2 text-[13px] font-bold text-ink-2">需要负责人确认的单据</p>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {(Object.keys(APPROVAL_RULE_LABELS) as (keyof ApprovalRules)[]).map((k) => (
          <label key={k} className={cn('flex cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2.5', draft.approvalRules[k] ? 'border-pine bg-pine-tint' : 'border-line-strong bg-card')}>
            <input type="checkbox" checked={draft.approvalRules[k]} onChange={(e) => rule(k, e.target.checked)} className="size-4 accent-[var(--color-pine)]" />
            <span className="text-[13.5px] font-semibold">{APPROVAL_RULE_LABELS[k]}</span>
          </label>
        ))}
        <label className="flex items-center gap-2.5 rounded-md border border-pine bg-pine-tint px-3 py-2.5 opacity-70">
          <input type="checkbox" checked disabled className="size-4 accent-[var(--color-pine)]" />
          <span className="text-[13.5px] font-semibold">盘点调整（固定需要）</span>
        </label>
      </div>
      {error && <Notice tone="error" title={error} className="mt-3" />}
      <div className="mt-4 flex justify-end">
        <Button variant="primary" loading={saving} onClick={save}>
          保存库存规则
        </Button>
      </div>
    </Card>
  );
}
