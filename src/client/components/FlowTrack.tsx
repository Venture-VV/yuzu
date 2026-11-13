// 流程轨（8.0.17，docs/FLOW_V8017.md）：一排环节，做完的绿勾、正在等的橙点、没到的灰着、超期或卡住的红底标出来。
// 两种密度：
//   · full：每个环节下面写全（谁、状态、时间、等了多久）——流程进度页用；窄了横向滑；
//   · compact：只画圆点与名称，下面一行写选中的那个环节（默认是正在等的）——抽屉、弹窗里用，点别的环节看别的。
// 只管画：环节是什么、点了去哪由用的地方给。FlowDot 单独导出，竖着的时间线（审批进度）也用它。

import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Check, Hourglass } from 'lucide-react';
import { cn, formatDateTime } from '../lib/utils';

export type FlowState = 'done' | 'current' | 'pending';

export interface FlowTrackNode {
  key: string;
  /** 圆点里的一个字（或图标） */
  glyph: ReactNode;
  title: string;
  role?: string;
  state: FlowState;
  /** 状态的一句话 */
  text?: string;
  /** 做完的时间：时刻，或只有日期（YYYY-MM-DD） */
  at?: string | null;
  /** 正在等的：等了多久 */
  waited?: string | null;
  /** 红底的一条 */
  alert?: string | null;
  /** 点了去哪（站内地址）；没有就不能点 */
  to?: string | null;
}

/** 11/6 16:36；只有日期的写 11/6 */
export function flowTime(at: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(at)) {
    const [, m, d] = at.split('-').map(Number) as [number, number, number];
    return `${m}/${d}`;
  }
  return formatDateTime(at);
}

/** 圆点：里面一个字，右下角是状态（绿勾、橙点、红点） */
export function FlowDot({ state, alert, children, size = 'md' }: { state: FlowState; alert?: boolean; children: ReactNode; size?: 'sm' | 'md' }) {
  return (
    <span
      className={cn(
        'relative flex shrink-0 items-center justify-center rounded-full font-bold transition-colors duration-200',
        size === 'md' ? 'size-10 text-[14px]' : 'size-8 text-[12.5px]',
        state === 'done' && 'bg-pine-soft text-pine',
        state === 'current' && (alert ? 'bg-clay-soft text-clay ring-2 ring-clay/45' : 'bg-yuzu-soft text-yuzu-deep ring-2 ring-yuzu'),
        state === 'pending' && 'bg-paper-3 text-ink-4',
      )}
    >
      {children}
      {state === 'done' && (
        <span className="absolute -right-0.5 -bottom-0.5 flex size-[15px] items-center justify-center rounded-full bg-pine text-white ring-2 ring-card">
          <Check className="size-2.5" strokeWidth={3.5} />
        </span>
      )}
      {state === 'current' && <span className={cn('absolute -right-0.5 -bottom-0.5 size-[13px] rounded-full ring-2 ring-card', alert ? 'bg-clay' : 'bg-ember')} />}
    </span>
  );
}

/** 红底的一条：已等待 7 天 · 超期 2 天 */
export function FlowAlert({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex max-w-full items-center gap-1 rounded-md bg-clay-soft px-1.5 py-0.5 text-[11.5px] leading-snug font-semibold text-clay', className)}>
      <Hourglass className="size-3 shrink-0" />
      <span className="min-w-0">{children}</span>
    </span>
  );
}

const stateWord: Record<FlowState, string> = { done: '已完成', current: '进行中', pending: '未开始' };

function NodeShell({ node, className, children, onClick, pressed }: { node: FlowTrackNode; className?: string; children: ReactNode; onClick?: () => void; pressed?: boolean }) {
  const common = {
    className: cn(className, (node.to || onClick) && 'rounded-lg outline-none hover:bg-paper-2/70 focus-visible:ring-2 focus-visible:ring-pine/40'),
    'data-testid': `flow-node-${node.key}`,
    'data-state': node.state,
    'data-alert': node.alert ? 'true' : undefined,
    title: `${node.title}：${stateWord[node.state]}`,
  };
  if (onClick) {
    return (
      <button type="button" {...common} onClick={onClick} aria-pressed={pressed}>
        {children}
      </button>
    );
  }
  if (node.to) return <Link to={node.to} {...common}>{children}</Link>;
  return <div {...common}>{children}</div>;
}

