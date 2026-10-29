import { useQuery } from '@tanstack/react-query';
import { Banknote, BedDouble, ClipboardCheck, Ticket, TrendingUp, UsersRound } from 'lucide-react';
import { CHECKOUT_METHOD_LABELS, type DashboardData } from '@shared/checkout';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import { cn, formatTime } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { Money } from '../../components/Money';
import { Card, Notice, SectionTitle, Skeleton } from '../../components/ui';

/** 经营看板：今天的在店、营业额与收款，近 7 个营业日营业额（口径与日结一致） */
export function DashboardPage() {
  const session = useSession();
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<DashboardData>('/api/dashboard'), refetchInterval: 60_000 });
  const d = q.data;
  return (
    <>
      <PageHeader title="经营看板" subtitle={`营业日 ${session.today} · 每分钟刷新`} />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1080px] space-y-5 px-5 py-6 md:px-7" data-testid="dashboard">
          {q.isPending ? (
            <Skeleton className="h-64" />
          ) : q.error ? (
            <Notice tone="error" title={q.error.message} />
          ) : (
            d && (
              <>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <Kpi icon={<TrendingUp className="size-4" />} label="今日净营业额（应收 − 优惠）" tone="pine">
                    <Money cents={d.todayStats.net - d.todayStats.discount} />
                    {d.todayStats.discount !== 0 && (
                      <span className="block text-[12px] font-semibold text-ink-3" data-testid="dashboard-discount">
                        应收 <Money cents={d.todayStats.net} /> · 优惠 <Money cents={-d.todayStats.discount} signed />
                      </span>
                    )}
                  </Kpi>
                  <Kpi icon={<UsersRound className="size-4" />} label="已结账客人">
                    {d.todayStats.guests} 位 · {d.todayStats.checkouts} 张
                  </Kpi>
                  <Kpi icon={<BedDouble className="size-4" />} label="在店（未结）">
                    {d.inStore.count} 位 · <Money cents={d.inStore.unsettled + d.inStore.ticketEstimate} />
                    {d.inStore.count > 0 && (
                      <span className="block text-[12px] font-semibold text-ink-3" data-testid="dashboard-instore-estimate">
                        已挂 <Money cents={d.inStore.unsettled} /> + 门票估算 <Money cents={d.inStore.ticketEstimate} />
                        {d.inStore.noTicket > 0 && `（${d.inStore.noTicket} 位未选票种，未计入）`}
                      </span>
                    )}
                  </Kpi>
                  <Kpi icon={<Banknote className="size-4" />} label="会员充值实收" tone="lake">
                    <Money cents={d.todayStats.rechargePaid} /> <span className="text-[13px] font-semibold text-ink-3">· {d.todayStats.rechargeCount} 笔</span>
                  </Kpi>
                </div>

                <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
                  <Card className="p-5">
                    <SectionTitle>近 {d.days.length} 个营业日营业额</SectionTitle>
                    <Bars days={d.days} />
                  </Card>
                  <Card className="p-5">
                    <SectionTitle>今日收款构成</SectionTitle>
                    <ul className="mt-3 space-y-2 text-[13px]">
                      {d.todayStats.byMethod.length === 0 && <li className="text-ink-4">今天还没有结账</li>}
                      {d.todayStats.byMethod.map((m) => (
                        <li key={m.method} className="flex justify-between">
                          <span className="text-ink-2">{CHECKOUT_METHOD_LABELS[m.method]}</span>
                          <Money cents={m.amount} className="font-bold" />
                        </li>
                      ))}
                    </ul>
                    <SectionTitle className="mt-5">今日门票</SectionTitle>
                    <ul className="mt-3 space-y-2 text-[13px]">
                      {d.tickets.length === 0 && <li className="text-ink-4">今天还没有结账</li>}
                      {d.tickets.map((t) => (
                        <li key={t.name} className="flex items-center justify-between gap-2">
                          <span className="flex items-center gap-1.5 text-ink-2">
                            <Ticket className="size-3.5 text-pine" />
                            {t.name} <span className="text-ink-3">· {t.count} 位</span>
                          </span>
                          <Money cents={t.amount} className="font-bold" />
                        </li>
                      ))}
                    </ul>
                  </Card>
                </div>

                <Card className="p-5">
                  <SectionTitle>
                    <span className="flex items-center gap-2">
                      <ClipboardCheck className="size-4 text-pine" /> 当班中
                    </span>
                  </SectionTitle>
                  {d.openShifts.length === 0 ? (
                    <p className="mt-2 text-[13px] text-ink-3">没有未交班的班次</p>
                  ) : (
                    <ul className="mt-2 flex flex-wrap gap-2">
                      {d.openShifts.map((s) => (
                        <li key={s.shiftNo} className="rounded-full bg-pine-tint px-3 py-1 text-[13px] font-semibold text-pine">
                          {s.staffName} · {formatTime(s.startedAt)} 开班
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </>
            )
          )}
        </div>
      </div>
    </>
  );
}

function Kpi({ icon, label, children, tone }: { icon: React.ReactNode; label: string; children: React.ReactNode; tone?: 'pine' | 'lake' }) {
  return (
    <Card className="p-4">
      <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-3">
        {icon}
        {label}
      </p>
      <p className={cn('mt-1.5 text-[22px] leading-tight font-bold', tone === 'pine' ? 'text-pine' : tone === 'lake' ? 'text-lake' : 'text-ink')}>{children}</p>
    </Card>
  );
}

function Bars({ days }: { days: DashboardData['days'] }) {
  const max = Math.max(1, ...days.map((d) => d.net));
  return (
    <div className="mt-4 flex h-44 items-end gap-2" role="img" aria-label="近几个营业日营业额">
      {days.map((d) => (
        <div key={d.date} className="flex min-w-0 flex-1 flex-col items-center gap-1">
          <span className="num text-[11px] text-ink-3">{d.net ? `¥${Math.round(d.net / 100)}` : ''}</span>
          <div className="flex w-full flex-1 items-end">
            <div className="w-full rounded-t-md bg-pine/80" style={{ height: `${Math.max(2, (Math.max(0, d.net) / max) * 100)}%` }} title={`${d.date} 营业额 ¥${(d.net / 100).toFixed(2)}，结账 ${d.checkouts} 张`} />
          </div>
          <span className="num text-[11px] text-ink-3">{d.date.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}
