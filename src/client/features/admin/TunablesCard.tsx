// 后台「经营规则」里的「可调的数值」（8.0.7 A1，店主 2026-11-10：有争议的规则不要写死）：原来写死在代码里、标「待确认」的数值，
// 按模块分组，一次保存（只提交这些项，别的规则不动）。范围与服务端同一份（@shared/tunables）；改了立即生效、记修改记录，
// 已经办完的单据不回头改。各页面上的提示文字随会话刷新。

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { centsToInput, parseYuan } from '@shared/money';
import { PRINT_MODE_LABELS, PRINT_MODES, TUNABLE_LIMITS, type IntTunable, type PrintMode, type Tunables } from '@shared/tunables';
import { api, errorMessage } from '../../lib/api';
import { qk, useSettings } from '../../lib/queries';
import { useToast } from '../../components/Toast';
import { Button, Card, Field, Input, MoneyInput, Notice, PendingBadge, SectionTitle, Segmented, Skeleton } from '../../components/ui';

/** 金额项（页面上按元填） */
const MONEY_KEYS: IntTunable[] = ['approvalBatchMaxCents', 'mpFoodMaxTotalCents'];

interface FieldDef {
  key: IntTunable;
  label: string;
  hint: string;
  unit?: string;
}

const GROUPS: { title: string; code: string; fields: FieldDef[] }[] = [
  {
    title: '审批中心',
    code: 'A5–A10',
    fields: [
      { key: 'approvalBatchMaxCents', label: '批量同意：每张不超过（元）', hint: '超过的要打开单独审（A5）' },
      { key: 'approvalBatchMax', label: '批量同意：一次最多几张', hint: 'A5', unit: '张' },
      { key: 'approvalOverdueHours', label: '超时：当前这一级等了超过几小时', hint: '超时的标红、排在最前（A6）', unit: '小时' },
      { key: 'delegationMaxDays', label: '代理人最多几天', hint: '含首尾（A7）', unit: '天' },
      { key: 'urgentEscalateDays', label: '急采收货后几天没补采购单就升级', hint: '进负责人待办（A10）', unit: '天' },
    ],
  },
  {
    title: '合同与采购附件',
    code: 'C11、CG08、CG11',
    fields: [
      { key: 'contractRemindDays', label: '合同结束日前几天提醒', hint: '进 ERP 待办（C11）', unit: '天' },
      { key: 'pdfMaxMb', label: 'PDF 每份最大（MB）', hint: '签约供应商合同、收货附件、发票附件（CG08，最多 10）', unit: 'MB' },
      { key: 'receiptAttachmentsMax', label: '每张收货单最多几份附件', hint: 'CG11', unit: '份' },
    ],
  },
  {
    title: '扫码点餐与平台核销',
    code: 'N1、N6',
    fields: [
      { key: 'mpFoodMaxQuantity', label: '小程序扫码点餐：一单最多几份', hint: 'N1', unit: '份' },
      { key: 'mpFoodMaxTotalCents', label: '小程序扫码点餐：一单最多多少钱（元）', hint: 'N1' },
      { key: 'platformBackfillDays', label: '平台核销补录最早补到几天前', hint: 'N6', unit: '天' },
    ],
  },
  {
    title: '营销与短信',
    code: 'HY07、HY08、HY16',
    fields: [
      { key: 'campaignMaxMembers', label: '批量发券一次最多发给几位', hint: '超过的要缩小范围、分几次发（HY07）', unit: '位' },
      { key: 'campaignNoticeDays', label: '到账的会员端弹窗最多显示几天', hint: 'HY16', unit: '天' },
      { key: 'smsMaxAttempts', label: '短信发不出去最多试几次', hint: 'HY08', unit: '次' },
    ],
  },
];

type Draft = Record<IntTunable, string> & { printMode: PrintMode; printWaitMinutes: string; countCardSales: boolean; financeHidesMarketingCost: boolean };

const toDraft = (s: Tunables & { countCardSales: boolean }): Draft => {
  const out = {} as Record<IntTunable, string>;
  for (const key of Object.keys(TUNABLE_LIMITS) as IntTunable[]) out[key] = MONEY_KEYS.includes(key) ? centsToInput(s[key] as number) : String(s[key]);
  return { ...out, printMode: s.printMode, printWaitMinutes: String(s.printWaitMinutes), countCardSales: s.countCardSales, financeHidesMarketingCost: s.financeHidesMarketingCost };
};

/** 页面上先核对一遍（服务端照样核对）；不合格返回提示 */
function fromDraft(d: Draft): Partial<Tunables & { countCardSales: boolean }> | string {
  const body: Record<string, unknown> = {};
  for (const key of Object.keys(TUNABLE_LIMITS) as IntTunable[]) {
    const l = TUNABLE_LIMITS[key];
    const raw = key === 'printWaitMinutes' ? d.printWaitMinutes : d[key];
    const value = MONEY_KEYS.includes(key) ? parseYuan(raw) : /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : null;
    if (value === null || !Number.isInteger(value)) return `${l.label}要填${MONEY_KEYS.includes(key) ? '金额' : '整数'}`;
    if (value < l.min || value > l.max) {
      return MONEY_KEYS.includes(key) ? `${l.label}要在 ¥${centsToInput(l.min)}–¥${centsToInput(l.max)} 之间` : `${l.label}要在 ${l.min}–${l.max} 之间`;
    }
    body[key] = value;
  }
  return { ...body, printMode: d.printMode, countCardSales: d.countCardSales, financeHidesMarketingCost: d.financeHidesMarketingCost };
}

