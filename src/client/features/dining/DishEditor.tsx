// 菜品管理：新增 / 编辑一道菜（8.1.15，docs/DISHES_V8115.md 第 7 节）。
// 名称、分类、出品口与小类、档口、图片；规格与价格（新增时定价，沿用价目里的档；以后改价走「改价」，要写原因）；
// 做法（点单时选了写进出品备注；8.1.17 起可以分组、设必选、加价，docs/DISHES_V8117.md 第 2 节）、
// 加料（另外的菜，点单时另起一行、备注「配 某菜」）、套餐内容（含哪几样、每样几份；8.1.17 起每一样可以标「可换」，
// 列出能换成哪几样与每份补的差价，docs/DISHES_V8117.md 第 7 节）。
// 保存带操作编号与打开时的版本：别人先改过会被拒绝；没收到结果的进「结果待确认」（8.1.16，dishPendingStore.ts）——
// 弹窗里列着那一笔，查回、按原内容重新提交（同一个编号）或确认作废之前不能再保存。

import { useMemo, useState, type ReactNode } from 'react';
import { CircleOff, ImagePlus, Plus, Trash2, X } from 'lucide-react';
import { PRICE_TIER_LABELS, PRICE_TIERS, type PriceTier } from '@shared/catalog';
import { ALL_DINING_SLOTS, slotKey, slotLabel, type DiningOutlet } from '@shared/dining';
import {
  MAX_COMBO_ITEMS,
  MAX_COMBO_SWAP_DIFF,
  MAX_COMBO_SWAPS,
  MAX_DISH_ADDONS,
  MAX_DISH_CATEGORY,
  MAX_DISH_METHOD_GROUP_LENGTH,
  MAX_DISH_METHOD_GROUPS,
  MAX_DISH_METHOD_LENGTH,
  MAX_DISH_METHOD_PRICE,
  MAX_DISH_METHODS,
  MAX_DISH_NAME,
  plusYuan,
  pricesText,
  type DishBody,
  type DishMethodOption,
  type DishRow,
  type DishSaveResult,
  type DishesBoard,
} from '@shared/dishes';
import { centsToInput, formatYuan, parseYuan } from '@shared/money';
import { api, ApiError, errorMessage, UncertainError } from '../../lib/api';
import { useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { cn, uuid } from '../../lib/utils';
import { imagePayload } from '../../components/Images';
import { Dialog } from '../../components/Overlay';
import { QtyInput } from '../../components/QtyInput';
import { Button, Field, Input, MoneyInput, Notice, Select } from '../../components/ui';
import { StatusChip } from './DishChips';
import { DishPendingNotice } from './DishPendingNotice';
import { pendingOf, sendDishOp, useDishPending } from './dishPendingStore';

/** 常用的做法，点一下加进去 */
const QUICK_METHODS = ['不辣', '微辣', '中辣', '特辣', '免葱', '免蒜', '免香菜', '去冰', '少冰', '热', '少糖', '无糖'];

interface Draft {
  name: string;
  category: string;
  slot: string;
  stationId: number | null;
  imageId: number | null;
  /** 新传的图的预览地址（已有的图用菜品上的地址） */
  imageUrl: string | null;
  prices: Record<PriceTier, string>;
  active: boolean;
  /** 做法（8.1.17：所在的组、加价——加价是输入框里的元） */
  methods: { name: string; group: string; price: string }[];
  groups: { name: string; required: boolean }[];
  addons: number[];
  /** 套餐内容（8.1.17：可换的、能换成哪几样，差价是输入框里的元） */
  combo: { itemId: number; quantity: number; swappable: boolean; swaps: { itemId: number; diff: string }[] }[];
}

const emptyDraft = (outlets: DiningOutlet[]): Draft => ({
  name: '',
  category: '餐饮',
  slot: slotKey(ALL_DINING_SLOTS.find((s) => outlets.includes(s.outlet)) ?? ALL_DINING_SLOTS[0]!),
  stationId: null,
  imageId: null,
  imageUrl: null,
  prices: { standard: '', professional: '', premium: '' },
  active: true,
  methods: [],
  groups: [],
  addons: [],
  combo: [],
});

const draftOf = (d: DishRow): Draft => ({
  name: d.name,
  category: d.category,
  slot: slotKey(d),
  stationId: d.stationId,
  imageId: d.imageId,
  imageUrl: d.imageUrl,
  prices: { standard: '', professional: '', premium: '' },
  active: d.active,
  methods: d.methodOptions.map((m) => ({ name: m.name, group: m.group, price: m.price ? centsToInput(m.price) : '' })),
  groups: d.methodGroups.map((g) => ({ ...g })),
  addons: d.addons.map((a) => a.itemId),
  combo: d.combo.map((c) => ({
    itemId: c.itemId,
    quantity: c.quantity,
    swappable: c.swappable,
    swaps: c.swaps.map((w) => ({ itemId: w.itemId, diff: w.priceDiff ? centsToInput(w.priceDiff) : '' })),
  })),
});

export function DishEditor({
  target,
  board,
  outlets,
  onClose,
  onSaved,
  onRejected,
  onDelete,
}: {
  target: DishRow | 'new' | null;
  board: DishesBoard;
  /** 这位员工能维护的出品口 */
  outlets: DiningOutlet[];
  onClose: () => void;
  onSaved: (dish: DishRow, created: boolean) => void;
  /** 服务端明确拒绝了（别人先改过、重名……）：外面把菜品表刷新一下，关掉重新打开看到的就是最新的 */
  onRejected: () => void;
  /** 删除这道菜（8.1.17 BW10：下架并从菜品表隐藏）：外面问一句再删 */
  onDelete?: (dish: DishRow) => void;
}) {
  const dish = target && target !== 'new' ? target : null;
  const [f, setF] = useState<Draft>(() => emptyDraft(outlets));
  const [method, setMethod] = useState('');
  const [groupName, setGroupName] = useState('');
  const [busy, setBusy] = useState<'save' | 'image' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [qtyHint, setQtyHint] = useState<string | null>(null);
  const session = useSession();
  // 这道菜（新增：任何一笔新增）上一笔保存的结果待确认：处理好之前不能再保存
  const waiting = pendingOf(useDishPending(), dish ? 'update' : 'create', dish?.id ?? null);
  useResetOnOpen(
    target !== null,
    () => {
      setF(dish ? draftOf(dish) : emptyDraft(outlets));
      setMethod('');
      setGroupName('');
      setBusy(null);
      setError(null);
      setQtyHint(null);
    },
    [dish?.id ?? 'new'],
  );
  const set = (patch: Partial<Draft>) => {
    setF((cur) => ({ ...cur, ...patch }));
    setError(null);
  };

  const byId = useMemo(() => new Map(board.dishes.map((d) => [d.id, d])), [board.dishes]);
  // 能当加料、放进套餐的：别的菜，自己不是套餐
  const candidates = useMemo(() => board.dishes.filter((d) => d.id !== dish?.id && d.combo.length === 0), [board.dishes, dish?.id]);
  const stations = board.stations.filter((s) => s.active || s.id === dish?.stationId);
  // 已经当了别人的加料、进了别的套餐的菜不能再做成套餐
  const comboBlocked = dish && dish.usedBy.length > 0 ? `这道菜已经是${dish.usedBy.join('、')}，不能再做成套餐。` : null;

  const addMethod = (raw: string) => {
    const m = raw.trim();
    if (!m) return;
    if (m.length > MAX_DISH_METHOD_LENGTH) return setError(`一种做法最多 ${MAX_DISH_METHOD_LENGTH} 个字`);
    if (/[，,、;；/\s+＋:：]/.test(m)) return setError('一种做法写一个，不要带逗号、顿号、斜杠、冒号、加号或空格');
    if (f.methods.some((x) => x.name === m)) return setMethod('');
    if (f.methods.length >= MAX_DISH_METHODS) return setError(`一道菜最多 ${MAX_DISH_METHODS} 种做法`);
    set({ methods: [...f.methods, { name: m, group: '', price: '' }] });
    setMethod('');
  };
  /** 做法分组（8.1.17）：同一组点单时只能选一个；必选的组不选不能下单 */
  const addGroup = (raw: string) => {
    const g = raw.trim();
    if (!g) return;
    if (g.length > MAX_DISH_METHOD_GROUP_LENGTH) return setError(`组名最多 ${MAX_DISH_METHOD_GROUP_LENGTH} 个字`);
    if (/[，,、;；/\s+＋:：（）()]/.test(g)) return setError('组名里不要带标点、括号或空格');
    if (f.groups.some((x) => x.name === g)) return setGroupName('');
    if (f.groups.length >= MAX_DISH_METHOD_GROUPS) return setError(`做法最多分 ${MAX_DISH_METHOD_GROUPS} 组`);
    set({ groups: [...f.groups, { name: g, required: false }] });
    setGroupName('');
  };
  const setMethodAt = (name: string, patch: Partial<Draft['methods'][number]>) => set({ methods: f.methods.map((m) => (m.name === name ? { ...m, ...patch } : m)) });

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy('image');
    setError(null);
    try {
      const img = await api.post<{ id: number; url: string }>('/api/dining/dishes/images', await imagePayload(file), { timeoutMs: 30_000 });
      set({ imageId: img.id, imageUrl: img.url });
    } catch (e) {
      setError(`图片没传上去：${errorMessage(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    const name = f.name.trim();
    if (!name) return setError('请填写菜名');
    if (f.stationId === null) return setError('请选择出品档口');
    const methods: DishMethodOption[] = [];
    for (const m of f.methods) {
      const price = m.price.trim() ? parseYuan(m.price) : 0;
      if (price === null || price > MAX_DISH_METHOD_PRICE) return setError(`做法「${m.name}」的加价「${m.price}」不对（最多 ${formatYuan(MAX_DISH_METHOD_PRICE)}）`);
      methods.push({ name: m.name, group: f.groups.some((g) => g.name === m.group) ? m.group : '', price });
    }
    const empty = f.groups.find((g) => !methods.some((m) => m.group === g.name));
    if (empty) return setError(`做法的组「${empty.name}」里还没有做法：给它选几种做法，或者把这一组去掉`);
    // 套餐（8.1.17）：可换的至少能换成一样；差价是每份套餐补的钱
    const combo: DishBody['combo'] = [];
    for (const c of f.combo) {
      const partName = byId.get(c.itemId)?.name ?? '这一样';
      if (c.swappable && c.swaps.length === 0) return setError(`套餐里的「${partName}」标了可换：请加上能换成的菜，或者取消「可换」`);
      const swaps: { itemId: number; priceDiff: number }[] = [];
      for (const w of c.swappable ? c.swaps : []) {
        const diff = w.diff.trim() ? parseYuan(w.diff) : 0;
        if (diff === null || diff > MAX_COMBO_SWAP_DIFF) return setError(`「${partName}」换成「${byId.get(w.itemId)?.name ?? ''}」的差价「${w.diff}」不对（最多 ${formatYuan(MAX_COMBO_SWAP_DIFF)}）`);
        swaps.push({ itemId: w.itemId, priceDiff: diff });
      }
      combo.push({ itemId: c.itemId, quantity: c.quantity, swappable: c.swappable, swaps });
    }
    const body: DishBody = {
      name,
      category: f.category.trim(),
      slot: f.slot,
      stationId: f.stationId,
      imageId: f.imageId,
      methods,
      methodGroups: f.groups,
      addons: f.addons,
      combo,
    };
    let extra: Record<string, unknown>;
    if (dish) extra = { rev: dish.rev };
    else {
      const prices: Partial<Record<PriceTier, number>> = {};
      for (const tier of PRICE_TIERS) {
        const text = f.prices[tier].trim();
        if (!text) continue;
        const cents = parseYuan(text);
        if (cents === null || cents <= 0) return setError(`${PRICE_TIER_LABELS[tier]}价「${text}」不是有效的金额`);
        prices[tier] = cents;
      }
      if (Object.keys(prices).length === 0) return setError('请至少填写一档价格');
      extra = { prices, active: f.active };
    }
    if (waiting) return;
    const key = uuid();
    setBusy('save');
    setError(null);
    try {
      const r = await sendDishOp<DishSaveResult>({
        key,
        type: dish ? 'update' : 'create',
        itemId: dish?.id ?? null,
        method: dish ? 'put' : 'post',
        url: dish ? `/api/dining/dishes/${dish.id}` : '/api/dining/dishes',
        body: { clientKey: key, ...body, ...extra },
        summary: dish ? `编辑「${dish.name}」` : `新增「${name}」`,
        staffName: session.staff.displayName,
      });
      onSaved(r.dish, !dish);
    } catch (e) {
      // 没收到结果：记录留在本机，弹窗里出现「结果待确认」那一条（查回、按原内容重新提交、确认作废）
      if (!(e instanceof UncertainError)) setError(errorMessage(e));
      if (e instanceof ApiError) onRejected();
    } finally {
      setBusy(null);
    }
  };

  const shownImage = f.imageUrl;
  return (
    <Dialog
      open={target !== null}
      onClose={onClose}
      title={dish ? `编辑菜品 · ${dish.name}` : '新增菜品'}
      description={dish ? '改价、上下架在菜品表里另点；这里改名称、分类、出品口、档口、图片、做法、加料与套餐内容。' : '菜品就是一个餐饮价目项目：建好以后点单页、后台价目里都有它。'}
      width="max-w-2xl"
      footer={
        <>
          {dish && onDelete && (
            <Button variant="danger" className="mr-auto min-h-11" icon={<Trash2 className="size-4" />} disabled={busy !== null} onClick={() => onDelete(dish)} data-testid="dish-delete">
              删除
            </Button>
          )}
          <Button variant="ghost" className="min-h-11" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" className="min-h-11 min-w-[112px]" loading={busy === 'save'} disabled={busy === 'image' || !!waiting} onClick={() => void save()} data-testid="dish-save">
            {dish ? '保存' : '新增'}
          </Button>
        </>
      }
    >
      <div className="space-y-5" data-testid="dish-editor">
        {waiting && <DishPendingNotice op={waiting} onApplied={(saved) => (saved ? onSaved(saved, !dish) : onRejected())} onAbandoned={onRejected} />}
        <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="菜名" htmlFor="dish-name" className="sm:col-span-2">
            <Input id="dish-name" value={f.name} onChange={(e) => set({ name: e.target.value })} maxLength={MAX_DISH_NAME} placeholder="例如 牛肉面" data-autofocus data-testid="dish-name" />
          </Field>
          <Field label="出品口与小类" htmlFor="dish-slot" hint="点单页先选餐厅 / 水吧 / 果吧，再按小类点">
            <Select id="dish-slot" className="min-h-11" value={f.slot} onChange={(e) => set({ slot: e.target.value })} data-testid="dish-slot">
              {ALL_DINING_SLOTS.map((s) => (
                <option key={slotKey(s)} value={slotKey(s)} disabled={!outlets.includes(s.outlet)}>
                  {slotLabel(s)}
                  {outlets.includes(s.outlet) ? '' : '（没有这一处的权限）'}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="出品档口" htmlFor="dish-station" hint="下单后到这个档口的厨房屏">
            <Select id="dish-station" className="min-h-11" value={f.stationId ?? ''} onChange={(e) => set({ stationId: e.target.value ? Number(e.target.value) : null })} data-testid="dish-station">
              <option value="">请选择</option>
              {stations.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.active ? '' : '（已停用）'}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="分类" htmlFor="dish-category" hint="价目分类：管部门营业额、券与会员折扣的范围">
            <Input id="dish-category" value={f.category} onChange={(e) => set({ category: e.target.value })} maxLength={MAX_DISH_CATEGORY} list="dish-categories" data-testid="dish-category" />
            <datalist id="dish-categories">
              {board.categories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </Field>
          <Field label="图片" hint={dish?.emenuDish && !f.imageId ? `现在带出的是电子菜单「${dish.emenuDish}」的图；这里传了就用这里的` : '选填；菜品表上显示'}>
            <div className="flex items-center gap-3">
              {shownImage ? (
                <img src={shownImage} alt="" className="size-14 rounded-md border border-line object-cover" data-testid="dish-image-preview" />
              ) : (
                <span className="flex size-14 items-center justify-center rounded-md border border-dashed border-line-strong text-[12px] text-ink-3">没有图</span>
              )}
              <label
                className={cn(
                  'inline-flex h-11 cursor-pointer items-center gap-1.5 rounded-md border border-line-strong bg-card px-3 text-[13.5px] font-semibold text-ink-2 hover:border-ink-3',
                  busy === 'image' && 'opacity-60',
                )}
              >
                <ImagePlus className="size-4" />
                {busy === 'image' ? '上传中…' : f.imageId ? '换一张' : '传一张'}
                <input
                  type="file"
                  accept="image/*"
                  className="sr-only"
                  aria-label="选择菜品图片"
                  disabled={busy !== null}
                  onChange={(e) => void upload(e.target.files?.[0])}
                  data-testid="dish-image-file"
                />
              </label>
              {f.imageId !== null && (
                <Button variant="ghost" className="min-h-11" onClick={() => set({ imageId: null, imageUrl: null })}>
                  去掉
                </Button>
              )}
            </div>
          </Field>
        </section>

        <Section title="规格与价格" hint="规格沿用价目里的三档；只卖一种就只填标准价。点单页卖的是第一档填了的价。">
          {dish ? (
            <p className="rounded-md bg-paper-2 px-3 py-2.5 text-[16px]" data-testid="dish-prices-now">
              <b className="num">{pricesText(dish.prices)}</b>
              <span className="ml-2 text-[12.5px] text-ink-3">改价请在菜品表里点「改价」（要写原因，留改价记录）</span>
            </p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {PRICE_TIERS.map((tier) => (
                  <Field key={tier} label={`${PRICE_TIER_LABELS[tier]}价`} htmlFor={`dish-price-${tier}`}>
                    <MoneyInput
                      id={`dish-price-${tier}`}
                      value={f.prices[tier]}
                      onChange={(e) => set({ prices: { ...f.prices, [tier]: e.target.value } })}
                      placeholder={tier === 'standard' ? '必填一档' : '不卖就空着'}
                      data-testid={`dish-price-input-${tier}`}
                    />
                  </Field>
                ))}
              </div>
              <label className="mt-3 inline-flex min-h-11 items-center gap-2 text-[13.5px] font-semibold text-ink-2">
                <input type="checkbox" className="size-4" checked={f.active} onChange={(e) => set({ active: e.target.checked })} data-testid="dish-active" />
                建好就上架（不勾的先放着，以后在菜品表里点「上架」）
              </label>
            </>
          )}
        </Section>

        <Section
          title={`做法 ${f.methods.length ? f.methods.length : ''}`}
          hint="点单时选了写进出品单的口味备注，例如「微辣，免葱」。可以分组（同一组只能选一个，组可以设必选），可以加价（按份加在这道菜的单价上，账单上写「特辣 +¥2」）。"
        >
          <div className="flex flex-wrap items-center gap-1.5" data-testid="dish-method-groups">
            <span className="text-[13px] font-semibold text-ink-2">分组：</span>
            {f.groups.length === 0 && <span className="text-[13px] text-ink-3">不分组（都可以多选）</span>}
            {f.groups.map((g) => (
              <span key={g.name} className="inline-flex h-11 items-center gap-1 rounded-full bg-lake-soft pr-1 pl-3 text-[13.5px] font-semibold text-lake" data-testid={`dish-group-${g.name}`}>
                {g.name}
                <label className="ml-1 inline-flex h-9 items-center gap-1 rounded-full px-1.5 text-[13px] font-semibold">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={g.required}
                    onChange={(e) => set({ groups: f.groups.map((x) => (x.name === g.name ? { ...x, required: e.target.checked } : x)) })}
                    data-testid={`dish-group-required-${g.name}`}
                  />
                  必选
                </label>
                <button
                  type="button"
                  aria-label={`去掉做法的组 ${g.name}`}
                  title={`去掉这一组（组里的做法改成不分组）`}
                  onClick={() => set({ groups: f.groups.filter((x) => x.name !== g.name), methods: f.methods.map((m) => (m.group === g.name ? { ...m, group: '' } : m)) })}
                  className="tap relative flex size-9 items-center justify-center rounded-full hover:bg-lake/10"
                >
                  <X className="size-3.5" />
                </button>
              </span>
            ))}
          </div>
          <form
            className="mt-2 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              addGroup(groupName);
            }}
          >
            <Input
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              maxLength={MAX_DISH_METHOD_GROUP_LENGTH}
              placeholder="加一组，例如 辣度、冰量"
              aria-label="做法的组名"
              data-testid="dish-group-input"
            />
            <Button type="submit" className="min-h-11 shrink-0" icon={<Plus className="size-4" />} disabled={!groupName.trim()} data-testid="dish-group-add">
              加一组
            </Button>
          </form>
          <ul className="mt-3 space-y-1.5" data-testid="dish-methods">
            {f.methods.length === 0 && <li className="text-[13px] text-ink-3">还没有做法</li>}
            {f.methods.map((m) => (
              <li key={m.name} className="flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-1.5" data-testid={`dish-method-${m.name}`}>
                <span className="min-w-0 flex-1 basis-20 truncate text-[15px] font-semibold">{m.name}</span>
                <Select
                  className="min-h-11 w-32"
                  fullWidth={false}
                  value={m.group}
                  onChange={(e) => setMethodAt(m.name, { group: e.target.value })}
                  aria-label={`${m.name} 在哪一组`}
                  data-testid={`dish-method-group-${m.name}`}
                >
                  <option value="">不分组</option>
                  {f.groups.map((g) => (
                    <option key={g.name} value={g.name}>
                      {g.name}
                    </option>
                  ))}
                </Select>
                <span className="w-28">
                  <MoneyInput
                    value={m.price}
                    onChange={(e) => setMethodAt(m.name, { price: e.target.value })}
                    placeholder="不加钱"
                    aria-label={`${m.name} 加价（元）`}
                    data-testid={`dish-method-price-${m.name}`}
                  />
                </span>
                {parseYuan(m.price) ? <span className="num text-[13px] font-semibold text-ember-deep">{plusYuan(parseYuan(m.price)!)}</span> : null}
                <RemoveButton label={`去掉做法 ${m.name}`} onClick={() => set({ methods: f.methods.filter((x) => x.name !== m.name) })} />
              </li>
            ))}
          </ul>
          <form
            className="mt-2 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              addMethod(method);
            }}
          >
            <Input value={method} onChange={(e) => setMethod(e.target.value)} maxLength={MAX_DISH_METHOD_LENGTH} placeholder="写一种做法，回车加上" aria-label="做法" data-testid="dish-method-input" />
            <Button type="submit" className="min-h-11" icon={<Plus className="size-4" />} disabled={!method.trim()} data-testid="dish-method-add">
              加上
            </Button>
          </form>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {QUICK_METHODS.filter((m) => !f.methods.some((x) => x.name === m)).map((m) => (
              <button key={m} type="button" className="tap relative h-9 rounded-full bg-paper-2 px-3 text-[12.5px] font-semibold text-ink-3 hover:text-ink" onClick={() => addMethod(m)}>
                + {m}
              </button>
            ))}
          </div>
        </Section>

        <Section title={`加料 ${f.addons.length ? f.addons.length : ''}`} hint="另外的菜（各有各的价、沽清、档口）。点单时另起一行，出品单上写「配 这道菜」。">
          <ul className="space-y-1.5" data-testid="dish-addons">
            {f.addons.map((id) => {
              const a = byId.get(id);
              return (
                <li key={id} className="flex min-h-11 items-center gap-2 rounded-md border border-line px-3">
                  <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{a?.name ?? '已经不是菜品'}</span>
                  {a && <span className="num text-[16px] font-semibold text-ink-2">+{formatYuan(a.price)}</span>}
                  {a && !a.active && (
                    <StatusChip tone="neutral" icon={<CircleOff />}>
                      已下架
                    </StatusChip>
                  )}
                  <RemoveButton label={`去掉加料 ${a?.name ?? ''}`} onClick={() => set({ addons: f.addons.filter((x) => x !== id) })} />
                </li>
              );
            })}
          </ul>
          {f.addons.length < MAX_DISH_ADDONS && (
            <DishPicker candidates={candidates.filter((d) => !f.addons.includes(d.id))} placeholder="搜菜名，加一种料" testId="dish-addon" onPick={(d) => set({ addons: [...f.addons, d.id] })} />
          )}
        </Section>

        <Section
          title={`套餐内容 ${f.combo.length ? f.combo.length : ''}`}
          hint="填了就是套餐：下单一行、按这道菜自己的价，出品单上列出含的几样；每一样在自己的档口出、扣自己的沽清与用料。标了「可换」的点单时可以换成列出的菜（补差价的加在这一行上）。"
        >
          {comboBlocked ? (
            <p className="text-[13px] text-ink-3" data-testid="dish-combo-blocked">
              {comboBlocked}
            </p>
          ) : (
            <>
              <ul className="space-y-1.5" data-testid="dish-combo">
                {f.combo.map((c) => {
                  const it = byId.get(c.itemId);
                  const name = it?.name ?? '这一样';
                  const patch = (p: Partial<Draft['combo'][number]>) => set({ combo: f.combo.map((x) => (x.itemId === c.itemId ? { ...x, ...p } : x)) });
                  return (
                    <li key={c.itemId} className="rounded-md border border-line px-3 py-1" data-testid={`dish-combo-part-${name}`}>
                      <div className="flex min-h-11 flex-wrap items-center gap-2">
                        <span className="min-w-0 flex-1 basis-24 truncate text-[15px] font-semibold">{it?.name ?? '已经不是菜品'}</span>
                        {it && !it.active && (
                          <StatusChip tone="neutral" icon={<CircleOff />}>
                            已下架
                          </StatusChip>
                        )}
                        <span className="text-[13px] text-ink-3">×</span>
                        <QtyInput
                          value={c.quantity}
                          onChange={(n) => patch({ quantity: n })}
                          onHint={setQtyHint}
                          label={`${name} 每份套餐含几份`}
                          className="h-9 w-11 rounded-md border border-line-strong text-[15px]"
                          testId={`dish-combo-qty-${it?.name ?? c.itemId}`}
                        />
                        {/* 8.1.17（BW7）：点单时能不能换成别的 */}
                        <label className="inline-flex h-11 items-center gap-1.5 px-1 text-[13.5px] font-semibold text-ink-2">
                          <input type="checkbox" className="size-4" checked={c.swappable} onChange={(e) => patch({ swappable: e.target.checked })} data-testid={`dish-combo-swappable-${name}`} />
                          可换
                        </label>
                        <RemoveButton label={`去掉 ${it?.name ?? ''}`} onClick={() => set({ combo: f.combo.filter((x) => x.itemId !== c.itemId) })} />
                      </div>
                      {c.swappable && (
                        <div className="mb-1.5 ml-2 border-l-2 border-line pl-3" data-testid={`dish-combo-swaps-${name}`}>
                          <p className="text-[12.5px] text-ink-3">点单时可以换成（每份套餐补的差价，空着 = 同价）：</p>
                          <ul className="mt-1 space-y-1">
                            {c.swaps.map((w) => {
                              const to = byId.get(w.itemId);
                              return (
                                <li key={w.itemId} className="flex min-h-11 flex-wrap items-center gap-2" data-testid={`dish-combo-swap-${name}-${to?.name ?? w.itemId}`}>
                                  <span className="min-w-0 flex-1 basis-20 truncate text-[14.5px] font-semibold">{to?.name ?? '已经不是菜品'}</span>
                                  {to && !to.active && (
                                    <StatusChip tone="neutral" icon={<CircleOff />}>
                                      已下架
                                    </StatusChip>
                                  )}
                                  <span className="w-28">
                                    <MoneyInput
                                      value={w.diff}
                                      onChange={(e) => patch({ swaps: c.swaps.map((x) => (x.itemId === w.itemId ? { ...x, diff: e.target.value } : x)) })}
                                      placeholder="同价"
                                      aria-label={`${name} 换成 ${to?.name ?? ''} 补差价（元）`}
                                      data-testid={`dish-combo-swap-diff-${name}-${to?.name ?? w.itemId}`}
                                    />
                                  </span>
                                  <RemoveButton label={`不能换成 ${to?.name ?? ''}`} onClick={() => patch({ swaps: c.swaps.filter((x) => x.itemId !== w.itemId) })} />
                                </li>
                              );
                            })}
                          </ul>
                          {c.swaps.length < MAX_COMBO_SWAPS && (
                            <DishPicker
                              candidates={candidates.filter((d) => d.id !== c.itemId && !c.swaps.some((w) => w.itemId === d.id))}
                              placeholder={`搜菜名，${name}可以换成什么`}
                              testId={`dish-combo-swap-${name}`}
                              onPick={(d) => patch({ swaps: [...c.swaps, { itemId: d.id, diff: '' }] })}
                            />
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
              {qtyHint && (
                <p className="mt-1 text-[12.5px] font-semibold text-clay" role="status">
                  {qtyHint}
                </p>
              )}
              {f.combo.length < MAX_COMBO_ITEMS && (
                <DishPicker
                  candidates={candidates.filter((d) => !f.combo.some((c) => c.itemId === d.id))}
                  placeholder="搜菜名，加进套餐"
                  testId="dish-combo"
                  onPick={(d) => set({ combo: [...f.combo, { itemId: d.id, quantity: 1, swappable: false, swaps: [] }] })}
                />
              )}
            </>
          )}
        </Section>

        {error && <Notice tone="error" title={error} data-testid="dish-editor-error" />}
      </div>
    </Dialog>
  );
}

function Section({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section className="border-t border-line pt-4">
      <h3 className="text-[14px] font-bold text-ink">{title}</h3>
      <p className="mt-0.5 mb-2.5 text-[12.5px] leading-relaxed text-ink-3">{hint}</p>
      {children}
    </section>
  );
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="-mr-2 flex size-11 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-paper-2 hover:text-clay">
      <Trash2 className="size-4" />
    </button>
  );
}

/** 从菜品里挑一道：打字筛，点一下选上（最多列 6 道，没打字时列前 6 道） */
function DishPicker({ candidates, placeholder, testId, onPick }: { candidates: DishRow[]; placeholder: string; testId: string; onPick: (d: DishRow) => void }) {
  const [q, setQ] = useState('');
  const hits = candidates.filter((d) => d.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 6);
  return (
    <div className="mt-2">
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} maxLength={MAX_DISH_NAME} aria-label={placeholder} data-testid={`${testId}-search`} />
      {candidates.length === 0 ? (
        <p className="mt-1.5 text-[12.5px] text-ink-3">没有可以选的菜了（套餐不能选进来）。</p>
      ) : hits.length === 0 ? (
        <p className="mt-1.5 text-[12.5px] text-ink-3">没有叫这个名字的菜。</p>
      ) : (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {hits.map((d) => (
            <button
              key={d.id}
              type="button"
              className="inline-flex h-11 items-center gap-1.5 rounded-md border border-line bg-card px-3 text-[15px] font-semibold text-ink-2 hover:border-pine"
              onClick={() => {
                onPick(d);
                setQ('');
              }}
              data-testid={`${testId}-pick-${d.name}`}
            >
              <Plus className="size-3.5" />
              {d.name}
              <span className="num text-[16px] font-normal text-ink-3">{formatYuan(d.price)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
