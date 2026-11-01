import { useState, type ReactNode } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { Download, FileUp, Plus, Wallet } from 'lucide-react';
import { shiftDate } from '@shared/labels';
import { PAY_METHOD_LABELS, type OpeningPayableDoc, type Statement } from '@shared/purchasing';
import { errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn, downloadUrl } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { Badge, Button, Input, Notice, Segmented, Select, Skeleton } from '../../components/ui';
import { useSuppliers } from '../inventory/queries';
import { PayableStatusChip } from '../purchasing/parts';
import { useOffsets, useOpenings, usePayablesOverview, usePayments, useRefunds, useStatement } from '../purchasing/queries';
import { OpeningDialog, OpeningSheet, PaymentSheet } from './PayableSheets';
import { CreditsSection, OffsetSheet, RefundSheet } from './SettlementSheets';

type View = 'suppliers' | 'statement' | 'payments' | 'openings' | 'settlements';

export function PayablesPage() {
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const view = (params.get('view') as View) ?? 'suppliers';
  const [openingDialog, setOpeningDialog] = useState(false);
  const paymentId = Number(params.get('payment')) || null;
  const [opening, setOpening] = useState<OpeningPayableDoc | null>(null);
  if (!can('payable.read')) return <Navigate to="/" replace />;

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader
        dateMode="calendar"
        title="货款"
        subtitle="供应商余额 = 期初未付 + 收货货款 − 退货扣款 − 净付款 + 供应商退款 = 未付 − 可抵扣（门店内部管理口径）"
        actions={
          (can('payable.manage') || can('inventory.master')) && (
            <div className="flex gap-2">
              <Link to="/payables/import" className="flex h-8 items-center gap-1.5 rounded-sm border border-line-strong bg-card px-3 text-[13px] font-semibold hover:border-ink-3">
                <FileUp className="size-4" />
                导入
              </Link>
              {can('payable.manage') && (
                <>
                  <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setOpeningDialog(true)}>
                    期初未付
                  </Button>
                  <Link to="/payables/pay" className="flex h-8 items-center gap-1.5 rounded-sm bg-pine px-3 text-[13px] font-bold text-paper hover:bg-pine-hover">
                    <Wallet className="size-4" />
                    登记付款
                  </Link>
                </>
              )}
            </div>
          )
        }
      />
      {/* 手机上五个视图放不下：这一行横向滑动（v0.7.12 加了「核销与退款」） */}
      <div className="scroll-thin flex shrink-0 items-center gap-3 overflow-x-auto border-b border-line px-5 py-3 md:px-7">
        <Segmented<View>
          size="sm"
          value={view}
          onChange={(v) => update({ view: v === 'suppliers' ? null : v })}
          ariaLabel="视图"
          options={[
            { value: 'suppliers', label: '供应商余额' },
            { value: 'statement', label: '对账单' },
            { value: 'payments', label: '付款记录' },
            { value: 'openings', label: '期初未付' },
            { value: 'settlements', label: '核销与退款' },
          ]}
        />
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4 md:px-7">
        {view === 'suppliers' && <SuppliersView onStatement={(id) => update({ view: 'statement', supplier: String(id) })} />}
        {view === 'statement' && <StatementView supplierId={Number(params.get('supplier')) || null} onSupplier={(id) => update({ supplier: id ? String(id) : null })} onPayment={(id) => update({ payment: String(id) })} onOpening={setOpening} />}
        {view === 'payments' && <PaymentsView onOpen={(id) => update({ payment: String(id) })} />}
        {view === 'openings' && <OpeningsView onOpen={setOpening} />}
        {view === 'settlements' && <SettlementsView />}
      </div>
      <PaymentSheet id={paymentId} onClose={() => update({ payment: null })} />
      <OpeningSheet doc={opening} onClose={() => setOpening(null)} />
      <OpeningDialog open={openingDialog} onClose={() => setOpeningDialog(false)} />
    </>
  );
}

function Tile({ label, cents, tone = 'ink', sign }: { label: string; cents: number; tone?: 'ink' | 'pine' | 'lake' | 'clay'; sign?: string }) {
  const color = { ink: 'text-ink', pine: 'text-pine', lake: 'text-lake', clay: 'text-clay' }[tone];
  return (
    <div className="rounded-lg border border-line bg-card px-4 py-2.5 shadow-card">
      <p className="text-[12px] font-semibold text-ink-3">
        {sign && <span className="mr-1 text-ink-4">{sign}</span>}
        {label}
      </p>
      <Money cents={cents} className={cn('text-[20px] leading-tight font-bold', color)} />
    </div>
  );
}

