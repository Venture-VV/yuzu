// 当场授权：值班经理 / 店总（或店主）在当前弹窗输入自己的账号密码，服务端签发一次性授权，
// 绑定用途、申请的员工与授权对象，5 分钟内有效；业务请求只带授权编号，密码不进入本机的待确认记录。
//   · vip_tag：散客或等级不够的会员使用 VIP 柜（值班经理、店总、店主可授权，经营规则开启后才可用）；
//   · over_limit：超过单笔上限的充值 / 消费（店总、店主可授权）。

export const GRANT_PURPOSES = ['vip_tag', 'over_limit'] as const;
export type GrantPurpose = (typeof GRANT_PURPOSES)[number];

export const GRANT_PURPOSE_LABELS: Record<GrantPurpose, string> = {
  vip_tag: '使用 VIP 柜',
  over_limit: '超过单笔上限',
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

export type VipGrantRequest = { purpose: 'vip_tag'; scope: VipTagScope };
export type OverLimitGrantRequest = { purpose: 'over_limit'; scope: OverLimitScope };
export type GrantRequest = VipGrantRequest | OverLimitGrantRequest;

/** 签发的授权：授权编号、授权人与有效期，连同申请时的用途与对象 */
export type Granted<R extends GrantRequest = GrantRequest> = R & {
  grantId: string;
  approverName: string;
  expiresAt: string;
};
export type IssuedGrant = Granted;
export type VipGrant = Granted<VipGrantRequest>;
export type OverLimitGrant = Granted<OverLimitGrantRequest>;

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
