// 退款单（v0.7.20，飞书 RQ-006；docs/CASHIER.md 第 3 节）：在「结账记录」里对已结的单按项部分退款，以及这张单的退款单列表（作废、打印）。
//   · 按项目选（同名项目合并成一行）：份数默认全退，金额默认按份数比例退实收，可以改小；份数可以填 0（只退钱）；
//   · 按原收款方式退：只列原单收过的现金类方式与还能退多少；扫码、银行卡登记商户后台的退款单号，「其他」写明怎么退的；
//   · 退现金选钱箱（与反结账同一套）；不退现金时记到自己的班次（要先开班）；
//   · 带操作编号，断网走「结果待确认」（查回、原样重提、确认作废）。

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ReceiptText, Undo2 } from 'lucide-react';
import { defaultRefundAmount, refundNeedsRef, type RefundDetail, type RefundMethod, type RefundOptions, type RefundSummary, CHECKOUT_METHOD_LABELS, type CheckoutMethod } from '@shared/checkout';
import { PAYMENT_METHOD_LABELS } from '@shared/labels';
import { centsToInput, formatYuan, parseYuan } from '@shared/money';
import { api, errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn, formatTime } from '../../lib/utils';
import { Money } from '../../components/Money';
import { useToast } from '../../components/Toast';
import { Badge, Button, Input, MoneyInput, Notice, Skeleton } from '../../components/ui';
import { PrintButton } from '../print/PrintButton';
import { NetPrintButton } from '../print/NetPrintButton';
import { SHIFT_ERRORS, shiftKeys, ShiftGate } from '../shift/ShiftGate';
import { PendingPanel, useFrontdeskOp } from './pending';

const keyOf = (i: { category: string; name: string }) => `${i.category}\u0000${i.name}`;
/** 自动分配退款方式时的顺序：现金在前，其余按原单收的 */
const METHOD_ORDER: RefundMethod[] = ['cash', 'wechat', 'alipay', 'bank_card', 'other'];

