// 收银台（8.1.15，docs/DESKS_V8115.md 第 3.3 节）：客人离店结账。左边是待结账清单（在店的手牌），直接敲牌号回车就打开；
// 右边是只读账单（不能加项目、作废、换牌），带这位客人能用的权益与优惠；预结账、结账、结账记录都在这里。
// 接待发牌、换牌、挂账在发卡台（FrontdeskPage）。两个台共用一个「补录纸质单」状态（desk.tsx 的 DeskLayout）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { ArrowDownWideNarrow, FilePenLine, Gift, Hash, Keyboard, ReceiptText, Search, ShieldCheck, Store, Ticket, UserRound, X } from 'lucide-react';
import { matchTags, normalizeTagCode, uniqueTagMatch, ZONE_LABELS, type BoardTag } from '@shared/frontdesk';
import { useCan, useSession } from '../../lib/session';
import { cn, isTypingTarget } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { Money } from '../../components/Money';
import { Sheet } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Button, Kbd, Segmented, Select, Skeleton } from '../../components/ui';
import { useMedia } from '../inventory/useMedia';
import { UnsettledPayBanner } from '../pay/ScanPay';
import { UnusedVerificationsBanner } from '../pay/VoucherVerify';
import { CrossDayShiftNotice } from '../shift/ShiftGate';
import { BackfillBar, useBackfill } from './backfill';
import { BillPanel, type PanelAction } from './BillPanel';
import { CheckoutDialog, CheckoutRecordsDialog } from './CheckoutDialog';
import { BillPerks, gradeShort } from './desk';
import { ChecksDialog } from './FrontdeskPage';
import { overstayOf } from '@shared/frontdesk-risk';
import { GroupMark, Stat, VipChip, VisitStatusChips, ZoneChip } from './parts';
import { stayMinutes, stayText, useBoard, useCheckoutPreview, useRefreshFrontdesk, useServerNow, useVisit } from './queries';
import { FindGuestDialog } from './ToolDialogs';
import { PreviewDialog } from './VisitDialogs';

type QueueFilter = 'all' | 'spent' | 'group' | 'long';
type QueueSort = 'code' | 'amount' | 'stay';
const SORT_LABELS: Record<QueueSort, string> = { code: '按牌号', amount: '金额高的在前', stay: '在店久的在前' };

