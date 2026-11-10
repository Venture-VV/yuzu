// 转单（v0.7.6）：挂错手牌时，把这位客人账单上的明细转到另一位在店客人的手牌上。
// 原明细作废（原因写明转到哪张手牌），目标手牌新增同样的明细（价格、档位、技师不变）；房费、餐饮的菜、钟房派的钟不能转。
// 与挂账一样有「结果待确认」：断网后查回 / 原样重提 / 确认作废。

import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { MAX_MOVE_LINES, normalizeTagCode, ZONE_LABELS, type BillLine, type BoardTag, type FrontdeskBoardRules, type VisitDetail } from '@shared/frontdesk';
import { formatYuan } from '@shared/money';
import { useCan, useSession } from '../../lib/session';
import { cn } from '../../lib/utils';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { Button, Field, Input, Notice } from '../../components/ui';
import { PendingPanel, useFrontdeskOp } from './pending';
import { useServerNow } from './queries';

const MOVE_REASONS = ['挂错手牌', '同行客人分开结账', '客人要求转给同行'];

/** 这条明细能不能转：不能转的写明原因（与服务端一致） */
export function moveBlock(line: BillLine): string | null {
  if (line.source === 'room') return '房费随入住单走';
  if (line.source === 'dining' || line.kitchen) return '餐饮的菜有出品单，请退菜后在正确的手牌上重点';
  if (line.sessionId !== null) return '钟房派的钟，请在钟房处理';
  return null;
}

