// 付款申请详情（v0.7.32，docs/PAYMENTS.md 第 3 节）：申请要点、合同那一段的情况（为什么能付 / 不能付）、选的货款、三单、
// 审批进度（能审的人在这里审）、按申请登记的付款；经办撤回、改了再提交、作废，登记付款的人登记付款或合同付款、结束。

import { useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { ArrowLeft, Banknote, FilePen, Flag, Trash2, Undo2 } from 'lucide-react';
import { CONTRACT_CATEGORY_LABELS, PAYMENT_STAGE_LABELS } from '@shared/contracts';
import { formatAmount, parseYuan } from '@shared/money';
import { PAY_MODE_LABELS, type PaymentRequestDetail } from '@shared/payments';
import { PAY_METHOD_LABELS, PAYMENT_METHODS, type PayMethod } from '@shared/purchasing';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, useErpPending } from '../../lib/erpPending';
import { useCan, useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { cn, formatDateTime, uuid } from '../../lib/utils';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, MoneyInput, Notice, Select, Skeleton } from '../../components/ui';
import { ApprovalProgress } from '../approvals/ApprovalProgress';
import { ReviewActions } from '../approvals/DocReviewActions';
import { Fact, Facts } from '../contracts/parts';
import { ErpPage } from '../erp/ErpHome';
import { ReleaseDialog } from './PaymentsPage';
import { RequestStatusBadge, ThreeWayBadge } from './parts';
import { useInvalidatePayments, usePaymentRequest, useRequestableItems } from './queries';

export function PaymentRequestPage() {
  const can = useCan();
  const { id } = useParams();
  const requestId = Number(id) || null;
  const q = usePaymentRequest(requestId);
  if (!can('payable.read') && !can('payment.request')) return <Navigate to="/erp" replace />;
  return (
    <ErpPage
      title={q.data ? `${q.data.requestNo} · ${q.data.payee}` : '付款申请'}
      description={q.data ? (q.data.contractNo ? `合同 ${q.data.contractNo} · ${PAYMENT_STAGE_LABELS[q.data.stage!]}款` : '没挂合同的应付') : undefined}
      actions={
        <Link to="/erp/payments" className="flex items-center gap-1 text-[13px] font-semibold text-ink-3 hover:text-ink">
          <ArrowLeft className="size-4" />
          回到付款
        </Link>
      }
    >
      {q.isPending ? <Skeleton className="h-96" /> : q.error ? <Notice tone="error" title={errorMessage(q.error)} /> : <Detail r={q.data!} />}
    </ErpPage>
  );
}

type DialogState = { kind: 'withdraw' } | { kind: 'void' } | { kind: 'end' } | { kind: 'pay' } | { kind: 'payout' } | { kind: 'payout-void'; id: number; docNo: string } | null;

