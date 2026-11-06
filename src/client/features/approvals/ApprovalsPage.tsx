// ERP「审批中心」（v0.7.30，docs/APPROVALS.md）：待我审批（含我代理的）、全部在审（负责人与店主）、我提交的；
// 审批规则（店主维护）、代理人（本人设，店主可以给任何人设）；顶部「急采待补单」（负责人）。
// 竖屏可用：卡片一列，点开整屏详情，底部固定「同意」「退回」；只做看与批，新建、修改单据仍在电脑上。

import { useMemo, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { CheckCheck, ChevronDown, ChevronUp, PackageCheck, PackageX, RotateCcw, TriangleAlert } from 'lucide-react';
import {
  APPROVAL_BATCH_MAX,
  APPROVAL_BATCH_MAX_CENTS,
  APPROVAL_DOC_TYPE_LABELS,
  APPROVAL_OVERDUE_HOURS,
  NO_BATCH_DOC_TYPES,
  URGENT_BACKFILL_ESCALATE_DAYS,
  type ApprovalCard,
  type BatchApproveResult,
  type UrgentAcceptItem,
} from '@shared/approvals';
import { formatAmount } from '@shared/money';
import { errorMessage, UncertainError } from '../../lib/api';
import { useCan } from '../../lib/session';
import { cn, formatDateTime } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Input, Notice, Segmented, Skeleton } from '../../components/ui';
import { useApprovalResend, waited } from './ApprovalProgress';
import { ApprovalSheet } from './ApprovalSheet';
import { DelegationsPanel } from './DelegationsPanel';
import { RulesPanel } from './RulesPanel';
import { useApprovals, useRefreshAfterApproval, useUrgentAccepts, useUrgentBackfills, type ApprovalTab } from './queries';
import { sendBatchApprove, sentLabel, useUncertainApprovals } from './uncertain';

type Tab = ApprovalTab | 'rules' | 'delegations';

export function ApprovalsPage() {
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const canAct = can('approval.act') || can('inventory.approve') || can('expense.approve');
  const canViewAll = can('inventory.approve') || can('expense.approve') || can('approval.rules');
  const tab = (params.get('tab') as Tab | null) ?? 'mine';
  const openId = Number(params.get('open')) || null;
  const setParam = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };
  const listTab: ApprovalTab = tab === 'all' || tab === 'submitted' ? tab : 'mine';
  const mine = useApprovals('mine', undefined, canAct);
  const list = useApprovals(listTab, undefined, canAct && (tab === 'all' || tab === 'submitted'));
  const cards = tab === 'mine' ? mine : list;
  const backfills = useUrgentBackfills(can('inventory.approve'));
  const accepts = useUrgentAccepts(can('inventory.approve'));
  const [retryOpen, setRetryOpen] = useState(false);
  if (!canAct) return <Navigate to="/erp" replace />;

  const overdue = (mine.data ?? []).filter((c) => c.overdue).length;
  const tabs: { value: Tab; label: string }[] = [
    { value: 'mine', label: `待我审批${mine.data ? ` ${mine.data.length}` : ''}` },
    ...(canViewAll ? [{ value: 'all' as Tab, label: '全部在审' }] : []),
    { value: 'submitted', label: '我提交的' },
    { value: 'rules', label: '审批规则' },
    { value: 'delegations', label: '代理人' },
  ];

  return (
    <>
      <PageHeader
        dateMode="calendar"
        title="审批中心"
        subtitle={`采购、报损、盘点差异、退货、付款、期初、报销的审批都在这里；当前这一级等了超过 ${APPROVAL_OVERDUE_HOURS} 小时的标「超时」、排在最前`}
        actions={
          can('inventory.approve') && (
            <Link to="/todo" className="hidden h-8 items-center rounded-sm border border-line-strong bg-card px-3 text-[13px] font-semibold hover:border-ink-3 sm:flex">
              旧的审批待办页
            </Link>
          )
        }
      />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[920px] space-y-4 px-4 py-4 md:px-7 md:py-5" data-testid="approvals-page">
          <UncertainPanel onOpen={(id) => setParam({ open: String(id) })} onBatch={() => setRetryOpen(true)} />
          {(accepts.data?.length ?? 0) > 0 && <AcceptStrip items={accepts.data!} />}
          {(backfills.data?.length ?? 0) > 0 && <BackfillStrip items={backfills.data!} />}
          <div className="-mx-1 overflow-x-auto px-1">
            <Segmented value={tab} onChange={(v) => setParam({ tab: v === 'mine' ? null : v })} options={tabs} ariaLabel="审批中心分页" className="min-w-max" />
          </div>
          {tab === 'mine' && overdue > 0 && (
            <Notice tone="warning" icon={<TriangleAlert className="size-4" />} title={`${overdue} 张超时`} data-testid="approval-overdue">
              当前这一级等了超过 {APPROVAL_OVERDUE_HOURS} 小时，已排在最前。
            </Notice>
          )}
          {tab === 'rules' ? (
            <RulesPanel />
          ) : tab === 'delegations' ? (
            <DelegationsPanel />
          ) : cards.error ? (
            <Notice tone="error" title={errorMessage(cards.error)} />
          ) : !cards.data ? (
            <Skeleton className="h-48" />
          ) : (
            <CardList cards={cards.data} tab={listTab} onOpen={(id) => setParam({ open: String(id) })} />
          )}
        </div>
      </div>
      <ApprovalSheet id={openId} onClose={() => setParam({ open: null })} />
      {/* 没收到结果的那一批：从上方「结果待确认」整批重新提交（不按刷新后的卡片，照上次的发） */}
      <BatchDialog open={retryOpen} cards={[]} onClose={() => setRetryOpen(false)} onDone={() => undefined} />
    </>
  );
}

