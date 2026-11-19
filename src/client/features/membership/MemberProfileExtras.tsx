// 会员详情身份区里 8.1.15 加的一行（docs/MEMBERS_V8115.md）：卡类型、推荐人、偏好项目。
// 单独一个部件：会员详情别的部分不用动，没有内容的项不显示。

import { MEMBER_CARD_TYPE_LABELS } from '@shared/member-form';
import type { MemberDetail } from '@shared/types';
import { Badge } from '../../components/ui';

const TONES = { ecard: 'neutral', physical: 'moss', anonymous: 'lake' } as const;

export function MemberProfileExtras({ member }: { member: MemberDetail }) {
  return (
    <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-ink-3" data-testid="member-profile-extras">
      <Badge tone={TONES[member.cardType]}>{MEMBER_CARD_TYPE_LABELS[member.cardType]}</Badge>
      {member.referrer && (
        <span data-testid="member-referrer">
          推荐人 <b className="text-ink-2">{member.referrer.name}</b> <span className="num">{member.referrer.memberNo}</span>
        </span>
      )}
      {member.preferredItems.length > 0 && (
        <span className="break-all" data-testid="member-preferred-items">
          偏好 <b className="text-ink-2">{member.preferredItems.join('、')}</b>
        </span>
      )}
    </p>
  );
}
