// 发起付款申请 / 改了再提交（v0.7.32，docs/PAYMENTS.md 第 3 节）：
//   · 合同的某一段：选合同与付款节点，看这一段的计划、现在可付、在途申请、已付与说明；申请金额超过可付的要勾「提前付款」写原因；
//   · 没挂合同的应付：选供应商，再选这家没结清的收货单、期初未付与各自金额（挂合同的收货单要从合同申请）。
// 新建先把操作编号和原请求存在本机（结果待确认时在付款页上方查回、重提或作废）；改了再提交带打开时的版本号。

import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { ArrowLeft, Send } from 'lucide-react';
import { PAYMENT_STAGES, PAYMENT_STAGE_LABELS, type PaymentStage } from '@shared/contracts';
import { formatAmount, parseYuan } from '@shared/money';
import { nextPayDay, payDaysLabel, type PaymentRequestDetail } from '@shared/payments';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, useErpPending } from '../../lib/erpPending';
import { useCan, useSession } from '../../lib/session';
import { cn, uuid } from '../../lib/utils';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { Money } from '../../components/Money';
import { useToast } from '../../components/Toast';
import { Button, Card, Field, Input, MoneyInput, Notice, Select, Skeleton, Textarea } from '../../components/ui';
import { useErpAccess } from '../erp/access';
import { ErpPage } from '../erp/ErpHome';
import { useInvalidatePayments, usePaymentMeta, usePaymentPlan, usePaymentRequest, usePaymentRules, useRequestableItems } from './queries';

export function PaymentRequestFormPage() {
  const can = useCan();
  const [params] = useSearchParams();
  const editId = Number(params.get('edit')) || null;
  const existing = usePaymentRequest(editId);
  if (!can('payment.request')) return <Navigate to="/erp/payments" replace />;
  return (
    <ErpPage
      title={editId ? `改了再提交 ${existing.data?.requestNo ?? ''}` : '发起付款申请'}
      description="提交即走审批中心（财务 → 负责人；超过可付的按「提前付款」多一级店主）；批了以后由对账付款的人登记付款。"
      actions={
        <Link to={editId ? `/erp/payments/requests/${editId}` : '/erp/payments'} className="flex items-center gap-1 text-[13px] font-semibold text-ink-3 hover:text-ink">
          <ArrowLeft className="size-4" />
          {editId ? '回到申请' : '回到付款'}
        </Link>
      }
    >
      {editId ? (
        existing.isPending ? (
          <Skeleton className="h-80" />
        ) : existing.error ? (
          <Notice tone="error" title={errorMessage(existing.error)} />
        ) : existing.data!.status !== 'returned' ? (
          <Notice tone="warning" title="这张申请不在「已退回」，不能改了再提交">
            <Link to={`/erp/payments/requests/${editId}`} className="font-semibold text-lake">
              回到申请看状态
            </Link>
          </Notice>
        ) : (
          <Form existing={existing.data!} />
        )
      ) : (
        <Form existing={null} />
      )}
    </ErpPage>
  );
}

type Source = 'contract' | 'payables';

