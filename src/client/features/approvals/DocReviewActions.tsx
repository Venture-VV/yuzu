// 单据详情里的「审批」按钮与对话框（v0.7.31 起在合同详情里，v0.7.32 挪到这里给付款申请共用）：审批单当前这一级我能审时给按钮；
// 上次没收到结果的只能按原内容重新提交；代理审的去审批中心。法务那一级（合同、合同变更）按审查清单逐条给结论。
// 打开对话框时记下这一次提交与级别，同意、退回按它发；开着时审批变了（撤回重提、到了别的级别）就提示关掉重开。

import { useEffect, useState } from 'react';
import { CircleCheck, CornerUpLeft, Gavel } from 'lucide-react';
import { isLegalStep, type ApprovalBrief, type ApprovalDocKind } from '@shared/approvals';
import { errorMessage, UncertainError } from '../../lib/api';
import { useCan, useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Button, Field, Input, Notice, Textarea } from '../../components/ui';
import { checklistBody, checklistProblem, LegalChecklistEditor, type ChecklistDraft } from '../contracts/LegalChecklist';
import { ApprovalResend, useApprovalGate } from './ApprovalProgress';
import { postDocAction } from './uncertain';

/** 审批单当前这一级我能审时给「审批」按钮；上次没收到结果的只能按原内容重新提交；代理审的去审批中心 */
export function ReviewActions({ approval, kind, docNo, urlBase, onDone }: { approval: ApprovalBrief | null; kind: ApprovalDocKind; docNo: string; urlBase: string; onDone: () => unknown }) {
  const can = useCan();
  const gate = useApprovalGate(approval, kind);
  // 打开审批对话框时的这一次提交与级别：同意、退回按它发（对不上服务端拒绝 APPROVAL_MOVED）。
  // 对话框开着时后台刷新拿到了新的一次提交（撤回、改了再提交又到这一级）或别的级别，就提示关掉重开，
  // 不把这次填的审查清单、意见算到新的提交上（Codex 自动审查 e426148）
  const [opened, setOpened] = useState<{ approval: ApprovalBrief; fence: { requestId?: number; level?: number } } | null>(null);
  const approver = can('approval.act') || can('inventory.approve') || can('expense.approve');
  // 这一级已经轮不到自己（别人审过、退回、撤回……）时收起对话框，免得以后又到这一级时自己弹出来
  const actionable = !!approval && approval.status === 'pending' && approver && !gate.uncertain && gate.canActHere;
  useEffect(() => {
    if (!actionable) setOpened(null);
  }, [actionable]);
  if (!approval || approval.status !== 'pending' || !approver) return null;
  if (gate.uncertain) return <ApprovalResend sent={gate.uncertain} onDone={onDone} />;
  if (!gate.canActHere) return gate.waiting ? <span className="text-[12.5px] text-ink-3">{gate.waiting}</span> : null;
  const moved = !!opened && (opened.fence.requestId !== gate.fence.requestId || opened.fence.level !== gate.fence.level);
  return (
    <>
      <Button size="sm" variant="primary" icon={<Gavel className="size-4" />} onClick={() => setOpened({ approval, fence: gate.fence })} data-testid={`review-open-${docNo}`}>
        审批{approval.levels > 1 ? `（第 ${approval.currentLevel}/${approval.levels} 级）` : ''}
      </Button>
      <ApproveDialog
        open={!!opened}
        onClose={() => setOpened(null)}
        approval={opened?.approval ?? approval}
        kind={kind}
        docNo={docNo}
        urlBase={urlBase}
        fence={opened?.fence ?? gate.fence}
        moved={moved}
        onDone={onDone}
      />
    </>
  );
}

