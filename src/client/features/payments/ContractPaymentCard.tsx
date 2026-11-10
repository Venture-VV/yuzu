// 合同详情里的付款计划、验收登记、质量问题登记（v0.7.32，docs/PAYMENTS.md 第 2 节）：
// 每一段的计划金额、现在可付、在途申请、已付与为什么能付 / 不能付，能申请的直接去发起付款申请；
// 维护合同的人登记验收（合格放开验收段、质保起算）与质量问题（有未处理的质保段挂起），登错了作废。

import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { CircleCheck, ClipboardCheck, FilePlus2, TriangleAlert } from 'lucide-react';
import { PAYMENT_STAGE_LABELS, WARRANTY_BASIS_LABELS, formatPercentBp, type ContractDetail } from '@shared/contracts';
import { formatAmount } from '@shared/money';
import { ACCEPTANCE_RESULT_LABELS, QUALITY_STATUS_LABELS, type AcceptanceResult, type QualityIssueView } from '@shared/payments';
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
import { Badge, Button, Card, Field, Input, Notice, Select, Skeleton, Textarea } from '../../components/ui';
import { useErpAccess } from '../erp/access';
import { RequestStatusBadge } from './parts';
import { useInvalidatePayments, usePaymentPlan } from './queries';

type DialogState =
  | { kind: 'acceptance' }
  | { kind: 'acceptance-void'; id: number; label: string }
  | { kind: 'issue' }
  | { kind: 'issue-resolve'; issue: QualityIssueView }
  | { kind: 'issue-void'; issue: QualityIssueView }
  | null;

