import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import { ArrowLeft, CircleAlert, CircleCheck, CloudOff, Eraser, ListPlus, RotateCw, Search, Trash2 } from 'lucide-react';
import {
  COUNT_REASON_LABELS,
  COUNT_REASONS,
  DEFAULT_COUNT_BIG_CENTS,
  DEFAULT_COUNT_BIG_PCT,
  INV_DOC_META,
  isBigVariance,
  type CountReason,
  type DeptStockMeta,
  type InvDoc,
  type InvDocSummary,
  type InvDocType,
  type Material,
  type WarehouseStockRow,
} from '@shared/inventory';
import { centsToInput, parseYuan } from '@shared/money';
import { formatQty, lineAmountCents } from '@shared/quantity';
import { api, ApiError, errorMessage, UncertainError } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn, uuid } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { ImageThumbs } from '../../components/Images';
import { Money } from '../../components/Money';
import { useToast } from '../../components/Toast';
import { Badge, Button, Field, IconButton, Input, MoneyInput, Notice, Select, Skeleton, Spinner } from '../../components/ui';
import { emptyQty, MaterialPicker, qtyEntryFromMilli, QtyInput, resolveQty, type QtyEntry } from './inputs';
import { DOC_VISUAL, Qty, SimRule, StatusChip } from './parts';
import type { PoLine } from '@shared/purchasing';
import { usePo, usePos } from '../purchasing/queries';
import { useDeptDoc, useDeptMeta, useDeptStock, useInvalidateDept } from '../dept-stock/queries';
import { useCoAcceptors, useDepartments, useInvDoc, useInvDocs, useInvSettings, useInvalidateInventory, useMaterials, useSuppliers, useUsual } from './queries';

// ───────────────────────── 表单状态 ─────────────────────────

interface LineDraft {
  key: string;
  materialId: number;
  /** 领料 / 耗用 / 报损 / 期初 / 退回数量；盘点为实盘数 */
  qty: QtyEntry;
  delivered: QtyEntry;
  accepted: QtyEntry;
  /** 合格实收是否手动改过（否则跟随送达数量） */
  acceptedTouched: boolean;
  rejectReason: string;
  /** 批次与效期（8.0.7 3.3）：管效期的物料收货时填 */
  batchNo?: string;
  producedOn?: string;
  expiresOn?: string;
  /** 每采购单位价格（元） */
  price: string;
  sourceLineId: number | null;
  /** 按采购单收货：对应的采购单行 */
  poLineId: number | null;
  /** 盘点：已记下的账面数（编辑草稿时） */
  bookMilli: number | null;
  stale: boolean;
  note: string;
  /** 盘点差异的原因类别与说明（v0.7.30：大差异的行提交时必须写） */
  diffReason?: CountReason | '';
  diffNote?: string;
}

interface FormState {
  clientKey: string;
  docDate: string;
  supplierId: number | null;
  departmentId: number | null;
  sourceDocId: number | null;
  purchaseOrderId: number | null;
  /** 收货：一起验收的采购经办（#17，v0.7.11） */
  coAcceptorId: number | null;
  handler: string;
  note: string;
  /** 耗用的用途与经办人（8.0.7 2.3）：用途从「门店基本规则 → 可调的数值」的列表选，经办人默认自己 */
  usePurpose: string;
  useHandlerId: number | null;
  lines: LineDraft[];
}

const blankLine = (materialId: number, over: Partial<LineDraft> = {}): LineDraft => ({
  key: uuid(),
  materialId,
  qty: emptyQty(),
  delivered: emptyQty('pack'),
  accepted: emptyQty('pack'),
  acceptedTouched: false,
  rejectReason: '',
  price: '',
  sourceLineId: null,
  poLineId: null,
  bookMilli: null,
  stale: false,
  note: '',
  diffReason: '',
  diffNote: '',
  ...over,
});

const blankForm = (date: string): FormState => ({
  clientKey: uuid(),
  docDate: date,
  supplierId: null,
  departmentId: null,
  sourceDocId: null,
  purchaseOrderId: null,
  coAcceptorId: null,
  handler: '',
  note: '',
  usePurpose: '',
  useHandlerId: null,
  lines: [],
});

// ───────────────────────── 入口：库存（总仓）或本部门小仓（v0.7.11） ─────────────────────────

/**
 * 表单服务于哪个入口：库存页（总仓、领料与退回、按采购单收货）、本部门小仓（部门的期初、耗用、报损、盘点），
 * 或急采（8.0.1 起由采购在「采购 → 急采」登记，CG05：数据按总仓，给哪个部门买的在表头选）
 */
export interface FormScope {
  kind: 'central' | 'dept' | 'urgent';
  dept: { id: number; name: string; warehouseId: number } | null;
  /** 单据接口 */
  api: string;
  home: string;
  docLink: (id: number) => string;
  newLink: (type: InvDocType) => string;
}

const CENTRAL_SCOPE: FormScope = {
  kind: 'central',
  dept: null,
  api: '/api/inventory/docs',
  home: '/inventory',
  docLink: (id) => `/inventory/docs?doc=${id}`,
  newLink: (t) => `/inventory/new/${t}`,
};

/** 急采（8.0.1，CG05）：走库存单据接口（带 urgent 与部门），回到「采购 → 急采」 */
export const URGENT_SCOPE: FormScope = {
  kind: 'urgent',
  dept: null,
  api: '/api/inventory/docs',
  home: '/purchasing/urgent',
  docLink: (id) => `/purchasing/urgent?doc=${id}`,
  newLink: () => '/purchasing/urgent/new',
};

export function deptScope(dept: { id: number; name: string; warehouseId: number }): FormScope {
  return {
    kind: 'dept',
    dept,
    api: '/api/erp/dept-stock/docs',
    home: `/erp/dept-stock?dept=${dept.id}`,
    docLink: (id) => `/erp/dept-stock?dept=${dept.id}&doc=${id}`,
    newLink: (t) => `/erp/dept-stock/new/${t}?dept=${dept.id}`,
  };
}

/** 部门小仓能登记的单据：耗用、报损、盘点、期初（领料与退回由仓库登记；急采 8.0.1 起由采购登记） */
export const DEPT_DOC_TYPES: InvDocType[] = ['direct_use', 'damage', 'count', 'opening'];

/** 部门小仓的物料：部门的员工看不到总仓结存与参考价，库存按本部门小仓 */
function deptMaterial(m: DeptStockMeta['materials'][number], row: WarehouseStockRow | undefined): Material {
  return {
    ...m,
    refPriceCents: null,
    defaultSupplierId: null,
    defaultSupplierName: null,
    lowStockMilli: null,
    coverDays: row?.coverDays ?? null,
    tracked: true,
    active: true,
    stockMilli: row?.stockMilli ?? 0,
    deptStockMilli: 0,
    isLow: row?.isLow ?? false,
    dailyUsageMilli: row?.dailyUsageMilli ?? 0,
    daysOfCover: row?.daysOfCover ?? null,
    hasMoves: !!row,
    anyMoves: !!row,
    lastMoveAt: row?.lastMoveAt ?? null,
    note: '',
    isSynthetic: false,
    // 部门小仓不分批（V17）
    expiryTracked: false,
    shelfLifeDays: null,
    replenishMode: row?.replenishMode ?? 'auto',
  };
}

/** 按入口取表单要的数据：总仓走库存接口；部门小仓走 /api/erp/dept-stock（部门的员工没有「查看库存」） */
function useScopeData(scope: FormScope) {
  // 急采按总仓的数据（采购有「查看库存」）
  const central = scope.kind !== 'dept';
  const materialsQ = useMaterials(true, central);
  const suppliersQ = useSuppliers(false, central);
  const settingsQ = useInvSettings(central);
  const meta = useDeptMeta(!central);
  const stock = useDeptStock(central ? null : scope.dept!.id);
  const deptMaterials = useMemo(() => {
    if (central || !meta.data || !stock.data) return undefined;
    const rows = new Map(stock.data.map((r) => [r.materialId, r]));
    return meta.data.materials.map((m) => deptMaterial(m, rows.get(m.id)));
  }, [central, meta.data, stock.data]);
  return {
    materials: central ? materialsQ.data : deptMaterials,
    refetchMaterials: () => (central ? materialsQ.refetch() : stock.refetch()),
    suppliers: central ? suppliersQ.data : meta.data?.suppliers,
    approvalRules: central ? settingsQ.data?.approvalRules : meta.data?.approvalRules,
    urgentCapCents: central ? settingsQ.data?.urgentCapCents : meta.data?.urgentCapCents,
    /** 称重收货容差（%，v0.7.13）：按采购单收货只在总仓 */
    weighTolerancePct: central ? (settingsQ.data?.weighTolerancePct ?? 10) : 10,
    /** 耗用经办人能选的员工（8.0.7 2.3，部门小仓；总仓的耗用默认是自己） */
    staff: central ? undefined : meta.data?.staff,
    /** 盘点大差异（v0.7.30，A8） */
    countBig: {
      countBigPct: (central ? settingsQ.data?.countBigPct : meta.data?.countBigPct) ?? DEFAULT_COUNT_BIG_PCT,
      countBigCents: (central ? settingsQ.data?.countBigCents : meta.data?.countBigCents) ?? DEFAULT_COUNT_BIG_CENTS,
    },
  };
}

const DRAFT_KEY = (type: InvDocType, scope: FormScope) => (scope.dept ? `yuzu.invDraft.v1.dept${scope.dept.id}.${type}` : `yuzu.invDraft.v1.${type}`);
function readDraft(type: InvDocType, scope: FormScope): FormState | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY(type, scope));
    if (!raw) return null;
    // v0.7.11 以前存下的草稿没有「一起验收的采购」
    const draft = JSON.parse(raw) as Partial<FormState>;
    return { ...draft, coAcceptorId: draft.coAcceptorId ?? null, usePurpose: draft.usePurpose ?? '', useHandlerId: draft.useHandlerId ?? null } as FormState;
  } catch {
    return null;
  }
}
function writeDraft(type: InvDocType, scope: FormScope, form: FormState | null) {
  try {
    if (form) localStorage.setItem(DRAFT_KEY(type, scope), JSON.stringify(form));
    else localStorage.removeItem(DRAFT_KEY(type, scope));
  } catch {
    /* 不可写时忽略 */
  }
}

