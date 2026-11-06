// 合同页面共用的小块（v0.7.31）：状态色、到期天数、四要素与单价表的只读展示、法务审查清单的结论。

import type { ReactNode } from 'react';
import {
  BEARER_LABELS,
  CONTRACT_STATUS_LABELS,
  LEGAL_CHECKLIST,
  PAYMENT_STAGE_LABELS,
  REVIEW_VERDICT_LABELS,
  WARRANTY_BASIS_LABELS,
  formatPercentBp,
  warrantyPercentBp,
  type ContractContent,
  type ContractLineView,
  type ContractStatus,
  type ReviewVerdict,
  type ReviewView,
} from '@shared/contracts';
import { formatQty } from '@shared/quantity';
import { cn, formatDateTime } from '../../lib/utils';
import { Money } from '../../components/Money';
import { Badge } from '../../components/ui';

type Tone = 'neutral' | 'pine' | 'yuzu' | 'clay' | 'lake' | 'ember';

export const CONTRACT_STATUS_TONE: Record<ContractStatus, Tone> = {
  draft: 'neutral',
  reviewing: 'yuzu',
  returned: 'clay',
  approved: 'lake',
  signed: 'pine',
  archived: 'pine',
  terminated: 'neutral',
  voided: 'neutral',
};

export function ContractStatusBadge({ status }: { status: ContractStatus }) {
  return <Badge tone={CONTRACT_STATUS_TONE[status]}>{CONTRACT_STATUS_LABELS[status]}</Badge>;
}

/** 到期提醒的说法：还有 N 天到期 / 今天到期 / 已过期 N 天 */
export function daysLeftText(daysLeft: number): string {
  if (daysLeft > 0) return `还有 ${daysLeft} 天到期`;
  if (daysLeft === 0) return '今天到期';
  return `已过期 ${-daysLeft} 天`;
}

export const VERDICT_TONE: Record<ReviewVerdict, Tone> = { pass: 'pine', revise: 'clay', risk: 'ember' };

export function Facts({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn('grid grid-cols-2 gap-x-4 gap-y-2 text-[13px] sm:grid-cols-3 lg:grid-cols-4', className)}>{children}</dl>;
}

export function Fact({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={cn('min-w-0', wide && 'col-span-2')}>
      <dt className="text-[11.5px] font-semibold text-ink-3">{label}</dt>
      <dd className="font-semibold break-words text-ink">{children}</dd>
    </div>
  );
}

