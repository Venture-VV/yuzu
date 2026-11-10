// 后台「经营规则」里的「可调的数值」（8.0.7 A1，店主 2026-11-10：有争议的规则不要写死）：原来写死在代码里、标「待确认」的数值，
// 按模块分组，一次保存（只提交这些项，别的规则不动）。范围与服务端同一份（@shared/tunables）；改了立即生效、记修改记录，
// 已经办完的单据不回头改。各页面上的提示文字随会话刷新。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { centsToInput, parseYuan } from '@shared/money';
import { BOOL_TUNABLES, PRINT_MODE_LABELS, PRINT_MODES, TUNABLE_LIMITS, type BoolTunable, type IntTunable, type PrintMode, type Tunables } from '@shared/tunables';
import type { WecomStatus, WecomTestResult } from '@shared/wecom';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/utils';
import { qk, useSettings } from '../../lib/queries';
import { useToast } from '../../components/Toast';
import { Button, Card, Field, Input, MoneyInput, Notice, PendingBadge, SectionTitle, Segmented, Skeleton, Textarea } from '../../components/ui';

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
    title: '供应链与应收（8.0.7）',
    code: 'V3、V5、V7、V10、V14、V18',
    fields: [
      { key: 'licenseRemindDays', label: '供应商证照到期前几天提醒', hint: '进 ERP 待办（V3）', unit: '天' },
      { key: 'supplierWatchScore', label: '季度评分低于几分进观察名单', hint: '权重准时 40、合格 40、价格 20（V5）', unit: '分' },
      { key: 'slowMovingDays', label: '有结存、多少天没出库算呆滞', hint: '只提醒，处理照旧用退货、报损（V7）', unit: '天' },
      { key: 'reconLinkDays', label: '对账确认链接有效几天', hint: '供应商只能回一次（V10）', unit: '天' },
      { key: 'arOverdueDays', label: '应收超过几天没回进待办', hint: '协议单位挂账、平台回款（V14）', unit: '天' },
      { key: 'expiryRemindDays', label: '批次到期前几天提醒', hint: '管效期的物料（V18）', unit: '天' },
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

type Draft = Record<IntTunable, string> &
  Record<BoolTunable, boolean> & { printMode: PrintMode; printWaitMinutes: string; countCardSales: boolean; consumptionPurposes: string };

const toDraft = (s: Tunables & { countCardSales: boolean }): Draft => {
  const out = {} as Record<IntTunable, string>;
  for (const key of Object.keys(TUNABLE_LIMITS) as IntTunable[]) out[key] = MONEY_KEYS.includes(key) ? centsToInput(s[key] as number) : String(s[key]);
  const bools = Object.fromEntries(BOOL_TUNABLES.map((k) => [k, s[k]])) as Record<BoolTunable, boolean>;
  return { ...out, ...bools, printMode: s.printMode, printWaitMinutes: String(s.printWaitMinutes), countCardSales: s.countCardSales, consumptionPurposes: s.consumptionPurposes.join('\n') };
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
  const purposes = d.consumptionPurposes
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);
  if (purposes.length === 0) return '部门耗用的用途至少要有一个';
  if (purposes.some((x) => x.length > 12)) return '每个耗用用途最多 12 个字';
  if (new Set(purposes).size !== purposes.length) return '部门耗用的用途重复了';
  const bools = Object.fromEntries(BOOL_TUNABLES.map((k) => [k, d[k]]));
  return { ...body, ...bools, printMode: d.printMode, countCardSales: d.countCardSales, consumptionPurposes: purposes };
}

/** 当前设置按提交的样子摆出来（与 fromDraft 的结果比，找出改过的项） */
function bodyOf(s: Tunables & { countCardSales: boolean }): Record<string, unknown> {
  const body = fromDraft(toDraft(s));
  return typeof body === 'string' ? {} : body;
}

