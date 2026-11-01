// 本部门小仓（v0.7.11，飞书需求 RQ-002 第一步，docs/WAREHOUSES.md）：部门申购看本部门小仓的结存、签收仓库登记的领料、
// 登记急采与补采购单、本部门的期初、耗用、报损、盘点；财务成本岗可看所有部门、给部门盘点、登记耗用。
// 数据都从 /api/erp/dept-stock 取：部门的员工没有「查看库存」，看不到总仓的结存与参考价。

import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { CircleAlert, ClipboardCheck, Droplets, FilePen, Flag, PackageCheck, PackagePlus, PackageX, ReceiptText, Send, X } from 'lucide-react';
import { COUNT_REASON_LABELS, INV_DOC_META, type DeptStockMeta, type InvDoc, type InvDocSummary, type InvDocType } from '@shared/inventory';
import { formatQty } from '@shared/quantity';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { useSession } from '../../lib/session';
import { cn, formatDateTime, relativeTime, uuid } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { Sheet } from '../../components/Overlay';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, IconButton, Notice, Segmented, Select, Skeleton, Spinner, Textarea } from '../../components/ui';
import { ErpPage } from '../erp/ErpHome';
import { Qty, SimRule, StatusChip } from '../inventory/parts';
import { useDeptDoc, useDeptDocs, useDeptMeta, useDeptStock, useInvalidateDept } from './queries';

type View = 'stock' | 'sign' | 'docs';

/** 部门能登记的单据（领料与退回由仓库登记） */
const ACTIONS: { type: InvDocType; label: string; icon: typeof PackagePlus; audit?: boolean }[] = [
  { type: 'receipt', label: '登记急采', icon: PackagePlus },
  { type: 'direct_use', label: '耗用', icon: Droplets, audit: true },
  { type: 'damage', label: '报损', icon: PackageX },
  { type: 'count', label: '盘点', icon: ClipboardCheck, audit: true },
  { type: 'opening', label: '期初', icon: Flag },
];

const docTitle = (d: { docType: InvDocType; urgent: boolean }) => (d.urgent ? '急采' : INV_DOC_META[d.docType].title);

export function DeptStockPage() {
  const meta = useDeptMeta();
  const [params, setParams] = useSearchParams();
  const departments = meta.data?.departments ?? [];
  const deptId = Number(params.get('dept')) || (meta.data?.myDepartmentId && departments.some((d) => d.id === meta.data!.myDepartmentId) ? meta.data.myDepartmentId : departments[0]?.id) || null;
  const dept = departments.find((d) => d.id === deptId) ?? null;
  const view = (['stock', 'sign', 'docs'] as const).find((v) => v === params.get('view')) ?? 'stock';
  const docId = Number(params.get('doc')) || null;
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  };
  const unsigned = useDeptDocs(dept?.id ?? null, { unsigned: '1' });

  return (
    <ErpPage
      title={dept ? `${dept.name}小仓` : '本部门小仓'}
      description="本部门从仓库领来的和自己急采的东西：结存、签收领料、急采与补单、耗用、报损、盘点。领料由仓库登记、部门签收；小仓的盘点差异由部门自己管。"
      actions={
        dept && meta.data ? (
          <div className="flex flex-wrap gap-2">
            {ACTIONS.filter((a) => meta.data!.canOperate || a.audit).map((a) => {
              const Icon = a.icon;
              return (
                <Link key={a.type} to={`/erp/dept-stock/new/${a.type}?dept=${dept.id}`} data-testid={`dept-new-${a.type}`}>
                  <Button variant={a.type === 'receipt' ? 'primary' : 'secondary'} icon={<Icon className="size-4" />}>
                    {a.label}
                  </Button>
                </Link>
              );
            })}
          </div>
        ) : undefined
      }
    >
      <div className="space-y-4" data-testid="dept-stock-page">
        {meta.isPending ? (
          <Skeleton className="h-64" />
        ) : meta.error ? (
          <Notice tone="error" title={errorMessage(meta.error)} />
        ) : !dept ? (
          <Notice tone="warning" title="你的员工档案里还没有所属部门">
            请店主在「后台 → 员工」里给你选所属部门，之后才能看本部门的小仓。
          </Notice>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              {departments.length > 1 && (
                <Select aria-label="部门" value={dept.id} onChange={(e) => set({ dept: e.target.value, doc: null })} fullWidth={false} className="w-40" data-testid="dept-select">
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}小仓
                    </option>
                  ))}
                </Select>
              )}
              <Segmented<View>
                ariaLabel="本部门小仓视图"
                value={view}
                onChange={(v) => set({ view: v === 'stock' ? null : v })}
                options={[
                  { value: 'stock', label: '结存' },
                  { value: 'sign', label: `待签收${unsigned.data?.length ? ` ${unsigned.data.length}` : ''}` },
                  { value: 'docs', label: '单据' },
                ]}
              />
            </div>
            {view === 'stock' && <StockList deptId={dept.id} />}
            {view === 'sign' && <DocList deptId={dept.id} meta={meta.data!} filter={{ unsigned: '1' }} empty="没有待签收的领料" onOpen={(id) => set({ doc: String(id) })} />}
            {view === 'docs' && <DocsView deptId={dept.id} meta={meta.data!} onOpen={(id) => set({ doc: String(id) })} />}
          </>
        )}
      </div>
      {dept && meta.data && <DeptDocSheet id={docId} dept={dept} meta={meta.data} onClose={() => set({ doc: null })} />}
    </ErpPage>
  );
}

