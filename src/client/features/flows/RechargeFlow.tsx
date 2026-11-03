import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Banknote, CreditCard, Ellipsis, Gift, Smartphone, Ticket, WalletCards } from 'lucide-react';
import { overLimitGrantFits, type OverLimitGrant } from '@shared/grants';
import { lastUsableDate } from '@shared/business-date';
import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS, shiftDate, type PaymentMethod } from '@shared/labels';
import { formatYuan, parseYuan } from '@shared/money';
import type { MemberDetail, OperationResult } from '@shared/types';
import { findPending } from '../../lib/pendingOps';
import { qk, useCatalog } from '../../lib/queries';
import { useCan, useSession } from '../../lib/session';
import { cn } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Button, ConfirmCheck, Field, Input, MoneyInput, Notice, PendingBadge, Skeleton } from '../../components/ui';
import { BalanceChange, FlowFrame, OperationStatus, OverLimitCard, PendingRecovery, SuccessHeader, SummaryRow, type Step } from './parts';
import { isBusy, isLocked, useOperation } from './useOperation';
import { SHIFT_ERRORS, shiftKeys, ShiftGate, useShiftReady } from '../shift/ShiftGate';
import { planGiftText, usePlanGifts } from '../coupons/queries';

const METHOD_ICONS: Record<PaymentMethod, typeof Smartphone> = {
  wechat: Smartphone,
  alipay: WalletCards,
  cash: Banknote,
  bank_card: CreditCard,
  other: Ellipsis,
};

