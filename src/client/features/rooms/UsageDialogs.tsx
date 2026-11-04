// 派对房、宠物轰趴房、娱乐室「开单即占用」（D37 / D39，v0.7.19，见 docs/FLOORPLAN_FINISH.md 第 1 节）：
// 平面图上点房间 →「开单」（选在店客人的手牌、人数、备注）；使用中的房间可以「结束使用」或「撤单」（写原因）。
// 费用是使用人手牌账单上的普通明细（到前台挂账，与平时同一个口径）；使用人结账时使用单自动结束。
// 三个写操作都带操作编号，断网时走「结果待确认」（查回 / 原样重提 / 确认作废）。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, CircleStop, PartyPopper } from 'lucide-react';
import { normalizeTagCode, TAG_CODE_PATTERN } from '@shared/frontdesk';
import type { FloorMapSpace, FloorMapUsage } from '@shared/floormap';
import { spaceLabel } from '@shared/spaces';
import { durationText, MAX_USAGE_GUESTS, MAX_USAGE_NOTE, pricingText, usageEstimate, usageMinutes, type UsageDetail } from '@shared/usages';
import { formatYuan } from '@shared/money';
import { api, errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { formatTime } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Button, Field, Input, Notice } from '../../components/ui';
import { PendingPanel, useFrontdeskOp } from '../frontdesk/pending';
import { roomsKey } from './queries';

type UsageSpace = Pick<FloorMapSpace, 'id' | 'code' | 'displayName' | 'businessType' | 'capacity'>;

