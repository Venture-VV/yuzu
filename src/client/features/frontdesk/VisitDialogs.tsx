import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, CircleAlert, CircleCheck, ReceiptText, ShieldCheck } from 'lucide-react';
import {
  BILL_SOURCE_LABELS,
  matchTags,
  normalizeTagCode,
  SWAP_REASONS,
  uniqueTagMatch,
  ZONE_LABELS,
  type BoardTag,
  type FrontdeskRules,
  type VisitDetail,
} from '@shared/frontdesk';
import { grantCovers, type VipGrant } from '@shared/grants';
import { formatYuan } from '@shared/money';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import { cn, formatTime } from '../../lib/utils';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { Button, ConfirmCheck, Field, Input, Notice, Skeleton } from '../../components/ui';
import { useCheckoutPreview, usePreview, useServerNow, stayText } from './queries';
import { AuthorizeDialog } from '../../components/AuthorizeDialog';
import { GroupMark, VipChip, ZoneChip } from './parts';
import { PendingPanel, useFrontdeskOp } from './pending';

// ───────────────────────── 换牌 ─────────────────────────

const LOST_REASON = '手牌丢失';
const GRANT_ERRORS = ['VIP_AUTH_REQUIRED', 'GRANT_INVALID', 'GRANT_USED', 'GRANT_EXPIRED', 'GRANT_SCOPE'];

