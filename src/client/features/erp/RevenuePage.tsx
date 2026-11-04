// ERP 营业数据（只读）：任选时段的营业收入、每天的明细与日结情况、收款与部门构成。
// 与经营总览同一口径（结账计正、反结账冲回）；门店的流水、日结、交班仍在门店办理，这里不改任何数据。

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Banknote, ReceiptText, Tag, TrendingUp, UsersRound } from 'lucide-react';
import { CHECKOUT_METHOD_LABELS } from '@shared/checkout';
import type { ErpRevenue } from '@shared/erp';
import { api, errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { formatDateTime } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Badge, Card, Notice, SectionTitle, Skeleton } from '../../components/ui';
import { HBars, Kpi, PeriodPicker, presetRange, yuan, type Period } from '../dashboard/charts';
import { ErpPage } from './ErpHome';

export function RevenuePage() {
  const session = useSession();
  const [period, setPeriod] = useState<Period>(() => ({ preset: 'last7', ...presetRange('last7', session.today) }));
  const q = useQuery({
    queryKey: ['erp', 'revenue', period.from, period.to],
    queryFn: () => api.get<ErpRevenue>(`/api/erp/revenue?from=${period.from}&to=${period.to}`),
    enabled: period.from <= period.to,
  });
  const d = q.data;
  const closed = new Map((d?.settlements ?? []).map((s) => [s.date, s]));
  return (
    <ErpPage
      title="营业数据"
      description="只读：每天的营业收入、收款与部门构成、日结情况（与经营总览同一口径，结账计入、反结账冲回）。门店的流水、日结、交班仍在门店办理。"
    >
      <div className="space-y-5" data-testid="erp-revenue">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <PeriodPicker value={period} onChange={setPeriod} today={session.today} />
          {d && (
            <p className="text-[12.5px] text-ink-3">
              {d.from} 至 {d.to}（{d.days} 个营业日）
            </p>
          )}
        </div>
        {q.isPending ? (
          <Skeleton className="h-72" />
        ) : q.error ? (
          <Notice tone="error" title={errorMessage(q.error)} />
        ) : (
          d && (
            <>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                <Kpi icon={<TrendingUp className="size-4" />} label="净营业额（应收 − 优惠 − 券抵扣 − 退款）" tone="pine" testId="erp-revenue-net">
                  <Money cents={d.kpis.net} />
                </Kpi>
                <Kpi icon={<ReceiptText className="size-4" />} label="应收 / 优惠、券抵扣与会员折扣 / 退款">
                  <Money cents={d.kpis.receivable} />{' '}
                  <span className="text-[13px] font-semibold text-ink-3">
                    / <Money cents={d.kpis.discount + (d.kpis.coupon ?? 0) + (d.kpis.memberDiscount ?? 0)} /> / <Money cents={d.kpis.refund ?? 0} />
                  </span>
                </Kpi>
                <Kpi icon={<UsersRound className="size-4" />} label="结账客人 / 结账单">
                  {d.kpis.guests} 位 <span className="text-[13px] font-semibold text-ink-3">/ {d.kpis.checkouts} 张</span>
                </Kpi>
                <Kpi icon={<Tag className="size-4" />} label="客单价">
                  <Money cents={d.kpis.perGuest} />
                </Kpi>
                <Kpi icon={<Banknote className="size-4" />} label="会员充值实收" tone="lake">
                  <Money cents={d.kpis.rechargePaid} />
                  {d.kpis.memberRefund > 0 && (
                    <span className="block text-[12px] font-semibold text-ink-3">
                      退储值 −<Money cents={d.kpis.memberRefund} />
                    </span>
                  )}
                </Kpi>
              </div>

              <Card className="overflow-hidden">
                <div className="px-4 pt-4">
                  <SectionTitle>每天</SectionTitle>
                </div>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full min-w-[560px] text-[13px]" data-testid="erp-revenue-days">
                    <thead className="bg-paper-2/70 text-[12px] text-ink-3">
                      <tr>
                        <th className="px-4 py-2 text-left font-semibold">营业日</th>
                        <th className="px-3 py-2 text-right font-semibold">净营业额</th>
                        <th className="px-3 py-2 text-right font-semibold">结账客人</th>
                        <th className="px-3 py-2 text-right font-semibold">充值实收</th>
                        <th className="px-4 py-2 text-left font-semibold">日结</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line/70">
                      {[...d.trend].reverse().map((t) => {
                        const s = closed.get(t.date);
                        return (
                          <tr key={t.date}>
                            <td className="num px-4 py-2 font-semibold">{t.date}</td>
                            <td className="px-3 py-2 text-right">
                              <Money cents={t.net} className="font-bold" />
                            </td>
                            <td className="num px-3 py-2 text-right">{t.guests}</td>
                            <td className="px-3 py-2 text-right">
                              <Money cents={t.rechargePaid} />
                            </td>
                            <td className="px-4 py-2">
                              {s ? (
                                <span className="text-[12px] text-ink-3">
                                  <Badge tone="pine">已日结</Badge> {s.closedByName} · {formatDateTime(s.closedAt)}
                                </span>
                              ) : (
                                <Badge tone="neutral">未日结</Badge>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>

              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                <Card className="p-4">
                  <SectionTitle>收款构成</SectionTitle>
                  <HBars
                    testId="erp-revenue-methods"
                    format={yuan}
                    empty="这段时间没有结账"
                    rows={d.byMethod.map((x) => ({ key: x.method, label: CHECKOUT_METHOD_LABELS[x.method], value: x.amount }))}
                  />
                </Card>
                <Card className="p-4">
                  <SectionTitle>部门构成（结账那一刻的明细）</SectionTitle>
                  <HBars
                    testId="erp-revenue-departments"
                    format={yuan}
                    empty="这段时间没有结账"
                    rows={d.departments.map((x) => ({ key: x.category, label: x.category, value: x.amount, note: `${x.quantity} 项${x.discount ? ` · 优惠 ${yuan(x.discount)}` : ''}${x.refund ? ` · 退款 ${yuan(x.refund)}` : ''}` }))}
                  />
                </Card>
              </div>
            </>
          )
        )}
      </div>
    </ErpPage>
  );
}
