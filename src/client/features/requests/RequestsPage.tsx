// 部门采购需求单（v0.7.8，飞书需求 RQ-005 第二步）：部门提需求、采购审核；采购勾选已通过的行转采购单。
// 每一行的下单、到货、退货由采购单与收货单算出来（不手填）。
// 8.0.1（采购组整改 02、03）：红点紧急、绿点普通，待审核按紧急在前、期望到货日期早的在前排；截单以后提交的当天不能通过。
// 8.1.10 核库转领用：库管多一个页签「待核库」；需求行上写总仓结存与核库结果，部门在这里答复替代（StockCheck.tsx）。

import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ClipboardList, Download, ExternalLink, Inbox, PackageCheck, PackageSearch, Pencil, Plus, ShoppingCart, X } from 'lucide-react';
import { formatQty } from '@shared/quantity';
import {
  REQUEST_STATUS_LABELS,
  requestStatusLabel,
  stockCheckOpen,
  type PurchaseRequest,
  type PurchaseRequestSummary,
  type RequestLine,
  type RequestLineProgress,
  type RequestStatus,
} from '@shared/requests';
import { channelLabel } from '@shared/purchasing';
import { api, errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn, formatDateTime } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { ImageThumbs } from '../../components/Images';
import { LoadFailed } from '../../components/LoadFailed';
import { Money } from '../../components/Money';
import { Sheet } from '../../components/Overlay';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Input, Notice, Segmented, Select, Skeleton } from '../../components/ui';
import { PurchaseFlowPanel } from '../purchasing/PurchaseFlow';
import { ErpPage } from '../erp/ErpHome';
import { DraftBox } from './DraftBox';
import { useDrafts } from './drafts';
import { PriorityDot, PriorityTag } from './parts';
import { useInvalidateRequests, useOpenLines, useRequest, useRequestMeta, useRequests } from './queries';
import { LineStockInfo, StockCheckDialog, SubstituteAnswer } from './StockCheck';

export const REQUEST_STATUS_TONE: Record<RequestStatus, 'pine' | 'yuzu' | 'neutral' | 'clay'> = {
  submitted: 'yuzu',
  returned: 'clay',
  approved: 'pine',
  rejected: 'neutral',
  cancelled: 'neutral',
  issued: 'pine',
};

/** 列表、详情上状态的颜色：等主管确认、在核库的标橙 */
const statusTone = (r: Pick<PurchaseRequestSummary, 'status' | 'deptConfirm' | 'stockCheck'>) =>
  r.status === 'submitted' && (r.deptConfirm.state === 'pending' || stockCheckOpen(r.stockCheck)) ? 'ember' : REQUEST_STATUS_TONE[r.status];

const PROGRESS: Record<RequestLineProgress['state'], { label: string; tone: 'neutral' | 'lake' | 'yuzu' | 'pine' }> = {
  none: { label: '未下单', tone: 'neutral' },
  sourcing: { label: '询价中', tone: 'yuzu' },
  ordered: { label: '已下单', tone: 'lake' },
  partial: { label: '部分到货', tone: 'yuzu' },
  received: { label: '已到货', tone: 'pine' },
  closed: { label: '采购单已关闭', tone: 'neutral' },
  issued: { label: '已领用', tone: 'pine' },
};

const ACTION_LABELS: Record<string, string> = { create: '新建', submit: '提交', revise: '修改', approve: '通过', return: '退回', cancel: '结束', stock: '核库' };

