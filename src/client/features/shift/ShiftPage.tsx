import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck, Clock3, Coins, Undo2 } from 'lucide-react';
import { CHECKOUT_METHOD_LABELS, COUPON_PLATFORM_LABELS, type ShiftRecord, type ShiftSummary } from '@shared/checkout';
import { PAYMENT_METHOD_LABELS } from '@shared/labels';
import { parseYuan } from '@shared/money';
import { api, errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { cn, formatDateTime, formatTime } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, MoneyInput, Notice, PendingBadge, SectionTitle, Skeleton } from '../../components/ui';

// 交班（店主 #11）：开班登记备用金 → 当班期间系统按本人经办的结账与充值汇总 → 交班时实点现金，记下长款 / 短款。

const sk = { current: ['shift', 'current'] as const, list: (date: string) => ['shift', 'list', date] as const };

export function ShiftPage() {
  const session = useSession();
  const current = useQuery({
    queryKey: sk.current,
    queryFn: () => api.get<{ shift: ShiftRecord | null }>('/api/shifts/current'),
    refetchInterval: 30_000,
  });
  const list = useQuery({ queryKey: sk.list(session.today), queryFn: () => api.get<ShiftRecord[]>(`/api/shifts?date=${session.today}`) });
  const shift = current.data?.shift ?? null;
  return (
    <>
      <PageHeader title="交班" subtitle={`营业日 ${session.today} · ${session.staff.displayName}`} />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[960px] space-y-5 px-5 py-6 md:px-7">
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
  const qc = useQueryClient();
  const toast = useToast();
  const [cash, setCash] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cents = parseYuan(cash || '0');
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await api.post<ShiftRecord>('/api/shifts', { openingCash: cents });
      toast({ tone: 'success', title: `已开班 ${s.shiftNo}` });
      void qc.invalidateQueries({ queryKey: ['shift'] });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="p-5" data-testid="shift-start">
      <SectionTitle>
        <span className="flex items-center gap-2">
          开班 <PendingBadge title="交班表口径（按本人经办的结账与充值汇总、应有现金 = 备用金 + 现金收款）为默认做法，待店主确认" />
        </span>
      </SectionTitle>
      <p className="mt-1 text-[13px] text-ink-3">登记抽屉里的备用金后开始当班；交班时系统按你经办的结账与充值汇总各收款方式，算出应有现金。</p>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <Field label="备用金（元）" className="w-[200px]">
          <MoneyInput value={cash} onChange={(e) => setCash(e.target.value)} aria-label="备用金" data-testid="shift-opening-cash" />
        </Field>
        <Button variant="primary" size="lg" disabled={cents === null} loading={busy} onClick={() => void start()} data-testid="shift-start-submit">
          开班
        </Button>
      </div>
      {error && <Notice tone="error" title={error} className="mt-3" />}
    </Card>
  );
}

function OpenShift({ shift }: { shift: ShiftRecord }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const countedCents = parseYuan(counted);
  const diff = countedCents === null ? null : countedCents - shift.summary.cash.expected;
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
      void qc.invalidateQueries({ queryKey: ['shift'] });
    } catch (e) {
      setError(errorMessage(e));
      void qc.invalidateQueries({ queryKey: ['shift'] });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="p-5" data-testid="shift-open">
      <SectionTitle aside={<Badge tone="pine">当班中</Badge>}>
        <span className="flex items-center gap-2">
          <ClipboardCheck className="size-4 text-pine" /> 交班表 · {shift.shiftNo}
        </span>
      </SectionTitle>
      <p className="mt-1 flex items-center gap-1.5 text-[13px] text-ink-3">
        <Clock3 className="size-3.5" /> {formatDateTime(shift.startedAt)} 开班 · 备用金 <Money cents={shift.openingCash} /> · 数据每 30 秒刷新
      </p>
      <SummaryView summary={shift.summary} />
      <div className="mt-5 rounded-lg border border-line bg-paper/60 p-4">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <p className="text-[12.5px] font-semibold text-ink-3">应有现金</p>
            <Money cents={shift.summary.cash.expected} className="text-[28px] font-bold text-pine" />
            <p className="text-[12px] text-ink-3">
              备用金 <Money cents={shift.summary.cash.opening} /> + 结账现金 <Money cents={shift.summary.cash.checkout} /> + 充值现金{' '}
              <Money cents={shift.summary.cash.recharge} />
            </p>
          </div>
          <Field label="实点现金（元）" className="w-[200px]">
            <MoneyInput value={counted} onChange={(e) => setCounted(e.target.value)} aria-label="实点现金" data-testid="shift-counted-cash" />
          </Field>
          {diff !== null && (
            <p className={cn('pb-2 text-[14px] font-bold', diff === 0 ? 'text-pine' : 'text-clay')} data-testid="shift-diff">
              {diff === 0 ? '与应有一致' : `${diff > 0 ? '长款' : '短款'} ¥${(Math.abs(diff) / 100).toFixed(2)}`}
            </p>
          )}
        </div>
        <Input className="mt-3" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="交班备注（选填），例如短款原因" aria-label="交班备注" />
        <Button className="mt-3" variant="primary" size="lg" disabled={countedCents === null} loading={busy} onClick={() => void close()} data-testid="shift-close">
          确认交班
        </Button>
        {error && <Notice tone="error" title={error} className="mt-3" />}
      </div>
    </Card>
  );
}

function SummaryView({ summary }: { summary: ShiftSummary }) {
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
      {summary.voids.length > 0 && (
        <Notice tone="warning" icon={<Undo2 className="size-4" />} title={`本班次反结账 ${summary.voids.length} 张`} className="md:col-span-2">
          {summary.voids.map((v) => `${v.checkoutNo}（¥${(v.amount / 100).toFixed(2)}，${v.reason}）`).join('；')}。原单收过的现金不计入应有现金，请核对是否已退还或已重新收取。
        </Notice>
      )}
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
        <span className="text-[13px] font-semibold text-ink-2">{s.staffName}</span>
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
              应有现金 <Money cents={s.expectedCash!} /> · 实点 <Money cents={s.countedCash!} /> · 交班人 {s.closedByName}
              {s.handedToName ? ` · 接班 ${s.handedToName}` : ''}
              {s.note ? ` · ${s.note}` : ''}
            </p>
          )}
        </div>
      )}
    </li>
  );
}