function ApproveDialog({
  open,
  onClose,
  approval,
  kind,
  docNo,
  urlBase,
  fence,
  moved,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  approval: ApprovalBrief;
  kind: ApprovalDocKind;
  docNo: string;
  urlBase: string;
  fence: { requestId?: number; level?: number };
  /** 打开以后审批变了（新的一次提交或到了别的级别）：不能按这次填的提交 */
  moved: boolean;
  onDone: () => unknown;
}) {
  const session = useSession();
  const toast = useToast();
  // 法务那一级（合同、合同变更）按审查清单逐条给结论；用印、付款申请没有清单
  const legal = (kind === 'contract' || kind === 'contract_change') && isLegalStep(approval.steps[approval.currentLevel - 1]);
  const [checklist, setChecklist] = useState<ChecklistDraft>({});
  const [comment, setComment] = useState('');
  const [returning, setReturning] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<null | 'approve' | 'return'>(null);
  useResetOnOpen(open, () => {
    setChecklist({});
    setComment('');
    setReturning(false);
    setReason('');
  });
  const approveProblem = legal ? checklistProblem(checklist, 'approve') : null;
  const returnProblem = legal ? checklistProblem(checklist, 'return') : reason.trim().length < 2 ? '请写退回原因（至少 2 个字）' : null;
  const step = approval.stepLabels[approval.currentLevel - 1];

  const send = async (action: 'approve' | 'return') => {
    const body: Record<string, unknown> = action === 'approve' ? { ...fence, comment: comment.trim() } : { ...fence, reason: reason.trim() };
    if (legal && checklistBody(checklist).length) body.checklist = checklistBody(checklist);
    setBusy(action);
    try {
      await postDocAction(`${urlBase}/${action}`, body, docNo, session.staff.id);
      toast({
        tone: 'success',
        title: action === 'return' ? '已退回' : approval.currentLevel < approval.levels ? `已同意第 ${approval.currentLevel} 级` : '已同意，审批通过',
        body: docNo,
      });
      onClose();
    } catch (e) {
      toast({
        tone: 'error',
        title: e instanceof UncertainError ? `没收到结果：${errorMessage(e)}` : errorMessage(e),
        body: e instanceof UncertainError ? `${docNo} 可能已经生效，只能按原内容重新提交` : docNo,
      });
      if (e instanceof UncertainError) onClose();
    } finally {
      setBusy(null);
      await onDone();
    }
  };

  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title={`审批 ${docNo}`}
      description={`第 ${approval.currentLevel}/${approval.levels} 级 · ${step}${legal ? ' · 按审查清单逐条给结论' : ''}`}
      width="max-w-2xl"
      footer={
        returning ? (
          <>
            <Button variant="ghost" disabled={!!busy} onClick={() => setReturning(false)}>
              不退回了
            </Button>
            <Button variant="danger" loading={busy === 'return'} disabled={moved || !!returnProblem || reason.trim().length < 2} icon={<CornerUpLeft className="size-4" />} onClick={() => void send('return')} data-testid="review-return-confirm">
              确认退回
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" disabled={!!busy} icon={<CornerUpLeft className="size-4" />} onClick={() => setReturning(true)} data-testid="review-return">
              退回…
            </Button>
            <Button variant="primary" loading={busy === 'approve'} disabled={moved || !!approveProblem} icon={<CircleCheck className="size-4" />} onClick={() => void send('approve')} data-testid="review-approve">
              同意
            </Button>
          </>
        )
      }
    >
      <div className="space-y-3">
        {moved && (
          <Notice tone="warning" title="审批已经变了" data-testid="review-moved">
            打开以后这份单据撤回重提或到了别的级别，这里填的不能算到新的提交上。请关掉重新打开，看过新的内容再审。
          </Notice>
        )}
        {legal && <LegalChecklistEditor value={checklist} onChange={setChecklist} disabled={!!busy} />}
        {returning ? (
          <Field label="退回原因" htmlFor="rv-reason">
            <Textarea id="rv-reason" rows={2} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="要改什么" data-testid="review-return-reason" />
          </Field>
        ) : (
          <Field label="意见（选填）" htmlFor="rv-comment">
            <Input id="rv-comment" value={comment} maxLength={200} onChange={(e) => setComment(e.target.value)} className="h-10" />
          </Field>
        )}
        {(returning ? legal && returnProblem : approveProblem) && <p className="text-[12.5px] font-semibold text-ember">{returning ? returnProblem : `${approveProblem}（退回可以只填有问题的几条）`}</p>}
      </div>
    </Dialog>
  );
}