function formFromDoc(doc: InvDoc, materials: Map<number, Material>): FormState {
  return {
    clientKey: uuid(),
    docDate: doc.docDate,
    supplierId: doc.supplier?.id ?? null,
    departmentId: doc.department?.id ?? null,
    sourceDocId: doc.sourceDoc?.id ?? null,
    purchaseOrderId: doc.purchaseOrder?.id ?? null,
    coAcceptorId: doc.coAcceptor?.id ?? null,
    handler: doc.handler,
    note: doc.note,
    usePurpose: doc.usePurpose ?? '',
    useHandlerId: doc.useHandler?.id ?? null,
    lines: doc.lines.map((l) => {
      const m = materials.get(l.materialId) ?? { purchaseFactorMilli: l.factorMilli };
      const enteredPack = l.enteredUnit && l.enteredUnit === l.purchaseUnit && l.enteredUnit !== l.inventoryUnit;
      return blankLine(l.materialId, {
        qty: qtyEntryFromMilli(doc.docType === 'count' ? l.countedMilli : l.qtyMilli, m, enteredPack ? 'pack' : 'base'),
        delivered: qtyEntryFromMilli(l.deliveredMilli, m, 'pack'),
        accepted: qtyEntryFromMilli(l.qtyMilli, m, 'pack'),
        acceptedTouched: true,
        rejectReason: l.rejectReason,
        batchNo: l.batchNo ?? '',
        producedOn: l.producedOn ?? '',
        expiresOn: l.expiresOn ?? '',
        price: l.priceCents === null ? '' : centsToInput(l.priceCents),
        sourceLineId: l.sourceLineId,
        poLineId: l.poLineId,
        bookMilli: l.bookMilli,
        stale: l.stale,
        note: l.note,
        diffReason: l.diffReason && l.diffReason !== 'pending' ? l.diffReason : '',
        diffNote: l.diffNote ?? '',
      });
    }),
  };
}

// ───────────────────────── 每类单据的说明 ─────────────────────────

const INTRO: Record<InvDocType, string> = {
  opening: '经确认的期初数量，是这项物料库存流水的起点；每项物料只能建一次。',
  receipt: '按实际合格数量入库。拒收部分不入库、不形成货款；未到的货不能提前入库。',
  issue: '仓库登记领给哪个部门、谁来领：总仓出、进这个部门的小仓（当面交接即生效）；部门在「本部门小仓」签收，有差异写明。',
  issue_return: '部门小仓把没用完的东西退回总仓，关联原领料单：部门小仓出、总仓进。',
  direct_use: '总仓的东西直接在仓库区域用掉。领给部门的东西由部门在「本部门小仓」登记耗用。',
  damage: '已知损坏单独登记并注明原因；与盘点差异分开处理。',
  count: '先记下账面数，再填实盘数。差异先叫「待核差异」，负责人确认后才调整库存。',
  supplier_return: '已验收入库后退回供应商，关联原收货单，同时扣减库存与该批货款。',
};

/** 本部门小仓的说明（v0.7.11） */
const URGENT_INTRO =
  '急采：没有采购单、临时给部门买的东西，由采购登记。合计不超过急采上限；提交后按金额分级审批，批了以后仓库到部门验收、进部门小仓，之后补采购单（提交即确认）。';

const DEPT_INTRO: Partial<Record<InvDocType, string>> = {
  direct_use: '本部门小仓里用掉的东西（客用、日耗品等），从本部门小仓扣。',
  damage: '本部门小仓里已知损坏的东西，注明原因；报损要负责人确认。',
  count: '本部门小仓的盘点：差异由部门自己管，提交即生效，差异原因默认「耗用」（客用、日耗品用掉的）。',
  opening: '本部门小仓现有的存货：每项物料只能建一次期初，要负责人确认。',
};

const QTY_LABEL: Partial<Record<InvDocType, string>> = {
  opening: '期初数量',
  issue: '领料数量',
  issue_return: '退回数量',
  direct_use: '耗用数量',
  damage: '报损数量',
  supplier_return: '退货数量',
};

const OUTBOUND: InvDocType[] = ['issue', 'direct_use', 'damage', 'supplier_return'];

/** 表头备注框占的列数：让每类单据的表头刚好排满 */
const NOTE_SPAN: Record<InvDocType, string> = {
  opening: 'lg:col-span-3',
  count: 'lg:col-span-3',
  direct_use: 'lg:col-span-3',
  damage: 'lg:col-span-3',
  receipt: 'sm:col-span-2 lg:col-span-4',
  issue: 'sm:col-span-2 lg:col-span-4',
  issue_return: 'sm:col-span-2 lg:col-span-4',
  supplier_return: 'sm:col-span-2 lg:col-span-1',
};

// ───────────────────────── 页面 ─────────────────────────

/** 急采的登记与修改（8.0.1，「采购 → 急采」） */
export function UrgentDocFormPage() {
  return <DocFormPage scope={URGENT_SCOPE} />;
}

export function DocFormPage({ scope = CENTRAL_SCOPE }: { scope?: FormScope }) {
  const params = useParams();
  const editId = params.id ? Number(params.id) : null;
  const type = scope.kind === 'urgent' ? 'receipt' : (params.type as InvDocType | undefined);
  const can = useCan();
  // 急采与总仓用库存单据接口
  const central = scope.kind !== 'dept';
  const invDoc = useInvDoc(central ? editId : null);
  const deptDoc = useDeptDoc(central ? null : editId);
  const doc = central ? invDoc : deptDoc;
  const data = useScopeData(scope);

  if (editId) {
    if (doc.error) return <PageError error={doc.error} />;
    if (!doc.data || !data.materials) return <FormSkeleton />;
    if (doc.data.status !== 'draft' && doc.data.status !== 'returned') return <Navigate to={scope.docLink(editId)} replace />;
    const map = new Map(data.materials.map((m) => [m.id, m]));
    return <DocForm key={editId} scope={scope} type={doc.data.docType} editing={doc.data} initial={formFromDoc(doc.data, map)} />;
  }
  if (!type || !(type in INV_DOC_META)) return <Navigate to={scope.home} replace />;
  if (scope.kind === 'urgent') {
    if (!can('purchase.manage')) return <Navigate to="/purchasing" replace />;
  } else if (central) {
    const perm = type === 'supplier_return' ? 'supplierReturn.create' : 'inventory.operate';
    if (!can(perm)) return <Navigate to="/inventory" replace />;
  } else if (!DEPT_DOC_TYPES.includes(type)) {
    return <Navigate to={scope.home} replace />;
  }
  return <NewDoc key={type} type={type} scope={scope} />;
}

