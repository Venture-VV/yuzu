// 用料与扣料（8.0.20，docs/ERP_V8020.md 第 2 节）：「库存 → 用料与扣料」。
// · 哪些价目项目设了用料（零售品就是一行；菜、饮品是配方），改用料 = 旧的停用、写一份新版本；
// · 待扣料：结账、出品时记下、还没开成耗用单的（库存不够的、等着与冲回轧差的）；
// · 最近的出库批次；开关与默认从哪个仓扣。
// 进厨房 / 水吧的项目出品完成时扣，不进的结账时扣；没设用料的项目不扣。

import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChefHat, PackageMinus, Plus, RefreshCw, ShoppingBag, Trash2 } from 'lucide-react';
import { formatYuan } from '@shared/money';
import { formatQty, parseQty } from '@shared/quantity';
import { STOCK_USAGE_KIND_LABELS, type ItemRecipe, type StockUsageOverview } from '@shared/stock-usage';
import { api, errorMessage } from '../../lib/api';
import { useCan } from '../../lib/session';
import { cn, formatDateTime } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, Select, Skeleton } from '../../components/ui';
import { useMaterials, useWarehouses } from './queries';

const recipesKey = ['inv', 'recipes'] as const;
const usageKey = ['inv', 'usage'] as const;

/**
 * 「结账、出品时按用料扣库存」的开关与默认从哪个仓扣。两处都能改：这一页顶上，和「ERP 设置 → 库存与审批开关」（规则都收在那里）。
 * 不给 rules 时自己取。
 */
