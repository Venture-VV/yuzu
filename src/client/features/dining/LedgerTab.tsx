// 餐饮台账与退菜记录（8.0.8，docs/FRONTDESK_V808.md 第 5.2、5.4 节）：
//   · 台账（B06）：按营业日起止（一次最多 92 天）、菜品分类（多选，空为全部）、状态列出每道菜，上方合计（份数、金额只算有效的），
//     「导出」按同样的条件导出 CSV，最后一行合计与页面一致；手牌、桌台、小程序扫码点餐的都在。
//   · 退菜记录（B02）：按营业日列出退的菜、谁退的、怎么批的（小额直接退 / 本人 15 分钟内 / 经理 / 当场授权 + 授权人），可导出。
//   · 8.1.7（docs/DINING_V817.md 第 5 节，CF7）：两页的「分类」都按点单分类（餐厅 / 水吧 / 果吧 与小分类），按它筛；
//     台账原来按价目分类筛（价目分类照旧在导出的「价目分类」一列，接口的 categories 参数照旧能用）。
//   · 8.1.15（docs/DINING_V8115.md 第 3 节，块 B2）：「退菜记录」并进台账——按类型筛（全部 / 正常 / 退菜 / 赠送 / 折扣，地址里的 type），
//     退菜的行写原因、怎么批的（审批人）、责任岗位，汇总写退菜率（份数比，另写金额占比）；导出跟着筛选。旧地址 /dining/voids 跳到这里的「退菜」。

import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { KITCHEN_STATUS_LABELS, MAX_DINING_LEDGER_DAYS, type DiningLedger, type DiningOutlet } from '@shared/dining';
import { LEDGER_KIND_LABELS, LEDGER_KINDS, percentText, VOID_BLAME_LABELS, type LedgerKind } from '@shared/dining-v8115';
import { shiftDate } from '@shared/labels';
import { formatYuan } from '@shared/money';
import { api } from '../../lib/api';
import { useBusinessToday } from '../../lib/revenue';
import { cn, downloadUrl, formatTime } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { Badge, Button, Card, Input, Notice, Segmented, Skeleton } from '../../components/ui';
import { GroupChips, OutletFilter, SlotBadge } from './slots';

/** 类型（8.1.15）：全部 / 正常 / 退菜 / 赠送 / 折扣 */
type Kind = 'all' | LedgerKind;
const KIND_OPTIONS: { value: Kind; label: string }[] = [{ value: 'all', label: '全部' }, ...LEDGER_KINDS.map((k) => ({ value: k, label: LEDGER_KIND_LABELS[k] }))];
const isKind = (v: string | null): v is Kind => v === 'all' || (LEDGER_KINDS as readonly string[]).includes(v ?? '');
const KIND_TONE: Record<LedgerKind, 'pine' | 'clay' | 'yuzu' | 'lake'> = { normal: 'pine', voided: 'clay', gift: 'yuzu', discount: 'lake' };

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const dayCount = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

/** 起止日期：校验不过时返回提示 */
function useRange(today: string) {
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const problem =
    !ISO.test(from) || !ISO.test(to) ? '请选择起止日期' : from > to ? '开始日期不能晚于结束日期' : dayCount(from, to) > MAX_DINING_LEDGER_DAYS ? `一次最多查 ${MAX_DINING_LEDGER_DAYS} 天` : null;
  return { from, to, setFrom, setTo, problem };
}

function RangeInputs({ range, today, quick = true }: { range: ReturnType<typeof useRange>; today: string; quick?: boolean }) {
  const set = (from: string, to: string) => {
    range.setFrom(from);
    range.setTo(to);
  };
  return (
    <span className="flex flex-wrap items-center gap-2 text-[13px]">
      <Input type="date" value={range.from} max={today} onChange={(e) => range.setFrom(e.target.value)} fullWidth={false} className="w-40" aria-label="从" data-testid="dining-range-from" />
      至
      <Input type="date" value={range.to} max={today} onChange={(e) => range.setTo(e.target.value)} fullWidth={false} className="w-40" aria-label="到" data-testid="dining-range-to" />
      {quick && (
        <>
          <Button size="sm" variant="ghost" onClick={() => set(today, today)}>
            今天
          </Button>
          <Button size="sm" variant="ghost" onClick={() => set(shiftDate(today, -1), shiftDate(today, -1))}>
            昨天
          </Button>
          <Button size="sm" variant="ghost" onClick={() => set(shiftDate(today, -6), today)}>
            近 7 天
          </Button>
          <Button size="sm" variant="ghost" onClick={() => set(`${today.slice(0, 7)}-01`, today)}>
            本月
          </Button>
        </>
      )}
    </span>
  );
}

