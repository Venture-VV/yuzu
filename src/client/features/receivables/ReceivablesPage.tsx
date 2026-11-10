// ERP「应收与挂账」（8.0.7 ERP P2 3.1）：
//   · 协议单位：编码、名称、联系人、电话、挂账额度（空 = 不限）、启用；前台结账时可以挂到这里（要岗位权限「挂账」）；
//   · 每个单位的挂账（结账单、签单人、核销了多少、挂了几天）与回款（核销到哪几笔、冲销）；
//   · 登记回款：日期、方式、金额、凭据，从最早的挂账开始核销，不能超过没结清的；当月可以冲销；不进交班、日结；
//   · 账龄：协议单位与平台团购的未回款按 0–30、31–60、61–90、90 天以上，超过提醒天数的标出；平台回款（应结 − 打款）。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate } from 'react-router';
import { Download, Landmark, Plus } from 'lucide-react';
import { AGING_BUCKETS, AR_METHOD_LABELS, AR_METHODS, type ArAccount, type ArAccountDetail, type ArAging, type ArMethod, type PlatformReceivable } from '@shared/ar';
import { centsToInput, formatYuan, parseYuan } from '@shared/money';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, useErpPending } from '../../lib/erpPending';
import { useCan, useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { cn, formatDateTime, uuid } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, MoneyInput, Notice, Segmented, Select, Skeleton } from '../../components/ui';
import { ErpPage } from '../erp/ErpHome';

const KEY = ['erp', 'receivables'] as const;
type Tab = 'accounts' | 'aging';

export function ReceivablesPage() {
  const can = useCan();
  const [tab, setTab] = useState<Tab>('accounts');
  const [openId, setOpenId] = useState<number | null>(null);
  const [editing, setEditing] = useState<ArAccount | 'new' | null>(null);
  const [collecting, setCollecting] = useState<ArAccount | null>(null);
  const accounts = useQuery({ queryKey: [...KEY, 'accounts'], queryFn: () => api.get<ArAccount[]>('/api/erp/receivables/accounts') });
  if (!can('ar.read')) return <Navigate to="/erp" replace />;
  const manage = can('ar.manage');
  return (
    <ErpPage
      title="应收与挂账"
      description="协议单位挂账（前台结账时选「挂账」）、回款登记与核销、平台团购回款与账龄。挂账算营业额、不算实收；回款在这里登记，不进前台交班、日结。"
      actions={
        manage && (
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')} data-testid="ar-account-new">
            新增协议单位
          </Button>
        )
      }
    >
      <div className="space-y-4" data-testid="receivables-page">
        {manage && <ErpPendingPanel types={['ar_collection']} />}
        <Segmented<Tab>
          ariaLabel="应收与挂账"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'accounts', label: '协议单位' },
            { value: 'aging', label: '账龄与平台回款' },
          ]}
        />
        {tab === 'accounts' ? (
          accounts.error ? (
            <Notice tone="error" title={errorMessage(accounts.error)} />
          ) : accounts.isPending ? (
            <Skeleton className="h-48" />
          ) : accounts.data.length === 0 ? (
            <EmptyState art="leaf" title="还没有协议单位" description={manage ? '点「新增协议单位」登记合作的公司、单位；前台结账时就能挂账到这里。' : undefined} className="rounded-lg border border-dashed border-line-strong" />
          ) : (
            <ul className="grid gap-2.5 md:grid-cols-2" data-testid="ar-accounts">
              {accounts.data.map((a) => (
                <li key={a.id}>
                  <Card className={cn('space-y-1 p-4', !a.active && 'opacity-60')}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="num text-[12px] font-semibold text-ink-3">{a.code}</span>
                      <button type="button" className="truncate text-[14.5px] font-bold hover:underline" onClick={() => setOpenId(a.id)}>
                        {a.name}
                      </button>
                      {!a.active && <Badge>已停用</Badge>}
                      <span className="flex-1" />
                      <Money cents={a.outstandingCents} className="text-[15px] font-bold" />
                    </div>
                    <p className="text-[12.5px] text-ink-3">
                      {[a.contact, a.phone].filter(Boolean).join(' · ') || '未填写联系人'} · {a.creditLimitCents === null ? '额度不限' : `额度 ${formatYuan(a.creditLimitCents)}`}
                      {a.oldestOpenDate ? ` · 最早一笔 ${a.oldestOpenDate}` : ''}
                    </p>
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      <Button size="sm" variant="secondary" onClick={() => setOpenId(a.id)}>
                        挂账与回款
                      </Button>
                      {manage && (
                        <>
                          <Button size="sm" variant="secondary" disabled={a.outstandingCents <= 0} onClick={() => setCollecting(a)} data-testid={`ar-collect-${a.code}`}>
                            登记回款
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditing(a)}>
                            修改
                          </Button>
                        </>
                      )}
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          )
        ) : (
          <AgingView />
        )}
      </div>
      <AccountDialog editing={editing} onClose={() => setEditing(null)} />
      <CollectionDialog account={collecting} onClose={() => setCollecting(null)} />
      <AccountSheet id={openId} manage={manage} onClose={() => setOpenId(null)} />
    </ErpPage>
  );
}

