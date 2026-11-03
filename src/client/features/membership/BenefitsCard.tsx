// 会员详情「本月可享」（会员体系 v2 第二期，v0.7.24；docs/BENEFITS.md 第 4 节）：按会员现在的档阶列出能用的本店权益——
//   · 券类：本期发了几张、能用几张（券在「账户内券」里，结账时用）；
//   · 事件礼：什么时候发、收到过几次；
//   · 服务与资格：本期用了几次 / 上限，「登记使用」（数次数、到上限拒绝；超时、断网、回复 500 时结果待确认）；
//   · 折扣类（v0.7.25）：几折、打哪些明细、哪几天——手牌结账时自动算；
//   · 升档以后还能享的；最近的使用登记（登记错的作废，写原因）。

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgePercent, CalendarHeart, CheckCircle2, ChevronDown, Gift, Sparkles, Ticket } from 'lucide-react';
import {
  BENEFIT_CATEGORY_LABELS,
  BENEFIT_EVENT_LABELS,
  BENEFIT_PERIOD_LABELS,
  MAX_BENEFIT_LIMIT,
  type BenefitUseRow,
  type MemberBenefitItem,
  type MemberBenefits,
} from '@shared/benefits';
import type { MemberDetail } from '@shared/types';
import { api, errorMessage, UncertainError } from '../../lib/api';
import { sendErpOp, useErpPending, type ErpPendingOp } from '../../lib/erpPending';
import { useCan, useSession } from '../../lib/session';
import { useResetOnOpen } from '../../lib/useResetOnOpen';
import { cn, formatDateTime, uuid } from '../../lib/utils';
import { Dialog } from '../../components/Overlay';
import { ErpPendingPanel } from '../../components/ErpPendingPanel';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Notice, PendingBadge, SectionTitle, Skeleton } from '../../components/ui';
import { benefitKeys } from './queries';

/** 这位会员的使用登记（提交地址带会员编号） */
const useUrl = (memberId: number) => `/api/members/${memberId}/benefit-uses`;

const periodSpan = (item: MemberBenefitItem) => (item.period === 'day' ? '今天' : item.period === 'month' ? '本月' : item.period === 'year' ? '今年' : '本月');

