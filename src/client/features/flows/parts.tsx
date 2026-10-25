import type { ReactNode } from 'react';
import { ArrowRight, CloudOff, RotateCw, Search, X } from 'lucide-react';
import type { WalletBalance } from '@shared/deduction';
import { maskPhone } from '@shared/labels';
import type { MemberSummary } from '@shared/types';
import { cn, avatarTone } from '../../lib/utils';
import { AnimatedMoney, Money } from '../../components/Money';
import { Badge, Button, IconButton, Notice } from '../../components/ui';
import type { OperationState } from './useOperation';

export type Step = 'form' | 'confirm' | 'result';

/** 流程面板外框：标题、当前会员、步骤条、内容与底部操作 */
export function FlowFrame({
  title,
  tone,
  member,
  step,
  onClose,
  children,
  footer,
}: {
  title: string;
  tone: 'pine' | 'yuzu';
  member: MemberSummary;
  step: Step;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const steps: { key: Step; label: string }[] = [
    { key: 'form', label: tone === 'pine' ? '填写' : '选择' },
    { key: 'confirm', label: '核对' },
    { key: 'result', label: '完成' },
  ];
  const index = steps.findIndex((s) => s.key === step);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={cn('relative shrink-0 px-5 pt-4 pb-4', tone === 'pine' ? 'bg-pine text-paper' : 'bg-yuzu text-ink')}>
        <div className="flex items-center justify-between">
          <h2 className="text-[17px] font-bold">{title}</h2>
          <IconButton
            label="关闭"
            onClick={onClose}
            className={cn('-mr-2', tone === 'pine' ? 'text-paper/80 hover:bg-white/10 hover:text-paper' : 'text-ink/70 hover:bg-black/5')}
          >
            <X className="size-[18px]" />
          </IconButton>
        </div>
        <div className={cn('mt-3 flex items-center gap-3 rounded-lg px-3 py-2.5', tone === 'pine' ? 'bg-white/10' : 'bg-white/45')}>
          <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-full text-[14px] font-bold', avatarTone(member.id))}>
            {member.name.slice(0, 1)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] font-bold">{member.name}</p>
            <p className={cn('num text-[12px]', tone === 'pine' ? 'text-paper/65' : 'text-ink/60')}>
              {member.memberNo} · {maskPhone(member.phone)}
            </p>
          </div>
          <div className="text-right">
            <p className={cn('text-[11px] font-semibold', tone === 'pine' ? 'text-paper/60' : 'text-ink/55')}>可用余额</p>
            <Money cents={member.principalBalance + member.bonusBalance} className="text-[15px] font-bold" />
          </div>
        </div>
        <ol className="mt-3.5 flex items-center gap-2 text-[12px] font-semibold">
          {steps.map((s, i) => (
            <li key={s.key} className="flex items-center gap-2">
              <span
                className={cn(
                  'flex items-center gap-1.5 rounded-full px-2 py-0.5',
                  i === index
                    ? tone === 'pine'
                      ? 'bg-paper text-pine'
                      : 'bg-ink text-yuzu'
                    : i < index
                      ? 'opacity-80'
                      : 'opacity-45',
                )}
              >
                <span className="num">{i + 1}</span>
                {s.label}
              </span>
              {i < steps.length - 1 && <span className="h-px w-4 bg-current opacity-30" />}
            </li>
          ))}
        </ol>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto bg-paper px-5 py-5">{children}</div>
      {footer && <div className="shrink-0 border-t border-line bg-card px-5 py-4">{footer}</div>}
    </div>
  );
}

