import { SUPPLIER_SETTLEMENT_LABELS, type SupplierSettlement } from '@shared/expenses';
import { useState } from 'react';
import { Plus, Search } from 'lucide-react';
import type { Department, Material, Supplier } from '@shared/inventory';
import { centsToInput, formatAmount, parseYuan } from '@shared/money';
import { conversionText, formatQty, parseQty } from '@shared/quantity';
import { api, errorMessage } from '../../lib/api';
import { useCan } from '../../lib/session';
import { cn } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Field, Input, MoneyInput, Notice, Segmented, Select, Skeleton } from '../../components/ui';
import { SimRule } from './parts';
import { useDepartments, useInvalidateInventory, useMaterials, useSuppliers } from './queries';

type Section = 'materials' | 'suppliers' | 'departments';

export function MasterTab() {
  const can = useCan();
  const [section, setSection] = useState<Section>('materials');
  const editable = can('inventory.master');
  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-5 py-3 md:px-7">
        <Segmented<Section>
          size="sm"
          value={section}
          onChange={setSection}
          ariaLabel="档案"
          options={[
            { value: 'materials', label: '物料' },
            { value: 'suppliers', label: '供应商' },
            { value: 'departments', label: '部门' },
          ]}
        />
        <p className="text-[12.5px] text-ink-3">档案停用而不删除，历史单据始终可追溯。{!editable && '维护档案需要采购经办职责。'}</p>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4 md:px-7">
        {section === 'materials' && <Materials editable={editable} />}
        {section === 'suppliers' && <Suppliers editable={editable} />}
        {section === 'departments' && <Departments editable={editable} />}
      </div>
    </>
  );
}

// ───────────────────────── 物料 ─────────────────────────

