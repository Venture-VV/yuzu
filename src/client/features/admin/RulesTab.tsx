import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Minus } from 'lucide-react';
import { DEDUCTION_RULES, splitDeduction, type DeductionRule } from '@shared/deduction';
import { DEDUCTION_RULE_LABELS, ROLE_LABELS } from '@shared/labels';
import { centsToInput, parseYuan } from '@shared/money';
import { PERMISSION_LABELS, PERMISSIONS, ROLES, type Permission } from '@shared/permissions';
import { api, errorMessage } from '../../lib/api';
import { qk, useSettings } from '../../lib/queries';
import { cn } from '../../lib/utils';
import { Money } from '../../components/Money';
import { useToast } from '../../components/Toast';
import { Button, Card, Field, Input, MoneyInput, Notice, PendingBadge, SectionTitle, Select, Skeleton } from '../../components/ui';

const EXAMPLE = { balance: { principal: 50000, bonus: 5000 }, amount: 11000 };

export function RulesTab() {
  const settings = useSettings();
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<null | { storeName: string; deductionRule: DeductionRule; businessDayStartHour: number; maxRecharge: string; maxConsume: string }>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (settings.data && !draft) {
    setDraft({
      storeName: settings.data.storeName,
      deductionRule: settings.data.deductionRule,
      businessDayStartHour: settings.data.businessDayStartHour,
      maxRecharge: centsToInput(settings.data.maxRechargeCents),
      maxConsume: centsToInput(settings.data.maxConsumeCents),
    });
  }
  if (!draft) return <Skeleton className="h-96" />;

  const save = async () => {
    const maxRechargeCents = parseYuan(draft.maxRecharge);
    const maxConsumeCents = parseYuan(draft.maxConsume);
    if (!maxRechargeCents || !maxConsumeCents) return setError('请填写正确的单笔上限');
    setSaving(true);
    setError(null);
    try {
      await api.put('/api/settings', {
        storeName: draft.storeName,
        deductionRule: draft.deductionRule,
        businessDayStartHour: draft.businessDayStartHour,
        maxRechargeCents,
        maxConsumeCents,
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
        <Field label="单笔充值上限" htmlFor="r-maxr" hint="防止多输一个 0">
          <MoneyInput id="r-maxr" value={draft.maxRecharge} onChange={(e) => setDraft({ ...draft, maxRecharge: e.target.value })} />
        </Field>
        <Field label="单笔消费上限" htmlFor="r-maxc">
          <MoneyInput id="r-maxc" value={draft.maxConsume} onChange={(e) => setDraft({ ...draft, maxConsume: e.target.value })} />
        </Field>
      </Card>

      {error && <Notice tone="error" title={error} />}
      <div className="flex justify-end">
        <Button variant="primary" loading={saving} onClick={save}>
          保存规则
        </Button>
      </div>

      <Card className="p-5">
        <SectionTitle aside={<PendingBadge />}>岗位权限</SectionTitle>
        <p className="mt-1 text-[12.5px] text-ink-3">当前按下表执行；确认后由维护人员在代码中调整（src/shared/permissions.ts）。</p>
        <div className="mt-3 overflow-hidden rounded-lg border border-line">
          <table className="w-full text-[13px]">
            <thead className="bg-paper-2/70 text-[12px] font-bold text-ink-3">
              <tr>
                <th className="px-4 py-2 text-left">操作</th>
                {ROLES.map((r) => (
                  <th key={r} className="w-20 px-2 py-2 text-center">
                    {ROLE_LABELS[r]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line/70">
              {(Object.keys(PERMISSIONS) as Permission[]).map((p) => (
                <tr key={p}>
                  <td className="px-4 py-2">{PERMISSION_LABELS[p]}</td>
                  {ROLES.map((r) => (
                    <td key={r} className="px-2 py-2 text-center">
                      {(PERMISSIONS[p] as readonly string[]).includes(r) ? (
                        <Check className="mx-auto size-4 text-pine" strokeWidth={3} />
                      ) : (
                        <Minus className="mx-auto size-4 text-ink-4" />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
