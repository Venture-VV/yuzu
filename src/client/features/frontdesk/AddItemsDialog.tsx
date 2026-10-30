import { useMemo, useState } from 'react';
import { HandHeart, Minus, Plus, Trash2 } from 'lucide-react';
import type { PriceTier } from '@shared/catalog';
import { ZONE_LABELS, type VisitDetail } from '@shared/frontdesk';
import { parseYuan } from '@shared/money';
import { technicianText, type CallType } from '@shared/technicians';
import type { ServiceItem } from '@shared/types';
import { api } from '../../lib/api';
import { useCatalog } from '../../lib/queries';
import { useCan, useSession } from '../../lib/session';
import { cn } from '../../lib/utils';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { Button, Input, MoneyInput, Notice, Skeleton } from '../../components/ui';
import { CartLineName, cartKey, cartLines, ItemCard } from '../catalog/ItemCard';
import { ZoneChip } from './parts';
import { BackfillNotice, backfillBody, backfillSummary, useBackfill } from './backfill';
import { PendingPanel, useFrontdeskOp } from './pending';
import { useFrontdeskTechnicians } from './queries';
import { TechnicianPicker } from './TechnicianPicker';

const isVisitDetail = (r: unknown): r is VisitDetail => !!r && typeof r === 'object' && 'tag' in r && 'lines' in r;

/** 购物车的键：「项目:价格档」，选了技师时再加「:技师:点钟 / 轮钟」（同一项目不同技师分开计数） */
const lineKey = (itemId: number, tier: PriceTier, tech: { id: number; callType: CallType } | null) =>
  tech ? `${cartKey(itemId, tier)}:${tech.id}:${tech.callType}` : cartKey(itemId, tier);
const techOfKey = (key: string): { technicianId: number; callType: CallType } | null => {
  const [, , id, callType] = key.split(':');
  return id ? { technicianId: Number(id), callType: callType as CallType } : null;
};

