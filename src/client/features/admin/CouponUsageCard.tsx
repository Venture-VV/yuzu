// 「券与会员权益 → 使用率」（8.0.4 需求表 08，docs/MEMBERSHIP_V804.md 第 8 节，HY10）：按发放的时间段圈一批券，
// 看领取率、核销率与核销金额；可按会员档级、标签圈，按券 / 发放方式 / 会员权益 / 档级分别看，导出 CSV。
// 口径写在页面下方（与 @shared/coupon-usage 一致）；与「统计」的区别：统计按事情发生的那一天，这里按发券的那一批算到今天。

import { useState, type ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { ISO_DATE } from '@shared/business-date';
import { rateText, usageRate, USAGE_GROUP_LABELS, USAGE_GROUPS, type CouponUsage, type UsageGroup, type UsageRow } from '@shared/coupon-usage';
import { shiftDate } from '@shared/labels';
import { groupTags } from '@shared/member-tags';
import { api, errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { downloadUrl } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Button, Card, Input, Notice, SectionTitle, Segmented, Select, Skeleton } from '../../components/ui';
import { useCouponMeta } from '../coupons/queries';
import { useMemberTags } from '../membership/TagPicker';

interface Range {
  from: string;
  to: string;
  grade: number | null;
  tagId: number | null;
}

const queryOf = (r: Range) => `from=${r.from}&to=${r.to}${r.grade !== null ? `&grade=${r.grade}` : ''}${r.tagId !== null ? `&tagId=${r.tagId}` : ''}`;

function useCouponUsage(r: Range, enabled: boolean) {
  return useQuery({
    queryKey: ['coupons', 'usage', r] as const,
    queryFn: () => api.get<CouponUsage>(`/api/coupons/usage?${queryOf(r)}`),
    enabled,
    placeholderData: keepPreviousData,
  });
}

/** 一位小数的比例条：单一颜色，长度就是比例（文字照常用正文颜色） */
function RateMeter({ part, whole }: { part: number; whole: number }) {
  const r = usageRate(part, whole);
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span className="num">{rateText(part, whole)}</span>
      <span className="hidden h-1.5 w-14 overflow-hidden rounded-full bg-paper-2 sm:inline-block" aria-hidden>
        <span className="block h-full rounded-full bg-pine" style={{ width: `${Math.min(100, r ?? 0)}%` }} />
      </span>
    </span>
  );
}

function Tile({ label, children, sub, testId }: { label: string; children: ReactNode; sub?: ReactNode; testId: string }) {
  return (
    <div className="rounded-lg border border-line bg-card px-4 py-3" data-testid={testId}>
      <p className="text-[12.5px] font-semibold text-ink-3">{label}</p>
      <p className="num mt-1 text-[24px] leading-tight font-bold text-ink">{children}</p>
      {sub && <p className="mt-0.5 text-[12.5px] text-ink-2">{sub}</p>}
    </div>
  );
}

