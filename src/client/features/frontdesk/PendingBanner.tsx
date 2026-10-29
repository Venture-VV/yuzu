import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Hourglass } from 'lucide-react';
import type { FrontdeskOpLookup } from '@shared/frontdesk';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/utils';
import { Money } from '../../components/Money';
import { useToast } from '../../components/Toast';
import { FRONTDESK_OP_LABELS, removeFrontdeskPending, useFrontdeskPendingForBanner, type FrontdeskPendingOp } from './pending';

/**
 * 页面顶部的前台「结果待确认」提醒（刷新、重新登录后仍在）。
 * 进入页面时按原操作编号只读查回：已生效或已作废的直接移除；查不到的保留，由员工进入对应对话框处理。
 */
export function FrontdeskPendingBanner() {
  const ops = useFrontdeskPendingForBanner();
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
          .get<FrontdeskOpLookup>(`/api/frontdesk/ops/${op.key}?type=${op.type}`)
          .then((found) => {
            if (!found.found && !found.abandoned) return;
            removeFrontdeskPending(op.key);
            void qc.invalidateQueries({ queryKey: ['frontdesk'] });
            if (found.found) {
              toast({ tone: 'success', title: `已查回：${op.tagCodes.join('、')} 的${FRONTDESK_OP_LABELS[op.type]}已生效`, body: '只生效了一次，无需重新操作。' });
            }
          })
          .catch(() => checked.current.delete(op.key));
      }
    };
    run();
    const timer = setInterval(() => {
      checked.current.clear();
      run();
    }, 60_000);
    return () => clearInterval(timer);
  }, [ops, qc, toast]);

  if (ops.length === 0) return null;

  const open = (op: FrontdeskPendingOp) => {
    const params = new URLSearchParams({ resume: op.type });
    if (op.visitId) params.set('v', String(op.visitId));
    navigate(`/frontdesk?${params}`);
  };

  return (
    <div role="status" data-testid="frontdesk-pending-banner" className="shrink-0 border-b border-yuzu-deep/25 bg-yuzu-tint px-5 py-2.5 md:px-7">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex items-center gap-2 text-[13.5px] font-bold text-yuzu-deep">
          <Hourglass className="size-4" />
          {ops.length} 笔前台操作结果待确认，处理前请勿对同一手牌重复登记
        </span>
        {ops.slice(0, 3).map((op) => (
          <span key={op.key} className="flex items-center gap-2 rounded-full bg-card py-1 pr-1 pl-3 text-[13px] ring-1 ring-yuzu-deep/20">
            <span className="num font-bold">{op.tagCodes.join('、')}</span>
            <span className="text-ink-2">{FRONTDESK_OP_LABELS[op.type]}</span>
            {op.amount !== null && <Money cents={op.amount} className="font-bold" />}
            <span className="hidden text-[12px] text-ink-3 sm:inline">
              {formatDateTime(op.createdAt)} · {op.staffName}
            </span>
            <button
              type="button"
              onClick={() => open(op)}
              className="flex h-7 items-center gap-1 rounded-full bg-pine px-3 text-[12.5px] font-bold text-paper hover:bg-pine-hover"
            >
              去处理 <ArrowRight className="size-3.5" />
            </button>
          </span>
        ))}
        {ops.length > 3 && <span className="text-[12.5px] text-ink-3">另有 {ops.length - 3} 笔</span>}
      </div>
    </div>
  );
}
