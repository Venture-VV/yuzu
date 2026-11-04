// 后台「微信小程序」→「线上充值」里的「原路退回」（小程序线第二期 2d，docs/MP_RECHARGE.md 第 9 节；权限 mp.recharge）：
//   · 主线退储值里交给门店系统原路退回的那一行，门店系统每分钟自己申请、查结果；这里列出来给店主看；
//   · 没退成的（没能退、退款关闭、退款异常，或连不上、余额不够还在等）可以重试或记已另行处理（写怎么处理的）；
//   · 重试、另行处理都带看到的商户退款单号：单号变了门店系统就不再动它，结果待确认时按原内容重新提交不会退两次。

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { formatYuan } from '@shared/money';
import type { MpRefundOrderAdmin, MpRefundStatus } from '@shared/mp';
import { UncertainError } from '../../lib/api';
import { useSession } from '../../lib/session';
import { formatDateTime, uuid } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Notice, Textarea } from '../../components/ui';
import { saveError } from './mpAdminShared';
import { lookupRefundOp, removeMpPending, sendMpOp, sendRefundAct, useMpPending, type MpPendingOp } from './mpPending';

const STATUS: Record<MpRefundStatus, { label: string; tone: 'neutral' | 'pine' | 'ember' | 'clay' | 'lake' }> = {
  new: { label: '待申请', tone: 'lake' },
  processing: { label: '微信处理中', tone: 'lake' },
  success: { label: '已退到', tone: 'pine' },
  abnormal: { label: '退款异常', tone: 'ember' },
  closed: { label: '退款关闭', tone: 'ember' },
  failed: { label: '没能退', tone: 'ember' },
  handled: { label: '已另行处理', tone: 'clay' },
};

const needsOwner = (r: MpRefundOrderAdmin) => r.status === 'failed' || r.status === 'closed' || r.status === 'abnormal' || (r.status === 'new' && r.failCode !== null);
const canRetry = (r: MpRefundOrderAdmin) => r.status === 'new' || ((r.status === 'failed' || r.status === 'closed') && r.outTradeNo !== null);
const canHandle = (r: MpRefundOrderAdmin) => r.status === 'failed' || r.status === 'closed' || r.status === 'abnormal';

/** 第一次重试、记另行处理就没收到结果：不知道办了没有，记录已经在本机（这一笔先不能再点），在上方查回或按原内容重新提交 */
const UNCERTAIN_BODY = '没收到结果，不知道办了没有。已记在本机：请在这一张卡片上方查回或按原内容重新提交（带同一个退款单号，不会做两次），不要另点一次。';

export function RefundsCard({ refunds, refundAuto }: { refunds: MpRefundOrderAdmin[]; refundAuto: boolean }) {
  const retries = useMpPending('refund_retry');
  const handles = useMpPending('refund_handle');
  const pending = useMemo(() => [...retries, ...handles], [retries, handles]);
  const [handling, setHandling] = useState<MpRefundOrderAdmin | null>(null);
  const attention = refunds.filter(needsOwner);
  const running = refunds.filter((r) => !needsOwner(r) && (r.status === 'new' || r.status === 'processing'));
  const done = refunds.filter((r) => r.status === 'success' || r.status === 'handled');
  if (refunds.length === 0 && pending.length === 0) {
    return (
      <Card className="p-4">
        <p className="text-[15px] font-semibold text-ink">原路退回</p>
        <p className="text-[13px] text-ink-3">
          {refundAuto
            ? '退储值时，线上充值的那一行选「门店系统原路退回」，门店系统会自己退回到顾客的微信；这里还没有。'
            : '原路退回关着：退储值时线上充值的那一行要在商户平台退、填退款单号。'}
        </p>
      </Card>
    );
  }
  return (
    <Card className="p-0">
      <div className="border-b border-line px-4 py-3">
        <p className="text-[15px] font-semibold text-ink">原路退回</p>
        <p className="text-[13px] text-ink-3">
          退储值时交给门店系统的线上充值那一行：门店系统自己向微信支付申请退款、查结果，退到顾客付款的微信（零钱或银行卡）。没退成的在这里重试或记已另行处理。
        </p>
      </div>
      {pending.length > 0 && <PendingActs ops={pending} />}
      {attention.length > 0 && (
        <div className="divide-y divide-line border-b border-line">
          {attention.map((r) => (
            <RefundRow key={r.id} r={r} busy={pending.some((p) => p.target === String(r.id))} onHandle={() => setHandling(r)} />
          ))}
        </div>
      )}
      {running.length > 0 && (
        <div className="divide-y divide-line border-b border-line">
          {running.map((r) => (
            <RefundRow key={r.id} r={r} busy={pending.some((p) => p.target === String(r.id))} onHandle={() => setHandling(r)} />
          ))}
        </div>
      )}
      {done.length > 0 && (
        <div className="divide-y divide-line">
          {done.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13.5px]" data-testid="mp-refund-done">
              <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
              <span className="font-semibold text-ink">{r.memberName}</span>
              <span className="num">{formatYuan(r.amount)}</span>
              <span className="text-ink-3">
                {r.status === 'success' ? `${r.receivedAccount ?? '原路'} · ${r.succeededAt ? formatDateTime(r.succeededAt) : ''}` : `${r.handledNote}（${r.handledByName ?? ''}）`}
              </span>
              <span className="num text-[12.5px] text-ink-3">退储值单 {r.memberRefundNo}</span>
            </div>
          ))}
        </div>
      )}
      {handling && <HandleDialog r={handling} onClose={() => setHandling(null)} />}
    </Card>
  );
}

