import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Banknote, CircleCheck, Clock3, Plus, ReceiptText, Ticket, Trash2, Undo2, UserRound, WalletCards } from 'lucide-react';
import {
  CHECKOUT_METHOD_LABELS,
  COUPON_CODE_PATTERN,
  COUPON_PLATFORM_LABELS,
  COUPON_PLATFORMS,
  normalizeCouponCode,
  priceTicket,
  type CheckoutDetail,
  type CheckoutMethod,
  type CheckoutPreview,
  type CouponPlatform,
} from '@shared/checkout';
import { splitDeduction } from '@shared/deduction';
import { ZONE_LABELS, type BoardTag, type VisitDetail } from '@shared/frontdesk';
import { maskPhone, PAYMENT_METHODS } from '@shared/labels';
import { centsToInput, parseYuan } from '@shared/money';
import { api, errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn, formatDateTime, formatTime } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Input, MoneyInput, Notice, Select, Skeleton, Textarea } from '../../components/ui';
import { PrintButton } from '../print/PrintButton';
import { ZoneChip } from './parts';
import { PendingPanel, useFrontdeskOp } from './pending';
import { stayText, useCheckout, useCheckoutPreview, useCheckouts, useRefreshFrontdesk, useTicketTypes } from './queries';

// 结账（S3）：勾选要一起结的手牌 → 核对门票与明细 → 登记收款（可组合）→ 确认结清。
// 应收合计、储值扣款构成以服务端为准：门票刚好跳档、余额或扣款规则变化时服务端拒绝，页面刷新后重新核对。

interface PayRow {
  id: number;
  method: CheckoutMethod;
  /** 金额（元，输入框原文） */
  amount: string;
  ref: string;
  member: { id: number; name: string; memberNo: string; principalBalance: number; bonusBalance: number; status: 'active' | 'frozen' } | null;
  platform: CouponPlatform;
  code: string;
  dealName: string;
  /** 现金：客人实给的金额（只用于计算找零，不登记） */
  tendered: string;
}

let paySeq = 1;
const newRow = (method: CheckoutMethod, amount: number): PayRow => ({
  id: paySeq++,
  method,
  amount: amount > 0 ? centsToInput(amount) : '',
  ref: '',
  member: null,
  platform: 'meituan',
  code: '',
  dealName: '',
  tendered: '',
});

const QUICK_METHODS: CheckoutMethod[] = ['wechat', 'alipay', 'cash', 'bank_card', 'other', 'wallet', 'coupon'];