/**
 * 没收到结果的同意、退回（uncertain.ts，存在本机、按账号分开）：刷新、重新登录以后也列在这里，可以逐张按原内容重新提交、
 * 打开看审批进度；批量的那一批可以整批重新提交。有明确结果（或读回时审批单已经结束）才从这里消失。
 */
function UncertainPanel({ onOpen, onBatch }: { onOpen: (id: number) => void; onBatch: () => void }) {
  const sent = useUncertainApprovals();
  const refresh = useRefreshAfterApproval();
  const { busy, resend } = useApprovalResend(refresh);
  if (sent.all.length === 0) return null;
  return (
    <Notice
      tone="warning"
      icon={<TriangleAlert className="size-4" />}
      title={`${sent.all.length} 张的同意或退回没收到结果`}
      action={
        sent.batch && sent.batch.items.length > 1 ? (
          <Button size="sm" variant="primary" icon={<RotateCcw className="size-4" />} onClick={onBatch} data-testid="approval-batch-retry">
            这一批 {sent.batch.items.length} 张一起重新提交
          </Button>
        ) : undefined
      }
      data-testid="approval-uncertain-panel"
    >
      <p>可能已经生效。按原内容重新提交：已经生效的不重复记，这张单已经走过这一级的会写明原因。</p>
      <ul className="mt-1.5 space-y-1.5">
        {sent.all.map((s) => (
          <li key={s.requestId} className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <button type="button" onClick={() => onOpen(s.requestId)} className="num font-semibold text-lake hover:underline">
              {s.docNo}
            </button>
            <span className="text-ink-2">
              {sentLabel(s)}
              {s.batch ? ' · 批量' : ''}
            </span>
            <Button size="sm" variant="secondary" loading={busy === s.requestId} onClick={() => void resend(s)} data-testid={`approval-uncertain-resend-${s.docNo}`}>
              按原内容重新提交
            </Button>
            {s.lastError && <span className="w-full text-[12px] text-clay">上次重新提交没被受理：{s.lastError}</span>}
          </li>
        ))}
      </ul>
    </Notice>
  );
}

