// 后台「会员规则」（会员体系 v2，v0.7.23；docs/MEMBERSHIP.md 第 2、4 节）：一页改完档级门槛与赠送比例、享阶 / 尊阶比例、
// 会籍周期与补充期、首充 / 续充最低、到期提醒、上线定档最高档；v0.7.25 起还有低一档邀请体验的天数、次数与受邀间隔；
// 8.0.4 起有生日礼提前几天到账，VIP 柜对应移到「会员权益 → VIP 柜」（这里留一条跳转）。保存前列出「会影响哪些以后的判断」。

import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { DEFAULT_MEMBERSHIP_RULES, MAX_GRADE, type MembershipRules } from '@shared/membership';
import { formatYuan, parseYuan } from '@shared/money';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useCan } from '../../lib/session';
import { useToast } from '../../components/Toast';
import { Button, Card, Field, Input, Notice, PendingBadge, SectionTitle, Select, Skeleton } from '../../components/ui';
import { AdminPage } from '../admin/AdminShell';
import { membershipKeys, useMembershipRules } from './queries';

export function MembershipRulesSection() {
  return (
    <AdminPage
      section="membership"
      description="档级门槛与赠送比例、享阶 / 尊阶、会籍周期与补充期、最低充值、到期提醒、生日礼到账、邀请体验。改了只影响以后的充值、消费与到期判断，已经记下的档阶不重算。"
    >
      <RulesEditor />
    </AdminPage>
  );
}

interface Draft {
  grades: { name: string; threshold: string; bonus: string }[];
  enjoyPct: string;
  honorPct: string;
  cycleDays: string;
  graceDays: string;
  firstMin: string;
  topUpMin: string;
  reminderDays: string;
  onboardMaxGrade: number;
  birthdayLead: string;
  inviteDays: string;
  invitesPerMonth: string;
  inviteeMonths: string;
}

const yuanText = (cents: number) => (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2));
const pctText = (bp: number) => String(bp / 100);

function toDraft(r: MembershipRules): Draft {
  return {
    grades: r.grades.map((g) => ({ name: g.name, threshold: yuanText(g.thresholdCents), bonus: pctText(g.bonusBp) })),
    enjoyPct: String(r.enjoyPct),
    honorPct: String(r.honorPct),
    cycleDays: String(r.cycleDays),
    graceDays: String(r.graceDays),
    firstMin: r.firstRechargeMinCents ? yuanText(r.firstRechargeMinCents) : '',
    topUpMin: r.topUpMinCents ? yuanText(r.topUpMinCents) : '',
    reminderDays: r.reminderDays.join('、'),
    onboardMaxGrade: r.onboardMaxGrade,
    birthdayLead: String(r.birthdayLeadDays),
    inviteDays: String(r.trialInviteDays),
    invitesPerMonth: String(r.trialInvitesPerMonth),
    inviteeMonths: String(r.trialInviteeMonths),
  };
}

const int = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : NaN);
/** 「8」「8.5」「12.25」→ 万分比 */
const bpOf = (s: string) => (/^\d+(\.\d{1,2})?$/.test(s.trim()) ? Math.round(Number(s.trim()) * 100) : NaN);

