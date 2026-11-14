import type { ReactNode } from "react";
import { ArrowRight, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { Money } from "../../components/Money";
import { Button, Notice, Skeleton } from "../../components/ui";

export const monthName = (value: string) => { const [year, month] = value.split("-"); return month ? `${year}年${Number(month)}月` : value; };
export const localTime = (value: string | null | undefined, timezone = "Asia/Shanghai") => value ? new Date(value).toLocaleString("zh-CN", { timeZone: timezone, hour12: false }) : "未登记";
export function Amount({ value, signed = false }: { value: number | null | undefined; signed?: boolean }) {
  return value == null ? <span className="customer-muted">—</span> : <Money cents={value} signed={signed} />;
}
export function ReadStatus({ loading, error, receivedAt, hasData, onRetry }: { loading: boolean; error: string; receivedAt: string; hasData: boolean; onRetry: () => void }) {
  return <>
    {error && <Notice tone="error" title="同步暂未完成" action={<Button variant="secondary" size="sm" onClick={onRetry}><RefreshCw size={14} />重试</Button>}>{error}{hasData ? " 当前内容可能尚未更新。" : ""}</Notice>}
    {loading && !hasData && <div role="status" aria-label="正在读取客户部数据"><Skeleton className="h-32" /></div>}
    {receivedAt && <p className="customer-sync">最近收到更新 {localTime(receivedAt)} · 每3秒同步</p>}
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
