// 经营总览的「部门项目明细」（8.0.15，docs/ORDERS_V8015.md 第 3 节）：部门构成往下拆到每个项目——数量、销售金额、占该部门的比例、
// 优惠、退款、净额。数字与上面的「部门构成」、应收、净营业额是同一份快照、同一个口径；表尾把这几个数对给看的人。

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, CircleAlert, CircleCheck, Download } from 'lucide-react';
import { departmentItemTable, sharePercent, type ExecutiveReport } from '@shared/reports';
import { cn, downloadUrl } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Button, Card, SectionTitle } from '../../components/ui';

const TH = 'py-2 font-semibold whitespace-nowrap';
const NUM = 'num py-1.5 text-right whitespace-nowrap';

/** 0 写成「—」（优惠、退款两栏大多数是 0，写一串 ¥0.00 反而不好找有数的那几行） */
function Amount({ cents, className }: { cents: number; className?: string }) {
  return cents === 0 ? <span className="text-ink-4">—</span> : <Money cents={cents} className={className} />;
}

export function DepartmentItemsCard({ report }: { report: ExecutiveReport }) {
  const table = useMemo(() => departmentItemTable(report.items ?? []), [report.items]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const categories = table.groups.map((g) => g.category);
  const allCollapsed = categories.length > 0 && categories.every((c) => collapsed.has(c));
  const toggle = (category: string) =>
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  const itemCount = table.groups.reduce((n, g) => n + g.items.length, 0);
  // 三方对账：全表销售金额 = 应收，全表净额 = 净营业额。正常一分不差；对不上（自检也会报）时照实写出来
  const amountOk = table.total.amount === report.kpis.receivable;
  const netOk = table.total.net === report.kpis.net;

  return (
    <Card className="p-5" data-testid="overview-items">
      <SectionTitle
        aside={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="text-[12px] text-ink-3">
              {report.from} 至 {report.to} · {table.groups.length} 个部门 {itemCount} 个项目
            </span>
            <Button size="sm" variant="ghost" disabled={categories.length === 0} onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(categories))} data-testid="overview-items-toggle-all">
              {allCollapsed ? '全部展开' : '全部折叠'}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon={<Download className="size-4" />}
              onClick={() => downloadUrl(`/api/reports/executive/items.csv?from=${report.from}&to=${report.to}`)}
              data-testid="overview-items-export"
            >
              导出 CSV
            </Button>
          </div>
        }
      >
        部门项目明细
      </SectionTitle>
      {table.groups.length === 0 ? (
        <p className="mt-3 text-[13px] text-ink-4" data-testid="overview-items-empty">
          这段时间没有结账
        </p>
      ) : (
        <>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[700px] text-[13px]">
              <thead className="border-b border-line text-[12px] text-ink-3">
                <tr>
                  <th className={cn(TH, 'text-left')}>部门</th>
                  <th className={cn(TH, 'text-left')}>项目</th>
                  <th className={cn(TH, 'text-right')}>销售数量</th>
                  <th className={cn(TH, 'text-right')}>销售金额（应收）</th>
                  <th className={cn(TH, 'text-right')}>占该部门金额比</th>
                  <th className={cn(TH, 'text-right')}>优惠</th>
                  <th className={cn(TH, 'text-right')}>退款</th>
                  <th className={cn(TH, 'text-right')}>净额</th>
                </tr>
              </thead>
              {table.groups.map((g) => {
                const open = !collapsed.has(g.category);
                return (
                  <tbody key={g.category} className="border-b border-line/70" data-testid="overview-items-group" data-category={g.category} data-open={open}>
                    <tr className="bg-paper-2/60">
                      <td className="py-1.5 pr-2" colSpan={2}>
                        <button
                          type="button"
                          onClick={() => toggle(g.category)}
                          aria-expanded={open}
                          className="flex w-full items-center gap-1.5 rounded text-left font-bold text-ink hover:text-pine"
                          data-testid="overview-items-toggle"
                        >
                          {open ? <ChevronDown className="size-4 shrink-0 text-ink-3" aria-hidden /> : <ChevronRight className="size-4 shrink-0 text-ink-3" aria-hidden />}
                          <span className="truncate">{g.category}</span>
                          <span className="shrink-0 text-[11.5px] font-semibold text-ink-3">
                            {g.items.length} 个项目{g.share !== null && ` · 占全部 ${sharePercent(g.share)}`}
                          </span>
                        </button>
                      </td>
                      <td className={cn(NUM, 'font-bold')}>{g.quantity}</td>
                      <td className={NUM} data-testid="overview-items-group-amount">
                        <Money cents={g.amount} className="font-bold" />
                      </td>
                      <td className={cn(NUM, 'text-ink-3')}>{g.amount > 0 ? '100.0%' : '—'}</td>
                      <td className={NUM}>
                        <Amount cents={g.discount} />
                      </td>
                      <td className={NUM}>
                        <Amount cents={g.refund} />
                      </td>
                      <td className={NUM}>
                        <Money cents={g.net} className="font-bold" />
                      </td>
                    </tr>
                    {open &&
                      g.items.map((i) => (
                        <tr key={i.name} className="border-t border-line/50" data-testid="overview-items-row">
                          <td className="py-1.5 pl-[22px] pr-2 text-ink-4">{g.category}</td>
                          <td className="py-1.5 pr-2 font-semibold text-ink">{i.name}</td>
                          <td className={NUM}>{i.quantity}</td>
                          <td className={NUM}>
                            <Money cents={i.amount} />
                          </td>
                          <td className={cn(NUM, 'text-ink-2')}>{sharePercent(i.share)}</td>
                          <td className={NUM}>
                            <Amount cents={i.discount} />
                          </td>
                          <td className={NUM}>
                            <Amount cents={i.refund} />
                          </td>
                          <td className={NUM}>
                            <Money cents={i.net} />
                          </td>
                        </tr>
                      ))}
                  </tbody>
                );
              })}
              <tfoot>
                <tr className="border-t-2 border-line font-bold text-ink" data-testid="overview-items-total">
                  <td className="py-2" colSpan={2}>
                    合计
                  </td>
                  <td className={NUM}>{table.total.quantity}</td>
                  <td className={NUM} data-testid="overview-items-total-amount">
                    <Money cents={table.total.amount} className="font-bold" />
                  </td>
                  <td className={NUM} />
                  <td className={NUM}>
                    <Amount cents={table.total.discount} className="font-bold" />
                  </td>
                  <td className={NUM}>
                    <Amount cents={table.total.refund} className="font-bold" />
                  </td>
                  <td className={NUM} data-testid="overview-items-total-net">
                    <Money cents={table.total.net} className="font-bold" />
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className={cn('mt-3 flex items-start gap-1.5 text-[12px]', amountOk && netOk ? 'text-ink-3' : 'font-semibold text-danger')} data-testid="overview-items-recon" data-ok={amountOk && netOk}>
            {amountOk && netOk ? <CircleCheck className="mt-px size-3.5 shrink-0 text-pine" aria-hidden /> : <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />}
            <span>
              销售金额合计 <Money cents={table.total.amount} /> {amountOk ? '=' : '≠'} 应收 <Money cents={report.kpis.receivable} />
              ；净额合计 <Money cents={table.total.net} /> {netOk ? '=' : '≠'} 净营业额 <Money cents={report.kpis.net} />
              {amountOk && netOk
                ? '。口径与日结相同：按营业日，时段内反结账的冲回，退款单按退款的营业日冲减数量与净额；优惠含优惠 / 免单、券抵扣与会员折扣。'
                : '。两边对不上，请到「日结」看自检，或联系店主。'}
            </span>
          </p>
        </>
      )}
    </Card>
  );
}
