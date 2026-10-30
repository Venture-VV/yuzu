// 看板的小部件：指标卡（含环比）、竖条（按日 / 按小时）、横条（构成）、时段选择。
// 只用一个色相表示数量（松绿），文字用正文色；每根条都有悬停说明（title），数值在旁边写出来，不靠颜色区分。

import type { ReactNode } from 'react';
import { REPORT_PRESET_LABELS, REPORT_PRESETS, type ReportPreset } from '@shared/reports';
import { shiftDate } from '@shared/labels';
import { formatYuan } from '@shared/money';
import { cn } from '../../lib/utils';
import { Card, Input, Segmented } from '../../components/ui';

export function Kpi({
  icon,
  label,
  children,
  tone,
  delta,
  testId,
}: {
  icon?: ReactNode;
  label: string;
  children: ReactNode;
  tone?: 'pine' | 'lake';
  /** 与上一时段比较：当前值、上一时段的值与它的写法 */
  delta?: { now: number; prev: number; format: (v: number) => string };
  testId?: string;
}) {
  return (
    <Card className="p-4" data-testid={testId}>
      <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-3">
        {icon}
        {label}
      </p>
      <div className={cn('mt-1.5 text-[22px] leading-tight font-bold', tone === 'pine' ? 'text-pine' : tone === 'lake' ? 'text-lake' : 'text-ink')}>{children}</div>
      {delta && <Delta {...delta} />}
    </Card>
  );
}

/** 环比：上一时段为 0 时只说「上一时段没有」 */
export function Delta({ now, prev, format }: { now: number; prev: number; format: (v: number) => string }) {
  if (prev === 0) return <p className="mt-1 text-[12px] text-ink-4">{now === 0 ? '与上一时段持平' : '上一时段没有'}</p>;
  const pct = ((now - prev) / Math.abs(prev)) * 100;
  const flat = Math.abs(pct) < 0.05;
  return (
    <p className={cn('mt-1 text-[12px] font-semibold', flat ? 'text-ink-3' : pct > 0 ? 'text-pine' : 'text-clay')}>
      {flat ? '与上一时段持平' : `${pct > 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(1)}%`}
      <span className="font-normal text-ink-4"> · 上一时段 {format(prev)}</span>
    </p>
  );
}

/** 竖条：按日或按小时，一个序列；每根条悬停显示说明 */
export function Columns({
  items,
  label,
  format,
  height = 'h-40',
  showValues = true,
}: {
  items: { key: string; label: string; value: number; title: string }[];
  label: string;
  format: (v: number) => string;
  height?: string;
  showValues?: boolean;
}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  const dense = items.length > 16;
  return (
    <div className={cn('mt-4 flex items-end gap-[2px]', height)} role="img" aria-label={label}>
      {items.map((i, idx) => (
        <div key={i.key} className="group flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1" title={i.title}>
          {showValues && !dense && <span className="num truncate text-[11px] text-ink-3">{i.value ? format(i.value) : ''}</span>}
          <div className="flex w-full flex-1 items-end">
            <div
              className="w-full rounded-t-[4px] bg-pine/75 transition-colors group-hover:bg-pine"
              style={{ height: `${i.value > 0 ? Math.max(3, (i.value / max) * 100) : 1}%`, opacity: i.value > 0 ? 1 : 0.25 }}
            />
          </div>
          <span className={cn('num text-[10.5px] text-ink-3', dense && idx % Math.ceil(items.length / 12) !== 0 && 'invisible')}>{i.label}</span>
        </div>
      ))}
    </div>
  );
}

/** 横条：构成（收款方式、部门、渠道、等级），数值与占比写在条旁边 */
export function HBars({
  rows,
  format,
  empty,
  testId,
}: {
  rows: { key: string; label: ReactNode; value: number; note?: ReactNode }[];
  format: (v: number) => string;
  empty: string;
  testId?: string;
}) {
  const total = rows.reduce((t, r) => t + Math.max(0, r.value), 0);
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (rows.length === 0) return <p className="mt-3 text-[13px] text-ink-4">{empty}</p>;
  return (
    <ul className="mt-3 space-y-2.5 text-[13px]" data-testid={testId}>
      {rows.map((r) => (
        <li key={r.key} title={`${typeof r.label === 'string' ? r.label : ''} ${format(r.value)}`}>
          <div className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 truncate text-ink-2">{r.label}</span>
            <span className="num shrink-0 font-bold text-ink">
              {format(r.value)}
              {total > 0 && r.value > 0 && <span className="ml-1.5 text-[11.5px] font-semibold text-ink-3">{Math.round((r.value / total) * 100)}%</span>}
            </span>
          </div>
          <div className="mt-1 h-2 rounded-full bg-paper-2">
            <div className="h-full rounded-full bg-pine/70" style={{ width: `${Math.max(0, (r.value / max) * 100)}%` }} />
          </div>
          {r.note && <p className="mt-0.5 text-[11.5px] text-ink-3">{r.note}</p>}
        </li>
      ))}
    </ul>
  );
}

export const yuanShort = (cents: number) => {
  const y = cents / 100;
  if (Math.abs(y) >= 10000) return `¥${(y / 10000).toFixed(Math.abs(y) >= 100000 ? 0 : 1)}万`;
  return `¥${Math.round(y)}`;
};
export const yuan = (cents: number) => formatYuan(cents);

/** 常用时段（营业日） */
export function presetRange(preset: ReportPreset, today: string): { from: string; to: string } {
  const month = today.slice(0, 7);
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday':
      return { from: shiftDate(today, -1), to: shiftDate(today, -1) };
    case 'last7':
      return { from: shiftDate(today, -6), to: today };
    case 'last30':
      return { from: shiftDate(today, -29), to: today };
    case 'month':
      return { from: `${month}-01`, to: today };
    case 'lastMonth': {
      const last = shiftDate(`${month}-01`, -1);
      return { from: `${last.slice(0, 7)}-01`, to: last };
    }
  }
}

export interface Period {
  preset: ReportPreset | 'custom';
  from: string;
  to: string;
}

/** 时段选择：常用时段 + 自定义起止日期 */
export function PeriodPicker({ value, onChange, today }: { value: Period; onChange: (p: Period) => void; today: string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2" data-testid="period-picker">
      <div className="min-w-0 max-w-full">
        <Segmented
          size="sm"
          className="flex-wrap"
          ariaLabel="时段"
          value={value.preset}
          onChange={(p) => (p === 'custom' ? onChange({ ...value, preset: 'custom' }) : onChange({ preset: p, ...presetRange(p, today) }))}
          options={[...REPORT_PRESETS.map((p) => ({ value: p as ReportPreset | 'custom', label: REPORT_PRESET_LABELS[p] })), { value: 'custom' as const, label: '自定义' }]}
        />
      </div>
      {value.preset === 'custom' && (
        <span className="flex items-center gap-1.5 text-[13px] text-ink-3">
          <Input type="date" value={value.from} max={value.to} onChange={(e) => e.target.value && onChange({ ...value, from: e.target.value })} fullWidth={false} className="h-8 w-[150px]" aria-label="开始日期" />
          至
          <Input type="date" value={value.to} min={value.from} max={today} onChange={(e) => e.target.value && onChange({ ...value, to: e.target.value })} fullWidth={false} className="h-8 w-[150px]" aria-label="结束日期" />
        </span>
      )}
    </div>
  );
}