/** 开单：使用人是在店客人（手牌），开单即「使用中」 */
export function OpenUsageDialog({ space, onClose, onDone }: { space: UsageSpace; onClose: () => void; onDone: (u: UsageDetail) => void }) {
  const session = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [tag, setTag] = useState('');
  const [guests, setGuests] = useState(1);
  const [note, setNote] = useState('');
  const op = useFrontdeskOp<UsageDetail>({
    type: 'usage_open',
    visitId: null,
    spaceId: space.id,
    staffName: session.staff.displayName,
    pick: (found) => (found.type === 'usage_open' ? found.usage : null),
  });
  const tagCode = normalizeTagCode(tag);
  const tagOk = TAG_CODE_PATTERN.test(tagCode);
  const ok = tagOk && Number.isInteger(guests) && guests >= 1 && guests <= MAX_USAGE_GUESTS && note.trim().length <= MAX_USAGE_NOTE;

  const finish = (u: UsageDetail) => {
    void qc.invalidateQueries({ queryKey: roomsKey });
    toast({ tone: 'success', title: `${u.spaceCode} 已开单，使用中`, body: `${u.usageNo} · 手牌 ${u.tagCode} · ${u.guests} 人` });
    onDone(u);
  };
  const submit = async () => {
    if (!ok) return;
    const u = await op.submit((key) => ({
      url: '/api/usages',
      body: { clientKey: key, spaceId: space.id, tagCode, guests, note: note.trim() },
      tagCodes: [`房 ${space.code}`],
      summary: `开单 ${guests} 人（手牌 ${tagCode}）`,
      amount: null,
    }));
    if (u) finish(u);
  };

  return (
    <Dialog
      open
      onClose={op.busy ? () => {} : onClose}
      title={
        <span className="flex items-center gap-2">
          <PartyPopper className="size-5 text-pine" /> 开单 · {spaceLabel(space.code, space.displayName)}
        </span>
      }
      description={`${space.businessType}${space.capacity ? ` · ${space.capacity} 人` : ''}：开单即「使用中」，结束使用、使用人结账或撤单后空闲。`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={op.busy}>
            取消
          </Button>
          <Button variant="primary" size="lg" disabled={!ok || op.locked} loading={op.busy} onClick={submit} data-testid="usage-open-submit">
            确认开单
          </Button>
        </>
      }
    >
      <PendingPanel op={op} onResolved={finish} />
      <div className="space-y-4" data-testid="usage-open">
        <Field
          label="使用人的手牌号"
          htmlFor="usage-tag"
          hint="使用人要先在前台接待、买门票；场次费等到前台挂到这张手牌的账单上，离店时一起结账（结账后使用单自动结束）"
          error={tag && !tagOk ? '牌号格式不正确（例如 A023、1088）' : op.state.phase === 'error' ? op.state.message : null}
        >
          <Input
            fullWidth={false}
            id="usage-tag"
            value={tag}
            onChange={(e) => {
              setTag(e.target.value.toUpperCase());
              op.clearError();
            }}
            disabled={op.locked}
            className="num w-40 text-[16px] font-bold"
            data-autofocus
            data-testid="usage-open-tag"
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-[auto_1fr]">
          <Field label="人数" htmlFor="usage-guests">
            <Input
              fullWidth={false}
              id="usage-guests"
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_USAGE_GUESTS}
              value={String(guests)}
              onChange={(e) => setGuests(Math.trunc(Number(e.target.value)) || 0)}
              disabled={op.locked}
              className="num w-24 text-[16px] font-bold"
              data-testid="usage-open-guests"
            />
          </Field>
          <Field label="备注" htmlFor="usage-note" hint="选填，例如 生日会、带 2 只狗">
            <Input id="usage-note" value={note} maxLength={MAX_USAGE_NOTE} onChange={(e) => setNote(e.target.value)} disabled={op.locked} data-testid="usage-open-note" />
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

/** 结束使用（正常结束）或撤单（开错了，写原因；挂过的费用另到前台作废） */
export function CloseUsageDialog({
  usage,
  space,
  mode,
  onClose,
  onDone,
}: {
  usage: FloorMapUsage;
  space: UsageSpace;
  mode: 'end' | 'cancel';
  onClose: () => void;
  onDone: (u: UsageDetail) => void;
}) {
  const session = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const type = mode === 'end' ? 'usage_end' : 'usage_cancel';
  const op = useFrontdeskOp<UsageDetail>({
    type,
    visitId: null,
    usageId: usage.id,
    staffName: session.staff.displayName,
    pick: (found) => (found.type === type ? found.usage : null),
  });
  const minutes = usageMinutes({ openedAt: usage.openedAt, closedAt: null }, Date.now());
  const ok = mode === 'end' || reason.trim().length >= 2;

  const finish = (u: UsageDetail) => {
    void qc.invalidateQueries({ queryKey: roomsKey });
    const fee = u.fee ? `；房费 ${formatYuan(u.fee.amount)}${u.fee.openFee > 0 ? `、开台费 ${formatYuan(u.fee.openFee)}` : ''} 已挂到手牌 ${u.tagCode}` : '';
    toast({ tone: 'success', title: `${u.spaceCode} ${mode === 'end' ? '已结束使用' : '已撤单'}`, body: `${u.usageNo} · 手牌 ${u.tagCode}${fee}` });
    onDone(u);
  };
  const submit = async () => {
    if (!ok) return;
    const u = await op.submit((key) => ({
      url: `/api/usages/${usage.id}/${mode}`,
      body: mode === 'end' ? { clientKey: key } : { clientKey: key, reason: reason.trim() },
      tagCodes: [`房 ${space.code}`],
      summary: `${mode === 'end' ? '结束使用' : `撤单（${reason.trim()}）`} ${usage.usageNo}`,
      amount: null,
    }));
    if (u) finish(u);
  };

  return (
    <Dialog
      open
      onClose={op.busy ? () => {} : onClose}
      title={
        <span className="flex items-center gap-2">
          {mode === 'end' ? <CircleStop className="size-5 text-pine" /> : <Ban className="size-5 text-clay" />}
          {mode === 'end' ? '结束使用' : '撤单'} · {spaceLabel(space.code, space.displayName)}
        </span>
      }
      description={`${usage.usageNo} · 手牌 ${usage.tagCode} · ${formatTime(usage.openedAt)} 开单，已用 ${durationText(minutes)} · ${usage.guests} 人`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={op.busy}>
            取消
          </Button>
          <Button variant={mode === 'end' ? 'primary' : 'danger'} size="lg" disabled={!ok || op.locked} loading={op.busy} onClick={submit} data-testid="usage-close-submit">
            {mode === 'end' ? '确认结束' : '确认撤单'}
          </Button>
        </>
      }
    >
      <PendingPanel op={op} onResolved={finish} />
      <div className="space-y-3" data-testid="usage-close">
        {mode === 'end' ? (
          usage.pricing ? (
            <Notice tone="info" title={`结束时按时长挂房费：到现在约 ${formatYuan(usageEstimate(minutes, usage.pricing))}`}>
              <p data-testid="usage-close-fee">
                {usage.pricing.itemName}：{pricingText(usage.pricing, formatYuan)}。按确认结束那一刻计时，挂到手牌 {usage.tagCode} 的账单上。
              </p>
            </Notice>
          ) : (
            <p className="text-[13.5px] text-ink-2">结束后房间变空闲；场次费等请确认已挂到手牌 {usage.tagCode} 的账单上。</p>
          )
        ) : (
          <>
            <Notice tone="warning" title="撤单只用于开错了">
              撤单后房间变空闲，使用单留档（记原因与经办人）；已经挂到手牌账单上的费用不会自动作废，请到前台按明细作废。
            </Notice>
            <Field label="撤单原因" htmlFor="usage-reason" error={op.state.phase === 'error' ? op.state.message : null}>
              <Input
                id="usage-reason"
                value={reason}
                maxLength={200}
                onChange={(e) => {
                  setReason(e.target.value);
                  op.clearError();
                }}
                disabled={op.locked}
                placeholder="例如 开错了房间"
                data-autofocus
                data-testid="usage-close-reason"
              />
            </Field>
          </>
        )}
        {mode === 'end' && op.state.phase === 'error' && <Notice tone="error">{op.state.message}</Notice>}
      </div>
    </Dialog>
  );
}

/** 结账前「结束使用并挂房费」（v0.7.28）：按编号取使用单，再用同一个结束对话框 */
export function EndUsageById({ usageId, onClose, onDone }: { usageId: number; onClose: () => void; onDone: (u: UsageDetail) => void }) {
  const q = useQuery({ queryKey: ['usages', 'one', usageId], queryFn: () => api.get<UsageDetail>(`/api/usages/${usageId}`) });
  if (q.isError) {
    return (
      <Dialog open onClose={onClose} title="结束使用">
        <Notice tone="error">{errorMessage(q.error)}</Notice>
      </Dialog>
    );
  }
  if (!q.data) return null;
  const d = q.data;
  const usage: FloorMapUsage = {
    id: d.id,
    usageNo: d.usageNo,
    spaceId: d.spaceId,
    visitId: d.visitId,
    tagCode: d.tagCode,
    guests: d.guests,
    note: d.note,
    openedAt: d.openedAt,
    openedByName: d.openedByName,
    pricing: d.pricing ?? null,
  };
  const space = { id: d.spaceId, code: d.spaceCode, displayName: d.spaceName, businessType: d.businessType, capacity: null };
  return <CloseUsageDialog usage={usage} space={space} mode="end" onClose={onClose} onDone={onDone} />;
}