function NewDoc({ type, scope }: { type: InvDocType; scope: FormScope }) {
  const session = useSession();
  const [params] = useSearchParams();
  // 从库存卡或原单进入时带上物料 / 原单
  const prefillMaterial = Number(params.get('m')) || null;
  const prefillSource = Number(params.get('src')) || null;
  const prefillPo = type === 'receipt' ? Number(params.get('po')) || null : null;
  // 「再录一张」时换一轮：清空表单、生成新的操作编号
  const [round, setRound] = useState(0);
  const initial = useMemo(() => {
    const draft = round === 0 && !prefillSource && !prefillPo ? readDraft(type, scope) : null;
    if (draft) return { form: { ...draft, purchaseOrderId: draft.purchaseOrderId ?? null }, restored: true };
    return {
      form: { ...blankForm(session.calendarToday), sourceDocId: round === 0 ? prefillSource : null, purchaseOrderId: round === 0 ? prefillPo : null },
      restored: false,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round, type, session.calendarToday, prefillSource, prefillPo]);
  return (
    <DocForm
      key={round}
      scope={scope}
      type={type}
      initial={initial.form}
      restored={initial.restored}
      prefillMaterialId={round === 0 ? prefillMaterial : null}
      onAgain={() => setRound((r) => r + 1)}
    />
  );
}

function PageError({ error }: { error: unknown }) {
  return (
    <>
      <PageHeader title="库存单据" dateMode="calendar" />
      <div className="p-7">
        <Notice tone="error" title={errorMessage(error)} />
      </div>
    </>
  );
}

function FormSkeleton() {
  return (
    <>
      <PageHeader title="库存单据" dateMode="calendar" />
      <div className="mx-auto w-full max-w-[1180px] space-y-4 p-7">
        <Skeleton className="h-28" />
        <Skeleton className="h-64" />
      </div>
    </>
  );
}

type Phase =
  | { kind: 'edit' }
  | { kind: 'submitting' }
  | { kind: 'uncertain'; reason: UncertainError['reason']; body: unknown; checking?: boolean; notFound?: boolean }
  | { kind: 'done'; doc: InvDoc; replayed: boolean };

function DocForm({
  scope,
  type,
  initial,
  editing,
  restored,
  onAgain,
  prefillMaterialId,
}: {
  scope: FormScope;
  type: InvDocType;
  initial: FormState;
  editing?: InvDoc;
  restored?: boolean;
  onAgain?: () => void;
  prefillMaterialId?: number | null;
}) {
  const session = useSession();
  const can = useCan();
  const toast = useToast();
  const navigate = useNavigate();
  const invalidateInv = useInvalidateInventory();
  const invalidateDept = useInvalidateDept();
  const central = scope.kind === 'central';
  // 急采（8.0.1 起由采购登记）：总仓的数据，给哪个部门买的在表头选
  const urgent = scope.kind === 'urgent';
  const invalidate = () => (scope.kind === 'dept' ? invalidateDept() : invalidateInv());
  const data = useScopeData(scope);
  const departments = useDepartments(false, (central && type === 'issue') || urgent);
  // 按采购单收货：一起验收的采购经办（#17）
  const coAcceptors = useCoAcceptors(central && type === 'receipt');
  const [form, setForm] = useState<FormState>(initial);
  const [phase, setPhase] = useState<Phase>({ kind: 'edit' });
  const [error, setError] = useState<ApiError | null>(null);
  const [approveNow, setApproveNow] = useState(false);
  const [showRestored, setShowRestored] = useState(!!restored);
  const qtyRefs = useRef(new Map<string, HTMLInputElement | null>());
  const pickerRef = useRef<HTMLInputElement>(null);
  const meta = INV_DOC_META[type];
  const visual = DOC_VISUAL[type];
  const Icon = visual.icon;
  const locked = phase.kind !== 'edit';

  const materials = useMemo(() => new Map((data.materials ?? []).map((m) => [m.id, m])), [data.materials]);

  // 新建单据的内容随手保存在本机：刷新或误关页面后可以接着填，操作编号不变
  useEffect(() => {
    if (editing || phase.kind === 'done') return;
    const t = setTimeout(() => {
      const empty = form.lines.length === 0 && !form.note && !form.handler && !form.supplierId && !form.departmentId && !form.sourceDocId;
      writeDraft(type, scope, empty ? null : form);
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, type, editing, phase.kind]);

  const patch = (p: Partial<FormState>) => setForm((f) => ({ ...f, ...p }));
  const patchLine = (key: string, p: Partial<LineDraft>) =>
    setForm((f) => ({ ...f, lines: f.lines.map((l) => (l.key === key ? { ...l, ...p } : l)) }));
  const removeLine = (key: string) => setForm((f) => ({ ...f, lines: f.lines.filter((l) => l.key !== key) }));

  // 加入物料后把焦点交给新行的数量框：在提交渲染后同步移动，连续快速输入也不会落回搜索框
  const focusNext = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!focusNext.current) return;
    const el = qtyRefs.current.get(focusNext.current);
    if (el) {
      el.focus();
      focusNext.current = null;
    }
  });
  const addMaterial = (m: Material, over: Partial<LineDraft> = {}) => {
    const line = blankLine(m.id, {
      price: type === 'receipt' && m.refPriceCents !== null ? centsToInput(m.refPriceCents) : '',
      ...over,
    });
    focusNext.current = line.key;
    setForm((f) => ({ ...f, lines: [...f.lines, line] }));
  };

  const prefilled = useRef(false);
  useEffect(() => {
    if (prefilled.current || !prefillMaterialId || !data.materials) return;
    prefilled.current = true;
    const m = materials.get(prefillMaterialId);
    if (!m || !m.tracked || !m.active || form.lines.some((l) => l.materialId === m.id)) return;
    if (type === 'opening' && m.hasMoves) return;
    addMaterial(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillMaterialId, data.materials]);

  // ── 来源单据（领料退回 / 退供应商） ──
  const sourceType = type === 'issue_return' ? 'issue' : type === 'supplier_return' ? 'receipt' : null;
  const source = useInvDoc(sourceType ? form.sourceDocId : null);
  const chooseSource = (docId: number | null) => {
    patch({ sourceDocId: docId, lines: [] });
  };
  useEffect(() => {
    if (!source.data || !sourceType || form.lines.length > 0 || source.data.id !== form.sourceDocId) return;
    setForm((f) => ({
      ...f,
      supplierId: source.data!.supplier?.id ?? null,
      departmentId: source.data!.department?.id ?? null,
      lines: source.data!.lines.map((l) => blankLine(l.materialId, { sourceLineId: l.id })),
    }));
  }, [source.data, sourceType, form.lines.length, form.sourceDocId]);

  // ── 按采购单收货 ──
  const openPos = usePos({ open: '1', supplierId: form.supplierId ? String(form.supplierId) : undefined }, central && type === 'receipt' && !!form.supplierId);
  const po = usePo(central && type === 'receipt' ? form.purchaseOrderId : null);
  const poLines = useMemo(() => new Map((po.data?.lines ?? []).map((l) => [l.id, l])), [po.data]);
  const choosePo = (poId: number | null) => patch({ purchaseOrderId: poId, lines: [] });
  useEffect(() => {
    if (!po.data || po.data.id !== form.purchaseOrderId) return;
    if (!form.supplierId) patch({ supplierId: po.data.supplier.id });
    if (form.lines.length > 0) return;
    // 带出未到齐的行：送达默认按剩余数量（能整箱时按箱），单价取采购单
    const lines = po.data.lines
      .filter((l) => l.baseQtyMilli > l.receivedMilli)
      .map((l) => {
        const m = materials.get(l.materialId) ?? { purchaseFactorMilli: l.factorMilli };
        const remaining = qtyEntryFromMilli(l.baseQtyMilli - l.receivedMilli, m, 'pack');
        return blankLine(l.materialId, { poLineId: l.id, delivered: remaining, accepted: remaining, price: centsToInput(l.priceCents) });
      });
    if (lines.length) patch({ lines });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [po.data, form.purchaseOrderId]);

  // ── 逐行计算 ──
  const rows: Row[] = form.lines.map((l): Row => {
    const m = materials.get(l.materialId);
    const srcLine = source.data?.lines.find((s) => s.id === l.sourceLineId);
    if (!m) return { line: l, m: undefined, error: '物料不存在', ready: false };
    const qty = resolveQty(l.qty, m);
    let errorText: string | null = qty.error;
    let ready = false;
    let after: number | null = null;
    let amount: number | null = null;
    let rejected: number | null = null;
    let maxReturn: number | null = null;
    let book: number | null = null;
    let diff: number | null = null;
    let big = false;
    let accepted: ReturnType<typeof resolveQty> | null = null;
    let delivered: ReturnType<typeof resolveQty> | null = null;
    let price: number | null = null;

    switch (type) {
      case 'opening':
        ready = qty.milli !== null;
        after = qty.milli;
        break;
      case 'issue':
      case 'direct_use':
      case 'damage':
        ready = qty.milli !== null && qty.milli > 0;
        if (qty.milli !== null) {
          after = m.stockMilli - qty.milli;
          if (after < 0) errorText = `库存不足，当前 ${formatQty(m.stockMilli)} ${m.inventoryUnit}`;
        }
        if (qty.milli === 0) errorText = '数量必须大于 0';
        break;
      case 'issue_return':
      case 'supplier_return':
        // 台面日耗品领到部门即算耗用，不能退回（v0.7.13）
        // 迁移前的领料没进部门小仓，退回只进总仓，不受限制
        if (type === 'issue_return' && m.counterUse && source.data?.warehouse?.kind === 'department' && qty.milli !== null && qty.milli > 0) {
          errorText = '台面日耗品领到即算耗用，不能退回';
        }
        if (srcLine) {
          maxReturn = srcLine.qtyMilli - srcLine.returnedMilli;
          if (qty.milli !== null && qty.milli > maxReturn) errorText = errorText ?? `最多 ${formatQty(Math.max(0, maxReturn))} ${m.inventoryUnit}`;
          if (qty.milli !== null) {
            after = m.stockMilli + (type === 'issue_return' ? qty.milli : -qty.milli);
            if (after < 0) errorText = errorText ?? `库存不足，当前 ${formatQty(m.stockMilli)} ${m.inventoryUnit}`;
          }
          if (type === 'supplier_return' && qty.milli !== null && srcLine.priceCents !== null) {
            amount = lineAmountCents(qty.milli, srcLine.priceCents, srcLine.factorMilli);
          }
        }
        ready = qty.milli !== null && qty.milli > 0;
        break;
      case 'count':
        book = l.bookMilli ?? m.stockMilli;
        if (qty.milli !== null) diff = qty.milli - book;
        ready = qty.milli !== null;
        if (l.stale) errorText = '盘点后又有收发，需重新核对账面';
        // 大差异（v0.7.30）：差异超过账面的 2% 或差异金额超过 ¥500，要写原因类别与说明（部门小仓看不到参考价，只按比例；服务端照两样核对）
        big = diff !== null && isBigVariance(book, diff, m.refPriceCents === null ? null : lineAmountCents(Math.abs(diff), m.refPriceCents, m.purchaseFactorMilli), data.countBig);
        if (big && (!l.diffReason || (l.diffNote ?? '').trim().length < 2)) errorText = errorText ?? '大差异：请选原因类别并写说明（至少 2 个字）';
        break;
      case 'receipt': {
        const pl = l.poLineId ? poLines.get(l.poLineId) : undefined;
        delivered = resolveQty(l.delivered, m);
        accepted = l.acceptedTouched ? resolveQty(l.accepted, m) : delivered;
        price = pl ? pl.priceCents : parseYuan(l.price);
        errorText = delivered.error ?? accepted.error;
        if (pl) {
          // 称重物料按实际称重收货，可以比订购数量多出容差（v0.7.13）
          const cap = m.weighed ? pl.baseQtyMilli + Math.floor((pl.baseQtyMilli * data.weighTolerancePct) / 100) : pl.baseQtyMilli;
          maxReturn = cap - pl.receivedMilli;
          if (accepted.milli !== null && accepted.milli > maxReturn) {
            errorText = m.weighed
              ? `超出称重容差 ${data.weighTolerancePct}%（最多还能收 ${formatQty(Math.max(0, maxReturn))} ${m.inventoryUnit}）`
              : `超出采购单未到数量（还差 ${formatQty(Math.max(0, maxReturn))} ${m.inventoryUnit}）`;
          }
        }
        if (delivered.milli !== null && accepted.milli !== null) {
          rejected = delivered.milli - accepted.milli;
          if (rejected < 0) errorText = '合格实收不能多于送达';
          else if (rejected > 0 && !l.rejectReason.trim()) errorText = errorText ?? '请填写拒收原因';
          // 管效期的物料（8.0.7 3.3）：到期日必填，填了生产日期、有保质期的可以不填
          else if (m.expiryTracked && !l.expiresOn && !(l.producedOn && m.shelfLifeDays)) errorText = errorText ?? `「${m.name}」管效期，请填到期日`;
          after = m.stockMilli + accepted.milli;
        }
        if (!pl && l.price.trim() && price === null) errorText = errorText ?? '单价格式不正确';
        if (!pl && !l.price.trim()) errorText = errorText ?? `请填写单价（元/${m.purchaseUnit}）`;
        if (accepted.milli !== null && price !== null) amount = lineAmountCents(accepted.milli, price, pl ? pl.factorMilli : m.purchaseFactorMilli);
        ready = delivered.milli !== null && delivered.milli > 0 && accepted.milli !== null && price !== null && !errorText;
        break;
      }
    }
    return {
      line: l,
      m,
      qty,
      error: errorText,
      ready: ready && !errorText,
      after,
      amount,
      rejected,
      maxReturn,
      book,
      diff,
      big,
      accepted,
      delivered,
      price,
      srcLine,
      poLine: l.poLineId ? poLines.get(l.poLineId) : undefined,
    };
  });

  const isReturn = type === 'issue_return' || type === 'supplier_return';
  // 总仓的收货一律按采购单（#19）：明细由采购单带出，不能另加物料
  const poReceipt = type === 'receipt' && central;
  // 退回类单据：没填数量的行不提交
  const activeRows = isReturn ? rows.filter((r) => r.line.qty.text.trim() !== '') : rows;
  const lineErrors = activeRows.filter((r) => r.error);
  const unfilled = activeRows.filter((r) => !r.ready && !r.error);
  const totalAmount = activeRows.reduce((sum, r) => sum + (r.amount ?? 0), 0);
  const countDiffs = type === 'count' ? rows.filter((r) => r.diff != null && r.diff !== 0).length : 0;

  const rules = data.approvalRules;
  // 部门小仓的盘点只有小差异的提交即生效，有大差异的要审批（v0.7.30）；急采要仓库到部门验收（v0.7.11）
  // 只是页面提示：命中审批规则的（审批中心）以服务端为准
  const needsApproval = urgent
    ? true
    : type === 'count'
      ? central
        ? countDiffs > 0
        : rows.some((r) => r.big)
      : type === 'opening'
        ? !!rules?.opening
        : type === 'damage'
          ? !!rules?.damage
          : type === 'supplier_return'
            ? !!rules?.supplier_return
            : false;
  // 急采不能一步确认（要另一个人验收；店主除外，也不在这里一步确认）
  const canApprove = can('inventory.approve') && !urgent;
  const urgentOver = urgent && data.urgentCapCents != null && totalAmount > data.urgentCapCents;

  // ── 表头校验 ──
  const headerError =
    type === 'receipt' && !form.supplierId
      ? '请选择供应商'
      : urgent && !form.departmentId
        ? '请选给哪个部门买的'
      : type === 'receipt' && central && !form.purchaseOrderId
        ? '请选择采购单（没有采购单不能收货；没有采购单的临时采购由采购在「采购 → 急采」登记）'
        : urgentOver
            ? `急采合计超过上限 ¥${((data.urgentCapCents ?? 0) / 100).toFixed(2)}，请先开采购单`
            : type === 'issue' && !form.departmentId
        ? '请选择领料部门'
        : type === 'issue' && !form.handler.trim()
          ? '请填写领料人'
          : isReturn && !form.sourceDocId
            ? type === 'issue_return'
              ? '请选择原领料单'
              : '请选择原收货单'
            : type === 'direct_use' && !form.usePurpose
              ? '请选择用途'
            : (type === 'direct_use' || type === 'damage' || type === 'supplier_return') && form.note.trim().length < 2
              ? type === 'direct_use'
                ? '请填写说明'
                : type === 'damage'
                  ? '请填写报损原因'
                  : '请填写退货原因'
              : form.docDate > session.calendarToday
                ? '单据日期不能晚于今天'
                : null;
  const noLines = activeRows.length === 0;
  const blocking =
    headerError ??
    (noLines
      ? isReturn
        ? '请至少填写一行退回数量'
        : '请至少添加一项物料'
      : lineErrors.length
        ? `有 ${lineErrors.length} 行需要修改`
        : unfilled.length
          ? type === 'count'
            ? `还有 ${unfilled.length} 项没填实盘数`
            : `还有 ${unfilled.length} 行没填完整`
          : null);

  const buildBody = (action: 'save' | 'submit') => {
    // 部门小仓的期初、耗用、报损、盘点记在本部门小仓（v0.7.11）
    const wh = scope.dept && type !== 'receipt' ? { warehouseId: scope.dept.warehouseId } : {};
    const base = { docType: type, docDate: form.docDate, note: form.note.trim(), action, ...wh };
    const lines = activeRows;
    switch (type) {
      case 'opening':
        return { ...base, lines: lines.map((r) => ({ materialId: r.line.materialId, qtyMilli: r.qty!.milli, note: r.line.note })) };
      case 'issue':
      case 'direct_use':
      case 'damage':
        return {
          ...base,
          ...(type === 'issue' ? { departmentId: form.departmentId, handler: form.handler.trim() } : {}),
          ...(type === 'direct_use' ? { purpose: form.usePurpose || null, handlerId: form.useHandlerId } : {}),
          lines: lines.map((r) => ({
            materialId: r.line.materialId,
            qtyMilli: r.qty!.milli,
            enteredQtyMilli: r.qty!.entered,
            enteredUnit: r.line.qty.unit === 'pack' ? r.m!.purchaseUnit : r.m!.inventoryUnit,
            note: r.line.note,
          })),
        };
      case 'count':
        return {
          ...base,
          lines: lines.map((r) => ({
            materialId: r.line.materialId,
            countedMilli: r.qty!.milli,
            expectedBookMilli: r.book ?? null,
            note: r.line.note,
            ...(r.diff ? { diffReason: r.line.diffReason || null, diffNote: (r.line.diffNote ?? '').trim() } : {}),
          })),
        };
      case 'issue_return':
      case 'supplier_return':
        return {
          ...base,
          sourceDocId: form.sourceDocId,
          ...(type === 'issue_return' ? { handler: form.handler.trim() } : {}),
          lines: lines.map((r) => ({ sourceLineId: r.line.sourceLineId, qtyMilli: r.qty!.milli, note: r.line.note })),
        };
      case 'receipt':
        return {
          ...base,
          supplierId: form.supplierId,
          purchaseOrderId: urgent ? null : form.purchaseOrderId,
          coAcceptorId: urgent ? null : form.coAcceptorId,
          ...(urgent ? { urgent: true, departmentId: form.departmentId } : {}),
          handler: form.handler.trim(),
          lines: lines.map((r) => ({
            materialId: r.line.materialId,
            poLineId: form.purchaseOrderId ? r.line.poLineId : null,
            deliveredMilli: r.delivered!.milli,
            acceptedMilli: r.accepted!.milli,
            rejectReason: r.rejected && r.rejected > 0 ? r.line.rejectReason.trim() : '',
            priceCents: r.price,
            batchNo: r.line.batchNo?.trim() || null,
            producedOn: r.line.producedOn || null,
            expiresOn: r.line.expiresOn || null,
            note: r.line.note,
          })),
        };
    }
  };

  const finish = (doc: InvDoc, replayed: boolean) => {
    writeDraft(type, scope, null);
    void invalidate();
    setPhase({ kind: 'done', doc, replayed });
  };

  const send = async (body: unknown) => {
    setError(null);
    setPhase({ kind: 'submitting' });
    try {
      if (editing) {
        const doc = await api.put<InvDoc>(`${scope.api}/${editing.id}`, { ...(body as object), approveNow });
        finish(doc, false);
      } else {
        const res = await api.post<{ doc: InvDoc; replayed: boolean }>(scope.api, body, { timeoutMs: 20_000 });
        finish(res.doc, res.replayed);
      }
    } catch (e) {
      if (e instanceof UncertainError && !editing) {
        setPhase({ kind: 'uncertain', reason: e.reason, body });
        return;
      }
      setPhase({ kind: 'edit' });
      if (e instanceof ApiError) {
        setError(e);
        if (e.code === 'IDEMPOTENCY_CONFLICT') patch({ clientKey: uuid() });
        if (e.code === 'COUNT_STALE' || e.code === 'INSUFFICIENT_STOCK') void data.refetchMaterials();
      } else {
        toast({ tone: 'error', title: errorMessage(e) });
      }
    }
  };

  const submit = (action: 'save' | 'submit') => {
    if (action === 'submit' && blocking) return;
    void send({ ...buildBody(action), clientKey: form.clientKey, approveNow: action === 'submit' && needsApproval && approveNow });
  };

  const checkResult = async () => {
    if (phase.kind !== 'uncertain') return;
    setPhase({ ...phase, checking: true });
    try {
      const res = await api.get<{ found: boolean; doc?: InvDoc }>(`${scope.api}/by-key/${form.clientKey}`);
      if (res.found && res.doc) finish(res.doc, true);
      else setPhase({ ...phase, checking: false, notFound: true });
    } catch {
      setPhase({ ...phase, checking: false });
      toast({ tone: 'error', title: '暂时连不上服务器', body: '请检查网络后再查一次。' });
    }
  };

  const refreshBook = async () => {
    if (!editing) return;
    try {
      const doc = await api.post<InvDoc>(`${scope.api}/${editing.id}/refresh-book`);
      const book = new Map(doc.lines.map((l) => [l.materialId, l.bookMilli]));
      setForm((f) => ({ ...f, lines: f.lines.map((l) => (book.has(l.materialId) ? { ...l, bookMilli: book.get(l.materialId) ?? null, stale: false } : l)) }));
      setError(null);
      void invalidate();
      toast({ tone: 'info', title: '已按最新账面记下账面数', body: '请对照新的账面数，再核对一遍实盘数。' });
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    }
  };

  if (phase.kind === 'done') {
    return <DoneView scope={scope} type={type} doc={phase.doc} replayed={phase.replayed} onAgain={onAgain ?? (() => navigate(scope.newLink(type)))} />;
  }

  const takenMaterials = new Set(form.lines.map((l) => l.materialId));
  const lineCount = activeRows.length;

  return (
    <>
      <PageHeader
        dateMode="calendar"
        title={
          <span className="flex items-center gap-2.5">
            <Link to={scope.home} className="-ml-1 flex size-8 items-center justify-center rounded-md text-ink-3 hover:bg-paper-2 hover:text-ink" aria-label={central ? '返回库存' : urgent ? '返回急采' : '返回本部门小仓'}>
              <ArrowLeft className="size-[18px]" />
            </Link>
            <span className={cn('flex size-8 items-center justify-center rounded-full', visual.tone)}>
              <Icon className="size-4" />
            </span>
            {scope.dept && `${scope.dept.name}小仓 · `}
            {editing ? `修改${urgent ? '急采' : meta.title} · ${editing.docNo}` : `新建${urgent ? '急采' : meta.title}`}
          </span>
        }
        subtitle={urgent ? URGENT_INTRO : (scope.dept && DEPT_INTRO[type]) || INTRO[type]}
      />

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1180px] space-y-4 px-5 py-5 md:px-7">
          {showRestored && (
            <Notice
              tone="info"
              title="已恢复上次没有提交的内容"
              action={
                <>
                  <Button size="sm" variant="secondary" onClick={() => setShowRestored(false)}>
                    继续填写
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Eraser className="size-4" />}
                    onClick={() => {
                      writeDraft(type, scope, null);
                      setForm(blankForm(session.calendarToday));
                      setShowRestored(false);
                    }}
                  >
                    清空重填
                  </Button>
                </>
              }
            >
              内容只保存在这台电脑的浏览器里，提交后自动清除。
            </Notice>
          )}
          {editing?.status === 'returned' && editing.returnedReason && (
            <Notice tone="warning" title="负责人退回修改" icon={<CircleAlert className="size-5" />}>
              {editing.returnedReason}
            </Notice>
          )}

          {/* ── 表头 ── */}
          <section className="grid gap-4 rounded-lg border border-line bg-card p-5 shadow-card sm:grid-cols-2 lg:grid-cols-4">
            <Field label="单据日期" htmlFor="docDate">
              <Input id="docDate" type="date" value={form.docDate} max={session.calendarToday} disabled={locked} onChange={(e) => patch({ docDate: e.target.value })} className="h-10" />
            </Field>

            {type === 'receipt' && (
              <>
                <Field label="供应商" htmlFor="supplier">
                  <Select
                  id="supplier"
                  value={form.supplierId ?? ''}
                  disabled={locked}
                  onChange={(e) => patch({ supplierId: Number(e.target.value) || null, ...(form.purchaseOrderId ? { purchaseOrderId: null, lines: [] } : {}) })}
                >
                    <option value="">选择供应商</option>
                    {data.suppliers?.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.code} · {s.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                {central && (
                  <Field label="采购单" htmlFor="po" hint={form.supplierId ? '没有采购单不能收货' : '先选供应商'}>
                    <Select id="po" value={form.purchaseOrderId ?? ''} disabled={locked || !form.supplierId || !!editing} onChange={(e) => choosePo(Number(e.target.value) || null)}>
                      <option value="">请选择采购单</option>
                      {form.purchaseOrderId && !openPos.data?.some((p) => p.id === form.purchaseOrderId) && po.data && <option value={po.data.id}>{po.data.docNo}</option>}
                      {openPos.data
                        ?.filter((p) => p.receiving !== 'full')
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.docNo} · {p.summary}
                          </option>
                        ))}
                    </Select>
                  </Field>
                )}
                {central && (
                  <Field label="一起验收的采购（选填）" htmlFor="coAcceptor" hint="采购不参与库管收货（店主 2026-11-10），仓库自己验收即可；要一起验收的照旧选上">
                    <Select id="coAcceptor" value={form.coAcceptorId ?? ''} disabled={locked} onChange={(e) => patch({ coAcceptorId: Number(e.target.value) || null })}>
                      <option value="">不选（仓库自己验收）</option>
                      {coAcceptors.data
                        ?.filter((c) => c.id !== session.staff.id)
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.displayName}
                          </option>
                        ))}
                    </Select>
                  </Field>
                )}
                {urgent && (
                  <Field label="给哪个部门买的" htmlFor="urgent-dept" hint="验收后进这个部门的小仓">
                    <Select id="urgent-dept" value={form.departmentId ?? ''} disabled={locked} onChange={(e) => patch({ departmentId: Number(e.target.value) || null })} data-testid="urgent-dept">
                      <option value="">选择部门</option>
                      {departments.data?.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}
                <Field label={urgent ? '经手人' : '收货人'} htmlFor="handler">
                  <Input id="handler" value={form.handler} disabled={locked} onChange={(e) => patch({ handler: e.target.value })} placeholder={urgent ? '实际去买的人' : '默认为当前账号'} className="h-10" />
                </Field>
              </>
            )}

            {type === 'issue' && (
              <>
                <Field label="领料部门" className="sm:col-span-2 lg:col-span-2" hint="领到这个部门的小仓">
                  <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="领料部门">
                    {departments.data?.map((d) => (
                      <button
                        key={d.id}
                        type="button"
                        role="radio"
                        aria-checked={form.departmentId === d.id}
                        disabled={locked}
                        onClick={() => patch({ departmentId: d.id })}
                        className={cn(
                          'h-10 rounded-md border px-3.5 text-[14px] font-semibold transition-colors',
                          form.departmentId === d.id ? 'border-pine bg-pine text-paper' : 'border-line-strong bg-card text-ink-2 hover:border-ink-3',
                        )}
                      >
                        {d.name}
                      </button>
                    ))}
                  </div>
                </Field>
                <Field label="领料人" htmlFor="handler">
                  <Input id="handler" value={form.handler} disabled={locked} onChange={(e) => patch({ handler: e.target.value })} placeholder="实际来领的人" className="h-10" />
                </Field>
              </>
            )}

            {sourceType && (
              <>
                <SourcePicker
                  type={sourceType}
                  value={form.sourceDocId}
                  disabled={locked || !!editing}
                  onChange={chooseSource}
                  className="sm:col-span-2 lg:col-span-2"
                />
                {type === 'issue_return' && (
                  <Field label="退回人" htmlFor="handler">
                    <Input id="handler" value={form.handler} disabled={locked} onChange={(e) => patch({ handler: e.target.value })} className="h-10" />
                  </Field>
                )}
              </>
            )}

            {type === 'direct_use' && (
              <>
                <Field label="用途" htmlFor="use-purpose" hint="在经营规则「可调的数值」里改">
                  <Select id="use-purpose" value={form.usePurpose} disabled={locked} onChange={(e) => patch({ usePurpose: e.target.value })} className="h-10" data-testid="use-purpose">
                    <option value="">选择用途</option>
                    {session.rules.consumptionPurposes.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </Select>
                </Field>
                {data.staff && (
                  <Field label="经办人" htmlFor="use-handler">
                    <Select
                      id="use-handler"
                      value={form.useHandlerId ?? session.staff.id}
                      disabled={locked}
                      onChange={(e) => patch({ useHandlerId: Number(e.target.value) || null })}
                      className="h-10"
                      data-testid="use-handler"
                    >
                      {data.staff.map((st) => (
                        <option key={st.id} value={st.id}>
                          {st.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}
              </>
            )}
            <Field
              label={type === 'direct_use' ? '说明' : type === 'damage' ? '报损原因' : type === 'supplier_return' ? '退货原因' : '备注'}
              htmlFor="note"
              className={NOTE_SPAN[type]}
            >
              <Input
                id="note"
                value={form.note}
                disabled={locked}
                onChange={(e) => patch({ note: e.target.value })}
                placeholder={type === 'direct_use' ? '例如：总库清洁' : type === 'damage' ? '例如：搬运摔裂' : type === 'supplier_return' ? '例如：开胶、批次不合格' : '可选'}
                maxLength={200}
                className="h-10"
              />
            </Field>
          </section>

          {urgent && (
            <Notice tone={urgentOver ? 'error' : 'warning'} title={`急采：合计不超过 ¥${((data.urgentCapCents ?? 0) / 100).toFixed(2)}`} icon={<CircleAlert className="size-5" />}>
              没有采购单的临时采购登记成急采：提交后按金额分级审批，批了以后仓库到部门验收、确认后才进部门小仓；之后在「采购 → 急采」里补采购单（提交即确认）。上限是采购规则里急采分级的最高一档 <SimRule className="align-middle" />
            </Notice>
          )}
          {type === 'receipt' && po.data && form.purchaseOrderId === po.data.id && (
            <Notice tone="info" title={`按采购单 ${po.data.docNo} 收货`}>
              单价与包装换算以采购单为准；本次合格实收不能超过未到数量，拒收部分不入库、不计货款。
              {po.data.lines.some((l) => l.weighed) && <> 称重的物料按实际称重填，可以比订购数量多出 {data.weighTolerancePct}%，货款按实收重量算。</>}
            </Notice>
          )}

          {/* ── 明细 ── */}
          <section className="@container rounded-lg border border-line bg-card shadow-card">
            <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3">
              <h2 className="text-[14px] font-bold">明细</h2>
              <span className="num text-[12.5px] text-ink-3">{lineCount} 行</span>
              <div className="flex-1" />
              {type === 'issue' && <UsualChips departmentId={form.departmentId} materials={materials} taken={takenMaterials} disabled={locked} onAdd={(m, qty) => addMaterial(m, { qty: qtyEntryFromMilli(qty, m) })} />}
              {type === 'count' && !locked && (
                <CountFillMenu
                  materials={scope.kind !== 'dept' ? (data.materials ?? []) : (data.materials ?? []).filter((m) => m.hasMoves && !m.counterUse)}
                  taken={takenMaterials}
                  onAdd={(list) => setForm((f) => ({ ...f, lines: [...f.lines, ...list.map((m) => blankLine(m.id))] }))}
                />
              )}
              {type === 'count' && editing && form.lines.some((l) => l.stale) && (
                <Button size="sm" variant="accent" icon={<RotateCw className="size-4" />} onClick={refreshBook}>
                  按最新账面重新核对
                </Button>
              )}
            </div>

            <LineHeader type={type} />

            {rows.length === 0 && (isReturn ? !form.sourceDocId : true) && (
              <EmptyState
                art="leaf"
                title={isReturn ? (type === 'issue_return' ? '先选择原领料单' : '先选择原收货单') : poReceipt ? '先选择采购单' : '还没有物料'}
                description={
                  isReturn
                    ? '选好原单后，这里会列出可退的物料与数量上限。'
                    : poReceipt
                      ? '收货必须按已确认的采购单；选好采购单后，这里会列出还没到齐的物料。'
                      : '在下方搜索框输入编码或名称，回车加入；可以连续录入多行。'
                }
                className="py-8"
              />
            )}
            {isReturn && form.sourceDocId && source.isPending && (
              <div className="flex justify-center py-8">
                <Spinner />
              </div>
            )}

            <ul className="divide-y divide-line/70">
              {rows.map((r) => (
                <LineRow
                  key={r.line.key}
                  type={type}
                  row={r}
                  locked={locked}
                  qtyRef={(el) => qtyRefs.current.set(r.line.key, el)}
                  onPatch={(p) => patchLine(r.line.key, p)}
                  onRemove={isReturn ? undefined : () => removeLine(r.line.key)}
                />
              ))}
            </ul>

            {!isReturn && !locked && !poReceipt && (
              <div className="border-t border-line px-5 py-3.5">
                <MaterialPicker
                  ref={pickerRef}
                  materials={data.materials ?? []}
                  taken={takenMaterials}
                  disabledReason={(m) => {
                    // 台面日耗品领到部门即算耗用，部门小仓不登记它的期初、耗用、报损、盘点（急采照常，v0.7.13）
                    if (!central && m.counterUse && type !== 'receipt') return '台面日耗品，领到即耗用';
                    if (type === 'opening') return m.hasMoves ? '已有库存记录' : null;
                    if (OUTBOUND.includes(type)) return m.stockMilli <= 0 ? '无库存' : null;
                    return null;
                  }}
                  onPick={(m) => addMaterial(m)}
                  placeholder={type === 'opening' ? '搜索还没有建期初的物料' : '搜索物料：编码 / 名称 / 规格，回车加入'}
                />
              </div>
            )}
          </section>

          {error && (
            <Notice tone="error" title={error.message} icon={<CircleAlert className="size-5" />}>
              {error.code === 'COUNT_STALE' ? '期间有新的收发，账面数已更新。请按新的账面重新核对实盘数后再提交。' : '单据没有生效，内容仍保留在页面上，可修改后再提交。'}
            </Notice>
          )}

          {phase.kind === 'uncertain' && (
            <Notice
              tone="warning"
              title={phase.reason === 'timeout' ? '服务器长时间没有响应，结果待确认' : phase.reason === 'server' ? '服务器出了点问题，结果待确认' : '网络中断，结果待确认'}
              icon={<CloudOff className="size-5" />}
              action={
                <>
                  <Button size="sm" variant="primary" loading={phase.checking} icon={<Search className="size-4" />} onClick={checkResult}>
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
              {phase.notFound
                ? '服务器上没有这张单，可以按原内容重新提交（使用同一操作编号，不会重复生效）。'
                : '单据可能已经生效。请先查回结果，不要重新填写，以免重复记账。'}
            </Notice>
          )}
        </div>
      </div>

      {/* ── 底部操作条 ── */}
      <footer className="shrink-0 border-t border-line bg-card/95 px-5 py-3 backdrop-blur md:px-7">
        <div className="mx-auto flex w-full max-w-[1180px] flex-wrap items-center gap-x-5 gap-y-2.5">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1">
            {(type === 'receipt' || type === 'supplier_return') && (
              <span className="flex items-baseline gap-2">
                <span className="text-[12.5px] font-semibold text-ink-3">{type === 'receipt' ? '确认货款' : '退货扣款'}</span>
                <Money cents={totalAmount} className={cn('text-[20px] font-bold', type === 'receipt' ? 'text-pine' : 'text-clay')} />
              </span>
            )}
            {type === 'count' && (
              <span className="text-[13px] text-ink-2">
                <b className="num">{countDiffs}</b> 项有差异
                {countDiffs > 0 && <span className="ml-1.5 text-ink-3">· 确认前按「{COUNT_REASON_LABELS.pending}」处理，不改库存</span>}
              </span>
            )}
            <span className="flex items-center gap-2 text-[12.5px]">
              {urgent ? (
                <span className="font-semibold text-yuzu-deep">提交后按金额分级审批，批了以后仓库到部门验收、进部门小仓</span>
              ) : needsApproval ? (
                <>
                  <span className="font-semibold text-yuzu-deep">提交后需负责人确认</span>
                  {type !== 'count' && <SimRule />}
                </>
              ) : (
                <span className="font-semibold text-pine">提交即生效，库存立即更新</span>
              )}
            </span>
            {blocking && phase.kind === 'edit' && <span className="text-[12.5px] font-semibold text-clay">{blocking}</span>}
          </div>
          {needsApproval && canApprove && (
            <label className="flex cursor-pointer items-center gap-2 text-[13px] font-semibold text-ink-2">
              <input type="checkbox" className="size-4 accent-[var(--color-pine)]" checked={approveNow} disabled={locked} onChange={(e) => setApproveNow(e.target.checked)} />
              同时以负责人身份确认
            </label>
          )}
          {(type === 'count' || editing || type === 'opening') && (
            <Button variant="secondary" disabled={locked || noLines || !!headerError} loading={phase.kind === 'submitting'} onClick={() => submit('save')}>
              存草稿
            </Button>
          )}
          <Button
            variant="primary"
            size="lg"
            disabled={locked || !!blocking}
            loading={phase.kind === 'submitting'}
            icon={<CircleCheck className="size-[18px]" />}
            onClick={() => submit('submit')}
          >
            {urgent ? '提交急采' : needsApproval ? (approveNow ? '提交并确认' : '提交确认') : `确认${meta.verb}`}
          </Button>
        </div>
      </footer>
    </>
  );
}

// ───────────────────────── 明细行 ─────────────────────────

type Resolved = ReturnType<typeof resolveQty>;
interface Row {
  line: LineDraft;
  m: Material | undefined;
  qty?: Resolved;
  error: string | null;
  ready: boolean;
  after?: number | null;
  amount?: number | null;
  rejected?: number | null;
  maxReturn?: number | null;
  book?: number | null;
  diff?: number | null;
  /** 盘点大差异（v0.7.30） */
  big?: boolean;
  accepted?: Resolved | null;
  delivered?: Resolved | null;
  price?: number | null;
  srcLine?: InvDoc['lines'][number];
  poLine?: PoLine;
}

/** 各类单据的列布局（容器足够宽时一行展示，平板上自动折行） */
const GRID: Record<InvDocType, string> = {
  opening: '@3xl:grid-cols-[minmax(0,1fr)_200px_minmax(0,0.6fr)_40px]',
  issue: '@3xl:grid-cols-[minmax(0,1fr)_110px_200px_110px_minmax(0,0.5fr)_40px]',
  direct_use: '@3xl:grid-cols-[minmax(0,1fr)_110px_200px_110px_minmax(0,0.5fr)_40px]',
  damage: '@3xl:grid-cols-[minmax(0,1fr)_110px_200px_110px_minmax(0,0.5fr)_40px]',
  issue_return: '@3xl:grid-cols-[minmax(0,1fr)_120px_200px_110px_minmax(0,0.5fr)_40px]',
  supplier_return: '@3xl:grid-cols-[minmax(0,1fr)_120px_200px_110px_110px_40px]',
  count: '@3xl:grid-cols-[minmax(0,1fr)_120px_200px_130px_minmax(0,0.5fr)_40px]',
  // 收货列多：容器足够宽（≥1024px）才排成一行，平板上分两行并显示字段名
  receipt: '@lg:grid-cols-3 @5xl:grid-cols-[minmax(0,1fr)_170px_170px_130px_140px_100px_40px]',
};

const HEADERS: Record<InvDocType, string[]> = {
  opening: ['物料', '期初数量', '备注', ''],
  issue: ['物料', '总仓库存', '领料数量', '领料后', '备注', ''],
  direct_use: ['物料', '当前库存', '耗用数量', '耗用后', '备注', ''],
  damage: ['物料', '当前库存', '报损数量', '报损后', '备注', ''],
  issue_return: ['物料（原领料）', '可退', '退回数量', '退回后总仓', '备注', ''],
  supplier_return: ['物料（原收货）', '可退', '退货数量', '退货后库存', '扣款', ''],
  count: ['物料', '账面数', '实盘数', '差异', '备注', ''],
  receipt: ['物料', '送达数量', '合格实收', '拒收', '单价', '金额', ''],
};

function LineHeader({ type }: { type: InvDocType }) {
  return (
    <div className={cn('hidden gap-3 border-b border-line bg-paper-2/60 px-5 py-2 text-[12px] font-bold text-ink-3', type === 'receipt' ? '@5xl:grid' : '@3xl:grid', GRID[type])}>
      {HEADERS[type].map((h, i) => (
        <span key={i} className={cn(i > 0 && h && !['备注'].includes(h) && 'text-right')}>
          {h}
        </span>
      ))}
    </div>
  );
}

function MaterialCell({ m, sub, type }: { m: Material; sub?: ReactNode; type?: InvDocType }) {
  return (
    <div className="min-w-0">
      <p className="line-clamp-2 text-[14px] leading-snug font-bold" title={m.name}>
        {m.name}
        {m.counterUse && (type === 'issue' || type === 'receipt') && (
          <Badge tone="lake" className="ml-1.5 align-middle">
            领到即耗用
          </Badge>
        )}
        {m.weighed && (type === 'receipt' || type === 'count') && (
          <Badge tone="lake" className="ml-1.5 align-middle">
            称重
          </Badge>
        )}
      </p>
      <p className="truncate text-[12px] text-ink-3">
        <span className="num font-semibold">{m.code}</span>
        {m.specification && <> · {m.specification}</>}
      </p>
      {sub && <p className="text-[12px] text-ink-3">{sub}</p>}
    </div>
  );
}

function Cell({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-w-0 items-baseline justify-between gap-2 @3xl:block @3xl:text-right', className)}>
      <span className="text-[12px] font-semibold text-ink-3 @3xl:hidden">{label}</span>
      {children}
    </div>
  );
}

function LineRow({
  type,
  row,
  locked,
  qtyRef,
  onPatch,
  onRemove,
}: {
  type: InvDocType;
  row: Row;
  locked: boolean;
  qtyRef: (el: HTMLInputElement | null) => void;
  onPatch: (p: Partial<LineDraft>) => void;
  onRemove?: () => void;
}) {
  const { line, m } = row;
  if (!m) return <li className="px-5 py-3 text-[13px] text-clay">物料不存在（可能已删除档案）</li>;
  const qtyLabel = QTY_LABEL[type] ?? '数量';
  const remove = onRemove && (
    <IconButton label="删除这一行" onClick={onRemove} disabled={locked} className="justify-self-end text-ink-3 hover:text-clay">
      <Trash2 className="size-4" />
    </IconButton>
  );
  const note = (
    <Input
      value={line.note}
      onChange={(e) => onPatch({ note: e.target.value })}
      disabled={locked}
      placeholder="备注"
      aria-label="行备注"
      maxLength={100}
      className="h-10 text-[13px]"
    />
  );

  return (
    <li className={cn('grid grid-cols-1 items-start gap-x-3 gap-y-2 px-5 py-3', type !== 'receipt' && '@lg:grid-cols-2', GRID[type], row.error && line.qty.text && 'bg-clay-soft/25')}>
      {type === 'receipt' ? (
        <ReceiptCells row={row} locked={locked} qtyRef={qtyRef} onPatch={onPatch} remove={remove} />
      ) : (
        <>
          <div className="flex items-start justify-between gap-2 @lg:col-span-2 @3xl:col-span-1">
            <MaterialCell
              m={m}
              type={type}
              sub={
                row.srcLine && (
                  <>
                    原{type === 'issue_return' ? '领' : '收'} <Qty milli={row.srcLine.qtyMilli} unit={row.srcLine.inventoryUnit} />
                    {row.srcLine.returnedMilli > 0 && (
                      <>
                        {' '}
                        · 已退 <Qty milli={row.srcLine.returnedMilli} unit={row.srcLine.inventoryUnit} />
                      </>
                    )}
                    {type === 'supplier_return' && (
                      <>
                        {' '}
                        · 现库存 <Qty milli={m.stockMilli} unit={m.inventoryUnit} />
                      </>
                    )}
                  </>
                )
              }
            />
            <span className="@3xl:hidden">{remove}</span>
          </div>

          {type === 'count' ? (
            <Cell label="账面数">
              <Qty milli={row.book ?? 0} unit={m.inventoryUnit} className="text-[14px] font-semibold text-ink-2 @3xl:pt-2.5" />
            </Cell>
          ) : type === 'opening' ? null : row.maxReturn !== undefined && row.maxReturn !== null ? (
            <Cell label="可退">
              <Qty milli={Math.max(0, row.maxReturn)} unit={m.inventoryUnit} className="text-[14px] font-semibold text-ink-2 @3xl:pt-2.5" />
            </Cell>
          ) : (
            <Cell label="当前库存">
              <Qty milli={m.stockMilli} unit={m.inventoryUnit} className={cn('text-[14px] font-semibold @3xl:pt-2.5', m.isLow ? 'text-clay' : 'text-ink-2')} />
            </Cell>
          )}

          <QtyInput
            label={type === 'count' ? '实盘数' : qtyLabel}
            material={m}
            value={line.qty}
            onChange={(v) => onPatch({ qty: v })}
            inputRef={qtyRef}
            allowPack={type !== 'count'}
            invalid={!!row.error && !!line.qty.text}
          />

          {type === 'count' ? (
            <Cell label="差异">
              <span className="@3xl:pt-2 @3xl:block">
                {row.diff === null || row.diff === undefined ? (
                  <span className="text-ink-4">—</span>
                ) : row.diff === 0 ? (
                  <span className="text-[13px] font-semibold text-pine">无差异</span>
                ) : (
                  <span className="inline-flex flex-col items-end">
                    <Qty milli={row.diff} unit={m.inventoryUnit} signed className={cn('text-[15px] font-bold', row.diff < 0 ? 'text-clay' : 'text-lake')} />
                    <span className="text-[11px] font-semibold text-yuzu-deep">{COUNT_REASON_LABELS.pending}</span>
                  </span>
                )}
              </span>
            </Cell>
          ) : type === 'opening' ? null : (
            <Cell label={HEADERS[type][3]!}>
              {row.after === null || row.after === undefined ? (
                <span className="text-ink-4 @3xl:block @3xl:pt-2.5">—</span>
              ) : (
                <Qty milli={row.after} unit={m.inventoryUnit} className={cn('text-[14px] font-bold @3xl:pt-2.5', row.after < 0 ? 'text-clay' : 'text-ink')} />
              )}
            </Cell>
          )}

          {type === 'supplier_return' ? (
            <Cell label="扣款">
              {row.amount != null ? <Money cents={row.amount} className="text-[14px] font-bold text-clay @3xl:pt-2.5" /> : <span className="text-ink-4">—</span>}
            </Cell>
          ) : (
            note
          )}
          <span className="hidden @3xl:block">{remove}</span>
          {row.error && line.qty.text && <p className="text-[12px] font-semibold text-clay @lg:col-span-2 @3xl:col-span-full">{row.error}</p>}
          {type === 'count' && line.stale && <p className="text-[12px] font-semibold text-clay @3xl:col-span-full">盘点后这项物料又有收发，需要按最新账面重新核对</p>}
          {type === 'count' && row.diff !== null && row.diff !== undefined && row.diff !== 0 && (
            <div className="flex flex-wrap items-center gap-2 @lg:col-span-2 @3xl:col-span-full" data-testid={`count-reason-${m.id}`}>
              <span className={cn('text-[12.5px] font-semibold', row.big ? 'text-clay' : 'text-ink-3')}>{row.big ? '大差异，必须写原因' : '差异原因（选填）'}</span>
              <Select
                fullWidth={false}
                value={line.diffReason ?? ''}
                onChange={(e) => onPatch({ diffReason: e.target.value as CountReason | '' })}
                disabled={locked}
                className="h-8 text-[12.5px]"
                aria-label={`${m.name}差异原因`}
              >
                <option value="">原因类别</option>
                {COUNT_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {COUNT_REASON_LABELS[r]}
                  </option>
                ))}
              </Select>
              <Input
                value={line.diffNote ?? ''}
                onChange={(e) => onPatch({ diffNote: e.target.value })}
                disabled={locked}
                maxLength={100}
                placeholder={row.big ? '说明（至少 2 个字）' : '说明（选填）'}
                className="h-8 min-w-0 flex-1 text-[12.5px]"
                aria-label={`${m.name}差异说明`}
              />
            </div>
          )}
        </>
      )}
    </li>
  );
}

function ReceiptCells({
  row,
  locked,
  qtyRef,
  onPatch,
  remove,
}: {
  row: Row;
  locked: boolean;
  qtyRef: (el: HTMLInputElement | null) => void;
  onPatch: (p: Partial<LineDraft>) => void;
  remove: ReactNode;
}) {
  const { line, m } = row;
  if (!m) return null;
  const caption = (text: string) => <span className="mb-1 block text-[12px] font-semibold text-ink-3 @5xl:hidden">{text}</span>;
  return (
    <>
      <div className="flex items-start justify-between gap-2 @lg:col-span-3 @5xl:col-span-1">
        <MaterialCell
          m={m}
          type="receipt"
          sub={
            <>
              {row.poLine && (
                <span className="block font-semibold text-lake">
                  订 <Qty milli={row.poLine.baseQtyMilli} unit={row.poLine.inventoryUnit} /> · 已收 <Qty milli={row.poLine.receivedMilli} unit={row.poLine.inventoryUnit} /> ·{' '}
                  {row.poLine.receivedMilli > row.poLine.baseQtyMilli ? (
                    <>
                      称重多到 <Qty milli={row.poLine.receivedMilli - row.poLine.baseQtyMilli} unit={row.poLine.inventoryUnit} />
                    </>
                  ) : (
                    <>
                      未到 <Qty milli={row.poLine.baseQtyMilli - row.poLine.receivedMilli} unit={row.poLine.inventoryUnit} />
                    </>
                  )}
                </span>
              )}
              {/* 按单收货（v0.7.8）：采购单行的规格与图片，库管核对实物 */}
              {row.poLine?.spec && <span className="block font-semibold text-ink-2">规格：{row.poLine.spec}</span>}
              {row.poLine && row.poLine.images.length > 0 && <ImageThumbs images={row.poLine.images} size={36} className="my-1" />}
              现库存 <Qty milli={m.stockMilli} unit={m.inventoryUnit} />
              {row.after != null && (
                <>
                  {' '}
                  → 入库后 <Qty milli={row.after} unit={m.inventoryUnit} className="font-semibold text-pine" />
                </>
              )}
            </>
          }
        />
        <span className="@5xl:hidden">{remove}</span>
      </div>
      <div className="min-w-0">
        {caption('送达数量')}
        <QtyInput
          label="送达数量"
          material={m}
          value={line.delivered}
          inputRef={qtyRef}
          onChange={(v) => onPatch(line.acceptedTouched ? { delivered: v } : { delivered: v, accepted: v })}
        />
      </div>
      <div className="min-w-0">
        {caption('合格实收')}
        <QtyInput label="合格实收" material={m} value={line.acceptedTouched ? line.accepted : line.delivered} onChange={(v) => onPatch({ accepted: v, acceptedTouched: true })} />
      </div>
      <div className="min-w-0">
        {caption('拒收')}
        {row.rejected ? (
          <>
            <Qty milli={row.rejected} unit={m.inventoryUnit} className="block text-right text-[14px] font-bold text-clay @5xl:pt-1" />
            <Input
              value={line.rejectReason}
              disabled={locked}
              onChange={(e) => onPatch({ rejectReason: e.target.value })}
              placeholder="拒收原因"
              aria-label="拒收原因"
              maxLength={100}
              invalid={!line.rejectReason.trim()}
              className="mt-1 h-9 text-[13px]"
            />
          </>
        ) : (
          <span className="block text-ink-4 @5xl:pt-2.5 @5xl:text-right">无</span>
        )}
      </div>
      <div className="min-w-0">
        {caption(`单价（元/${row.poLine?.purchaseUnit ?? m.purchaseUnit}）`)}
        <MoneyInput
          value={row.poLine ? centsToInput(row.poLine.priceCents) : line.price}
          disabled={locked || !!row.poLine}
          onChange={(e) => onPatch({ price: e.target.value })}
          aria-label={`单价（元/${row.poLine?.purchaseUnit ?? m.purchaseUnit}）`}
          className="h-10 text-right"
        />
        <p className="mt-1 hidden text-right text-[11.5px] text-ink-3 @5xl:block">{row.poLine ? '采购单价' : `元 / ${m.purchaseUnit}`}</p>
      </div>
      <div className="min-w-0 @5xl:text-right">
        {caption('金额')}
        {row.amount != null ? <Money cents={row.amount} className="text-[15px] font-bold text-pine @5xl:pt-2" /> : <span className="text-ink-4 @5xl:block @5xl:pt-2.5">—</span>}
      </div>
      <span className="hidden justify-self-end @5xl:block">{remove}</span>
      {m.expiryTracked && (
        <div className="flex flex-wrap items-center gap-2 @lg:col-span-3 @5xl:col-span-full" data-testid="receipt-expiry">
          <span className="text-[12px] font-semibold text-ink-3">效期</span>
          <Input fullWidth={false} value={line.batchNo ?? ''} disabled={locked} onChange={(e) => onPatch({ batchNo: e.target.value })} placeholder="批号（选填）" maxLength={40} className="h-9 w-36 text-[13px]" aria-label="批号" />
          <label className="flex items-center gap-1 text-[12px] text-ink-3">
            生产日期
            <Input fullWidth={false} type="date" value={line.producedOn ?? ''} disabled={locked} onChange={(e) => onPatch({ producedOn: e.target.value })} className="h-9 w-36 text-[13px]" aria-label="生产日期" />
          </label>
          <label className="flex items-center gap-1 text-[12px] text-ink-3">
            到期日
            <Input fullWidth={false} type="date" value={line.expiresOn ?? ''} disabled={locked} onChange={(e) => onPatch({ expiresOn: e.target.value })} className="h-9 w-36 text-[13px]" aria-label="到期日" data-testid="receipt-expires-on" />
          </label>
          {m.shelfLifeDays && <span className="text-[12px] text-ink-3">保质期 {m.shelfLifeDays} 天（只填生产日期的按它算）</span>}
        </div>
      )}
      {row.error && (line.delivered.text || line.price) && <p className="text-[12px] font-semibold text-clay @lg:col-span-3 @5xl:col-span-full">{row.error}</p>}
    </>
  );
}

// ───────────────────────── 辅助选择 ─────────────────────────

function SourcePicker({ type, value, onChange, disabled, className }: { type: 'issue' | 'receipt'; value: number | null; onChange: (id: number | null) => void; disabled?: boolean; className?: string }) {
  const docs = useInvDocs({ type, status: 'confirmed' });
  const [q, setQ] = useState('');
  const list = (docs.data ?? []).filter((d: InvDocSummary) => !q || `${d.docNo} ${d.partyName ?? ''} ${d.summary}`.includes(q.trim()));
  return (
    <Field label={type === 'issue' ? '原领料单' : '原收货单'} className={className} hint={value ? undefined : '只列出已生效的单据'}>
      <div className="flex gap-2">
        <Input
          fullWidth={false}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="单号 / 部门 / 物料"
          aria-label="搜索原单"
          disabled={disabled}
          className="h-10 w-40 shrink-0 text-[13px]"
        />
        <Select value={value ?? ''} onChange={(e) => onChange(Number(e.target.value) || null)} disabled={disabled} aria-label="选择原单" className="min-w-0 flex-1">
          <option value="">{docs.isPending ? '加载中…' : `选择（${list.length}）`}</option>
          {list.map((d) => (
            <option key={d.id} value={d.id}>
              {d.docNo} · {d.docDate.slice(5)} · {d.partyName ?? ''} · {d.summary}
            </option>
          ))}
        </Select>
      </div>
    </Field>
  );
}

function UsualChips({ departmentId, materials, taken, onAdd, disabled }: { departmentId: number | null; materials: Map<number, Material>; taken: Set<number>; onAdd: (m: Material, qty: number) => void; disabled?: boolean }) {
  const usual = useUsual(departmentId);
  const items = (usual.data ?? []).map((u) => ({ ...u, m: materials.get(u.materialId) })).filter((u) => u.m && !taken.has(u.materialId));
  if (!departmentId || items.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="text-[12px] font-semibold text-ink-3">常用</span>
      {items.slice(0, 6).map((u) => (
        <button
          key={u.materialId}
          type="button"
          disabled={disabled}
          onClick={() => onAdd(u.m!, u.lastQtyMilli)}
          title={`上次领料 ${formatQty(u.lastQtyMilli)} ${u.m!.inventoryUnit}，点击按上次数量加入`}
          className="flex h-7 items-center gap-1 rounded-full border border-line-strong bg-card px-2.5 text-[12.5px] font-semibold text-ink-2 hover:border-pine hover:text-pine"
        >
          <ListPlus className="size-3.5" />
          {u.m!.name}
          <Qty milli={u.lastQtyMilli} unit={u.m!.inventoryUnit} className="text-ink-3" />
        </button>
      ))}
    </div>
  );
}

function CountFillMenu({ materials, taken, onAdd }: { materials: Material[]; taken: Set<number>; onAdd: (list: Material[]) => void }) {
  const tracked = materials.filter((m) => m.tracked && m.active && !taken.has(m.id));
  const categories = [...new Set(tracked.map((m) => m.category || '未分类'))];
  if (tracked.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[12px] font-semibold text-ink-3">带出物料</span>
      <button type="button" onClick={() => onAdd(tracked)} className="h-7 rounded-full bg-pine px-3 text-[12.5px] font-bold text-paper hover:bg-pine-hover">
        全部 {tracked.length}
      </button>
      {categories.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onAdd(tracked.filter((m) => (m.category || '未分类') === c))}
          className="h-7 rounded-full border border-line-strong bg-card px-2.5 text-[12.5px] font-semibold text-ink-2 hover:border-pine hover:text-pine"
        >
          {c}
        </button>
      ))}
    </div>
  );
}