/** 草稿换成规则；填得不对返回说明 */
function fromDraft(d: Draft): MembershipRules | string {
  const grades = [];
  for (const [i, g] of d.grades.entries()) {
    const threshold = i === 0 ? 0 : parseYuan(g.threshold);
    if (threshold === null) return `L${i} 的门槛请填金额（元）`;
    const bp = bpOf(g.bonus);
    if (Number.isNaN(bp)) return `L${i} 的赠送比例请填百分数（最多两位小数）`;
    if (!g.name.trim()) return `请填写 L${i} 的档名`;
    grades.push({ name: g.name.trim(), thresholdCents: threshold, bonusBp: bp });
  }
  const nums = { enjoyPct: int(d.enjoyPct), honorPct: int(d.honorPct), cycleDays: int(d.cycleDays), graceDays: int(d.graceDays) };
  if (Object.values(nums).some(Number.isNaN)) return '比例与天数请填整数';
  const firstMin = d.firstMin.trim() ? parseYuan(d.firstMin) : 0;
  const topUpMin = d.topUpMin.trim() ? parseYuan(d.topUpMin) : 0;
  if (firstMin === null || topUpMin === null) return '最低充值请填金额（元），不限留空';
  const reminderDays = d.reminderDays
    .split(/[、,，\s]+/)
    .filter(Boolean)
    .map(int);
  if (reminderDays.some(Number.isNaN)) return '提醒天数请填整数，用顿号分开，例如 90、60、30、7';
  const birthdayLeadDays = int(d.birthdayLead);
  if (Number.isNaN(birthdayLeadDays)) return '生日礼提前几天请填整数（0 = 生日当天）';
  const trial = { trialInviteDays: int(d.inviteDays), trialInvitesPerMonth: int(d.invitesPerMonth), trialInviteeMonths: int(d.inviteeMonths) };
  if (Object.values(trial).some(Number.isNaN)) return '邀请体验的天数、次数与受邀间隔请填整数';
  return {
    grades,
    ...nums,
    firstRechargeMinCents: firstMin,
    topUpMinCents: topUpMin,
    reminderDays,
    onboardMaxGrade: d.onboardMaxGrade,
    birthdayLeadDays,
    ...trial,
  };
}

/** 改了哪些、会影响哪些以后的判断 */
function effects(before: MembershipRules, after: MembershipRules): string[] {
  const out: string[] = [];
  after.grades.forEach((g, i) => {
    const b = before.grades[i]!;
    if (g.name !== b.name) out.push(`L${i} 改名「${b.name}」→「${g.name}」：各处的显示马上换成新名字`);
    if (g.thresholdCents !== b.thresholdCents)
      out.push(`L${i} 门槛 ${formatYuan(b.thresholdCents)} → ${formatYuan(g.thresholdCents)}：以后的充值按新门槛升档，享阶、尊阶（保级）线随之变；已经在档的会员不降`);
    if (g.bonusBp !== b.bonusBp) out.push(`L${i} 赠送比例 ${b.bonusBp / 100}% → ${g.bonusBp / 100}%：以后充完在这一档的充值按新比例赠送`);
  });
  if (after.enjoyPct !== before.enjoyPct || after.honorPct !== before.honorPct)
    out.push(`享阶 / 尊阶 ${before.enjoyPct}% / ${before.honorPct}% → ${after.enjoyPct}% / ${after.honorPct}%：以后的储值消费按新比例升阶，到期判断按新比例`);
  if (after.cycleDays !== before.cycleDays) out.push(`会籍周期 ${before.cycleDays} → ${after.cycleDays} 天：以后新开始的周期按新天数，累计充值按新天数滚动；已经在走的周期到期日不变`);
  if (after.graceDays !== before.graceDays) out.push(`补充期 ${before.graceDays} → ${after.graceDays} 天：以后进补充期的会员按新天数；已经在补充期的不变`);
  if (after.firstRechargeMinCents !== before.firstRechargeMinCents || after.topUpMinCents !== before.topUpMinCents)
    out.push(`最低充值改为首充 ${after.firstRechargeMinCents ? formatYuan(after.firstRechargeMinCents) : '不限'}、续充 ${after.topUpMinCents ? formatYuan(after.topUpMinCents) : '不限'}：下一笔充值起生效`);
  if (after.reminderDays.join() !== before.reminderDays.join()) out.push(`到期提醒改为前 ${after.reminderDays.join('、')} 天：提醒名单马上按新天数`);
  if (after.onboardMaxGrade !== before.onboardMaxGrade) out.push(`期初导入定档最高 L${before.onboardMaxGrade} → L${after.onboardMaxGrade}：以后的期初导入按新上限`);
  if (after.birthdayLeadDays !== before.birthdayLeadDays)
    out.push(`生日礼 ${before.birthdayLeadDays ? `生日前 ${before.birthdayLeadDays} 天` : '生日当天'} → ${after.birthdayLeadDays ? `生日前 ${after.birthdayLeadDays} 天` : '生日当天'}到账：今年还没发的按新天数`);
  if (after.trialInviteDays !== before.trialInviteDays) out.push(`邀请体验 ${before.trialInviteDays} → ${after.trialInviteDays} 天：以后发起的按新天数，已经在体验中的到期日不变`);
  if (after.trialInvitesPerMonth !== before.trialInvitesPerMonth)
    out.push(`每位会员每月能邀请 ${before.trialInvitesPerMonth} → ${after.trialInvitesPerMonth} 次${after.trialInvitesPerMonth === 0 ? '（0 = 不开放邀请体验）' : ''}：马上生效`);
  if (after.trialInviteeMonths !== before.trialInviteeMonths) out.push(`受邀间隔 ${before.trialInviteeMonths} → ${after.trialInviteeMonths} 个月：以后发起时按新间隔核对`);
  return out;
}