/** 挂账：点选项目（多档项目按档位点选）累加数量，确认后一次登记到手牌账单（只挂账，不收款）；需要技师的项目先选技师 */
export function AddItemsDialog({
  open,
  visit,
  onClose,
  onDone,
}: {
  open: boolean;
  visit: VisitDetail;
  onClose: () => void;
  onDone: (v: VisitDetail) => void;
}) {
  const can = useCan();
  const session = useSession();
  const catalog = useCatalog();
  /** 键见 lineKey（项目:价格档，选了技师时再加技师与上钟方式），值为数量 */
  const [cart, setCart] = useState<Map<string, number>>(new Map());
  const [category, setCategory] = useState('全部');
  const [custom, setCustom] = useState<{ name: string; amount: string }[]>([]);
  const techs = useFrontdeskTechnicians(open);
  const techRules = techs.data?.rules;
  const techOn = !!techRules?.enabled;
  const [picking, setPicking] = useState<{ item: ServiceItem; tier: PriceTier } | null>(null);
  const [callType, setCallType] = useState<CallType>('rotation');
  // 同一位客人上一笔挂账结果待确认时，先处理那一笔，不能另起一笔（避免重复挂账）
  const op = useFrontdeskOp<VisitDetail>({
    type: 'bill_post',
    visitId: visit.id,
    staffName: session.staff.displayName,
    pick: (found) => ('visit' in found ? found.visit : null),
  });

  useResetOnOpen(open, () => {
    setCart(new Map());
    setCustom([]);
    setCategory('全部');
    setPicking(null);
    op.clearError();
  });
  // 每次打开按规则的默认上钟方式
  const defaultCallType = techRules?.defaultCallType;
  useResetOnOpen(
    open,
    () => {
      if (defaultCallType) setCallType(defaultCallType);
    },
    [defaultCallType],
  );

  const items = useMemo(() => (catalog.data?.items ?? []).filter((i) => i.active), [catalog.data]);
  const categories = useMemo(() => ['全部', ...new Set(items.map((i) => i.category || '其他'))], [items]);
  const shown = category === '全部' ? items : items.filter((i) => (i.category || '其他') === category);

  const locked = op.locked;
  const touch = op.clearError;
  const add = (key: string, delta: number) => {
    if (locked) return;
    touch();
    setCart((m) => {
      const next = new Map(m);
      const q = Math.min(99, Math.max(0, (next.get(key) ?? 0) + delta));
      if (q === 0) next.delete(key);
      else next.set(key, q);
      return next;
    });
  };

  const techById = useMemo(() => new Map((techs.data?.technicians ?? []).map((t) => [t.id, t])), [techs.data]);
  const lines = cartLines(cart, items).map((l) => {
    const tech = techOfKey(l.key);
    const t = tech ? techById.get(tech.technicianId) : undefined;
    return {
      ...l,
      quantity: l.qty,
      technicianId: tech?.technicianId,
      callType: tech?.callType,
      techLabel: tech ? (t ? technicianText({ ...t, callType: tech.callType }) : '这位技师已不能选，请移除后重选') : null,
    };
  });
  /** 项目卡片上的数量：同一项目同一档不分技师合计 */
  const cardCart = useMemo(() => {
    const m = new Map<string, number>();
    for (const [k, q] of cart) {
      const base = k.split(':').slice(0, 2).join(':');
      m.set(base, (m.get(base) ?? 0) + q);
    }
    return m;
  }, [cart]);
  const needsTech = (i: ServiceItem) => techOn && i.technicianRequired;
  /** 只限某一性别的项目（如私汤木桶浴仅女宾）：这位客人不能用时不可选；技师名单还没加载时需要技师的项目先不能点 */
  const unavailableFor = (i: ServiceItem) =>
    i.gender && i.gender !== visit.zone
      ? `仅限${ZONE_LABELS[i.gender].title}`
      : i.technicianRequired && techs.isPending
        ? '正在加载技师…'
        : i.technicianRequired && !techs.data
          ? '技师名单没有加载出来'
          : null;
  const missingTech = techOn && !!techRules?.requireTechnician && lines.some((l) => l.item.technicianRequired && !l.technicianId);
  const staleTech = lines.some((l) => l.technicianId && !techById.has(l.technicianId));
  const customParsed = custom.map((c) => ({ name: c.name.trim(), amount: parseYuan(c.amount) }));
  const customValid = customParsed.every((c) => c.name && c.amount && c.amount > 0);
  const total = lines.reduce((s, l) => s + l.amount, 0) + customParsed.reduce((s, c) => s + (c.amount ?? 0), 0);
  const ready = (lines.length > 0 || custom.length > 0) && customValid && total > 0 && !missingTech && !staleTech;

  const backfill = useBackfill();
  const backfillBlocked = backfill.state.active && !backfill.request;
  const submit = async () => {
    if (backfillBlocked) return;
    const result = await op.submit((key) => ({
      url: `/api/frontdesk/visits/${visit.id}/charges`,
      body: {
        clientKey: key,
        lines: lines.map((l) => ({ itemId: l.item.id, quantity: l.quantity, tier: l.tier, technicianId: l.technicianId, callType: l.callType })),
        customLines: customParsed.map((c) => ({ name: c.name, amount: c.amount })),
        expectedTotal: total,
        ...backfillBody(backfill),
      },
      tagCodes: [visit.tag.code],
      summary: [...lines.map((l) => `${l.name} ×${l.quantity}${l.techLabel ? `（${l.techLabel}）` : ''}`), ...customParsed.map((c) => c.name)].join('、') + backfillSummary(backfill),
      amount: total,
    }));
    if (result) onDone(result);
  };
  const busy = op.busy;

  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      width="max-w-3xl"
      title={
        <span className="flex items-center gap-2">
          加项目 · <span className="num">{visit.tag.code}</span> <ZoneChip zone={visit.zone} size="md" />
        </span>
      }
      description="点项目累加数量；确认后挂到这张手牌的账单上，价格按当前价格留存。挂账不是收款。"
      footer={
        <>
          <span className="mr-auto self-center text-[13px] text-ink-3">
            本次 <b className="num text-ink">{lines.reduce((s, l) => s + l.quantity, 0) + custom.length}</b> 项，合计{' '}
            <Money cents={total} className="text-[17px] font-bold text-ink" />
          </span>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" size="lg" disabled={!ready || op.locked || backfillBlocked} loading={busy} onClick={submit} data-testid="add-items-submit">
            挂到 {visit.tag.code}
          </Button>
        </>
      }
    >
      <PendingPanel
        op={op}
        onResolved={(r) => {
          // 待确认的那笔可能是钟房派钟、加钟或点单页下单发出的：按原内容重新提交时返回的不是账单，重新取一次
          if (isVisitDetail(r)) onDone(r);
          else void api.get<VisitDetail>(`/api/frontdesk/visits/${visit.id}`).then(onDone, () => onClose());
        }}
      />
      <BackfillNotice action="挂账" />
      <div className={cn('grid gap-5 md:grid-cols-[minmax(0,1fr)_280px]', backfill.state.active && 'mt-4')}>
        <div className="min-w-0">
          {picking ? (
            <TechnicianPicker
              item={picking.item}
              tier={picking.tier}
              data={techs.data}
              loading={techs.isPending}
              callType={callType}
              onCallType={setCallType}
              onPick={(pick) => {
                add(lineKey(picking.item.id, pick?.tier ?? picking.tier, pick ? { id: pick.tech.id, callType } : null), 1);
                setPicking(null);
              }}
              onCancel={() => setPicking(null)}
            />
          ) : (
            <>
              <div className="scroll-thin -mx-1 mb-3 flex gap-1.5 overflow-x-auto px-1 pb-1">
                {categories.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCategory(c)}
                    className={cn(
                      'h-8 shrink-0 rounded-full px-3.5 text-[13px] font-semibold transition-colors',
                      category === c ? 'bg-pine text-paper' : 'bg-paper-2 text-ink-2 hover:bg-paper-3',
                    )}
                  >
                    {c}
                  </button>
                ))}
              </div>
              {catalog.isPending ? (
                <Skeleton className="h-40" />
              ) : shown.length === 0 ? (
                <p className="rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-[13px] text-ink-3">还没有可挂账的项目，请店主在「管理 → 套餐与项目」中添加</p>
              ) : (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {shown.map((i) => (
                    <ItemCard
                      key={i.id}
                      item={i}
                      cart={cardCart}
                      disabled={locked}
                      unavailable={unavailableFor(i)}
                      hint={needsTech(i) ? (techRules?.tierByGrade && i.prices.length > 1 ? '选技师 · 按技师等级取价' : '选技师') : null}
                      onAdd={(tier) => {
                        if (!needsTech(i)) return add(cartKey(i.id, tier), 1);
                        if (locked) return;
                        touch();
                        setPicking({ item: i, tier });
                      }}
                    />
                  ))}
                </div>
              )}
            </>
          )}
          {can('consume.customAmount') && !picking && (
            <div className="mt-4">
              {custom.map((c, i) => (
                <div key={i} className="mb-2 flex items-center gap-2">
                  <Input
                    fullWidth={false}
                    className="h-10 min-w-0 flex-1"
                    placeholder="项目名称"
                    value={c.name}
                    maxLength={32}
                    disabled={locked}
                    onChange={(e) => {
                      touch();
                      setCustom((list) => list.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)));
                    }}
                    aria-label="手动项目名称"
                  />
                  <div className="w-32">
                    <MoneyInput
                      value={c.amount}
                      disabled={locked}
                      onChange={(e) => {
                        touch();
                        setCustom((list) => list.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)));
                      }}
                      placeholder="0.00"
                      aria-label="手动项目金额"
                      className="h-10"
                    />
                  </div>
                  <button type="button" aria-label="移除" onClick={() => setCustom((list) => list.filter((_, j) => j !== i))} className="flex size-10 items-center justify-center rounded-md text-ink-3 hover:bg-clay-soft hover:text-clay">
                    <Trash2 className="size-4" />
                  </button>
                </div>
              ))}
              {custom.length < 5 && (
                <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => setCustom((list) => [...list, { name: '', amount: '' }])}>
                  手动输入项目与金额
                </Button>
              )}
            </div>
          )}
        </div>

        <aside className="rounded-lg border border-line bg-paper/70 p-3" aria-label="本次挂账">
          <p className="text-[12.5px] font-bold text-ink-2">本次挂账</p>
          {lines.length === 0 && custom.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-ink-3">点左侧项目添加</p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {lines.map((l) => (
                <li key={l.key} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1">
                    <CartLineName line={l} className="block text-[13px]" />
                    {l.techLabel && (
                      <span className={cn('flex items-center gap-1 text-[11.5px] font-semibold', l.technicianId && techById.has(l.technicianId) ? 'text-pine' : 'text-clay')}>
                        <HandHeart className="size-3" />
                        {l.techLabel}
                      </span>
                    )}
                    {techOn && l.item.technicianRequired && !l.technicianId && <span className="block text-[11.5px] font-semibold text-ink-3">未指定技师</span>}
                  </span>
                  <span className="flex items-center rounded-md border border-line bg-card">
                    <button type="button" aria-label={`减少 ${l.name}`} onClick={() => add(l.key, -1)} className="flex size-7 items-center justify-center text-ink-2 hover:text-ink">
                      <Minus className="size-3.5" />
                    </button>
                    <span className="num w-6 text-center text-[13px] font-bold">{l.quantity}</span>
                    <button type="button" aria-label={`增加 ${l.name}`} onClick={() => add(l.key, 1)} className="flex size-7 items-center justify-center text-ink-2 hover:text-ink">
                      <Plus className="size-3.5" />
                    </button>
                  </span>
                  <Money cents={l.amount} className="w-[72px] justify-end text-right text-[13px] font-semibold" />
                </li>
              ))}
              {customParsed.map((c, i) => (
                <li key={`c${i}`} className="flex items-center gap-2 text-[13px]">
                  <span className="min-w-0 flex-1 truncate font-semibold">{c.name || '（未填名称）'}</span>
                  {c.amount ? <Money cents={c.amount} className="font-semibold" /> : <span className="text-clay">金额未填</span>}
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
      {techs.isError && (
        <Notice
          tone="warning"
          title="技师名单没有加载出来，需要技师的项目暂时不能挂"
          className="mt-4"
          action={
            <Button size="sm" variant="secondary" onClick={() => void techs.refetch()}>
              重新加载
            </Button>
          }
        />
      )}
      {missingTech && <Notice tone="warning" title="有需要技师的项目还没有选技师，请移除后重新点选" className="mt-4" />}
      {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} className="mt-4" />}
    </Dialog>
  );
}
