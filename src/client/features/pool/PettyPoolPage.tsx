// 零采备用金（8.1.9，docs/ERP_V819.md 第 2 节）：ERP「供应链 → 零采备用金」。
// 供应链零采专用：申用（登记即占用）→ 提交报销（未补单 / 已补单 + 采购单）→ 财务在「费用报销」登记报销单 → 确认后自动回补。
// 顶部四个数：总额、已占用、剩余可用、待报销笔数；一条占用条；下面是申用台账（窄屏是卡片）。
// 申用带操作编号，提交前先把编号与原请求存在本机（存不了就不发）：没收到结果时关掉弹窗、刷新以后，
// 页面顶上的「结果待确认」里还能查回、按原内容重新提交（只记一次）或确认作废。

import { useMemo, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Download, FilePen, HandCoins, Plus, Search, Send, Settings2, Undo2, Wallet } from 'lucide-react';
import { CLAIM_STATUS_LABELS } from '@shared/expenses';
import { formatYuan, parseYuan } from '@shared/money';
import { POOL_BACKFILL_LABELS, POOL_USE_STATE_LABELS, type PoolBackfill, type PoolBoard, type PoolPoOption, type PoolUseDetail, type PoolUseRow, type PoolUseState } from '@shared/petty-pool';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp } from '../../lib/erpPending';
import { useCan, useSession } from '../../lib/session';
import { cn, formatDateTime, uuid } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, MoneyInput, Notice, Select, Skeleton, Textarea } from '../../components/ui';
import { erpSettingsPath } from '../erp/settingsTabs';

const key = ['erp', 'pool'] as const;
type Tone = Parameters<typeof Badge>[0]['tone'];
const STATE_TONE: Record<PoolUseState, Tone> = { open: 'ember', submitted: 'yuzu', reviewing: 'lake', reimbursed: 'pine', voided: 'neutral' };
/** 占用条三段的颜色（与状态徽标一个色系） */
const SEGMENTS: { state: 'open' | 'submitted' | 'reviewing'; label: string; bar: string }[] = [
  { state: 'open', label: '待报销', bar: 'bg-ember' },
  { state: 'submitted', label: '已提交报销', bar: 'bg-yuzu-deep' },
  { state: 'reviewing', label: '报销审核中', bar: 'bg-lake' },
];
const STATE_FILTERS: { value: '' | PoolUseState; label: string }[] = [
  { value: '', label: '全部' },
  { value: 'open', label: '待报销' },
  { value: 'submitted', label: '已提交报销' },
  { value: 'reviewing', label: '审核中' },
  { value: 'reimbursed', label: '已报销' },
  { value: 'voided', label: '已作废' },
];

const qs = (params: Record<string, string>) => new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();

