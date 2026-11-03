// 会员详情的赠金明细（v0.6.0，同事在测试服的反馈：要看到赠送额度的使用情况；等级 v0.7.23 起见 membership/GradeCard）；
// 账户内券（v0.7.20，飞书 RQ-006 后半，docs/COUPONS.md 第 6 节）：按状态看券、手动发券、作废没用过的券。

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Gift, Ticket, TicketPlus } from 'lucide-react';
import { lastUsableDate } from '@shared/business-date';
import {
  COUPON_ISSUE_KIND_LABELS,
  COUPON_STATE_LABELS,
  formatStoreCouponCode,
  MAX_MANUAL_COUPONS,
  type CouponIssueResult,
  type CouponRow,
  type CouponState,
  type CouponTemplate,
} from '@shared/coupons';
import { shiftDate } from '@shared/labels';
import { BONUS_LOT_STATUS_LABELS, type BonusLotStatus } from '@shared/members';
import type { MemberDetail } from '@shared/types';
import { api, ApiError, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, useErpPending } from '../../lib/erpPending';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { useCan, useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { cn, formatDate, formatDateTime, uuid } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Dialog } from '../../components/Overlay';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, PendingBadge, SectionTitle, Segmented, Select, Skeleton, Textarea } from '../../components/ui';
import {
  COUPON_STATE_ORDER,
  COUPON_STATE_TONES,
  couponKeys,
  couponRangeText,
  templateExpired,
  templateValidityText,
  useCouponTemplates,
  useMemberCoupons,
} from '../coupons/queries';

