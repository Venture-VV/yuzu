// 餐饮台账与退菜记录（8.0.8，docs/FRONTDESK_V808.md 第 5.2、5.4 节）：
//   · 台账（B06）：按营业日起止（一次最多 92 天）、菜品分类（多选，空为全部）、状态列出每道菜，上方合计（份数、金额只算有效的），
//     「导出」按同样的条件导出 CSV，最后一行合计与页面一致；手牌、桌台、小程序扫码点餐的都在。
//   · 退菜记录（B02）：按营业日列出退的菜、谁退的、怎么批的（小额直接退 / 本人 15 分钟内 / 经理 / 当场授权 + 授权人），可导出。

import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { KITCHEN_STATUS_LABELS, MAX_DINING_LEDGER_DAYS, type DiningLedger, type DishVoidRow } from '@shared/dining';
import { shiftDate } from '@shared/labels';
import { formatYuan } from '@shared/money';
import { api } from '../../lib/api';
import { useBusinessToday } from '../../lib/revenue';
import { cn, downloadUrl, formatDateTime, formatTime } from '../../lib/utils';
import { Badge, Button, Card, Input, Notice, Segmented, Skeleton } from '../../components/ui';

type Status = 'all' | 'active' | 'voided';
const STATUS_OPTIONS: { value: Status; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'active', label: '有效' },
  { value: 'voided', label: '已退' },
];

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const dayCount = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

