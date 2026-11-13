// 补货建议（v0.7.29 ERP 采购五项④，E4，docs/ERP_PURCHASING.md 第 5 节）。
// 总仓物料按日均用量、结存与在途算出该补多少，按供应商分组；采购改数量、去掉不要的行，一键生成采购单草稿，
// 打开草稿核对后提交；合计到询价门槛的（或想先比价的）可以「发起询价」（v0.7.30）。建好的草稿、询价单都算在途，刷新后不会重复建议。

import { PurchasingTabs } from './PurchasingTabs';
import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { ArrowLeft, CloudOff, FilePlus2, FileSearch, Lightbulb } from 'lucide-react';
import type { PurchaseOrder, ReplenishGroup } from '@shared/purchasing';
import { centsToInput, formatAmount, parseYuan } from '@shared/money';
import { fitsDecimals, formatQty, lineAmountCents, parseQty, toBaseQty } from '@shared/quantity';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn, uuid } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Input, MoneyInput, Notice, Select, Skeleton } from '../../components/ui';
import { useMaterials, useSuppliers } from '../inventory/queries';
import { useInvalidateAll, usePurchaseRules, useSuggestions } from './queries';
import { SourcingCreateDialog, type SourcingDraft } from './SourcingPage';

export function SuggestionsPage() {
  const can = useCan();
  const data = useSuggestions();
  if (!can('inventory.read')) return <Navigate to="/" replace />;
  const d = data.data;
  return (
    <>
      <PageHeader
        dateMode="calendar"
        title={
          <span className="flex items-center gap-2.5">
            <Link to="/purchasing" className="-ml-1 flex size-8 items-center justify-center rounded-md text-ink-3 hover:bg-paper-2 hover:text-ink" aria-label="返回采购">
              <ArrowLeft className="size-[18px]" />
            </Link>
            <span className="flex size-8 items-center justify-center rounded-full bg-yuzu-soft text-yuzu-deep">
              <Lightbulb className="size-4" />
            </span>
            补货建议
          </span>
        }
        subtitle={
          d
            ? `总仓物料：按近 ${d.windowDays} 天的日均用量，结存加在途能用的天数少于 ${d.reorderDays} 天（物料设了提醒天数的按物料的）就建议，补到 ${d.targetDays} 天；没有用量的按低库存提醒数量补`
            : '按日均用量、结存与在途算出该补多少'
        }
      />
      <PurchasingTabs active="suggestions" />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1180px] space-y-4 px-5 py-5 md:px-7" data-testid="suggestions-page">
          {data.isPending ? (
            <Skeleton className="h-64" />
          ) : data.error ? (
            <Notice tone="error" title={errorMessage(data.error)} />
          ) : d!.count === 0 ? (
            <EmptyState art="calm" title="现在没有要补的物料" description="结存加在途都够用；物料设了提醒天数或低库存提醒数量才会算进来。" />
          ) : (
            d!.groups.map((g) => <GroupCard key={g.supplier?.id ?? 'none'} group={g} canCreate={can('purchase.manage')} />)
          )}
        </div>
      </div>
    </>
  );
}

interface Pick {
  on: boolean;
  qty: string;
  price: string;
}

