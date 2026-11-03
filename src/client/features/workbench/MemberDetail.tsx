import { ArrowLeft, Bath, CirclePlus, PencilLine, StickyNote } from 'lucide-react';
import { formatPhone } from '@shared/labels';
import { lastUsableDate } from '@shared/business-date';
import { displayFieldValue } from '@shared/member-fields';
import { channelLabel } from '@shared/members';
import type { MemberDetail as Member } from '@shared/types';
import { useActivity } from '../../lib/queries';
import { useCan, useSession } from '../../lib/session';
import { avatarTone, cn, formatDate, formatTime, relativeTime } from '../../lib/utils';
import { EmptyState } from '../../components/EmptyState';
import { Money } from '../../components/Money';
import { Badge, Button, Card, IconButton, SectionTitle, Skeleton } from '../../components/ui';
import { ActivityRow } from './ActivityList';
import { BonusLotsCard, MemberCouponsCard } from './MemberExtras';
import { GradeBadge } from '../membership/GradeBadge';
import { GradeCard } from '../membership/GradeCard';
import { BenefitsCard } from '../membership/BenefitsCard';

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
  const session = useSession();
  const activity = useActivity(member.id);
  const total = member.principalBalance + member.bonusBalance;
  // 有到期时间的赠金（先到期的在前）；长期有效的不提示
  const expiring = (member.bonusLots ?? []).filter((l) => l.expiresAt !== null);
  // 自定义字段：只显示启用且已填写的
  const channel = channelLabel(session.rules.memberChannels ?? [], member.channel);
  const fieldRows = session.rules.memberFields
    .filter((d) => d.active)
    .map((d) => ({ key: d.key, label: d.label, value: displayFieldValue(member.customFields?.[d.key]) }))
    .filter((r) => r.value !== null);

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
              <GradeBadge member={member} withExpiry />
              {member.status === 'frozen' && <Badge tone="clay">已停用</Badge>}
              {member.isSynthetic && <Badge tone="ember">合成数据</Badge>}
            </div>
            <p className="num mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[13px] text-ink-2">
              <span className="font-semibold">{formatPhone(member.phone)}</span>
              <span className="text-ink-3" data-testid="member-no">
                会员号 <b className="text-ink-2">{member.memberNo}</b>
              </span>
              {member.gender && <span className="text-ink-3">{member.gender === 'female' ? '女' : '男'}</span>}
              {member.birthday && <span className="text-ink-3">生日 {member.birthday.slice(5)}</span>}
            </p>
            <p className="mt-1 text-[12.5px] text-ink-3" data-testid="member-registered">
              最近 {relativeTime(member.lastActivityAt)} · 注册于 {formatDate(member.createdAt)} {formatTime(member.createdAt)}
              {member.createdByName ? `（${member.createdByName}）` : ''}
              {channel && ` · 渠道 ${channel}`}
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
        {fieldRows.length > 0 && (
          <dl className="mx-5 mb-5 grid gap-x-5 gap-y-1.5 rounded-md bg-card/80 px-3 py-2.5 text-[13px] ring-1 ring-line sm:grid-cols-2" data-testid="member-custom-fields">
            {fieldRows.map((r) => (
              <div key={r.key} className="flex min-w-0 gap-2">
                <dt className="shrink-0 text-ink-3">{r.label}</dt>
                <dd className="min-w-0 font-semibold break-all text-ink-2">{r.value}</dd>
              </div>
            ))}
          </dl>
        )}

        {/* 余额：合计 / 本金 / 赠金 分层展示。按卡片实际宽度（容器查询）决定是否三栏并排，金额始终完整显示 */}
        <div className="@container border-t border-line bg-card">
          <div className="grid grid-cols-2 @2xl:grid-cols-[1.25fr_1fr_1fr]">
            <div className="col-span-2 min-w-0 px-5 py-4 @2xl:col-span-1">
              <p className="text-[12.5px] font-semibold text-ink-3">可用余额</p>
              <Money cents={total} className={cn('mt-1 text-[36px] leading-none font-bold tracking-tight', total ? 'text-ink' : 'text-ink-4')} />
            </div>
            <div className="min-w-0 border-t border-line px-5 py-4 @2xl:border-t-0 @2xl:border-l">
              <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-3">
                <span className="size-2 rounded-full bg-pine" />
                本金
              </p>
              <Money cents={member.principalBalance} className="mt-1.5 text-[22px] leading-none font-bold text-pine" />
              <p className="mt-1.5 text-[12px] text-ink-3">
                累计实收 <Money cents={member.stats.totalPaid} />
              </p>
            </div>
            <div className="min-w-0 border-t border-l border-line px-5 py-4 @2xl:border-t-0">
              <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-3">
                <span className="size-2 rounded-full bg-yuzu" />
                赠金
              </p>
              <Money cents={member.bonusBalance} className="mt-1.5 text-[22px] leading-none font-bold text-yuzu-deep" />
              <p className="mt-1.5 text-[12px] text-ink-3">
                累计赠送 <Money cents={member.stats.totalBonusGranted} />
              </p>
              {expiring.length > 0 && (
                <ul className="mt-1.5 space-y-0.5 text-[12px] font-semibold text-ember" data-testid="bonus-expiring">
                  {expiring.slice(0, 2).map((l, i) => (
                    <li key={i}>
                      <Money cents={l.remaining} /> 有效至 {lastUsableDate(l.expiresAt!, session.timezone, session.rules.businessDayStartHour).slice(5)}
                    </li>
                  ))}
                  {expiring.length > 2 && <li className="text-ink-3">另有 {expiring.length - 2} 笔将陆续到期</li>}
                </ul>
              )}
            </div>
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
        {member.opening && (
          <span className="rounded-full bg-pine-tint px-3 py-1 font-semibold text-pine" data-testid="member-opening" title={`期初 ${member.opening.docNo}`}>
            {member.opening.source} 期初{member.opening.legacyNo ? `（旧卡号 ${member.opening.legacyNo}）` : ''} · 本金 <Money cents={member.opening.principal} /> · 赠金{' '}
            <Money cents={member.opening.bonus} />
            {member.opening.legacyRecharged > 0 && (
              <>
                {' '}
                · 旧系统累计充值 <Money cents={member.opening.legacyRecharged} />
              </>
            )}
          </span>
        )}
      </div>

      {/* 会员详情所在的栏宽随工作台布局变化，按卡片容器宽度决定是否并排 */}
      <div className="@container">
        <div className="grid gap-4 @3xl:grid-cols-2">
          <GradeCard member={member} />
          <BonusLotsCard member={member} />
        </div>
      </div>

      {/* 本月可享（会员体系 v2 第二期，v0.7.24）：换会员时整块重来（登记使用的操作编号不带到下一位会员） */}
      <BenefitsCard key={`benefits-${member.id}`} member={member} />

      {/* 账户内券（v0.7.20）：换会员时整块重来（筛选、发券的操作编号都不带到下一位会员） */}
      {can('member.read') && <MemberCouponsCard key={member.id} member={member} />}

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