/** 四要素：付款节点、质保、验收，加上运费卸货与税率 */
export function TermsView({ content }: { content: Omit<ContractContent, 'lines'> }) {
  const warrantyPct = warrantyPercentBp(content);
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
      <div>
        <h4 className="mb-1.5 text-[12.5px] font-bold text-ink-2">付款节点</h4>
        <table className="w-full text-[13px]" data-testid="contract-terms">
          <tbody className="divide-y divide-line/70">
            {content.paymentTerms.map((t) => (
              <tr key={t.stage}>
                <td className="w-14 py-1.5 font-semibold">{PAYMENT_STAGE_LABELS[t.stage]}</td>
                <td className="num w-16 py-1.5 text-right font-bold">{formatPercentBp(t.percentBp)}</td>
                <td className="py-1.5 pl-3 text-ink-2">{t.condition || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="space-y-1.5 text-[13px]">
        <div>
          <dt className="text-[12.5px] font-bold text-ink-2">质保</dt>
          <dd className="text-ink">
            {content.warranty.months > 0 ? `${content.warranty.months} 个月，从${WARRANTY_BASIS_LABELS[content.warranty.basis]}起算` : '没有质保'}
            {warrantyPct > 0 && ` · 质保金 ${formatPercentBp(warrantyPct)}`}
          </dd>
        </div>
        <div>
          <dt className="text-[12.5px] font-bold text-ink-2">验收</dt>
          <dd className="text-ink">
            {content.acceptance.method || '没写验收方法'}
            {content.acceptance.signer && <span className="block text-ink-2">签字：{content.acceptance.signer}</span>}
            {content.acceptance.penalty && <span className="block text-ink-2">不合格：{content.acceptance.penalty}</span>}
          </dd>
        </div>
        <div>
          <dt className="text-[12.5px] font-bold text-ink-2">税与运费</dt>
          <dd className="text-ink">
            税率 {formatPercentBp(content.taxRateBp)} · 运费{BEARER_LABELS[content.freightBearer]}承担 · 卸货{BEARER_LABELS[content.unloadingBearer]}承担
          </dd>
        </div>
      </dl>
    </div>
  );
}

/** 单价表（含税单价、税率、合同数量） */
export function LinesView({ lines, ordered }: { lines: ContractLineView[]; ordered?: Record<number, number> }) {
  if (lines.length === 0) return <p className="text-[13px] text-ink-3">没有单价表（服务、租赁类可以不填）</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-[13px]" data-testid="contract-lines">
        <thead>
          <tr className="border-b border-line text-left text-[12px] text-ink-3">
            <th className="py-1.5 pr-2 font-semibold">品名</th>
            <th className="py-1.5 pr-2 font-semibold">规格</th>
            <th className="py-1.5 pr-2 text-right font-semibold">含税单价</th>
            <th className="py-1.5 pr-2 text-right font-semibold">税率</th>
            <th className="py-1.5 pr-2 text-right font-semibold">合同数量</th>
            {ordered && <th className="py-1.5 text-right font-semibold">已下单</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-line/70">
          {lines.map((l) => (
            <tr key={l.lineNo}>
              <td className="py-1.5 pr-2 font-semibold">
                {l.itemName}
                {l.materialId === null && <span className="ml-1 text-[11.5px] font-normal text-ink-3">（不在物料档案）</span>}
              </td>
              <td className="py-1.5 pr-2 text-ink-2">{l.spec || '—'}</td>
              <td className="num py-1.5 pr-2 text-right">
                <Money cents={l.priceCents} className="font-semibold" /> / {l.unit}
              </td>
              <td className="num py-1.5 pr-2 text-right">{formatPercentBp(l.taxRateBp)}</td>
              <td className="num py-1.5 pr-2 text-right">{l.qtyMilli === null ? '不限量' : `${formatQty(l.qtyMilli)} ${l.unit}`}</td>
              {ordered && <td className="num py-1.5 text-right">{formatQty(ordered[l.lineNo] ?? 0)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 法务审查清单的结论（审批中心、合同详情的提交记录共用） */
export function ReviewsView({ reviews }: { reviews: ReviewView[] }) {
  if (reviews.length === 0) return null;
  return (
    <ul className="space-y-2" data-testid="contract-reviews">
      {reviews.map((r) => (
        <li key={r.id} className="rounded-md border border-line bg-card px-3 py-2 text-[12.5px]">
          <p className="font-semibold">
            第 {r.level} 级法务审查 ·{' '}
            <span className={r.action === 'return' ? 'text-clay' : 'text-pine'}>{r.action === 'return' ? '退回' : '同意'}</span> · {r.reviewerName}
            {r.onBehalfOfName && `（代 ${r.onBehalfOfName}）`}
            <span className="num font-normal text-ink-3"> · {formatDateTime(r.createdAt)}</span>
          </p>
          <ul className="mt-1 grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
            {r.items.map((it) => (
              <li key={it.key} className="flex min-w-0 items-baseline gap-1.5">
                <Badge tone={VERDICT_TONE[it.verdict]} className="h-[20px] px-1.5 text-[11px]">
                  {REVIEW_VERDICT_LABELS[it.verdict]}
                </Badge>
                <span className="shrink-0 font-semibold">{LEGAL_CHECKLIST.find((x) => x.key === it.key)?.label ?? it.key}</span>
                {it.note && <span className="min-w-0 text-ink-2">{it.note}</span>}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
