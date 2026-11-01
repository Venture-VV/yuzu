import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import { ArrowLeft, CircleAlert, CircleCheck, ClipboardList, CloudOff, PackagePlus, RotateCw, Search, ShoppingCart, Trash2, X } from 'lucide-react';
import type { Material } from '@shared/inventory';
import { centsToInput, parseYuan } from '@shared/money';
import type { PoLineRequest, PriceCompare, PurchaseOrder } from '@shared/purchasing';
import { fitsDecimals, formatQty, lineAmountCents, parseQty, priceChangePercent, toBaseQty } from '@shared/quantity';
import { MAX_LINE_IMAGES, type ImageRef, type OpenRequestLine } from '@shared/requests';
import { api, ApiError, errorMessage, UncertainError } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn, uuid } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { ImagePicker, ImageThumbs } from '../../components/Images';
import { Money } from '../../components/Money';
import { useToast } from '../../components/Toast';
import { Button, Field, IconButton, Input, MoneyInput, Notice, Select, Skeleton } from '../../components/ui';
import { MaterialPicker } from '../inventory/inputs';
import { MaterialDialog } from '../inventory/MasterTab';
import { SimRule } from '../inventory/parts';
import { useInvSettings, useMaterials, useSuppliers } from '../inventory/queries';
import { CompareChip } from './parts';
import { useOpenLines } from '../requests/queries';
import { useBaseline, useInvalidateAll, usePo } from './queries';

interface Line {
  key: string;
  id: number | null;
  materialId: number;
  purchaseUnit: string;
  inventoryUnit: string;
  factorMilli: number;
  decimals: number;
  qty: string;
  price: string;
  receivedMilli: number;
  /** 已有行原来的订购数量（库存单位）；新行为空 */
  origBaseMilli: number | null;
  /** 称重物料（v0.7.13）：按实际称重收货，可以比订购数量多出容差 */
  weighed: boolean;
  /** 已有行的比价（按下单日期计算） */
  compare: PriceCompare | null;
  note: string;
  /** 规格（v0.7.8）：默认带物料档案的规格或需求单的详情 */
  spec: string;
  images: ImageRef[];
  /** 来自哪几行需求（v0.7.8）：同一物料的几行需求合并成这一行 */
  requests: PoLineRequest[];
}

const asRequest = (o: OpenRequestLine): PoLineRequest => ({
  lineId: o.id,
  requestId: o.requestId,
  requestNo: o.requestNo,
  departmentName: o.department.name,
  name: o.name,
  qtyMilli: o.qtyMilli,
  unit: o.unit,
});

/** 需求行的数量换成采购单位：单位是采购单位或库存单位时能换，换不出来返回 null（由采购自己填） */
function requestQtyInPurchase(o: { qtyMilli: number; unit: string }, m: Material): number | null {
  if (o.unit === m.purchaseUnit) return o.qtyMilli;
  if (o.unit === m.inventoryUnit) {
    const purchaseMilli = (o.qtyMilli * 1000) / m.purchaseFactorMilli;
    return Number.isInteger(purchaseMilli) ? purchaseMilli : null;
  }
  return null;
}

type Mode = 'new' | 'edit' | 'revise';

export function PoFormPage({ mode }: { mode: Mode }) {
  const { id } = useParams();
  const can = useCan();
  const po = usePo(mode === 'new' ? null : Number(id));
  if (!can('purchase.manage')) return <Navigate to="/purchasing" replace />;
  if (mode === 'new') return <PoForm mode="new" />;
  if (po.error) return <Notice tone="error" title={errorMessage(po.error)} className="m-7" />;
  if (!po.data) return <Skeleton className="m-7 h-96" />;
  const allowed = mode === 'revise' ? po.data.status === 'approved' : po.data.status === 'draft' || po.data.status === 'returned';
  if (!allowed || po.data.backfill) return <Navigate to={`/purchasing?po=${po.data.id}`} replace />;
  return <PoForm mode={mode} existing={po.data} />;
}

