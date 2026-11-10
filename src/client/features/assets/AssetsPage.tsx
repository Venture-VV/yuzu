// ERP「资产与易耗」（8.0.7 ERP P2 3.2）：资产卡片（固定资产、低值易耗）——从收货单转资产建卡或手工建（期初），
// 调拨、改状态、报废都留变动记录；勾选几张打印标签（二维码 = 资产编号）；扫码盘点（扫码枪或手机扫、也能手输编号），
// 结束时列出没扫到的（盘亏）与不在范围里的。盘点结果只记录，不自动改卡片。

import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate } from 'react-router';
import { Plus, Printer, ScanLine } from 'lucide-react';
import { ASSET_CATEGORIES, ASSET_CATEGORY_LABELS, ASSET_STATUS_LABELS, ASSET_STATUSES, type AssetCard, type AssetCategory, type AssetDetail, type AssetReceiptLine, type AssetStatus, type AssetStocktake } from '@shared/assets';
import { centsToInput, formatYuan, parseYuan } from '@shared/money';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, useErpPending } from '../../lib/erpPending';
import { useCan, useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { cn, formatDateTime, uuid } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, MoneyInput, Notice, Segmented, Select, Skeleton } from '../../components/ui';
import { ErpPage } from '../erp/ErpHome';
import { useDepartments } from '../inventory/queries';

const KEY = ['erp', 'assets'] as const;
type Tab = 'cards' | 'stocktake';
const STATUS_TONES: Record<AssetStatus, 'pine' | 'neutral' | 'yuzu' | 'clay'> = { in_use: 'pine', idle: 'neutral', repair: 'yuzu', scrapped: 'clay' };

