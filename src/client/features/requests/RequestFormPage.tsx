// 提需求单 / 修改需求单（v0.7.8，飞书需求 RQ-005 第二步）。
// 每一行：从物料档案里选已有的物料，或写新产品（新产品必须有参考链接和至少一张图片）；用途与费用报销同一套固定选项。
// 部门申购只能给员工档案里的所属部门提；店主与采购可以替任何部门提。
// 断网时「结果待确认」：提交前把编号和原请求存在本机并读回核对，存不了就不提交；刷新后仍可查回、重新提交或作废。
// 草稿（供应链二次整改 03，docs/ERP_ROUND2.md）：填的内容每 30 秒自动存成草稿（存在服务端、只有本人看得到），离开、关页面时再存一次；
// 进这一页时有没提交的草稿就在顶部问要不要继续填；草稿带着已经上传的图片；提交成功后草稿自动清掉。

import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import { ArrowLeft, CircleAlert, CircleCheck, ClipboardList, Inbox, Plus, Trash2 } from 'lucide-react';
import { centsToInput, formatAmount, parseYuan } from '@shared/money';
import { formatQty, parseQty } from '@shared/quantity';
import {
  DRAFT_AUTOSAVE_SECONDS,
  DRAFT_LIMITS,
  MAX_LINE_IMAGES,
  type ImageRef,
  type PurchaseRequest,
  type RequestDraft,
  type RequestDraftBody,
  type RequestDraftSaveInput,
  type RequestMeta,
  type RequestPriority,
} from '@shared/requests';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, useErpPending } from '../../lib/erpPending';
import { useCan, useSession } from '../../lib/session';
import { cn, formatDateTime, formatTime, uuid } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { ImagePicker } from '../../components/Images';
import { useToast } from '../../components/Toast';
import { Button, Field, Input, MoneyInput, Notice, Segmented, Select, Skeleton } from '../../components/ui';
import { DraftBox, draftLabel } from './DraftBox';
import { deleteDraft, DRAFT_KEY, fetchDraft, useDraft, useDraftAutosave, useDrafts, useInvalidateDrafts, type DraftStatus } from './drafts';
import { PriorityDot } from './parts';
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
    return <EditRequest key={r.id} meta={meta.data} existing={r} />;
  }
  return <NewRequest meta={meta.data} />;
}

/**
 * 提需求：这一页有自己的草稿编号，第一次自动保存以后写进地址栏（刷新能回到刚才填的内容）；
 * 地址栏里带着别的草稿编号（从草稿箱、顶部提示点「继续填写」）就把那一份填回页面。
 */
function NewRequest({ meta }: { meta: RequestMeta }) {
  const [params, setParams] = useSearchParams();
  const [own, setOwn] = useState(uuid);
  // 「载入最新的」之后换一个编号，让表单按新读到的内容重新装一次
  const [nonce, setNonce] = useState(0);
  const raw = params.get('draft');
  const urlKey = raw && DRAFT_KEY.test(raw) ? raw.toLowerCase() : null;
  const resuming = urlKey !== null && urlKey !== own;
  const draft = useDraft(resuming ? urlKey : null);
  const startBlank = () => {
    setOwn(uuid());
    setParams({}, { replace: true });
  };
  if (resuming && draft.isPending) return <Skeleton className="m-7 h-96" />;
  // 修改某张需求单的草稿走修改页
  if (resuming && draft.data?.request) return <Navigate to={`/erp/requests/${draft.data.request.id}/edit`} replace />;
  if (resuming && !draft.data) {
    return (
      <div className="m-7 max-w-[720px]" data-testid="rq-draft-gone">
        <Notice
          tone="warning"
          title="这份草稿已经不在了"
          action={
            <Button size="sm" variant="primary" onClick={startBlank}>
              填一张新的
            </Button>
          }
        >
          已经提交、删除或过期的草稿不能再继续填。{draft.error ? `（${errorMessage(draft.error)}）` : ''}
        </Notice>
      </div>
    );
  }
  const key = resuming ? urlKey : own;
  return (
    <RequestForm
      key={`${key}:${nonce}`}
      meta={meta}
      draftKey={key}
      draft={resuming ? draft.data : undefined}
      onDraftCreated={() => setParams({ draft: key }, { replace: true })}
      onReloadDraft={() => {
        // 这一页自己建的草稿：换掉自己的编号，按地址栏里的那一份重新读；继续填写的那一份：重新读一次
        if (resuming) void draft.refetch().then(() => setNonce((n) => n + 1));
        else setOwn(uuid());
      }}
    />
  );
}

