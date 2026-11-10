// 退房（S7）：按此刻补齐房费（挂到住客的手牌账单上，随手牌在前台结账），押金全部原路退回，房间变待打扫。
// 客房页的入住单与前台结账（客人还住着客房时）共用；退房有「结果待确认」。

import { invalidateRevenue } from '../../lib/revenue';
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PAYMENT_METHOD_LABELS } from '@shared/labels';
import { formatYuan } from '@shared/money';
import type { StayCharge, StayDetail } from '@shared/rooms';
import { errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Button, Notice, Skeleton } from '../../components/ui';
import { PendingPanel, useFrontdeskOp } from '../frontdesk/pending';
import { SHIFT_ERRORS, shiftKeys, ShiftGate, useShiftReady } from '../shift/ShiftGate';
import { dayText, roomsKey, stayKey, useStay, useStayClosePreview } from './queries';

/** 房费的叫法：「11月1日 一晚」「11月2日 超时半天」「第 2 段」 */
export const chargeText = (c: Pick<StayCharge, 'kind' | 'nightDate' | 'blockNo'>) =>
  c.kind === 'block' ? `第 ${c.blockNo} 段` : c.kind === 'half_day' ? `${dayText(c.nightDate!)} 超时半天` : `${dayText(c.nightDate!)} 一晚`;

export function CloseStayDialog({ stay, onClose, onDone }: { stay: StayDetail; onClose: () => void; onDone: (d: StayDetail) => void }) {
  const session = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const preview = useStayClosePreview(stay.id, stay.status === 'open');
  const p = preview.data;
  // 有押金要退才要先开班（押金在住期间已经退完的不用）
  const shiftReady = useShiftReady((p?.depositBalance ?? stay.depositBalance) > 0);
  const op = useFrontdeskOp<StayDetail>({
    type: 'room_close',
    visitId: null,
    stayId: stay.id,
    staffName: session.staff.displayName,
    pick: (found) => (found.type === 'room_close' ? found.stay : null),
  });
  useEffect(() => {
    if (op.state.phase === 'error' && ['ROOM_DUE_CHANGED', 'DEPOSIT_CHANGED'].includes(op.state.code ?? '')) void preview.refetch();
    if (op.state.phase === 'error' && SHIFT_ERRORS.includes(op.state.code ?? '')) void qc.invalidateQueries({ queryKey: shiftKeys.all });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [op.state]);
  const ok = !!p && !preview.isFetching && (p.depositBalance === 0 || shiftReady.ready);
  const finish = (d: StayDetail) => {
    toast({ tone: 'success', title: `${d.roomNo} 已退房`, body: '房费已挂在手牌账单上，随手牌一起结账；房间变为待打扫。' });
    void qc.invalidateQueries({ queryKey: stayKey(stay.id) });
    void qc.invalidateQueries({ queryKey: roomsKey });
    void qc.invalidateQueries({ queryKey: ['frontdesk'] });
    invalidateRevenue(qc);
    onDone(d);
  };
  const submit = async () => {
    if (!ok || !p) return;
    const d = await op.submit((key) => ({
      url: `/api/rooms/stays/${stay.id}/close`,
      // 带上看到的押金余额：其他终端刚收、退过押金时服务端拒绝，重新核对后再退
      body: { clientKey: key, expectedDue: p.dueAmount, expectedDeposits: p.depositByMethod.map(({ method, balance }) => ({ method, balance })) },
      tagCodes: [`房 ${stay.roomNo}`],
      summary: `退房（手牌 ${stay.tagCode}）${p.dueAmount > 0 ? '，补房费' : ''}${p.depositBalance > 0 ? '，退押金' : ''}`,
      amount: p.dueAmount || null,
    }));
    if (d) finish(d);
  };
  return (
    <Dialog
      open
      onClose={op.busy ? () => {} : onClose}
      title={`退房 · ${stay.roomNo}`}
      description={`手牌 ${stay.tagCode}：房费挂在手牌账单上，离店时随手牌在前台一起结账。`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={op.busy}>
            取消
          </Button>
          <Button variant="primary" size="lg" disabled={!ok || op.locked} loading={op.busy} onClick={submit} data-testid="stay-close-submit">
            确认退房
          </Button>
        </>
      }
    >
      <PendingPanel op={op} onResolved={finish} />
      <div className="space-y-3" data-testid="stay-close-review">
        {preview.isPending ? (
          <Skeleton className="h-24" />
        ) : preview.error ? (
          <Notice tone="error" title={errorMessage(preview.error)} />
        ) : (
          p && (
            <>
              <DuesList dues={p.dues.map((d) => ({ ...d, name: chargeText(d) }))} />
              <p className="flex items-baseline justify-between text-[13px]">
                <span className="text-ink-2">退房后手牌账单合计（含门票与其他消费）</span>
                <Money cents={p.billAmount + p.dueAmount} className="text-[16px] font-bold" />
              </p>
              {p.depositBalance > 0 && (
                <Notice tone="info" title={`押金 ${formatYuan(p.depositBalance)} 全部原路退回`}>
                  {p.depositByMethod.map((m) => `${PAYMENT_METHOD_LABELS[m.method]} ${formatYuan(m.balance)}`).join('、')}。现金从你当班的钱箱退，扫码、银行卡在商户后台退。
                </Notice>
              )}
              {p.depositBalance > 0 && <ShiftGate action="退押金" />}
            </>
          )
        )}
        {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} />}
      </div>
    </Dialog>
  );
}

/** 只知道入住单号时（前台结账里客人还住着客房）：先取入住单，再打开退房 */
export function CloseStayById({ stayId, onClose, onDone }: { stayId: number; onClose: () => void; onDone: (d: StayDetail) => void }) {
  const stay = useStay(stayId);
  if (!stay.data) {
    return (
      <Dialog open onClose={onClose} title="退房">
        {stay.error ? <Notice tone="error" title={errorMessage(stay.error)} /> : <Skeleton className="h-24" />}
      </Dialog>
    );
  }
  return <CloseStayDialog stay={stay.data} onClose={onClose} onDone={onDone} />;
}

/** 退房时要补挂的房费（没有时说明已经挂齐） */
export function DuesList({ dues }: { dues: { name: string; amount: number }[] }) {
  if (dues.length === 0) return <p className="text-[13px] text-ink-3">房费已经挂齐，退房不用再补。</p>;
  return (
    <div data-testid="room-dues">
      <p className="text-[13px] font-bold text-ink-2">退房时补挂的房费</p>
      <ul className="mt-1 space-y-0.5 text-[13px]">
        {dues.map((x, i) => (
          <li key={i} className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate">{x.name}</span>
            <Money cents={x.amount} className="font-semibold" />
          </li>
        ))}
      </ul>
    </div>
  );
}
