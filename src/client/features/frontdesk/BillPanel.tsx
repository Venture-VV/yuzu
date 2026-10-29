import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeftRight,
  ChevronDown,
  CircleSlash,
  Clock3,
  Ellipsis,
  Link2,
  LogOut,
  Plus,
  ReceiptText,
  Undo2,
  UserPlus,
  UserRound,
  X,
  ShieldCheck,
  Banknote,
  Ticket,
} from 'lucide-react';
import {
  BILL_SOURCE_LABELS,
  BILL_SOURCES,
  CANCEL_REASONS,
  VISIT_STATUS_LABELS,
  VOID_REASONS,
  ZONE_LABELS,
  type BillLine,
  type FrontdeskRules,
  type VisitDetail,
} from '@shared/frontdesk';
import { maskPhone } from '@shared/labels';
import { api, errorMessage } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn, formatTime } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, IconButton, Notice, PendingBadge, Skeleton, Textarea } from '../../components/ui';
import { GroupMark, LONG_STAY_MINUTES, VipChip, ZoneChip, ZONE_STYLE } from './parts';
import { FRONTDESK_OP_LABELS, useFrontdeskPending } from './pending';
import { stayMinutes, stayText, useServerNow } from './queries';

export type PanelAction = 'add' | 'swap' | 'join' | 'companion' | 'preview' | 'checkout' | 'ticket' | 'records';

