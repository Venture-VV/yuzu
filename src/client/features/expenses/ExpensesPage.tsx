// 费用报销（v0.7.7，飞书需求 RQ-005）：按日期、部门、经办人、状态查报销单；明细里负责人确认、退回、冲销，登记人重新提交或撤回。

import { ExpenseTabs } from './ExpenseTabs';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Archive, BookOpenCheck, Download, FileText, Gauge, Plus, ReceiptText, ShieldCheck, Wallet, X } from 'lucide-react';
import {
  CLAIM_STATUS_LABELS,
  EXPENSE_CATEGORY_LABELS,
  PAY_SOURCE_LABELS,
  taxRateText,
  type ClaimStatus,
  type ExpenseClaim,
} from '@shared/expenses';
import { budgetCheckText, budgetOver } from '@shared/budgets';
import { CERT_STATUS_LABELS } from '@shared/invoices';
import { formatAmount } from '@shared/money';
import { formatQty } from '@shared/quantity';
import { channelText, RECEIVING_LABELS } from '@shared/purchasing';
import { errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn, formatDateTime } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { Money } from '../../components/Money';
import { PoReceiptsList } from '../../components/ReceiptAttachments';
import { Sheet } from '../../components/Overlay';
import { ReasonDialog } from '../../components/ReasonDialog';
import { ApprovalProgress, ApprovalResend, useApprovalGate } from '../approvals/ApprovalProgress';
import { postDocAction } from '../approvals/uncertain';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Input, Notice, Select, Skeleton } from '../../components/ui';
import { ErpPage } from '../erp/ErpHome';
import { useDepartments } from '../inventory/queries';
import { monthRange, search, useClaim, useClaims, useHandlers, useInvalidateExpenses, useToClaim } from './queries';

const STATUS_TONE: Record<ClaimStatus, 'pine' | 'yuzu' | 'neutral' | 'clay'> = {
  submitted: 'yuzu',
  returned: 'yuzu',
  confirmed: 'pine',
  cancelled: 'neutral',
  voided: 'clay',
};

