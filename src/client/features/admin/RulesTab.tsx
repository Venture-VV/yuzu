import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Minus } from 'lucide-react';
import { describeBusinessHours, HHMM } from '@shared/business-date';
import { DEDUCTION_RULES, splitDeduction, type DeductionRule } from '@shared/deduction';
import { APPROVAL_RULE_LABELS, type ApprovalRules, type InventorySettings } from '@shared/inventory';
import { DEDUCTION_RULE_LABELS, describeHours, DUTY_LABELS, ROLE_LABELS } from '@shared/labels';
import { centsToInput, parseYuan } from '@shared/money';
import { DUTIES, PERMISSION_GROUPS, PERMISSION_LABELS, PERMISSIONS, ROLES, type Permission } from '@shared/permissions';
import { api, errorMessage } from '../../lib/api';
import { qk, useSettings } from '../../lib/queries';
import { cn } from '../../lib/utils';
import { Money } from '../../components/Money';
import { useToast } from '../../components/Toast';
import { Button, Card, Field, Input, MoneyInput, Notice, PendingBadge, SectionTitle, Segmented, Select, Skeleton } from '../../components/ui';
import { useInvSettings } from '../inventory/queries';

const EXAMPLE = { balance: { principal: 50000, bonus: 5000 }, amount: 11000 };
/** 撤销时限的常用选项（小时）；null 为不限 */
const REVERSAL_WINDOWS: (number | null)[] = [null, 2, 24, 48, 72, 168, 720];

interface Draft {
  storeName: string;
  deductionRule: DeductionRule;
  businessDayStartHour: number;
  maxRecharge: string;
  maxConsume: string;
  reversalWindowHours: number | null;
  /** 全天营业时为 null */
  businessHours: { open: string; close: string } | null;
}

