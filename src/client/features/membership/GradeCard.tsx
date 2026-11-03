// 会员详情的等级卡（会员体系 v2，v0.7.23；docs/MEMBERSHIP.md 第 4 节）：
//   · 19 个状态的阶梯和当前位置；
//   · 两条进度：周期储值消费到享阶、尊阶（也是保级）还差多少；滚动 365 天累计充值到下一档还差多少、这笔按几成赠送；
//   · 状态变化记录（谁、什么时候、为什么）；
//   · 店主手动调整（写原因，留记录）。

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Award, History, Info, PencilLine, ShieldCheck, TrendingUp } from 'lucide-react';
import { formatYuan } from '@shared/money';
import { shiftDate } from '@shared/labels';
import {
  GRADE_EVENT_LABELS,
  gradeLabel,
  MAX_GRADE,
  TIER_LABELS,
  type GradeEventRow,
  type MemberGradeInfo,
  type MembershipRules,
} from '@shared/membership';
import type { MemberDetail } from '@shared/types';
import { api, errorMessage } from '../../lib/api';
import { qk } from '../../lib/queries';
import { useCan } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { cn, uuid } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Notice, PendingBadge, SectionTitle, Segmented, Select, Skeleton, Textarea } from '../../components/ui';
import { membershipKeys, useMembershipRules } from './queries';

const pctOf = (bp: number) => `${bp % 100 === 0 ? bp / 100 : (bp / 100).toFixed(2).replace(/0$/, '')}%`;

export function GradeCard({ member }: { member: MemberDetail }) {
  const info = member.gradeInfo;
  const rules = useMembershipRules().data;
  const can = useCan();
  const [all, setAll] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  if (!info) return null;
  if (!rules) return <Skeleton className="h-56" />;
  const s = info.state;
  const events = all ? info.events : info.events.slice(0, 3);
  return (
    <Card className="p-5" data-testid="member-grade">
      <SectionTitle
        aside={
          <span className="flex items-center gap-2">
            <PendingBadge title="会员体系 v2 的门槛、比例、周期与补充期按会员文档与默认做法，待店主确认（后台「会员规则」可改）" />
            {can('member.adjust') && (
              <Button size="sm" variant="ghost" icon={<PencilLine className="size-3.5" />} onClick={() => setAdjusting(true)} data-testid="grade-adjust-open">
                手动调整
              </Button>
            )}
          </span>
        }
      >
        <span className="flex items-center gap-2">
          <Award className="size-4 text-yuzu-deep" /> 会员档阶
        </span>
      </SectionTitle>

      <div className="mt-3 flex flex-wrap items-end gap-x-4 gap-y-1">
        <p className="text-[22px] leading-none font-bold text-ink" data-testid="member-grade-label">
          {info.label}
        </p>
        <p className="text-[13px] text-ink-3">
          {s.grade === 0 ? (
            '免费注册，不分阶、没有会籍周期'
          ) : (
            <>
              会籍 {s.cycleStart} 至 {s.cycleEnd}
              {!info.inGrace && info.daysLeft !== null && <>（还有 {info.daysLeft} 天）</>} · 能用 {info.lockerLevel} 级及以下的 VIP 柜
            </>
          )}
        </p>
        {info.reminder !== null && <Badge tone="ember">到期提醒 · {info.reminder} 天内</Badge>}
      </div>
      {info.inGrace && s.cycleEnd && (
        <Notice tone="warning" className="mt-3" title={`补充期至 ${s.graceUntil}（还有 ${info.daysLeft} 天）`} data-testid="member-grade-grace">
          周期消费已过享阶、没到保级：补充期内（从周期第一天累计）储值消费到 <Money cents={info.targets?.honor ?? 0} /> 当场保级，新周期从{' '}
          {shiftDate(s.cycleEnd, 1)} 起算；补充期满还不够降到 L{s.grade - 1}。
        </Notice>
      )}

      <Ladder rules={rules} info={info} />

      {s.grade > 0 && info.targets && <SpendProgress info={info} />}
      <RechargeProgress rules={rules} info={info} />

      {info.events.length > 0 && (
        <div className="mt-4 border-t border-line pt-3">
          <p className="flex items-center gap-1.5 text-[12.5px] font-bold text-ink-2">
            <History className="size-3.5" /> 状态变化
          </p>
          <ul className="mt-1.5 space-y-1.5 text-[12.5px]" data-testid="member-grade-events">
            {events.map((e) => (
              <EventLine key={e.id} rules={rules} e={e} />
            ))}
            {info.events.length > 3 && (
              <li>
                <button type="button" className="font-semibold text-pine hover:underline" onClick={() => setAll(!all)}>
                  {all ? '收起' : `全部 ${info.events.length} 条`}
                </button>
              </li>
            )}
          </ul>
        </div>
      )}
      <AdjustDialog open={adjusting} onClose={() => setAdjusting(false)} member={member} rules={rules} />
    </Card>
  );
}

