import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ArrowRight, Download, Hourglass, Search, TriangleAlert, X } from 'lucide-react';
import { CENTRAL_WAREHOUSE_ID, INV_DOC_META, INV_STATUS_LABELS, ISSUE_SIGN_DUE_DAYS, MOVE_TYPE_LABELS, SUPPLIER_ANSWER_DUE_DAYS, type InvDocType, type Material, type WarehouseStockRow } from '@shared/inventory';
import { formatAmount } from '@shared/money';
import { conversionText, formatQty } from '@shared/quantity';
import { errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn, downloadUrl, formatDateTime, relativeTime } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { Sheet } from '../../components/Overlay';
import { Badge, Button, IconButton, Notice, Skeleton, Spinner } from '../../components/ui';
import { DOC_VISUAL, MoveIcon, PackHint, Qty, StockMeter } from './parts';
import { useMaterials, useOverview, useStockCard, useWarehouseStock, useWarehouses } from './queries';
import { useMedia } from './useMedia';
import type { StocktakeProgress } from '@shared/cycles';
import { useStocktakeReminders } from '../cycles/queries';
import { StocktakeNotice } from '../cycles/StocktakeNotice';

/** 工作台上的快捷入口（顺序即日常频率） */
const ACTIONS: InvDocType[] = ['receipt', 'issue', 'issue_return', 'direct_use', 'damage', 'count', 'supplier_return', 'opening'];

