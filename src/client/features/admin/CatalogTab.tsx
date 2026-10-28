import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FileUp, ListChecks, Plus } from 'lucide-react';
import { itemTags, PRICE_TIER_LABELS, PRICE_TIERS, STRENGTH_LABELS, STRENGTHS, tierPrice, type PriceTier, type Strength } from '@shared/catalog';
import { centsToInput, parseYuan } from '@shared/money';
import { parsePriceListCsv, type BuiltinPriceList, type PriceListCsvResult, type PriceListImportReport } from '@shared/price-list-import';
import type { Catalog, RechargePlan, ServiceItem } from '@shared/types';
import { api, errorMessage } from '../../lib/api';
import { useCatalog } from '../../lib/queries';
import { cn } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, ConfirmCheck, Field, Input, MoneyInput, Notice, PendingBadge, SectionTitle, Segmented, Skeleton } from '../../components/ui';

type Editing = { kind: 'plan'; data: RechargePlan | null } | { kind: 'item'; data: ServiceItem | null } | null;

export function CatalogTab() {
  const catalog = useCatalog(true);
  const [editing, setEditing] = useState<Editing>(null);

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card className="p-5">
        <SectionTitle
          aside={
            <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setEditing({ kind: 'plan', data: null })}>
              新增套餐
            </Button>
          }
        >
          <span className="flex items-center gap-2">
            充值套餐 <PendingBadge title="实际充值与赠送方案待店主确认" />
          </span>
        </SectionTitle>
        <p className="mt-1 text-[12.5px] text-ink-3">实收金额计入本金，赠送部分计入赠金。停用后不再出现在充值页，历史单据不受影响。</p>
        <div className="mt-3 space-y-2">
          {catalog.isPending ? (
            <Skeleton className="h-32" />
          ) : catalog.data?.plans.length === 0 ? (
            <EmptyState art="leaf" title="还没有充值套餐" className="py-6" />
          ) : (
            catalog.data?.plans.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setEditing({ kind: 'plan', data: p })}
                className={cn('flex w-full items-center gap-3 rounded-lg border border-line px-4 py-3 text-left transition-colors hover:border-line-strong hover:bg-paper/60', !p.active && 'opacity-50')}
              >
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-bold">{p.name}</p>
                  {p.note && <p className="text-[12px] text-ink-3">{p.note}</p>}
                </div>
                {!p.active && <Badge>已停用</Badge>}
                <div className="text-right">
                  <Money cents={p.payAmount} className="text-[15px] font-bold" />
                  <p className="text-[12px] font-semibold text-yuzu-deep">
                    {p.bonusAmount ? (
                      <>
                        送 <Money cents={p.bonusAmount} />
                      </>
                    ) : (
                      <span className="text-ink-4">无赠送</span>
                    )}
                  </p>
                </div>
              </button>
            ))
          )}
        </div>
      </Card>

      <Card className="p-5">
        <SectionTitle
          aside={
            <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setEditing({ kind: 'item', data: null })}>
              新增项目
            </Button>
          }
        >
          消费项目
        </SectionTitle>
        <p className="mt-1 text-[12.5px] text-ink-3">价格以这里为准；同一项目可设标准 / 专业 / 优选多档价格。改价后，正在登记的消费会提示重新核对。</p>
        <div className="mt-3 divide-y divide-line/70 rounded-lg border border-line" data-testid="catalog-items">
          {catalog.isPending ? (
            <Skeleton className="m-3 h-32" />
          ) : catalog.data?.items.length === 0 ? (
            <EmptyState art="leaf" title="还没有消费项目" className="py-6" />
          ) : (
            catalog.data?.items.map((i) => {
              const tags = itemTags(i);
              return (
                <button
                  key={i.id}
                  type="button"
                  onClick={() => setEditing({ kind: 'item', data: i })}
                  className={cn('flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-paper/60', !i.active && 'opacity-50')}
                >
                  <span className="w-20 shrink-0 truncate text-[12px] font-semibold text-ink-3">{i.category || '其他'}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-semibold">{i.name}</span>
                    {(i.durationMinutes || tags.length > 0 || i.gender) && (
                      <span className="block truncate text-[11.5px] text-ink-3">
                        {[i.durationMinutes ? `${i.durationMinutes} 分钟` : '', i.gender ? `仅${i.gender === 'female' ? '女宾' : '男宾'}` : '', ...tags].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </span>
                  {!i.active && <Badge>已停用</Badge>}
                  <span className="flex shrink-0 flex-col items-end">
                    {i.prices.length === 1 ? (
                      <Money cents={i.prices[0]!.price} className="text-[14px] font-bold" />
                    ) : (
                      i.prices.map((p) => (
                        <span key={p.tier} className="flex items-baseline gap-1 text-[12.5px]">
                          <span className="text-ink-3">{PRICE_TIER_LABELS[p.tier]}</span>
                          <Money cents={p.price} className="font-bold" />
                        </span>
                      ))
                    )}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </Card>

      <PriceListCard />

      <PlanDialog editing={editing?.kind === 'plan' ? editing : null} onClose={() => setEditing(null)} />
      <ItemDialog editing={editing?.kind === 'item' ? editing : null} onClose={() => setEditing(null)} />
    </div>
  );
}

function PlanDialog({ editing, onClose }: { editing: Extract<Editing, { kind: 'plan' }> | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [bonus, setBonus] = useState('');
  const [note, setNote] = useState('');
  const [active, setActive] = useState(true);
  const [sort, setSort] = useState('0');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [last, setLast] = useState<Editing>(null);

  if (editing !== last) {
    setLast(editing);
    const p = editing?.data;
    setName(p?.name ?? '');
    setAmount(p ? centsToInput(p.payAmount) : '');
    setBonus(p ? centsToInput(p.bonusAmount) : '');
    setNote(p?.note ?? '');
    setActive(p?.active ?? true);
    setSort(String(p?.sortOrder ?? 0));
    setError(null);
  }

  const save = async () => {
    const cents = parseYuan(amount);
    const bonusCents = bonus.trim() ? parseYuan(bonus) : 0;
    if (!name.trim()) return setError('请填写名称');
    if (!cents) return setError('请填写正确的金额');
    if (bonusCents === null) return setError('赠金格式不正确');
    setSaving(true);
    setError(null);
    try {
      const body = { name, payAmount: cents, bonusAmount: bonusCents, note, active, sortOrder: Number(sort) || 0 };
      const result: Catalog = editing?.data ? await api.put(`/api/plans/${editing.data.id}`, body) : await api.post('/api/plans', body);
      qc.setQueryData(['catalog', true], result);
      void qc.invalidateQueries({ queryKey: ['catalog', false] });
      toast({ tone: 'success', title: '已保存' });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={!!editing}
      onClose={onClose}
      title={`${editing?.data ? '编辑' : '新增'}充值套餐`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={saving} onClick={save}>
            保存
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="名称" htmlFor="c-name">
          <Input id="c-name" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} data-autofocus />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="实收金额" htmlFor="c-amount">
            <MoneyInput id="c-amount" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="赠金" htmlFor="c-bonus" hint="无赠送填 0">
            <MoneyInput id="c-bonus" value={bonus} onChange={(e) => setBonus(e.target.value)} />
          </Field>
        </div>
        <Field label="说明" htmlFor="c-note" hint="选填">
          <Input id="c-note" value={note} maxLength={100} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <ActiveSortFields active={active} setActive={setActive} sort={sort} setSort={setSort} />
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}

function ActiveSortFields({ active, setActive, sort, setSort }: { active: boolean; setActive: (v: boolean) => void; sort: string; setSort: (v: string) => void }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="状态">
        <Segmented
          value={active ? 'on' : 'off'}
          onChange={(v) => setActive(v === 'on')}
          className="w-full"
          options={[
            { value: 'on', label: '启用' },
            { value: 'off', label: '停用' },
          ]}
        />
      </Field>
      <Field label="排序" htmlFor="c-sort" hint="数字越小越靠前">
        <Input id="c-sort" inputMode="numeric" value={sort} onChange={(e) => setSort(e.target.value.replace(/[^\d-]/g, ''))} />
      </Field>
    </div>
  );
}

/** 消费项目：多档价格（某一档不提供时留空）、时长、性别限定与属性（属性不影响计价） */
function ItemDialog({ editing, onClose }: { editing: Extract<Editing, { kind: 'item' }> | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [prices, setPrices] = useState<Record<PriceTier, string>>({ standard: '', professional: '', premium: '' });
  const [duration, setDuration] = useState('');
  const [gender, setGender] = useState<'any' | 'male' | 'female'>('any');
  const [strength, setStrength] = useState<'none' | Strength>('none');
  const [essentialOil, setEssentialOil] = useState(false);
  const [heatTherapy, setHeatTherapy] = useState(false);
  const [popular, setPopular] = useState(false);
  const [note, setNote] = useState('');
  const [active, setActive] = useState(true);
  const [sort, setSort] = useState('0');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [last, setLast] = useState<Editing>(null);

  if (editing !== last) {
    setLast(editing);
    const i = editing?.data;
    setName(i?.name ?? '');
    setCategory(i?.category ?? '');
    setPrices({
      standard: i && tierPrice(i.prices, 'standard') !== null ? centsToInput(tierPrice(i.prices, 'standard')!) : '',
      professional: i && tierPrice(i.prices, 'professional') !== null ? centsToInput(tierPrice(i.prices, 'professional')!) : '',
      premium: i && tierPrice(i.prices, 'premium') !== null ? centsToInput(tierPrice(i.prices, 'premium')!) : '',
    });
    setDuration(i?.durationMinutes ? String(i.durationMinutes) : '');
    setGender(i?.gender ?? 'any');
    setStrength(i?.strength ?? 'none');
    setEssentialOil(i?.essentialOil ?? false);
    setHeatTherapy(i?.heatTherapy ?? false);
    setPopular(i?.popular ?? false);
    setNote(i?.note ?? '');
    setActive(i?.active ?? true);
    setSort(String(i?.sortOrder ?? 0));
    setError(null);
  }

  const save = async () => {
    if (!name.trim()) return setError('请填写名称');
    const tierCents: Partial<Record<PriceTier, number | null>> = {};
    for (const t of PRICE_TIERS) {
      const text = prices[t].trim();
      if (!text) {
        tierCents[t] = null;
        continue;
      }
      const c = parseYuan(text);
      if (!c) return setError(`${PRICE_TIER_LABELS[t]}价格式不正确`);
      tierCents[t] = c;
    }
    if (PRICE_TIERS.every((t) => !tierCents[t])) return setError('请至少填写一档价格');
    const minutes = duration.trim() ? Number(duration) : null;
    if (minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440)) return setError('时长应为 1–1440 分钟');
    setSaving(true);
    setError(null);
    try {
      const body = {
        name,
        category,
        prices: tierCents,
        durationMinutes: minutes,
        gender: gender === 'any' ? null : gender,
        strength: strength === 'none' ? null : strength,
        essentialOil,
        heatTherapy,
        popular,
        note,
        active,
        sortOrder: Number(sort) || 0,
      };
      const result: Catalog = editing?.data ? await api.put(`/api/items/${editing.data.id}`, body) : await api.post('/api/items', body);
      qc.setQueryData(['catalog', true], result);
      void qc.invalidateQueries({ queryKey: ['catalog', false] });
      toast({ tone: 'success', title: '已保存' });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={!!editing}
      onClose={onClose}
      width="max-w-xl"
      title={`${editing?.data ? '编辑' : '新增'}消费项目`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={saving} onClick={save} data-testid="item-save">
            保存
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_180px]">
          <Field label="名称" htmlFor="c-name">
            <Input id="c-name" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} data-autofocus />
          </Field>
          <Field label="分类" htmlFor="c-cat" hint="如 全身按摩 / 理疗系列">
            <Input id="c-cat" value={category} maxLength={16} onChange={(e) => setCategory(e.target.value)} />
          </Field>
        </div>
        <Field label="价格" hint="某一档不提供时留空；不带档位的旧请求按标准 → 专业 → 优选中第一个提供的计价">
          <div className="grid grid-cols-3 gap-2.5">
            {PRICE_TIERS.map((t) => (
              <label key={t} className="flex flex-col gap-1 text-[12px] font-semibold text-ink-3">
                {PRICE_TIER_LABELS[t]}
                <MoneyInput value={prices[t]} onChange={(e) => setPrices((p) => ({ ...p, [t]: e.target.value }))} aria-label={`${PRICE_TIER_LABELS[t]}价`} placeholder="不提供" />
              </label>
            ))}
          </div>
        </Field>
        <div className="grid gap-4 sm:grid-cols-[140px_minmax(0,1fr)]">
          <Field label="时长（分钟）" htmlFor="c-duration" hint="选填">
            <Input id="c-duration" inputMode="numeric" value={duration} onChange={(e) => setDuration(e.target.value.replace(/[^\d]/g, ''))} className="num" />
          </Field>
          <Field label="适用宾客">
            <Segmented
              value={gender}
              onChange={setGender}
              options={[
                { value: 'any', label: '不限' },
                { value: 'male', label: '仅男宾' },
                { value: 'female', label: '仅女宾' },
              ]}
            />
          </Field>
        </div>
        <Field label="项目属性" hint="只用于展示与筛选，不影响计价">
          <div className="space-y-2.5">
            <Segmented
              value={strength}
              onChange={setStrength}
              ariaLabel="力道"
              options={[{ value: 'none' as const, label: '力道不标注' }, ...STRENGTHS.map((v) => ({ value: v, label: STRENGTH_LABELS[v] }))]}
            />
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ['精油', essentialOil, setEssentialOil],
                  ['热疗', heatTherapy, setHeatTherapy],
                  ['超人气', popular, setPopular],
                ] as const
              ).map(([label, on, set]) => (
                <button
                  key={label}
                  type="button"
                  role="switch"
                  aria-checked={on}
                  onClick={() => set(!on)}
                  className={cn('h-9 rounded-full border px-3.5 text-[13px] font-semibold', on ? 'border-pine bg-pine-tint text-pine' : 'border-line bg-card text-ink-2')}
                >
                  {on ? '✓ ' : ''}
                  {label}
                </button>
              ))}
            </div>
          </div>
        </Field>
        <Field label="说明" htmlFor="c-note" hint="选填，如「含采耳」">
          <Input id="c-note" value={note} maxLength={100} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <ActiveSortFields active={active} setActive={setActive} sort={sort} setSort={setSort} />
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}

/** 价目表导入：内置的店主价目表或 CSV 文件，先预览再导入 */
function PriceListCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState('');
  const [parsed, setParsed] = useState<PriceListCsvResult | null>(null);
  const [deactivateMissing, setDeactivateMissing] = useState(false);
  const [preview, setPreview] = useState<PriceListImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (dryRun: boolean, rows = parsed?.rows ?? [], deactivate = deactivateMissing) => {
    setBusy(true);
    setError(null);
    try {
      const report = await api.post<PriceListImportReport>('/api/items/import', { rows, deactivateMissing: deactivate, dryRun });
      if (dryRun) {
        setPreview(report);
      } else {
        toast({
          tone: 'success',
          title: `已导入 ${report.total} 个项目`,
          body: `新建 ${report.created} · 更新 ${report.updated} · 未变 ${report.unchanged}${report.deactivated ? ` · 停用 ${report.deactivated}` : ''}`,
        });
        setParsed(null);
        setPreview(null);
        setSource('');
        void qc.invalidateQueries({ queryKey: ['catalog'] });
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const load = async (name: string, text: string) => {
    setPreview(null);
    setError(null);
    setSource(name);
    const result = parsePriceListCsv(text);
    setParsed(result);
    if (result.errors.length === 0) await run(true, result.rows, deactivateMissing);
  };

  const loadBuiltin = async () => {
    try {
      const lists = await api.get<BuiltinPriceList[]>('/api/items/price-lists');
      const list = lists[0];
      if (list) await load(list.title, list.csv);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Card className="p-5 lg:col-span-2" data-testid="price-list-import">
      <SectionTitle>
        <span className="flex items-center gap-2">导入价目表</span>
      </SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">
        按项目名称导入：新项目新建，已有项目的分类、时长、各档价格与排序以价目表为准；力道、精油、热疗、超人气在表里留空时保持现有设置。CSV 列为{' '}
        <code className="num">category,name,duration_minutes,gender,standard,professional,premium,strength,essential_oil,heat_therapy,popular,note</code>
        （价格单位为元，与 docs/data/price-list-tangqi-2026-10-27.csv 相同）。
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button variant="secondary" icon={<ListChecks className="size-4" />} onClick={() => void loadBuiltin()} loading={busy && !preview && !parsed} data-testid="price-list-builtin">
          预览汤崎价目表（店主 2026-10-27）
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) await load(f.name, await f.text());
            e.target.value = '';
          }}
          data-testid="price-list-file"
        />
        <Button variant="ghost" icon={<FileUp className="size-4" />} onClick={() => fileRef.current?.click()}>
          选择 CSV 文件
        </Button>
        {source && <span className="text-[13px] text-ink-2">{source}</span>}
      </div>
      <div className="mt-3">
        <ConfirmCheck
          checked={deactivateMissing}
          onChange={(v) => {
            setDeactivateMissing(v);
            if (parsed && parsed.errors.length === 0) void run(true, parsed.rows, v);
          }}
        >
          同时停用不在价目表里的项目
          <span className="block text-[12.5px] font-normal text-ink-3">例如试用期间的示例项目；停用后历史单据不受影响</span>
        </ConfirmCheck>
      </div>

      {parsed && parsed.errors.length > 0 && (
        <Notice tone="error" title={`价目表有 ${parsed.errors.length} 处需要修改，未导入`} className="mt-3">
          <ul className="mt-1 space-y-0.5 text-[12.5px]">
            {parsed.errors.slice(0, 8).map((e) => (
              <li key={`${e.line}-${e.message}`}>
                第 {e.line} 行：{e.message}
              </li>
            ))}
          </ul>
        </Notice>
      )}
      {preview && (
        <div className="mt-3 space-y-3" data-testid="price-list-preview">
          <p className="text-[13.5px] text-ink-2">
            价目表共 <b className="num">{preview.total}</b> 个项目：新建 <b className="num">{preview.created}</b> · 更新 <b className="num">{preview.updated}</b> · 未变{' '}
            <b className="num">{preview.unchanged}</b>
            {deactivateMissing && (
              <>
                {' '}
                · 停用价目表外 <b className="num">{preview.deactivated}</b>
              </>
            )}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {preview.groups.map((g) => (
              <span key={g.category} className="rounded-full border border-line bg-paper px-2.5 py-1 text-[12.5px] font-semibold">
                {g.category} <span className="num text-ink-3">{g.count}</span>
              </span>
            ))}
          </div>
          <Button variant="primary" loading={busy} onClick={() => void run(false)} data-testid="price-list-confirm">
            确认导入 {preview.total} 个项目
          </Button>
        </div>
      )}
      {error && <Notice tone="error" title={error} className="mt-3" />}
    </Card>
  );
}
