import { useState } from 'react';
import { REVENUE_REFRESH_MS, useBusinessToday } from '../../lib/revenue';
import { useCheckoutDaySummary } from '../frontdesk/queries';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck, Clock3, Coins, LogOut, Undo2, Users } from 'lucide-react';
import { CHECKOUT_METHOD_LABELS, COUPON_PLATFORM_LABELS, type ShiftRecord, type ShiftSummary } from '@shared/checkout';
import { PAYMENT_METHOD_LABELS } from '@shared/labels';
import { parseYuan } from '@shared/money';
import { api, errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { formatYuan } from '@shared/money';
import { cn, formatDateTime, formatTime } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, MoneyInput, Notice, SectionTitle, Skeleton } from '../../components/ui';
import { PrintButton } from '../print/PrintButton';
import { NetPrintButton } from '../print/NetPrintButton';
import { CrossDayShiftNotice, shiftKeys, StartShiftForm, useCurrentShift, useDrawerBoard } from './ShiftGate';

// 交班（店主 #11，2026-10-29 签认）：开班登记备用金 → 当班期间系统按本人经办的结账与充值汇总 → 交班时实点现金，记下长款 / 短款。
// 结账收款算在收款时的班次；反结账退的现金算在执行反结账的人当时的班次、扣减应有现金（同一钱箱的人合并核对时相抵）。

