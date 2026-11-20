// 菜品管理（8.1.15，店主 2026-11-19《浴族系统需求汇总》餐饮第 4 条，docs/DISHES_V8115.md）：
// 一张表看全部菜品——名称、分类、出品口与小类、档口、价格、上架 / 下架、今天的沽清、图片；能搜、能按出品口与状态筛。
// 新增 / 编辑（DishEditor）、上下架（一点就生效）、改价（DishPriceDialog，单独一项权限、留改价记录）、Excel 导出与导入（DishImportDialog）。
// 维护权限按出品口分三项：没有某个出品口权限的看得到、改不了（按钮是灰的，写明原因；服务端照样逐项核对）。
// 宽屏（平板、收银机）是一张表，窄屏（手持点单机）一道菜一张卡片，都不用横向滚动。
// 8.1.16（Codex 审查 d12390f 的 P1）：上下架、改价、新增 / 编辑、导入没收到结果的进「结果待确认」（dishPendingStore.ts）：
// 记在本机、列在菜品表上方，这道菜上同类的操作先不能再做，只能查回、按原内容重新提交或确认作废。

import { useMemo, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Ban,
  CircleCheck,
  CircleOff,
  Download,
  FileUp,
  History,
  Hourglass,
  ImageOff,
  Infinity as InfinityIcon,
  Lock,
  PencilLine,
  Plus,
  Search,
  Tag,
} from 'lucide-react';
import { DINING_OUTLET_KEYS, DINING_OUTLET_LABELS, type DiningOutlet } from '@shared/dining';
import { DISH_OUTLET_PERMISSIONS, DISH_PRICE_PERMISSION, DISH_STATUS_LABELS, filterDishes, pricesText, remainingText, type DishRow, type DishSaveResult, type DishStatusFilter } from '@shared/dishes';
import { errorMessage, UncertainError } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn, downloadUrl, uuid } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { Money } from '../../components/Money';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Input, Notice, Segmented, Skeleton } from '../../components/ui';
import { StatusChip } from './DishChips';
import { DishEditor } from './DishEditor';
import { DishImportDialog } from './DishImportDialog';
import { DishPendingNotice } from './DishPendingNotice';
import { DishPriceDialog, PriceHistoryDialog } from './DishPriceDialog';
import { pendingOf, sendDishOp, useDishPending } from './dishPendingStore';
import { useDishes, useRefreshDishes } from './dishQueries';
import { OutletFilter, SlotBadge } from './slots';

const STATUS_OPTIONS = (['all', 'on', 'off', 'soldout'] as const).map((value) => ({ value, label: DISH_STATUS_LABELS[value] }));

/** 行里的按钮：手指点得到（高 44 像素） */
const ROW_BUTTON = 'min-h-11';

