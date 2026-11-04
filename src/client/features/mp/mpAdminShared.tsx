// 后台「微信小程序」几页共用的：查询键、「结果待确认」的提示与修改结果待确认的面板（小程序线；第二期 2a 起线上充值这一页也用）。

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { MpAdminData } from '@shared/mp';
import { ApiError, errorMessage, UncertainError } from '../../lib/api';
import { formatDateTime } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Button, Notice } from '../../components/ui';
import { abandonUpdate, lookupUpdate, removeMpPending, sendMpOp, updateOutcome, type MpPendingOp, type MpUpdateOutcome } from './mpPending';

export const mpAdminKey = ['mp', 'admin'] as const;
const key = mpAdminKey;

/** 待确认的记录重新提交、作废时又没收到结果：记录还留在本机，稍后再处理 */
export function saveError(error: unknown): string {
  return error instanceof UncertainError ? '还是没收到结果，记录留在本机，稍后再处理；重新提交不会多做一次' : errorMessage(error);
}

type ToastFn = ReturnType<typeof useToast>;
/** 修改内容没保存成：没收到结果的记在本机（这一页上方处理），被明确拒绝的写原因 */
export function updateFailed(toast: ToastFn, error: unknown) {
  if (error instanceof UncertainError) {
    toast({
      tone: 'info',
      title: '保存结果待确认',
      body: '没收到结果，不知道改上没有。已记在本机：请在这一页上方查回、按原内容重新提交或放弃这次修改，不要另改一次。',
    });
  } else {
    toast({ tone: 'error', title: '没有保存', body: errorMessage(error) });
  }
}

export function PendingUpdates({ ops, data }: { ops: MpPendingOp[]; data: MpAdminData }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<MpPendingOp | null>(null);
  const done = useRef(new Set<string>());
  const settle = (op: MpPendingOp, outcome: MpUpdateOutcome | 'abandoned' | 'resubmitted') => {
    if (done.current.has(op.key)) return;
    done.current.add(op.key);
    removeMpPending(op.key);
    void qc.invalidateQueries({ queryKey: key });
    if (outcome === 'resubmitted') toast({ tone: 'success', title: '已保存', body: op.summary });
    else if (outcome === 'saved') toast({ tone: 'success', title: '已查回：已经改上了', body: `${op.summary}只改了一次，不用重新改。` });
    else if (outcome === 'abandoned') toast({ tone: 'success', title: '已放弃这次修改', body: `${op.summary}：内容没改，原来那次请求即使晚到也不会生效。` });
    else
      toast({
        tone: 'info',
        title: '已有结论：以现在的内容为准',
        body: `${op.summary}：这期间这一处被改过，原来那次不会再生效。请看现在的内容，需要的话再改。`,
      });
  };
  // 有新的待确认时取一次门店系统现在的内容（页面上的可能是提交之前取的）
  const opKeys = ops.map((op) => op.key).join('\n');
  useEffect(() => {
    void qc.invalidateQueries({ queryKey: key });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opKeys]);
  // 版本号变了就有结论；正在重提、放弃的那条由按钮的结果下结论
  useEffect(() => {
    for (const op of ops) {
      if (op.key === busy) continue;
      const outcome = updateOutcome(op, data);
      if (outcome) settle(op, outcome);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ops, data, busy]);
  const resubmit = async (op: MpPendingOp) => {
    setBusy(op.key);
    try {
      await sendMpOp(op);
      settle(op, 'resubmitted');
    } catch (error) {
      // 版本号已经变了：原来那次改上了，或这期间被改过；查回下结论
      if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
        const outcome = await lookupUpdate(op).catch(() => null);
        if (outcome) {
          settle(op, outcome);
          return;
        }
      }
      toast({ tone: 'error', title: '还没确认', body: saveError(error) });
    } finally {
      setBusy(null);
    }
  };
  const abandon = async (op: MpPendingOp) => {
    setBusy(op.key);
    try {
      settle(op, await abandonUpdate(op));
      setConfirming(null);
    } catch (error) {
      toast({ tone: 'error', title: error instanceof UncertainError ? '还没确认' : '没有放弃', body: saveError(error) });
    } finally {
      setBusy(null);
    }
  };
  return (
    <Notice tone="warning" title={`${ops.length} 处修改的结果待确认`}>
      <p>
        上次保存时网络断了或没收到结果，不知道改上没有。查不到时按原内容重新提交（带着原来的版本号，不会改两次），或放弃这次修改。处理完之前这一处先不能再改。
      </p>
      <ul className="mt-2 space-y-2">
        {ops.map((op) => (
          <li key={op.key} className="flex flex-wrap items-center gap-2" data-testid="mp-update-pending">
            <span className="font-semibold text-ink">{op.summary}</span>
            <span className="text-[12.5px] text-ink-3">
              {op.staffName} · {formatDateTime(op.createdAt)}
            </span>
            <Button size="sm" variant="secondary" loading={busy === op.key} disabled={busy !== null && busy !== op.key} onClick={() => void resubmit(op)}>
              按原内容重新提交
            </Button>
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirming(op)}>
              放弃这次修改
            </Button>
          </li>
        ))}
      </ul>
      {confirming && (
        <Dialog
          open
          onClose={() => setConfirming(null)}
          title="放弃这次修改"
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirming(null)}>
                先不放弃
              </Button>
              <Button variant="danger" loading={busy === confirming.key} onClick={() => void abandon(confirming)}>
                确认放弃
              </Button>
            </>
          }
        >
          <p className="text-[13.5px]">
            放弃这次修改（{confirming.summary}）：门店系统按现在的内容保存一次（内容不变），原来那次请求即使晚到也不会生效；如果其实已经改上了，会直接告诉你。
          </p>
        </Dialog>
      )}
    </Notice>
  );
}