function RulesEditor() {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const rules = useMembershipRules();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (rules.data) setDraft(toDraft(rules.data));
  }, [rules.data]);
  if (!rules.data || !draft) return <Skeleton className="h-96" />;
  const parsed = fromDraft(draft);
  const problem = typeof parsed === 'string' ? parsed : null;
  const changes = typeof parsed === 'string' ? [] : effects(rules.data, parsed);
  const editable = can('member.rules');
  const setGrade = (i: number, patch: Partial<Draft['grades'][number]>) => setDraft({ ...draft, grades: draft.grades.map((g, j) => (j === i ? { ...g, ...patch } : g)) });

  const save = async () => {
    if (typeof parsed === 'string') return;
    setBusy(true);
    setError(null);
    try {
      // 带上打开时读到的规则：这期间别人保存过，服务端整页拒绝（RULES_CHANGED），页面换成最新的规则
      await api.put<MembershipRules>('/api/membership/rules', { ...parsed, based: rules.data });
      await qc.invalidateQueries({ queryKey: membershipKeys.rules });
      await qc.invalidateQueries({ queryKey: ['membership'] });
      toast({ tone: 'success', title: '会员规则已保存', body: '以后的充值、消费与到期判断按新规则；已经记下的档阶不重算。' });
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiError && e.code === 'RULES_CHANGED') await qc.invalidateQueries({ queryKey: membershipKeys.rules });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5" data-testid="membership-rules">
      <Card className="p-5">
        <SectionTitle aside={<PendingBadge title="按会员文档（2026-11-02）与 PENDING_DECISIONS「会员体系 v2」的默认做法，待店主确认" />}>档级、门槛与赠送比例</SectionTitle>
        <p className="mt-1 text-[12.5px] text-ink-3">
          滚动 {draft.cycleDays || rules.data.cycleDays} 天内的累计充值（含本笔）达到门槛就升入那一档的初阶，可以连跳几档；赠金 = 本笔实收 × 充值后所在档的比例。
        </p>
        <div className="mt-3 overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[620px] text-[13px]">
            <thead className="bg-paper-2/70 text-[12px] font-bold text-ink-3">
              <tr>
                <th className="w-14 px-3 py-2 text-left">档级</th>
                <th className="px-3 py-2 text-left">名称</th>
                <th className="px-3 py-2 text-left">充值门槛（元）</th>
                <th className="px-3 py-2 text-left">赠送比例（%）</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/70">
              {draft.grades.map((g, i) => (
                <tr key={i}>
                  <td className="px-3 py-2 font-semibold">L{i}</td>
                  <td className="px-3 py-1.5">
                    <Input value={g.name} maxLength={8} className="h-9" disabled={!editable} aria-label={`L${i} 名称`} data-testid={`rule-grade-name-${i}`} onChange={(e) => setGrade(i, { name: e.target.value })} />
                  </td>
                  <td className="px-3 py-1.5">
                    {i === 0 ? (
                      <span className="text-ink-3">免费注册</span>
                    ) : (
                      <Input value={g.threshold} inputMode="decimal" className="num h-9" disabled={!editable} aria-label={`L${i} 门槛`} data-testid={`rule-grade-threshold-${i}`} onChange={(e) => setGrade(i, { threshold: e.target.value })} />
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    <Input value={g.bonus} inputMode="decimal" className="num h-9" disabled={!editable} aria-label={`L${i} 赠送比例`} data-testid={`rule-grade-bonus-${i}`} onChange={(e) => setGrade(i, { bonus: e.target.value })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* VIP 柜（8.0.4 起归「会员权益」，docs/MEMBERSHIP_V804.md 第 2 节）：原来这里的「VIP 柜」一列搬过去了，这里只留跳转 */}
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-paper/60 px-4 py-3" data-testid="vip-moved">
          <ShieldCheck className="size-5 shrink-0 text-pine" />
          <p className="min-w-0 flex-1 text-[12.5px] text-ink-3">
            <b className="text-ink">VIP 柜已移到「会员权益」</b>：各档能用到几级柜、当场授权开关都在「会员权益 → VIP 柜」设置，原来的设置已原样搬过去。
          </p>
          <Link to="/admin/vip-lockers" className="inline-flex h-8 items-center rounded-full bg-pine px-3.5 text-[12.5px] font-semibold text-paper hover:bg-pine/90" data-testid="vip-moved-link">
            去设置
          </Link>
        </div>
      </Card>

      <Card className="p-5">
        <SectionTitle>阶位、会籍与到期</SectionTitle>
        <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="享阶（周期储值消费达门槛的 %）" htmlFor="enjoy-pct">
            <Input id="enjoy-pct" value={draft.enjoyPct} inputMode="numeric" disabled={!editable} onChange={(e) => setDraft({ ...draft, enjoyPct: e.target.value })} />
          </Field>
          <Field label="尊阶 · 保级（%）" htmlFor="honor-pct">
            <Input id="honor-pct" value={draft.honorPct} inputMode="numeric" disabled={!editable} onChange={(e) => setDraft({ ...draft, honorPct: e.target.value })} />
          </Field>
          <Field label="会籍周期（天）" htmlFor="cycle-days" hint="也是累计充值的滚动天数">
            <Input id="cycle-days" value={draft.cycleDays} inputMode="numeric" disabled={!editable} onChange={(e) => setDraft({ ...draft, cycleDays: e.target.value })} />
          </Field>
          <Field label="补充期（天）" htmlFor="grace-days" hint="周期消费过享阶、没到保级时给；0 = 不给">
            <Input id="grace-days" value={draft.graceDays} inputMode="numeric" disabled={!editable} onChange={(e) => setDraft({ ...draft, graceDays: e.target.value })} />
          </Field>
          <Field label="首充最低（元）" htmlFor="first-min" hint="没有充值、没有期初的会员；留空不限">
            <Input id="first-min" value={draft.firstMin} inputMode="decimal" disabled={!editable} data-testid="rule-first-min" onChange={(e) => setDraft({ ...draft, firstMin: e.target.value })} />
          </Field>
          <Field label="续充最低（元）" htmlFor="topup-min" hint="建议 1,000 或不限（M4）">
            <Input id="topup-min" value={draft.topUpMin} inputMode="decimal" disabled={!editable} data-testid="rule-topup-min" onChange={(e) => setDraft({ ...draft, topUpMin: e.target.value })} />
          </Field>
          <Field label="到期提醒（到期前几天）" htmlFor="reminder-days" hint="用顿号分开">
            <Input id="reminder-days" value={draft.reminderDays} disabled={!editable} onChange={(e) => setDraft({ ...draft, reminderDays: e.target.value })} />
          </Field>
          <Field label="生日礼提前几天到账" htmlFor="birthday-lead" hint="发券规则的生日礼、权益的生日礼遇都按它；0 = 生日当天（HY13）">
            <Input id="birthday-lead" value={draft.birthdayLead} inputMode="numeric" disabled={!editable} data-testid="rule-birthday-lead" onChange={(e) => setDraft({ ...draft, birthdayLead: e.target.value })} />
          </Field>
          <Field label="期初导入定档最高" htmlFor="onboard-max" hint="最高档要新充值达到门槛">
            <Select id="onboard-max" value={draft.onboardMaxGrade} disabled={!editable} onChange={(e) => setDraft({ ...draft, onboardMaxGrade: Number(e.target.value) })}>
              {Array.from({ length: MAX_GRADE }, (_, i) => i + 1).map((g) => (
                <option key={g} value={g}>
                  L{g} {draft.grades[g]?.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Card>

      <Card className="p-5">
        <SectionTitle aside={<PendingBadge title="M52：L2 起的会员每月 1 次，给对方低一档的初阶 7 天；受邀人 12 个月内一次（待店主确认）" />}>低一档邀请体验</SectionTitle>
        <p className="mt-1 text-[12.5px] text-ink-3">
          L2 起的会员可以邀请一位朋友体验「自己的档级 − 1」的初阶，只享服务、折扣与 VIP 柜，不发券、不进升档保级；赠送会籍（QY-042）的次数在「会员权益」里按 QY-042 设。
        </p>
        <div className="mt-3 grid gap-4 sm:grid-cols-3">
          <Field label="体验几天" htmlFor="trial-days" hint="从发起当天算起">
            <Input id="trial-days" value={draft.inviteDays} inputMode="numeric" disabled={!editable} data-testid="rule-trial-days" onChange={(e) => setDraft({ ...draft, inviteDays: e.target.value })} />
          </Field>
          <Field label="每位会员每月能邀请几次" htmlFor="trial-per-month" hint="0 = 不开放；撤销的不退">
            <Input id="trial-per-month" value={draft.invitesPerMonth} inputMode="numeric" disabled={!editable} data-testid="rule-trial-per-month" onChange={(e) => setDraft({ ...draft, invitesPerMonth: e.target.value })} />
          </Field>
          <Field label="受邀人几个月内只能一次" htmlFor="trial-interval" hint="邀请体验、赠送会籍合计；撤销的不算">
            <Input id="trial-interval" value={draft.inviteeMonths} inputMode="numeric" disabled={!editable} data-testid="rule-trial-interval" onChange={(e) => setDraft({ ...draft, inviteeMonths: e.target.value })} />
          </Field>
        </div>
      </Card>

      <Card className="p-5">
        <SectionTitle>保存前核对</SectionTitle>
        {problem ? (
          <p className="mt-2 text-[13px] text-clay">{problem}</p>
        ) : changes.length === 0 ? (
          <p className="mt-2 text-[13px] text-ink-3">没有改动。</p>
        ) : (
          <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] text-ink-2" data-testid="membership-rules-effects">
            {changes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[12px] text-ink-3">已经记下的档阶、周期与补充期不重算；周期到期时按当时的规则判断保级。</p>
        {error && <Notice tone="error" title={error} className="mt-3" />}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="ghost" disabled={!editable || busy} onClick={() => setDraft(toDraft(DEFAULT_MEMBERSHIP_RULES))}>
            恢复默认（未保存）
          </Button>
          <Button variant="secondary" disabled={busy || changes.length === 0} onClick={() => setDraft(toDraft(rules.data!))}>
            放弃修改
          </Button>
          <Button variant="primary" loading={busy} disabled={!editable || !!problem || changes.length === 0} onClick={() => void save()} data-testid="membership-rules-save">
            保存会员规则
          </Button>
        </div>
      </Card>
    </div>
  );
}