export function DishesTab() {
  const can = useCan();
  const session = useSession();
  const toast = useToast();
  const refresh = useRefreshDishes();
  const board = useDishes();
  const [q, setQ] = useState('');
  const [outlet, setOutlet] = useState<DiningOutlet | null>(null);
  const [status, setStatus] = useState<DishStatusFilter>('all');
  /** 编辑哪一道（'new' 为新增） */
  const [editing, setEditing] = useState<DishRow | 'new' | null>(null);
  const [pricing, setPricing] = useState<DishRow | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const pending = useDishPending();

  const mine = DINING_OUTLET_KEYS.filter((o) => can(DISH_OUTLET_PERMISSIONS[o]));
  const canPrice = can(DISH_PRICE_PERMISSION);
  const canEdit = (d: DishRow) => mine.includes(d.outlet);
  const all = useMemo(() => board.data?.dishes ?? [], [board.data]);
  const shown = useMemo(() => filterDishes(all, { q, outlet, status }), [all, q, outlet, status]);
  const counts: Partial<Record<DiningOutlet | 'all', number>> = { all: all.length };
  for (const d of all) counts[d.outlet] = (counts[d.outlet] ?? 0) + 1;

  /** 上下架：带着页面看到的版本（别人先改过、或晚到的旧请求都被拒绝）；没收到结果的进「结果待确认」，这道菜先不能再上下架 */
  const toggle = async (d: DishRow) => {
    if (pendingOf(pending, 'active', d.id)) return;
    const verb = d.active ? '下架' : '上架';
    const key = uuid();
    setBusy(d.id);
    try {
      const r = await sendDishOp<DishSaveResult>({
        key,
        type: 'active',
        itemId: d.id,
        method: 'post',
        url: `/api/dining/dishes/${d.id}/active`,
        body: { clientKey: key, active: !d.active, rev: d.rev },
        summary: `「${d.name}」${verb}`,
        staffName: session.staff.displayName,
      });
      const used = r.dish.usedBy.length ? `它还是${r.dish.usedBy.join('、')}：加料不再列出来，套餐照卖。` : '';
      toast(
        r.dish.active
          ? { tone: 'success', title: `「${d.name}」已上架`, body: '点单页、电子菜单马上能点。' }
          : { tone: 'success', title: `「${d.name}」已下架`, body: `点单页马上不显示，电子菜单上标「已下架」、不能点。${used}` },
      );
    } catch (e) {
      toast(
        e instanceof UncertainError
          ? { tone: 'info', title: `「${d.name}」${verb}的结果待确认`, body: '已记在本机：在菜品表上方查回、按原内容重新提交或确认作废；有结论之前这道菜不能再上下架。' }
          : { tone: 'error', title: `「${d.name}」${verb}没成功`, body: errorMessage(e) },
      );
    } finally {
      setBusy(null);
      refresh();
    }
  };
  // 弹窗开着的那一笔在弹窗里处理，菜品表上方不重复列（也免得两处同时自动查回）
  const inDialog = (op: (typeof pending)[number]) =>
    (op.type === 'price' && pricing?.id === op.itemId) ||
    (op.type === 'update' && editing !== null && editing !== 'new' && editing.id === op.itemId) ||
    (op.type === 'create' && editing === 'new') ||
    (op.type === 'import' && importOpen);
  const listed = pending.filter((op) => !inDialog(op));

  if (board.isPending) {
    return (
      <div className="space-y-3 p-5 md:p-7">
        <Skeleton className="h-28" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (board.isError && !board.data) {
    return (
      <div className="p-5 md:p-7">
        <LoadFailed title="菜品没有取回来，请检查网络" onRetry={() => void board.refetch()} retrying={board.isFetching} testId="dishes-error">
          不是没有菜品。点「重试」再取一次。
        </LoadFailed>
      </div>
    );
  }
  const data = board.data!;
  const lockedOutlets = DINING_OUTLET_KEYS.filter((o) => !mine.includes(o));

  return (
    <div className="mx-auto max-w-[1480px] space-y-4 p-3 sm:p-5 md:p-7" data-testid="dishes">
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative min-w-0 flex-1 basis-56">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-4" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜菜名、分类、档口、做法" maxLength={40} className="pl-9" aria-label="搜索菜品" data-testid="dishes-search" />
          </div>
          <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center [&_svg]:hidden sm:[&_svg]:block">
            {mine.length > 0 && canPrice && (
              <Button variant="primary" className="min-h-11" icon={<Plus className="size-4" />} onClick={() => setEditing('new')} data-testid="dishes-new">
                新增菜品
              </Button>
            )}
            {mine.length > 0 && (
              <Button className="min-h-11" icon={<FileUp className="size-4" />} onClick={() => setImportOpen(true)} data-testid="dishes-import">
                导入
              </Button>
            )}
            <Button className="min-h-11" icon={<Download className="size-4" />} onClick={() => downloadUrl('/api/dining/dishes/export.xlsx')} data-testid="dishes-export">
              导出全部
            </Button>
            <Button className="min-h-11" icon={<History className="size-4" />} onClick={() => setHistoryOpen(true)} data-testid="dishes-history">
              改价记录
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <OutletFilter value={outlet} onChange={setOutlet} counts={counts} testPrefix="dishes" />
          {/* 手持点单机上放不下四格时这一排自己左右滑 */}
          <div className="w-full max-w-full overflow-x-auto sm:w-auto">
            <Segmented value={status} onChange={setStatus} options={STATUS_OPTIONS} ariaLabel="状态" className="w-full sm:w-auto" />
          </div>
        </div>
        <p className="text-[12.5px] leading-relaxed text-ink-3" data-testid="dishes-summary">
          共 <b className="num text-ink-2">{all.length}</b> 道：上架 {all.filter((d) => d.active).length}、下架 {all.filter((d) => !d.active).length}、今日沽清{' '}
          {all.filter((d) => d.active && d.remaining === 0).length}（营业日 {data.businessDate}）。
          {mine.length === 0
            ? '你没有哪个出品口的维护权限，只能看。'
            : `你能维护${mine.map((o) => DINING_OUTLET_LABELS[o]).join('、')}的菜${lockedOutlets.length ? `；${lockedOutlets.map((o) => DINING_OUTLET_LABELS[o]).join('、')}的看得到、改不了` : ''}。`}
          {canPrice ? '' : ' 没有「定价与改价」的权限：不能新增、不能改价。'}
        </p>
      </Card>

      {listed.length > 0 && (
        <section className="space-y-2" aria-label="结果待确认的菜品操作" data-testid="dish-pending-list">
          {listed.map((op) => (
            <DishPendingNotice key={op.key} op={op} onApplied={refresh} onAbandoned={refresh} />
          ))}
        </section>
      )}

      {all.length === 0 ? (
        <Card>
          <EmptyState
            art="leaf"
            title="还没有菜品"
            description="菜品就是挂了出品档口的价目项目。先在「后台 → 餐饮」建好出品档口，再回来点「新增菜品」，或者用「导入」一次导进来。"
            action={
              mine.length > 0 && canPrice ? (
                <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
                  新增菜品
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : shown.length === 0 ? (
        <Card>
          <EmptyState art="search" title="没有符合条件的菜品" description="换个词搜，或者把出品口、状态改回「全部」。" />
        </Card>
      ) : (
        <Card className="overflow-hidden" data-testid="dishes-list">
          {/* 宽屏的表头；窄屏每道菜是一张卡片，不用表头 */}
          <div className={cn('hidden border-b border-line bg-paper-2/70 py-2 text-[12px] font-bold text-ink-3 xl:grid', ROW_COLS)}>
            <span>图片</span>
            <span>名称</span>
            <span>分类</span>
            <span>出品口与小类</span>
            <span>档口</span>
            <span className="text-right">价格</span>
            <span>状态</span>
            <span>今日沽清</span>
            <span className="text-right">操作</span>
          </div>
          <ul className="divide-y divide-line/70">
            {shown.map((d) => (
              <DishLine
                key={d.id}
                d={d}
                editable={canEdit(d)}
                priceable={canPrice && canEdit(d)}
                busy={busy === d.id}
                waiting={!!pendingOf(pending, 'active', d.id)}
                onEdit={() => setEditing(d)}
                onPrice={() => setPricing(d)}
                onToggle={() => void toggle(d)}
              />
            ))}
          </ul>
        </Card>
      )}
      {board.isError && <Notice tone="warning" title="刚才那次刷新没成功，上面是之前取到的" />}

      <DishEditor
        target={editing}
        board={data}
        outlets={mine}
        onClose={() => setEditing(null)}
        onRejected={refresh}
        onSaved={(dish, created) => {
          setEditing(null);
          refresh();
          toast({ tone: 'success', title: created ? `已新增「${dish.name}」` : `「${dish.name}」已保存`, body: created && dish.active ? '点单页马上能点。' : undefined });
        }}
      />
      <DishPriceDialog
        dish={pricing}
        onClose={() => setPricing(null)}
        onRejected={refresh}
        onSaved={(dish) => {
          setPricing(null);
          refresh();
          toast({ tone: 'success', title: `「${dish.name}」已改价`, body: `现在是 ${pricesText(dish.prices)}；以前的订单照下单时的价。` });
        }}
      />
      <PriceHistoryDialog open={historyOpen} onClose={() => setHistoryOpen(false)} />
      <DishImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onDone={(r) => {
          setImportOpen(false);
          refresh();
          toast({
            tone: 'success',
            title: r.replayed ? '这份表之前已经导入过' : `已导入：新建 ${r.created} 道、修改 ${r.updated} 道`,
            body: r.priceChanges ? `其中改价 ${r.priceChanges} 道，已记进改价记录。` : undefined,
          });
        }}
      />
    </div>
  );
}

/**
 * 一道菜一行。宽屏（1280 起：收银机、平板）是一行九格——图片、名称、分类、出品口与小类、档口、价格、状态、今日沽清、操作；
 * 窄屏（手持点单机）同一份内容排成一张卡片：图片、名称、价格一行，分类这些一行，按钮一行。
 * 只有一份内容、靠样式换排法（中间那一组在宽屏上散开成各自的格子），页面上每个按钮只有一个。
 */
const ROW_COLS =
  'grid-cols-[48px_minmax(0,1fr)_auto] gap-x-3 gap-y-2 px-4 xl:grid-cols-[48px_minmax(0,2.2fr)_minmax(0,0.9fr)_minmax(0,1.25fr)_minmax(0,0.9fr)_minmax(0,0.95fr)_84px_112px_232px] xl:items-center';

function Thumb({ d }: { d: DishRow }) {
  return d.imageUrl ? (
    <img src={d.imageUrl} alt="" loading="lazy" className="size-12 rounded-md border border-line object-cover xl:order-1" data-testid={`dish-image-${d.name}`} />
  ) : (
    <span className="flex size-12 items-center justify-center rounded-md border border-dashed border-line-strong text-ink-4 xl:order-1" title="还没有图片">
      <ImageOff className="size-4" />
    </span>
  );
}

function DishLine({
  d,
  editable,
  priceable,
  busy,
  waiting,
  onEdit,
  onPrice,
  onToggle,
}: {
  d: DishRow;
  editable: boolean;
  priceable: boolean;
  busy: boolean;
  /** 上一笔上下架结果待确认：处理好之前不能再上下架 */
  waiting: boolean;
  onEdit: () => void;
  onPrice: () => void;
  onToggle: () => void;
}) {
  const why = editable ? undefined : `没有${DINING_OUTLET_LABELS[d.outlet]}的菜品维护权限`;
  const missing = d.combo.filter((c) => !c.available).map((c) => c.name);
  const extras = [d.methods.length ? `做法 ${d.methods.join('、')}` : '', d.addons.length ? `加料 ${d.addons.map((a) => a.name).join('、')}` : ''].filter(Boolean).join(' · ');
  return (
    <li className={cn('grid py-3 xl:py-2.5', ROW_COLS)} data-testid={`dish-row-${d.name}`} data-active={d.active} data-editable={editable}>
      <Thumb d={d} />
      <div className="min-w-0 xl:order-2">
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <span className={cn('text-[15px] leading-snug font-bold', !d.active && 'text-ink-3')}>{d.name}</span>
          {d.combo.length > 0 && <Badge tone="lake">套餐</Badge>}
          {!d.stationActive && <Badge tone="ember">档口已停用</Badge>}
          {!editable && <Badge icon={<Lock className="size-3" />}>只读</Badge>}
        </p>
        {d.combo.length > 0 && (
          <p className="mt-0.5 text-[12.5px] text-ink-2" data-testid={`dish-combo-${d.name}`}>
            含 {d.combo.map((c) => `${c.name}×${c.quantity}`).join('、')}
            {missing.length > 0 && <span className="ml-1 font-semibold text-clay">（{missing.join('、')}已下架）</span>}
          </p>
        )}
        {extras && <p className="mt-0.5 text-[12.5px] text-ink-3">{extras}</p>}
        {d.usedBy.length > 0 && <p className="mt-0.5 text-[12px] text-ink-3">用在：{d.usedBy.join('、')}</p>}
      </div>
      <span className="inline-flex flex-col items-end text-right xl:order-6" data-testid={`dish-price-text-${d.name}`}>
        <Money cents={d.price} className="text-[16px] font-bold" />
        {d.prices.length > 1 && <span className="text-[12px] text-ink-3">{d.prices.length} 档规格</span>}
      </span>
      <div className="col-span-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-2 xl:contents">
        <span className="xl:order-3 xl:truncate">{d.category || '—'}</span>
        <span className="order-first flex min-w-0 flex-wrap items-center gap-1 xl:order-4">
          <SlotBadge slot={d} />
          {!d.slotAssigned && <span className="text-[12px] text-ink-3">默认</span>}
        </span>
        <span className="xl:order-5 xl:truncate">{d.stationName}</span>
        <span className="xl:order-7" data-testid={`dish-state-${d.name}`}>
          {d.active ? (
            <StatusChip tone="pine" icon={<CircleCheck />}>
              上架
            </StatusChip>
          ) : (
            <StatusChip tone="neutral" icon={<CircleOff />}>
              下架
            </StatusChip>
          )}
        </span>
        <span className="xl:order-8" data-testid={`dish-limit-${d.name}`}>
          {d.remaining === null ? (
            <StatusChip tone="neutral" icon={<InfinityIcon />}>
              不限量
            </StatusChip>
          ) : d.remaining === 0 ? (
            <StatusChip tone="clay" icon={<Ban />}>
              已沽清
            </StatusChip>
          ) : (
            <StatusChip tone="yuzu" icon={<Hourglass />}>
              {remainingText(d.remaining)}
            </StatusChip>
          )}
        </span>
      </div>
      <div className="col-span-3 flex flex-wrap items-center justify-end gap-1 xl:order-9 xl:col-span-1 xl:flex-nowrap">
        <Button
          size="sm"
          className={ROW_BUTTON}
          variant="ghost"
          icon={<PencilLine className="size-4" />}
          disabled={!editable}
          title={why ?? '编辑'}
          aria-label={`编辑 ${d.name}`}
          onClick={onEdit}
          data-testid={`dish-edit-${d.name}`}
        >
          编辑
        </Button>
        <Button
          size="sm"
          className={ROW_BUTTON}
          variant="ghost"
          icon={<Tag className="size-4" />}
          disabled={!priceable}
          title={editable ? (priceable ? '改价' : '没有「定价与改价」的权限') : why}
          aria-label={`改价 ${d.name}`}
          onClick={onPrice}
          data-testid={`dish-price-${d.name}`}
        >
          改价
        </Button>
        <Button
          size="sm"
          className={cn(ROW_BUTTON, 'min-w-[76px]')}
          variant={waiting ? 'ghost' : d.active ? 'secondary' : 'primary'}
          icon={waiting ? <Hourglass className="size-4" /> : d.active ? <ArrowDownToLine className="size-4" /> : <ArrowUpFromLine className="size-4" />}
          disabled={!editable || waiting}
          title={waiting ? '上一笔上下架结果待确认：先在菜品表上方处理' : why}
          loading={busy}
          onClick={onToggle}
          data-testid={`dish-toggle-${d.name}`}
        >
          {waiting ? '待确认' : d.active ? '下架' : '上架'}
        </Button>
      </div>
    </li>
  );
}