function RefundRow({ r, busy, onHandle }: { r: MpRefundOrderAdmin; busy: boolean; onHandle: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const session = useSession();
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    setRetrying(true);
    try {
      const after = await sendRefundAct({
        key: uuid(),
        refundId: r.id,
        act: 'retry',
        outRefundNo: r.outRefundNo,
        status: r.status,
        summary: `重试原路退回：${r.memberName} ${formatYuan(r.amount)}`,
        staffName: session.staff.displayName,
      });
      toast({ tone: after.status === 'success' || after.status === 'processing' ? 'success' : 'info', title: `重试了：${STATUS[after.status].label}`, body: after.failMessage ?? undefined });
    } catch (error) {
      // 没收到结果不是「没有重试」：结果待确认（独立的浏览器用例发现的写法不一致，其他几页都写「结果待确认」）
      if (error instanceof UncertainError) toast({ tone: 'info', title: '重试的结果待确认', body: UNCERTAIN_BODY });
      else toast({ tone: 'error', title: '没有重试', body: saveError(error) });
    } finally {
      setRetrying(false);
      void qc.invalidateQueries({ queryKey: ['mp', 'recharge'] });
    }
  };
  const waiting = r.status === 'new' && r.nextTryAt;
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid="mp-refund-row">
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-ink">
          <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge> {r.memberName}{' '}
          <span className="num text-[12.5px] font-normal text-ink-3">{r.memberNo}</span> · <span className="num">{formatYuan(r.amount)}</span>
        </p>
        <p className="text-[12.5px] text-ink-3">
          退储值单 <span className="num">{r.memberRefundNo}</span> · 原充值 <span className="num">{r.rechargeDocNo}</span> · 交易单号{' '}
          <span className="num">{r.transactionId}</span> · 退款单号 <span className="num">{r.outRefundNo}</span>
        </p>
        {r.failMessage && (
          <p className="text-[12.5px] text-ember">
            {r.failMessage}
            {waiting ? `（${formatDateTime(r.nextTryAt!)} 自动再试）` : ''}
          </p>
        )}
      </div>
      {canRetry(r) && (
        <Button size="sm" variant="secondary" loading={retrying} disabled={busy} title={busy ? '这一笔的操作结果待确认，先在上方处理' : undefined} onClick={() => void retry()}>
          {r.status === 'new' ? '马上再试' : '重试'}
        </Button>
      )}
      {canHandle(r) && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={onHandle}>
          已另行处理
        </Button>
      )}
    </div>
  );
}