function CardList({ cards, tab, onOpen }: { cards: ApprovalCard[]; tab: ApprovalTab; onOpen: (id: number) => void }) {
  const [selected, setSelected] = useState<number[]>([]);
  const [batchOpen, setBatchOpen] = useState(false);
  // 上次同意没收到结果的单（uncertain.ts）：不能再勾进新的一批，打开后只能按原内容重新提交（页面上方「结果待确认」里也列着）
  const sent = useUncertainApprovals();
  const picked = useMemo(() => cards.filter((c) => selected.includes(c.id)), [cards, selected]);
  const pickedType = picked[0]?.docType ?? null;
  const batchable = (c: ApprovalCard) =>
    tab === 'mine' &&
    c.canAct &&
    !sent.get(c.id) &&
    // 合同、合同变更、用印（v0.7.31）要逐张审：法务那一级按审查清单逐条给意见
    !NO_BATCH_DOC_TYPES.includes(c.docType) &&
    c.amountCents !== null &&
    c.amountCents <= APPROVAL_BATCH_MAX_CENTS &&
    (!pickedType || c.docType === pickedType);
  const batchDialog = <BatchDialog open={batchOpen} cards={picked} onClose={() => setBatchOpen(false)} onDone={() => setSelected([])} />;
  if (cards.length === 0) {
    return (
      <>
        <EmptyState
          art="calm"
          title={tab === 'mine' ? '没有待你审批的单据' : tab === 'all' ? '没有在审的单据' : '你还没有提交过要审批的单据'}
          description={tab === 'mine' ? '有单据走到你能审的这一级（或你代理的人能审）时会出现在这里。' : undefined}
          className="rounded-lg border border-dashed border-line-strong bg-card"
        />
        {batchDialog}
      </>
    );
  }
  return (
    <>
      {tab === 'mine' && (
        <p className="text-[12.5px] text-ink-3">
          勾选同一种单据、每张不超过 ¥{formatAmount(APPROVAL_BATCH_MAX_CENTS)} 的可以一起同意（一次最多 {APPROVAL_BATCH_MAX} 张）；合同、合同变更、用印要逐张审。
        </p>
      )}
      <ul className="space-y-2.5" data-testid="approval-cards">
        {cards.map((c) => (
          <li key={c.id} className={cn('flex gap-3 rounded-lg border bg-card px-3.5 py-3 shadow-card', c.overdue ? 'border-clay/40' : 'border-line')} data-testid={`approval-card-${c.docNo}`}>
            {tab === 'mine' && (
              <input
                type="checkbox"
                aria-label={`勾选 ${c.docNo}`}
                className="mt-1 size-5 shrink-0 accent-[var(--color-pine)] disabled:opacity-30"
                disabled={!batchable(c) && !selected.includes(c.id)}
                checked={selected.includes(c.id)}
                onChange={(e) => setSelected((s) => (e.target.checked ? [...s, c.id].slice(0, APPROVAL_BATCH_MAX) : s.filter((x) => x !== c.id)))}
                data-testid={`approval-pick-${c.docNo}`}
              />
            )}
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpen(c.id)}>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone="lake">{APPROVAL_DOC_TYPE_LABELS[c.docType]}</Badge>
                <span className="num text-[12.5px] font-semibold text-ink-3">{c.docNo}</span>
                {c.overdue && <Badge tone="clay">超时</Badge>}
                {c.stuck && <Badge tone="ember">没人能审</Badge>}
                {c.actingFor.length > 0 && <Badge tone="moss">代 {c.actingFor.join('、')}</Badge>}
                {sent.get(c.id) && <Badge tone="ember">结果待确认</Badge>}
                {tab === 'submitted' && c.status !== 'pending' && <Badge tone={c.status === 'approved' ? 'pine' : 'neutral'}>{c.status === 'approved' ? '已通过' : c.status === 'returned' ? '已退回' : '已撤回'}</Badge>}
                <span className="ml-auto">
                  {c.amountCents !== null ? <Money cents={c.amountCents} className="text-[15px] font-bold" /> : <span className="text-[12px] text-ink-3">金额算不出</span>}
                </span>
              </div>
              <p className="mt-1 truncate text-[14px] font-semibold">{c.summary || APPROVAL_DOC_TYPE_LABELS[c.docType]}</p>
              <p className="mt-0.5 text-[12.5px] text-ink-3">
                {c.departmentName ? `${c.departmentName} · ` : ''}
                {c.submittedByName} 提交 ·{' '}
                {c.status === 'pending' ? (
                  <>
                    {c.levels > 1 && `第 ${c.currentLevel}/${c.levels} 级 · `}
                    {c.currentStepLabel} · 等了 {waited(c.levelStartedAt)}
                  </>
                ) : (
                  c.finishedAt && formatDateTime(c.finishedAt)
                )}
              </p>
              {c.lastAction && (
                <p className="mt-1 truncate text-[12.5px] text-ink-2">
                  第 {c.lastAction.level} 级 {c.lastAction.actorName}
                  {c.lastAction.onBehalfOfName ? `（代 ${c.lastAction.onBehalfOfName}）` : ''}
                  {c.lastAction.action === 'return' ? ' 退回' : ' 同意'}
                  {c.lastAction.comment && `：${c.lastAction.comment}`}
                </p>
              )}
            </button>
          </li>
        ))}
      </ul>
      {picked.length > 0 && (
        <div className="sticky bottom-0 z-10 -mx-1 flex items-center gap-3 rounded-lg border border-line bg-card/95 px-4 py-3 shadow-pop backdrop-blur">
          <p className="min-w-0 flex-1 text-[13px]">
            已选 <span className="num font-bold">{picked.length}</span> 张{APPROVAL_DOC_TYPE_LABELS[pickedType!]} · 合计{' '}
            <Money cents={picked.reduce((t, c) => t + (c.amountCents ?? 0), 0)} className="font-bold" />
          </p>
          <Button variant="ghost" size="sm" onClick={() => setSelected([])}>
            清空
          </Button>
          <Button variant="primary" icon={<CheckCheck className="size-4" />} onClick={() => setBatchOpen(true)} data-testid="approval-batch">
            批量同意
          </Button>
        </div>
      )}
      {batchDialog}
    </>
  );
}