export function ContractPaymentCard({ c }: { c: ContractDetail }) {
  const can = useCan();
  const toast = useToast();
  const navigate = useNavigate();
  const access = useErpAccess();
  const invalidate = useInvalidatePayments();
  const q = usePaymentPlan(c.id, 'contracts');
  const [dialog, setDialog] = useState<DialogState>(null);
  const [busy, setBusy] = useState(false);
  const manage = can('contract.manage');
  const canRequest = can('payment.request') && access.modules.includes('payments');
  const signed = ['signed', 'archived', 'terminated'].includes(c.status);

  const post = async (url: string, body: unknown, success: string) => {
    setBusy(true);
    try {
      await api.post(url, body);
      toast({ tone: 'success', title: success, body: c.contractNo });
      setDialog(null);
    } catch (e) {
      toast({ tone: 'error', title: e instanceof UncertainError ? `没收到结果：${errorMessage(e)}` : errorMessage(e), body: e instanceof UncertainError ? '刷新后看状态；再做一次不会重复' : c.contractNo });
    } finally {
      setBusy(false);
      await invalidate();
    }
  };

  if (q.isPending) return <Skeleton className="h-48" />;
  if (q.error) return <Notice tone="error" title={errorMessage(q.error)} />;
  const p = q.data!;
  const w = p.warranty;

  return (
    <Card className="space-y-4 p-5" data-testid="contract-payment-plan">
      {manage && <ErpPendingPanel types={['contract_acceptance', 'contract_quality']} filter={(op) => op.url.startsWith(`/api/erp/contracts/${c.id}/`)} onFound={() => void invalidate()} />}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[14px] font-bold">付款计划</h2>
        <span className="text-[12.5px] text-ink-3">按第 {p.currentVersion || 1} 版的付款节点现算（变更单生效后按新的一版）</span>
        {p.settled ? <Badge tone="pine">已结项</Badge> : signed && <Badge tone="neutral">未结项</Badge>}
        <span className="ml-auto text-[13px]">
          已付 <Money cents={p.paidCents} className="font-bold" /> / 计划 <Money cents={p.plannedCents} />
        </span>
      </div>
      {!p.canRequest && <p className="text-[13px] text-ink-3">{p.whyNot}</p>}
      {p.legacyPaidCents > 0 && <p className="text-[12.5px] text-ink-3">另有不带付款申请、核销到这份合同收货单上的付款 ¥{formatAmount(p.legacyPaidCents)}（v0.7.32 以前登记的，或「付款规则」关掉「挂合同的货款要先提申请」以后直接登记的；不算在各段里）。</p>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-[13px]" data-testid="payment-plan-stages">
          <thead>
            <tr className="border-b border-line text-left text-[12px] text-ink-3">
              <th className="py-1.5 pr-2 font-semibold">节点</th>
              <th className="py-1.5 pr-2 text-right font-semibold">计划</th>
              <th className="py-1.5 pr-2 text-right font-semibold">现在可付</th>
              <th className="py-1.5 pr-2 text-right font-semibold" title="审批中、退回待改、批了没付完的">在途申请</th>
              <th className="py-1.5 pr-2 text-right font-semibold">已付</th>
              <th className="py-1.5 pr-2 font-semibold">说明</th>
              <th className="py-1.5 font-semibold" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line/70">
            {p.stages.map((s) => (
              <tr key={s.stage} className={cn(s.plannedCents === 0 && 'text-ink-3')} data-testid={`plan-stage-${s.stage}`}>
                <td className="py-2 pr-2 align-top font-semibold">
                  {PAYMENT_STAGE_LABELS[s.stage]} {formatPercentBp(s.percentBp)}
                  {s.condition && <span className="block text-[11.5px] font-normal text-ink-3">{s.condition}</span>}
                </td>
                <td className="py-2 pr-2 text-right align-top">
                  <Money cents={s.plannedCents} />
                </td>
                <td className="py-2 pr-2 text-right align-top">
                  <Money cents={s.payableCents} className={cn(s.payableCents > 0 && 'font-semibold text-pine')} />
                </td>
                <td className="py-2 pr-2 text-right align-top">{s.requestedCents ? <Money cents={s.requestedCents} /> : <span className="text-ink-4">·</span>}</td>
                <td className="py-2 pr-2 text-right align-top">{s.paidCents ? <Money cents={s.paidCents} /> : <span className="text-ink-4">·</span>}</td>
                <td className="py-2 pr-2 align-top text-[12.5px]">
                  <span className={cn(s.overpaidCents > 0 ? 'text-clay' : 'text-ink-2')}>{s.reason}</span>
                  {s.requests.length > 0 && (
                    <span className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5">
                      {s.requests.map((r) => (
                        <Link key={r.id} to={`/erp/payments/requests/${r.id}`} className="num inline-flex items-center gap-1 text-lake hover:underline">
                          {r.requestNo} ¥{formatAmount(r.amountCents)}
                          <RequestStatusBadge status={r.status} />
                        </Link>
                      ))}
                    </span>
                  )}
                </td>
                <td className="py-2 text-right align-top">
                  {s.done && s.plannedCents > 0 ? (
                    <Badge tone="pine">{s.paidCents >= s.plannedCents ? '付清' : '已结束'}</Badge>
                  ) : (
                    canRequest &&
                    p.canRequest &&
                    s.remainingCents > 0 && (
                      <Button
                        size="sm"
                        variant={s.availableCents > 0 ? 'primary' : 'secondary'}
                        icon={<FilePlus2 className="size-4" />}
                        onClick={() => navigate(`/erp/payments/requests/new?contract=${c.id}&stage=${s.stage}`)}
                        data-testid={`plan-request-${s.stage}`}
                      >
                        {s.availableCents > 0 ? '申请付款' : '提前申请'}
                      </Button>
                    )
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <div className="mb-1.5 flex items-center gap-2">
            <h3 className="text-[13px] font-bold">验收</h3>
            {p.latestAcceptance && <Badge tone={p.latestAcceptance.result === 'pass' ? 'pine' : 'clay'}>最近一次{ACCEPTANCE_RESULT_LABELS[p.latestAcceptance.result]}</Badge>}
            {manage && signed && (
              <Button size="sm" variant="secondary" icon={<ClipboardCheck className="size-4" />} className="ml-auto" onClick={() => setDialog({ kind: 'acceptance' })} data-testid="acceptance-new">
                登记验收
              </Button>
            )}
          </div>
          {p.acceptances.length === 0 ? (
            <p className="text-[12.5px] text-ink-3">{signed ? '验收合格放开验收段；质保从验收合格日起算的也按它。' : '签署以后登记验收。'}</p>
          ) : (
            <ul className="space-y-1.5 text-[12.5px]" data-testid="acceptance-list">
              {p.acceptances.map((a) => (
                <li key={a.id} className={cn('rounded-md border border-line px-3 py-1.5', a.voidedAt && 'opacity-60')}>
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="num font-semibold">{a.acceptedOn}</span>
                    <Badge tone={a.voidedAt ? 'neutral' : a.result === 'pass' ? 'pine' : 'clay'}>{a.voidedAt ? '已作废' : ACCEPTANCE_RESULT_LABELS[a.result]}</Badge>
                    <span>签字 {a.signer}</span>
                    {manage && !a.voidedAt && (
                      <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setDialog({ kind: 'acceptance-void', id: a.id, label: `${a.acceptedOn} ${ACCEPTANCE_RESULT_LABELS[a.result]}` })}>
                        作废
                      </Button>
                    )}
                  </span>
                  {a.note && <span className="block text-ink-2">{a.note}</span>}
                  <span className="block text-ink-3">
                    {a.createdByName} · {formatDateTime(a.createdAt)}
                    {a.voidReason && ` · 作废：${a.voidReason}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <div className="mb-1.5 flex items-center gap-2">
            <h3 className="text-[13px] font-bold">质保与质量问题</h3>
            {w.openIssues > 0 && <Badge tone="clay">{w.openIssues} 条未处理</Badge>}
            {manage && signed && (
              <Button size="sm" variant="secondary" icon={<TriangleAlert className="size-4" />} className="ml-auto" onClick={() => setDialog({ kind: 'issue' })} data-testid="quality-new">
                登记质量问题
              </Button>
            )}
          </div>
          <p className="text-[12.5px] text-ink-2" data-testid="warranty-state">
            {w.months > 0 || stageWarranty(p) > 0
              ? `${w.months} 个月，从${WARRANTY_BASIS_LABELS[w.basis]}起算：${w.startDate ? `${w.startDate} 起，${w.dueDate} 到期` : '还没起算'}${w.startNote ? `（${w.startNote}）` : ''}`
              : '没有质保'}
          </p>
          {p.qualityIssues.length > 0 && (
            <ul className="mt-1.5 space-y-1.5 text-[12.5px]" data-testid="quality-list">
              {p.qualityIssues.map((i) => (
                <li key={i.id} className={cn('rounded-md border border-line px-3 py-1.5', i.status === 'voided' && 'opacity-60')}>
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="num font-semibold">{i.foundOn}</span>
                    <Badge tone={i.status === 'open' ? 'clay' : 'neutral'}>{QUALITY_STATUS_LABELS[i.status]}</Badge>
                    <span className="min-w-0">{i.description}</span>
                    {manage && i.status === 'open' && (
                      <span className="ml-auto flex gap-1">
                        <Button size="sm" variant="secondary" icon={<CircleCheck className="size-4" />} onClick={() => setDialog({ kind: 'issue-resolve', issue: i })} data-testid={`quality-resolve-${i.id}`}>
                          已处理
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'issue-void', issue: i })}>
                          作废
                        </Button>
                      </span>
                    )}
                  </span>
                  {i.resolution && (
                    <span className="block text-ink-2">
                      {i.resolvedOn} 处理：{i.resolution}（{i.resolvedByName}）
                    </span>
                  )}
                  {i.voidReason && <span className="block text-ink-3">作废：{i.voidReason}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <AcceptanceDialog open={dialog?.kind === 'acceptance'} c={c} onClose={() => setDialog(null)} onDone={invalidate} />
      <IssueDialog open={dialog?.kind === 'issue'} c={c} onClose={() => setDialog(null)} onDone={invalidate} />
      <ResolveDialog open={dialog?.kind === 'issue-resolve'} issue={dialog?.kind === 'issue-resolve' ? dialog.issue : null} busy={busy} onClose={() => setDialog(null)} onConfirm={(body) => dialog?.kind === 'issue-resolve' && void post(`/api/erp/contracts/quality-issues/${dialog.issue.id}/resolve`, body, '质量问题已标记处理')} />
      <ReasonDialog
        open={dialog?.kind === 'acceptance-void'}
        busy={busy}
        title={`作废验收登记 ${dialog?.kind === 'acceptance-void' ? dialog.label : ''}`}
        description="登错了才作废；以最近一条没作废的验收登记为准。"
        confirmLabel="确认作废"
        danger
        onClose={() => setDialog(null)}
        onConfirm={(reason) => dialog?.kind === 'acceptance-void' && void post(`/api/erp/contracts/acceptances/${dialog.id}/void`, { reason }, '验收登记已作废')}
      />
      <ReasonDialog
        open={dialog?.kind === 'issue-void'}
        busy={busy}
        title="作废质量问题登记"
        description="登错了才作废（已处理的不能作废）。"
        confirmLabel="确认作废"
        danger
        onClose={() => setDialog(null)}
        onConfirm={(reason) => dialog?.kind === 'issue-void' && void post(`/api/erp/contracts/quality-issues/${dialog.issue.id}/void`, { reason }, '质量问题登记已作废')}
      />
    </Card>
  );
}

const stageWarranty = (p: { stages: { stage: string; plannedCents: number }[] }) => p.stages.find((s) => s.stage === 'warranty')?.plannedCents ?? 0;

function AcceptanceDialog({ open, c, onClose, onDone }: { open: boolean; c: ContractDetail; onClose: () => void; onDone: () => unknown }) {
  const session = useSession();
  const toast = useToast();
  const [acceptedOn, setAcceptedOn] = useState('');
  const [result, setResult] = useState<AcceptanceResult>('pass');
  const [signer, setSigner] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = `/api/erp/contracts/${c.id}/acceptances`;
  const pending = useErpPending(['contract_acceptance']).filter((p) => p.url === url);
  useResetOnOpen(open, () => {
    setAcceptedOn(session.calendarToday);
    setResult('pass');
    setSigner(c.content.acceptance.signer.slice(0, 20));
    setNote('');
    setError(null);
  });
  const problem = pending.length > 0 ? '上一条验收登记结果待确认，请先在上方处理' : !acceptedOn || acceptedOn > session.calendarToday ? '验收日不能晚于今天' : !signer.trim() ? '请填写签字人' : result === 'fail' && note.trim().length < 2 ? '不合格请写明怎么处理' : null;
  const submit = async () => {
    if (problem) return;
    setBusy(true);
    setError(null);
    const body = { clientKey: uuid(), acceptedOn, result, signer: signer.trim(), note: note.trim() };
    try {
      await sendErpOp({ key: body.clientKey, type: 'contract_acceptance', url, body, summary: `${c.contractNo} 验收 ${acceptedOn} ${ACCEPTANCE_RESULT_LABELS[result]}`, staffName: session.staff.displayName });
      toast({ tone: 'success', title: `已登记验收（${ACCEPTANCE_RESULT_LABELS[result]}）`, body: c.contractNo });
      onClose();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'error', title: '验收登记没收到结果', body: '记在付款计划上方的「结果待确认」里，查回或按原内容重新提交' });
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
      title={`登记验收 · ${c.contractNo}`}
      description={`验收标准：${c.content.acceptance.method || '合同里没写'}。合格放开验收段（服务、租赁、其他合同还放开到货段），质保从验收合格日起算的也按它。登记以后不能改，登错了作废。`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!!problem} onClick={() => void submit()} data-testid="acceptance-confirm">
            登记验收
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="验收日" htmlFor="ac-date">
          <Input id="ac-date" type="date" value={acceptedOn} max={session.calendarToday} onChange={(e) => setAcceptedOn(e.target.value)} className="h-10" />
        </Field>
        <Field label="结果" htmlFor="ac-result">
          <Select id="ac-result" value={result} onChange={(e) => setResult(e.target.value as AcceptanceResult)} data-testid="acceptance-result">
            <option value="pass">合格</option>
            <option value="fail">不合格</option>
          </Select>
        </Field>
        <Field label="签字人" htmlFor="ac-signer">
          <Input id="ac-signer" value={signer} maxLength={20} onChange={(e) => setSigner(e.target.value)} className="h-10" data-testid="acceptance-signer" />
        </Field>
        <Field label={result === 'fail' ? '怎么处理（必填）' : '说明（选填）'} htmlFor="ac-note" className="sm:col-span-3">
          <Textarea id="ac-note" rows={2} maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} data-testid="acceptance-note" />
        </Field>
      </div>
      {error && <Notice tone="error" title={error} className="mt-3" />}
    </Dialog>
  );
}

function IssueDialog({ open, c, onClose, onDone }: { open: boolean; c: ContractDetail; onClose: () => void; onDone: () => unknown }) {
  const session = useSession();
  const toast = useToast();
  const [foundOn, setFoundOn] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = `/api/erp/contracts/${c.id}/quality-issues`;
  const pending = useErpPending(['contract_quality']).filter((p) => p.url === url);
  useResetOnOpen(open, () => {
    setFoundOn(session.calendarToday);
    setDescription('');
    setError(null);
  });
  const problem = pending.length > 0 ? '上一条质量问题结果待确认，请先在上方处理' : !foundOn || foundOn > session.calendarToday ? '发现日不能晚于今天' : description.trim().length < 2 ? '请描述问题' : null;
  const submit = async () => {
    if (problem) return;
    setBusy(true);
    setError(null);
    const body = { clientKey: uuid(), foundOn, description: description.trim() };
    try {
      await sendErpOp({ key: body.clientKey, type: 'contract_quality', url, body, summary: `${c.contractNo} 质量问题：${body.description.slice(0, 40)}`, staffName: session.staff.displayName });
      toast({ tone: 'success', title: '已登记质量问题', body: `${c.contractNo}：处理完以前质保金不能付` });
      onClose();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'error', title: '质量问题没收到结果', body: '记在付款计划上方的「结果待确认」里，查回或按原内容重新提交' });
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
      title={`登记质量问题 · ${c.contractNo}`}
      description="有未处理的质量问题时质保金不能付；处理完以后标记「已处理」。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!!problem} onClick={() => void submit()} data-testid="quality-confirm">
            登记
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-[160px_minmax(0,1fr)]">
        <Field label="发现日" htmlFor="qi-date">
          <Input id="qi-date" type="date" value={foundOn} max={session.calendarToday} onChange={(e) => setFoundOn(e.target.value)} className="h-10" />
        </Field>
        <Field label="问题" htmlFor="qi-desc">
          <Input id="qi-desc" value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} className="h-10" data-testid="quality-description" />
        </Field>
      </div>
      {error && <Notice tone="error" title={error} className="mt-3" />}
    </Dialog>
  );
}

function ResolveDialog({ open, issue, busy, onClose, onConfirm }: { open: boolean; issue: QualityIssueView | null; busy: boolean; onClose: () => void; onConfirm: (body: { resolvedOn: string; resolution: string }) => void }) {
  const session = useSession();
  const [resolvedOn, setResolvedOn] = useState('');
  const [resolution, setResolution] = useState('');
  useResetOnOpen(open, () => {
    setResolvedOn(session.calendarToday);
    setResolution('');
  });
  const ok = !!issue && !!resolvedOn && resolvedOn <= session.calendarToday && resolvedOn >= issue.foundOn && resolution.trim().length >= 2;
  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title="标记已处理"
      description={issue ? `${issue.foundOn} 发现：${issue.description}` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!ok} onClick={() => onConfirm({ resolvedOn, resolution: resolution.trim() })} data-testid="quality-resolve-confirm">
            标记已处理
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-[160px_minmax(0,1fr)]">
        <Field label="处理日" htmlFor="qr-date">
          <Input id="qr-date" type="date" value={resolvedOn} min={issue?.foundOn} max={session.calendarToday} onChange={(e) => setResolvedOn(e.target.value)} className="h-10" />
        </Field>
        <Field label="处理结果" htmlFor="qr-res">
          <Input id="qr-res" value={resolution} maxLength={200} onChange={(e) => setResolution(e.target.value)} className="h-10" data-testid="quality-resolution" />
        </Field>
      </div>
    </Dialog>
  );
}
