// 补货建议（v0.7.29 ERP 采购五项④，E4，docs/ERP_PURCHASING.md 第 5 节）。
// 总仓物料按日均用量、结存与在途算出该补多少，按供应商分组；采购改数量、去掉不要的行，一键生成采购单草稿，
// 打开草稿核对后提交；合计到询价门槛的（或想先比价的）可以「发起询价」（v0.7.30）。建好的草稿、询价单都算在途，刷新后不会重复建议。
// 补货方式（店主 2026-11-14，迁移 161，第 5.1 节）：手机这类不是消耗品的不该提补货——每行有「不用备货」（定为按需采购）；
// 页面下方「没提补货的」列出本来会提、识别为不用补的物料与原因（按需采购 / 建过资产卡片 / 只领过一次），一键改成常备、按需采购或改回自动识别。

import { AutoReplenishCard } from './AutoReplenishCard';
import { PurchasingTabs } from './PurchasingTabs';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, Navigate, useNavigate } from 'react-router';
import { ArrowLeft, ChevronDown, CloudOff, FilePlus2, FileSearch, Lightbulb } from 'lucide-react';
import { REPLENISH_MODE_LABELS, type Material, type ReplenishMode } from '@shared/inventory';
import { describeDate } from '@shared/labels';
import type { PurchaseOrder, ReplenishGroup, ReplenishSkipped, ReplenishSuggestions } from '@shared/purchasing';
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
  const modeOps = useReplenishModeOps();
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
            ? `总仓物料：按近 ${d.windowDays} 天的日均用量，结存加在途能用的天数少于 ${d.reorderDays} 天（物料设了提醒天数的按物料的）就建议，补到 ${d.targetDays} 天；没有用量的按低库存提醒数量补。按需采购的、只领过一次的不提`
            : '按日均用量、结存与在途算出该补多少'
        }
      />
      <PurchasingTabs active="suggestions" />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1180px] space-y-4 px-5 py-5 md:px-7" data-testid="suggestions-page">
          <AutoReplenishCard />
          {data.isPending ? (
            <Skeleton className="h-64" />
          ) : data.error ? (
            <Notice tone="error" title={errorMessage(data.error)} />
          ) : (
            <>
              {modeOps.pending && (
                <Notice
                  tone="warning"
                  icon={<CloudOff className="size-5" />}
                  title={`「${modeOps.pending.name}」的补货方式结果待确认：要改成「${REPLENISH_MODE_LABELS[modeOps.pending.mode].title}」，网络断了或超时，不知道改没改成`}
                  data-testid="mode-pending"
                >
                  <p className="mb-2">点「再试一次」按原样重提（已经改成了的不会重复改；这之后被别人改过的会明确告诉你没改）。确认之前，补货建议页上的补货方式先不能改；刷新、离开再回来这一条都还在。</p>
                  <Button variant="secondary" size="sm" loading={modeOps.busyId !== null} onClick={() => void modeOps.retry()} data-testid="mode-pending-retry">
                    再试一次
                  </Button>
                </Notice>
              )}
              {d!.count === 0 ? (
                <EmptyState
                  art="calm"
                  title="现在没有要补的物料"
                  description="常备的、经常领用的物料结存加在途都够用。手机、设备这类按需采购的东西不在这里提，部门提需求单再买。"
                />
              ) : (
                d!.groups.map((g) => <GroupCard key={g.supplier?.id ?? 'none'} group={g} canCreate={can('purchase.manage')} canMode={can('inventory.master')} mode={modeOps} />)
              )}
              {d!.skipped.length > 0 && <SkippedCard data={d!} canMode={can('inventory.master')} mode={modeOps} />}
            </>
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
  /** 人动过（改了数量、单价，或者勾掉 / 勾回）：建议刷新时保持原样 */
  touched?: boolean;
}

interface ModeOp {
  materialId: number;
  name: string;
  /** 要改成的 */
  mode: ReplenishMode;
  /** 页面上看到的补货方式版本号：服务端对不上就拒绝（晚到的旧请求不会盖掉后来的修改，改走又改回也认得出来） */
  expectedRev: number;
}

// 改补货方式的「结果待确认」存在本机浏览器里（一次只有一个）：提交前先存下并读回核对，存不了就不发请求；
// 有了结论（成功、被明确拒绝、读回来版本号已经变了）才删。刷新、离开页面再回来都还在。
const MODE_PENDING_KEY = 'yuzu.replenishModePending.v1';
function loadModePending(): ModeOp | null {
  try {
    const p = JSON.parse(localStorage.getItem(MODE_PENDING_KEY) ?? 'null') as Partial<ModeOp> | null;
    return p && typeof p.materialId === 'number' && typeof p.expectedRev === 'number' && typeof p.mode === 'string' && typeof p.name === 'string' ? (p as ModeOp) : null;
  } catch {
    return null;
  }
}
/** 写入并读回核对：写不进去返回 false */
function storeModePending(op: ModeOp | null): boolean {
  const raw = op ? JSON.stringify(op) : null;
  try {
    if (raw === null) localStorage.removeItem(MODE_PENDING_KEY);
    else localStorage.setItem(MODE_PENDING_KEY, raw);
    return localStorage.getItem(MODE_PENDING_KEY) === raw;
  } catch {
    return false;
  }
}

/**
 * 改一个物料的补货方式（只改这一项）：改完补货建议、物料档案一起刷新。整页共用一份，同一时刻只发一个。
 *
 * 断网、超时或服务器出错时不知道改没改成（合并前 Codex 审查 e3cfbd0、测试会话在 44ddeb5 上的复验）：
 *   · 提交前把这次请求存在本机，没有结论之前页面上一直留着「结果待确认」，补货方式都不能再改；
 *   · 只能按原样「再试一次」：已经是要改成的值服务端照常返回；这之后被改过的（版本号对不上）明确拒绝；
 *   · 也会自己读回这个物料：版本号变了就有结论——是要改成的值算改成了，不是就说明之后又被改过、那次请求不会再生效。
 */
function useReplenishModeOps() {
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [pending, setPendingState] = useState<ModeOp | null>(loadModePending);
  const settle = () => {
    storeModePending(null);
    setPendingState(null);
  };
  const done = (op: ModeOp) =>
    toast({
      tone: 'success',
      title: `「${op.name}」已${op.mode === 'on_demand' ? '定为按需采购' : op.mode === 'stock' ? '设为常备' : '改回自动识别'}`,
      body: op.mode === 'on_demand' ? '以后不提补货、不做低库存提醒；在下面「没提补货的」或物料档案里可以改回来' : REPLENISH_MODE_LABELS[op.mode].hint,
    });
  const send = async (op: ModeOp) => {
    // 先存下再发：存不了就不发（不然断网以后没有地方记着这次请求）
    if (!storeModePending(op)) {
      toast({ tone: 'error', title: '没有提交', body: '这台电脑的浏览器存不了「结果待确认」记录（存储已满或被禁用），请清理浏览器数据或换一台电脑再试' });
      return;
    }
    setBusyId(op.materialId);
    try {
      await api.put<Material>(`/api/inventory/materials/${op.materialId}/replenish-mode`, { mode: op.mode, expectedRev: op.expectedRev });
      settle();
      done(op);
    } catch (e) {
      if (e instanceof UncertainError) {
        setPendingState(op);
        toast({ tone: 'error', title: '网络断了或超时，不知道补货方式改没改成', body: '页面上留了一条「结果待确认」，点「再试一次」按原样重提' });
      } else {
        // 明确被拒绝（没权限、这之后又被改过……）：没有生效，刷新后按页面上的为准
        settle();
        toast({ tone: 'error', title: '补货方式没改成', body: errorMessage(e) });
      }
    } finally {
      await invalidate();
      setBusyId(null);
    }
  };
  // 待确认的那一个：读回这个物料。版本号变了就有结论（要等这一次读回来的是最新的）
  const check = useQuery({
    queryKey: ['inv', 'material-replenish', pending?.materialId ?? 0],
    queryFn: () => api.get<Material>(`/api/inventory/materials/${pending!.materialId}`),
    enabled: pending !== null && busyId === null,
    staleTime: 0,
  });
  useEffect(() => {
    const m = check.data;
    if (!pending || busyId !== null || !m || check.isFetching || m.id !== pending.materialId) return;
    if (m.replenishRev === pending.expectedRev && m.replenishMode !== pending.mode) return; // 还没生效，也还可能晚到
    settle();
    if (m.replenishMode === pending.mode) done(pending);
    else toast({ tone: 'info', title: `「${pending.name}」的补货方式之后又被改过`, body: `现在是「${REPLENISH_MODE_LABELS[m.replenishMode].title}」，刚才那次修改不会再生效` });
    void invalidate();
  }, [check.data, check.isFetching, pending, busyId]);
  return {
    busyId,
    pending,
    /** 正在发，或者有一个还没确认：别的先不能改 */
    locked: busyId !== null || pending !== null,
    setMode: (m: { materialId: number; name: string; modeRev: number }, to: ReplenishMode) => send({ materialId: m.materialId, name: m.name, mode: to, expectedRev: m.modeRev }),
    retry: () => (pending ? send(pending) : Promise.resolve()),
  };
}
type ModeOps = ReturnType<typeof useReplenishModeOps>;

function GroupCard({ group, canCreate, canMode, mode }: { group: ReplenishGroup; canCreate: boolean; canMode: boolean; mode: ModeOps }) {
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
  // 建议刷新了（这一组里有一行改了补货方式、别处建了草稿……）：人动过的行（改过数量、单价，或者去掉了勾）保持原样，
  // 没动过的跟着新的建议量走，新出现的行按建议量——不然点一行的「不用备货」会把别的行改好的数量、去掉的勾都冲掉
  //（合并前 Codex 审查 e3cfbd0）
  useEffect(() => {
    setPicks((prev) =>
      Object.fromEntries(
        group.lines.map((l) => [
          l.materialId,
          prev[l.materialId]?.touched
            ? prev[l.materialId]!
            : { on: true, qty: formatQty(l.suggestedPurchaseMilli).replace(/,/g, ''), price: l.priceCents === null ? '' : centsToInput(l.priceCents) },
        ]),
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
  const setPick = (id: number, patch: Partial<Pick>) => setPicks((ps) => ({ ...ps, [id]: { ...ps[id]!, ...patch, touched: true } }));

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
                {l.owedMilli > 0 && ` · 欠着没扣 ${formatQty(l.owedMilli)}`}
                {l.reason === 'cover'
                  ? ` · 日均 ${formatQty(l.dailyUsageMilli ?? 0)} · 够用 ${l.daysOfCover} 天（少于 ${l.triggerDays} 天）→ 补到 ${l.targetDays} 天`
                  : l.lowStockMilli === null
                    ? ' · 卖出、出品的用料还没扣上，把欠的补上'
                    : ` · 近期没有用量，低于提醒数量 ${formatQty(l.lowStockMilli)}`}
              </span>
              {err && <span className="block font-semibold text-clay">{err}</span>}
              {canMode && (
                <button
                  type="button"
                  className="mt-0.5 text-[12px] font-semibold text-ink-3 underline decoration-line-strong underline-offset-2 hover:text-ink disabled:opacity-50"
                  title="不是消耗品（手机、设备这类部门提需求才买的）：定为按需采购，以后不提补货"
                  disabled={mode.locked || busy}
                  onClick={() => void mode.setMode(l, 'on_demand')}
                  data-testid={`suggest-off-${l.materialId}`}
                >
                  不用备货
                </button>
              )}
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

/** 没提补货的原因，一句话 */
function skipReason(r: ReplenishSkipped, d: ReplenishSuggestions): string {
  if (r.why === 'on_demand') return '物料档案里定了按需采购';
  if (r.why === 'asset') return `建过资产卡片（${r.assetNo}${r.assetCount > 1 ? ` 等 ${r.assetCount} 张` : ''}），按资产管`;
  const last = r.lastUsedOn ? `，最近一次 ${describeDate(r.lastUsedOn).md}` : '';
  return `近 ${d.lookbackDays} 天只有 ${r.useDays} 天有领用${last}，看作一次性采购`;
}

/** 本来会提、识别为不用补的（E12）：默认收起，展开看原因、改补货方式 */
function SkippedCard({ data, canMode, mode }: { data: ReplenishSuggestions; canMode: boolean; mode: ModeOps }) {
  const [open, setOpen] = useState(false);
  const counts = { on_demand: 0, asset: 0, sporadic: 0 };
  for (const r of data.skipped) counts[r.why] += 1;
  const summary = [
    counts.sporadic ? `${data.regularUseDays === 2 ? '只领过一次的' : `领用不到 ${data.regularUseDays} 天的`} ${counts.sporadic} 种` : '',
    counts.asset ? `建过资产卡片的 ${counts.asset} 种` : '',
    counts.on_demand ? `按需采购的 ${counts.on_demand} 种` : '',
  ]
    .filter(Boolean)
    .join('、');
  return (
    <Card className="overflow-hidden" data-testid="suggest-skipped">
      <button
        type="button"
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-paper-2/60"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-testid="suggest-skipped-toggle"
      >
        <h2 className="text-[14.5px] font-bold">没提补货的</h2>
        <Badge>{data.skipped.length} 种</Badge>
        <span className="min-w-0 flex-1 text-[12.5px] text-ink-3">{summary}。结存不多了，但不像是要一直备着的东西，点开看原因</span>
        <ChevronDown className={cn('size-4 shrink-0 text-ink-3 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <>
          <p className="border-t border-line px-4 py-2.5 text-[12.5px] text-ink-3">
            自动识别：设了提醒天数或提醒数量的、台面日耗品这类消耗品（还有管效期、称重的）、近 {data.lookbackDays} 天有 {data.regularUseDays} 天以上领用的才提补货；认错了在这里改，或者到「库存 → 档案」里改物料的补货方式。
          </p>
          <ul className="divide-y divide-line/70 border-t border-line">
            {data.skipped.map((r) => (
              <li key={r.materialId} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3" data-testid={`suggest-skip-${r.materialId}`}>
                <span className="min-w-0 flex-1 basis-64 text-[12.5px]">
                  <span className="block truncate text-[13.5px] font-semibold">
                    <span className="num mr-1.5 text-ink-3">{r.code}</span>
                    {r.name}
                    {r.specification && <span className="ml-1.5 font-normal text-ink-3">{r.specification}</span>}
                  </span>
                  <span className="block text-ink-2">
                    结存 {formatQty(r.stockMilli)} {r.inventoryUnit}
                    {r.inTransitMilli > 0 && ` · 在途 ${formatQty(r.inTransitMilli)}`}
                    {r.owedMilli > 0 && ` · 欠着没扣 ${formatQty(r.owedMilli)}`} · {skipReason(r, data)}
                  </span>
                </span>
                {canMode && (
                  <span className="flex flex-wrap gap-2">
                    {r.mode === 'on_demand' ? (
                      <Button variant="secondary" size="sm" disabled={mode.locked} loading={mode.busyId === r.materialId} onClick={() => void mode.setMode(r, 'auto')} data-testid={`suggest-skip-auto-${r.materialId}`}>
                        改回自动识别
                      </Button>
                    ) : (
                      <Button variant="secondary" size="sm" disabled={mode.locked} loading={mode.busyId === r.materialId} onClick={() => void mode.setMode(r, 'on_demand')} data-testid={`suggest-skip-off-${r.materialId}`}>
                        定为按需采购
                      </Button>
                    )}
                    <Button variant="secondary" size="sm" disabled={mode.locked} onClick={() => void mode.setMode(r, 'stock')} data-testid={`suggest-skip-stock-${r.materialId}`}>
                      要备货，设为常备
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
