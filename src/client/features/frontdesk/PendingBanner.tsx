import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Hourglass } from 'lucide-react';
import type { FrontdeskOpLookup } from '@shared/frontdesk';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/utils';
import { Money } from '../../components/Money';
import { useToast } from '../../components/Toast';
import { FRONTDESK_OP_LABELS, isBookingOp, isRoomOp, isTableOp, isUsageOp, removeFrontdeskPending, useFrontdeskPendingForBanner, type FrontdeskPendingOp } from './pending';

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
            if (isTableOp(op.type)) void qc.invalidateQueries({ queryKey: ['dining'] });
            if (isRoomOp(op.type) || isUsageOp(op.type)) void qc.invalidateQueries({ queryKey: ['rooms'] });
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
    // 桌台的操作到餐饮页处理：桌台点单回到点单页的那一桌；开台、桌台结账回到「桌台」页（开台带桌台，结账带开台）
    if (isTableOp(op.type)) {
      const s = op.sessionIds?.[0];
      if (op.type === 'table_post' && s) {
        navigate(`/dining/order?table=${s}`);
        return;
      }
      if (op.tableId) params.set('t', String(op.tableId));
      if (s) params.set('s', String(s));
      navigate(`/dining/tables?${params}`);
      return;
    }
    // 客房的操作到客房页处理：入住回到那间房的入住对话框，其余回到那张入住单
    if (isRoomOp(op.type)) {
      if (op.roomId) params.set('r', String(op.roomId));
      if (op.stayIds?.[0]) params.set('s', String(op.stayIds[0]));
      navigate(`/rooms?${params}`);
      return;
    }
    // 派对房等的使用单（v0.7.19）到客房页的平面图处理：开单回到那间房的开单对话框，结束、撤单回到那张使用单
    if (isUsageOp(op.type)) {
      params.set('view', 'map');
      if (op.spaceId) params.set('sp', String(op.spaceId));
      if (op.usageIds?.[0]) params.set('u', String(op.usageIds[0]));
      navigate(`/rooms?${params}`);
      return;
    }
    // 预约（v0.7.28）到「预约」页处理：改动回到那张预约单
    if (isBookingOp(op.type)) {
      if (op.bookingIds?.[0]) params.set('b', String(op.bookingIds[0]));
      navigate(`/bookings?${params}`);
      return;
    }
    // 退款单（v0.7.20）回到前台「结账记录」里的原结账单
    if (op.type === 'checkout_refund' && op.checkoutIds?.[0]) params.set('c', String(op.checkoutIds[0]));
    if (op.visitId) params.set('v', String(op.visitId));
    navigate(`/frontdesk?${params}`);
  };
  const anyTable = ops.some((op) => isTableOp(op.type));
  const anyRoom = ops.some((op) => isRoomOp(op.type) || isUsageOp(op.type));
  const objects = ['手牌', ...(anyTable ? ['桌台'] : []), ...(anyRoom ? ['房间'] : [])];

  return (
    <div role="status" data-testid="frontdesk-pending-banner" className="shrink-0 border-b border-yuzu-deep/25 bg-yuzu-tint px-5 py-2.5 md:px-7">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex items-center gap-2 text-[13.5px] font-bold text-yuzu-deep">
          <Hourglass className="size-4" />
          {ops.length} 笔前台操作结果待确认，处理前请勿对同一{objects.length > 2 ? `${objects.slice(0, -1).join('、')}或${objects.at(-1)}` : objects.join('或')}重复登记
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
