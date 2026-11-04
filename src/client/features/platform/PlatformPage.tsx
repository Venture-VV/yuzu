// 平台核销补录（v0.7.28 ⑤，docs/SCHEDULE_FINISH.md 第 6 节，N6 待确认）：
//   · 补登记：已在平台 App（美团、大众点评、抖音等）核销、没有经过前台结账的券——不结账、不算营业额；登记错了作废（值班经理以上）；
//   · 打款与对账（店主、店总）：登记平台打款，按时间段核对 补登记的应结 + 结账里的团购券 与 到账。
// 补登记、打款登记动的是账：超时、断网、回复 500 时「结果待确认」，在页面上方查回、按原内容重新提交或作废。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Store } from 'lucide-react';
import { COUPON_PLATFORM_LABELS, COUPON_PLATFORMS, type CouponPlatform } from '@shared/checkout';
import { centsToInput, formatYuan, parseYuan } from '@shared/money';
import type { PlatformReconcile, PlatformRedemption, PlatformSettlement } from '@shared/platform';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp } from '../../lib/erpPending';
import { useCan, useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { cn, formatDateTime, uuid } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { DateNav } from '../../components/DateNav';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { Dialog } from '../../components/Overlay';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, MoneyInput, Notice, PendingBadge, SectionTitle, Segmented, Select, Skeleton } from '../../components/ui';

const keys = { list: (d: string) => ['platform', 'redemptions', d] as const, reconcile: (f: string, t: string) => ['platform', 'reconcile', f, t] as const };

export function PlatformPage() {
  const can = useCan();
  const session = useSession();
  const [tab, setTab] = useState<'redeem' | 'settle'>('redeem');
  return (
    <>
      <PageHeader
        title="平台核销补录"
        subtitle="已在平台 App 核销、没有经过前台结账的券；不算营业额，与平台打款对账"
        actions={
          can('platform.settle') ? (
            <Segmented
              value={tab}
              onChange={setTab}
              ariaLabel="页面"
              size="sm"
              options={[
                { value: 'redeem', label: '补登记' },
                { value: 'settle', label: '打款与对账' },
              ]}
            />
          ) : null
        }
      />
      <div className="space-y-4 p-5 md:p-7" data-testid="platform-page">
        {tab === 'redeem' ? <RedeemTab today={session.today} /> : <SettleTab today={session.today} />}
      </div>
    </>
  );
}