/** 赠金明细：每笔赠送的额度——可用、已用完、已过期 */
export function BonusLotsCard({ member }: { member: MemberDetail }) {
  const session = useSession();
  const lots = member.bonusLotHistory ?? [];
  const counts = { active: 0, used: 0, expired: 0 } as Record<BonusLotStatus, number>;
  for (const l of lots) counts[l.status] += 1;
  const [tab, setTab] = useState<BonusLotStatus>(counts.active || !lots.length ? 'active' : counts.used ? 'used' : 'expired');
  if (lots.length === 0) return null;
  const rows = lots.filter((l) => l.status === tab);
  const sourceText = (s: (typeof lots)[number]['source']) => (s === 'recharge' ? '充值赠送' : s === 'legacy' ? '升级前的赠金' : '撤销恢复');
  return (
    <Card className="p-5" data-testid="member-bonus-lots">
      <SectionTitle>
        <span className="flex items-center gap-2">
          <Gift className="size-4 text-yuzu-deep" /> 赠金明细
        </span>
      </SectionTitle>
      <Segmented
        size="sm"
        className="mt-2"
        ariaLabel="赠金状态"
        value={tab}
        onChange={setTab}
        options={(['active', 'used', 'expired'] as const).map((k) => ({ value: k, label: `${BONUS_LOT_STATUS_LABELS[k]} ${counts[k]}` }))}
      />
      {rows.length === 0 ? (
        <p className="mt-3 text-[13px] text-ink-3">没有{BONUS_LOT_STATUS_LABELS[tab]}的赠金</p>
      ) : (
        <ul className="mt-3 divide-y divide-line/70 text-[13px]">
          {rows.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-2">
              <Money cents={l.amount} className="font-bold text-ink" />
              <span className="text-ink-3">{sourceText(l.source)}</span>
              {l.docNo && <span className="num text-[12px] text-ink-3">{l.docNo}</span>}
              <span className="flex-1" />
              {l.status === 'active' && (
                <span className="text-ink-2">
                  剩 <Money cents={l.remaining} className="font-semibold" />
                  {l.expiresAt ? ` · 有效至 ${lastUsableDate(l.expiresAt, session.timezone, session.rules.businessDayStartHour)}` : ' · 长期有效'}
                </span>
              )}
              {l.used > 0 && (
                <span className="text-ink-3">
                  已用 <Money cents={l.used} />
                </span>
              )}
              {l.expired > 0 && (
                <Badge tone="clay">
                  过期作废 <Money cents={l.expired} />
                </Badge>
              )}
              <span className="num w-full text-[11.5px] text-ink-4 sm:w-auto">{formatDate(l.createdAt)} 赠送</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** 作废得了的券：没用过的（可用、未生效、已过期）；用过的要反结账退回 */
const VOIDABLE: readonly CouponState[] = ['available', 'pending', 'expired'];

/**
 * 账户内券：可用 / 未生效 / 已过期 / 已用 / 已作废（过期与未生效按营业日算，不改数据）。
 * 「发券」要「发券给会员」权限，「作废」要「作废券」权限；看会员的岗位都能看
 */
export function MemberCouponsCard({ member }: { member: MemberDetail }) {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const coupons = useMemberCoupons(member.id, can('member.read'));
  const [picked, setPicked] = useState<CouponState | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [voiding, setVoiding] = useState<CouponRow | null>(null);
  const [voidBusy, setVoidBusy] = useState(false);
  const [voidError, setVoidError] = useState<string | null>(null);
  useResetOnOpen(!!voiding, () => setVoidError(null));
  const canIssue = can('coupon.issue');
  const canVoid = can('coupon.void');
  const data = coupons.data;
  // 发给这位会员的券结果待确认（断网、超时）：刷新、重新登录后也在，先查回、按原内容重新提交或作废，处理完才能再发（Codex 复审 6c3765c）
  const issueUrl = `/api/members/${member.id}/coupons`;
  const pendingIssue = useErpPending(['coupon_issue']).some((op) => op.url === issueUrl);
  // 没选过时：先看有可用的，没有就看第一个有券的状态
  const tab: CouponState = picked ?? (data ? (COUPON_STATE_ORDER.find((s) => data.counts[s] > 0) ?? 'available') : 'available');
  const rows = (data?.coupons ?? []).filter((c) => c.state === tab);
  const frozen = member.status !== 'active';

  const voidCoupon = async (reason: string) => {
    if (!voiding) return;
    setVoidBusy(true);
    setVoidError(null);
    try {
      await api.post<CouponRow>(`/api/coupons/${voiding.id}/void`, { reason });
      toast({ tone: 'success', title: `已作废券 ${formatStoreCouponCode(voiding.code)}`, body: voiding.templateName });
      setVoiding(null);
    } catch (e) {
      setVoidError(errorMessage(e));
    } finally {
      setVoidBusy(false);
      void qc.invalidateQueries({ queryKey: couponKeys.member(member.id) });
      void qc.invalidateQueries({ queryKey: couponKeys.all });
    }
  };

  return (
    <Card className="p-5" data-testid="coupon-member">
      <SectionTitle
        aside={
          canIssue && (
            <Button
              size="sm"
              variant="secondary"
              icon={<TicketPlus className="size-4" />}
              onClick={() => setIssuing(true)}
              disabled={frozen || pendingIssue}
              title={frozen ? '会员已停用，不能发券' : pendingIssue ? '上一次发券的结果待确认：先在下面查回、重提或作废' : undefined}
              data-testid="coupon-member-issue"
            >
              发券
            </Button>
          )
        }
      >
        <span className="flex items-center gap-2">
          <Ticket className="size-4 text-yuzu-deep" /> 账户内券
        </span>
      </SectionTitle>
      {canIssue && (
        <ErpPendingPanel
          types={['coupon_issue']}
          filter={(op) => op.url === issueUrl}
          className="mt-3 space-y-2"
          onFound={() => {
            void qc.invalidateQueries({ queryKey: couponKeys.member(member.id) });
            void qc.invalidateQueries({ queryKey: couponKeys.all });
          }}
        />
      )}
      {coupons.error ? (
        <Notice tone="error" className="mt-3" title={errorMessage(coupons.error)} />
      ) : !data ? (
        <Skeleton className="mt-3 h-20" />
      ) : data.coupons.length === 0 ? (
        <p className="mt-2 text-[13px] text-ink-3" data-testid="coupon-member-empty">
          还没有券。开卡礼、升级礼、生日礼、充值赠券按后台的发券规则自动发{canIssue ? '；也可以点「发券」手动发' : ''}。
        </p>
      ) : (
        <>
          <div className="mt-2.5 flex flex-wrap gap-1.5" role="radiogroup" aria-label="券的状态">
            {COUPON_STATE_ORDER.map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={tab === s}
                onClick={() => setPicked(s)}
                className={cn(
                  'inline-flex h-7 items-center gap-1 rounded-full px-3 text-[12.5px] font-semibold whitespace-nowrap transition-colors',
                  tab === s ? 'bg-pine text-paper' : 'bg-paper-2 text-ink-2 hover:bg-paper-3',
                )}
                data-testid={`coupon-member-filter-${s}`}
              >
                {COUPON_STATE_LABELS[s]}
                <span className="num">{data.counts[s]}</span>
              </button>
            ))}
          </div>
          {rows.length === 0 ? (
            <p className="mt-3 text-[13px] text-ink-3">没有{COUPON_STATE_LABELS[tab]}的券</p>
          ) : (
            <ul className="mt-2 divide-y divide-line/70">
              {rows.map((c) => (
                <MemberCouponRow key={c.id} c={c} onVoid={canVoid && VOIDABLE.includes(c.state) ? () => setVoiding(c) : undefined} />
              ))}
            </ul>
          )}
          {data.coupons.length >= 300 && <p className="mt-2 text-[12px] text-ink-3">只列最近 300 张</p>}
        </>
      )}
      {canIssue && <IssueCouponDialog open={issuing} member={member} onClose={() => setIssuing(false)} />}
      <ReasonDialog
        open={!!voiding}
        title={voiding ? `作废券 ${formatStoreCouponCode(voiding.code)}` : ''}
        description={voiding ? `「${voiding.templateName}」${voiding.summary}。作废后结账时不能再用，不能恢复。` : undefined}
        label="作废原因"
        confirmLabel="作废"
        danger
        busy={voidBusy}
        testId="coupon-member-void"
        extra={voidError && <Notice tone="error" title={voidError} className="mt-3" />}
        onClose={voidBusy ? () => {} : () => setVoiding(null)}
        onConfirm={(reason) => void voidCoupon(reason)}
      />
    </Card>
  );
}

function MemberCouponRow({ c, onVoid }: { c: CouponRow; onVoid?: () => void }) {
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2.5" data-testid={`coupon-member-row-${c.id}`}>
      <div className="min-w-0 flex-1 basis-[220px]">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-[14px] font-bold break-all text-ink">{c.templateName}</span>
          <Badge tone={COUPON_STATE_TONES[c.state]}>{COUPON_STATE_LABELS[c.state]}</Badge>
        </p>
        <p className="mt-0.5 text-[13px] text-ink-2">{c.summary}</p>
        <p className="mt-0.5 text-[12px] text-ink-3">
          有效期 {couponRangeText(c.validFrom, c.validTo)} · {COUPON_ISSUE_KIND_LABELS[c.issueKind]} {formatDate(c.issuedAt)}
          {c.issuedByName ? `（${c.issuedByName}）` : ''}
        </p>
        {c.state === 'used' && (
          <p className="mt-0.5 text-[12.5px] text-ink-2" data-testid={`coupon-member-used-${c.id}`}>
            用于结账单 <span className="num font-semibold">{c.checkoutNo ?? '—'}</span>
            {c.usedAmount !== null && (
              <>
                {' '}
                · 抵 <Money cents={c.usedAmount} className="font-semibold" />
              </>
            )}
          </p>
        )}
        {c.state === 'voided' && c.voidReason && <p className="mt-0.5 text-[12.5px] break-all text-clay">作废原因：{c.voidReason}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="num text-[13px] font-semibold tracking-wide text-ink-2" data-testid={`coupon-member-code-${c.id}`}>
          {formatStoreCouponCode(c.code)}
        </span>
        {onVoid && (
          <Button size="sm" variant="ghost" onClick={onVoid} data-testid={`coupon-member-void-${c.id}`}>
            作废
          </Button>
        )}
      </div>
    </li>
  );
}

/** 手动发券：选启用的模板（限定的等级里没有这位会员、固定有效期已过的不能选）、张数、原因 */
function IssueCouponDialog({ open, member, onClose }: { open: boolean; member: MemberDetail; onClose: () => void }) {
  const session = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const templates = useCouponTemplates(open);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(open, () => {
    setTemplateId(null);
    setQuantity('1');
    setReason('');
    setError(null);
  });
  // 会员体系 v2（v0.7.23）：券的限定等级是档级 L0–L6
  const level = member.grade;
  const blocked = (t: CouponTemplate) =>
    t.levels.length > 0 && !t.levels.includes(level) ? `只发给 ${t.levels.map((l) => `L${l}`).join('、')}` : templateExpired(t, session.today) ? '有效期已过' : null;
  const choices = (templates.data ?? []).filter((t) => t.active);
  const template = choices.find((t) => t.id === templateId) ?? null;
  const n = Number(quantity);
  const problem = !template
    ? '请选择券'
    : blocked(template)
      ? `「${template.name}」${blocked(template)}，这位会员现在是 L${level}`
      : !quantity || !Number.isInteger(n) || n < 1 || n > MAX_MANUAL_COUPONS
        ? `张数请填 1 到 ${MAX_MANUAL_COUPONS}`
        : reason.trim().length < 2
          ? '请填写发券原因（至少 2 个字）'
          : null;

  const submit = async () => {
    if (problem || !template) return;
    setBusy(true);
    setError(null);
    // 发出前把操作编号与原请求存在本机并读回核对（存不了就不发）：没收到结果时关掉对话框、刷新、重新登录后，
    // 在「账户内券」上方查回、按原内容重新提交（同一编号，不会重复发）或确认作废（Codex 复审 6c3765c）
    const key = uuid();
    try {
      const r = await sendErpOp<CouponIssueResult>({
        key,
        type: 'coupon_issue',
        url: `/api/members/${member.id}/coupons`,
        body: { clientKey: key, templateId: template.id, quantity: n, reason: reason.trim() },
        summary: `${member.name}：${template.name} × ${n} 张`,
        staffName: session.staff.displayName,
      });
      toast(
        r.replayed
          ? { tone: 'info', title: '这笔券之前已经发出', body: `发券记录 ${r.issueNo}，没有重复发` }
          : { tone: 'success', title: `已给「${member.name}」发 ${r.coupons.length} 张「${template.name}」`, body: `发券记录 ${r.issueNo}` },
      );
      onClose();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({
          tone: 'info',
          title: '发券：没收到结果',
          body: '可能已经发出，也可能没有。这笔记在「账户内券」上方（刷新、重新登录也在）：先查回；查不到就按原内容重新提交（同一操作编号，不会重复发）或确认作废后再重新发。',
        });
        onClose();
      } else {
        setError(errorMessage(e));
        if (e instanceof ApiError && ['TEMPLATE_INACTIVE', 'TEMPLATE_EXPIRED', 'COUPON_LEVEL'].includes(e.code)) void qc.invalidateQueries({ queryKey: couponKeys.templates });
      }
    } finally {
      setBusy(false);
      // 发出了（或可能发出了）：会员的券、模板的已发张数与统计一起刷新
      void qc.invalidateQueries({ queryKey: couponKeys.member(member.id) });
      void qc.invalidateQueries({ queryKey: couponKeys.all });
    }
  };

  const days = template?.validity === 'days' ? (template.validDays ?? 1) : null;
  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title={`给「${member.name}」发券`}
      description="发到会员账户，结账时在收款里选用"
      footer={
        <>
          {problem && <span className="mr-auto self-center text-[12.5px] text-ink-3">{problem}</span>}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!!problem} onClick={submit} data-testid="coupon-issue-submit">
            发券
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-testid="coupon-issue-dialog">
        {templates.error ? (
          <Notice tone="error" title={errorMessage(templates.error)} />
        ) : !templates.data ? (
          <Skeleton className="h-11" />
        ) : (
          <Field label="券" htmlFor="coupon-issue-template" hint={choices.length === 0 ? '还没有启用的券模板，请店主或店总在后台「券与会员权益」里建' : undefined}>
            <Select id="coupon-issue-template" value={templateId ?? ''} onChange={(e) => setTemplateId(e.target.value ? Number(e.target.value) : null)} disabled={busy} className="h-11" data-testid="coupon-issue-template">
              <option value="">选择券</option>
              {choices.map((t) => {
                const why = blocked(t);
                return (
                  <option key={t.id} value={t.id} disabled={!!why}>
                    {t.name} · {t.summary}
                    {why ? `（${why}）` : ''}
                  </option>
                );
              })}
            </Select>
          </Field>
        )}
        {template && (
          <p className="rounded-md bg-paper-2 px-3 py-2 text-[12.5px] text-ink-2" data-testid="coupon-issue-preview">
            {template.summary} ·{' '}
            {days !== null ? `今天发：有效期 ${couponRangeText(session.today, shiftDate(session.today, days - 1))}` : templateValidityText(template)}
          </p>
        )}
        <Field label="张数" htmlFor="coupon-issue-quantity" hint={`一次最多 ${MAX_MANUAL_COUPONS} 张`}>
          <Input
            id="coupon-issue-quantity"
            fullWidth={false}
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_MANUAL_COUPONS}
            value={quantity}
            onChange={(e) => setQuantity(e.target.value.replace(/[^0-9]/g, ''))}
            disabled={busy}
            className="num w-28"
            data-testid="coupon-issue-quantity"
          />
        </Field>
        <Field label="发券原因" htmlFor="coupon-issue-reason" hint="至少 2 个字，会记在发券记录里，例如「老客人回馈」「投诉补偿」">
          <Textarea id="coupon-issue-reason" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} disabled={busy} data-testid="coupon-issue-reason" />
        </Field>
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}
