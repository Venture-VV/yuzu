// 发牌后的异常处置（8.1.15，docs/FRONTDESK_RISK_V8115.md 第 4 节）：
//   · IncidentDialog：客人卡上的「异常处置」——提醒、加收、上报、临时外出 / 返回、手牌丢失、未结离店，与这次来访已经记过的异常；
//   · IncidentTodoDialog：发卡台顶上的「异常待办」——没处理完的上报、未结离店，能指派、能写处理结果。
// 登记带操作编号（visit_incident），超时、断网后进「结果待确认」，与挂账、换牌同一套处理。
// 页面的规矩（8.1.15 起）：状态用颜色 + 文字 + 图标、不小于 16 像素；金额不小于 16 像素；主要按钮不矮于 44 像素；颜色只用样式变量。

import { useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { BellRing, CircleCheck, CircleDot, DoorOpen, KeyRound, LogIn, LogOut, Megaphone, ReceiptText, ShieldCheck, Store, Timer } from 'lucide-react';
import type { VisitDetail } from '@shared/frontdesk';
import { INCIDENT_KIND_LABELS, MAX_SURCHARGE_CENTS, overstayOf, TODO_KINDS, type IncidentKind, type IncidentTodo, type IncidentTodoList, type VisitIncident } from '@shared/frontdesk-risk';
import type { CheckinRiskGrant, CheckinRiskGrantRequest } from '@shared/grants';
import { formatYuan, parseYuan } from '@shared/money';
import { api, errorMessage } from '../../lib/api';
import { useCan, useReasons, useSession } from '../../lib/session';
import { cn, formatDateTime, formatTime } from '../../lib/utils';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { AuthorizeDialog } from '../../components/AuthorizeDialog';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailed } from '../../components/LoadFailed';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { ReasonChips } from '../../components/ReasonChips';
import { useToast } from '../../components/Toast';
import { Button, Field, Input, MoneyInput, Notice, Select, Skeleton, Textarea } from '../../components/ui';
import { StatusChip, VisitStatusChips, ZoneChip, type StatusTone } from './parts';
import { PendingPanel, useFrontdeskOp } from './pending';
import { fk, stayMinutes, stayText, useIncidentTodos, useRefreshFrontdesk, useServerNow } from './queries';

type Action = 'remind' | 'surcharge' | 'report' | 'away' | 'lost' | 'unsettled';

const GRANT_ERRORS = ['SURCHARGE_AUTH_REQUIRED', 'GRANT_INVALID', 'GRANT_USED', 'GRANT_EXPIRED', 'GRANT_SCOPE'];
const REMIND_NOTES = ['已当面提醒', '已电话提醒', '已广播提醒'];

/** 每种异常的颜色与图标（颜色都配文字） */
const KIND_STYLE: Record<IncidentKind, { tone: StatusTone; icon: ReactNode }> = {
  remind: { tone: 'neutral', icon: <BellRing className="size-4 shrink-0" /> },
  surcharge: { tone: 'yuzu', icon: <Timer className="size-4 shrink-0" /> },
  report: { tone: 'ember', icon: <Megaphone className="size-4 shrink-0" /> },
  away: { tone: 'lake', icon: <DoorOpen className="size-4 shrink-0" /> },
  return: { tone: 'pine', icon: <LogIn className="size-4 shrink-0" /> },
  unsettled: { tone: 'clay', icon: <ReceiptText className="size-4 shrink-0" /> },
};

function KindChip({ kind }: { kind: IncidentKind }) {
  return (
    <StatusChip tone={KIND_STYLE[kind].tone} icon={KIND_STYLE[kind].icon}>
      {INCIDENT_KIND_LABELS[kind]}
    </StatusChip>
  );
}

/** 待办处理了没有 */
function TodoStateChip({ resolved }: { resolved: boolean }) {
  return resolved ? (
    <StatusChip tone="pine" icon={<CircleCheck className="size-4 shrink-0" />}>
      已处理
    </StatusChip>
  ) : (
    <StatusChip tone="clay" icon={<CircleDot className="size-4 shrink-0" />}>
      待处理
    </StatusChip>
  );
}

