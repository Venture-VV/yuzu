// 会员详情「储值与账户」（会员体系收尾，v0.7.26；docs/MEMBERSHIP_FINISH.md 第 1、3、4 节）：
//   · 退储值（M69–M74）：退本金余额以内、默认全退；最近的充值先退、按原收款方式（期初、合并转入的选方式）；赠金按比例扣回；
//     现金选钱箱；扫码、银行卡登记退款单号；店主或店总当场授权；超时、断网、回复 500 时结果待确认，在卡片上方查回、重提或作废；
//   · 线上充值（小程序）的那一行（v0.7.27）：小程序线的原路退回开着时，可以选「门店系统原路退回」（不填退款单号），
//     或「已在商户平台退过」（填退款单号）；没开时与 v0.7.26 一样填退款单号；
//   · 退过的储值（退储值单）列在下面。停用 / 启用、合并在同一张卡片上（见 MemberStatusActions）。

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { HandCoins, ShieldCheck } from 'lucide-react';
import type { RefundShiftOptions } from '@shared/checkout';
import type { Granted, MemberRefundGrantRequest } from '@shared/grants';
import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS, type PaymentMethod } from '@shared/labels';
import {
  onlineRoutable,
  REFUND_SOURCE_LABELS,
  refundRefRequired,
  type MemberRefundDetail,
  type MemberRefundPlan,
  type RefundPlanLine,
  type RefundRoute,
} from '@shared/member-refunds';
import { centsToInput, formatYuan, parseYuan } from '@shared/money';
import type { MemberDetail } from '@shared/types';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, useErpPending, type ErpPendingOp } from '../../lib/erpPending';
import { useCan, useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { formatDate, uuid } from '../../lib/utils';
import { AuthorizeDialog } from '../../components/AuthorizeDialog';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, MoneyInput, Notice, PendingBadge, SectionTitle, Select, Skeleton, Textarea } from '../../components/ui';
import type { MemberAccountHistory } from '@shared/member-admin';
import { formatPhone } from '@shared/labels';
import { MemberStatusActions, mergeUrl, statusUrl } from './MemberStatusActions';

const refundUrl = (memberId: number) => `/api/members/${memberId}/refunds`;
export const accountKeys = {
  refunds: (memberId: number) => ['member-refunds', memberId] as const,
  history: (memberId: number) => ['member-account-history', memberId] as const,
  plan: (memberId: number, amount: number | null) => ['member-refund-plan', memberId, amount ?? 'all'] as const,
};

