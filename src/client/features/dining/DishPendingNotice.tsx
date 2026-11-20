// 菜品维护「结果待确认」的处理条（8.1.16，Codex 审查 d12390f 的 P1）：查回 / 按原内容重新提交 / 确认作废。
// 菜品表上方列本机全部待确认的（弹窗开着的那一笔除外），新增 / 编辑、改价、导入的弹窗里列自己那一笔；
// 出现时自动查回一次，网络恢复时再查一次。有了结论记录就删掉，这一条随之消失。

import { useEffect, useRef, useState } from 'react';
import { Hourglass } from 'lucide-react';
import { DISH_OP_LABELS, type DishRow } from '@shared/dishes';
import { onReconnect } from '../../lib/connection';
import { formatDateTime } from '../../lib/utils';
import { useToast } from '../../components/Toast';
import { Button, Notice } from '../../components/ui';
import { abandonDishOp, checkDishOp, resendDishOp, type DishOpOutcome, type DishPendingOp } from './dishPendingStore';

type Step = 'check' | 'retry' | 'abandon';

export function DishPendingNotice({
  op,
  onApplied,
  onAbandoned,
  className,
}: {
  op: DishPendingOp;
  /** 原操作已经生效（查回到、或重新提交成功）：dish 是这道菜现在的样子（导入为空） */
  onApplied?: (dish: DishRow | null) => void;
  /** 确认没有生效（已作废）：可以重新操作 */
  onAbandoned?: () => void;
  className?: string;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<Step | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const handlers = useRef({ onApplied, onAbandoned });
  handlers.current = { onApplied, onAbandoned };

  const run = async (step: Step) => {
    setBusy(step);
    const out: DishOpOutcome = await (step === 'check' ? checkDishOp(op) : step === 'retry' ? resendDishOp(op) : abandonDishOp(op));
    setBusy(null);
    if (out.kind === 'unknown') {
      setMessage(out.message);
      return;
    }
    if (out.kind === 'applied') {
      toast({ tone: 'success', title: `${op.summary}：已经生效`, body: step === 'abandon' ? '原来那一笔已经办好了，没有作废。' : undefined });
      handlers.current.onApplied?.(out.dish);
    } else {
      toast({ tone: 'info', title: `${op.summary}：已作废，没有生效`, body: out.reason ? `按原内容重新提交被拒绝：${out.reason}` : '可以重新操作了。' });
      handlers.current.onAbandoned?.();
    }
  };

  // 出现时（刚没收到结果、刷新以后、重新打开弹窗）自动查回一次；网络恢复时再查
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    void runRef.current('check');
    return onReconnect(() => void runRef.current('check'));
  }, [op.key]);

  const target = op.itemId === null ? '这一类' : '这道菜';
  return (
    <Notice
      tone="warning"
      icon={<Hourglass className="size-4" />}
      title={`${DISH_OP_LABELS[op.type]}结果待确认：${op.summary}`}
      className={className}
      data-testid={`dish-pending-${op.type}${op.itemId === null ? '' : `-${op.itemId}`}`}
      action={
        <>
          <Button size="sm" className="min-h-11" variant="primary" loading={busy === 'check'} disabled={busy !== null} onClick={() => void run('check')} data-testid="dish-pending-check">
            查回结果
          </Button>
          <Button size="sm" className="min-h-11" variant="secondary" loading={busy === 'retry'} disabled={busy !== null} onClick={() => void run('retry')} data-testid="dish-pending-retry">
            按原内容重新提交
          </Button>
          <Button size="sm" className="min-h-11" variant="ghost" loading={busy === 'abandon'} disabled={busy !== null} onClick={() => void run('abandon')} data-testid="dish-pending-abandon">
            确认作废
          </Button>
        </>
      }
    >
      <span className="block">
        {formatDateTime(op.createdAt)} {op.staffName} 提交的，没收到结果（超时、断网或服务器出错，可能已经生效）。有结论之前{target}不能再{DISH_OP_LABELS[op.type]}。
      </span>
      {message && (
        <span className="mt-1 block font-semibold text-ink" data-testid="dish-pending-message">
          {message}
        </span>
      )}
    </Notice>
  );
}
