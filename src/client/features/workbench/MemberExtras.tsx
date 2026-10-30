// 会员详情的等级与赠金明细（v0.6.0，同事在测试服的反馈：要看到升级时间、差多少到下一级、赠送额度的使用情况）。

import { useState } from 'react';
import { Award, Gift, TrendingUp } from 'lucide-react';
import { lastUsableDate } from '@shared/business-date';
import { VIP_LEVEL_BASIS_LABELS } from '@shared/frontdesk';
import { BONUS_LOT_STATUS_LABELS, type BonusLotStatus } from '@shared/members';
import type { MemberDetail } from '@shared/types';
import { useSession } from '../../lib/session';
import { cn, formatDate, formatDateTime } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Badge, Card, PendingBadge, SectionTitle, Segmented } from '../../components/ui';

/** 等级：当前等级与达到时间、到下一级还差多少、升降级记录 */
export function MemberLevelCard({ member }: { member: MemberDetail }) {
  const l = member.level;
  const [all, setAll] = useState(false);
  if (!l) return null;
  const pct = l.next ? Math.min(100, Math.round((l.amountCents / Math.max(1, l.next.thresholdCents)) * 100)) : 100;
  const history = all ? l.history : l.history.slice(0, 3);
  return (
    <Card className="p-5" data-testid="member-level">
      <SectionTitle aside={<PendingBadge title="等级口径、门槛、名称与有效期是默认做法，待店主确认（后台「会员与渠道」可改）" />}>
        <span className="flex items-center gap-2">
          <Award className="size-4 text-yuzu-deep" /> 会员等级
        </span>
      </SectionTitle>
      <div className="mt-3 flex flex-wrap items-end gap-x-4 gap-y-1">
        <p className="text-[22px] leading-none font-bold text-ink" data-testid="member-level-name">
          {l.name}
        </p>
        <p className="text-[13px] text-ink-3">
          {l.level > 0 ? `第 ${l.level} 级` : '0 级'} · {VIP_LEVEL_BASIS_LABELS[l.basis]} <Money cents={l.amountCents} className="font-semibold text-ink-2" />
          {l.since && ` · ${formatDate(l.since)} 起`}
        </p>
      </div>
      <div className="mt-3">
        <div className="h-2.5 overflow-hidden rounded-full bg-paper-2" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="到下一级的进度">
          <div className={cn('h-full rounded-full', l.next ? 'bg-yuzu' : 'bg-pine')} style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-1.5 flex items-center gap-1.5 text-[13px] text-ink-2" data-testid="member-level-next">
          <TrendingUp className="size-4 text-pine" />
          {l.next ? (
            <span>
              {l.basis === 'recharge' ? '再充值' : '余额再增加'} <Money cents={l.next.gapCents} className="font-bold text-ink" /> 升至「{l.next.name}」（门槛{' '}
              <Money cents={l.next.thresholdCents} />）
            </span>
          ) : (
            <span>已是最高一级</span>
          )}
        </p>
        <p className="mt-0.5 text-[12px] text-ink-3">等级有效期：{l.validity}</p>
      </div>
      {l.history.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-line pt-2.5 text-[12.5px]" data-testid="member-level-history">
          {history.map((h, i) => (
            <li key={i} className="flex flex-wrap gap-x-2">
              <span className="num text-ink-3">{formatDateTime(h.at)}</span>
              <span className={cn('font-semibold', h.to > h.from ? 'text-pine' : 'text-clay')}>
                {h.to > h.from ? '升级' : '降级'}：{h.fromName} → {h.toName}
              </span>
            </li>
          ))}
          {l.history.length > 3 && (
            <li>
              <button type="button" className="font-semibold text-pine hover:underline" onClick={() => setAll(!all)}>
                {all ? '收起' : `全部 ${l.history.length} 条`}
              </button>
            </li>
          )}
        </ul>
      )}
    </Card>
  );
}

/** 赠金明细：每笔赠送的额度——可用、已用完、已过期 */
export function BonusLotsCard({ member }: { member: MemberDetail }) {
  const session = useSession();
  const lots = member.bonusLotHistory ?? [];
  const counts = { active: 0, used: 0, expired: 0 } as Record<BonusLotStatus, number>;
  for (const l of lots) counts[l.status] += 1;
  const [tab, setTab] = useState<BonusLotStatus>(counts.active || !lots.length ? 'active' : counts.used ? 'used' : 'expired');
  if (lots.length === 0) return null;
  const rows = lots.filter((l) => l.status === tab);
  const sourceText = (s: (typeof lots)[number]['source']) => (s === 'recharge' ? '充值赠送' : s === 'legacy' ? '升级前的赠金' : '撤销恢复');
  return (
    <Card className="p-5" data-testid="member-bonus-lots">
      <SectionTitle>
        <span className="flex items-center gap-2">
          <Gift className="size-4 text-yuzu-deep" /> 赠金明细
        </span>
      </SectionTitle>
      <Segmented
        size="sm"
        className="mt-2"
        ariaLabel="赠金状态"
        value={tab}
        onChange={setTab}
        options={(['active', 'used', 'expired'] as const).map((k) => ({ value: k, label: `${BONUS_LOT_STATUS_LABELS[k]} ${counts[k]}` }))}
      />
      {rows.length === 0 ? (
        <p className="mt-3 text-[13px] text-ink-3">没有{BONUS_LOT_STATUS_LABELS[tab]}的赠金</p>
      ) : (
        <ul className="mt-3 divide-y divide-line/70 text-[13px]">
          {rows.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-2">
              <Money cents={l.amount} className="font-bold text-ink" />
              <span className="text-ink-3">{sourceText(l.source)}</span>
              {l.docNo && <span className="num text-[12px] text-ink-3">{l.docNo}</span>}
              <span className="flex-1" />
              {l.status === 'active' && (
                <span className="text-ink-2">
                  剩 <Money cents={l.remaining} className="font-semibold" />
                  {l.expiresAt ? ` · 有效至 ${lastUsableDate(l.expiresAt, session.timezone, session.rules.businessDayStartHour)}` : ' · 长期有效'}
                </span>
              )}
              {l.used > 0 && (
                <span className="text-ink-3">
                  已用 <Money cents={l.used} />
                </span>
              )}
              {l.expired > 0 && (
                <Badge tone="clay">
                  过期作废 <Money cents={l.expired} />
                </Badge>
              )}
              <span className="num w-full text-[11.5px] text-ink-4 sm:w-auto">{formatDate(l.createdAt)} 赠送</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