export function TunablesCard() {
  const settings = useSettings();
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (settings.data && draft === null) setDraft(toDraft(settings.data));
  if (!draft) return <Skeleton className="h-60" />;
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });

  const save = async () => {
    const body = fromDraft(draft);
    if (typeof body === 'string') return setError(body);
    setSaving(true);
    setError(null);
    try {
      const next = await api.put<Tunables & { countCardSales: boolean }>('/api/settings', body);
      setDraft(toDraft(next));
      await qc.invalidateQueries({ queryKey: qk.settings });
      await qc.invalidateQueries({ queryKey: qk.session });
      toast({ tone: 'success', title: '可调的数值已保存', body: '立即生效；已经办完的单据不回头改' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  const toggle = (label: string, checked: boolean, onChange: (v: boolean) => void, testId: string) => (
    <label className="flex items-center gap-2 text-[13.5px] font-semibold text-ink-2">
      <input type="checkbox" className="size-4 accent-[var(--color-pine)]" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
      {label}
    </label>
  );

  return (
    <Card className="space-y-5 p-5" data-testid="tunables-card">
      <div className="flex flex-wrap items-center gap-2">
        <SectionTitle aside={<PendingBadge title="默认与原来写死的一样，店主 2026-11-10：有争议的规则不要写死" />}>可调的数值</SectionTitle>
        <Button variant="primary" size="sm" className="ml-auto" loading={saving} onClick={() => void save()} data-testid="tunables-save">
          保存
        </Button>
      </div>
      <p className="-mt-3 text-[12.5px] text-ink-3">原来写死在代码里、标「待确认」的数值，默认与原来一样。改了立即生效，已经办完的单据不回头改；付款流的几项在 ERP「付款 → 付款规则」里改。</p>

      {GROUPS.map((g) => (
        <section key={g.title} className="space-y-3 rounded-lg border border-line p-4">
          <p className="text-[13.5px] font-bold">
            {g.title} <span className="font-normal text-ink-3">（{g.code}）</span>
          </p>
          <div className="grid gap-x-5 gap-y-3 sm:grid-cols-2">
            {g.fields.map((f) => (
              <Field key={f.key} label={f.label} htmlFor={`tun-${f.key}`} hint={f.hint}>
                {MONEY_KEYS.includes(f.key) ? (
                  <MoneyInput id={`tun-${f.key}`} value={draft[f.key]} onChange={(e) => set({ [f.key]: e.target.value } as Partial<Draft>)} className="h-10" data-testid={`tun-${f.key}`} />
                ) : (
                  <Input id={`tun-${f.key}`} inputMode="numeric" value={draft[f.key]} onChange={(e) => set({ [f.key]: e.target.value } as Partial<Draft>)} className="h-10" data-testid={`tun-${f.key}`} />
                )}
              </Field>
            ))}
          </div>
        </section>
      ))}

      <section className="space-y-3 rounded-lg border border-line p-4">
        <p className="text-[13.5px] font-bold">
          打印 <span className="font-normal text-ink-3">（店主 2026-11-10：设置打印功能，连接打印机由各自的电脑负责；N7）</span>
        </p>
        <Segmented
          ariaLabel="打印方式"
          value={draft.printMode}
          onChange={(v) => set({ printMode: v as PrintMode })}
          options={PRINT_MODES.map((m) => ({ value: m, label: PRINT_MODE_LABELS[m] }))}
        />
        <p className="text-[12.5px] text-ink-3">
          {draft.printMode === 'local'
            ? '各台电脑用浏览器打印到自己连的打印机（装好打印机驱动、设成默认打印机）；服务器不连门店的小票机，页面上不显示「打到小票机」。正式服在云上时用这个。'
            : '服务器直接把单据发到「设备」里登记的网口小票机；服务器和打印机要在同一个局域网里。'}
        </p>
        {draft.printMode === 'network' && (
          <Field label="小票机断网时最多等几分钟" htmlFor="tun-printWaitMinutes" hint="等恢复后自动补打，过了不再打（N7）" className="max-w-xs">
            <Input id="tun-printWaitMinutes" inputMode="numeric" value={draft.printWaitMinutes} onChange={(e) => set({ printWaitMinutes: e.target.value })} className="h-10" data-testid="tun-printWaitMinutes" />
          </Field>
        )}
      </section>

      <section className="space-y-3 rounded-lg border border-line p-4">
        <p className="text-[13.5px] font-bold">
          次卡与营销成本 <span className="font-normal text-ink-3">（HY05、HY14）</span>
        </p>
        {toggle('次卡照常售卖（关着时停售：价目与套餐不显示次卡，已售的照常用、退、打印）', draft.countCardSales, (v) => set({ countCardSales: v }), 'tun-countCardSales')}
        {toggle('有财务职责（对账付款、成本核算）的账号看不到营销成本测算（关掉以后按岗位权限给）', draft.financeHidesMarketingCost, (v) => set({ financeHidesMarketingCost: v }), 'tun-financeHidesMarketingCost')}
      </section>

      {error && <Notice tone="error" title={error} />}
    </Card>
  );
}
