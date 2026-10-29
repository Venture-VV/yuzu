import type { ReactNode } from 'react';
import { Crown, Link2, Lock, UserRound } from 'lucide-react';
import { tagArea, ZONE_LABELS, type BoardTag, type HandTag, type TagKind, type TagZone } from '@shared/frontdesk';
import { cn } from '../../lib/utils';
import { Money } from '../../components/Money';
import { stayMinutes, stayText } from './queries';

/** 分区配色：男宾湖水青、女宾杏橙（旧儿童区苔绿）；颜色始终配文字，不单靠颜色区分 */
export const ZONE_STYLE: Record<TagZone, { chip: string; strip: string; soft: string; text: string }> = {
  male: { chip: 'bg-lake-soft text-lake', strip: 'bg-lake', soft: 'bg-lake-soft/50', text: 'text-lake' },
  female: { chip: 'bg-ember-soft text-ember', strip: 'bg-ember', soft: 'bg-ember-soft/50', text: 'text-ember' },
  child: { chip: 'bg-moss-soft text-moss', strip: 'bg-moss', soft: 'bg-moss-soft/60', text: 'text-moss' },
};

export function ZoneChip({ zone, size = 'sm', className }: { zone: TagZone; size?: 'sm' | 'md'; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-bold leading-none',
        size === 'sm' ? 'h-[18px] px-1.5 text-[11px]' : 'h-6 px-2.5 text-[12.5px]',
        ZONE_STYLE[zone].chip,
        className,
      )}
    >
      {size === 'sm' ? ZONE_LABELS[zone].short : ZONE_LABELS[zone].title}
    </span>
  );
}

/** VIP 柜等级标记：会员等级不低于柜子等级才能使用 */
export function VipChip({ level, size = 'sm', className }: { level: number; size?: 'sm' | 'md'; className?: string }) {
  return (
    <span
      title={`VIP 第 ${level} 级柜`}
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 rounded-full bg-ink font-bold leading-none text-yuzu',
        size === 'sm' ? 'h-[18px] px-1.5 text-[11px]' : 'h-6 px-2.5 text-[12.5px]',
        className,
      )}
    >
      <Crown className={size === 'sm' ? 'size-3' : 'size-3.5'} strokeWidth={2.4} />
      {size === 'sm' ? level : `VIP ${level} 级`}
    </span>
  );
}

/** 柜型说明：普通柜「A 区」，VIP 柜「VIP 3 级」 */
export function tagKindText(tag: Pick<HandTag, 'code' | 'kind' | 'vipLevel'>) {
  if (tag.kind === 'vip') return `VIP 第 ${tag.vipLevel} 级柜`;
  const area = tagArea(tag.code);
  return area ? `${area} 区普通柜` : '普通柜';
}

/** 按柜型分组：普通柜按区号（A、B、C、D…），VIP 柜按等级；保持服务端的排序 */
export function groupTags<T extends HandTag>(tags: T[]) {
  const groups = new Map<string, { key: string; kind: TagKind; area: string; vipLevel: number | null; tags: T[] }>();
  for (const t of tags) {
    const area = t.kind === 'vip' ? '' : tagArea(t.code);
    const key = t.kind === 'vip' ? `vip-${t.vipLevel}` : `area-${area}`;
    const g = groups.get(key) ?? { key, kind: t.kind, area, vipLevel: t.vipLevel, tags: [] };
    g.tags.push(t);
    groups.set(key, g);
  }
  return [...groups.values()];
}

/** 同行组短号：TX20261026-0003 → 03 */
export const groupShort = (groupNo: string) => groupNo.slice(-2);

export function GroupMark({ groupNo, count, className }: { groupNo: string; count?: number; className?: string }) {
  return (
    <span
      title={`同行组 ${groupNo}${count ? `，${count} 人在店` : ''}`}
      className={cn('inline-flex h-[18px] shrink-0 items-center gap-0.5 rounded-full bg-pine px-1.5 text-[11px] leading-none font-bold text-paper', className)}
    >
      <Link2 className="size-3" strokeWidth={2.6} />
      联{groupShort(groupNo)}
      {count ? <span className="font-semibold opacity-75">·{count}</span> : null}
    </span>
  );
}

/** 在店超过 6 小时用柚黄提示（接近夜场 / 过夜计费，S3 起按规则计算） */
export const LONG_STAY_MINUTES = 360;