/** 右侧「小票」：当前手牌的共同账单，按消费来源分组；挂账、换牌、同行、预结账都从这里发起 */
export function BillPanel({
  visit,
  loading,
  error,
  rules,
  onAction,
  onSelectVisit,
  onChanged,
  onClose,
}: {
  visit: VisitDetail | undefined;
  loading: boolean;
  error: unknown;
  rules: FrontdeskRules | undefined;
  onAction: (a: PanelAction) => void;
  onSelectVisit: (id: number) => void;
  onChanged: (v: VisitDetail) => void;
  onClose?: () => void;
}) {
  const now = useServerNow(visit?.serverTime);
  const [voiding, setVoiding] = useState<BillLine | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [showVoided, setShowVoided] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const can = useCan();
  const session = useSession();
  const toast = useToast();
  const pendingOps = useFrontdeskPending();

  if (loading && !visit) {
    return (
      <div className="space-y-3 p-5">
        <Skeleton className="h-16" />
        <Skeleton className="h-10" />
        <Skeleton className="h-48" />
      </div>
    );
  }
  if (error && !visit) return <Notice tone="error" title={errorMessage(error)} className="m-5" />;
  if (!visit) return null;
  const pendingHere = pendingOps.filter((p) => p.visitId === visit.id);

  const open = visit.status === 'open';
  const active = visit.lines.filter((l) => l.status === 'active');
  const voided = visit.lines.filter((l) => l.status === 'voided');
  const long = open && stayMinutes(visit.checkedInAt, now) >= LONG_STAY_MINUTES;
  const selfMinutes = rules?.selfVoidMinutes ?? 10;
  const canFix = (ownerId: number, at: string) =>
    can('frontdesk.correct') || (ownerId === session.staff.id && (now - new Date(at).getTime()) / 60_000 <= selfMinutes);

  const leaveGroup = async () => {
    try {
      onChanged(await api.post<VisitDetail>(`/api/frontdesk/visits/${visit.id}/group`, { action: 'leave' }));
      toast({ tone: 'success', title: `${visit.tag.code} 已退出同行组` });
    } catch (e) {
      toast({ tone: 'error', title: '退出同行未成功', body: errorMessage(e) });
    }
  };

  return (
    <section aria-label={`手牌 ${visit.tag.code} 账单`} data-testid="bill-panel" className="flex h-full min-h-0 flex-col">
      {/* 抬头 */}
      <header className="shrink-0 border-b border-line px-5 pt-4 pb-3.5">
        <div className="flex items-start gap-3">
          <div className={cn('flex size-[58px] shrink-0 flex-col items-center justify-center rounded-[16px]', ZONE_STYLE[visit.zone].soft)}>
            <span className={cn('text-[11px] font-bold', ZONE_STYLE[visit.zone].text)}>{ZONE_LABELS[visit.zone].title}</span>
            <span className="num text-[11px] font-semibold text-ink-3">手牌</span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="num text-[30px] leading-none font-bold tracking-tight" data-testid="bill-tag">
                {visit.tag.code}
              </h2>
              {visit.tag.kind === 'vip' && <VipChip level={visit.tag.vipLevel!} size="md" />}
              {visit.group && <GroupMark groupNo={visit.group.groupNo} count={visit.group.mates.filter((m) => m.status === 'open').length} />}
              {!open && <Badge tone={visit.status === 'cancelled' ? 'clay' : 'neutral'}>{VISIT_STATUS_LABELS[visit.status]}</Badge>}
            </div>
            <p className="num mt-1.5 flex flex-wrap items-center gap-x-2 text-[12.5px] text-ink-3">
              <span>{visit.visitNo}</span>
              <span className="flex items-center gap-1">
                <Clock3 className="size-3.5" />入场 {formatTime(visit.checkedInAt)}
              </span>
              {open && (
                <span className={cn('font-semibold', long ? 'rounded-sm bg-yuzu-soft px-1 text-yuzu-deep' : 'text-ink-2')} data-testid="bill-stay">
                  在店 {stayText(visit.checkedInAt, now)}
                  {long && ' · 超 6 小时'}
                </span>
              )}
            </p>
          </div>
          {onClose && (
            <IconButton label="关闭账单" onClick={onClose} className="-mt-1 -mr-2">
              <X className="size-[18px]" />
            </IconButton>
          )}
        </div>
        {/* 客人 */}
        <div className="mt-3 flex items-center gap-2.5 rounded-lg bg-paper-2/70 px-3 py-2">
          <UserRound className={cn('size-4 shrink-0', visit.member ? 'text-pine' : 'text-ink-3')} />
          {visit.member ? (
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13.5px] font-bold">
                会员 {visit.member.name}
                {visit.memberLevel && <span className="ml-1 text-[12px] font-semibold text-yuzu-deep">第 {visit.memberLevel.level} 级</span>}{' '}
                <span className="num text-[12px] font-semibold text-ink-3">{visit.member.memberNo} · {maskPhone(visit.member.phone)}</span>
              </p>
              <p className="num text-[12px] text-ink-3">
                本金 <Money cents={visit.member.principalBalance} /> · 赠金 <Money cents={visit.member.bonusBalance} />
                <span className="ml-1 text-ink-4">结账时可用储值支付</span>
              </p>
            </div>
          ) : (
            <p className="min-w-0 flex-1 truncate text-[13.5px] text-ink-2">
              散客{visit.guestLabel ? ` · ${visit.guestLabel}` : ''}
            </p>
          )}
        </div>
        {visit.vipOverrideByName && (
          <p className="mt-1.5 flex items-center gap-1 px-1 text-[12px] font-semibold text-yuzu-deep" data-testid="bill-vip-override">
            <ShieldCheck className="size-3.5" /> VIP 柜由{visit.vipOverrideByName}当场授权
          </p>
        )}
        {/* 同行 */}
        {visit.group && (
          <div className="mt-2.5" data-testid="bill-group">
            <div className="flex items-center justify-between gap-2 text-[12px]">
              <span className="flex items-center gap-1 font-bold text-pine">
                <Link2 className="size-3.5" /> 同行 {visit.group.groupNo}
              </span>
              <span className="text-ink-3">
                同行未结 <Money cents={visit.group.openAmountCents} className="font-bold text-ink" />
              </span>
            </div>
            <div className="scroll-thin mt-1.5 flex gap-1.5 overflow-x-auto pb-0.5">
              {visit.group.mates.map((m) => (
                <button
                  key={m.visitId}
                  type="button"
                  onClick={() => onSelectVisit(m.visitId)}
                  disabled={m.visitId === visit.id}
                  className={cn(
                    'flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12.5px] font-bold',
                    m.visitId === visit.id ? 'border-pine bg-pine-tint text-pine' : 'border-line bg-card text-ink-2 hover:border-line-strong',
                    m.status !== 'open' && 'opacity-50',
                  )}
                  title={m.status !== 'open' ? VISIT_STATUS_LABELS[m.status] : undefined}
                >
                  <span className="num">{m.tagCode}</span>
                  <span className="text-[11px] opacity-70">{ZONE_LABELS[m.zone].short}</span>
                  {m.status === 'open' ? <Money cents={m.amountCents} className="font-semibold text-ink-3" /> : <span className="text-[11px]">{VISIT_STATUS_LABELS[m.status]}</span>}
                </button>
              ))}
            </div>
          </div>
        )}
      </header>

      {/* 小票正文 */}
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto bg-paper-2/40 px-4 py-4">
        {pendingHere.map((p) => (
          <Notice
            key={p.key}
            tone="warning"
            title={`${FRONTDESK_OP_LABELS[p.type]}结果待确认`}
            className="mb-3"
            action={
              <Button
                size="sm"
                variant="primary"
                onClick={() => onAction(p.type === 'bill_post' ? 'add' : p.type === 'checkout' ? 'checkout' : 'swap')}
                data-testid="bill-pending-resolve"
              >
                去处理
              </Button>
            }
          >
            {p.summary}。确认前请勿重复登记，以免多记一笔。
          </Notice>
        ))}
        <div className="relative rounded-[14px] border border-line bg-card px-4 pt-3 pb-4 shadow-card" data-testid="receipt">
          <div className="flex items-center justify-between border-b border-dashed border-line-strong pb-2 text-[12px] text-ink-3">
            <span className="flex items-center gap-1 font-semibold">
              <ReceiptText className="size-3.5" /> 账单 {visit.bill.billNo}
            </span>
            <span>{active.length} 项有效</span>
          </div>
          {active.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-[14px] font-bold text-ink-2">还没有挂账</p>
              <p className="mt-1 text-[12.5px] text-ink-3">门票结账时按在店时长计算；项目、饮品等可随时挂到这张手牌</p>
              {open && can('frontdesk.operate') && (
                <Button className="mt-3" variant="secondary" icon={<Plus className="size-4" />} onClick={() => onAction('add')}>
                  加项目
                </Button>
              )}
            </div>
          ) : (
            BILL_SOURCES.filter((src) => active.some((l) => l.source === src)).map((src) => {
              const rows = active.filter((l) => l.source === src);
              return (
                <div key={src} className="pt-3">
                  <div className="flex items-center justify-between text-[12px] font-bold text-ink-3">
                    <span>{BILL_SOURCE_LABELS[src]}</span>
                    <Money cents={rows.reduce((s, l) => s + l.amount, 0)} />
                  </div>
                  <ul className="mt-1.5 space-y-1.5">
                    {rows.map((l) => (
                      <LineRow key={l.id} line={l} canVoid={open && can('frontdesk.operate')} allowed={canFix(l.postedById, l.postedAt)} selfMinutes={selfMinutes} onVoid={() => setVoiding(l)} />
                    ))}
                  </ul>
                </div>
              );
            })
          )}
          {voided.length > 0 && (
            <div className="mt-3 border-t border-dashed border-line pt-2">
              <button type="button" onClick={() => setShowVoided((v) => !v)} className="flex items-center gap-1 text-[12px] font-semibold text-ink-3 hover:text-ink">
                <ChevronDown className={cn('size-3.5 transition-transform', showVoided && 'rotate-180')} />
                已作废 {voided.length} 项（留痕，不计入未结）
              </button>
              {showVoided && (
                <ul className="mt-1.5 space-y-1.5">
                  {voided.map((l) => (
                    <li key={l.id} className="text-[12.5px] text-ink-3">
                      <div className="flex items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate line-through">
                          {l.name} × {l.quantity}
                        </span>
                        <Money cents={l.amount} className="line-through" />
                      </div>
                      <p className="text-[11.5px]">
                        {l.voidReason} · {l.voidedByName} {l.voidedAt && formatTime(l.voidedAt)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div className="mt-3 border-t border-dashed border-line-strong pt-2.5" data-testid="bill-ticket">
            {visit.ticket ? (
              <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13px]">
                <Ticket className="size-3.5 self-center text-pine" />
                <span className="font-semibold">
                  门票 · {visit.ticket.name}（{visit.ticket.tierLabel}）
                </span>
                <Money cents={visit.ticket.amount} className="font-bold" />
                {open &&
                  (visit.ticket.endAt ? (
                    // 反结账后重结：门票按第一次结账的时刻计算，不再跳档
                    <span className="text-[12px] text-ink-3">按第一次结账 {formatTime(visit.ticket.endAt)} 计算</span>
                  ) : (
                    <span className="text-[12px] text-ink-3">
                      {formatTime(visit.ticket.nextJumpAt)} 后 <Money cents={visit.ticket.nextAmount} />
                    </span>
                  ))}
                <span className="flex-1" />
                {open && can('frontdesk.operate') && (
                  <button type="button" onClick={() => onAction('ticket')} className="text-[12.5px] font-semibold text-pine hover:underline" data-testid="bill-ticket-change">
                    改票种
                  </button>
                )}
              </p>
            ) : open ? (
              <p className="flex flex-wrap items-center gap-2 text-[13px] text-clay">
                <Ticket className="size-3.5" /> 还没有选票种（结账前需要选择）
                {can('frontdesk.operate') && (
                  <button type="button" onClick={() => onAction('ticket')} className="font-semibold text-pine hover:underline" data-testid="bill-ticket-change">
                    选择票种
                  </button>
                )}
              </p>
            ) : null}
            <p className="mt-1 flex items-center gap-1.5 text-[11.5px] text-ink-3">
              <PendingBadge title="门票按每 12 小时跳一档计算（店主 #31）；跳档宽限默认 0 分钟、1 米以下儿童免票为默认做法，待确认" />
              门票离店结账时按在店时长计算（每 12 小时跳一档），不预先挂账
            </p>
          </div>
        </div>

        <button type="button" onClick={() => setShowHistory((v) => !v)} className="mt-3 flex items-center gap-1 px-1 text-[12px] font-semibold text-ink-3 hover:text-ink">
          <ChevronDown className={cn('size-3.5 transition-transform', showHistory && 'rotate-180')} />
          经办记录（{visit.history.length}）
        </button>
        {showHistory && (
          <ol className="mt-1.5 space-y-1 border-l-2 border-line pl-3" data-testid="bill-history">
            {visit.history.map((h, i) => (
              <li key={i} className="text-[12px] text-ink-2">
                <span className="num text-ink-3">{formatTime(h.at)}</span> {h.text} <span className="text-ink-3">· {h.operatorName}</span>
              </li>
            ))}
          </ol>
        )}
      </div>

      {/* 合计与操作：按小票栏实际宽度（容器查询）排版，金额与按钮都完整显示。
          较窄时（平板横屏右栏 360px）预结账、结账排到合计下方各占一半；够宽时与合计并排，
          金额位数多、一行放不下时按钮换到下一行靠右（合计上下的说明文字不撑宽这一行，随金额宽度折行） */}
      <footer className="@container shrink-0 border-t border-line bg-card px-5 pt-3 pb-4 shadow-[0_-8px_24px_-18px_rgb(28_35_31/0.3)]">
        <div className="flex flex-col gap-2.5 @min-[22rem]:flex-row @min-[22rem]:flex-wrap @min-[22rem]:items-end @min-[22rem]:gap-x-2">
          <div className="@min-[22rem]:grow">
            <p className="w-0 min-w-full text-[12px] font-semibold text-ink-3">{open ? '本牌未结（已挂明细）' : '账单金额'}</p>
            <span data-testid="bill-total">
              <Money cents={visit.bill.amountCents} className="text-[30px] leading-tight font-bold text-ink" />
            </span>
            {open && visit.ticket && (
              <p className="w-0 min-w-full text-[12px] text-ink-3" data-testid="bill-due">
                含门票此刻应收 <Money cents={visit.bill.amountCents + visit.ticket.amount} className="font-bold text-pine" />
              </p>
            )}
          </div>
          {open ? (
            <div className="flex gap-2 @min-[22rem]:ml-auto">
              <Button variant="secondary" className="flex-1 @min-[22rem]:flex-none" icon={<ReceiptText className="size-4" />} onClick={() => onAction('preview')} kbd="F8">
                预结账
              </Button>
              {can('frontdesk.checkout') && (
                <Button
                  variant="accent"
                  className="flex-1 @min-[22rem]:flex-none"
                  icon={<Banknote className="size-4" />}
                  onClick={() => onAction('checkout')}
                  kbd="F9"
                  data-testid="action-checkout"
                >
                  结账
                </Button>
              )}
            </div>
          ) : (
            visit.checkout && (
              <Button variant="secondary" className="@min-[22rem]:ml-auto" icon={<ReceiptText className="size-4" />} onClick={() => onAction('records')} data-testid="bill-checkout">
                结账单 {visit.checkout.checkoutNo.slice(-4)}
              </Button>
            )
          )}
        </div>
        {open && can('frontdesk.operate') && (
          <div className="mt-3 flex gap-2">
            <Button variant="primary" size="lg" className="flex-1" icon={<Plus className="size-[18px]" />} onClick={() => onAction('add')} kbd="F4" data-testid="action-add">
              加项目
            </Button>
            <Button variant="secondary" size="lg" icon={<ArrowLeftRight className="size-4" />} onClick={() => onAction('swap')} data-testid="action-swap">
              换牌
            </Button>
            <MoreMenu
              items={[
                { icon: <UserPlus className="size-4" />, label: '再发一张同行手牌', onClick: () => onAction('companion') },
                { icon: <Link2 className="size-4" />, label: visit.group ? '改为与其他客人同行' : '与在店客人同行', onClick: () => onAction('join') },
                ...(visit.group ? [{ icon: <LogOut className="size-4" />, label: '退出同行组', onClick: leaveGroup }] : []),
                { icon: <Undo2 className="size-4" />, label: '撤销误开的牌', onClick: () => setCancelling(true), danger: true },
              ]}
            />
          </div>
        )}
      </footer>

      <QuickReasonDialog
        open={!!voiding}
        title={voiding ? `作废「${voiding.name} × ${voiding.quantity}」` : ''}
        description="作废后不计入未结金额，明细保留并标注作废原因与经办人"
        reasons={VOID_REASONS}
        confirmLabel="确认作废"
        onClose={() => setVoiding(null)}
        onConfirm={async (reason) => {
          const v = await api.post<VisitDetail>(`/api/frontdesk/lines/${voiding!.id}/void`, { reason });
          onChanged(v);
          setVoiding(null);
          toast({ tone: 'success', title: '已作废', body: `${voiding!.name} × ${voiding!.quantity}` });
        }}
      >
        {voiding && (
          <div className="mb-3 flex items-center justify-between rounded-lg bg-paper-2 px-3 py-2 text-[13.5px]">
            <span className="font-semibold">
              {voiding.name} × {voiding.quantity}
            </span>
            <Money cents={voiding.amount} className="font-bold" />
          </div>
        )}
      </QuickReasonDialog>

      <QuickReasonDialog
        open={cancelling}
        title={`撤销来访 · ${visit.tag.code}`}
        description={
          active.length
            ? `账单上还有 ${active.length} 项未结消费，不能直接释放手牌。请先结账，或作废登记错的明细。`
            : '只用于开错牌、客人未入场等情况：撤销后手牌立即空闲，来访记录保留。'
        }
        reasons={CANCEL_REASONS}
        confirmLabel="撤销并释放手牌"
        disabled={active.length > 0}
        onClose={() => setCancelling(false)}
        onConfirm={async (reason) => {
          const v = await api.post<VisitDetail>(`/api/frontdesk/visits/${visit.id}/cancel`, { reason });
          onChanged(v);
          setCancelling(false);
          toast({ tone: 'success', title: `${visit.tag.code} 已撤销并释放` });
        }}
      />
    </section>
  );
}

function LineRow({ line, canVoid, allowed, selfMinutes, onVoid }: { line: BillLine; canVoid: boolean; allowed: boolean; selfMinutes: number; onVoid: () => void }) {
  return (
    <li className="group/line flex items-start gap-2" data-testid={`line-${line.id}`}>
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-1.5 text-[14px]">
          <span className="truncate font-semibold">{line.name}</span>
          <span className="num shrink-0 text-[12.5px] text-ink-3">
            × {line.quantity}
            {line.quantity > 1 && (
              <>
                {' '}· 单价 <Money cents={line.unitPrice} />
              </>
            )}
          </span>
        </p>
        <p className="num text-[11.5px] text-ink-4">
          {formatTime(line.postedAt)} · {line.postedByName}
        </p>
      </div>
      <Money cents={line.amount} className="pt-px text-[14px] font-bold" />
      {canVoid && (
        <button
          type="button"
          onClick={onVoid}
          disabled={!allowed}
          aria-label={`作废 ${line.name}`}
          title={allowed ? '作废这项明细' : `超过 ${selfMinutes} 分钟或不是你登记的，请店主处理`}
          className="-mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-ink-4 transition-colors hover:bg-clay-soft hover:text-clay disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink-4"
        >
          <CircleSlash className="size-4" />
        </button>
      )}
    </li>
  );
}

function MoreMenu({ items }: { items: { icon: ReactNode; label: string; onClick: () => void; danger?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <Button variant="secondary" size="lg" aria-label="更多操作" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="px-3.5" data-testid="action-more">
        <Ellipsis className="size-5" />
      </Button>
      {open && (
        <div role="menu" className="absolute right-0 bottom-[calc(100%+8px)] z-30 w-56 animate-rise rounded-lg border border-line bg-card p-1.5 shadow-pop">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
              className={cn(
                'flex h-11 w-full items-center gap-2.5 rounded-md px-3 text-left text-[14px] font-semibold',
                it.danger ? 'text-clay hover:bg-clay-soft' : 'text-ink-2 hover:bg-paper-2 hover:text-ink',
              )}
            >
              {it.icon}
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 带常用原因的确认框：作废明细、撤销来访 */
function QuickReasonDialog({
  open,
  title,
  description,
  reasons,
  confirmLabel,
  disabled,
  children,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  reasons: readonly string[];
  confirmLabel: string;
  disabled?: boolean;
  children?: ReactNode;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setReason('');
      setError(null);
    }
  }, [open]);
  const ok = reason.trim().length >= 2 && !disabled;
  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            variant="danger"
            disabled={!ok}
            loading={busy}
            data-testid="reason-confirm"
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onConfirm(reason.trim());
              } catch (e) {
                setError(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {!disabled && (
        <>
          <div className="flex flex-wrap gap-1.5">
            {reasons.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setReason(r)}
                className={cn('h-9 rounded-full border px-3.5 text-[13px] font-semibold', reason === r ? 'border-clay bg-clay-soft text-clay' : 'border-line bg-card text-ink-2 hover:border-line-strong')}
              >
                {r}
              </button>
            ))}
          </div>
          <Textarea className="mt-2.5" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="或填写原因（至少 2 个字）" maxLength={200} aria-label="原因" />
        </>
      )}
      {error && <Notice tone="error" title={error} className="mt-3" />}
    </Dialog>
  );
}