const query = (params: Record<string, string>) => new URLSearchParams(params).toString();

/** 点单分类的筛选（8.1.7）：一处 + 这一处的小分类（多选，空为这一处全部） */
function useSlotFilter() {
  const [outlet, setOutletRaw] = useState<DiningOutlet | null>(null);
  const [groups, setGroups] = useState<string[]>([]);
  const setOutlet = (o: DiningOutlet | null) => {
    setOutletRaw(o);
    setGroups([]);
  };
  const params: Record<string, string> = { ...(outlet ? { outlet } : {}), ...(outlet && groups.length ? { groups: groups.join(',') } : {}) };
  return { outlet, setOutlet, groups, setGroups, params };
}

function SlotFilterBar({ f, testPrefix }: { f: ReturnType<typeof useSlotFilter>; testPrefix: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <OutletFilter value={f.outlet} onChange={f.setOutlet} testPrefix={testPrefix} size="sm" />
      {f.outlet && <GroupChips outlet={f.outlet} value={f.groups} onChange={f.setGroups} multiple testPrefix={testPrefix} allLabel="不限小类" />}
    </div>
  );
}

export function LedgerTab() {
  const today = useBusinessToday();
  const range = useRange(today);
  const [params, setParams] = useSearchParams();
  const typeParam = params.get('type');
  const type: Kind = isKind(typeParam) ? typeParam : 'all';
  const setType = (k: Kind) => {
    const next = new URLSearchParams(params);
    if (k === 'all') next.delete('type');
    else next.set('type', k);
    setParams(next, { replace: true });
  };
  const slot = useSlotFilter();
  const filters = { from: range.from, to: range.to, ...(type === 'all' ? {} : { type }), ...slot.params };
  const q = useQuery({
    queryKey: ['dining', 'ledger', filters],
    queryFn: () => api.get<DiningLedger>(`/api/dining/ledger?${query(filters)}`),
    enabled: !range.problem,
    placeholderData: keepPreviousData,
  });
  const data = q.data;
  const rate = data?.voidRate;

  return (
    <div className="space-y-4 p-5 md:p-7" data-testid="dining-ledger">
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <RangeInputs range={range} today={today} />
          <Button
            size="sm"
            variant="secondary"
            icon={<Download className="size-4" />}
            disabled={!!range.problem}
            onClick={() => downloadUrl(`/api/dining/ledger/export?${query(filters)}`)}
            data-testid="dining-ledger-export"
          >
            导出
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span data-testid="dining-ledger-type">
            <Segmented size="sm" value={type} onChange={setType} options={KIND_OPTIONS} ariaLabel="类型" />
          </span>
          <span className="mx-1 hidden h-5 w-px bg-line sm:block" />
          <SlotFilterBar f={slot} testPrefix="dining-ledger" />
        </div>
        {range.problem && <Notice tone="warning" title={range.problem} />}
      </Card>

      {range.problem ? null : q.isPending ? (
        <Skeleton className="h-40" />
      ) : q.isError && !data ? (
        <LoadFailed title="台账加载失败，请检查网络" onRetry={() => void q.refetch()} retrying={q.isFetching} testId="dining-ledger-error">
          台账没有取回来，不是没有记录。点「重试」再取一次。
        </LoadFailed>
      ) : data ? (
        <>
          <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 px-1 text-[13.5px]" data-testid="dining-ledger-total">
            <span>
              有效 <b className="num text-[16px]">{data.totals.quantity}</b> 份 · <b className="num text-[16px]">{formatYuan(data.totals.amount)}</b>
            </span>
            <span className="text-ink-3">
              共 {data.totals.lines} 条{data.totals.voidedLines > 0 && `，已退 ${data.totals.voidedLines} 条 ${formatYuan(data.totals.voidedAmount)}`}
            </span>
            {rate && (
              <span data-testid="dining-ledger-void-rate">
                退菜率 <b className="num text-[16px] text-clay">{percentText(rate.voidedQuantity, rate.quantity)}</b>
                <span className="text-ink-3">
                  （{rate.voidedQuantity} / {rate.quantity} 份；金额占比 {percentText(rate.voidedAmount, rate.amount)}）
                </span>
              </span>
            )}
            {q.isFetching && <span className="text-[12px] text-ink-4">刷新中…</span>}
          </div>
          {data.rows.length === 0 ? (
            <EmptyState art="search" title="没有符合条件的餐饮明细" description="换个日期、类型或分类再看看。" />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-line bg-card">
              <table className="w-full min-w-max text-[13px]">
                <thead className="bg-paper-2/70 text-[12px] font-bold text-ink-3">
                  <tr>
                    <th className="px-3 py-2 text-left">营业日</th>
                    <th className="px-3 py-2 text-left">时间</th>
                    <th className="px-3 py-2 text-left">手牌 / 桌台</th>
                    <th className="px-3 py-2 text-left">菜名</th>
                    <th className="px-3 py-2 text-left">分类</th>
                    <th className="px-3 py-2 text-right">数量</th>
                    <th className="px-3 py-2 text-right">单价</th>
                    <th className="px-3 py-2 text-right">金额</th>
                    <th className="px-3 py-2 text-left">类型</th>
                    <th className="px-3 py-2 text-left">退菜原因 · 怎么批的 · 责任岗位</th>
                    <th className="px-3 py-2 text-left">出品</th>
                    <th className="px-3 py-2 text-left">点单人</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.rows.map((r) => (
                    <tr key={r.id} className={cn(r.status === 'voided' && 'text-ink-3')} data-testid={`dining-ledger-row-${r.id}`} data-kind={r.kind}>
                      <td className="num px-3 py-2">{r.businessDate.slice(5)}</td>
                      <td className="num px-3 py-2">{formatTime(r.postedAt)}</td>
                      <td className="px-3 py-2">{r.tagCode ? `手牌 ${r.tagCode}` : r.tableName ? `桌台 ${r.tableName}` : '—'}</td>
                      <td className={cn('px-3 py-2 font-semibold', r.status === 'voided' && 'line-through')}>{r.name}</td>
                      <td className="px-3 py-2">
                        <SlotBadge slot={r} />
                      </td>
                      <td className="num px-3 py-2 text-right">{r.quantity}</td>
                      <td className="num px-3 py-2 text-right">{formatYuan(r.unitPrice)}</td>
                      <td className="num px-3 py-2 text-right font-semibold">{formatYuan(r.amount)}</td>
                      <td className="px-3 py-2">
                        <Badge tone={KIND_TONE[r.kind]}>{LEDGER_KIND_LABELS[r.kind]}</Badge>
                      </td>
                      <td className="px-3 py-2">
                        {r.kind === 'voided' ? (
                          <span className="flex max-w-[24em] flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12.5px]">
                            <span className="max-w-[12em] truncate" title={r.voidReason ?? ''}>
                              {r.voidReason ?? '—'}
                            </span>
                            <span>· {r.approvalText ?? '—'}</span>
                            <span className="font-semibold text-ink-2">· {r.blame ? VOID_BLAME_LABELS[r.blame] : '未选责任岗位'}</span>
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-3 py-2">{r.kitchenStatus ? KITCHEN_STATUS_LABELS[r.kitchenStatus] : '—'}</td>
                      <td className="px-3 py-2">{r.postedByName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="px-1 text-[12px] text-ink-3">
            按挂账的营业日；手牌、桌台与小程序扫码点餐点的菜都在。分类按点单分类（餐厅、水吧、果吧，后台「餐饮 → 出品档口与菜品」里设，没设的按默认归）。
            赠送是被签赠券抵掉的菜，折扣是被券或会员折扣抵到的菜（反结账了的不算）；退菜写原因、怎么批的（小额直接退、本人 15 分钟内、经理、当场授权）与责任岗位，
            升级前退的没有记录写「—」。退菜率按日期与分类筛完的全部份数算，不跟着类型变。导出的文件与这里的条件一样，另有一列「价目分类」便于和日结对账。
          </p>
        </>
      ) : null}
    </div>
  );
}