export function TagCard({
  tag,
  now,
  selected,
  matched,
  primaryMatch,
  companion,
  onClick,
}: {
  tag: BoardTag;
  now: number;
  selected: boolean;
  matched: boolean;
  primaryMatch: boolean;
  companion: boolean;
  onClick: () => void;
}) {
  const v = tag.visit;
  const style = ZONE_STYLE[tag.zone];
  const long = v ? stayMinutes(v.checkedInAt, now) >= LONG_STAY_MINUTES : false;
  const state = v ? '在店' : tag.locked ? '锁定' : '空闲';
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`tag-${tag.code}`}
      data-state={v ? 'in_use' : tag.locked ? 'locked' : 'free'}
      aria-label={`手牌 ${tag.code}，${ZONE_LABELS[tag.zone].title}${tag.kind === 'vip' ? `，VIP ${tag.vipLevel} 级` : ''}，${state}${v ? `，未结 ${(v.amountCents / 100).toFixed(2)} 元` : ''}`}
      aria-pressed={selected}
      className={cn(
        'group relative flex h-[92px] min-w-0 flex-col overflow-hidden rounded-[14px] border text-left transition-[box-shadow,border-color,transform,background-color] duration-150 active:scale-[0.98]',
        v
          ? 'border-line bg-card shadow-card hover:border-line-strong hover:shadow-lift'
          : tag.locked
            ? 'border-line bg-[repeating-linear-gradient(135deg,var(--color-paper-2)_0_6px,var(--color-paper-3)_6px_7px)] text-ink-3'
            : 'border-dashed border-line-strong bg-paper/60 hover:border-ink-4 hover:bg-card',
        selected && 'border-pine ring-2 ring-pine ring-offset-2 ring-offset-paper',
        !selected && companion && 'border-pine/60 ring-1 ring-pine/40',
        matched && !selected && 'ring-2 ring-yuzu ring-offset-1 ring-offset-paper',
        primaryMatch && !selected && 'shadow-lift',
      )}
    >
      {v && <span className={cn('absolute inset-y-0 left-0 w-[5px]', style.strip)} aria-hidden />}
      <span className={cn('flex items-center gap-1.5 pt-2 pr-2', v ? 'pl-3.5' : 'pl-3')}>
        <span className={cn('num min-w-0 truncate text-[19px] leading-none font-bold tracking-tight', v ? 'text-ink' : 'text-ink-3')}>{tag.code}</span>
        <span className="flex-1" />
        {/* VIP 柜卡片放不下两个标记：只显示等级，分区由所在分组与左侧色条表示 */}
        {tag.kind === 'vip' ? <VipChip level={tag.vipLevel!} /> : <ZoneChip zone={tag.zone} />}
      </span>
      {v ? (
        <>
          <span className="mt-1 flex min-w-0 items-center gap-1 pr-2 pl-3.5 text-[12px] text-ink-2">
            {v.memberName ? (
              <>
                <UserRound className="size-3 shrink-0 text-pine" />
                <span className="min-w-0 truncate font-semibold">{v.memberName}</span>
              </>
            ) : (
              <span className="min-w-0 truncate text-ink-3">{v.guestLabel || '散客'}</span>
            )}
            <span className="flex-1" />
            {v.groupNo && <GroupMark groupNo={v.groupNo} />}
          </span>
          <span className="mt-auto flex items-end justify-between gap-1 pr-2.5 pb-2 pl-3.5">
            <span className={cn('num whitespace-nowrap text-[12px] font-semibold', long ? 'rounded-sm bg-yuzu-soft px-1 text-yuzu-deep' : 'text-ink-3')}>
              {stayText(v.checkedInAt, now)}
            </span>
            {v.amountCents > 0 ? (
              <CardMoney cents={v.amountCents} />
            ) : (
              <span className="text-[11.5px] text-ink-4">未挂账</span>
            )}
          </span>
        </>
      ) : (
        <span className="mt-auto flex items-center gap-1 px-3 pb-2 text-[12px] font-semibold">
          {tag.locked ? (
            <>
              <Lock className="size-3 text-clay" />
              <span className="truncate text-clay">锁定 · {tag.lockReason}</span>
            </>
          ) : (
            <>
              <span className="text-ink-4 group-hover:hidden">空闲</span>
              <span className="hidden text-pine group-hover:inline">＋ 点此发牌</span>
            </>
          )}
        </span>
      )}
    </button>
  );
}

/**
 * 空闲 / 锁定手牌的紧凑标签：全店 747 个柜，空闲柜只需看牌号与柜型，在店客人才用完整卡片。
 * 与完整卡片同样的 data-testid 与状态，点一下即可发牌。
 */
export function TagChip({ tag, matched, primaryMatch, onClick }: { tag: BoardTag; matched: boolean; primaryMatch: boolean; onClick: () => void }) {
  const state = tag.locked ? '锁定' : '空闲';
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`tag-${tag.code}`}
      data-state={tag.locked ? 'locked' : 'free'}
      aria-label={`手牌 ${tag.code}，${ZONE_LABELS[tag.zone].title}${tag.kind === 'vip' ? `，VIP ${tag.vipLevel} 级` : ''}，${state}${tag.locked ? `（${tag.lockReason}）` : ''}`}
      title={tag.locked ? `锁定：${tag.lockReason}` : '空闲，点此发牌'}
      className={cn(
        'num flex h-[34px] min-w-[74px] items-center justify-center gap-1 rounded-[10px] border px-2 text-[14px] font-bold transition-[box-shadow,border-color,background-color] duration-150 active:scale-[0.98]',
        tag.locked
          ? 'border-clay/30 bg-[repeating-linear-gradient(135deg,var(--color-paper-2)_0_6px,var(--color-paper-3)_6px_7px)] text-clay'
          : 'border-dashed border-line-strong bg-paper/60 text-ink-2 hover:border-pine hover:bg-card hover:text-pine',
        matched && 'ring-2 ring-yuzu ring-offset-1 ring-offset-paper',
        primaryMatch && 'shadow-lift',
      )}
    >
      {tag.locked && <Lock className="size-3" />}
      {tag.code}
    </button>
  );
}

/** 卡片上的金额：整元时省略「.00」，给在店时长留出空间；有角分时照常显示 */
function CardMoney({ cents }: { cents: number }) {
  if (cents % 100 !== 0) return <Money cents={cents} className="text-[14px] font-bold text-ink" />;
  return (
    <span className="num inline-flex items-baseline text-[14px] font-bold whitespace-nowrap text-ink">
      <span className="mr-[0.12em] text-[0.72em] font-semibold opacity-70">¥</span>
      {(cents / 100).toLocaleString('en-US')}
    </span>
  );
}

export function Stat({ label, children, tone }: { label: string; children: ReactNode; tone?: 'pine' | 'yuzu' }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
      <span className="text-[12px] text-ink-3">{label}</span>
      <span className={cn('num text-[14px] font-bold', tone === 'pine' ? 'text-pine' : tone === 'yuzu' ? 'text-yuzu-deep' : 'text-ink')}>{children}</span>
    </span>
  );
}
