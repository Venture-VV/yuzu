// 询价比价与定标（v0.7.29 ERP 采购五项⑤，E5–E8，docs/ERP_PURCHASING.md 第 6 节）。
// 列表：询价单（询价中 / 已定标 / 已撤销）；新建：物料与数量（采购单位）。
// 详情：比价表（每家的单价、货款、运费、综合到价、付款条件、交货、有效期；每行最低价与最低综合到价标出），登记 / 撤下报价，
// 定标（理由必填；报价不够家数的标单一来源、负责人定标），转采购单（生成草稿），撤销定标、撤销询价单。

import { useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import { ArrowLeft, Award, CloudOff, FileSearch, FileText, Plus, Scale, Trash2 } from 'lucide-react';
import type { Material } from '@shared/inventory';
import { centsToInput, formatAmount, parseYuan } from '@shared/money';
import { SOURCING_STATUS_LABELS, type PurchaseOrder, type SourcingEvent, type SourcingQuote, type SourcingStatus } from '@shared/purchasing';
import { fitsDecimals, formatQty, parseQty, toBaseQty } from '@shared/quantity';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { cn, formatDateTime, uuid } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, MoneyInput, Notice, Select, Skeleton, Textarea } from '../../components/ui';
import { MaterialPicker } from '../inventory/inputs';
import { useMaterials, useSuppliers } from '../inventory/queries';
import { PriceHistoryButton } from './PriceHistory';
import { useInvalidateAll, usePurchaseRules, useSourcing, useSourcingList } from './queries';

const STATUS_TONE: Record<SourcingStatus, 'yuzu' | 'pine' | 'neutral'> = { open: 'yuzu', awarded: 'pine', cancelled: 'neutral' };

function Back({ to }: { to: string }) {
  return (
    <Link to={to} className="-ml-1 flex size-8 items-center justify-center rounded-md text-ink-3 hover:bg-paper-2 hover:text-ink" aria-label="返回">
      <ArrowLeft className="size-[18px]" />
    </Link>
  );
}

// ───────────────────────── 列表 ─────────────────────────