export function StockTab() {
  const can = useCan();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const selectedId = Number(params.get('m')) || null;
  // 两级库存（v0.7.11）：看总仓还是某个部门小仓
  const warehouseId = Number(params.get('wh')) || CENTRAL_WAREHOUSE_ID;
  const dept = warehouseId !== CENTRAL_WAREHOUSE_ID;
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<string>('all');
  const materials = useMaterials();
  const overview = useOverview();
  const warehouses = useWarehouses();
  const deptStock = useWarehouseStock(dept ? warehouseId : null);
  const wide = useMedia('(min-width: 1280px)');
  const session = useSession();
  // 每月盘点提醒（#23，v0.7.13）：总仓给仓库，所有部门小仓给成本核算与负责人
  const stocktake = useStocktakeReminders(can('inventory.operate') || can('deptStock.audit') || can('inventory.approve'));
  const stocktakeLink = (w: StocktakeProgress) =>
    w.kind === 'central'
      ? can('inventory.operate')
        ? '/inventory/new/count'
        : null
      : can('deptStock.audit') && session.erpModules.includes('deptStock') && w.departmentId
        ? `/erp/dept-stock/new/count?dept=${w.departmentId}`
        : null;

  const tracked = useMemo(() => (materials.data ?? []).filter((m) => m.tracked), [materials.data]);
  const categories = useMemo(() => [...new Set(tracked.map((m) => m.category || '未分类'))], [tracked]);
  const list = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return tracked.filter((m) => {
      if (filter === 'low' && !m.isLow) return false;
      if (filter === 'empty' && m.hasMoves) return false;
      if (filter.startsWith('c:') && (m.category || '未分类') !== filter.slice(2)) return false;
      const text = `${m.code} ${m.name} ${m.specification} ${m.category}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
  }, [tracked, q, filter]);
  const noOpening = tracked.filter((m) => !m.hasMoves).length;

  const select = (id: number | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('m', String(id));
    else next.delete('m');
    setParams(next, { replace: true });
  };
  const chooseWarehouse = (id: number) => {
    const next = new URLSearchParams(params);
    if (id === CENTRAL_WAREHOUSE_ID) next.delete('wh');
    else next.set('wh', String(id));
    setParams(next, { replace: true });
  };
  const deptRows = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (deptStock.data ?? []).filter((r) => words.every((w) => `${r.code} ${r.name} ${r.specification} ${r.category}`.toLowerCase().includes(w)));
  }, [deptStock.data, q]);

  const canAct = (t: InvDocType) => (t === 'supplier_return' ? can('supplierReturn.create') : can('inventory.operate'));

  const detail = selectedId ? <MaterialDetail key={`${selectedId}-${warehouseId}`} id={selectedId} warehouseId={warehouseId} onClose={() => select(null)} closable={!wide} /> : null;
  const todo = overview.data
    ? [
        { n: overview.data.urgentToVerify, label: '急采待仓库验收', to: '/inventory/docs?type=receipt&urgent=1&status=submitted' },
        { n: overview.data.unsignedIssues, label: `领料超过 ${ISSUE_SIGN_DUE_DAYS} 天部门没签收`, to: '/inventory/docs?type=issue&unsigned=1' },
        { n: overview.data.urgentToBackfill, label: '急采待补采购单', to: '/inventory/docs?type=receipt&urgent=1&status=confirmed' },
        {
          n: overview.data.awaitingSupplier,
          label: overview.data.awaitingSupplierOverdue
            ? `退货待供应商确认（其中 ${overview.data.awaitingSupplierOverdue} 张超过 ${SUPPLIER_ANSWER_DUE_DAYS} 天）`
            : '退货待供应商确认',
          to: '/inventory/docs?type=supplier_return&status=awaiting_supplier',
        },
      ].filter((t) => t.n > 0)
    : [];

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 概览与快捷入口 */}
        <div className="shrink-0 space-y-3 border-b border-line px-5 py-4 md:px-7">
          <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
            <Tile label="受管物料" value={overview.data?.materialCount} sub={noOpening ? `${noOpening} 项未建期初` : '均已建期初'} onClick={() => setFilter(noOpening ? 'empty' : 'all')} />
            <Tile label="低库存提醒" value={overview.data?.lowCount} tone={overview.data?.lowCount ? 'clay' : undefined} sub="可用天数不足或低于提醒线" onClick={() => setFilter('low')} />
            <Tile
              label="待确认单据"
              value={overview.data?.pendingApprovals}
              tone={overview.data?.pendingApprovals ? 'yuzu' : undefined}
              sub={can('inventory.approve') ? '去待办处理' : '等待负责人确认'}
              onClick={() => navigate(can('inventory.approve') ? '/todo' : '/inventory/docs?status=submitted')}
            />
            <Tile label="今日收发" value={overview.data ? overview.data.todayIn + overview.data.todayOut : undefined} sub={overview.data ? `入库 ${overview.data.todayIn} 单 · 出库 ${overview.data.todayOut} 单` : ' '} onClick={() => navigate('/inventory/docs')} />
          </div>
          {todo.length > 0 && (
            <div className="flex flex-wrap gap-2" data-testid="inv-todo-chips">
              {todo.map((t) => (
                <Link key={t.label} to={t.to} className="flex h-8 items-center gap-1.5 rounded-full bg-yuzu-soft px-3 text-[12.5px] font-bold text-yuzu-deep hover:bg-yuzu-tint">
                  {t.label} <span className="num">{t.n}</span>
                  <ArrowRight className="size-3.5" />
                </Link>
              ))}
            </div>
          )}
          <StocktakeNotice data={stocktake.data} linkFor={stocktakeLink} />
          {ACTIONS.some(canAct) && (
            <div className="flex flex-wrap gap-2">
              {ACTIONS.filter((t) => canAct(t) && (t !== 'opening' || noOpening > 0)).map((t) => {
                const v = DOC_VISUAL[t];
                const Icon = v.icon;
                const primary = t === 'receipt' || t === 'issue';
                return (
                  <Link
                    key={t}
                    to={`/inventory/new/${t}`}
                    className={cn(
                      'flex h-10 items-center gap-2 rounded-md px-3.5 text-[13.5px] font-bold transition-colors',
                      primary ? 'bg-pine text-paper hover:bg-pine-hover' : 'border border-line-strong bg-card text-ink-2 hover:border-ink-3 hover:text-ink',
                    )}
                  >
                    <Icon className="size-4" />
                    {INV_DOC_META[t].title}
                  </Link>
                );
              })}
            </div>
          )}
        </div>

        {/* 搜索与筛选 */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-5 py-3 md:px-7">
          {(warehouses.data?.length ?? 0) > 1 && (
            <select
              value={warehouseId}
              onChange={(e) => chooseWarehouse(Number(e.target.value))}
              aria-label="仓库"
              data-testid="warehouse-select"
              className="h-9 rounded-md border border-line-strong bg-card px-2.5 text-[13px] font-semibold outline-none focus:border-pine"
            >
              {warehouses.data!.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.kind === 'central' ? `总仓 · ${w.name}` : w.name}
                  {!w.active ? '（已停用）' : ''}
                </option>
              ))}
            </select>
          )}
          <div className="relative min-w-[200px] flex-1 md:max-w-xs">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="编码 / 名称 / 规格"
              aria-label="搜索物料"
              className="h-9 w-full rounded-md border border-line-strong bg-card pr-3 pl-9 text-[13px] outline-none focus:border-pine"
            />
          </div>
          {!dept && (
            <>
              <FilterChip active={filter === 'all'} onClick={() => setFilter('all')}>
                全部 {tracked.length}
              </FilterChip>
              <FilterChip active={filter === 'low'} onClick={() => setFilter('low')} tone="clay">
                低库存 {tracked.filter((m) => m.isLow).length}
              </FilterChip>
              {categories.map((c) => (
                <FilterChip key={c} active={filter === `c:${c}`} onClick={() => setFilter(`c:${c}`)}>
                  {c}
                </FilterChip>
              ))}
            </>
          )}
          {dept && <span className="text-[12.5px] text-ink-3">部门小仓的东西由部门登记耗用、盘点；仓库在这里看结存，领料与退回照常登记</span>}
        </div>

        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4 md:px-7">
          {dept ? (
            deptStock.error ? (
              <Notice tone="error" title={errorMessage(deptStock.error)} />
            ) : deptStock.isPending ? (
              <Skeleton className="h-48" />
            ) : deptRows.length === 0 ? (
              <EmptyState art="leaf" title="这个部门小仓里还没有东西" description="仓库登记领料、急采验收后，或者部门登记了期初，这里就会有结存。" className="rounded-lg border border-dashed border-line-strong" />
            ) : (
              <ul className="overflow-hidden rounded-lg border border-line bg-card shadow-card" aria-label="部门小仓结存">
                {deptRows.map((r) => (
                  <DeptRow key={r.materialId} r={r} selected={r.materialId === selectedId} onSelect={() => select(r.materialId)} />
                ))}
              </ul>
            )
          ) : materials.error ? (
            <Notice tone="error" title={errorMessage(materials.error)} />
          ) : materials.isPending ? (
            <div className="space-y-2">
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="h-14" />
              ))}
            </div>
          ) : tracked.length === 0 ? (
            <EmptyState
              art="leaf"
              title="还没有受管物料"
              description={can('inventory.master') ? '先在「档案」里建立物料，再录入期初库存。' : '请采购经办或店主先建立物料档案。'}
              action={
                can('inventory.master') && (
                  <Button variant="primary" onClick={() => navigate('/inventory/master')}>
                    去建立档案
                  </Button>
                )
              }
              className="rounded-lg border border-dashed border-line-strong"
            />
          ) : list.length === 0 ? (
            <EmptyState art="search" title="没有符合条件的物料" description="换个关键词或筛选试试。" className="rounded-lg border border-dashed border-line-strong" />
          ) : (
            <ul className="overflow-hidden rounded-lg border border-line bg-card shadow-card" aria-label="物料库存">
              {list.map((m) => (
                <MaterialRow key={m.id} m={m} selected={m.id === selectedId} onSelect={() => select(m.id)} />
              ))}
            </ul>
          )}
        </div>
      </div>

      {wide ? (
        <aside className="flex w-[440px] shrink-0 flex-col border-l border-line bg-paper-2/40 2xl:w-[500px]">
          {detail ?? <EmptyState art="calm" title="选择一项物料" description="查看当前库存、包装换算和完整的库存流水。" className="my-auto" />}
        </aside>
      ) : (
        <Sheet open={!!selectedId} onClose={() => select(null)} label="物料库存详情" width="w-[min(500px,100vw)]">
          {detail}
        </Sheet>
      )}
    </div>
  );
}

function Tile({ label, value, sub, tone, onClick }: { label: string; value: number | undefined; sub: string; tone?: 'clay' | 'yuzu'; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative overflow-hidden rounded-lg border border-line bg-card px-4 py-2.5 text-left shadow-card transition-colors hover:border-line-strong"
    >
      <span className={cn('absolute top-0 left-0 h-full w-1', tone === 'clay' ? 'bg-clay' : tone === 'yuzu' ? 'bg-yuzu' : 'bg-line-strong')} />
      <p className="text-[12px] font-semibold text-ink-3">{label}</p>
      <p className={cn('num text-[22px] leading-tight font-bold', tone === 'clay' ? 'text-clay' : tone === 'yuzu' ? 'text-yuzu-deep' : 'text-ink')}>
        {value ?? <span className="inline-block h-6 w-8 animate-pulse rounded bg-paper-3" />}
      </p>
      <p className="truncate text-[12px] text-ink-3">{sub}</p>
    </button>
  );
}

function FilterChip({ active, onClick, children, tone }: { active: boolean; onClick: () => void; children: ReactNode; tone?: 'clay' }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'h-8 rounded-full px-3 text-[12.5px] font-semibold whitespace-nowrap transition-colors',
        active ? (tone === 'clay' ? 'bg-clay text-paper' : 'bg-ink text-paper') : 'border border-line-strong bg-card text-ink-2 hover:border-ink-3',
      )}
    >
      {children}
    </button>
  );
}

function MaterialRow({ m, selected, onSelect }: { m: Material; selected: boolean; onSelect: () => void }) {
  return (
    <li className="border-b border-line/70 last:border-0">
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected || undefined}
        className={cn(
          'grid w-full grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2.5 text-left transition-colors md:grid-cols-[52px_minmax(0,1fr)_140px_auto]',
          selected ? 'bg-pine-tint' : 'hover:bg-paper/70',
        )}
      >
        <span className="num text-[12px] font-semibold text-ink-3">{m.code}</span>
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <span className="truncate text-[14px] font-bold" title={m.name}>
              {m.name}
            </span>
            {m.isLow && <Badge tone="clay">低库存</Badge>}
            {!m.hasMoves && <Badge tone="yuzu">未建期初</Badge>}
          </span>
          <span className="block truncate text-[12px] text-ink-3">
            {m.specification || '—'} · {conversionText(m.purchaseUnit, m.purchaseFactorMilli, m.inventoryUnit)}
          </span>
        </span>
        <span className="hidden text-[12px] text-ink-3 md:block">
          <StockMeter stock={m.stockMilli} low={m.lowStockMilli} className="mb-1" />
          {coverText(m)}
        </span>
        <span className="text-right">
          <Qty milli={m.stockMilli} unit={m.inventoryUnit} className={cn('text-[17px] font-bold', m.isLow && 'text-clay')} />
          <span className="block text-[11.5px] text-ink-3">
            {m.deptStockMilli > 0 ? (
              <>
                部门小仓 <Qty milli={m.deptStockMilli} unit={m.inventoryUnit} />
              </>
            ) : (
              relativeTime(m.lastMoveAt)
            )}
          </span>
        </span>
      </button>
    </li>
  );
}

/** 部门小仓里的一项物料（v0.7.11） */
function DeptRow({ r, selected, onSelect }: { r: WarehouseStockRow; selected: boolean; onSelect: () => void }) {
  return (
    <li className="border-b border-line/70 last:border-0">
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected || undefined}
        className={cn('grid w-full grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2.5 text-left transition-colors', selected ? 'bg-pine-tint' : 'hover:bg-paper/70', r.stockMilli === 0 && 'opacity-60')}
      >
        <span className="num text-[12px] font-semibold text-ink-3">{r.code}</span>
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <span className="truncate text-[14px] font-bold">{r.name}</span>
            {r.isLow && <Badge tone="clay">低库存</Badge>}
          </span>
          <span className="block truncate text-[12px] text-ink-3">{r.specification || '—'}</span>
        </span>
        <span className="text-right">
          <Qty milli={r.stockMilli} unit={r.inventoryUnit} className={cn('text-[17px] font-bold', r.isLow && 'text-clay')} />
          <span className="block text-[11.5px] text-ink-3">
            {r.daysOfCover !== null ? `可用 ${r.daysOfCover} 天${r.coverDays !== null ? ` · 提醒 ${r.coverDays} 天` : ''}` : relativeTime(r.lastMoveAt)}
          </span>
        </span>
      </button>
    </li>
  );
}

function MaterialDetail({ id, warehouseId: initialWarehouse, onClose, closable }: { id: number; warehouseId: number; onClose: () => void; closable: boolean }) {
  const can = useCan();
  const session = useSession();
  const [warehouseId, setWarehouseId] = useState(initialWarehouse);
  const card = useStockCard(id, warehouseId);
  const [limit, setLimit] = useState(30);
  useEffect(() => setLimit(30), [id, warehouseId]);

  if (card.error) return <Notice tone="error" title={errorMessage(card.error)} className="m-5" />;
  if (!card.data)
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  const { material: m, moves, pending, balances } = card.data;
  const central = card.data.warehouse.kind === 'central';
  const balance = balances.find((b) => b.warehouseId === card.data.warehouse.id)?.stockMilli ?? 0;
  const quick: InvDocType[] = ['issue', 'receipt', 'count', 'damage'];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 border-b border-line bg-card px-5 pt-4 pb-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="num text-[12px] font-semibold text-ink-3">
              {m.code} · {m.category || '未分类'}
            </p>
            <h2 className="text-[18px] leading-snug font-bold">{m.name}</h2>
            <p className="text-[12.5px] text-ink-3">{m.specification || '未填写规格'}</p>
          </div>
          {closable && (
            <IconButton label="关闭" onClick={onClose} className="-mt-1 -mr-2">
              <X className="size-[18px]" />
            </IconButton>
          )}
        </div>
        {balances.length > 1 && (
          <div className="mt-3 flex flex-wrap gap-1.5" role="radiogroup" aria-label="看哪个仓的库存卡">
            {balances.map((b) => (
              <button
                key={b.warehouseId}
                type="button"
                role="radio"
                aria-checked={b.warehouseId === card.data.warehouse.id}
                onClick={() => setWarehouseId(b.warehouseId)}
                className={cn(
                  'flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-semibold',
                  b.warehouseId === card.data.warehouse.id ? 'bg-ink text-paper' : 'border border-line-strong bg-card text-ink-2 hover:border-ink-3',
                )}
              >
                {b.kind === 'central' ? '总仓' : b.name}
                <Qty milli={b.stockMilli} unit={m.inventoryUnit} unitClassName="opacity-70" />
              </button>
            ))}
          </div>
        )}
        <div className="mt-3 flex items-end justify-between gap-4 rounded-lg bg-paper-2/70 px-4 py-3">
          <div>
            <p className="text-[12px] font-semibold text-ink-3">{central ? '总仓当前库存' : `${card.data.warehouse.name}当前库存`}</p>
            <Qty milli={balance} unit={m.inventoryUnit} className={cn('text-[30px] leading-tight font-bold', central && m.isLow && 'text-clay')} />
            <PackHint milli={balance} factorMilli={m.purchaseFactorMilli} purchaseUnit={m.purchaseUnit} inventoryUnit={m.inventoryUnit} className="ml-2" />
            {central && m.deptStockMilli > 0 && (
              <p className="text-[12px] text-ink-3">
                各部门小仓合计 <Qty milli={m.deptStockMilli} unit={m.inventoryUnit} />
              </p>
            )}
          </div>
          <div className="text-right text-[12px] text-ink-3">
            <p>{conversionText(m.purchaseUnit, m.purchaseFactorMilli, m.inventoryUnit)}</p>
            <p>{coverText(m)}</p>
            {m.refPriceCents !== null && <p>参考价 ¥{formatAmount(m.refPriceCents)}/{m.purchaseUnit}</p>}
          </div>
        </div>
        {central && m.isLow && (
          <p className="mt-2 flex items-center gap-1.5 text-[12.5px] font-semibold text-clay">
            <TriangleAlert className="size-4" />
            {m.coverDays !== null && m.daysOfCover !== null ? `按近期用量只够 ${m.daysOfCover} 天，少于提醒天数 ${m.coverDays} 天` : '低于人工设定的提醒线（阈值为模拟值，不是行业推荐用量）'}
          </p>
        )}
        {can('inventory.operate') && central && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {quick.map((t) => (
              <Link
                key={t}
                to={`/inventory/new/${t}?m=${m.id}`}
                className="flex h-8 items-center gap-1.5 rounded-md border border-line-strong bg-card px-2.5 text-[12.5px] font-semibold text-ink-2 hover:border-pine hover:text-pine"
              >
                {INV_DOC_META[t].title}
              </Link>
            ))}
          </div>
        )}
      </header>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {pending.length > 0 && (
          <div className="mb-4 rounded-lg border border-dashed border-yuzu-deep/40 bg-yuzu-tint/70 px-4 py-3">
            <p className="flex items-center gap-1.5 text-[13px] font-bold text-yuzu-deep">
              <Hourglass className="size-4" />
              未生效的单据（不影响库存）
            </p>
            <ul className="mt-1.5 space-y-1">
              {pending.map((p) => (
                <li key={p.id} className="flex items-center gap-2 text-[12.5px]">
                  <Link to={`/inventory/docs?doc=${p.id}`} className="num font-semibold text-ink hover:underline">
                    {p.docNo}
                  </Link>
                  <span className="text-ink-3">{INV_DOC_META[p.docType].title}</span>
                  <span className="text-ink-3">{INV_STATUS_LABELS[p.status]}</span>
                  <span className="flex-1" />
                  <Qty
                    milli={INV_DOC_META[p.docType].direction === 'out' ? -p.qtyMilli : p.qtyMilli}
                    unit={m.inventoryUnit}
                    signed
                    className="font-semibold text-ink-2"
                  />
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[13px] font-bold text-ink-2">库存卡{central ? '' : ` · ${card.data.warehouse.name}`}</h3>
          <Button size="sm" variant="ghost" icon={<Download className="size-4" />} onClick={() => downloadUrl(`/api/inventory/materials/${m.id}/card/export?warehouse=${card.data.warehouse.id}`)}>
            导出
          </Button>
        </div>
        {moves.length === 0 ? (
          <EmptyState
            art="leaf"
            title="还没有库存流水"
            description="这项物料需要先建立经确认的期初，之后的每一笔收发都会记在这里。"
            action={
              can('inventory.operate') &&
              central && (
                <Link to={`/inventory/new/opening?m=${m.id}`} className="inline-flex h-9 items-center gap-1.5 rounded-md bg-pine px-3.5 text-[13px] font-bold text-paper hover:bg-pine-hover">
                  建立期初 <ArrowRight className="size-4" />
                </Link>
              )
            }
          />
        ) : (
          <ol className="relative space-y-0.5 before:absolute before:top-3 before:bottom-3 before:left-[15px] before:w-px before:bg-line">
            {moves.slice(0, limit).map((mv) => {
              const inbound = mv.qtyDeltaMilli > 0;
              return (
                <li key={mv.id} className="relative">
                  <Link to={`/inventory/docs?doc=${mv.docId}`} className="flex items-start gap-3 rounded-md py-2 pr-2 transition-colors hover:bg-card">
                    <span
                      className={cn(
                        'relative z-10 mt-0.5 flex size-[31px] shrink-0 items-center justify-center rounded-full ring-4 ring-paper',
                        mv.moveType === 'void' ? 'bg-clay-soft text-clay' : DOC_VISUAL[mv.docType].tone,
                      )}
                    >
                      <MoveIcon type={mv.moveType} className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="text-[13.5px] font-bold">{MOVE_TYPE_LABELS[mv.moveType]}</span>
                        {mv.partyName && <span className="truncate text-[12.5px] text-ink-2">{mv.partyName}</span>}
                      </span>
                      <span className="num block truncate text-[11.5px] text-ink-3">
                        {mv.docNo} · {mv.docDate === session.calendarToday ? '今天' : mv.docDate.slice(5)} · {mv.operatorName}
                        {mv.note && ` · ${mv.note}`}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <Qty milli={mv.qtyDeltaMilli} unit={m.inventoryUnit} signed className={cn('text-[14px] font-bold', inbound ? 'text-pine' : 'text-ink')} />
                      <span className="num block text-[11.5px] text-ink-3" title={formatDateTime(mv.createdAt)}>
                        结存 {formatQty(mv.qtyAfterMilli)}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ol>
        )}
        {moves.length > limit && (
          <Button size="sm" variant="ghost" className="mt-2 w-full" onClick={() => setLimit((l) => l + 50)}>
            显示更早的 {Math.min(50, moves.length - limit)} 条
          </Button>
        )}
      </div>
    </div>
  );
}

/** 提醒线说明（#22，v0.7.12）：设了提醒天数且有用量的按可用天数，否则按固定数量 */
function coverText(m: Material): string {
  if (m.coverDays !== null && m.daysOfCover !== null) return `可用 ${m.daysOfCover} 天 · 提醒 ${m.coverDays} 天`;
  if (m.coverDays !== null) return `提醒 ${m.coverDays} 天 · 近期没有用量`;
  return m.lowStockMilli !== null ? `提醒线 ${formatQty(m.lowStockMilli)} ${m.inventoryUnit}` : '未设提醒线';
}