function AccountDialog({ editing, onClose }: { editing: ArAccount | 'new' | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({ code: '', name: '', contact: '', phone: '', limit: '', active: true, note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(!!editing, () => {
    const a = editing && editing !== 'new' ? editing : null;
    setForm({
      code: a?.code ?? '',
      name: a?.name ?? '',
      contact: a?.contact ?? '',
      phone: a?.phone ?? '',
      limit: a?.creditLimitCents ? centsToInput(a.creditLimitCents) : '',
      active: a?.active ?? true,
      note: a?.note ?? '',
    });
    setError(null);
  });
  const save = async () => {
    const limit = form.limit.trim() ? parseYuan(form.limit) : null;
    if (form.limit.trim() && (limit === null || limit <= 0)) return setError('额度要填大于 0 的金额，不限就留空');
    setBusy(true);
    setError(null);
    try {
      const body = { code: form.code.trim(), name: form.name.trim(), contact: form.contact.trim(), phone: form.phone.trim(), creditLimitCents: limit, active: form.active, note: form.note.trim() };
      if (editing && editing !== 'new') await api.put(`/api/erp/receivables/accounts/${editing.id}`, { ...body, expectedVersion: editing.version });
      else await api.post('/api/erp/receivables/accounts', body);
      await qc.invalidateQueries({ queryKey: KEY });
      toast({ tone: 'success', title: '协议单位已保存', body: body.name });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!editing}
      onClose={busy ? () => {} : onClose}
      title={editing && editing !== 'new' ? `修改协议单位 · ${editing.name}` : '新增协议单位'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void save()} data-testid="ar-account-save">
            保存
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="编码" htmlFor="ar-code">
          <Input id="ar-code" value={form.code} maxLength={16} onChange={(e) => setForm({ ...form, code: e.target.value })} className="h-10" data-testid="ar-code" />
        </Field>
        <Field label="名称" htmlFor="ar-name" className="sm:col-span-2">
          <Input id="ar-name" value={form.name} maxLength={40} onChange={(e) => setForm({ ...form, name: e.target.value })} className="h-10" data-testid="ar-name" />
        </Field>
        <Field label="联系人" htmlFor="ar-contact">
          <Input id="ar-contact" value={form.contact} maxLength={40} onChange={(e) => setForm({ ...form, contact: e.target.value })} className="h-10" />
        </Field>
        <Field label="电话" htmlFor="ar-phone">
          <Input id="ar-phone" value={form.phone} maxLength={32} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="h-10" />
        </Field>
        <Field label="挂账额度（元，空 = 不限）" htmlFor="ar-limit">
          <MoneyInput id="ar-limit" value={form.limit} onChange={(e) => setForm({ ...form, limit: e.target.value })} className="h-10" data-testid="ar-limit" />
        </Field>
        <Field label="备注" htmlFor="ar-note" className="sm:col-span-3">
          <Input id="ar-note" value={form.note} maxLength={200} onChange={(e) => setForm({ ...form, note: e.target.value })} className="h-10" />
        </Field>
        {editing !== 'new' && (
          <label className="flex items-center gap-2 text-[13.5px] font-semibold text-ink-2 sm:col-span-3">
            <input type="checkbox" className="size-4 accent-[var(--color-pine)]" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
            在用（停用的前台结账时选不到）
          </label>
        )}
      </div>
      {error && <Notice tone="error" title={error} className="mt-3" />}
    </Dialog>
  );
}

function CollectionDialog({ account, onClose }: { account: ArAccount | null; onClose: () => void }) {
  const session = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [collectedOn, setCollectedOn] = useState('');
  const [method, setMethod] = useState<ArMethod>('bank_transfer');
  const [amount, setAmount] = useState('');
  const [evidence, setEvidence] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useErpPending(['ar_collection']);
  useResetOnOpen(!!account, () => {
    setCollectedOn(session.calendarToday);
    setMethod('bank_transfer');
    setAmount(account ? centsToInput(account.outstandingCents) : '');
    setEvidence('');
    setNote('');
    setError(null);
  });
  const cents = parseYuan(amount);
  const problem = !account
    ? null
    : pending.length > 0
      ? '上一笔回款结果待确认，请先在页面上方处理'
      : !cents || cents <= 0
        ? '请填写回款金额'
        : cents > account.outstandingCents
          ? `不能超过没结清的 ${formatYuan(account.outstandingCents)}`
          : !collectedOn || collectedOn > session.calendarToday
            ? '回款日期不能晚于今天'
            : null;
  const submit = async () => {
    if (!account || problem || !cents) return;
    setBusy(true);
    setError(null);
    const body = { clientKey: uuid(), accountId: account.id, collectedOn, method, amountCents: cents, evidence: evidence.trim(), note: note.trim() };
    try {
      await sendErpOp({ key: body.clientKey, type: 'ar_collection', url: '/api/erp/receivables/collections', body, summary: `${account.name} 回款 ${formatYuan(cents)}`, staffName: session.staff.displayName });
      toast({ tone: 'success', title: '回款已登记', body: `${account.name} ${formatYuan(cents)}，从最早的挂账开始核销` });
      onClose();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'error', title: '回款登记没收到结果', body: '记在页面上方的「结果待确认」里，查回或按原内容重新提交' });
        onClose();
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
      await qc.invalidateQueries({ queryKey: KEY });
    }
  };
  return (
    <Dialog
      open={!!account}
      onClose={busy ? () => {} : onClose}
      title={account ? `登记回款 · ${account.name}` : '登记回款'}
      description={account ? `没结清 ${formatYuan(account.outstandingCents)}；从最早的挂账开始核销，不能超过没结清的。当月登错了可以冲销。` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!!problem} onClick={() => void submit()} data-testid="ar-collect-confirm">
            登记回款
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="回款日期" htmlFor="col-date">
          <Input id="col-date" type="date" value={collectedOn} max={session.calendarToday} onChange={(e) => setCollectedOn(e.target.value)} className="h-10" />
        </Field>
        <Field label="方式" htmlFor="col-method">
          <Select id="col-method" value={method} onChange={(e) => setMethod(e.target.value as ArMethod)} className="h-10">
            {AR_METHODS.map((m) => (
              <option key={m} value={m}>
                {AR_METHOD_LABELS[m]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="金额（元）" htmlFor="col-amount">
          <MoneyInput id="col-amount" value={amount} onChange={(e) => setAmount(e.target.value)} className="h-10" data-testid="ar-collect-amount" />
        </Field>
        <Field label="凭据（流水号、收据号）" htmlFor="col-evidence" className="sm:col-span-3">
          <Input id="col-evidence" value={evidence} maxLength={64} onChange={(e) => setEvidence(e.target.value)} className="h-10" />
        </Field>
        <Field label="备注" htmlFor="col-note" className="sm:col-span-3">
          <Input id="col-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} className="h-10" />
        </Field>
      </div>
      {problem && account && <p className="mt-2 text-[12.5px] text-ink-3">{problem}</p>}
      {error && <Notice tone="error" title={error} className="mt-3" />}
    </Dialog>
  );
}

function AccountSheet({ id, manage, onClose }: { id: number | null; manage: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const detail = useQuery({ queryKey: [...KEY, 'account', id], queryFn: () => api.get<ArAccountDetail>(`/api/erp/receivables/accounts/${id}`), enabled: id !== null });
  const [voiding, setVoiding] = useState<{ id: number; docNo: string } | null>(null);
  const d = detail.data;
  return (
    <Dialog open={id !== null} onClose={onClose} title={d ? `${d.account.name} · 挂账与回款` : '挂账与回款'} width="max-w-3xl" footer={null}>
      {detail.isPending ? (
        <Skeleton className="h-48" />
      ) : detail.error ? (
        <Notice tone="error" title={errorMessage(detail.error)} />
      ) : d ? (
        <div className="space-y-4" data-testid="ar-account-detail">
          <p className="text-[13px] text-ink-2">
            没结清 <span className="num font-bold">{formatYuan(d.account.outstandingCents)}</span>
            {d.account.creditLimitCents !== null ? ` · 额度 ${formatYuan(d.account.creditLimitCents)}` : ' · 额度不限'}
          </p>
          <section>
            <h3 className="mb-1.5 text-[13px] font-bold text-ink-2">挂账</h3>
            {d.charges.length === 0 ? (
              <p className="text-[12.5px] text-ink-3">还没有挂账。</p>
            ) : (
              <div className="overflow-x-auto rounded-md border border-line">
                <table className="w-full min-w-[560px] text-[12.5px]">
                  <thead className="bg-paper-2 text-left text-ink-3">
                    <tr>
                      <th className="px-2.5 py-1.5 font-semibold">营业日</th>
                      <th className="px-2.5 py-1.5 font-semibold">结账单</th>
                      <th className="px-2.5 py-1.5 font-semibold">签单人</th>
                      <th className="px-2.5 py-1.5 text-right font-semibold">挂账</th>
                      <th className="px-2.5 py-1.5 text-right font-semibold">已回款</th>
                      <th className="px-2.5 py-1.5 text-right font-semibold">挂了</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.charges.map((c) => (
                      <tr key={c.id} className={cn('border-t border-line', c.status === 'voided' && 'opacity-50')}>
                        <td className="num px-2.5 py-1">{c.businessDate}</td>
                        <td className="num px-2.5 py-1">
                          {c.checkoutNo}
                          {c.status === 'voided' && <Badge className="ml-1">已反结账</Badge>}
                        </td>
                        <td className="px-2.5 py-1">{c.signer}</td>
                        <td className="px-2.5 py-1 text-right">
                          <Money cents={c.amountCents} />
                        </td>
                        <td className="px-2.5 py-1 text-right">
                          <Money cents={c.collectedCents} />
                        </td>
                        <td className="num px-2.5 py-1 text-right">{c.status === 'open' && c.collectedCents < c.amountCents ? `${c.ageDays} 天` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section>
            <h3 className="mb-1.5 text-[13px] font-bold text-ink-2">回款</h3>
            {d.collections.length === 0 ? (
              <p className="text-[12.5px] text-ink-3">还没有回款。</p>
            ) : (
              <ul className="space-y-1.5" data-testid="ar-collections">
                {d.collections.map((k) => (
                  <li key={k.id} className={cn('rounded-md border border-line px-3 py-1.5 text-[12.5px]', k.voided && 'opacity-60')}>
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="num font-semibold">{k.docNo}</span>
                      <span className="num">{k.collectedOn}</span>
                      <span>{AR_METHOD_LABELS[k.method]}</span>
                      <Money cents={k.amountCents} className="font-bold" />
                      {k.voided && <Badge>已冲销</Badge>}
                      {manage && !k.voided && (
                        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setVoiding({ id: k.id, docNo: k.docNo })}>
                          冲销
                        </Button>
                      )}
                    </span>
                    <span className="block text-ink-3">
                      核销：{k.allocations.map((x) => `${x.checkoutNo}（${x.businessDate}）${formatYuan(x.amountCents)}`).join('、')}
                      {k.evidence ? ` · 凭据 ${k.evidence}` : ''}
                      {k.voided ? ` · ${k.voided.byName} 冲销：${k.voided.reason}` : ` · ${k.createdByName} ${formatDateTime(k.createdAt)}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : null}
      <ReasonDialog
        open={!!voiding}
        title={voiding ? `冲销回款 · ${voiding.docNo}` : '冲销回款'}
        description="只限当月；冲销以后核销的挂账回到没结清，记录保留。"
        confirmLabel="冲销"
        danger
        onClose={() => setVoiding(null)}
        onConfirm={async (reason) => {
          if (!voiding) return;
          try {
            await api.post(`/api/erp/receivables/collections/${voiding.id}/void`, { reason });
            setVoiding(null);
            await qc.invalidateQueries({ queryKey: KEY });
          } catch (e) {
            toast({ tone: 'error', title: errorMessage(e) });
          }
        }}
      />
    </Dialog>
  );
}

function AgingView() {
  const aging = useQuery({ queryKey: [...KEY, 'aging'], queryFn: () => api.get<ArAging>('/api/erp/receivables/aging') });
  const platforms = useQuery({ queryKey: [...KEY, 'platforms'], queryFn: () => api.get<PlatformReceivable[]>('/api/erp/receivables/platforms') });
  return (
    <div className="space-y-4">
      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[15px] font-bold">账龄</h2>
          {aging.data && <span className="text-[12.5px] text-ink-3">超过 {aging.data.overdueDays} 天没回的标出、进 ERP 待办（经营规则「可调的数值」里改）</span>}
          <a href="/api/erp/receivables/aging/export" className="ml-auto flex h-9 items-center gap-1.5 rounded-md border border-line-strong bg-card px-3 text-[13px] font-bold text-ink-2 hover:border-ink-3">
            <Download className="size-4" />
            导出
          </a>
        </div>
        {aging.error ? (
          <Notice tone="error" title={errorMessage(aging.error)} />
        ) : aging.isPending ? (
          <Skeleton className="h-32" />
        ) : aging.data.rows.length === 0 ? (
          <p className="text-[13px] text-ink-3">没有没回的应收。</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line bg-card">
            <table className="w-full min-w-[720px] text-[13px]" data-testid="ar-aging">
              <thead className="bg-paper-2 text-left text-[12px] text-ink-3">
                <tr>
                  <th className="px-3 py-2 font-semibold">单位 / 平台</th>
                  {AGING_BUCKETS.map((b) => (
                    <th key={b.key} className="px-3 py-2 text-right font-semibold">
                      {b.label}
                    </th>
                  ))}
                  <th className="px-3 py-2 text-right font-semibold">合计</th>
                  <th className="px-3 py-2 text-right font-semibold">逾期</th>
                </tr>
              </thead>
              <tbody>
                {aging.data.rows.map((r) => (
                  <tr key={r.id} className={cn('border-t border-line', r.overdueCents > 0 && 'bg-clay/5')}>
                    <td className="px-3 py-1.5 font-semibold">
                      {r.kind === 'platform' && <Landmark className="mr-1 inline size-3.5 text-ink-3" />}
                      {r.name}
                    </td>
                    {AGING_BUCKETS.map((b) => (
                      <td key={b.key} className="px-3 py-1.5 text-right">
                        {r.buckets[b.key] ? <Money cents={r.buckets[b.key]} /> : <span className="text-ink-4">—</span>}
                      </td>
                    ))}
                    <td className="px-3 py-1.5 text-right font-bold">
                      <Money cents={r.totalCents} />
                    </td>
                    <td className={cn('px-3 py-1.5 text-right', r.overdueCents > 0 && 'font-bold text-clay')}>{r.overdueCents ? <Money cents={r.overdueCents} /> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="space-y-2">
        <h2 className="text-[15px] font-bold">平台团购回款</h2>
        <p className="text-[12.5px] text-ink-3">应结 = 结账登记的团购券 + 平台核销补录的结算金额；已回 = 平台打款登记；与「平台核销」对账同一口径，按核销日先进先出算还没回的。</p>
        {platforms.isPending ? (
          <Skeleton className="h-20" />
        ) : (platforms.data ?? []).length === 0 ? (
          <p className="text-[13px] text-ink-3">还没有团购核销。</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2" data-testid="ar-platforms">
            {platforms.data!.map((p) => (
              <li key={p.platform} className="rounded-lg border border-line bg-card px-4 py-3 text-[13px]">
                <p className="flex items-center gap-2 font-bold">
                  {p.platformLabel}
                  <Money cents={p.outstandingCents} className={cn('ml-auto', p.outstandingCents > 0 && 'text-clay')} />
                </p>
                <p className="text-[12px] text-ink-3">
                  应结 {formatYuan(p.redeemedCents)} · 已回 {formatYuan(p.settledCents)}
                  {p.oldestDate ? ` · 最早没回的 ${p.oldestDate}` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