function GroupCard({ group, canCreate }: { group: ReplenishGroup; canCreate: boolean }) {
  const session = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const invalidate = useInvalidateAll();
  const suppliers = useSuppliers();
  const materials = useMaterials();
  const purchaseRules = usePurchaseRules();
  const [supplierId, setSupplierId] = useState<number | null>(group.supplier?.id ?? null);
  const [sourcingDraft, setSourcingDraft] = useState<SourcingDraft | null>(null);
  const [picks, setPicks] = useState<Record<number, Pick>>({});
  const [clientKey, setClientKey] = useState(uuid);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setPicks(
      Object.fromEntries(
        group.lines.map((l) => [l.materialId, { on: true, qty: formatQty(l.suggestedPurchaseMilli).replace(/,/g, ''), price: l.priceCents === null ? '' : centsToInput(l.priceCents) }]),
      ),
    );
  }, [group]);
  const rows = useMemo(
    () =>
      group.lines.map((l) => {
        const p = picks[l.materialId] ?? { on: false, qty: '', price: '' };
        const qty = parseQty(p.qty, 3);
        const base = qty !== null ? toBaseQty(qty, l.factorMilli) : null;
        const price = p.price.trim() ? parseYuan(p.price) : null;
        const err = !p.on
          ? null
          : qty === null || qty <= 0
            ? '数量不正确'
            : base === null || !fitsDecimals(base, l.decimals)
              ? `换算后不是整${l.inventoryUnit}`
              : price === null
                ? '请填单价'
                : null;
        return { l, p, qty, price, err, amount: !err && base !== null && price !== null ? lineAmountCents(base, price, l.factorMilli) : null };
      }),
    [group, picks],
  );
  const chosen = rows.filter((r) => r.p.on);
  const total = chosen.reduce((t, r) => t + (r.amount ?? 0), 0);
  const blocking = !supplierId ? '请先选供应商' : chosen.length === 0 ? '请至少勾一行' : (chosen.find((r) => r.err)?.err ?? null);
  // 询价门槛（E5）：合计到门槛的草稿提交时会被拦，先发起询价（v0.7.30）
  const quoteThreshold = purchaseRules.data?.quoteThresholdCents ?? 0;
  const overQuote = quoteThreshold > 0 && total >= quoteThreshold;
  const toSourcing = () => {
    const mats = new Map((materials.data ?? []).map((m) => [m.id, m]));
    const lines = chosen.flatMap((r) => {
      const m = mats.get(r.l.materialId);
      return m ? [{ key: uuid(), material: m, qty: r.p.qty, spec: r.l.specification.slice(0, 80) }] : [];
    });
    if (lines.length === 0) {
      setError('请至少勾一行');
      return;
    }
    const who = suppliers.data?.find((s) => s.id === supplierId)?.name ?? group.supplier?.name;
    setError(null);
    setSourcingDraft({
      title: `补货：${lines[0]!.material.name}${lines.length > 1 ? `等 ${lines.length} 项` : ''}`.slice(0, 40),
      needBy: '',
      note: who ? `补货建议发起（常用供应商：${who}）` : '补货建议发起',
      lines,
    });
  };
  const setPick = (id: number, patch: Partial<Pick>) => setPicks((ps) => ({ ...ps, [id]: { ...ps[id]!, ...patch } }));

  const done = (po: PurchaseOrder) => {
    void invalidate();
    toast({ tone: 'success', title: '采购单草稿已生成', body: `${po.docNo}：核对后提交` });
    navigate(`/purchasing/${po.id}/edit`);
  };
  const create = async () => {
    if (blocking) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ po: PurchaseOrder }>(
        '/api/purchase-orders',
        {
          clientKey,
          supplierId,
          orderDate: session.calendarToday,
          note: '补货建议生成',
          action: 'save',
          lines: chosen.map((r) => ({ materialId: r.l.materialId, purchaseQtyMilli: r.qty, priceCents: r.price, spec: r.l.specification.slice(0, 80) })),
        },
        { timeoutMs: 20_000 },
      );
      done(r.po);
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
      const r = await api.get<{ found: boolean; po?: PurchaseOrder }>(`/api/purchase-orders/by-key/${clientKey}`);
      if (r.found && r.po) done(r.po);
      else {
        // 没有登记：换一个编号，可以重新生成
        setUncertain(false);
        setClientKey(uuid());
        setError('刚才那次没有生成，可以重新点「生成采购单草稿」');
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="overflow-hidden" data-testid={`suggest-group-${group.supplier?.id ?? 'none'}`}>
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        {group.supplier ? (
          <h2 className="text-[14.5px] font-bold">{group.supplier.name}</h2>
        ) : (
          <Select fullWidth={false} aria-label="选供应商" value={supplierId ?? ''} onChange={(e) => setSupplierId(Number(e.target.value) || null)} className="h-9 w-56" data-testid="suggest-supplier">
            <option value="">未定供应商：先选一家</option>
            {suppliers.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code} · {s.name}
              </option>
            ))}
          </Select>
        )}
        <Badge tone="yuzu">{group.lines.length} 种</Badge>
        <span className="text-[12.5px] text-ink-3">
          勾选的合计 <Money cents={total} className="font-semibold text-ink-2" />
        </span>
        {canCreate && (
          <span className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {blocking && <span className="text-[12px] font-semibold text-clay">{blocking}</span>}
            {overQuote && (
              <span className="text-[12px] font-semibold text-yuzu-deep" data-testid="suggest-over-quote">
                合计到了询价门槛 ¥{formatAmount(quoteThreshold)}，要先询价
              </span>
            )}
            <Button
              variant={overQuote ? 'primary' : 'secondary'}
              size="sm"
              icon={<FileSearch className="size-4" />}
              disabled={chosen.length === 0 || busy || uncertain}
              onClick={toSourcing}
              data-testid="suggest-sourcing"
            >
              发起询价
            </Button>
            <Button
              variant={overQuote ? 'secondary' : 'primary'}
              size="sm"
              icon={<FilePlus2 className="size-4" />}
              disabled={!!blocking || busy || uncertain}
              loading={busy}
              onClick={() => void create()}
              data-testid="suggest-create"
            >
              生成采购单草稿
            </Button>
          </span>
        )}
      </div>
      {uncertain && (
        <Notice tone="warning" icon={<CloudOff className="size-5" />} title="生成结果待确认：网络断了或超时，不知道草稿有没有建好" className="m-4">
          <Button variant="secondary" size="sm" loading={busy} onClick={() => void check()} data-testid="suggest-check">
            查回
          </Button>
        </Notice>
      )}
      {error && <Notice tone="error" title={error} className="m-4" />}
      <ul className="divide-y divide-line/70">
        {rows.map(({ l, p, err, amount }) => (
          <li
            key={l.materialId}
            className={cn('grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 px-4 py-3 md:grid-cols-[auto_minmax(0,1fr)_120px_120px_110px]', p.on && 'bg-pine-tint/30')}
            data-testid={`suggest-line-${l.materialId}`}
          >
            <input
              type="checkbox"
              className="mt-1 size-4 accent-[var(--color-pine)]"
              aria-label={`补 ${l.name}`}
              checked={p.on}
              disabled={!canCreate}
              onChange={(e) => setPick(l.materialId, { on: e.target.checked })}
            />
            <span className="min-w-0 text-[12.5px]">
              <span className="block truncate text-[13.5px] font-semibold">
                <span className="num mr-1.5 text-ink-3">{l.code}</span>
                {l.name}
                {l.specification && <span className="ml-1.5 font-normal text-ink-3">{l.specification}</span>}
              </span>
              <span className="block text-ink-2">
                结存 {formatQty(l.stockMilli)} {l.inventoryUnit}
                {l.inTransitMilli > 0 && ` · 在途 ${formatQty(l.inTransitMilli)}（${l.openPos.join('、')}）`}
                {l.reason === 'cover'
                  ? ` · 日均 ${formatQty(l.dailyUsageMilli ?? 0)} · 够用 ${l.daysOfCover} 天（少于 ${l.triggerDays} 天）→ 补到 ${l.targetDays} 天`
                  : ` · 近期没有用量，低于提醒数量 ${formatQty(l.lowStockMilli ?? 0)}`}
              </span>
              {err && <span className="block font-semibold text-clay">{err}</span>}
            </span>
            <label className="col-start-2 flex items-center gap-1.5 text-[12.5px] text-ink-3 md:col-start-auto">
              <Input
                aria-label={`${l.name} 采购数量`}
                inputMode="decimal"
                value={p.qty}
                disabled={!canCreate || !p.on}
                onChange={(e) => setPick(l.materialId, { qty: e.target.value })}
                className="h-9 text-right"
                data-testid={`suggest-qty-${l.materialId}`}
              />
              {l.purchaseUnit}
            </label>
            <label className="col-start-2 flex items-center gap-1.5 text-[12.5px] text-ink-3 md:col-start-auto" title={l.priceSource === 'last' ? '最近一次成交价' : l.priceSource === 'ref' ? '参考价' : '没有价格，请填'}>
              <MoneyInput aria-label={`${l.name} 单价`} value={p.price} disabled={!canCreate || !p.on} onChange={(e) => setPick(l.materialId, { price: e.target.value })} className="h-9 text-right" />
            </label>
            <span className="col-start-2 text-right md:col-start-auto md:self-center">{amount !== null ? <Money cents={amount} className="font-bold" /> : <span className="text-ink-4">—</span>}</span>
          </li>
        ))}
      </ul>
      <SourcingCreateDialog open={!!sourcingDraft} onClose={() => setSourcingDraft(null)} initial={sourcingDraft ?? undefined} />
    </Card>
  );
}
