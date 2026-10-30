// 技师业绩（v0.7.0）：任选时段每位技师的钟数、点钟 / 轮钟与金额。
// 口径与部门构成相同：结账那一刻账单上的技师明细，时段内结的计入、时段内反结账的冲回；还没结账的不算。

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Download, HandHeart, Hourglass, Star, UsersRound } from 'lucide-react';
import { CALL_TYPE_LABELS, gradeLabel, type TechnicianReport } from '@shared/technicians';
import { api } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Badge, Card, Notice, SectionTitle, Skeleton } from '../../components/ui';
import { HBars, Kpi, PeriodPicker, presetRange, type Period } from './charts';

export function TechniciansTab() {
  const session = useSession();
  const can = useCan();
  const [period, setPeriod] = useState<Period>(() => ({ preset: 'today', ...presetRange('today', session.today) }));
  const q = useQuery({
    queryKey: ['reports', 'technicians', period.from, period.to],
    queryFn: () => api.get<TechnicianReport>(`/api/reports/technicians?from=${period.from}&to=${period.to}`),
    enabled: period.from <= period.to,
  });
  const d = q.data;
  const busy = d?.rows.filter((r) => r.clocks > 0) ?? [];
  const designatedRate = d && d.totals.clocks > 0 ? Math.round((d.totals.designated / d.totals.clocks) * 100) : 0;
  return (
    <div className="space-y-5" data-testid="dashboard-technicians">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PeriodPicker value={period} onChange={setPeriod} today={session.today} />
        <p className="text-[12.5px] text-ink-3">按结账计：时段内结账的计入，反结账的冲回；在店未结的不算</p>
        {can('report.commission') && (
          <a
            href={`/api/reports/technicians/commission.csv?from=${period.from}&to=${period.to}`}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-line-strong px-3 text-[13px] font-semibold text-ink-2 hover:border-pine hover:text-pine"
            data-testid="commission-export"
          >
            <Download className="size-4" /> 导出提成明细
          </a>
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
              <Kpi icon={<Hourglass className="size-4" />} label="钟数" tone="pine" testId="technicians-clocks">
                {d.totals.clocks} 个钟
                <span className="block text-[12px] font-semibold text-ink-3">
                  {CALL_TYPE_LABELS.designated} {d.totals.designated} · {CALL_TYPE_LABELS.rotation} {d.totals.rotation}
                </span>
              </Kpi>
              <Kpi icon={<HandHeart className="size-4" />} label="技师项目金额">
                <Money cents={d.totals.amount} />
                {d.unassigned.clocks !== 0 && (
                  <span className="block text-[12px] font-semibold text-ink-3">
                    另有未指定技师 {d.unassigned.clocks} 个钟 · <Money cents={d.unassigned.amount} />
                  </span>
                )}
              </Kpi>
              <Kpi icon={<Star className="size-4" />} label="点钟率">
                {d.totals.clocks ? `${designatedRate}%` : '—'}
                <span className="block text-[12px] font-semibold text-ink-3">客人点名的钟占比</span>
              </Kpi>
              {d.totals.commission ? (
                <Kpi icon={<UsersRound className="size-4" />} label="技师提成合计" tone="lake" testId="technicians-commission">
                  <Money cents={d.totals.commission.total} />
                  <span className="block text-[12px] font-semibold text-ink-3">
                    其中点钟奖励 <Money cents={d.totals.commission.bonus} /> · 上钟技师 {busy.length} 位
                  </span>
                </Kpi>
              ) : (
                <Kpi icon={<UsersRound className="size-4" />} label="上钟技师" tone="lake">
                  {busy.length} 位
                  <span className="block text-[12px] font-semibold text-ink-3">在职 {d.rows.filter((r) => r.active).length} 位</span>
                </Kpi>
              )}
            </div>

            {d.rows.length === 0 ? (
              <Card className="p-8 text-center text-[13.5px] text-ink-3">
                还没有技师。{can('technician.manage') && <Link to="/admin/technicians" className="font-semibold text-pine hover:underline">去后台添加技师</Link>}
              </Card>
            ) : (
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.7fr)]">
                <Card className="p-5">
                  <SectionTitle>钟数排行</SectionTitle>
                  <HBars
                    testId="technicians-rank"
                    format={(n) => `${n} 钟`}
                    empty="这个时段还没有结账的技师钟"
                    rows={busy.map((r) => ({ key: String(r.technicianId), label: `${r.techNo} 号 ${r.name}`, value: r.clocks }))}
                  />
                </Card>
                <Card className="overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[560px] text-[13px]" data-testid="technicians-table">
                      <thead className="bg-paper-2/70 text-[12px] font-bold text-ink-3">
                        <tr>
                          <th className="px-2.5 py-2 text-left">技师</th>
                          <th className="px-2.5 py-2 text-left">等级</th>
                          <th className="px-2.5 py-2 text-right">钟数</th>
                          <th className="px-2.5 py-2 text-right">{CALL_TYPE_LABELS.designated}</th>
                          <th className="px-2.5 py-2 text-right">{CALL_TYPE_LABELS.rotation}</th>
                          <th className="px-2.5 py-2 text-right">金额</th>
                          {d.totals.commission && <th className="px-2.5 py-2 text-right">提成</th>}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line/70">
                        {d.rows.map((r) => (
                          <tr key={r.technicianId} className={cn(!r.active && 'text-ink-3')} data-testid={`technicians-row-${r.techNo}`}>
                            <td className="px-2.5 py-2">
                              <span className="num font-bold">{r.techNo}</span> <span className="font-semibold">{r.name}</span>
                              {!r.active && (
                                <Badge className="ml-1.5" tone="clay">
                                  已停用
                                </Badge>
                              )}
                            </td>
                            <td className="px-2.5 py-2 text-ink-3">{gradeLabel(r.grade)}</td>
                            <td className="num px-2.5 py-2 text-right font-bold">{r.clocks}</td>
                            <td className="num px-2.5 py-2 text-right">{r.designated}</td>
                            <td className="num px-2.5 py-2 text-right">{r.rotation}</td>
                            <td className="px-2.5 py-2 text-right">
                              <Money cents={r.amount} className="font-semibold" />
                            </td>
                            {r.commission && (
                              <td className="px-2.5 py-2 text-right" title={`基本 ¥${(r.commission.base / 100).toFixed(2)} + 点钟奖励 ¥${(r.commission.bonus / 100).toFixed(2)}`}>
                                <Money cents={r.commission.total} className="font-semibold text-pine" />
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="border-t border-line bg-paper-2/40 font-bold">
                        <tr>
                          <td className="px-2.5 py-2" colSpan={2}>
                            合计
                          </td>
                          <td className="num px-2.5 py-2 text-right">{d.totals.clocks}</td>
                          <td className="num px-2.5 py-2 text-right">{d.totals.designated}</td>
                          <td className="num px-2.5 py-2 text-right">{d.totals.rotation}</td>
                          <td className="px-2.5 py-2 text-right">
                            <Money cents={d.totals.amount} />
                          </td>
                          {d.totals.commission && (
                            <td className="px-2.5 py-2 text-right">
                              <Money cents={d.totals.commission.total} />
                            </td>
                          )}
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </Card>
              </div>
            )}
          </>
        )
      )}
    </div>
  );
}