/** 起止日期：校验不过时返回提示 */
function useRange(today: string) {
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const problem = !ISO.test(from) || !ISO.test(to)
    ? '请选择起止日期'
    : from > to
      ? '开始日期不能晚于结束日期'
      : dayCount(from, to) > MAX_DINING_LEDGER_DAYS
        ? `一次最多查 ${MAX_DINING_LEDGER_DAYS} 天`
        : null;
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

export function LedgerTab() {
  const today = useBusinessToday();
  const range = useRange(today);
  const [status, setStatus] = useState<Status>('all');
  const [categories, setCategories] = useState<string[]>([]);
  const params = { from: range.from, to: range.to, status, ...(categories.length ? { categories: categories.join(',') } : {}) };
  const q = useQuery({
    queryKey: ['dining', 'ledger', params],
    queryFn: () => api.get<DiningLedger>(`/api/dining/ledger?${query(params)}`),
    enabled: !range.problem,
    placeholderData: keepPreviousData,
  });
  const data = q.data;
  // 选着的分类即使换了日期以后这段时间里没有也留着：看得出为什么筛出来是空的，也能点掉
  const shown = data ? [...new Set([...data.categories, ...categories])] : categories;
  const toggle = (c: string) => setCategories((cur) => (cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]));

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
            onClick={() => downloadUrl(`/api/dining/ledger/export?${query(params)}`)}
            data-testid="dining-ledger-export"
          >
            导出
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented size="sm" value={status} onChange={setStatus} options={STATUS_OPTIONS} ariaLabel="状态" />
          <span className="mx-1 h-5 w-px bg-line" />
          <button
            type="button"
            onClick={() => setCategories([])}
            className={cn('h-7 rounded-full border px-3 text-[12.5px] font-semibold', categories.length === 0 ? 'border-pine bg-pine-soft text-pine' : 'border-line text-ink-3 hover:text-ink')}
            data-testid="dining-ledger-cat-all"
          >
            全部分类
          </button>
          {shown.map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={categories.includes(c)}
              onClick={() => toggle(c)}
              className={cn('h-7 rounded-full border px-3 text-[12.5px] font-semibold', categories.includes(c) ? 'border-pine bg-pine-soft text-pine' : 'border-line text-ink-3 hover:text-ink')}
              data-testid={`dining-ledger-cat-${c}`}
            >
              {c}
            </button>
          ))}
        </div>
        {range.problem && <Notice tone="warning" title={range.problem} />}
      </Card>

      {!range.problem && !data ? (
        <Skeleton className="h-40" />
      ) : data ? (
        <>
          <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 px-1 text-[13.5px]" data-testid="dining-ledger-total">
            <span>
              有效 <b className="num">{data.totals.quantity}</b> 份 · <b className="num">{formatYuan(data.totals.amount)}</b>
            </span>
            <span className="text-ink-3">
              共 {data.totals.lines} 条{data.totals.voidedLines > 0 && `，已退 ${data.totals.voidedLines} 条 ${formatYuan(data.totals.voidedAmount)}`}
            </span>
            {q.isFetching && <span className="text-[12px] text-ink-4">刷新中…</span>}
          </div>
          {data.rows.length === 0 ? (
            <p className="px-1 text-[13px] text-ink-3">这段时间没有符合条件的餐饮明细。</p>
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
                    <th className="px-3 py-2 text-left">状态</th>
                    <th className="px-3 py-2 text-left">出品</th>
                    <th className="px-3 py-2 text-left">点单人</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.rows.map((r) => (
                    <tr key={r.id} className={cn(r.status === 'voided' && 'text-ink-3')} data-testid={`dining-ledger-row-${r.id}`}>
                      <td className="num px-3 py-2">{r.businessDate.slice(5)}</td>
                      <td className="num px-3 py-2">{formatTime(r.postedAt)}</td>
                      <td className="px-3 py-2">{r.tagCode ? `手牌 ${r.tagCode}` : r.tableName ? `桌台 ${r.tableName}` : '—'}</td>
                      <td className={cn('px-3 py-2 font-semibold', r.status === 'voided' && 'line-through')}>{r.name}</td>
                      <td className="px-3 py-2">{r.category}</td>
                      <td className="num px-3 py-2 text-right">{r.quantity}</td>
                      <td className="num px-3 py-2 text-right">{formatYuan(r.unitPrice)}</td>
                      <td className="num px-3 py-2 text-right font-semibold">{formatYuan(r.amount)}</td>
                      <td className="px-3 py-2">
                        {r.status === 'active' ? (
                          <Badge tone="pine">有效</Badge>
                        ) : (
                          <span className="inline-flex items-center gap-1.5">
                            <Badge tone="clay">已退</Badge>
                            {r.voidReason && <span className="max-w-[16em] truncate text-[12px]" title={r.voidReason}>{r.voidReason}</span>}
                          </span>
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
          <p className="px-1 text-[12px] text-ink-3">按挂账的营业日；手牌、桌台与小程序扫码点餐点的菜都在。分类按价目表，没写分类的记「未分类」。导出的文件与这里的条件、合计一样。</p>
        </>
      ) : null}
    </div>
  );
}

export function VoidsTab() {
  const today = useBusinessToday();
  const range = useRange(today);
  const params = { from: range.from, to: range.to };
  const q = useQuery({
    queryKey: ['dining', 'voids', params],
    queryFn: () => api.get<DishVoidRow[]>(`/api/dining/voids?${query(params)}`),
    enabled: !range.problem,
    placeholderData: keepPreviousData,
  });
  const rows = q.data ?? [];
  const total = rows.reduce((n, r) => n + r.amount, 0);
  return (
    <div className="space-y-4 p-5 md:p-7" data-testid="dining-voids">
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <RangeInputs range={range} today={today} />
          <Button
            size="sm"
            variant="secondary"
            icon={<Download className="size-4" />}
            disabled={!!range.problem}
            onClick={() => downloadUrl(`/api/dining/voids/export?${query(params)}`)}
            data-testid="dining-voids-export"
          >
            导出
          </Button>
        </div>
        {range.problem && <Notice tone="warning" title={range.problem} />}
      </Card>
      {!range.problem && !q.data ? (
        <Skeleton className="h-32" />
      ) : q.data ? (
        <>
          <p className="px-1 text-[13.5px]" data-testid="dining-voids-total">
            退了 <b className="num">{rows.length}</b> 条 · <b className="num">{formatYuan(total)}</b>
          </p>
          {rows.length === 0 ? (
            <p className="px-1 text-[13px] text-ink-3">这段时间没有退菜。</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-line bg-card">
              <table className="w-full min-w-max text-[13px]">
                <thead className="bg-paper-2/70 text-[12px] font-bold text-ink-3">
                  <tr>
                    <th className="px-3 py-2 text-left">退菜时间</th>
                    <th className="px-3 py-2 text-left">手牌 / 桌台</th>
                    <th className="px-3 py-2 text-left">菜名</th>
                    <th className="px-3 py-2 text-right">数量</th>
                    <th className="px-3 py-2 text-right">金额</th>
                    <th className="px-3 py-2 text-left">原因</th>
                    <th className="px-3 py-2 text-left">谁退的</th>
                    <th className="px-3 py-2 text-left">怎么批的</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows.map((r) => (
                    <tr key={r.id} data-testid={`dining-void-row-${r.id}`}>
                      <td className="num px-3 py-2">{formatDateTime(r.voidedAt)}</td>
                      <td className="px-3 py-2">{r.tagCode ? `手牌 ${r.tagCode}` : r.tableName ? `桌台 ${r.tableName}` : '—'}</td>
                      <td className="px-3 py-2 font-semibold">{r.name}</td>
                      <td className="num px-3 py-2 text-right">{r.quantity}</td>
                      <td className="num px-3 py-2 text-right font-semibold">{formatYuan(r.amount)}</td>
                      <td className="max-w-[18em] truncate px-3 py-2" title={r.voidReason ?? ''}>
                        {r.voidReason ?? '—'}
                      </td>
                      <td className="px-3 py-2">
                        {r.voidedByName}
                        {r.postedByName !== r.voidedByName && <span className="text-[12px] text-ink-3">（{r.postedByName} 点的）</span>}
                      </td>
                      <td className="px-3 py-2">
                        <Badge tone={r.approvalText.startsWith('当场授权') ? 'yuzu' : r.approvalText.startsWith('小额') ? 'neutral' : 'lake'}>{r.approvalText}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="px-1 text-[12px] text-ink-3">按退菜的时间落在哪个营业日。「怎么批的」：小额直接退、本人 15 分钟内、经理（有更正权限的自己退）、当场授权（括号里是授权人）；升级到 8.0.8 以前退的记「—」。</p>
        </>
      ) : null}
    </div>
  );
}