/**
 * 批量同意。没收到结果（超时、断网、服务器出错）时这一批原样记下（uncertain.ts）：再打开只能按原内容重新提交——
 * 勾的单、各自当时的级别与意见都照上次的发，不按刷新后的卡片重新拼（同一个人能审连续几级时会多同意一级）。
 */
function BatchDialog({ open, cards, onClose, onDone }: { open: boolean; cards: ApprovalCard[]; onClose: () => void; onDone: () => void }) {
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BatchApproveResult | null>(null);
  const refresh = useRefreshAfterApproval();
  const toast = useToast();
  const sent = useUncertainApprovals();
  const retry = sent.batch;
  const close = () => {
    setResult(null);
    setComment('');
    onClose();
  };
  const run = async () => {
    setBusy(true);
    try {
      const r = retry
        ? await sendBatchApprove(
            sent.staffId,
            retry.items.map((s) => ({ requestId: s.requestId, docNo: s.docNo, level: s.level })),
            retry.comment,
            retry.id,
          )
        : await sendBatchApprove(
            sent.staffId,
            cards.map((c) => ({ requestId: c.id, docNo: c.docNo, level: c.currentLevel })),
            comment.trim(),
          );
      setResult(r);
      onDone();
      const ok = r.results.filter((x) => x.ok).length;
      toast({ tone: ok === r.results.length ? 'success' : 'error', title: `同意 ${ok} 张${ok < r.results.length ? `，${r.results.length - ok} 张没成功` : ''}` });
    } catch (e) {
      if (e instanceof UncertainError) toast({ tone: 'error', title: `没收到结果：${errorMessage(e)}`, body: '可能已经同意了一部分，只能按原内容重新提交' });
      else toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(false);
      await refresh();
    }
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title={result ? '批量同意的结果' : retry ? `批量同意 ${retry.items.length} 张没收到结果` : `批量同意 ${cards.length} 张`}
      description={
        result
          ? undefined
          : retry
            ? '上次批量同意没收到结果，可能已经同意了一部分。按原内容重新提交：每张按上次的级别与意见再提交一次，已经生效的不重复记，走过了这一级的写明原因。'
            : '每张单独同意当前这一级：成功的照常生效或进下一级，没成功的写明原因、照旧在待办里。'
      }
      footer={
        result ? (
          <Button variant="primary" onClick={close}>
            知道了
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              取消
            </Button>
            {retry ? (
              <Button variant="primary" loading={busy} icon={<RotateCcw className="size-4" />} onClick={() => void run()} data-testid="approval-batch-resend">
                按原内容重新提交 {retry.items.length} 张
              </Button>
            ) : (
              <Button variant="primary" loading={busy} disabled={cards.length === 0} onClick={() => void run()} data-testid="approval-batch-confirm">
                同意这 {cards.length} 张
              </Button>
            )}
          </>
        )
      }
    >
      {result ? (
        <ul className="space-y-1.5 text-[13px]" data-testid="approval-batch-result">
          {result.results.map((r) => (
            <li key={r.id} className="flex gap-2">
              <span className={r.ok ? 'font-semibold text-pine' : 'font-semibold text-clay'}>{r.ok ? '已同意' : '没成功'}</span>
              <span className="num">{r.docNo}</span>
              {r.message && <span className="text-ink-2">{r.message}</span>}
            </li>
          ))}
        </ul>
      ) : retry ? (
        <div className="space-y-2 text-[13px]" data-testid="approval-batch-pending">
          <ul className="space-y-1">
            {retry.items.map((s) => (
              <li key={s.requestId} className="flex gap-2">
                <span className="num font-semibold">{s.docNo}</span>
                <span className="text-ink-2">同意第 {s.level} 级</span>
              </li>
            ))}
          </ul>
          {retry.comment && <p className="text-ink-2">意见：{retry.comment}</p>}
        </div>
      ) : (
        <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="意见（选填，每张都记这一句）" maxLength={200} data-autofocus />
      )}
    </Dialog>
  );
}