export function AccountCard({ member }: { member: MemberDetail }) {
  const can = useCan();
  const qc = useQueryClient();
  const canRefund = can('member.refund');
  const refunds = useQuery({ queryKey: accountKeys.refunds(member.id), queryFn: () => api.get<MemberRefundDetail[]>(`/api/members/${member.id}/refunds`) });
  const history = useQuery({ queryKey: accountKeys.history(member.id), queryFn: () => api.get<MemberAccountHistory>(`/api/members/${member.id}/account-history`) });
  const ofMember = (op: ErpPendingOp) => op.url === refundUrl(member.id);
  const ofAccount = (op: ErpPendingOp) => op.url === statusUrl(member.id) || op.url === mergeUrl(member.id);
  const pending = useErpPending(['member_refund']).filter(ofMember);
  const [open, setOpen] = useState(false);
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['member', member.id] }),
      qc.invalidateQueries({ queryKey: accountKeys.refunds(member.id) }),
      qc.invalidateQueries({ queryKey: accountKeys.history(member.id) }),
      qc.invalidateQueries({ queryKey: ['members'] }),
      qc.invalidateQueries({ queryKey: ['activity', member.id] }),
      qc.invalidateQueries({ queryKey: ['membership'] }),
    ]);
  const merged = member.mergedInto ?? null;
  const refundBlocked = merged
    ? `已合并到 ${merged.memberNo}，请到那位会员那里退`
    : member.principalBalance <= 0
      ? '没有本金余额'
      : pending.length > 0
        ? '上一次退储值结果待确认，请先在上方查回、按原内容重新提交或作废'
        : null;

  return (
    <Card className="p-5" data-testid="member-account">
      <SectionTitle
        aside={
          <span className="flex flex-wrap items-center justify-end gap-2">
            <PendingBadge title="M69–M79：退储值要店主或店总当场授权、按原收款方式退、赠金按比例扣回；停用 / 合并要店主或店总（待店主确认）" />
            {canRefund && (
              <Button
                size="sm"
                variant="secondary"
                icon={<HandCoins className="size-3.5" />}
                disabled={refundBlocked !== null}
                title={refundBlocked ?? undefined}
                onClick={() => setOpen(true)}
                data-testid="member-refund-open"
              >
                退储值
              </Button>
            )}
            <MemberStatusActions member={member} onChanged={() => void refresh()} />
          </span>
        }
      >
        <span className="flex items-center gap-2">
          <HandCoins className="size-4 text-clay" /> 储值与账户
        </span>
      </SectionTitle>
      {canRefund && <ErpPendingPanel types={['member_refund']} filter={ofMember} className="mt-3 space-y-2" onFound={() => void refresh()} />}
      <ErpPendingPanel types={['member_status', 'member_merge']} filter={ofAccount} className="mt-3 space-y-2" onFound={() => void refresh()} />
      {merged && (
        <Notice tone="warning" className="mt-3" title={`已合并到 ${merged.name}（${merged.memberNo}）`} data-testid="member-merged-into">
          余额与赠金已经转过去，这份档案停用；以后在那位会员那里办理。
        </Notice>
      )}
      {refunds.isPending ? (
        <Skeleton className="mt-3 h-12" />
      ) : (refunds.data ?? []).length === 0 ? (
        <p className="mt-3 text-[13px] text-ink-3">没有退过储值。</p>
      ) : (
        <ul className="mt-3 divide-y divide-line/70 text-[13px]" data-testid="member-refund-list">
          {refunds.data!.map((r) => (
            <li key={r.id} className="py-2">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="num font-semibold text-ink">{r.refundNo}</span>
                <span className="text-ink-3">{r.businessDate}</span>
                <span className="font-semibold text-clay">
                  退本金 <Money cents={r.principal} />
                </span>
                {r.bonus > 0 && (
                  <span className="text-ink-3">
                    扣回赠金 <Money cents={r.bonus} />
                  </span>
                )}
                {r.grade && <Badge tone="ember">{`${r.grade.from} → ${r.grade.to}`}</Badge>}
              </div>
              <p className="mt-0.5 text-[12.5px] text-ink-3">
                {r.lines
                  .map((l) => `${PAYMENT_METHOD_LABELS[l.method]} ${formatYuan(l.amount)}${l.ref ? `（${l.ref}）` : l.route === 'mp_auto' ? '（门店系统原路退回）' : ''}`)
                  .join('、')}{' '}
                · {r.reason} · 经办 {r.operatorName}，
                {r.approverName}授权
              </p>
            </li>
          ))}
        </ul>
      )}
      {history.data && <AccountHistory h={history.data} />}
      {open && <RefundDialog member={member} onClose={() => setOpen(false)} onDone={() => void refresh()} />}
    </Card>
  );
}

/** 停用 / 启用、换手机号、合并的记录（最近的在前） */
function AccountHistory({ h }: { h: MemberAccountHistory }) {
  const rows = [
    ...h.statusEvents
      .filter((e) => !e.mergeNo)
      .map((e) => ({ at: e.createdAt, key: `s${e.id}`, text: `${e.toStatus === 'frozen' ? '停用' : '启用'} · ${e.reason} · ${e.staffName}` })),
    ...h.phoneChanges.map((c) => ({
      at: c.createdAt,
      key: `p${c.id}`,
      text: `换手机号 ${formatPhone(c.oldPhone)} → ${formatPhone(c.newPhone)} · ${c.reason} · ${c.staffName}${c.approverName ? `，${c.approverName}授权` : ''}`,
    })),
    ...h.mergedFrom.map((g) => ({
      at: g.createdAt,
      key: `m${g.id}`,
      text: `合并转入 ${g.mergeNo}：${g.source.name}（${g.source.memberNo}）本金 ${formatYuan(g.principal)}、赠金 ${formatYuan(g.bonus)}${g.grade ? `，档阶 ${g.grade.from} → ${g.grade.to}` : ''} · ${g.staffName}`,
    })),
    ...(h.mergedInto
      ? [{ at: h.mergedInto.createdAt, key: 'into', text: `合并到 ${h.mergedInto.target.name}（${h.mergedInto.target.memberNo}）${h.mergedInto.mergeNo} · ${h.mergedInto.reason} · ${h.mergedInto.staffName}` }]
      : []),
  ].sort((a, b) => (a.at < b.at ? 1 : -1));
  if (rows.length === 0) return null;
  return (
    <ul className="mt-3 space-y-1 border-t border-line pt-3 text-[12.5px] text-ink-3" data-testid="member-account-history">
      {rows.map((r) => (
        <li key={r.key}>
          <span className="num">{formatDate(r.at)}</span> {r.text}
        </li>
      ))}
    </ul>
  );
}

