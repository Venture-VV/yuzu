// 采购台账（按日逐笔，v0.7.9，飞书需求 RQ-005 第三步）：打款、报销的每一行、退回与补付按日期列出，每天小计；
// 平账按打款算的在「备用金与每日平账」里看。导出 CSV（逐笔 + 合计）。

import { useState } from 'react';
import { Link } from 'react-router';
import { BookOpenCheck, Download, ShieldCheck, Wallet } from 'lucide-react';
import { EXPENSE_CATEGORY_LABELS, PAY_SOURCE_LABELS } from '@shared/expenses';
import { LEDGER_KIND_LABELS, type LedgerEntry, type LedgerTotals } from '@shared/purchase-ledger';
import { formatQty } from '@shared/quantity';
import { errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { Badge, Button, Card, Input, Notice, Select, Skeleton } from '../../components/ui';
import { ErpPage } from '../erp/ErpHome';
import { monthRange, useHandlers } from '../expenses/queries';
import { useDepartments } from '../inventory/queries';
import { search, useLedger } from './queries';

const KIND_TONE: Record<LedgerEntry['kind'], 'lake' | 'clay' | 'pine' | 'yuzu'> = { advance: 'lake', expense: 'clay', return: 'pine', topup: 'yuzu' };

function Totals({ t, className }: { t: LedgerTotals; className?: string }) {
  return (
    <p className={cn('flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[12.5px] text-ink-2', className)}>
      <span>
        打款 <Money cents={t.advanceCents} className="font-bold" />
      </span>
      <span>
        支出（备用金） <Money cents={t.pettySpentCents} className="font-bold" />
      </span>
      <span>
        支出（公司直付） <Money cents={t.companySpentCents} className="font-bold" />
      </span>
      <span>
        退回 <Money cents={t.returnedCents} className="font-bold" />
      </span>
      {t.toppedUpCents > 0 && (
        <span>
          补付 <Money cents={t.toppedUpCents} className="font-bold" />
        </span>
      )}
    </p>
  );
}

function entryLink(e: LedgerEntry) {
  if (e.kind === 'expense') return `/erp/expenses?claim=${e.refId}`;
  return e.advanceId ? `/erp/petty?advance=${e.advanceId}` : null;
}

export function PurchaseLedgerPage() {
  const can = useCan();
  const session = useSession();
  const departments = useDepartments();
  const handlers = useHandlers();
  const [range, setRange] = useState(() => monthRange(session.calendarToday));
  const [departmentId, setDepartmentId] = useState('');
  const [handlerId, setHandlerId] = useState('');
  const filters = { from: range.from, to: range.to, departmentId: departmentId || undefined, handlerId: handlerId || undefined };
  const ledger = useLedger(filters, range.from <= range.to);
  const d = ledger.data;

  return (
    <ErpPage
      title="采购台账"
      description="按日期逐笔：打款、报销的每一行（已确认的）、退回与补付，每天小计。按打款平账在「备用金与每日平账」里看，账目问题在「账目自检」里看。"
      actions={
        <div className="flex flex-wrap gap-2">
          <Link to="/erp/petty">
            <Button variant="secondary" icon={<Wallet className="size-4" />}>
              每日平账
            </Button>
          </Link>
          <Link to="/erp/audit">
            <Button variant="secondary" icon={<ShieldCheck className="size-4" />}>
              账目自检
            </Button>
          </Link>
          {can('expense.export') && (
            <a href={`/api/erp/ledger/export?${search(filters)}`} download data-testid="ledger-export">
              <Button variant="secondary" icon={<Download className="size-4" />}>
                导出台账
              </Button>
            </a>
          )}
          {/* 需求单也在这里导出：对账付款、成本核算、负责人能导出需求单，但进不了需求单页（只给提单与审核的人） */}
          {can('expense.export') && session.erpModules.includes('requests') && (
            <a
              href={`/api/erp/requests/export?${search({ from: range.from, to: range.to, departmentId: departmentId || undefined })}`}
              download
              title="按提交日期，日期范围与部门同上"
              data-testid="ledger-requests-export"
            >
              <Button variant="secondary" icon={<Download className="size-4" />}>
                导出需求单
              </Button>
            </a>
          )}
        </div>
      }
    >
      <div className="space-y-4" data-testid="ledger-page">
        <Card className="flex flex-wrap items-end gap-3 p-4">
          <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-3">
            日期 从
            <Input type="date" fullWidth={false} value={range.from} max={range.to} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} className="h-9 w-40" />
          </label>
          <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-3">
            到
            <Input type="date" fullWidth={false} value={range.to} max={session.calendarToday} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} className="h-9 w-40" />
          </label>
          <Select fullWidth={false} aria-label="部门" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} className="h-9 w-36">
            <option value="">全部部门</option>
            {departments.data?.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
          <Select fullWidth={false} aria-label="经办人" value={handlerId} onChange={(e) => setHandlerId(e.target.value)} className="h-9 w-36">
            <option value="">全部经办人</option>
            {handlers.data?.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </Select>
          {d && <Totals t={d.totals} className="ml-auto" />}
        </Card>
        {d?.truncated && <Notice tone="info" title="笔数太多，只显示最近的一部分；合计按全部算，要看全部请缩短日期范围或导出" />}

        {ledger.isPending ? (
          <Skeleton className="h-64" />
        ) : ledger.error ? (
          <Notice tone="error" title={errorMessage(ledger.error)} />
        ) : d!.days.length === 0 ? (
          <EmptyState art="calm" title="这段时间没有打款、报销与退回" />
        ) : (
          <div className="space-y-3">
            {d!.days.map((day) => (
              <Card key={day.date} className="overflow-hidden" data-testid={`ledger-day-${day.date}`}>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-paper-2/60 px-4 py-2.5">
                  <span className="flex items-center gap-1.5 text-[14px] font-bold">
                    <BookOpenCheck className="size-4 text-ink-3" />
                    {day.date}
                  </span>
                  <Totals t={day.totals} />
                </div>
                <ul className="divide-y divide-line/70">
                  {day.entries.map((e, i) => {
                    const to = entryLink(e);
                    const body = (
                      <span className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 py-2 text-left md:grid-cols-[64px_150px_minmax(0,1fr)_120px_auto]">
                        <Badge tone={KIND_TONE[e.kind]}>{LEDGER_KIND_LABELS[e.kind]}</Badge>
                        <span className="num hidden text-[12.5px] font-semibold md:block">{e.docNo}</span>
                        <span className="min-w-0">
                          <span className="block truncate text-[13.5px] font-semibold">
                            {e.description || '—'}
                            {e.qty && (
                              <span className="num ml-2 text-[12px] font-normal text-ink-3">
                                {formatQty(e.qty.boughtMilli)} {e.qty.unit}
                                {e.qty.receivedMilli !== e.qty.boughtMilli && ` · 到货 ${formatQty(e.qty.receivedMilli)}`}
                              </span>
                            )}
                          </span>
                          <span className="block truncate text-[12px] text-ink-3">
                            <span className="num md:hidden">{e.docNo} · </span>
                            {e.department.name} · {e.handler.name}
                            {e.category && ` · ${EXPENSE_CATEGORY_LABELS[e.category]}`}
                            {e.paySource && ` · ${PAY_SOURCE_LABELS[e.paySource]}`}
                            {e.advanceNo && e.kind !== 'advance' && ` · 打款 ${e.advanceNo}`}
                            {e.poNo && ` · 采购单 ${e.poNo}`}
                          </span>
                        </span>
                        <span className="hidden text-[12px] text-ink-3 md:block">{e.kind === 'expense' ? (e.paySource === 'petty' ? '备用金支出' : '公司直付') : ''}</span>
                        <Money cents={e.amountCents} className={cn('text-right font-bold', e.kind === 'expense' && 'text-clay', e.kind === 'advance' && 'text-lake')} />
                      </span>
                    );
                    return (
                      <li key={`${e.kind}-${e.refId}-${i}`}>
                        {to ? (
                          <Link to={to} className="block hover:bg-paper-2">
                            {body}
                          </Link>
                        ) : (
                          body
                        )}
                      </li>
                    );
                  })}
                </ul>
              </Card>
            ))}
          </div>
        )}
      </div>
    </ErpPage>
  );
}
