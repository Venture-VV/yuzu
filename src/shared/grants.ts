// 当场授权：值班经理 / 店总（或店主）在当前弹窗输入自己的账号密码，服务端签发一次性授权，
// 绑定用途、申请的员工与授权对象，5 分钟内有效；业务请求只带授权编号，密码不进入本机的待确认记录。
//   · vip_tag：散客或等级不够的会员使用 VIP 柜（值班经理、店总、店主可授权，经营规则开启后才可用）；
//   · over_limit：超过单笔上限的充值 / 消费（店总、店主可授权）；
//   · checkout_discount：结账时的「优惠 / 免单」（值班经理、店总、店主可授权，R1.2）；
//   · ticket_discount：改成更便宜的票种或儿童免票，接待时直接选免票也算（值班经理、店总、店主可授权，R1.2）。
// 优惠与降档的原因由申请的员工在弹窗里填写，随授权一起签发、核销后记到单据上。

export const GRANT_PURPOSES = ['vip_tag', 'over_limit', 'checkout_discount', 'ticket_discount'] as const;
export type GrantPurpose = (typeof GRANT_PURPOSES)[number];

export const GRANT_PURPOSE_LABELS: Record<GrantPurpose, string> = {
  vip_tag: '使用 VIP 柜',
  over_limit: '超过单笔上限',
  checkout_discount: '优惠 / 免单',
  ticket_discount: '降低票种 / 免票',
};

export const GRANT_TTL_MINUTES = 5;

/** VIP 柜授权的对象：哪位客人（会员编号；散客为 null）用哪张柜 */
export interface VipGrantTag {
  code: string;
  memberId: number | null;
}

export interface VipTagScope {
  tags: VipGrantTag[];
}

/** 超过单笔上限的授权对象：哪位会员、哪类业务、多少金额（金额必须与办理时完全一致） */
export interface OverLimitScope {
  kind: 'recharge' | 'consume';
  memberId: number;
  amount: number;
}

/** 优惠 / 免单的授权对象：一起结账的来访（升序）、优惠金额与原因（金额与客人必须与结账时完全一致） */
export interface DiscountScope {
  visitIds: number[];
  amount: number;
  reason: string;
}

/** 降低票种 / 免票的授权对象：哪张手牌改成哪个票种（接待时为将要发的牌），以及原因 */
export interface TicketGrantItem {
  tagCode: string;
  ticketTypeId: number;
}
export interface TicketDiscountScope {
  items: TicketGrantItem[];
  reason: string;
}

export type VipGrantRequest = { purpose: 'vip_tag'; scope: VipTagScope };
export type OverLimitGrantRequest = { purpose: 'over_limit'; scope: OverLimitScope };
export type DiscountGrantRequest = { purpose: 'checkout_discount'; scope: DiscountScope };
export type TicketGrantRequest = { purpose: 'ticket_discount'; scope: TicketDiscountScope };
export type GrantRequest = VipGrantRequest | OverLimitGrantRequest | DiscountGrantRequest | TicketGrantRequest;

/** 签发的授权：授权编号、授权人与有效期，连同申请时的用途与对象 */
export type Granted<R extends GrantRequest = GrantRequest> = R & {
  grantId: string;
  approverName: string;
  expiresAt: string;
};
export type IssuedGrant = Granted;
export type VipGrant = Granted<VipGrantRequest>;
export type OverLimitGrant = Granted<OverLimitGrantRequest>;
export type DiscountGrant = Granted<DiscountGrantRequest>;
export type TicketGrant = Granted<TicketGrantRequest>;

/** 来访编号按升序去重，授权与结账按同一顺序比较 */
export const sortedVisitIds = (ids: readonly number[]) => [...new Set(ids)].sort((a, b) => a - b);

/** 优惠授权是否仍可用于这次结账（客人、金额一致且未过期；服务端核销时再核对一次） */
export function discountGrantFits(grant: DiscountGrant | null, visitIds: readonly number[], amount: number, now = Date.now()): grant is DiscountGrant {
  if (!grant || grant.scope.amount !== amount || new Date(grant.expiresAt).getTime() <= now) return false;
  const a = sortedVisitIds(grant.scope.visitIds);
  const b = sortedVisitIds(visitIds);
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** 降档 / 免票授权是否覆盖这些手牌与票种 */
export function ticketGrantCovers(scope: TicketDiscountScope, needed: readonly TicketGrantItem[]): boolean {
  return needed.every((n) => scope.items.some((t) => t.tagCode === n.tagCode && t.ticketTypeId === n.ticketTypeId));
}

/** 超限授权是否仍可用于这笔业务（金额、会员、业务类型一致且未过期；服务端核销时再核对一次） */
export function overLimitGrantFits(grant: OverLimitGrant | null, scope: OverLimitScope, now = Date.now()): grant is OverLimitGrant {
  return (
    !!grant &&
    grant.scope.kind === scope.kind &&
    grant.scope.memberId === scope.memberId &&
    grant.scope.amount === scope.amount &&
    new Date(grant.expiresAt).getTime() > now
  );
}

/** 授权是否覆盖这些需要授权的柜（柜号与客人都要一致） */
export function grantCovers(scope: VipTagScope, needed: readonly VipGrantTag[]): boolean {
  return needed.every((n) => scope.tags.some((t) => t.code === n.code && t.memberId === n.memberId));
}
