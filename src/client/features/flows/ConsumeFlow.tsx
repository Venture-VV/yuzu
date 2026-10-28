import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Minus, Plus, Trash2, Wallet } from 'lucide-react';
import { splitDeduction, type DeductionRule, type WalletBalance } from '@shared/deduction';
import { overLimitGrantFits, type OverLimitGrant } from '@shared/grants';
import { DEDUCTION_RULE_LABELS } from '@shared/labels';
import { formatYuan, parseYuan } from '@shared/money';
import type { MemberDetail, OperationResult, ServiceItem } from '@shared/types';
import { findPending } from '../../lib/pendingOps';
import { CartLineName, cartKey, cartLines as toCartLines, ItemCard } from '../catalog/ItemCard';
import { qk, useCatalog } from '../../lib/queries';
import { useCan, useSession } from '../../lib/session';
import { cn } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { Button, Field, Input, MoneyInput, Notice, PendingBadge, Skeleton } from '../../components/ui';
import { BalanceChange, FlowFrame, OperationStatus, OverLimitCard, PendingRecovery, SuccessHeader, SummaryRow, type Step } from './parts';
import { isBusy, isLocked, useOperation } from './useOperation';

interface CustomLine {
  name: string;
  amountText: string;
}

export function ConsumeFlow({
  member,
  onClose,
  onSwitchToRecharge,
}: {
  member: MemberDetail;
  onClose: () => void;
  onSwitchToRecharge: () => void;
}) {
  const can = useCan();
  const session = useSession();
  const qc = useQueryClient();
  const catalog = useCatalog();
  const items = catalog.data?.items ?? [];

  const [step, setStep] = useState<Step>('form');
  /** 键为「项目:价格档」，值为数量 */
  const [cart, setCart] = useState<Map<string, number>>(new Map());
  const [custom, setCustom] = useState<CustomLine | null>(null);
  const [note, setNote] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 确认时看到的余额，提交给服务端校验（其他终端同时操作时要求重新确认）
  const [seenBalance, setSeenBalance] = useState<WalletBalance>({ principal: member.principalBalance, bonus: member.bonusBalance });
  // 服务端告知扣款规则已调整时，核对页按新规则重新计算，等员工再次确认
  const [ruleOverride, setRuleOverride] = useState<DeductionRule | null>(null);
  const activeRule = ruleOverride ?? session.rules.deductionRule;
  /** 超过单笔上限时店主或店总的当场授权 */
  const [grant, setGrant] = useState<OverLimitGrant | null>(null);

  const groups = useMemo(() => {
    const map = new Map<string, ServiceItem[]>();
    for (const item of items) {
      const key = item.category || '其他';
      map.set(key, [...(map.get(key) ?? []), item]);
    }
    return [...map];
  }, [items]);

  const cartLines = toCartLines(cart, items);
  const customAmount = custom ? parseYuan(custom.amountText) : null;
  const total = cartLines.reduce((s, l) => s + l.amount, 0) + (customAmount ?? 0);
  const balance = { principal: member.principalBalance, bonus: member.bonusBalance };
  const available = balance.principal + balance.bonus;
  const split = total > 0 ? splitDeduction(total, balance, activeRule) : null;
  const confirmSplit = total > 0 ? splitDeduction(total, seenBalance, activeRule) : null;
  const limit = session.rules.maxConsumeCents;
  const overLimit = total > limit;
  const grantScope = { kind: 'consume' as const, memberId: member.id, amount: total };
  const grantOk = !overLimit || overLimitGrantFits(grant, grantScope);

  const add = (key: string, delta: number) =>
    setCart((prev) => {
      const next = new Map(prev);
      const qty = Math.max(0, Math.min(99, (next.get(key) ?? 0) + delta));
      if (qty === 0) next.delete(key);
      else next.set(key, qty);
      return next;
    });

  const op = useOperation({
    type: 'consume',
    url: '/api/consumptions',
    build: (idempotencyKey) => ({
      body: {
        idempotencyKey,
        memberId: member.id,
        lines: cartLines.map((l) => ({ itemId: l.item.id, quantity: l.qty, tier: l.tier })),
        customLines: custom && customAmount ? [{ name: custom.name.trim() || '其他消费', amount: customAmount }] : [],
        note,
        expectedTotal: total,
        expectedBalance: seenBalance,
        // 员工在核对页确认的本金 / 赠金扣款构成，服务端必须按此入账
        expectedSplit: confirmSplit?.ok ? { principal: confirmSplit.principal, bonus: confirmSplit.bonus } : undefined,
        overLimitGrantId: overLimit ? grant?.grantId : undefined,
      },
      meta: {
        memberId: member.id,
        memberName: member.name,
        amount: total,
        summary: [
          ...cartLines.map((l) => `${l.name}${l.qty > 1 ? ` ×${l.qty}` : ''}`),
          ...(custom && customAmount ? [custom.name.trim() || '其他消费'] : []),
        ].join('、'),
        staffName: session.staff.displayName,
      },
    }),
  });

  // 这位会员有之前留下的待确认消费：先处理它，再开始新的一笔
  useEffect(() => {
    const pending = findPending(member.id, 'consume');
    if (pending) op.adopt(pending);
  }, [member.id]); // 只在打开面板（或切换会员）时检查一次

  useEffect(() => {
    const s = op.state;
    if (s.status === 'success') setStep('result');
    if (s.status !== 'error' || op.adopted) return;
    if (s.error.code === 'BALANCE_CHANGED') {
      void qc.invalidateQueries({ queryKey: ['member', member.id] });
      void qc.invalidateQueries({ queryKey: ['activity', member.id] });
      setNotice('会员余额刚刚有变化（可能其他终端在操作），已刷新为最新余额，请再次核对。');
      setStep('form');
      op.reset();
    } else if (s.error.code === 'SPLIT_CHANGED') {
      const details = s.error.details as { rule?: DeductionRule; balance?: WalletBalance } | undefined;
      void qc.invalidateQueries({ queryKey: ['session'] });
      if (details?.rule) setRuleOverride(details.rule);
      if (details?.balance) setSeenBalance(details.balance);
      setNotice(`扣款规则刚刚调整为「${DEDUCTION_RULE_LABELS[details?.rule ?? activeRule].title}」，本金 / 赠金的扣款构成已更新，请核对后再次确认。`);
      op.reset();
    } else if (s.error.code === 'PRICE_CHANGED' || s.error.code === 'ITEM_UNAVAILABLE') {
      void qc.invalidateQueries({ queryKey: ['catalog'] });
      setNotice(s.error.message);
      setStep('form');
      op.reset();
    } else if (/^(GRANT_|OVER_LIMIT_)/.test(s.error.code)) {
      // 授权过期、已用过或与金额不符：作废这次授权，重新请店主或店总授权；上限刚被调整时刷新规则
      setGrant(null);
      if (s.error.code === 'OVER_LIMIT_AUTH_REQUIRED') void qc.invalidateQueries({ queryKey: qk.session });
    }
  }, [op.state, op.adopted, qc, member.id, op.reset, activeRule]);

  const toConfirm = () => {
    if (total <= 0) return setFormError('请至少选择一个消费项目');
    if (custom && (customAmount === null || customAmount <= 0)) return setFormError('请填写正确的其他消费金额');
    if (split && !split.ok) return setFormError(`余额不足，还差 ${formatYuan(split.shortfall)}`);
    setFormError(null);
    setNotice(null);
    setRuleOverride(null);
    setSeenBalance(balance);
    op.reset();
    setStep('confirm');
  };

  const busy = isBusy(op.state);
  const locked = isLocked(op.state);
  const rule = DEDUCTION_RULE_LABELS[activeRule];

  if (op.adopted && op.state.status !== 'success') {
    return (
      <FlowFrame title="登记消费" tone="yuzu" member={member} step="confirm" onClose={onClose} closeDisabled={op.state.status === 'submitting'}>
        <PendingRecovery op={op.adopted} state={op.state} onCheck={op.check} onRetry={op.retry} onDiscard={op.discard} />
      </FlowFrame>
    );
  }

  if (step === 'result' && op.state.status === 'success') {
    const r = op.state.result as Extract<OperationResult, { type: 'consume' }>;
    return (
      <FlowFrame
        title="登记消费"
        tone="yuzu"
        member={r.member}
        step="result"
        onClose={onClose}
        footer={
          <div className="flex gap-2.5">
            <Button
              variant="secondary"
              size="lg"
              className="flex-1"
              onClick={() => {
                setCart(new Map());
                setCustom(null);
                setNote('');
                op.reset();
                setStep('form');
              }}
            >
              再登记一笔
            </Button>
            <Button variant="primary" size="lg" className="flex-1" onClick={onClose} data-autofocus>
              完成
            </Button>
          </div>
        }
      >
        <SuccessHeader title="扣款完成" docNo={r.consumption.docNo} recovered={op.state.recovered} />
        <div className="rounded-lg border border-line bg-card px-4 py-1">
          {r.consumption.lines.map((l) => (
            <SummaryRow key={l.id} label={`${l.name}${l.quantity > 1 ? ` ×${l.quantity}` : ''}`}>
              <Money cents={l.amount} />
            </SummaryRow>
          ))}
          <SummaryRow label="合计扣款" className="border-t border-dashed border-line">
            <Money cents={r.consumption.totalAmount} className="text-[16px]" />
          </SummaryRow>
          <SummaryRow label="其中本金 / 赠金">
            <Money cents={r.consumption.principalAmount} className="text-pine" /> <span className="text-ink-4">/</span>{' '}
            <Money cents={r.consumption.bonusAmount} className="text-yuzu-deep" />
          </SummaryRow>
          {r.consumption.overLimitApproverName && <SummaryRow label="超限授权">{r.consumption.overLimitApproverName}</SummaryRow>}
        </div>
        <p className="mt-5 mb-2 text-[13px] font-bold text-ink-2">余额变化</p>
        <BalanceChange before={r.balanceBefore} after={r.balanceAfter} animate />
      </FlowFrame>
    );
  }

  if (step === 'confirm' && confirmSplit?.ok) {
    const after = { principal: seenBalance.principal - confirmSplit.principal, bonus: seenBalance.bonus - confirmSplit.bonus };
    return (
      <FlowFrame
        title="登记消费"
        tone="yuzu"
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
            <Button variant="primary" size="lg" className="flex-1" disabled={locked || !grantOk} loading={op.state.status === 'submitting'} onClick={op.submit} data-autofocus>
              确认扣款 {formatYuan(total)}
            </Button>
          </div>
        }
      >
        {notice && <Notice tone="warning" className="mb-4" title={notice} />}
        <div className="rounded-lg border border-line bg-card p-4">
          <p className="text-[12.5px] font-semibold text-ink-3">应扣金额</p>
          <Money cents={total} className="mt-1 text-[34px] leading-none font-bold text-ink" />
          <div className="mt-4 border-t border-dashed border-line pt-1">
            {cartLines.map((l) => (
              <SummaryRow key={l.key} label={`${l.name}${l.qty > 1 ? ` ×${l.qty}` : ''}`}>
                <Money cents={l.amount} />
              </SummaryRow>
            ))}
            {custom && customAmount ? (
              <SummaryRow label={custom.name.trim() || '其他消费'}>
                <Money cents={customAmount} />
              </SummaryRow>
            ) : null}
            {note && <SummaryRow label="备注">{note}</SummaryRow>}
          </div>
        </div>

        <div className="mt-4 rounded-lg border border-line bg-card p-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[13px] font-bold text-ink-2">扣款构成</p>
            <span className="flex items-center gap-1.5 text-[12px] text-ink-3">
              {rule.title}
              <PendingBadge />
            </span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2.5">
            <div className="rounded-md bg-pine-tint px-3 py-2.5">
              <p className="text-[12px] font-semibold text-pine/80">扣本金</p>
              <Money cents={confirmSplit.principal} className="text-[18px] font-bold text-pine" />
            </div>
            <div className="rounded-md bg-yuzu-tint px-3 py-2.5">
              <p className="text-[12px] font-semibold text-yuzu-deep/80">扣赠金</p>
              <Money cents={confirmSplit.bonus} className="text-[18px] font-bold text-yuzu-deep" />
            </div>
          </div>
        </div>

        {overLimit && (
          <OverLimitCard
            kind="consume"
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

        <p className="mt-5 mb-2 text-[13px] font-bold text-ink-2">扣款后余额</p>
        <BalanceChange before={seenBalance} after={after} />
        <div className="mt-4">
          <OperationStatus state={op.state} onCheck={op.check} onRetry={op.retry} onDiscard={op.discard} />
        </div>
      </FlowFrame>
    );
  }

  return (
    <FlowFrame
      title="登记消费"
      tone="yuzu"
      member={member}
      step="form"
      onClose={onClose}
      footer={
        <div className="flex items-center gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-semibold text-ink-3">应扣</p>
            <Money cents={total} className={cn('text-[24px] leading-tight font-bold', total ? 'text-ink' : 'text-ink-4')} />
          </div>
          <Button variant="primary" size="lg" onClick={toConfirm} disabled={total <= 0}>
            下一步：核对扣款
          </Button>
        </div>
      }
    >
      {notice && <Notice tone="warning" className="mb-4" title={notice} />}

      {catalog.isPending ? (
        <div className="grid grid-cols-2 gap-2.5">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-[66px]" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState art="leaf" title="还没有消费项目" description="店主可在「管理 → 套餐与项目」中添加；也可以直接输入其他金额。" />
      ) : (
        groups.map(([category, list]) => (
          <section key={category} className="mb-4">
            <p className="mb-2 text-[12px] font-bold tracking-wide text-ink-3">{category}</p>
            <div className="grid grid-cols-2 gap-2">
              {list.map((item) => (
                <ItemCard key={item.id} item={item} cart={cart} tone="yuzu" onAdd={(tier) => add(cartKey(item.id, tier), 1)} />
              ))}
            </div>
          </section>
        ))
      )}

      {can('consume.customAmount') &&
        (custom ? (
          <div className="mb-4 grid animate-rise grid-cols-[1fr_140px_auto] items-end gap-2 rounded-lg border border-line bg-card p-3">
            <Field label="其他消费" htmlFor="cname">
              <Input id="cname" value={custom.name} maxLength={32} onChange={(e) => setCustom({ ...custom, name: e.target.value })} placeholder="其他消费" />
            </Field>
            <Field label="金额" htmlFor="camount">
              <MoneyInput id="camount" value={custom.amountText} onChange={(e) => setCustom({ ...custom, amountText: e.target.value })} placeholder="0.00" autoFocus />
            </Field>
            <Button variant="ghost" aria-label="移除其他消费" onClick={() => setCustom(null)} className="h-11 px-3">
              <Trash2 className="size-4" />
            </Button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setCustom({ name: '', amountText: '' })}
            className="mb-4 flex h-11 w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-line-strong text-[13.5px] font-semibold text-ink-2 hover:border-ink-4 hover:bg-card"
          >
            <Plus className="size-4" /> 其他金额（不在项目列表中）
          </button>
        ))}

      {cartLines.length > 0 && (
        <div className="mb-4 overflow-hidden rounded-lg border border-line bg-card">
          {cartLines.map((l) => (
            <div key={l.key} className="flex items-center gap-3 border-b border-line px-3.5 py-2 last:border-0">
              <CartLineName line={l} className="text-[13.5px]" />
              <div className="flex items-center rounded-md border border-line">
                <button type="button" aria-label={`减少 ${l.name}`} onClick={() => add(l.key, -1)} className="flex size-9 items-center justify-center text-ink-2 hover:bg-paper-2">
                  <Minus className="size-3.5" />
                </button>
                <span className="num w-7 text-center text-[14px] font-bold">{l.qty}</span>
                <button type="button" aria-label={`增加 ${l.name}`} onClick={() => add(l.key, 1)} className="flex size-9 items-center justify-center text-ink-2 hover:bg-paper-2">
                  <Plus className="size-3.5" />
                </button>
              </div>
              <Money cents={l.amount} className="w-24 text-right text-[14px] font-bold" />
            </div>
          ))}
        </div>
      )}

      <Field label="备注" htmlFor="cnote">
        <Input id="cnote" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="选填" />
      </Field>

      <div className="mt-4 rounded-lg bg-paper-2/70 px-4 py-3 text-[13px]">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 font-semibold text-ink-2">
            <Wallet className="size-4" /> 可用余额
          </span>
          <Money cents={available} className="font-bold" />
        </div>
        {split?.ok && (
          <p className="mt-1.5 text-[12.5px] text-ink-3">
            按「{rule.title}」将扣本金 <Money cents={split.principal} className="font-semibold text-pine" />、赠金{' '}
            <Money cents={split.bonus} className="font-semibold text-yuzu-deep" />
          </p>
        )}
      </div>

      {split && !split.ok && (
        <Notice
          tone="error"
          className="mt-4"
          title={`余额不足，还差 ${formatYuan(split.shortfall)}`}
          action={
            can('recharge.create') && (
              <Button variant="secondary" size="sm" onClick={onSwitchToRecharge}>
                先去充值
              </Button>
            )
          }
        >
          储值余额不能透支。可以减少项目，或请会员先充值。
        </Notice>
      )}
      {formError && !(split && !split.ok) && <Notice tone="error" className="mt-4" title={formError} />}
    </FlowFrame>
  );
}
