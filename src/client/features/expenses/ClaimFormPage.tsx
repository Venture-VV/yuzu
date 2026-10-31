// 登记费用报销（v0.7.7，飞书需求 RQ-005）：按次报销，或按现付供应商的采购单报销。
// 用途、发票类型与税点、费用科目都是固定选项；有发票必须填发票号；购买与到货数量不一致要写原因；
// 单笔超过门槛（默认 2000 元）要负责人确认。
// 断网时「结果待确认」（v0.7.8 修正）：提交前把编号和原请求存在本机并读回核对，存不了就不提交；
// 刷新、关闭页面后仍在页面顶部查回、按原内容重新提交（同一编号不会重复登记）或确认作废。

import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { ArrowLeft, CircleAlert, CircleCheck, Plus, ReceiptText, Trash2 } from 'lucide-react';
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  PAY_SOURCE_LABELS,
  taxRateText,
  type ExpenseCategory,
  type ExpenseClaim,
  type PaySource,
} from '@shared/expenses';
import { centsToInput, formatAmount, parseYuan } from '@shared/money';
import { formatQty, parseQty } from '@shared/quantity';
import { ApiError, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, useErpPending } from '../../lib/erpPending';
import { useCan, useSession } from '../../lib/session';
import { cn, uuid } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { Money } from '../../components/Money';
import { useToast } from '../../components/Toast';
import { Button, Field, Input, MoneyInput, Notice, Segmented, Select, Skeleton } from '../../components/ui';
import { useDepartments } from '../inventory/queries';
import { useAdvances, useExpenseRules, useHandlers, useInvalidateExpenses, usePoCandidates, usePoForClaim } from './queries';

interface AdhocLine {
  key: string;
  name: string;
  category: ExpenseCategory | '';
  unit: string;
  bought: string;
  received: string;
  diffReason: string;
  amount: string;
}

const blankLine = (): AdhocLine => ({ key: uuid(), name: '', category: '', unit: '', bought: '1', received: '1', diffReason: '', amount: '' });