export function CashierPage() {
  const session = useSession();
  const can = useCan();
  const navigate = useNavigate();
  const toast = useToast();
  const board = useBoard();
  const refresh = useRefreshFrontdesk();
  const [params, setParams] = useSearchParams();
  const selectedId = Number(params.get('v')) || null;
  const visit = useVisit(selectedId);
  const now = useServerNow(board.data?.serverTime);
  const wide = useMedia('(min-width: 1024px)');
  const backfill = useBackfill();

  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const [picked, setPicked] = useState(false);
  const [filter, setFilter] = useState<QueueFilter>('all');
  const [sort, setSort] = useState<QueueSort>('code');
  const [dialog, setDialog] = useState<null | { kind: 'preview' } | { kind: 'checkout'; ids?: number[] } | { kind: 'records'; checkoutId?: number }>(null);
  const [checksOpen, setChecksOpen] = useState(false);
  const [finding, setFinding] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const tags = board.data?.tags ?? [];
  const inStore = useMemo(() => tags.filter((t) => t.visit), [tags]);
  // 敲的牌号只在在店的手牌里找；对上的是空闲牌时另外提示（没有账单可看）
  const matches = useMemo(() => (q ? matchTags(inStore, q) : []), [inStore, q]);
  const unique = useMemo(() => (q ? uniqueTagMatch(inStore, q) : null), [inStore, q]);
  const idle = useMemo(() => (q && matches.length === 0 ? uniqueTagMatch(tags, q) : null), [tags, q, matches.length]);
  const primary = picked ? matches[Math.min(cursor, matches.length - 1)] : (unique ?? undefined);

  const select = useCallback(
    (id: number | null) => {
      const next = new URLSearchParams(params);
      if (id) next.set('v', String(id));
      else next.delete('v');
      setParams(next, { replace: true });
    },
    [params, setParams],
  );
  const openTag = useCallback(
    (t: BoardTag) => {
      setQ('');
      setCursor(0);
      setPicked(false);
      if (t.visit) select(t.visit.id);
    },
    [select],
  );

  // 从顶部「结果待确认」进入：结账打开结账对话框，退款单打开结账记录里的原结账单
  const resume = params.get('resume');
  useEffect(() => {
    if (!resume) return;
    // 发牌、挂账、换牌、转明细在发卡台处理：带着这几种来的转过去
    if (resume !== 'checkout' && resume !== 'checkout_refund') {
      navigate(`/frontdesk?${params}`, { replace: true });
      return;
    }
    if (!board.data) return;
    if (resume === 'checkout' && (!visit.data || visit.data.id !== selectedId)) return;
    if (resume === 'checkout_refund') setDialog({ kind: 'records', checkoutId: Number(params.get('c')) || undefined });
    else setDialog({ kind: 'checkout' });
    const next = new URLSearchParams(params);
    next.delete('resume');
    next.delete('c');
    setParams(next, { replace: true });
  }, [resume, board.data, visit.data, selectedId, params, setParams, navigate]);

  // 盲打牌号、F8 预结账、F9 结账
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // 窄屏时账单是侧滑抽屉（也是 dialog），不挡快捷键；其他弹窗打开时不响应
      if (document.querySelector('[role="dialog"]:not([aria-label="手牌账单"])')) return;
      const sheetOpen = !!document.querySelector('[role="dialog"][aria-label="手牌账单"]');
      if (e.key === 'F8' && visit.data?.status === 'open') {
        e.preventDefault();
        setDialog({ kind: 'preview' });
        return;
      }
      if (e.key === 'F9' && visit.data?.status === 'open' && can('frontdesk.checkout')) {
        e.preventDefault();
        setDialog({ kind: 'checkout' });
        return;
      }
      if (isTypingTarget(e.target)) return;
      if (/^[0-9a-zA-Z]$/.test(e.key)) {
        e.preventDefault();
        if (sheetOpen) select(null);
        searchRef.current?.focus();
        setQ((v) => normalizeTagCode(v + e.key));
        setCursor(0);
      } else if (e.key === 'Escape' && selectedId) {
        select(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [can, visit.data, selectedId, select]);

  const matchedIds = new Set(matches.map((t) => t.id));
  const queue = useMemo(() => {
    const list = inStore.filter((t) => {
      const v = t.visit!;
      if (filter === 'spent') return v.amountCents > 0;
      if (filter === 'group') return v.groupId !== null;
      if (filter === 'long') return overstayOf(stayMinutes(v.checkedInAt, now)) !== null;
      return true;
    });
    // 按牌号时沿用手牌板的顺序（分区、柜型、号段）
    if (sort === 'amount') return [...list].sort((a, b) => b.visit!.amountCents - a.visit!.amountCents);
    if (sort === 'stay') return [...list].sort((a, b) => a.visit!.checkedInAt.localeCompare(b.visit!.checkedInAt));
    return list;
  }, [inStore, filter, sort, now]);
  const shown = q ? queue.filter((t) => matchedIds.has(t.id)) : queue;

  const stats = board.data?.stats;
  const open = visit.data?.status === 'open';
  // 这位客人现在能用的权益（与结账对话框同一个核对接口，按此刻计价）
  const perks = useCheckoutPreview(selectedId && open ? [selectedId] : [], !!selectedId && !!open && !dialog);

  const panel = (
    <BillPanel
      desk="cashier"
      visit={visit.data}
      loading={visit.isPending}
      error={visit.error}
      rules={board.data?.rules}
      extra={visit.data ? <BillPerks visit={visit.data} preview={perks.data} loading={perks.isPending} /> : undefined}
      onAction={(a: PanelAction) => {
        if (a === 'preview' || a === 'checkout' || a === 'records') setDialog({ kind: a });
      }}
      onSelectVisit={select}
      onChanged={() => refresh(selectedId ? [selectedId] : [])}
      onClose={wide ? undefined : () => select(null)}
    />
  );

  return (
    <>
      <PageHeader
        title="收银台 · 待结账"
        subtitle={
          stats ? (
            <span className="flex flex-wrap gap-x-4">
              <Stat label="在店" tone="pine">
                {stats.inStore}
              </Stat>
              <Stat label="同行">{stats.groups} 组</Stat>
              <span className="flex items-center gap-1.5">
                未结合计 <Money cents={stats.unsettledCents} className="font-bold text-ink" />
              </span>
            </span>
          ) : (
            session.storeName
          )
        }
        actions={
          <>
            <Button size="sm" variant="ghost" icon={<Search className="size-4" />} onClick={() => setFinding(true)} data-testid="open-find-guest">
              找客人
            </Button>
            {can('frontdesk.backfill') && (
              <Button
                size="sm"
                variant={backfill.state.active ? 'accent' : 'ghost'}
                icon={<FilePenLine className="size-4" />}
                aria-pressed={backfill.state.active}
                onClick={() => backfill.setState({ active: !backfill.state.active, slipNo: '', at: '' })}
                data-testid="backfill-toggle"
              >
                补录纸质单
              </Button>
            )}
            <Button size="sm" variant="ghost" icon={<ReceiptText className="size-4" />} onClick={() => setDialog({ kind: 'records' })} data-testid="open-checkouts">
              结账记录
            </Button>
            {(can('platform.redeem') || can('platform.settle')) && (
              <Button size="sm" variant="ghost" icon={<Store className="size-4" />} onClick={() => navigate('/platform')} data-testid="open-platform">
                平台核销
              </Button>
            )}
            <Button size="sm" variant="ghost" icon={<ShieldCheck className="size-4" />} onClick={() => setChecksOpen(true)}>
              自检
            </Button>
          </>
        }
      />
      <div className={cn('grid min-h-0 flex-1', wide ? 'grid-cols-[minmax(0,1fr)_400px] xl:grid-cols-[minmax(0,1fr)_460px]' : 'grid-cols-1')}>
        <div className="flex min-h-0 flex-col">
          <div className="shrink-0 space-y-3 border-b border-line px-5 pt-4 pb-3 md:px-6">
            <CrossDayShiftNotice />
            {/* 8.0.21 扫码收款：收了钱没入账、还在支付中、原路退款没完成的 */}
            <UnsettledPayBanner />
            {/* 8.0.21 平台验券：验过券没结账的 */}
            <UnusedVerificationsBanner />
            <div className="relative">
              <Hash className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-ink-3" />
              <input
                ref={searchRef}
                value={q}
                onChange={(e) => {
                  setQ(normalizeTagCode(e.target.value));
                  setCursor(0);
                  setPicked(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (primary) {
                      openTag(primary);
                      searchRef.current?.blur();
                    }
                  } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setCursor((c) => (picked ? Math.min(c + 1, Math.max(0, matches.length - 1)) : Math.max(0, matches.indexOf(unique ?? matches[0]!))));
                    setPicked(true);
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setCursor((c) => (picked ? Math.max(0, c - 1) : Math.max(0, matches.indexOf(unique ?? matches[0]!))));
                    setPicked(true);
                  } else if (e.key === 'Escape') {
                    setQ('');
                    searchRef.current?.blur();
                  }
                }}
                placeholder="直接敲牌号（末位即可），回车看账单"
                aria-label="牌号快检"
                data-testid="tag-search"
                autoComplete="off"
                className="num h-[52px] w-full rounded-[14px] border border-line-strong bg-card pr-10 pl-11 text-[22px] font-bold tracking-wide outline-none placeholder:text-[15px] placeholder:font-medium placeholder:tracking-normal focus:border-pine focus:shadow-[0_0_0_3px_rgb(36_73_58/0.12)]"
              />
              {q && (
                <button type="button" aria-label="清空" onClick={() => setQ('')} className="absolute top-1/2 right-3 -translate-y-1/2 rounded-md p-1 text-ink-3 hover:text-ink">
                  <X className="size-4" />
                </button>
              )}
            </div>
            <BackfillBar />
            {q ? (
              <p className="min-h-8 text-[13px]" aria-live="polite" data-testid="search-hint">
                {matches.length > 0 ? (
                  <span className="text-ink-3">
                    {primary || matches.length === 1 ? `对上 ${matches.length} 张在店的手牌，回车打开` : `对上 ${matches.length} 张，请用方向键选中后回车，或直接点选`}
                  </span>
                ) : idle ? (
                  <span className="font-semibold text-clay">
                    手牌 {idle.code} 现在没有在店的客人（{idle.locked ? '锁定' : '空闲'}），没有账单可看
                  </span>
                ) : (
                  <span className="font-semibold text-clay">没有匹配「{q}」的在店手牌</span>
                )}
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-2.5">
                <Segmented
                  size="sm"
                  value={filter}
                  onChange={setFilter}
                  ariaLabel="筛选"
                  options={[
                    { value: 'all', label: `全部 ${inStore.length}` },
                    { value: 'spent', label: '有消费' },
                    { value: 'group', label: '同行' },
                    { value: 'long', label: '超 12 小时' },
                  ]}
                />
                <label className="ml-auto flex items-center gap-1.5 text-[12.5px] text-ink-3">
                  <ArrowDownWideNarrow className="size-4" />
                  <Select value={sort} onChange={(e) => setSort(e.target.value as QueueSort)} aria-label="排序" className="h-8 w-auto text-[13px]" data-testid="queue-sort">
                    {(Object.keys(SORT_LABELS) as QueueSort[]).map((s) => (
                      <option key={s} value={s}>
                        {SORT_LABELS[s]}
                      </option>
                    ))}
                  </Select>
                </label>
              </div>
            )}
          </div>

          {/* 待结账清单 */}
          <div className="@container scroll-thin min-h-0 flex-1 overflow-y-auto px-5 pt-3 pb-8 md:px-6" data-testid="cashier-queue">
            {board.isPending ? (
              <div className="space-y-2">
                {Array.from({ length: 8 }, (_, i) => (
                  <Skeleton key={i} className="h-[60px] rounded-[14px]" />
                ))}
              </div>
            ) : board.error ? (
              <LoadFailed title="待结账清单没取回来" onRetry={() => void board.refetch()} retrying={board.isFetching}>
                {board.error.message}
              </LoadFailed>
            ) : inStore.length === 0 ? (
              <EmptyState art="calm" title="现在没有在店的客人" description="客人在发卡台发了牌，就会出现在这里；离店时敲牌号回车结账。" />
            ) : shown.length === 0 ? (
              <p className="py-10 text-center text-[13.5px] text-ink-3">{q ? '没有对上的在店手牌' : '这个筛选下没有手牌'}</p>
            ) : (
              // 清单够宽时排两列（台式收银机的大屏一屏看得到更多手牌），窄了一列
              <ul className="grid grid-cols-1 gap-2 @min-[56rem]:grid-cols-2">
                {shown.map((t) => (
                  <QueueRow key={t.id} tag={t} now={now} selected={t.visit!.id === selectedId} primary={t === primary} onClick={() => openTag(t)} />
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* 右侧只读账单（窄屏改为侧滑） */}
        {wide ? (
          <aside className="min-h-0 border-l border-line bg-paper">
            {selectedId ? (
              panel
            ) : (
              <div className="flex h-full flex-col items-center justify-center px-8 text-center" data-testid="cashier-empty">
                <EmptyState art="calm" title="选一张手牌看账单" description="直接敲牌号（如 23）回车，或点左侧的手牌。这里只看不改：加项目、换牌在发卡台。" />
                <div className="mt-2 space-y-1.5 text-[12.5px] text-ink-3">
                  <p className="flex items-center justify-center gap-1.5">
                    <Keyboard className="size-4" /> <Kbd>F8</Kbd> 预结账 · <Kbd>F9</Kbd> 结账
                  </p>
                </div>
              </div>
            )}
          </aside>
        ) : (
          <Sheet open={!!selectedId} onClose={() => select(null)} label="手牌账单" width="w-[min(460px,100vw)]">
            {panel}
          </Sheet>
        )}
      </div>

      {visit.data && dialog?.kind === 'preview' && (
        <PreviewDialog open visit={visit.data} tags={tags} onClose={() => setDialog(null)} onCheckout={can('frontdesk.checkout') ? (ids) => setDialog({ kind: 'checkout', ids }) : undefined} />
      )}
      {visit.data && dialog?.kind === 'checkout' && (
        <CheckoutDialog
          open
          visit={visit.data}
          tags={tags}
          initialIds={dialog.ids}
          onClose={() => setDialog(null)}
          onDone={(d) => {
            setDialog(null);
            refresh(d.bills.flatMap((b) => (b.visitId === null ? [] : [b.visitId])));
            toast({ tone: 'success', title: `已结清 ${d.bills.map((b) => b.tagCode ?? `桌 ${b.tableName}`).join('、')}`, body: `结账单 ${d.checkoutNo}，手牌已释放` });
            select(null);
          }}
        />
      )}
      <CheckoutRecordsDialog open={dialog?.kind === 'records'} focusId={dialog?.kind === 'records' ? (dialog.checkoutId ?? visit.data?.checkout?.id ?? null) : null} onClose={() => setDialog(null)} />
      <ChecksDialog open={checksOpen} onClose={() => setChecksOpen(false)} />
      <FindGuestDialog open={finding} tags={tags} onClose={() => setFinding(false)} onPick={select} />
    </>
  );
}

/** 待结账清单的一行：牌号、客人与档阶、同行、手上的券 / 签赠、在店多久、已挂多少 */
function QueueRow({ tag, now, selected, primary, onClick }: { tag: BoardTag; now: number; selected: boolean; primary: boolean; onClick: () => void }) {
  const v = tag.visit!;
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        data-testid={`queue-${tag.code}`}
        aria-pressed={selected}
        aria-label={`手牌 ${tag.code}，${ZONE_LABELS[tag.zone].title}，${v.memberName ? `会员 ${v.memberName}` : '散客'}，已挂 ${(v.amountCents / 100).toFixed(2)} 元`}
        className={cn(
          'flex min-h-[60px] w-full items-center gap-3 rounded-[14px] border bg-card px-3.5 py-2 text-left shadow-card transition-[box-shadow,border-color] hover:border-line-strong hover:shadow-lift',
          selected ? 'border-pine ring-2 ring-pine ring-offset-2 ring-offset-paper' : primary ? 'border-yuzu ring-2 ring-yuzu' : 'border-line',
        )}
      >
        <span className="flex w-[72px] shrink-0 flex-col items-start gap-1">
          <span className="num text-[20px] leading-none font-bold tracking-tight">{tag.code}</span>
          {tag.kind === 'vip' ? <VipChip level={tag.vipLevel!} /> : <ZoneChip zone={tag.zone} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5 text-[13.5px]">
            {v.memberName ? (
              <>
                <UserRound className="size-3.5 shrink-0 text-pine" />
                <span className="min-w-0 truncate font-bold">{v.memberName}</span>
                {v.memberGradeLabel && (
                  <span className="shrink-0 rounded-sm bg-yuzu-soft px-1 text-[11px] font-bold text-yuzu-deep" title={v.memberGradeLabel}>
                    {gradeShort(v.memberGradeLabel)}
                  </span>
                )}
              </>
            ) : (
              <span className="min-w-0 truncate text-ink-3">{v.guestLabel || '散客'}</span>
            )}
            {v.groupNo && <GroupMark groupNo={v.groupNo} count={v.groupOpenCount} />}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-ink-3">
            <span className="num font-semibold">在店 {stayText(v.checkedInAt, now)}</span>
            {/* 超时在店（8.1.15：超 12 / 24 / 72 小时黄 / 橙 / 红）、临时外出、异常待办：颜色都配文字与图标 */}
            <VisitStatusChips visit={v} now={now} testId={`queue-${tag.code}`} />
            {/* 手上有能用的签赠 / 券：提醒收银别漏了 */}
            {v.gifts > 0 && (
              <span className="flex items-center gap-0.5 rounded-sm bg-yuzu-soft px-1 font-bold text-yuzu-deep" data-testid={`queue-${tag.code}-gift`}>
                <Gift className="size-3" /> 签赠 {v.gifts}
              </span>
            )}
            {v.coupons - v.gifts > 0 && (
              <span className="flex items-center gap-0.5 rounded-sm bg-pine-soft px-1 font-bold text-pine" data-testid={`queue-${tag.code}-coupon`}>
                <Ticket className="size-3" /> 券 {v.coupons - v.gifts}
              </span>
            )}
          </span>
        </span>
        <span className="shrink-0 text-right">
          {v.amountCents > 0 ? <Money cents={v.amountCents} className="text-[16px] font-bold text-ink" /> : <span className="text-[12px] text-ink-4">未挂账</span>}
          <span className="block text-[11.5px] text-ink-3">{v.lineCount > 0 ? `${v.lineCount} 项` : '只有门票'}</span>
        </span>
      </button>
    </li>
  );
}
