// 停车登记（v0.7.28，QY-016，N10）。8.0.19（IA4）起显示在门店「会员工作台 → 停车登记」（/parking-log），
// 原来在后台「会员权益」最下面；接口与权限没变（能登记权益使用的、维护会员权益的都能看）。

import { useState } from 'react';
import { Link, Navigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Download } from 'lucide-react';
import type { ParkingUseRow } from '@shared/benefits';
import { api, errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn, downloadUrl, formatDateTime } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { Badge, Button, Card, Field, Input, Notice, SectionTitle } from '../../components/ui';

export function ParkingLogPage() {
  const can = useCan();
  if (!can('benefit.use') && !can('benefit.publish')) return <Navigate to="/" replace />;
  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <Link to="/" className="-ml-1 flex size-8 items-center justify-center rounded-md text-ink-3 hover:bg-paper-2 hover:text-ink" aria-label="返回会员工作台">
              <ArrowLeft className="size-[18px]" />
            </Link>
            停车登记
          </span>
        }
        subtitle="登记在会员详情「本月可享」的停车优惠那一行；这里按日期看登记过的、导出给停车场对账"
      />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[980px] px-5 py-5 md:px-7" data-testid="parking-log-page">
          <ParkingLogCard />
        </div>
      </div>
    </>
  );
}

/**
 * 停车登记（v0.7.28，QY-016，N10）：一段营业日里前台登记的停车优惠（车牌、免费几小时、会员、经办），导出给停车场对账。
 * 系统不收停车费，只登记
 */
export function ParkingLogCard({ className }: { className?: string }) {
  const today = useSession().today;
  // 默认看今天（前台每天对一次）；要看整月的自己改日期
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;
  const q = useQuery({
    queryKey: ['benefits', 'parking', from, to],
    queryFn: () => api.get<ParkingUseRow[]>(`/api/benefits/parking?from=${from}&to=${to}`),
    enabled: valid,
  });
  const rows = q.data ?? [];
  const active = rows.filter((r) => r.status === 'active');
  return (
    <Card className={cn('p-5', className)} data-testid="benefit-parking-log">
      <SectionTitle
        aside={
          <Button size="sm" variant="secondary" icon={<Download className="size-3.5" />} disabled={!valid} onClick={() => downloadUrl(`/api/benefits/parking/export?from=${from}&to=${to}`)}>
            导出给停车场
          </Button>
        }
      >
        停车登记
      </SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">前台登记的停车优惠（车牌、免费几小时）；系统不收停车费，只登记、给停车场对账。作废的列出来但不算。</p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <Field label="从" htmlFor="parking-from">
          <Input id="parking-from" type="date" fullWidth={false} value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="到" htmlFor="parking-to">
          <Input id="parking-to" type="date" fullWidth={false} value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <span className="pb-2 text-[13px] text-ink-2" data-testid="benefit-parking-total">
          {active.length} 次 · 共免 {active.reduce((sum, r) => sum + r.hours, 0)} 小时
        </span>
      </div>
      {q.error ? (
        <Notice tone="error" title={errorMessage(q.error)} className="mt-3" />
      ) : rows.length === 0 ? (
        <p className="mt-3 text-[13px] text-ink-3">这段时间没有停车登记。</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[640px] text-[13px]">
            <thead className="text-left text-[12px] text-ink-3">
              <tr>
                <th className="py-1.5 pr-3">时间</th>
                <th className="py-1.5 pr-3">车牌</th>
                <th className="py-1.5 pr-3">免费</th>
                <th className="py-1.5 pr-3">会员</th>
                <th className="py-1.5 pr-3">经办</th>
                <th className="py-1.5">状态</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/70">
              {rows.map((r) => (
                <tr key={r.id} data-testid={`parking-row-${r.plate}`}>
                  <td className="num py-1.5 pr-3 whitespace-nowrap">{formatDateTime(r.createdAt)}</td>
                  <td className="py-1.5 pr-3 font-semibold">{r.plate}</td>
                  <td className="num py-1.5 pr-3">{r.hours} 小时</td>
                  <td className="py-1.5 pr-3">
                    {r.memberName} <span className="text-ink-4">{r.memberNo}</span>
                  </td>
                  <td className="py-1.5 pr-3">{r.staffName}</td>
                  <td className="py-1.5">{r.status === 'voided' ? <Badge tone="clay">已作废：{r.voidReason}</Badge> : '有效'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
