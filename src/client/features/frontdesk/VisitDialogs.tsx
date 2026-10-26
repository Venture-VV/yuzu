import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, CircleAlert, CircleCheck, ReceiptText } from 'lucide-react';
import {
  BILL_SOURCE_LABELS,
  matchTags,
  normalizeTagCode,
  SWAP_REASONS,
  ZONE_LABELS,
  type BoardTag,
  type VisitDetail,
} from '@shared/frontdesk';
import { api } from '../../lib/api';
import { cn, formatTime } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { Button, ConfirmCheck, Field, Input, Notice, Skeleton } from '../../components/ui';
import { usePreview, useServerNow, stayText } from './queries';
import { GroupMark, useKeyedSubmit, ZoneChip } from './parts';

// ───────────────────────── 换牌 ─────────────────────────

export function SwapDialog({
  open,
  visit,
  tags,
  onClose,
  onDone,
}: {
  open: boolean;
  visit: VisitDetail;
  tags: BoardTag[];
  onClose: () => void;
  onDone: (v: VisitDetail) => void;
}) {
  const [code, setCode] = useState('');
  const [reason, setReason] = useState('');
  const [lockOld, setLockOld] = useState(false);
  const op = useKeyedSubmit<VisitDetail>((found) => (found as { visit?: VisitDetail }).visit ?? null);
  useEffect(() => {
    if (!open) return;
    setCode('');
    setReason('');
    setLockOld(false);
    op.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const free = tags.filter((t) => t.zone === visit.zone && t.active && !t.locked && !t.visit);
  const c = normalizeTagCode(code);
  const target = tags.find((t) => t.code === c);
  const problem = !c
    ? null
    : !target
      ? `没有牌号 ${c}`
      : target.code === visit.tag.code
        ? '这就是客人现在的手牌'
        : target.zone !== visit.zone
          ? `${c} 是${ZONE_LABELS[target.zone].title}牌，客人是${ZONE_LABELS[visit.zone].title}`
          : target.visit
            ? `${c} 已在店`
            : target.locked
              ? `${c} 已锁定（${target.lockReason}）`
              : !target.active
                ? `${c} 已停用`
                : null;
  const ready = !!target && !problem && reason.trim().length >= 2;
  const locked = op.state.phase === 'uncertain' || op.state.phase === 'busy';
  const edit = (fn: () => void) => {
    if (locked) return;
    if (op.state.phase === 'error') op.reset();
    fn();
  };

  const submit = async () => {
    const r = await op.submit((key) =>
      api.post<VisitDetail>(`/api/frontdesk/visits/${visit.id}/swap`, { clientKey: key, toTagCode: c, reason: reason.trim(), lockOld }),
    );
    if (r) onDone(r);
  };

  return (
    <Dialog
      open={open}
      onClose={op.state.phase === 'busy' ? () => {} : onClose}
      title={`换牌 · ${visit.tag.code}`}
      description="账单跟着客人走：换牌后原有消费明细全部保留在新手牌上"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={!ready} loading={op.state.phase === 'busy'} onClick={submit} data-testid="swap-submit">
            确认换牌
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <div className="rounded-lg border border-line bg-paper px-4 py-2.5 text-center">
            <p className="text-[11.5px] text-ink-3">原手牌</p>
            <p className="num text-[22px] font-bold">{visit.tag.code}</p>
          </div>
          <ArrowRight className="size-5 text-ink-3" />
          <div className="flex-1">
            <Field label="新手牌" htmlFor="swap-code" error={problem} hint={!c && free[0] ? `同分区空闲牌如 ${free.slice(0, 4).map((t) => t.code).join('、')}` : undefined}>
              <Input
                id="swap-code"
                data-autofocus
                value={code}
                disabled={locked}
                onChange={(e) => edit(() => setCode(e.target.value.toUpperCase()))}
                onBlur={() => {
                  if (c && !target) {
                    const m = matchTags(free, c)[0];
                    if (m) setCode(m.code);
                  }
                }}
                invalid={!!problem}
                placeholder={`${ZONE_LABELS[visit.zone].title}牌号`}
                className="num text-[18px] font-bold"
              />
            </Field>
          </div>
        </div>
        <Field label="换牌原因">
          <div className="flex flex-wrap gap-1.5">
            {SWAP_REASONS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() =>
                  edit(() => {
                    setReason(r);
                    setLockOld(r !== '顾客要求换柜');
                  })
                }
                className={cn('h-9 rounded-full border px-3.5 text-[13px] font-semibold', reason === r ? 'border-pine bg-pine-tint text-pine' : 'border-line bg-card text-ink-2 hover:border-line-strong')}
              >
                {r}
              </button>
            ))}
          </div>
          <Input value={reason} disabled={locked} onChange={(e) => edit(() => setReason(e.target.value))} placeholder="或填写其他原因" maxLength={100} className="mt-2" />
        </Field>
        <ConfirmCheck checked={lockOld} onChange={(v) => edit(() => setLockOld(v))}>
          同时锁定原手牌 {visit.tag.code}
          <span className="block text-[12.5px] font-normal text-ink-3">丢失、损坏、柜锁故障时勾选，避免再次发出；找回或修好后由店主解锁</span>
        </ConfirmCheck>
        {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} />}
        {op.state.phase === 'uncertain' && (
          <Notice
            tone="warning"
            title="结果待确认"
            action={
              <Button size="sm" variant="primary" onClick={async () => { const r = await op.check(); if (r) onDone(r); }}>
                查回结果
              </Button>
            }
          >
            {op.state.message}
          </Notice>
        )}
      </div>
    </Dialog>
  );
}

