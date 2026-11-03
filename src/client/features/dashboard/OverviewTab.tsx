// 经营总览（总经理：店主、店总）：任选时段的营业额、客流、客单价、收款与部门构成、热门项目、到店时段，与上一时段环比。

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Banknote, Gift, ReceiptText, Tag, TrendingUp, UserPlus, UsersRound, Wallet } from 'lucide-react';
import { CHECKOUT_METHOD_LABELS } from '@shared/checkout';
import type { ExecutiveReport } from '@shared/reports';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import { Money } from '../../components/Money';
import { Card, Notice, SectionTitle, Skeleton } from '../../components/ui';
import { Columns, HBars, Kpi, PeriodPicker, presetRange, yuan, yuanShort, type Period } from './charts';

const people = (n: number) => `${n} 位`;
const count = (n: number) => `${n}`;

export function OverviewTab() {
  const session = useSession();
  const [period, setPeriod] = useState<Period>(() => ({ preset: 'last7', ...presetRange('last7', session.today) }));
  const q = useQuery({
    queryKey: ['reports', 'executive', period.from, period.to],
    queryFn: () => api.get<ExecutiveReport>(`/api/reports/executive?from=${period.from}&to=${period.to}`),
    enabled: period.from <= period.to,
  });
  const d = q.data;
  const startHour = session.rules.businessDayStartHour;
  return (
    <div className="space-y-5" data-testid="dashboard-overview">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PeriodPicker value={period} onChange={setPeriod} today={session.today} />
        {d && (
          <p className="text-[12.5px] text-ink-3">
            {d.from} 至 {d.to}（{d.days} 个营业日）· 对比 {d.prevFrom} 至 {d.prevTo}
          </p>
        )}
      </div>
      {q.isPending ? (
        <Skeleton className="h-72" />
      ) : q.error ? (
        <Notice tone="error" title={q.error.message} />
      ) : (
        d && (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Kpi icon={<TrendingUp className="size-4" />} label="净营业额（应收 − 优惠 − 券抵扣 − 退款）" tone="pine" delta={{ now: d.kpis.net, prev: d.prev.net, format: yuan }} testId="overview-net">
                <Money cents={d.kpis.net} />
              </Kpi>
              <Kpi icon={<UsersRound className="size-4" />} label="结账客人" delta={{ now: d.kpis.guests, prev: d.prev.guests, format: people }}>
                {d.kpis.guests} 位
              </Kpi>
              <Kpi icon={<Tag className="size-4" />} label="客单价" delta={{ now: d.kpis.perGuest, prev: d.prev.perGuest, format: yuan }}>
                <Money cents={d.kpis.perGuest} />
              </Kpi>
              <Kpi icon={<ReceiptText className="size-4" />} label="结账单" delta={{ now: d.kpis.checkouts, prev: d.prev.checkouts, format: count }}>
                {d.kpis.checkouts} 张
              </Kpi>
              <Kpi icon={<Banknote className="size-4" />} label="会员充值实收" tone="lake" delta={{ now: d.kpis.rechargePaid, prev: d.prev.rechargePaid, format: yuan }}>
                <Money cents={d.kpis.rechargePaid} /> <span className="text-[13px] font-semibold text-ink-3">· {d.kpis.rechargeCount} 笔</span>
              </Kpi>
              <Kpi icon={<Wallet className="size-4" />} label="储值消费" delta={{ now: d.kpis.walletConsumed, prev: d.prev.walletConsumed, format: yuan }}>
                <Money cents={d.kpis.walletConsumed} />
              </Kpi>
              <Kpi icon={<UserPlus className="size-4" />} label="新增会员" delta={{ now: d.kpis.newMembers, prev: d.prev.newMembers, format: people }}>
                {d.kpis.newMembers} 位
              </Kpi>
              <Kpi icon={<Gift className="size-4" />} label="优惠 / 免单与券抵扣" delta={{ now: d.kpis.discount + (d.kpis.coupon ?? 0), prev: d.prev.discount + (d.prev.coupon ?? 0), format: yuan }}>
                <Money cents={d.kpis.discount + (d.kpis.coupon ?? 0)} />
                <span className="block text-[12px] font-semibold text-ink-3">
                  应收 <Money cents={d.kpis.receivable} />
                  {!!d.kpis.coupon && (
                    <>
                      {' '}
                      · 其中券抵扣 <Money cents={d.kpis.coupon} />
                    </>
                  )}
                  {!!d.kpis.refund && (
                    <>
                      {' '}
                      · 退款 <Money cents={d.kpis.refund} />
                    </>
                  )}
                </span>
              </Kpi>
            </div>

            <Card className="p-5">
              <SectionTitle aside={<span className="text-[12px] text-ink-3">悬停看当天客人与充值</span>}>每日净营业额</SectionTitle>
              <Columns
                label="每日净营业额"
                format={yuanShort}
                items={d.trend.map((t) => ({
                  key: t.date,
                  label: t.date.slice(5),
                  value: t.net,
                  title: `${t.date} 净营业额 ${yuan(t.net)}，结账客人 ${t.guests} 位，会员充值实收 ${yuan(t.rechargePaid)}`,
                }))}
              />
            </Card>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Card className="p-5">
                <SectionTitle>部门（项目分类）构成</SectionTitle>
                <HBars
                  testId="overview-departments"
                  format={yuan}
                  empty="这段时间没有结账"
                  rows={d.departments.map((x) => ({ key: x.category, label: x.category, value: x.amount, note: `${x.quantity} 项${x.discount ? ` · 优惠 ${yuan(x.discount)}` : ''}${x.refund ? ` · 退款 ${yuan(x.refund)}` : ''}` }))}
                />
              </Card>
              <Card className="p-5">
                <SectionTitle>收款构成</SectionTitle>
                <HBars format={yuan} empty="这段时间没有结账" rows={d.byMethod.map((m) => ({ key: m.method, label: CHECKOUT_METHOD_LABELS[m.method], value: m.amount }))} />
              </Card>
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
              <Card className="p-5">
                <SectionTitle>热门项目（按金额）</SectionTitle>
                {d.topItems.length === 0 ? (
                  <p className="mt-3 text-[13px] text-ink-4">这段时间没有项目消费</p>
                ) : (
                  <div className="mt-3 overflow-x-auto">
                    <table className="w-full min-w-[360px] text-[13px]">
                      <thead className="text-[12px] text-ink-3">
                        <tr>
                          <th className="py-1.5 text-left font-semibold">项目</th>
                          <th className="py-1.5 text-left font-semibold">分类</th>
                          <th className="py-1.5 text-right font-semibold">数量</th>
                          <th className="py-1.5 text-right font-semibold">金额</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line/70">
                        {d.topItems.map((t) => (
                          <tr key={`${t.category}-${t.name}`}>
                            <td className="py-1.5 font-semibold text-ink">{t.name}</td>
                            <td className="py-1.5 text-ink-3">{t.category}</td>
                            <td className="num py-1.5 text-right">{t.quantity}</td>
                            <td className="py-1.5 text-right">
                              <Money cents={t.amount} className="font-bold" />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
              <Card className="p-5">
                <SectionTitle>门票</SectionTitle>
                <HBars format={(n) => `${n} 位`} empty="这段时间没有结账" rows={d.tickets.map((t) => ({ key: t.name, label: t.name, value: t.count, note: <Money cents={t.amount} /> }))} />
              </Card>
            </div>

            <Card className="p-5">
              <SectionTitle aside={<span className="text-[12px] text-ink-3">按接待时间，撤销误开的不计</span>}>到店时段</SectionTitle>
              <Columns
                label="各小时到店人数"
                format={(n) => String(n)}
                height="h-32"
                items={Array.from({ length: 24 }, (_, i) => (i + startHour) % 24).map((h) => {
                  const n = d.arrivals.find((a) => a.hour === h)?.count ?? 0;
                  return { key: String(h), label: String(h).padStart(2, '0'), value: n, title: `${String(h).padStart(2, '0')}:00–${String(h).padStart(2, '0')}:59 到店 ${n} 位` };
                })}
              />
            </Card>
          </>
        )
      )}
    </div>
  );
}
