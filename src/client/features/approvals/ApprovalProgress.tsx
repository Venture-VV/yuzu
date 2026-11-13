// 单据详情里的「审批进度」（v0.7.30；8.0.17 起画成一条时间线，ApprovalTimeline）：审批链每一级、谁同意或退回、意见；原来的「确认」「退回」按钮带上看到的审批单与级别。

import { useState } from 'react';
import { Link } from 'react-router';
import { ArrowRight, RotateCcw } from 'lucide-react';
import { APPROVAL_STATUS_LABELS, inStep, type ApprovalBrief, type ApprovalDocKind } from '@shared/approvals';
import { errorMessage, UncertainError } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { cn, formatDateTime } from '../../lib/utils';
import { useToast } from '../../components/Toast';
import { Badge, Button } from '../../components/ui';
import { ApprovalTimeline } from './ApprovalTimeline';
import { sendApproval, sentLabel, useSettleWhenFinished, useUncertainApprovals, type SentApproval } from './uncertain';

/** 等了多久：12 分钟、3 小时、2 天 */
export function waited(iso: string): string {
  const min = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000));
  if (min < 60) return `${min} 分钟`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr} 小时`;
  return `${Math.floor(hr / 24)} 天`;
}

/**
 * 原来的确认、退回按钮用：在审的审批单当前这一级我能不能审（本人；代理的去审批中心审），
 * 以及要带上的审批单与级别（审批单已经变了、走到别的级别时服务端拒绝）。
 * uncertain：上次同意或退回没收到结果（uncertain.ts）——这时只给「按原内容重新提交」（ApprovalResend），不按刷新后的级别重新拼。
 */
export function useApprovalGate(approval: ApprovalBrief | null | undefined, kind: ApprovalDocKind) {
  const session = useSession();
  const uncertain = useUncertainApprovals();
  useSettleWhenFinished(approval?.requestId, approval?.status);
  if (!approval || approval.status !== 'pending') return { fence: {}, canActHere: true, waiting: null as string | null, uncertain: null as SentApproval | null };
  const step = approval.steps[approval.currentLevel - 1]!;
  const me = { id: session.staff.id, role: session.staff.role, duties: session.staff.duties, permissions: session.permissions };
  const selfBlocked = !approval.allowSelf && approval.submittedBy === me.id;
  const done = approval.approvedIds.includes(me.id) && me.role !== 'owner';
  const canActHere = !selfBlocked && !done && inStep(step, me, kind);
  const levels = approval.levels > 1 ? `第 ${approval.currentLevel}/${approval.levels} 级 · ` : '';
  return {
    fence: { requestId: approval.requestId, level: approval.currentLevel },
    canActHere,
    waiting: canActHere ? null : `${levels}等「${approval.stepLabels[approval.currentLevel - 1]}」审批${selfBlocked ? '（提交人不能审自己的单）' : ''}`,
    uncertain: uncertain.get(approval.requestId),
  };
}

/** 按原内容重新提交没收到结果的那次（原样再发，见 uncertain.ts）；busy 是正在重提的审批单 */
export function useApprovalResend(onDone: () => unknown) {
  const toast = useToast();
  const [busy, setBusy] = useState<number | null>(null);
  const resend = async (sent: SentApproval) => {
    setBusy(sent.requestId);
    try {
      await sendApproval(sent);
      toast({ tone: 'success', title: `已按原内容重新提交：${sentLabel(sent)}`, body: `${sent.docNo} · 上次已经生效的不重复记` });
    } catch (e) {
      toast({ tone: 'error', title: e instanceof UncertainError ? `还是没收到结果：${errorMessage(e)}` : errorMessage(e), body: sent.docNo });
    } finally {
      setBusy(null);
      await onDone();
    }
  };
  return { busy, resend };
}

/**
 * 上次同意或退回没收到结果：只能按原内容重新提交（原样再发，见 uncertain.ts）——已经生效的不重复记，
 * 这张单走过了这一级或已经结束的会被拒绝（那也说明上次那次不会再生效）。单据详情的底部、审批中心的详情共用。
 */
export function ApprovalResend({ sent, onDone, className }: { sent: SentApproval; onDone: () => unknown; className?: string }) {
  const { busy, resend } = useApprovalResend(onDone);
  return (
    <div className={cn('flex flex-wrap items-center justify-end gap-x-3 gap-y-1.5', className)} data-testid="approval-uncertain">
      <p className="min-w-0 flex-1 text-[12.5px] text-ink-2">
        <span className="font-semibold text-ember">上次「{sentLabel(sent)}」没收到结果</span>，可能已经生效。按原内容重新提交：已经生效的不重复记，这张单已经走过这一级的会提示。
        {sent.lastError && <span className="mt-0.5 block text-clay">上次重新提交没被受理：{sent.lastError}</span>}
      </p>
      <Button variant="primary" loading={busy === sent.requestId} icon={<RotateCcw className="size-4" />} onClick={() => void resend(sent)} data-testid="approval-resend">
        按原内容重新提交
      </Button>
    </div>
  );
}

export function ApprovalProgress({ approval, className }: { approval: ApprovalBrief | null | undefined; className?: string }) {
  const can = useCan();
  const session = useSession();
  if (!approval) return null;
  const centerOn = session.erpModules.includes('approvals') && (can('approval.act') || can('inventory.approve') || can('expense.approve'));
  return (
    <section className={className} data-testid="approval-progress">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-[13px] font-bold text-ink-2">审批进度</h3>
        <Badge tone={approval.status === 'approved' ? 'pine' : approval.status === 'pending' ? (approval.overdue ? 'clay' : 'yuzu') : 'neutral'}>
          {approval.status === 'pending' && approval.overdue ? '超时' : APPROVAL_STATUS_LABELS[approval.status]}
        </Badge>
        <span className="text-[12px] text-ink-3">{approval.ruleId ? '按审批规则' : '默认规则'}</span>
        {centerOn && approval.status === 'pending' && (
          <Link to={`/approvals?open=${approval.requestId}`} className="ml-auto flex items-center gap-0.5 text-[12.5px] font-semibold text-lake hover:underline">
            审批中心 <ArrowRight className="size-3.5" />
          </Link>
        )}
      </div>
      <ApprovalTimeline
        testIdPrefix="approval-level"
        waitedText={waited(approval.levelStartedAt)}
        overdue={approval.overdue}
        levels={approval.stepLabels.map((label, i) => {
          const level = i + 1;
          const actions = approval.actions.filter((x) => x.level === level);
          const current = approval.status === 'pending' && level === approval.currentLevel;
          const done = approval.status === 'approved' || level < approval.currentLevel;
          return { level, label, actions, state: actions.some((x) => x.action === 'return') ? 'returned' : done ? 'done' : current ? 'current' : 'pending' };
        })}
      />
    </section>
  );
}
