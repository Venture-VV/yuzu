// ERP 单据「结果待确认」的提醒（v0.7.8）：费用报销、备用金打款与退回补付、部门需求单；v0.7.12 起还有核销、供应商退款、批量导入；
// v0.7.13 起还有对账登记；后台的空间台账导入（v0.7.14）、模拟刷卡（v0.7.17）也用它；v0.7.22 起还有供应商付款与期初未付登记。
// 进入页面时按原编号只读查回：已登记或已作废的直接移除；查不到的保留，由员工选择
// 「按原内容重新提交」（同一编号，不会重复登记）或「确认作废」（服务端登记作废，原请求晚到也不会登记）。

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CloudOff, RotateCw, Search, Trash2 } from 'lucide-react';
import { ERP_OP_LABELS, type ErpOpLookup, type ErpOpType } from '@shared/erp';
import { ApiError, errorMessage, UncertainError } from '../lib/api';
import { abandonErpOp, lookupErpOp, removeErpPending, sendErpOp, useErpPending, type ErpPendingOp } from '../lib/erpPending';
import { formatDateTime } from '../lib/utils';
import { useToast } from './Toast';
import { Button, Notice } from './ui';

export interface ErpOpRef {
  refId: number;
  advanceId?: number;
}

/** 重新提交成功时，从各接口的返回里取出单据编号 */
function refOfResponse(type: ErpOpType, data: unknown): ErpOpRef | null {
  const d = data as Record<string, { id: number } | number | undefined>;
  switch (type) {
    case 'expense_claim':
      return d.claim && typeof d.claim === 'object' ? { refId: d.claim.id } : null;
    case 'petty_advance':
      return d.advance && typeof d.advance === 'object' ? { refId: d.advance.id, advanceId: d.advance.id } : null;
    case 'petty_settlement':
      return d.advance && typeof d.advance === 'object' && typeof d.settlementId === 'number' ? { refId: d.settlementId, advanceId: d.advance.id } : null;
    case 'purchase_request':
      return d.request && typeof d.request === 'object' ? { refId: d.request.id } : null;
    case 'ap_offset':
      return d.offset && typeof d.offset === 'object' ? { refId: d.offset.id } : null;
    case 'supplier_refund':
      return d.refund && typeof d.refund === 'object' ? { refId: d.refund.id } : null;
    case 'erp_import':
    case 'space_import':
      return d.import && typeof d.import === 'object' ? { refId: d.import.id } : null;
    case 'supplier_recon':
    case 'supplier_recon_void':
      return d.reconciliation && typeof d.reconciliation === 'object' ? { refId: d.reconciliation.id } : null;
    case 'location_report':
      return typeof d.eventId === 'number' ? { refId: d.eventId } : null;
    // 券与会员权益（v0.7.20）：模板、无记名券返回自己（id），规则返回 ruleId，发券返回 issueId
    case 'coupon_template':
    case 'coupon_batch':
      return typeof d.id === 'number' ? { refId: d.id } : null;
    case 'coupon_rule':
      return typeof d.ruleId === 'number' ? { refId: d.ruleId } : null;
    // 硬件连接（v0.7.21）：登记设备返回那台设备，打印任务返回那个任务
    case 'device_create':
    case 'device_job':
    case 'doc_print':
      return typeof d.id === 'number' ? { refId: d.id } : null;
    case 'coupon_issue':
      return typeof d.issueId === 'number' ? { refId: d.issueId } : null;
    // 供应商付款、期初未付登记（v0.7.22）
    case 'payment':
      return d.payment && typeof d.payment === 'object' ? { refId: d.payment.id } : null;
    case 'opening_payable':
      return d.opening && typeof d.opening === 'object' ? { refId: d.opening.id } : null;
    // 手动调整会员档阶（v0.7.23）：返回那位会员的等级卡
    case 'grade_adjust':
      return typeof d.memberId === 'number' ? { refId: d.memberId } : null;
    // 登记会员权益使用（v0.7.24）：返回那条登记
    case 'benefit_use':
      return d.use && typeof d.use === 'object' ? { refId: d.use.id } : null;
    // 邀请体验、赠送会籍（v0.7.25）：返回那条临时身份
    case 'member_trial':
      return d.trial && typeof d.trial === 'object' ? { refId: d.trial.id } : null;
    // 会员实体卡（v0.7.28）：发卡、补卡返回那张卡
    case 'member_card':
      return d.card && typeof d.card === 'object' ? { refId: d.card.id } : null;
    // 会员体系收尾（v0.7.26）：退储值返回那张退储值单，停用 / 启用返回那位会员，合并返回那张合并单
    case 'member_refund':
      return d.refund && typeof d.refund === 'object' ? { refId: d.refund.id } : null;
    case 'member_status':
      return typeof d.memberId === 'number' ? { refId: d.memberId } : null;
    case 'member_merge':
      return d.merge && typeof d.merge === 'object' ? { refId: d.merge.id } : null;
    // 次卡（v0.7.28）：售卡、退卡都返回那张卡
    case 'count_card_sale':
    case 'count_card_refund':
      return d.card && typeof d.card === 'object' ? { refId: d.card.id } : null;
    // 平台核销补录（v0.7.28）
    case 'platform_redemption':
      return d.redemption && typeof d.redemption === 'object' ? { refId: d.redemption.id } : null;
    case 'platform_settlement':
      return d.settlement && typeof d.settlement === 'object' ? { refId: d.settlement.id } : null;
  }
}

