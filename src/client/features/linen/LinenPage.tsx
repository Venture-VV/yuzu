// 布草洗涤（8.0.20，docs/ERP_V8020.md 第 4 节）：ERP「供应链 → 布草洗涤」。
// 布草品类的总数 / 在洗 / 在店；开送洗、收回（破损、丢失）、新增、报废单；洗涤厂手里还有几件；按月的洗涤费对账表。
// 开单带操作编号（这个弹窗开着的时候一直用同一个）：没收到结果再点一次保存，只记一次。

import { useState } from 'react';
import { Navigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, PackagePlus, Plus, Shirt, Trash2, Truck, Undo2 } from 'lucide-react';
import { LINEN_DOC_LABELS, type LinenDoc, type LinenDocKind, type LinenItem, type LinenOverview, type LinenStatement } from '@shared/linen';
import { centsToInput, formatYuan, parseYuan } from '@shared/money';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn, formatDateTime, uuid } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { Dialog } from '../../components/Overlay';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, Select, Skeleton } from '../../components/ui';
import { useSuppliers } from '../inventory/queries';

const key = ['erp', 'linen'] as const;
const KIND_ICON: Record<LinenDocKind, typeof Truck> = { add: PackagePlus, send: Truck, return: Undo2, scrap: Trash2 };

