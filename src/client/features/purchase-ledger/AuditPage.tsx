// 12 条账目自检（v0.7.9，飞书需求 RQ-005 第五段）：逐条列出规则、怎么查、现在有几条问题，点开看是哪几张单。
// 「录入时拦截」的规则在登记时已经挡住，这里再查一遍库里的数据；「每日预警」是要有人处理的经营问题。

import { useState } from 'react';
import { Link } from 'react-router';
import { ChevronDown, ChevronRight, CircleAlert, CircleCheck, RotateCw } from 'lucide-react';
import { AUDIT_KIND_LABELS, type AuditItem, type AuditRule } from '@shared/purchase-ledger';
import { errorMessage } from '../../lib/api';
import { cn } from '../../lib/utils';
import { Badge, Button, Card, Notice, Skeleton } from '../../components/ui';
import { ErpPage } from '../erp/ErpHome';
import { useAudit } from './queries';

function itemLink(i: AuditItem): string | null {
  if (!i.link) return null;
  switch (i.link.kind) {
    case 'claim':
      return `/erp/expenses?claim=${i.link.id}`;
    case 'advance':
      return `/erp/petty?advance=${i.link.id}`;
    case 'po':
      return `/purchasing?po=${i.link.id}`;
    case 'request':
      return `/erp/requests?request=${i.link.id}`;
  }
}

function RuleRow({ r }: { r: AuditRule }) {
  const [open, setOpen] = useState(false);
  const canOpen = r.items.length > 0;
  return (
    <li data-testid={`audit-rule-${r.no}`}>
      <button
        type="button"
        disabled={!canOpen}
        onClick={() => setOpen((o) => !o)}
        className="grid w-full grid-cols-[28px_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 px-4 py-3 text-left enabled:hover:bg-paper-2"
        aria-expanded={canOpen ? open : undefined}
      >
        <span className="num pt-0.5 text-[13px] font-bold text-ink-3">{r.no}</span>
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-bold">{r.title}</span>
            <Badge tone={r.kind === 'block' ? 'neutral' : 'yuzu'}>{AUDIT_KIND_LABELS[r.kind]}</Badge>
          </span>
          <span className="mt-0.5 block text-[12.5px] text-ink-3">{r.how}</span>
        </span>
        <span className={cn('flex items-center gap-1.5 pt-0.5 text-[13px] font-bold', r.ok ? 'text-pine' : r.kind === 'block' ? 'text-clay' : 'text-yuzu-deep')}>
          {r.ok ? <CircleCheck className="size-4" /> : <CircleAlert className="size-4" />}
          {r.ok ? '没有问题' : `${r.count} 条`}
          {canOpen && (open ? <ChevronDown className="size-4 text-ink-3" /> : <ChevronRight className="size-4 text-ink-3" />)}
        </span>
      </button>
      {open && (
        <ul className="space-y-1 border-t border-line/70 bg-paper-2/40 px-4 py-2 pl-[52px]">
          {r.items.map((i, k) => {
            const to = itemLink(i);
            return (
              <li key={k} className="text-[13px]">
                {i.date && <span className="num mr-2 text-ink-3">{i.date}</span>}
                {to ? (
                  <Link to={to} className="font-semibold text-lake hover:underline">
                    {i.text}
                  </Link>
                ) : (
                  i.text
                )}
              </li>
            );
          })}
          {r.count > r.items.length && <li className="text-[12px] text-ink-3">只列前 {r.items.length} 条，共 {r.count} 条</li>}
        </ul>
      )}
    </li>
  );
}

export function AuditPage() {
  const audit = useAudit();
  const rules = audit.data?.rules ?? [];
  const blockBad = rules.filter((r) => r.kind === 'block' && !r.ok).length;
  const warnBad = rules.filter((r) => r.kind === 'warn' && !r.ok).length;
  return (
    <ErpPage
      title="账目自检"
      description="飞书需求 RQ-005 的 12 条规则：录入时拦截的再查一遍库里的数据；每日预警列出要有人处理的问题。这是经营预警，不影响系统自检（check）。"
      actions={
        <Button variant="secondary" icon={<RotateCw className="size-4" />} loading={audit.isFetching} onClick={() => void audit.refetch()}>
          重新检查
        </Button>
      }
    >
      <div className="space-y-4" data-testid="audit-page">
        {audit.isPending ? (
          <Skeleton className="h-96" />
        ) : audit.error ? (
          <Notice tone="error" title={errorMessage(audit.error)} />
        ) : (
          <>
            <Notice
              tone={blockBad > 0 ? 'error' : warnBad > 0 ? 'warning' : 'success'}
              title={
                blockBad > 0
                  ? `有 ${blockBad} 条录入规则查出问题，请联系开发会话核查`
                  : warnBad > 0
                    ? `录入规则都没有问题；${warnBad} 条每日预警要处理`
                    : '12 条都没有问题'
              }
            >
              检查日期 {audit.data!.today}。点开每一条看是哪几张单，点单号直接打开。
            </Notice>
            <Card className="overflow-hidden">
              <ul className="divide-y divide-line/70">
                {rules.map((r) => (
                  <RuleRow key={r.no} r={r} />
                ))}
              </ul>
            </Card>
          </>
        )}
      </div>
    </ErpPage>
  );
}
