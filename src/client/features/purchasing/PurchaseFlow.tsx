// 采购流程图（8.0.17，docs/FLOW_V8017.md）：从提需求到付款的一排环节。环节是服务端从单据算出来的（@shared/purchase-flow），这里只管画。
//   · PurchaseFlowCard：一条流程一张卡（流程 A / B、金额、一排环节）——流程进度页用；
//   · PurchaseFlowPanel：详情里嵌的那一块（需求单、询价单、采购单、审批中心），自己取数，紧凑的一排，点环节看那一环、能去那张单。
// 只读：图上不能办事，办事点环节去原来的页面。

import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { ArrowRight, Shuffle } from 'lucide-react';
import type { FlowAnchorKind, FlowLink, PurchaseFlow } from '@shared/purchase-flow';
import { api } from '../../lib/api';
import { useCan } from '../../lib/session';
import { cn } from '../../lib/utils';
import { FlowTrack, type FlowTrackNode } from '../../components/FlowTrack';
import { Money } from '../../components/Money';
import { Badge, Skeleton } from '../../components/ui';

/** 环节上的单据在站内的地址 */
export function flowLinkTo(link: FlowLink | null): string | null {
  if (!link) return null;
  switch (link.kind) {
    case 'request':
      return `/erp/requests?request=${link.id}`;
    case 'sourcing':
      return `/purchasing/sourcing/${link.id}`;
    case 'po':
      return `/purchasing?po=${link.id}`;
    case 'approval':
      return `/approvals?open=${link.id}`;
    case 'receipt':
      return `/inventory/docs?doc=${link.id}`;
  }
}

/** skipSelf：详情里嵌着的图，指向这张单据自己的环节不给链接（已经在这张单上了） */
function toTrackNodes(flow: PurchaseFlow, skipSelf: boolean): FlowTrackNode[] {
  return flow.nodes.map((n) => {
    const self = skipSelf && n.link !== null && n.link.kind === flow.anchor.kind && n.link.id === flow.anchor.id;
    return { key: n.key, glyph: n.glyph, title: n.title, role: n.role, state: n.state, text: n.text, at: n.at, waited: n.waited, alert: n.alert, to: self ? null : flowLinkTo(n.link) };
  });
}

/** 流程 A / B 的那一行：流程 B ｜ ≥ ¥1,000 · 必须 ≥ 2 家比价 + 审批 */
function VariantLine({ flow, className }: { flow: PurchaseFlow; className?: string }) {
  return (
    <span className={cn('flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5', className)} data-testid="flow-variant" data-variant={flow.variant}>
      <span className="text-[14px] font-bold text-ink">流程 {flow.variant}</span>
      <span className="text-ink-4">|</span>
      <span className="text-[13px] font-semibold text-ink-2">{flow.variantText}</span>
    </span>
  );
}

const anchorTo = (flow: PurchaseFlow) => flowLinkTo({ kind: flow.anchor.kind, id: flow.anchor.id, docNo: flow.anchor.docNo });

export function PurchaseFlowCard({ flow }: { flow: PurchaseFlow }) {
  return (
    <section
      className="mo-lift rounded-xl border border-line bg-card px-5 pt-4 pb-3 shadow-card"
      data-testid={`flow-card-${flow.anchor.kind}-${flow.anchor.id}`}
      data-stage={flow.stage ?? ''}
      data-alert={flow.alert ? 'true' : undefined}
    >
      <header className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <VariantLine flow={flow} />
        {flow.alert && <Badge tone="clay">超期 / 卡住</Badge>}
        <Link
          to={anchorTo(flow) ?? '/purchasing'}
          className={cn('ml-auto flex max-w-full items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px] font-semibold hover:underline', flow.variant === 'B' ? 'bg-lake-soft text-lake' : 'bg-pine-tint text-pine')}
          data-testid="flow-card-open"
        >
          <span className="num shrink-0">{flow.anchor.docNo}</span>
          <span className="min-w-0 truncate">{flow.title}</span>
          {flow.amountCents !== null && (
            <span className="shrink-0">
              {flow.amountEstimated && '约 '}
              <Money cents={flow.amountCents} />
            </span>
          )}
          <ArrowRight className="size-3.5 shrink-0" />
        </Link>
      </header>
      <FlowTrack nodes={toTrackNodes(flow, false)} label={`${flow.anchor.docNo} 的流程`} />
    </section>
  );
}

export function usePurchaseFlow(kind: FlowAnchorKind, id: number | null, version: string, enabled = true) {
  return useQuery({
    // version：单据的状态变了（通过、定标、收货……）就重新取
    queryKey: ['inv', 'flow', kind, id, version],
    queryFn: () => api.get<PurchaseFlow>(`/api/purchase-flow/one?kind=${kind}&id=${id}`),
    enabled: enabled && id !== null,
    retry: false,
  });
}

/**
 * 详情里嵌的流程图。取不到（没权限、单据撤回了）就不画，不挡着详情。
 * version 给这张单据会随着流程变的东西（状态、到货进度……），变了就重新取。
 */
export function PurchaseFlowPanel({ kind, id, version, className }: { kind: FlowAnchorKind; id: number; version: string; className?: string }) {
  const can = useCan();
  const flow = usePurchaseFlow(kind, id, version);
  if (flow.isPending) return <Skeleton className={cn('h-24', className)} />;
  if (!flow.data) return null;
  const f = flow.data;
  return (
    <section className={cn('rounded-lg border border-line bg-card px-3 pt-3 pb-2.5', className)} data-testid="purchase-flow" data-stage={f.stage ?? ''} data-end={f.end ?? ''}>
      <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 px-1">
        <Shuffle className="size-3.5 shrink-0 text-ink-3" />
        <VariantLine flow={f} className="[&>span:first-child]:text-[13px] [&>span:last-child]:text-[12px]" />
        {f.end && <Badge tone={f.end === 'done' ? 'pine' : 'neutral'}>{f.endText}</Badge>}
        {can('inventory.read') && (
          <Link to="/purchasing/flow" className="ml-auto flex items-center gap-0.5 text-[12px] font-semibold text-lake hover:underline" data-testid="flow-all-link">
            全部流程 <ArrowRight className="size-3" />
          </Link>
        )}
      </div>
      <FlowTrack nodes={toTrackNodes(f, true)} density="compact" label={`${f.anchor.docNo} 的流程`} />
    </section>
  );
}
