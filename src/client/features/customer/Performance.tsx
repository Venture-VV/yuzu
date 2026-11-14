import { useEffect, useState } from "react";
import type { CustomerMeta, CustomerPerformancePage } from "@shared/customer";
import { Dialog } from "../../components/Overlay";
import { Badge, Button, Notice, SectionTitle, Segmented } from "../../components/ui";
import { customerUrl, useCustomerRead } from "./api";
import type { OpenRecord } from "./types";
import { Amount, Empty, Facts, localTime, PageControls, ReadStatus } from "./ui";

export type PerformanceSelection = { day: string; month: string; period: "today" | "month" | "lastMonthSame"; scope: "department" | "group" | "staff"; subject: string; groupName?: "A组" | "B组"; managerId?: number };

export function PerformanceDialog({ selection, meta, revision, onRefresh, onClose, onRecord }: { selection: PerformanceSelection; meta: CustomerMeta; revision: number; onRefresh: () => void; onClose: () => void; onRecord: OpenRecord }) {
  const [offset, setOffset] = useState(0);
  const [selfOnly, setSelfOnly] = useState(false);
  const [period, setPeriod] = useState(selection.period);
  const allowed = meta.capabilities.manage || selection.scope === "staff" && selection.managerId === meta.capabilities.actorId;
  const canRead = allowed || selfOnly;
  const read = useCustomerRead<CustomerPerformancePage>(canRead ? customerUrl("performance", { day: selection.day, month: selection.month, period, scope: selfOnly ? "staff" : selection.scope, groupName: selfOnly ? undefined : selection.groupName, managerId: selfOnly ? meta.capabilities.actorId : selection.managerId, offset }) : null, revision);
  const d = read.data;
  useEffect(() => {
    if (d && offset > 0 && offset >= d.filteredTotal) setOffset(Math.floor(Math.max(0, d.filteredTotal - 1) / d.limit) * d.limit);
  }, [d?.filteredTotal, d?.limit, offset]);
  const periodName = period === "today" ? "今日" : period === "month" ? "本月" : "上月同期";
  const title = selection.scope === "department" ? `${periodName}部门已核业绩` : `${selection.subject}${periodName}已核业绩`;
  return <Dialog open title={title} description="已核充值原单与退储值冲减逐笔展示，金额来自原生账本。" width="max-w-5xl" onClose={onClose} footer={<Button variant="secondary" onClick={onClose}>关闭业绩详情</Button>}>
    <div className="customer-dialog customer-stack">
      <Segmented ariaLabel="业绩原单统计期间" size="sm" value={period} onChange={(value) => { setPeriod(value); setOffset(0); }} options={[{ value: "today", label: "所选当日" }, { value: "month", label: "本月累计" }, { value: "lastMonthSame", label: "上月同期" }]} />
      {!allowed && <Notice tone="info" title="原单明细按账号权限查看">当前账号可查看部门与分组汇总，金融原单仅可查看本人。{!selfOnly && <div className="customer-actions"><Button size="sm" variant="secondary" onClick={() => setSelfOnly(true)}>查看本人同期已核原单</Button></div>}</Notice>}
      {selfOnly && <p className="customer-caption">下列为本人同期明细；其合计不代表部门或分组总额。</p>}
      <ReadStatus {...read} hasData={Boolean(d)} onRetry={onRefresh} />
      {d && <>
        <Facts values={[["统计期间", `${d.from} 至 ${d.to}`], ["核定充值", <Amount value={d.totals.rechargeCents} />], ["退储值冲减", <Amount value={d.totals.refundCents} />], ["净已核业绩", <Amount value={d.totals.netCents} />]]} />
        <SectionTitle>业绩原单与退款冲减</SectionTitle>
        {!d.rows.length ? <Empty>当前范围内暂无已核业绩原单或退款冲减。</Empty> : <div className="customer-record-list">{d.rows.map((event) => <article key={`${event.eventType}-${event.id}`} className="customer-record">
          <div className="customer-record-head"><strong>{event.docNo}</strong><Badge tone={event.eventType === "refund" ? "yuzu" : "pine"}>{event.eventType === "refund" ? "退款冲减" : "已核充值"}</Badge><Amount value={event.amountCents} signed /></div>
          <p><button type="button" className="customer-inline-link" onClick={() => onRecord("member", event.member.id)}>{event.member.name} · {event.member.memberNo}</button> · 成交人 {event.manager.name} · {event.groupName || "待分组"}</p>
          <small>营业日 {event.businessDate} · {localTime(event.occurredAt, d.timezone)}</small>
          <div className="customer-actions"><Button size="sm" variant="secondary" onClick={() => onRecord("recharge", event.rechargeId)}>查看{event.eventType === "refund" ? "对应充值与退款原单" : "充值原单"}</Button></div>
        </article>)}</div>}
        <PageControls {...d} total={d.filteredTotal} onOffset={setOffset} />
      </>}
    </div>
  </Dialog>;
}