export function ExpensesPage() {
  const can = useCan();
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const [range, setRange] = useState(() => monthRange(session.calendarToday));
  const [departmentId, setDepartmentId] = useState('');
  const [handlerId, setHandlerId] = useState('');
  const [status, setStatus] = useState('');
  const departments = useDepartments();
  const handlers = useHandlers();
  const filters = { from: range.from, to: range.to, departmentId: departmentId || undefined, handlerId: handlerId || undefined, status: status || undefined };
  const list = useClaims(filters, range.from <= range.to);
  const openId = Number(params.get('claim')) || null;
  const open = (id: number | null) => setParams(id ? { claim: String(id) } : {}, { replace: true });

  return (
    <ErpPage
      tabs={<ExpenseTabs active="claims" />}
      title="费用报销"
      description="一次支出一张报销单：按次或按现付供应商的采购单；单笔超过门槛要负责人确认。用备用金付的，平账在「备用金」里看。"
      actions={
        <div className="flex flex-wrap gap-2">
          {session.erpModules.includes('invoices') && (
            <Link to="/erp/invoices">
              <Button variant="secondary" icon={<FileText className="size-4" />} data-testid="invoices-link">
                发票台账
              </Button>
            </Link>
          )}
          {can('expense.export') && (
            <a href={`/api/erp/expenses/export?${search(filters)}`} download>
              <Button variant="secondary" icon={<Download className="size-4" />}>
                导出明细
              </Button>
            </a>
          )}
          {can('expense.manage') && (
            <Link to="/erp/expenses/new">
              <Button variant="primary" icon={<Plus className="size-4" />} data-testid="claim-new">
                登记报销
              </Button>
            </Link>
          )}
        </div>
      }
    >
      <div className="space-y-4" data-testid="expenses-page">
        <ErpPendingPanel types={['expense_claim']} onFound={(_, ref) => setParams({ claim: String(ref.refId) }, { replace: true })} />
        <ToClaimCard />
        <Card className="flex flex-wrap items-end gap-3 p-4">
          <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-3">
            从
            <Input type="date" fullWidth={false} value={range.from} max={range.to} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} className="h-9 w-40" />
          </label>
          <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-3">
            到
            <Input type="date" fullWidth={false} value={range.to} max={session.calendarToday} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} className="h-9 w-40" />
          </label>
          <Select fullWidth={false} aria-label="部门" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} className="h-9 w-36">
            <option value="">全部部门</option>
            {departments.data?.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
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
          <Select fullWidth={false} aria-label="状态" value={status} onChange={(e) => setStatus(e.target.value)} className="h-9 w-32">
            <option value="">全部状态</option>
            {(Object.keys(CLAIM_STATUS_LABELS) as ClaimStatus[]).map((s) => (
              <option key={s} value={s}>
                {CLAIM_STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
          {list.data && (
            <p className="ml-auto text-[13px] text-ink-2" data-testid="claims-totals">
              {list.data.totals.count} 张 · 已确认 <Money cents={list.data.totals.confirmedCents} className="font-bold" />
              {list.data.totals.pendingCents > 0 && (
                <>
                  {' '}
                  · 待确认 <Money cents={list.data.totals.pendingCents} className="font-bold text-yuzu-deep" />
                </>
              )}
              {list.data.truncated && <span className="block text-[12px] text-ink-3">列表只显示最近 {list.data.claims.length} 张，合计按全部算；要看全部请缩短日期范围或导出</span>}
            </p>
          )}
        </Card>

        {list.isPending ? (
          <Skeleton className="h-64" />
        ) : list.error ? (
          <Notice tone="error" title={errorMessage(list.error)} />
        ) : list.data!.claims.length === 0 ? (
          <EmptyState art="calm" title="这段时间没有报销单" />
        ) : (
          <Card className="overflow-hidden">
            <ul className="divide-y divide-line/70">
              {list.data!.claims.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => open(c.id)}
                    className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-paper-2 md:grid-cols-[150px_minmax(0,1fr)_110px_110px_auto]"
                    data-testid={`claim-row-${c.id}`}
                  >
                    <span className="num text-[13.5px] font-bold">
                      {c.docNo}
                      <span className="block font-sans text-[12px] font-medium text-ink-3">{c.expenseDate}</span>
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[13.5px] font-semibold">{c.summary || '—'}</span>
                      <span className="block truncate text-[12px] text-ink-3">
                        {c.department.name} · {c.handler.name} · {c.purpose}
                        {c.purchaseOrder ? ` · 采购单 ${c.purchaseOrder.docNo}` : ''}
                        {c.channel ? ` · ${c.channel.label}` : ''}
                      </span>
                    </span>
                    <span className="hidden text-[12.5px] text-ink-2 md:block">
                      {PAY_SOURCE_LABELS[c.paySource]}
                      {c.advance && <span className="num block text-[11.5px] text-ink-3">{c.advance.docNo}</span>}
                    </span>
                    <span className="flex flex-wrap items-center gap-1 justify-self-start md:justify-self-auto">
                      <Badge tone={STATUS_TONE[c.status]}>{CLAIM_STATUS_LABELS[c.status]}</Badge>
                      {c.overBudget && <Badge tone="clay">超预算</Badge>}
                    </span>
                    <Money cents={c.amountCents} className="text-right font-bold" />
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
      <ClaimSheet id={openId} onClose={() => open(null)} />
    </ErpPage>
  );
}

function ClaimSheet({ id, onClose }: { id: number | null; onClose: () => void }) {
  const can = useCan();
  const session = useSession();
  const toast = useToast();
  const invalidate = useInvalidateExpenses();
  const claim = useClaim(id);
  const [reasonFor, setReasonFor] = useState<'return' | 'cancel' | 'void' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const c = claim.data;
  // 审批中心（v0.7.30）：同意的是当前这一级，带上看到的审批单与级别
  const gate = useApprovalGate(c?.approval, 'expense_claim');

  const act = async (action: 'approve' | 'return' | 'resubmit' | 'cancel' | 'void', reason?: string) => {
    if (!c) return;
    setBusy(true);
    setError(null);
    try {
      const fence = action === 'approve' || action === 'return' ? gate.fence : {};
      // 确认、退回带着审批单与级别：没收到结果时记下，之后只能按原内容重新提交（uncertain.ts）
      await postDocAction<ExpenseClaim>(`/api/erp/expenses/${c.id}/${action}`, reason ? { reason, ...fence } : fence, c.docNo, session.staff.id);
      await invalidate();
      setReasonFor(null);
      toast({ tone: 'success', title: { approve: '已确认', return: '已退回', resubmit: '已重新提交', cancel: '已撤回', void: '已冲销' }[action] });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const mine = c?.createdBy === session.staff.id;
  return (
    <Sheet open={!!id} onClose={onClose} label="报销单" width="w-[min(560px,100vw)]">
      <div className="flex items-center gap-3 border-b border-line px-5 py-4">
        <span className="flex size-8 items-center justify-center rounded-full bg-lake-soft text-lake">
          <ReceiptText className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="num text-[16px] font-bold">{c?.docNo ?? '报销单'}</p>
          {c && (
            <p className="text-[12.5px] text-ink-3">
              {c.expenseDate} · 登记 {c.createdByName} {formatDateTime(c.createdAt)}
            </p>
          )}
        </div>
        <button type="button" onClick={onClose} className="rounded-md p-1.5 text-ink-3 hover:bg-paper-2" aria-label="关闭">
          <X className="size-5" />
        </button>
      </div>
      <div className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4" data-testid="claim-sheet">
        {!c ? (
          claim.error ? <Notice tone="error" title={errorMessage(claim.error)} /> : <Skeleton className="h-64" />
        ) : (
          <>
            <div className="flex items-center gap-2">
              <Badge tone={STATUS_TONE[c.status]}>{CLAIM_STATUS_LABELS[c.status]}</Badge>
              {c.overBudget && <Badge tone="clay">超预算</Badge>}
              {c.needsApproval && <span className="text-[12.5px] text-ink-3">超过门槛，需负责人确认</span>}
              <Money cents={c.amountCents} className="ml-auto text-[20px] font-bold" />
            </div>
            {c.returnedReason && c.status === 'returned' && <Notice tone="warning" title={`退回：${c.returnedReason}`} />}
            {c.voidReason && <Notice tone="error" title={`冲销：${c.voidReason}（${c.voidedByName}）`} />}
            {c.budgetCheck && c.budgetCheck.length > 0 && (
              <Notice tone={c.overBudget ? 'warning' : 'info'} title={c.overBudget ? '超预算：走「超预算报销」审批（提交时核对）' : '提交时核对的预算'} data-testid="claim-budget-check">
                <ul className="space-y-0.5 text-[12.5px]">
                  {c.budgetCheck.map((b) => (
                    <li key={b.category} className={cn(budgetOver(b) && 'font-semibold text-clay')}>
                      {budgetCheckText(b, (cents) => `¥${formatAmount(cents)}`)}
                    </li>
                  ))}
                </ul>
              </Notice>
            )}
            <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13.5px]">
              <dt className="text-ink-3">部门</dt>
              <dd>{c.department.name}</dd>
              <dt className="text-ink-3">经办人</dt>
              <dd>{c.handler.name}</dd>
              <dt className="text-ink-3">用途</dt>
              <dd>{c.purpose}</dd>
              <dt className="text-ink-3">钱从哪来</dt>
              <dd>
                {PAY_SOURCE_LABELS[c.paySource]}
                {c.advance && <span className="num ml-1.5 text-ink-2">打款 {c.advance.docNo}</span>}
              </dd>
              <dt className="text-ink-3">发票</dt>
              <dd>
                {c.invoiceLabel} · 税点 {taxRateText(c.taxRateBp)}
                {c.invoiceNo && <span className="num ml-1.5">{c.invoiceNo}</span>}
                {c.invoice && session.erpModules.includes('invoices') && (
                  <Link to={`/erp/invoices?invoice=${c.invoice.id}`} className="ml-1.5 text-[12.5px] font-semibold text-lake" data-testid="claim-invoice-link">
                    台账 · {c.invoice.issuerName || '开票方未填'} · {CERT_STATUS_LABELS[c.invoice.certStatus]}
                  </Link>
                )}
              </dd>
              <dt className="text-ink-3">采购途径</dt>
              <dd data-testid="claim-channel">{channelText(c.channel)}</dd>
              {c.purchaseOrder && (
                <>
                  <dt className="text-ink-3">采购单</dt>
                  <dd>
                    <span className="num">{c.purchaseOrder.docNo}</span> · {c.purchaseOrder.supplierName}
                  </dd>
                  {/* 收货单与附件（8.0.1 采购组整改 11：收货确认时传的照片、送货单） */}
                  {c.receipts.length > 0 && (
                    <>
                      <dt className="text-ink-3">收货附件</dt>
                      <dd>
                        <PoReceiptsList receipts={c.receipts} />
                      </dd>
                    </>
                  )}
                </>
              )}
              {c.note && (
                <>
                  <dt className="text-ink-3">备注</dt>
                  <dd>{c.note}</dd>
                </>
              )}
            </dl>
            <ul className="divide-y divide-line rounded-lg border border-line">
              {c.lines.map((l) => (
                <li key={l.lineNo} className="flex items-start gap-3 px-3 py-2.5 text-[13.5px]">
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">{l.name}</span>
                    <span className={cn('block text-[12px]', l.boughtMilli !== l.receivedMilli ? 'text-yuzu-deep' : 'text-ink-3')}>
                      {EXPENSE_CATEGORY_LABELS[l.category]} · 购买 {formatQty(l.boughtMilli)} {l.unit} · 到货 {formatQty(l.receivedMilli)} {l.unit}
                      {l.diffReason && `（${l.diffReason}）`}
                    </span>
                  </span>
                  <Money cents={l.amountCents} className="font-bold" />
                </li>
              ))}
            </ul>
            <ol className="space-y-1 text-[12.5px] text-ink-3">
              {c.approvals.map((a) => (
                <li key={a.id}>
                  {formatDateTime(a.createdAt)} · {a.actorName} · {{ create: '登记', submit: '提交', approve: '确认', return: '退回', cancel: '撤回', void: '冲销' }[a.action] ?? a.action}
                  {a.reason && `：${a.reason}`}
                </li>
              ))}
            </ol>
            <ApprovalProgress approval={c.approval} />
            {error && <Notice tone="error" title={error} />}
          </>
        )}
      </div>
      {c && (
        <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">
          {c.status === 'submitted' && can('expense.approve') && gate.uncertain && <ApprovalResend sent={gate.uncertain} onDone={invalidate} className="w-full" />}
          {c.status === 'submitted' && can('expense.approve') && !gate.uncertain && !gate.canActHere && gate.waiting && <span className="self-center text-[12.5px] text-ink-3">{gate.waiting}</span>}
          {c.status === 'submitted' && can('expense.approve') && !gate.uncertain && gate.canActHere && (
            <>
              <Button variant="secondary" disabled={busy} onClick={() => setReasonFor('return')}>
                退回
              </Button>
              <Button variant="primary" loading={busy} onClick={() => void act('approve')} data-testid="claim-approve">
                {c.approval && c.approval.levels > 1 ? `同意（第 ${c.approval.currentLevel}/${c.approval.levels} 级）` : '确认'}
              </Button>
            </>
          )}
          {c.status === 'returned' && (mine || can('expense.manage')) && (
            <Button variant="primary" loading={busy} onClick={() => void act('resubmit')}>
              重新提交
            </Button>
          )}
          {(c.status === 'submitted' || c.status === 'returned') && (mine || can('expense.approve')) && (
            <Button variant="ghost" disabled={busy} onClick={() => setReasonFor('cancel')}>
              撤回
            </Button>
          )}
          {c.status === 'confirmed' && can('finance.void') && (
            <Button variant="danger" disabled={busy} onClick={() => setReasonFor('void')} data-testid="claim-void">
              冲销
            </Button>
          )}
        </div>
      )}
      <ReasonDialog
        open={reasonFor !== null}
        title={reasonFor === 'return' ? '退回报销单' : reasonFor === 'cancel' ? '撤回报销单' : '冲销报销单'}
        description={reasonFor === 'void' ? '冲销后这笔钱退回备用金的平账；内容不改，留冲销记录。' : undefined}
        confirmLabel={reasonFor === 'return' ? '退回' : reasonFor === 'cancel' ? '撤回' : '冲销'}
        danger={reasonFor === 'void'}
        busy={busy}
        onClose={() => setReasonFor(null)}
        onConfirm={(reason) => reasonFor && void act(reasonFor, reason)}
      />
    </Sheet>
  );
}

/** 待报销（v0.7.29 ERP 采购五项②）：现付、已确认或已关闭、还有没报销的行的采购单，最早的在上面；点「转报销」打开带好的登记页 */
function ToClaimCard() {
  const can = useCan();
  const list = useToClaim();
  const [all, setAll] = useState(false);
  const rows = list.data ?? [];
  if (rows.length === 0) return null;
  const shown = all ? rows : rows.slice(0, 5);
  const total = rows.reduce((t, r) => t + r.openCents, 0);
  return (
    <Card className="overflow-hidden" data-testid="to-claim">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <ReceiptText className="size-4 text-yuzu-deep" />
        <h2 className="text-[14px] font-bold">待报销的现付采购单</h2>
        <Badge tone="yuzu">{rows.length} 张</Badge>
        <span className="text-[12.5px] text-ink-3">
          未报销 <Money cents={total} className="font-semibold text-ink-2" /> · 经办人、部门、用途、金额会带好，核对后提交
        </span>
      </div>
      <ul className="divide-y divide-line/70">
        {shown.map((r) => (
          <li key={r.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-2.5 md:grid-cols-[150px_minmax(0,1fr)_120px_auto]" data-testid={`to-claim-${r.id}`}>
            <span className="num text-[13.5px] font-bold">
              {r.docNo}
              <span className="block font-sans text-[12px] font-medium text-ink-3">
                {r.orderDate} · {r.ageDays} 天
              </span>
            </span>
            <span className="min-w-0 text-[12.5px] text-ink-2">
              <span className="block truncate font-semibold text-ink">
                {r.supplierName}
                {r.channel && <span className="ml-1.5 font-normal text-ink-3">{channelText(r.channel)}</span>}
              </span>
              <span className="block truncate text-ink-3">
                经办 {r.createdBy.name}
                {r.departments.length > 0 && ` · ${r.departments.join('、')}`} · {RECEIVING_LABELS[r.receiving]} · {r.openLines}/{r.lineCount} 行未报销
              </span>
              {/* 收货生效后推送过来（8.0.1 采购组整改 11）：收货单与附件份数 */}
              {r.receipts.length > 0 && (
                <span className="flex flex-wrap items-center gap-1.5 text-ink-3" data-testid={`to-claim-receipts-${r.id}`}>
                  <Badge tone="pine">已收货</Badge>
                  收货单 {r.receipts.map((x) => x.docNo).join('、')} · 附件 {r.receipts.reduce((n, x) => n + x.attachmentCount, 0)} 份
                </span>
              )}
            </span>
            <Money cents={r.openCents} className="text-right font-bold" />
            {can('expense.manage') ? (
              <Link to={`/erp/expenses/new?po=${r.id}`} className="col-start-2 md:col-start-auto">
                <Button variant="secondary" size="sm" data-testid={`to-claim-go-${r.id}`}>
                  转报销
                </Button>
              </Link>
            ) : (
              <span />
            )}
          </li>
        ))}
      </ul>
      {rows.length > 5 && (
        <div className="border-t border-line px-4 py-2">
          <Button variant="ghost" size="sm" onClick={() => setAll((v) => !v)}>
            {all ? '收起' : `展开全部 ${rows.length} 张`}
          </Button>
        </div>
      )}
    </Card>
  );
}