export function LinenPage() {
  const can = useCan();
  const session = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const data = useQuery({ queryKey: key, queryFn: () => api.get<LinenOverview>('/api/erp/linen'), enabled: can('linen.read') });
  const [month, setMonth] = useState(session.calendarToday.slice(0, 7));
  const statement = useQuery({ queryKey: [...key, 'statement', month], queryFn: () => api.get<LinenStatement>(`/api/erp/linen/statement?month=${month}`), enabled: can('linen.read') && /^\d{4}-\d{2}$/.test(month) });
  const [opening, setOpening] = useState<LinenDocKind | null>(null);
  const [editing, setEditing] = useState<LinenItem | 'new' | null>(null);
  const [voiding, setVoiding] = useState<LinenDoc | null>(null);
  const [busy, setBusy] = useState(false);
  if (!can('linen.read')) return <Navigate to="/erp" replace />;
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const d = data.data;
  const manage = d?.canManage ?? false;

  const doVoid = async (reason: string) => {
    if (!voiding) return;
    setBusy(true);
    try {
      await api.post(`/api/erp/linen/docs/${voiding.id}/void`, { reason });
      toast({ tone: 'success', title: '已作废', body: voiding.docNo });
      setVoiding(null);
      await refresh();
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        dateMode="calendar"
        title="布草洗涤"
        subtitle="浴巾、浴衣、床品这些来回洗的东西：在店多少、在洗多少、洗涤厂手里还有几件；洗涤费按月对账"
        actions={
          manage && (
            <span className="flex flex-wrap gap-2">
              {(['send', 'return', 'add', 'scrap'] as const).map((k) => {
                const Icon = KIND_ICON[k];
                return (
                  <Button key={k} size="sm" variant={k === 'send' || k === 'return' ? 'primary' : 'secondary'} icon={<Icon className="size-4" />} onClick={() => setOpening(k)} data-testid={`linen-new-${k}`}>
                    {LINEN_DOC_LABELS[k]}
                  </Button>
                );
              })}
            </span>
          )
        }
      />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1180px] space-y-4 px-5 py-5 md:px-7" data-testid="linen-page">
          {data.error ? (
            <Notice tone="error" title={errorMessage(data.error)} />
          ) : !d ? (
            <Skeleton className="h-64" />
          ) : (
            <>
              <Card className="p-4">
                <div className="mb-2 flex items-center gap-2">
                  <Shirt className="size-4 text-ink-3" />
                  <span className="text-[14.5px] font-bold">布草品类</span>
                  {manage && (
                    <Button size="sm" variant="secondary" className="ml-auto" icon={<Plus className="size-4" />} onClick={() => setEditing('new')} data-testid="linen-item-new">
                      加品类
                    </Button>
                  )}
                </div>
                {d.items.length === 0 ? (
                  <EmptyState art="leaf" title="还没有布草品类" description={manage ? '先加品类（浴巾、浴衣、床单……）与每件洗涤费，再开「新增」单把现有的数量记进来。' : undefined} className="py-8" />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[520px] text-[13.5px]" data-testid="linen-items">
                      <thead>
                        <tr className="text-left text-[12px] text-ink-3">
                          <th className="py-1.5 font-semibold">品类</th>
                          <th className="text-right font-semibold">总数</th>
                          <th className="text-right font-semibold">在店</th>
                          <th className="text-right font-semibold">在洗</th>
                          <th className="text-right font-semibold">每件洗涤费</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {d.items.map((it) => (
                          <tr key={it.id} className={cn('border-t border-line/70', !it.active && 'text-ink-3')} data-testid={`linen-item-${it.id}`}>
                            <td className="py-1.5 font-semibold">
                              {it.name} {!it.active && <Badge>已停用</Badge>}
                            </td>
                            <td className="num text-right">{it.totalQty}</td>
                            <td className="num text-right font-bold">{it.inHouseQty}</td>
                            <td className="num text-right">{it.atLaundryQty}</td>
                            <td className="num text-right">{formatYuan(it.washPriceCents)}</td>
                            <td className="text-right">
                              {manage && (
                                <Button size="sm" variant="ghost" onClick={() => setEditing(it)}>
                                  改
                                </Button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>

              {d.outstanding.length > 0 && (
                <Card className="p-4" data-testid="linen-outstanding">
                  <div className="mb-2 text-[14.5px] font-bold">洗涤厂手里还没收回的</div>
                  <ul className="flex flex-wrap gap-x-5 gap-y-1 text-[13.5px]">
                    {d.outstanding.map((o) => (
                      <li key={`${o.supplierId}-${o.itemId}`}>
                        <span className="text-ink-3">{o.supplierName}</span> · {o.itemName} <b className="num">{o.qty}</b> 件
                      </li>
                    ))}
                  </ul>
                </Card>
              )}

              <Card className="p-4">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="text-[14.5px] font-bold">洗涤费对账</span>
                  <Input type="month" fullWidth={false} className="h-9 w-40" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="月份" data-testid="linen-month" />
                  <span className="text-[12.5px] text-ink-3">只算有效的收回单；完好与破损的都算洗过，丢失的不算。这一版不自动记应付，付款走付款申请或报销。</span>
                  <a className="ml-auto" href={`/api/erp/linen/statement/export?month=${month}`} download data-testid="linen-export">
                    <Button size="sm" variant="secondary" icon={<Download className="size-4" />}>
                      导出 CSV
                    </Button>
                  </a>
                </div>
                {!statement.data ? (
                  <Skeleton className="h-16" />
                ) : statement.data.rows.length === 0 ? (
                  <p className="text-[13px] text-ink-3">这个月没有收回单。</p>
                ) : (
                  <table className="w-full text-[13.5px]" data-testid="linen-statement">
                    <thead>
                      <tr className="text-left text-[12px] text-ink-3">
                        <th className="py-1.5 font-semibold">洗涤厂</th>
                        <th className="text-right font-semibold">收回单</th>
                        <th className="text-right font-semibold">完好</th>
                        <th className="text-right font-semibold">破损</th>
                        <th className="text-right font-semibold">丢失</th>
                        <th className="text-right font-semibold">洗涤费</th>
                      </tr>
                    </thead>
                    <tbody>
                      {statement.data.rows.map((r) => (
                        <tr key={r.supplierId} className="border-t border-line/70">
                          <td className="py-1.5">{r.supplierName}</td>
                          <td className="num text-right">{r.docs}</td>
                          <td className="num text-right">{r.washedQty}</td>
                          <td className="num text-right">{r.damagedQty}</td>
                          <td className="num text-right">{r.lostQty}</td>
                          <td className="num text-right font-bold">{formatYuan(r.amountCents)}</td>
                        </tr>
                      ))}
                      <tr className="border-t border-line font-bold">
                        <td className="py-1.5" colSpan={5}>
                          合计
                        </td>
                        <td className="num text-right">{formatYuan(statement.data.totalCents)}</td>
                      </tr>
                    </tbody>
                  </table>
                )}
              </Card>

              <Card className="p-4">
                <div className="mb-2 text-[14.5px] font-bold">最近的单据</div>
                {d.docs.length === 0 ? (
                  <p className="text-[13px] text-ink-3">还没有单据。</p>
                ) : (
                  <ul className="divide-y divide-line/70" data-testid="linen-docs">
                    {d.docs.map((doc) => (
                      <li key={doc.id} className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-[13.5px]', doc.status === 'voided' && 'text-ink-3')} data-testid={`linen-doc-${doc.id}`}>
                        <span className="num font-bold">{doc.docNo}</span>
                        <Badge tone={doc.kind === 'send' ? 'lake' : doc.kind === 'return' ? 'moss' : 'neutral'}>{LINEN_DOC_LABELS[doc.kind]}</Badge>
                        <span className="text-ink-3">{doc.docDate}</span>
                        {doc.supplier && <span>{doc.supplier.name}</span>}
                        <span className="min-w-0 flex-1 truncate">
                          {doc.lines.map((l) => `${l.itemName} ${l.qty}${l.damagedQty ? ` 破损 ${l.damagedQty}` : ''}${l.lostQty ? ` 丢失 ${l.lostQty}` : ''}`).join(' · ')}
                          {doc.note && <span className="text-ink-3"> · {doc.note}</span>}
                        </span>
                        {doc.amountCents > 0 && <span className="num font-semibold">{formatYuan(doc.amountCents)}</span>}
                        <span className="text-[12px] text-ink-3">
                          {doc.createdByName} {formatDateTime(doc.createdAt)}
                        </span>
                        {doc.status === 'voided' ? (
                          <Badge>已作废：{doc.voidReason}</Badge>
                        ) : (
                          manage && (
                            <Button size="sm" variant="ghost" onClick={() => setVoiding(doc)}>
                              作废
                            </Button>
                          )
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </>
          )}
        </div>
      </div>
      {opening && d && <DocDialog kind={opening} items={d.items.filter((i) => i.active)} onClose={() => setOpening(null)} onDone={refresh} />}
      {editing && <ItemDialog item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onDone={refresh} />}
      <ReasonDialog open={!!voiding} title={`作废 ${voiding?.docNo ?? ''}`} description="作废以后单据还在，数量冲回去。后面已经有送洗、收回挡着的作废不了，要先处理后面的单。" confirmLabel="作废" busy={busy} onClose={() => setVoiding(null)} onConfirm={(reason) => void doVoid(reason)} />
    </>
  );
}

function ItemDialog({ item, onClose, onDone }: { item: LinenItem | null; onClose: () => void; onDone: () => Promise<unknown> }) {
  const toast = useToast();
  const [name, setName] = useState(item?.name ?? '');
  const [price, setPrice] = useState(item ? centsToInput(item.washPriceCents) : '');
  const [active, setActive] = useState(item?.active ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const cents = price.trim() === '' ? 0 : parseYuan(price);
    if (cents === null || cents < 0) return setError('洗涤费不对');
    if (!name.trim()) return setError('请填写品类名称');
    setSaving(true);
    setError(null);
    try {
      if (item) await api.put(`/api/erp/linen/items/${item.id}`, { name: name.trim(), washPriceCents: cents, active, expectedVersion: item.version });
      else await api.post('/api/erp/linen/items', { name: name.trim(), washPriceCents: cents });
      toast({ tone: 'success', title: item ? '已保存' : '已添加', body: name.trim() });
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
      title={item ? `改「${item.name}」` : '加布草品类'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={saving} data-testid="linen-item-save">
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="品类名称" htmlFor="linen-name">
          <Input id="linen-name" value={name} maxLength={24} onChange={(e) => setName(e.target.value)} placeholder="浴巾" />
        </Field>
        <Field label="每件洗涤费（元）" htmlFor="linen-price" hint="收回单按「完好 + 破损」的件数 × 这个价算洗涤费；改了只管以后的收回单">
          <Input id="linen-price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" />
        </Field>
        {item && (
          <label className="flex items-center gap-2 text-[13.5px]">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            在用（停用以后不能再开单；还有在洗的不能停用）
          </label>
        )}
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}

interface Line {
  key: number;
  itemId: number | '';
  qty: string;
  damaged: string;
  lost: string;
}

function DocDialog({ kind, items, onClose, onDone }: { kind: LinenDocKind; items: LinenItem[]; onClose: () => void; onDone: () => Promise<unknown> }) {
  const toast = useToast();
  const session = useSession();
  const suppliers = useSuppliers();
  const needsSupplier = kind === 'send' || kind === 'return';
  // 这个弹窗开着的时候一直用同一个操作编号：没收到结果再点一次保存，服务端只记一次
  const [clientKey] = useState(uuid);
  const [supplierId, setSupplierId] = useState<number | ''>('');
  const [docDate, setDocDate] = useState(session.calendarToday);
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<Line[]>([{ key: 0, itemId: '', qty: '', damaged: '', lost: '' }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const set = (k: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...patch } : l)));
  const int = (s: string) => (s.trim() === '' ? 0 : /^\d+$/.test(s.trim()) ? Number(s.trim()) : NaN);

  const submit = async () => {
    setError(null);
    if (needsSupplier && supplierId === '') return setError('请选择洗涤厂');
    const body = [];
    for (const l of lines) {
      if (l.itemId === '') continue;
      const qty = int(l.qty);
      const damagedQty = kind === 'return' ? int(l.damaged) : 0;
      const lostQty = kind === 'return' ? int(l.lost) : 0;
      if ([qty, damagedQty, lostQty].some(Number.isNaN)) return setError('数量填整数');
      if (qty + damagedQty + lostQty <= 0) return setError('数量要大于 0');
      body.push({ itemId: l.itemId, qty, damagedQty, lostQty });
    }
    if (body.length === 0) return setError('请至少填一行');
    setSaving(true);
    try {
      await api.post('/api/erp/linen/docs', { clientKey, kind, supplierId: needsSupplier ? supplierId : null, docDate, note: note.trim(), lines: body });
      toast({ tone: 'success', title: `${LINEN_DOC_LABELS[kind]}单已保存` });
      await onDone();
      onClose();
    } catch (e) {
      if (e instanceof UncertainError) {
        setUncertain(true);
        setError('没收到结果，不知道存没存上。不要改内容，再点一次「保存」——存过了不会再记一次。');
      } else setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!uncertain}
      title={`${LINEN_DOC_LABELS[kind]}单`}
      description={
        kind === 'send'
          ? '送去洗涤厂：在店减少、在洗增加。'
          : kind === 'return'
            ? '洗涤厂送回来：完好的回到在店；破损、丢失的从总数里减掉。洗涤费按「完好 + 破损」算。'
            : kind === 'add'
              ? '新买的或第一次清点的：总数增加。'
              : '用旧了不要的：总数减少（只能报废在店的）。'
      }
      width="max-w-2xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {uncertain ? '先不管（稍后在单据里核对）' : '取消'}
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={saving} data-testid="linen-doc-save">
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="linen-doc-dialog">
        <div className="grid gap-3 md:grid-cols-2">
          {needsSupplier && (
            <Field label="洗涤厂" htmlFor="linen-supplier" hint="在「库存 → 档案 → 供应商」里维护">
              <Select id="linen-supplier" value={supplierId} disabled={uncertain} onChange={(e) => setSupplierId(e.target.value === '' ? '' : Number(e.target.value))} data-testid="linen-doc-supplier">
                <option value="">请选择</option>
                {(suppliers.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="日期" htmlFor="linen-date">
            <Input id="linen-date" type="date" value={docDate} max={session.calendarToday} disabled={uncertain} onChange={(e) => setDocDate(e.target.value)} />
          </Field>
        </div>
        <ul className="space-y-2">
          {lines.map((l, index) => {
            const it = items.find((x) => x.id === l.itemId);
            return (
              <li key={l.key} className={cn('grid items-end gap-2', kind === 'return' ? 'grid-cols-[minmax(0,1fr)_84px_84px_84px_auto]' : 'grid-cols-[minmax(0,1fr)_110px_auto]')}>
                <Field label={index === 0 ? '品类' : ''} htmlFor={`linen-l-${l.key}`} hint={it ? `在店 ${it.inHouseQty} · 在洗 ${it.atLaundryQty}` : undefined}>
                  <Select id={`linen-l-${l.key}`} value={l.itemId} disabled={uncertain} onChange={(e) => set(l.key, { itemId: e.target.value === '' ? '' : Number(e.target.value) })} data-testid={`linen-doc-item-${index}`}>
                    <option value="">请选择</option>
                    {items.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={index === 0 ? (kind === 'return' ? '完好' : '件数') : ''} htmlFor={`linen-q-${l.key}`}>
                  <Input id={`linen-q-${l.key}`} inputMode="numeric" value={l.qty} disabled={uncertain} onChange={(e) => set(l.key, { qty: e.target.value })} data-testid={`linen-doc-qty-${index}`} />
                </Field>
                {kind === 'return' && (
                  <>
                    <Field label={index === 0 ? '破损' : ''} htmlFor={`linen-d-${l.key}`}>
                      <Input id={`linen-d-${l.key}`} inputMode="numeric" value={l.damaged} disabled={uncertain} onChange={(e) => set(l.key, { damaged: e.target.value })} data-testid={`linen-doc-damaged-${index}`} />
                    </Field>
                    <Field label={index === 0 ? '丢失' : ''} htmlFor={`linen-x-${l.key}`}>
                      <Input id={`linen-x-${l.key}`} inputMode="numeric" value={l.lost} disabled={uncertain} onChange={(e) => set(l.key, { lost: e.target.value })} data-testid={`linen-doc-lost-${index}`} />
                    </Field>
                  </>
                )}
                <Button variant="ghost" size="sm" aria-label="去掉这一行" disabled={lines.length === 1 || uncertain} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} icon={<Trash2 className="size-4" />} />
              </li>
            );
          })}
        </ul>
        <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} disabled={uncertain || lines.length >= 50} onClick={() => setLines((ls) => [...ls, { key: Math.max(...ls.map((x) => x.key)) + 1, itemId: '', qty: '', damaged: '', lost: '' }])}>
          加一行
        </Button>
        <Field label="备注" htmlFor="linen-note">
          <Input id="linen-note" value={note} maxLength={200} disabled={uncertain} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {error && <Notice tone={uncertain ? 'warning' : 'error'} title={error} />}
      </div>
    </Dialog>
  );
}