export function MoveLinesDialog({
  open,
  visit,
  tags,
  rules,
  onClose,
  onDone,
}: {
  open: boolean;
  visit: VisitDetail;
  tags: BoardTag[];
  rules: FrontdeskBoardRules | undefined;
  onClose: () => void;
  /** 转好了：原客人的账单与目标客人的来访（刷新用） */
  onDone: (v: VisitDetail, toVisitId: number | null) => void;
}) {
  const session = useSession();
  const can = useCan();
  const [picked, setPicked] = useState<number[]>([]);
  const [code, setCode] = useState('');
  const [reason, setReason] = useState('');
  const op = useFrontdeskOp<VisitDetail>({
    type: 'line_move',
    visitId: visit.id,
    staffName: session.staff.displayName,
    pick: (found) => (found.type === 'line_move' ? found.visit : null),
  });
  useResetOnOpen(open, () => {
    setPicked([]);
    setCode('');
    setReason('');
    op.clearError();
  });

  const now = useServerNow(visit.serverTime);
  const selfMinutes = rules?.selfVoidMinutes ?? 10;
  // 权限与作废明细相同：有「前台更正」的岗位随时可以；其他人只能转自己在规定分钟内挂的（按服务器时间，以服务端为准）
  const canFix = (l: BillLine) =>
    can('frontdesk.correct') || (l.postedById === session.staff.id && (now - new Date(l.postedAt).getTime()) / 60_000 <= selfMinutes);
  const active = visit.lines.filter((l) => l.status === 'active');
  const why = (l: BillLine) => moveBlock(l) ?? (canFix(l) ? null : `超过 ${selfMinutes} 分钟或不是你挂的，请店主或值班经理处理`);
  const chosen = active.filter((l) => picked.includes(l.id));
  const total = chosen.reduce((t, l) => t + l.amount, 0);

  const c = normalizeTagCode(code);
  const target = c ? tags.find((t) => t.code === c) : undefined;
  const problem = !c
    ? null
    : !target
      ? `没有牌号 ${c}`
      : target.code === visit.tag.code
        ? '这就是这位客人的手牌'
        : !target.visit
          ? `手牌 ${c} 没有在店客人`
          : null;
  const ready = chosen.length > 0 && chosen.length <= MAX_MOVE_LINES && !!target?.visit && !problem && reason.trim().length >= 2;
  const locked = op.locked;
  const edit = (fn: () => void) => {
    if (locked) return;
    op.clearError();
    fn();
  };

  const submit = async () => {
    if (!ready) return;
    const r = await op.submit((key) => ({
      url: '/api/frontdesk/lines/move',
      body: { clientKey: key, lineIds: chosen.map((l) => l.id), toTagCode: c, reason: reason.trim() },
      tagCodes: [visit.tag.code, c],
      summary: `转 ${chosen.length} 项到手牌 ${c}（${reason.trim()}）`,
      amount: total,
    }));
    if (r) onDone(r, target?.visit?.id ?? null);
  };

  return (
    <Dialog
      open={open}
      onClose={op.busy ? () => {} : onClose}
      title={`明细转到别的手牌 · ${visit.tag.code}`}
      description="挂错手牌时用：选中的明细在这张手牌上作废，转到目标手牌上（价格、技师不变），两边都留记录"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={op.busy}>
            取消
          </Button>
          <Button variant="primary" disabled={!ready || locked} loading={op.busy} onClick={submit} data-testid="move-submit">
            {target?.visit && !problem ? `转到 ${c}` : '确认转单'}
          </Button>
        </>
      }
    >
      <PendingPanel op={op} onResolved={(v) => onDone(v, null)} />
      <div className="space-y-4" data-testid="move-lines">
        <Field label="要转的明细" hint={`一次最多 ${MAX_MOVE_LINES} 项；房费、餐饮的菜、钟房派的钟不能转`}>
          {active.length === 0 ? (
            <p className="text-[13px] text-ink-3">这张手牌上没有可转的明细。</p>
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {active.map((l) => {
                const block = why(l);
                const on = picked.includes(l.id);
                return (
                  <li key={l.id}>
                    <label
                      className={cn('flex items-center gap-3 px-3 py-2.5 text-[14px]', block ? 'cursor-not-allowed opacity-55' : 'cursor-pointer hover:bg-paper-2')}
                      title={block ?? undefined}
                    >
                      <input
                        type="checkbox"
                        className="size-4 accent-pine"
                        checked={on}
                        disabled={!!block || locked}
                        onChange={(e) => edit(() => setPicked((p) => (e.target.checked ? [...p, l.id] : p.filter((x) => x !== l.id))))}
                        data-testid={`move-line-${l.id}`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="font-semibold">{l.name}</span>
                        <span className="num ml-1.5 text-[12.5px] text-ink-3">× {l.quantity}</span>
                        {block && <span className="block text-[12px] text-ink-3">{block}</span>}
                      </span>
                      <Money cents={l.amount} className="font-bold" />
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </Field>
        <div className="flex items-end gap-3">
          <div className="rounded-lg border border-line bg-paper px-4 py-2 text-center">
            <p className="text-[11.5px] text-ink-3">从</p>
            <p className="num text-[20px] font-bold">{visit.tag.code}</p>
          </div>
          <ArrowRight className="mb-3 size-5 text-ink-3" />
          <Field label="转到手牌" htmlFor="move-to" error={problem}>
            <Input
              fullWidth={false}
              id="move-to"
              value={code}
              onChange={(e) => edit(() => setCode(e.target.value.toUpperCase()))}
              disabled={locked}
              className="num w-40 text-[16px] font-bold"
              placeholder="例如 A023"
              data-testid="move-to-tag"
            />
          </Field>
          {target?.visit && !problem && (
            <p className="mb-3 text-[13px] text-ink-2" data-testid="move-target">
              {ZONE_LABELS[target.zone].title} · 在店
            </p>
          )}
        </div>
        <Field label="原因" htmlFor="move-reason">
          <div className="mb-2 flex flex-wrap gap-1.5">
            {MOVE_REASONS.map((r) => (
              <button
                key={r}
                type="button"
                disabled={locked}
                onClick={() => edit(() => setReason(r))}
                className={cn(
                  'h-8 rounded-full border px-3 text-[13px] font-semibold',
                  reason === r ? 'border-pine bg-pine-tint text-pine' : 'border-line text-ink-2 hover:bg-paper-2',
                )}
              >
                {r}
              </button>
            ))}
          </div>
          <Input id="move-reason" value={reason} maxLength={100} onChange={(e) => edit(() => setReason(e.target.value))} disabled={locked} data-testid="move-reason" />
        </Field>
        {chosen.length > 0 && (
          <p className="flex items-baseline justify-between text-[13.5px]" data-testid="move-summary">
            <span className="text-ink-2">转 {chosen.length} 项</span>
            <span className="font-bold">{formatYuan(total)}</span>
          </p>
        )}
        {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} />}
      </div>
    </Dialog>
  );
}