/** 急采待验收：部门登记、等仓库或负责人到部门验收（不走审批中心，在原单据上「到部门验收确认」） */
function AcceptStrip({ items }: { items: UrgentAcceptItem[] }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-lg border border-lake/25 bg-lake-soft/40 px-4 py-3" data-testid="approval-accepts">
      <button type="button" className="flex w-full items-center gap-2 text-left" onClick={() => setOpen((o) => !o)}>
        <PackageCheck className="size-4 text-lake" />
        <span className="text-[14px] font-bold">急采待验收 {items.length} 张</span>
        <span className="text-[12.5px] text-ink-3">部门登记的急采收货，到部门验收后生效</span>
        <span className="ml-auto">{open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}</span>
      </button>
      {open && (
        <ul className="mt-2 space-y-1.5">
          {items.map((d) => (
            <li key={d.docId} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px]">
              <Link to={`/inventory/docs?doc=${d.docId}`} className="num font-semibold text-lake hover:underline">
                {d.docNo}
              </Link>
              <span>{[d.departmentName, d.supplierName].filter(Boolean).join(' · ')}</span>
              {d.amountCents !== null && <Money cents={d.amountCents} className="font-semibold" />}
              <span className="text-ink-3">
                {d.handlerName} 登记 · {formatDateTime(d.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function BackfillStrip({ items }: { items: { receiptId: number; docNo: string; departmentName: string | null; supplierName: string | null; amountCents: number; confirmedAt: string; daysOver: number; handlerName: string }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-lg border border-ember/30 bg-ember-soft/40 px-4 py-3" data-testid="approval-backfills">
      <button type="button" className="flex w-full items-center gap-2 text-left" onClick={() => setOpen((o) => !o)}>
        <PackageX className="size-4 text-ember" />
        <span className="text-[14px] font-bold">急采待补单 {items.length} 张</span>
        <span className="text-[12.5px] text-ink-3">收货生效后超过 {URGENT_BACKFILL_ESCALATE_DAYS} 天还没补采购单</span>
        <span className="ml-auto">{open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}</span>
      </button>
      {open && (
        <ul className="mt-2 space-y-1.5">
          {items.map((b) => (
            <li key={b.receiptId} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px]">
              <Link to={`/inventory/docs?doc=${b.receiptId}`} className="num font-semibold text-lake hover:underline">
                {b.docNo}
              </Link>
              <span>{[b.departmentName, b.supplierName].filter(Boolean).join(' · ')}</span>
              <Money cents={b.amountCents} className="font-semibold" />
              <Badge tone="clay">超 {b.daysOver} 天</Badge>
              <span className="text-ink-3">经办 {b.handlerName}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