/** 每一行的退款方式与退款单号（充值的方式固定是原收款方式；期初、合并转入的员工选）；线上充值的那一行还可以交给门店系统原路退回 */
interface LineDraft {
  method: PaymentMethod;
  ref: string;
  route: RefundRoute;
}
const lineKey = (l: RefundPlanLine) => `${l.source}:${l.id}`;

function RefundDialog({ member, onClose, onDone }: { member: MemberDetail; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const session = useSession();
  const qc = useQueryClient();
  const [amountText, setAmountText] = useState(centsToInput(member.principalBalance));
  const [amount, setAmount] = useState<number | null>(member.principalBalance);
  const [drafts, setDrafts] = useState<Record<string, LineDraft>>({});
  const [reason, setReason] = useState('');
  const [drawer, setDrawer] = useState<number | null>(null);
  const [key, setKey] = useState(uuid);
  const [grant, setGrant] = useState<Granted<MemberRefundGrantRequest> | null>(null);
  const [authorizing, setAuthorizing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(true, () => {
    setKey(uuid());
    setError(null);
  });
  // 金额停下 300 毫秒再核对（每次核对按此刻的余额重新分配）
  useEffect(() => {
    const t = setTimeout(() => setAmount(parseYuan(amountText)), 300);
    return () => clearTimeout(t);
  }, [amountText]);
  const plan = useQuery({
    queryKey: ['member-refund-plan', member.id, amount],
    queryFn: () => api.get<MemberRefundPlan>(`/api/members/${member.id}/refund-plan${amount ? `?amount=${amount}` : ''}`),
    enabled: amount !== null && amount > 0,
  });
  const drawers = useQuery({ queryKey: ['member-refund-drawers'], queryFn: () => api.get<RefundShiftOptions>(`/api/members/${member.id}/refund-drawers`) });
  useEffect(() => {
    if (drawer === null && drawers.data?.suggested) setDrawer(drawers.data.suggested);
  }, [drawers.data, drawer]);
  const p = plan.data;
  // 金额、分配变了：授权作废（授权绑定金额）
  useEffect(() => setGrant(null), [p?.amount, member.id]);
  // 线上充值的那一行：原路退回开着时默认交给门店系统；没开（或刚关掉）的一律员工退、填退款单号
  const autoOk = (l: RefundPlanLine) => !!p?.onlineRoute && onlineRoutable(l);
  const lines = useMemo(
    () =>
      (p?.lines ?? []).map((l) => {
        const d = drafts[lineKey(l)] ?? { method: l.method ?? 'cash', ref: '', route: autoOk(l) ? ('mp_auto' as const) : ('manual' as const) };
        return { ...l, draft: { ...d, route: autoOk(l) ? d.route : ('manual' as const) } };
      }),
    [p?.lines, p?.onlineRoute, drafts],
  );
  const hasCash = lines.some((l) => l.draft.method === 'cash');
  const missingRef = lines.find((l) => l.draft.route === 'manual' && refundRefRequired(l.draft.method) && l.draft.ref.trim().length < 2);
  const overBalance = amount !== null && amount > member.principalBalance;
  const ready = !!p && !p.blocked && p.amount > 0 && !overBalance && !missingRef && reason.trim().length >= 2 && (!hasCash || drawer !== null);
  const setDraft = (l: RefundPlanLine, patch: Partial<LineDraft>) =>
    setDrafts((d) => ({
      ...d,
      [lineKey(l)]: { ...(d[lineKey(l)] ?? { method: l.method ?? 'cash', ref: '', route: autoOk(l) ? 'mp_auto' : 'manual' }), ...patch },
    }));

  const submit = async (g: Granted<MemberRefundGrantRequest>) => {
    if (!p) return;
    setBusy(true);
    setError(null);
    try {
      await sendErpOp({
        key,
        type: 'member_refund',
        url: refundUrl(member.id),
        body: {
          clientKey: key,
          amount: p.amount,
          expectedBonus: p.bonus,
          lines: lines.map((l) => ({
            source: l.source,
            id: l.id,
            method: l.draft.method,
            amount: l.amount,
            ref: l.draft.route === 'mp_auto' ? '' : l.draft.ref.trim(),
            route: l.draft.route,
          })),
          reason: reason.trim(),
          ...(hasCash && drawer !== null ? { refundShiftId: drawer } : {}),
          grantId: g.grantId,
        },
        summary: `${member.name}退储值 ${formatYuan(p.amount)}`,
        staffName: session.staff.displayName,
      });
      toast({ tone: 'success', title: '已退储值', body: `${member.name}：退本金 ${formatYuan(p.amount)}${p.bonus ? `，扣回赠金 ${formatYuan(p.bonus)}` : ''}` });
      await qc.invalidateQueries({ queryKey: ['member'] });
      onDone();
      onClose();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '退储值结果待确认', body: '已记在本机：请在「储值与账户」上方查回、按原内容重新提交或作废，不要另起一笔。' });
        onDone();
        onClose();
        return;
      }
      setGrant(null);
      setError(errorMessage(e));
      void plan.refetch();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${member.name}：退储值`}
      description="退本金（最近的充值先退、按原收款方式）；赠金按退的本金比例扣回、不退钱，本金退到 0 时赠金全部扣回。退了不能作废，请与客人、授权人当场核对。"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            variant="danger"
            icon={<ShieldCheck className="size-4" />}
            onClick={() => (grant ? void submit(grant) : setAuthorizing(true))}
            loading={busy}
            disabled={!ready || busy}
            data-testid="member-refund-submit"
          >
            {grant ? '确认退回' : '请店主 / 店总授权并退回'}
          </Button>
        </div>
      }
    >
      <div className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="退的本金" htmlFor="member-refund-amount" hint={`本金余额 ${formatYuan(member.principalBalance)}，默认全退`}>
            <MoneyInput
              id="member-refund-amount"
              value={amountText}
              invalid={overBalance}
              onChange={(e) => setAmountText(e.target.value)}
              data-testid="member-refund-amount"
            />
          </Field>
          <div className="rounded-md bg-paper-2 px-3 py-2 text-[13px]" data-testid="member-refund-bonus">
            <p className="text-ink-3">扣回赠金</p>
            <p className="mt-0.5 text-[18px] font-bold text-ink">{p ? formatYuan(p.bonus) : '—'}</p>
            <p className="text-[12px] text-ink-3">赠金余额 {formatYuan(member.bonusBalance)}</p>
          </div>
        </div>
        {overBalance && <Notice tone="error" title={`最多退本金余额 ${formatYuan(member.principalBalance)}`} />}
        {plan.isFetching && !p && <Skeleton className="h-16" />}
        {plan.error && <Notice tone="error" title={errorMessage(plan.error)} />}
        {p?.blocked && <Notice tone="warning" title={p.blocked} />}
        {p?.grade && (
          <Notice tone="warning" title={`退了以后会降档：${p.grade.from} → ${p.grade.to}`} data-testid="member-refund-grade">
            这一档是本会籍周期里靠充值升上来的，扣掉退回以后滚动累计充值够不上，当场降到 {p.grade.to}（会籍周期不变）。
          </Notice>
        )}
        {p && !p.blocked && lines.length > 0 && (
          <div className="rounded-md ring-1 ring-line" data-testid="member-refund-lines">
            <p className="border-b border-line px-3 py-2 text-[12.5px] font-semibold text-ink-3">按原收款方式退（最近的充值先退）</p>
            <ul className="divide-y divide-line/70">
              {lines.map((l, i) => (
                <li key={lineKey(l)} className="grid gap-2 px-3 py-2.5 text-[13px] sm:grid-cols-[1fr_auto]" data-testid={`member-refund-line-${i}`}>
                  <div className="min-w-0">
                    <p className="font-semibold text-ink">
                      {REFUND_SOURCE_LABELS[l.source]} <span className="num">{l.docNo}</span>
                      <span className="ml-1 font-normal text-ink-3">{l.date}</span>
                      {l.channel === 'mp' && <Badge tone="lake" className="ml-1">小程序</Badge>}
                    </p>
                    <p className="text-[12.5px] text-ink-3">
                      退 <Money cents={l.amount} />
                      {l.method ? ` · 原收款方式 ${PAYMENT_METHOD_LABELS[l.method]}` : ' · 没有原收款方式，请选退款方式'}
                    </p>
                    {onlineRoutable(l) && (
                      <p className="text-[12px] text-ink-3" data-testid={`member-refund-route-hint-${i}`}>
                        {l.draft.route === 'mp_auto'
                          ? '门店系统会自动原路退回到顾客的微信，不用去商户平台'
                          : p.onlineRoute
                            ? '已在小程序的微信支付商户平台退过：填那边的退款单号，门店系统不会再退'
                            : '线上充值：请在小程序的微信支付商户平台原路退回后填退款单号'}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {l.method === null && (
                      <Select
                        aria-label="退款方式"
                        value={l.draft.method}
                        onChange={(e) => setDraft(l, { method: e.target.value as PaymentMethod })}
                        data-testid={`member-refund-method-${i}`}
                      >
                        {PAYMENT_METHODS.map((m) => (
                          <option key={m} value={m}>
                            {PAYMENT_METHOD_LABELS[m]}
                          </option>
                        ))}
                      </Select>
                    )}
                    {autoOk(l) && (
                      <Select
                        aria-label="怎么退"
                        value={l.draft.route}
                        onChange={(e) => setDraft(l, { route: e.target.value as RefundRoute })}
                        data-testid={`member-refund-route-${i}`}
                      >
                        <option value="mp_auto">门店系统原路退回</option>
                        <option value="manual">已在商户平台退过</option>
                      </Select>
                    )}
                    {l.draft.route === 'manual' && refundRefRequired(l.draft.method) && (
                      <Input
                        aria-label={l.draft.method === 'other' ? '怎么退的' : '退款单号'}
                        placeholder={l.draft.method === 'other' ? '写明怎么退的' : '商户后台的退款单号'}
                        value={l.draft.ref}
                        maxLength={64}
                        onChange={(e) => setDraft(l, { ref: e.target.value })}
                        data-testid={`member-refund-ref-${i}`}
                      />
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
        {hasCash && (
          <Field label="现金从哪个钱箱退" htmlFor="member-refund-drawer" hint="所选钱箱当班的班次：退的现金从它的应有现金里减">
            <Select id="member-refund-drawer" value={drawer ?? ''} onChange={(e) => setDrawer(e.target.value ? Number(e.target.value) : null)} data-testid="member-refund-drawer">
              <option value="">请选择钱箱</option>
              {(drawers.data?.shifts ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.staffName} · {s.shiftNo}
                  {s.mine ? '（我的）' : ''}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="原因" htmlFor="member-refund-reason">
          <Textarea id="member-refund-reason" rows={2} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="member-refund-reason" />
        </Field>
        {grant && <Notice tone="success" title={`已由 ${grant.approverName} 当场授权（5 分钟内有效，只能用于这一笔）`} />}
        {missingRef && <p className="text-[12.5px] text-ink-3">扫码、银行卡退的，在商户后台原路退回后填退款单号；「其他」写明怎么退的。</p>}
        {error && <Notice tone="error" title={error} />}
      </div>
      <AuthorizeDialog
        open={authorizing}
        request={{ purpose: 'member_refund', scope: { memberId: member.id, amount: p?.amount ?? 0 } }}
        lines={[`会员 ${member.name} · 退本金 ${formatYuan(p?.amount ?? 0)}`, `扣回赠金 ${formatYuan(p?.bonus ?? 0)}`]}
        onClose={() => setAuthorizing(false)}
        onGranted={(g) => {
          setAuthorizing(false);
          setGrant(g);
          void submit(g);
        }}
      />
    </Dialog>
  );
}