export function ShiftPage() {
  const session = useSession();
  const can = useCan();
  const current = useCurrentShift();
  // 8.0.8（A02）：「今天」跟着服务端的营业日走；班次列表每 15 秒刷新；没开班时收的结账单独提示（不在任何交班里）
  const today = useBusinessToday();
  const list = useQuery({ queryKey: shiftKeys.list(today), queryFn: () => api.get<ShiftRecord[]>(`/api/shifts?date=${today}`), refetchInterval: REVENUE_REFRESH_MS });
  const summary = useCheckoutDaySummary(today, can('frontdesk.read'), true);
  const shift = current.data?.shift ?? null;
  return (
    <>
      <PageHeader title="交班" subtitle={`营业日 ${today} · ${session.staff.displayName} · 每 15 秒自动刷新`} />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[960px] space-y-5 px-5 py-6 md:px-7">
          <CrossDayShiftNotice />
          {(summary.data?.unshifted.count ?? 0) > 0 && (
            <Notice tone="warning" title={`今天有 ${summary.data!.unshifted.count} 笔结账（${formatYuan(summary.data!.unshifted.total)}）收款时没有开班`} data-testid="shift-unshifted">
              这几笔不在任何交班的合计里（日结照常算进营业额），对账时请单独核对。
            </Notice>
          )}
          {current.isPending ? <Skeleton className="h-48" /> : shift ? <OpenShift shift={shift} /> : <StartShift />}
          <Card className="p-5">
            <SectionTitle>今天的班次</SectionTitle>
            {list.isPending ? (
              <Skeleton className="mt-3 h-24" />
            ) : (list.data ?? []).length === 0 ? (
              <EmptyState art="calm" title="今天还没有班次" description="开班后，交班表会记在这里。" />
            ) : (
              <ul className="mt-3 divide-y divide-line rounded-lg border border-line" data-testid="shift-list">
                {list.data!.map((s) => (
                  <ShiftRow key={s.id} s={s} />
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

function StartShift() {
  const session = useSession();
  const drawerMode = useDrawerBoard().data?.mode === 'drawer';
  return (
    <Card className="p-5" data-testid="shift-start">
      <SectionTitle>开班</SectionTitle>
      <p className="mt-1 text-[13px] text-ink-3">
        {drawerMode
          ? '按钱箱交班：选你所在的钱箱，已经开班的点「加入」，还没开班的登记抽屉里的备用金后开班；交班时按这个钱箱所有人经办的结账与充值汇总，算出应有现金。'
          : '登记抽屉里的备用金后开始当班；交班时系统按你经办的结账与充值汇总各收款方式，算出应有现金。'}
        {session.rules.requireOpenShift ? '充值、结账、反结账前都要先开班。' : ''}
      </p>
      <StartShiftForm />
    </Card>
  );
}

/** 按钱箱交班：班次上的人（加入、离开的时间） */
function MembersLine({ shift }: { shift: ShiftRecord }) {
  if (!shift.drawerName) return null;
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[12.5px] text-ink-3" data-testid="shift-members">
      <Users className="size-3.5" /> 在这个钱箱上：
      {shift.members.map((m, i) => (
        <span key={`${m.staffId}-${m.joinedAt}`} className={cn(m.leftAt ? 'text-ink-4' : 'font-semibold text-ink-2')}>
          {m.staffName} {formatTime(m.joinedAt)}
          {m.leftAt ? `–${formatTime(m.leftAt)}` : ' 起'}
          {i < shift.members.length - 1 ? '、' : ''}
        </span>
      ))}
    </p>
  );
}

function OpenShift({ shift }: { shift: ShiftRecord }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [leaving, setLeaving] = useState(false);
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const countedCents = parseYuan(counted);
  const diff = countedCents === null ? null : countedCents - shift.summary.cash.expected;
  /** 跨钱箱退款：反结账退的现金比本班收的现金多（应有现金为负），多出的部分来自别的钱箱（R1.2 口径，不改金额，只说明） */
  const crossDrawer = Math.max(0, -shift.summary.cash.expected);
  const close = async () => {
    if (countedCents === null) return;
    setBusy(true);
    setError(null);
    try {
      const s = await api.post<ShiftRecord>(`/api/shifts/${shift.id}/close`, {
        countedCash: countedCents,
        expectedCash: shift.summary.cash.expected,
        note: note.trim(),
      });
      toast({ tone: 'success', title: `已交班 ${s.shiftNo}`, body: diff ? `${diff > 0 ? '长款' : '短款'} ¥${(Math.abs(diff) / 100).toFixed(2)}，已记入交班表` : '现金与应有一致' });
      void qc.invalidateQueries({ queryKey: shiftKeys.all });
    } catch (e) {
      setError(errorMessage(e));
      void qc.invalidateQueries({ queryKey: shiftKeys.all });
    } finally {
      setBusy(false);
    }
  };
  /** 按钱箱交班：离开钱箱（班次照常开着，钱等交班时一起点） */
  const leave = async () => {
    setLeaving(true);
    setError(null);
    try {
      await api.post<ShiftRecord>(`/api/shifts/${shift.id}/leave`, {});
      toast({ tone: 'success', title: `已离开${shift.drawerName ?? ''}`, body: '之后你的收款不再记到这个钱箱；钱箱的班次照常开着，交班时一起点钱。' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLeaving(false);
      void qc.invalidateQueries({ queryKey: shiftKeys.all });
    }
  };
  const onShift = shift.members.filter((m) => !m.leftAt).length;
  return (
    <Card className="p-5" data-testid="shift-open">
      <SectionTitle
        aside={
          <span className="flex items-center gap-2">
            {shift.drawerName && (
              <Button size="sm" variant="ghost" icon={<LogOut className="size-3.5" />} loading={leaving} onClick={() => void leave()} data-testid="shift-leave">
                离开钱箱
              </Button>
            )}
            <Badge tone="pine">当班中</Badge>
          </span>
        }
      >
        <span className="flex items-center gap-2">
          <ClipboardCheck className="size-4 text-pine" /> 交班表 · {shift.shiftNo}
          {shift.drawerName ? ` · ${shift.drawerName}` : ''}
        </span>
      </SectionTitle>
      <p className="mt-1 flex items-center gap-1.5 text-[13px] text-ink-3">
        <Clock3 className="size-3.5" /> {formatDateTime(shift.startedAt)} 开班 · 备用金 <Money cents={shift.openingCash} /> · 数据每 30 秒刷新
      </p>
      <MembersLine shift={shift} />
      {shift.drawerName && onShift <= 1 && (
        <p className="mt-1 text-[12px] text-ink-3">你是这个钱箱上最后一个人：离开后钱箱的班次还开着（钱在里面），下一位点「加入」接着收；要点钱交班就在下面确认交班。</p>
      )}
      <SummaryView summary={shift.summary} />
      <div className="mt-5 rounded-lg border border-line bg-paper/60 p-4">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <p className="text-[12.5px] font-semibold text-ink-3">应有现金</p>
            <Money cents={shift.summary.cash.expected} className="text-[28px] font-bold text-pine" />
            <CashFormula cash={shift.summary.cash} />
          </div>
          <Field label="实点现金（元）" className="w-[200px]">
            <MoneyInput value={counted} onChange={(e) => setCounted(e.target.value)} aria-label="实点现金" data-testid="shift-counted-cash" />
          </Field>
          {diff !== null && (
            <p className={cn('pb-2 text-[14px] font-bold', diff === 0 ? 'text-pine' : 'text-clay')} data-testid="shift-diff">
              {diff === 0 ? '与应有一致' : `${diff > 0 ? '长款' : '短款'} ¥${(Math.abs(diff) / 100).toFixed(2)}`}
              {crossDrawer > 0 && diff > 0 && <span className="ml-1 text-[12.5px] font-semibold text-ink-3">（其中跨钱箱退款 ¥{(Math.min(diff, crossDrawer) / 100).toFixed(2)}）</span>}
            </p>
          )}
        </div>
        {crossDrawer > 0 && (
          <Notice tone="warning" className="mt-3" title={`应有现金是负数：本班退给客人的现金比收进的多 ¥${(crossDrawer / 100).toFixed(2)}`}>
            <span data-testid="shift-cross-drawer">
              多出的这部分不是从你的钱箱出的（例如从收银员的钱箱或保险柜拿的）。实点按你钱箱里实际的现金填，没有钱箱填 0；交班表会记成长款，与出钱那个钱箱的短款相抵（同一钱箱合并核对）。请在交班备注里写明这笔现金是从哪里拿的。以后反结账时在「从哪个钱箱退现金」里选实际出钱的钱箱，退款就记到那个班次，不会再出现负数。
            </span>
          </Notice>
        )}
        <Input className="mt-3" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="交班备注（选填），例如短款原因" aria-label="交班备注" />
        <Button className="mt-3" variant="primary" size="lg" disabled={countedCents === null} loading={busy} onClick={() => void close()} data-testid="shift-close">
          确认交班
        </Button>
        {error && <Notice tone="error" title={error} className="mt-3" />}
      </div>
    </Card>
  );
}

/** 应有现金 = 备用金 + 结账现金 + 充值现金 − 反结账退现金 + 客房押金现金（收 − 退）− 退款单退现金（之前交班的快照没有退款、押金、退款单） */
function CashFormula({ cash }: { cash: ShiftSummary['cash'] }) {
  return (
    <p className="text-[12px] text-ink-3" data-testid="shift-cash-formula">
      备用金 <Money cents={cash.opening} /> + 结账现金 <Money cents={cash.checkout} /> + 充值现金 <Money cents={cash.recharge} />
      {cash.refund ? (
        <>
          {' '}
          − 反结账退现金 <Money cents={cash.refund} />
        </>
      ) : null}
      {cash.deposit ? (
        <>
          {' '}
          {cash.deposit > 0 ? '+' : '−'} 押金现金（收 − 退） <Money cents={Math.abs(cash.deposit)} />
        </>
      ) : null}
      {cash.refundSlip ? (
        <>
          {' '}
          − 退款单退现金 <Money cents={cash.refundSlip} />
        </>
      ) : null}
      {cash.memberRefund ? (
        <>
          {' '}
          − 储值退回的现金 <Money cents={cash.memberRefund} />
        </>
      ) : null}
      {cash.countCard ? (
        <>
          {' '}
          {cash.countCard > 0 ? '+' : '−'} 次卡现金（卖 − 退） <Money cents={Math.abs(cash.countCard)} />
        </>
      ) : null}
    </p>
  );
}

/** 退款单（v0.7.20）：记到本班次的离店后部分退款；现金已从应有现金里扣，扫码、银行卡、其他列出退款单号 */
function RefundSlipsView({ slips }: { slips: NonNullable<ShiftSummary['refundSlips']> }) {
  return (
    <div className="rounded-lg border border-ember/30 bg-ember-soft/20 p-4 md:col-span-2" data-testid="shift-refund-slips">
      <p className="text-[13px] font-bold text-ink-2">
        退款单 {slips.count} 张 · <Money cents={slips.total} className="font-bold text-ember" />
        <span className="ml-2 font-normal text-ink-3">{slips.byMethod.map((m) => `${PAYMENT_METHOD_LABELS[m.method]} ¥${(m.amount / 100).toFixed(2)}`).join('、')}</span>
      </p>
      <ul className="mt-2 space-y-1 text-[12.5px] text-ink-2">
        {slips.list.map((r) => (
          <li key={r.refundNo}>
            {r.refundNo}（原单 {r.checkoutNo}，¥{(r.amount / 100).toFixed(2)}，{r.reason}
            {r.operatorName ? `，${r.operatorName}从本班钱箱退` : ''}
            {r.refs.filter((x) => x.method !== 'cash').map((x) => `；${PAYMENT_METHOD_LABELS[x.method]}${x.method === 'other' ? '：' : '退款单号 '}${x.ref}`).join('')}）
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-[12px] text-ink-3">现金从你的钱箱退给客人，已从应有现金里扣掉；扫码、银行卡请核对已在商户后台原路退回。</p>
    </div>
  );
}

function SummaryView({ summary }: { summary: ShiftSummary }) {
  const refunds = summary.refunds;
  return (
    <div className="mt-4 grid gap-4 md:grid-cols-2" data-testid="shift-summary">
      <div className="rounded-lg border border-line p-4">
        <p className="text-[13px] font-bold text-ink-2">
          前台结账 {summary.checkouts.count} 张 · <Money cents={summary.checkouts.total} className="font-bold" />
        </p>
        <ul className="mt-2 space-y-1 text-[13px]">
          {summary.checkoutByMethod.length === 0 && <li className="text-ink-4">无</li>}
          {summary.checkoutByMethod.map((m) => (
            <li key={m.method} className="flex justify-between">
              <span className="text-ink-2">
                {CHECKOUT_METHOD_LABELS[m.method]} <span className="text-ink-3">· {m.count} 笔</span>
              </span>
              <Money cents={m.amount} className="font-semibold" />
            </li>
          ))}
        </ul>
        {summary.coupons.length > 0 && (
          <p className="mt-2 text-[12px] text-ink-3">
            团购：{summary.coupons.map((c) => `${COUPON_PLATFORM_LABELS[c.platform]} ${c.count} 张`).join('、')}
          </p>
        )}
      </div>
      <div className="rounded-lg border border-line p-4">
        <p className="text-[13px] font-bold text-ink-2">
          会员充值 {summary.recharges.count} 笔 · 实收 <Money cents={summary.recharges.paid} className="font-bold" />
        </p>
        <ul className="mt-2 space-y-1 text-[13px]">
          {summary.recharges.byMethod.length === 0 && <li className="text-ink-4">无</li>}
          {summary.recharges.byMethod.map((m) => (
            <li key={m.method} className="flex justify-between">
              <span className="text-ink-2">
                {PAYMENT_METHOD_LABELS[m.method]} <span className="text-ink-3">· {m.count} 笔</span>
              </span>
              <Money cents={m.amount} className="font-semibold" />
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[12px] text-ink-3">
          赠金 <Money cents={summary.recharges.bonus} /> · 会员工作台储值消费 {summary.walletConsumes.count} 笔 <Money cents={summary.walletConsumes.total} />（不是现金）
        </p>
      </div>
      {summary.byOperator && summary.byOperator.length > 0 && <OperatorsView operators={summary.byOperator} />}
      {summary.deposits && <DepositsView deposits={summary.deposits} />}
      {summary.refundSlips && <RefundSlipsView slips={summary.refundSlips} />}
      {summary.countCards && <CountCardsView cards={summary.countCards} />}
      {summary.voids.length > 0 &&
        (refunds ? (
          <Notice tone="warning" icon={<Undo2 className="size-4" />} title={`本班次反结账 ${summary.voids.length} 张 · 退款 ¥${(refunds.total / 100).toFixed(2)}`} className="md:col-span-2">
            <span data-testid="shift-refunds">
              {summary.voids.map((v) => `${v.checkoutNo}（¥${(v.amount / 100).toFixed(2)}，${v.reason}${v.voidedByName ? `，${v.voidedByName}反结账、从本班钱箱退` : ''}）`).join('；')}。
              退款按原收款方式：{refunds.byMethod.map((m) => `${CHECKOUT_METHOD_LABELS[m.method]} ¥${(m.amount / 100).toFixed(2)}`).join('、')}。
              现金从你的钱箱退给客人，已从应有现金里扣掉；扫码、银行卡、团购请在商户后台原路退回并登记退款单号。原单若是别人收的款，仍算在原收款人的班次，同一钱箱合并核对时相抵。
            </span>
          </Notice>
        ) : (
          <Notice tone="warning" icon={<Undo2 className="size-4" />} title={`本班次反结账 ${summary.voids.length} 张`} className="md:col-span-2">
            {summary.voids.map((v) => `${v.checkoutNo}（¥${(v.amount / 100).toFixed(2)}，${v.reason}${v.voidedByName ? `，${v.voidedByName}反结账、从本班钱箱退` : ''}）`).join('；')}。原单收过的现金不计入应有现金，请核对是否已退还或已重新收取。
          </Notice>
        ))}
    </div>
  );
}

/** 按钱箱交班（v0.7.28）：各人经办的结账与充值（一个钱箱几个人收款） */
function OperatorsView({ operators }: { operators: NonNullable<ShiftSummary['byOperator']> }) {
  return (
    <div className="rounded-lg border border-line p-4 md:col-span-2" data-testid="shift-operators">
      <p className="text-[13px] font-bold text-ink-2">各人经办</p>
      <ul className="mt-2 space-y-1 text-[13px]">
        {operators.map((o) => (
          <li key={o.staffId} className="flex flex-wrap justify-between gap-x-3">
            <span className="text-ink-2">
              {o.staffName}
              <span className="text-ink-3">
                {' '}
                · 结账 {o.checkouts.count} 张 <Money cents={o.checkouts.total} /> · 充值 {o.recharges.count} 笔 <Money cents={o.recharges.paid} />
              </span>
            </span>
            <Money cents={o.checkouts.total + o.recharges.paid} className="font-semibold" />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 次卡（v0.7.28）：本班次卖的卡、退的卡，按方式；售卡是预收、不是营业额，现金计入应有现金 */
function CountCardsView({ cards }: { cards: NonNullable<ShiftSummary['countCards']> }) {
  const line = (list: typeof cards.sales.byMethod) =>
    list.length ? list.map((m) => `${PAYMENT_METHOD_LABELS[m.method]} ${m.count} 张 ¥${(m.amount / 100).toFixed(2)}`).join('、') : '无';
  return (
    <div className="rounded-lg border border-line p-4 md:col-span-2" data-testid="shift-count-cards">
      <p className="text-[13px] font-bold text-ink-2">次卡（售卡是预收，不算营业额）</p>
      <p className="mt-1.5 text-[13px] text-ink-2">卖：{line(cards.sales.byMethod)}</p>
      <p className="mt-0.5 text-[13px] text-ink-2">退：{line(cards.refunds.byMethod)}</p>
      <p className="mt-1.5 text-[12px] text-ink-3">现金计入应有现金（卖的加、退的减）；扫码、银行卡退的在商户后台原路退。</p>
    </div>
  );
}

/** 客房押金（S7）：本班次收、退的押金，按收款方式；押金是负债、不算营业额，现金押金计入应有现金 */
function DepositsView({ deposits }: { deposits: NonNullable<ShiftSummary['deposits']> }) {
  const line = (list: typeof deposits.received) =>
    list.length ? list.map((m) => `${PAYMENT_METHOD_LABELS[m.method]} ${m.count} 笔 ¥${(m.amount / 100).toFixed(2)}`).join('、') : '无';
  return (
    <div className="rounded-lg border border-line p-4 md:col-span-2" data-testid="shift-deposits">
      <p className="text-[13px] font-bold text-ink-2">客房押金（不算营业额）</p>
      <p className="mt-1.5 text-[13px] text-ink-2">收：{line(deposits.received)}</p>
      <p className="mt-0.5 text-[13px] text-ink-2">退：{line(deposits.refunded)}</p>
      <p className="mt-1.5 text-[12px] text-ink-3">现金押金计入应有现金（收的加、退的减）；扫码、银行卡收的押金退房时在商户后台原路退。</p>
    </div>
  );
}

function ShiftRow({ s }: { s: ShiftRecord }) {
  const [open, setOpen] = useState(false);
  const diff = s.countedCash !== null && s.expectedCash !== null ? s.countedCash - s.expectedCash : null;
  return (
    <li>
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-paper-2/60">
        <span className="num font-bold">{s.shiftNo}</span>
        <span className="text-[13px] font-semibold text-ink-2">
          {s.drawerName ? `${s.drawerName}（${[...new Set(s.members.map((m) => m.staffName))].join('、')}）` : s.staffName}
        </span>
        <span className="text-[12.5px] text-ink-3">
          {formatTime(s.startedAt)} – {s.endedAt ? formatTime(s.endedAt) : '当班中'}
        </span>
        <span className="flex-1" />
        {s.status === 'open' ? (
          <Badge tone="pine">当班中</Badge>
        ) : diff === 0 ? (
          <Badge tone="neutral">现金一致</Badge>
        ) : (
          <Badge tone="clay">
            <Coins className="size-3" />
            {diff! > 0 ? '长款' : '短款'} ¥{(Math.abs(diff!) / 100).toFixed(2)}
          </Badge>
        )}
        <Money cents={s.summary.checkouts.total + s.summary.recharges.paid} className="font-bold" />
      </button>
      {open && (
        <div className="border-t border-line bg-paper/50 px-4 pb-4">
          <SummaryView summary={s.summary} />
          {s.status === 'closed' && (
            <p className="mt-3 text-[12.5px] text-ink-3">
              应有现金 <Money cents={s.expectedCash!} />
              {s.expectedCash! < 0 && `（跨钱箱退款 ¥${(-s.expectedCash! / 100).toFixed(2)}，与出钱的钱箱相抵）`} · 实点 <Money cents={s.countedCash!} /> · 交班人 {s.closedByName}
              {s.handedToName ? ` · 接班 ${s.handedToName}` : ''}
              {s.note ? ` · ${s.note}` : ''}
            </p>
          )}
          <PrintButton path={`/print/shift/${s.id}`} size="sm" testId="shift-print">
            {s.status === 'closed' ? '打印交班表' : '打印预览'}
          </PrintButton>
          <NetPrintButton doc={{ type: 'shift', id: s.id }} docName={s.status === 'closed' ? '交班表' : '交班表（预览）'} size="sm" testId="shift-netprint" />
        </div>
      )}
    </li>
  );
}