export function TunablesCard() {
  const settings = useSettings();
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  // 打开时（或上次保存后）的值：保存时只交改过的项，两个页面同时开着时不会把别人刚改的改回去
  const [base, setBase] = useState<Record<string, unknown> | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (settings.data && draft === null) {
    setDraft(toDraft(settings.data));
    setBase(bodyOf(settings.data));
  }
  if (!draft || !base) return <Skeleton className="h-60" />;
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });

  const save = async () => {
    const body = fromDraft(draft);
    if (typeof body === 'string') return setError(body);
    const changed = Object.fromEntries(Object.entries(body).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(base[k])));
    if (Object.keys(changed).length === 0) {
      setError(null);
      toast({ tone: 'info', title: '没有改动' });
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const next = await api.put<Tunables & { countCardSales: boolean }>('/api/settings', changed);
      setDraft(toDraft(next));
      setBase(bodyOf(next));
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

      <section className="space-y-3 rounded-lg border border-line p-4">
        <p className="text-[13.5px] font-bold">
          供应链与付款的开关 <span className="font-normal text-ink-3">（8.0.7：V2、V6、V9、V20）</span>
        </p>
        {toggle('采购单只能给已准入的供应商（关着时待准入、暂停的只提醒，不拦）', draft.supplierApprovedOnly, (v) => set({ supplierApprovedOnly: v }), 'tun-supplierApprovedOnly')}
        {toggle('合同最近一次验收不合格时挂起付款（新的付款申请、按申请登记付款、合同付款都拒绝，重新验收合格解除）', draft.acceptanceHoldsPayment, (v) => set({ acceptanceHoldsPayment: v }), 'tun-acceptanceHoldsPayment')}
        {toggle('每周一 9:00 把本周应付、待审批、快到期的、逾期应收推到企业微信群（机器人地址在服务器 .env 的 ERP_WECOM_WEBHOOK）', draft.wecomWeeklyPush, (v) => set({ wecomWeeklyPush: v }), 'tun-wecomWeeklyPush')}
        <WecomRow />
        <Field label="部门耗用的用途（每行一个，最多 12 个字）" htmlFor="tun-consumptionPurposes" hint="部门小仓登记耗用时从这里选（V6）" className="max-w-md">
          <Textarea id="tun-consumptionPurposes" rows={6} value={draft.consumptionPurposes} onChange={(e) => set({ consumptionPurposes: e.target.value })} data-testid="tun-consumptionPurposes" />
        </Field>
      </section>

      {error && <Notice tone="error" title={error} />}
    </Card>
  );
}

/** 企业微信推送（V19、V20）：机器人地址配没配、最近几次推送的结果、「发一条试试」 */
function WecomRow() {
  const qc = useQueryClient();
  const toast = useToast();
  const [sending, setSending] = useState(false);
  const status = useQuery({ queryKey: ['settings', 'wecom'], queryFn: () => api.get<WecomStatus>('/api/settings/wecom') });
  const s = status.data;
  if (!s) return null;
  const last = s.recent[0];
  const test = async () => {
    setSending(true);
    try {
      const r = await api.post<WecomTestResult>('/api/settings/wecom/test', {});
      if (r.ok) toast({ tone: 'success', title: '已推送一条试发消息', body: '到企业微信群里看看收到没有' });
      else toast({ tone: 'error', title: '没发出去', body: r.error ?? '' });
    } catch (e) {
      toast({ tone: 'error', title: '没发出去', body: errorMessage(e) });
    } finally {
      setSending(false);
      await qc.invalidateQueries({ queryKey: ['settings', 'wecom'] });
    }
  };
  return (
    <div className="ml-6 space-y-1.5 text-[12.5px] text-ink-3" data-testid="wecom-row">
      <p>
        机器人地址：
        {s.configured ? (
          <span className="font-semibold text-ink-2">已配置</span>
        ) : s.invalid ? (
          <span className="font-semibold text-clay">格式不对（要企业微信群机器人的 https 地址），改好 .env 以后重启应用</span>
        ) : (
          <span className="font-semibold text-ink-2">没配置（服务器 .env 的 ERP_WECOM_WEBHOOK，配好以后重启应用；地址相当于密码，不发到群里、不进 Git）</span>
        )}
        {s.configured && !s.enabled && '；开关关着，每周一不推'}
      </p>
      {last && (
        <p data-testid="wecom-last">
          最近一次：{last.kind === 'test' ? `试发（${last.createdByName ?? ''}）` : `每周一推（${last.periodKey}）`} · {formatDateTime(last.finishedAt ?? last.createdAt)} ·{' '}
          {last.status === 'sent' ? '已发出' : last.status === 'sending' ? '正在发' : `没发出去${last.error ? `：${last.error}` : ''}`}
        </p>
      )}
      <Button size="sm" variant="secondary" disabled={!s.configured} loading={sending} onClick={() => void test()} data-testid="wecom-test">
        发一条试试
      </Button>
    </div>
  );
}