function HandleDialog({ r, onClose }: { r: MpRefundOrderAdmin; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const session = useSession();
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!note.trim()) return;
    setSaving(true);
    try {
      const after = await sendRefundAct({
        key: uuid(),
        refundId: r.id,
        act: 'handle',
        outRefundNo: r.outRefundNo,
        status: r.status,
        note: note.trim(),
        summary: `原路退回已另行处理：${r.memberName} ${formatYuan(r.amount)}`,
        staffName: session.staff.displayName,
      });
      // 以门店系统回来的状态为准：不是「已另行处理」就没有记上
      if (after.status === 'handled') {
        toast({ tone: 'success', title: '已记另行处理' });
        onClose();
      } else {
        toast({ tone: 'error', title: '没有记上', body: `这一笔现在是「${STATUS[after.status].label}」，请刷新后再看` });
      }
    } catch (error) {
      if (error instanceof UncertainError) {
        // 记录已经在本机、这一笔的按钮也锁住了：关掉对话框，免得再点一次又记一条待确认
        toast({ tone: 'info', title: '记另行处理的结果待确认', body: UNCERTAIN_BODY });
        onClose();
      } else {
        toast({ tone: 'error', title: '没有记上', body: saveError(error) });
      }
    } finally {
      setSaving(false);
      void qc.invalidateQueries({ queryKey: ['mp', 'recharge'] });
    }
  };
  return (
    <Dialog open onClose={onClose} title="已另行处理" description={`${r.memberName} · ${formatYuan(r.amount)} · 退储值单 ${r.memberRefundNo}`}>
      <div className="space-y-3">
        <Notice tone="info">
          门店系统不再退这一笔。请先在微信支付商户平台（或前台）把钱退给顾客，再写怎么处理的，例如「商户平台转到顾客新的银行卡」「前台退现金」。
        </Notice>
        <Field label="怎么处理的" htmlFor="mp-refund-note">
          <Textarea id="mp-refund-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={saving} disabled={!note.trim()} onClick={() => void save()}>
            记已另行处理
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** 上次的重试、另行处理没收到结果：查回，没有结论的可以按原内容重新提交（带同一个退款单号，不会做两次） */
function PendingActs({ ops }: { ops: MpPendingOp[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const checked = useRef(new Set<string>());
  const settle = (op: MpPendingOp, title: string) => {
    removeMpPending(op.key);
    void qc.invalidateQueries({ queryKey: ['mp', 'recharge'] });
    toast({ tone: 'success', title, body: op.summary });
  };
  const opKeys = useMemo(() => ops.map((op) => op.key).join('\n'), [ops]);
  useEffect(() => {
    for (const op of ops) {
      if (checked.current.has(op.key)) continue;
      checked.current.add(op.key);
      void lookupRefundOp(op)
        .then((r) => r.done && settle(op, '已查回：已经办过了'))
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opKeys]);
  const resubmit = async (op: MpPendingOp) => {
    setBusy(op.key);
    try {
      const after = await sendMpOp<MpRefundOrderAdmin>(op);
      if (op.type === 'refund_handle' && after.status !== 'handled') {
        removeMpPending(op.key);
        void qc.invalidateQueries({ queryKey: ['mp', 'recharge'] });
        toast({ tone: 'error', title: '没有记上', body: `${op.summary}：这一笔现在是「${STATUS[after.status].label}」，请刷新后再看` });
      } else settle(op, '已办好');
    } catch (error) {
      const r = await lookupRefundOp(op).catch(() => null);
      if (r?.done) settle(op, '已查回：已经办过了');
      else toast({ tone: 'error', title: '还没确认', body: saveError(error) });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="border-b border-line px-4 py-3">
      <Notice tone="warning" title={`${ops.length} 笔原路退回的操作结果待确认`}>
        <p>上次重试或另行处理时网络断了，不知道办了没有。按原内容重新提交带的是同一个退款单号，不会退两次。</p>
        <ul className="mt-2 space-y-2">
          {ops.map((op) => (
            <li key={op.key} className="flex flex-wrap items-center gap-2" data-testid="mp-refund-pending">
              <span className="font-semibold text-ink">{op.summary}</span>
              <span className="text-[12.5px] text-ink-3">
                {op.staffName} · {formatDateTime(op.createdAt)}
              </span>
              <Button size="sm" variant="secondary" loading={busy === op.key} disabled={busy !== null && busy !== op.key} onClick={() => void resubmit(op)}>
                按原内容重新提交
              </Button>
            </li>
          ))}
        </ul>
      </Notice>
    </div>
  );
}
