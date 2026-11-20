// 发卡台与收银台共用的小部件（8.1.15，docs/DESKS_V8115.md）：
//   · 两个台共用一个「补录纸质单」状态（DeskLayout）；
//   · 发卡台的会员基础权益（MemberEntitlements）：选了会员马上看得到档阶能享什么；
//   · 收银台的「权益与优惠」（BillPerks）：这位客人现在能用的会员折扣、签赠券、券、次卡，各带经办人；结过账的显示用了哪些。

import { useState } from 'react';
import { Outlet } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Crown, Gift, Signature, Ticket } from 'lucide-react';
import { minutesText, rateText, type MemberBenefits } from '@shared/benefits';
import type { CheckoutPreview } from '@shared/checkout';
import type { VisitDetail } from '@shared/frontdesk';
import type { MemberGradeBadge } from '@shared/membership';
import { formatStoreCouponCode } from '@shared/coupons';
import { api } from '../../lib/api';
import { useCan } from '../../lib/session';
import { cn } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Badge, Skeleton } from '../../components/ui';
import { GiftIssueDialog } from '../gifts/GiftIssueDialog';
import { BackfillProvider } from './backfill';
import { PerkRow } from './CheckoutReceipt';
import { fk, useCheckout } from './queries';

/** 两个台共用一个补录状态（FS14）：在发卡台填了纸质单号与时间，切到收银台结账时还在 */
export function DeskLayout() {
  return (
    <BackfillProvider>
      <Outlet />
    </BackfillProvider>
  );
}

/** 档阶的短写：「L3 观澜 · 初」→「L3」，放在手牌卡片与清单的窄位置 */
export const gradeShort = (label: string) => label.split(/[\s·]/)[0] ?? label;

/**
 * 发卡台 · 会员等级识别（FS6）：档阶能用几级 VIP 柜、哪几项打几折、浴票延迟、本月可享的服务几项、手上能用的券。
 * 权益清单要「查找与查看会员」；没有这项权限的账号只显示档阶与券（都在手牌板的数据里）。
 */
export function MemberEntitlements({ memberId, grade, coupons, gifts }: { memberId: number; grade: MemberGradeBadge | null; coupons: number; gifts: number }) {
  const can = useCan();
  const benefits = useQuery({
    queryKey: ['members', memberId, 'benefits'],
    queryFn: () => api.get<MemberBenefits>(`/api/members/${memberId}/benefits`),
    enabled: can('member.read'),
    staleTime: 60_000,
  });
  const items = benefits.data?.items ?? [];
  // 折扣写清是哪一项的（「派对房及包房折扣 5.5 折」）：折扣各有适用的范围，不能只写一个「结账几折」
  const discounts = items.flatMap((i) => (i.discount ? [{ id: i.benefitId, text: `${i.name} ${rateText(i.discount.rate)}`, title: i.discount.text }] : []));
  const extension = Math.max(0, ...items.map((i) => i.extension?.minutes ?? 0));
  const services = items.filter((i) => i.category === 'service').length;
  const chips: { key: string; text: string; title?: string; tone: 'yuzu' | 'pine' | 'lake' | 'neutral' | 'ember' }[] = [];
  if (grade && grade.lockerLevel > 0) chips.push({ key: 'locker', text: `VIP 柜 ${grade.lockerLevel} 级及以下`, tone: 'yuzu' });
  if (grade?.graceUntil) chips.push({ key: 'grace', text: `补充期至 ${grade.graceUntil}`, tone: 'ember' });
  for (const d of discounts.slice(0, 2)) chips.push({ key: `discount-${d.id}`, text: d.text, title: d.title, tone: 'pine' });
  if (discounts.length > 2) chips.push({ key: 'discount-more', text: `另有 ${discounts.length - 2} 项折扣`, tone: 'pine' });
  if (extension > 0) chips.push({ key: 'extension', text: `浴票延迟 ${minutesText(extension)}`, tone: 'lake' });
  if (services > 0) chips.push({ key: 'service', text: `本月可享服务 ${services} 项`, tone: 'neutral' });
  if (coupons > 0) chips.push({ key: 'coupons', text: gifts > 0 ? `券 ${coupons} 张（签赠 ${gifts}）` : `券 ${coupons} 张`, tone: 'pine' });
  if (benefits.isPending && can('member.read') && chips.length === 0) return <Skeleton className="mt-2 h-6" />;
  if (chips.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 px-1" data-testid="member-entitlements" aria-label="会员基础权益">
      <Crown className="size-3.5 shrink-0 text-yuzu-deep" />
      {chips.map((c) => (
        <span key={c.key} title={c.title}>
          <Badge tone={c.tone}>{c.text}</Badge>
        </span>
      ))}
    </div>
  );
}

/**
 * 收银台 · 权益与优惠（FS8）。在店未结：列现在能用的（结账时在结账对话框里选，规则不变）；已结账：列这张结账单用了的。
 * 有「发放签赠」的人可以当场给这位会员发（渠道默认「前台」），发完马上出现在这里。
 */