export function SwapDialog({
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
  rules: FrontdeskRules | undefined;
  onClose: () => void;
  onDone: (v: VisitDetail) => void;
}) {
  const [code, setCode] = useState('');
  const [reason, setReason] = useState('');
  const [lockOld, setLockOld] = useState(false);
  /** 丢牌赔偿（店主 #30：固定 200 元，挂到客人账单）；勾选时原手牌必须同时锁定 */
  const [chargeFee, setChargeFee] = useState(false);
  const [grant, setGrant] = useState<VipGrant | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const fee = rules?.lostTagFeeCents ?? 0;
  const session = useSession();
  // 这位客人上一笔换牌结果待确认时，先处理那一笔
  const op = useFrontdeskOp<VisitDetail>({
    type: 'tag_swap',
    visitId: visit.id,
    staffName: session.staff.displayName,
    pick: (found) => ('visit' in found ? found.visit : null),
  });
  useResetOnOpen(open, () => {
    setCode('');
    setReason('');
    setLockOld(false);
    setChargeFee(false);
    setGrant(null);
    op.clearError();
  });
  useEffect(() => {
    if (op.state.phase === 'error' && op.state.code && GRANT_ERRORS.includes(op.state.code)) setGrant(null);
  }, [op.state]);

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
  // 只输了末位且对上多张空闲牌时，列出候选让员工点选，不自动取第一张
  const candidates = c && !target ? matchTags(free, c).slice(0, 8) : [];
  // VIP 柜：按这位客人的会员等级（散客为 0 级）
  const guestLevel = visit.memberLevel?.level ?? 0;
  const vipShort = !!target && !problem && target.kind === 'vip' && guestLevel < target.vipLevel!;
  const overrideOn = !!rules?.vipOverrideEnabled;
  const needs = vipShort ? [{ code: target!.code, memberId: visit.member?.id ?? null }] : [];
  const grantOk = needs.length === 0 || (!!grant && grantCovers(grant.scope, needs) && new Date(grant.expiresAt).getTime() > Date.now());
  const ready = !!target && !problem && reason.trim().length >= 2 && (!vipShort || (overrideOn && grantOk)) && (!chargeFee || lockOld);
  const guestText = visit.member ? `会员「${visit.member.name}」（第 ${guestLevel} 级）` : '散客';
  const locked = op.locked;
  const edit = (fn: () => void) => {
    if (locked) return;
    op.clearError();
    fn();
  };

  const submit = async () => {
    const r = await op.submit((key) => ({
      url: `/api/frontdesk/visits/${visit.id}/swap`,
      body: {
        clientKey: key,
        toTagCode: c,
        reason: reason.trim(),
        lockOld,
        lostFee: chargeFee ? fee : null,
        vipGrantId: needs.length && grant ? grant.grantId : null,
      },
      tagCodes: [visit.tag.code, c],
      summary: `换牌 ${visit.tag.code} → ${c}（${reason.trim()}${chargeFee ? `，丢牌赔偿 ${formatYuan(fee)}` : ''}）`,
      amount: chargeFee ? fee : null,
    }));
    if (r) onDone(r);
  };

  return (
    <Dialog
      open={open}
      onClose={op.busy ? () => {} : onClose}
      title={`换牌 · ${visit.tag.code}`}
      description="账单跟着客人走：换牌后原有消费明细全部保留在新手牌上"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={!ready || op.locked} loading={op.busy} onClick={submit} data-testid="swap-submit">
            确认换牌
          </Button>
        </>
      }
    >
      <PendingPanel op={op} onResolved={onDone} />
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <div className="rounded-lg border border-line bg-paper px-4 py-2.5 text-center">
            <p className="text-[11.5px] text-ink-3">原手牌</p>
            <p className="num text-[22px] font-bold">{visit.tag.code}</p>
          </div>
          <ArrowRight className="size-5 text-ink-3" />
          <div className="flex-1">
            <Field
              label="新手牌"
              htmlFor="swap-code"
              error={candidates.length ? null : problem}
              hint={!c && free[0] ? `同分区空闲牌如 ${free.slice(0, 4).map((t) => t.code).join('、')}` : undefined}
            >
              <Input
                id="swap-code"
                data-autofocus
                value={code}
                disabled={locked}
                onChange={(e) => edit(() => setCode(e.target.value.toUpperCase()))}
                onBlur={() => {
                  if (c && !target) {
                    const m = uniqueTagMatch(free, c);
                    if (m) setCode(m.code);
                  }
                }}
                invalid={!!problem}
                placeholder={`${ZONE_LABELS[visit.zone].title}牌号`}
                className="num text-[18px] font-bold"
              />
              {candidates.length > 1 && (
                <div className="flex flex-wrap items-center gap-1.5 text-[12.5px]" data-testid="swap-candidates">
                  <span className="font-semibold text-yuzu-deep">匹配多张，请点选实际拿到的：</span>
                  {candidates.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => edit(() => setCode(t.code))}
                      className="num h-8 rounded-full border border-line bg-card px-3 font-bold text-ink-2 hover:border-pine hover:text-pine"
                    >
                      {t.code}
                    </button>
                  ))}
                </div>
              )}
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
                    setChargeFee(r === LOST_REASON && fee > 0);
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
        {fee > 0 && (
          <ConfirmCheck
            checked={chargeFee}
            onChange={(v) =>
              edit(() => {
                setChargeFee(v);
                if (v) setLockOld(true);
              })
            }
          >
            收取丢牌赔偿 <span className="num">{formatYuan(fee)}</span>
            <span className="block text-[12.5px] font-normal text-ink-3">挂到这位客人的账单（来源「其他」），原手牌同时锁定</span>
          </ConfirmCheck>
        )}
        <ConfirmCheck checked={lockOld} onChange={(v) => edit(() => setLockOld(v || chargeFee))}>
          同时锁定原手牌 {visit.tag.code}
          <span className="block text-[12.5px] font-normal text-ink-3">
            {chargeFee ? '收取丢牌赔偿时原手牌必须锁定，找回后由店主解锁' : '丢失、损坏、柜锁故障时勾选，避免再次发出；找回或修好后由店主解锁'}
          </span>
        </ConfirmCheck>
        {vipShort && (
          <Notice
            tone={!overrideOn ? 'error' : grantOk ? 'success' : 'warning'}
            icon={<ShieldCheck className="size-4" />}
            title={
              <span className="flex items-center gap-1.5">
                <VipChip level={target!.vipLevel!} /> {target!.code} 是第 {target!.vipLevel} 级 VIP 柜，{guestText}不够
              </span>
            }
          >
            {!overrideOn ? (
              '请换普通柜或等级相符的 VIP 柜。'
            ) : grantOk && grant ? (
              `已由${grant.approverName}当场授权，${formatTime(grant.expiresAt)} 前有效。`
            ) : (
              <span className="flex flex-wrap items-center gap-3">
                需值班经理、店总或店主当场授权。
                <Button size="sm" variant="secondary" icon={<ShieldCheck className="size-4" />} disabled={locked} onClick={() => setAuthOpen(true)} data-testid="request-authorize">
                  请经理授权
                </Button>
              </span>
            )}
          </Notice>
        )}
        {op.state.phase === 'error' && <Notice tone="error" title={op.state.message} />}
      </div>
      <AuthorizeDialog
        open={authOpen}
        request={{ purpose: 'vip_tag', scope: { tags: needs } }}
        lines={target ? [`${guestText} · 换到 VIP 柜 ${target.code}（第 ${target.vipLevel} 级）`] : []}
        onClose={() => setAuthOpen(false)}
        onGranted={(g) => {
          setGrant(g);
          setAuthOpen(false);
          op.clearError();
        }}
      />
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
  useResetOnOpen(open, () => {
    setQ('');
    setError(null);
  });
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