/** 余额变化：本金、赠金分行展示「之前 → 之后」，可选动画 */
export function BalanceChange({
  before,
  after,
  animate = false,
  className,
}: {
  before: WalletBalance;
  after: WalletBalance;
  animate?: boolean;
  className?: string;
}) {
  const rows = [
    { label: '本金', key: 'principal' as const, color: 'text-pine', dot: 'bg-pine' },
    { label: '赠金', key: 'bonus' as const, color: 'text-yuzu-deep', dot: 'bg-yuzu' },
  ];
  const totalBefore = before.principal + before.bonus;
  const totalAfter = after.principal + after.bonus;
  return (
    <div className={cn('overflow-hidden rounded-lg border border-line bg-card', className)}>
      {rows.map((r) => {
        const delta = after[r.key] - before[r.key];
        return (
          <div key={r.key} className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-0">
            <span className={cn('size-2 rounded-full', r.dot)} />
            <span className="w-10 text-[13px] font-semibold text-ink-2">{r.label}</span>
            <Money cents={before[r.key]} className="text-[14px] text-ink-3" />
            <ArrowRight className="size-3.5 text-ink-4" />
            {animate ? (
              <AnimatedMoney from={before[r.key]} to={after[r.key]} className={cn('text-[16px] font-bold', r.color)} />
            ) : (
              <Money cents={after[r.key]} className={cn('text-[16px] font-bold', r.color)} />
            )}
            <span className="flex-1" />
            <Money
              cents={delta}
              signed
              className={cn('text-[13px] font-semibold', delta === 0 ? 'text-ink-4' : delta > 0 ? 'text-moss' : 'text-clay')}
            />
          </div>
        );
      })}
      <div className="flex items-center gap-3 bg-paper-2/60 px-4 py-2.5">
        <span className="size-2" />
        <span className="w-10 text-[13px] font-semibold text-ink-2">合计</span>
        <Money cents={totalBefore} className="text-[13px] text-ink-3" />
        <ArrowRight className="size-3.5 text-ink-4" />
        {animate ? (
          <AnimatedMoney from={totalBefore} to={totalAfter} className="text-[14px] font-bold text-ink" />
        ) : (
          <Money cents={totalAfter} className="text-[14px] font-bold text-ink" />
        )}
      </div>
    </div>
  );
}

/** 成功页顶部：描线勾 + 标题 + 单号 */
export function SuccessHeader({ title, docNo, recovered }: { title: string; docNo: string; recovered: boolean }) {
  return (
    <div className="flex flex-col items-center pt-2 pb-5 text-center">
      <div className="relative flex size-16 animate-pop items-center justify-center rounded-full bg-pine text-paper">
        <span className="absolute -top-1 -right-1 size-4 rounded-full bg-yuzu ring-4 ring-paper" />
        <svg viewBox="0 0 24 24" className="size-8" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <path className="draw-check" d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      </div>
      <h3 className="mt-4 text-[20px] font-bold text-ink">{title}</h3>
      <p className="num mt-1 text-[13px] font-semibold text-ink-3">单号 {docNo}</p>
      {recovered && (
        <Badge tone="lake" className="mt-2.5">
          已查回第一次提交的结果，未重复记账
        </Badge>
      )}
    </div>
  );
}

/** 提交出错 / 结果待确认 / 查询中 等状态的统一展示 */
export function OperationStatus({
  state,
  onCheck,
  onRetry,
}: {
  state: OperationState;
  onCheck: () => void;
  onRetry: () => void;
}) {
  if (state.status === 'uncertain' || state.status === 'checking') {
    return (
      <Notice
        tone="warning"
        icon={<CloudOff className="size-5" />}
        title="结果待确认"
        action={
          <Button variant="secondary" size="sm" icon={<Search className="size-4" />} loading={state.status === 'checking'} onClick={onCheck}>
            查询这笔操作的结果
          </Button>
        }
      >
        {state.status === 'checking'
          ? '正在按操作编号查询…'
          : `${state.status === 'uncertain' && state.reason === 'timeout' ? '服务器长时间没有响应' : '网络连接中断'}，这笔操作可能已经入账。请先查询结果，不要重复收款或重复登记。`}
      </Notice>
    );
  }
  if (state.status === 'not_found') {
    return (
      <Notice
        tone="info"
        title="系统中没有这笔记录"
        action={
          <Button variant="primary" size="sm" icon={<RotateCw className="size-4" />} onClick={onRetry}>
            重新提交
          </Button>
        }
      >
        刚才的操作没有入账，余额未发生变化，可以放心重新提交。
      </Notice>
    );
  }
  if (state.status === 'error') {
    return <Notice tone="error" title={state.error.message} />;
  }
  return null;
}

export function SummaryRow({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-center justify-between gap-4 py-2', className)}>
      <span className="text-[13px] text-ink-3">{label}</span>
      <span className="text-right text-[14px] font-semibold text-ink">{children}</span>
    </div>
  );
}
