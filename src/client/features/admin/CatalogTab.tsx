import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FileUp, ListChecks, Plus } from 'lucide-react';
import { isCareItem, itemTags, PRICE_TIER_LABELS, PRICE_TIERS, STRENGTH_LABELS, STRENGTHS, tierPrice, type PriceTier, type Strength } from '@shared/catalog';
import { centsToInput, parseYuan } from '@shared/money';
import { parsePriceListCsv, type BuiltinPriceList, type PriceListCsvResult, type PriceListImportReport } from '@shared/price-list-import';
import type { TicketType } from '@shared/checkout';
import type { Catalog, RechargePlan, ServiceItem } from '@shared/types';
import { api, errorMessage } from '../../lib/api';
import { readImportFile } from '../../lib/import-file';
import { useCatalog } from '../../lib/queries';
import { useTicketTypes } from '../frontdesk/queries';
import { cn } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, ConfirmCheck, Field, Input, MoneyInput, Notice, PendingBadge, SectionTitle, Segmented, Skeleton } from '../../components/ui';
import { SubPane } from '../../components/SubNav';
import { AdminPage } from './AdminShell';

type Editing = { kind: 'plan'; data: RechargePlan | null } | { kind: 'item'; data: ServiceItem | null } | null;

/** 二级页签（8.0.17）：清单 → 导入与工具（价目没有规则类的设置） */
const CATALOG_TABS = [
  { key: 'items', label: '消费项目' },
  { key: 'tickets', label: '门票' },
  { key: 'plans', label: '充值套餐' },
  { key: 'import', label: '导入价目表' },
];

