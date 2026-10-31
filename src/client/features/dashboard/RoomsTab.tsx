// 看板「客房」（S7，v0.7.4，经营总览的岗位看；客房功能开启后才显示）：此刻的房态与在住押金、任选时段的入住、晚数、
// 客房营业额（结账口径：时段内结账的房费，反结账冲回，与部门参考表的「客房」一致）、平均房价、押金的收退。

import { useState } from 'react';
import { BedDouble, HandCoins, Moon, TrendingUp } from 'lucide-react';
import { ROOM_BOARD_LABELS } from '@shared/rooms';
import { useSession } from '../../lib/session';
import { Money } from '../../components/Money';
import { Card, Notice, SectionTitle, Skeleton } from '../../components/ui';
import { useRoomsReport } from '../rooms/queries';
import { Columns, HBars, Kpi, PeriodPicker, presetRange, yuan, yuanShort, type Period } from './charts';

export function RoomsTab() {
  const session = useSession();
  const [period, setPeriod] = useState<Period>(() => ({ preset: 'today', ...presetRange('today', session.today) }));
  const q = useRoomsReport(period.from, period.to, period.from <= period.to);
  const d = q.data;
  const occupied = d ? d.now.counts.occupied : 0;
  const rate = d && d.now.rooms > 0 ? Math.round((occupied / d.now.rooms) * 100) : 0;
  return (
    <div className="space-y-5" data-testid="dashboard-rooms">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PeriodPicker value={period} onChange={setPeriod} today={session.today} />
        <p className="text-[12.5px] text-ink-3">营业额按结账计：时段内结账的房费计入，反结账的冲回；押金不算营业额</p>
      </div>
      {q.isPending ? (
        <Skeleton className="h-72" />
      ) : q.error ? (
        <Notice tone="error" title={q.error.message} />
      ) : (
        d && (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Kpi icon={<BedDouble className="size-4" />} label="此刻在住" tone="pine" testId="rooms-now">
                {occupied} / {d.now.rooms} 间
                <span className="block text-[12px] font-semibold text-ink-3">
                  入住率 {rate}% · {ROOM_BOARD_LABELS.dirty} {d.now.counts.dirty} · {ROOM_BOARD_LABELS.maintenance} {d.now.counts.maintenance}
                </span>
              </Kpi>
              <Kpi icon={<TrendingUp className="size-4" />} label="客房营业额（结账口径）" testId="rooms-revenue">
                <Money cents={d.revenue.total} />
                <span className="block text-[12px] font-semibold text-ink-3">平均房价 {d.averageRate !== null ? yuan(d.averageRate) : '—'}</span>
              </Kpi>
              <Kpi icon={<Moon className="size-4" />} label="入住与晚数">
                {d.checkins} 次入住
                <span className="block text-[12px] font-semibold text-ink-3">
                  全天房 {d.nights} 晚 · 钟点房 {d.blocks} 段
                </span>
              </Kpi>
              <Kpi icon={<HandCoins className="size-4" />} label="在住押金余额" tone="lake" testId="rooms-deposit">
                <Money cents={d.now.depositHeld} />
                <span className="block text-[12px] font-semibold text-ink-3">
                  时段内收 <Money cents={d.deposits.received} /> · 退 <Money cents={d.deposits.refunded} />
                </span>
              </Kpi>
            </div>
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
              <Card className="p-5">
                <SectionTitle>按营业日</SectionTitle>
                {d.days.length <= 1 ? (
                  <p className="mt-3 text-[13px] text-ink-3">选一段日期看每天的客房营业额。</p>
                ) : (
                  <Columns
                    label="每天的客房营业额"
                    format={yuanShort}
                    items={d.days.map((x) => ({
                      key: x.date,
                      label: x.date.slice(5),
                      value: x.revenue,
                      title: `${x.date}：营业额 ${yuan(x.revenue)}，入住 ${x.checkins} 次，${x.nights} 晚`,
                    }))}
                  />
                )}
              </Card>
              <Card className="p-5">
                <SectionTitle>房费构成</SectionTitle>
                <HBars
                  testId="rooms-revenue-kinds"
                  format={yuan}
                  empty="这个时段还没有结账的房费"
                  rows={d.revenue.byKind.map((k) => ({ key: k.name, label: `${k.name} · ${k.quantity}`, value: k.amount }))}
                />
              </Card>
            </div>
          </>
        )
      )}
    </div>
  );
}