// ───────────────────────── 完成 ─────────────────────────

function DoneView({ scope, type, doc, replayed, onAgain }: { scope: FormScope; type: InvDocType; doc: InvDoc; replayed: boolean; onAgain: () => void }) {
  const navigate = useNavigate();
  const meta = doc.urgent ? { ...INV_DOC_META[type], title: '急采' } : INV_DOC_META[type];
  const effective = doc.status === 'confirmed';
  return (
    <>
      <PageHeader dateMode="calendar" title={meta.title} />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-lg flex-col items-center px-6 py-14 text-center">
          <span className={cn('flex size-16 animate-pop items-center justify-center rounded-full', effective ? 'bg-pine text-paper' : 'bg-yuzu text-ink')}>
            <svg viewBox="0 0 24 24" className="size-8" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
              <path className="draw-check" d="M5 12.5l4.5 4.5L19 7.5" />
            </svg>
          </span>
          <h2 className="mt-5 text-[22px] font-bold">
            {effective
              ? `${meta.title}已生效`
              : doc.status === 'draft'
                ? '草稿已保存'
                : doc.urgent
                  ? doc.urgentApprovedAt
                    ? '已批准，等仓库到部门验收'
                    : '已提交，按金额分级审批'
                  : '已提交，等待负责人确认'}
          </h2>
          <p className="num mt-1 text-[15px] font-semibold text-ink-2">{doc.docNo}</p>
          <div className="mt-3">
            <StatusChip status={doc.status} />
          </div>
          <p className="mt-4 text-[13.5px] leading-relaxed text-ink-3">
            {replayed
              ? '这是同一次操作的结果，服务器只记录了一次。'
              : effective
                ? '库存与库存卡已经更新。'
                : doc.status === 'draft'
                  ? '草稿不影响库存，可以稍后继续修改再提交。'
                  : doc.urgent
                    ? '审批人在审批中心批了以后，仓库到部门验收；验收确认前不影响库存或货款，确认后进部门小仓，再由采购补采购单（提交即确认）。'
                    : '确认前不影响库存或货款。负责人可以在「待办」里确认或退回修改。'}
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-2.5">
            <Button variant="secondary" onClick={() => navigate(scope.docLink(doc.id))}>
              查看单据
            </Button>
            <Button variant="secondary" onClick={() => navigate(scope.home)}>
              {scope.dept ? '回到本部门小仓' : scope.kind === 'urgent' ? '回到急采' : '回到库存'}
            </Button>
            <Button variant="primary" onClick={onAgain}>
              再录一张{meta.title}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