function SuppliersView({ onStatement }: { onStatement: (id: number) => void }) {
  const overview = usePayablesOverview();
  const can = useCan();
  if (overview.error) return <Notice tone="error" title={errorMessage(overview.error)} />;
  if (!overview.data) return <Skeleton className="h-64" />;
  const { totals, suppliers, pending } = overview.data;
  const active = suppliers.filter((s) => s.balanceCents !== 0 || s.receivedCents !== 0 || s.openingCents !== 0 || s.creditCents !== 0 || s.paidCents !== 0);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4 xl:grid-cols-7">
        <Tile label="期初未付" cents={totals.openingCents} />
        <Tile label="收货货款" cents={totals.receivedCents} tone="pine" sign="+" />
        <Tile label="退货扣款" cents={totals.returnCreditCents} tone="clay" sign="−" />
        <Tile label="已付款" cents={totals.paidCents} tone="lake" sign="−" />
        <Tile label="供应商退款" cents={totals.refundedCents} sign="+" />
        <Tile label="当前余额" cents={totals.balanceCents} sign="=" />
        <Tile label="其中可抵扣" cents={totals.creditCents} tone="clay" />
      </div>
      {(pending.payments > 0 || pending.openings > 0) && (
        <Notice tone="warning" title={`${pending.payments} 笔付款、${pending.openings} 笔期初未付待负责人确认`}>
          待确认的付款不计入已付款，但会占用对应货款的未结清金额，防止重复核销。
        </Notice>
      )}
      {active.length === 0 ? (
        <EmptyState art="calm" title="还没有供应商货款" description="收货生效后，货款会按供应商自动汇总在这里。" className="rounded-lg border border-dashed border-line-strong" />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-card shadow-card">
          <table className="w-full min-w-[1020px] text-left text-[13px]">
            <thead className="bg-paper-2/70 text-[12px] font-bold text-ink-3">
              <tr>
                <th className="px-4 py-2.5">供应商</th>
                <th className="px-2 py-2.5 text-right">期初未付</th>
                <th className="px-2 py-2.5 text-right">+ 收货货款</th>
                <th className="px-2 py-2.5 text-right">− 退货扣款</th>
                <th className="px-2 py-2.5 text-right">− 已付款</th>
                <th className="px-2 py-2.5 text-right">+ 供应商退款</th>
                <th className="bg-paper-3/50 px-2 py-2.5 text-right text-ink-2">= 余额</th>
                <th className="px-2 py-2.5 text-right">可抵扣</th>
                <th className="px-2 py-2.5 text-right">待确认付款</th>
                <th className="w-[170px] px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line/70">
              {active.map((s) => (
                <tr key={s.supplierId} className="hover:bg-pine-tint/40">
                  <td className="px-4 py-2.5">
                    <p className="font-bold">{s.name}</p>
                    <p className="num text-[11.5px] text-ink-3">
                      {s.code}
                      {s.openItemCount > 0 && ` · ${s.openItemCount} 笔未结清`}
                    </p>
                  </td>
                  <td className="num px-2 py-2.5 text-right">{s.openingCents ? <Money cents={s.openingCents} /> : <span className="text-ink-4">·</span>}</td>
                  <td className="num px-2 py-2.5 text-right">
                    <Money cents={s.receivedCents} className="text-pine" />
                  </td>
                  <td className="num px-2 py-2.5 text-right">{s.returnCreditCents ? <Money cents={s.returnCreditCents} className="text-clay" /> : <span className="text-ink-4">·</span>}</td>
                  <td className="num px-2 py-2.5 text-right">{s.paidCents ? <Money cents={s.paidCents} className="text-lake" /> : <span className="text-ink-4">·</span>}</td>
                  <td className="num px-2 py-2.5 text-right">{s.refundedCents ? <Money cents={s.refundedCents} /> : <span className="text-ink-4">·</span>}</td>
                  <td className="bg-paper-2/50 px-2 py-2.5 text-right">
                    <Money cents={s.balanceCents} className={cn('text-[15px] font-bold', s.balanceCents < 0 && 'text-clay')} />
                    {s.balanceCents < 0 && <span className="block text-[11px] font-semibold text-clay">供应商欠我们（预付 / 退货余额）</span>}
                  </td>
                  <td className="num px-2 py-2.5 text-right">{s.creditCents ? <Money cents={s.creditCents} className="text-ember" /> : <span className="text-ink-4">·</span>}</td>
                  <td className="num px-2 py-2.5 text-right text-yuzu-deep">{s.pendingPaymentCents ? <Money cents={s.pendingPaymentCents} /> : <span className="text-ink-4">·</span>}</td>
                  <td className="px-4 py-2.5 text-right">
                    <span className="flex justify-end gap-1.5">
                      <Button size="sm" variant="ghost" onClick={() => onStatement(s.supplierId)}>
                        对账单
                      </Button>
                      {can('payable.manage') && s.balanceCents > 0 && (
                        <Link to={`/payables/pay?supplier=${s.supplierId}`} className="flex h-8 items-center rounded-sm border border-line-strong bg-card px-3 text-[13px] font-semibold whitespace-nowrap hover:border-ink-3">
                          付款
                        </Link>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatementView({
  supplierId,
  onSupplier,
  onPayment,
  onOpening,
}: {
  supplierId: number | null;
  onSupplier: (id: number | null) => void;
  onPayment: (id: number) => void;
  onOpening: (doc: OpeningPayableDoc) => void;
}) {
  const session = useSession();
  const can = useCan();
  const today = session.calendarToday;
  const suppliers = useSuppliers(true);
  const [range, setRange] = useState({ from: `${today.slice(0, 8)}01`, to: today });
  const st = useStatement(supplierId, range.from, range.to);
  const openings = useOpenings({ supplierId: supplierId ? String(supplierId) : undefined }, !!supplierId);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select fullWidth={false} value={supplierId ?? ''} onChange={(e) => onSupplier(Number(e.target.value) || null)} className="h-9 min-w-[200px] text-[13px]" aria-label="供应商">
          <option value="">选择供应商</option>
          {suppliers.data?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.code} · {s.name}
            </option>
          ))}
        </Select>
        <span className="flex items-center gap-1.5 text-[13px] text-ink-3">
          <Input fullWidth={false} type="date" value={range.from} max={range.to} onChange={(e) => setRange({ ...range, from: e.target.value })} className="h-9 w-[150px] text-[13px]" aria-label="开始日期" />
          至
          <Input fullWidth={false} type="date" value={range.to} max={today} onChange={(e) => setRange({ ...range, to: e.target.value })} className="h-9 w-[150px] text-[13px]" aria-label="结束日期" />
        </span>
        <Button size="sm" variant="ghost" onClick={() => setRange({ from: shiftDate(today, -29), to: today })}>
          近 30 天
        </Button>
        <span className="flex-1" />
        {supplierId && can('inventory.export') && (
          <Button size="sm" variant="secondary" icon={<Download className="size-4" />} onClick={() => downloadUrl(`/api/payables/statement/export?supplierId=${supplierId}&from=${range.from}&to=${range.to}`)}>
            导出对账单
          </Button>
        )}
      </div>
      {!supplierId ? (
        <EmptyState art="search" title="选择一家供应商查看对账单" description="可以拿着供应商的单据逐笔核对：每一行都能打开原单。" className="rounded-lg border border-dashed border-line-strong" />
      ) : st.error ? (
        <Notice tone="error" title={errorMessage(st.error)} />
      ) : !st.data ? (
        <Skeleton className="h-64" />
      ) : (
        <StatementBody st={st.data} onPayment={onPayment} onOpening={(id) => {
          const doc = openings.data?.find((o) => o.id === id);
          if (doc) onOpening(doc);
        }} />
      )}
      {supplierId && st.data && <CreditsSection supplierId={supplierId} />}
    </div>
  );
}

const KIND_LABEL = { opening: '期初未付', receipt: '收货货款', supplier_return: '退货扣款', payment: '付款', refund: '供应商退款' } as const;

function StatementBody({ st, onPayment, onOpening }: { st: Statement; onPayment: (id: number) => void; onOpening: (id: number) => void }) {
  const [refundId, setRefundId] = useState<number | null>(null);
  return (
    <>
      <div className="flex flex-wrap items-stretch gap-2 rounded-lg border border-line bg-card p-3 shadow-card">
        <Formula label="上期结余" cents={st.beginCents} />
        <Op>+</Op>
        <Formula label="期初未付" cents={st.openingCents} />
        <Op>+</Op>
        <Formula label="收货货款" cents={st.receivedCents} tone="pine" />
        <Op>−</Op>
        <Formula label="退货扣款" cents={st.returnCreditCents} tone="clay" />
        <Op>−</Op>
        <Formula label="付款" cents={st.paidCents} tone="lake" />
        <Op>+</Op>
        <Formula label="供应商退款" cents={st.refundedCents} />
        <Op>=</Op>
        <Formula label="期末余额" cents={st.endCents} strong />
      </div>
      <p className="text-[12px] text-ink-3">
        价格口径：{st.priceBasis}。门店内部管理口径，不是发票或税务核算；对账、导出不会新增应付。
      </p>

      <section>
        <h3 className="mb-2 text-[13px] font-bold text-ink-2">本期明细</h3>
        {st.rows.length === 0 ? (
          <EmptyState art="calm" title="本期没有货款变动" className="rounded-lg border border-dashed border-line-strong py-6" />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line bg-card shadow-card">
            <table className="w-full min-w-[760px] text-left text-[13px]">
              <thead className="bg-paper-2/70 text-[12px] font-bold text-ink-3">
                <tr>
                  <th className="w-[118px] px-4 py-2">日期</th>
                  <th className="w-[100px] px-2 py-2">类型</th>
                  <th className="w-[170px] px-2 py-2">单号</th>
                  <th className="px-2 py-2">说明</th>
                  <th className="w-[120px] px-2 py-2 text-right">金额</th>
                  <th className="w-[120px] px-4 py-2 text-right">余额</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/70">
                {st.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="num px-4 py-2 whitespace-nowrap text-ink-2">{r.date}</td>
                    <td className="px-2 py-2">
                      <span className="font-semibold">{KIND_LABEL[r.kind]}</span>
                      {r.isVoid && <Badge tone="clay" className="ml-1">冲销</Badge>}
                    </td>
                    <td className="num px-2 py-2">
                      {r.docKind === 'inv_doc' ? (
                        <Link to={`/inventory/docs?doc=${r.docId}`} className="font-semibold text-pine hover:underline">
                          {r.docNo}
                        </Link>
                      ) : (
                        <button
                          type="button"
                          onClick={() => (r.docKind === 'payment' ? onPayment(r.docId) : r.docKind === 'supplier_refund' ? setRefundId(r.docId) : onOpening(r.docId))}
                          className="font-semibold text-pine hover:underline"
                        >
                          {r.docNo}
                        </button>
                      )}
                    </td>
                    <td className="truncate px-2 py-2 text-ink-3">{r.note}</td>
                    <td className="px-2 py-2 text-right">
                      <Money cents={r.amountDeltaCents} signed className={cn('font-semibold', r.amountDeltaCents > 0 ? 'text-ink' : 'text-lake')} />
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Money cents={r.balanceCents} className="font-bold" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-[13px] font-bold text-ink-2">未结清货款</h3>
        {st.openItems.filter((i) => i.amountCents - i.creditCents - i.offsetCents - i.paidCents !== 0).length === 0 ? (
          <p className="text-[13px] text-ink-3">全部货款已结清。</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line bg-card shadow-card">
            <table className="w-full min-w-[720px] text-left text-[13px]">
              <thead className="bg-paper-2/70 text-[12px] font-bold text-ink-3">
                <tr>
                  <th className="px-4 py-2">货款</th>
                  <th className="px-2 py-2 text-right">金额</th>
                  <th className="px-2 py-2 text-right">退货抵扣</th>
                  <th className="px-2 py-2 text-right">核销</th>
                  <th className="px-2 py-2 text-right">已付</th>
                  <th className="px-2 py-2 text-right">待确认付款</th>
                  <th className="px-4 py-2 text-right">未结清</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/70">
                {st.openItems
                  .filter((i) => i.amountCents - i.creditCents - i.offsetCents - i.paidCents !== 0)
                  .map((i) => (
                    <tr key={`${i.kind}${i.id}`}>
                      <td className="px-4 py-2">
                        <span className="num font-semibold">{i.docNo}</span>
                        <span className="ml-2 text-ink-3">
                          {i.kind === 'opening' ? '期初未付' : i.purchaseOrderNo ? `采购单 ${i.purchaseOrderNo}` : '直接收货'} · {i.date}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-right">
                        <Money cents={i.amountCents} />
                      </td>
                      <td className="px-2 py-2 text-right">{i.creditCents ? <Money cents={i.creditCents} className="text-clay" /> : <span className="text-ink-4">·</span>}</td>
                      <td className="px-2 py-2 text-right">{i.offsetCents ? <Money cents={i.offsetCents} className="text-ember" /> : <span className="text-ink-4">·</span>}</td>
                      <td className="px-2 py-2 text-right">{i.paidCents ? <Money cents={i.paidCents} className="text-lake" /> : <span className="text-ink-4">·</span>}</td>
                      <td className="px-2 py-2 text-right">{i.pendingCents ? <Money cents={i.pendingCents} className="text-yuzu-deep" /> : <span className="text-ink-4">·</span>}</td>
                      <td className="px-4 py-2 text-right">
                        <Money cents={i.amountCents - i.creditCents - i.offsetCents - i.paidCents} className="font-bold" />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <RefundSheet id={refundId} onClose={() => setRefundId(null)} />
    </>
  );
}

function Formula({ label, cents, tone = 'ink', strong }: { label: string; cents: number; tone?: 'ink' | 'pine' | 'lake' | 'clay'; strong?: boolean }) {
  const color = { ink: 'text-ink', pine: 'text-pine', lake: 'text-lake', clay: 'text-clay' }[tone];
  return (
    <div className={cn('min-w-[110px] flex-1 rounded-md px-3 py-1.5', strong ? 'bg-pine text-paper' : 'bg-paper-2/60')}>
      <p className={cn('text-[11.5px] font-semibold', strong ? 'text-paper/70' : 'text-ink-3')}>{label}</p>
      <Money cents={cents} className={cn('text-[16px] font-bold', !strong && color)} />
    </div>
  );
}

function Op({ children }: { children: ReactNode }) {
  return <span className="flex items-center text-[16px] font-bold text-ink-4">{children}</span>;
}

function PaymentsView({ onOpen }: { onOpen: (id: number) => void }) {
  const [status, setStatus] = useState('');
  const payments = usePayments({ status: status || undefined });
  return (
    <div className="space-y-3">
      <Segmented
        size="sm"
        value={status}
        onChange={setStatus}
        ariaLabel="状态"
        options={[
          { value: '', label: '全部' },
          { value: 'submitted', label: '待确认' },
          { value: 'confirmed', label: '已确认' },
          { value: 'returned', label: '退回修改' },
          { value: 'voided', label: '已冲销' },
        ]}
      />
      {payments.isPending ? (
        <Skeleton className="h-48" />
      ) : payments.data?.length === 0 ? (
        <EmptyState art="calm" title="没有付款记录" description="付款只登记线下已经完成的付款，并核销到具体货款。" className="rounded-lg border border-dashed border-line-strong" />
      ) : (
        <ul className="overflow-hidden rounded-lg border border-line bg-card shadow-card">
          {payments.data?.map((p) => (
            <li key={p.id} className="border-b border-line/70 last:border-0">
              <button type="button" onClick={() => onOpen(p.id)} className="grid w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 px-4 py-2.5 text-left hover:bg-pine-tint/50">
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="num text-[13.5px] font-bold">{p.docNo}</span>
                    <span className="truncate text-[13px] font-semibold">{p.supplier.name}</span>
                  </span>
                  <span className="block truncate text-[12px] text-ink-3">
                    {p.payDate} · {PAY_METHOD_LABELS[p.method]} · {p.evidence} · 核销 {p.allocations.map((a) => a.docNo).join('、')}
                  </span>
                </span>
                <Money cents={p.amountCents} className="text-[15px] font-bold text-lake" />
                <PayableStatusChip status={p.status} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function OpeningsView({ onOpen }: { onOpen: (doc: OpeningPayableDoc) => void }) {
  const openings = useOpenings({});
  return openings.isPending ? (
    <Skeleton className="h-40" />
  ) : openings.data?.length === 0 ? (
    <EmptyState art="calm" title="没有期初未付" description="启用前已收货未付的货款，经对账确认后在这里登记一次。" className="rounded-lg border border-dashed border-line-strong" />
  ) : (
    <ul className="overflow-hidden rounded-lg border border-line bg-card shadow-card">
      {openings.data?.map((o) => (
        <li key={o.id} className="border-b border-line/70 last:border-0">
          <button type="button" onClick={() => onOpen(o)} className="grid w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 px-4 py-2.5 text-left hover:bg-pine-tint/50">
            <span className="min-w-0">
              <span className="flex items-center gap-2">
                <span className="num text-[13.5px] font-bold">{o.docNo}</span>
                <span className="truncate text-[13px] font-semibold">{o.supplier.name}</span>
              </span>
              <span className="block truncate text-[12px] text-ink-3">
                截至 {o.asOfDate} · {o.note || '期初未付'} · 已核销 ¥{(o.paidCents / 100).toFixed(2)}
              </span>
            </span>
            <Money cents={o.amountCents} className="text-[15px] font-bold" />
            <PayableStatusChip status={o.status} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** 核销与供应商退款（v0.7.12）：所有供应商的记录，点开可冲销（当月） */
function SettlementsView() {
  const [kind, setKind] = useState<'offsets' | 'refunds'>('offsets');
  const offsets = useOffsets({}, kind === 'offsets');
  const refunds = useRefunds({}, kind === 'refunds');
  const [offsetId, setOffsetId] = useState<number | null>(null);
  const [refundId, setRefundId] = useState<number | null>(null);
  const rows =
    kind === 'offsets'
      ? (offsets.data ?? []).map((o) => ({ id: o.id, docNo: o.docNo, supplier: o.supplier.name, date: o.offsetDate, amountCents: o.amountCents, status: o.status, detail: `用 ${o.credit.docNo} 抵扣 ${o.lines.map((l) => l.docNo).join('、')}` }))
      : (refunds.data ?? []).map((r) => ({ id: r.id, docNo: r.docNo, supplier: r.supplier.name, date: r.refundDate, amountCents: r.amountCents, status: r.status, detail: `退回 ${r.credit.docNo} · ${PAY_METHOD_LABELS[r.method]} · ${r.evidence}` }));
  const pending = kind === 'offsets' ? offsets.isPending : refunds.isPending;
  return (
    <div className="space-y-3">
      <Segmented
        size="sm"
        value={kind}
        onChange={setKind}
        ariaLabel="类型"
        options={[
          { value: 'offsets', label: '核销' },
          { value: 'refunds', label: '供应商退款' },
        ]}
      />
      <p className="text-[12.5px] text-ink-3">预付款、退货余额在对账单的「可抵扣」里核销或登记退款；核销不动钱，供应商退款记应付流水（现付供应商的退货除外）。</p>
      {pending ? (
        <Skeleton className="h-40" />
      ) : rows.length === 0 ? (
        <EmptyState art="calm" title={kind === 'offsets' ? '还没有核销' : '还没有供应商退款'} className="rounded-lg border border-dashed border-line-strong" />
      ) : (
        <ul className="overflow-hidden rounded-lg border border-line bg-card shadow-card">
          {rows.map((r) => (
            <li key={r.id} className="border-b border-line/70 last:border-0">
              <button type="button" onClick={() => (kind === 'offsets' ? setOffsetId(r.id) : setRefundId(r.id))} className="grid w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 px-4 py-2.5 text-left hover:bg-pine-tint/50">
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="num text-[13.5px] font-bold">{r.docNo}</span>
                    <span className="truncate text-[13px] font-semibold">{r.supplier}</span>
                  </span>
                  <span className="block truncate text-[12px] text-ink-3">
                    {r.date} · {r.detail}
                  </span>
                </span>
                <Money cents={r.amountCents} className={cn('text-[15px] font-bold', r.status === 'voided' && 'text-ink-4 line-through')} />
                {r.status === 'voided' ? <Badge tone="clay">已冲销</Badge> : <Badge tone="pine">已生效</Badge>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <OffsetSheet id={offsetId} onClose={() => setOffsetId(null)} />
      <RefundSheet id={refundId} onClose={() => setRefundId(null)} />
    </div>
  );
}
