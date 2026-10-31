// 部门采购需求单（v0.7.8，飞书需求 RQ-005 第二步）：部门提需求、采购审核；采购勾选已通过的行转采购单。
// 每一行的下单、到货、退货由采购单与收货单算出来（不手填）。

import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ClipboardList, ExternalLink, PackageCheck, Pencil, Plus, ShoppingCart, X } from 'lucide-react';
import { formatQty } from '@shared/quantity';
import { REQUEST_STATUS_LABELS, type PurchaseRequest, type RequestLine, type RequestLineProgress, type RequestStatus } from '@shared/requests';
import { api, errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn, formatDateTime } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { ImageThumbs } from '../../components/Images';
import { Money } from '../../components/Money';
import { Sheet } from '../../components/Overlay';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Notice, Segmented, Select, Skeleton } from '../../components/ui';
import { ErpPage } from '../erp/ErpHome';
import { useInvalidateRequests, useOpenLines, useRequest, useRequestMeta, useRequests } from './queries';

export const REQUEST_STATUS_TONE: Record<RequestStatus, 'pine' | 'yuzu' | 'neutral' | 'clay'> = {
  submitted: 'yuzu',
  returned: 'clay',
  approved: 'pine',
  rejected: 'neutral',
  cancelled: 'neutral',
};

const PROGRESS: Record<RequestLineProgress['state'], { label: string; tone: 'neutral' | 'lake' | 'yuzu' | 'pine' }> = {
  none: { label: '未下单', tone: 'neutral' },
  ordered: { label: '已下单', tone: 'lake' },
  partial: { label: '部分到货', tone: 'yuzu' },
  received: { label: '已到货', tone: 'pine' },
};

const ACTION_LABELS: Record<string, string> = { create: '新建', submit: '提交', revise: '修改', approve: '通过', return: '退回', cancel: '结束' };