export function CheckoutDialog({
  open,
  visit,
  tags,
  initialIds,
  onClose,
  onDone,
}: {
  open: boolean;
  visit: VisitDetail;
  tags: BoardTag[];
  /** 从预结账进入时带上已勾选的手牌 */
  initialIds?: number[];
  onClose: () => void;
  onDone: (detail: CheckoutDetail) => void;
}) {
  const session = useSession();
  const can = useCan();
  const [selected, setSelected] = useState<number[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [ticketPick, setTicketPick] = useState<Record<number, number>>({});
  const [rows, setRows] = useState<PayRow[]>([]);
  const [note, setNote] = useState('');
  const [result, setResult] = useState<CheckoutDetail | null>(null);
  const preview = useCheckoutPreview(selected, open && !result);
  const ticketTypes = useTicketTypes();
  const op = useFrontdeskOp<CheckoutDetail>({
    type: 'checkout',
    visitId: visit.id,
    staffName: session.staff.displayName,
    pick: (found) => (found.type === 'checkout' ? found.checkout : null),
  });

  useEffect(() => {
    if (!open) return;
    const mates = visit.group?.mates.filter((m) => m.status === 'open').map((m) => m.visitId) ?? [];
    setSelected(initialIds?.length ? initialIds : mates.length ? mates : [visit.id]);
    setShowAll(false);
    setTicketPick({});
    setRows([]);
    setNote('');
    setResult(null);
    op.clearError();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 服务端拒绝（门票跳档、余额变化）后重新取一次核对数据
  useEffect(() => {
    if (op.state.phase === 'error' && ['PRICE_CHANGED', 'SPLIT_CHANGED', 'INSUFFICIENT_BALANCE', 'TICKET_CHANGED'].includes(op.state.code ?? '')) {
      void preview.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [op.state]);

  const locked = op.locked;
  const edit = (fn: () => void) => {
    if (locked) return;
    op.clearError();
    fn();
  };

  const p = preview.data;
  const pricedAt = p ? new Date(p.pricedAt) : new Date();
  // 每位客人的应收：已挂明细 + 门票（没有票种的按补选的票种在页面先算，服务端再核对）
  const amounts = (p?.visits ?? []).map((v) => {
    if (!v.needsTicket) return v.amount;
    const t = ticketTypes.data?.find((x) => x.id === ticketPick[v.visitId]);
    return t ? v.linesAmount + priceTicket(t, v.checkedInAt, pricedAt, p!.graceMinutes).amount : null;
  });
  const total = p && amounts.every((a) => a !== null) ? amounts.reduce<number>((s, a) => s + a!, 0) : null;
  const rowCents = rows.map((r) => parseYuan(r.amount));
  const paid = rowCents.reduce<number>((s, c) => s + (c ?? 0), 0);
  const remaining = total === null ? null : total - paid;

  const splitOf = (r: PayRow, cents: number | null) =>
    r.member && cents && cents > 0
      ? splitDeduction(cents, { principal: r.member.principalBalance, bonus: r.member.bonusBalance }, session.rules.deductionRule)
      : null;
  const rowProblem = (r: PayRow, i: number): string | null => {
    const c = rowCents[i];
    if (c === null || c === undefined || c <= 0) return '请填写金额';
    if (r.method === 'wallet') {
      if (!r.member) return '请选择会员';
      // 改了勾选的手牌后，原来选的会员可能已不在本次结账里
      if (p && !p.members.some((m) => m.id === r.member!.id)) return '这位会员不在本次结账的客人里，请重新选择';
      if (r.member.status !== 'active') return '会员已停用';
      const s = splitOf(r, c);
      if (s && !s.ok) return `余额不足，还差 ¥${(s.shortfall / 100).toFixed(2)}`;
    }
    if (r.method === 'coupon' && !COUPON_CODE_PATTERN.test(normalizeCouponCode(r.code))) return '请填写完整券码';
    return null;
  };
  const problems = rows.map(rowProblem);
  const walletMembers = rows.filter((r) => r.method === 'wallet' && r.member).map((r) => r.member!.id);
  const dupWallet = new Set(walletMembers).size !== walletMembers.length;
  const ready = total !== null && remaining === 0 && problems.every((x) => x === null) && !dupWallet && !preview.isFetching;

  const addRow = (method: CheckoutMethod) =>
    edit(() => {
      const row = newRow(method, Math.max(0, remaining ?? 0));
      if (method === 'wallet') {
        const m = p?.members.find((x) => !rows.some((r) => r.member?.id === x.id));
        if (m) row.member = m;
      }
      setRows((list) => [...list, row]);
    });
  const update = (id: number, patch: Partial<PayRow>) => edit(() => setRows((list) => list.map((r) => (r.id === id ? { ...r, ...patch } : r))));

  const submit = async () => {
    if (!ready || !p) return;
    const visitIds = p.visits.map((v) => v.visitId);
    const tagCodes = p.visits.map((v) => v.tagCode);
    const payments = rows.map((r, i) => {
      const amount = rowCents[i]!;
      if (r.method === 'wallet') {
        const s = splitOf(r, amount);
        return { method: 'wallet' as const, memberId: r.member!.id, amount, expectedSplit: s && s.ok ? { principal: s.principal, bonus: s.bonus } : { principal: amount, bonus: 0 } };
      }
      if (r.method === 'coupon') return { method: 'coupon' as const, platform: r.platform, code: normalizeCouponCode(r.code), dealName: r.dealName.trim(), amount };
      return { method: r.method, amount, ref: r.ref.trim() };
    });
    const detail = await op.submit((key) => ({
      url: '/api/frontdesk/checkouts',
      body: {
        clientKey: key,
        visitIds,
        tickets: p.visits.filter((v) => v.needsTicket).map((v) => ({ visitId: v.visitId, ticketTypeId: ticketPick[v.visitId]! })),
        expectedTotal: total!,
        payments,
        note: note.trim(),
      },
      tagCodes,
      summary: `结账 ${tagCodes.length} 张（${[...new Set(rows.map((r) => CHECKOUT_METHOD_LABELS[r.method]))].join(' + ') || '免收'}）`,
      amount: total!,
      visitIds,
    }));
    if (detail) setResult(detail);
  };

  const inStore = tags.filter((t) => t.visit);
  const groupIds = new Set(visit.group?.mates.filter((m) => m.status === 'open').map((m) => m.visitId) ?? [visit.id]);
  const choices = inStore.filter((t) => showAll || groupIds.has(t.visit!.id) || selected.includes(t.visit!.id));
  const toggle = (id: number) => edit(() => setSelected((s) => (s.includes(id) ? (s.length > 1 ? s.filter((x) => x !== id) : s) : [...s, id])));
  const busy = op.busy;

  if (result) {
    return (
      <Dialog
        open={open}
        onClose={() => onDone(result)}
        width="max-w-xl"
        title={
          <span className="flex items-center gap-2 text-pine">
            <CircleCheck className="size-5" /> 已结清 · {result.checkoutNo}
          </span>
        }
        footer={
          <>
            <PrintButton path={`/print/checkout/${result.id}`} size="lg" testId="checkout-print">
              打印结账单
            </PrintButton>
            <Button variant="primary" size="lg" onClick={() => onDone(result)} data-testid="checkout-finish">
              完成
            </Button>
          </>
        }
      >
        <CheckoutReceipt detail={result} />
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      width="max-w-3xl"
      title={
        <span className="flex items-center gap-2">
          <Banknote className="size-5 text-pine" /> 结账
        </span>
      }
      description="勾选一起结的手牌，核对门票与明细后登记收款；收款合计等于应收才能结清，结清后手牌释放"
      footer={
        <>
          <span className="mr-auto self-center text-[13px] text-ink-3">
            {remaining === null ? (
              '请先为没有票种的客人选择票种'
            ) : remaining > 0 ? (
              <>
                还差 <Money cents={remaining} className="font-bold text-clay" />
              </>
            ) : remaining < 0 ? (
              <>
                多收 <Money cents={-remaining} className="font-bold text-clay" />（现金找零不用登记，按应收记）
              </>
            ) : (
              <span className="font-semibold text-pine">收款已等于应收</span>
            )}
          </span>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" size="lg" disabled={!ready || locked} loading={busy} onClick={submit} data-testid="checkout-submit">
            确认结清{total !== null ? ` ¥${(total / 100).toFixed(2)}` : ''}
          </Button>
        </>
      }
    >
      <PendingPanel op={op} onResolved={(d) => setResult(d)} />
      <div className="space-y-4" data-testid="checkout">
        {/* 手牌 */}
        <div>
          <div className="flex flex-wrap gap-1.5">
            {choices.map((t) => {
              const on = selected.includes(t.visit!.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(t.visit!.id)}
                  className={cn(
                    'flex h-10 items-center gap-1.5 rounded-full border px-3 text-[14px] font-bold',
                    on ? 'border-pine bg-pine text-paper' : 'border-line bg-card text-ink-2 hover:border-line-strong',
                  )}
                >
                  {on ? <CircleCheck className="size-4" /> : <span className="size-4 rounded-full border-2 border-line-strong" />}
                  <span className="num">{t.code}</span>
                  <span className="text-[11.5px] font-semibold opacity-70">{ZONE_LABELS[t.zone].short}</span>
                </button>
              );
            })}
          </div>
          {!showAll && inStore.length > choices.length && (
            <button type="button" onClick={() => setShowAll(true)} className="mt-2 text-[13px] font-semibold text-pine hover:underline">
              + 合并其他在店手牌（共 {inStore.length} 张在店）
            </button>
          )}
        </div>

        {/* 核对 */}
        {preview.isPending ? (
          <Skeleton className="h-40" />
        ) : preview.error ? (
          <Notice tone="error" title={errorMessage(preview.error)} />
        ) : (
          p && <ReviewTable preview={p} amounts={amounts} ticketPick={ticketPick} onPick={(id, t) => edit(() => setTicketPick((x) => ({ ...x, [id]: t })))} />
        )}

        {/* 收款 */}
        <div className="rounded-lg border border-line bg-paper/50 p-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[13px] font-bold text-ink-2">收款</span>
            {QUICK_METHODS.filter((m) => m !== 'wallet' || can('consume.create')).map((m) => (
              <Button key={m} size="sm" variant="secondary" icon={<Plus className="size-3.5" />} disabled={locked} onClick={() => addRow(m)} data-testid={`pay-add-${m}`}>
                {CHECKOUT_METHOD_LABELS[m]}
              </Button>
            ))}
          </div>
          {rows.length === 0 ? (
            <p className="mt-3 text-[13px] text-ink-3">{total === 0 ? '应收为 0（例如儿童免票），不用登记收款，直接确认结清。' : '点上面的收款方式添加一笔，金额默认为还差的部分；可组合多种方式。'}</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {rows.map((r, i) => (
                <PayRowEditor
                  key={r.id}
                  row={r}
                  cents={rowCents[i] ?? null}
                  problem={problems[i] ?? null}
                  members={p?.members ?? []}
                  split={splitOf(r, rowCents[i] ?? null)}
                  locked={locked}
                  onChange={(patch) => update(r.id, patch)}
                  onRemove={() => edit(() => setRows((list) => list.filter((x) => x.id !== r.id)))}
                />
              ))}
            </ul>
          )}
          {dupWallet && <p className="mt-2 text-[12.5px] font-semibold text-clay">同一位会员的储值支付请合并为一笔</p>}
        </div>

        <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="备注（选填）" maxLength={200} aria-label="结账备注" className="min-h-[44px]" />
        {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} />}
      </div>
    </Dialog>
  );
}

function ReviewTable({
  preview,
  amounts,
  ticketPick,
  onPick,
}: {
  preview: CheckoutPreview;
  amounts: (number | null)[];
  ticketPick: Record<number, number>;
  onPick: (visitId: number, ticketTypeId: number) => void;
}) {
  const ticketTypes = useTicketTypes();
  const total = amounts.every((a) => a !== null) ? amounts.reduce<number>((s, a) => s + a!, 0) : null;
  const now = new Date(preview.pricedAt).getTime();
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-card" data-testid="checkout-review">
      <ul className="divide-y divide-line/70">
        {preview.visits.map((v, i) => (
          <li key={v.visitId} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="num text-[17px] font-bold">{v.tagCode}</span>
              <ZoneChip zone={v.zone} />
              <span className="min-w-0 truncate text-[13px] text-ink-2">{v.memberName ? `会员 ${v.memberName}` : v.guestLabel || '散客'}</span>
              <span className="num flex items-center gap-1 text-[12.5px] text-ink-3">
                <Clock3 className="size-3.5" />
                {formatTime(v.checkedInAt)} 入场 · 在店 {stayText(v.checkedInAt, now)}
              </span>
              <span className="flex-1" />
              {amounts[i] !== null ? <Money cents={amounts[i]!} className="text-[16px] font-bold" /> : <span className="text-[12.5px] text-clay">待选票种</span>}
            </div>
            <div className="mt-1.5 space-y-0.5 pl-0.5 text-[12.5px] text-ink-2">
              {v.ticket ? (
                <p className="flex flex-wrap items-center gap-x-2" data-testid={`checkout-ticket-${v.tagCode}`}>
                  <Ticket className="size-3.5 text-pine" />
                  门票 · {v.ticket.name}（{v.ticket.tierLabel}）<Money cents={v.ticket.amount} className="font-semibold" />
                  <span className="text-ink-3">
                    {formatTime(v.ticket.nextJumpAt)} 后跳到 <Money cents={v.ticket.nextAmount} />
                  </span>
                </p>
              ) : (
                <p className="flex flex-wrap items-center gap-2">
                  <Ticket className="size-3.5 text-clay" />
                  <span className="font-semibold text-clay">还没有选票种，请补选：</span>
                  <Select
                    fullWidth={false}
                    value={String(ticketPick[v.visitId] ?? '')}
                    onChange={(e) => onPick(v.visitId, Number(e.target.value))}
                    className="h-8 w-[160px] text-[13px]"
                    aria-label={`${v.tagCode} 票种`}
                  >
                    <option value="" disabled>
                      选择票种
                    </option>
                    {ticketTypes.data?.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </Select>
                </p>
              )}
              {v.lines.map((l) => (
                <p key={l.id} className="flex items-baseline gap-2 pl-5">
                  <span className="min-w-0 flex-1 truncate">
                    {l.name} × {l.quantity}
                  </span>
                  <Money cents={l.amount} className="text-ink-3" />
                </p>
              ))}
            </div>
          </li>
        ))}
      </ul>
      <div className="flex items-end justify-between gap-3 border-t border-line bg-paper/60 px-4 py-3">
        <p className="text-[12px] text-ink-3">
          {preview.visits.length} 张手牌 · 按 {formatTime(preview.pricedAt)} 计算门票{preview.graceMinutes ? `（跳档宽限 ${preview.graceMinutes} 分钟）` : ''}
        </p>
        <div className="text-right">
          <p className="text-[12px] text-ink-3">应收合计</p>
          <span data-testid="checkout-total">{total !== null ? <Money cents={total} className="text-[28px] font-bold text-pine" /> : <span className="text-[14px] text-clay">待选票种</span>}</span>
        </div>
      </div>
    </div>
  );
}

function PayRowEditor({
  row,
  cents,
  problem,
  members,
  split,
  locked,
  onChange,
  onRemove,
}: {
  row: PayRow;
  cents: number | null;
  problem: string | null;
  members: CheckoutPreview['members'];
  split: ReturnType<typeof splitDeduction> | null;
  locked: boolean;
  onChange: (patch: Partial<PayRow>) => void;
  onRemove: () => void;
}) {
  const tendered = parseYuan(row.tendered);
  return (
    <li className={cn('rounded-lg border bg-card p-3', problem ? 'border-clay/40' : 'border-line')} data-testid={`pay-row-${row.method}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={row.method === 'wallet' ? 'pine' : row.method === 'coupon' ? 'yuzu' : 'neutral'} className="h-7 px-3 text-[13px]">
          {row.method === 'wallet' ? <WalletCards className="size-3.5" /> : row.method === 'coupon' ? <Ticket className="size-3.5" /> : null}
          {CHECKOUT_METHOD_LABELS[row.method]}
        </Badge>
        <div className="w-[150px]">
          <MoneyInput value={row.amount} onChange={(e) => onChange({ amount: e.target.value })} disabled={locked} aria-label={`${CHECKOUT_METHOD_LABELS[row.method]}金额`} className="h-10" />
        </div>
        {(PAYMENT_METHODS as readonly string[]).includes(row.method) && (
          <Input
            fullWidth={false}
            value={row.ref}
            onChange={(e) => onChange({ ref: e.target.value })}
            placeholder={row.method === 'cash' ? '备注（选填）' : '单号后几位（选填）'}
            maxLength={64}
            disabled={locked}
            className="h-10 min-w-0 flex-1 basis-32"
            aria-label="收款备注"
          />
        )}
        {row.method === 'coupon' && (
          <>
            <Select fullWidth={false} value={row.platform} onChange={(e) => onChange({ platform: e.target.value as CouponPlatform })} disabled={locked} className="h-10 w-[120px]" aria-label="团购平台">
              {COUPON_PLATFORMS.map((pl) => (
                <option key={pl} value={pl}>
                  {COUPON_PLATFORM_LABELS[pl]}
                </option>
              ))}
            </Select>
            <Input
              fullWidth={false}
              value={row.code}
              onChange={(e) => onChange({ code: e.target.value.toUpperCase() })}
              onBlur={() => onChange({ code: normalizeCouponCode(row.code) })}
              placeholder="完整券码"
              disabled={locked}
              className="num h-10 min-w-0 flex-1 basis-40 font-semibold tracking-wide"
              aria-label="完整券码"
              data-testid="coupon-code"
            />
          </>
        )}
        <span className="flex-1" />
        <button type="button" aria-label="移除这笔收款" onClick={onRemove} disabled={locked} className="flex size-9 items-center justify-center rounded-md text-ink-3 hover:bg-clay-soft hover:text-clay disabled:opacity-40">
          <Trash2 className="size-4" />
        </button>
      </div>

      {row.method === 'coupon' && (
        <Input value={row.dealName} onChange={(e) => onChange({ dealName: e.target.value })} placeholder="团购项目（选填，例如「不含餐 12 小时」）" maxLength={48} disabled={locked} className="mt-2 h-9 text-[13px]" aria-label="团购项目" />
      )}

      {row.method === 'cash' && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
          客人实给
          <div className="w-[120px]">
            <MoneyInput value={row.tendered} onChange={(e) => onChange({ tendered: e.target.value })} className="h-8 text-[13px]" aria-label="客人实给现金" />
          </div>
          {tendered !== null && cents !== null && tendered >= cents && (
            <span className="font-semibold text-ink-2">
              找零 <Money cents={tendered - cents} className="font-bold text-pine" />（找零不用登记）
            </span>
          )}
        </div>
      )}

      {row.method === 'wallet' &&
        (row.member ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-pine-tint px-3 py-2 text-[12.5px]">
            <UserRound className="size-3.5 text-pine" />
            <span className="font-bold text-ink">{row.member.name}</span>
            <span className="num text-ink-3">{row.member.memberNo}</span>
            <span className="text-ink-2">
              本金 <Money cents={row.member.principalBalance} /> · 赠金 <Money cents={row.member.bonusBalance} />
            </span>
            {split?.ok && (
              <span className="font-semibold text-pine" data-testid="wallet-split">
                将扣本金 <Money cents={split.principal} /> · 赠金 <Money cents={split.bonus} />
              </span>
            )}
            <span className="flex-1" />
            {members.length > 1 && (
              <Select
                fullWidth={false}
                value={String(row.member.id)}
                onChange={(e) => onChange({ member: members.find((m) => m.id === Number(e.target.value)) ?? row.member })}
                disabled={locked}
                className="h-8 w-[130px] text-[12.5px]"
                aria-label="换一位会员"
              >
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
            )}
            <Button size="sm" variant="ghost" disabled={locked} onClick={() => onChange({ member: null })}>
              换人
            </Button>
          </div>
        ) : (
          // 只能用本次结账客人里的会员储值（服务端同样核对）；会员替朋友付，把朋友的手牌合并进本次结账
          <div className="mt-2" data-testid="wallet-members">
            <p className="text-[12.5px] text-ink-3">
              {members.length ? '选择付款会员：' : '本次结账的客人里没有会员。'}只能用本次结账客人里的会员储值支付；同行朋友请合并到同一张结账单
            </p>
            {members.length > 0 && (
              <ul className="mt-1 space-y-0.5">
                {members.map((m) => (
                  <MemberPick key={m.id} m={m} onPick={() => onChange({ member: m })} />
                ))}
              </ul>
            )}
          </div>
        ))}
      {problem && <p className="mt-1.5 text-[12.5px] font-semibold text-clay">{problem}</p>}
    </li>
  );
}

function MemberPick({ m, onPick }: { m: { name: string; memberNo: string; principalBalance: number; bonusBalance: number; phone?: string }; onPick: () => void }) {
  return (
    <li>
      <button type="button" onClick={onPick} className="flex w-full items-center gap-3 rounded-md px-3 py-1.5 text-left text-[13px] hover:bg-card">
        <span className="min-w-0 flex-1 truncate font-semibold">{m.name}</span>
        {m.phone && <span className="num text-ink-3">{maskPhone(m.phone)}</span>}
        <span className="num text-ink-3">
          余额 <Money cents={m.principalBalance + m.bonusBalance} />
        </span>
      </button>
    </li>
  );
}

/** 结账单：所结手牌、门票与收款明细 */
export function CheckoutReceipt({ detail }: { detail: CheckoutDetail }) {
  return (
    <div className="space-y-3" data-testid="checkout-receipt">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
        <ReceiptText className="size-4" />
        <span className="num font-semibold text-ink-2">{detail.checkoutNo}</span>
        <span>
          {formatDateTime(detail.createdAt)} · {detail.operatorName}
        </span>
        {detail.status === 'voided' && <Badge tone="clay">已反结账</Badge>}
      </div>
      {detail.status === 'voided' && (
        <Notice tone="warning" icon={<Undo2 className="size-4" />} title={`${detail.voidedByName ?? ''} 于 ${detail.voidedAt ? formatDateTime(detail.voidedAt) : ''} 反结账`}>
          {detail.voidReason}。储值消费已按原单撤销，团购券登记已作废，客人恢复为在店未结。
        </Notice>
      )}
      <div className="overflow-hidden rounded-lg border border-line">
        <table className="w-full text-[13px]">
          <thead className="bg-paper-2 text-[12px] text-ink-3">
            <tr>
              <th className="px-3 py-2 text-left font-semibold">手牌</th>
              <th className="px-3 py-2 text-left font-semibold">门票</th>
              <th className="px-3 py-2 text-right font-semibold">金额</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/70">
            {detail.bills.map((b) => (
              <tr key={b.billId}>
                <td className="px-3 py-2">
                  <span className="num font-bold">{b.tagCode}</span> <span className="text-ink-3">{b.memberName ?? (b.guestLabel || '散客')}</span>
                </td>
                <td className="px-3 py-2 text-ink-2">
                  {b.ticketName} · {b.ticketSegments === 1 ? '12 小时档' : `${b.ticketSegments} 段`} <Money cents={b.ticketAmount} className="text-ink-3" />
                  <span className="block text-[11.5px] text-ink-3">在店 {Math.floor(b.stayMinutes / 60)} 时 {b.stayMinutes % 60} 分</span>
                </td>
                <td className="px-3 py-2 text-right">
                  <Money cents={b.amount} className="font-bold" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="space-y-1 border-t border-line bg-paper/60 px-3 py-2.5 text-[13px]">
          {detail.payments.length === 0 && <p className="text-ink-3">应收为 0，未收款</p>}
          {detail.payments.map((pm) => (
            <p key={pm.id} className="flex flex-wrap items-baseline gap-2">
              <span className="font-semibold">{CHECKOUT_METHOD_LABELS[pm.method]}</span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">
                {pm.method === 'wallet' && pm.consumption
                  ? `${pm.memberName ?? ''} · ${pm.consumption.docNo} · 本金 ¥${(pm.consumption.principal / 100).toFixed(2)} / 赠金 ¥${(pm.consumption.bonus / 100).toFixed(2)}${pm.consumption.status === 'reversed' ? '（已撤销）' : ''}`
                  : pm.method === 'coupon' && pm.coupon
                    ? `${COUPON_PLATFORM_LABELS[pm.coupon.platform]} ${pm.coupon.code}${pm.coupon.dealName ? ` · ${pm.coupon.dealName}` : ''}${pm.coupon.status === 'voided' ? '（已作废）' : ''}`
                    : pm.ref}
              </span>
              <Money cents={pm.amount} className="font-bold" />
            </p>
          ))}
          <p className="flex items-baseline justify-between border-t border-dashed border-line pt-1.5">
            <span className="font-bold">合计</span>
            <Money cents={detail.totalAmount} className="text-[20px] font-bold text-pine" />
          </p>
        </div>
      </div>
      {detail.remainingMates.length > 0 && detail.status === 'completed' && (
        <p className="text-[12.5px] text-ink-3">同行组里还有 {detail.remainingMates.join('、')} 在店，离店时另行结账。</p>
      )}
    </div>
  );
}

/** 今日结账记录：查看结账单、反结账 */
export function CheckoutRecordsDialog({ open, onClose, focusId }: { open: boolean; onClose: () => void; focusId?: number | null }) {
  const session = useSession();
  const list = useCheckouts(session.today, open);
  const [openId, setOpenId] = useState<number | null>(focusId ?? null);
  useEffect(() => {
    if (open) setOpenId(focusId ?? null);
  }, [open, focusId]);
  return (
    <Dialog open={open} onClose={onClose} width="max-w-2xl" title="结账记录" description={`营业日 ${session.today} 的结账单（含当天反结账的）`}>
      {openId ? (
        <CheckoutDetailView id={openId} onBack={() => setOpenId(null)} />
      ) : list.isPending ? (
        <Skeleton className="h-40" />
      ) : (list.data ?? []).length === 0 ? (
        <EmptyState art="calm" title="今天还没有结账" description="在账单上点「结账」后，结账单会出现在这里。" />
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line" data-testid="checkout-records">
          {list.data!.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => setOpenId(c.id)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-paper-2/60">
                <span className="num font-bold">{c.checkoutNo}</span>
                <span className="num text-[13px] font-semibold text-ink-2">{c.tagCodes.join('、')}</span>
                <span className="text-[12.5px] text-ink-3">
                  {formatTime(c.createdAt)} · {c.operatorName} · {(c.methods ?? []).map((m) => CHECKOUT_METHOD_LABELS[m]).join(' + ') || '免收'}
                </span>
                <span className="flex-1" />
                {c.status === 'voided' && <Badge tone="clay">已反结账</Badge>}
                <Money cents={c.totalAmount} className={cn('font-bold', c.status === 'voided' && 'line-through opacity-60')} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

function CheckoutDetailView({ id, onBack }: { id: number; onBack: () => void }) {
  const detail = useCheckout(id);
  const can = useCan();
  const toast = useToast();
  const qc = useQueryClient();
  const refresh = useRefreshFrontdesk();
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const d = detail.data;
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post<CheckoutDetail>(`/api/frontdesk/checkouts/${id}/void`, { reason: reason.trim() });
      toast({ tone: 'success', title: `已反结账 ${d?.checkoutNo ?? ''}`, body: '客人恢复为在店未结，可更正后重新结账' });
      setVoiding(false);
      void qc.invalidateQueries({ queryKey: ['frontdesk'] });
      void qc.invalidateQueries({ queryKey: ['member'] });
      refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <Button size="sm" variant="ghost" onClick={onBack}>
        ← 返回列表
      </Button>
      {!d ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          <CheckoutReceipt detail={d} />
          <PrintButton path={`/print/checkout/${d.id}`} testId="checkout-reprint">
            打印结账单
          </PrintButton>
          {d.status === 'completed' && can('frontdesk.checkoutVoid') && !voiding && (
            <Button variant="secondary" icon={<Undo2 className="size-4" />} onClick={() => setVoiding(true)} data-testid="checkout-void">
              反结账
            </Button>
          )}
          {voiding && (
            <div className="space-y-2 rounded-lg border border-clay/30 bg-clay-soft/40 p-3">
              <p className="text-[13px] text-ink-2">反结账后：储值消费按原单撤销，团购券登记作废，门票明细作废，客人恢复为在店未结（手牌须仍空闲）。</p>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="反结账原因（至少 2 个字），例如：收款方式记错" maxLength={200} aria-label="反结账原因" />
              <div className="flex gap-2">
                <Button variant="danger" disabled={reason.trim().length < 2} loading={busy} onClick={() => void run()} data-testid="checkout-void-confirm">
                  确认反结账
                </Button>
                <Button variant="ghost" onClick={() => setVoiding(false)} disabled={busy}>
                  取消
                </Button>
              </div>
              {error && <Notice tone="error" title={error} />}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** 改票种（在店期间）：之后结账按新票种（选定时的票价）计算门票 */
export function TicketDialog({ open, visit, onClose, onDone }: { open: boolean; visit: VisitDetail; onClose: () => void; onDone: (v: VisitDetail) => void }) {
  const types = useTicketTypes();
  const [pick, setPick] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setPick(visit.ticket?.typeId ?? null);
      setError(null);
    }
  }, [open, visit]);
  const options = useMemo(() => types.data ?? [], [types.data]);
  const run = async () => {
    if (!pick) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await api.post<VisitDetail>(`/api/frontdesk/visits/${visit.id}/ticket`, { ticketTypeId: pick }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title={`${visit.ticket ? '改票种' : '选择票种'} · ${visit.tag.code}`}
      description="门票离店结账时按在店时长计算：每 12 小时跳一档（12 小时档 → 24 小时档 → 24 + 12 …）"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" disabled={!pick || pick === visit.ticket?.typeId} loading={busy} onClick={() => void run()} data-testid="ticket-confirm">
            确认
          </Button>
        </>
      }
    >
      <ul className="space-y-2" role="radiogroup" aria-label="票种">
        {options.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              role="radio"
              aria-checked={pick === t.id}
              onClick={() => setPick(t.id)}
              className={cn(
                'flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left',
                pick === t.id ? 'border-pine bg-pine-tint' : 'border-line bg-card hover:border-line-strong',
              )}
            >
              <Ticket className={cn('size-4', pick === t.id ? 'text-pine' : 'text-ink-3')} />
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-bold">{t.name}</span>
                {t.note && <span className="block text-[12px] text-ink-3">{t.note}</span>}
              </span>
              <span className="num text-right text-[12.5px] text-ink-2">
                {t.price12h || t.price24h ? (
                  <>
                    12 小时 <Money cents={t.price12h} className="font-bold" /> · 24 小时 <Money cents={t.price24h} className="font-bold" />
                  </>
                ) : (
                  '免票'
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {error && <Notice tone="error" title={error} className="mt-3" />}
    </Dialog>
  );
}
