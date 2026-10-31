// 提需求单 / 修改需求单（v0.7.8，飞书需求 RQ-005 第二步）。
// 每一行：从物料档案里选已有的物料，或写新产品（新产品必须有参考链接和至少一张图片）；用途与费用报销同一套固定选项。
// 部门申购只能给员工档案里的所属部门提；店主与采购可以替任何部门提。
// 断网时「结果待确认」：提交前把编号和原请求存在本机并读回核对，存不了就不提交；刷新后仍可查回、重新提交或作废。

import { useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { ArrowLeft, CircleAlert, CircleCheck, ClipboardList, Plus, Trash2 } from 'lucide-react';
import { centsToInput, formatAmount, parseYuan } from '@shared/money';
import { formatQty, parseQty } from '@shared/quantity';
import { MAX_LINE_IMAGES, type ImageRef, type PurchaseRequest, type RequestMeta } from '@shared/requests';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, useErpPending } from '../../lib/erpPending';
import { useCan, useSession } from '../../lib/session';
import { cn, uuid } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { ImagePicker } from '../../components/Images';
import { useToast } from '../../components/Toast';
import { Button, Field, Input, MoneyInput, Notice, Segmented, Select, Skeleton } from '../../components/ui';
import { useInvalidateRequests, useRequest, useRequestMeta } from './queries';

interface FormLine {
  key: string;
  kind: 'material' | 'new';
  materialId: number | null;
  name: string;
  purpose: string;
  qty: string;
  unit: string;
  refPrice: string;
  link: string;
  details: string;
  note: string;
  images: ImageRef[];
}

const blankLine = (): FormLine => ({
  key: uuid(),
  kind: 'new',
  materialId: null,
  name: '',
  purpose: '',
  qty: '',
  unit: '',
  refPrice: '',
  link: '',
  details: '',
  note: '',
  images: [],
});

const LINK = /^https?:\/\/\S+$/i;

export function RequestFormPage({ mode }: { mode: 'new' | 'edit' }) {
  const { id } = useParams();
  const can = useCan();
  const session = useSession();
  const meta = useRequestMeta();
  const existing = useRequest(mode === 'edit' ? Number(id) : null);
  if (!can('request.create')) return <Navigate to="/erp/requests" replace />;
  if (meta.error) return <Notice tone="error" title={errorMessage(meta.error)} className="m-7" />;
  if (!meta.data || (mode === 'edit' && !existing.data && !existing.error)) return <Skeleton className="m-7 h-96" />;
  if (mode === 'edit') {
    if (existing.error) return <Notice tone="error" title={errorMessage(existing.error)} className="m-7" />;
    const r = existing.data!;
    const editable = (r.status === 'submitted' || r.status === 'returned') && (r.requester.id === session.staff.id || session.staff.role === 'owner');
    if (!editable) return <Navigate to={`/erp/requests?request=${r.id}`} replace />;
    return <RequestForm meta={meta.data} existing={r} />;
  }
  return <RequestForm meta={meta.data} />;
}

function linesFrom(r: PurchaseRequest): FormLine[] {
  return r.lines.map((l) => ({
    key: uuid(),
    kind: l.materialId ? 'material' : 'new',
    materialId: l.materialId,
    name: l.name,
    purpose: l.purpose,
    qty: formatQty(l.qtyMilli).replace(/,/g, ''),
    unit: l.unit,
    refPrice: l.refPriceCents !== null ? centsToInput(l.refPriceCents) : '',
    link: l.link,
    details: l.details,
    note: l.note,
    images: l.images,
  }));
}