// ───────────────────────── 加入同行 ─────────────────────────

export function JoinGroupDialog({
  open,
  visit,
  tags,
  onClose,
  onDone,
}: {
  open: boolean;
  visit: VisitDetail;
  tags: BoardTag[];
  onClose: () => void;
  onDone: (v: VisitDetail) => void;
}) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setQ('');
      setError(null);
    }
  }, [open]);
  const candidates = useMemo(() => {
    const inStore = tags.filter((t) => t.visit && t.visit.id !== visit.id && (!visit.group || t.visit.groupId !== visit.group.id));
    return q.trim() ? matchTags(inStore, q) : inStore;
  }, [tags, q, visit]);

  const join = async (targetVisitId: number) => {
    setBusy(true);
    setError(null);
    try {
      onDone(await api.post<VisitDetail>(`/api/frontdesk/visits/${visit.id}/group`, { action: 'join', targetVisitId }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={`${visit.tag.code} 加入同行`} description="选择一位已在店的客人；对方已有同行组时加入该组，没有时自动新建。离店时可勾选同组手牌合并结账。">
      <Input data-autofocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="输入对方牌号（末位即可）" className="num text-[16px]" aria-label="对方牌号" />
      {visit.group && <p className="mt-2 text-[12.5px] text-ink-3">{visit.tag.code} 目前在同行组 {visit.group.groupNo}，加入新组会先退出原组。</p>}
      <ul className="mt-3 grid max-h-[320px] grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
        {candidates.slice(0, 30).map((t) => (
          <li key={t.id}>
            <button
              type="button"
              disabled={busy}
              onClick={() => join(t.visit!.id)}
              className="flex w-full items-center gap-2 rounded-lg border border-line bg-card px-3 py-2.5 text-left hover:border-pine hover:bg-pine-tint"
            >
              <span className="num text-[16px] font-bold">{t.code}</span>
              <ZoneChip zone={t.zone} />
              {t.visit!.groupNo && <GroupMark groupNo={t.visit!.groupNo} />}
              <span className="min-w-0 flex-1 truncate text-right text-[12px] text-ink-3">{t.visit!.memberName ?? (t.visit!.guestLabel || '散客')}</span>
            </button>
          </li>
        ))}
        {candidates.length === 0 && <li className="col-span-full py-6 text-center text-[13px] text-ink-3">没有匹配的在店手牌</li>}
      </ul>
      {error && <Notice tone="error" title={error} className="mt-3" />}
    </Dialog>
  );
}

// ───────────────────────── 预结账（S2：只汇总，不收款） ─────────────────────────

export function PreviewDialog({
  open,
  visit,
  tags,
  onClose,
}: {
  open: boolean;
  visit: VisitDetail;
  tags: BoardTag[];
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<number[]>([]);
  useEffect(() => {
    if (!open) return;
    const mates = visit.group?.mates.filter((m) => m.status === 'open').map((m) => m.visitId) ?? [];
    setSelected(mates.length ? mates : [visit.id]);
  }, [open, visit]);
  const preview = usePreview(selected, open);
  const now = useServerNow(preview.data?.serverTime);
  const inStore = tags.filter((t) => t.visit);
  const toggle = (id: number) => setSelected((s) => (s.includes(id) ? (s.length > 1 ? s.filter((x) => x !== id) : s) : [...s, id]));
  // 可勾选：同组 + 当前 + 任意其他在店手牌（「任意指定多张未结手牌合并」）
  const groupIds = new Set(visit.group?.mates.filter((m) => m.status === 'open').map((m) => m.visitId) ?? [visit.id]);
  const [showAll, setShowAll] = useState(false);
  const choices = inStore.filter((t) => showAll || groupIds.has(t.visit!.id) || selected.includes(t.visit!.id));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width="max-w-2xl"
      title={
        <span className="flex items-center gap-2">
          <ReceiptText className="size-5 text-pine" /> 预结账
        </span>
      }
      description="勾选要一起结的手牌，查看合并后的未结金额"
      footer={
        <>
          <span className="mr-auto self-center text-[12.5px] text-ink-3">收款、团购核销与会员卡扣款将在 S3 开放</span>
          <Button variant="primary" onClick={onClose}>
            知道了
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-testid="preview">
        <div>
          <div className="flex flex-wrap gap-1.5">
            {choices.map((t) => {
              const on = selected.includes(t.visit!.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(t.visit!.id)}
                  className={cn(
                    'flex h-10 items-center gap-1.5 rounded-full border px-3 text-[14px] font-bold',
                    on ? 'border-pine bg-pine text-paper' : 'border-line bg-card text-ink-2 hover:border-line-strong',
                  )}
                >
                  {on ? <CircleCheck className="size-4" /> : <span className="size-4 rounded-full border-2 border-line-strong" />}
                  <span className="num">{t.code}</span>
                  <span className="text-[11.5px] font-semibold opacity-70">{ZONE_LABELS[t.zone].short}</span>
                </button>
              );
            })}
          </div>
          {!showAll && inStore.length > choices.length && (
            <button type="button" onClick={() => setShowAll(true)} className="mt-2 text-[13px] font-semibold text-pine hover:underline">
              + 合并其他在店手牌（共 {inStore.length} 张在店）
            </button>
          )}
        </div>

        {preview.isPending ? (
          <Skeleton className="h-40" />
        ) : preview.error ? (
          <Notice tone="error" title={preview.error.message} />
        ) : (
          preview.data && (
            <div className="overflow-hidden rounded-lg border border-line bg-card">
              <table className="w-full text-[13.5px]">
                <thead className="bg-paper-2 text-[12px] text-ink-3">
                  <tr>
                    <th className="px-4 py-2 text-left font-semibold">手牌</th>
                    <th className="px-2 py-2 text-left font-semibold">客人</th>
                    <th className="px-2 py-2 text-right font-semibold">在店</th>
                    <th className="px-4 py-2 text-right font-semibold">未结</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/70">
                  {preview.data.visits.map((v) => (
                    <tr key={v.visitId}>
                      <td className="px-4 py-2.5">
                        <span className="num font-bold">{v.tagCode}</span> <ZoneChip zone={v.zone} className="ml-1" />
                      </td>
                      <td className="max-w-[160px] truncate px-2 py-2.5 text-ink-2">{v.memberName ?? (v.guestLabel || '散客')}</td>
                      <td className="num px-2 py-2.5 text-right text-ink-3">
                        {formatTime(v.checkedInAt)} · {stayText(v.checkedInAt, now)}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <Money cents={v.amountCents} className="font-bold" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex flex-wrap items-end justify-between gap-3 border-t border-line bg-paper/60 px-4 py-3">
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-ink-3">
                  {preview.data.bySource.map((s) => (
                    <span key={s.source}>
                      {BILL_SOURCE_LABELS[s.source]} <Money cents={s.amountCents} className="font-semibold text-ink-2" />
                    </span>
                  ))}
                </div>
                <div className="text-right">
                  <p className="text-[12px] text-ink-3">{preview.data.visits.length} 张手牌合计（已挂明细）</p>
                  <span data-testid="preview-total">
                    <Money cents={preview.data.totalCents} className="text-[26px] font-bold text-pine" />
                  </span>
                </div>
              </div>
            </div>
          )
        )}
        <Notice tone="info" icon={<CircleAlert className="size-4" />} title="这还不是结账单">
          门票与时长 / 大厅过夜费将在结账时按入场时间动态计算；本阶段不收款、不扣会员余额，手牌不会释放。
        </Notice>
      </div>
    </Dialog>
  );
}