export function CatalogTab() {
  const catalog = useCatalog(true);
  const [editing, setEditing] = useState<Editing>(null);

  return (
    <AdminPage section="catalog" description="消费项目（多档价格）、门票票种与票价、充值套餐、价目表导入。" tabs={CATALOG_TABS}>
      <SubPane tab="items">
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
                    {(i.durationMinutes || tags.length > 0 || i.gender || i.technicianRequired) && (
                      <span className="block truncate text-[11.5px] text-ink-3">
                        {[i.durationMinutes ? `${i.durationMinutes} 分钟` : '', i.gender ? `仅${i.gender === 'female' ? '女宾' : '男宾'}` : '', i.technicianRequired ? '需要技师' : '', ...tags]
                          .filter(Boolean)
                          .join(' · ')}
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
      </SubPane>
      <SubPane tab="tickets">
        <TicketTypesCard />
      </SubPane>
      <SubPane tab="plans">
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
                        <span className="ml-1 font-normal text-ink-3">{p.bonusValidDays ? `${p.bonusValidDays} 天有效` : '长期有效'}</span>
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
      </SubPane>
      <SubPane tab="import">
        <PriceListCard />
      </SubPane>

      <PlanDialog editing={editing?.kind === 'plan' ? editing : null} onClose={() => setEditing(null)} />
      <ItemDialog editing={editing?.kind === 'item' ? editing : null} onClose={() => setEditing(null)} />
      {/* 次卡的卡种 8.0.4 起取消（需求表 03：价目与套餐不再有次卡；已售的次卡照常结账核销、退卡、打印，见 docs/MEMBERSHIP_V804.md 第 3 节） */}
    </AdminPage>
  );
}

function PlanDialog({ editing, onClose }: { editing: Extract<Editing, { kind: 'plan' }> | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [bonus, setBonus] = useState('');
  /** 赠金有效期（天）；空为长期有效 */
  const [validDays, setValidDays] = useState('');
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
    setValidDays(p?.bonusValidDays ? String(p.bonusValidDays) : '');
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
    const days = validDays.trim() ? Number(validDays.trim()) : null;
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) return setError('赠金有效期请填 1–3650 天，长期有效请留空');
    setSaving(true);
    setError(null);
    try {
      const body = { name, payAmount: cents, bonusAmount: bonusCents, bonusValidDays: days, note, active, sortOrder: Number(sort) || 0 };
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
        <Field
          label={<span className="inline-flex items-center gap-2">赠金有效期（天） <PendingBadge /></span>}
          htmlFor="c-valid"
          hint="留空为长期有效；填 30 表示从充值当天的营业日算起共 30 个营业日可用，第 31 天营业日开始时未用完的赠金作废"
        >
          <Input id="c-valid" inputMode="numeric" className="num" value={validDays} maxLength={4} placeholder="长期有效" onChange={(e) => setValidDays(e.target.value.replace(/\D/g, ''))} />
        </Field>
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
  /** null：新建项目、还没手动选过，按名称或分类含「护理」默认需要技师（8.0.8，A01）；手动选过或编辑已有项目时是选定的值 */
  const [technicianRequired, setTechnicianRequired] = useState<boolean | null>(null);
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
    setTechnicianRequired(i ? i.technicianRequired : null);
    setNote(i?.note ?? '');
    setActive(i?.active ?? true);
    setSort(String(i?.sortOrder ?? 0));
    setError(null);
  }

  const careDefault = technicianRequired === null && isCareItem(category.trim(), name.trim());
  const needsTechnician = technicianRequired ?? careDefault;

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
        technicianRequired: needsTechnician,
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
        <Field
          label="需要技师"
          hint={
            careDefault
              ? '名称或分类含「护理」，默认需要技师（交给钟房派钟）；不需要的点「不需要」'
              : '技师功能开启后，挂这个项目要选技师与点钟 / 轮钟；也可以在后台「技师」里按分类勾选'
          }
        >
          <Segmented
            value={needsTechnician ? 'on' : 'off'}
            onChange={(v) => setTechnicianRequired(v === 'on')}
            ariaLabel="需要技师"
            options={[
              { value: 'off', label: '不需要' },
              { value: 'on', label: '需要技师' },
            ]}
          />
        </Field>
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
            if (f) {
              try {
                const loaded = await readImportFile(f);
                await load(loaded.label, loaded.text);
              } catch (err) {
                setError(errorMessage(err));
              }
            }
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

/** 门票票种（店主 #31：男女宾、普通柜与 VIP 柜统一一套票价，每 12 小时跳一档） */
function TicketTypesCard() {
  const types = useTicketTypes(true);
  const [editing, setEditing] = useState<TicketType | 'new' | null>(null);
  return (
    <Card className="p-5 lg:col-span-2" data-testid="ticket-types">
      <SectionTitle
        aside={
          <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            新增票种
          </Button>
        }
      >
        <span className="flex items-center gap-2">
          门票 <PendingBadge title="票价为店主 2026-10-27 #31 确认；1 米以下儿童免票、跳档宽限为默认做法，待确认" />
        </span>
      </SectionTitle>
      <p className="mt-1 text-[12.5px] text-ink-3">
        接待时为每位客人选票种，留存当时的票价；离店结账按在店时长计算：每 12 小时一段，票价 = 24 小时档 × 整天数 + 剩余半天时再加一个 12 小时档（例：499 → 599 → 1098 → 1198）。跳档宽限在「手牌 → 前台规则」设置。
      </p>
      {types.isPending ? (
        <Skeleton className="mt-3 h-24" />
      ) : (
        <ul className="mt-3 divide-y divide-line rounded-lg border border-line">
          {types.data?.map((t) => (
            <li key={t.id}>
              <button type="button" onClick={() => setEditing(t)} className={cn('flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-paper-2/60', !t.active && 'opacity-55')}>
                <span className="text-[14px] font-bold">{t.name}</span>
                {t.isDefault && <Badge tone="pine">接待默认</Badge>}
                {!t.active && <Badge tone="neutral">已停用</Badge>}
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-3">{t.note}</span>
                <span className="num text-[13px] text-ink-2">
                  {t.price12h || t.price24h ? (
                    <>
                      12 小时 <Money cents={t.price12h} className="font-bold" /> · 24 小时 <Money cents={t.price24h} className="font-bold" />
                    </>
                  ) : (
                    '免票'
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing && <TicketTypeDialog editing={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function TicketTypeDialog({ editing, onClose }: { editing: TicketType | 'new'; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const t = editing === 'new' ? null : editing;
  const [name, setName] = useState(t?.name ?? '');
  const [p12, setP12] = useState(t ? centsToInput(t.price12h) : '');
  const [p24, setP24] = useState(t ? centsToInput(t.price24h) : '');
  const [note, setNote] = useState(t?.note ?? '');
  const [active, setActive] = useState(t?.active ?? true);
  const [isDefault, setIsDefault] = useState(t?.isDefault ?? false);
  const [sort, setSort] = useState(String(t?.sortOrder ?? 50));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const c12 = parseYuan(p12 || '0');
  const c24 = parseYuan(p24 || '0');
  const problem = !name.trim() ? '请填写名称' : c12 === null || c24 === null ? '价格格式不正确' : c24 < c12 ? '24 小时档不能低于 12 小时档' : null;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), price12h: c12, price24h: c24, note: note.trim(), active, isDefault: active && isDefault, sortOrder: Number(sort) || 0 };
      if (t) await api.put(`/api/frontdesk/ticket-types/${t.id}`, body);
      else await api.post('/api/frontdesk/ticket-types', body);
      void qc.invalidateQueries({ queryKey: ['frontdesk', 'ticket-types'] });
      toast({ tone: 'success', title: `已保存票种「${body.name}」`, body: '改价只影响之后选定这一票种的客人' });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={busy ? () => {} : onClose}
      title={t ? `修改票种「${t.name}」` : '新增票种'}
      description="已在店的客人按接待时留存的票价结账，改价不影响他们"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" disabled={!!problem} loading={busy} onClick={() => void save()} data-testid="ticket-type-save">
            保存
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="名称" className="sm:col-span-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} aria-label="票种名称" />
        </Field>
        <Field label="12 小时档（元）" hint="免票填 0">
          <MoneyInput value={p12} onChange={(e) => setP12(e.target.value)} aria-label="12 小时档价格" />
        </Field>
        <Field label="24 小时档（元）">
          <MoneyInput value={p24} onChange={(e) => setP24(e.target.value)} aria-label="24 小时档价格" />
        </Field>
        <Field label="说明（选填）" className="sm:col-span-2">
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={100} aria-label="说明" />
        </Field>
        <Field label="排序">
          <Input value={sort} onChange={(e) => setSort(e.target.value.replace(/\D/g, ''))} inputMode="numeric" className="num" aria-label="排序" />
        </Field>
      </div>
      <div className="mt-3 space-y-2">
        <ConfirmCheck checked={active} onChange={setActive}>
          启用
        </ConfirmCheck>
        <ConfirmCheck checked={isDefault && active} onChange={(v) => setIsDefault(v)}>
          接待时默认选中
        </ConfirmCheck>
      </div>
      {problem && <p className="mt-2 text-[13px] text-clay">{problem}</p>}
      {error && <Notice tone="error" title={error} className="mt-3" />}
    </Dialog>
  );
}