export function BenefitsCard({ member }: { member: MemberDetail }) {
  const can = useCan();
  const session = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: benefitKeys.member(member.id), queryFn: () => api.get<MemberBenefits>(`/api/members/${member.id}/benefits`) });
  const [using, setUsing] = useState<MemberBenefitItem | null>(null);
  const [voiding, setVoiding] = useState<BenefitUseRow | null>(null);
  const [voidBusy, setVoidBusy] = useState(false);
  const [showUses, setShowUses] = useState(false);
  const toast = useToast();
  const ofMember = (op: ErpPendingOp) => op.url === useUrl(member.id);
  const pending = useErpPending(['benefit_use']).filter(ofMember);
  const refresh = () => qc.invalidateQueries({ queryKey: benefitKeys.member(member.id) });
  if (q.isPending) return <Skeleton className="h-40" />;
  if (q.error || !q.data) return <Notice tone="error" title={q.error?.message ?? '本月可享没有加载出来'} />;
  const d = q.data;
  const group = (cat: MemberBenefitItem['category']) => d.items.filter((i) => i.category === cat);
  const coupons = group('coupon');
  const events = group('event');
  const services = group('service');
  const infos = group('info');
  const discounts = group('discount');
  const canVoid = (u: BenefitUseRow) => u.status === 'active' && (can('benefit.publish') || (u.staffId === session.staff.id && u.businessDate === session.today));
  const voidUse = async (reason: string) => {
    if (!voiding) return;
    setVoidBusy(true);
    try {
      await api.post(`/api/benefit-uses/${voiding.id}/void`, { reason });
      toast({ tone: 'success', title: '已作废这次登记', body: `${voiding.benefitName} · ${voiding.quantity} 次` });
      setVoiding(null);
      await refresh();
    } catch (e) {
      toast({ tone: 'error', title: '没有作废', body: errorMessage(e) });
    } finally {
      setVoidBusy(false);
    }
  };
  return (
    <Card className="p-5" data-testid="member-benefits">
      <SectionTitle aside={<PendingBadge title="权益的配置起点、数量与发放时机按会员文档与默认做法，待店主确认（后台「会员权益」可改）" />}>
        <span className="flex items-center gap-2">
          <Sparkles className="size-4 text-yuzu-deep" /> 本月可享
          <span className="text-[13px] font-normal text-ink-3">{d.state.label}</span>
        </span>
      </SectionTitle>
      {can('benefit.use') && <ErpPendingPanel types={['benefit_use']} filter={ofMember} className="mt-3 space-y-2" onFound={() => void refresh()} />}
      {d.items.length === 0 ? (
        <p className="mt-3 text-[13px] text-ink-3">还没有这一档能享的已发布权益。</p>
      ) : (
        <div className="mt-3 space-y-4">
          {coupons.length > 0 && (
            <Group icon={<Ticket className="size-4 text-pine" />} title={BENEFIT_CATEGORY_LABELS.coupon} hint="券在下方「账户内券」里，结账时用">
              {coupons.map((i) => (
                <Row key={i.benefitId} item={i} testId={`member-benefit-${i.code}`}>
                  <span className="num">
                    {i.period === 'year' ? '今年' : '本月'}发 {i.granted} / {i.quantity ?? 0} 张 · 能用 {i.available} 张
                    {i.quantity !== null && i.granted < i.quantity && <span className="text-ink-3">（还差 {i.quantity - i.granted} 张，自动任务稍后补发）</span>}
                  </span>
                </Row>
              ))}
            </Group>
          )}
          {events.length > 0 && (
            <Group icon={<Gift className="size-4 text-ember" />} title={BENEFIT_CATEGORY_LABELS.event} hint="事件发生时自动发券">
              {events.map((i) => (
                <Row key={i.benefitId} item={i} testId={`member-benefit-${i.code}`}>
                  <span>
                    {i.events.map((e) => BENEFIT_EVENT_LABELS[e]).join('、')} · 每次 {i.quantity ?? 0} 张
                    {i.granted > 0 ? ` · 收到过 ${i.granted} 次（最近 ${i.lastGrantDate}）` : ' · 还没收到过'}
                  </span>
                </Row>
              ))}
            </Group>
          )}
          {services.length > 0 && (
            <Group icon={<CalendarHeart className="size-4 text-lake" />} title={BENEFIT_CATEGORY_LABELS.service} hint="服务的同事点「登记使用」，设了次数的到上限不能再登记">
              {services.map((i) => {
                const full = i.quantity !== null && i.used >= i.quantity;
                return (
                  <Row
                    key={i.benefitId}
                    item={i}
                    testId={`member-benefit-${i.code}`}
                    action={
                      can('benefit.use') && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={full || pending.length > 0 || member.status !== 'active'}
                          title={
                            pending.length > 0
                              ? '上一次登记结果待确认，请先在上方查回、按原内容重新提交或作废'
                              : full
                                ? `${periodSpan(i)}的次数已经用完`
                                : undefined
                          }
                          onClick={() => setUsing(i)}
                          data-testid={`benefit-use-${i.code}`}
                        >
                          登记使用
                        </Button>
                      )
                    }
                  >
                    <span className={cn('num', full && 'font-semibold text-clay')}>
                      {i.quantity === null ? `不限次 · 本月登记 ${i.used} 次` : `${periodSpan(i)}已用 ${i.used} / ${i.quantity} 次（${BENEFIT_PERIOD_LABELS[i.period]}）`}
                    </span>
                  </Row>
                );
              })}
            </Group>
          )}
          {discounts.length > 0 && (
            <Group icon={<BadgePercent className="size-4 text-yuzu-deep" />} title={BENEFIT_CATEGORY_LABELS.discount} hint="手牌结账时自动算：一张结账单只享一种、不与券同用">
              {discounts.map((i) => (
                <div key={i.benefitId} className="py-1.5" data-testid={`member-benefit-${i.code}`}>
                  <p className="text-[13.5px] font-semibold text-ink">{i.name}</p>
                  <p className="text-[12.5px] text-ink-3">{i.discount?.text ?? '结账时自动'}</p>
                </div>
              ))}
            </Group>
          )}
          {infos.length > 0 && (
            <Group icon={<CheckCircle2 className="size-4 text-moss" />} title={BENEFIT_CATEGORY_LABELS.info}>
              {infos.map((i) => (
                <Row key={i.benefitId} item={i} testId={`member-benefit-${i.code}`} />
              ))}
            </Group>
          )}
        </div>
      )}
      {d.upcoming.length > 0 && (
        <p className="mt-4 text-[12.5px] text-ink-3" data-testid="member-benefits-upcoming">
          升档以后还能享：
          {d.upcoming.map((u) => `${u.name}（${u.startLabel}）`).join('、')}
        </p>
      )}
      {d.uses.length > 0 && (
        <div className="mt-4 border-t border-line pt-3">
          <button type="button" className="flex items-center gap-1 text-[13px] font-semibold text-ink-2" onClick={() => setShowUses((v) => !v)} aria-expanded={showUses}>
            <ChevronDown className={cn('size-4 transition-transform', showUses && 'rotate-180')} /> 使用登记（最近 {d.uses.length} 条）
          </button>
          {showUses && (
            <ul className="mt-2 space-y-1.5 text-[13px]" data-testid="member-benefit-uses">
              {d.uses.map((u) => (
                <li key={u.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="num text-ink-3">{formatDateTime(u.createdAt)}</span>
                  <span className={cn('font-semibold', u.status === 'voided' ? 'text-ink-4 line-through' : 'text-ink')}>
                    {u.benefitName} × {u.quantity}
                  </span>
                  <span className="text-ink-3">经办 {u.staffName}</span>
                  {u.note && <span className="text-ink-3">· {u.note}</span>}
                  {u.status === 'voided' && <Badge tone="clay">已作废：{u.voidReason}</Badge>}
                  {canVoid(u) && (
                    <Button size="sm" variant="ghost" onClick={() => setVoiding(u)} data-testid={`benefit-use-void-${u.id}`}>
                      作废
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <UseDialog item={using} member={member} onClose={() => setUsing(null)} onDone={() => void refresh()} />
      <ReasonDialog
        open={!!voiding}
        title="作废这次登记"
        description={voiding ? `${voiding.benefitName} × ${voiding.quantity}（${formatDateTime(voiding.createdAt)}，经办 ${voiding.staffName}）。作废后不占次数，留原因与经办人。` : undefined}
        confirmLabel="作废"
        danger
        busy={voidBusy}
        testId="benefit-use-void"
        onClose={() => setVoiding(null)}
        onConfirm={(reason) => void voidUse(reason)}
      />
    </Card>
  );
}

function Group({ icon, title, hint, children }: { icon: React.ReactNode; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="flex flex-wrap items-center gap-x-1.5 text-[13px] font-bold text-ink-2">
        <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
          {icon} {title}
        </span>
        {hint && <span className="text-[12.5px] font-normal text-ink-3">{hint}</span>}
      </p>
      <ul className="mt-1.5 divide-y divide-line/70 rounded-lg border border-line">{children}</ul>
    </div>
  );
}

function Row({ item, children, action, testId }: { item: MemberBenefitItem; children?: React.ReactNode; action?: React.ReactNode; testId: string }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2" data-testid={testId}>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-1.5 text-[13.5px] font-semibold text-ink" title={[item.content, item.conditions].filter(Boolean).join('\n')}>
          {item.name}
          <span className="text-[12px] font-normal whitespace-nowrap text-ink-4">
            {item.code} · {item.startLabel} 起
          </span>
        </p>
        {children && <p className="text-[12.5px] text-ink-2">{children}</p>}
      </div>
      {action}
    </li>
  );
}

/** 登记一次使用：先把编号和原请求存在本机（存不了就不发）；超时、断网、回复 500 时结果待确认，在卡片上方查回、重提或作废 */
function UseDialog({ item, member, onClose, onDone }: { item: MemberBenefitItem | null; member: MemberDetail; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const session = useSession();
  const [quantity, setQuantity] = useState('1');
  const [note, setNote] = useState('');
  const [key, setKey] = useState(uuid);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(!!item, () => {
    setQuantity('1');
    setNote('');
    setKey(uuid());
    setError(null);
  });
  if (!item) return null;
  const n = /^\d+$/.test(quantity.trim()) ? Number(quantity.trim()) : NaN;
  const left = item.quantity === null ? null : item.quantity - item.used;
  const ok = Number.isInteger(n) && n >= 1 && n <= (left ?? MAX_BENEFIT_LIMIT);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await sendErpOp({
        key,
        type: 'benefit_use',
        url: useUrl(member.id),
        body: { clientKey: key, benefitId: item.benefitId, quantity: n, note: note.trim() },
        summary: `${member.name}：${item.name} × ${n}`,
        staffName: session.staff.displayName,
      });
      toast({ tone: 'success', title: '已登记使用', body: `${member.name}：${item.name} × ${n}` });
      onDone();
      onClose();
    } catch (e) {
      if (e instanceof UncertainError) {
        toast({ tone: 'info', title: '登记结果待确认', body: '已记在本机：请在「本月可享」上方查回、按原内容重新提交或作废，不要另起一笔。' });
        onDone();
        onClose();
        return;
      }
      setError(errorMessage(e));
      onDone();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`登记使用：${item.name}`}
      description={
        item.quantity === null
          ? `${member.name}（${item.startLabel} 起）。不限次，登记留痕。`
          : `${member.name}${periodSpan(item)}已用 ${item.used} / ${item.quantity} 次，还能登记 ${Math.max(0, left ?? 0)} 次。`
      }
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={!ok} data-testid="benefit-use-submit">
            确认登记
          </Button>
        </div>
      }
    >
      <div className="grid gap-4">
        {item.conditions && <Notice tone="info" title="使用条件">{item.conditions}</Notice>}
        <Field label="次数" htmlFor="benefit-use-quantity">
          <Input id="benefit-use-quantity" inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} data-testid="benefit-use-quantity" />
        </Field>
        <Field label="备注（可选）" htmlFor="benefit-use-note" hint="例如手牌号、陪同人数">
          <Input id="benefit-use-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} data-testid="benefit-use-note" />
        </Field>
        {error && <Notice tone="error" title={error} />}
      </div>
    </Dialog>
  );
}
