import { useMemo, useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { ArrowRight, CalendarClock, HandCoins, Inbox, ReceiptText, Scale, ShoppingCart, TriangleAlert } from 'lucide-react';
import { INV_DOC_META, type InvDocType } from '@shared/inventory';
import type { OpeningPayableDoc } from '@shared/purchasing';
import { errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn, relativeTime } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { Badge, Notice, Skeleton } from '../../components/ui';
import { useClaims } from '../expenses/queries';
import { OpeningSheet, PaymentSheet } from '../payables/PayableSheets';
import { PoSheet } from '../purchasing/PoSheet';
import { useOpenings, usePayablesOverview, usePayments, usePos } from '../purchasing/queries';
import { DocSheet } from './DocSheet';
import { DOC_VISUAL, Qty, SimRule } from './parts';
import { useInvDocs, useMaterials, useWarehouses } from './queries';
import { useReconReminders, useStocktakeReminders } from '../cycles/queries';

/** 负责人待办：先处理需要确认的申请，再看需要关注的异常，最后才是经营汇总 */
export function TodoPage() {
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const docId = Number(params.get('doc')) || null;
  const poId = Number(params.get('po')) || null;
  const paymentId = Number(params.get('payment')) || null;
  const [opening, setOpening] = useState<OpeningPayableDoc | null>(null);
  const payableRead = can('payable.read');
  const docs = useInvDocs({ status: 'submitted' });
  const pos = usePos({ status: 'submitted' });
  const payments = usePayments({ status: 'submitted' }, payableRead);
  const openings = useOpenings({ status: 'submitted' }, payableRead);
  const noPo = useInvDocs({ type: 'receipt', status: 'confirmed' });
  // 超过门槛、等负责人确认的费用报销（v0.7.7）：在「费用报销」里确认
  const session = useSession();
  const navigate = useNavigate();
  const claims = useClaims({ status: 'submitted' }, can('expense.approve') && session.erpModules.includes('expenses'));
  const materials = useMaterials();
  const overview = usePayablesOverview(payableRead);
  const low = useMemo(() => (materials.data ?? []).filter((m) => m.isLow), [materials.data]);
  // 没有采购单的收货：迁移 029 以前的直接收货与急采，补单前列在这里
  const missingPo = (noPo.data ?? []).filter((d) => d.noPo && (!d.urgent || d.needsBackfill));
  const warehouses = useWarehouses();
  const centralName = warehouses.data?.find((w) => w.kind === 'central')?.name;
  const credit = (overview.data?.suppliers ?? []).filter((s) => s.balanceCents < 0);
  // 每月盘点与供应商对账提醒（#23，v0.7.13）
  const stocktake = useStocktakeReminders();
  const recon = useReconReminders(payableRead);
  const stocktakeLeft = stocktake.data?.active ? stocktake.data.warehouses.filter((w) => !w.done) : [];
  const reconLeft = recon.data
    ? (recon.data.monthly.active ? recon.data.monthly.items.length : recon.data.monthly.items.filter((i) => i.state === 'changed').length) + recon.data.batch.length
    : 0;

  if (!can('inventory.approve')) return <Navigate to="/inventory" replace />;
  const open = (key: 'doc' | 'po' | 'payment', id: number | null) => setParams(id ? { [key]: String(id) } : {}, { replace: true });
  const total = (docs.data?.length ?? 0) + (pos.data?.length ?? 0) + (payments.data?.length ?? 0) + (openings.data?.length ?? 0) + (claims.data?.claims.length ?? 0);
  const loading = docs.isPending || pos.isPending;

  return (
    <>
      <PageHeader dateMode="calendar" title="待办" subtitle="先处理需要确认的申请，再看需要关注的异常" />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {/* 窄屏一列也要限定列宽（minmax(0,1fr)），不然一行写不下的单号、摘要会把整列撑出屏幕 */}
        <div className="mx-auto grid max-w-[1180px] grid-cols-1 gap-5 px-5 py-5 md:px-7 lg:grid-cols-[minmax(0,1fr)_340px]">
          <section className="space-y-5">
            <div className="flex items-center gap-2">
              <h2 className="text-[15px] font-bold">待确认</h2>
              {!loading && <span className="num rounded-full bg-yuzu px-2 text-[12px] font-bold">{total}</span>}
              <SimRule>审批安排为模拟规则</SimRule>
            </div>
            {docs.error ? (
              <Notice tone="error" title={errorMessage(docs.error)} />
            ) : loading ? (
              <Skeleton className="h-40" />
            ) : total === 0 ? (
              <EmptyState art="calm" title="没有待确认的申请" description="采购单、报损、盘点调整、退货、付款与期初提交后会出现在这里。" className="rounded-lg border border-dashed border-line-strong bg-card" />
            ) : (
              <>
                {(pos.data?.length ?? 0) > 0 && (
                  <Group title="采购单" icon={<ShoppingCart className="size-4" />}>
                    {pos.data!.map((p) => (
                      <TodoRow
                        key={p.id}
                        active={poId === p.id}
                        onClick={() => open('po', p.id)}
                        icon={<ShoppingCart className="size-5" />}
                        tone="bg-pine-soft text-pine"
                        title={
                          <>
                            {p.backfill ? '补单采购单' : p.revision > 1 ? `采购单改版（第 ${p.revision} 版）` : '采购单'}
                            <span className="num ml-2 text-[12.5px] font-normal text-ink-3">{p.docNo}</span>
                          </>
                        }
                        line={`${p.supplierName} · ${p.summary}${p.lineCount > 3 ? ` 等 ${p.lineCount} 项` : ''}`}
                        meta={`${p.createdByName} 编制 · ${relativeTime(p.createdAt)}`}
                        amount={<Money cents={p.totalCents} className="text-[14px] font-bold" />}
                      />
                    ))}
                  </Group>
                )}
                {(docs.data?.length ?? 0) > 0 && (
                  <Group title="库存单据" icon={<Inbox className="size-4" />}>
                    {docs.data!.map((d) => {
                      const v = DOC_VISUAL[d.docType as InvDocType];
                      const Icon = v.icon;
                      return (
                        <TodoRow
                          key={d.id}
                          active={docId === d.id}
                          onClick={() => open('doc', d.id)}
                          icon={<Icon className="size-5" />}
                          tone={v.tone}
                          title={
                            <>
                              {d.urgent ? '急采（待验收）' : INV_DOC_META[d.docType as InvDocType].title}
                              {d.warehouseName && d.docType !== 'issue' && d.docType !== 'issue_return' && d.warehouseName !== centralName && (
                                <span className="ml-1.5 text-[12.5px] font-semibold text-lake">{d.warehouseName}</span>
                              )}
                              <span className="num ml-2 text-[12.5px] font-normal text-ink-3">{d.docNo}</span>
                            </>
                          }
                          line={`${d.partyName ? `${d.partyName} · ` : ''}${d.summary}${d.lineCount > 3 ? ` 等 ${d.lineCount} 项` : ''}`}
                          meta={`${d.createdByName} 提交 · ${relativeTime(d.createdAt)}`}
                          amount={
                            d.docType === 'supplier_return' ? (
                              <Money cents={-d.amountCents} className="text-[14px] font-bold text-clay" />
                            ) : d.urgent ? (
                              <Money cents={d.amountCents} className="text-[14px] font-bold" />
                            ) : undefined
                          }
                        />
                      );
                    })}
                  </Group>
                )}
                {(claims.data?.claims.length ?? 0) > 0 && (
                  <Group title="费用报销（超过确认门槛）" icon={<ReceiptText className="size-4" />}>
                    {claims.data!.claims.map((c) => (
                      <TodoRow
                        key={`c${c.id}`}
                        active={false}
                        onClick={() => navigate(`/erp/expenses?claim=${c.id}`)}
                        icon={<ReceiptText className="size-5" />}
                        tone="bg-lake-soft text-lake"
                        title={
                          <>
                            费用报销
                            <span className="num ml-2 text-[12.5px] font-normal text-ink-3">{c.docNo}</span>
                          </>
                        }
                        line={`${c.department.name} · ${c.handler.name} · ${c.purpose} · ${c.summary}`}
                        meta={`${c.createdByName} 登记 · ${relativeTime(c.createdAt)}`}
                        amount={<Money cents={c.amountCents} className="text-[14px] font-bold" />}
                      />
                    ))}
                  </Group>
                )}
                {((payments.data?.length ?? 0) > 0 || (openings.data?.length ?? 0) > 0) && (
                  <Group title="付款与期初未付" icon={<HandCoins className="size-4" />}>
                    {payments.data?.map((p) => (
                      <TodoRow
                        key={`p${p.id}`}
                        active={paymentId === p.id}
                        onClick={() => open('payment', p.id)}
                        icon={<HandCoins className="size-5" />}
                        tone="bg-lake-soft text-lake"
                        title={
                          <>
                            付款登记<span className="num ml-2 text-[12.5px] font-normal text-ink-3">{p.docNo}</span>
                          </>
                        }
                        line={`${p.supplier.name} · 核销 ${p.allocations.map((a) => a.docNo).join('、')}`}
                        meta={`${p.createdByName} 登记 · ${p.evidence}`}
                        amount={<Money cents={p.amountCents} className="text-[14px] font-bold text-lake" />}
                      />
                    ))}
                    {openings.data?.map((o) => (
                      <TodoRow
                        key={`o${o.id}`}
                        active={opening?.id === o.id}
                        onClick={() => setOpening(o)}
                        icon={<Scale className="size-5" />}
                        tone="bg-paper-3 text-ink-2"
                        title={
                          <>
                            期初未付<span className="num ml-2 text-[12.5px] font-normal text-ink-3">{o.docNo}</span>
                          </>
                        }
                        line={`${o.supplier.name} · 截至 ${o.asOfDate}${o.note ? ` · ${o.note}` : ''}`}
                        meta={`${o.createdByName} 登记`}
                        amount={<Money cents={o.amountCents} className="text-[14px] font-bold" />}
                      />
                    ))}
                  </Group>
                )}
              </>
            )}
          </section>

          <aside className="space-y-4">
            {(stocktakeLeft.length > 0 || reconLeft > 0) && (
              <Card title="盘点与对账" count={stocktakeLeft.length + reconLeft} icon={<CalendarClock className="size-4 text-yuzu-deep" />}>
                <ul className="space-y-1.5 text-[13px]" data-testid="todo-cycles">
                  {stocktakeLeft.length > 0 && (
                    <li>
                      <Link to="/inventory" className="flex items-center gap-2 hover:text-pine">
                        <span className="min-w-0 flex-1 font-semibold">
                          {Number(stocktake.data!.month.slice(5, 7))} 月盘点还有 {stocktakeLeft.length} 个仓没盘完
                        </span>
                        {stocktake.data!.overdue && <Badge tone="clay">已超期</Badge>}
                      </Link>
                    </li>
                  )}
                  {reconLeft > 0 && (
                    <li>
                      <Link to="/payables?view=recon" className="flex items-center gap-2 hover:text-pine">
                        <span className="min-w-0 flex-1 font-semibold">供应商对账待登记 {reconLeft} 项</span>
                        {(recon.data!.monthly.overdue && recon.data!.monthly.items.length > 0) || recon.data!.batch.some((b) => b.overdue) ? <Badge tone="clay">已超期</Badge> : null}
                      </Link>
                    </li>
                  )}
                </ul>
                <p className="mt-2 text-[11.5px] text-ink-3">每月盘点、月结供应商次月初对账、按批次的每批货到后对账（规则在后台「规则总表 → 库存与采购」）。</p>
              </Card>
            )}
            <Card title="低库存提醒" count={low.length} icon={<TriangleAlert className="size-4 text-clay" />}>
              {low.length === 0 ? (
                <p className="text-[12.5px] text-ink-3">没有低于提醒线的物料。</p>
              ) : (
                <ul className="space-y-1.5">
                  {low.slice(0, 8).map((m) => (
                    <li key={m.id}>
                      <Link to={`/inventory?m=${m.id}`} className="flex items-center gap-2 text-[13px] hover:text-pine">
                        <span className="min-w-0 flex-1 truncate font-semibold">{m.name}</span>
                        <Qty milli={m.stockMilli} unit={m.inventoryUnit} className="font-bold text-clay" />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-[11.5px] text-ink-3">提醒线为人工设定的模拟值，不是行业推荐用量。</p>
            </Card>
            <Card title="缺少采购依据的收货" count={missingPo.length} icon={<Inbox className="size-4 text-ember" />}>
              {missingPo.length === 0 ? (
                <p className="text-[12.5px] text-ink-3">所有收货都有采购依据。</p>
              ) : (
                <ul className="space-y-1.5">
                  {missingPo.slice(0, 6).map((d) => (
                    <li key={d.id}>
                      <button type="button" onClick={() => open('doc', d.id)} className="flex w-full items-center gap-2 text-left text-[13px] hover:text-pine">
                        <span className="num font-semibold">{d.docNo}</span>
                        <span className="min-w-0 flex-1 truncate text-ink-3">{d.partyName}</span>
                        <Money cents={d.amountCents} className="font-semibold" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-[11.5px] text-ink-3">
                直接收货已计入库存与货款；补采购单时只关联原收货，不会重复入库。<Badge tone="yuzu" className="ml-1">先收货后补单待确认</Badge>
              </p>
            </Card>
            {payableRead && credit.length > 0 && (
              <Card title="供应商待退 / 可抵" count={credit.length} icon={<HandCoins className="size-4 text-clay" />}>
                <ul className="space-y-1.5">
                  {credit.map((s) => (
                    <li key={s.supplierId}>
                      <Link to={`/payables?view=statement&supplier=${s.supplierId}`} className="flex items-center gap-2 text-[13px] hover:text-pine">
                        <span className="min-w-0 flex-1 truncate font-semibold">{s.name}</span>
                        <Money cents={s.balanceCents} className="font-bold text-clay" />
                      </Link>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[11.5px] text-ink-3">已付货款后又退货形成，需与供应商确认退款或抵扣；系统不假定现金已退回。</p>
              </Card>
            )}
          </aside>
        </div>
      </div>
      <DocSheet id={docId} onClose={() => open('doc', null)} />
      <PoSheet id={poId} onClose={() => open('po', null)} />
      <PaymentSheet id={paymentId} onClose={() => open('payment', null)} />
      <OpeningSheet doc={opening} onClose={() => setOpening(null)} />
    </>
  );
}

function Group({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <div>
      <p className="mb-2 flex items-center gap-1.5 text-[12.5px] font-bold text-ink-3">
        {icon}
        {title}
      </p>
      <ul className="space-y-2">{children}</ul>
    </div>
  );
}

function TodoRow({
  active,
  onClick,
  icon,
  tone,
  title,
  line,
  meta,
  amount,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  tone: string;
  title: ReactNode;
  line: string;
  meta: string;
  amount?: ReactNode;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={cn('flex w-full items-center gap-3 rounded-lg border bg-card px-4 py-3 text-left shadow-card transition-colors hover:border-line-strong', active ? 'border-pine' : 'border-line')}
      >
        <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-full', tone)}>{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-bold">{title}</span>
          <span className="block truncate text-[12.5px] text-ink-2">{line}</span>
          <span className="block truncate text-[11.5px] text-ink-3">{meta}</span>
        </span>
        {amount}
        <ArrowRight className="size-4 shrink-0 text-ink-3" />
      </button>
    </li>
  );
}

function Card({ title, count, icon, children }: { title: string; count: number; icon: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-card p-4 shadow-card">
      <p className="mb-2 flex items-center gap-1.5 text-[13px] font-bold">
        {icon}
        {title} <span className="num text-ink-3">{count}</span>
      </p>
      {children}
    </div>
  );
}
