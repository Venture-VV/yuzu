// 技师休假、停牌、复牌（8.0.8，B01）带操作编号、走「结果待确认」（合并前 Codex 审查 e2cb70d）：
// 发出前在本机记下编号与原请求；超时、断网、服务器出错时留在这里查回、原样重提或确认作废，
// 处理完之前这位技师不能另做停牌、复牌、休假、上牌等（迟到的原请求不会覆盖之后的操作）。

import { useState } from 'react';
import type { BoardTechnician, ClockroomBoard } from '@shared/clockroom';
import { useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { Dialog } from '../../components/Overlay';
import { Button, Field, Input, Notice } from '../../components/ui';
import { PendingPanel, useFrontdeskOp } from '../frontdesk/pending';

export type TechStateAction = 'leave' | 'suspend' | 'resume';

const TEXT: Record<TechStateAction, { title: string; description: string; confirm: string; reason: 'required' | 'optional' | 'none'; placeholder?: string }> = {
  leave: {
    title: '休假',
    description: '今天休假：不在排队里、不能派钟，「全部上牌」跳过他；只管今天，上牌即取消休假。',
    confirm: '确认休假',
    reason: 'optional',
    placeholder: '选填，例如：调休、事假',
  },
  suspend: {
    title: '停牌',
    description: '停牌一直停到复牌（跨天）：停牌的不能上牌、不能派钟，「全部上牌」跳过他。原因记进钟房日志。',
    confirm: '确认停牌',
    reason: 'required',
    placeholder: '例如：迟到、培训、身体不适',
  },
  resume: { title: '复牌', description: '复牌以后回到未上牌，可以上牌、派钟。', confirm: '确认复牌', reason: 'none' },
};

export const TECH_STATE_DONE: Record<TechStateAction, string> = { leave: '今天休假', suspend: '已停牌', resume: '已复牌' };

const doneOnFound = () => true as const;

export function TechStateDialog({
  technician,
  action,
  onClose,
  onDone,
}: {
  technician: BoardTechnician | null;
  action: TechStateAction;
  onClose: () => void;
  /** 生效了：直接返回的新看板；查回、作废后为 null（按最新的看板刷新） */
  onDone: (board: ClockroomBoard | null, settled: 'done' | 'checked') => void;
}) {
  const session = useSession();
  const [reason, setReason] = useState('');
  useResetOnOpen(!!technician, () => setReason(''));
  const op = useFrontdeskOp<ClockroomBoard | true>({
    type: 'technician_state',
    visitId: null,
    technicianId: technician?.id ?? null,
    staffName: session.staff.displayName,
    pick: doneOnFound,
  });
  if (!technician) return null;
  // 有待确认的那一笔时，按那一笔原来的动作显示（从顶部提醒、或点了别的按钮打开）
  const pendingAction = (op.pending?.body as { action?: TechStateAction } | undefined)?.action;
  const shown = pendingAction ?? action;
  const t = TEXT[shown];
  const label = `${technician.techNo} 号 ${technician.name}`;
  const trimmed = reason.trim();
  const problem = t.reason === 'required' && trimmed.length < 2 ? '请写原因（至少 2 个字）' : null;

  const submit = async () => {
    const result = await op.submit((key) => ({
      url: `/api/clockroom/technicians/${technician.id}/state`,
      body: { action, ...(t.reason !== 'none' && trimmed ? { reason: trimmed } : {}), clientKey: key },
      tagCodes: [label],
      summary: `${t.title}${t.reason !== 'none' && trimmed ? `：${trimmed}` : ''}`,
      amount: null,
    }));
    if (result) onDone(result === true ? null : result, 'done');
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${t.title} · ${label}`}
      description={t.description}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {op.pending ? '先关掉' : '取消'}
          </Button>
          <Button variant="primary" disabled={!!problem || op.locked} loading={op.busy} onClick={() => void submit()} data-testid="tech-state-confirm">
            {t.confirm}
          </Button>
        </>
      }
    >
      <PendingPanel op={op} onResolved={(r) => onDone(r === true ? null : r, 'checked')} />
      {t.reason !== 'none' && !op.pending && (
        <Field label={t.reason === 'required' ? '原因' : '原因（选填）'} htmlFor="tech-state-reason">
          <Input id="tech-state-reason" value={reason} maxLength={100} placeholder={t.placeholder} onChange={(e) => setReason(e.target.value)} data-autofocus />
        </Field>
      )}
      {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} className="mt-4" />}
    </Dialog>
  );
}
