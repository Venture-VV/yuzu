// 会员档阶徽标（会员体系 v2，v0.7.23）：「L3 观澜 · 享」；补充期标黄，到期提醒名单内（30 天内）写出还有几天。
// 前台、会员工作台、搜索结果都用它；档名按会员规则（后台可改）。

import { Award } from 'lucide-react';
import { daysToExpiry, gradeLabel, reminderBucket, type MemberGradeFields } from '@shared/membership';
import { useSession } from '../../lib/session';
import { cn } from '../../lib/utils';
import { Badge } from '../../components/ui';
import { useMembershipRules } from './queries';

export function GradeBadge({ member, withExpiry = false, className }: { member: MemberGradeFields; withExpiry?: boolean; className?: string }) {
  const session = useSession();
  const rules = useMembershipRules().data;
  const label = rules ? gradeLabel(rules, member.grade, member.tier) : `L${member.grade}`;
  const inGrace = member.graceUntil !== null && member.graceUntil >= session.today;
  const daysLeft = member.grade > 0 ? daysToExpiry({ ...member, cycleStart: null }, session.today) : null;
  const bucket = rules && !inGrace ? reminderBucket(rules, daysLeft) : null;
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1.5', className)} data-testid="grade-badge">
      <Badge tone={member.grade === 0 ? 'neutral' : inGrace ? 'ember' : 'yuzu'} icon={<Award className="size-3.5" />}>
        {label}
      </Badge>
      {withExpiry && member.grade > 0 && (
        inGrace ? (
          <Badge tone="ember">补充期至 {member.graceUntil}</Badge>
        ) : (
          <span className={cn('text-[12px] whitespace-nowrap', bucket !== null && bucket <= 30 ? 'font-semibold text-ember' : 'text-ink-3')}>
            会籍至 {member.cycleEnd}
            {bucket !== null && daysLeft !== null ? `（还有 ${daysLeft} 天）` : ''}
          </span>
        )
      )}
    </span>
  );
}