export function RulesTab() {
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
      reversalWindowHours: settings.data.reversalWindowHours,
      businessHours: settings.data.businessHours,
    });
  }
  if (!draft) return <Skeleton className="h-96" />;
  const windowOptions = REVERSAL_WINDOWS.includes(draft.reversalWindowHours) ? REVERSAL_WINDOWS : [...REVERSAL_WINDOWS, draft.reversalWindowHours];

  const save = async () => {
    const maxRechargeCents = parseYuan(draft.maxRecharge);
    const maxConsumeCents = parseYuan(draft.maxConsume);
    if (!maxRechargeCents || !maxConsumeCents) return setError('请填写正确的单笔上限');
    const hours = draft.businessHours;
    if (hours && (!HHMM.test(hours.open) || !HHMM.test(hours.close))) return setError('请填写营业时间（开门与打烊时间）');
    if (hours && hours.open === hours.close) return setError('开门与打烊时间不能相同；全天营业请选「全天 24 小时」');
    setSaving(true);
    setError(null);
    try {
      await api.put('/api/settings', {
        storeName: draft.storeName,
        deductionRule: draft.deductionRule,
        businessDayStartHour: draft.businessDayStartHour,
        maxRechargeCents,
        maxConsumeCents,
        reversalWindowHours: draft.reversalWindowHours,
        businessHours: draft.businessHours,
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

  return (
    <div className="space-y-5">
      <Notice tone="warning" title="以下均为模拟规则，正式试用前需店主确认">
        扣款顺序、营业日口径、岗位权限都标为「待确认」。修改只影响之后的业务；已入账单据按当时的规则记录，撤销按原单构成恢复。
      </Notice>

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
          label={<span className="inline-flex items-center gap-2">撤销时限 <PendingBadge /></span>}
          htmlFor="r-window"
          hint="消费后多长时间内可以撤销；超过后只有店主可以撤销"
        >
          <Select
            id="r-window"
            value={draft.reversalWindowHours ?? ''}
            onChange={(e) => setDraft({ ...draft, reversalWindowHours: e.target.value ? Number(e.target.value) : null })}
          >
            {windowOptions.map((h) => (
              <option key={h ?? 'none'} value={h ?? ''}>
                {h === null ? '不限' : `消费后 ${describeHours(h)}内`}
              </option>
            ))}
          </Select>
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

      <InventoryRules />

      <PermissionMatrix />
    </div>
  );
}

/** 库存与采购的经营规则（模拟规则，可由店主调整） */
function InventoryRules() {
  const settings = useInvSettings();
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<InventorySettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (settings.data && !draft) setDraft(settings.data);
  if (!draft) return <Skeleton className="h-48" />;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await api.put<InventorySettings>('/api/inventory/settings', draft);
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
      <p className="mt-1 text-[12.5px] text-ink-3">库存范围、价格口径与单层负责人确认。常规领用、收货、退回不需要逐笔审批；盘点调整固定需要负责人确认。</p>
      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <Field label="库存范围" htmlFor="i-scope" hint="库存数字代表哪里，避免重复管理">
          <Input id="i-scope" value={draft.scopeName} maxLength={20} onChange={(e) => setDraft({ ...draft, scopeName: e.target.value })} />
        </Field>
        <Field label="价格口径" htmlFor="i-basis" hint="比价只比较同规格、同单位、同口径">
          <Input id="i-basis" value={draft.priceBasis} maxLength={20} onChange={(e) => setDraft({ ...draft, priceBasis: e.target.value })} />
        </Field>
        <Field label="无采购单直接收货">
          <Segmented
            value={draft.allowDirectReceipt ? 'on' : 'off'}
            onChange={(v) => setDraft({ ...draft, allowDirectReceipt: v === 'on' })}
            className="w-full"
            options={[
              { value: 'on', label: '允许（标记缺少依据）' },
              { value: 'off', label: '不允许' },
            ]}
          />
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

/** 岗位与职责权限表：岗位决定会员业务，职责叠加库存与采购权限 */
function PermissionMatrix() {
  const has = (p: Permission, col: { role?: (typeof ROLES)[number]; duty?: (typeof DUTIES)[number] }) => {
    const rule = PERMISSIONS[p] as { roles: readonly string[]; duties?: readonly string[] };
    return col.role ? rule.roles.includes(col.role) : !!rule.duties?.includes(col.duty!);
  };
  const columns = [
    ...ROLES.map((r) => ({ key: r, label: ROLE_LABELS[r], role: r })),
    ...DUTIES.map((d) => ({ key: d, label: DUTY_LABELS[d].title, duty: d })),
  ];
  return (
    <Card className="p-5">
      <SectionTitle aside={<PendingBadge />}>岗位与职责权限</SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">
        一个账号 = 一个岗位 + 若干库存职责，权限取并集；服务端逐项校验。确认后由维护人员在代码中调整（src/shared/permissions.ts）。
      </p>
      <div className="mt-3 overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[760px] text-[13px]">
          <thead className="bg-paper-2/70 text-[12px] font-bold text-ink-3">
            <tr>
              <th className="px-4 py-2 text-left">操作</th>
              {columns.map((c, i) => (
                <th key={c.key} className={cn('w-[76px] px-1.5 py-2 text-center leading-tight', i === ROLES.length && 'border-l border-line')}>
                  {c.label}
                </th>
              ))}
            </tr>
            <tr className="text-[11px] font-semibold text-ink-4">
              <th />
              <th colSpan={ROLES.length} className="pb-1.5">
                岗位
              </th>
              <th colSpan={DUTIES.length} className="border-l border-line pb-1.5">
                库存与采购职责（可叠加）
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/70">
            {PERMISSION_GROUPS.map((g) => [
              <tr key={g.title} className="bg-paper/60">
                <td colSpan={columns.length + 1} className="px-4 py-1.5 text-[12px] font-bold text-ink-2">
                  {g.title}
                </td>
              </tr>,
              ...g.items.map((p) => (
                <tr key={p}>
                  <td className="px-4 py-2">{PERMISSION_LABELS[p]}</td>
                  {columns.map((c, i) => (
                    <td key={c.key} className={cn('px-1.5 py-2 text-center', i === ROLES.length && 'border-l border-line')}>
                      {has(p, c) ? <Check className="mx-auto size-4 text-pine" strokeWidth={3} /> : <Minus className="mx-auto size-4 text-ink-4" />}
                    </td>
                  ))}
                </tr>
              )),
            ])}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
