// 加项目时选技师（v0.7.0）：需要技师的项目点了之后在这里选技师与点钟 / 轮钟。
// 价格跟技师等级时，每位技师按他的等级显示这个项目的价格；不能做这个项目的技师灰掉并写明原因。

import { useState } from 'react';
import { ArrowLeft, UserRoundX } from 'lucide-react';
import { PRICE_TIER_LABELS, tierPrice, type PriceTier } from '@shared/catalog';
import { CALL_TYPE_LABELS, canServe, gradeLabel, tierFor, type CallType, type FrontdeskTechnicians } from '@shared/technicians';
import type { ServiceItem } from '@shared/types';
import { cn } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Button, Notice, Segmented, Skeleton } from '../../components/ui';

type Tech = FrontdeskTechnicians['technicians'][number];

export function TechnicianPicker({
  item,
  tier,
  data,
  loading,
  callType,
  onCallType,
  onPick,
  onCancel,
}: {
  item: ServiceItem;
  /** 在项目卡片上点的价格档（价格不跟等级时按它计价） */
  tier: PriceTier;
  data: FrontdeskTechnicians | undefined;
  loading: boolean;
  callType: CallType;
  onCallType: (v: CallType) => void;
  /** 选了技师（tier 为实际计价的档）；null 为暂不指定 */
  onPick: (pick: { tech: Tech; tier: PriceTier } | null) => void;
  onCancel: () => void;
}) {
  const [gender, setGender] = useState<'all' | 'male' | 'female'>('all');
  const rules = data?.rules;
  const all = data?.technicians ?? [];
  const genders = new Set(all.map((t) => t.gender));
  const shown = gender === 'all' ? all : all.filter((t) => t.gender === gender);
  // 能做这个项目的技师里今日钟数最少的（都一样多时不标）
  const clocks = all.filter((t) => rules && !canServe(t, item, rules.tierByGrade)).map((t) => t.todayClocks);
  const fewest = clocks.length && Math.min(...clocks) < Math.max(...clocks) ? Math.min(...clocks) : null;

  return (
    <div data-testid="technician-picker">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" icon={<ArrowLeft className="size-4" />} onClick={onCancel}>
          返回项目
        </Button>
        <p className="min-w-0 flex-1 text-[14px] font-bold">
          为「{item.name}」选技师
          {rules && !rules.tierByGrade && item.prices.length > 1 && <span className="ml-1 text-[12.5px] font-semibold text-ink-3">（{PRICE_TIER_LABELS[tier]}档）</span>}
        </p>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented
          size="sm"
          ariaLabel="上钟方式"
          value={callType}
          onChange={onCallType}
          options={[
            { value: 'rotation', label: CALL_TYPE_LABELS.rotation },
            { value: 'designated', label: CALL_TYPE_LABELS.designated },
          ]}
        />
        <span className="text-[12px] text-ink-3">客人点名要的选「点钟」，按顺序排的选「轮钟」</span>
        {genders.size > 1 && (
          <Segmented
            size="sm"
            ariaLabel="技师性别"
            className="ml-auto"
            value={gender}
            onChange={setGender}
            options={[
              { value: 'all', label: '全部' },
              { value: 'male', label: '男技师' },
              { value: 'female', label: '女技师' },
            ]}
          />
        )}
      </div>
      {loading ? (
        <Skeleton className="h-40" />
      ) : !rules ? (
        <Notice tone="error" title="技师名单没有加载出来，请关闭后重试" />
      ) : all.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-[13px] text-ink-3">
          还没有在职的技师，请店主或店总在「后台 → 技师」中添加
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {shown.map((t) => {
            const why = canServe(t, item, rules.tierByGrade);
            const charged = tierFor(t, item, tier, rules.tierByGrade);
            const price = tierPrice(item.prices, charged);
            return (
              <button
                key={t.id}
                type="button"
                disabled={!!why || price === null}
                onClick={() => onPick({ tech: t, tier: charged })}
                data-testid={`tech-${t.techNo}`}
                className="flex min-h-[72px] flex-col rounded-lg border border-line bg-card px-3 py-2 text-left transition-[background-color,border-color] hover:border-pine active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-line disabled:active:scale-100"
              >
                <span className="flex items-baseline gap-1.5">
                  <span className="num text-[17px] font-bold text-ink">{t.techNo}</span>
                  <span className="min-w-0 truncate text-[14px] font-bold">{t.name}</span>
                  <span className={cn('ml-auto text-[11.5px] font-semibold', t.gender === 'female' ? 'text-clay' : 'text-lake')}>{t.gender === 'female' ? '女' : '男'}</span>
                </span>
                <span className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 text-[12px] font-semibold text-ink-3">
                  <span>{gradeLabel(t.grade)}</span>
                  {!why && price !== null && <Money cents={price} className="text-[12.5px] font-bold text-ink-2" />}
                </span>
                <span className={cn('mt-auto pt-0.5 text-[11.5px] font-semibold', why ? 'text-clay' : t.todayClocks === fewest ? 'text-pine' : 'text-ink-4')}>
                  {why ?? `今日 ${t.todayClocks} 钟${t.todayClocks === fewest ? ' · 钟最少' : ''}`}
                </span>
              </button>
            );
          })}
          {shown.length === 0 && <p className="col-span-full py-6 text-center text-[13px] text-ink-3">没有符合条件的技师</p>}
        </div>
      )}
      {rules && !rules.requireTechnician && (
        <Button className="mt-3" size="sm" variant="secondary" icon={<UserRoundX className="size-4" />} onClick={() => onPick(null)} data-testid="tech-none">
          暂不指定技师
        </Button>
      )}
    </div>
  );
}