function Form({ existing }: { existing: PaymentRequestDetail | null }) {
  const session = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const access = useErpAccess();
  const invalidate = useInvalidatePayments();
  const [params] = useSearchParams();
  const meta = usePaymentMeta();
  // 打开表单时的版本号：改了再提交按它发（别人改过就拒绝，不覆盖）
  const [opened] = useState(() => ({ version: existing?.version ?? 0 }));
  const contractsOn = access.modules.includes('contracts');
  const [source, setSource] = useState<Source>(existing ? (existing.contractId ? 'contract' : 'payables') : params.get('supplier') || !contractsOn ? 'payables' : 'contract');
  const [contractId, setContractId] = useState<number | null>(existing?.contractId ?? (Number(params.get('contract')) || null));
  const [stage, setStage] = useState<PaymentStage>(existing?.stage ?? (PAYMENT_STAGES.find((s) => s === params.get('stage')) as PaymentStage | undefined) ?? 'prepay');
  const [supplierId, setSupplierId] = useState<number | null>(existing?.supplierId ?? (Number(params.get('supplier')) || null));
  const [amount, setAmount] = useState(existing ? (existing.amountCents / 100).toFixed(2) : '');
  const [targets, setTargets] = useState<Record<string, string>>(
    existing ? Object.fromEntries(existing.targets.map((t) => [`${t.kind}:${t.targetId}`, (t.amountCents / 100).toFixed(2)])) : {},
  );
  const [expectedDate, setExpectedDate] = useState(existing && existing.expectedDate >= session.calendarToday ? existing.expectedDate : session.calendarToday);
  // 固定付款日（8.0.17，LC7）：新建的申请默认取下一个付款日（今天就是付款日取今天）；自己改过日期、修改已有申请的不动
  const rules = usePaymentRules();
  const [dateTouched, setDateTouched] = useState(false);
  const payDay = rules.data ? nextPayDay(session.calendarToday, rules.data.payDays) : null;
  useEffect(() => {
    if (!existing && !dateTouched && payDay) setExpectedDate(payDay);
  }, [existing, dateTouched, payDay]);
  const [purpose, setPurpose] = useState(existing?.purpose ?? '');
  const [earlyReason, setEarlyReason] = useState(existing?.earlyReason ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plan = usePaymentPlan(source === 'contract' ? contractId : null);
  const items = useRequestableItems(source === 'payables' ? supplierId : null);
  const pending = useErpPending(['payment_request']);

  const st = plan.data?.stages.find((s) => s.stage === stage) ?? null;
  // 改了再提交时，这张申请自己占着的额度不算
  const own = existing && existing.contractId === contractId && existing.stage === stage ? existing.amountCents - existing.paidCents : 0;
  const remaining = st ? Math.max(0, st.plannedCents - (st.requestedCents - own) - st.paidCents) : 0;
  const available = st ? Math.max(0, Math.min(st.payableCents, st.plannedCents) - (st.requestedCents - own) - st.paidCents) : 0;
  const amountCents = amount.trim() ? parseYuan(amount) : null;
  const early = source === 'contract' && amountCents !== null && amountCents > available;

  const rows = useMemo(
    () =>
      (items.data ?? [])
        .filter((i) => i.openCents > 0 || targets[`${i.kind}:${i.id}`])
        .map((i) => {
          const key = `${i.kind}:${i.id}`;
          const mineHere = existing?.targets.find((t) => `${t.kind}:${t.targetId}` === key)?.amountCents ?? 0;
          const room = i.openCents - Math.max(0, i.requestedCents - mineHere);
          const text = targets[key] ?? '';
          const cents = text.trim() ? parseYuan(text) : null;
          return { i, key, room, text, cents, blocked: i.contractNo ? `挂在合同 ${i.contractNo} 下，从合同申请` : !i.hasPo ? '急采还没补采购单' : null };
        }),
    [items.data, targets, existing],
  );
  const chosen = rows.filter((r) => r.text.trim());
  const targetsTotal = chosen.reduce((s, r) => s + (r.cents ?? 0), 0);

  // 提示按页面上从上到下的顺序：先合同 / 供应商与金额，再期望付款日与用途
  const sourceProblem =
    source === 'contract'
      ? !contractId
        ? '请选择合同'
        : !st
          ? '正在读付款计划…'
          : !plan.data!.canRequest
            ? plan.data!.whyNot ?? '这份合同现在不能申请'
            : st.plannedCents === 0
              ? '这一段比例为 0，不用付'
              : !amountCents
                ? '请填写申请金额'
                : amountCents > remaining
                  ? `这一段最多还能申请 ¥${formatAmount(remaining)}`
                  : early && earlyReason.trim().length < 2
                    ? '超过现在可付的，要写提前付款的原因'
                    : null
      : !supplierId
        ? '请选择供应商'
        : chosen.length === 0
          ? '请选择要付的货款并填金额'
          : chosen.some((r) => r.blocked)
            ? '选了不能从这里申请的货款'
            : chosen.some((r) => !r.cents || r.cents > r.room)
              ? '有金额格式不对或超过能申请的'
              : null;
  const problem =
    !existing && pending.length > 0
      ? '上一张付款申请结果待确认，请先在上方查回、按原内容重新提交或作废'
      : (sourceProblem ??
        (expectedDate < session.calendarToday
          ? '期望付款日不能早于今天'
          : purpose.trim().length < 2
            ? '请写明用途（至少 2 个字）'
            : null));

  const submit = async () => {
    if (problem) return;
    setBusy(true);
    setError(null);
    const common = { expectedDate, purpose: purpose.trim(), early, earlyReason: early ? earlyReason.trim() : '' };
    const targetList = chosen.map((r) => ({ kind: r.i.kind, targetId: r.i.id, amountCents: r.cents }));
    try {
      if (existing) {
        await api.post(`/api/erp/payments/requests/${existing.id}/resubmit`, {
          version: opened.version,
          ...common,
          ...(source === 'contract' ? { amountCents } : { targets: targetList }),
        });
        toast({ tone: 'success', title: '已重新提交，等审批', body: existing.requestNo });
        await invalidate();
        navigate(`/erp/payments/requests/${existing.id}`);
        return;
      }
      const body = {
        clientKey: uuid(),
        ...common,
        source: source === 'contract' ? { kind: 'contract', contractId, stage, amountCents } : { kind: 'payables', supplierId, targets: targetList },
      };
      const summary =
        source === 'contract'
          ? `${plan.data?.contractNo ?? '合同'} ${PAYMENT_STAGE_LABELS[stage]}款 ¥${formatAmount(amountCents!)}${early ? '（提前付款）' : ''}`
          : `${meta.data?.suppliers.find((s) => s.id === supplierId)?.name ?? '供应商'} 应付 ${chosen.length} 笔 ¥${formatAmount(targetsTotal)}`;
      const r = await sendErpOp<{ request: PaymentRequestDetail }>({ key: body.clientKey, type: 'payment_request', url: '/api/erp/payments/requests', body, summary, staffName: session.staff.displayName });
      toast({ tone: 'success', title: '付款申请已提交，等审批', body: `${r.request.requestNo} · ¥${formatAmount(r.request.amountCents)}` });
      await invalidate();
      navigate(`/erp/payments/requests/${r.request.id}`);
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'error', title: '没收到结果', body: existing ? '刷新后看状态（带了版本号，重复提交不会多走一次）' : '记在上方「结果待确认」里，查回或按原内容重新提交' });
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {!existing && <ErpPendingPanel types={['payment_request']} onFound={(_, ref) => navigate(`/erp/payments/requests/${ref.refId}`)} />}
      {!existing && (
        <div className="flex gap-1.5" role="radiogroup" aria-label="从哪里发起">
          {(
            [
              ['contract', '合同的付款节点'],
              ['payables', '没挂合同的应付'],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={source === v}
              disabled={v === 'contract' && !contractsOn}
              onClick={() => setSource(v)}
              className={cn('h-9 rounded-full px-4 text-[13.5px] font-semibold disabled:opacity-40', source === v ? 'bg-ink text-paper' : 'bg-paper-2 text-ink-2 hover:bg-paper-3')}
              data-testid={`request-source-${v}`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {source === 'contract' ? (
        <Card className="space-y-3 p-5">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px]">
            <Field label="合同" htmlFor="rq-contract">
              <Select id="rq-contract" value={contractId ?? ''} disabled={!!existing} onChange={(e) => setContractId(Number(e.target.value) || null)} data-testid="request-contract">
                <option value="">选择合同（已签署的）</option>
                {(meta.data?.contracts ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.contractNo} · {c.title} · {c.counterparty}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="付款节点" htmlFor="rq-stage">
              <Select id="rq-stage" value={stage} disabled={!!existing} onChange={(e) => setStage(e.target.value as PaymentStage)} data-testid="request-stage">
                {PAYMENT_STAGES.map((s) => (
                  <option key={s} value={s}>
                    {PAYMENT_STAGE_LABELS[s]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {contractId && plan.isPending && <Skeleton className="h-16" />}
          {plan.error && <Notice tone="error" title={errorMessage(plan.error)} />}
          {st && (
            <div className="rounded-lg border border-line bg-paper-2/40 px-4 py-3 text-[13px]" data-testid="request-stage-plan">
              <p className="flex flex-wrap gap-x-4 gap-y-1">
                <span>
                  计划 <Money cents={st.plannedCents} className="font-bold" />
                </span>
                <span>
                  现在可付 <Money cents={st.payableCents} className="font-bold" />
                </span>
                <span>
                  在途申请 <Money cents={Math.max(0, st.requestedCents - own)} />
                </span>
                <span>
                  已付 <Money cents={st.paidCents} />
                </span>
                <span>
                  照常能申请 <Money cents={available} className="font-bold text-pine" />
                </span>
              </p>
              <p className="mt-1 text-ink-2">{st.reason}</p>
              {!plan.data!.canRequest && <p className="mt-1 font-semibold text-clay">{plan.data!.whyNot}</p>}
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="申请金额" htmlFor="rq-amount">
              <MoneyInput id="rq-amount" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="request-amount" />
            </Field>
            {st && available > 0 && (
              <div className="flex items-end">
                <Button size="sm" variant="ghost" onClick={() => setAmount((available / 100).toFixed(2))}>
                  按照常能申请的填（¥{formatAmount(available)}）
                </Button>
              </div>
            )}
          </div>
          {early && (
            <Field label="提前付款原因（超过现在可付的部分，多审一级店主）" htmlFor="rq-early">
              <Textarea id="rq-early" rows={2} maxLength={200} value={earlyReason} onChange={(e) => setEarlyReason(e.target.value)} data-testid="request-early-reason" />
            </Field>
          )}
        </Card>
      ) : (
        <Card className="space-y-3 p-5">
          <Field label="供应商" htmlFor="rq-supplier">
            <Select id="rq-supplier" value={supplierId ?? ''} disabled={!!existing} onChange={(e) => (setSupplierId(Number(e.target.value) || null), setTargets({}))} data-testid="request-supplier">
              <option value="">选择供应商</option>
              {(meta.data?.suppliers ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          {supplierId && items.isPending && <Skeleton className="h-24" />}
          {supplierId && items.data && (
            rows.length === 0 ? (
              <p className="text-[13px] text-ink-3">这家供应商没有没结清的货款。</p>
            ) : (
              <table className="w-full text-[13px]" data-testid="request-items">
                <thead>
                  <tr className="border-b border-line text-left text-[12px] text-ink-3">
                    <th className="py-1.5 pr-2 font-semibold">单号</th>
                    <th className="py-1.5 pr-2 font-semibold">日期</th>
                    <th className="py-1.5 pr-2 text-right font-semibold">没结清</th>
                    <th className="py-1.5 pr-2 text-right font-semibold">别的申请占着</th>
                    <th className="w-36 py-1.5 font-semibold">申请</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/70">
                  {rows.map((r) => (
                    <tr key={r.key} className={cn(r.blocked && 'text-ink-3')}>
                      <td className="py-1.5 pr-2">
                        <span className="num font-semibold">{r.i.docNo}</span>
                        <span className="block text-[11.5px] text-ink-3">{r.blocked ?? r.i.summary}</span>
                      </td>
                      <td className="num py-1.5 pr-2">{r.i.date}</td>
                      <td className="py-1.5 pr-2 text-right">
                        <Money cents={r.i.openCents} />
                      </td>
                      <td className="py-1.5 pr-2 text-right">{r.i.requestedCents ? <Money cents={r.i.requestedCents} /> : <span className="text-ink-4">·</span>}</td>
                      <td className="py-1.5">
                        {r.blocked ? (
                          <span className="text-[12px]">—</span>
                        ) : (
                          <MoneyInput aria-label={`申请 ${r.i.docNo}`} value={r.text} onChange={(e) => setTargets((t) => ({ ...t, [r.key]: e.target.value }))} data-testid={`request-item-${r.i.docNo}`} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}
          {chosen.length > 0 && (
            <p className="text-[13px]">
              合计 <Money cents={targetsTotal} className="font-bold" />（选的收货单要三单对得上：先登记发票，差额大的请财务放行）
            </p>
          )}
        </Card>
      )}

      <Card className="grid gap-3 p-5 sm:grid-cols-[180px_minmax(0,1fr)]">
        <Field label="期望付款日" htmlFor="rq-date">
          <Input
            id="rq-date"
            type="date"
            value={expectedDate}
            min={session.calendarToday}
            onChange={(e) => {
              setDateTouched(true);
              setExpectedDate(e.target.value);
            }}
            className="h-10"
            data-testid="request-expected"
          />
          {rules.data && rules.data.payDays.length > 0 && (
            <p className="mt-1 text-[12px] text-ink-3" data-testid="request-payday-hint">
              {payDaysLabel(rules.data.payDays)}付款{payDay ? `，下个付款日 ${payDay}` : ''}
            </p>
          )}
        </Field>
        <Field label="用途" htmlFor="rq-purpose">
          <Input id="rq-purpose" value={purpose} maxLength={200} onChange={(e) => setPurpose(e.target.value)} placeholder="例如：洗浴用品年度采购预付款" className="h-10" data-testid="request-purpose" />
        </Field>
      </Card>

      {error && <Notice tone="error" title={error} />}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" icon={<Send className="size-4" />} loading={busy} disabled={!!problem} onClick={() => void submit()} data-testid="request-submit">
          {existing ? '重新提交' : early ? '提交（提前付款）' : '提交付款申请'}
        </Button>
        {problem && <span className="text-[12.5px] font-semibold text-ember">{problem}</span>}
      </div>
    </div>
  );
}
