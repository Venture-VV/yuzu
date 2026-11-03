// 会员总览（客户经理）：储值余额、新增与渠道、活跃与沉睡、等级分布、余额与充值排行、待回访的沉睡会员、赠金到期。

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Banknote, Hourglass, Moon, UserPlus, UsersRound, Wallet } from 'lucide-react';
import type { MemberBrief, MembersReport } from '@shared/reports';
import { api } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { relativeTime } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Card, Notice, SectionTitle, Skeleton } from '../../components/ui';
import { HBars, Kpi, PeriodPicker, presetRange, type Period } from './charts';

export function MembersTab() {
  const session = useSession();
  const [period, setPeriod] = useState<Period>(() => ({ preset: 'month', ...presetRange('month', session.today) }));
  const q = useQuery({
    queryKey: ['reports', 'members', period.from, period.to],
    queryFn: () => api.get<MembersReport>(`/api/reports/members?from=${period.from}&to=${period.to}`),
    enabled: period.from <= period.to,
  });
  const d = q.data;
  return (
    <div className="space-y-5" data-testid="dashboard-members">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PeriodPicker value={period} onChange={setPeriod} today={session.today} />
        <p className="text-[12.5px] text-ink-3">余额、活跃与等级按此刻；新增、充值与消费按所选时段</p>
      </div>
      {q.isPending ? (
        <Skeleton className="h-72" />
      ) : q.error ? (
        <Notice tone="error" title={q.error.message} />
      ) : (
        d && (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Kpi icon={<UsersRound className="size-4" />} label="会员总数" testId="members-total">
                {d.totals.members} 位
                <span className="block text-[12px] font-semibold text-ink-3">有余额 {d.totals.withBalance} 位</span>
              </Kpi>
              <Kpi icon={<Wallet className="size-4" />} label="储值余额（本金 + 赠金）" tone="pine">
                <Money cents={d.totals.principal + d.totals.bonus} />
                <span className="block text-[12px] font-semibold text-ink-3">
                  本金 <Money cents={d.totals.principal} /> · 赠金 <Money cents={d.totals.bonus} />
                </span>
              </Kpi>
              <Kpi icon={<UserPlus className="size-4" />} label="本期新增会员">
                {d.period.newMembers} 位
              </Kpi>
              <Kpi icon={<Banknote className="size-4" />} label="本期充值实收" tone="lake">
                <Money cents={d.period.rechargePaid} />
                <span className="block text-[12px] font-semibold text-ink-3">
                  {d.period.rechargeCount} 笔 · {d.period.rechargeMembers} 位会员
                </span>
              </Kpi>
              <Kpi icon={<Wallet className="size-4" />} label="本期储值消费">
                <Money cents={d.period.walletConsumed} />
                <span className="block text-[12px] font-semibold text-ink-3">{d.period.consumeMembers} 位会员</span>
              </Kpi>
              <Kpi icon={<Moon className="size-4" />} label="沉睡会员（90 天没来、有余额）">
                {d.activity.dormant} 位
                <span className="block text-[12px] font-semibold text-ink-3">
                  余额 <Money cents={d.activity.dormantBalance} />
                </span>
              </Kpi>
              <Kpi icon={<Hourglass className="size-4" />} label="30 天内到期的赠金">
                <Money cents={d.bonusExpiring.amount} />
                <span className="block text-[12px] font-semibold text-ink-3">{d.bonusExpiring.members} 位会员</span>
              </Kpi>
              <Kpi icon={<UsersRound className="size-4" />} label="有余额会员的活跃度">
                <span className="text-[16px]">
                  30 天内 {d.activity.active30} · 31–90 天 {d.activity.active90}
                </span>
              </Kpi>
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Card className="p-5">
                <SectionTitle aside={<span className="text-[12px] text-ink-3">本期新增 · 括号里是全部会员</span>}>渠道来源</SectionTitle>
                <HBars
                  testId="members-channels"
                  format={(n) => `${n} 位`}
                  empty="本期没有新会员"
                  rows={d.newByChannel.map((c) => ({
                    key: c.channel ?? 'none',
                    label: `${c.label}（共 ${d.allByChannel.find((x) => x.channel === c.channel)?.count ?? c.count} 位）`,
                    value: c.count,
                  }))}
                />
              </Card>
              <Card className="p-5">
                <SectionTitle aside={<span className="text-[12px] text-ink-3">各档阶的人数见「会员体系」</span>}>会员档级</SectionTitle>
                <HBars
                  testId="members-levels"
                  format={(n) => `${n} 位`}
                  empty="还没有会员"
                  rows={d.levels
                    .filter((l) => l.level > 0 || l.count > 0)
                    .map((l) => ({ key: String(l.level), label: l.name, value: l.count, note: <>余额 <Money cents={l.balance} /></> }))}
                />
              </Card>
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <MemberList title="余额最高" rows={d.topBalance} value={(m) => <Money cents={m.balance} className="font-bold" />} />
              <MemberList title="本期充值最多" rows={d.topRecharge} value={(m) => <Money cents={(m as MemberBrief & { paid: number }).paid} className="font-bold" />} />
              <MemberList title="待回访：沉睡会员" hint="90 天没有余额变动、余额最高的 10 位" rows={d.dormantList} value={(m) => <Money cents={m.balance} className="font-bold" />} testId="members-dormant" />
            </div>
          </>
        )
      )}
    </div>
  );
}

function MemberList({ title, hint, rows, value, testId }: { title: string; hint?: string; rows: MemberBrief[]; value: (m: MemberBrief) => React.ReactNode; testId?: string }) {
  const can = useCan();
  return (
    <Card className="p-5" data-testid={testId}>
      <SectionTitle>{title}</SectionTitle>
      {hint && <p className="text-[12px] text-ink-3">{hint}</p>}
      {rows.length === 0 ? (
        <p className="mt-3 text-[13px] text-ink-4">没有</p>
      ) : (
        <ol className="mt-2 divide-y divide-line/70 text-[13px]">
          {rows.map((m, i) => {
            const body = (
              <>
                <span className="num w-5 text-[12px] text-ink-4">{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold text-ink">
                    {m.name} <span className="num font-normal text-ink-3">尾号 {m.phoneTail}</span>
                  </span>
                  <span className="block truncate text-[11.5px] text-ink-3">
                    {m.levelName} · 最近 {relativeTime(m.lastActivityAt)}
                  </span>
                </span>
                {value(m)}
              </>
            );
            return (
              <li key={m.id}>
                {can('member.read') ? (
                  <Link to={`/?m=${m.id}`} className="flex items-center gap-2 py-2 hover:bg-paper-2/50">
                    {body}
                  </Link>
                ) : (
                  <div className="flex items-center gap-2 py-2">{body}</div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