export function ClaimFormPage() {
  const can = useCan();
  const session = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const invalidate = useInvalidateExpenses();
  const [params] = useSearchParams();
  const rules = useExpenseRules();
  const departments = useDepartments();
  const handlers = useHandlers();

  const [mode, setMode] = useState<'adhoc' | 'po'>(params.get('po') ? 'po' : 'adhoc');
  const [expenseDate, setExpenseDate] = useState(session.calendarToday);
  const [departmentId, setDepartmentId] = useState<number | null>(Number(params.get('department')) || null);
  const [handlerId, setHandlerId] = useState<number | null>(session.staff.id);
  const [purpose, setPurpose] = useState('');
  const [paySource, setPaySource] = useState<PaySource>(params.get('advance') ? 'petty' : 'company');
  const [advanceId, setAdvanceId] = useState<number | null>(Number(params.get('advance')) || null);
  const [invoiceType, setInvoiceType] = useState('');
  const [taxRateBp, setTaxRateBp] = useState<number | null>(null);
  const [invoiceNo, setInvoiceNo] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<AdhocLine[]>([blankLine()]);
  const [poQuery, setPoQuery] = useState('');
  const [poId, setPoId] = useState<number | null>(Number(params.get('po')) || null);
  const [poPick, setPoPick] = useState<Record<number, { on: boolean; category: ExpenseCategory | ''; amount: string; diffReason: string }>>({});
  const [approveNow, setApproveNow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useErpPending(['expense_claim']);

  const advances = useAdvances({ departmentId: departmentId ? String(departmentId) : undefined, unsettled: '1' }, paySource === 'petty' && !!departmentId);
  const candidates = usePoCandidates(poQuery.trim(), mode === 'po' && !poId);
  const po = usePoForClaim(mode === 'po' ? poId : null);

  // 从打款进来：部门跟着打款
  const fromAdvance = advances.data?.find((a) => a.id === advanceId);
  useEffect(() => {
    if (fromAdvance && departmentId !== fromAdvance.department.id) setDepartmentId(fromAdvance.department.id);
  }, [fromAdvance, departmentId]);
  // 采购单载入后：每一行默认勾上（已报销的除外），金额按采购单
  useEffect(() => {
    if (!po.data) return;
    setPoPick(Object.fromEntries(po.data.lines.map((l) => [l.poLineId, { on: !l.claimedBy, category: '', amount: centsToInput(l.amountCents), diffReason: '' }])));
  }, [po.data]);

  const inv = rules.data?.invoiceTypes.find((t) => t.key === invoiceType);
  const adhocRows = lines.map((l) => {
    const bought = parseQty(l.bought);
    const received = parseQty(l.received);
    const cents = l.amount.trim() ? parseYuan(l.amount) : null;
    const differs = bought !== null && received !== null && bought !== received;
    const err = !l.name.trim()
      ? '请填写物品或内容'
      : !l.category
        ? '请选费用科目'
        : !l.unit.trim()
          ? '请填写单位'
          : bought === null || bought <= 0
            ? '购买数量不正确'
            : received === null
              ? '到货数量不正确'
              : differs && l.diffReason.trim().length < 2
                ? '数量不一致，请写原因'
                : cents === null || cents <= 0
                  ? '请填写金额'
                  : null;
    return { l, bought, received, cents, differs, err };
  });
  const poRows = (po.data?.lines ?? []).map((pl) => {
    const pick = poPick[pl.poLineId] ?? { on: false, category: '' as const, amount: '', diffReason: '' };
    const cents = pick.amount.trim() ? parseYuan(pick.amount) : null;
    const differs = pl.boughtMilli !== pl.receivedMilli;
    const err = !pick.on
      ? null
      : !pick.category
        ? '请选费用科目'
        : differs && pick.diffReason.trim().length < 2
          ? '数量不一致，请写原因'
          : cents === null || cents <= 0
            ? '请填写金额'
            : null;
    return { pl, pick, cents, differs, err };
  });
  const chosenPo = poRows.filter((r) => r.pick.on);
  const total = mode === 'adhoc' ? adhocRows.reduce((t, r) => t + (r.cents ?? 0), 0) : chosenPo.reduce((t, r) => t + (r.cents ?? 0), 0);
  const threshold = rules.data?.approvalThresholdCents ?? 200_000;
  const needsApproval = total > threshold;

  const blocking = pending.length > 0
    ? '上一笔报销结果待确认，请先在上方查回、重新提交或作废'
    : !departmentId
    ? '请选择部门'
    : !handlerId
      ? '请选择经办人'
      : !purpose
        ? '请选择用途'
        : paySource === 'petty' && !advanceId
          ? '请选择这笔钱出自哪一笔打款'
          : !inv
            ? '请选择发票类型'
            : taxRateBp === null
              ? '请选择税点'
              : inv.needsNumber && !invoiceNo.trim()
                ? `${inv.label}要填发票号码`
                : mode === 'po'
                  ? !poId
                    ? '请选择采购单'
                    : chosenPo.length === 0
                      ? '请勾选要报销的行'
                      : chosenPo.find((r) => r.err)?.err ?? null
                  : adhocRows.find((r) => r.err)?.err ?? null;

  if (!can('expense.manage')) return <Navigate to="/erp/expenses" replace />;

  const send = async (body: { clientKey: string } & Record<string, unknown>, summary: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await sendErpOp<{ claim: ExpenseClaim }>({ key: body.clientKey, type: 'expense_claim', url: '/api/erp/expenses', body, summary, staffName: session.staff.displayName });
      await invalidate();
      toast({
        tone: 'success',
        title: r.claim.status === 'confirmed' ? '报销已登记并确认' : '已提交，等待负责人确认',
        body: `${r.claim.docNo} · ¥${formatAmount(r.claim.amountCents)}`,
      });
      navigate(`/erp/expenses?claim=${r.claim.id}`);
    } catch (e) {
      // 结果待确认：记录留在本机，页面顶部可以查回、重新提交或作废（这里不另起一笔）
      if (!(e instanceof UncertainError)) {
        setError(errorMessage(e));
        if (e instanceof ApiError && (e.code === 'PO_CHANGED' || e.code === 'PO_LINE_CLAIMED')) void po.refetch();
      }
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    if (blocking) return;
    const payloadLines =
      mode === 'adhoc'
        ? adhocRows.map(({ l, bought, received, cents, differs }) => ({
            name: l.name.trim(),
            category: l.category,
            unit: l.unit.trim(),
            boughtMilli: bought,
            receivedMilli: received,
            diffReason: differs ? l.diffReason.trim() : '',
            amountCents: cents,
          }))
        : chosenPo.map(({ pl, pick, cents, differs }) => ({
            name: pl.name,
            category: pick.category,
            unit: pl.unit,
            boughtMilli: pl.boughtMilli,
            receivedMilli: pl.receivedMilli,
            diffReason: differs ? pick.diffReason.trim() : '',
            amountCents: cents,
            poLineId: pl.poLineId,
          }));
    const deptName = departments.data?.find((d) => d.id === departmentId)?.name ?? '';
    // 每次提交用新的操作编号：结果不明的那一笔留在本机，由页面顶部按原编号处理
    void send({
      clientKey: uuid(),
      expenseDate,
      departmentId,
      handlerId,
      purpose,
      paySource,
      advanceId: paySource === 'petty' ? advanceId : null,
      invoiceType,
      taxRateBp,
      invoiceNo: invoiceNo.trim(),
      purchaseOrderId: mode === 'po' ? poId : null,
      note: note.trim(),
      approveNow: needsApproval && approveNow,
      lines: payloadLines,
    }, `${deptName} · ${purpose} · ¥${formatAmount(total)}`);
  };

  const locked = busy;
  const setLine = (key: string, patch: Partial<AdhocLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const setPick = (id: number, patch: Partial<(typeof poPick)[number]>) => setPoPick((p) => ({ ...p, [id]: { ...p[id]!, ...patch } }));

  return (
    <>
      <PageHeader
        dateMode="calendar"
        title={
          <span className="flex items-center gap-2.5">
            <Link to="/erp/expenses" className="-ml-1 flex size-8 items-center justify-center rounded-md text-ink-3 hover:bg-paper-2 hover:text-ink" aria-label="返回费用报销">
              <ArrowLeft className="size-[18px]" />
            </Link>
            <span className="flex size-8 items-center justify-center rounded-full bg-lake-soft text-lake">
              <ReceiptText className="size-4" />
            </span>
            登记报销
          </span>
        }
        subtitle="一次支出登记成一张；按现付供应商的采购单报销时，购买与到货数量取系统里的"
      />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1080px] space-y-4 px-5 py-5 md:px-7" data-testid="claim-form">
          <ErpPendingPanel types={['expense_claim']} onFound={(_, ref) => navigate(`/erp/expenses?claim=${ref.refId}`)} />
          <Segmented
            ariaLabel="报销方式"
            value={mode}
            onChange={(v) => !locked && setMode(v)}
            options={[
              { value: 'adhoc', label: '按次报销' },
              { value: 'po', label: '按采购单报销（现付供应商）' },
            ]}
          />
          <section className="grid gap-4 rounded-lg border border-line bg-card p-5 shadow-card sm:grid-cols-2 lg:grid-cols-4">
            <Field label="支出日期" htmlFor="ex-date">
              <Input id="ex-date" type="date" value={expenseDate} max={session.calendarToday} disabled={locked} onChange={(e) => setExpenseDate(e.target.value)} className="h-10" />
            </Field>
            <Field label="部门" htmlFor="ex-dept">
              <Select
                id="ex-dept"
                value={departmentId ?? ''}
                disabled={locked}
                onChange={(e) => {
                  setDepartmentId(Number(e.target.value) || null);
                  setAdvanceId(null);
                }}
                data-testid="ex-dept"
              >
                <option value="">选择部门</option>
                {departments.data?.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="经办人" htmlFor="ex-handler">
              <Select id="ex-handler" value={handlerId ?? ''} disabled={locked} onChange={(e) => setHandlerId(Number(e.target.value) || null)} data-testid="ex-handler">
                <option value="">选择经办人</option>
                {handlers.data?.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="用途" htmlFor="ex-purpose">
              <Select id="ex-purpose" value={purpose} disabled={locked} onChange={(e) => setPurpose(e.target.value)} data-testid="ex-purpose">
                <option value="">选择用途</option>
                {rules.data?.purposes.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="钱从哪来" className="sm:col-span-2">
              <Segmented
                ariaLabel="付款来源"
                value={paySource}
                onChange={(v) => !locked && setPaySource(v)}
                options={(['petty', 'company'] as const).map((v) => ({ value: v, label: PAY_SOURCE_LABELS[v] }))}
              />
            </Field>
            {paySource === 'petty' && (
              <Field label="出自哪一笔打款" htmlFor="ex-adv" className="sm:col-span-2" hint={departmentId ? '只列这个部门没平账的打款' : '先选部门'}>
                <Select id="ex-adv" value={advanceId ?? ''} disabled={locked || !departmentId} onChange={(e) => setAdvanceId(Number(e.target.value) || null)} data-testid="ex-advance">
                  <option value="">选择打款</option>
                  {advances.data?.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.docNo} · {a.advanceDate} · {a.handler.name} · 打款 ¥{formatAmount(a.advanceCents)} · 未退回 ¥{formatAmount(a.outstandingCents)}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label="发票类型" htmlFor="ex-inv">
              <Select
                id="ex-inv"
                value={invoiceType}
                disabled={locked}
                onChange={(e) => {
                  setInvoiceType(e.target.value);
                  const t = rules.data?.invoiceTypes.find((x) => x.key === e.target.value);
                  setTaxRateBp(t && t.taxRatesBp.length === 1 ? t.taxRatesBp[0]! : null);
                }}
                data-testid="ex-invoice"
              >
                <option value="">选择发票类型</option>
                {rules.data?.invoiceTypes.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="税点" htmlFor="ex-tax">
              <Select id="ex-tax" value={taxRateBp ?? ''} disabled={locked || !inv} onChange={(e) => setTaxRateBp(e.target.value === '' ? null : Number(e.target.value))} data-testid="ex-tax">
                <option value="">{inv ? '选择税点' : '先选发票类型'}</option>
                {inv?.taxRatesBp.map((bp) => (
                  <option key={bp} value={bp}>
                    {taxRateText(bp)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="发票号码" htmlFor="ex-invno" hint={inv?.needsNumber ? '有发票必须填' : '没有发票可以不填'}>
              <Input id="ex-invno" value={invoiceNo} maxLength={40} disabled={locked} onChange={(e) => setInvoiceNo(e.target.value)} className="h-10" data-testid="ex-invoice-no" />
            </Field>
            <Field label="备注" htmlFor="ex-note">
              <Input id="ex-note" value={note} maxLength={200} disabled={locked} onChange={(e) => setNote(e.target.value)} placeholder="可选" className="h-10" />
            </Field>
          </section>

          {mode === 'adhoc' ? (
            <section className="rounded-lg border border-line bg-card shadow-card">
              <div className="flex items-center gap-3 border-b border-line px-5 py-3">
                <h2 className="text-[14px] font-bold">报销明细</h2>
                <span className="text-[12.5px] text-ink-3">费用科目只有办公费、固定资产、低值易耗；购买与到货数量不一致要写原因</span>
              </div>
              <div className="hidden grid-cols-[minmax(0,2fr)_130px_70px_80px_80px_120px_32px] gap-x-3 px-5 pt-3 text-[12px] font-semibold text-ink-3 md:grid">
                <span>物品或内容</span>
                <span>费用科目</span>
                <span>单位</span>
                <span className="text-right">购买数量</span>
                <span className="text-right">到货数量</span>
                <span className="text-right">金额</span>
                <span />
              </div>
              <ul className="divide-y divide-line/70">
                {adhocRows.map(({ l, differs, err }, i) => (
                  <li key={l.key} className="grid grid-cols-2 gap-x-3 gap-y-2 px-5 py-3 md:grid-cols-[minmax(0,2fr)_130px_70px_80px_80px_120px_32px]">
                    <Input aria-label={`第 ${i + 1} 行物品`} placeholder="物品或内容" value={l.name} maxLength={40} disabled={locked} onChange={(e) => setLine(l.key, { name: e.target.value })} className="col-span-2 h-10 md:col-span-1" data-testid={`line-name-${i}`} />
                    <Select aria-label={`第 ${i + 1} 行费用科目`} value={l.category} disabled={locked} onChange={(e) => setLine(l.key, { category: e.target.value as ExpenseCategory })} data-testid={`line-cat-${i}`}>
                      <option value="">费用科目</option>
                      {EXPENSE_CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {EXPENSE_CATEGORY_LABELS[c]}
                        </option>
                      ))}
                    </Select>
                    <Input aria-label={`第 ${i + 1} 行单位`} placeholder="单位" value={l.unit} maxLength={8} disabled={locked} onChange={(e) => setLine(l.key, { unit: e.target.value })} className="h-10" data-testid={`line-unit-${i}`} />
                    <Input aria-label={`第 ${i + 1} 行购买数量`} inputMode="decimal" value={l.bought} disabled={locked} onChange={(e) => setLine(l.key, { bought: e.target.value })} className="h-10 text-right" />
                    <Input aria-label={`第 ${i + 1} 行到货数量`} inputMode="decimal" value={l.received} disabled={locked} onChange={(e) => setLine(l.key, { received: e.target.value })} className="h-10 text-right" />
                    <MoneyInput aria-label={`第 ${i + 1} 行金额`} value={l.amount} disabled={locked} onChange={(e) => setLine(l.key, { amount: e.target.value })} className="h-10 text-right" data-testid={`line-amount-${i}`} />
                    <Button variant="ghost" size="sm" icon={<Trash2 className="size-4" />} disabled={locked || lines.length === 1} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label={`删除第 ${i + 1} 行`} />
                    {differs && (
                      <Input aria-label={`第 ${i + 1} 行差异原因`} placeholder="购买与到货数量不一致的原因" value={l.diffReason} maxLength={100} disabled={locked} onChange={(e) => setLine(l.key, { diffReason: e.target.value })} className="col-span-2 h-10 md:col-span-7" />
                    )}
                    {err && l.name.trim() && <p className="col-span-2 text-[12px] font-semibold text-clay md:col-span-7">{err}</p>}
                  </li>
                ))}
              </ul>
              <div className="border-t border-line px-5 py-3">
                <Button variant="secondary" size="sm" icon={<Plus className="size-4" />} disabled={locked || lines.length >= 50} onClick={() => setLines((ls) => [...ls, blankLine()])}>
                  加一行
                </Button>
              </div>
            </section>
          ) : (
            <section className="rounded-lg border border-line bg-card shadow-card">
              <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3">
                <h2 className="text-[14px] font-bold">采购单</h2>
                {poId && po.data ? (
                  <>
                    <span className="num text-[13.5px] font-bold">{po.data.docNo}</span>
                    <span className="text-[12.5px] text-ink-3">
                      {po.data.supplierName} · {po.data.orderDate}
                    </span>
                    <Button variant="ghost" size="sm" disabled={locked} onClick={() => setPoId(null)}>
                      换一张
                    </Button>
                  </>
                ) : (
                  <span className="text-[12.5px] text-ink-3">只列现付供应商已确认或已关闭的采购单；挂账的在「应付货款」里付款</span>
                )}
              </div>
              {!poId ? (
                <div className="space-y-3 p-5">
                  <Input placeholder="搜采购单号或供应商" value={poQuery} onChange={(e) => setPoQuery(e.target.value)} className="h-10" data-testid="po-search" />
                  {candidates.isPending ? (
                    <Skeleton className="h-24" />
                  ) : (candidates.data ?? []).length === 0 ? (
                    <EmptyState art="search" title="没有可以报销的采购单" className="py-6" />
                  ) : (
                    <ul className="divide-y divide-line/70 rounded-lg border border-line">
                      {candidates.data!.map((c) => (
                        <li key={c.id}>
                          <button type="button" disabled={c.openLines === 0} onClick={() => setPoId(c.id)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-paper-2 disabled:opacity-50" data-testid={`po-pick-${c.id}`}>
                            <span className="num font-bold">{c.docNo}</span>
                            <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">
                              {c.supplierName} · {c.orderDate}
                            </span>
                            <span className="text-[12px] text-ink-3">{c.openLines === 0 ? '已全部报销' : `${c.openLines} 行未报销`}</span>
                            <Money cents={c.totalCents} className="font-bold" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : po.isPending ? (
                <Skeleton className="m-5 h-32" />
              ) : po.error ? (
                <Notice tone="error" title={errorMessage(po.error)} className="m-5" />
              ) : (
                <ul className="divide-y divide-line/70">
                  {poRows.map(({ pl, pick, differs, err }) => (
                    <li key={pl.poLineId} className={cn('grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 px-5 py-3 md:grid-cols-[auto_minmax(0,1fr)_150px_130px_130px]', pick.on && 'bg-pine-tint/40')}>
                      <input type="checkbox" className="mt-1 size-4 accent-[var(--color-pine)]" aria-label={`报销 ${pl.name}`} checked={pick.on} disabled={locked || !!pl.claimedBy} onChange={(e) => setPick(pl.poLineId, { on: e.target.checked })} />
                      <span className="min-w-0">
                        <span className="block font-semibold">{pl.name}</span>
                        <span className={cn('block text-[12.5px]', differs ? 'font-semibold text-yuzu-deep' : 'text-ink-3')}>
                          购买 {formatQty(pl.boughtMilli)} {pl.unit} · 到货 {formatQty(pl.receivedMilli)} {pl.unit} · 采购单金额 ¥{formatAmount(pl.amountCents)}
                        </span>
                        {pl.claimedBy && <span className="block text-[12px] text-ink-3">已在报销单 {pl.claimedBy} 里</span>}
                      </span>
                      <Select aria-label={`${pl.name} 费用科目`} value={pick.category} disabled={locked || !pick.on} onChange={(e) => setPick(pl.poLineId, { category: e.target.value as ExpenseCategory })} className="col-start-2 md:col-start-auto">
                        <option value="">费用科目</option>
                        {EXPENSE_CATEGORIES.map((c) => (
                          <option key={c} value={c}>
                            {EXPENSE_CATEGORY_LABELS[c]}
                          </option>
                        ))}
                      </Select>
                      <MoneyInput aria-label={`${pl.name} 实付金额`} value={pick.amount} disabled={locked || !pick.on} onChange={(e) => setPick(pl.poLineId, { amount: e.target.value })} className="col-start-2 h-10 text-right md:col-start-auto" />
                      <span className="col-start-2 text-[12px] text-ink-3 md:col-start-auto md:self-center">实付金额，可与采购单不同</span>
                      {pick.on && differs && (
                        <Input aria-label={`${pl.name} 差异原因`} placeholder="购买与到货数量不一致的原因" value={pick.diffReason} maxLength={100} disabled={locked} onChange={(e) => setPick(pl.poLineId, { diffReason: e.target.value })} className="col-start-2 h-10 md:col-span-4" />
                      )}
                      {err && <p className="col-start-2 text-[12px] font-semibold text-clay md:col-span-4">{err}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {error && (
            <Notice tone="error" title={error} icon={<CircleAlert className="size-5" />}>
              报销没有登记，内容仍保留在页面上。
            </Notice>
          )}
        </div>
      </div>
      <footer className="shrink-0 border-t border-line bg-card/95 px-5 py-3 backdrop-blur md:px-7">
        <div className="mx-auto flex w-full max-w-[1080px] flex-wrap items-center gap-x-5 gap-y-2.5">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1">
            <span className="flex items-baseline gap-2">
              <span className="text-[12.5px] font-semibold text-ink-3">报销金额</span>
              <Money cents={total} className="text-[20px] font-bold text-lake" />
            </span>
            <span className={cn('text-[12.5px] font-semibold', needsApproval ? 'text-yuzu-deep' : 'text-pine')} data-testid="claim-approval-hint">
              {needsApproval ? `超过 ¥${formatAmount(threshold)}，提交后要负责人确认` : '不超过门槛，登记即确认'}
            </span>
            {blocking && <span className="text-[12.5px] font-semibold text-clay">{blocking}</span>}
          </div>
          {needsApproval && can('expense.approve') && (
            <label className="flex cursor-pointer items-center gap-2 text-[13px] font-semibold text-ink-2">
              <input type="checkbox" className="size-4 accent-[var(--color-pine)]" checked={approveNow} disabled={locked} onChange={(e) => setApproveNow(e.target.checked)} />
              同时以负责人身份确认
            </label>
          )}
          <Button variant="primary" size="lg" disabled={locked || !!blocking} loading={busy} icon={<CircleCheck className="size-[18px]" />} onClick={submit} data-testid="claim-submit">
            登记报销
          </Button>
        </div>
      </footer>
    </>
  );
}