export function RefundPanel({ checkoutId, checkoutNo, onClose, DrawerPicker }: {
  checkoutId: number;
  checkoutNo: string;
  onClose: () => void;
  /** 退现金的钱箱（与反结账同一个选择器） */
  DrawerPicker: (props: { options: RefundOptions['drawers']; value: number | null; onChange: (id: number) => void; onRefetch: () => void }) => React.ReactNode;
}) {
  const session = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const options = useQuery({
    queryKey: ['frontdesk', 'refund-options', checkoutId],
    queryFn: () => api.get<RefundOptions>(`/api/frontdesk/checkouts/${checkoutId}/refund-options`),
  });
  const op = useFrontdeskOp<RefundDetail>({
    type: 'checkout_refund',
    visitId: null,
    checkoutId,
    staffName: session.staff.displayName,
    pick: (found) => (found.type === 'checkout_refund' ? found.refund : null),
  });
  const [picked, setPicked] = useState<Record<string, { quantity: string; amount: string }>>({});
  const [pays, setPays] = useState<Partial<Record<RefundMethod, { amount: string; ref: string }>>>({});
  const [paysTouched, setPaysTouched] = useState(false);
  const [reason, setReason] = useState('');
  const [drawer, setDrawer] = useState<number | null>(null);
  const o = options.data;

  const items = useMemo(() => (o?.items ?? []).filter((i) => i.remainingAmount > 0), [o]);
  const total = items.reduce((s, i) => s + (picked[keyOf(i)] ? (parseYuan(picked[keyOf(i)]!.amount) ?? 0) : 0), 0);
  const methods = useMemo(() => (o?.methods ?? []).filter((m) => m.remaining > 0).sort((a, b) => METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method)), [o]);
  // 退款方式没动过时按顺序自动分配：现金在前，每种不超过还能退的
  useEffect(() => {
    if (paysTouched || !methods.length) return;
    let left = total;
    const next: Partial<Record<RefundMethod, { amount: string; ref: string }>> = {};
    for (const m of methods) {
      const take = Math.min(left, m.remaining);
      next[m.method] = { amount: take > 0 ? centsToInput(take) : '', ref: pays[m.method]?.ref ?? '' };
      left -= take;
    }
    setPays(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [total, methods, paysTouched]);
  useEffect(() => {
    const d = o?.drawers;
    if (d) setDrawer((cur) => (cur !== null && d.shifts.some((x) => x.id === cur) ? cur : d.suggested));
  }, [o?.drawers]);

  const payCents = (m: RefundMethod) => parseYuan(pays[m]?.amount ?? '') ?? 0;
  const paysTotal = methods.reduce((s, m) => s + payCents(m.method), 0);
  const cash = payCents('cash');
  const problems: string[] = [];
  for (const i of items) {
    const p = picked[keyOf(i)];
    if (!p) continue;
    const q = Number(p.quantity);
    const a = parseYuan(p.amount);
    if (!Number.isInteger(q) || q < 0 || q > i.remainingQuantity) problems.push(`「${i.name}」最多还能退 ${i.remainingQuantity} 份`);
    if (a === null || a <= 0) problems.push(`请填写「${i.name}」退的金额`);
    else if (a > i.remainingAmount) problems.push(`「${i.name}」最多还能退 ${formatYuan(i.remainingAmount)}`);
    // 退几份最多退这几份的实收（服务端同样核对）；份数 0 只退钱，只受整项剩下的金额限制
    else if (Number.isInteger(q) && q > 0 && q <= i.remainingQuantity && a > defaultRefundAmount(i, q)) {
      problems.push(`「${i.name}」退 ${q} 份最多退 ${formatYuan(defaultRefundAmount(i, q))}；只退钱不退份数请把份数填 0`);
    }
  }
  for (const m of methods) {
    const c = payCents(m.method);
    if (c > m.remaining) problems.push(`${PAYMENT_METHOD_LABELS[m.method]}最多还能退 ${formatYuan(m.remaining)}`);
    if (c > 0 && refundNeedsRef(m.method) && (pays[m.method]?.ref.trim().length ?? 0) < 2) {
      problems.push(m.method === 'other' ? '「其他」退款请写明是怎么退的' : `${PAYMENT_METHOD_LABELS[m.method]}退款请登记商户后台的退款单号`);
    }
  }
  if (total > 0 && paysTotal !== total) problems.push(`退款方式合计 ${formatYuan(paysTotal)}，要等于退的项目合计 ${formatYuan(total)}`);
  const ready = !o?.blocked && total > 0 && problems.length === 0 && reason.trim().length >= 2 && (cash === 0 || drawer !== null) && !op.locked;

  const done = (r: RefundDetail) => {
    const cashPart = r.payments.find((p) => p.method === 'cash')?.amount ?? 0;
    toast({
      tone: 'success',
      title: `已开退款单 ${r.refundNo}`,
      body: `退 ${formatYuan(r.amount)}${cashPart ? `，其中现金 ${formatYuan(cashPart)} 计入${r.shift ? ` ${r.shift.staffName} ` : ''}当班的交班表` : ''}；扫码、银行卡请确认已在商户后台原路退回`,
    });
    void qc.invalidateQueries({ queryKey: ['frontdesk'] });
    void qc.invalidateQueries({ queryKey: shiftKeys.all });
    void qc.invalidateQueries({ queryKey: ['settlement'] });
    onClose();
  };
  const submit = async () => {
    if (!ready || !o) return;
    const body = {
      items: items.filter((i) => picked[keyOf(i)]).map((i) => ({ category: i.category, name: i.name, quantity: Number(picked[keyOf(i)]!.quantity), amount: parseYuan(picked[keyOf(i)]!.amount)! })),
      payments: methods.filter((m) => payCents(m.method) > 0).map((m) => ({ method: m.method, amount: payCents(m.method), ref: pays[m.method]?.ref.trim() ?? '' })),
      reason: reason.trim(),
      ...(cash > 0 && drawer !== null ? { refundShiftId: drawer } : {}),
    };
    const r = await op.submit((key) => ({
      url: `/api/frontdesk/checkouts/${checkoutId}/refunds`,
      body: { clientKey: key, ...body },
      tagCodes: [],
      summary: `退款 · 结账单 ${checkoutNo}`,
      amount: total,
    }));
    if (r) done(r);
  };
  useEffect(() => {
    if (op.state.phase === 'error' && (op.state.code ?? '').startsWith('REFUND')) void options.refetch();
    if (op.state.phase === 'error' && SHIFT_ERRORS.includes(op.state.code ?? '')) void qc.invalidateQueries({ queryKey: shiftKeys.all });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [op.state]);

  if (op.pending) {
    return (
      <div className="rounded-lg border border-yuzu-deep/30 bg-yuzu-tint/50 p-3" data-testid="refund-pending">
        <PendingPanel op={op} onResolved={done} />
      </div>
    );
  }
  return (
    <div className="space-y-3 rounded-lg border border-ember/30 bg-ember-soft/30 p-3" data-testid="refund-panel">
      <p className="text-[13px] text-ink-2">
        按项目退：选要退的项目与份数，金额默认退这几份的实收（应收减分摊的优惠、券抵扣），可以改小；份数填 0 表示只退钱。按原收款方式退，储值、团购券、优惠与券抵扣不能部分退，要整单撤回请用反结账。
      </p>
      {options.isPending ? (
        <Skeleton className="h-32" />
      ) : options.error ? (
        <Notice tone="error" title={errorMessage(options.error)} />
      ) : o!.blocked ? (
        <Notice tone="warning" title={o!.blocked.message} />
      ) : (
        <>
          <ul className="divide-y divide-line rounded-md border border-line bg-card" data-testid="refund-items">
            {items.map((i) => {
              const k = keyOf(i);
              const p = picked[k];
              return (
                <li key={k} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 text-[13px]">
                  <label className="flex min-w-0 flex-1 basis-56 cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={!!p}
                      disabled={op.locked}
                      onChange={(e) =>
                        setPicked((cur) => {
                          const next = { ...cur };
                          if (e.target.checked) next[k] = { quantity: String(i.remainingQuantity), amount: centsToInput(i.remainingAmount) };
                          else delete next[k];
                          return next;
                        })
                      }
                      className="size-4 accent-pine"
                      data-testid={`refund-item-${i.name}`}
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-semibold">{i.name}</span>
                      <span className="block text-[12px] text-ink-3">
                        {i.category} · {i.quantity} 份 · 实收 {formatYuan(i.amount - i.discount)}
                        {i.refundedAmount > 0 ? ` · 已退 ${i.refundedQuantity} 份 ${formatYuan(i.refundedAmount)}` : ''} · 还能退 {formatYuan(i.remainingAmount)}
                      </span>
                    </span>
                  </label>
                  {p && (
                    <span className="flex items-center gap-2">
                      <Input
                        fullWidth={false}
                        type="number"
                        min={0}
                        max={i.remainingQuantity}
                        value={p.quantity}
                        disabled={op.locked}
                        onChange={(e) => {
                          const q = e.target.value;
                          const n = Number(q);
                          setPicked((cur) => ({
                            ...cur,
                            [k]: { quantity: q, amount: Number.isInteger(n) && n >= 0 && n <= i.remainingQuantity ? centsToInput(defaultRefundAmount(i, n === 0 ? i.remainingQuantity : n)) : cur[k]!.amount },
                          }));
                        }}
                        className="h-9 w-[72px] text-[13px]"
                        aria-label={`${i.name}退的份数`}
                      />
                      <span className="text-[12px] text-ink-3">份</span>
                      <div className="w-[120px]">
                        <MoneyInput
                          value={p.amount}
                          disabled={op.locked}
                          onChange={(e) => setPicked((cur) => ({ ...cur, [k]: { ...cur[k]!, amount: e.target.value } }))}
                          className="h-9 text-[13px]"
                          aria-label={`${i.name}退的金额`}
                        />
                      </div>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {o!.nonRefundable.length > 0 && (
            <p className="text-[12.5px] text-ink-3">
              原单另有 {o!.nonRefundable.map((n) => `${CHECKOUT_METHOD_LABELS[n.method as CheckoutMethod] ?? n.method} ${formatYuan(n.amount)}`).join('、')}，不能部分退。
            </p>
          )}
          <div className="space-y-2 rounded-md border border-line bg-card p-3" data-testid="refund-methods">
            <p className="flex items-baseline justify-between text-[13px] font-bold text-ink-2">
              <span>退款方式（按原收款方式）</span>
              <span>
                退款合计 <Money cents={total} className="text-[16px] font-bold text-ember" />
              </span>
            </p>
            {methods.map((m) => (
              <div key={m.method} className="flex flex-wrap items-center gap-2 text-[13px]">
                <Badge tone={m.method === 'cash' ? 'pine' : 'neutral'} className="h-7 w-[64px] justify-center">
                  {PAYMENT_METHOD_LABELS[m.method]}
                </Badge>
                <div className="w-[120px]">
                  <MoneyInput
                    value={pays[m.method]?.amount ?? ''}
                    disabled={op.locked}
                    onChange={(e) => {
                      setPaysTouched(true);
                      setPays((cur) => ({ ...cur, [m.method]: { amount: e.target.value, ref: cur[m.method]?.ref ?? '' } }));
                    }}
                    className="h-9 text-[13px]"
                    aria-label={`${PAYMENT_METHOD_LABELS[m.method]}退款`}
                  />
                </div>
                <span className="text-[12px] text-ink-3">还能退 {formatYuan(m.remaining)}</span>
                {refundNeedsRef(m.method) && (
                  <Input
                    fullWidth={false}
                    value={pays[m.method]?.ref ?? ''}
                    disabled={op.locked}
                    onChange={(e) => setPays((cur) => ({ ...cur, [m.method]: { amount: cur[m.method]?.amount ?? '', ref: e.target.value } }))}
                    placeholder={m.method === 'other' ? '写明怎么退的' : '商户后台的退款单号'}
                    maxLength={64}
                    className="h-9 min-w-0 flex-1 basis-40 text-[13px]"
                    aria-label={`${PAYMENT_METHOD_LABELS[m.method]}退款单号`}
                  />
                )}
              </div>
            ))}
          </div>
          {cash > 0 ? (
            <DrawerPicker options={o!.drawers} value={drawer} onChange={setDrawer} onRefetch={() => void options.refetch()} />
          ) : (
            total > 0 && <ShiftGate action="退款" />
          )}
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="退款原因（至少 2 个字），例如：按摩没做完、客人投诉" maxLength={200} disabled={op.locked} aria-label="退款原因" />
          {problems.length > 0 && total > 0 && (
            <ul className="space-y-0.5 text-[12.5px] font-semibold text-clay">
              {problems.slice(0, 4).map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </>
      )}
      <div className="flex gap-2">
        <Button variant="danger" icon={<Undo2 className="size-4" />} disabled={!ready} loading={op.busy} onClick={() => void submit()} data-testid="refund-confirm">
          确认退款 {total > 0 ? formatYuan(total) : ''}
        </Button>
        <Button variant="ghost" onClick={onClose} disabled={op.busy}>
          取消
        </Button>
      </div>
      {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} />}
      {op.state.phase === 'uncertain' && <Notice tone="warning" title={op.state.message} />}
    </div>
  );
}

/** 这张结账单的退款单：当天、钱箱还没交班的可以作废（写原因）；可以打印退款凭条 */
export function RefundsList({ refunds, onChanged }: { refunds: RefundSummary[]; onChanged: () => void }) {
  const can = useCan();
  const session = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [voiding, setVoiding] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (refunds.length === 0) return null;
  const run = async (r: RefundSummary) => {
    setBusy(true);
    setError(null);
    try {
      await api.post<RefundDetail>(`/api/frontdesk/refunds/${r.id}/void`, { reason: reason.trim() });
      toast({ tone: 'success', title: `已作废退款单 ${r.refundNo}`, body: '交班、日结与部门营业额都不再算这张；钱已经退出去的请核对是否收回' });
      setVoiding(null);
      setReason('');
      void qc.invalidateQueries({ queryKey: ['frontdesk'] });
      void qc.invalidateQueries({ queryKey: shiftKeys.all });
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-lg border border-line" data-testid="refunds-list">
      <p className="flex items-center gap-1.5 border-b border-line bg-paper-2/50 px-3 py-2 text-[13px] font-bold text-ink-2">
        <ReceiptText className="size-4" /> 退款单
      </p>
      <ul className="divide-y divide-line">
        {refunds.map((r) => (
          <li key={r.id} className="space-y-2 px-3 py-2 text-[13px]">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="num font-bold">{r.refundNo}</span>
              <span className="text-[12.5px] text-ink-3">
                {formatTime(r.createdAt)} · {r.operatorName} · {r.methods.map((m) => PAYMENT_METHOD_LABELS[m]).join(' + ')} · {r.reason}
              </span>
              <span className="flex-1" />
              {r.status === 'voided' && <Badge tone="clay">已作废</Badge>}
              <Money cents={r.amount} className={cn('font-bold text-ember', r.status === 'voided' && 'line-through opacity-60')} />
            </div>
            <div className="flex flex-wrap gap-2">
              <PrintButton path={`/print/refund/${r.id}`} testId={`refund-print-${r.refundNo}`}>
                打印退款凭条
              </PrintButton>
              <NetPrintButton doc={{ type: 'refund', id: r.id }} docName="退款单" testId={`refund-netprint-${r.refundNo}`} />
              {r.status === 'completed' && r.businessDate === session.today && can('frontdesk.refund') && voiding !== r.id && (
                <Button size="sm" variant="ghost" onClick={() => setVoiding(r.id)} data-testid={`refund-void-${r.refundNo}`}>
                  作废这张退款单
                </Button>
              )}
            </div>
            {voiding === r.id && (
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  fullWidth={false}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="作废原因（至少 2 个字），例如：金额登记错了"
                  maxLength={200}
                  className="h-9 min-w-0 flex-1 basis-56 text-[13px]"
                  aria-label="作废退款单原因"
                />
                <Button size="sm" variant="danger" disabled={reason.trim().length < 2} loading={busy} onClick={() => void run(r)} data-testid="refund-void-confirm">
                  确认作废
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setVoiding(null)} disabled={busy}>
                  取消
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {error && <Notice tone="error" title={error} className="m-3" />}
    </div>
  );
}