function Materials({ editable }: { editable: boolean }) {
  const materials = useMaterials(true);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Material | 'new' | null>(null);
  const list = (materials.data ?? []).filter((m) => !q.trim() || `${m.code} ${m.name} ${m.specification} ${m.category}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1 md:max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="编码 / 名称 / 规格 / 分类" aria-label="搜索物料档案" className="h-9 w-full rounded-md border border-line-strong bg-card pr-3 pl-9 text-[13px] outline-none focus:border-pine" />
        </div>
        <span className="flex-1" />
        {editable && (
          <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            新增物料
          </Button>
        )}
      </div>
      {materials.isPending ? (
        <Skeleton className="h-64" />
      ) : materials.error ? (
        <Notice tone="error" title={errorMessage(materials.error)} />
      ) : list.length === 0 ? (
        <EmptyState art="leaf" title="还没有物料档案" description="先建立首批试点物料：明确名称、规格、库存单位与采购包装换算。" className="rounded-lg border border-dashed border-line-strong" />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-card shadow-card">
          <table className="w-full min-w-[860px] text-left text-[13px]">
            <thead className="bg-paper-2/70 text-[12px] font-bold text-ink-3">
              <tr>
                <th className="w-[64px] px-4 py-2.5">编码</th>
                <th className="px-2 py-2.5">名称与规格</th>
                <th className="w-[80px] px-2 py-2.5">分类</th>
                <th className="w-[150px] px-2 py-2.5">包装换算</th>
                <th className="w-[110px] px-2 py-2.5 text-right">参考价</th>
                <th className="w-[100px] px-2 py-2.5 text-right">提醒线</th>
                <th className="w-[110px] px-4 py-2.5">状态</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/70">
              {list.map((m) => (
                <tr key={m.id} onClick={editable ? () => setEditing(m) : undefined} className={cn(editable && 'cursor-pointer hover:bg-pine-tint/50', !m.active && 'opacity-55')}>
                  <td className="num px-4 py-2.5 font-semibold text-ink-3">{m.code}</td>
                  <td className="px-2 py-2.5">
                    <p className="font-bold">{m.name}</p>
                    <p className="text-[12px] text-ink-3">{m.specification || '—'}</p>
                  </td>
                  <td className="px-2 py-2.5 text-ink-2">{m.category || '—'}</td>
                  <td className="num px-2 py-2.5 text-ink-2">{conversionText(m.purchaseUnit, m.purchaseFactorMilli, m.inventoryUnit)}</td>
                  <td className="num px-2 py-2.5 text-right">{m.refPriceCents !== null ? `¥${formatAmount(m.refPriceCents)}/${m.purchaseUnit}` : <span className="text-ink-4">—</span>}</td>
                  <td className="num px-2 py-2.5 text-right">{m.lowStockMilli !== null ? `${formatQty(m.lowStockMilli)} ${m.inventoryUnit}` : <span className="text-ink-4">—</span>}</td>
                  <td className="px-4 py-2.5">
                    <span className="flex flex-wrap gap-1">
                      {!m.tracked ? <Badge tone="lake">候选</Badge> : m.active ? <Badge tone="pine">受管</Badge> : <Badge>已停用</Badge>}
                      {m.isSynthetic && <Badge tone="ember">合成</Badge>}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <MaterialDialog editing={editing} onClose={() => setEditing(null)} />
    </>
  );
}

/** 物料档案的新增 / 编辑。转采购单时（v0.7.8）新产品在这里建档：initial 带入需求单的名称与规格，onSaved 拿到新物料 */
export function MaterialDialog({
  editing,
  onClose,
  initial,
  onSaved,
}: {
  editing: Material | 'new' | null;
  onClose: () => void;
  initial?: Partial<Pick<ReturnType<typeof toForm>, 'name' | 'specification' | 'inventoryUnit' | 'purchaseUnit' | 'supplierId'>>;
  onSaved?: (m: Material) => void;
}) {
  const toast = useToast();
  const invalidate = useInvalidateInventory();
  const suppliers = useSuppliers();
  const [form, setForm] = useState(() => toForm(null));
  const [last, setLast] = useState<typeof editing>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (editing !== last) {
    setLast(editing);
    setForm(editing === 'new' ? { ...toForm(null), ...initial } : toForm(editing));
    setError(null);
  }
  const m = editing && editing !== 'new' ? editing : null;
  const unitLocked = !!m?.hasMoves;
  const set = (p: Partial<typeof form>) => setForm((f) => ({ ...f, ...p }));
  const decimals = Number(form.decimals);
  const factor = parseQty(form.factor, decimals);
  const low = form.low.trim() ? parseQty(form.low, decimals) : null;
  const price = form.price.trim() ? parseYuan(form.price) : null;

  const save = async () => {
    if (!form.code.trim() || !form.name.trim()) return setError('请填写物料编码和名称');
    if (!form.inventoryUnit.trim() || !form.purchaseUnit.trim()) return setError('请填写库存单位和采购单位');
    // 采购单位与库存单位相同时换算固定为 1（输入框显示 1、不可改）
    const sameUnits = form.purchaseUnit.trim() === form.inventoryUnit.trim();
    if (!sameUnits && !factor) return setError(`换算数量格式不正确（最多 ${decimals} 位小数）`);
    if (form.low.trim() && low === null) return setError('提醒线格式不正确');
    if (form.price.trim() && price === null) return setError('参考价格式不正确');
    const body = {
      code: form.code.trim(),
      name: form.name.trim(),
      category: form.category.trim(),
      specification: form.specification.trim(),
      inventoryUnit: form.inventoryUnit.trim(),
      decimals,
      purchaseUnit: form.purchaseUnit.trim(),
      purchaseFactorMilli: sameUnits ? 1000 : factor,
      refPriceCents: price,
      defaultSupplierId: Number(form.supplierId) || null,
      lowStockMilli: low,
      tracked: form.tracked,
      active: form.active,
      note: form.note.trim(),
    };
    setSaving(true);
    setError(null);
    try {
      const saved = m ? await api.put<Material>(`/api/inventory/materials/${m.id}`, body) : await api.post<Material>('/api/inventory/materials', body);
      await invalidate();
      toast({ tone: 'success', title: '物料档案已保存', body: body.name });
      onSaved?.(saved);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const same = form.purchaseUnit.trim() !== '' && form.purchaseUnit.trim() === form.inventoryUnit.trim();
  return (
    <Dialog
      open={!!editing}
      onClose={onClose}
      width="max-w-2xl"
      title={m ? `编辑物料 · ${m.name}` : '新增物料'}
      description="相似名称、不同规格的物资请分开建档，不能直接合并比价。"
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
      <div className="grid gap-4 sm:grid-cols-6">
        <Field label="编码" htmlFor="m-code" className="sm:col-span-2">
          <Input id="m-code" value={form.code} maxLength={16} onChange={(e) => set({ code: e.target.value })} data-autofocus />
        </Field>
        <Field label="名称" htmlFor="m-name" className="sm:col-span-4">
          <Input id="m-name" value={form.name} maxLength={40} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="规格" htmlFor="m-spec" className="sm:col-span-4" hint="如 500ml × 24 瓶 / 均码独立包装">
          <Input id="m-spec" value={form.specification} maxLength={80} onChange={(e) => set({ specification: e.target.value })} />
        </Field>
        <Field label="分类" htmlFor="m-cat" className="sm:col-span-2">
          <Input id="m-cat" value={form.category} maxLength={16} onChange={(e) => set({ category: e.target.value })} placeholder="如 客用品" />
        </Field>

        <div className="rounded-lg border border-line bg-paper-2/50 p-4 sm:col-span-6">
          <p className="mb-3 text-[13px] font-bold text-ink-2">单位与换算</p>
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="库存单位" htmlFor="m-unit" hint={unitLocked ? '已有流水，不能修改' : '按实际可盘点的颗粒度'}>
              <Input id="m-unit" value={form.inventoryUnit} maxLength={8} disabled={unitLocked} onChange={(e) => set({ inventoryUnit: e.target.value })} placeholder="双 / 瓶 / 卷" />
            </Field>
            <Field label="小数位" htmlFor="m-dec" hint={unitLocked ? '已有流水，不能修改' : '称重类可用小数'}>
              <Select id="m-dec" value={form.decimals} disabled={unitLocked} onChange={(e) => set({ decimals: e.target.value })}>
                <option value="0">整数</option>
                <option value="1">1 位</option>
                <option value="2">2 位</option>
                <option value="3">3 位</option>
              </Select>
            </Field>
            <Field label="采购单位" htmlFor="m-punit">
              <Input id="m-punit" value={form.purchaseUnit} maxLength={8} onChange={(e) => set({ purchaseUnit: e.target.value })} placeholder="箱 / 提 / 桶" />
            </Field>
            <Field label={`1 ${form.purchaseUnit || '采购单位'} =`} htmlFor="m-factor" hint={same ? '与库存单位相同' : form.inventoryUnit || '库存单位'}>
              <Input id="m-factor" value={same ? '1' : form.factor} disabled={same} inputMode="decimal" onChange={(e) => set({ factor: e.target.value })} className="num text-right" />
            </Field>
          </div>
          {factor && !same && (
            <p className="mt-2 text-[12.5px] font-semibold text-pine">{conversionText(form.purchaseUnit, factor, form.inventoryUnit)} · 换算随每张单据留存，以后改包装不会改写历史数量</p>
          )}
        </div>

        <Field label={`参考价（元/${form.purchaseUnit || '采购单位'}）`} htmlFor="m-price" className="sm:col-span-2">
          <MoneyInput id="m-price" value={form.price} onChange={(e) => set({ price: e.target.value })} />
        </Field>
        <Field label="常用供应商" htmlFor="m-sup" className="sm:col-span-2">
          <Select id="m-sup" value={form.supplierId} onChange={(e) => set({ supplierId: e.target.value })}>
            <option value="">不指定</option>
            {suppliers.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={<span className="flex items-center gap-1.5">低库存提醒线 <SimRule>人工设定</SimRule></span>} htmlFor="m-low" className="sm:col-span-2" hint={`低于此数提醒（${form.inventoryUnit || '库存单位'}），留空不提醒`}>
          <Input id="m-low" value={form.low} inputMode="decimal" onChange={(e) => set({ low: e.target.value })} className="num text-right" />
        </Field>

        <Field label="纳入库存" className="sm:col-span-3" hint="候选物料只保留档案，不进入首轮库存">
          <Segmented
            value={form.tracked ? 'on' : 'off'}
            onChange={(v) => set({ tracked: v === 'on' })}
            className="w-full"
            options={[
              { value: 'on', label: '受管物料' },
              { value: 'off', label: '候选（暂不管）', disabled: unitLocked },
            ]}
          />
        </Field>
        <Field label="状态" className="sm:col-span-3">
          <Segmented
            value={form.active ? 'on' : 'off'}
            onChange={(v) => set({ active: v === 'on' })}
            className="w-full"
            options={[
              { value: 'on', label: '启用' },
              { value: 'off', label: '停用' },
            ]}
          />
        </Field>
        <Field label="备注" htmlFor="m-note" className="sm:col-span-6">
          <Input id="m-note" value={form.note} maxLength={200} onChange={(e) => set({ note: e.target.value })} />
        </Field>
        {error && <Notice tone="error" title={error} className="sm:col-span-6" />}
      </div>
    </Dialog>
  );
}

function toForm(m: Material | null) {
  return {
    code: m?.code ?? '',
    name: m?.name ?? '',
    category: m?.category ?? '',
    specification: m?.specification ?? '',
    inventoryUnit: m?.inventoryUnit ?? '',
    decimals: String(m?.decimals ?? 0),
    purchaseUnit: m?.purchaseUnit ?? '',
    factor: m ? formatQty(m.purchaseFactorMilli).replace(/,/g, '') : '',
    price: m?.refPriceCents != null ? centsToInput(m.refPriceCents) : '',
    supplierId: m?.defaultSupplierId ? String(m.defaultSupplierId) : '',
    low: m?.lowStockMilli != null ? formatQty(m.lowStockMilli).replace(/,/g, '') : '',
    tracked: m?.tracked ?? true,
    active: m?.active ?? true,
    note: m?.note ?? '',
  };
}

// ───────────────────────── 供应商 ─────────────────────────

function Suppliers({ editable }: { editable: boolean }) {
  const suppliers = useSuppliers(true);
  const [editing, setEditing] = useState<Supplier | 'new' | null>(null);
  return (
    <>
      <div className="mb-3 flex justify-end">
        {editable && (
          <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            新增供应商
          </Button>
        )}
      </div>
      {suppliers.isPending ? (
        <Skeleton className="h-48" />
      ) : suppliers.data?.length === 0 ? (
        <EmptyState art="leaf" title="还没有供应商" className="rounded-lg border border-dashed border-line-strong" />
      ) : (
        <ul className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-3">
          {suppliers.data?.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                disabled={!editable}
                onClick={() => setEditing(s)}
                className={cn('w-full rounded-lg border border-line bg-card px-4 py-3 text-left shadow-card transition-colors enabled:hover:border-line-strong', !s.active && 'opacity-55')}
              >
                <p className="flex items-center gap-2">
                  <span className="num text-[12px] font-semibold text-ink-3">{s.code}</span>
                  <span className="truncate text-[14px] font-bold">{s.name}</span>
                  {s.settlement === 'cash' && <Badge tone="lake">现付</Badge>}
                  {!s.active && <Badge>已停用</Badge>}
                  {s.isSynthetic && <Badge tone="ember">合成</Badge>}
                </p>
                <p className="mt-0.5 truncate text-[12.5px] text-ink-3">{[s.contact, s.phone].filter(Boolean).join(' · ') || '未填写联系人'}</p>
                {s.note && <p className="truncate text-[12px] text-ink-3">{s.note}</p>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <SupplierDialog editing={editing} onClose={() => setEditing(null)} />
    </>
  );
}

function SupplierDialog({ editing, onClose }: { editing: Supplier | 'new' | null; onClose: () => void }) {
  const toast = useToast();
  const invalidate = useInvalidateInventory();
  const blank = { code: '', name: '', contact: '', phone: '', note: '', settlement: 'credit' as SupplierSettlement, active: true };
  const [form, setForm] = useState(blank);
  const [last, setLast] = useState<typeof editing>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (editing !== last) {
    setLast(editing);
    setForm(
      editing && editing !== 'new'
        ? { code: editing.code, name: editing.name, contact: editing.contact, phone: editing.phone, note: editing.note, settlement: editing.settlement, active: editing.active }
        : blank,
    );
    setError(null);
  }
  const s = editing && editing !== 'new' ? editing : null;
  const save = async () => {
    if (!form.code.trim() || !form.name.trim()) return setError('请填写供应商编码和名称');
    setSaving(true);
    setError(null);
    try {
      if (s) await api.put(`/api/inventory/suppliers/${s.id}`, form);
      else await api.post('/api/inventory/suppliers', form);
      await invalidate();
      toast({ tone: 'success', title: '供应商已保存' });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open={!!editing}
      onClose={onClose}
      title={s ? `编辑供应商 · ${s.name}` : '新增供应商'}
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
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="编码" htmlFor="s-code">
          <Input id="s-code" value={form.code} maxLength={16} onChange={(e) => setForm({ ...form, code: e.target.value })} data-autofocus />
        </Field>
        <Field label="名称" htmlFor="s-name" className="sm:col-span-2">
          <Input id="s-name" value={form.name} maxLength={40} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="联系人" htmlFor="s-contact">
          <Input id="s-contact" value={form.contact} maxLength={40} onChange={(e) => setForm({ ...form, contact: e.target.value })} />
        </Field>
        <Field label="电话" htmlFor="s-phone" className="sm:col-span-2">
          <Input id="s-phone" value={form.phone} maxLength={32} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </Field>
        <Field label="备注" htmlFor="s-note" className="sm:col-span-3" hint="如 含税到货价、结算周期（待确认）">
          <Input id="s-note" value={form.note} maxLength={200} onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </Field>
        <Field label="结算方式" className="sm:col-span-3" hint={SUPPLIER_SETTLEMENT_LABELS[form.settlement].hint}>
          <Segmented
            ariaLabel="结算方式"
            value={form.settlement}
            onChange={(v) => setForm({ ...form, settlement: v })}
            className="w-full"
            options={(['credit', 'cash'] as const).map((v) => ({ value: v, label: SUPPLIER_SETTLEMENT_LABELS[v].title }))}
          />
        </Field>
        <Field label="状态" className="sm:col-span-3">
          <Segmented
            value={form.active ? 'on' : 'off'}
            onChange={(v) => setForm({ ...form, active: v === 'on' })}
            className="w-full"
            options={[
              { value: 'on', label: '启用' },
              { value: 'off', label: '停用' },
            ]}
          />
        </Field>
        {error && <Notice tone="error" title={error} className="sm:col-span-3" />}
      </div>
    </Dialog>
  );
}

// ───────────────────────── 部门 ─────────────────────────

function Departments({ editable }: { editable: boolean }) {
  const departments = useDepartments(true);
  const toast = useToast();
  const invalidate = useInvalidateInventory();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (d: Department | null, body: { name: string; active: boolean; sortOrder: number }) => {
    setBusy(true);
    try {
      if (d) await api.put(`/api/inventory/departments/${d.id}`, body);
      else await api.post('/api/inventory/departments', body);
      await invalidate();
      if (!d) setName('');
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="max-w-xl">
      <p className="mb-3 text-[12.5px] text-ink-3">每个部门有一个小仓（新建部门时自动建）：仓库登记领料进部门小仓，部门在「本部门小仓」签收、耗用、盘点。停用部门前要先把它的小仓清空（退回总仓或盘点到 0）。</p>
      <ul className="divide-y divide-line/70 rounded-lg border border-line bg-card shadow-card">
        {departments.data?.map((d) => (
          <li key={d.id} className={cn('flex items-center gap-3 px-4 py-2.5', !d.active && 'opacity-55')}>
            <span className="flex-1 text-[14px] font-semibold">{d.name}</span>
            {!d.active && <Badge>已停用</Badge>}
            {editable && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => save(d, { name: d.name, active: !d.active, sortOrder: d.sortOrder })}>
                {d.active ? '停用' : '启用'}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {editable && (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void save(null, { name: name.trim(), active: true, sortOrder: (departments.data?.length ?? 0) + 1 });
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={16} placeholder="新部门名称" aria-label="新部门名称" className="h-10" />
          <Button type="submit" variant="secondary" loading={busy} icon={<Plus className="size-4" />}>
            添加
          </Button>
        </form>
      )}
    </div>
  );
}