export function AssetsPage() {
  const can = useCan();
  const [tab, setTab] = useState<Tab>('cards');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<AssetStatus | ''>('');
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const qs = new URLSearchParams(Object.entries({ q, status }).filter(([, v]) => v) as [string, string][]).toString();
  const cards = useQuery({ queryKey: [...KEY, 'list', qs], queryFn: () => api.get<AssetCard[]>(`/api/erp/assets?${qs}`) });
  if (!can('asset.read')) return <Navigate to="/erp" replace />;
  const manage = can('asset.manage');
  const toggle = (id: number) => setPicked((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
  return (
    <ErpPage
      title="资产与易耗"
      description="资产卡片：从收货单转资产建卡（一件一张）或手工建；调拨、改状态、报废都留记录。打印标签贴在资产上，盘点时扫码。"
      actions={
        <span className="flex flex-wrap gap-2">
          {picked.size > 0 && (
            <Button variant="secondary" icon={<Printer className="size-4" />} onClick={() => window.open(`/print/asset-labels/${[...picked].join(',')}`, '_blank')} data-testid="asset-print">
              打印标签（{picked.size}）
            </Button>
          )}
          {manage && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)} data-testid="asset-new">
              建卡
            </Button>
          )}
        </span>
      }
    >
      <div className="space-y-4" data-testid="assets-page">
        {manage && <ErpPendingPanel types={['asset_card', 'asset_stocktake']} />}
        <Segmented<Tab>
          ariaLabel="资产与易耗"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'cards', label: '资产卡片' },
            { value: 'stocktake', label: '扫码盘点' },
          ]}
        />
        {tab === 'cards' ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Input fullWidth={false} value={q} onChange={(e) => setQ(e.target.value)} placeholder="编号、名称、保管人" className="h-9 w-56" aria-label="搜索资产" />
              <Select fullWidth={false} value={status} onChange={(e) => setStatus(e.target.value as AssetStatus | '')} className="h-9 w-32 text-[13px]" aria-label="状态">
                <option value="">全部状态</option>
                {ASSET_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {ASSET_STATUS_LABELS[s]}
                  </option>
                ))}
              </Select>
            </div>
            {cards.error ? (
              <Notice tone="error" title={errorMessage(cards.error)} />
            ) : cards.isPending ? (
              <Skeleton className="h-48" />
            ) : cards.data.length === 0 ? (
              <EmptyState art="leaf" title="还没有资产卡片" description={manage ? '点「建卡」：手工建（期初）或从收货单的某一行转过来。' : undefined} className="rounded-lg border border-dashed border-line-strong" />
            ) : (
              <div className="overflow-x-auto rounded-lg border border-line bg-card">
                <table className="w-full min-w-[760px] text-[13px]" data-testid="asset-table">
                  <thead className="bg-paper-2 text-left text-[12px] text-ink-3">
                    <tr>
                      <th className="w-8 px-3 py-2" />
                      <th className="px-3 py-2 font-semibold">编号</th>
                      <th className="px-3 py-2 font-semibold">名称</th>
                      <th className="px-3 py-2 font-semibold">部门 · 位置 · 保管人</th>
                      <th className="px-3 py-2 text-right font-semibold">原值</th>
                      <th className="px-3 py-2 font-semibold">状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cards.data.map((c) => (
                      <tr key={c.id} className={cn('border-t border-line', c.status === 'scrapped' && 'opacity-55')}>
                        <td className="px-3 py-1.5">
                          <input type="checkbox" className="size-4 accent-[var(--color-pine)]" checked={picked.has(c.id)} onChange={() => toggle(c.id)} aria-label={`选 ${c.assetNo}`} />
                        </td>
                        <td className="px-3 py-1.5">
                          <button type="button" className="num font-semibold text-lake hover:underline" onClick={() => setOpenId(c.id)}>
                            {c.assetNo}
                          </button>
                        </td>
                        <td className="px-3 py-1.5">
                          {c.name}
                          <span className="ml-1.5 text-[12px] text-ink-3">{ASSET_CATEGORY_LABELS[c.category]}</span>
                        </td>
                        <td className="px-3 py-1.5 text-ink-2">{[c.departmentName, c.location, c.keeper].filter(Boolean).join(' · ') || '—'}</td>
                        <td className="px-3 py-1.5 text-right">
                          <Money cents={c.originalCents} />
                        </td>
                        <td className="px-3 py-1.5">
                          <Badge tone={STATUS_TONES[c.status]}>{ASSET_STATUS_LABELS[c.status]}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : (
          <StocktakeView manage={manage} />
        )}
      </div>
      <CreateDialog open={creating} onClose={() => setCreating(false)} />
      <AssetSheet id={openId} manage={manage} onClose={() => setOpenId(null)} />
    </ErpPage>
  );
}

function CreateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const session = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const departments = useDepartments(false, open);
  const [source, setSource] = useState<'manual' | 'receipt'>('manual');
  const [docNo, setDocNo] = useState('');
  const [lines, setLines] = useState<AssetReceiptLine[] | null>(null);
  const [lineId, setLineId] = useState<number | null>(null);
  const [form, setForm] = useState({ name: '', category: 'fixed' as AssetCategory, departmentId: '', location: '', keeper: '', original: '', acquiredOn: '', quantity: '1', note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useErpPending(['asset_card']);
  useResetOnOpen(open, () => {
    setSource('manual');
    setDocNo('');
    setLines(null);
    setLineId(null);
    setForm({ name: '', category: 'fixed', departmentId: '', location: '', keeper: '', original: '', acquiredOn: session.calendarToday, quantity: '1', note: '' });
    setError(null);
  });
  const findLines = async () => {
    setError(null);
    try {
      const r = await api.get<AssetReceiptLine[]>(`/api/erp/assets/receipt-lines?docNo=${encodeURIComponent(docNo.trim())}`);
      setLines(r);
      if (r.length === 0) setError('没有找到这张收货单（要已生效的收货单）');
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const pickLine = (l: AssetReceiptLine) => {
    setLineId(l.lineId);
    setForm((f) => ({ ...f, name: l.materialName, original: centsToInput(l.unitCents), acquiredOn: l.docDate, quantity: String(Math.max(1, l.quantity - l.carded)) }));
  };
  const qty = Number(form.quantity);
  const original = parseYuan(form.original);
  const problem =
    pending.length > 0
      ? '上一次建卡结果待确认，请先在页面上方处理'
      : source === 'receipt' && !lineId
        ? '请先找到收货单、选一行'
        : !form.name.trim()
          ? '请填写名称'
          : original === null
            ? '请填写原值'
            : !Number.isInteger(qty) || qty < 1 || qty > 50
              ? '张数要在 1–50 之间'
              : null;
  const submit = async () => {
    if (problem || original === null) return;
    setBusy(true);
    setError(null);
    const body = {
      clientKey: uuid(),
      name: form.name.trim(),
      category: form.category,
      departmentId: Number(form.departmentId) || null,
      location: form.location.trim(),
      keeper: form.keeper.trim(),
      originalCents: original,
      acquiredOn: form.acquiredOn,
      quantity: qty,
      receiptLineId: source === 'receipt' ? lineId : null,
      note: form.note.trim(),
    };
    try {
      await sendErpOp({ key: body.clientKey, type: 'asset_card', url: '/api/erp/assets', body, summary: `建卡 ${body.name} × ${qty}`, staffName: session.staff.displayName });
      toast({ tone: 'success', title: `已建 ${qty} 张资产卡片`, body: body.name });
      onClose();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'error', title: '建卡没收到结果', body: '记在页面上方的「结果待确认」里，查回或按原内容重新提交' });
        onClose();
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
      await qc.invalidateQueries({ queryKey: KEY });
    }
  };
  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title="建资产卡片"
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!!problem} onClick={() => void submit()} data-testid="asset-create-confirm">
            建卡
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Segmented<'manual' | 'receipt'>
          ariaLabel="来源"
          value={source}
          onChange={setSource}
          options={[
            { value: 'manual', label: '手工建（期初）' },
            { value: 'receipt', label: '从收货单转' },
          ]}
        />
        {source === 'receipt' && (
          <div className="space-y-2 rounded-md bg-paper-2 p-2.5">
            <div className="flex gap-2">
              <Input value={docNo} onChange={(e) => setDocNo(e.target.value)} placeholder="收货单号，例如 RK20261110-0001" className="h-9" aria-label="收货单号" data-testid="asset-receipt-no" />
              <Button size="sm" variant="secondary" onClick={() => void findLines()}>
                找
              </Button>
            </div>
            {lines && lines.length > 0 && (
              <ul className="space-y-1">
                {lines.map((l) => (
                  <li key={l.lineId}>
                    <label className="flex items-center gap-2 text-[13px]">
                      <input type="radio" name="asset-line" checked={lineId === l.lineId} disabled={l.carded >= l.quantity} onChange={() => pickLine(l)} />
                      <span className="font-semibold">{l.materialName}</span>
                      <span className="text-ink-3">
                        收 {l.quantity} {l.inventoryUnit}，已建 {l.carded} 张 · 每件 {formatYuan(l.unitCents)}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="名称" htmlFor="as-name" className="sm:col-span-2">
            <Input id="as-name" value={form.name} maxLength={60} onChange={(e) => setForm({ ...form, name: e.target.value })} className="h-10" data-testid="asset-name" />
          </Field>
          <Field label="类别" htmlFor="as-cat">
            <Select id="as-cat" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as AssetCategory })} className="h-10">
              {ASSET_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {ASSET_CATEGORY_LABELS[c]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="使用部门" htmlFor="as-dept">
            <Select id="as-dept" value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })} className="h-10">
              <option value="">不分部门</option>
              {(departments.data ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="存放位置" htmlFor="as-loc">
            <Input id="as-loc" value={form.location} maxLength={60} onChange={(e) => setForm({ ...form, location: e.target.value })} className="h-10" />
          </Field>
          <Field label="保管人" htmlFor="as-keeper">
            <Input id="as-keeper" value={form.keeper} maxLength={20} onChange={(e) => setForm({ ...form, keeper: e.target.value })} className="h-10" />
          </Field>
          <Field label="每张原值（元）" htmlFor="as-orig">
            <MoneyInput id="as-orig" value={form.original} onChange={(e) => setForm({ ...form, original: e.target.value })} className="h-10" data-testid="asset-original" />
          </Field>
          <Field label="取得日期" htmlFor="as-date">
            <Input id="as-date" type="date" value={form.acquiredOn} max={session.calendarToday} onChange={(e) => setForm({ ...form, acquiredOn: e.target.value })} className="h-10" />
          </Field>
          <Field label="张数（一件一张）" htmlFor="as-qty">
            <Input id="as-qty" inputMode="numeric" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} className="h-10" data-testid="asset-qty" />
          </Field>
        </div>
        {problem && <p className="text-[12.5px] text-ink-3">{problem}</p>}
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}

function AssetSheet({ id, manage, onClose }: { id: number | null; manage: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const departments = useDepartments(false, id !== null);
  const detail = useQuery({ queryKey: [...KEY, 'one', id], queryFn: () => api.get<AssetDetail>(`/api/erp/assets/${id}`), enabled: id !== null });
  const [transfer, setTransfer] = useState<{ departmentId: string; location: string; keeper: string } | null>(null);
  const [scrapping, setScrapping] = useState(false);
  const a = detail.data;
  const change = async (body: Record<string, unknown>) => {
    if (!a) return;
    try {
      await api.post(`/api/erp/assets/${a.id}/change`, { ...body, expectedVersion: a.version });
      await qc.invalidateQueries({ queryKey: KEY });
      setTransfer(null);
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    }
  };
  return (
    <Dialog open={id !== null} onClose={onClose} title={a ? `${a.assetNo} · ${a.name}` : '资产卡片'} width="max-w-2xl" footer={null}>
      {detail.isPending ? (
        <Skeleton className="h-40" />
      ) : detail.error ? (
        <Notice tone="error" title={errorMessage(detail.error)} />
      ) : a ? (
        <div className="space-y-3 text-[13px]" data-testid="asset-detail">
          <p className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS_TONES[a.status]}>{ASSET_STATUS_LABELS[a.status]}</Badge>
            <span>{ASSET_CATEGORY_LABELS[a.category]}</span>
            <span>原值 {formatYuan(a.originalCents)}</span>
            <span>取得 {a.acquiredOn}</span>
            {a.receipt && <span className="text-ink-3">来自收货单 {a.receipt.docNo}</span>}
          </p>
          <p className="text-ink-2">{[a.departmentName ?? '不分部门', a.location, a.keeper].filter(Boolean).join(' · ')}</p>
          {manage && a.status !== 'scrapped' && (
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="secondary" onClick={() => setTransfer({ departmentId: a.departmentId ? String(a.departmentId) : '', location: a.location, keeper: a.keeper })}>
                调拨
              </Button>
              {(['in_use', 'idle', 'repair'] as const)
                .filter((s) => s !== a.status)
                .map((s) => (
                  <Button key={s} size="sm" variant="ghost" onClick={() => void change({ kind: 'status', status: s })}>
                    改成{ASSET_STATUS_LABELS[s]}
                  </Button>
                ))}
              <Button size="sm" variant="ghost" onClick={() => setScrapping(true)}>
                报废
              </Button>
            </div>
          )}
          {transfer && (
            <div className="grid gap-2 rounded-md bg-paper-2 p-2.5 sm:grid-cols-4">
              <Select value={transfer.departmentId} onChange={(e) => setTransfer({ ...transfer, departmentId: e.target.value })} className="h-9" aria-label="使用部门">
                <option value="">不分部门</option>
                {(departments.data ?? []).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
              <Input value={transfer.location} maxLength={60} onChange={(e) => setTransfer({ ...transfer, location: e.target.value })} placeholder="存放位置" className="h-9" />
              <Input value={transfer.keeper} maxLength={20} onChange={(e) => setTransfer({ ...transfer, keeper: e.target.value })} placeholder="保管人" className="h-9" />
              <Button size="sm" variant="primary" onClick={() => void change({ kind: 'transfer', departmentId: Number(transfer.departmentId) || null, location: transfer.location.trim(), keeper: transfer.keeper.trim() })}>
                保存调拨
              </Button>
            </div>
          )}
          <section>
            <h3 className="mb-1 text-[12.5px] font-bold text-ink-2">变动记录</h3>
            <ul className="space-y-1 text-[12.5px]">
              {a.changes.map((c) => (
                <li key={c.id} className="rounded-md border border-line px-2.5 py-1">
                  {c.kind === 'create' ? '建卡' : c.kind === 'transfer' ? '调拨' : c.kind === 'status' ? `改状态：${ASSET_STATUS_LABELS[(c.detail as { to: AssetStatus }).to] ?? ''}` : c.kind === 'scrap' ? '报废' : '修改'}
                  {c.reason ? ` · ${c.reason}` : ''}
                  <span className="ml-1.5 text-ink-3">
                    {c.createdByName} · {formatDateTime(c.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      ) : null}
      <ReasonDialog
        open={scrapping}
        title={a ? `报废 · ${a.assetNo}` : '报废'}
        description="报废以后卡片不能再改，记录保留。"
        confirmLabel="报废"
        danger
        onClose={() => setScrapping(false)}
        onConfirm={async (reason) => {
          await change({ kind: 'scrap', reason });
          setScrapping(false);
        }}
      />
    </Dialog>
  );
}

function StocktakeView({ manage }: { manage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const session = useSession();
  const departments = useDepartments(false, true);
  const list = useQuery({ queryKey: [...KEY, 'stocktakes'], queryFn: () => api.get<{ id: number; docNo: string; departmentName: string | null; status: string; startedAt: string; closedAt: string | null }[]>('/api/erp/assets/stocktakes') });
  const [openId, setOpenId] = useState<number | null>(null);
  const [dept, setDept] = useState('');
  const st = useQuery({ queryKey: [...KEY, 'stocktake', openId], queryFn: () => api.get<AssetStocktake>(`/api/erp/assets/stocktakes/${openId}`), enabled: openId !== null });
  const [code, setCode] = useState('');
  const input = useRef<HTMLInputElement>(null);
  // 带操作编号、走「结果待确认」（Codex 审查 0048165）：回复丢了不会多开一次，记在页面上方查回或按原内容重提
  const start = async () => {
    const body = { clientKey: uuid(), departmentId: Number(dept) || null };
    const scope = departments.data?.find((d) => d.id === body.departmentId)?.name ?? '全部';
    try {
      const r = await sendErpOp<AssetStocktake>({ key: body.clientKey, type: 'asset_stocktake', url: '/api/erp/assets/stocktakes', body, summary: `开始扫码盘点（${scope}）`, staffName: session.staff.displayName });
      setOpenId(r.id);
    } catch (e) {
      if (e instanceof UncertainError) toast({ tone: 'error', title: '开始盘点没收到结果', body: '记在页面上方的「结果待确认」里，查回或按原内容重新提交' });
      else toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      await qc.invalidateQueries({ queryKey: KEY });
    }
  };
  const scan = async () => {
    if (!openId || !code.trim()) return;
    try {
      qc.setQueryData([...KEY, 'stocktake', openId], await api.post<AssetStocktake>(`/api/erp/assets/stocktakes/${openId}/scan`, { code: code.trim() }));
      setCode('');
      input.current?.focus();
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    }
  };
  const close = async () => {
    if (!openId) return;
    try {
      qc.setQueryData([...KEY, 'stocktake', openId], await api.post<AssetStocktake>(`/api/erp/assets/stocktakes/${openId}/close`, {}));
      await qc.invalidateQueries({ queryKey: [...KEY, 'stocktakes'] });
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    }
  };
  const s = st.data;
  return (
    <div className="space-y-3" data-testid="asset-stocktake">
      {manage && (
        <div className="flex flex-wrap items-center gap-2">
          <Select fullWidth={false} value={dept} onChange={(e) => setDept(e.target.value)} className="h-9 w-40 text-[13px]" aria-label="盘点范围">
            <option value="">全部资产</option>
            {(departments.data ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
          <Button size="sm" variant="primary" icon={<ScanLine className="size-4" />} onClick={() => void start()} data-testid="stocktake-start">
            开始盘点
          </Button>
        </div>
      )}
      {(list.data ?? []).length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {list.data!.map((x) => (
            <li key={x.id}>
              <button type="button" onClick={() => setOpenId(x.id)} className={cn('rounded-md border px-2.5 py-1 text-[12.5px]', openId === x.id ? 'border-pine bg-pine-tint' : 'border-line bg-card')}>
                {x.docNo} · {x.departmentName ?? '全部'} · {x.status === 'open' ? '进行中' : '已结束'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {s && (
        <Card className="space-y-3 p-4">
          <p className="flex flex-wrap items-center gap-2 text-[13px]">
            <span className="num font-bold">{s.docNo}</span>
            <span>{s.departmentName ?? '全部资产'}</span>
            <Badge tone={s.status === 'open' ? 'yuzu' : 'neutral'}>{s.status === 'open' ? '进行中' : '已结束'}</Badge>
            <span className="text-ink-3">
              应有 {s.expected} 张，扫到 {s.found} 张
            </span>
            {manage && s.status === 'open' && (
              <Button size="sm" variant="secondary" className="ml-auto" onClick={() => void close()} data-testid="stocktake-close">
                结束盘点
              </Button>
            )}
          </p>
          {manage && s.status === 'open' && (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void scan();
              }}
            >
              <Input ref={input} autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="扫资产标签的二维码，或输入资产编号后回车" className="h-10" data-testid="stocktake-code" />
              <Button type="submit" variant="primary">
                记下
              </Button>
            </form>
          )}
          {s.status === 'closed' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <section>
                <h3 className="mb-1 text-[12.5px] font-bold text-clay">没扫到（盘亏）{s.missing.length} 张</h3>
                <ul className="space-y-0.5 text-[12.5px]" data-testid="stocktake-missing">
                  {s.missing.map((m) => (
                    <li key={m.id}>
                      <span className="num font-semibold">{m.assetNo}</span> {m.name} {[m.location, m.keeper].filter(Boolean).join(' · ')}
                    </li>
                  ))}
                </ul>
              </section>
              <section>
                <h3 className="mb-1 text-[12.5px] font-bold text-yuzu-deep">不在范围里、或编号对不上 {s.extra.length} 个</h3>
                <ul className="space-y-0.5 text-[12.5px]" data-testid="stocktake-extra">
                  {s.extra.map((x) => (
                    <li key={x.code}>
                      <span className="num font-semibold">{x.code}</span> {x.name ?? '（没有这张卡）'} {x.departmentName ?? ''}
                    </li>
                  ))}
                </ul>
              </section>
              <p className="text-[12px] text-ink-3 sm:col-span-2">盘点结果只记录，不自动改卡片；要调拨、报废的到资产卡片里改。</p>
            </div>
          )}
          {s.scans.length > 0 && (
            <p className="text-[12px] text-ink-3">
              最近扫到：
              {s.scans
                .slice(-8)
                .reverse()
                .map((x) => x.code)
                .join('、')}
            </p>
          )}
        </Card>
      )}
    </div>
  );
}