function linesFrom(po: PurchaseOrder): Line[] {
  return po.lines.map((l) => ({
    key: uuid(),
    id: l.id,
    materialId: l.materialId,
    purchaseUnit: l.purchaseUnit,
    inventoryUnit: l.inventoryUnit,
    factorMilli: l.factorMilli,
    decimals: l.decimals,
    qty: formatQty(l.purchaseQtyMilli).replace(/,/g, ''),
    price: centsToInput(l.priceCents),
    receivedMilli: l.receivedMilli,
    origBaseMilli: l.baseQtyMilli,
    weighed: l.weighed,
    compare: l.compare,
    note: l.note,
    spec: l.spec,
    images: l.images,
    requests: l.requests,
  }));
}

type Phase = { kind: 'edit' } | { kind: 'submitting' } | { kind: 'uncertain'; body: unknown; checking?: boolean; notFound?: boolean };

function PoForm({ mode, existing }: { mode: Mode; existing?: PurchaseOrder }) {
  const session = useSession();
  const can = useCan();
  const toast = useToast();
  const navigate = useNavigate();
  const invalidate = useInvalidateAll();
  const suppliers = useSuppliers();
  const materialsQ = useMaterials();
  const settings = useInvSettings();
  // 称重物料多到的（v0.7.13）：数量没改的照旧可以改单；改了的，已收货不超过新数量加容差就行（与服务端一致）
  const weighedOk = (l: Line, base: number) =>
    l.weighed && (base === l.origBaseMilli || base + Math.floor((base * (settings.data?.weighTolerancePct ?? 10)) / 100) >= l.receivedMilli);
  const [clientKey] = useState(uuid);
  const [supplierId, setSupplierId] = useState<number | null>(existing?.supplier.id ?? null);
  const [orderDate, setOrderDate] = useState(existing?.orderDate ?? session.calendarToday);
  const [expectedDate, setExpectedDate] = useState(existing?.expectedDate ?? '');
  const [note, setNote] = useState(existing?.note ?? '');
  const [lines, setLines] = useState<Line[]>(existing ? linesFrom(existing) : []);
  const [approveNow, setApproveNow] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'edit' });
  const [error, setError] = useState<string | null>(null);
  // 转采购单（v0.7.8）：?requestLines=1,2,3 带来已通过的需求行；选了物料的直接加进明细（同一物料合并），新产品先选或新建物料
  const [params] = useSearchParams();
  const requestIds = mode === 'new' && /^\d+(,\d+)*$/.test(params.get('requestLines') ?? '') ? params.get('requestLines') : null;
  const openLines = useOpenLines(requestIds, !!requestIds);
  const [unmatched, setUnmatched] = useState<OpenRequestLine[]>([]);
  const [creating, setCreating] = useState<OpenRequestLine | null>(null);
  // 还在上传图片的行：上传完之前不能提交（v0.7.9 修正）
  const [uploading, setUploading] = useState<ReadonlySet<string>>(new Set());
  const setLineUploading = (key: string, busy: boolean) =>
    setUploading((s) => {
      if (busy === s.has(key)) return s;
      const next = new Set(s);
      if (busy) next.add(key);
      else next.delete(key);
      return next;
    });
  const seeded = useRef(false);
  const qtyRefs = useRef(new Map<string, HTMLInputElement | null>());
  const focusNext = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (focusNext.current && qtyRefs.current.get(focusNext.current)) {
      qtyRefs.current.get(focusNext.current)!.focus();
      focusNext.current = null;
    }
  });
  const locked = phase.kind !== 'edit';
  const hasReceipts = lines.some((l) => l.receivedMilli > 0);

  // 常用该供应商的物料排在前面
  const materials = useMemo(() => {
    const list = materialsQ.data ?? [];
    return supplierId ? [...list].sort((a, b) => Number(b.defaultSupplierId === supplierId) - Number(a.defaultSupplierId === supplierId)) : list;
  }, [materialsQ.data, supplierId]);

  const newLine = (m: Material): Line => ({
    key: uuid(),
    id: null,
    materialId: m.id,
    purchaseUnit: m.purchaseUnit,
    inventoryUnit: m.inventoryUnit,
    factorMilli: m.purchaseFactorMilli,
    decimals: m.decimals,
    qty: '',
    price: m.refPriceCents !== null ? centsToInput(m.refPriceCents) : '',
    receivedMilli: 0,
    origBaseMilli: null,
    weighed: m.weighed,
    compare: null,
    note: '',
    spec: m.specification.slice(0, 80),
    images: [],
    requests: [],
  });
  const add = (m: Material) => {
    const line = newLine(m);
    focusNext.current = line.key;
    setLines((ls) => [...ls, line]);
  };
  /** 把一行需求并进明细：已有这个物料的行就合并（数量能换算的加上去），没有就新加一行 */
  const mergeRequest = (ls: Line[], m: Material, o: OpenRequestLine): Line[] => {
    const qty = requestQtyInPurchase(o, m);
    const existingLine = ls.find((l) => l.materialId === m.id);
    if (existingLine) {
      if (existingLine.requests.some((r) => r.lineId === o.id)) return ls;
      const prevQty = parseQty(existingLine.qty, 3);
      const images = [...existingLine.images, ...o.images.filter((i) => !existingLine.images.some((x) => x.id === i.id))].slice(0, MAX_LINE_IMAGES);
      return ls.map((l) =>
        l.key === existingLine.key
          ? { ...l, requests: [...l.requests, asRequest(o)], images, qty: qty !== null && prevQty !== null ? formatQty(prevQty + qty).replace(/,/g, '') : l.qty }
          : l,
      );
    }
    const line = newLine(m);
    return [
      ...ls,
      {
        ...line,
        qty: qty !== null ? formatQty(qty).replace(/,/g, '') : '',
        price: line.price || (o.refPriceCents !== null && o.unit === m.purchaseUnit ? centsToInput(o.refPriceCents) : ''),
        spec: (o.details || m.specification).slice(0, 80),
        images: o.images.slice(0, MAX_LINE_IMAGES),
        requests: [asRequest(o)],
      },
    ];
  };
  const placeRequest = (m: Material, o: OpenRequestLine) => {
    setLines((ls) => mergeRequest(ls, m, o));
    setUnmatched((u) => u.filter((x) => x.id !== o.id));
  };
  useEffect(() => {
    if (seeded.current || !openLines.data || !materialsQ.data) return;
    seeded.current = true;
    const mats = new Map(materialsQ.data.map((m) => [m.id, m]));
    const rest: OpenRequestLine[] = [];
    let next: Line[] = lines;
    for (const o of openLines.data) {
      const m = o.materialId ? mats.get(o.materialId) : undefined;
      if (m) next = mergeRequest(next, m, o);
      else rest.push(o);
    }
    setLines(next);
    setUnmatched(rest);
    // 只在需求行第一次读回时并入一次（之后的修改由采购在明细里调整）
  }, [openLines.data, materialsQ.data]);
  const patch = (key: string, p: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)));

  const rows = lines.map((l) => {
    const m = materialsQ.data?.find((x) => x.id === l.materialId);
    const qty = parseQty(l.qty, 3);
    const base = qty !== null ? toBaseQty(qty, l.factorMilli) : null;
    const price = parseYuan(l.price);
    let err: string | null = null;
    if (l.qty.trim() && (qty === null || qty === 0)) err = '数量格式不正确';
    else if (qty !== null && (base === null || !fitsDecimals(base, l.decimals))) err = `换算后不是整${l.inventoryUnit}`;
    else if (base !== null && base < l.receivedMilli && !weighedOk(l, base)) err = `已收货 ${formatQty(l.receivedMilli)} ${l.inventoryUnit}，不能少于已收货`;
    else if (l.price.trim() && price === null) err = '单价格式不正确';
    const amount = base !== null && price !== null ? lineAmountCents(base, price, l.factorMilli) : null;
    const ready = !err && qty !== null && qty > 0 && price !== null;
    return { l, m, qty, base, price, err, amount, ready };
  });
  const total = rows.reduce((s, r) => s + (r.amount ?? 0), 0);
  const needsApproval = !!settings.data?.approvalRules.purchase_order;
  const blocking = uploading.size > 0
    ? '图片还在上传，请稍等'
    : unmatched.length > 0
    ? `还有 ${unmatched.length} 行新产品没选物料`
    : !supplierId
    ? '请选择供应商'
    : rows.length === 0
      ? '请至少添加一项物料'
      : rows.some((r) => r.err)
        ? `有 ${rows.filter((r) => r.err).length} 行需要修改`
        : rows.some((r) => !r.ready)
          ? '还有行没填完整'
          : expectedDate && expectedDate < orderDate
            ? '预计到货日期不能早于下单日期'
            : null;

  const body = (action: 'save' | 'submit') => ({
    supplierId,
    orderDate,
    expectedDate: expectedDate || null,
    note: note.trim(),
    action,
    approveNow: action === 'submit' && needsApproval && approveNow,
    lines: rows.map((r) => ({
      id: r.l.id,
      materialId: r.l.materialId,
      purchaseQtyMilli: r.qty,
      priceCents: r.price,
      note: r.l.note,
      spec: r.l.spec.trim(),
      imageIds: r.l.images.map((i) => i.id),
      requestLineIds: r.l.requests.map((x) => x.lineId),
    })),
  });

  const done = (po: PurchaseOrder) => {
    void invalidate();
    toast({
      tone: 'success',
      title: po.status === 'approved' ? '采购单已确认' : po.status === 'submitted' ? '已提交，等待负责人确认' : '草稿已保存',
      body: po.docNo,
    });
    navigate(`/purchasing?po=${po.id}`);
  };

  const send = async (payload: unknown) => {
    setError(null);
    setPhase({ kind: 'submitting' });
    try {
      if (mode === 'new') {
        const r = await api.post<{ po: PurchaseOrder }>('/api/purchase-orders', payload, { timeoutMs: 20_000 });
        done(r.po);
      } else if (mode === 'edit') {
        done(await api.put<PurchaseOrder>(`/api/purchase-orders/${existing!.id}`, payload));
      } else {
        done(await api.post<PurchaseOrder>(`/api/purchase-orders/${existing!.id}/revise`, payload));
      }
    } catch (e) {
      if (e instanceof UncertainError && mode === 'new') return setPhase({ kind: 'uncertain', body: payload });
      setPhase({ kind: 'edit' });
      setError(e instanceof ApiError ? e.message : errorMessage(e));
    }
  };

  const check = async () => {
    if (phase.kind !== 'uncertain') return;
    setPhase({ ...phase, checking: true });
    try {
      const r = await api.get<{ found: boolean; po?: PurchaseOrder }>(`/api/purchase-orders/by-key/${clientKey}`);
      if (r.found && r.po) done(r.po);
      else setPhase({ ...phase, checking: false, notFound: true });
    } catch {
      setPhase({ ...phase, checking: false });
    }
  };

  const title = mode === 'new' ? '新建采购单' : mode === 'edit' ? `修改采购单 · ${existing!.docNo}` : `改版 · ${existing!.docNo}（第 ${existing!.revision + 1} 版）`;

  return (
    <>
      <PageHeader
        dateMode="calendar"
        title={
          <span className="flex items-center gap-2.5">
            <Link to={existing ? `/purchasing?po=${existing.id}` : '/purchasing'} className="-ml-1 flex size-8 items-center justify-center rounded-md text-ink-3 hover:bg-paper-2 hover:text-ink" aria-label="返回采购">
              <ArrowLeft className="size-[18px]" />
            </Link>
            <span className="flex size-8 items-center justify-center rounded-full bg-pine-soft text-pine">
              <ShoppingCart className="size-4" />
            </span>
            {title}
          </span>
        }
        subtitle="单价按采购单位填写；比价只与同规格、同单位、同价格口径的最近成交价比较"
      />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1180px] space-y-4 px-5 py-5 md:px-7">
          {mode === 'revise' && (
            <Notice tone="warning" title="改版会保留当前版本，并重新提交负责人确认" icon={<CircleAlert className="size-5" />}>
              确认前不能继续按单收货。已收货的行不能改价，数量不能少于已收货。
            </Notice>
          )}
          {existing?.status === 'returned' && existing.returnedReason && <Notice tone="warning" title="负责人退回修改">{existing.returnedReason}</Notice>}

          <section className="grid gap-4 rounded-lg border border-line bg-card p-5 shadow-card sm:grid-cols-2 lg:grid-cols-4">
            <Field label="供应商" htmlFor="po-sup" hint={hasReceipts ? '已有收货，不能更换' : undefined}>
              <Select id="po-sup" value={supplierId ?? ''} disabled={locked || hasReceipts} onChange={(e) => setSupplierId(Number(e.target.value) || null)}>
                <option value="">选择供应商</option>
                {suppliers.data?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code} · {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="下单日期" htmlFor="po-date">
              <Input id="po-date" type="date" value={orderDate} max={session.calendarToday} disabled={locked} onChange={(e) => setOrderDate(e.target.value)} className="h-10" />
            </Field>
            <Field label="预计到货" htmlFor="po-exp" hint="选填">
              <Input id="po-exp" type="date" value={expectedDate} min={orderDate} disabled={locked} onChange={(e) => setExpectedDate(e.target.value)} className="h-10" />
            </Field>
            <Field label="价格口径">
              <p className="flex h-10 items-center gap-2 text-[13.5px] font-semibold">
                {settings.data?.priceBasis ?? '—'} <SimRule>待确认</SimRule>
              </p>
            </Field>
            <Field label="备注" htmlFor="po-note" className="sm:col-span-2 lg:col-span-4">
              <Input id="po-note" value={note} maxLength={200} disabled={locked} onChange={(e) => setNote(e.target.value)} placeholder="例如：需求来源、送货要求" className="h-10" />
            </Field>
          </section>

          {requestIds && (
            <section className="rounded-lg border border-line bg-card p-4 shadow-card" data-testid="po-from-requests">
              <h2 className="flex items-center gap-2 text-[14px] font-bold">
                <ClipboardList className="size-4 text-pine" />
                来自需求单
              </h2>
              {openLines.isPending ? (
                <Skeleton className="mt-3 h-16" />
              ) : openLines.error ? (
                <Notice tone="error" title={errorMessage(openLines.error)} className="mt-3" />
              ) : (
                <>
                  <p className="mt-1 text-[12.5px] text-ink-3">
                    {openLines.data!.length === 0
                      ? '选的需求行已经下单或不再是「已通过」，请回需求单重新勾选。'
                      : `共 ${openLines.data!.length} 行：选了物料的已加进明细（同一物料合并成一行，数量能换算的已加好，请核对）${unmatched.length ? `；下面 ${unmatched.length} 行新产品要先选或新建物料` : ''}。`}
                  </p>
                  {unmatched.length > 0 && (
                    <ul className="mt-3 divide-y divide-line/70 rounded-lg border border-line">
                      {unmatched.map((o) => (
                        <li key={o.id} className="grid gap-2 px-3 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]" data-testid={`po-unmatched-${o.id}`}>
                          <div className="min-w-0 space-y-1">
                            <p className="text-[13.5px] font-bold">
                              {o.name}
                              <span className="num ml-2 font-semibold text-ink-2">
                                {formatQty(o.qtyMilli)} {o.unit}
                              </span>
                            </p>
                            <p className="text-[12px] text-ink-3">
                              <span className="num">{o.requestNo}</span> · {o.department.name} · {o.requesterName}
                              {o.details && ` · ${o.details}`}
                            </p>
                            {o.link && (
                              <a href={o.link} target="_blank" rel="noopener noreferrer" className="block truncate text-[12px] font-semibold text-lake hover:underline">
                                {o.link}
                              </a>
                            )}
                            <ImageThumbs images={o.images} size={36} />
                          </div>
                          <div className="flex flex-wrap items-start gap-2">
                            <MaterialPicker materials={materials} onPick={(m) => placeRequest(m, o)} placeholder="选已有物料：编码 / 名称" className="min-w-[200px] flex-1" />
                            <Button size="sm" variant="secondary" icon={<PackagePlus className="size-4" />} disabled={locked} onClick={() => setCreating(o)} data-testid={`po-unmatched-create-${o.id}`}>
                              新建物料
                            </Button>
                            <Button size="sm" variant="ghost" disabled={locked} onClick={() => setUnmatched((u) => u.filter((x) => x.id !== o.id))}>
                              这次不转
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </section>
          )}

          <section className="@container rounded-lg border border-line bg-card shadow-card">
            <div className="flex items-center gap-3 border-b border-line px-5 py-3">
              <h2 className="text-[14px] font-bold">明细</h2>
              <span className="num text-[12.5px] text-ink-3">{rows.length} 行</span>
            </div>
            <div className="hidden grid-cols-[minmax(0,1fr)_170px_150px_120px_minmax(0,0.9fr)_40px] gap-3 border-b border-line bg-paper-2/60 px-5 py-2 text-[12px] font-bold text-ink-3 @4xl:grid">
              <span>物料</span>
              <span className="text-right">采购数量</span>
              <span className="text-right">单价</span>
              <span className="text-right">金额</span>
              <span>比价</span>
              <span />
            </div>
            {rows.length === 0 && <EmptyState art="leaf" title="还没有物料" description="搜索物料加入；同一物料在一张采购单里只出现一次。" className="py-8" />}
            <ul className="divide-y divide-line/70">
              {rows.map((r) => (
                <PoLineRow
                  key={r.l.key}
                  row={r}
                  locked={locked}
                  qtyRef={(el) => qtyRefs.current.set(r.l.key, el)}
                  onPatch={(p) => patch(r.l.key, p)}
                  onUploading={(b) => setLineUploading(r.l.key, b)}
                  onRemove={r.l.receivedMilli > 0 ? undefined : () => setLines((ls) => ls.filter((x) => x.key !== r.l.key))}
                />
              ))}
            </ul>
            {!locked && (
              <div className="border-t border-line px-5 py-3.5">
                <MaterialPicker materials={materials} taken={new Set(lines.map((l) => l.materialId))} onPick={add} placeholder="搜索物料：编码 / 名称 / 规格，回车加入" />
              </div>
            )}
          </section>

          {error && <Notice tone="error" title={error} icon={<CircleAlert className="size-5" />}>内容仍保留在页面上，可修改后再提交。</Notice>}
          {phase.kind === 'uncertain' && (
            <Notice
              tone="warning"
              title="结果待确认"
              icon={<CloudOff className="size-5" />}
              action={
                <>
                  <Button size="sm" variant="primary" loading={phase.checking} icon={<Search className="size-4" />} onClick={check}>
                    查回结果
                  </Button>
                  {phase.notFound && (
                    <Button size="sm" variant="secondary" icon={<RotateCw className="size-4" />} onClick={() => void send(phase.body)}>
                      按原内容重新提交
                    </Button>
                  )}
                </>
              }
            >
              {phase.notFound ? '服务器上没有这张采购单，可以按原内容重新提交（同一操作编号，不会重复建单）。' : '采购单可能已经建好。请先查回结果，不要重新填写。'}
            </Notice>
          )}
        </div>
      </div>

      <footer className="shrink-0 border-t border-line bg-card/95 px-5 py-3 backdrop-blur md:px-7">
        <div className="mx-auto flex w-full max-w-[1180px] flex-wrap items-center gap-x-5 gap-y-2.5">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1">
            <span className="flex items-baseline gap-2">
              <span className="text-[12.5px] font-semibold text-ink-3">下单金额</span>
              <Money cents={total} className="text-[20px] font-bold" />
            </span>
            <span className="text-[12.5px] font-semibold">
              {needsApproval ? (
                <span className="flex items-center gap-2 text-yuzu-deep">
                  提交后需负责人确认 <SimRule />
                </span>
              ) : (
                <span className="text-pine">提交即确认</span>
              )}
            </span>
            {blocking && phase.kind === 'edit' && <span className="text-[12.5px] font-semibold text-clay">{blocking}</span>}
          </div>
          {needsApproval && can('inventory.approve') && (
            <label className="flex cursor-pointer items-center gap-2 text-[13px] font-semibold text-ink-2">
              <input type="checkbox" className="size-4 accent-[var(--color-pine)]" checked={approveNow} disabled={locked} onChange={(e) => setApproveNow(e.target.checked)} />
              同时以负责人身份确认
            </label>
          )}
          {mode !== 'revise' && (
            <Button variant="secondary" disabled={locked || !!blocking} loading={phase.kind === 'submitting'} onClick={() => void send({ ...body('save'), clientKey })}>
              存草稿
            </Button>
          )}
          <Button variant="primary" size="lg" disabled={locked || !!blocking} loading={phase.kind === 'submitting'} icon={<CircleCheck className="size-[18px]" />} onClick={() => void send({ ...body('submit'), clientKey })}>
            {mode === 'revise' ? '提交改版' : needsApproval ? (approveNow ? '提交并确认' : '提交确认') : '提交'}
          </Button>
        </div>
      </footer>
      <MaterialDialog
        editing={creating ? 'new' : null}
        onClose={() => setCreating(null)}
        initial={
          creating
            ? { name: creating.name, specification: creating.details.slice(0, 80), inventoryUnit: creating.unit, purchaseUnit: creating.unit, supplierId: supplierId ? String(supplierId) : '' }
            : undefined
        }
        onSaved={(m) => creating && placeRequest(m, creating)}
      />
    </>
  );
}

function PoLineRow({
  row,
  locked,
  qtyRef,
  onPatch,
  onRemove,
  onUploading,
}: {
  row: { l: Line; m: Material | undefined; base: number | null; price: number | null; err: string | null; amount: number | null };
  locked: boolean;
  qtyRef: (el: HTMLInputElement | null) => void;
  onPatch: (p: Partial<Line>) => void;
  onRemove?: () => void;
  onUploading: (busy: boolean) => void;
}) {
  const unlink = (lineId: number) => onPatch({ requests: row.l.requests.filter((r) => r.lineId !== lineId) });
  const { l, m } = row;
  // 新行实时比价（按物料当前包装）；已有行用下单时的比价
  const live = useBaseline(l.materialId);
  const sameUnit = m && m.purchaseUnit === l.purchaseUnit && m.purchaseFactorMilli === l.factorMilli;
  const compare: PriceCompare | null =
    l.id && l.compare
      ? row.price !== null && l.compare.baseline
        ? { baseline: l.compare.baseline, changePercent: priceChangePercent(l.compare.baseline.priceCents, row.price) }
        : l.compare
      : sameUnit && live.data
        ? { baseline: live.data.baseline, changePercent: live.data.baseline && row.price !== null ? priceChangePercent(live.data.baseline.priceCents, row.price) : null }
        : null;
  const priceLocked = l.receivedMilli > 0;
  return (
    <li className={cn('grid grid-cols-1 items-start gap-x-3 gap-y-2 px-5 py-3 @lg:grid-cols-3 @4xl:grid-cols-[minmax(0,1fr)_170px_150px_120px_minmax(0,0.9fr)_40px]', row.err && 'bg-clay-soft/25')}>
      <div className="flex items-start justify-between gap-2 @lg:col-span-3 @4xl:col-span-1">
        <div className="min-w-0">
          <p className="line-clamp-2 text-[14px] leading-snug font-bold">{m?.name ?? '物料'}</p>
          <p className="truncate text-[12px] text-ink-3">
            <span className="num font-semibold">{m?.code}</span>
            {m?.specification && ` · ${m.specification}`} · 1 {l.purchaseUnit} = {formatQty(l.factorMilli)} {l.inventoryUnit}
          </p>
          {l.receivedMilli > 0 && (
            <p className="num text-[12px] font-semibold text-pine">
              已收货 {formatQty(l.receivedMilli)} {l.inventoryUnit}
            </p>
          )}
        </div>
        {onRemove && (
          <IconButton label="删除这一行" onClick={onRemove} disabled={locked} className="text-ink-3 hover:text-clay @4xl:hidden">
            <Trash2 className="size-4" />
          </IconButton>
        )}
      </div>
      <div>
        <div className="flex h-10 items-stretch overflow-hidden rounded-md border border-line-strong bg-card focus-within:border-pine focus-within:shadow-[0_0_0_3px_rgb(36_73_58/0.12)]">
          <input
            ref={qtyRef}
            value={l.qty}
            onChange={(e) => onPatch({ qty: e.target.value })}
            disabled={locked}
            inputMode="decimal"
            aria-label={`采购数量（${l.purchaseUnit}）`}
            className="num w-full min-w-0 bg-transparent px-3 text-right text-[15px] font-bold outline-none"
          />
          <span className="flex shrink-0 items-center border-l border-line bg-paper-2/70 px-2.5 text-[12.5px] font-bold text-ink-2">{l.purchaseUnit}</span>
        </div>
        <p className="num mt-1 text-right text-[11.5px] text-ink-3">{row.base !== null ? `= ${formatQty(row.base)} ${l.inventoryUnit}` : ''}</p>
      </div>
      <div>
        <MoneyInput value={l.price} disabled={locked || priceLocked} onChange={(e) => onPatch({ price: e.target.value })} aria-label={`单价（元/${l.purchaseUnit}）`} className="h-10 text-right" />
        <p className="mt-1 text-right text-[11.5px] text-ink-3">{priceLocked ? '已有收货，单价锁定' : `元 / ${l.purchaseUnit}`}</p>
      </div>
      <div className="text-right @4xl:pt-2">{row.amount !== null ? <Money cents={row.amount} className="text-[15px] font-bold" /> : <span className="text-ink-4">—</span>}</div>
      <div className="@4xl:pt-2.5">
        <CompareChip compare={compare} unit={l.purchaseUnit} />
      </div>
      <span className="hidden justify-self-end @4xl:block">
        {onRemove && (
          <IconButton label="删除这一行" onClick={onRemove} disabled={locked} className="text-ink-3 hover:text-clay">
            <Trash2 className="size-4" />
          </IconButton>
        )}
      </span>
      <div className="flex flex-col gap-2 @lg:col-span-3 @4xl:col-span-full">
        <div className="flex flex-wrap items-start gap-3">
          <Input
            aria-label={`${m?.name ?? '物料'} 的规格`}
            value={l.spec}
            maxLength={80}
            disabled={locked}
            onChange={(e) => onPatch({ spec: e.target.value })}
            placeholder="规格：颜色、尺寸、型号等（选填，库管收货时能看到）"
            className="h-9 max-w-md min-w-[200px] flex-1"
          />
          <ImagePicker value={l.images} onChange={(images) => onPatch({ images })} disabled={locked} onBusyChange={onUploading} />
        </div>
        {l.requests.length > 0 && (
          <p className="flex flex-wrap items-center gap-1.5 text-[12px] text-ink-3" data-testid="po-line-requests">
            <ClipboardList className="size-3.5" />
            需求
            {l.requests.map((r) => (
              <span key={r.lineId} className="inline-flex items-center gap-1 rounded-full bg-pine-tint px-2 py-0.5 font-semibold text-pine">
                <span className="num">{r.requestNo}</span>
                {r.departmentName} {formatQty(r.qtyMilli)} {r.unit}
                {!locked && (
                  <button type="button" aria-label={`不再关联 ${r.requestNo} 的 ${r.name}`} onClick={() => unlink(r.lineId)} className="rounded-full p-0.5 hover:bg-pine/10">
                    <X className="size-3" />
                  </button>
                )}
              </span>
            ))}
          </p>
        )}
      </div>
      {row.err && <p className="text-[12px] font-semibold text-clay @lg:col-span-3 @4xl:col-span-full">{row.err}</p>}
    </li>
  );
}