function Detail({ r }: { r: PaymentRequestDetail }) {
  const can = useCan();
  const session = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const invalidate = useInvalidatePayments();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [releasing, setReleasing] = useState<PaymentRequestDetail['threeWay'][number] | null>(null);
  // 经办（发起的人），或店主、店总（与服务端一样）
  const mine = r.createdById === session.staff.id || session.staff.role === 'owner' || session.staff.role === 'store_manager';
  const payer = can('payable.manage');
  const left = r.amountCents - r.paidCents;

  /** 撤回、作废、结束带版本号：重复发不会多做一次（做过的会提示刷新） */
  const run = async (key: string, url: string, body: unknown, success: string) => {
    setBusy(key);
    try {
      await api.post(url, body);
      toast({ tone: 'success', title: success, body: r.requestNo });
      setDialog(null);
    } catch (e) {
      toast({
        tone: 'error',
        title: e instanceof UncertainError ? `没收到结果：${errorMessage(e)}` : errorMessage(e),
        body: e instanceof UncertainError ? '刷新后看状态；再做一次不会重复（带了版本号）' : r.requestNo,
      });
    } finally {
      setBusy(null);
      await invalidate();
    }
  };

  return (
    <div className="space-y-4" data-testid="payment-request-detail">
      {payer && <ErpPendingPanel types={['payment', 'contract_payout']} filter={(op) => op.url.startsWith(`/api/erp/payments/requests/${r.id}/`)} onFound={() => void invalidate()} />}
      {r.status === 'returned' && (
        <Notice tone="warning" title={r.returnedReason?.startsWith('撤回') ? r.returnedReason : `审批退回：${r.returnedReason ?? ''}`}>
          改好金额、期望付款日或用途后重新提交，从第一级重新走审批；不要了就作废。
        </Notice>
      )}
      {r.status === 'approved' && payer && <Notice tone="info" title={`批了，待付款：还要付 ¥${formatAmount(left)}`}>线下付好款以后在这里登记（不再审一次）；付了一部分、剩下的不付了就「结束」。</Notice>}

      <Card className="p-5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <RequestStatusBadge status={r.status} />
          {r.early && <Badge tone="ember">提前付款</Badge>}
          <Badge tone="neutral">{PAY_MODE_LABELS[r.payMode]}</Badge>
          <Money cents={r.amountCents} className="ml-auto text-[20px] font-bold" />
        </div>
        <Facts>
          <Fact label="申请号">
            <span className="num">{r.requestNo}</span>
          </Fact>
          <Fact label="收款方">{r.payee}</Fact>
          {r.contractId ? (
            <Fact label="合同">
              <Link to={`/erp/contracts/${r.contractId}`} className="num text-lake hover:underline">
                {r.contractNo}
              </Link>{' '}
              {r.contractCategory && `${CONTRACT_CATEGORY_LABELS[r.contractCategory]} · `}
              {PAYMENT_STAGE_LABELS[r.stage!]}款
            </Fact>
          ) : (
            <Fact label="来源">没挂合同的应付 {r.targets.length} 笔</Fact>
          )}
          <Fact label="期望付款日">{r.expectedDate}</Fact>
          <Fact label="已付">
            <Money cents={r.paidCents} />
          </Fact>
          <Fact label="部门">{r.departmentName ?? '不分部门'}</Fact>
          <Fact label="用途" wide>
            {r.purpose}
          </Fact>
          {r.early && (
            <Fact label="提前付款原因" wide>
              {r.earlyReason}
            </Fact>
          )}
          {r.supplierBalanceCents !== null && (
            <Fact label="供应商往来余额">
              <Money cents={r.supplierBalanceCents} />
              {!!r.supplierCreditCents && <span className="block text-[11.5px] text-ink-3">其中可抵扣 ¥{formatAmount(r.supplierCreditCents)}</span>}
            </Fact>
          )}
          <Fact label="发起">
            {r.createdByName} · {formatDateTime(r.createdAt)}
          </Fact>
          {r.closedReason && (
            <Fact label={r.status === 'voided' ? '作废' : '结束'} wide>
              {r.closedReason} · {r.closedByName}
            </Fact>
          )}
        </Facts>

        {['submitted', 'returned', 'approved'].includes(r.status) && (
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3" data-testid="payment-request-actions">
            {can('payment.request') && mine && r.status === 'submitted' && (
              <Button size="sm" variant="secondary" icon={<Undo2 className="size-4" />} onClick={() => setDialog({ kind: 'withdraw' })} data-testid="request-withdraw">
                撤回
              </Button>
            )}
            {can('payment.request') && mine && r.status === 'returned' && (
              <Button size="sm" variant="primary" icon={<FilePen className="size-4" />} onClick={() => navigate(`/erp/payments/requests/new?edit=${r.id}`)} data-testid="request-resubmit">
                改了再提交
              </Button>
            )}
            {payer && r.status === 'approved' && left > 0 && (
              <Button size="sm" variant="primary" icon={<Banknote className="size-4" />} onClick={() => setDialog({ kind: r.payMode === 'ap' ? 'pay' : 'payout' })} data-testid="request-pay">
                {r.payMode === 'ap' ? '登记付款' : '登记合同付款'}
              </Button>
            )}
            {payer && r.status === 'approved' && r.paidCents > 0 && (
              <Button size="sm" variant="secondary" icon={<Flag className="size-4" />} onClick={() => setDialog({ kind: 'end' })} data-testid="request-end">
                结束（剩下的不付）
              </Button>
            )}
            {((can('payment.request') && mine) || payer) && ['submitted', 'returned', 'approved'].includes(r.status) && r.paidCents === 0 && (
              <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setDialog({ kind: 'void' })} data-testid="request-void">
                作废
              </Button>
            )}
            <span className="ml-auto">
              <ReviewActions approval={r.approval} kind="payment_request" docNo={r.requestNo} urlBase={`/api/erp/payments/requests/${r.id}`} onDone={invalidate} />
            </span>
          </div>
        )}
      </Card>

      {r.approval && (r.status === 'submitted' || r.approval.actions.length > 0) && (
        <Card className="p-5">
          <ApprovalProgress approval={r.approval} />
        </Card>
      )}

      {r.stagePlan && (
        <Card className="p-5" data-testid="request-stage">
          <h2 className="mb-2 text-[14px] font-bold">
            {PAYMENT_STAGE_LABELS[r.stagePlan.stage]}段现在的情况
          </h2>
          <Facts>
            <Fact label="计划">
              <Money cents={r.stagePlan.plannedCents} />
            </Fact>
            <Fact label="现在可付">
              <Money cents={r.stagePlan.payableCents} />
            </Fact>
            <Fact label="在途申请（审批中到没付完的）">
              <Money cents={r.stagePlan.requestedCents} />
            </Fact>
            <Fact label="已付">
              <Money cents={r.stagePlan.paidCents} />
            </Fact>
            <Fact label="说明" wide>
              {r.stagePlan.reason}
            </Fact>
          </Facts>
        </Card>
      )}

      {r.targets.length > 0 && (
        <Card className="p-5">
          <h2 className="mb-2 text-[14px] font-bold">申请付的货款</h2>
          <table className="w-full text-[13px]" data-testid="request-targets">
            <thead>
              <tr className="border-b border-line text-left text-[12px] text-ink-3">
                <th className="py-1.5 pr-2 font-semibold">单号</th>
                <th className="py-1.5 pr-2 font-semibold">日期</th>
                <th className="py-1.5 pr-2 text-right font-semibold">申请</th>
                <th className="py-1.5 pr-2 text-right font-semibold">已付</th>
                <th className="py-1.5 text-right font-semibold">现在没结清</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/70">
              {r.targets.map((t) => (
                <tr key={`${t.kind}:${t.targetId}`}>
                  <td className="num py-1.5 pr-2 font-semibold">
                    {t.docNo}
                    {t.purchaseOrderNo && <span className="block font-sans text-[11.5px] font-normal text-ink-3">采购单 {t.purchaseOrderNo}</span>}
                  </td>
                  <td className="num py-1.5 pr-2">{t.date}</td>
                  <td className="py-1.5 pr-2 text-right">
                    <Money cents={t.amountCents} />
                  </td>
                  <td className="py-1.5 pr-2 text-right">
                    <Money cents={t.paidCents} />
                  </td>
                  <td className="py-1.5 text-right">
                    <Money cents={t.openCents} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {(r.threeWayRequired || r.threeWay.length > 0) && (
        <Card className="p-5" data-testid="request-three-way">
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-[14px] font-bold">三单匹配</h2>
            {r.threeWayRequired ? <Badge tone={r.threeWayOk ? 'pine' : 'clay'}>{r.threeWayOk ? '齐了' : '还没对上'}</Badge> : <Badge tone="neutral">这一段不要求</Badge>}
          </div>
          {r.threeWay.length === 0 ? (
            <p className="text-[13px] text-ink-3">还没有收货的采购单。</p>
          ) : (
            <ul className="divide-y divide-line/70 text-[13px]">
              {r.threeWay.map((t) => (
                <li key={t.poId} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-1.5">
                  <span className="num font-semibold">{t.poNo}</span>
                  <ThreeWayBadge status={t.status} />
                  <span>采购单 <Money cents={t.poTotalCents} /></span>
                  <span>收货 <Money cents={t.receivedCents} /></span>
                  <span>发票 <Money cents={t.invoicedCents} /></span>
                  <span className={cn('min-w-0 text-[12px]', t.status === 'held' ? 'text-clay' : 'text-ink-3')}>{t.reason}</span>
                  {payer && (t.status === 'held' || t.status === 'incomplete') && (
                    <Button size="sm" variant="secondary" className="ml-auto" onClick={() => setReleasing(t)}>
                      确认放行
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {r.threeWayRequired && !r.threeWayOk && <p className="mt-2 text-[12.5px] text-ink-3">先在「付款 → 发票」登记发票；差额是运费、尾差的，请财务确认放行。</p>}
        </Card>
      )}

      {r.payments.length > 0 && (
        <Card className="p-5">
          <h2 className="mb-2 text-[14px] font-bold">按这张申请登记的付款</h2>
          <ul className="space-y-2" data-testid="request-payments">
            {r.payments.map((p) => (
              <li key={`${p.kind}:${p.id}`} className="rounded-lg border border-line px-3.5 py-2.5 text-[13px]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="num font-bold">{p.docNo}</span>
                  <Badge tone={p.status === 'voided' ? 'neutral' : 'pine'}>{p.status === 'voided' ? '已冲销' : p.kind === 'payout' ? '合同付款' : '已付款'}</Badge>
                  <span className="text-ink-2">
                    {p.payDate} · {PAY_METHOD_LABELS[p.method]} · {p.evidence}
                  </span>
                  <Money cents={p.amountCents} className="ml-auto font-bold" />
                </div>
                {(p.allocations.length > 0 || p.prepaidCents > 0) && (
                  <p className="mt-0.5 text-[12.5px] text-ink-3">
                    {p.allocations.map((a) => `核销 ${a.docNo} ¥${formatAmount(a.amountCents)}`).join('；')}
                    {p.prepaidCents > 0 && `${p.allocations.length ? '；' : ''}记为预付款 ¥${formatAmount(p.prepaidCents)}`}
                  </p>
                )}
                {p.voidReason && <p className="mt-0.5 text-[12.5px] text-ink-3">冲销：{p.voidReason}</p>}
                <div className="mt-1 flex items-center gap-2 text-[12px] text-ink-3">
                  {p.createdByName} · {formatDateTime(p.createdAt)}
                  {p.kind === 'payment' && p.status === 'confirmed' && (
                    <Link to={`/payables?view=payments&payment=${p.id}`} className="font-semibold text-lake hover:underline">
                      在供应商往来里看（冲销在那里）
                    </Link>
                  )}
                  {p.kind === 'payout' && p.status === 'confirmed' && can('finance.void') && (
                    <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'payout-void', id: p.id, docNo: p.docNo })}>
                      冲销
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <ReasonDialog
        open={dialog?.kind === 'withdraw'}
        busy={busy === 'withdraw'}
        title={`撤回 ${r.requestNo}`}
        description="撤回后回到「已退回」，审批单关掉；改了再提交从第一级重新走，不要了可以作废。"
        confirmLabel="确认撤回"
        onClose={() => setDialog(null)}
        onConfirm={(reason) => void run('withdraw', `/api/erp/payments/requests/${r.id}/withdraw`, { version: r.version, reason }, '已撤回')}
      />
      <ReasonDialog
        open={dialog?.kind === 'void'}
        busy={busy === 'void'}
        title={`作废 ${r.requestNo}`}
        description="作废后这张申请不再占这一段（或这些货款）的额度；已经付过钱的不能作废。"
        confirmLabel="确认作废"
        danger
        onClose={() => setDialog(null)}
        onConfirm={(reason) => void run('void', `/api/erp/payments/requests/${r.id}/void`, { version: r.version, reason }, '已作废')}
      />
      <ReasonDialog
        open={dialog?.kind === 'end'}
        busy={busy === 'end'}
        title={`结束 ${r.requestNo}`}
        description={`已付 ¥${formatAmount(r.paidCents)}，剩下的 ¥${formatAmount(left)} 不付了（合同这一段算结束）。`}
        confirmLabel="确认结束"
        onClose={() => setDialog(null)}
        onConfirm={(reason) => void run('end', `/api/erp/payments/requests/${r.id}/end`, { version: r.version, reason }, '已结束')}
      />
      <ReasonDialog
        open={dialog?.kind === 'payout-void'}
        busy={busy === 'payout-void'}
        title={`冲销合同付款 ${dialog?.kind === 'payout-void' ? dialog.docNo : ''}`}
        description="只能冲销当月的；冲销后这张申请回到「待付款」，可以重新登记。"
        confirmLabel="确认冲销"
        danger
        onClose={() => setDialog(null)}
        onConfirm={(reason) => dialog?.kind === 'payout-void' && void run('payout-void', `/api/erp/payments/payouts/${dialog.id}/void`, { reason }, '合同付款已冲销')}
      />
      <PayDialog open={dialog?.kind === 'pay'} r={r} onClose={() => setDialog(null)} onDone={invalidate} />
      <PayoutDialog open={dialog?.kind === 'payout'} r={r} onClose={() => setDialog(null)} onDone={invalidate} />
      <ReleaseDialog row={releasing} onClose={() => setReleasing(null)} />
    </div>
  );
}

// ───────────────────────── 登记付款 ─────────────────────────

/** 供应商往来的付款：合同的申请核销到这份合同的收货单或记预付款；没挂合同的核销到申请里选的那几笔 */
function PayDialog({ open, r, onClose, onDone }: { open: boolean; r: PaymentRequestDetail; onClose: () => void; onDone: () => unknown }) {
  const session = useSession();
  const toast = useToast();
  const items = useRequestableItems(open && r.contractId !== null ? r.supplierId : null);
  const [amount, setAmount] = useState('');
  const [payDate, setPayDate] = useState('');
  const [method, setMethod] = useState<PayMethod>('bank_transfer');
  const [evidence, setEvidence] = useState('');
  const [note, setNote] = useState('');
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = `/api/erp/payments/requests/${r.id}/pay`;
  const pending = useErpPending(['payment']).filter((p) => p.url === url);
  const left = r.amountCents - r.paidCents;
  // 能核销的：合同的申请 = 这份合同的收货单（没结清的）；没挂合同的 = 申请里选的、还没付完的
  const rows =
    r.contractId !== null
      ? (items.data ?? []).filter((i) => i.kind === 'receipt' && i.contractNo === r.contractNo && i.openCents > 0).map((i) => ({ key: `receipt:${i.id}`, kind: 'receipt' as const, id: i.id, docNo: i.docNo, max: i.openCents }))
      : r.targets.filter((t) => t.amountCents - t.paidCents > 0).map((t) => ({ key: `${t.kind}:${t.targetId}`, kind: t.kind, id: t.targetId, docNo: t.docNo, max: Math.min(t.amountCents - t.paidCents, t.openCents) }));
  useResetOnOpen(open, () => {
    setAmount(String((left / 100).toFixed(2)));
    setPayDate(session.calendarToday);
    setMethod('bank_transfer');
    setEvidence('');
    setNote('');
    setError(null);
    setAlloc(r.contractId === null ? Object.fromEntries(r.targets.filter((t) => t.amountCents - t.paidCents > 0).map((t) => [`${t.kind}:${t.targetId}`, ((t.amountCents - t.paidCents) / 100).toFixed(2)])) : {});
  });
  const cents = amount.trim() ? parseYuan(amount) : null;
  const chosen = rows.map((x) => ({ ...x, cents: alloc[x.key]?.trim() ? parseYuan(alloc[x.key]!) : null })).filter((x) => alloc[x.key]?.trim());
  const allocated = chosen.reduce((s, x) => s + (x.cents ?? 0), 0);
  const prepay = cents !== null ? cents - allocated : 0;
  const problem =
    pending.length > 0
      ? '上一笔付款结果待确认，请先在上方查回、按原内容重新提交或作废'
      : !cents
        ? '请填写付款金额'
        : cents > left
          ? `这次最多付 ¥${formatAmount(left)}`
          : chosen.some((x) => !x.cents || x.cents > x.max)
            ? '有核销金额格式不对或超过能核销的'
            : allocated > cents
              ? '核销合计超过付款金额'
              : r.contractId === null && allocated !== cents
                ? '没挂合同的付款要全部核销到申请里选的货款上'
                : evidence.trim().length < 2
                  ? '请填写凭据说明'
                  : null;
  const submit = async () => {
    if (problem) return;
    setBusy(true);
    setError(null);
    const body = {
      clientKey: uuid(),
      payDate,
      amountCents: cents,
      method,
      evidence: evidence.trim(),
      note: note.trim(),
      prepay: prepay > 0,
      allocations: chosen.map((x) => ({ kind: x.kind, targetId: x.id, amountCents: x.cents })),
    };
    try {
      await sendErpOp({ key: body.clientKey, type: 'payment', url, body, summary: `${r.requestNo} 付款 ¥${formatAmount(cents!)}`, staffName: session.staff.displayName });
      toast({ tone: 'success', title: '付款已登记', body: `${r.requestNo} · ¥${formatAmount(cents!)}` });
      onClose();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'error', title: '付款没收到结果', body: '记在页面上方「结果待确认」里，查回或按原内容重新提交' });
        onClose();
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
      await onDone();
    }
  };
  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title={`登记付款 · ${r.requestNo}`}
      description="线下付好款以后登记：付款日、方式、凭据。申请已经批过，登记即确认，进供应商往来。"
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!!problem} onClick={() => void submit()} data-testid="pay-confirm">
            登记付款
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="付款金额" htmlFor="pay-amount">
          <MoneyInput id="pay-amount" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="pay-amount" />
        </Field>
        <Field label="付款日" htmlFor="pay-date">
          <Input id="pay-date" type="date" value={payDate} max={session.calendarToday} onChange={(e) => setPayDate(e.target.value)} className="h-10" />
        </Field>
        <Field label="方式" htmlFor="pay-method">
          <Select id="pay-method" value={method} onChange={(e) => setMethod(e.target.value as PayMethod)}>
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {PAY_METHOD_LABELS[m]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="凭据说明" htmlFor="pay-evidence" className="sm:col-span-2">
          <Input id="pay-evidence" value={evidence} maxLength={200} onChange={(e) => setEvidence(e.target.value)} placeholder="例如转账流水号后四位" className="h-10" data-testid="pay-evidence" />
        </Field>
        <Field label="备注（选填）" htmlFor="pay-note">
          <Input id="pay-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} className="h-10" />
        </Field>
      </div>
      <div className="mt-4">
        <h4 className="mb-1.5 text-[12.5px] font-bold text-ink-2">{r.contractId !== null ? '核销到这份合同的收货单（不填的部分记为预付款）' : '核销到申请里选的货款'}</h4>
        {rows.length === 0 ? (
          <p className="text-[13px] text-ink-3">{r.contractId !== null ? '这份合同还没有没结清的收货单：整笔记为预付款，以后到货再核销。' : '申请里的货款都付完了。'}</p>
        ) : (
          <ul className="divide-y divide-line/70 text-[13px]" data-testid="pay-allocations">
            {rows.map((x) => (
              <li key={x.key} className="flex items-center gap-3 py-1.5">
                <span className="num font-semibold">{x.docNo}</span>
                <span className="text-ink-3">最多 ¥{formatAmount(x.max)}</span>
                <span className="ml-auto w-36">
                  <MoneyInput aria-label={`核销 ${x.docNo}`} value={alloc[x.key] ?? ''} onChange={(e) => setAlloc((a) => ({ ...a, [x.key]: e.target.value }))} data-testid={`pay-alloc-${x.docNo}`} />
                </span>
              </li>
            ))}
          </ul>
        )}
        {r.contractId !== null && cents !== null && prepay > 0 && !problem && <p className="mt-2 text-[12.5px] text-ink-2">其中 ¥{formatAmount(prepay)} 记为预付款（以后到货在供应商往来里核销）。</p>}
      </div>
      {problem && cents !== null && <p className="mt-2 text-[12.5px] font-semibold text-ember">{problem}</p>}
      {error && <Notice tone="error" title={error} className="mt-3" />}
    </Dialog>
  );
}

/** 合同付款（服务、租赁、其他合同）：不进供应商往来 */
function PayoutDialog({ open, r, onClose, onDone }: { open: boolean; r: PaymentRequestDetail; onClose: () => void; onDone: () => unknown }) {
  const session = useSession();
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [payDate, setPayDate] = useState('');
  const [method, setMethod] = useState<PayMethod>('bank_transfer');
  const [evidence, setEvidence] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = `/api/erp/payments/requests/${r.id}/payout`;
  const pending = useErpPending(['contract_payout']).filter((p) => p.url === url);
  const left = r.amountCents - r.paidCents;
  useResetOnOpen(open, () => {
    setAmount((left / 100).toFixed(2));
    setPayDate(session.calendarToday);
    setMethod('bank_transfer');
    setEvidence('');
    setNote('');
    setError(null);
  });
  const cents = amount.trim() ? parseYuan(amount) : null;
  const problem = pending.length > 0 ? '上一笔合同付款结果待确认，请先在上方处理' : !cents ? '请填写付款金额' : cents > left ? `这次最多付 ¥${formatAmount(left)}` : evidence.trim().length < 2 ? '请填写凭据说明' : null;
  const submit = async () => {
    if (problem) return;
    setBusy(true);
    setError(null);
    const body = { clientKey: uuid(), payDate, amountCents: cents, method, evidence: evidence.trim(), note: note.trim() };
    try {
      await sendErpOp({ key: body.clientKey, type: 'contract_payout', url, body, summary: `${r.requestNo} 合同付款 ¥${formatAmount(cents!)}`, staffName: session.staff.displayName });
      toast({ tone: 'success', title: '合同付款已登记', body: `${r.requestNo} · ¥${formatAmount(cents!)}` });
      onClose();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'error', title: '合同付款没收到结果', body: '记在页面上方「结果待确认」里，查回或按原内容重新提交' });
        onClose();
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
      await onDone();
    }
  };
  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title={`登记合同付款 · ${r.requestNo}`}
      description="服务、租赁、其他合同没有收货单、不记应付：付好款以后在这里登记，不进供应商往来。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!!problem} onClick={() => void submit()} data-testid="payout-confirm">
            登记合同付款
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="付款金额" htmlFor="po-amount">
          <MoneyInput id="po-amount" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="payout-amount" />
        </Field>
        <Field label="付款日" htmlFor="po-date">
          <Input id="po-date" type="date" value={payDate} max={session.calendarToday} onChange={(e) => setPayDate(e.target.value)} className="h-10" />
        </Field>
        <Field label="方式" htmlFor="po-method">
          <Select id="po-method" value={method} onChange={(e) => setMethod(e.target.value as PayMethod)}>
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {PAY_METHOD_LABELS[m]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="凭据说明" htmlFor="po-evidence" className="sm:col-span-2">
          <Input id="po-evidence" value={evidence} maxLength={200} onChange={(e) => setEvidence(e.target.value)} className="h-10" data-testid="payout-evidence" />
        </Field>
        <Field label="备注（选填）" htmlFor="po-note">
          <Input id="po-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} className="h-10" />
        </Field>
      </div>
      {problem && cents !== null && <p className="mt-2 text-[12.5px] font-semibold text-ember">{problem}</p>}
      {error && <Notice tone="error" title={error} className="mt-3" />}
    </Dialog>
  );
}