export function PettyPoolPage() {
  const can = useCan();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const filters = { state: params.get('state') ?? '', backfill: params.get('backfill') ?? '', applicantId: params.get('applicant') ?? '', from: params.get('from') ?? '', to: params.get('to') ?? '' };
  const query = qs({ state: filters.state, backfill: filters.backfill, applicantId: filters.applicantId, from: filters.from, to: filters.to });
  const board = useQuery({
    queryKey: [...key, query],
    queryFn: () => api.get<PoolBoard>(`/api/erp/pool${query ? `?${query}` : ''}`),
    placeholderData: keepPreviousData,
    enabled: can('pool.read'),
  });
  const manage = can('pool.manage');
  const applicants = useQuery({ queryKey: [...key, 'applicants'], queryFn: () => api.get<{ id: number; name: string }[]>('/api/erp/pool/applicants'), enabled: manage, staleTime: 300_000 });
  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState<{ use: PoolUseRow; mode: 'submit' | 'backfill' } | null>(null);
  const [voiding, setVoiding] = useState<PoolUseRow | null>(null);
  const [unsubmitting, setUnsubmitting] = useState<PoolUseRow | null>(null);
  const [opened, setOpened] = useState<number | null>(Number(params.get('use')) || null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  if (!can('pool.read')) return <Navigate to="/erp" replace />;
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const setFilter = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    next.delete('use');
    setParams(next, { replace: true });
  };
  const b = board.data;

  const doVoid = async (reason: string) => {
    if (!voiding) return;
    setBusy(true);
    try {
      await api.post(`/api/erp/pool/uses/${voiding.id}/void`, { version: voiding.version, reason });
      toast({ tone: 'success', title: '已作废', body: `${voiding.docNo} 不再占用额度` });
      setVoiding(null);
      await refresh();
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const doUnsubmit = async () => {
    if (!unsubmitting) return;
    setBusy(true);
    try {
      await api.post(`/api/erp/pool/uses/${unsubmitting.id}/unsubmit`, { version: unsubmitting.version });
      toast({ tone: 'success', title: '已撤回报销', body: unsubmitting.docNo });
      setUnsubmitting(null);
      await refresh();
    } catch (e) {
      toast({ tone: 'error', title: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const actions = (u: PoolUseRow) =>
    manage && u.state !== 'voided' ? (
      <span className="flex flex-wrap justify-end gap-1.5">
        {u.state === 'open' && (
          <Button size="sm" variant="primary" icon={<Send className="size-3.5" />} onClick={() => setSubmitting({ use: u, mode: 'submit' })} data-testid={`pool-submit-${u.id}`}>
            报销
          </Button>
        )}
        {u.state !== 'open' && (
          <Button size="sm" variant="secondary" icon={<FilePen className="size-3.5" />} onClick={() => setSubmitting({ use: u, mode: 'backfill' })} data-testid={`pool-backfill-${u.id}`}>
            更新补单
          </Button>
        )}
        {u.state === 'submitted' && (
          <Button size="sm" variant="ghost" icon={<Undo2 className="size-3.5" />} onClick={() => setUnsubmitting(u)} data-testid={`pool-unsubmit-${u.id}`}>
            撤回报销
          </Button>
        )}
        {(u.state === 'open' || u.state === 'submitted') && (
          <Button
            size="sm"
            variant="ghost"
            icon={<Ban className="size-3.5" />}
            onClick={() => setVoiding(u)}
            className="text-clay hover:bg-clay-soft/60 hover:text-clay"
            data-testid={`pool-void-${u.id}`}
          >
            作废
          </Button>
        )}
      </span>
    ) : null;

  return (
    <>
      <PageHeader
        dateMode="calendar"
        title="零采备用金"
        subtitle="供应链零采专用：申用占用额度 → 提交报销（补单）→ 财务登记报销单 → 确认后自动回补"
        actions={
          <span className="flex flex-wrap gap-2">
            <a href={`/api/erp/pool/export${query ? `?${query}` : ''}`} download>
              <Button size="sm" variant="secondary" icon={<Download className="size-4" />}>
                导出台账
              </Button>
            </a>
            {manage && (
              <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)} disabled={!b || b.settings.totalCents === null} data-testid="pool-new">
                申用
              </Button>
            )}
          </span>
        }
      />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1180px] space-y-4 px-4 py-5 md:px-7" data-testid="pool-page">
          {manage && <ErpPendingPanel types={['pool_use']} onFound={() => void refresh()} />}
          {board.isPending ? (
            <Skeleton className="h-64" />
          ) : board.isError && !b ? (
            <LoadFailed title="零采备用金没取回来" onRetry={() => void board.refetch()} retrying={board.isFetching} testId="pool-load-failed">
              {errorMessage(board.error)}
            </LoadFailed>
          ) : b ? (
            <>
              {b.settings.totalCents === null && (
                <Notice
                  tone="warning"
                  title="还没配置零采备用金的总额"
                  action={
                    can('settings.manage') ? (
                      <Link to={erpSettingsPath('expenses')}>
                        <Button size="sm" variant="secondary" icon={<Settings2 className="size-4" />}>
                          去「ERP 设置 → 报销与备用金」填
                        </Button>
                      </Link>
                    ) : undefined
                  }
                  data-testid="pool-unconfigured"
                >
                  总额由店主在「ERP 设置 → 报销与备用金」里填；填好以前不能申用。
                </Notice>
              )}
              <Summary board={b} />
              <Card className="p-4">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <Wallet className="size-4 text-ink-3" />
                  <span className="text-[14.5px] font-bold">申用台账</span>
                  {b.truncated && <Badge tone="ember">只显示最近 1000 笔，导出是全部</Badge>}
                </div>
                <Filters filters={filters} setFilter={setFilter} applicants={applicants.data ?? b.uses.map((u) => u.applicant)} />
                {b.uses.length === 0 ? (
                  <EmptyState
                    art="leaf"
                    title={query ? '没有符合条件的申用' : '还没有申用'}
                    description={manage && !query && b.settings.totalCents !== null ? '零采要先垫钱的，点右上角「申用」登记：申请人、用途、买什么、多少钱。' : undefined}
                    className="py-8"
                  />
                ) : (
                  <>
                    {/* 宽屏：表格 */}
                    <div className="mt-3 hidden overflow-x-auto lg:block">
                      <table className="w-full min-w-[880px] text-[13.5px]" data-testid="pool-table">
                        <thead>
                          <tr className="text-left text-[12px] text-ink-3">
                            <th className="py-1.5 font-semibold">单号 / 日期</th>
                            <th className="font-semibold">申请人</th>
                            <th className="font-semibold">用途 · 采购内容</th>
                            <th className="text-right font-semibold">申用金额</th>
                            <th className="pl-4 font-semibold">进度（补单 · 报销单）</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {b.uses.map((u) => (
                            <tr key={u.id} className={cn('border-t border-line/70 align-top', u.state === 'voided' && 'text-ink-3')} data-testid={`pool-use-${u.id}`}>
                              <td className="py-2 whitespace-nowrap">
                                <button type="button" className="num font-semibold text-pine hover:underline" onClick={() => setOpened(u.id)}>
                                  {u.docNo}
                                </button>
                                <p className="num text-[12px] text-ink-3">{u.useDate}</p>
                              </td>
                              <td className="py-2 pr-2 whitespace-nowrap">{u.applicant.name}</td>
                              <td className="max-w-[280px] py-2">
                                <p className="font-semibold">{u.purpose}</p>
                                <p className="line-clamp-2 text-[12.5px] text-ink-2">{u.content}</p>
                              </td>
                              <td className={cn('num py-2 text-right font-bold', u.state === 'voided' && 'line-through')}>{formatYuan(u.amountCents)}</td>
                              <td className="py-2 pl-4">
                                <StateBadge u={u} />
                                <div className="mt-1 space-y-0.5 leading-snug">
                                  <BackfillCell u={u} />
                                  <ClaimCell u={u} />
                                </div>
                              </td>
                              <td className="py-2 text-right">{actions(u)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {/* 窄屏（商米 V3、平板竖屏）：卡片 */}
                    <ul className="mt-3 space-y-2.5 lg:hidden" data-testid="pool-cards">
                      {b.uses.map((u) => (
                        <li key={u.id} className={cn('rounded-lg border border-line bg-card p-3', u.state === 'voided' && 'opacity-70')} data-testid={`pool-card-${u.id}`}>
                          <div className="flex items-start gap-2">
                            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpened(u.id)}>
                              <p className="font-semibold text-pine">{u.docNo}</p>
                              <p className="text-[12px] text-ink-3">
                                {u.useDate} · {u.applicant.name}
                              </p>
                            </button>
                            <span className={cn('num shrink-0 text-[16px] font-bold', u.state === 'voided' && 'line-through')}>{formatYuan(u.amountCents)}</span>
                          </div>
                          <p className="mt-1.5 text-[13px] font-semibold">{u.purpose}</p>
                          <p className="line-clamp-2 text-[12.5px] text-ink-2">{u.content}</p>
                          <div className="mt-2 flex flex-wrap items-start gap-x-3 gap-y-1 text-[12.5px]">
                            <StateBadge u={u} />
                            <div className="min-w-0 space-y-0.5">
                              <BackfillCell u={u} />
                              <ClaimCell u={u} />
                            </div>
                          </div>
                          {actions(u) && <div className="mt-2.5 border-t border-line/70 pt-2.5">{actions(u)}</div>}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </Card>
            </>
          ) : null}
        </div>
      </div>
      {creating && b && <UseDialog board={b} applicants={applicants.data ?? []} onClose={() => setCreating(false)} onDone={refresh} />}
      {submitting && <SubmitDialog use={submitting.use} mode={submitting.mode} onClose={() => setSubmitting(null)} onDone={refresh} />}
      <ReasonDialog
        open={!!voiding}
        title={`作废申用 ${voiding?.docNo ?? ''}`}
        description="作废以后这笔不再占用额度，也不能再提交报销；登记错了作废后重新申用。"
        confirmLabel="作废"
        danger
        busy={busy}
        testId="pool-void-dialog"
        onClose={() => setVoiding(null)}
        onConfirm={(reason) => void doVoid(reason)}
      />
      <Dialog
        open={!!unsubmitting}
        onClose={() => setUnsubmitting(null)}
        title={`撤回报销 ${unsubmitting?.docNo ?? ''}`}
        description="撤回以后回到「待报销」，财务那边看不到这一笔，补单情况照旧留着；之后可以重新提交。"
        footer={
          <>
            <Button variant="secondary" onClick={() => setUnsubmitting(null)} disabled={busy}>
              取消
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void doUnsubmit()} data-testid="pool-unsubmit-confirm">
              撤回报销
            </Button>
          </>
        }
      >
        <p className="text-[13.5px] text-ink-2">财务已经登记了报销单的不能撤回，要先请财务撤回或冲销那张报销单。</p>
      </Dialog>
      {opened && <DetailDialog useId={opened} onClose={() => setOpened(null)} />}
    </>
  );
}

// ───────────────────────── 顶部的数 ─────────────────────────

function Summary({ board }: { board: PoolBoard }) {
  const s = board.summary;
  const total = s.totalCents;
  const over = s.remainingCents !== null && s.remainingCents < 0;
  // 占用条：按总额（总额改小了按已占用）的比例画三段
  const base = Math.max(total ?? 0, s.occupiedCents, 1);
  return (
    <Card className="p-4" data-testid="pool-summary">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="备用金总额" value={total === null ? '还没配置' : formatYuan(total)} hint={board.departmentName ? `归属：${board.departmentName}` : '店主在 ERP 设置里填'} testId="pool-total" />
        <Stat label="已占用" value={formatYuan(s.occupiedCents)} hint={`${s.pendingCount} 笔还没报销完`} tone="ember" testId="pool-occupied" />
        <Stat
          label="剩余可用"
          value={s.remainingCents === null ? '—' : formatYuan(s.remainingCents)}
          hint={over ? '超出总额：先报销再申用' : s.reimbursedThisMonth.count ? `本月已回补 ${s.reimbursedThisMonth.count} 笔 ${formatYuan(s.reimbursedThisMonth.cents)}` : '报销确认后自动回补'}
          tone={over ? 'clay' : 'pine'}
          testId="pool-remaining"
        />
        <Stat
          label="待报销"
          value={`${s.pendingCount} 笔`}
          hint={`已提交 ${s.byState.submitted.count} · 审核中 ${s.byState.reviewing.count}`}
          tone={s.pendingCount ? 'yuzu' : undefined}
          testId="pool-pending"
        />
      </div>
      <div className="mt-4">
        <div
          className="flex h-3 w-full overflow-hidden rounded-full bg-pine-soft"
          role="img"
          aria-label={`已占用 ${formatYuan(s.occupiedCents)}，剩余 ${s.remainingCents === null ? '未配置' : formatYuan(s.remainingCents)}`}
        >
          {SEGMENTS.map((seg) => {
            const cents = s.byState[seg.state].cents;
            return cents > 0 ? <span key={seg.state} className={cn('h-full', seg.bar)} style={{ width: `${(cents / base) * 100}%` }} title={`${seg.label} ${formatYuan(cents)}`} /> : null;
          })}
        </div>
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-2">
          {SEGMENTS.map((seg) => (
            <li key={seg.state} className="flex items-center gap-1.5">
              <span className={cn('size-2.5 rounded-full', seg.bar)} />
              {seg.label} {s.byState[seg.state].count} 笔 · <span className="num">{formatYuan(s.byState[seg.state].cents)}</span>
            </li>
          ))}
          <li className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-pine-soft ring-1 ring-pine/30" />
            剩余可用
          </li>
        </ul>
      </div>
    </Card>
  );
}

function Stat({ label, value, hint, tone, testId }: { label: string; value: string; hint: string; tone?: 'ember' | 'pine' | 'clay' | 'yuzu'; testId: string }) {
  const color = { ember: 'text-ember', pine: 'text-pine', clay: 'text-clay', yuzu: 'text-yuzu-deep' } as const;
  return (
    <div className="min-w-0 rounded-lg bg-paper-2/60 px-3 py-2.5" data-testid={testId}>
      <p className="text-[12px] font-semibold text-ink-3">{label}</p>
      <p className={cn('num truncate text-[20px] font-bold md:text-[22px]', tone ? color[tone] : 'text-ink')}>{value}</p>
      <p className="truncate text-[12px] text-ink-3">{hint}</p>
    </div>
  );
}

// ───────────────────────── 台账的格子 ─────────────────────────

function StateBadge({ u }: { u: PoolUseRow }) {
  return (
    <Badge tone={STATE_TONE[u.state]} className="whitespace-nowrap">
      {POOL_USE_STATE_LABELS[u.state]}
    </Badge>
  );
}

function BackfillCell({ u }: { u: PoolUseRow }) {
  if (!u.backfill) return u.state === 'open' || u.state === 'voided' ? null : <span className="block text-[12.5px] text-ink-3">补单未填</span>;
  return (
    <span className="block text-[12.5px] whitespace-nowrap">
      <span className={u.backfill === 'done' ? 'font-semibold text-pine' : 'font-semibold text-ember'}>{POOL_BACKFILL_LABELS[u.backfill]}</span>
      {u.purchaseOrder && (
        <Link to={`/purchasing?po=${u.purchaseOrder.id}`} className="ml-1 text-ink-2 hover:underline">
          {u.purchaseOrder.docNo}
        </Link>
      )}
    </span>
  );
}

function ClaimCell({ u }: { u: PoolUseRow }) {
  const can = useCan();
  if (!u.claim) return u.state === 'submitted' ? <span className="block text-[12.5px] text-ink-3">等财务登记报销单</span> : null;
  const text = (
    <>
      {u.claim.docNo} · {CLAIM_STATUS_LABELS[u.claim.status]}
      {u.claim.amountCents !== u.amountCents && <span className="num"> · 报销 {formatYuan(u.claim.amountCents)}</span>}
    </>
  );
  return can('expense.read') ? (
    <Link to={`/erp/expenses?claim=${u.claim.id}`} className="block text-[12.5px] whitespace-nowrap text-pine hover:underline">
      {text}
    </Link>
  ) : (
    <span className="block text-[12.5px] whitespace-nowrap">{text}</span>
  );
}

function Filters({ filters, setFilter, applicants }: { filters: Record<string, string>; setFilter: (k: string, v: string) => void; applicants: { id: number; name: string }[] }) {
  const unique = useMemo(() => [...new Map(applicants.map((a) => [a.id, a])).values()], [applicants]);
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="scroll-thin -mx-1 flex max-w-full gap-1 overflow-x-auto px-1 pb-1" role="radiogroup" aria-label="按状态看">
        {STATE_FILTERS.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={filters.state === o.value}
            onClick={() => setFilter('state', o.value)}
            className={cn(
              'h-8 shrink-0 rounded-full border px-3 text-[12.5px] font-semibold whitespace-nowrap transition-colors',
              filters.state === o.value ? 'border-pine bg-pine text-white' : 'border-line bg-card text-ink-2 hover:border-pine/40',
            )}
            data-testid={`pool-filter-${o.value || 'all'}`}
          >
            {o.label}
          </button>
        ))}
      </div>
      <Select value={filters.backfill} onChange={(e) => setFilter('backfill', e.target.value)} fullWidth={false} className="h-8 w-[118px] text-[12.5px]" aria-label="补单">
        <option value="">补单：全部</option>
        <option value="pending">未补单</option>
        <option value="done">已补单</option>
        <option value="none">补单未填</option>
      </Select>
      <Select value={filters.applicantId} onChange={(e) => setFilter('applicant', e.target.value)} fullWidth={false} className="h-8 w-[130px] text-[12.5px]" aria-label="申请人">
        <option value="">申请人：全部</option>
        {unique.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </Select>
      <span className="flex items-center gap-1 text-[12.5px] text-ink-3">
        <Input type="date" value={filters.from} onChange={(e) => setFilter('from', e.target.value)} className="h-8 w-[136px] text-[12.5px]" aria-label="从" />
        至
        <Input type="date" value={filters.to} onChange={(e) => setFilter('to', e.target.value)} className="h-8 w-[136px] text-[12.5px]" aria-label="到" />
      </span>
    </div>
  );
}

// ───────────────────────── 申用 ─────────────────────────

function UseDialog({ board, applicants, onClose, onDone }: { board: PoolBoard; applicants: { id: number; name: string }[]; onClose: () => void; onDone: () => Promise<unknown> }) {
  const session = useSession();
  const toast = useToast();
  // 这个弹窗开着的时候一直用同一个操作编号；编号与原请求提交前存在本机（sendErpOp）
  const [clientKey] = useState(uuid);
  const [applicantId, setApplicantId] = useState<number>(session.staff.id);
  const [useDate, setUseDate] = useState(session.calendarToday);
  const [purpose, setPurpose] = useState('');
  const [content, setContent] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const cents = parseYuan(amount);
  const remaining = board.summary.remainingCents ?? 0;
  const over = cents !== null && cents > remaining;
  const options = applicants.some((a) => a.id === session.staff.id) ? applicants : [{ id: session.staff.id, name: session.staff.displayName }, ...applicants];

  const submit = async () => {
    setError(null);
    if (!purpose.trim()) return setError('请写用途说明');
    if (!content.trim()) return setError('请写采购内容');
    if (cents === null || cents <= 0) return setError('申用金额要大于 0，写到分');
    if (over) return setError(`剩余可用只有 ${formatYuan(remaining)}`);
    setSaving(true);
    try {
      const name = options.find((a) => a.id === applicantId)?.name ?? '';
      await sendErpOp({
        key: clientKey,
        type: 'pool_use',
        url: '/api/erp/pool/uses',
        body: { clientKey, useDate, applicantId, purpose: purpose.trim(), content: content.trim(), amountCents: cents, note: note.trim() },
        summary: `零采备用金申用 · ${name} · ${formatYuan(cents)} · ${content.trim().slice(0, 30)}`,
        staffName: session.staff.displayName,
      });
      toast({ tone: 'success', title: '已申用', body: `占用 ${formatYuan(cents)}` });
      await onDone();
      onClose();
    } catch (e) {
      if (e instanceof UncertainError) {
        setUncertain(true);
        setError('没收到结果，不知道记没记上。不要改内容，再点一次「申用」——记过了不会再记一次。也可以先关掉：这一笔在页面顶上的「结果待确认」里，能查回、按原内容重新提交或确认作废。');
      } else setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="申用零采备用金"
      description="登记即占用额度；买完货、补了单以后在台账里点「报销」。"
      width="max-w-lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {uncertain ? '先关掉（在「结果待确认」里处理）' : '取消'}
          </Button>
          <Button variant="primary" icon={<HandCoins className="size-4" />} loading={saving} onClick={() => void submit()} disabled={over} data-testid="pool-use-save">
            申用
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="pool-use-dialog">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="申请人" htmlFor="pool-applicant">
            <Select id="pool-applicant" value={applicantId} disabled={uncertain} onChange={(e) => setApplicantId(Number(e.target.value))}>
              {options.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="申用日期" htmlFor="pool-date">
            <Input id="pool-date" type="date" value={useDate} max={session.calendarToday} disabled={uncertain} onChange={(e) => setUseDate(e.target.value)} />
          </Field>
        </div>
        <Field label="用途说明" htmlFor="pool-purpose">
          <Input id="pool-purpose" value={purpose} maxLength={100} disabled={uncertain} onChange={(e) => setPurpose(e.target.value)} placeholder="例如：前台客用品补货" />
        </Field>
        <Field label="采购内容" htmlFor="pool-content">
          <Textarea id="pool-content" rows={2} value={content} maxLength={200} disabled={uncertain} onChange={(e) => setContent(e.target.value)} placeholder="买什么、在哪买：网购一次性拖鞋 2 箱" />
        </Field>
        <Field label="申用金额" htmlFor="pool-amount" hint={`剩余可用 ${formatYuan(remaining)}`}>
          <MoneyInput id="pool-amount" value={amount} invalid={over} disabled={uncertain} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" data-testid="pool-amount" />
        </Field>
        {over && (
          <Notice tone="error" title={`超过剩余可用 ${formatYuan(remaining)}`}>
            先报销已经用掉的，或请店主调高总额。
          </Notice>
        )}
        <Field label="备注（选填）" htmlFor="pool-note">
          <Input id="pool-note" value={note} maxLength={200} disabled={uncertain} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {error && <Notice tone={uncertain ? 'warning' : 'error'} title={error} />}
      </div>
    </Dialog>
  );
}

// ───────────────────────── 报销 / 更新补单 ─────────────────────────

function SubmitDialog({ use, mode, onClose, onDone }: { use: PoolUseRow; mode: 'submit' | 'backfill'; onClose: () => void; onDone: () => Promise<unknown> }) {
  const toast = useToast();
  const [backfill, setBackfill] = useState<PoolBackfill | null>(use.backfill);
  const [po, setPo] = useState<{ id: number; docNo: string; supplierName: string } | null>(use.purchaseOrder);
  const [q, setQ] = useState('');
  const [note, setNote] = useState(use.submitNote);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = useQuery({
    queryKey: [...key, 'po-options', q],
    queryFn: () => api.get<PoolPoOption[]>(`/api/erp/pool/po-options?${qs({ q: q.trim() })}`),
    enabled: backfill === 'done',
    placeholderData: keepPreviousData,
  });

  const save = async () => {
    setError(null);
    if (!backfill) return setError('请选未补单或已补单');
    if (backfill === 'done' && !po) return setError('已补单请选对应的采购单');
    setSaving(true);
    try {
      const body = { version: use.version, backfill, purchaseOrderId: backfill === 'done' ? po!.id : null, ...(mode === 'submit' ? { note: note.trim() } : {}) };
      await api.post(`/api/erp/pool/uses/${use.id}/${mode}`, body);
      toast({ tone: 'success', title: mode === 'submit' ? '已提交报销' : '补单已更新', body: mode === 'submit' ? '财务登记报销单时就能勾这一笔' : use.docNo });
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
      title={mode === 'submit' ? `报销 ${use.docNo}` : `更新补单 ${use.docNo}`}
      description={
        mode === 'submit'
          ? '勾补单情况（已补单要选对应的采购单）；提交以后由财务在「费用报销」登记报销单，确认后这笔自动回补。'
          : '补单只是记录：未补单的补了采购单以后改过来，已报销的也能改，不动钱。'
      }
      width="max-w-xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void save()} data-testid="pool-submit-save">
            {mode === 'submit' ? '提交报销' : '保存补单'}
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="pool-submit-dialog">
        <div className="rounded-lg bg-paper-2/60 px-3 py-2 text-[13px]">
          <p className="font-semibold">
            {use.purpose} · <span className="num">{formatYuan(use.amountCents)}</span>
          </p>
          <p className="text-ink-2">{use.content}</p>
        </div>
        <fieldset>
          <legend className="mb-1.5 text-[13px] font-semibold text-ink-2">补单情况</legend>
          <div className="grid grid-cols-2 gap-2">
            {(['pending', 'done'] as const).map((v) => (
              <label
                key={v}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5 text-[14px] font-semibold',
                  backfill === v ? 'border-pine bg-pine-tint text-pine' : 'border-line bg-card text-ink-2',
                )}
              >
                <input type="radio" name="pool-backfill" checked={backfill === v} onChange={() => setBackfill(v)} data-testid={`pool-backfill-${v}`} />
                {POOL_BACKFILL_LABELS[v]}
              </label>
            ))}
          </div>
          <p className="mt-1 text-[12px] text-ink-3">补单 = 事后补的采购单（库管入库、急采以后在收货单上「补采购单」生成的那种，也可以是别的已确认的采购单）。</p>
        </fieldset>
        {backfill === 'done' && (
          <div className="space-y-2">
            {po && (
              <p className="flex items-center gap-2 rounded-lg border border-pine/30 bg-pine-tint px-3 py-2 text-[13.5px]" data-testid="pool-po-chosen">
                <span className="font-semibold text-pine">{po.docNo}</span>
                <span className="min-w-0 flex-1 truncate text-ink-2">{po.supplierName}</span>
                <Button size="sm" variant="ghost" onClick={() => setPo(null)}>
                  换一张
                </Button>
              </p>
            )}
            {!po && (
              <>
                <div className="relative">
                  <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
                  <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="按采购单号、供应商找" className="pl-9" data-testid="pool-po-search" />
                </div>
                {options.isError && !options.data ? (
                  <LoadFailed title="采购单没取回来" onRetry={() => void options.refetch()} retrying={options.isFetching} />
                ) : (
                  <ul className="scroll-thin max-h-56 space-y-1 overflow-y-auto" data-testid="pool-po-options">
                    {options.isPending && <Skeleton className="h-10" />}
                    {options.data?.length === 0 && <li className="py-3 text-center text-[13px] text-ink-3">没有找到已确认的采购单</li>}
                    {options.data?.map((o) => (
                      <li key={o.id}>
                        <button
                          type="button"
                          onClick={() => setPo({ id: o.id, docNo: o.docNo, supplierName: o.supplierName })}
                          className="flex w-full items-center gap-2 rounded-md border border-line px-3 py-2 text-left text-[13px] hover:border-pine/40"
                          data-testid={`pool-po-${o.id}`}
                        >
                          <span className="font-semibold">{o.docNo}</span>
                          {o.backfill && <Badge tone="lake">补单</Badge>}
                          <span className="min-w-0 flex-1 truncate text-ink-2">{o.supplierName}</span>
                          <span className="num text-ink-3">{o.orderDate}</span>
                          <span className="num font-semibold">{formatYuan(o.totalCents)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        )}
        {mode === 'submit' && (
          <Field label="说明（选填）" htmlFor="pool-submit-note" hint="给财务的话：发票随后补、实际花了多少……">
            <Input id="pool-submit-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
          </Field>
        )}
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}

// ───────────────────────── 详情 ─────────────────────────

function DetailDialog({ useId, onClose }: { useId: number; onClose: () => void }) {
  const detail = useQuery({ queryKey: [...key, 'use', useId], queryFn: () => api.get<PoolUseDetail>(`/api/erp/pool/uses/${useId}`) });
  const u = detail.data;
  const steps: { label: string; at: string | null; text: string; done: boolean }[] = u
    ? [
        { label: '申用', at: u.createdAt, text: `${u.createdByName} 登记 · 占用 ${formatYuan(u.amountCents)}`, done: true },
        {
          label: '提交报销',
          at: u.submittedAt,
          text: u.submittedAt ? `${u.submittedByName ?? ''} 提交 · ${u.backfill ? POOL_BACKFILL_LABELS[u.backfill] : ''}${u.purchaseOrder ? ` ${u.purchaseOrder.docNo}` : ''}` : '还没提交',
          done: !!u.submittedAt || !!u.claim,
        },
        { label: '财务登记报销单', at: null, text: u.claim ? `${u.claim.docNo} · ${CLAIM_STATUS_LABELS[u.claim.status]} · ${formatYuan(u.claim.amountCents)}` : '还没登记', done: !!u.claim },
        {
          label: '确认回补',
          at: u.state === 'reimbursed' ? (u.claim?.confirmedAt ?? null) : null,
          text: u.state === 'reimbursed' ? `回补 ${formatYuan(u.amountCents)}` : '报销单确认后自动回补',
          done: u.state === 'reimbursed',
        },
      ]
    : [];
  return (
    <Dialog open onClose={onClose} title={u ? `申用 ${u.docNo}` : '申用'} width="max-w-lg">
      {detail.isPending ? (
        <Skeleton className="h-48" />
      ) : detail.isError && !u ? (
        <LoadFailed title="这笔申用没取回来" onRetry={() => void detail.refetch()} retrying={detail.isFetching}>
          {errorMessage(detail.error)}
        </LoadFailed>
      ) : u ? (
        <div className="space-y-4 text-[13.5px]" data-testid="pool-detail">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
            <div>
              <dt className="text-[12px] text-ink-3">状态</dt>
              <dd>
                <StateBadge u={u} />
              </dd>
            </div>
            <div>
              <dt className="text-[12px] text-ink-3">申用金额</dt>
              <dd className="num font-bold">{formatYuan(u.amountCents)}</dd>
            </div>
            <div>
              <dt className="text-[12px] text-ink-3">申请人</dt>
              <dd>{u.applicant.name}</dd>
            </div>
            <div>
              <dt className="text-[12px] text-ink-3">申用日期</dt>
              <dd className="num">{u.useDate}</dd>
            </div>
            <div className="col-span-2">
              <dt className="text-[12px] text-ink-3">用途说明</dt>
              <dd>{u.purpose}</dd>
            </div>
            <div className="col-span-2">
              <dt className="text-[12px] text-ink-3">采购内容</dt>
              <dd className="whitespace-pre-wrap">{u.content}</dd>
            </div>
            {u.note && (
              <div className="col-span-2">
                <dt className="text-[12px] text-ink-3">备注</dt>
                <dd>{u.note}</dd>
              </div>
            )}
            {u.submitNote && (
              <div className="col-span-2">
                <dt className="text-[12px] text-ink-3">提交报销的说明</dt>
                <dd>{u.submitNote}</dd>
              </div>
            )}
            {u.voidReason && (
              <div className="col-span-2">
                <dt className="text-[12px] text-ink-3">作废</dt>
                <dd className="text-clay">
                  {u.voidedByName} · {u.voidedAt ? formatDateTime(u.voidedAt) : ''} · {u.voidReason}
                </dd>
              </div>
            )}
          </dl>
          {u.state !== 'voided' && (
            <ol className="space-y-2.5 border-l-2 border-line pl-4" data-testid="pool-timeline">
              {steps.map((s) => (
                <li key={s.label} className="relative">
                  <span className={cn('absolute top-1 -left-[23px] size-3 rounded-full ring-2 ring-card', s.done ? 'bg-pine' : 'bg-line')} />
                  <p className={cn('font-semibold', !s.done && 'text-ink-3')}>
                    {s.label}
                    {s.at && <span className="ml-2 text-[12px] font-normal text-ink-3">{formatDateTime(s.at)}</span>}
                  </p>
                  <p className="text-[12.5px] text-ink-2">{s.text}</p>
                </li>
              ))}
            </ol>
          )}
          {u.claims.some((c) => c.status === 'cancelled' || c.status === 'voided') && (
            <div>
              <p className="mb-1 text-[12px] font-semibold text-ink-3">挂过的报销单</p>
              <ul className="space-y-1 text-[12.5px]">
                {u.claims.map((c) => (
                  <li key={c.id}>
                    {c.docNo} · {CLAIM_STATUS_LABELS[c.status]} · <span className="num">{formatYuan(c.amountCents)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : null}
    </Dialog>
  );
}