/** 19 个状态的阶梯：L0 一格，L1–L6 各分初、享、尊；当前位置高亮 */
function Ladder({ rules, info }: { rules: MembershipRules; info: MemberGradeInfo }) {
  const s = info.state;
  return (
    <div className="mt-4 overflow-x-auto pb-1" data-testid="member-grade-ladder">
      <div className="grid min-w-[560px] grid-cols-7 gap-1.5">
        {rules.grades.map((g, i) => {
          const current = s.grade === i;
          return (
            <div key={i} className={cn('rounded-md border px-1.5 py-1.5 text-center', current ? 'border-pine bg-pine-tint' : 'border-line bg-card')}>
              <p className={cn('text-[12px] font-bold', current ? 'text-pine' : 'text-ink-2')}>
                L{i} {g.name}
              </p>
              <p className="num text-[11px] text-ink-3">{i === 0 ? '免费注册' : `${formatYuan(g.thresholdCents).replace('.00', '')}`}</p>
              <p className="text-[11px] text-ink-3">{g.bonusBp ? `赠 ${pctOf(g.bonusBp)}` : '不赠'}</p>
              <div className="mt-1 flex justify-center gap-0.5">
                {i === 0 ? (
                  <span className={cn('rounded px-1.5 text-[11px] font-semibold', current ? 'bg-pine text-paper' : 'bg-paper-2 text-ink-3')}>注册</span>
                ) : (
                  TIER_LABELS.map((t, k) => (
                    <span
                      key={t}
                      className={cn('rounded px-1 text-[11px] font-semibold', current && s.tier === k ? 'bg-pine text-paper' : 'bg-paper-2 text-ink-3')}
                      data-current={current && s.tier === k ? 'true' : undefined}
                    >
                      {t}
                    </span>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 周期储值消费：享阶在本档门槛的 30%、尊阶（保级）60%；条里享阶在一半处 */
function SpendProgress({ info }: { info: MemberGradeInfo }) {
  const t = info.targets!;
  const spend = info.cycleSpendCents;
  const pct = Math.min(100, Math.round((spend / Math.max(1, t.honor)) * 100));
  const enjoyAt = Math.round((t.enjoy / Math.max(1, t.honor)) * 100);
  const tier = info.state.tier ?? 0;
  const lines: React.ReactNode[] = [];
  if (tier < 1 && spend < t.enjoy) lines.push(<>再消费 <Money cents={t.enjoy - spend} className="font-bold text-ink" /> 升享阶</>);
  if (spend < t.honor) {
    lines.push(
      <>
        再消费 <Money cents={t.honor - spend} className="font-bold text-ink" /> {tier < 2 ? '升尊阶并' : ''}保级
        {!info.inGrace && info.state.cycleEnd ? `（到期日 ${info.state.cycleEnd}）` : ''}
      </>,
    );
  } else {
    lines.push(<>本周期已到保级线，到期日自动续一个周期、保持尊阶</>);
  }
  return (
    <div className="mt-4" data-testid="member-grade-spend">
      <div className="flex items-baseline justify-between text-[12.5px]">
        <span className="font-semibold text-ink-2">周期储值消费</span>
        <span className="text-ink-3">
          <Money cents={spend} className="font-bold text-ink" /> / 保级 <Money cents={t.honor} />
        </span>
      </div>
      <div className="relative mt-1.5 h-2.5 overflow-hidden rounded-full bg-paper-2" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="周期消费到保级的进度">
        <div className={cn('h-full rounded-full', pct >= 100 ? 'bg-pine' : 'bg-yuzu')} style={{ width: `${pct}%` }} />
        <span className="absolute inset-y-0 w-0.5 bg-ink-4/60" style={{ left: `${enjoyAt}%` }} aria-hidden />
      </div>
      <div className="mt-0.5 flex justify-between text-[11px] text-ink-3">
        <span>初</span>
        <span style={{ marginLeft: `${enjoyAt - 10}%` }}>享 <Money cents={t.enjoy} /></span>
        <span>尊 · 保级</span>
      </div>
      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px] text-ink-2" data-testid="member-grade-spend-next">
        <ShieldCheck className="size-4 text-pine" />
        {lines.map((l, i) => (
          <span key={i}>{l}</span>
        ))}
      </p>
      <p className="mt-0.5 flex items-center gap-1 text-[12px] text-ink-3">
        <Info className="size-3.5" /> 只算储值（本金 + 赠金）消费，撤销、反结账的不算；现金、微信等付款不计入
      </p>
    </div>
  );
}

/** 滚动 365 天累计充值到下一档 */
function RechargeProgress({ rules, info }: { rules: MembershipRules; info: MemberGradeInfo }) {
  const next = info.next;
  const pct = next ? Math.min(100, Math.round((info.rollingRechargeCents / Math.max(1, next.thresholdCents)) * 100)) : 100;
  return (
    <div className="mt-4" data-testid="member-grade-recharge">
      <div className="flex items-baseline justify-between text-[12.5px]">
        <span className="font-semibold text-ink-2">近 {rules.cycleDays} 天累计充值</span>
        <span className="text-ink-3">
          <Money cents={info.rollingRechargeCents} className="font-bold text-ink" />
          {next && (
            <>
              {' '}
              / L{next.grade} <Money cents={next.thresholdCents} />
            </>
          )}
        </span>
      </div>
      <div className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-paper-2" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="累计充值到下一档的进度">
        <div className={cn('h-full rounded-full', next ? 'bg-lake' : 'bg-pine')} style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 flex items-center gap-1.5 text-[13px] text-ink-2" data-testid="member-grade-next">
        <TrendingUp className="size-4 text-lake" />
        {next ? (
          next.needCents > 0 ? (
            <span>
              再充 <Money cents={next.needCents} className="font-bold text-ink" /> 升到「L{next.grade} {next.name}」，这笔按 {pctOf(next.bonusBp)} 赠送
            </span>
          ) : (
            <span>累计已够「L{next.grade} {next.name}」，下一笔充值即升档</span>
          )
        ) : (
          <span>已是最高档</span>
        )}
      </p>
    </div>
  );
}

function EventLine({ rules, e }: { rules: MembershipRules; e: GradeEventRow }) {
  const detail = [
    e.rechargeDocNo && `充值 ${e.rechargeDocNo}`,
    e.consumptionDocNo && `消费 ${e.consumptionDocNo}`,
    e.kind === 'go_live' || e.kind === 'import' ? e.rollingRecharge !== null && `累计充值 ${formatYuan(e.rollingRecharge)}` : null,
    ['retain', 'grace_start', 'grace_retain', 'downgrade', 'spend_up'].includes(e.kind) && `周期消费 ${formatYuan(e.cycleSpend)}`,
    e.reason,
    e.staffName ? `经办 ${e.staffName}` : e.kind === 'manual' ? null : '系统自动',
  ].filter(Boolean);
  const up = e.toGrade > e.fromGrade || (e.toGrade === e.fromGrade && (e.toTier ?? 0) > (e.fromTier ?? 0));
  const down = e.toGrade < e.fromGrade;
  return (
    <li className="flex flex-wrap gap-x-2" data-testid="member-grade-event">
      <span className="num text-ink-3">{e.businessDate}</span>
      <span className={cn('font-semibold', up ? 'text-pine' : down ? 'text-clay' : 'text-ink-2')}>
        {GRADE_EVENT_LABELS[e.kind]}：{gradeLabel(rules, e.fromGrade, e.fromTier)} → {gradeLabel(rules, e.toGrade, e.toTier)}
      </span>
      {detail.length > 0 && <span className="text-ink-3">{detail.join(' · ')}</span>}
    </li>
  );
}

/** 店主手动调整：新状态的会籍周期从今天起算；写原因、留记录 */
function AdjustDialog({ open, onClose, member, rules }: { open: boolean; onClose: () => void; member: MemberDetail; rules: MembershipRules }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [grade, setGrade] = useState(member.grade);
  const [tier, setTier] = useState<'0' | '1' | '2'>('0');
  const [reason, setReason] = useState('');
  const [key, setKey] = useState(uuid);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(open, () => {
    setGrade(member.grade);
    setTier(String(member.tier ?? 0) as '0' | '1' | '2');
    setReason('');
    setKey(uuid());
    setError(null);
  });
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/members/${member.id}/grade`, {
        clientKey: key,
        grade,
        tier: grade === 0 ? null : Number(tier),
        reason: reason.trim(),
        expectedVersion: member.gradeInfo.version,
      });
      await Promise.all([qc.invalidateQueries({ queryKey: qk.member(member.id) }), qc.invalidateQueries({ queryKey: membershipKeys.grade(member.id) })]);
      toast({ tone: 'success', title: '档阶已调整', body: `${member.name}：${gradeLabel(rules, grade, grade === 0 ? null : Number(tier))}` });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      // 档阶刚有变化：刷新会员，按最新的再调
      void qc.invalidateQueries({ queryKey: qk.member(member.id) });
    } finally {
      setBusy(false);
    }
  };
  const ok = reason.trim().length >= 2;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="手动调整会员档阶"
      description={`${member.name} 现在是「${member.gradeInfo.label}」。调整后会籍周期从今天起算 ${rules.cycleDays} 天（L0 没有周期），记一条「手动调整」。`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={!ok} data-testid="grade-adjust-submit">
            确认调整
          </Button>
        </div>
      }
    >
      <div className="grid gap-4">
        <Field label="档级" htmlFor="adjust-grade">
          <Select id="adjust-grade" value={grade} onChange={(e) => setGrade(Number(e.target.value) as typeof grade)} data-testid="grade-adjust-grade">
            {Array.from({ length: MAX_GRADE + 1 }, (_, i) => (
              <option key={i} value={i}>
                L{i} {rules.grades[i]?.name}
              </option>
            ))}
          </Select>
        </Field>
        {grade > 0 && (
          <Field label="阶位">
            <Segmented ariaLabel="阶位" value={tier} onChange={setTier} options={TIER_LABELS.map((t, i) => ({ value: String(i) as '0' | '1' | '2', label: t }))} />
          </Field>
        )}
        <Field label="调整原因" htmlFor="adjust-reason" hint="至少 2 个字，例如「老卡核对后补定档」">
          <Textarea id="adjust-reason" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} data-testid="grade-adjust-reason" />
        </Field>
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}