// ───────────────────────── 预结账（只汇总，不收款；门票按此刻的在店时长估算，结账时按结账时刻重新计算） ─────────────────────────

export function PreviewDialog({
  open,
  visit,
  tags,
  onClose,
  onCheckout,
}: {
  open: boolean;
  visit: VisitDetail;
  tags: BoardTag[];
  onClose: () => void;
  /** 去结账：带上已勾选的手牌 */
  onCheckout?: (visitIds: number[]) => void;
}) {
  const [selected, setSelected] = useState<number[]>([]);
  useResetOnOpen(
    open,
    () => {
      const mates = visit.group?.mates.filter((m) => m.status === 'open').map((m) => m.visitId) ?? [];
      setSelected(mates.length ? mates : [visit.id]);
    },
    [visit],
  );
  const preview = usePreview(selected, open);
  // 门票（与结账共用计价）：按此刻的在店时长估算，结账时按结账时刻重新计算
  const priced = useCheckoutPreview(selected, open);
  const now = useServerNow(preview.data?.serverTime);
  const pricedOf = (visitId: number) => priced.data?.visits.find((v) => v.visitId === visitId);
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
      description="勾选要一起结的手牌，查看合并后的应收（含门票）"
      footer={
        <>
          <span className="mr-auto self-center text-[12.5px] text-ink-3">门票按此刻的在店时长估算，结账时按结账时刻重新计算</span>
          <Button variant={onCheckout ? 'ghost' : 'primary'} onClick={onClose}>
            关闭
          </Button>
          {onCheckout && (
            <Button variant="primary" onClick={() => onCheckout(selected)} data-testid="preview-checkout">
              去结账
            </Button>
          )}
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
                    <th className="px-4 py-2 text-right font-semibold">应收（含门票）</th>
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
                        {(() => {
                          const pv = pricedOf(v.visitId);
                          if (!pv) return <Money cents={v.amountCents} className="font-bold" />;
                          return (
                            <>
                              <Money cents={pv.amount} className="font-bold" />
                              <span className="block text-[11.5px] text-ink-3">
                                {pv.ticket ? (
                                  <>
                                    明细 <Money cents={pv.linesAmount} /> + 门票 <Money cents={pv.ticket.amount} />（{pv.ticket.tierLabel}）
                                  </>
                                ) : (
                                  '还没有选票种，结账时补选'
                                )}
                              </span>
                            </>
                          );
                        })()}
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
                  <p className="text-[12px] text-ink-3">
                    {preview.data.visits.length} 张手牌应收（含门票）
                    {priced.data ? ` · 门票 ¥${(priced.data.visits.reduce((n, v) => n + (v.ticket?.amount ?? 0), 0) / 100).toFixed(2)}` : ''}
                  </p>
                  <span data-testid="preview-total">
                    <Money cents={priced.data?.totalAmount ?? preview.data.totalCents} className="text-[26px] font-bold text-pine" />
                  </span>
                </div>
              </div>
            </div>
          )
        )}
        <Notice tone="info" icon={<CircleAlert className="size-4" />} title="这还不是结账单">
          预结账只汇总，不收款、不扣会员余额，手牌不会释放；门票每 12 小时跳一档（跳档宽限见前台规则），结账时按结账那一刻重新计算。
        </Notice>
      </div>
    </Dialog>
  );
}
