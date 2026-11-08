// 后台「会员权益 → 按档阶」（8.0.4，需求表 01，docs/MEMBERSHIP_V804.md 第 1 节）：L0–L6 七档，点开一档只见这一档的三阶，
// 点开一阶看这一阶的券与福利——上面是「本阶起享」，低档阶带上来的收在「另有 N 项」里；券按面值从高到低排。
// 编辑、发布、暂缓与「按类别」视图同一套（onEdit / onStatus 由上层给）。

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Gift, Sparkles, TriangleAlert } from 'lucide-react';
import { BENEFIT_CATEGORY_LABELS, BENEFIT_STATUS_LABELS, type BenefitStatus } from '@shared/benefits';
import type { BenefitTiers, TierEntry, TierStage } from '@shared/benefit-tiers';
import { formatYuan } from '@shared/money';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { Badge, Button, Card, Notice, Skeleton } from '../../components/ui';

export const benefitTierKey = ['benefits', 'tiers'] as const;

const STATUS_TONE: Record<BenefitStatus | 'active' | 'inactive', 'pine' | 'neutral' | 'ember' | 'clay'> = {
  published: 'pine',
  draft: 'neutral',
  paused: 'ember',
  active: 'pine',
  inactive: 'clay',
};
const statusText = (s: TierEntry['status']) => (s === 'active' ? '启用' : s === 'inactive' ? '已停用' : BENEFIT_STATUS_LABELS[s]);