function RequestForm({ meta, existing }: { meta: RequestMeta; existing?: PurchaseRequest }) {
  const session = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const invalidate = useInvalidateRequests();
  const pending = useErpPending(['purchase_request']);
  const free = meta.me.canReview || session.staff.role === 'owner';
  const [departmentId, setDepartmentId] = useState<number | null>(existing?.department.id ?? meta.me.departmentId);
  const [needBy, setNeedBy] = useState(existing?.needBy ?? '');
  const [note, setNote] = useState(existing?.note ?? '');
  const [lines, setLines] = useState<FormLine[]>(existing ? linesFrom(existing) : [blankLine()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertainEdit, setUncertainEdit] = useState(false);
  const materials = new Map(meta.materials.map((m) => [m.id, m]));

  const rows = lines.map((l) => {
    const qty = parseQty(l.qty, 3);
    const price = l.refPrice.trim() ? parseYuan(l.refPrice) : null;
    const isNew = l.kind === 'new';
    const err =
      l.kind === 'material' && !l.materialId
        ? '请选物料'
        : !l.name.trim()
          ? '请填写产品名'
          : !l.purpose
            ? '请选用途'
            : qty === null || qty <= 0
              ? '请填写数量'
              : !l.unit.trim()
                ? '请填写单位'
                : l.refPrice.trim() && price === null
                  ? '参考单价格式不正确'
                  : isNew && !LINK.test(l.link.trim())
                    ? '新产品要填参考链接（http 或 https 开头）'
                    : !isNew && l.link.trim() && !LINK.test(l.link.trim())
                      ? '链接要以 http 或 https 开头'
                      : isNew && l.images.length === 0
                        ? '新产品要至少上传一张图片'
                        : null;
    return { l, qty, price, err };
  });

  const deptName = meta.departments.find((d) => d.id === departmentId)?.name ?? meta.me.departmentName ?? '';
  const blocking =
    !existing && pending.length > 0
      ? '上一张需求单结果待确认，请先在上方查回、重新提交或作废'
      : !departmentId
        ? free
          ? '请选择部门'
          : '你的员工档案里还没有填所属部门，请店主在「后台 → 员工」里补上'
        : needBy && needBy < session.calendarToday
          ? '需要日期不能早于今天'
          : rows.find((r) => r.err)?.err ?? null;

  const setLine = (key: string, patch: Partial<FormLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const payloadLines = () =>
    rows.map(({ l, qty, price }) => ({
      materialId: l.kind === 'material' ? l.materialId : null,
      name: l.name.trim(),
      purpose: l.purpose,
      qtyMilli: qty,
      unit: l.unit.trim(),
      link: l.link.trim(),
      details: l.details.trim(),
      refPriceCents: price,
      note: l.note.trim(),
      imageIds: l.images.map((i) => i.id),
    }));

  const submit = async () => {
    if (blocking) return;
    setBusy(true);
    setError(null);
    try {
      if (existing) {
        const r = await api.put<PurchaseRequest>(`/api/erp/requests/${existing.id}`, { departmentId: null, needBy: needBy || null, note: note.trim(), lines: payloadLines() });
        await invalidate();
        toast({ tone: 'success', title: '需求单已修改，重新等待审核', body: r.docNo });
        navigate(`/erp/requests?request=${r.id}`);
      } else {
        // 每次提交用新的操作编号；结果不明的那一笔存在本机，由页面顶部按原编号处理
        const body = { clientKey: uuid(), departmentId: free ? departmentId : null, needBy: needBy || null, note: note.trim(), lines: payloadLines() };
        const first = rows[0]?.l.name.trim() ?? '';
        const r = await sendErpOp<{ request: PurchaseRequest }>({
          key: body.clientKey,
          type: 'purchase_request',
          url: '/api/erp/requests',
          body,
          summary: `${deptName} · ${first}${rows.length > 1 ? ` 等 ${rows.length} 行` : ''}`,
          staffName: session.staff.displayName,
        });
        await invalidate();
        toast({ tone: 'success', title: '需求单已提交，等待采购审核', body: r.request.docNo });
        navigate(`/erp/requests?request=${r.request.id}`);
      }
    } catch (e) {
      if (e instanceof UncertainError) {
        if (existing) setUncertainEdit(true);
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const title = existing ? `修改需求单 · ${existing.docNo}` : '提需求';
  return (
    <>
      <PageHeader
        dateMode="calendar"
        title={
          <span className="flex items-center gap-2.5">
            <Link to={existing ? `/erp/requests?request=${existing.id}` : '/erp/requests'} className="-ml-1 flex size-8 items-center justify-center rounded-md text-ink-3 hover:bg-paper-2 hover:text-ink" aria-label="返回需求单">
              <ArrowLeft className="size-[18px]" />
            </Link>
            <span className="flex size-8 items-center justify-center rounded-full bg-pine-soft text-pine">
              <ClipboardList className="size-4" />
            </span>
            {title}
          </span>
        }
        subtitle="已有的物料从档案里选；新产品写名称，必须带参考链接和图片。提交后由采购审核。"
      />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1080px] space-y-4 px-5 py-5 md:px-7" data-testid="request-form">
          {!existing && <ErpPendingPanel types={['purchase_request']} onFound={(_, ref) => navigate(`/erp/requests?request=${ref.refId}`)} />}
          {existing?.status === 'returned' && existing.reason && <Notice tone="warning" title={`采购退回：${existing.reason}`}>改好后提交，重新等待审核。</Notice>}
          <section className="grid gap-4 rounded-lg border border-line bg-card p-5 shadow-card sm:grid-cols-3">
            <Field label="部门" htmlFor="rq-dept" hint={free ? undefined : '员工档案里的所属部门'}>
              {free && !existing ? (
                <Select id="rq-dept" value={departmentId ?? ''} disabled={busy} onChange={(e) => setDepartmentId(Number(e.target.value) || null)} data-testid="rq-dept">
                  <option value="">选择部门</option>
                  {meta.departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              ) : (
                <p className="flex h-10 items-center text-[14px] font-semibold" data-testid="rq-dept-fixed">
                  {deptName || '未填所属部门'}
                </p>
              )}
            </Field>
            <Field label="需要日期" htmlFor="rq-need" hint="选填">
              <Input id="rq-need" type="date" value={needBy} min={session.calendarToday} disabled={busy} onChange={(e) => setNeedBy(e.target.value)} className="h-10" />
            </Field>
            <Field label="备注" htmlFor="rq-note">
              <Input id="rq-note" value={note} maxLength={200} disabled={busy} onChange={(e) => setNote(e.target.value)} placeholder="可选" className="h-10" />
            </Field>
          </section>

          <ul className="space-y-3">
            {rows.map(({ l, err }, i) => (
              <li key={l.key} className={cn('rounded-lg border border-line bg-card p-4 shadow-card', err && l.name.trim() && 'border-clay/40')} data-testid={`rq-line-${i}`}>
                <div className="mb-3 flex flex-wrap items-center gap-3">
                  <span className="text-[13px] font-bold text-ink-2">第 {i + 1} 行</span>
                  <Segmented
                    size="sm"
                    ariaLabel={`第 ${i + 1} 行是已有物料还是新产品`}
                    value={l.kind}
                    onChange={(v) => !busy && setLine(l.key, { kind: v, materialId: v === 'new' ? null : l.materialId })}
                    options={[
                      { value: 'material', label: '已有物料' },
                      { value: 'new', label: '新产品' },
                    ]}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Trash2 className="size-4" />}
                    className="ml-auto"
                    disabled={busy || lines.length === 1}
                    onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                    aria-label={`删除第 ${i + 1} 行`}
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-6">
                  {l.kind === 'material' ? (
                    <Field label="物料" className="sm:col-span-3">
                      <Select
                        aria-label={`第 ${i + 1} 行物料`}
                        value={l.materialId ?? ''}
                        disabled={busy}
                        onChange={(e) => {
                          const m = materials.get(Number(e.target.value));
                          setLine(l.key, { materialId: m?.id ?? null, name: m ? m.name.slice(0, 40) : l.name, unit: m && !l.unit.trim() ? m.purchaseUnit.slice(0, 8) : l.unit });
                        }}
                        data-testid={`rq-material-${i}`}
                      >
                        <option value="">选择物料</option>
                        {meta.materials.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.code} · {m.name}
                            {m.specification ? ` · ${m.specification}` : ''}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  ) : (
                    <Field label="产品名" className="sm:col-span-3">
                      <Input aria-label={`第 ${i + 1} 行产品名`} value={l.name} maxLength={40} disabled={busy} onChange={(e) => setLine(l.key, { name: e.target.value })} className="h-10" data-testid={`rq-name-${i}`} />
                    </Field>
                  )}
                  <Field label="用途" className="sm:col-span-3">
                    <Select aria-label={`第 ${i + 1} 行用途`} value={l.purpose} disabled={busy} onChange={(e) => setLine(l.key, { purpose: e.target.value })} data-testid={`rq-purpose-${i}`}>
                      <option value="">选择用途</option>
                      {meta.purposes.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="数量" className="sm:col-span-2">
                    <Input aria-label={`第 ${i + 1} 行数量`} inputMode="decimal" value={l.qty} disabled={busy} onChange={(e) => setLine(l.key, { qty: e.target.value })} className="h-10 text-right" data-testid={`rq-qty-${i}`} />
                  </Field>
                  <Field label="单位" className="sm:col-span-2">
                    <Input aria-label={`第 ${i + 1} 行单位`} value={l.unit} maxLength={8} disabled={busy} onChange={(e) => setLine(l.key, { unit: e.target.value })} className="h-10" data-testid={`rq-unit-${i}`} />
                  </Field>
                  <Field label="参考单价" hint="选填" className="sm:col-span-2">
                    <MoneyInput aria-label={`第 ${i + 1} 行参考单价`} value={l.refPrice} disabled={busy} onChange={(e) => setLine(l.key, { refPrice: e.target.value })} className="h-10 text-right" />
                  </Field>
                  <Field label="参考链接" hint={l.kind === 'new' ? '新产品必填' : '选填'} className="sm:col-span-6">
                    <Input
                      aria-label={`第 ${i + 1} 行参考链接`}
                      value={l.link}
                      maxLength={500}
                      inputMode="url"
                      placeholder="https://"
                      disabled={busy}
                      onChange={(e) => setLine(l.key, { link: e.target.value })}
                      className="h-10"
                      data-testid={`rq-link-${i}`}
                    />
                  </Field>
                  <Field label="产品详情 / 规格" className="sm:col-span-3">
                    <Input aria-label={`第 ${i + 1} 行详情`} value={l.details} maxLength={200} disabled={busy} onChange={(e) => setLine(l.key, { details: e.target.value })} placeholder="颜色、尺寸、型号等" className="h-10" />
                  </Field>
                  <Field label="备注" className="sm:col-span-3">
                    <Input aria-label={`第 ${i + 1} 行备注`} value={l.note} maxLength={100} disabled={busy} onChange={(e) => setLine(l.key, { note: e.target.value })} placeholder="可选" className="h-10" />
                  </Field>
                  <Field label="图片" hint={`${l.kind === 'new' ? '新产品至少一张；' : ''}最多 ${MAX_LINE_IMAGES} 张，上传前自动压缩`} className="sm:col-span-6">
                    <ImagePicker value={l.images} onChange={(images) => setLine(l.key, { images })} disabled={busy} testId={`rq-images-${i}`} />
                  </Field>
                </div>
                {err && l.name.trim() && <p className="mt-2 text-[12px] font-semibold text-clay">{err}</p>}
              </li>
            ))}
          </ul>
          <Button variant="secondary" size="sm" icon={<Plus className="size-4" />} disabled={busy || lines.length >= 50} onClick={() => setLines((ls) => [...ls, blankLine()])} data-testid="rq-add-line">
            加一行
          </Button>

          {error && (
            <Notice tone="error" title={error} icon={<CircleAlert className="size-5" />}>
              需求单没有提交，内容仍保留在页面上。
            </Notice>
          )}
          {uncertainEdit && (
            <Notice tone="warning" title="结果待确认">
              修改可能已经保存（修改不会产生新单）。请回到需求单里查看，没改上再改一次。
            </Notice>
          )}
        </div>
      </div>
      <footer className="shrink-0 border-t border-line bg-card/95 px-5 py-3 backdrop-blur md:px-7">
        <div className="mx-auto flex w-full max-w-[1080px] flex-wrap items-center gap-x-5 gap-y-2.5">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1">
            <span className="text-[12.5px] font-semibold text-ink-3">{rows.length} 行</span>
            {rows.some((r) => r.price !== null && r.qty !== null) && (
              <span className="text-[12.5px] text-ink-3">
                参考金额约 ¥{formatAmount(rows.reduce((t, r) => t + (r.price !== null && r.qty !== null ? Math.round((r.price * r.qty) / 1000) : 0), 0))}
              </span>
            )}
            {blocking && <span className="text-[12.5px] font-semibold text-clay">{blocking}</span>}
          </div>
          <Button variant="primary" size="lg" disabled={busy || !!blocking} loading={busy} icon={<CircleCheck className="size-[18px]" />} onClick={() => void submit()} data-testid="rq-submit">
            {existing ? '提交修改' : '提交需求单'}
          </Button>
        </div>
      </footer>
    </>
  );
}