function StockList({ deptId }: { deptId: number }) {
  const stock = useDeptStock(deptId);
  if (stock.isPending) return <Skeleton className="h-64" />;
  if (stock.error) return <Notice tone="error" title={errorMessage(stock.error)} />;
  if (stock.data!.length === 0) {
    return <EmptyState art="leaf" title="小仓里还没有东西" description="仓库登记领料、急采验收后，或者登记了期初，这里就会有结存。" />;
  }
  return (
    <Card className="overflow-hidden">
      <ul className="divide-y divide-line/70" aria-label="本部门小仓结存" data-testid="dept-stock-list">
        {stock.data!.map((r) => (
          <li key={r.materialId} className={cn('grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 px-4 py-2.5', r.stockMilli === 0 && 'opacity-60')}>
            <span className="min-w-0">
              <span className="flex items-center gap-2">
                <span className="truncate text-[14px] font-bold">{r.name}</span>
                {r.isLow && <Badge tone="clay">该补货了</Badge>}
              </span>
              <span className="num block truncate text-[12px] text-ink-3">
                {r.code}
                {r.specification && ` · ${r.specification}`}
                {r.category && ` · ${r.category}`}
              </span>
            </span>
            <span className="text-right">
              <Qty milli={r.stockMilli} unit={r.inventoryUnit} className={cn('text-[17px] font-bold', r.isLow && 'text-clay')} />
              <span className="block text-[11.5px] text-ink-3">
                {r.daysOfCover !== null ? `可用 ${r.daysOfCover} 天${r.coverDays !== null ? ` · 提醒 ${r.coverDays} 天` : ''}` : relativeTime(r.lastMoveAt)}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function DocsView({ deptId, meta, onOpen }: { deptId: number; meta: DeptStockMeta; onOpen: (id: number) => void }) {
  const [filter, setFilter] = useState<'all' | 'urgent' | 'backfill'>('all');
  return (
    <div className="space-y-3">
      <Segmented
        size="sm"
        ariaLabel="单据筛选"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: '全部' },
          { value: 'urgent', label: '急采' },
          { value: 'backfill', label: '急采待补单' },
        ]}
      />
      <DocList
        deptId={deptId}
        meta={meta}
        filter={filter === 'all' ? {} : { urgent: '1' }}
        only={filter === 'backfill' ? (d) => d.needsBackfill : undefined}
        empty={filter === 'backfill' ? '没有待补采购单的急采' : '还没有单据'}
        onOpen={onOpen}
      />
    </div>
  );
}

function DocList({
  deptId,
  filter,
  only,
  empty,
  onOpen,
}: {
  deptId: number;
  meta: DeptStockMeta;
  filter: { unsigned?: string; urgent?: string };
  only?: (d: InvDocSummary) => boolean;
  empty: string;
  onOpen: (id: number) => void;
}) {
  const docs = useDeptDocs(deptId, filter);
  if (docs.isPending) return <Skeleton className="h-48" />;
  if (docs.error) return <Notice tone="error" title={errorMessage(docs.error)} />;
  const list = only ? docs.data!.filter(only) : docs.data!;
  if (list.length === 0) return <EmptyState art="calm" title={empty} />;
  return (
    <Card className="overflow-hidden">
      <ul className="divide-y divide-line/70">
        {list.map((d) => (
          <li key={d.id}>
            <button
              type="button"
              onClick={() => onOpen(d.id)}
              className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-paper-2 md:grid-cols-[150px_minmax(0,1fr)_auto]"
              data-testid={`dept-doc-${d.id}`}
            >
              <span className="num text-[13.5px] font-bold">
                {d.docNo}
                <span className="block font-sans text-[12px] font-medium text-ink-3">{d.docDate}</span>
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[13.5px] font-semibold">
                  {docTitle(d)} · {d.summary || '—'}
                  {d.lineCount > 3 ? ` 等 ${d.lineCount} 行` : ''}
                </span>
                <span className="block truncate text-[12px] text-ink-3">
                  {d.partyName ?? ''} · {d.createdByName}
                  {d.amountCents > 0 && <> · <Money cents={d.amountCents} /></>}
                </span>
              </span>
              <span className="flex flex-wrap items-center justify-end gap-1.5">
                {d.deptSigned === false && <Badge tone="yuzu">待签收</Badge>}
                {d.deptSigned === true && <Badge tone="pine">已签收</Badge>}
                {d.needsBackfill && <Badge tone="clay">待补采购单</Badge>}
                <StatusChip status={d.status} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** 补采购单的操作编号存在本机：断网或超时后按同一编号重提，不会补出两张采购单 */
const BACKFILL_KEY = (docId: number) => `yuzu.deptBackfill.v1.${docId}`;
function backfillKey(docId: number): string | null {
  try {
    const saved = localStorage.getItem(BACKFILL_KEY(docId));
    if (saved) return saved;
    const key = uuid();
    localStorage.setItem(BACKFILL_KEY(docId), key);
    return localStorage.getItem(BACKFILL_KEY(docId)) === key ? key : null;
  } catch {
    return null;
  }
}
function clearBackfillKey(docId: number) {
  try {
    localStorage.removeItem(BACKFILL_KEY(docId));
  } catch {
    /* 不可写时忽略 */
  }
}

function DeptDocSheet({ id, dept, meta, onClose }: { id: number | null; dept: { id: number; name: string }; meta: DeptStockMeta; onClose: () => void }) {
  return (
    <Sheet open={!!id} onClose={onClose} label="本部门小仓单据" width="w-[min(620px,100vw)]">
      {id && <DeptDocDetail key={id} id={id} dept={dept} meta={meta} onClose={onClose} />}
    </Sheet>
  );
}

function DeptDocDetail({ id, dept, meta, onClose }: { id: number; dept: { id: number; name: string }; meta: DeptStockMeta; onClose: () => void }) {
  const session = useSession();
  const toast = useToast();
  const invalidate = useInvalidateDept();
  const q = useDeptDoc(id);
  const [busy, setBusy] = useState<string | null>(null);
  const [signNote, setSignNote] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (q.error) return <Notice tone="error" title={errorMessage(q.error)} className="m-5" />;
  if (!q.data)
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  const doc = q.data;
  const unit = (l: InvDoc['lines'][number]) => l.inventoryUnit;
  const canOperate = meta.canOperate;
  const mine = doc.createdBy === session.staff.id;

  const run = async (name: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
      toast({ tone: 'success', title: done, body: doc.docNo });
      await invalidate();
    } catch (e) {
      if (e instanceof UncertainError) setError('网络不稳，结果待确认：请稍后刷新这张单查看；重新点一次不会重复办理。');
      else setError(errorMessage(e));
      void q.refetch();
    } finally {
      setBusy(null);
    }
  };

  const sign = () => run('sign', () => api.post(`/api/erp/dept-stock/docs/${id}/sign`, { note: signNote.trim() }), '已签收');
  const submit = () => run('submit', () => api.post(`/api/erp/dept-stock/docs/${id}/submit`, {}), doc.urgent ? '已提交，等仓库验收' : '已提交');
  const backfill = () => {
    const key = backfillKey(id);
    if (!key) {
      setError('本机浏览器无法保存操作编号（存储空间已满或被禁用），为防止断网后补出两张采购单，这次没有提交。');
      return;
    }
    void run(
      'backfill',
      async () => {
        await api.post(`/api/erp/dept-stock/docs/${id}/backfill`, { clientKey: key }, { timeoutMs: 20_000 });
        clearBackfillKey(id);
      },
      '已补采购单，并由本部门确认',
    );
  };

  const canSign = doc.docType === 'issue' && doc.status === 'confirmed' && doc.warehouse !== null && !doc.deptSign && canOperate;
  const canBackfill = doc.urgent && doc.status === 'confirmed' && !doc.purchaseOrder && canOperate;
  const editable = (doc.status === 'draft' || doc.status === 'returned') && (mine || session.staff.role === 'owner');

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-start gap-3 border-b border-line bg-card px-5 py-4">
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-semibold text-ink-3">
            {dept.name}小仓 · {docTitle(doc)}
          </p>
          <h2 className="num text-[18px] font-bold">{doc.docNo}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <StatusChip status={doc.status} />
            {doc.urgent && <Badge tone="yuzu">急采 · 上限 <Money cents={doc.urgentCapCents ?? 0} /></Badge>}
            {doc.deptSign && <Badge tone="pine">已签收</Badge>}
          </div>
        </div>
        <IconButton label="关闭" onClick={onClose} className="-mt-1 -mr-2">
          <X className="size-[18px]" />
        </IconButton>
      </header>

      <div className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
          <Info label="单据日期" value={doc.docDate} />
          <Info label={doc.docType === 'receipt' ? '供应商' : '部门'} value={doc.supplier?.name ?? doc.department?.name ?? '—'} />
          {doc.handler && <Info label={doc.docType === 'issue' ? '领料人' : '经手人'} value={doc.handler} />}
          <Info label="登记" value={`${doc.createdByName} · ${formatDateTime(doc.createdAt)}`} />
          {doc.confirmedByName && <Info label={doc.urgent ? '仓库验收' : '生效'} value={`${doc.confirmedByName} · ${doc.confirmedAt ? formatDateTime(doc.confirmedAt) : ''}`} />}
          {doc.purchaseOrder && <Info label="补的采购单" value={doc.purchaseOrder.docNo} />}
          {doc.note && <Info label="备注" value={doc.note} wide />}
        </dl>

        {doc.status === 'returned' && doc.returnedReason && <Notice tone="warning" title="退回修改">{doc.returnedReason}</Notice>}
        {doc.urgent && doc.status === 'submitted' && (
          <Notice tone="info" title="等仓库到部门验收">仓库验收确认后才进本部门小仓、记货款；验收前可以撤回。</Notice>
        )}
        {doc.deptSign && (
          <Notice tone="success" title={`${doc.deptSign.signedByName} 已签收 · ${formatDateTime(doc.deptSign.signedAt)}`}>
            {doc.deptSign.note || '没有差异'}
          </Notice>
        )}

        <section>
          <h3 className="mb-2 text-[13px] font-bold text-ink-2">明细</h3>
          <ul className="divide-y divide-line/70 rounded-lg border border-line">
            {doc.lines.map((l) => (
              <li key={l.id} className="flex items-start gap-3 px-3.5 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-bold">{l.materialName}</span>
                  <span className="num block truncate text-[12px] text-ink-3">
                    {l.materialCode}
                    {l.specification && ` · ${l.specification}`}
                    {doc.docType === 'count' && l.bookMilli !== null && l.countedMilli !== null && (
                      <>
                        {' '}
                        · 账面 {formatQty(l.bookMilli)} → 实盘 {formatQty(l.countedMilli)}
                        {l.diffReason && ` · ${COUNT_REASON_LABELS[l.diffReason]}`}
                      </>
                    )}
                    {l.priceCents !== null && doc.docType === 'receipt' && <> · 单价 <Money cents={l.priceCents} />/{l.purchaseUnit}</>}
                    {l.note && ` · ${l.note}`}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <Qty
                    milli={doc.docType === 'count' ? l.qtyMilli : INV_DOC_META[doc.docType].direction === 'out' && doc.docType !== 'issue' ? -l.qtyMilli : l.qtyMilli}
                    unit={unit(l)}
                    signed
                    className="text-[14px] font-bold"
                  />
                  {l.amountCents !== null && doc.docType === 'receipt' && <Money cents={l.amountCents} className="block text-[12px] text-ink-3" />}
                </span>
              </li>
            ))}
          </ul>
          {doc.docType === 'receipt' && (
            <p className="mt-2 text-right text-[13px]">
              合计 <Money cents={doc.amountCents} className="text-[16px] font-bold" />
            </p>
          )}
        </section>

        {canSign && (
          <section className="rounded-lg border border-yuzu-deep/30 bg-yuzu-tint/60 p-3.5" data-testid="dept-sign">
            <p className="flex items-center gap-1.5 text-[13.5px] font-bold">
              <PackageCheck className="size-4" />
              部门签收（第二次验收）
              <SimRule />
            </p>
            <p className="mt-1 text-[12.5px] text-ink-3">
              对照实物核对数量；有差异写在下面，仓库据此做退回或盘点。超过 {meta.signDueDays} 天没签收会在仓库的待办里标出。
            </p>
            <Textarea value={signNote} onChange={(e) => setSignNote(e.target.value)} maxLength={200} rows={2} placeholder="差异说明（没有差异可以不填）" aria-label="签收差异说明" className="mt-2" />
            <div className="mt-2 flex justify-end">
              <Button variant="primary" loading={busy === 'sign'} icon={<PackageCheck className="size-4" />} onClick={sign} data-testid="dept-sign-submit">
                签收
              </Button>
            </div>
          </section>
        )}

        {canBackfill && (
          <Notice
            tone="warning"
            title="急采后要补采购单"
            icon={<CircleAlert className="size-5" />}
            action={
              <Button size="sm" variant="primary" loading={busy === 'backfill'} icon={<ReceiptText className="size-4" />} onClick={backfill} data-testid="dept-backfill">
                补采购单
              </Button>
            }
          >
            按这张急采的数量和价格生成采购单，由本部门确认；不会再入库或记货款。
          </Notice>
        )}

        {error && <Notice tone="error" title={error} />}

        {doc.approvals.length > 0 && (
          <section>
            <h3 className="mb-2 text-[13px] font-bold text-ink-2">记录</h3>
            <ol className="space-y-1 text-[12.5px] text-ink-2">
              {doc.approvals.map((a) => (
                <li key={a.id}>
                  <span className="num text-ink-3">{formatDateTime(a.createdAt)}</span> · {a.actorName} · {APPROVAL_LABELS[a.action] ?? a.action}
                  {a.reason && `：${a.reason}`}
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>

      {editable && (
        <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-line bg-card px-5 py-3">
          <Button variant="ghost" disabled={!!busy} onClick={() => setCancelOpen(true)}>
            撤回
          </Button>
          <Link to={`/erp/dept-stock/docs/${doc.id}/edit?dept=${dept.id}`}>
            <Button variant="secondary" icon={<FilePen className="size-4" />}>
              修改
            </Button>
          </Link>
          <Button variant="primary" loading={busy === 'submit'} icon={<Send className="size-4" />} onClick={submit}>
            提交
          </Button>
        </footer>
      )}
      {doc.status === 'submitted' && (mine || session.staff.role === 'owner') && (
        <footer className="flex shrink-0 justify-end gap-2 border-t border-line bg-card px-5 py-3">
          <Button variant="ghost" disabled={!!busy} onClick={() => setCancelOpen(true)}>
            撤回
          </Button>
        </footer>
      )}
      <ReasonDialog
        open={cancelOpen}
        title={`撤回 ${doc.docNo}`}
        description="撤回未生效的单据，不影响库存。"
        confirmLabel="确认撤回"
        busy={busy === 'cancel'}
        onClose={() => setCancelOpen(false)}
        onConfirm={async (reason) => {
          await run('cancel', () => api.post(`/api/erp/dept-stock/docs/${id}/cancel`, { reason }), '已撤回');
          setCancelOpen(false);
        }}
      />
    </div>
  );
}

const APPROVAL_LABELS: Record<string, string> = {
  create: '登记',
  submit: '提交',
  approve: '确认生效',
  return: '退回修改',
  cancel: '撤回',
  void: '冲销',
  sign: '部门签收',
  revise: '修改',
  close: '关闭',
};

function Info({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={cn('min-w-0', wide && 'col-span-2')}>
      <dt className="text-[12px] font-semibold text-ink-3">{label}</dt>
      <dd className="truncate">{value}</dd>
    </div>
  );
}
