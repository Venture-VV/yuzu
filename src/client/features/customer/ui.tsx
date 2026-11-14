import type { ReactNode } from "react";
import { ArrowRight, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { Money } from "../../components/Money";
import { Button, Notice, Skeleton } from "../../components/ui";
import { formatDate, formatDateTime, formatTime } from "../../lib/utils";

export const monthName = (value: string) => { const [year, month] = value.split("-"); return month ? `${year}年${Number(month)}月` : value; };
/**
 * 时间按全店的格式显示（门店时区由登录后的会话设置，见 lib/utils）：今年的写「11月14日 16:20」，往年的带年份。
 * 第二个参数是原来传的时区，留着不用——时区全店一处定，不各页各算。
 */
export const localTime = (value: string | null | undefined, _timezone?: string) => {
  if (!value) return "未登记";
  return formatDate(value).slice(0, 4) === formatDate(new Date().toISOString()).slice(0, 4) ? formatDateTime(value) : `${formatDate(value)} ${formatTime(value)}`;
};
export function Amount({ value, signed = false }: { value: number | null | undefined; signed?: boolean }) {
  return value == null ? <span className="customer-muted">—</span> : <Money cents={value} signed={signed} />;
}
/** 读取状态：出错给重试，第一次读给骨架。什么时候更新的只在页面右上角写一处（SyncedAt），不每块各写一行 */
export function ReadStatus({ loading, error, hasData, onRetry }: { loading: boolean; error: string; receivedAt?: string; hasData: boolean; onRetry: () => void }) {
  return <>
    {error && <Notice tone="error" title="同步暂未完成" action={<Button variant="secondary" size="sm" onClick={onRetry}><RefreshCw size={14} />重试</Button>}>{error}{hasData ? " 当前内容可能尚未更新。" : ""}</Notice>}
    {loading && !hasData && <div role="status" aria-label="正在读取客户部数据"><Skeleton className="h-32" /></div>}
  </>;
}
export function Empty({ children = "当前条件下暂无记录。" }: { children?: ReactNode }) { return <div className="customer-empty">{children}</div>; }
export function PageControls({ offset, limit, hasMore, total, onOffset }: { offset: number; limit: number; hasMore: boolean; total: number; onOffset: (offset: number) => void }) {
  return <div className="customer-pagination"><span>共 {total} 条 · 第 {Math.floor(offset / limit) + 1} 页</span><Button size="sm" variant="secondary" disabled={!offset} onClick={() => onOffset(Math.max(0, offset - limit))}><ChevronLeft size={14} />上一页</Button><Button size="sm" variant="secondary" disabled={!hasMore} onClick={() => onOffset(offset + limit)}>下一页<ChevronRight size={14} /></Button></div>;
}
export function Metric({ label, children, note, onClick }: { label: string; children: ReactNode; note?: ReactNode; onClick?: () => void }) {
  const content = <><span className="customer-metric-label">{label}{onClick && <ArrowRight size={14} />}</span><strong>{children}</strong>{note && <small>{note}</small>}</>;
  return onClick ? <button type="button" className="customer-metric" onClick={onClick} aria-label={`查看${label}详情`}>{content}</button> : <article className="customer-metric">{content}</article>;
}
export function Facts({ values }: { values: Array<[string, ReactNode]> }) { return <dl className="customer-facts">{values.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>; }
/** 页面右上角：数据是几点更新的（前台有变化会自动跟上） */
export function SyncedAt({ receivedAt }: { receivedAt: string }) {
  return receivedAt ? <span className="customer-sync" data-testid="customer-synced-at">{formatTime(receivedAt)} 更新 · 自动同步</span> : null;
}