const refOfLookup = (r: ErpOpLookup): ErpOpRef | null => (r.found && r.refId ? { refId: r.refId, advanceId: r.advanceId } : null);

export function ErpPendingPanel({
  types,
  onFound,
  className,
  filter,
}: {
  types: readonly ErpOpType[];
  onFound?: (op: ErpPendingOp, ref: ErpOpRef) => void;
  className?: string;
  /** 只列其中一部分（例如会员详情只列发给这位会员的券） */
  filter?: (op: ErpPendingOp) => boolean;
}) {
  const all = useErpPending(types);
  const ops = filter ? all.filter(filter) : all;
  const qc = useQueryClient();
  const toast = useToast();
  const checked = useRef(new Set<string>());
  const onFoundRef = useRef(onFound);
  onFoundRef.current = onFound;

  // 进入页面先查回一次：已登记、已作废的不用员工再处理。
  // 按「有哪些编号」触发，不按数组本身（v0.7.22）：传了 filter 时每次渲染都是新数组，原来每次重新渲染都会把查回失败的再查一次——
  // 断网时页面一刷新数据就再发一遍查回；网络一恢复，又会抢在员工点「按原内容重新提交」之前把这一行处理掉。
  // 没传 filter 的页面本来就只在列表变了时查。查不回的由员工点「查回」或重新提交、作废。
  const opKeys = ops.map((op) => op.key).join('\n');
  useEffect(() => {
    for (const op of ops) {
      if (checked.current.has(op.key)) continue;
      checked.current.add(op.key);
      lookupErpOp(op)
        .then((r) => {
          if (!r.found && !r.abandoned) return;
          removeErpPending(op.key);
          void qc.invalidateQueries({ queryKey: ['inv'] });
          if (r.found) {
            toast({ tone: 'success', title: `已查回：${ERP_OP_LABELS[op.type]}已登记`, body: `${op.summary}。只登记了一次，不用重新填写。` });
            const ref = refOfLookup(r);
            if (ref) onFoundRef.current?.(op, ref);
          }
        })
        .catch(() => checked.current.delete(op.key));
    }
    // ops 只在 opKeys 变了时读：同一组编号的新数组不再触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opKeys, qc, toast]);

  if (ops.length === 0) return null;
  return (
    <div className={className ?? 'space-y-2'} data-testid="erp-pending">
      {ops.map((op) => (
        <PendingRow key={op.key} op={op} onFound={onFound} />
      ))}
    </div>
  );
}

function PendingRow({ op, onFound }: { op: ErpPendingOp; onFound?: (op: ErpPendingOp, ref: ErpOpRef) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<null | 'check' | 'resend' | 'abandon'>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const label = ERP_OP_LABELS[op.type];

  const settle = (r: ErpOpLookup | null, ref: ErpOpRef | null) => {
    removeErpPending(op.key);
    void qc.invalidateQueries({ queryKey: ['inv'] });
    if (ref) {
      toast({ tone: 'success', title: `${label}已登记`, body: `${op.summary}。只登记了一次。` });
      onFound?.(op, ref);
    } else if (r?.abandoned) {
      toast({ tone: 'info', title: `${label}已作废`, body: '这笔没有登记；如仍需办理，请重新填写。' });
    }
  };

  const check = async () => {
    setBusy('check');
    setMessage(null);
    try {
      const r = await lookupErpOp(op);
      if (r.found || r.abandoned) settle(r, refOfLookup(r));
      else setMessage('服务器上暂时查不到这笔。查不到不能断定没有登记（原请求可能还在路上），请按原内容重新提交，或确认作废后再重新填写。');
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const resend = async () => {
    setBusy('resend');
    setMessage(null);
    try {
      const data = await sendErpOp<unknown>(op);
      settle(null, refOfResponse(op.type, data));
    } catch (e) {
      if (e instanceof UncertainError) {
        setMessage(e.reason === 'server' ? '服务器还是出错，结果待确认。稍后再查回或重新提交（同一编号只登记一次）。' : '仍然连不上服务器，结果待确认。稍后再查回或重新提交。');
      }
      else if (e instanceof ApiError && e.code === 'OP_ABANDONED') settle({ found: false, abandoned: true }, null);
      else setMessage(`${errorMessage(e)}（之前那次提交可能仍会登记：请先查回，确认没有登记时再确认作废）`);
    } finally {
      setBusy(null);
    }
  };

  const abandon = async () => {
    setBusy('abandon');
    setMessage(null);
    try {
      const r = await abandonErpOp(op);
      settle(r, refOfLookup(r));
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(null);
      setConfirming(false);
    }
  };

  return (
    <Notice
      tone="warning"
      icon={<CloudOff className="size-5" />}
      title={`${label}结果待确认`}
      action={
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="primary" icon={<Search className="size-4" />} loading={busy === 'check'} disabled={!!busy} onClick={() => void check()} data-testid="erp-pending-check">
            查回结果
          </Button>
          <Button size="sm" variant="secondary" icon={<RotateCw className="size-4" />} loading={busy === 'resend'} disabled={!!busy} onClick={() => void resend()} data-testid="erp-pending-resend">
            按原内容重新提交
          </Button>
          {confirming ? (
            <Button size="sm" variant="danger" icon={<Trash2 className="size-4" />} loading={busy === 'abandon'} disabled={!!busy && busy !== 'abandon'} onClick={() => void abandon()} data-testid="erp-pending-abandon-confirm">
              确认作废这笔
            </Button>
          ) : (
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setConfirming(true)} data-testid="erp-pending-abandon">
              作废这笔
            </Button>
          )}
        </div>
      }
    >
      <span className="block">
        {op.summary} · {op.staffName} · {formatDateTime(op.createdAt)}
      </span>
      <span className="block text-[12.5px]">
        上次提交时网络中断，可能已经登记，也可能没有。重新提交用同一操作编号，不会重复登记；作废后原请求即使晚到也不会登记。
      </span>
      {confirming && <span className="block text-[12.5px] font-semibold">确认作废：服务器先登记作废，如果这笔其实已经登记，会直接显示原单据，不会作废。</span>}
      {message && <span className="block text-[12.5px] font-semibold text-clay">{message}</span>}
    </Notice>
  );
}
