// ERP「付款」（v0.7.32，docs/PAYMENTS.md）：付款申请、发票、三单、质保金台账、本周应付；8.0.6 加「付款规则」（有争议的数值与开关在页面上改）。
// 付款申请走审批中心（财务 → 负责人，提前付款多一级店主），批了以后对账付款的人在申请里登记付款。

import { useRef, useState } from 'react';
import { Navigate, Link, useNavigate, useSearchParams } from 'react-router';
import { Download, FilePlus2, Plus, ReceiptText, ShieldCheck } from 'lucide-react';
import { PAYMENT_STAGE_LABELS, WARRANTY_BASIS_LABELS } from '@shared/contracts';
import { formatAmount, parseYuan } from '@shared/money';
import { threeWayToleranceText, WEEKLY_ITEM_LABELS, type ThreeWayRow } from '@shared/payments';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { useCan } from '../../lib/session';
import { cn, uuid } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { Money } from '../../components/Money';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Input, MoneyInput, Notice, Skeleton } from '../../components/ui';
import { ErpPage } from '../erp/ErpHome';
import { InvoiceDialog } from './InvoiceDialog';
import { RequestStatusBadge, stageText, ThreeWayBadge, WarrantyBadge } from './parts';
import {
  useInvalidatePayments,
  useInvoices,
  usePaymentRequests,
  usePaymentRules,
  usePaymentTodo,
  useThreeWay,
  useWarranty,
  useWeeklyPayables,
  type RequestFilter,
  type WarrantyFilter,
} from './queries';

const TABS = [
  { value: 'requests', label: '付款申请' },
  { value: 'invoices', label: '发票' },
  { value: 'three-way', label: '三单' },
  { value: 'warranty', label: '质保金' },
  { value: 'weekly', label: '本周应付' },
  { value: 'rules', label: '付款规则' },
] as const;
type Tab = (typeof TABS)[number]['value'];