/** 一条异常：种类、备注、金额、谁、几点；待办再写责任人与处理结果 */
function IncidentRow({ incident }: { incident: VisitIncident }) {
  const todo = TODO_KINDS.includes(incident.kind);
  return (
    <li className="rounded-lg border border-line bg-card px-3 py-2.5 text-[13px]" data-testid={`incident-${incident.id}`} data-kind={incident.kind}>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <KindChip kind={incident.kind} />
        {todo && <TodoStateChip resolved={!!incident.resolved} />}
        {incident.amountCents !== null && <Money cents={incident.amountCents} className="text-[16px] font-bold" />}
        <span className="num ml-auto text-[12px] text-ink-3">
          {formatTime(incident.createdAt)} · {incident.createdByName}
        </span>
      </p>
      {incident.note && <p className="mt-1 break-all text-ink-2">{incident.note}</p>}
      {incident.approvedByName && (
        <p className="mt-0.5 flex items-center gap-1 text-[12px] font-semibold text-yuzu-deep">
          <ShieldCheck className="size-3.5" /> 由{incident.approvedByName}当场授权
        </p>
      )}
      {todo && (
        <p className="mt-0.5 text-[12px] text-ink-3">
          {incident.resolved
            ? `处理结果：${incident.resolved.note}（${incident.resolved.byName} ${formatDateTime(incident.resolved.at)}）`
            : incident.assigneeName
              ? `责任人 ${incident.assigneeName}`
              : '还没指派责任人'}
        </p>
      )}
    </li>
  );
}