function RedeemTab({ today }: { today: string }) {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const [date, setDate] = useState(today);
  const [adding, setAdding] = useState(false);
  const [voiding, setVoiding] = useState<PlatformRedemption | null>(null);
  const list = useQuery({ queryKey: keys.list(date), queryFn: () => api.get<PlatformRedemption[]>(`/api/platform/redemptions?from=${date}&to=${date}`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['platform'] });
  const active = (list.data ?? []).filter((r) => r.status === 'active');
  return (
    <>
      <ErpPendingPanel types={['platform_redemption']} className="space-y-2" onFound={() => void refresh()} />
      <Card className="p-5">
        <SectionTitle
          aside={
            <span className="flex items-center gap-2">
              <DateNav value={date} today={today} onChange={setDate} />
              {can('platform.redeem') && (
                <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)} data-testid="platform-redeem-new">
                  补登记
                </Button>
              )}
            </span>
          }
        >
          <span className="flex items-center gap-2">
            <Store className="size-4 text-yuzu-deep" /> 当天的补登记 <PendingBadge title="N6：不结账、不算营业额；补登记 31 天以内的核销；同一张券不能和结账里登记的团购券重复（待确认）" />
          </span>
        </SectionTitle>
        <p className="mt-1 text-[12.5px] text-ink-3">
          {active.length} 笔有效 · 面值 {formatYuan(active.reduce((t, r) => t + Number(r.faceValue), 0))} · 平台应结 {formatYuan(active.reduce((t, r) => t + Number(r.settleAmount), 0))}
        </p>
        {list.isPending ? (
          <Skeleton className="mt-3 h-20" />
        ) : (list.data ?? []).length === 0 ? (
          <p className="mt-3 text-[13px] text-ink-3">这一天没有补登记。</p>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {list.data!.map((r) => (
              <li key={r.id} className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-[13.5px]', r.status === 'voided' && 'opacity-60')} data-testid={`platform-redemption-${r.redemptionNo}`}>
                <Badge tone="lake">{COUPON_PLATFORM_LABELS[r.platform]}</Badge>
                <span className="num font-semibold">{r.code}</span>
                <span>{r.dealName || '（没写项目）'}</span>
                <span className="num">面值 {formatYuan(Number(r.faceValue))} · 应结 {formatYuan(Number(r.settleAmount))}</span>
                <span className="text-[12px] text-ink-3">
                  {r.redemptionNo} · 核销 {formatDateTime(r.redeemedAt)} · {r.registeredByName}
                  {r.status === 'voided' && ` · 已作废：${r.voidReason}`}
                </span>
                {r.status === 'active' && can('platform.void') && (
                  <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setVoiding(r)} data-testid={`platform-void-${r.redemptionNo}`}>
                    作废
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {adding && <RedeemDialog onClose={() => setAdding(false)} onDone={() => void refresh()} />}
      {voiding && (
        <ReasonDialog
          open
          title={`作废补登记 ${voiding.redemptionNo}`}
          description={`${COUPON_PLATFORM_LABELS[voiding.platform]} ${voiding.code}：登记错了才作废，写明原因`}
          confirmLabel="作废"
          onClose={() => setVoiding(null)}
          onConfirm={async (reason) => {
            try {
              await api.post(`/api/platform/redemptions/${voiding.id}/void`, { reason });
              toast({ tone: 'success', title: '已作废' });
              setVoiding(null);
              await refresh();
            } catch (e) {
              toast({ tone: 'error', title: '没有作废', body: errorMessage(e) });
            }
          }}
        />
      )}
    </>
  );
}

/** datetime-local 的值（本机时区）与 ISO 互转 */
const localNow = () => {
  const d = new Date();
  d.setSeconds(0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

function RedeemDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const session = useSession();
  const toast = useToast();
  const [platform, setPlatform] = useState<CouponPlatform>('meituan');
  const [code, setCode] = useState('');
  const [deal, setDeal] = useState('');
  const [face, setFace] = useState('');
  const [settle, setSettle] = useState('');
  const [at, setAt] = useState(localNow);
  const [note, setNote] = useState('');
  const [key, setKey] = useState(uuid);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(true, () => {
    setKey(uuid());
    setError(null);
  });
  const faceCents = parseYuan(face);
  const settleCents = settle.trim() === '' ? null : parseYuan(settle);
  const ok = code.replace(/[\s-]/g, '').length >= 6 && faceCents !== null && (settle.trim() === '' || (settleCents !== null && settleCents <= faceCents!)) && !!at;
  const submit = async () => {
    if (faceCents === null) return;
    setBusy(true);
    setError(null);
    try {
      await sendErpOp({
        key,
        type: 'platform_redemption',
        url: '/api/platform/redemptions',
        body: { clientKey: key, platform, code, dealName: deal.trim(), faceValue: faceCents, settleAmount: settleCents, redeemedAt: new Date(at).toISOString(), note: note.trim() },
        summary: `${COUPON_PLATFORM_LABELS[platform]} ${code} 面值 ${formatYuan(faceCents)}`,
        staffName: session.staff.displayName,
      });
      toast({ tone: 'success', title: '已补登记', body: `${COUPON_PLATFORM_LABELS[platform]} ${code}` });
      onDone();
      onClose();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '补登记结果待确认', body: '已记在本机：请在页面上方查回、按原内容重新提交或作废，不要另登一笔。' });
        onDone();
        onClose();
        return;
      }
      setError(errorMessage(e));
      onDone();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="补登记平台核销"
      description="只登记已在平台 App 核销、没有经过前台结账的券。前台结账时用的团购券在结账里登记，不要再补。"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={!ok || busy} data-testid="platform-redeem-submit">
            补登记
          </Button>
        </div>
      }
    >
      <div className="grid gap-4">
        <Field label="平台">
          <Segmented value={platform} onChange={setPlatform} ariaLabel="平台" size="sm" options={COUPON_PLATFORMS.map((p) => ({ value: p, label: COUPON_PLATFORM_LABELS[p] }))} />
        </Field>
        <Field label="券码" htmlFor="platform-code">
          <Input id="platform-code" value={code} maxLength={80} onChange={(e) => setCode(e.target.value)} data-testid="platform-code" />
        </Field>
        <Field label="项目（团购名称）" htmlFor="platform-deal">
          <Input id="platform-deal" value={deal} maxLength={48} onChange={(e) => setDeal(e.target.value)} placeholder="例如 双人洗浴套餐" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="面值（顾客付的）" htmlFor="platform-face">
            <MoneyInput id="platform-face" value={face} onChange={(e) => setFace(e.target.value)} data-testid="platform-face" />
          </Field>
          <Field label="平台应结（可不填，按面值）" htmlFor="platform-settle">
            <MoneyInput id="platform-settle" value={settle} onChange={(e) => setSettle(e.target.value)} placeholder={faceCents !== null ? centsToInput(faceCents) : ''} />
          </Field>
        </div>
        <Field label="在平台 App 核销的时间" htmlFor="platform-at">
          <Input id="platform-at" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
        </Field>
        <Field label="备注" htmlFor="platform-note">
          <Input id="platform-note" value={note} maxLength={100} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Dialog>
  );
}

const monthStart = (d: string) => `${d.slice(0, 7)}-01`;

function SettleTab({ today }: { today: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [from, setFrom] = useState(monthStart(today));
  const [to, setTo] = useState(today);
  const [adding, setAdding] = useState(false);
  const [voiding, setVoiding] = useState<PlatformSettlement | null>(null);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;
  const rec = useQuery({ queryKey: keys.reconcile(from, to), queryFn: () => api.get<PlatformReconcile>(`/api/platform/reconcile?from=${from}&to=${to}`), enabled: valid });
  const refresh = () => qc.invalidateQueries({ queryKey: ['platform'] });
  return (
    <>
      <ErpPendingPanel types={['platform_settlement']} className="space-y-2" onFound={() => void refresh()} />
      <Card className="p-5" data-testid="platform-reconcile">
        <SectionTitle
          aside={
            <span className="flex flex-wrap items-center gap-2 text-[13px]">
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} fullWidth={false} className="w-40" aria-label="从" />
              至
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} fullWidth={false} className="w-40" aria-label="到" />
              <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)} data-testid="platform-settle-new">
                登记打款
              </Button>
            </span>
          }
        >
          对账（按营业日）
        </SectionTitle>
        {!valid ? (
          <Notice tone="warning" className="mt-3">开始日期不能晚于结束日期</Notice>
        ) : !rec.data ? (
          <Skeleton className="mt-3 h-24" />
        ) : rec.data.rows.length === 0 ? (
          <p className="mt-3 text-[13px] text-ink-3">这段时间没有平台核销与打款。</p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-max text-[13px]">
              <thead className="bg-paper-2/70 text-[12px] font-bold text-ink-3">
                <tr>
                  <th className="px-3 py-2 text-left">平台</th>
                  <th className="px-3 py-2 text-right">补登记（应结）</th>
                  <th className="px-3 py-2 text-right">结账团购券</th>
                  <th className="px-3 py-2 text-right">应结合计</th>
                  <th className="px-3 py-2 text-right">到账</th>
                  <th className="px-3 py-2 text-right">差额（到账 − 应结）</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rec.data.rows.map((r) => (
                  <tr key={r.platform} data-testid={`platform-row-${r.platform}`}>
                    <td className="px-3 py-2">{COUPON_PLATFORM_LABELS[r.platform]}</td>
                    <td className="num px-3 py-2 text-right">
                      {r.redemptions.count} 张 · {formatYuan(r.redemptions.settle)}
                    </td>
                    <td className="num px-3 py-2 text-right">
                      {r.checkoutCoupons.count} 张 · {formatYuan(r.checkoutCoupons.amount)}
                    </td>
                    <td className="num px-3 py-2 text-right font-semibold">{formatYuan(r.expected)}</td>
                    <td className="num px-3 py-2 text-right">
                      {r.settlements.count} 笔 · {formatYuan(r.settlements.amount)}
                    </td>
                    <td className={cn('num px-3 py-2 text-right font-bold', r.diff < 0 ? 'text-clay' : r.diff > 0 ? 'text-yuzu-deep' : 'text-pine')}>{formatYuan(r.diff)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-[12px] text-ink-3">打款按它所属的结算期间算：期间整段在这段时间里的才算进来。差额是负数时是平台还没打，或者扣了佣金、退款。</p>
      </Card>
      <Card className="p-5">
        <SectionTitle>这段时间的打款</SectionTitle>
        {(rec.data?.settlements ?? []).length === 0 ? (
          <p className="mt-2 text-[13px] text-ink-3">没有打款登记。</p>
        ) : (
          <ul className="mt-2 divide-y divide-line">
            {rec.data!.settlements.map((s) => (
              <li key={s.id} className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-[13.5px]', s.status === 'voided' && 'opacity-60')}>
                <Badge tone="lake">{COUPON_PLATFORM_LABELS[s.platform]}</Badge>
                <span className="num font-semibold">{formatYuan(Number(s.amount))}</span>
                <span className="text-ink-2">
                  {s.periodFrom} 至 {s.periodTo} · {s.receivedOn} 到账
                </span>
                <span className="text-[12px] text-ink-3">
                  {s.settlementNo}
                  {s.ref && ` · ${s.ref}`} · {s.createdByName}
                  {s.status === 'voided' && ` · 已作废：${s.voidReason}`}
                </span>
                {s.status === 'active' && (
                  <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setVoiding(s)}>
                    作废
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {adding && <SettleDialog defaultFrom={from} defaultTo={to} onClose={() => setAdding(false)} onDone={() => void refresh()} />}
      {voiding && (
        <ReasonDialog
          open
          title={`作废打款登记 ${voiding.settlementNo}`}
          confirmLabel="作废"
          onClose={() => setVoiding(null)}
          onConfirm={async (reason) => {
            try {
              await api.post(`/api/platform/settlements/${voiding.id}/void`, { reason });
              toast({ tone: 'success', title: '已作废' });
              setVoiding(null);
              await refresh();
            } catch (e) {
              toast({ tone: 'error', title: '没有作废', body: errorMessage(e) });
            }
          }}
        />
      )}
    </>
  );
}

function SettleDialog({ defaultFrom, defaultTo, onClose, onDone }: { defaultFrom: string; defaultTo: string; onClose: () => void; onDone: () => void }) {
  const session = useSession();
  const toast = useToast();
  const [platform, setPlatform] = useState<CouponPlatform>('meituan');
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [amount, setAmount] = useState('');
  const [receivedOn, setReceivedOn] = useState(session.today);
  const [ref, setRef] = useState('');
  const [note, setNote] = useState('');
  const [key, setKey] = useState(uuid);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(true, () => {
    setKey(uuid());
    setError(null);
  });
  const cents = parseYuan(amount);
  const ok = cents !== null && cents > 0 && from <= to && !!receivedOn;
  const submit = async () => {
    if (cents === null) return;
    setBusy(true);
    setError(null);
    try {
      await sendErpOp({
        key,
        type: 'platform_settlement',
        url: '/api/platform/settlements',
        body: { clientKey: key, platform, periodFrom: from, periodTo: to, amount: cents, receivedOn, ref: ref.trim(), note: note.trim() },
        summary: `${COUPON_PLATFORM_LABELS[platform]} ${from}–${to} 打款 ${formatYuan(cents)}`,
        staffName: session.staff.displayName,
      });
      toast({ tone: 'success', title: '已登记打款' });
      onDone();
      onClose();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '打款登记结果待确认', body: '已记在本机：请在页面上方查回、按原内容重新提交或作废。' });
        onDone();
        onClose();
        return;
      }
      setError(errorMessage(e));
      onDone();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="登记平台打款"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={!ok || busy} data-testid="platform-settle-submit">
            登记
          </Button>
        </div>
      }
    >
      <div className="grid gap-4">
        <Field label="平台">
          <Select value={platform} onChange={(e) => setPlatform(e.target.value as CouponPlatform)} aria-label="平台">
            {COUPON_PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {COUPON_PLATFORM_LABELS[p]}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="结算期间从" htmlFor="ps-from">
            <Input id="ps-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="到" htmlFor="ps-to">
            <Input id="ps-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="到账金额" htmlFor="ps-amount">
            <MoneyInput id="ps-amount" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="platform-settle-amount" />
          </Field>
          <Field label="到账日期" htmlFor="ps-on">
            <Input id="ps-on" type="date" value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} />
          </Field>
        </div>
        <Field label="流水号" htmlFor="ps-ref">
          <Input id="ps-ref" value={ref} maxLength={64} onChange={(e) => setRef(e.target.value)} />
        </Field>
        <Field label="备注" htmlFor="ps-note">
          <Input id="ps-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Dialog>
  );
}