export function BenefitTiersView({ onEdit }: { onEdit: (benefitId: number) => void }) {
  const q = useQuery({ queryKey: benefitTierKey, queryFn: () => api.get<BenefitTiers>('/api/benefits/tiers') });
  const [openGrade, setOpenGrade] = useState<number | null>(null);
  const [openStage, setOpenStage] = useState<number | null>(null);
  if (q.isPending) return <Skeleton className="h-96" />;
  if (q.error || !q.data) return <Notice tone="error" title={q.error?.message ?? '档阶没有加载出来'} />;
  const d = q.data;
  return (
    <div className="space-y-3" data-testid="benefit-tiers">
      {d.unplaced.length > 0 && (
        <Notice tone="warning" icon={<TriangleAlert className="size-5" />} title={`还没设起点：${d.unplaced.length} 项`}>
          设好配置起点才会出现在档阶里，也才能发布：
          <span className="mt-1 flex flex-wrap gap-1.5">
            {d.unplaced.map((u) => (
              <button
                key={u.benefitId}
                type="button"
                className="rounded-full bg-card px-2.5 py-0.5 text-[12.5px] font-semibold text-ink-2 ring-1 ring-line hover:ring-ink-3"
                onClick={() => onEdit(u.benefitId)}
                data-testid={`tier-unplaced-${u.code}`}
              >
                {u.code} {u.name}
              </button>
            ))}
          </span>
        </Notice>
      )}
      <p className="text-[12.5px] text-ink-3">
        点开一档只出现这一档的三阶，点开一阶看这一阶的券与福利；券按面值从高到低排。券模板 {d.templates.total} 张都已归到档阶里（发券规则按发的那一阶，只用于手动、批量、领券中心的按限定的最低档，不限的在 L0）。
      </p>
      {d.grades.map((g) => {
        const open = openGrade === g.grade;
        const fresh = g.stages.reduce((s, st) => s + st.coupons.filter((e) => e.fresh).length + st.perks.filter((e) => e.fresh).length, 0);
        return (
          <Card key={g.grade} className="overflow-hidden" data-testid={`tier-grade-${g.grade}`}>
            <button
              type="button"
              className="flex w-full items-center gap-3 px-5 py-3.5 text-left hover:bg-paper-2/60"
              aria-expanded={open}
              onClick={() => {
                setOpenGrade(open ? null : g.grade);
                setOpenStage(null);
              }}
              data-testid={`tier-grade-toggle-${g.grade}`}
            >
              {open ? <ChevronDown className="size-4 text-ink-3" /> : <ChevronRight className="size-4 text-ink-3" />}
              <span className="text-[15px] font-bold text-ink">{g.label}</span>
              <span className="text-[12.5px] text-ink-3">{g.grade === 0 ? '免费注册' : `充值门槛 ${formatYuan(g.thresholdCents)}`}</span>
              <span className="flex-1" />
              <span className="text-[12px] text-ink-3">{g.grade === 0 ? '' : '三阶 · '}这一档起享 {fresh} 项</span>
            </button>
            {open && (
              <div className="space-y-2 border-t border-line bg-paper/50 px-4 py-3" data-testid={`tier-stages-${g.grade}`}>
                {g.stages.map((st) => (
                  <StageRow key={st.rank} stage={st} open={g.grade === 0 || openStage === st.rank} single={g.grade === 0} onToggle={() => setOpenStage(openStage === st.rank ? null : st.rank)} onEdit={onEdit} />
                ))}
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

function StageRow({ stage, open, single, onToggle, onEdit }: { stage: TierStage; open: boolean; single: boolean; onToggle: () => void; onEdit: (benefitId: number) => void }) {
  const [showInherited, setShowInherited] = useState(false);
  const freshCoupons = stage.coupons.filter((e) => e.fresh);
  const freshPerks = stage.perks.filter((e) => e.fresh);
  const inherited = [...stage.coupons.filter((e) => !e.fresh), ...stage.perks.filter((e) => !e.fresh)];
  return (
    <div className="rounded-lg border border-line bg-card" data-testid={`tier-stage-${stage.rank}`}>
      {!single && (
        <button type="button" className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left hover:bg-paper-2/60" aria-expanded={open} onClick={onToggle} data-testid={`tier-stage-toggle-${stage.rank}`}>
          {open ? <ChevronDown className="size-4 text-ink-3" /> : <ChevronRight className="size-4 text-ink-3" />}
          <span className="text-[14px] font-bold text-ink">{stage.label}</span>
          <span className="text-[12px] text-ink-3">
            本阶起享 {freshCoupons.length + freshPerks.length} 项 · 共 {stage.coupons.length} 张券、{stage.perks.length} 项福利
          </span>
        </button>
      )}
      {open && (
        <div className={cn('space-y-3 px-4 pb-3', single ? 'pt-3' : 'border-t border-line/70 pt-3')}>
          <EntryList title="券" icon={<Gift className="size-4 text-yuzu-deep" />} entries={freshCoupons} empty="这一阶没有新的券" onEdit={onEdit} testid={`tier-coupons-${stage.rank}`} />
          <EntryList title="福利" icon={<Sparkles className="size-4 text-pine" />} entries={freshPerks} empty="这一阶没有新的福利" onEdit={onEdit} testid={`tier-perks-${stage.rank}`} />
          {inherited.length > 0 && (
            <div>
              <button type="button" className="text-[12.5px] font-semibold text-pine hover:underline" onClick={() => setShowInherited(!showInherited)} data-testid={`tier-inherited-${stage.rank}`}>
                {showInherited ? '收起' : `另有 ${inherited.length} 项低档阶的权益（按这一阶的数量）`}
              </button>
              {showInherited && (
                <div className="mt-2 space-y-3">
                  <EntryList title="券" icon={<Gift className="size-4 text-ink-4" />} entries={stage.coupons.filter((e) => !e.fresh)} empty="—" onEdit={onEdit} muted />
                  <EntryList title="福利" icon={<Sparkles className="size-4 text-ink-4" />} entries={stage.perks.filter((e) => !e.fresh)} empty="—" onEdit={onEdit} muted />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EntryList({ title, icon, entries, empty, onEdit, muted, testid }: { title: string; icon: React.ReactNode; entries: TierEntry[]; empty: string; onEdit: (benefitId: number) => void; muted?: boolean; testid?: string }) {
  return (
    <div data-testid={testid}>
      <p className="flex items-center gap-1.5 text-[12.5px] font-bold text-ink-2">
        {icon}
        {title}
      </p>
      {entries.length === 0 ? (
        <p className="mt-1 text-[12.5px] text-ink-4">{empty}</p>
      ) : (
        <ul className="mt-1 divide-y divide-line/60">
          {entries.map((e) => (
            <li key={e.key} className={cn('flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 py-1.5 text-[13px]', muted && 'opacity-75')} data-testid={`tier-entry-${e.key}`}>
              {e.code && <span className="num text-[12px] text-ink-3">{e.code}</span>}
              <span className="font-semibold text-ink">{e.name}</span>
              {e.category && <span className="text-[12px] text-ink-3">{BENEFIT_CATEGORY_LABELS[e.category]}</span>}
              <span className="text-ink-2">{e.quantityText}</span>
              {e.couponSummary && (
                <span className="text-[12px] text-ink-3" title={e.couponName ?? undefined}>
                  {e.couponName && e.couponName !== e.name ? `「${e.couponName}」` : ''}
                  {e.couponSummary}
                </span>
              )}
              {e.faceValue !== null && <span className="num text-[12px] font-semibold text-yuzu-deep">面值 {formatYuan(e.faceValue)}</span>}
              {e.note && <span className="text-[12px] text-ink-3">{e.note}</span>}
              <span className="flex-1" />
              <Badge tone={STATUS_TONE[e.status]}>{statusText(e.status)}</Badge>
              {e.benefitId !== null && (
                <Button size="sm" variant="ghost" onClick={() => onEdit(e.benefitId!)}>
                  编辑
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
