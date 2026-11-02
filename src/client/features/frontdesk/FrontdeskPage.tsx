import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { FilePenLine, Hash, Keyboard, Lock, ReceiptText, Search, ShieldCheck, UserPlus, X } from 'lucide-react';
import { matchTags, normalizeTagCode, TAG_ZONES, uniqueTagMatch, ZONE_LABELS, type BoardTag, type CheckinResult, type TagZone, type VisitDetail } from '@shared/frontdesk';
import { useCan, useSession } from '../../lib/session';
import { CrossDayShiftNotice } from '../shift/ShiftGate';
import { cn, isTypingTarget } from '../../lib/utils';
import { PageHeader } from '../../components/AppShell';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { Dialog, Sheet } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Button, Kbd, Notice, Segmented, Skeleton } from '../../components/ui';
import { useMedia } from '../inventory/useMedia';
import { AddItemsDialog } from './AddItemsDialog';
import { BackfillBar, BackfillProvider, useBackfill } from './backfill';
import { BillPanel, type PanelAction } from './BillPanel';
import { CheckinDialog, type CheckinPrefill } from './CheckinDialog';
import { CheckoutDialog, CheckoutRecordsDialog, TicketDialog } from './CheckoutDialog';
import { groupTags, Stat, TagCard, TagChip, VipChip, ZoneChip } from './parts';
import { useBoard, useFrontdeskChecks, useRefreshFrontdesk, useServerNow, useVisit } from './queries';
import { FindGuestDialog, TagLockDialog } from './ToolDialogs';
import { JoinGroupDialog, PreviewDialog, SwapDialog } from './VisitDialogs';
import { MoveLinesDialog } from './MoveLinesDialog';

type StatusFilter = 'all' | 'in' | 'free' | 'locked';

export function FrontdeskPage() {
  return (
    <BackfillProvider>
      <FrontdeskBoard />
    </BackfillProvider>
  );
}