export function IncidentDialog({
  open,
  visit,
  onClose,
  onDone,
  onLost,
}: {
  open: boolean;
  visit: VisitDetail;
  onClose: () => void;
  /** 登记成了：最新的来访详情与一句提示 */
  onDone: (v: VisitDetail, message: string) => void;
  /** 手牌丢失：走换牌（锁旧牌、收赔付、换新牌），由发卡台打开预先选好丢失的换牌对话框 */
  onLost: () => void;
}) {
  const can = useCan();
  const session = useSession();
  const now = useServerNow(visit.serverTime);
  const surchargeReasons = useReasons('surchargeReasons');
  const [action, setAction] = useState<Action>('remind');
  const [note, setNote] = useState('');
  const [amount, setAmount] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [grant, setGrant] = useState<CheckinRiskGrant | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const away = !!visit.awaySince;
  const over = overstayOf(stayMinutes(visit.checkedInAt, now));
  const direct = can('auth.checkinRisk');
  const needAssignee = action === 'report' || action === 'unsettled';
  const todos = useIncidentTodos(open && needAssignee);
  // 这位客人上一笔异常处置结果待确认时，先处理那一笔
  const op = useFrontdeskOp<VisitDetail>({ type: 'visit_incident', visitId: visit.id, staffName: session.staff.displayName, pick: (found) => ('visit' in found ? found.visit : null) });
  const due = visit.bill.amountCents + (visit.ticket?.amount ?? 0);
  const openTodos = visit.incidents.filter((i) => TODO_KINDS.includes(i.kind) && !i.resolved).length;

  const choose = (a: Action) => {
    if (op.locked) return;
    op.clearError();
    setAction(a);
    setNote('');
    setGrant(null);
    setAssigneeId('');
    setAmount(a === 'unsettled' && due > 0 ? (due / 100).toFixed(2) : '');
  };
  useResetOnOpen(open, () => {
    setAction('remind');
    setNote('');
    setAmount('');
    setAssigneeId('');
    setGrant(null);
    op.clearError();
  });
  useEffect(() => {
    if (op.state.phase === 'error' && op.state.code && GRANT_ERRORS.includes(op.state.code)) setGrant(null);
  }, [op.state]);

  const cents = parseYuan(amount);
  const reason = note.trim();
  const amountOk = cents !== null && cents > 0 && (action !== 'surcharge' || cents <= MAX_SURCHARGE_CENTS);
  const grantOk = direct || (!!grant && grant.scope.kind === 'surcharge' && grant.scope.amount === cents && new Date(grant.expiresAt).getTime() > Date.now());
  const ready =
    action === 'remind' || action === 'away'
      ? true
      : action === 'surcharge'
        ? amountOk && reason.length >= 2 && grantOk
        : action === 'report'
          ? reason.length >= 2
          : action === 'unsettled'
            ? amountOk && reason.length >= 2
            : false;

  const submit = async () => {
    if (!ready || op.locked) return;
    const kind: IncidentKind = action === 'away' ? (away ? 'return' : 'away') : (action as IncidentKind);
    const body: Record<string, unknown> = { kind, note: reason };
    if (kind === 'surcharge') Object.assign(body, { amount: cents, grantId: direct ? null : grant!.grantId });
    if (kind === 'unsettled') Object.assign(body, { amount: cents, assigneeId: assigneeId ? Number(assigneeId) : null });
    if (kind === 'report') Object.assign(body, { assigneeId: assigneeId ? Number(assigneeId) : null });
    const label = INCIDENT_KIND_LABELS[kind];
    const r = await op.submit((key) => ({
      url: `/api/frontdesk/visits/${visit.id}/incidents`,
      body: { clientKey: key, ...body },
      tagCodes: [visit.tag.code],
      summary: `${label}${reason ? `（${reason}）` : ''}`,
      amount: kind === 'surcharge' ? cents : null,
    }));
    if (r)
      onDone(
        r,
        kind === 'surcharge'
          ? `已加收 ${formatYuan(cents!)}，挂到 ${visit.tag.code}`
          : kind === 'away'
            ? `${visit.tag.code} 已标外出，手牌仍占用`
            : kind === 'return'
              ? `${visit.tag.code} 已返回`
              : `${visit.tag.code} 已记：${label}`,
      );
  };

  const tiles: { key: Action; label: string; hint: string; icon: ReactNode }[] = [
    { key: 'remind', label: '提醒', hint: '记一条已提醒', icon: <BellRing className="size-4" /> },
    { key: 'surcharge', label: '加收', hint: '挂一笔超时加收', icon: <Timer className="size-4" /> },
    { key: 'report', label: '上报', hint: '指给责任人跟进', icon: <Megaphone className="size-4" /> },
    { key: 'away', label: away ? '返回' : '临时外出', hint: away ? '客人回来了' : '牌照旧占着', icon: away ? <LogIn className="size-4" /> : <DoorOpen className="size-4" /> },
    { key: 'lost', label: '手牌丢失', hint: '锁旧牌、收赔付、换新牌', icon: <KeyRound className="size-4" /> },
    { key: 'unsettled', label: '未结离店', hint: '记待办，下次发牌要授权', icon: <ReceiptText className="size-4" /> },
  ];
  const assigneeField = (
    <Field label="责任人（选填）" hint="指给谁跟进；之后在「异常待办」里能改派">
      {todos.isError && !todos.data ? (
        <LoadFailed title="责任人名单没取回来" onRetry={() => void todos.refetch()} retrying={todos.isFetching}>
          可以先不选，之后在「异常待办」里指派。
        </LoadFailed>
      ) : (
        <Select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} disabled={op.locked || todos.isPending} aria-label="责任人" data-testid="incident-assignee">
          <option value="">先不指派</option>
          {todos.data?.assignees.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}（{a.role}）
            </option>
          ))}
        </Select>
      )}
    </Field>
  );

  return (
    <Dialog
      open={open}
      onClose={op.busy ? () => {} : onClose}
      title={`异常处置 · ${visit.tag.code}`}
      description="每一条都留痕（谁、几点、备注），进这位客人的经办记录；上报与未结离店进「异常待办」"
      width="max-w-xl"
      footer={
        <>
          <Button size="lg" variant="ghost" onClick={onClose} disabled={op.busy}>
            关闭
          </Button>
          {action === 'lost' ? (
            <Button size="lg" variant="primary" onClick={onLost} disabled={op.locked} data-testid="incident-lost-go">
              去换牌
            </Button>
          ) : (
            <Button size="lg" variant="primary" disabled={!ready || op.locked} loading={op.busy} onClick={submit} data-testid="incident-submit">
              {action === 'remind' ? '记一条已提醒' : action === 'surcharge' ? '确认加收' : action === 'report' ? '上报' : action === 'away' ? (away ? '客人已返回' : '标为外出') : '记未结离店'}
            </Button>
          )}
        </>
      }
    >
      <PendingPanel op={op} onResolved={(v) => onDone(v, `${visit.tag.code} 的异常处置已生效`)} />
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink-2" data-testid="incident-stay">
          <ZoneChip zone={visit.zone} size="md" />
          <span>{visit.member ? `会员 ${visit.member.name}` : `散客${visit.guestLabel ? ` · ${visit.guestLabel}` : ''}`}</span>
          <span className="num font-semibold">在店 {stayText(visit.checkedInAt, now)}</span>
          <VisitStatusChips visit={{ checkedInAt: visit.checkedInAt, awaySince: visit.awaySince, openTodos }} now={now} testId="incident" />
          {away && <span className="text-[12px] text-ink-3">{formatTime(visit.awaySince!)} 起外出</span>}
        </div>

        <div role="radiogroup" aria-label="处置方式" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {tiles.map((t) => (
            <button
              key={t.key}
              type="button"
              role="radio"
              aria-checked={action === t.key}
              disabled={op.locked}
              onClick={() => choose(t.key)}
              data-testid={`incident-action-${t.key}`}
              className={cn(
                'flex min-h-[56px] flex-col items-start justify-center gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-50',
                action === t.key ? 'border-pine bg-pine-tint text-pine' : 'border-line bg-card text-ink-2 hover:border-line-strong',
              )}
            >
              <span className="flex items-center gap-1.5 text-[16px] font-bold">
                {t.icon}
                {t.label}
              </span>
              <span className="text-[12px] text-ink-3">{t.hint}</span>
            </button>
          ))}
        </div>

        {action === 'remind' && (
          <Field label="备注（选填）">
            <ReasonChips reasons={REMIND_NOTES} value={note} onPick={setNote} disabled={op.locked} />
            <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} disabled={op.locked} placeholder="怎么提醒的、客人怎么说" aria-label="提醒备注" data-testid="incident-note" />
          </Field>
        )}

        {action === 'surcharge' && (
          <div className="space-y-3">
            <Notice tone="info" title="加收就是在账单上挂一条「超时加收」">
              结账时一起收，不另记余额；挂错了在客人卡上作废（留原因）。{over ? `这位客人已经${over.label}。` : '这位客人还没超过 12 小时。'}
            </Notice>
            <div className="grid gap-3 sm:grid-cols-[160px_minmax(0,1fr)]">
              <Field label="加收金额" error={amount && !amountOk ? `金额不正确（一笔最多 ${formatYuan(MAX_SURCHARGE_CENTS)}）` : null}>
                <MoneyInput
                  value={amount}
                  onChange={(e) => {
                    setAmount(e.target.value);
                    setGrant(null);
                  }}
                  disabled={op.locked}
                  placeholder="0.00"
                  aria-label="加收金额"
                  data-testid="incident-amount"
                />
              </Field>
              <Field label="原因">
                <ReasonChips reasons={surchargeReasons} value={note} onPick={setNote} disabled={op.locked || (!direct && !!grant)} />
                <Input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={100}
                  disabled={op.locked || (!direct && !!grant)}
                  placeholder="为什么加收（至少 2 个字）"
                  aria-label="加收原因"
                  data-testid="incident-note"
                />
              </Field>
            </div>
            {!direct && (
              <Notice
                tone={grantOk ? 'success' : 'warning'}
                icon={<ShieldCheck className="size-4" />}
                title={grantOk && grant ? `已由${grant.approverName}当场授权` : '超时加收要值班经理及以上当场授权'}
              >
                <span className="flex flex-wrap items-center gap-3">
                  {grantOk && grant ? `授权 ${formatTime(grant.expiresAt)} 前有效，只能用于这一笔加收。` : '填好金额与原因，请值班经理、店总或店主输入账号密码授权。'}
                  {!grantOk && (
                    <Button
                      size="lg"
                      variant="secondary"
                      icon={<ShieldCheck className="size-4" />}
                      disabled={op.locked || !amountOk || reason.length < 2}
                      onClick={() => setAuthOpen(true)}
                      data-testid="request-authorize"
                    >
                      请经理授权
                    </Button>
                  )}
                </span>
              </Notice>
            )}
          </div>
        )}

        {action === 'report' && (
          <div className="space-y-3">
            <Field label="情况">
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={200}
                disabled={op.locked}
                placeholder="发生了什么、要谁来处理（至少 2 个字）"
                aria-label="上报的情况"
                data-testid="incident-note"
              />
            </Field>
            {assigneeField}
          </div>
        )}

        {action === 'away' && (
          <Field label="备注（选填）" hint={away ? '点「客人已返回」清掉外出标记。' : '外出期间手牌照旧占着，不能发给别人；账单不动，回来点「返回」。'}>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={200}
              disabled={op.locked}
              placeholder={away ? '几点回来的' : '去哪、大概多久回来'}
              aria-label="外出备注"
              data-testid="incident-note"
            />
          </Field>
        )}

        {action === 'lost' && (
          <Notice tone="warning" icon={<KeyRound className="size-4" />} title="手牌丢失：一步走完「锁旧牌、收赔付、换新牌」">
            点「去换牌」打开换牌对话框，原因已经选好「手牌丢失」、勾上了锁定原手牌与丢牌赔偿（按前台规则的金额挂到账单）；刷新牌或填新牌号确认即可。
          </Notice>
        )}

        {action === 'unsettled' && (
          <div className="space-y-3">
            <Notice tone="warning" title="未结离店：记一条待办，不动账单">
              这张牌的账还挂着（手牌仍占用）。
              {visit.member ? `「${visit.member.name}」下次来店发牌时会被拦下来，要值班经理及以上当场授权。` : '散客没有会员档案，下次来认不出，只记待办跟进。'}
              真要把钱记成挂账，照旧在收银台用「挂账」结。
            </Notice>
            <div className="grid gap-3 sm:grid-cols-[160px_minmax(0,1fr)]">
              <Field
                label="应收多少"
                hint={`已挂 ${formatYuan(visit.bill.amountCents)}${visit.ticket ? ` + 门票此刻 ${formatYuan(visit.ticket.amount)}` : ''}`}
                error={amount && !amountOk ? '金额不正确' : null}
              >
                <MoneyInput value={amount} onChange={(e) => setAmount(e.target.value)} disabled={op.locked} placeholder="0.00" aria-label="应收金额" data-testid="incident-amount" />
              </Field>
              <Field label="情况">
                <Input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={200}
                  disabled={op.locked}
                  placeholder="怎么发现的、联系上没有（至少 2 个字）"
                  aria-label="未结离店的情况"
                  data-testid="incident-note"
                />
              </Field>
            </div>
            {assigneeField}
          </div>
        )}

        {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} />}

        <section aria-label="这次来访的异常记录">
          <h3 className="text-[12px] font-bold text-ink-3">这次来访已经记过的（{visit.incidents.length}）</h3>
          {visit.incidents.length === 0 ? (
            <p className="mt-1.5 text-[12.5px] text-ink-3" data-testid="incident-none">
              还没有记过异常。
            </p>
          ) : (
            <ul className="mt-1.5 space-y-1.5" data-testid="incident-list">
              {visit.incidents.map((i) => (
                <IncidentRow key={i.id} incident={i} />
              ))}
            </ul>
          )}
        </section>
      </div>
      {authOpen && cents !== null && (
        <AuthorizeDialog<CheckinRiskGrantRequest>
          open
          request={{ purpose: 'checkin_risk', scope: { kind: 'surcharge', visitId: visit.id, amount: cents, reason } }}
          lines={[`手牌 ${visit.tag.code} · 超时加收 ${formatYuan(cents)}`, `原因：${reason}`]}
          onClose={() => setAuthOpen(false)}
          onGranted={(g) => {
            setGrant(g);
            setAuthOpen(false);
            op.clearError();
          }}
        />
      )}
    </Dialog>
  );
}