export function RequestsPage() {
  const can = useCan();
  const meta = useRequestMeta();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'open' && can('request.review') ? 'open' : 'list';
  const [status, setStatus] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const list = useRequests({ status: status || undefined, departmentId: departmentId || undefined });
  const openId = Number(params.get('request')) || null;
  const setView = (v: 'list' | 'open') => setParams(v === 'open' ? { view: 'open' } : {}, { replace: true });
  const open = (id: number | null) => setParams(id ? { request: String(id) } : {}, { replace: true });
  const me = list.data?.me ?? meta.data?.me;

  return (
    <ErpPage
      title="采购需求单"
      description="部门提需求（新产品要带参考链接和图片），采购审核后勾选转采购单；下单、到货、退货由采购单与收货单自动回写。"
      actions={
        <div className="flex flex-wrap gap-2">
          {can('request.create') && (
            <Link to="/erp/requests/new">
              <Button variant="primary" icon={<Plus className="size-4" />} data-testid="request-new">
                提需求
              </Button>
            </Link>
          )}
        </div>
      }
    >
      <div className="space-y-4" data-testid="requests-page">
        <ErpPendingPanel types={['purchase_request']} onFound={(_, ref) => open(ref.refId)} />
        {me && !me.canReview && me.canCreate && !me.departmentId && (
          <Notice tone="warning" title="你的员工档案里还没有填所属部门">请店主在「后台 → 员工」里给你选所属部门，之后才能提需求单。</Notice>
        )}
        {can('request.review') && (
          <Segmented
            ariaLabel="需求单视图"
            value={view}
            onChange={setView}
            options={[
              { value: 'list', label: '需求单' },
              { value: 'open', label: '待转采购单' },
            ]}
          />
        )}
        {view === 'open' ? (
          <OpenLines />
        ) : (
          <>
            <Card className="flex flex-wrap items-center gap-2 p-3">
              <Select aria-label="状态" value={status} onChange={(e) => setStatus(e.target.value)} fullWidth={false} className="w-36" data-testid="requests-status">
                <option value="">全部状态</option>
                {(Object.keys(REQUEST_STATUS_LABELS) as RequestStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {REQUEST_STATUS_LABELS[s]}
                  </option>
                ))}
              </Select>
              {me?.canReview && (
                <Select aria-label="部门" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} fullWidth={false} className="w-40">
                  <option value="">全部部门</option>
                  {meta.data?.departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              )}
              {me && !me.canReview && me.departmentName && <span className="text-[13px] text-ink-2">只显示 {me.departmentName} 的需求单与你提的</span>}
            </Card>
            {list.isPending ? (
              <Skeleton className="h-64" />
            ) : list.error ? (
              <Notice tone="error" title={errorMessage(list.error)} />
            ) : list.data!.requests.length === 0 ? (
              <EmptyState art="calm" title="还没有需求单" description={can('request.create') ? '点「提需求」登记要买的东西。' : undefined} />
            ) : (
              <Card className="overflow-hidden">
                <ul className="divide-y divide-line/70">
                  {list.data!.requests.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        onClick={() => open(r.id)}
                        className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-paper-2 md:grid-cols-[150px_minmax(0,1fr)_150px_auto]"
                        data-testid={`request-row-${r.id}`}
                      >
                        <span className="num text-[13.5px] font-bold">
                          {r.docNo}
                          <span className="block font-sans text-[12px] font-medium text-ink-3">{formatDateTime(r.createdAt)}</span>
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-[13.5px] font-semibold">
                            {r.summary || '—'}
                            {r.lineCount > 3 ? ` 等 ${r.lineCount} 行` : ''}
                          </span>
                          <span className="block truncate text-[12px] text-ink-3">
                            {r.department.name} · {r.requester.name}
                            {r.needBy ? ` · ${r.needBy} 前要` : ''}
                          </span>
                        </span>
                        <span className="hidden text-[12.5px] text-ink-2 md:block">
                          {r.status === 'approved' ? `已下单 ${r.orderedLines}/${r.lineCount} 行 · 到货 ${r.receivedLines} 行` : `${r.lineCount} 行`}
                        </span>
                        <Badge tone={REQUEST_STATUS_TONE[r.status]} className="justify-self-start md:justify-self-auto">
                          {REQUEST_STATUS_LABELS[r.status]}
                        </Badge>
                      </button>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </>
        )}
      </div>
      <RequestSheet id={openId} onClose={() => open(null)} />
    </ErpPage>
  );
}

/** 已通过、还没下单的行：勾选后转采购单（可以跨几张需求单；同一物料的几行会合并成采购单的一行） */
function OpenLines() {
  const navigate = useNavigate();
  const lines = useOpenLines(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const toggle = (id: number) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  if (lines.isPending) return <Skeleton className="h-64" />;
  if (lines.error) return <Notice tone="error" title={errorMessage(lines.error)} />;
  if (lines.data!.length === 0) return <EmptyState art="calm" title="没有待转采购单的需求" description="通过审核、还没下单的需求行会列在这里。" />;
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <span className="text-[13px] text-ink-2">勾选要一起下单的行（同一供应商）。同一物料的几行会合并成采购单的一行；新产品在采购单里选或新建物料。</span>
        <Button
          variant="primary"
          icon={<ShoppingCart className="size-4" />}
          disabled={picked.size === 0}
          className="ml-auto"
          onClick={() => navigate(`/purchasing/new?requestLines=${[...picked].join(',')}`)}
          data-testid="open-lines-to-po"
        >
          转采购单{picked.size > 0 ? `（${picked.size} 行）` : ''}
        </Button>
      </div>
      <ul className="divide-y divide-line/70">
        {lines.data!.map((l) => (
          <li key={l.id} className={cn('grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-4 py-3', picked.has(l.id) && 'bg-pine-tint/40')}>
            <input
              type="checkbox"
              className="mt-1 size-4 accent-[var(--color-pine)]"
              checked={picked.has(l.id)}
              onChange={() => toggle(l.id)}
              aria-label={`选择 ${l.requestNo} ${l.name}`}
              data-testid={`open-line-${l.id}`}
            />
            <div className="min-w-0 space-y-1">
              <p className="flex flex-wrap items-baseline gap-x-2 text-[13.5px]">
                <span className="font-bold">{l.name}</span>
                {l.materialId ? <span className="text-[12px] text-ink-3">物料：{l.materialName}</span> : <Badge tone="yuzu">新产品</Badge>}
                <span className="num font-semibold">
                  {formatQty(l.qtyMilli)} {l.unit}
                </span>
                {l.refPriceCents !== null && (
                  <span className="text-[12px] text-ink-3">
                    参考单价 <Money cents={l.refPriceCents} />
                  </span>
                )}
              </p>
              <p className="text-[12px] text-ink-3">
                <span className="num">{l.requestNo}</span> · {l.department.name} · {l.requesterName} · {l.purpose}
                {l.details && ` · ${l.details}`}
              </p>
              {l.link && <ExternalLinkText href={l.link} />}
              <ImageThumbs images={l.images} size={40} />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ExternalLinkText({ href }: { href: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1 text-[12.5px] font-semibold text-lake hover:underline">
      <ExternalLink className="size-3.5 shrink-0" />
      <span className="truncate">{href}</span>
    </a>
  );
}

function ProgressText({ p, canSeePo }: { p: RequestLineProgress; canSeePo: boolean }) {
  const s = PROGRESS[p.state];
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-ink-3">
      <Badge tone={s.tone}>{s.label}</Badge>
      {p.po && (
        <>
          {canSeePo ? (
            <Link to={`/purchasing?po=${p.po.id}`} className="num font-semibold text-lake hover:underline">
              {p.po.docNo}
            </Link>
          ) : (
            <span className="num font-semibold">{p.po.docNo}</span>
          )}
          <span>{p.po.supplierName}</span>
          <span className="num">
            下单 {formatQty(p.orderedMilli)} · 到货 {formatQty(p.receivedMilli)}
            {p.returnedMilli > 0 && ` · 退货 ${formatQty(p.returnedMilli)}`} {p.inventoryUnit}
          </span>
          {p.mergedLines > 1 && <span>（与另外 {p.mergedLines - 1} 行需求合并下单，数量是整行的）</span>}
        </>
      )}
    </span>
  );
}

function LineCard({ l, canSeePo }: { l: RequestLine; canSeePo: boolean }) {
  return (
    <li className="space-y-1 px-3 py-2.5 text-[13.5px]" data-testid={`request-line-${l.lineNo}`}>
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-semibold">{l.name}</span>
        {l.materialId ? <span className="text-[12px] text-ink-3">物料：{l.materialName}</span> : <Badge tone="yuzu">新产品</Badge>}
        <span className="num ml-auto font-bold">
          {formatQty(l.qtyMilli)} {l.unit}
        </span>
      </p>
      <p className="text-[12px] text-ink-3">
        {l.purpose}
        {l.refPriceCents !== null && (
          <>
            {' '}
            · 参考单价 <Money cents={l.refPriceCents} />
          </>
        )}
        {l.details && ` · ${l.details}`}
        {l.note && ` · 备注：${l.note}`}
      </p>
      {l.link && <ExternalLinkText href={l.link} />}
      <ImageThumbs images={l.images} />
      <ProgressText p={l.progress} canSeePo={canSeePo} />
    </li>
  );
}

function RequestSheet({ id, onClose }: { id: number | null; onClose: () => void }) {
  const can = useCan();
  const session = useSession();
  const toast = useToast();
  const invalidate = useInvalidateRequests();
  const request = useRequest(id);
  const [reasonFor, setReasonFor] = useState<'return' | 'reject' | 'cancel' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const r = request.data;
  const review = can('request.review');
  const mine = !!r && (r.requester.id === session.staff.id || session.staff.role === 'owner');
  const open = r?.status === 'submitted' || r?.status === 'returned';

  const act = async (action: 'approve' | 'return' | 'reject' | 'cancel', reason?: string) => {
    if (!r) return;
    setBusy(true);
    setError(null);
    try {
      await api.post<PurchaseRequest>(`/api/erp/requests/${r.id}/${action}`, reason ? { reason } : {});
      await invalidate();
      setReasonFor(null);
      toast({ tone: 'success', title: { approve: '已通过', return: '已退回', reject: '已定为不采购', cancel: '已撤回' }[action] });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={!!id} onClose={onClose} label="需求单" width="w-[min(600px,100vw)]">
      <div className="flex items-center gap-3 border-b border-line px-5 py-4">
        <span className="flex size-8 items-center justify-center rounded-full bg-pine-soft text-pine">
          <ClipboardList className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="num text-[16px] font-bold">{r?.docNo ?? '需求单'}</p>
          {r && (
            <p className="text-[12.5px] text-ink-3">
              {r.department.name} · {r.requester.name} · {formatDateTime(r.createdAt)}
            </p>
          )}
        </div>
        <button type="button" onClick={onClose} className="rounded-md p-1.5 text-ink-3 hover:bg-paper-2" aria-label="关闭">
          <X className="size-5" />
        </button>
      </div>
      <div className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4" data-testid="request-sheet">
        {!r ? (
          request.error ? <Notice tone="error" title={errorMessage(request.error)} /> : <Skeleton className="h-64" />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={REQUEST_STATUS_TONE[r.status]}>{REQUEST_STATUS_LABELS[r.status]}</Badge>
              {r.needBy && <span className="text-[12.5px] text-ink-3">{r.needBy} 前要</span>}
              {r.status === 'approved' && (
                <span className="ml-auto flex items-center gap-1 text-[12.5px] text-ink-2">
                  <PackageCheck className="size-4" />
                  已下单 {r.orderedLines}/{r.lineCount} 行 · 到货 {r.receivedLines} 行
                </span>
              )}
            </div>
            {r.reason && (r.status === 'returned' || r.status === 'rejected' || r.status === 'cancelled') && (
              <Notice tone={r.status === 'returned' ? 'warning' : 'info'} title={`${REQUEST_STATUS_LABELS[r.status]}：${r.reason}`} />
            )}
            {r.note && <p className="text-[13px] text-ink-2">备注：{r.note}</p>}
            <ul className="divide-y divide-line rounded-lg border border-line">
              {r.lines.map((l) => (
                <LineCard key={l.id} l={l} canSeePo={can('purchase.manage') || can('inventory.read')} />
              ))}
            </ul>
            <ol className="space-y-1 text-[12.5px] text-ink-3">
              {r.approvals.map((a) => (
                <li key={a.id}>
                  {formatDateTime(a.createdAt)} · {a.actorName} · {ACTION_LABELS[a.action] ?? a.action}
                  {a.reason && `：${a.reason}`}
                </li>
              ))}
            </ol>
            {error && <Notice tone="error" title={error} />}
          </>
        )}
      </div>
      {r && (
        <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">
          {open && mine && (
            <>
              <Button variant="ghost" disabled={busy} onClick={() => setReasonFor('cancel')}>
                撤回
              </Button>
              <Link to={`/erp/requests/${r.id}/edit`}>
                <Button variant="secondary" icon={<Pencil className="size-4" />} disabled={busy}>
                  修改
                </Button>
              </Link>
            </>
          )}
          {open && review && (
            <Button variant="secondary" disabled={busy} onClick={() => setReasonFor('reject')} data-testid="request-reject">
              不采购
            </Button>
          )}
          {r.status === 'submitted' && review && (
            <>
              <Button variant="secondary" disabled={busy} onClick={() => setReasonFor('return')} data-testid="request-return">
                退回
              </Button>
              <Button variant="primary" loading={busy} onClick={() => void act('approve')} data-testid="request-approve">
                通过
              </Button>
            </>
          )}
        </div>
      )}
      <ReasonDialog
        open={reasonFor !== null}
        title={reasonFor === 'return' ? '退回需求单' : reasonFor === 'reject' ? '定为不采购' : '撤回需求单'}
        description={reasonFor === 'return' ? '提单人改了再提交。' : reasonFor === 'reject' ? '这张需求单结束，不再转采购单。' : undefined}
        confirmLabel={reasonFor === 'return' ? '退回' : reasonFor === 'reject' ? '不采购' : '撤回'}
        busy={busy}
        onClose={() => setReasonFor(null)}
        onConfirm={(reason) => reasonFor && void act(reasonFor, reason)}
      />
    </Sheet>
  );
}