export function SourcingPage() {
  const can = useCan();
  const rules = usePurchaseRules();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const list = useSourcingList({ status: status || undefined });
  const [creating, setCreating] = useState(false);
  if (!can('inventory.read')) return <Navigate to="/" replace />;
  const gate = rules.data?.quoteThresholdCents ?? 0;
  return (
    <>
      <PageHeader
        dateMode="calendar"
        title={
          <span className="flex items-center gap-2.5">
            <Back to="/purchasing" />
            <span className="flex size-8 items-center justify-center rounded-full bg-lake-soft text-lake">
              <Scale className="size-4" />
            </span>
            询价比价
          </span>
        }
        subtitle={
          gate > 0
            ? `合计 ¥${formatAmount(gate)} 及以上的采购单要先询价（至少 ${rules.data?.minQuotes ?? 2} 家报价）并定标，再从询价单转采购单`
            : '同一批物料让几家供应商报价，按综合到价比，定标写理由，再转采购单'
        }
        actions={
          can('purchase.manage') && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)} data-testid="sourcing-new">
              新建询价单
            </Button>
          )
        }
      />
      <div className="flex shrink-0 flex-wrap gap-1.5 border-b border-line px-5 py-3 md:px-7" role="radiogroup" aria-label="状态">
        {[{ value: '', label: '全部' }, ...(['open', 'awarded', 'cancelled'] as const).map((s) => ({ value: s, label: SOURCING_STATUS_LABELS[s] }))].map((f) => (
          <button
            key={f.value}
            type="button"
            role="radio"
            aria-checked={status === f.value}
            onClick={() => setParams(f.value ? { status: f.value } : {}, { replace: true })}
            className={cn('h-8 rounded-full px-3 text-[13px] font-semibold', status === f.value ? 'bg-ink text-paper' : 'bg-paper-2 text-ink-2 hover:bg-paper-3')}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1180px] px-5 py-5 md:px-7" data-testid="sourcing-list">
          {list.isPending ? (
            <Skeleton className="h-48" />
          ) : list.error ? (
            <Notice tone="error" title={errorMessage(list.error)} />
          ) : list.data!.length === 0 ? (
            <EmptyState art="search" title="还没有询价单" description="大额或新物料先询价：同一批物料让几家报价，比综合到价后定标。" />
          ) : (
            <Card className="overflow-hidden">
              <ul className="divide-y divide-line/70">
                {list.data!.map((e) => (
                  <li key={e.id}>
                    <Link to={`/purchasing/sourcing/${e.id}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-4 py-3 hover:bg-paper-2 md:grid-cols-[160px_minmax(0,1fr)_120px_140px]" data-testid={`sourcing-row-${e.id}`}>
                      <span className="num text-[13.5px] font-bold">
                        {e.docNo}
                        <span className="block font-sans text-[12px] font-medium text-ink-3">{e.createdAt.slice(0, 10)} · {e.createdByName}</span>
                      </span>
                      <span className="min-w-0 text-[12.5px]">
                        <span className="block truncate text-[13.5px] font-semibold">{e.title}</span>
                        <span className="block truncate text-ink-3">
                          {e.summary}
                          {e.lineCount > 3 && ` 等 ${e.lineCount} 项`} · {e.quoteCount} 家报价
                          {e.awardedSupplierName && ` · 中标 ${e.awardedSupplierName}`}
                          {e.purchaseOrder && ` · 采购单 ${e.purchaseOrder.docNo}`}
                        </span>
                      </span>
                      <span className="text-right text-[12.5px] text-ink-3 md:self-center">
                        {e.lowestLandedCents !== null ? (
                          <>
                            最低到价 <Money cents={e.lowestLandedCents} className="font-bold text-ink" />
                          </>
                        ) : (
                          '还没有报价'
                        )}
                      </span>
                      <span className="flex justify-end md:self-center">
                        <Badge tone={STATUS_TONE[e.status]}>{SOURCING_STATUS_LABELS[e.status]}</Badge>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
      <CreateDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

interface DraftLine {
  key: string;
  material: Material;
  qty: string;
}

function CreateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const session = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const invalidate = useInvalidateAll();
  const materials = useMaterials();
  const [title, setTitle] = useState('');
  const [needBy, setNeedBy] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [clientKey, setClientKey] = useState(uuid);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(open, () => {
    setTitle('');
    setNeedBy('');
    setNote('');
    setLines([]);
    setClientKey(uuid());
    setUncertain(false);
    setError(null);
  });
  const rows = lines.map((l) => {
    const qty = parseQty(l.qty, 3);
    const base = qty !== null ? toBaseQty(qty, l.material.purchaseFactorMilli) : null;
    const err = qty === null || qty <= 0 ? '数量不正确' : base === null || !fitsDecimals(base, l.material.decimals) ? `换算后不是整${l.material.inventoryUnit}` : null;
    return { l, qty, err };
  });
  const blocking = !title.trim() ? '请写询价内容' : rows.length === 0 ? '请至少加一项物料' : (rows.find((r) => r.err)?.err ?? null);
  const done = (e: SourcingEvent) => {
    void invalidate();
    toast({ tone: 'success', title: '询价单已建好', body: `${e.docNo}：接着登记各家报价` });
    onClose();
    navigate(`/purchasing/sourcing/${e.id}`);
  };
  const submit = async () => {
    if (blocking) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ event: SourcingEvent }>(
        '/api/purchase-sourcing',
        { clientKey, title: title.trim(), needBy: needBy || null, note: note.trim(), lines: rows.map((r) => ({ materialId: r.l.material.id, purchaseQtyMilli: r.qty })) },
        { timeoutMs: 20_000 },
      );
      done(r.event);
    } catch (e) {
      if (e instanceof UncertainError) setUncertain(true);
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const check = async () => {
    setBusy(true);
    try {
      const r = await api.get<{ found: boolean; event?: SourcingEvent }>(`/api/purchase-sourcing/by-key/${clientKey}`);
      if (r.found && r.event) done(r.event);
      else {
        setUncertain(false);
        setClientKey(uuid());
        setError('刚才那次没有建好，可以重新提交');
      }
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
      title="新建询价单"
      description="物料与数量建好后不改（要改就撤销重建）；数量按采购单位"
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" disabled={!!blocking || uncertain} loading={busy} onClick={() => void submit()} data-testid="sourcing-create">
            建询价单
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="询价内容" htmlFor="sc-title" className="sm:col-span-2">
          <Input id="sc-title" value={title} maxLength={40} onChange={(e) => setTitle(e.target.value)} placeholder="例如：客用毛巾 50 打" className="h-10" data-testid="sc-title" />
        </Field>
        <Field label="要货日期" htmlFor="sc-need" hint="选填">
          <Input id="sc-need" type="date" value={needBy} min={session.calendarToday} onChange={(e) => setNeedBy(e.target.value)} className="h-10" />
        </Field>
        <Field label="物料" className="sm:col-span-3">
          <MaterialPicker
            materials={materials.data ?? []}
            taken={new Set(lines.map((l) => l.material.id))}
            onPick={(m) => setLines((ls) => [...ls, { key: uuid(), material: m, qty: '' }])}
            placeholder="搜索物料：编码 / 名称，回车加入"
          />
        </Field>
      </div>
      {rows.length > 0 && (
        <ul className="mt-3 divide-y divide-line rounded-lg border border-line">
          {rows.map(({ l, err }, i) => (
            <li key={l.key} className="grid grid-cols-[minmax(0,1fr)_130px_32px] items-center gap-2 px-3 py-2">
              <span className="min-w-0 text-[13px]">
                <span className="block truncate font-semibold">
                  <span className="num mr-1.5 text-ink-3">{l.material.code}</span>
                  {l.material.name}
                </span>
                {err && l.qty.trim() && <span className="text-[12px] font-semibold text-clay">{err}</span>}
              </span>
              <label className="flex items-center gap-1.5 text-[12.5px] text-ink-3">
                <Input
                  aria-label={`${l.material.name} 数量`}
                  inputMode="decimal"
                  value={l.qty}
                  onChange={(e) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, qty: e.target.value } : x)))}
                  className="h-9 text-right"
                  data-testid={`sc-qty-${i}`}
                />
                {l.material.purchaseUnit}
              </label>
              <Button variant="ghost" size="sm" icon={<Trash2 className="size-4" />} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label={`删除 ${l.material.name}`} />
            </li>
          ))}
        </ul>
      )}
      <Field label="备注" htmlFor="sc-note" className="mt-3">
        <Textarea id="sc-note" rows={2} value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="可选：规格要求、送货要求" />
      </Field>
      {uncertain && (
        <Notice tone="warning" icon={<CloudOff className="size-5" />} title="提交结果待确认：网络断了或超时" className="mt-3">
          <Button variant="secondary" size="sm" loading={busy} onClick={() => void check()}>
            查回
          </Button>
        </Notice>
      )}
      {blocking && !uncertain && <p className="mt-3 text-[12.5px] font-semibold text-clay">{blocking}</p>}
      {error && <Notice tone="error" title={error} className="mt-3" />}
    </Dialog>
  );
}

// ───────────────────────── 详情：比价、报价、定标、转采购单 ─────────────────────────

export function SourcingDetailPage() {
  const can = useCan();
  const { id } = useParams();
  const eventId = Number(id) || null;
  const ev = useSourcing(eventId);
  if (!can('inventory.read')) return <Navigate to="/" replace />;
  return (
    <>
      <PageHeader
        dateMode="calendar"
        title={
          <span className="flex items-center gap-2.5">
            <Back to="/purchasing/sourcing" />
            <span className="flex size-8 items-center justify-center rounded-full bg-lake-soft text-lake">
              <FileSearch className="size-4" />
            </span>
            {ev.data ? `${ev.data.docNo} · ${ev.data.title}` : '询价单'}
            {ev.data && <Badge tone={STATUS_TONE[ev.data.status]}>{SOURCING_STATUS_LABELS[ev.data.status]}</Badge>}
          </span>
        }
        subtitle="综合到价 = 货款合计 + 运费；账期、交货、售后不折算进价格，定标理由里写清"
      />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1180px] space-y-4 px-5 py-5 md:px-7" data-testid="sourcing-detail">
          {ev.isPending ? <Skeleton className="h-64" /> : ev.error ? <Notice tone="error" title={errorMessage(ev.error)} /> : <Detail ev={ev.data!} />}
        </div>
      </div>
    </>
  );
}

type Pending = { kind: 'withdraw'; quote: SourcingQuote } | { kind: 'reopen' } | { kind: 'cancel' } | null;

function Detail({ ev }: { ev: SourcingEvent }) {
  const can = useCan();
  const toast = useToast();
  const navigate = useNavigate();
  const invalidate = useInvalidateAll();
  const [quoting, setQuoting] = useState(false);
  const [awarding, setAwarding] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [orderKey, setOrderKey] = useState(uuid);
  const [orderUncertain, setOrderUncertain] = useState(false);
  const manage = can('purchase.manage');
  const active = ev.quotes.filter((q) => q.status === 'active').sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  const withdrawn = ev.quotes.filter((q) => q.status === 'withdrawn');
  const awarded = ev.quotes.find((q) => q.id === ev.awardedQuoteId) ?? null;

  const act = async (path: string, body: unknown, success: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.post(path, body);
      await invalidate();
      toast({ tone: 'success', title: success, body: ev.docNo });
      setPending(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const openPo = (po: PurchaseOrder) => {
    void invalidate();
    toast({ tone: 'success', title: '采购单草稿已生成', body: `${po.docNo}：核对后提交` });
    navigate(`/purchasing/${po.id}/edit`);
  };
  const order = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ po: PurchaseOrder }>(`/api/purchase-sourcing/${ev.id}/order`, { clientKey: orderKey }, { timeoutMs: 20_000 });
      openPo(r.po);
    } catch (e) {
      if (e instanceof UncertainError) setOrderUncertain(true);
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const checkOrder = async () => {
    setBusy(true);
    try {
      const r = await api.get<{ found: boolean; po?: PurchaseOrder }>(`/api/purchase-orders/by-key/${orderKey}`);
      if (r.found && r.po) openPo(r.po);
      else {
        setOrderUncertain(false);
        setOrderKey(uuid());
        setError('刚才那次没有生成，可以重新点「转采购单」');
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card className="grid gap-x-5 gap-y-2 p-4 text-[13px] sm:grid-cols-3">
        <span>
          <span className="text-ink-3">建单</span> {ev.createdByName} · {formatDateTime(ev.createdAt)}
        </span>
        <span>
          <span className="text-ink-3">要货日期</span> <span className="num">{ev.needBy ?? '—'}</span>
        </span>
        <span>
          <span className="text-ink-3">有效报价</span> {active.length} 家（定标至少 {ev.minQuotes} 家）
        </span>
        {ev.note && <span className="sm:col-span-3">{ev.note}</span>}
        {ev.status === 'awarded' && awarded && (
          <span className="sm:col-span-3" data-testid="sourcing-awarded">
            <Badge tone="pine" icon={<Award className="size-3.5" />}>
              中标 {awarded.supplier.name}
            </Badge>
            {ev.singleSource && <Badge tone="ember" className="ml-1.5">单一来源</Badge>}
            <span className="ml-2 text-ink-2">
              理由：{ev.awardReason}（{ev.awardedByName} · {ev.awardedAt ? formatDateTime(ev.awardedAt) : ''}）
            </span>
          </span>
        )}
        {ev.status === 'cancelled' && <span className="text-ink-3 sm:col-span-3">已撤销：{ev.cancelReason}</span>}
        {ev.purchaseOrder && (
          <span className="sm:col-span-3">
            <span className="text-ink-3">采购单 </span>
            <Link to={`/purchasing?po=${ev.purchaseOrder.id}`} className="num font-semibold text-lake hover:underline" data-testid="sourcing-po">
              {ev.purchaseOrder.docNo}
            </Link>
          </span>
        )}
      </Card>

      {manage && ev.status !== 'cancelled' && (
        <div className="flex flex-wrap gap-2">
          {ev.status === 'open' && (
            <>
              <Button variant="secondary" icon={<Plus className="size-4" />} onClick={() => setQuoting(true)} data-testid="quote-new">
                登记报价
              </Button>
              <Button variant="primary" icon={<Award className="size-4" />} disabled={active.length === 0} onClick={() => setAwarding(true)} data-testid="award-open">
                定标
              </Button>
            </>
          )}
          {ev.status === 'awarded' && !ev.purchaseOrder && (
            <>
              <Button variant="primary" icon={<FileText className="size-4" />} loading={busy} disabled={orderUncertain} onClick={() => void order()} data-testid="sourcing-order">
                转采购单
              </Button>
              <Button variant="secondary" onClick={() => setPending({ kind: 'reopen' })}>
                撤销定标
              </Button>
            </>
          )}
          {!ev.purchaseOrder && (
            <Button variant="ghost" onClick={() => setPending({ kind: 'cancel' })}>
              撤销询价单
            </Button>
          )}
        </div>
      )}
      {!manage && can('inventory.approve') && ev.status === 'open' && active.length > 0 && (
        <Button variant="primary" icon={<Award className="size-4" />} onClick={() => setAwarding(true)} data-testid="award-open">
          定标（负责人）
        </Button>
      )}
      {orderUncertain && (
        <Notice tone="warning" icon={<CloudOff className="size-5" />} title="转采购单结果待确认：网络断了或超时">
          <Button variant="secondary" size="sm" loading={busy} onClick={() => void checkOrder()}>
            查回
          </Button>
        </Notice>
      )}
      {error && <Notice tone="error" title={error} />}

      <Compare ev={ev} quotes={active} />

      {withdrawn.length > 0 && (
        <Card className="p-4 text-[12.5px] text-ink-3">
          <p className="mb-1 font-semibold text-ink-2">撤下的报价</p>
          {withdrawn.map((q) => (
            <p key={q.id}>
              {q.supplier.name} · 综合到价 ¥{formatAmount(q.landedCents)} · 撤下原因：{q.withdrawReason}（{q.withdrawnByName}）
            </p>
          ))}
        </Card>
      )}

      {manage && ev.status === 'open' && active.length > 0 && (
        <div className="flex flex-wrap gap-2 text-[12.5px]">
          {active.map((q) => (
            <Button key={q.id} variant="ghost" size="sm" onClick={() => setPending({ kind: 'withdraw', quote: q })} data-testid={`quote-withdraw-${q.id}`}>
              撤下 {q.supplier.name} 的报价
            </Button>
          ))}
        </div>
      )}

      <QuoteDialog ev={ev} open={quoting} onClose={() => setQuoting(false)} />
      <AwardDialog ev={ev} quotes={active} open={awarding} onClose={() => setAwarding(false)} />
      <ReasonDialog
        open={pending?.kind === 'withdraw'}
        title={pending?.kind === 'withdraw' ? `撤下 ${pending.quote.supplier.name} 的报价` : ''}
        description="撤下后这家可以重新报价"
        confirmLabel="撤下"
        busy={busy}
        testId="quote-withdraw"
        onClose={() => setPending(null)}
        onConfirm={(reason) => pending?.kind === 'withdraw' && void act(`/api/purchase-sourcing/quotes/${pending.quote.id}/withdraw`, { reason }, '报价已撤下')}
      />
      <ReasonDialog
        open={pending?.kind === 'reopen'}
        title="撤销定标"
        description="回到询价中，可以改报价、重新定标"
        confirmLabel="撤销定标"
        busy={busy}
        onClose={() => setPending(null)}
        onConfirm={(reason) => void act(`/api/purchase-sourcing/${ev.id}/reopen`, { reason }, '已撤销定标')}
      />
      <ReasonDialog
        open={pending?.kind === 'cancel'}
        title="撤销询价单"
        description="撤销后不能再报价、定标"
        confirmLabel="撤销询价单"
        danger
        busy={busy}
        onClose={() => setPending(null)}
        onConfirm={(reason) => void act(`/api/purchase-sourcing/${ev.id}/cancel`, { reason }, '询价单已撤销')}
      />
    </>
  );
}

/** 比价表：行是物料与合计，列是各家有效报价（按综合到价排序）；每行最低价、最低综合到价标绿 */
function Compare({ ev, quotes }: { ev: SourcingEvent; quotes: SourcingQuote[] }) {
  const lowestLanded = quotes.length ? Math.min(...quotes.map((q) => q.landedCents)) : null;
  return (
    <Card className="overflow-x-auto" data-testid="sourcing-compare">
      <table className="w-full min-w-[640px] border-collapse text-[12.5px]">
        <thead>
          <tr className="border-b border-line text-left text-[12px] text-ink-3">
            <th className="px-3 py-2 font-semibold">物料 · 数量</th>
            <th className="px-3 py-2 text-right font-semibold">最近成交价</th>
            {quotes.map((q) => (
              <th key={q.id} className={cn('px-3 py-2 text-right font-semibold', q.id === ev.awardedQuoteId && 'bg-pine-tint')}>
                <span className="block text-[13px] font-bold text-ink">{q.supplier.name}</span>
                <span className="font-normal">第 {q.rank} 名</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ev.lines.map((l) => (
            <tr key={l.id} className="border-b border-line/70">
              <td className="px-3 py-2">
                <span className="flex items-center gap-1">
                  <span className="min-w-0">
                    <span className="block font-semibold">{l.materialName}</span>
                    <span className="text-ink-3">
                      {formatQty(l.purchaseQtyMilli)} {l.purchaseUnit}
                      {l.spec && ` · ${l.spec}`}
                    </span>
                  </span>
                  <PriceHistoryButton materialId={l.materialId} name={l.materialName} />
                </span>
              </td>
              <td className="px-3 py-2 text-right text-ink-2">{l.baseline ? `¥${formatAmount(l.baseline.priceCents)}` : '—'}</td>
              {quotes.map((q) => {
                const p = q.prices.find((x) => x.lineId === l.id)!;
                const best = ev.lowest[l.id] === q.id;
                return (
                  <td key={q.id} className={cn('px-3 py-2 text-right', q.id === ev.awardedQuoteId && 'bg-pine-tint/60')} data-testid={`cell-${l.id}-${q.id}`}>
                    <span className={cn('font-semibold', best && 'text-pine')}>¥{formatAmount(p.priceCents)}</span>
                    {p.changePercent !== null && (
                      <span className={cn('block text-[11px]', p.changePercent > 0 ? 'text-clay' : p.changePercent < 0 ? 'text-pine' : 'text-ink-3')}>
                        {p.changePercent > 0 ? '+' : ''}
                        {p.changePercent.toFixed(2)}%
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
          <Row label="货款合计" quotes={quotes} ev={ev} render={(q) => `¥${formatAmount(q.goodsCents)}`} />
          <Row label="运费" quotes={quotes} ev={ev} render={(q) => (q.freightCents ? `¥${formatAmount(q.freightCents)}` : '含')} />
          <tr className="border-b border-line bg-paper-2/60 font-bold">
            <td className="px-3 py-2">综合到价</td>
            <td />
            {quotes.map((q) => (
              <td key={q.id} className={cn('px-3 py-2 text-right', q.landedCents === lowestLanded && 'text-pine')} data-testid={`landed-${q.id}`}>
                ¥{formatAmount(q.landedCents)}
              </td>
            ))}
          </tr>
          <Row label="付款条件" quotes={quotes} ev={ev} render={(q) => `${q.payTerms}${q.creditDays ? `（${q.creditDays} 天）` : ''}`} />
          <Row label="交货" quotes={quotes} ev={ev} render={(q) => (q.deliveryDays === null ? '—' : `${q.deliveryDays} 天`)} />
          <Row label="有效期至" quotes={quotes} ev={ev} render={(q) => q.validUntil ?? '—'} />
          <Row label="备注" quotes={quotes} ev={ev} render={(q) => q.note || '—'} />
        </tbody>
      </table>
      {quotes.length === 0 && <p className="px-4 py-6 text-center text-[13px] text-ink-3">还没有有效报价：点「登记报价」录入各家的单价、运费与付款条件</p>}
    </Card>
  );
}

function Row({ label, quotes, ev, render }: { label: string; quotes: SourcingQuote[]; ev: SourcingEvent; render: (q: SourcingQuote) => string }) {
  return (
    <tr className="border-b border-line/70">
      <td className="px-3 py-2 text-ink-2">{label}</td>
      <td />
      {quotes.map((q) => (
        <td key={q.id} className={cn('px-3 py-2 text-right', q.id === ev.awardedQuoteId && 'bg-pine-tint/60')}>
          {render(q)}
        </td>
      ))}
    </tr>
  );
}

function QuoteDialog({ ev, open, onClose }: { ev: SourcingEvent; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const suppliers = useSuppliers();
  const taken = useMemo(() => new Set(ev.quotes.filter((q) => q.status === 'active').map((q) => q.supplier.id)), [ev.quotes]);
  const [supplierId, setSupplierId] = useState('');
  const [prices, setPrices] = useState<Record<number, string>>({});
  const [freight, setFreight] = useState('');
  const [payTerms, setPayTerms] = useState('');
  const [creditDays, setCreditDays] = useState('');
  const [deliveryDays, setDeliveryDays] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [note, setNote] = useState('');
  const [clientKey, setClientKey] = useState(uuid);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(open, () => {
    setSupplierId('');
    setPrices(Object.fromEntries(ev.lines.map((l) => [l.id, l.baseline ? centsToInput(l.baseline.priceCents) : ''])));
    setFreight('');
    setPayTerms('');
    setCreditDays('');
    setDeliveryDays('');
    setValidUntil('');
    setNote('');
    setClientKey(uuid());
    setError(null);
  });
  const parsed = ev.lines.map((l) => ({ l, cents: prices[l.id]?.trim() ? parseYuan(prices[l.id]!) : null }));
  const freightCents = freight.trim() ? parseYuan(freight) : 0;
  const ints = (t: string) => (t.trim() ? Number(t) : null);
  const blocking = !supplierId
    ? '请选供应商'
    : parsed.some((p) => p.cents === null)
      ? '每行都要填含税单价'
      : freightCents === null
        ? '运费格式不正确'
        : !payTerms.trim()
          ? '请写付款条件，例如「月结 30 天」'
          : null;
  const save = async () => {
    if (blocking) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/purchase-sourcing/${ev.id}/quotes`, {
        clientKey,
        supplierId: Number(supplierId),
        freightCents,
        payTerms: payTerms.trim(),
        creditDays: ints(creditDays) ?? 0,
        deliveryDays: ints(deliveryDays),
        validUntil: validUntil || null,
        note: note.trim(),
        prices: parsed.map((p) => ({ lineId: p.l.id, priceCents: p.cents })),
      });
      await invalidate();
      toast({ tone: 'success', title: '报价已登记', body: ev.docNo });
      onClose();
    } catch (e) {
      setError(e instanceof UncertainError ? '结果待确认：刷新看看这家的报价有没有登记上，没有再重新登记' : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title="登记报价"
      description="每一项物料都要报含税单价（按采购单位）；单价预填最近成交价，按供应商报的改"
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" disabled={!!blocking} loading={busy} onClick={() => void save()} data-testid="quote-save">
            登记报价
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="供应商" htmlFor="qt-supplier">
          <Select id="qt-supplier" value={supplierId} onChange={(e) => setSupplierId(e.target.value)} data-testid="qt-supplier">
            <option value="">选供应商</option>
            {suppliers.data?.map((s) => (
              <option key={s.id} value={s.id} disabled={taken.has(s.id)}>
                {s.code} · {s.name}
                {taken.has(s.id) ? '（已报价）' : ''}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="运费" htmlFor="qt-freight" hint="含在单价里的不填">
          <MoneyInput id="qt-freight" value={freight} onChange={(e) => setFreight(e.target.value)} className="h-10" data-testid="qt-freight" />
        </Field>
      </div>
      <ul className="mt-3 divide-y divide-line rounded-lg border border-line">
        {ev.lines.map((l) => (
          <li key={l.id} className="grid grid-cols-[minmax(0,1fr)_150px] items-center gap-2 px-3 py-2 text-[13px]">
            <span className="min-w-0 truncate">
              <b>{l.materialName}</b>
              <span className="text-ink-3">
                {' '}
                {formatQty(l.purchaseQtyMilli)} {l.purchaseUnit}
              </span>
            </span>
            <label className="flex items-center gap-1 text-[12px] text-ink-3">
              <MoneyInput aria-label={`${l.materialName} 含税单价`} value={prices[l.id] ?? ''} onChange={(e) => setPrices((p) => ({ ...p, [l.id]: e.target.value }))} className="h-9 text-right" data-testid={`qt-price-${l.id}`} />/{l.purchaseUnit}
            </label>
          </li>
        ))}
      </ul>
      <div className="mt-3 grid gap-3 sm:grid-cols-4">
        <Field label="付款条件" htmlFor="qt-terms" className="sm:col-span-2">
          <Input id="qt-terms" value={payTerms} maxLength={30} onChange={(e) => setPayTerms(e.target.value)} placeholder="月结 30 天 / 现付 / 预付 50%" className="h-10" data-testid="qt-terms" />
        </Field>
        <Field label="账期天数" htmlFor="qt-credit">
          <Input id="qt-credit" inputMode="numeric" value={creditDays} onChange={(e) => setCreditDays(e.target.value)} placeholder="0" className="h-10" />
        </Field>
        <Field label="交货天数" htmlFor="qt-delivery">
          <Input id="qt-delivery" inputMode="numeric" value={deliveryDays} onChange={(e) => setDeliveryDays(e.target.value)} placeholder="选填" className="h-10" />
        </Field>
        <Field label="报价有效期至" htmlFor="qt-valid" className="sm:col-span-2">
          <Input id="qt-valid" type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} className="h-10" />
        </Field>
        <Field label="备注" htmlFor="qt-note" className="sm:col-span-2">
          <Input id="qt-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="售后、换货、开票" className="h-10" />
        </Field>
      </div>
      {blocking && <p className="mt-3 text-[12.5px] font-semibold text-clay">{blocking}</p>}
      {error && <Notice tone="error" title={error} className="mt-3" />}
    </Dialog>
  );
}

function AwardDialog({ ev, quotes, open, onClose }: { ev: SourcingEvent; quotes: SourcingQuote[]; open: boolean; onClose: () => void }) {
  const can = useCan();
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const [quoteId, setQuoteId] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [single, setSingle] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notEnough = quotes.length < ev.minQuotes;
  useResetOnOpen(open, () => {
    setQuoteId(quotes[0]?.id ?? null);
    setReason('');
    setSingle(false);
    setError(null);
  });
  const blocking = !quoteId
    ? '请选中标的报价'
    : reason.trim().length < 2
      ? '请写定标理由'
      : notEnough && !single
        ? `有效报价只有 ${quotes.length} 家，不够 ${ev.minQuotes} 家：确实只能找这一家的，勾「单一来源」`
        : notEnough && !can('inventory.approve')
          ? '单一来源要由负责人定标'
          : notEnough && reason.trim().length < 4
            ? '单一来源请写清原因（至少 4 个字）'
            : null;
  const save = async () => {
    if (blocking) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/purchase-sourcing/${ev.id}/award`, { quoteId, reason: reason.trim(), singleSource: notEnough && single });
      await invalidate();
      toast({ tone: 'success', title: '已定标', body: `${ev.docNo}：可以转采购单了` });
      onClose();
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
      title="定标"
      description="选中标的一家并写理由：综合到价、账期、交货、售后、历史履约，为什么选它"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" disabled={!!blocking} loading={busy} onClick={() => void save()} data-testid="award-save">
            定标
          </Button>
        </>
      }
    >
      <ul className="space-y-1.5">
        {quotes.map((q) => (
          <li key={q.id}>
            <label className={cn('flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-[13px]', quoteId === q.id ? 'border-pine bg-pine-tint/40' : 'border-line')}>
              <input type="radio" name="award-quote" className="accent-[var(--color-pine)]" checked={quoteId === q.id} onChange={() => setQuoteId(q.id)} data-testid={`award-quote-${q.id}`} />
              <span className="flex-1 font-semibold">
                第 {q.rank} 名 · {q.supplier.name}
              </span>
              <span className="text-ink-3">{q.payTerms}</span>
              <Money cents={q.landedCents} className="font-bold" />
            </label>
          </li>
        ))}
      </ul>
      {notEnough && (
        <label className="mt-3 flex items-start gap-2 text-[13px]">
          <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-pine)]" checked={single} onChange={(e) => setSingle(e.target.checked)} data-testid="award-single" />
          <span>
            <b>单一来源</b>
            <span className="block text-[12px] text-ink-3">
              有效报价不够 {ev.minQuotes} 家；确实只能找这一家（品牌指定、独家代理等）的勾上并写清原因，由负责人定标
            </span>
          </span>
        </label>
      )}
      <Field label="定标理由" htmlFor="award-reason" className="mt-3">
        <Textarea id="award-reason" rows={3} value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="例如：综合到价最低、月结 30 天、上季度准时到货" data-testid="award-reason" />
      </Field>
      {blocking && <p className="mt-3 text-[12.5px] font-semibold text-clay">{blocking}</p>}
      {error && <Notice tone="error" title={error} className="mt-3" />}
    </Dialog>
  );
}