// ───────────────────────── 异常待办 ─────────────────────────

function TodoCard({
  todo,
  list,
  onChanged,
  onOpenVisit,
}: {
  todo: IncidentTodo;
  list: IncidentTodoList;
  onChanged: (next: IncidentTodoList, message: string) => void;
  onOpenVisit: (visitId: number) => void;
}) {
  const can = useCan();
  const toast = useToast();
  const [resolving, setResolving] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const operate = can('frontdesk.operate');
  // 未结离店处理完，这位会员下次发牌就不再拦：要值班经理及以上
  const canResolve = operate && (todo.kind !== 'unsettled' || can('auth.checkinRisk'));
  const inStore = todo.visitStatus === 'open';
  const run = async (fn: () => Promise<IncidentTodoList>, message: string) => {
    setBusy(true);
    try {
      onChanged(await fn(), message);
      setResolving(false);
    } catch (e) {
      toast({ tone: 'error', title: '没有保存', body: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="rounded-[14px] border border-line bg-card px-4 py-3 shadow-card" data-testid={`todo-${todo.id}`} data-kind={todo.kind}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <KindChip kind={todo.kind} />
        {inStore ? (
          <button
            type="button"
            onClick={() => onOpenVisit(todo.visitId)}
            className="num flex min-h-11 items-center text-[20px] font-bold text-pine hover:underline"
            title="打开这位客人的客人卡"
            data-testid={`todo-${todo.id}-open`}
          >
            {todo.tagCode}
          </button>
        ) : (
          <span className="num text-[20px] font-bold text-ink-2">{todo.tagCode}</span>
        )}
        <ZoneChip zone={todo.zone} size="md" />
        <StatusChip tone={inStore ? 'pine' : 'neutral'} icon={inStore ? <Store className="size-4 shrink-0" /> : <LogOut className="size-4 shrink-0" />}>
          {inStore ? '还在店' : todo.visitStatus === 'settled' ? '已结账离店' : '来访已撤销'}
        </StatusChip>
        {todo.amountCents !== null && (
          <span className="ml-auto text-[13px] text-ink-3">
            应收 <Money cents={todo.amountCents} className="text-[16px] font-bold text-clay" />
          </span>
        )}
      </div>
      <p className="mt-1.5 text-[13.5px] break-all text-ink">
        {todo.memberName ? `会员 ${todo.memberName}` : `散客${todo.guestLabel ? ` · ${todo.guestLabel}` : ''}`}：{todo.note}
      </p>
      <p className="num mt-0.5 text-[12px] text-ink-3">
        {todo.createdByName} {formatDateTime(todo.createdAt)} 登记 · {todo.visitNo}
        {inStore && todo.billAmountCents > 0 && (
          <>
            {' '}
            · 账单上挂着 <Money cents={todo.billAmountCents} className="text-[16px] font-bold text-ink-2" />
          </>
        )}
      </p>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-[13px] text-ink-3">
          责任人
          <Select
            fullWidth={false}
            value={todo.assigneeId === null ? '' : String(todo.assigneeId)}
            disabled={!operate || busy}
            onChange={(e) => {
              const id = Number(e.target.value);
              if (id) void run(() => api.post<IncidentTodoList>(`/api/frontdesk/incidents/${todo.id}/assign`, { assigneeId: id }), `已指给${list.assignees.find((a) => a.id === id)?.name ?? ''}`);
            }}
            className="w-[168px] text-[13.5px]"
            aria-label={`${todo.tagCode} 的责任人`}
            data-testid={`todo-${todo.id}-assignee`}
          >
            <option value="" disabled>
              还没指派
            </option>
            {list.assignees.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}（{a.role}）
              </option>
            ))}
          </Select>
        </label>
        <span className="flex-1" />
        {!resolving && (
          <Button
            size="lg"
            variant="secondary"
            icon={<CircleCheck className="size-4" />}
            disabled={!canResolve || busy}
            title={canResolve ? undefined : todo.kind === 'unsettled' ? '未结离店要值班经理、店总或店主写处理结果' : '没有发牌、挂账的权限'}
            onClick={() => {
              setNote('');
              setResolving(true);
            }}
            data-testid={`todo-${todo.id}-resolve`}
          >
            写处理结果
          </Button>
        )}
      </div>
      {!canResolve && operate && todo.kind === 'unsettled' && <p className="mt-1.5 text-[12px] text-ink-3">未结离店处理完这位会员发牌就不再拦，所以要值班经理、店总或店主写处理结果。</p>}
      {resolving && (
        <div className="mt-2.5 space-y-2 rounded-lg bg-paper-2/70 p-3">
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={200}
            placeholder="怎么处理的（至少 2 个字）；写了就算处理完，不能再改"
            aria-label="处理结果"
            data-autofocus
            data-testid={`todo-${todo.id}-note`}
          />
          <div className="flex justify-end gap-2">
            <Button size="lg" variant="ghost" onClick={() => setResolving(false)} disabled={busy}>
              取消
            </Button>
            <Button
              size="lg"
              variant="primary"
              loading={busy}
              disabled={note.trim().length < 2}
              onClick={() =>
                void run(() => api.post<IncidentTodoList>(`/api/frontdesk/incidents/${todo.id}/resolve`, { note: note.trim() }), `${todo.tagCode} 的${INCIDENT_KIND_LABELS[todo.kind]}已处理`)
              }
              data-testid={`todo-${todo.id}-confirm`}
            >
              确认处理完
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

export function IncidentTodoDialog({ open, onClose, onOpenVisit }: { open: boolean; onClose: () => void; onOpenVisit: (visitId: number) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = useRefreshFrontdesk();
  const todos = useIncidentTodos(open);
  const list = todos.data;
  return (
    <Dialog open={open} onClose={onClose} title="异常待办" description="没处理完的上报与未结离店（先登记的在前）。能指派责任人、写处理结果；处理结果只能写一次。" width="max-w-2xl">
      {todos.isPending ? (
        <div className="space-y-2">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : todos.isError && !list ? (
        <LoadFailed title="异常待办没取回来" onRetry={() => void todos.refetch()} retrying={todos.isFetching} testId="todo-load-failed">
          {errorMessage(todos.error)}
        </LoadFailed>
      ) : !list || list.todos.length === 0 ? (
        <EmptyState art="calm" title="没有待办" description="客人卡上「异常处置」里的上报、未结离店会出现在这里。" />
      ) : (
        <ul className="space-y-2.5" data-testid="todo-list">
          {list.todos.map((t) => (
            <TodoCard
              key={t.id}
              todo={t}
              list={list}
              onOpenVisit={(id) => {
                onClose();
                onOpenVisit(id);
              }}
              onChanged={(next, message) => {
                qc.setQueryData(fk.todos, next);
                refresh([t.visitId]);
                toast({ tone: 'success', title: message });
              }}
            />
          ))}
        </ul>
      )}
    </Dialog>
  );
}