/**
 * 修改需求单：一张需求单一份修改草稿。上次改到一半的内容还在时先问要不要继续（继续 = 把草稿填回页面；不用 = 删掉草稿，按需求单现在的内容改）。
 * 选定以后不再跟着草稿列表变（这一页自己存出来的草稿也会出现在列表里）。
 */
function EditRequest({ meta, existing }: { meta: RequestMeta; existing: PurchaseRequest }) {
  const prior = useDrafts(existing.id);
  const invalidateDrafts = useInvalidateDrafts();
  const [own, setOwn] = useState(uuid);
  const [chosen, setChosen] = useState<{ key: string; draft?: RequestDraft } | null>(null);
  const [busy, setBusy] = useState<'continue' | 'discard' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const first = prior.data?.drafts[0] ?? null;
  const settled = prior.isSuccess || prior.isError;
  useEffect(() => {
    if (!chosen && settled && !prior.isFetching && !first) setChosen({ key: own });
  }, [chosen, settled, prior.isFetching, first, own]);

  if (chosen) {
    return (
      <RequestForm
        key={chosen.key}
        meta={meta}
        existing={existing}
        draftKey={chosen.key}
        draft={chosen.draft}
        onReloadDraft={() => {
          setOwn(uuid());
          setChosen(null);
          void prior.refetch();
        }}
      />
    );
  }
  if (!first || prior.isFetching) return <Skeleton className="m-7 h-96" />;
  const resume = async () => {
    setBusy('continue');
    setError(null);
    try {
      setChosen({ key: first.key, draft: await fetchDraft(first.key) });
    } catch (e) {
      setError(`草稿没读出来：${errorMessage(e)}`);
    } finally {
      setBusy(null);
    }
  };
  const discard = async () => {
    setBusy('discard');
    setError(null);
    try {
      await deleteDraft(first.key);
      await invalidateDrafts();
      setChosen({ key: own });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="m-7 max-w-[720px] space-y-3" data-testid="rq-draft-choice">
      <Notice
        tone="info"
        title="有未完成的草稿，是否继续填写？"
        action={
          <>
            <Button size="sm" variant="primary" disabled={busy !== null} loading={busy === 'continue'} onClick={() => void resume()} data-testid="rq-draft-continue">
              继续填写
            </Button>
            <Button size="sm" variant="secondary" disabled={busy !== null} loading={busy === 'discard'} onClick={() => void discard()} data-testid="rq-draft-discard">
              不用了，按需求单现在的内容改
            </Button>
          </>
        }
      >
        {existing.docNo} 上次改到一半的内容还在：{first.title || '还没填产品名'}
        {first.lineCount > 1 ? ` 等 ${first.lineCount} 行` : ''}，保存于 {formatDateTime(first.updatedAt)}。选「不用了」会删掉这份草稿。
      </Notice>
      {error && <Notice tone="error" title={error} />}
    </div>
  );
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

/** 草稿填回页面：用途、物料已经不在选项里的清掉，让人重新选 */
function linesFromDraft(body: RequestDraftBody, meta: RequestMeta): FormLine[] {
  const materialIds = new Set(meta.materials.map((m) => m.id));
  const rows = body.lines.map((l) => ({
    key: uuid(),
    kind: l.kind,
    materialId: l.materialId !== null && materialIds.has(l.materialId) ? l.materialId : null,
    name: l.name,
    purpose: meta.purposes.includes(l.purpose) ? l.purpose : '',
    qty: l.qty,
    unit: l.unit,
    refPrice: l.refPrice,
    link: l.link,
    details: l.details,
    note: l.note,
    images: l.images,
  }));
  return rows.length ? rows : [blankLine()];
}

const lineBlank = (l: FormLine) =>
  l.materialId === null && l.images.length === 0 && ![l.name, l.purpose, l.qty, l.unit, l.refPrice, l.link, l.details, l.note].some((s) => s.trim());

function RequestForm({
  meta,
  existing,
  draftKey,
  draft,
  onDraftCreated,
  onReloadDraft,
}: {
  meta: RequestMeta;
  existing?: PurchaseRequest;
  /** 这一页的草稿编号 */
  draftKey: string;
  /** 继续填写的草稿：页面按它的内容打开 */
  draft?: RequestDraft;
  onDraftCreated?: () => void;
  /** 草稿在别处改过：按最新的重新打开 */
  onReloadDraft?: () => void;
}) {
  const session = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const invalidate = useInvalidateRequests();
  const invalidateDrafts = useInvalidateDrafts();
  const pending = useErpPending(['purchase_request']);
  const free = meta.me.canReview || session.staff.role === 'owner';
  const [departmentId, setDepartmentId] = useState<number | null>(() => {
    if (existing) return existing.department.id;
    // 草稿里的部门：能替别的部门提的人按草稿（部门停用了就重新选），部门申购永远是自己的所属部门
    if (draft && free) return meta.departments.some((d) => d.id === draft.body.departmentId) ? draft.body.departmentId : null;
    return meta.me.departmentId;
  });
  const [needBy, setNeedBy] = useState(draft?.body.needBy ?? existing?.needBy ?? '');
  // 采购优先级（8.0.1 采购组整改 02）：紧急（红点）/ 普通（绿点）
  const [priority, setPriority] = useState<RequestPriority>(draft?.body.priority ?? existing?.priority ?? 'normal');
  const [note, setNote] = useState(draft?.body.note ?? existing?.note ?? '');
  const [lines, setLines] = useState<FormLine[]>(() => (draft ? linesFromDraft(draft.body, meta) : existing ? linesFrom(existing) : [blankLine()]));
  const [boxOpen, setBoxOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertainEdit, setUncertainEdit] = useState(false);
  // 还在上传图片的行：上传完之前不能提交
  const [uploading, setUploading] = useState<ReadonlySet<string>>(new Set());
  const setLineUploading = (key: string, busy: boolean) =>
    setUploading((s) => {
      if (busy === s.has(key)) return s;
      const next = new Set(s);
      if (busy) next.add(key);
      else next.delete(key);
      return next;
    });
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
      : uploading.size > 0
        ? '图片还在上传，请稍等'
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

  // ── 草稿：页面上填到哪存到哪（不按提交的规则核对），各栏只按草稿的长度上限截一下 ──
  const draftSnapshot = (): { body: RequestDraftSaveInput['body']; blank: boolean } => ({
    body: {
      departmentId,
      needBy,
      priority,
      note: note.slice(0, DRAFT_LIMITS.note),
      lines: lines.map((l) => ({
        kind: l.kind,
        materialId: l.materialId,
        name: l.name.slice(0, DRAFT_LIMITS.name),
        purpose: l.purpose.slice(0, DRAFT_LIMITS.purpose),
        qty: l.qty.slice(0, DRAFT_LIMITS.qty),
        unit: l.unit.slice(0, DRAFT_LIMITS.unit),
        refPrice: l.refPrice.slice(0, DRAFT_LIMITS.refPrice),
        link: l.link.slice(0, DRAFT_LIMITS.link),
        details: l.details.slice(0, DRAFT_LIMITS.details),
        note: l.note.slice(0, DRAFT_LIMITS.lineNote),
        imageIds: l.images.map((i) => i.id),
      })),
    },
    // 新提的单一个字都没填：不存草稿（只改了优先级、部门不算）
    blank: !existing && !note.trim() && !needBy && lines.every(lineBlank),
  });
  // 打开时的内容：与它一样就不用存（修改需求单没动过、继续填写的草稿没再改）
  const baseline = useRef<string | null>(null);
  if (baseline.current === null) baseline.current = JSON.stringify(draftSnapshot().body);
  const autosave = useDraftAutosave({
    draftKey,
    initialRev: draft?.rev ?? 0,
    initialSavedAt: draft?.updatedAt,
    baseline: baseline.current,
    requestId: existing?.id ?? null,
    snapshot: draftSnapshot,
    // 正在提交、上一张需求单结果待确认时先不存
    paused: busy || (!existing && pending.length > 0),
    onCreated: onDraftCreated,
    onSaved: () => void invalidateDrafts(),
    onLeaveSaved: () => toast({ tone: 'info', title: '已保存草稿', body: '下次进「提需求」或在草稿箱里可以接着填。' }),
  });

  const submit = async () => {
    if (blocking) return;
    setBusy(true);
    setError(null);
    try {
      if (existing) {
        const r = await api.put<PurchaseRequest>(`/api/erp/requests/${existing.id}`, { departmentId: null, needBy: needBy || null, priority, note: note.trim(), lines: payloadLines(), draftKey });
        autosave.stop();
        await invalidate();
        toast({ tone: 'success', title: '需求单已修改，重新等待审核', body: r.docNo });
        navigate(`/erp/requests?request=${r.id}`);
      } else {
        // 每次提交用新的操作编号；结果不明的那一笔存在本机，由页面顶部按原编号处理
        // 带上这一页的草稿编号：提交成功时服务端在同一个事务里把草稿关掉
        const body = { clientKey: uuid(), departmentId: free ? departmentId : null, needBy: needBy || null, priority, note: note.trim(), lines: payloadLines(), draftKey };
        const first = rows[0]?.l.name.trim() ?? '';
        const r = await sendErpOp<{ request: PurchaseRequest }>({
          key: body.clientKey,
          type: 'purchase_request',
          url: '/api/erp/requests',
          body,
          summary: `${deptName} · ${first}${rows.length > 1 ? ` 等 ${rows.length} 行` : ''}`,
          staffName: session.staff.displayName,
        });
        autosave.stop();
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
        actions={
          <Button variant="secondary" size="sm" icon={<Inbox className="size-4" />} onClick={() => setBoxOpen(true)} data-testid="rq-draft-box">
            草稿箱
          </Button>
        }
      />
      <DraftBox open={boxOpen} onClose={() => setBoxOpen(false)} currentKey={draftKey} />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1080px] space-y-4 px-5 py-5 md:px-7" data-testid="request-form">
          {!existing && <ErpPendingPanel types={['purchase_request']} onFound={(_, ref) => navigate(`/erp/requests?request=${ref.refId}`)} />}
          {!existing && !draft && <ResumeBanner currentKey={draftKey} onOpenBox={() => setBoxOpen(true)} onResume={(key) => navigate(`/erp/requests/new?draft=${key}`)} />}
          {draft && autosave.status.state !== 'stopped' && (
            <Notice tone="info" title="已经接着上次的草稿" data-testid="rq-draft-resumed">
              这是 {formatDateTime(draft.updatedAt)} 保存的草稿，填过的内容和图片都在；接着填，照旧每 {DRAFT_AUTOSAVE_SECONDS} 秒自动保存。
            </Notice>
          )}
          {autosave.status.state === 'stopped' && (
            <Notice
              tone={autosave.status.reason === 'changed' ? 'warning' : 'info'}
              title={autosave.status.message}
              data-testid="rq-draft-stopped"
              action={
                autosave.status.reason === 'changed' && onReloadDraft ? (
                  <Button size="sm" variant="secondary" onClick={onReloadDraft} data-testid="rq-draft-reload">
                    载入最新的
                  </Button>
                ) : undefined
              }
            >
              {autosave.status.reason === 'changed' ? '这一页上的内容还在，可以照常提交；要接着别处改的那一版，点「载入最新的」（这一页没存的改动不会带过去）。' : '这一页上的内容还在，可以照常提交。'}
            </Notice>
          )}
          {autosave.status.state === 'full' && (
            <Notice
              tone="warning"
              title={autosave.status.message}
              data-testid="rq-draft-full"
              action={
                <Button size="sm" variant="secondary" onClick={() => setBoxOpen(true)}>
                  打开草稿箱
                </Button>
              }
            />
          )}
          {existing?.status === 'returned' && existing.reason && <Notice tone="warning" title={`采购退回：${existing.reason}`}>改好后提交，重新等待审核。</Notice>}
          {meta.cutoff.enabled && (
            <Notice tone="info" title={`每天 ${meta.cutoff.time} 截单`} data-testid="rq-cutoff">
              {meta.cutoff.time} 以后提交的需求单照常提交，当天不能审核通过，第二天起可以。急需的选「紧急」并尽量在截单前提交，来不及的请找采购走急采。
            </Notice>
          )}
          <section className="grid gap-4 rounded-lg border border-line bg-card p-5 shadow-card sm:grid-cols-2 lg:grid-cols-4">
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
            <Field label="采购优先级" hint="红点紧急、绿点普通；采购审核时紧急的排在前面">
              <Segmented
                ariaLabel="采购优先级"
                value={priority}
                onChange={(v) => setPriority(v)}
                options={[
                  { value: 'normal', label: <span className="inline-flex items-center gap-1.5"><PriorityDot priority="normal" />普通</span> },
                  { value: 'urgent', label: <span className="inline-flex items-center gap-1.5"><PriorityDot priority="urgent" />紧急</span> },
                ]}
              />
            </Field>
            <Field label="期望到货日期" htmlFor="rq-need" hint="选填">
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
                    <ImagePicker
                      value={l.images}
                      onChange={(images) => setLine(l.key, { images })}
                      disabled={busy}
                      testId={`rq-images-${i}`}
                      onBusyChange={(b) => setLineUploading(l.key, b)}
                    />
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
            <DraftStatusText status={autosave.status} />
          </div>
          <Button variant="primary" size="lg" disabled={busy || !!blocking} loading={busy} icon={<CircleCheck className="size-[18px]" />} onClick={() => void submit()} data-testid="rq-submit">
            {existing ? '提交修改' : '提交需求单'}
          </Button>
        </div>
      </footer>
    </>
  );
}

/** 页脚的小字：草稿存到哪一步了（自动保存不弹提示） */
function DraftStatusText({ status }: { status: DraftStatus }) {
  const text =
    status.state === 'saved'
      ? `草稿已自动保存 ${formatTime(status.at)}`
      : status.state === 'error'
        ? status.message
        : status.state === 'idle'
          ? `填的内容每 ${DRAFT_AUTOSAVE_SECONDS} 秒自动存成草稿`
          : status.state === 'full'
            ? '草稿箱满了，这一页还没存成草稿'
            : '这一页不再自动保存草稿';
  return (
    <span className={cn('text-[12.5px]', status.state === 'error' || status.state === 'full' ? 'font-semibold text-yuzu-deep' : 'text-ink-3')} data-testid="rq-draft-status" data-state={status.state}>
      {text}
    </span>
  );
}

/** 进「提需求」页时有没提交的草稿：顶部问要不要继续填（只看新提的草稿；修改某张需求单的草稿在草稿箱里） */
function ResumeBanner({ currentKey, onOpenBox, onResume }: { currentKey: string; onOpenBox: () => void; onResume: (key: string) => void }) {
  const drafts = useDrafts();
  const [dismissed, setDismissed] = useState(false);
  const others = (drafts.data?.drafts ?? []).filter((d) => !d.request && d.key !== currentKey);
  const latest = others[0];
  if (dismissed || !latest) return null;
  return (
    <Notice
      tone="info"
      title="有未完成的草稿，是否继续填写？"
      data-testid="rq-draft-banner"
      action={
        <>
          <Button size="sm" variant="primary" onClick={() => onResume(latest.key)} data-testid="rq-draft-banner-resume">
            继续填写
          </Button>
          <Button size="sm" variant="secondary" onClick={onOpenBox} data-testid="rq-draft-banner-box">
            草稿箱（{drafts.data?.drafts.length ?? others.length}）
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDismissed(true)} data-testid="rq-draft-banner-dismiss">
            先不用
          </Button>
        </>
      }
    >
      最近一份：{draftLabel(latest)}，保存于 {formatDateTime(latest.updatedAt)}
      {others.length > 1 ? `；另有 ${others.length - 1} 份在草稿箱里` : ''}。不继续也没关系，草稿留在草稿箱里。
    </Notice>
  );
}