export function RechargeFlow({
  member,
  onClose,
  onSwitchToConsume,
}: {
  member: MemberDetail;
  onClose: () => void;
  onSwitchToConsume: () => void;
}) {
  const can = useCan();
  const session = useSession();
  const qc = useQueryClient();
  const catalog = useCatalog();
  const plans = catalog.data?.plans ?? [];
  const canCustomBonus = can('recharge.customBonus');

  const [step, setStep] = useState<Step>('form');
  const [planId, setPlanId] = useState<number | 'custom' | null>(null);
  const [paidText, setPaidText] = useState('');
  const [bonusText, setBonusText] = useState('');
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  const [paymentRef, setPaymentRef] = useState('');
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  /** 超过单笔上限时店主或店总的当场授权 */
  const [grant, setGrant] = useState<OverLimitGrant | null>(null);

  const plan = typeof planId === 'number' ? plans.find((p) => p.id === planId) : undefined;
  // 充值赠券（v0.7.20）：套餐上挂的券，入账时与赠金一起发；接口要「会员充值」权限
  const gifts = usePlanGifts(can('recharge.create'));
  const planGifts = plan ? (gifts.data ?? []).filter((g) => g.planId === plan.id) : [];
  const paid = plan ? plan.payAmount : parseYuan(paidText);
  const bonus = plan ? plan.bonusAmount : bonusText.trim() ? parseYuan(bonusText) : 0;

  const before = { principal: member.principalBalance, bonus: member.bonusBalance };
  const after = { principal: before.principal + (paid ?? 0), bonus: before.bonus + (bonus ?? 0) };
  /** 赠金有效期（天）：套餐上设置；自定义赠金按经营规则的默认值；null 为长期有效 */
  const bonusValidDays = plan ? plan.bonusValidDays : session.rules.customBonusValidDays;
  const bonusValidText = bonusValidDays ? `至 ${shiftDate(session.today, bonusValidDays - 1)}（${bonusValidDays} 天）` : '长期有效';
  const limit = session.rules.maxRechargeCents;
  const overLimit = paid != null && paid > limit;
  const grantScope = { kind: 'recharge' as const, memberId: member.id, amount: paid ?? 0 };
  const grantOk = !overLimit || overLimitGrantFits(grant, grantScope);

  const op = useOperation({
    type: 'recharge',
    url: '/api/recharges',
    build: (idempotencyKey) => ({
      body: {
        idempotencyKey,
        memberId: member.id,
        planId: plan?.id ?? null,
        paidAmount: paid,
        bonusAmount: bonus,
        paymentMethod: method,
        paymentRef,
        note,
        paymentConfirmed: confirmed,
        overLimitGrantId: overLimit ? grant?.grantId : undefined,
        // 员工确认时看到的赠金有效期；期间店主调整了有效期时服务端拒绝，按新的重新确认
        bonusValidDays: bonus ? bonusValidDays : undefined,
      },
      meta: {
        memberId: member.id,
        memberName: member.name,
        amount: paid ?? 0,
        summary: [plan?.name ?? '自定义金额', method ? PAYMENT_METHOD_LABELS[method] : '', bonus ? `赠金 ${formatYuan(bonus)}` : '']
          .filter(Boolean)
          .join(' · '),
        staffName: session.staff.displayName,
      },
    }),
  });

  // 这位会员有之前留下的待确认充值：先处理它，再开始新的一笔
  useEffect(() => {
    const pending = findPending(member.id, 'recharge');
    if (pending) op.adopt(pending);
  }, [member.id]); // 只在打开面板（或切换会员）时检查一次

  useEffect(() => {
    if (op.state.status === 'success') setStep('result');
    if (op.state.status === 'error' && ['PLAN_CHANGED', 'PLAN_UNAVAILABLE'].includes(op.state.error.code)) {
      void qc.invalidateQueries({ queryKey: ['catalog'] });
      void qc.invalidateQueries({ queryKey: qk.session });
      setPlanId(null);
      setStep('form');
      setFormError(op.state.error.message);
    }
    // 没有开班或班次刚交班（R1.2 收款前必须先开班）：刷新当前班次，页面上出现开班提示
    if (op.state.status === 'error' && SHIFT_ERRORS.includes(op.state.error.code)) void qc.invalidateQueries({ queryKey: shiftKeys.all });
    // 授权过期、已用过或与金额不符：作废这次授权，重新请店主或店总授权；上限刚被调整时刷新规则
    if (op.state.status === 'error' && /^(GRANT_|OVER_LIMIT_)/.test(op.state.error.code)) {
      setGrant(null);
      if (op.state.error.code === 'OVER_LIMIT_AUTH_REQUIRED') void qc.invalidateQueries({ queryKey: qk.session });
    }
  }, [op.state, qc]);

  const toConfirm = () => {
    if (planId === null) return setFormError('请选择充值套餐或自定义金额');
    if (!paid || paid <= 0) return setFormError('请填写正确的实收金额（最多两位小数）');
    if (bonus === null) return setFormError('赠金格式不正确');
    if (!method) return setFormError('请选择收款方式');
    setFormError(null);
    setConfirmed(false);
    op.reset();
    setStep('confirm');
  };

  const busy = isBusy(op.state);
  const locked = isLocked(op.state);
  const shiftReady = useShiftReady();

  if (op.adopted && op.state.status !== 'success') {
    return (
      <FlowFrame title="会员充值" tone="pine" member={member} step="confirm" onClose={onClose} closeDisabled={op.state.status === 'submitting'}>
        <PendingRecovery op={op.adopted} state={op.state} onCheck={op.check} onRetry={op.retry} onDiscard={op.discard} />
      </FlowFrame>
    );
  }

  if (step === 'result' && op.state.status === 'success') {
    const r = op.state.result as Extract<OperationResult, { type: 'recharge' }>;
    return (
      <FlowFrame
        title="会员充值"
        tone="pine"
        member={r.member}
        step="result"
        onClose={onClose}
        footer={
          <div className="flex gap-2.5">
            <Button variant="secondary" size="lg" className="flex-1" onClick={onSwitchToConsume}>
              接着登记消费
            </Button>
            <Button variant="primary" size="lg" className="flex-1" onClick={onClose} data-autofocus>
              完成
            </Button>
          </div>
        }
      >
        <SuccessHeader title="充值已入账" docNo={r.recharge.docNo} recovered={op.state.recovered} />
        <div className="rounded-lg border border-line bg-card px-4 py-1">
          <SummaryRow label="实收金额">
            <Money cents={r.recharge.paidAmount} className="text-lake" />
          </SummaryRow>
          <SummaryRow label="收款方式">{PAYMENT_METHOD_LABELS[r.recharge.paymentMethod]}</SummaryRow>
          {r.recharge.bonusAmount > 0 && (
            <SummaryRow label="赠金">
              <Money cents={r.recharge.bonusAmount} className="text-yuzu-deep" signed />
            </SummaryRow>
          )}
          {r.recharge.bonusAmount > 0 && (
            <SummaryRow label="赠金有效期">
              {r.recharge.bonusExpiresAt ? `至 ${lastUsableDate(r.recharge.bonusExpiresAt, session.timezone, session.rules.businessDayStartHour)}` : '长期有效'}
            </SummaryRow>
          )}
          <SummaryRow label="经办">{r.recharge.operatorName}</SummaryRow>
          {r.recharge.overLimitApproverName && <SummaryRow label="超限授权">{r.recharge.overLimitApproverName}</SummaryRow>}
        </div>
        <p className="mt-5 mb-2 text-[13px] font-bold text-ink-2">余额变化</p>
        <BalanceChange before={r.balanceBefore} after={r.balanceAfter} animate />
      </FlowFrame>
    );
  }

  if (step === 'confirm') {
    return (
      <FlowFrame
        title="会员充值"
        tone="pine"
        member={member}
        step="confirm"
        onClose={onClose}
        closeDisabled={op.state.status === 'submitting'}
        footer={
          <div className="flex gap-2.5">
            <Button
              variant="secondary"
              size="lg"
              icon={<ArrowLeft className="size-4" />}
              disabled={busy || locked}
              onClick={() => {
                op.reset();
                setStep('form');
              }}
            >
              返回修改
            </Button>
            <Button
              variant="primary"
              size="lg"
              className="flex-1"
              disabled={!confirmed || !grantOk || locked || !shiftReady.ready}
              loading={op.state.status === 'submitting'}
              onClick={op.submit}
            >
              确认入账 {paid ? formatYuan(paid) : ''}
            </Button>
          </div>
        }
      >
        <div className="mb-4 empty:hidden">
          <ShiftGate action="充值" />
        </div>
        <div className="rounded-lg border border-line bg-card p-4">
          <p className="text-[12.5px] font-semibold text-ink-3">本次实收</p>
          <div className="mt-1 flex items-end justify-between gap-3">
            <Money cents={paid ?? 0} className="text-[34px] leading-none font-bold text-lake" />
            <span className="mb-1 rounded-full bg-lake-soft px-2.5 py-1 text-[12.5px] font-bold text-lake">
              {method ? PAYMENT_METHOD_LABELS[method] : ''}
            </span>
          </div>
          <div className="mt-4 border-t border-dashed border-line pt-1">
            <SummaryRow label="充值方案">{plan ? plan.name : '自定义金额'}</SummaryRow>
            <SummaryRow label="计入本金">
              <Money cents={paid ?? 0} className="text-pine" signed />
            </SummaryRow>
            <SummaryRow label="赠金">
              <Money cents={bonus ?? 0} className={bonus ? 'text-yuzu-deep' : 'text-ink-4'} signed />
            </SummaryRow>
            {bonus ? <SummaryRow label="赠金有效期">{bonusValidText}</SummaryRow> : null}
            {planGifts.length > 0 && (
              <SummaryRow label="另赠券">
                <span data-testid="coupon-plan-gifts-confirm">{planGifts.map(planGiftText).join('、')}</span>
              </SummaryRow>
            )}
            {paymentRef && <SummaryRow label="收款备注">{paymentRef}</SummaryRow>}
            {note && <SummaryRow label="备注">{note}</SummaryRow>}
          </div>
        </div>

        {overLimit && (
          <OverLimitCard
            kind="recharge"
            limit={limit}
            scope={grantScope}
            memberName={member.name}
            grant={grantOk ? grant : null}
            disabled={busy || locked}
            onGranted={(g) => {
              setGrant(g);
              if (op.state.status === 'error') op.reset();
            }}
          />
        )}

        <p className="mt-5 mb-2 text-[13px] font-bold text-ink-2">入账后余额</p>
        <BalanceChange before={before} after={after} />

        <div className="mt-5">
          <ConfirmCheck checked={confirmed} onChange={setConfirmed}>
            我已核实 <span className="num font-bold text-lake">{formatYuan(paid ?? 0)}</span> 已通过
            {method ? PAYMENT_METHOD_LABELS[method] : ''}到账
          </ConfirmCheck>
        </div>
        <div className="mt-4">
          <OperationStatus state={op.state} onCheck={op.check} onRetry={op.retry} onDiscard={op.discard} />
        </div>
      </FlowFrame>
    );
  }

  return (
    <FlowFrame
      title="会员充值"
      tone="pine"
      member={member}
      step="form"
      onClose={onClose}
      footer={
        <Button variant="primary" size="lg" className="w-full" onClick={toConfirm} disabled={catalog.isPending}>
          下一步：核对收款
        </Button>
      }
    >
      <div className="mb-4 empty:hidden">
        <ShiftGate action="充值" />
      </div>
      <div className="flex items-center justify-between">
        <p className="text-[13px] font-bold text-ink-2">充值方案</p>
        <PendingBadge title="实际充值与赠送方案待店主确认，当前为模拟方案" />
      </div>
      {catalog.isPending ? (
        <div className="mt-3 grid grid-cols-2 gap-2.5">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[84px]" />
          ))}
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-2.5">
          {plans.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPlanId(p.id)}
              aria-pressed={planId === p.id}
              className={cn(
                'relative flex min-h-[84px] flex-col items-start rounded-lg border bg-card px-3.5 py-3 text-left transition-all',
                planId === p.id ? 'border-pine shadow-[0_0_0_3px_rgb(36_73_58/0.12)]' : 'border-line hover:border-line-strong',
              )}
            >
              <span className="text-[13px] font-semibold text-ink-2">{p.name}</span>
              <Money cents={p.payAmount} className="mt-1 text-[20px] font-bold text-ink" />
              {p.bonusAmount > 0 ? (
                <span className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                  <span className="inline-flex items-center gap-1 rounded-full bg-yuzu-soft px-2 py-0.5 text-[12px] font-bold text-yuzu-deep">
                    <Gift className="size-3" />送 <Money cents={p.bonusAmount} />
                  </span>
                  {p.bonusValidDays && <span className="text-[11.5px] font-semibold text-ink-3">{p.bonusValidDays} 天有效</span>}
                </span>
              ) : (
                <span className="mt-1 text-[12px] text-ink-3">无赠送</span>
              )}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setPlanId('custom')}
            aria-pressed={planId === 'custom'}
            className={cn(
              'flex min-h-[84px] flex-col items-start justify-center rounded-lg border border-dashed bg-card/60 px-3.5 py-3 text-left transition-all',
              planId === 'custom' ? 'border-pine bg-card shadow-[0_0_0_3px_rgb(36_73_58/0.12)]' : 'border-line-strong hover:border-ink-4',
            )}
          >
            <span className="text-[14px] font-bold text-ink">自定义金额</span>
            <span className="mt-0.5 text-[12px] text-ink-3">{canCustomBonus ? '手动填写实收与赠金' : '只计本金，不含赠金'}</span>
          </button>
        </div>
      )}

      {planGifts.length > 0 && (
        <div className="mt-3 animate-rise rounded-lg border border-dashed border-yuzu-deep/35 bg-yuzu-tint px-3.5 py-2.5" data-testid="coupon-plan-gifts">
          {planGifts.map((g, i) => (
            <p key={`${g.templateId}-${i}`} className="flex items-center gap-1.5 text-[13px] font-bold text-yuzu-deep">
              <Ticket className="size-4 shrink-0" />
              另赠：{planGiftText(g)}
            </p>
          ))}
          <p className="mt-0.5 text-[12px] text-ink-3">入账时发到会员账户，与赠金分开；限定了等级的券按充值后的会员等级发，等级不在里面的不发</p>
        </div>
      )}

      {planId === 'custom' && (
        <div className="mt-4 grid animate-rise gap-4 rounded-lg border border-line bg-card p-4">
          <Field label="实收金额" htmlFor="paid" hint="实际收到的钱，等额计入本金">
            <MoneyInput id="paid" large value={paidText} onChange={(e) => setPaidText(e.target.value)} placeholder="0.00" autoFocus />
          </Field>
          {canCustomBonus ? (
            <Field label="赠金" htmlFor="bonus" hint="不填即为 0">
              <MoneyInput id="bonus" value={bonusText} onChange={(e) => setBonusText(e.target.value)} placeholder="0.00" />
            </Field>
          ) : (
            <p className="text-[12.5px] text-ink-3">自定义赠金需店主操作；有赠送请选择上方套餐。</p>
          )}
        </div>
      )}

      <p className="mt-6 mb-3 text-[13px] font-bold text-ink-2">收款方式</p>
      <div className="grid grid-cols-5 gap-2">
        {PAYMENT_METHODS.map((m) => {
          const Icon = METHOD_ICONS[m];
          const active = method === m;
          return (
            <button
              key={m}
              type="button"
              onClick={() => setMethod(m)}
              aria-pressed={active}
              className={cn(
                'flex h-[68px] flex-col items-center justify-center gap-1.5 rounded-lg border text-[12.5px] font-semibold transition-all',
                active ? 'border-lake bg-lake-soft/70 text-lake' : 'border-line bg-card text-ink-2 hover:border-line-strong',
              )}
            >
              <Icon className="size-5" strokeWidth={active ? 2.2 : 1.8} />
              {PAYMENT_METHOD_LABELS[m]}
            </button>
          );
        })}
      </div>

      <div className="mt-5 grid gap-4">
        <Field label="收款备注" htmlFor="ref" hint="选填，如支付单号后 4 位，便于对账">
          <Input id="ref" value={paymentRef} maxLength={64} onChange={(e) => setPaymentRef(e.target.value)} placeholder="选填" />
        </Field>
        <Field label="备注" htmlFor="note">
          <Input id="note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="选填" />
        </Field>
      </div>

      {paid != null && paid > 0 && planId !== null && (
        <div className="mt-5 flex items-center justify-between rounded-lg bg-pine-tint px-4 py-3 text-[13px]">
          <span className="font-semibold text-ink-2">充值后可用余额</span>
          <Money cents={after.principal + after.bonus} className="text-[17px] font-bold text-pine" />
        </div>
      )}
      {formError && <Notice tone="error" className="mt-4" title={formError} />}
    </FlowFrame>
  );
}
