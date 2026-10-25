import { ArrowLeft, Bath, CirclePlus, PencilLine, StickyNote } from 'lucide-react';
import { formatPhone } from '@shared/labels';
import type { MemberDetail as Member } from '@shared/types';
import { useActivity } from '../../lib/queries';
import { useCan } from '../../lib/session';
import { avatarTone, cn, relativeTime } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { Badge, Button, Card, IconButton, SectionTitle, Skeleton } from '../../components/ui';
import { ActivityRow } from './ActivityList';

export function MemberDetail({
  member,
  onRecharge,
  onConsume,
  onEdit,
  onReverse,
  onBack,
  activeFlow,
}: {
  member: Member;
  onRecharge: () => void;
  onConsume: () => void;
  onEdit: () => void;
  onReverse: (consumptionId: number) => void;
  onBack?: () => void;
  activeFlow: 'recharge' | 'consume' | null;
}) {
  const can = useCan();
  const activity = useActivity(member.id);
  const total = member.principalBalance + member.bonusBalance;

  return (
    <div className="mx-auto flex w-full max-w-[880px] flex-col gap-4 p-4 md:p-6">
      {/* 身份 */}
      <Card className="paper-grain overflow-hidden">
        <div className="flex items-start gap-4 p-5">
          {onBack && (
            <IconButton label="返回会员列表" onClick={onBack} className="-ml-2">
              <ArrowLeft className="size-5" />
            </IconButton>
          )}
          <span className={cn('flex size-14 shrink-0 items-center justify-center rounded-full text-[22px] font-bold', avatarTone(member.id))}>
            {member.name.slice(0, 1)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[22px] leading-tight font-bold tracking-tight break-all text-ink">{member.name}</h2>
              {member.status === 'frozen' && <Badge tone="clay">已停用</Badge>}
              {member.isSynthetic && <Badge tone="ember">合成数据</Badge>}
            </div>
            <p className="num mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[13px] text-ink-2">
              <span className="font-semibold">{formatPhone(member.phone)}</span>
              <span className="text-ink-3">{member.memberNo}</span>
              {member.gender && <span className="text-ink-3">{member.gender === 'female' ? '女' : '男'}</span>}
              {member.birthday && <span className="text-ink-3">生日 {member.birthday.slice(5)}</span>}
            </p>
            <p className="mt-1 text-[12.5px] text-ink-3">
              最近 {relativeTime(member.lastActivityAt)} · 建档 {member.createdAt.slice(0, 10)}
              {member.createdByName ? ` · ${member.createdByName}` : ''}
            </p>
          </div>
          {can('member.write') && (
            <Button size="sm" variant="secondary" icon={<PencilLine className="size-3.5" />} onClick={onEdit}>
              编辑
            </Button>
          )}
        </div>
        {member.note && (
          <div className="mx-5 mb-5 flex gap-2 rounded-md bg-card/80 px-3 py-2 text-[13px] text-ink-2 ring-1 ring-line">
            <StickyNote className="mt-0.5 size-4 shrink-0 text-yuzu-deep" />
            <span className="break-all">{member.note}</span>
          </div>
        )}

        {/* 余额：合计 / 本金 / 赠金 分层展示 */}
        <div className="grid grid-cols-1 border-t border-line bg-card sm:grid-cols-[1.25fr_1fr_1fr]">
          <div className="px-5 py-4">
            <p className="text-[12.5px] font-semibold text-ink-3">可用余额</p>
            <Money cents={total} className={cn('mt-1 text-[36px] leading-none font-bold tracking-tight', total ? 'text-ink' : 'text-ink-4')} />
          </div>
          <div className="border-t border-line px-5 py-4 sm:border-t-0 sm:border-l">
            <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-3">
              <span className="size-2 rounded-full bg-pine" />
              本金
            </p>
            <Money cents={member.principalBalance} className="mt-1.5 text-[22px] leading-none font-bold text-pine" />
            <p className="mt-1.5 text-[12px] text-ink-3">
              累计实收 <Money cents={member.stats.totalPaid} />
            </p>
          </div>
          <div className="border-t border-line px-5 py-4 sm:border-t-0 sm:border-l">
            <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-3">
              <span className="size-2 rounded-full bg-yuzu" />
              赠金
            </p>
            <Money cents={member.bonusBalance} className="mt-1.5 text-[22px] leading-none font-bold text-yuzu-deep" />
            <p className="mt-1.5 text-[12px] text-ink-3">
              累计赠送 <Money cents={member.stats.totalBonusGranted} />
            </p>
          </div>
        </div>
      </Card>

      {/* 常用操作 */}
      <div className="grid grid-cols-2 gap-3">
        {can('recharge.create') && (
          <Button
            variant="primary"
            size="lg"
            className={cn('h-14 text-[16px]', activeFlow === 'recharge' && 'ring-4 ring-pine/20')}
            icon={<CirclePlus className="size-5" />}
            kbd="R"
            onClick={onRecharge}
            disabled={member.status !== 'active'}
          >
            充值
          </Button>
        )}
        {can('consume.create') && (
          <Button
            variant="accent"
            size="lg"
            className={cn('h-14 text-[16px]', activeFlow === 'consume' && 'ring-4 ring-yuzu/40')}
            icon={<Bath className="size-5" />}
            kbd="X"
            onClick={onConsume}
            disabled={member.status !== 'active'}
          >
            消费
          </Button>
        )}
      </div>

      <div className="flex flex-wrap gap-2 text-[12.5px]">
        <span className="rounded-full bg-paper-2 px-3 py-1 font-semibold text-ink-2">
          充值 {member.stats.rechargeCount} 次
        </span>
        <span className="rounded-full bg-paper-2 px-3 py-1 font-semibold text-ink-2">
          消费 {member.stats.consumeCount} 次 · 累计 <Money cents={member.stats.totalConsumed} />
        </span>
        {member.stats.reversedCount > 0 && (
          <span className="rounded-full bg-clay-soft/70 px-3 py-1 font-semibold text-clay">已撤销 {member.stats.reversedCount} 笔</span>
        )}
      </div>

      {/* 余额记录 */}
      <Card className="p-2">
        <SectionTitle className="px-3 pt-2.5 pb-1.5" aside={<span className="text-[12px] text-ink-3">本金 · 赠金分别记录</span>}>
          余额记录
        </SectionTitle>
        {activity.isPending ? (
          <div className="space-y-2 p-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
        ) : (activity.data ?? []).length === 0 ? (
          <EmptyState art="pool" title="还没有余额记录" description="充值后这里会出现每一笔余额变化。" />
        ) : (
          <div className="divide-y divide-line/70">
            {activity.data!.map((row) => (
              <ActivityRow key={row.id} row={row} onReverse={can('consume.reverse') ? onReverse : undefined} />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

export function MemberDetailSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-[880px] flex-col gap-4 p-4 md:p-6">
      <Skeleton className="h-[220px] rounded-lg" />
      <div className="grid grid-cols-2 gap-3">
        <Skeleton className="h-14" />
        <Skeleton className="h-14" />
      </div>
      <Skeleton className="h-64 rounded-lg" />
    </div>
  );
}