export function CouponUsageCard() {
  const session = useSession();
  const monthStart = `${session.today.slice(0, 8)}01`;
  const [range, setRange] = useState<Range>({ from: monthStart, to: session.today, grade: null, tagId: null });
  const [group, setGroup] = useState<UsageGroup>('template');
  const valid = ISO_DATE.test(range.from) && ISO_DATE.test(range.to) && range.from <= range.to;
  const usage = useCouponUsage(range, valid);
  const meta = useCouponMeta();
  const tags = useMemberTags();
  const d = usage.data;
  const quick = (from: string, label: string, testId: string) => {
    const on = range.from === from && range.to === session.today;
    return (
      <Button size="sm" variant={on ? 'quiet' : 'ghost'} onClick={() => setRange((r) => ({ ...r, from, to: session.today }))} aria-pressed={on} data-testid={testId}>
        {label}
      </Button>
    );
  };
  const rows: UsageRow[] = d ? d.groups[group] : [];
  return (
    <Card className="space-y-4 p-5" data-testid="coupon-usage">
      <SectionTitle
        aside={
          <Button
            size="sm"
            variant="ghost"
            icon={<Download className="size-4" />}
            disabled={!valid || !d?.totals.issued}
            onClick={() => downloadUrl(`/api/coupons/usage.csv?${queryOf(range)}`)}
            data-testid="coupon-usage-export"
          >
            导出
          </Button>
        }
      >
        使用率
      </SectionTitle>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-3">
          发放从
          <Input type="date" fullWidth={false} value={range.from} max={range.to || session.today} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} className="w-40" data-testid="coupon-usage-from" />
        </label>
        <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-3">
          到
          <Input type="date" fullWidth={false} value={range.to} min={range.from || undefined} max={session.today} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} className="w-40" data-testid="coupon-usage-to" />
        </label>
        <div className="flex gap-1.5">
          {quick(monthStart, '本月', 'coupon-usage-month')}
          {quick(shiftDate(session.today, -89), '近 90 天', 'coupon-usage-90')}
        </div>
        <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-3">
          会员档级
          <Select
            value={range.grade ?? ''}
            onChange={(e) => setRange((r) => ({ ...r, grade: e.target.value === '' ? null : Number(e.target.value) }))}
            className="h-9 w-44 text-[13px]"
            data-testid="coupon-usage-grade"
          >
            <option value="">全部（含无记名券）</option>
            {(meta.data?.levels ?? []).map((l) => (
              <option key={l.level} value={l.level}>
                {l.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-3">
          会员标签
          <Select
            value={range.tagId ?? ''}
            onChange={(e) => setRange((r) => ({ ...r, tagId: e.target.value ? Number(e.target.value) : null }))}
            className="h-9 w-48 text-[13px]"
            data-testid="coupon-usage-tag"
          >
            <option value="">不按标签</option>
            {groupTags(tags.data ?? []).map((g) => (
              <optgroup key={g.group} label={g.group || '未分组'}>
                {g.tags.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {t.active ? '' : '（已停用）'}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </label>
      </div>
      {!valid ? (
        <Notice tone="error" title="请填写正确的日期，开始日期不能晚于结束日期" />
      ) : usage.error ? (
        <Notice tone="error" title={errorMessage(usage.error)} />
      ) : !d ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label="发放" testId="coupon-usage-issued" sub={d.totals.voided ? `其中作废 ${d.totals.voided} 张` : '这段时间发出的券'}>
              {d.totals.issued} 张
            </Tile>
            <Tile label="领取" testId="coupon-usage-claimed" sub={<>领取率 {rateText(d.totals.claimed, d.totals.issued)}</>}>
              {d.totals.claimed} 张
            </Tile>
            <Tile label="核销" testId="coupon-usage-used" sub={<span data-testid="coupon-usage-rate">核销率 {rateText(d.totals.used, d.totals.issued)}</span>}>
              {d.totals.used} 张
            </Tile>
            <Tile label="核销金额" testId="coupon-usage-amount" sub={d.totals.expired ? `已过期没用 ${d.totals.expired} 张` : '结账时的抵扣'}>
              <Money cents={d.totals.usedAmount} />
            </Tile>
          </div>
          <Segmented<UsageGroup>
            ariaLabel="怎么分"
            className="max-w-full flex-wrap"
            value={group}
            onChange={setGroup}
            options={USAGE_GROUPS.map((g) => ({ value: g, label: <span data-testid={`coupon-usage-group-${g}`}>{USAGE_GROUP_LABELS[g]}</span> }))}
          />
          {rows.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-[13px] text-ink-3" data-testid="coupon-usage-empty">
              {group === 'benefit' && d.totals.issued > 0 ? '这段时间没有会员权益发的券' : '这段时间没有发券'}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full min-w-[760px] text-[13px]" data-testid="coupon-usage-table">
                <thead className="bg-paper-2/70 text-[12px] font-bold text-ink-3">
                  <tr>
                    <th className="px-3 py-2 text-left">{USAGE_GROUP_LABELS[group].slice(1)}</th>
                    <th className="px-3 py-2 text-right">发放</th>
                    <th className="px-3 py-2 text-right">领取</th>
                    <th className="px-3 py-2 text-right">领取率</th>
                    <th className="px-3 py-2 text-right">核销</th>
                    <th className="px-3 py-2 text-right">核销率</th>
                    <th className="px-3 py-2 text-right">核销金额</th>
                    <th className="px-3 py-2 text-right">过期</th>
                    <th className="px-3 py-2 text-right">作废</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/70">
                  {rows.map((r) => (
                    <tr key={r.key} data-testid={`coupon-usage-row-${r.key.replace(':', '-')}`}>
                      <td className="px-3 py-2">
                        <span className="font-semibold text-ink">{r.label}</span>
                        {r.note && <span className="ml-1.5 text-[12px] text-ink-3">{r.note}</span>}
                      </td>
                      <td className="num px-3 py-2 text-right">{r.issued}</td>
                      <td className="num px-3 py-2 text-right">{r.claimed}</td>
                      <td className="px-3 py-2 text-right">
                        <RateMeter part={r.claimed} whole={r.issued} />
                      </td>
                      <td className="num px-3 py-2 text-right">{r.used}</td>
                      <td className="px-3 py-2 text-right">
                        <RateMeter part={r.used} whole={r.issued} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Money cents={r.usedAmount} />
                      </td>
                      <td className="num px-3 py-2 text-right">{r.expired}</td>
                      <td className="num px-3 py-2 text-right">{r.voided}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {d.services.length > 0 && (
            <div data-testid="coupon-usage-services">
              <p className="mb-1.5 text-[13px] font-bold text-ink">服务类权益（这段时间登记使用，作废的不算）</p>
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full min-w-[420px] text-[13px]">
                  <thead className="bg-paper-2/70 text-[12px] font-bold text-ink-3">
                    <tr>
                      <th className="px-3 py-2 text-left">权益</th>
                      <th className="px-3 py-2 text-right">登记次数</th>
                      <th className="px-3 py-2 text-right">会员人数</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/70">
                    {d.services.map((s) => (
                      <tr key={s.benefitId} data-testid={`coupon-usage-service-${s.code}`}>
                        <td className="px-3 py-2">
                          <span className="font-semibold text-ink">{s.name}</span>
                          <span className="ml-1.5 text-[12px] text-ink-3">{s.code}</span>
                        </td>
                        <td className="num px-3 py-2 text-right">{s.uses}</td>
                        <td className="num px-3 py-2 text-right">{s.members}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
      <p className="text-[12px] leading-relaxed text-ink-3">
        按发券的营业日圈一批券、算到今天：发放 = 发出的张数（含后来作废的）；领取 = 到了会员账户的张数，加上无记名券里已经用掉的；核销 = 其中已经用掉的（反结账退回的不算）；
        领取率 = 领取 ÷ 发放，核销率 = 核销 ÷ 发放；核销金额 = 结账时的抵扣；过期 = 到今天没用、有效期已过的。按档级、标签圈时只看发给会员的券（档级按会员现在的档级）。
        「统计」按事情发生的那一天算，两边口径不同。
      </p>
    </Card>
  );
}
