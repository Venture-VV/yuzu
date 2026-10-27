import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Hourglass } from 'lucide-react';
import type { Permission } from '@shared/permissions';
import type { OperationLookup } from '@shared/types';
import { api } from '../lib/api';
import { PENDING_LABELS, removePending, usePendingOps, type PendingOp } from '../lib/pendingOps';
import { useCan } from '../lib/session';
import { formatDateTime } from '../lib/utils';
import { Money } from './Money';
import { useToast } from './Toast';

const REQUIRED: Record<PendingOp['type'], Permission> = {
  recharge: 'recharge.create',
  consume: 'consume.create',
  reversal: 'consume.reverse',
};

function docNoOf(found: Extract<OperationLookup, { found: true }>): string {
  if (found.type === 'recharge') return found.recharge.docNo;
  if (found.type === 'consume') return found.consumption.docNo;
  return found.reversal.docNo;
}

/**
 * 页面顶部的「结果待确认」提醒。
 * 进入页面（包括刷新、重新登录）时自动按原操作编号查询：已入账或已作废的直接移除；
 * 查不到的保留，由员工进入对应流程选择「按原内容重新提交」或「确认作废」。
 */
export function PendingOpsBanner() {
  const ops = usePendingOps();
  const can = useCan();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const checked = useRef(new Set<string>());

  useEffect(() => {
    const run = () => {
      for (const op of ops) {
        if (checked.current.has(op.key)) continue;
        checked.current.add(op.key);
        api
          .get<OperationLookup>(`/api/operations/${op.key}?type=${op.type}`)
          .then((found) => {
            if (!found.found) {
              // 已确认作废的（例如作废答复在网络中丢失）直接移除；查不到的保留，不能断定没有入账
              if (found.abandoned) removePending(op.key);
              return;
            }
            removePending(op.key);
            void qc.invalidateQueries({ queryKey: ['member', op.memberId] });
            void qc.invalidateQueries({ queryKey: ['activity', op.memberId] });
            void qc.invalidateQueries({ queryKey: ['ledger'] });
            void qc.invalidateQueries({ queryKey: ['settlement'] });
            toast({
              tone: 'success',
              title: `已查回：${op.memberName} 的${PENDING_LABELS[op.type]}已入账`,
              body: `单号 ${docNoOf(found)}，只入账了一次。`,
            });
          })
          .catch(() => checked.current.delete(op.key)); // 暂时连不上，稍后再查
      }
    };
    run();
    // 仍未确定的操作每分钟再查一次（例如网络恢复后）
    const timer = setInterval(() => {
      checked.current.clear();
      run();
    }, 60_000);
    return () => clearInterval(timer);
  }, [ops, qc, toast]);

  if (ops.length === 0) return null;

  const open = (op: PendingOp) => {
    const params = new URLSearchParams({ m: String(op.memberId), resume: op.type });
    if (op.consumptionId) params.set('c', String(op.consumptionId));
    navigate(`/?${params}`);
  };

  return (
    <div role="status" className="shrink-0 border-b border-yuzu-deep/25 bg-yuzu-tint px-5 py-2.5 md:px-7">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex items-center gap-2 text-[13.5px] font-bold text-yuzu-deep">
          <Hourglass className="size-4" />
          {ops.length} 笔操作结果待确认，处理前请勿重复收款或登记
        </span>
        {ops.slice(0, 3).map((op) => (
          <span key={op.key} className="flex items-center gap-2 rounded-full bg-card py-1 pr-1 pl-3 text-[13px] ring-1 ring-yuzu-deep/20">
            <span className="font-bold">{op.memberName}</span>
            <span className="text-ink-2">{PENDING_LABELS[op.type]}</span>
            <Money cents={op.amount} className="font-bold" />
            <span className="hidden text-[12px] text-ink-3 sm:inline">
              {formatDateTime(op.createdAt)} · {op.staffName}
            </span>
            {can(REQUIRED[op.type]) ? (
              <button
                type="button"
                onClick={() => open(op)}
                className="flex h-7 items-center gap-1 rounded-full bg-pine px-3 text-[12.5px] font-bold text-paper hover:bg-pine-hover"
              >
                去处理 <ArrowRight className="size-3.5" />
              </button>
            ) : (
              <span className="px-2 text-[12px] font-semibold text-ink-3">需店主处理</span>
            )}
          </span>
        ))}
        {ops.length > 3 && <span className="text-[12.5px] text-ink-3">另有 {ops.length - 3} 笔</span>}
      </div>
    </div>
  );
}