export function RequestsPage() {
  const can = useCan();
  const meta = useRequestMeta();
  const [params, setParams] = useSearchParams();
  // 转采购单要能编采购单：负责人（v0.7.11 起能审核需求单）只审核，不转单
  const canConvert = can('request.review') && can('purchase.manage');
  // 核库（8.1.10）：库管的「待核库」页签
  const canStock = can('request.stock');
  const view = params.get('view') === 'open' && canConvert ? 'open' : params.get('view') === 'stock' && canStock ? 'stock' : 'list';
  const session = useSession();
  const [status, setStatus] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  // 按提交日期筛选；不填就是全部（导出时没填按本月）
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // 状态里的「待核库」不是需求单的状态，按 stock=open 查
  const list = useRequests(
    view === 'stock'
      ? { stock: 'open' }
      : {
          status: status && status !== 'stock' ? status : undefined,
          stock: status === 'stock' ? 'open' : undefined,
          departmentId: departmentId || undefined,
          from: from || undefined,
          to: to || undefined,
        },
  );
  const exportQs = new URLSearchParams(
    Object.entries({
      from: from || `${session.calendarToday.slice(0, 8)}01`,
      to: to || session.calendarToday,
      status,
      departmentId,
    }).filter(([, v]) => v) as [string, string][],
  ).toString();
  const openId = Number(params.get('request')) || null;
  const setView = (v: 'list' | 'open' | 'stock') => setParams(v === 'list' ? {} : { view: v }, { replace: true });
  const open = (id: number | null) => setParams(id ? { request: String(id) } : {}, { replace: true });
  const me = list.data?.me ?? meta.data?.me;
  // 我当主管的部门里、等主管确认的（店主不在这里列：店主能替任何部门确认，待审核的列表里看得到）
  const waitingForMe = (list.data?.requests ?? []).filter(
    (r) => r.status === 'submitted' && r.deptConfirm.state === 'pending' && (r.deptConfirm.head?.id === session.staff.id || (me?.headOf ?? []).includes(r.department.id)),
  );
  // 草稿箱（供应链二次整改 03）：自己没提交的草稿
  const drafts = useDrafts(null, can('request.create'));
  const [boxOpen, setBoxOpen] = useState(false);
  const draftCount = drafts.data?.drafts.length ?? 0;

  return (
    <ErpPage
      title="采购需求单"
      description="部门提需求（新产品要带参考链接和图片），采购审核后勾选转采购单；下单、到货、退货由采购单与收货单自动回写。"
      actions={
        <div className="flex flex-wrap gap-2">
          {can('expense.export') && (
            <a href={`/api/erp/requests/export?${exportQs}`} download data-testid="requests-export">
              <Button variant="secondary" icon={<Download className="size-4" />}>
                导出需求单
              </Button>
            </a>
          )}
          {can('request.create') && (
            <Button variant="secondary" icon={<Inbox className="size-4" />} onClick={() => setBoxOpen(true)} data-testid="requests-draft-box">
              草稿箱{draftCount > 0 ? `（${draftCount}）` : ''}
            </Button>
          )}
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
      <DraftBox open={boxOpen} onClose={() => setBoxOpen(false)} />
      <div className="space-y-4" data-testid="requests-page">
        <ErpPendingPanel types={['purchase_request', 'request_stock']} onFound={(_, ref) => open(ref.refId)} />
        {/* 部门主管（8.0.17，LC1）：等我确认的 */}
        {waitingForMe.length > 0 && (
          <Notice tone="warning" title={`有 ${waitingForMe.length} 张需求单等你（部门主管）确认`} data-testid="requests-head-notice">
            <span className="flex flex-wrap gap-x-3 gap-y-1">
              {waitingForMe.slice(0, 8).map((r) => (
                <button key={r.id} type="button" className="num font-semibold text-lake hover:underline" onClick={() => open(r.id)} data-testid={`requests-head-open-${r.id}`}>
                  {r.docNo}
                </button>
              ))}
              {waitingForMe.length > 8 && <span className="text-ink-3">……</span>}
              <span className="text-ink-3">确认以后采购才能审核通过。</span>
            </span>
          </Notice>
        )}
        {me && !me.canReview && me.canCreate && !me.departmentId && (
          <Notice tone="warning" title="你的员工档案里还没有填所属部门">
            请店主在「后台 → 员工」里给你选所属部门，之后才能提需求单。
          </Notice>
        )}
        {(canConvert || canStock) && (
          <Segmented
            ariaLabel="需求单视图"
            value={view}
            onChange={setView}
            options={[
              { value: 'list' as const, label: '需求单' },
              ...(canStock ? [{ value: 'stock' as const, label: '待核库' }] : []),
              ...(canConvert ? [{ value: 'open' as const, label: '待转采购单' }] : []),
            ]}
          />
        )}
        {view === 'open' ? (
          <OpenLines />
        ) : view === 'stock' ? (
          <StockQueue list={list} open={open} />
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
                <option value="stock">待核库</option>
              </Select>
              {(me?.canReview || me?.canStock) && (
                <Select aria-label="部门" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} fullWidth={false} className="w-40">
                  <option value="">全部部门</option>
                  {meta.data?.departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              )}
              <label className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-3">
                提交日期
                <Input type="date" fullWidth={false} value={from} max={to || session.calendarToday} onChange={(e) => setFrom(e.target.value)} className="h-9 w-36" aria-label="提交日期从" />
                到
                <Input
                  type="date"
                  fullWidth={false}
                  value={to}
                  min={from || undefined}
                  max={session.calendarToday}
                  onChange={(e) => setTo(e.target.value)}
                  className="h-9 w-36"
                  aria-label="提交日期到"
                />
              </label>
              {me && !me.canReview && !me.canStock && me.departmentName && <span className="text-[13px] text-ink-2">只显示 {me.departmentName} 的需求单与你提的</span>}
              {status === 'submitted' && (
                <span className="text-[12.5px] text-ink-3" data-testid="requests-review-order">
                  按紧急在前、期望到货日期早的在前排
                </span>
              )}
              {meta.data?.cutoff.enabled && <span className="text-[12.5px] text-ink-3">每天 {meta.data.cutoff.time} 截单</span>}
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
                        <span className="num flex items-start gap-2 text-[13.5px] font-bold">
                          <PriorityDot priority={r.priority} className="mt-1.5" />
                          <span>
                            {r.docNo}
                            <span className="block font-sans text-[12px] font-medium text-ink-3">{formatDateTime(r.submittedAt)}</span>
                          </span>
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-[13.5px] font-semibold">
                            {r.summary || '—'}
                            {r.lineCount > 3 ? ` 等 ${r.lineCount} 行` : ''}
                          </span>
                          <span className="block truncate text-[12px] text-ink-3">
                            {r.department.name} · {r.requester.name}
                            {r.needBy ? ` · 期望 ${r.needBy} 到货` : ''}
                            {r.source === 'import' ? ' · 集采导入' : r.source === 'sheet' ? ' · 表格导入' : ''}
                          </span>
                          {r.lockedToday && (
                            <span className="block text-[12px] font-semibold text-clay" data-testid={`request-locked-${r.id}`}>
                              截单以后提交，{r.approvableOn} 起可以通过
                            </span>
                          )}
                        </span>
                        <span className="hidden text-[12.5px] text-ink-2 md:block">
                          {r.status === 'approved' ? `已下单 ${r.orderedLines}/${r.lineCount} 行 · 到货 ${r.receivedLines} 行` : `${r.lineCount} 行`}
                        </span>
                        {/* Badge 不带测试标识，外面包一层 */}
                        <span className="justify-self-start md:justify-self-auto" data-testid={`request-status-${r.id}`}>
                          <Badge tone={statusTone(r)}>{requestStatusLabel(r)}</Badge>
                        </span>
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

/** 待核库（8.1.10，库管）：待核库的在前，进待核库早的在前；等部门确认替代的在后面 */
function StockQueue({ list, open }: { list: ReturnType<typeof useRequests>; open: (id: number) => void }) {
  if (list.isPending) return <Skeleton className="h-64" />;
  if (list.isError && !list.data) return <LoadFailed title="待核库的需求单没取回来" onRetry={() => void list.refetch()} retrying={list.isFetching} />;
  const rows = list.data!.requests;
  if (rows.length === 0) return <EmptyState art="calm" title="没有待核库的需求单" description="部门提交（要主管确认的在主管确认以后）、选了物料而且总仓有货的需求单会列在这里。" />;
  return (
    <Card className="overflow-hidden" data-testid="requests-stock-queue">
      <ul className="divide-y divide-line/70">
        {rows.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => open(r.id)}
              className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-paper-2"
              data-testid={`stock-row-${r.id}`}
            >
              <span className="min-w-0">
                <span className="num block text-[13.5px] font-bold">
                  {r.docNo}
                  <span className="ml-2 font-sans text-[13px] font-semibold">
                    {r.summary || '—'}
                    {r.lineCount > 3 ? ` 等 ${r.lineCount} 行` : ''}
                  </span>
                </span>
                <span className="block truncate text-[12px] text-ink-3">
                  {r.department.name} · {r.requester.name}
                  {r.stockCheckSince && ` · ${formatDateTime(r.stockCheckSince)} 进待核库`}
                </span>
              </span>
              <Badge tone="ember">{requestStatusLabel(r)}</Badge>
            </button>
          </li>
        ))}
      </ul>
    </Card>
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
                <PriorityDot priority={l.priority} className="self-center" />
                <span className="font-bold">{l.name}</span>
                {l.materialId ? <span className="text-[12px] text-ink-3">物料：{l.materialName}</span> : <Badge tone="yuzu">新产品</Badge>}
                <span className="num font-semibold">
                  {formatQty(l.qtyMilli)} {l.unit}
                </span>
                {l.issuedQtyMilli > 0 && (
                  <span className="num text-[12px] font-semibold text-pine" data-testid={`open-line-issued-${l.id}`}>
                    已从库存领 {formatQty(l.issuedQtyMilli)}，还要买 {formatQty(l.qtyMilli - l.issuedQtyMilli)} {l.unit}
                  </span>
                )}
                {l.needBy && <span className="text-[12px] text-ink-3">期望 {l.needBy} 到货</span>}
                {l.refPriceCents !== null && (
                  <span className="text-[12px] text-ink-3">
                    参考单价 <Money cents={l.refPriceCents} />
                  </span>
                )}
              </p>
              <p className="text-[12px] text-ink-3">
                <span className="num">{l.requestNo}</span> · {l.department.name} · {l.applicant || l.requesterName} · {l.purpose}
                {l.details && ` · ${l.details}`}
                {l.channel && ` · ${channelLabel(l.channel)}`}
                {l.supplier && ` · ${l.supplier.name}`}
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
      {!p.po && p.sourcing && (
        <>
          {canSeePo ? (
            <Link to={`/purchasing/sourcing/${p.sourcing.id}`} className="num font-semibold text-lake hover:underline">
              {p.sourcing.docNo}
            </Link>
          ) : (
            <span className="num font-semibold">{p.sourcing.docNo}</span>
          )}
          <span>定标后转采购单</span>
        </>
      )}
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

function LineCard({ l, canSeePo, request }: { l: RequestLine; canSeePo: boolean; request: PurchaseRequest }) {
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
        {l.applicant && ` · 申请人：${l.applicant}`}
        {l.channel && ` · ${channelLabel(l.channel)}`}
        {l.supplier && ` · 供应商：${l.supplier.name}`}
      </p>
      {l.link && <ExternalLinkText href={l.link} />}
      <ImageThumbs images={l.images} />
      <LineStockInfo l={l} request={request} />
      <SubstituteAnswer l={l} request={request} />
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
  const [reasonFor, setReasonFor] = useState<'return' | 'reject' | 'cancel' | 'dept-return' | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const r = request.data;
  const review = can('request.review');
  const mine = !!r && (r.requester.id === session.staff.id || session.staff.role === 'owner');
  const open = r?.status === 'submitted' || r?.status === 'returned';
  // 核库（8.1.10）：核库没完不能通过、退回；已经有行领用的不能修改、退回
  const stockOpen = !!r && r.status === 'submitted' && stockCheckOpen(r.stockCheck);
  const anyIssued = !!r && r.lines.some((l) => !!l.stock?.issueDoc && !l.stock.issueDoc.voided);

  const act = async (action: 'approve' | 'return' | 'reject' | 'cancel' | 'dept-confirm' | 'dept-return', reason?: string) => {
    if (!r) return;
    setBusy(true);
    setError(null);
    try {
      await api.post<PurchaseRequest>(`/api/erp/requests/${r.id}/${action}`, reason ? { reason } : {});
      await invalidate();
      setReasonFor(null);
      toast({ tone: 'success', title: { approve: '已通过', return: '已退回', reject: '已定为不采购', cancel: '已撤回', 'dept-confirm': '主管已确认', 'dept-return': '主管已退回' }[action] });
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
          request.error ? (
            <Notice tone="error" title={errorMessage(request.error)} />
          ) : (
            <Skeleton className="h-64" />
          )
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span data-testid="request-sheet-status">
                <Badge tone={statusTone(r)}>{requestStatusLabel(r)}</Badge>
              </span>
              <PriorityTag priority={r.priority} />
              {r.needBy && <span className="text-[12.5px] text-ink-3">期望 {r.needBy} 到货</span>}
              {r.source === 'import' && <Badge tone="neutral">集采导入</Badge>}
              {r.source === 'sheet' && <Badge tone="neutral">表格导入</Badge>}
              {r.status === 'approved' && (
                <span className="ml-auto flex items-center gap-1 text-[12.5px] text-ink-2">
                  <PackageCheck className="size-4" />
                  已下单 {r.orderedLines}/{r.lineCount} 行 · 到货 {r.receivedLines} 行
                </span>
              )}
            </div>
            {/* 这张需求走到哪了（8.0.17）：审核、询价、下单、到货、付款 */}
            <PurchaseFlowPanel
              kind="request"
              id={r.id}
              version={`${r.status}|${r.deptConfirm.state}|${r.submittedAt}|${r.orderedLines}|${r.receivedLines}|${r.lines.map((l) => `${l.progress.state}${l.progress.po?.status ?? ''}`).join(',')}`}
            />
            {/* 部门主管确认（8.0.17，LC1） */}
            {r.deptConfirm.state === 'pending' && r.status === 'submitted' && (
              <Notice tone="warning" title={`等部门主管${r.deptConfirm.head ? `（${r.deptConfirm.head.name}）` : ''}确认`} data-testid="request-dept-pending">
                {r.canDeptConfirm ? '你是这张单的部门主管：确认以后采购才能审核通过；不同意请退回并写原因。' : '主管确认以后采购才能审核通过；采购现在可以退回或定为不采购。'}
              </Notice>
            )}
            {r.deptConfirm.state === 'confirmed' && (
              <p className="text-[12.5px] text-ink-2" data-testid="request-dept-confirmed">
                部门主管已确认：{r.deptConfirm.confirmedByName}
                {r.deptConfirm.confirmedAt && <span className="num text-ink-3"> · {formatDateTime(r.deptConfirm.confirmedAt)}</span>}
              </p>
            )}
            {/* 核库（8.1.10） */}
            {stockOpen && r.stockCheck === 'pending' && (
              <Notice tone="warning" title="待核库：库管在看总仓有没有货" data-testid="request-stock-pending">
                {r.canStockCheck ? '有货的转领用（开部门领料单），可以提议替代品，没货的转采购；核完以后才进采购审核。' : '核完以后才进采购审核；总仓有的直接领用，不用再买。'}
              </Notice>
            )}
            {stockOpen && r.stockCheck === 'confirming' && (
              <Notice tone="warning" title="库管提议了替代品，等部门确认" data-testid="request-stock-confirming">
                {r.canAnswerSubstitute ? '在下面的行里选「同意替代」或「不用，照原来买」；都答复以后才进采购审核。' : '提单人或部门主管答复以后才进采购审核。'}
              </Notice>
            )}
            {r.status === 'issued' && (
              <Notice tone="success" title="已转领用：每一行都从总仓领用了，不再采购" data-testid="request-stock-issued">
                部门在库存「领料」里签收领料单。
              </Notice>
            )}
            {r.stockCheckedAt && (r.stockCheck === 'done' || r.stockCheck === 'confirming' || r.stockCheck === 'timeout') && (
              <p className="text-[12.5px] text-ink-2" data-testid="request-stock-checked">
                {r.stockCheck === 'timeout' ? '核库超时，没核的行转采购' : `核库：${r.stockCheckedByName ?? ''}`}
                <span className="num text-ink-3"> · {formatDateTime(r.stockCheckedAt)}</span>
              </p>
            )}
            {r.reason && (r.status === 'returned' || r.status === 'rejected' || r.status === 'cancelled') && (
              <Notice tone={r.status === 'returned' ? 'warning' : 'info'} title={`${REQUEST_STATUS_LABELS[r.status]}：${r.reason}`} />
            )}
            {r.lockedToday && (
              <Notice tone="warning" title={`截单以后提交的需求单，${r.approvableOn} 起可以通过`} data-testid="request-cutoff-notice">
                今天可以先退回或定为不采购；急需的请找采购走急采。
              </Notice>
            )}
            {r.note && <p className="text-[13px] text-ink-2">备注：{r.note}</p>}
            <ul className="divide-y divide-line rounded-lg border border-line">
              {r.lines.map((l) => (
                <LineCard key={l.id} l={l} request={r} canSeePo={can('purchase.manage') || can('inventory.read')} />
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
              {!anyIssued && (
                <Link to={`/erp/requests/${r.id}/edit`}>
                  <Button variant="secondary" icon={<Pencil className="size-4" />} disabled={busy}>
                    修改
                  </Button>
                </Link>
              )}
            </>
          )}
          {r.canStockCheck && (
            <Button variant="primary" icon={<PackageSearch className="size-4" />} disabled={busy} onClick={() => setChecking(true)} data-testid="request-stock-check">
              核库
            </Button>
          )}
          {r.canDeptConfirm && (
            <>
              <Button variant="secondary" disabled={busy} onClick={() => setReasonFor('dept-return')} data-testid="request-dept-return">
                主管退回
              </Button>
              <Button variant="primary" loading={busy} onClick={() => void act('dept-confirm')} data-testid="request-dept-confirm">
                主管确认
              </Button>
            </>
          )}
          {open && review && (
            <Button variant="secondary" disabled={busy} onClick={() => setReasonFor('reject')} data-testid="request-reject">
              不采购
            </Button>
          )}
          {r.status === 'submitted' && review && (
            <>
              {!stockOpen && !anyIssued && (
                <Button variant="secondary" disabled={busy} onClick={() => setReasonFor('return')} data-testid="request-return">
                  退回
                </Button>
              )}
              <Button
                variant={r.canDeptConfirm || r.canStockCheck ? 'secondary' : 'primary'}
                loading={busy}
                disabled={r.lockedToday || r.deptConfirm.state === 'pending' || stockOpen}
                title={r.deptConfirm.state === 'pending' ? '要部门主管先确认' : stockOpen ? '核库完了才能通过' : r.lockedToday ? `${r.approvableOn} 起可以通过` : undefined}
                onClick={() => void act('approve')}
                data-testid="request-approve"
              >
                通过
              </Button>
            </>
          )}
        </div>
      )}
      {checking && r && <StockCheckDialog request={r} onClose={() => setChecking(false)} />}
      <ReasonDialog
        open={reasonFor !== null}
        title={reasonFor === 'return' ? '退回需求单' : reasonFor === 'dept-return' ? '主管退回需求单' : reasonFor === 'reject' ? '定为不采购' : '撤回需求单'}
        description={reasonFor === 'return' || reasonFor === 'dept-return' ? '提单人改了再提交。' : reasonFor === 'reject' ? '这张需求单结束，不再转采购单。' : undefined}
        confirmLabel={reasonFor === 'return' || reasonFor === 'dept-return' ? '退回' : reasonFor === 'reject' ? '不采购' : '撤回'}
        busy={busy}
        onClose={() => setReasonFor(null)}
        onConfirm={(reason) => reasonFor && void act(reasonFor, reason)}
      />
    </Sheet>
  );
}
