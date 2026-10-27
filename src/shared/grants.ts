// 当场授权：值班经理 / 店总（或店主）在当前弹窗输入自己的账号密码，服务端签发一次性授权，
// 绑定用途、申请的员工与授权对象，5 分钟内有效；业务请求只带授权编号，密码不进入本机的待确认记录。

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

export interface IssuedGrant {
  grantId: string;
  purpose: GrantPurpose;
  approverName: string;
  expiresAt: string;
  scope: VipTagScope;
}

/** 授权是否覆盖这些需要授权的柜（柜号与客人都要一致） */
export function grantCovers(scope: VipTagScope, needed: readonly VipGrantTag[]): boolean {
  return needed.every((n) => scope.tags.some((t) => t.code === n.code && t.memberId === n.memberId));
}