function FrontdeskBoard() {
  const session = useSession();
  const can = useCan();
  const toast = useToast();
  const board = useBoard();
  const refresh = useRefreshFrontdesk();
  const [params, setParams] = useSearchParams();
  const selectedId = Number(params.get('v')) || null;
  const visit = useVisit(selectedId);
  const now = useServerNow(board.data?.serverTime);
  const wide = useMedia('(min-width: 1024px)');

  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  /** 员工用方向键明确选中了某张候选；否则多张候选时回车不打开，避免打开错的牌 */
  const [picked, setPicked] = useState(false);
  const [ambiguous, setAmbiguous] = useState(false);
  const [zone, setZone] = useState<'all' | TagZone>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [dialog, setDialog] = useState<null | { kind: 'checkin'; prefill: CheckinPrefill } | { kind: PanelAction; ids?: number[]; checkoutId?: number }>(null);
  const [checksOpen, setChecksOpen] = useState(false);
  /** 找在店客人、锁牌 / 解锁 */
  const [tool, setTool] = useState<null | { kind: 'find' } | { kind: 'lock'; code?: string }>(null);
  const backfill = useBackfill();
  const searchRef = useRef<HTMLInputElement>(null);

  const tags = board.data?.tags ?? [];
  const matches = useMemo(() => (q ? matchTags(tags, q) : []), [tags, q]);
  const unique = useMemo(() => (q ? uniqueTagMatch(tags, q) : null), [tags, q]);
  const primary = picked ? matches[Math.min(cursor, matches.length - 1)] : (unique ?? undefined);
  const matchedIds = new Set(matches.map((t) => t.id));

  const select = useCallback(
    (id: number | null) => {
      const next = new URLSearchParams(params);
      if (id) next.set('v', String(id));
      else next.delete('v');
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  /** 打开一张手牌：在店 → 看账单；空闲 → 发牌；锁定 → 提示 */
  const openTag = useCallback(
    (t: BoardTag) => {
      setQ('');
      setCursor(0);
      if (t.visit) {
        select(t.visit.id);
      } else if (t.locked) {
        if (can('frontdesk.tags')) setTool({ kind: 'lock', code: t.code });
        else toast({ tone: 'error', title: `手牌 ${t.code} 已锁定`, body: `${t.lockReason}。请换一张，或请值班经理在前台「锁牌 / 解锁」解锁。` });
      } else if (t.zone === 'child') {
        toast({ tone: 'error', title: `手牌 ${t.code} 属于已取消的儿童区`, body: '儿童跟同性别家长用男宾或女宾的牌；请店主在「管理 → 手牌」把这张牌改为男宾或女宾。' });
      } else if (can('frontdesk.operate')) {
        setDialog({ kind: 'checkin', prefill: { tagCode: t.code, zone: t.zone } });
      }
    },
    [select, toast, can],
  );

  // 从顶部「结果待确认」进入：打开对应对话框，由对话框显示原操作并处理
  const resume = params.get('resume');
  useEffect(() => {
    if (!resume || !board.data) return;
    // 退款单（v0.7.20）：打开结账记录里的原结账单，不需要选中手牌
    if (resume !== 'checkin' && resume !== 'checkout_refund' && (!visit.data || visit.data.id !== selectedId)) return;
    if (resume === 'checkin') setDialog({ kind: 'checkin', prefill: {} });
    else if (resume === 'checkout_refund') setDialog({ kind: 'records', checkoutId: Number(params.get('c')) || undefined });
    else if (resume === 'bill_post') setDialog({ kind: 'add' });
    else if (resume === 'tag_swap') setDialog({ kind: 'swap' });
    else if (resume === 'checkout') setDialog({ kind: 'checkout' });
    else if (resume === 'line_move') setDialog({ kind: 'move' });
    const next = new URLSearchParams(params);
    next.delete('resume');
    next.delete('c');
    setParams(next, { replace: true });
  }, [resume, board.data, visit.data, selectedId, params, setParams]);

  const companions = useMemo(() => {
    const g = visit.data?.group;
    return new Set(g ? g.mates.filter((m) => m.status === 'open').map((m) => m.visitId) : []);
  }, [visit.data]);

  // 盲打牌号：在页面任意位置直接敲数字或字母，自动进入牌号框；F2 发牌、F4 加项目、F8 预结账
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // 平板竖屏时账单是侧滑抽屉（也是 dialog），不挡快捷键；其他弹窗打开时不响应
      if (document.querySelector('[role="dialog"]:not([aria-label="手牌账单"])')) return;
      const sheetOpen = !!document.querySelector('[role="dialog"][aria-label="手牌账单"]');
      if (e.key === 'F2' && can('frontdesk.operate')) {
        e.preventDefault();
        setDialog({ kind: 'checkin', prefill: {} });
        return;
      }
      if (e.key === 'F4' && visit.data?.status === 'open' && can('frontdesk.operate')) {
        e.preventDefault();
        setDialog({ kind: 'add' });
        return;
      }
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

  /** 状态板上的分区：男宾、女宾；库里还有旧儿童区手牌时另列 */
  const zonesInPool = TAG_ZONES.filter((z) => z !== 'child' || tags.some((t) => t.zone === 'child'));
  const visible = tags.filter(
    (t) =>
      (zone === 'all' || t.zone === zone) &&
      (status === 'all' || (status === 'in' ? !!t.visit : status === 'free' ? !t.visit && !t.locked : t.locked)),
  );

  const afterCheckin = (r: CheckinResult) => {
    setDialog(null);
    refresh();
    toast({
      tone: 'success',
      title: `${r.replayed ? '已发过牌' : '已发牌'} ${r.visits.map((v) => v.tagCode).join('、')}`,
      body: r.groupNo ? `同行组 ${r.groupNo}` : undefined,
    });
    if (r.visits[0]) select(r.visits[0].id);
  };
  const afterChange = (v: VisitDetail, message?: string) => {
    setDialog(null);
    refresh([v.id, ...(v.group?.mates.map((m) => m.visitId) ?? [])]);
    if (message) toast({ tone: 'success', title: message });
    if (v.id !== selectedId) select(v.id);
  };

  const stats = board.data?.stats;
  const panel = (
    <BillPanel
      visit={visit.data}
      loading={visit.isPending}
      error={visit.error}
      rules={board.data?.rules}
      onAction={(a) => {
        if (a === 'companion' && visit.data) {
          setDialog({ kind: 'checkin', prefill: { zone: visit.data.zone === 'child' ? undefined : visit.data.zone, join: { visitId: visit.data.id, tagCode: visit.data.tag.code, groupNo: visit.data.group?.groupNo ?? null } } });
        } else setDialog({ kind: a });
      }}
      onSelectVisit={select}
      onChanged={(v) => afterChange(v)}
      onClose={wide ? undefined : () => select(null)}
    />
  );

  return (
    <>
      <PageHeader
        title="前台 · 在店手牌"
        subtitle={
          stats ? (
            <span className="flex flex-wrap gap-x-4">
              <Stat label="在店" tone="pine">
                {stats.inStore}
              </Stat>
              <span className="text-ink-3">
                男 {stats.inStoreByZone.male} · 女 {stats.inStoreByZone.female}
                {stats.inStoreByZone.child > 0 && ` · 童（旧）${stats.inStoreByZone.child}`}
              </span>
              <Stat label="空闲">{stats.free}</Stat>
              {stats.locked > 0 && <Stat label="锁定">{stats.locked}</Stat>}
              <Stat label="同行">{stats.groups} 组</Stat>
            </span>
          ) : (
            session.storeName
          )
        }
        actions={
          can('frontdesk.read') ? (
            <>
              <Button size="sm" variant="ghost" icon={<Search className="size-4" />} onClick={() => setTool({ kind: 'find' })} data-testid="open-find-guest">
                找客人
              </Button>
              {can('frontdesk.tags') && (
                <Button size="sm" variant="ghost" icon={<Lock className="size-4" />} onClick={() => setTool({ kind: 'lock' })} data-testid="open-tag-lock">
                  锁牌 / 解锁
                </Button>
              )}
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
              <Button size="sm" variant="ghost" icon={<ShieldCheck className="size-4" />} onClick={() => setChecksOpen(true)}>
                自检
              </Button>
            </>
          ) : null
        }
      />
      <div className={cn('grid min-h-0 flex-1', wide ? 'grid-cols-[minmax(0,1fr)_360px] xl:grid-cols-[minmax(0,1fr)_420px]' : 'grid-cols-1')}>
        <div className="flex min-h-0 flex-col">
          {/* 牌号快检 */}
          <div className="shrink-0 space-y-3 border-b border-line px-5 pt-4 pb-3 md:px-6">
            <CrossDayShiftNotice />
            <div className="flex flex-wrap items-stretch gap-3">
              <div className="relative min-w-[240px] flex-1">
                <Hash className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-ink-3" />
                <input
                  ref={searchRef}
                  value={q}
                  onChange={(e) => {
                    setQ(normalizeTagCode(e.target.value));
                    setCursor(0);
                    setPicked(false);
                    setAmbiguous(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      if (primary) {
                        openTag(primary);
                        searchRef.current?.blur();
                      } else if (matches.length > 1) {
                        setAmbiguous(true);
                      }
                    } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
                      e.preventDefault();
                      setCursor((c) => (picked ? Math.min(c + 1, Math.max(0, matches.length - 1)) : Math.max(0, matches.indexOf(unique ?? matches[0]!))));
                      setPicked(true);
                    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
                      e.preventDefault();
                      setCursor((c) => (picked ? Math.max(0, c - 1) : Math.max(0, matches.indexOf(unique ?? matches[0]!))));
                      setPicked(true);
                    } else if (e.key === 'Escape') {
                      setQ('');
                      searchRef.current?.blur();
                    }
                  }}
                  placeholder="直接敲牌号（末位即可），回车打开"
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
              {can('frontdesk.operate') && (
                <Button variant="primary" size="lg" className="h-[52px] rounded-[14px] px-6" icon={<UserPlus className="size-5" />} kbd="F2" onClick={() => setDialog({ kind: 'checkin', prefill: {} })} data-testid="open-checkin">
                  接待发牌
                </Button>
              )}
            </div>
            <BackfillBar />
            {q ? (
              <div className="flex min-h-8 flex-wrap items-center gap-1.5 text-[13px]" aria-live="polite">
                {matches.length === 0 ? (
                  <span className="font-semibold text-clay">没有匹配「{q}」的手牌</span>
                ) : (
                  <>
                    <span className={cn(ambiguous && !primary ? 'font-semibold text-yuzu-deep' : 'text-ink-3')} data-testid="search-hint">
                      {primary || matches.length === 1 ? `匹配 ${matches.length} 张：` : `对上 ${matches.length} 张，请用方向键选中后回车，或直接点选：`}
                    </span>
                    {matches.slice(0, 8).map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => openTag(t)}
                        className={cn(
                          'flex h-8 items-center gap-1.5 rounded-full border px-3 font-bold',
                          t === primary ? 'border-pine bg-pine text-paper' : 'border-line bg-card text-ink-2 hover:border-line-strong',
                        )}
                      >
                        <span className="num">{t.code}</span>
                        <span className="text-[11.5px] font-semibold opacity-75">
                          {ZONE_LABELS[t.zone].short}
                          {t.kind === 'vip' ? ` · VIP${t.vipLevel}` : ''} · {t.visit ? '在店' : t.locked ? '锁定' : '空闲'}
                        </span>
                        {t === primary && <Kbd className="ml-0.5 border-white/30 bg-white/15 text-paper">↵</Kbd>}
                      </button>
                    ))}
                  </>
                )}
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2.5">
                <Segmented
                  size="sm"
                  value={zone}
                  onChange={setZone}
                  ariaLabel="分区"
                  options={[
                    { value: 'all', label: '全部分区' },
                    ...zonesInPool.map((z) => ({ value: z, label: `${ZONE_LABELS[z].title} ${stats ? stats.inStoreByZone[z] : ''}` })),
                  ]}
                />
                <Segmented
                  size="sm"
                  value={status}
                  onChange={setStatus}
                  ariaLabel="状态"
                  options={[
                    { value: 'all', label: '全部' },
                    { value: 'in', label: '在店' },
                    { value: 'free', label: '空闲' },
                    { value: 'locked', label: '锁定' },
                  ]}
                />
                <span className="ml-auto flex items-center gap-1.5 text-[12.5px] text-ink-3">
                  未结合计 <Money cents={stats?.unsettledCents ?? 0} className="text-[15px] font-bold text-ink" />
                </span>
              </div>
            )}
          </div>

          {/* 手牌状态矩阵 */}
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-8 md:px-6" data-testid="tag-board">
            {board.isPending ? (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(118px,1fr))] gap-2.5">
                {Array.from({ length: 24 }, (_, i) => (
                  <Skeleton key={i} className="h-[92px] rounded-[14px]" />
                ))}
              </div>
            ) : board.error ? (
              <Notice tone="error" title={board.error.message} />
            ) : tags.length === 0 ? (
              <EmptyState
                art="pool"
                title="手牌池还是空的"
                description={can('frontdesk.tags') ? '先在「管理 → 手牌」导入柜号清单，或按号段建牌。' : '请店主先在「管理 → 手牌」导入柜号清单。'}
              />
            ) : (
              zonesInPool
                .filter((z) => zone === 'all' || z === zone)
                .map((z) => {
                  const zoneTags = tags.filter((t) => t.zone === z);
                  const list = visible.filter((t) => t.zone === z);
                  if (list.length === 0) return null;
                  const totals = new Map(groupTags(zoneTags).map((g) => [g.key, g.tags]));
                  return (
                    <section key={z} className="mb-6" aria-label={`${ZONE_LABELS[z].title}区`}>
                      <h3 className="sticky top-0 z-10 -mx-1 mb-2 flex items-center gap-2 bg-paper/95 px-1 py-1.5 backdrop-blur">
                        <ZoneChip zone={z} size="md" />
                        <span className="num text-[13px] font-semibold text-ink-3">
                          在店 <b className="text-ink">{zoneTags.filter((t) => t.visit).length}</b> / {zoneTags.length}
                        </span>
                      </h3>
                      {groupTags(list).map((g) => {
                        const all = totals.get(g.key) ?? g.tags;
                        const cards = g.tags.filter((t) => t.visit);
                        const chips = g.tags.filter((t) => !t.visit);
                        return (
                          <div key={g.key} className="mb-4" data-testid={`tag-group-${z}-${g.key}`}>
                            <p className="mb-1.5 flex items-center gap-2 text-[12.5px] font-semibold text-ink-3">
                              {g.kind === 'vip' ? <VipChip level={g.vipLevel!} size="md" /> : <span className="text-[13px] font-bold text-ink-2">{g.area ? `${g.area} 区` : '普通柜'}</span>}
                              <span className="num">
                                在店 {all.filter((t) => t.visit).length} · 空闲 {all.filter((t) => !t.visit && !t.locked).length} / {all.length}
                              </span>
                            </p>
                            {cards.length > 0 && (
                              <div className="mb-2 grid grid-cols-[repeat(auto-fill,minmax(118px,1fr))] gap-2.5">
                                {cards.map((t) => (
                                  <TagCard
                                    key={t.id}
                                    tag={t}
                                    now={now}
                                    selected={t.visit!.id === selectedId}
                                    matched={matchedIds.has(t.id)}
                                    primaryMatch={t === primary}
                                    companion={companions.has(t.visit!.id)}
                                    onClick={() => openTag(t)}
                                  />
                                ))}
                              </div>
                            )}
                            {chips.length > 0 && (
                              <div className="flex flex-wrap gap-1.5">
                                {chips.map((t) => (
                                  <TagChip key={t.id} tag={t} matched={matchedIds.has(t.id)} primaryMatch={t === primary} onClick={() => openTag(t)} />
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </section>
                  );
                })
            )}
          </div>
        </div>

        {/* 右侧小票抽屉（平板竖屏改为侧滑） */}
        {wide ? (
          <aside className="min-h-0 border-l border-line bg-paper">
            {selectedId ? (
              panel
            ) : (
              <div className="flex h-full flex-col items-center justify-center px-8 text-center">
                <EmptyState art="calm" title="选一张手牌看账单" description="直接敲牌号（如 23）回车，或点左侧手牌。空闲手牌点一下即可发牌。" />
                <div className="mt-2 space-y-1.5 text-[12.5px] text-ink-3">
                  <p className="flex items-center justify-center gap-1.5">
                    <Keyboard className="size-4" /> <Kbd>F2</Kbd> 接待发牌 · <Kbd>F4</Kbd> 加项目 · <Kbd>F8</Kbd> 预结账 · <Kbd>F9</Kbd> 结账
                  </p>
                </div>
              </div>
            )}
          </aside>
        ) : (
          <Sheet open={!!selectedId} onClose={() => select(null)} label="手牌账单" width="w-[min(440px,100vw)]">
            {panel}
          </Sheet>
        )}
      </div>

      {dialog?.kind === 'checkin' && (
        <CheckinDialog open tags={tags} rules={board.data?.rules} prefill={dialog.prefill} onClose={() => setDialog(null)} onDone={afterCheckin} />
      )}
      {visit.data && dialog?.kind === 'add' && (
        <AddItemsDialog open visit={visit.data} onClose={() => setDialog(null)} onDone={(v) => afterChange(v, `已挂到 ${v.tag.code}`)} />
      )}
      {visit.data && dialog?.kind === 'swap' && (
        <SwapDialog open visit={visit.data} tags={tags} rules={board.data?.rules} onClose={() => setDialog(null)} onDone={(v) => afterChange(v, `已换牌，现为 ${v.tag.code}`)} />
      )}
      {visit.data && dialog?.kind === 'move' && (
        <MoveLinesDialog
          open
          visit={visit.data}
          tags={tags}
          rules={board.data?.rules}
          onClose={() => setDialog(null)}
          onDone={(v, toVisitId) => {
            if (toVisitId) refresh([toVisitId]);
            afterChange(v, '明细已转到别的手牌');
          }}
        />
      )}
      {visit.data && dialog?.kind === 'join' && (
        <JoinGroupDialog open visit={visit.data} tags={tags} onClose={() => setDialog(null)} onDone={(v) => afterChange(v, `${v.tag.code} 已加入同行组 ${v.group?.groupNo ?? ''}`)} />
      )}
      {visit.data && dialog?.kind === 'preview' && (
        <PreviewDialog
          open
          visit={visit.data}
          tags={tags}
          onClose={() => setDialog(null)}
          onCheckout={can('frontdesk.checkout') ? (ids) => setDialog({ kind: 'checkout', ids }) : undefined}
        />
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
      {visit.data && dialog?.kind === 'ticket' && (
        <TicketDialog open visit={visit.data} onClose={() => setDialog(null)} onDone={(v) => afterChange(v, `${v.tag.code} 票种改为 ${v.ticket?.name ?? ''}`)} />
      )}
      <CheckoutRecordsDialog
        open={dialog?.kind === 'records'}
        focusId={dialog?.kind === 'records' ? ((dialog as { checkoutId?: number }).checkoutId ?? visit.data?.checkout?.id ?? null) : null}
        onClose={() => setDialog(null)}
      />
      <ChecksDialog open={checksOpen} onClose={() => setChecksOpen(false)} />
      <FindGuestDialog open={tool?.kind === 'find'} tags={tags} onClose={() => setTool(null)} onPick={select} />
      <TagLockDialog
        open={tool?.kind === 'lock'}
        tags={tags}
        initialCode={tool?.kind === 'lock' ? tool.code : undefined}
        onClose={() => setTool(null)}
        onDone={(message) => {
          setTool(null);
          refresh();
          toast({ tone: 'success', title: message });
        }}
      />
    </>
  );
}

function ChecksDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const checks = useFrontdeskChecks(open);
  return (
    <Dialog open={open} onClose={onClose} title="前台账务自检" description="手牌、来访、账单与明细之间的一致性；会员钱包与日结另有自检">
      {checks.isPending ? (
        <Skeleton className="h-32" />
      ) : checks.error ? (
        <Notice tone="error" title={checks.error.message} />
      ) : (
        <ul className="space-y-2.5">
          {checks.data.map((c) => (
            <li key={c.key} className={cn('rounded-lg border px-4 py-3', c.ok ? 'border-pine/20 bg-pine-tint' : 'border-clay/30 bg-clay-soft/50')}>
              <p className={cn('text-[14px] font-bold', c.ok ? 'text-pine' : 'text-clay')}>
                {c.ok ? '✓ 通过' : '✗ 异常'} · {c.label}
              </p>
              <p className="mt-0.5 text-[12.5px] text-ink-2">{c.detail}</p>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