function Chips<T extends string>({ value, options, onChange, testId }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; testId: string }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn('h-8 rounded-full px-3 text-[13px] font-semibold', value === o.value ? 'bg-ink text-paper' : 'bg-paper-2 text-ink-2 hover:bg-paper-3')}
          data-testid={`${testId}-${o.value}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function PaymentsPage() {
  const can = useCan();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab: Tab = TABS.find((t) => t.value === params.get('tab'))?.value ?? 'requests';
  const todo = usePaymentTodo(can('payable.read'));
  // 8.0.18：付款规则收进「ERP 设置 → 付款规则」；页签还在，点了（或打开旧地址 ?tab=rules）跳过去
  if (tab === 'rules') return <Navigate to="/erp/settings/payments" replace />;
  return (
    <ErpPage
      title="付款"
      description="付款申请（合同的付款节点或没挂合同的应付）走审批中心，批了以后按申请登记付款；发票与三单匹配、质保金台账、本周应付。"
      actions={
        can('payment.request') && (
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => navigate('/erp/payments/requests/new')} data-testid="payment-request-new">
            发起付款申请
          </Button>
        )
      }
    >
      <div className="space-y-4">
        {todo.data?.weekly && (
          <Notice tone="info" title={`本周应付 ¥${formatAmount(todo.data.weekly.totalCents)} / ${todo.data.weekly.count} 笔`} data-testid="payment-weekly-notice">
            每周一提醒一次：已批待付、可付还没申请的合同段、到期的质保金。<Link to="/erp/payments?tab=weekly" className="ml-1 font-semibold text-lake hover:underline">去看本周应付</Link>
          </Notice>
        )}
        <div className="flex flex-wrap gap-1.5 border-b border-line pb-2" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.value}
              type="button"
              role="tab"
              aria-selected={tab === t.value}
              onClick={() => setParams(t.value === 'requests' ? {} : { tab: t.value }, { replace: true })}
              className={cn('h-9 rounded-lg px-3.5 text-[13.5px] font-semibold', tab === t.value ? 'bg-pine text-paper' : 'text-ink-2 hover:bg-paper-2')}
              data-testid={`payments-tab-${t.value}`}
            >
              {t.label}
              {t.value === 'requests' && !!todo.data?.awaitingPayment && can('payable.manage') && <span className="num ml-1.5 rounded-full bg-yuzu px-1.5 text-[11px] text-ink">{todo.data.awaitingPayment}</span>}
              {t.value === 'warranty' && !!todo.data?.warrantyDue && <span className="num ml-1.5 rounded-full bg-ember px-1.5 text-[11px] text-paper">{todo.data.warrantyDue}</span>}
            </button>
          ))}
        </div>
        {tab === 'requests' && <RequestsTab />}
        {tab === 'invoices' && <InvoicesTab />}
        {tab === 'three-way' && <ThreeWayTab />}
        {tab === 'warranty' && <WarrantyTab />}
        {tab === 'weekly' && <WeeklyTab />}
      </div>
    </ErpPage>
  );
}

// ───────────────────────── 付款申请 ─────────────────────────

const REQUEST_FILTERS: { value: RequestFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'reviewing', label: '审批中' },
  { value: 'returned', label: '已退回' },
  { value: 'approved', label: '待付款' },
  { value: 'done', label: '已结束' },
  { value: 'mine', label: '我发起的' },
];

function RequestsTab() {
  const can = useCan();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<RequestFilter>(can('payable.manage') ? 'approved' : 'all');
  const [q, setQ] = useState('');
  const list = usePaymentRequests(filter, q);
  return (
    <div className="space-y-3">
      {can('payment.request') && <ErpPendingPanel types={['payment_request']} onFound={(_, ref) => navigate(`/erp/payments/requests/${ref.refId}`)} />}
      <div className="flex flex-wrap items-center gap-2">
        <Chips value={filter} options={REQUEST_FILTERS} onChange={setFilter} testId="request-filter" />
        <Input aria-label="搜索付款申请" value={q} maxLength={32} onChange={(e) => setQ(e.target.value)} placeholder="申请号、收款方、合同号、用途" fullWidth={false} className="h-9 w-60" />
      </div>
      {list.isPending ? (
        <Skeleton className="h-40" />
      ) : list.error ? (
        <Notice tone="error" title={errorMessage(list.error)} />
      ) : list.data!.length === 0 ? (
        <EmptyState art="search" title="没有符合条件的付款申请" description="合同详情的付款计划里点「申请付款」，或在这里发起（没挂合同的应付选收货单）。" />
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line/70" data-testid="payment-request-list">
            {list.data!.map((r) => (
              <li key={r.id}>
                <Link to={`/erp/payments/requests/${r.id}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-4 py-3 hover:bg-paper-2 md:grid-cols-[170px_minmax(0,1fr)_140px_120px]" data-testid={`payment-request-row-${r.requestNo}`}>
                  <span className="num text-[13.5px] font-bold">
                    {r.requestNo}
                    <span className="block font-sans text-[12px] font-medium text-ink-3">期望 {r.expectedDate}</span>
                  </span>
                  <span className="min-w-0 text-[12.5px]">
                    <span className="block truncate text-[13.5px] font-semibold">{r.payee}</span>
                    <span className="block truncate text-ink-3">
                      {stageText(r.contractNo, r.stage)} · {r.purpose} · {r.createdByName}
                    </span>
                  </span>
                  <span className="text-right md:self-center">
                    <Money cents={r.amountCents} className="text-[14px] font-bold" />
                    {r.paidCents > 0 && r.paidCents < r.amountCents && <span className="block text-[11.5px] text-ink-3">已付 ¥{formatAmount(r.paidCents)}</span>}
                  </span>
                  <span className="flex flex-wrap items-center justify-end gap-1.5 md:self-center">
                    {r.early && <Badge tone="ember">提前付款</Badge>}
                    <RequestStatusBadge status={r.status} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

// ───────────────────────── 发票 ─────────────────────────

function InvoicesTab() {
  const can = useCan();
  const toast = useToast();
  const invalidate = useInvalidatePayments();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'' | 'valid' | 'voided'>('valid');
  const list = useInvoices(q, status);
  const [adding, setAdding] = useState(false);
  const [voiding, setVoiding] = useState<{ id: number; invoiceNo: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const manage = can('payable.manage');
  const doVoid = async (reason: string) => {
    if (!voiding) return;
    setBusy(true);
    try {
      await api.post(`/api/erp/payments/invoices/${voiding.id}/void`, { reason });
      toast({ tone: 'success', title: '发票已作废', body: voiding.invoiceNo });
      setVoiding(null);
    } catch (e) {
      toast({ tone: 'error', title: e instanceof UncertainError ? `没收到结果：${errorMessage(e)}` : errorMessage(e), body: '刷新后看状态；再作废一次不会重复' });
    } finally {
      setBusy(false);
      await invalidate();
    }
  };
  return (
    <div className="space-y-3">
      {manage && <ErpPendingPanel types={['supplier_invoice']} onFound={() => void invalidate()} />}
      <div className="flex flex-wrap items-center gap-2">
        <Chips
          value={status || 'all'}
          options={[
            { value: 'valid', label: '有效' },
            { value: 'voided', label: '已作废' },
            { value: 'all', label: '全部' },
          ]}
          onChange={(v) => setStatus(v === 'all' ? '' : (v as 'valid' | 'voided'))}
          testId="invoice-filter"
        />
        <Input aria-label="搜索发票" value={q} maxLength={32} onChange={(e) => setQ(e.target.value)} placeholder="发票号码、开票方" fullWidth={false} className="h-9 w-52" />
        {manage && (
          <Button size="sm" variant="secondary" icon={<ReceiptText className="size-4" />} onClick={() => setAdding(true)} className="ml-auto" data-testid="invoice-new">
            登记发票
          </Button>
        )}
      </div>
      {list.isPending ? (
        <Skeleton className="h-40" />
      ) : list.error ? (
        <Notice tone="error" title={errorMessage(list.error)} />
      ) : list.data!.length === 0 ? (
        <EmptyState art="search" title="没有发票登记" description="供应商开来的发票在这里登记，分到对应的采购单，三单才对得上。" />
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line/70" data-testid="invoice-list">
            {list.data!.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-[13px]" data-testid={`invoice-row-${i.invoiceNo}`}>
                <span className="num font-bold">{i.invoiceNo}</span>
                <span className="text-ink-2">{i.supplierName}</span>
                <span className="text-ink-3">开票 {i.invoiceDate}</span>
                <span className="min-w-0 text-ink-3">分到 {i.lines.map((l) => `${l.poNo} ¥${formatAmount(l.amountCents)}`).join('、')}</span>
                <span className="ml-auto flex items-center gap-2">
                  {i.status === 'voided' ? <Badge tone="neutral">已作废：{i.voidReason}</Badge> : <Badge tone="pine">有效</Badge>}
                  <Money cents={i.totalCents} className="font-bold" />
                  {manage && i.status === 'valid' && (
                    <Button size="sm" variant="ghost" onClick={() => setVoiding({ id: i.id, invoiceNo: i.invoiceNo })}>
                      作废
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <InvoiceDialog open={adding} onClose={() => setAdding(false)} onDone={invalidate} />
      <ReasonDialog
        open={!!voiding}
        busy={busy}
        title={`作废发票 ${voiding?.invoiceNo ?? ''}`}
        description="登错了才作废；作废以后分到采购单的金额不再算，三单可能变成挂起。"
        confirmLabel="确认作废"
        danger
        onClose={() => setVoiding(null)}
        onConfirm={(reason) => void doVoid(reason)}
      />
    </div>
  );
}

// ───────────────────────── 三单 ─────────────────────────

function ThreeWayTab() {
  const can = useCan();
  const [pending, setPending] = useState(true);
  const list = useThreeWay(pending);
  const rules = usePaymentRules();
  const [releasing, setReleasing] = useState<ThreeWayRow | null>(null);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chips
          value={pending ? 'pending' : 'all'}
          options={[
            { value: 'pending', label: '挂起、不齐的' },
            { value: 'all', label: '全部' },
          ]}
          onChange={(v) => setPending(v === 'pending')}
          testId="three-way-filter"
        />
        <span className="text-[12.5px] text-ink-3">
          按采购单比：发票与收货（减退货）差额{rules.data ? `不超过收货的 ${threeWayToleranceText(rules.data)}` : '在「付款规则」的门槛内'}算对得上；付款申请要对得上或财务放行。
        </span>
      </div>
      {list.isPending ? (
        <Skeleton className="h-40" />
      ) : list.error ? (
        <Notice tone="error" title={errorMessage(list.error)} />
      ) : list.data!.length === 0 ? (
        <EmptyState art="search" title={pending ? '没有挂起或不齐的采购单' : '还没有收货或开票的采购单'} />
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line/70" data-testid="three-way-list">
            {list.data!.map((r) => (
              <li key={r.poId} className="grid gap-x-3 gap-y-1 px-4 py-3 text-[13px] md:grid-cols-[170px_minmax(0,1fr)_auto]" data-testid={`three-way-row-${r.poNo}`}>
                <span className="num font-bold">
                  {r.poNo}
                  <span className="block font-sans text-[12px] font-medium text-ink-3">{r.supplierName}</span>
                </span>
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                    <ThreeWayBadge status={r.status} />
                    <span>采购单 <Money cents={r.poTotalCents} /></span>
                    <span>收货 <Money cents={r.receivedCents} /></span>
                    <span>发票 <Money cents={r.invoicedCents} /></span>
                    {r.contractNo && <span className="text-ink-3">合同 {r.contractNo}</span>}
                  </span>
                  <span className={cn('mt-0.5 block text-[12.5px]', r.status === 'held' ? 'text-clay' : 'text-ink-3')}>
                    {r.reason}
                    {r.releaseStale && '（放行以后金额变了，要重新放行）'}
                  </span>
                </span>
                {can('payable.manage') && (r.status === 'held' || r.status === 'incomplete') && (
                  <span className="md:self-center">
                    <Button size="sm" variant="secondary" icon={<ShieldCheck className="size-4" />} onClick={() => setReleasing(r)} data-testid={`three-way-release-${r.poNo}`}>
                      确认放行
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <ReleaseDialog row={releasing} onClose={() => setReleasing(null)} />
    </div>
  );
}

/** 财务确认放行：按打开时看到的三个金额提交，金额变了服务端拒绝（THREE_WAY_MOVED） */
export function ReleaseDialog({ row, onClose }: { row: ThreeWayRow | null; onClose: () => void }) {
  const toast = useToast();
  const invalidate = useInvalidatePayments();
  const [busy, setBusy] = useState(false);
  // 同一次放行重发用同一个编号（没收到结果时再点一次不会多记一条）
  const key = useRef(uuid());
  const send = async (reason: string) => {
    if (!row) return;
    setBusy(true);
    try {
      await api.post(`/api/erp/payments/three-way/po/${row.poId}/release`, {
        clientKey: key.current,
        reason,
        seen: { poTotalCents: row.poTotalCents, receivedCents: row.receivedCents, invoicedCents: row.invoicedCents },
      });
      key.current = uuid();
      toast({ tone: 'success', title: '已放行', body: row.poNo });
      onClose();
    } catch (e) {
      toast({ tone: 'error', title: e instanceof UncertainError ? `没收到结果：${errorMessage(e)}` : errorMessage(e), body: e instanceof UncertainError ? '刷新后看状态；再放行一次不会重复' : row.poNo });
      if (!(e instanceof UncertainError)) key.current = uuid();
    } finally {
      setBusy(false);
      await invalidate();
    }
  };
  return (
    <ReasonDialog
      open={!!row}
      busy={busy}
      title={`确认放行 ${row?.poNo ?? ''}`}
      description={
        row ? `采购单 ¥${formatAmount(row.poTotalCents)}、收货 ¥${formatAmount(row.receivedCents)}、发票 ¥${formatAmount(row.invoicedCents)}：${row.reason}。放行时记下这三个金额，之后变了要重新放行。` : undefined
      }
      label="放行原因"
      confirmLabel="确认放行"
      testId="three-way-release-dialog"
      onClose={onClose}
      onConfirm={(reason) => void send(reason)}
    />
  );
}

// ───────────────────────── 质保金 ─────────────────────────

function WarrantyTab() {
  const [filter, setFilter] = useState<WarrantyFilter>('all');
  const list = useWarranty(filter);
  const days = usePaymentRules().data?.warrantyRemindDays;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chips
          value={filter}
          options={[
            { value: 'all', label: '全部' },
            { value: 'due', label: days === undefined ? '快到期的' : `${days} 天内到期` },
            { value: 'unsettled', label: '未结项' },
          ]}
          onChange={setFilter}
          testId="warranty-filter"
        />
        <span className="text-[12.5px] text-ink-3">一份有质保段的合同一条；到期前{days === undefined ? '' : ` ${days} 天`}进待办（天数在「付款规则」里改），有未处理的质量问题时挂起。</span>
      </div>
      {list.isPending ? (
        <Skeleton className="h-40" />
      ) : list.error ? (
        <Notice tone="error" title={errorMessage(list.error)} />
      ) : list.data!.length === 0 ? (
        <EmptyState art="search" title="没有符合条件的质保金" />
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line/70" data-testid="warranty-list">
            {list.data!.map((w) => (
              <li key={w.contractId} className="grid gap-x-3 gap-y-1 px-4 py-3 text-[13px] md:grid-cols-[170px_minmax(0,1fr)_auto]" data-testid={`warranty-row-${w.contractNo}`}>
                <Link to={`/erp/contracts/${w.contractId}`} className="num font-bold text-lake hover:underline">
                  {w.contractNo}
                  <span className="block font-sans text-[12px] font-medium text-ink-3">{w.counterparty}</span>
                </Link>
                <span className="min-w-0">
                  <span className="block truncate font-semibold">{w.title}</span>
                  <span className="block text-[12.5px] text-ink-3">
                    {w.months} 个月，从{WARRANTY_BASIS_LABELS[w.basis]}起算 · {w.startDate ? `${w.startDate} 起，${w.dueDate} 到期` : '还没起算'}
                    {w.daysLeft !== null && w.rowStatus !== 'paid' && (w.daysLeft > 0 ? ` · 还有 ${w.daysLeft} 天` : ' · 已到期')}
                    {w.openIssues > 0 && ` · ${w.openIssues} 条未处理的质量问题`}
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-2 md:justify-end md:self-center">
                  {!w.settled && <Badge tone="neutral">未结项</Badge>}
                  <WarrantyBadge status={w.rowStatus} />
                  <span className="text-right">
                    <Money cents={w.plannedCents} className="font-bold" />
                    {w.paidCents > 0 && <span className="block text-[11.5px] text-ink-3">已付 ¥{formatAmount(w.paidCents)}</span>}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

// ───────────────────────── 本周应付 ─────────────────────────

function WeeklyTab() {
  const q = useWeeklyPayables();
  const [funds, setFunds] = useState('');
  if (q.isPending) return <Skeleton className="h-60" />;
  if (q.error) return <Notice tone="error" title={errorMessage(q.error)} />;
  const w = q.data!;
  const fundsCents = funds.trim() ? parseYuan(funds) : null;
  return (
    <div className="space-y-3" data-testid="weekly-payables">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <p className="text-[12.5px] text-ink-3">{w.from} 起 {w.weeks.length} 周合计</p>
          <Money cents={w.totalCents} className="text-[22px] font-bold" />
        </div>
        <label className="text-[12.5px] text-ink-3">
          可用资金（只在这台电脑上算，不存）
          <MoneyInput aria-label="可用资金" value={funds} onChange={(e) => setFunds(e.target.value)} className="w-44" data-testid="weekly-funds" />
        </label>
        {fundsCents !== null && (
          <p className={cn('text-[14px] font-bold', fundsCents < w.totalCents ? 'text-clay' : 'text-pine')} data-testid="weekly-gap">
            {fundsCents < w.totalCents ? `资金缺口 ¥${formatAmount(w.totalCents - fundsCents)}` : `够付，余 ¥${formatAmount(fundsCents - w.totalCents)}`}
          </p>
        )}
        <a href="/api/erp/payments/weekly/export" className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-lg border border-line px-3 text-[13px] font-semibold text-ink-2 hover:bg-paper-2" data-testid="weekly-export">
          <Download className="size-4" />
          导出
        </a>
      </div>
      {w.weeks.map((wk, i) => (
        <Card key={wk.start} className="p-4">
          <div className="mb-2 flex items-center gap-2">
            <h3 className="text-[14px] font-bold">
              第 {i + 1} 周 <span className="num font-normal text-ink-3">{wk.start} 至 {wk.end}</span>
            </h3>
            <Money cents={wk.totalCents} className="ml-auto text-[15px] font-bold" />
          </div>
          {wk.items.length === 0 ? (
            <p className="text-[13px] text-ink-3">这一周没有要付的。</p>
          ) : (
            <ul className="divide-y divide-line/70 text-[13px]">
              {wk.items.map((it, j) => (
                <li key={j} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-1.5">
                  <Badge tone={it.kind === 'approved' ? 'lake' : it.kind === 'available' ? 'yuzu' : 'ember'}>{WEEKLY_ITEM_LABELS[it.kind]}</Badge>
                  <span className="num text-ink-3">{it.date}</span>
                  <span className="font-semibold">{it.payee}</span>
                  {it.requestId ? (
                    <Link to={`/erp/payments/requests/${it.requestId}`} className="num text-lake hover:underline">
                      {it.requestNo}
                    </Link>
                  ) : (
                    it.contractId && (
                      <Link to={`/erp/contracts/${it.contractId}`} className="num text-lake hover:underline">
                        {it.contractNo}
                      </Link>
                    )
                  )}
                  {it.stage && <span className="text-ink-3">{PAYMENT_STAGE_LABELS[it.stage]}款</span>}
                  {it.note && <span className="min-w-0 text-[12px] text-ink-3">{it.note}</span>}
                  <Money cents={it.amountCents} className="ml-auto font-semibold" />
                </li>
              ))}
            </ul>
          )}
        </Card>
      ))}
      {(w.laterCents > 0 || w.otherApCents > 0) && (
        <p className="text-[12.5px] text-ink-3">
          {w.laterCents > 0 && `期望付款日在 ${w.weeks.length} 周以后的已批待付 ¥${formatAmount(w.laterCents)}；`}
          {w.otherApCents > 0 && `没挂合同、也没提申请的应付余额 ¥${formatAmount(w.otherApCents)}（没有付款日期，只作参考）。`}
        </p>
      )}
      {w.weeks.every((wk) => wk.items.length === 0) && (
        <EmptyState art="search" title={`${w.weeks.length} 周内没有要付的`} description="已批待付的付款申请、可付还没申请的合同段、到期的质保金会列在这里。" action={<Link to="/erp/payments/requests/new" className="inline-flex items-center gap-1 font-semibold text-lake"><FilePlus2 className="size-4" />发起付款申请</Link>} />
      )}
    </div>
  );
}
