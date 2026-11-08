// 赠品入库台账（8.0.1 采购组整改 09，CG09，docs/PURCHASING_V801.md）：「库存 → 赠品台账」。
// 登记赠品名称（可以从物料里选）、数量与单位、哪家供应商、随哪张收货单（选填）、日期、备注；可以作废（写原因）、导出 CSV。
// 只记台账，不进库存结存、不记成本。仓库、采购登记；有查看库存的人都能看。登记带操作编号：断网时按同一编号重提只记一次。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Gift, Plus } from 'lucide-react';
import type { GiftReceipt } from '@shared/inventory';
import { formatQty, parseQty } from '@shared/quantity';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn, formatDateTime, uuid } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { Dialog } from '../../components/Overlay';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, Field, Input, Notice, Select, Skeleton } from '../../components/ui';
import { useMaterials, useSuppliers } from './queries';

const giftsKey = (from: string, to: string) => ['inv', 'gifts', from, to] as const;

export function GiftsTab() {
  const can = useCan();
  const session = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [from, setFrom] = useState(`${session.calendarToday.slice(0, 8)}01`);
  const [to, setTo] = useState(session.calendarToday);
  const gifts = useQuery({ queryKey: giftsKey(from, to), queryFn: () => api.get<GiftReceipt[]>(`/api/inventory/gifts?from=${from}&to=${to}`), enabled: !!from && !!to });
  const [creating, setCreating] = useState(false);
  const [voiding, setVoiding] = useState<GiftReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const canWrite = can('inventory.operate') || can('purchase.manage');
  const refresh = () => qc.invalidateQueries({ queryKey: ['inv', 'gifts'] });

  const doVoid = async (reason: string) => {
    if (!voiding) return;
    setBusy(true);
    try {
      await api.post(`/api/inventory/gifts/${voiding.id}/void`, { reason });
      toast({ tone: 'success', title: '已作废', body: voiding.docNo });
      setVoiding(null);
      await refresh();
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const rows = gifts.data ?? [];
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4 md:px-7" data-testid="gifts-tab">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-3">
          收到日期
          <Input type="date" fullWidth={false} value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="h-9 w-36" aria-label="从" />
          到
          <Input type="date" fullWidth={false} value={to} min={from} max={session.calendarToday} onChange={(e) => setTo(e.target.value)} className="h-9 w-36" aria-label="到" />
        </label>
        <span className="text-[12.5px] text-ink-3">只记台账，不进库存结存、不记成本</span>
        <span className="ml-auto flex gap-2">
          <a href={`/api/inventory/gifts/export?from=${from}&to=${to}`} download data-testid="gifts-export">
            <Button size="sm" variant="secondary" icon={<Download className="size-4" />}>
              导出 CSV
            </Button>
          </a>
          {canWrite && (
            <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)} data-testid="gift-new">
              登记赠品
            </Button>
          )}
        </span>
      </div>
      {gifts.error ? (
        <Notice tone="error" title={errorMessage(gifts.error)} />
      ) : gifts.isPending ? (
        <Skeleton className="h-48" />
      ) : rows.length === 0 ? (
        <EmptyState art="leaf" title="这段时间没有登记赠品" description={canWrite ? '供应商随货送的东西，点「登记赠品」记下来。' : undefined} className="rounded-lg border border-dashed border-line-strong" />
      ) : (
        <ul className="overflow-hidden rounded-lg border border-line bg-card shadow-card" data-testid="gifts-list">
          {rows.map((g) => (
            <li key={g.id} className={cn('grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-b border-line/70 px-4 py-2.5 last:border-0 md:grid-cols-[150px_minmax(0,1fr)_120px_auto]', g.status === 'voided' && 'opacity-60')}>
              <span className="num text-[13.5px] font-bold">
                {g.docNo}
                <span className="block font-sans text-[12px] font-medium text-ink-3">{g.receivedOn}</span>
              </span>
              <span className="min-w-0 text-[12.5px]">
                <span className="flex items-center gap-1.5 text-[13.5px] font-semibold">
                  <Gift className="size-4 text-yuzu-deep" />
                  <span className="truncate">{g.name}</span>
                  {g.material && <span className="text-[12px] font-normal text-ink-3">物料 {g.material.code}</span>}
                </span>
                <span className="block truncate text-ink-3">
                  {g.supplier?.name ?? '没填供应商'}
                  {g.receipt && ` · 随 ${g.receipt.docNo}`}
                  {g.note && ` · ${g.note}`} · {g.createdByName} 登记 {formatDateTime(g.createdAt)}
                </span>
                {g.status === 'voided' && <span className="block text-clay">已作废：{g.voidReason}</span>}
              </span>
              <span className="num text-right text-[14px] font-bold">
                {formatQty(g.qtyMilli)} {g.unit}
              </span>
              <span className="flex justify-end">
                {g.status === 'voided' ? (
                  <Badge>已作废</Badge>
                ) : (
                  canWrite && (
                    <Button size="sm" variant="ghost" onClick={() => setVoiding(g)}>
                      作废
                    </Button>
                  )
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <GiftDialog open={creating} onClose={() => setCreating(false)} onDone={refresh} />
      <ReasonDialog
        open={!!voiding}
        title="作废赠品登记"
        description="作废以后记录还在，只是不算了。"
        confirmLabel="作废"
        busy={busy}
        onClose={() => setVoiding(null)}
        onConfirm={(reason) => void doVoid(reason)}
      />
    </div>
  );
}

function GiftDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => unknown }) {
  const session = useSession();
  const toast = useToast();
  const materials = useMaterials(false, open);
  const suppliers = useSuppliers(false, open);
  const blank = () => ({ clientKey: uuid(), receivedOn: session.calendarToday, materialId: '', name: '', qty: '', unit: '', supplierId: '', note: '' });
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<ReturnType<typeof blank>>) => setForm((f) => ({ ...f, ...patch }));
  const pickMaterial = (value: string) => {
    const m = materials.data?.find((x) => String(x.id) === value);
    set({ materialId: value, ...(m ? { name: m.name, unit: m.inventoryUnit } : {}) });
  };
  const save = async () => {
    const qty = parseQty(form.qty, 3);
    if (!form.name.trim()) return setError('请写赠品名称');
    if (qty === null || qty <= 0) return setError('请写数量');
    if (!form.unit.trim()) return setError('请写单位');
    setBusy(true);
    setError(null);
    try {
      // 同一个操作编号重提只记一次：没收到结果时再点一次「登记」不会记两条
      await api.post('/api/inventory/gifts', {
        clientKey: form.clientKey,
        receivedOn: form.receivedOn,
        materialId: form.materialId ? Number(form.materialId) : null,
        name: form.name.trim(),
        qtyMilli: qty,
        unit: form.unit.trim(),
        supplierId: form.supplierId ? Number(form.supplierId) : null,
        note: form.note.trim(),
      });
      toast({ tone: 'success', title: '赠品已登记', body: form.name.trim() });
      setForm(blank());
      await onDone();
      onClose();
    } catch (e) {
      setError(e instanceof UncertainError ? '网络不稳，结果待确认：请再点一次「登记」（同一笔只会记一次）' : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="登记赠品"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void save()} data-testid="gift-save">
            登记
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="从物料里选（选填）" htmlFor="g-mat" className="sm:col-span-2">
          <Select id="g-mat" value={form.materialId} onChange={(e) => pickMaterial(e.target.value)} data-testid="gift-material">
            <option value="">不是物料档案里的东西</option>
            {materials.data?.map((m) => (
              <option key={m.id} value={m.id}>
                {m.code} · {m.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="赠品名称" htmlFor="g-name">
          <Input id="g-name" value={form.name} maxLength={40} onChange={(e) => set({ name: e.target.value })} data-testid="gift-name" />
        </Field>
        <Field label="收到日期" htmlFor="g-date">
          <Input id="g-date" type="date" value={form.receivedOn} max={session.calendarToday} onChange={(e) => set({ receivedOn: e.target.value })} />
        </Field>
        <Field label="数量" htmlFor="g-qty">
          <Input id="g-qty" inputMode="decimal" value={form.qty} onChange={(e) => set({ qty: e.target.value })} data-testid="gift-qty" />
        </Field>
        <Field label="单位" htmlFor="g-unit">
          <Input id="g-unit" value={form.unit} maxLength={8} onChange={(e) => set({ unit: e.target.value })} data-testid="gift-unit" />
        </Field>
        <Field label="供应商（选填）" htmlFor="g-sup" className="sm:col-span-2">
          <Select id="g-sup" value={form.supplierId} onChange={(e) => set({ supplierId: e.target.value })}>
            <option value="">不填</option>
            {suppliers.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code} · {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="备注" htmlFor="g-note" className="sm:col-span-2">
          <Input id="g-note" value={form.note} maxLength={200} onChange={(e) => set({ note: e.target.value })} placeholder="例如：满 20 箱送 2 箱" />
        </Field>
        {error && <Notice tone="error" title={error} className="sm:col-span-2" />}
      </div>
    </Dialog>
  );
}