export function UsageRulesCard({ rules, onSaved }: { rules?: StockUsageOverview['rules']; onSaved?: () => void | Promise<void> }) {
  const can = useCan();
  const toast = useToast();
  const qc = useQueryClient();
  const warehouses = useWarehouses();
  const own = useQuery({ queryKey: usageKey, queryFn: () => api.get<StockUsageOverview>('/api/inventory/usage'), enabled: !rules });
  const r = rules ?? own.data?.rules;
  if (!r) return null;
  const saveRules = async (patch: Record<string, unknown>) => {
    try {
      await api.put('/api/inventory/usage/rules', patch);
      await qc.invalidateQueries({ queryKey: usageKey });
      await onSaved?.();
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    }
  };
  const active = (warehouses.data ?? []).filter((w) => w.active);
  return (
    <Card className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4 text-[13.5px]" data-testid="usage-rules">
      <span className="font-bold">结账、出品时按用料扣库存</span>
      <Badge tone={r.enabled ? 'moss' : 'neutral'}>{r.enabled ? '开着' : '关着'}</Badge>
      <span className="text-ink-3">进厨房 / 水吧的出品完成时扣，不进的结账时扣；没设用料的项目不扣。库存不够不拦结账与出品，欠着的列在「待扣料」里。</span>
      {can('purchase.rules') && (
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-3">
            零售从
            <Select fullWidth={false} className="h-9" value={r.saleWarehouseId} onChange={(e) => void saveRules({ saleWarehouseId: Number(e.target.value) })} data-testid="usage-sale-warehouse">
              {active.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-3">
            配方从
            <Select fullWidth={false} className="h-9" value={r.recipeWarehouseId} onChange={(e) => void saveRules({ recipeWarehouseId: Number(e.target.value) })} data-testid="usage-recipe-warehouse">
              {active.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </label>
          <Button size="sm" variant="secondary" onClick={() => void saveRules({ enabled: !r.enabled })} data-testid="usage-toggle">
            {r.enabled ? '关掉' : '打开'}
          </Button>
        </span>
      )}
    </Card>
  );
}

export function UsageTab() {
  const can = useCan();
  const toast = useToast();
  const qc = useQueryClient();
  const recipes = useQuery({ queryKey: recipesKey, queryFn: () => api.get<ItemRecipe[]>('/api/inventory/recipes') });
  const usage = useQuery({ queryKey: usageKey, queryFn: () => api.get<StockUsageOverview>('/api/inventory/usage'), refetchInterval: 30_000 });
  const warehouses = useWarehouses();
  const [editing, setEditing] = useState<ItemRecipe | null>(null);
  const [keyword, setKeyword] = useState('');
  const [onlySet, setOnlySet] = useState(false);
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    await Promise.all([qc.invalidateQueries({ queryKey: recipesKey }), qc.invalidateQueries({ queryKey: usageKey })]);
  };

  const rows = useMemo(() => {
    const k = keyword.trim();
    return (recipes.data ?? []).filter((r) => (!onlySet || r.version > 0) && (!k || r.itemName.includes(k) || r.category.includes(k)));
  }, [recipes.data, keyword, onlySet]);
  const setCount = (recipes.data ?? []).filter((r) => r.version > 0).length;
  const whName = (id: number | null) => (id === null ? '按默认' : (warehouses.data?.find((w) => w.id === id)?.name ?? `仓 ${id}`));

  const runNow = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ docs: number; lines: number; blocked: number }>('/api/inventory/usage/run');
      toast({ tone: r.docs ? 'success' : 'info', title: r.docs ? `开了 ${r.docs} 张耗用单（${r.lines} 样物料）` : '这一次没有要扣的', body: r.blocked ? `${r.blocked} 样库存不够，先留着` : undefined });
      await refresh();
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const u = usage.data;
  return (
    <div className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 md:px-7" data-testid="usage-tab">
      {u && <UsageRulesCard rules={u.rules} onSaved={refresh} />}

      {u && u.pending.length > 0 && (
        <Card className="p-4" data-testid="usage-pending">
          <div className="mb-2 flex items-center gap-2">
            <PackageMinus className="size-4 text-clay" />
            <span className="text-[14.5px] font-bold">待扣料</span>
            <span className="text-[12.5px] text-ink-3">库存不够的补货后自动扣；负数是反结账、撤回出品冲回来的，等后面的来抵</span>
            {can('inventory.operate') && (
              <Button size="sm" variant="secondary" className="ml-auto" icon={<RefreshCw className="size-4" />} disabled={busy} onClick={() => void runNow()} data-testid="usage-run">
                现在扣一次
              </Button>
            )}
          </div>
          <ul className="divide-y divide-line/70">
            {u.pending.map((p) => (
              <li key={`${p.kind}-${p.warehouseId}-${p.materialId}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-[13.5px]" data-testid={`usage-pending-${p.materialCode}`}>
                <span className="font-semibold">{p.materialName}</span>
                <span className="num text-[12px] text-ink-3">{p.materialCode}</span>
                <Badge>{STOCK_USAGE_KIND_LABELS[p.kind]}</Badge>
                <span className="text-ink-3">{p.warehouseName}</span>
                <span className={cn('num ml-auto font-bold', p.netMilli < 0 && 'text-ink-3')}>
                  {p.netMilli > 0 ? '该扣 ' : '冲回 '}
                  {formatQty(Math.abs(p.netMilli))} {p.inventoryUnit}
                </span>
                <span className="num text-ink-3">
                  现有 {formatQty(p.stockMilli)} {p.inventoryUnit}
                </span>
                {p.blocked && <Badge tone="clay">库存不够</Badge>}
                <span className="basis-full text-[12px] text-ink-3 md:basis-auto">{formatDateTime(p.since)} 起</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-[14.5px] font-bold">项目的用料</span>
          <span className="text-[12.5px] text-ink-3">
            {setCount} 个项目设了用料 · 共 {recipes.data?.length ?? 0} 个项目
          </span>
          <span className="ml-auto flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-3">
              <input type="checkbox" checked={onlySet} onChange={(e) => setOnlySet(e.target.checked)} data-testid="usage-only-set" />
              只看设了的
            </label>
            <Input fullWidth={false} className="h-9 w-44" placeholder="项目名、分类" value={keyword} onChange={(e) => setKeyword(e.target.value)} aria-label="查找项目" data-testid="usage-search" />
          </span>
        </div>
        {recipes.error ? (
          <Notice tone="error" title={errorMessage(recipes.error)} />
        ) : recipes.isPending ? (
          <Skeleton className="h-48" />
        ) : rows.length === 0 ? (
          <EmptyState art="leaf" title={onlySet ? '还没有项目设用料' : '没有符合的项目'} description="零售品设一行（一瓶水 = 物料 1 瓶），菜和饮品按配方设几行。" className="rounded-lg border border-dashed border-line-strong py-10" />
        ) : (
          <ul className="overflow-hidden rounded-lg border border-line" data-testid="usage-recipes">
            {rows.map((r) => (
              <li key={r.itemId} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-b border-line/70 px-4 py-2.5 last:border-0" data-testid={`usage-item-${r.itemId}`}>
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-1.5 text-[13.5px] font-semibold">
                    {r.kitchen ? <ChefHat className="size-4 text-yuzu-deep" /> : <ShoppingBag className="size-4 text-ink-3" />}
                    <span className="truncate">{r.itemName}</span>
                    <span className="text-[12px] font-normal text-ink-3">
                      {r.category} · {formatYuan(r.price)}
                    </span>
                    {!r.active && <Badge>已停用</Badge>}
                    {r.version > 0 && <Badge tone="lake">{r.kitchen ? '出品时扣' : '结账时扣'}</Badge>}
                  </span>
                  {r.version > 0 ? (
                    <span className="block text-[12.5px] text-ink-2">
                      {r.lines.map((l) => `${l.materialName} ${formatQty(l.qtyMilli)}${l.inventoryUnit}${l.lossBp ? `（损耗 ${l.lossBp / 100}%）` : ''}`).join(' · ')}
                      <span className="text-ink-3">
                        {' '}
                        · 从{whName(r.warehouseId)}扣 · 第 {r.version} 版{r.updatedBy ? ` · ${r.updatedBy}` : ''}
                        {r.note ? ` · ${r.note}` : ''}
                      </span>
                    </span>
                  ) : (
                    <span className="block text-[12.5px] text-ink-3">没设用料，不扣库存</span>
                  )}
                </span>
                <span className="flex items-center gap-3">
                  {r.unitCostCents !== null && (
                    <span className="num text-right text-[12.5px] text-ink-3">
                      一份成本 <b className="text-ink">{formatYuan(r.unitCostCents)}</b>
                      {r.price > 0 && <span className="block">毛利率 {Math.round(((r.price - r.unitCostCents) / r.price) * 100)}%</span>}
                    </span>
                  )}
                  {usage.data?.canEdit && (
                    <Button size="sm" variant={r.version > 0 ? 'ghost' : 'secondary'} onClick={() => setEditing(r)} data-testid={`usage-edit-${r.itemId}`}>
                      {r.version > 0 ? '改用料' : '设用料'}
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {u && u.batches.length > 0 && (
        <Card className="p-4" data-testid="usage-batches">
          <div className="mb-2 text-[14.5px] font-bold">最近的自动出库</div>
          <ul className="divide-y divide-line/70 text-[13px]">
            {u.batches.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
                <span className="num text-ink-3">第 {b.id} 批</span>
                <Badge>{STOCK_USAGE_KIND_LABELS[b.kind]}</Badge>
                <span>{b.warehouseName}</span>
                <span className="text-ink-3">{b.lineCount} 样物料</span>
                {b.docNo ? (
                  <Link to={`/inventory/docs?doc=${b.docId}`} className="num font-semibold text-pine underline-offset-2 hover:underline">
                    {b.docNo}
                  </Link>
                ) : (
                  <Badge tone={b.status === 'released' ? 'ember' : 'neutral'}>{b.status === 'released' ? '没开成，已放回去' : '正在开单'}</Badge>
                )}
                {b.error && <span className="text-clay">{b.error}</span>}
                <span className="ml-auto text-[12px] text-ink-3">{formatDateTime(b.createdAt)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {editing && <RecipeDialog recipe={editing} onClose={() => setEditing(null)} onDone={refresh} />}
    </div>
  );
}

interface DraftLine {
  key: number;
  materialId: number | '';
  qty: string;
  lossPct: string;
}

function RecipeDialog({ recipe, onClose, onDone }: { recipe: ItemRecipe; onClose: () => void; onDone: () => Promise<void> }) {
  const toast = useToast();
  const materials = useMaterials();
  const warehouses = useWarehouses();
  const [lines, setLines] = useState<DraftLine[]>(() =>
    recipe.lines.length
      ? recipe.lines.map((l, i) => ({ key: i, materialId: l.materialId, qty: formatQty(l.qtyMilli), lossPct: l.lossBp ? String(l.lossBp / 100) : '' }))
      : [{ key: 0, materialId: '', qty: '1', lossPct: '' }],
  );
  const [warehouseId, setWarehouseId] = useState<number | ''>(recipe.warehouseId ?? '');
  const [note, setNote] = useState(recipe.note);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const usable = (materials.data ?? []).filter((m) => m.active && m.tracked);
  const set = (key: number, patch: Partial<DraftLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const submit = async (clear = false) => {
    setError(null);
    const body: { materialId: number; qtyMilli: number; lossBp: number }[] = [];
    if (!clear) {
      for (const l of lines) {
        if (l.materialId === '') continue;
        const m = usable.find((x) => x.id === l.materialId);
        const qtyMilli = parseQty(l.qty, m?.decimals ?? 3);
        if (qtyMilli === null || qtyMilli <= 0) return setError(`「${m?.name ?? '物料'}」的用量不对${m ? `（最多 ${m.decimals} 位小数）` : ''}`);
        const loss = l.lossPct.trim() === '' ? 0 : Number(l.lossPct);
        if (!Number.isFinite(loss) || loss < 0 || loss > 50) return setError('损耗率填 0 到 50 之间的数');
        body.push({ materialId: l.materialId, qtyMilli, lossBp: Math.round(loss * 100) });
      }
      if (body.length === 0) return setError('请至少选一样物料');
      if (new Set(body.map((b) => b.materialId)).size !== body.length) return setError('同一样物料只能出现一次');
    }
    setSaving(true);
    try {
      await api.put(`/api/inventory/recipes/${recipe.itemId}`, { expectedVersion: recipe.version, warehouseId: warehouseId === '' ? null : warehouseId, note: note.trim(), lines: body });
      toast({ tone: 'success', title: clear ? '已停用用料' : '用料已保存', body: recipe.itemName });
      await onDone();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${recipe.itemName} 的用料`}
      description={recipe.kitchen ? '这个项目进厨房 / 水吧：出品完成时按下面的用料扣库存。' : '这个项目不进厨房：结账时按下面的用料扣库存。'}
      width="max-w-2xl"
      footer={
        <>
          {recipe.version > 0 && (
            <Button variant="ghost" disabled={saving} onClick={() => void submit(true)} className="mr-auto" data-testid="recipe-clear">
              不再扣（停用用料）
            </Button>
          )}
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={saving} data-testid="recipe-save">
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="recipe-dialog">
        <ul className="space-y-2">
          {lines.map((l, index) => {
            const m = usable.find((x) => x.id === l.materialId);
            return (
              <li key={l.key} className="grid grid-cols-[minmax(0,1fr)_110px_90px_auto] items-end gap-2">
                <Field label={index === 0 ? '物料' : ''} htmlFor={`recipe-m-${l.key}`}>
                  <Select id={`recipe-m-${l.key}`} value={l.materialId} onChange={(e) => set(l.key, { materialId: e.target.value === '' ? '' : Number(e.target.value) })} data-testid={`recipe-material-${index}`}>
                    <option value="">请选择</option>
                    {usable.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}（{x.code} · {x.inventoryUnit}）
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={index === 0 ? `一份用量${m ? `（${m.inventoryUnit}）` : ''}` : ''} htmlFor={`recipe-q-${l.key}`}>
                  <Input id={`recipe-q-${l.key}`} inputMode="decimal" value={l.qty} onChange={(e) => set(l.key, { qty: e.target.value })} data-testid={`recipe-qty-${index}`} />
                </Field>
                <Field label={index === 0 ? '损耗 %' : ''} htmlFor={`recipe-l-${l.key}`}>
                  <Input id={`recipe-l-${l.key}`} inputMode="decimal" placeholder="0" value={l.lossPct} onChange={(e) => set(l.key, { lossPct: e.target.value })} data-testid={`recipe-loss-${index}`} />
                </Field>
                <Button variant="ghost" size="sm" aria-label="去掉这一行" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} icon={<Trash2 className="size-4" />} />
              </li>
            );
          })}
        </ul>
        <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setLines((ls) => [...ls, { key: Math.max(...ls.map((x) => x.key)) + 1, materialId: '', qty: '', lossPct: '' }])} disabled={lines.length >= 30} data-testid="recipe-add-line">
          加一样物料
        </Button>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="从哪个仓扣" htmlFor="recipe-wh" hint="不选就按上面的默认仓">
            <Select id="recipe-wh" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value === '' ? '' : Number(e.target.value))} data-testid="recipe-warehouse">
              <option value="">按默认</option>
              {(warehouses.data ?? []).filter((w) => w.active).map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="备注" htmlFor="recipe-note">
            <Input id="recipe-note" value={note} maxLength={100} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
        <p className="text-[12.5px] text-ink-3">改用料只管以后的结账与出品；已经扣过的不回头改。实际扣 = 一份用量 × 份数 ×（1 + 损耗率），按物料的小数位向上取整。</p>
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}
