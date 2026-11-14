import { useEffect, useState } from "react";
import type { CustomerBindingQueue } from "@shared/customer";
import { Badge, Button, Card, SectionTitle, Select } from "../../components/ui";
import { customerUrl, useCustomerRead } from "./api";
import { staffName } from "./types";
import type { OpenForm, OpenRecord } from "./types";
import { Empty, localTime, PageControls, ReadStatus } from "./ui";
export function BindingQueue({ revision, onRefresh, onRecord, onForm }: { revision: number; onRefresh: () => void; onRecord: OpenRecord; onForm: OpenForm }) {
  const [status, setStatus] = useState("pending"), [offset, setOffset] = useState(0);
  const read = useCustomerRead<CustomerBindingQueue>(customerUrl("bindings", { status, offset }), revision);
  const d = read.data;
  useEffect(() => { if (d && offset > 0 && offset >= d.filteredTotal) setOffset(Math.floor(Math.max(0, d.filteredTotal - 1) / d.limit) * d.limit); }, [d?.filteredTotal, d?.limit, offset]);
  return <div className="customer-stack"><div className="customer-filters"><label>申请状态<Select aria-label="绑定申请状态" value={status} onChange={(event) => { setStatus(event.target.value); setOffset(0); }}><option value="pending">待审核</option><option value="approved">已通过</option><option value="rejected">已驳回</option><option value="all">全部申请</option></Select></label></div><ReadStatus {...read} hasData={Boolean(d)} onRetry={onRefresh} />{d && <Card className="customer-section"><SectionTitle>会员维护绑定审核</SectionTitle><p className="customer-caption">审核通过前维护人不变；每次申请与审批都留记录，不挪动历史成交。</p>{!d.rows.length ? <Empty>当前状态下暂无绑定申请。</Empty> : <div className="customer-record-list">{d.rows.map((request) => <article className="customer-record" key={request.id}><div className="customer-record-head"><Button size="sm" variant="ghost" onClick={() => onRecord("member", request.member.id)}>{request.member.name} · {request.member.memberNo}</Button><Badge tone={request.status === "approved" ? "pine" : "neutral"}>{request.status === "pending" ? "待审核" : request.status === "approved" ? "已通过" : "已驳回"}</Badge></div><strong>{staffName(request.from)} → {staffName(request.manager)}</strong><p>{request.reason}</p><small>申请人 {request.requester.name} · {localTime(request.createdAt, d.timezone)}</small>{request.reviewer && <small>审核 {request.reviewer.name} · {request.reviewReason} · {localTime(request.resolvedAt, d.timezone)}</small>}{d.capabilities.manage && request.status === "pending" && <Button size="sm" variant="primary" onClick={() => onForm({ kind: "bindingReview", request })}>审核这项申请</Button>}</article>)}</div>}<PageControls {...d} total={d.filteredTotal} onOffset={setOffset} /></Card>}</div>;
}