export function FlowTrack({ nodes, density = 'full', label, className }: { nodes: readonly FlowTrackNode[]; density?: 'full' | 'compact'; label: string; className?: string }) {
  const firstCurrent = nodes.find((n) => n.state === 'current')?.key ?? null;
  const [picked, setPicked] = useState<string | null>(null);
  const selected = nodes.find((n) => n.key === (picked ?? firstCurrent)) ?? null;
  const compact = density === 'compact';
  return (
    <div className={className} data-testid="flow-track" data-density={density}>
      <ol aria-label={label} className={cn('scroll-thin flex overflow-x-auto', compact ? 'pb-1' : 'pb-2')}>
        {nodes.map((n, i) => {
          const prev = nodes[i - 1];
          return (
            <li key={n.key} className={cn('relative flex flex-1 justify-center', compact ? 'min-w-[58px]' : 'min-w-[104px]')}>
              {/* 与上一个环节之间的线：上一个做完了是绿的 */}
              {prev && <span aria-hidden className={cn('absolute right-1/2 left-[-50%] h-0.5', compact ? 'top-[19px]' : 'top-[23px]', prev.state === 'done' ? 'bg-pine/35' : 'bg-line')} />}
              <NodeShell
                node={n}
                className={cn('relative flex w-full flex-col items-center px-1 text-center', compact ? 'pt-1 pb-1' : 'pt-1 pb-1.5')}
                onClick={compact ? () => setPicked(n.key) : undefined}
                pressed={compact ? selected?.key === n.key : undefined}
              >
                <span className="rounded-full bg-card p-[3px]">
                  <FlowDot state={n.state} alert={!!n.alert} size={compact ? 'sm' : 'md'}>
                    {n.glyph}
                  </FlowDot>
                </span>
                <span className={cn('mt-1 font-bold', compact ? 'text-[11.5px] leading-tight' : 'text-[13px]', n.state === 'pending' ? 'text-ink-3' : 'text-ink', compact && selected?.key === n.key && 'text-pine underline decoration-2 underline-offset-4')}>
                  {n.title}
                </span>
                {!compact && (
                  <>
                    {n.role && <span className="mt-0.5 text-[12px] leading-snug text-ink-3">{n.role}</span>}
                    {n.text && (
                      <span className={cn('mt-0.5 text-[12px] leading-snug', n.state === 'current' ? 'font-semibold text-ember' : n.state === 'done' ? 'text-ink-2' : 'text-ink-4')}>
                        {n.text}
                        {n.at && <span className="num"> {flowTime(n.at)}</span>}
                      </span>
                    )}
                    {n.alert ? <FlowAlert className="mt-1.5">{n.alert}</FlowAlert> : n.state === 'current' && n.waited ? <span className="mt-0.5 text-[12px] text-ink-3">已等待 {n.waited}</span> : null}
                  </>
                )}
              </NodeShell>
            </li>
          );
        })}
      </ol>
      {compact && selected && (
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-paper-2/70 px-3 py-2 text-[12.5px]" data-testid="flow-selected" data-node={selected.key}>
          <span className="font-bold text-ink">{selected.title}</span>
          {selected.role && <span className="text-ink-3">{selected.role}</span>}
          {selected.text && (
            <span className={cn(selected.state === 'current' ? 'font-semibold text-ember' : selected.state === 'done' ? 'text-ink-2' : 'text-ink-4')}>
              {selected.text}
              {selected.at && <span className="num"> {flowTime(selected.at)}</span>}
            </span>
          )}
          {selected.alert ? <FlowAlert>{selected.alert}</FlowAlert> : selected.state === 'current' && selected.waited ? <span className="text-ink-3">已等待 {selected.waited}</span> : null}
          {selected.to && (
            <Link to={selected.to} className="ml-auto font-semibold text-lake hover:underline" data-testid="flow-selected-open">
              去看这张单
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

/** 图例（流程进度页底下那一行） */
export function FlowLegend({ className }: { className?: string }) {
  const item = (dot: string, text: string) => (
    <span className="flex items-center gap-1.5">
      <span className={cn('size-2.5 rounded-full', dot)} />
      {text}
    </span>
  );
  return (
    <p className={cn('flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-ink-3', className)}>
      {item('bg-pine', '已完成（绿勾）')}
      {item('bg-ember', '当前环节（橙点 · 写等了多久）')}
      {item('bg-paper-3 ring-1 ring-line-strong', '未开始（灰）')}
      {item('bg-clay', '超期 / 卡住（红底的一条）')}
    </p>
  );
}