export function BillPerks({ visit, preview, loading }: { visit: VisitDetail; preview: CheckoutPreview | undefined; loading: boolean }) {
  const can = useCan();
  const qc = useQueryClient();
  const [issuing, setIssuing] = useState(false);
  const checkout = useCheckout(visit.status !== 'open' && visit.checkout ? visit.checkout.id : null);

  if (visit.status !== 'open') {
    const perks = checkout.data?.perks ?? [];
    if (perks.length === 0) return null;
    return (
      <section className="mt-3 rounded-[14px] border border-line bg-card px-4 py-3" data-testid="bill-perks" aria-label="优惠与赠送">
        <h3 className="flex items-center gap-1 text-[12px] font-bold text-ink-3">
          <Gift className="size-3.5" /> 这张结账单用了的优惠与赠送
        </h3>
        <div className="mt-2 space-y-1.5 text-[13px]">
          {perks.map((k) => (
            <PerkRow key={k.paymentId} perk={k} />
          ))}
        </div>
      </section>
    );
  }

  const discount = preview?.memberDiscounts?.[0];
  const coupons = preview?.storeCoupons ?? [];
  const cards = preview?.countCards ?? [];
  const empty = !discount && coupons.length === 0 && cards.length === 0;
  const canGift = can('gift.issue') && !!visit.member;
  return (
    <section className="mt-3 rounded-[14px] border border-line bg-card px-4 py-3" data-testid="bill-perks" aria-label="权益与优惠">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1 text-[12px] font-bold text-ink-3">
          <Gift className="size-3.5" /> 权益与优惠（结账时选）
        </h3>
        {canGift && (
          <button type="button" onClick={() => setIssuing(true)} className="flex items-center gap-1 text-[12.5px] font-semibold text-pine hover:underline" data-testid="bill-gift-issue">
            <Signature className="size-3.5" /> 发放签赠
          </button>
        )}
      </div>
      {loading && !preview ? (
        <Skeleton className="mt-2 h-10" />
      ) : empty ? (
        <p className="mt-2 text-[12.5px] text-ink-3" data-testid="bill-perks-empty">
          {visit.member ? '这位会员现在没有能用的折扣、券与次卡。' : '散客没有会员权益。'}优惠 / 免单由值班经理及以上在结账时当场授权。
        </p>
      ) : (
        <ul className="mt-2 space-y-2 text-[13px]">
          {discount && (
            <li data-testid="bill-perk-member_discount">
              <p className="flex items-baseline gap-2">
                <Badge tone="pine">会员折扣</Badge>
                <span className="min-w-0 flex-1 truncate font-semibold">
                  {discount.stateLabel} · {rateText(discount.rate)}
                </span>
                <span className="num shrink-0 font-bold text-pine">
                  可省 <Money cents={discount.amount} />
                </span>
              </p>
              <p className="mt-0.5 text-[12px] text-ink-3">
                {discount.name}，按会员档阶自动带上{discount.companions.length > 0 && `（含同行 ${discount.companions.join('、')}）`}；用券、优惠 / 免单、次卡时不同用
              </p>
            </li>
          )}
          {coupons.map((c) => (
            <li key={c.couponId} className={cn(!c.usable && 'opacity-60')} data-testid={c.gift ? 'bill-perk-gift' : 'bill-perk-coupon'}>
              <p className="flex items-baseline gap-2">
                <Badge tone={c.gift ? 'yuzu' : 'pine'}>{c.gift ? '签赠' : '券'}</Badge>
                <span className="min-w-0 flex-1 truncate font-semibold">{c.templateName}</span>
                {c.usable ? (
                  <span className="num shrink-0 font-bold text-pine">
                    可抵 <Money cents={c.amount} />
                  </span>
                ) : (
                  <span className="shrink-0 text-[12px] text-ink-3">这单用不了</span>
                )}
              </p>
              <p className="mt-0.5 text-[12px] break-all text-ink-3">
                {c.summary} · 有效期到 {c.validTo} · 券码 {formatStoreCouponCode(c.code)}
              </p>
              {c.gift && (
                <p className="text-[12px] break-all text-yuzu-deep" data-testid="bill-perk-gift-operators">
                  {[c.gift.channel, c.gift.issuerName && `发放 ${c.gift.issuerName}`, c.gift.authorizerName && `授权 ${c.gift.authorizerName}`, c.gift.reason].filter(Boolean).join(' · ')}
                </p>
              )}
              {!c.usable && c.reason && <p className="text-[12px] text-clay">{c.reason}</p>}
            </li>
          ))}
          {cards.map((c) => (
            <li key={c.cardId} className={cn(c.coverable === 0 && 'opacity-60')} data-testid="bill-perk-count_card">
              <p className="flex items-baseline gap-2">
                <Badge tone="lake" icon={<Ticket className="size-3" />}>
                  次卡
                </Badge>
                <span className="min-w-0 flex-1 truncate font-semibold">{c.name}</span>
                <span className="num shrink-0 text-[12px] text-ink-3">{c.coverable > 0 ? `这单能抵 ${c.coverable} 份 · 剩 ${c.remaining} 次` : `剩 ${c.remaining} 次`}</span>
              </p>
              {c.coverable === 0 && c.reason && <p className="mt-0.5 text-[12px] text-ink-3">{c.reason}</p>}
            </li>
          ))}
        </ul>
      )}
      {issuing && visit.member && (
        <GiftIssueDialog
          defaultChannel="前台"
          presetMember={{
            id: visit.member.id,
            memberNo: visit.member.memberNo,
            name: visit.member.name,
            phone: visit.member.phone,
            grade: visit.memberGrade?.grade ?? 0,
            usable: visit.member.status === 'active',
          }}
          onClose={() => setIssuing(false)}
          onDone={async () => {
            setIssuing(false);
            await Promise.all([qc.invalidateQueries({ queryKey: ['frontdesk', 'checkout-preview'] }), qc.invalidateQueries({ queryKey: fk.board })]);
          }}
        />
      )}
    </section>
  );
}
